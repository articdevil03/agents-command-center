import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { keyHeaders } from "./temp-root.ts";
import { HOST, APP_KEY, CHROME } from "./browser-constants.ts";
import { stopChromeTree, CHROME_CLOSE_GRACE_MS } from "./chrome-stop.ts";
import { seatPointerProbes } from "./browser-dialog-seat-pointer.ts";
import { approvalProbes } from "./browser-dialog-approvals.ts";
import { settingsLifecycleProbes } from "./browser-dialog-settings.ts";
import { dialogCloseProbes } from "./browser-dialog-close.ts";

export async function chromeDialogAudit(args: { port: number; folder: string; width: number; profile: string; approvals?: boolean; seatPointer?: boolean }) {
  const query = new URLSearchParams({ mode: "fake", folder: args.folder, case: "dialog-close" });
  const url = `http://${HOST}:${args.port}/__audit?${query}`;
  mkdirSync(args.profile, { recursive: true });
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--window-size=${args.width + 16},1000`,
    `--user-data-dir=${args.profile}`, "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader", "--disable-dev-shm-usage",
    "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let socket: WebSocket | null = null;
  let sequence = 0;
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error(`Chrome DevTools socket is not open for ${method}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome DevTools command timed out: ${method}`)); }, 10_000);
    pending.set(id, {
      resolve(message) { clearTimeout(timer); resolve(message); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  try {
    const activePortFile = join(args.profile, "DevToolsActivePort");
    const portDeadline = Date.now() + 15_000;
    while (!existsSync(activePortFile) && Date.now() < portDeadline && proc.exitCode === null && proc.signalCode === null) await delay(50);
    assert.ok(existsSync(activePortFile), `Chrome PID ${proc.pid} opened DevTools; stderr=${stderr.slice(-1200)}`);
    // Chrome may still hold the file (EBUSY) or have written only part of it: read again until the whole first line is there, within the same deadline.
    let devtoolsPort = 0;
    while (!devtoolsPort && Date.now() < portDeadline) {
      try { devtoolsPort = Number(/^(\d+)\r?\n/.exec(readFileSync(activePortFile, "utf8"))?.[1] ?? 0); } catch { /* locked: retried */ }
      if (!devtoolsPort) await delay(50);
    }
    assert.ok(devtoolsPort > 0, `Chrome wrote a DevTools port to ${activePortFile} before the deadline`);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, `Chrome DevTools port was recorded: ${devtoolsPort}`);
    const version = await fetch(`http://${HOST}:${devtoolsPort}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
    assert.ok(version.webSocketDebuggerUrl, `Chrome exposed its DevTools websocket: ${JSON.stringify(version)}`);
    socket = new WebSocket(version.webSocketDebuggerUrl);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const waiting = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message);
    });
    socket.on("close", () => { for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(new Error("Chrome DevTools socket closed")); } });
    socket.on("error", (error) => { for (const [id, waiting] of pending) { pending.delete(id); waiting.reject(error); } });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });

    const created = await send("Target.createTarget", { url: "about:blank" });
    const targetId = created.result?.targetId;
    assert.ok(targetId, `Chrome created a page target: ${JSON.stringify(created)}`);
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    assert.ok(sessionId, `Chrome attached the page target: ${JSON.stringify(attached)}`);
    const sendPage = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await sendPage("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(`Browser expression failed: ${response.result.exceptionDetails.text ?? JSON.stringify(response.result.exceptionDetails)}`);
      return response.result?.result?.value;
    };
    const waitForPage = async (expression: string, label: string, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
        try { const value = await evaluate(expression); if (value) return value; } catch {}
        await delay(50);
      }
      assert.fail(`Chrome dialog audit timed out waiting for ${label}; stderr=${stderr.slice(-1200)}`);
    };
    const page = { evaluate, sendPage, waitForPage, delay };
    await sendPage("Page.enable");
    await sendPage("Runtime.enable");
    await sendPage("Emulation.setDeviceMetricsOverride", { width: args.width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sendPage("Page.navigate", { url });
    await waitForPage("window.__ccDialogAuditReady === true", "fake app state");
    const actualWidth = await evaluate("innerWidth");
    assert.equal(actualWidth, args.width, `Chrome viewport is ${args.width}px`);

    if (args.seatPointer) {
      await seatPointerProbes(page);
      return;
    }
    if (args.approvals) {
      await approvalProbes(page);
      return await settingsLifecycleProbes(page, args, proc);
    }

    const specs = [
      { id: "inboxPop", label: "Needs you", opener: "#inboxBtn", open: `(()=>{const e=document.querySelector("#inboxBtn");if(!e)return false;e.click();return true})()` },
      { id: "setModal", label: "Settings", opener: "#setBtn", open: `(()=>{const e=document.querySelector("#setBtn");if(!e)return false;e.click();return true})()` },
      { id: "avModal", label: "Avatar", opener: "#meBtn", open: `(()=>{const e=document.querySelector("#meBtn");if(!e)return false;e.click();return true})()` },
      { id: "viewer", label: "Screenshots", opener: "#view [data-open-screenshots]", open: `(()=>{const e=document.querySelector("#view [data-open-screenshots]");if(!e)return false;e.click();return true})()` },
      { id: "modal", label: "Add tab", opener: "#addtab", open: `(()=>{const e=document.querySelector("#addtab");if(!e)return false;e.click();return true})()` },
      { id: "projModal", label: "New project", opener: "#addProj", open: `(()=>{const e=document.querySelector("#addProj");if(!e)return false;e.click();return true})()` },
      { id: "runModal", label: "Run a seat", opener: "#stagehead [data-run-seat]", open: `(()=>{const s=document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]');if(!s)return false;s.click();const e=document.querySelector("#stagehead [data-run-seat]");if(!e)return false;e.click();return true})()` },
    ];
    const expectedIds = specs.map((item) => item.id);
    const foundIds = await evaluate(`(${JSON.stringify(expectedIds)}).filter((id)=>document.querySelector("#"+id)).map((id)=>"#"+id)`);
    assert.deepEqual(foundIds, expectedIds.map((id) => `#${id}`), `every dialog target was found at ${args.width}px: ${JSON.stringify(foundIds)}`);
    console.log(`Dialog targets ${args.width}px: matched ${JSON.stringify(foundIds)}, missing []`);

    const uploadResponse = await fetch(`http://${HOST}:${args.port}/api/paste-image`, {
      method: "POST",
      headers: keyHeaders(APP_KEY, { "Content-Type": "image/png", "X-Request-Id": `dialog-close-${args.width}` }),
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmWQAAAAASUVORK5CYII=", "base64"),
    });
    const uploaded = await uploadResponse.json() as { path?: string; error?: string };
    assert.equal(uploadResponse.status, 200, `temporary screenshot upload succeeded: ${JSON.stringify(uploaded)}`);
    assert.ok(uploaded.path, `temporary screenshot path was returned: ${JSON.stringify(uploaded)}`);
    const screenshotTabId = "alpha-dev";
    await evaluate(`(()=>{const state=structuredClone(window.__latestState);state.selectedTabId=${JSON.stringify(screenshotTabId)};const tab=state.projects.flatMap((project)=>project.tabs).find((item)=>item.id===${JSON.stringify(screenshotTabId)});if(!tab)return false;tab.processState.approval={state:"pending"};tab.processState.currentStepIndex=0;tab.derived.stepBar=[{stepId:"look",state:"current",owners:["user"],label:"Your look"}];window.__ccSeed=structuredClone(state);window.__ccDeliver({...state,type:"state"});window.__ccDeliver({type:"chatHistory",tabId:${JSON.stringify(screenshotTabId)},messages:[{id:"dialog-close-shot",role:"user",text:"Screenshot",images:[${JSON.stringify(uploaded.path)}],at:Date.now()}],revision:1,savedRevision:1});return true})()`);
    await waitForPage(`Boolean(document.querySelector('#view [data-open-screenshots="${screenshotTabId}"]'))`, "screenshot viewer opener");
    const screenshotOpener = `#view [data-open-screenshots="${screenshotTabId}"]`;
    const viewerSpec = specs.find((item) => item.id === "viewer")!;
    viewerSpec.opener = screenshotOpener;
    viewerSpec.open = `(()=>{const e=document.querySelector(${JSON.stringify(screenshotOpener)});if(!e)return false;e.click();return true})()`;

    await dialogCloseProbes(page, specs, args);
    await evaluate("window.__ccDialogAuditContinue?.(); true");
    return { width: args.width, dialogs: expectedIds.map((id) => `#${id}`), chromePid: proc.pid };
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { try { await send("Browser.close"); } catch {} }
    const stop = await stopChromeTree(proc, { graceMs: CHROME_CLOSE_GRACE_MS });
    socket?.close();
    assert.ok(stop.stopped, `Chrome PID ${proc.pid} exited after the dialog audit: ${stop.facts.join("; ")}`);
    console.log(`Dialog browser Chrome PID ${proc.pid} stopped in ${stop.ms} ms (exit=${proc.exitCode}, signal=${proc.signalCode})`);
  }
}