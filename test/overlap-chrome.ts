import { waitForFirstRender } from "./page-first-render.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { stopChromeTree } from "./chrome-stop.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { CHROME, DETAIL_PILLS, HEIGHT, HOST, INTENTIONAL_STACKS, LONG_PATH, SETTINGS_SECTIONS, STATE_GROUPS, UNBROKEN_300, delay, spaced, unbroken } from "./overlap-helpers.ts";

export type Finding = { width: number; state: string; type: string; a: string; b: string; detail: string };

// groups null = every state group; otherwise only those (see STATE_GROUPS), each starting from the freshly loaded page.
export async function chromeAudit(port: number, profile: string, width: number, extraFiles: string[], inventory: string[], groups: string[] | null = null) {
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--window-size=${width + 16},${HEIGHT + 130}`, "--window-position=1920,0", `--user-data-dir=${profile}`,
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox", "--use-gl=swiftshader",
    "--disable-dev-shm-usage", "--disable-background-networking", "--no-proxy-server", "--hide-scrollbars", "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let socket: WebSocket | null = null; let sequence = 0;
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((ok, bad) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { bad(new Error(`DevTools socket is not open for ${method}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); bad(new Error(`DevTools command timed out: ${method}`)); }, 20_000);
    pending.set(id, { resolve(message) { clearTimeout(timer); ok(message); }, reject(error) { clearTimeout(timer); bad(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const findings: Finding[] = []; const checked: string[] = [];
  let bodyError: unknown;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < deadline && proc.exitCode === null) await delay(50);
    assert.ok(existsSync(portFile), `Chrome PID ${proc.pid} opened DevTools; stderr=${stderr.slice(-800)}`);
    // Chrome may still hold the file (EBUSY) or have written only part of it: read again until the whole first line is there, within the same deadline.
    let devtoolsPort = 0;
    while (!devtoolsPort && Date.now() < deadline) {
      try { devtoolsPort = Number(/^(\d+)\r?\n/.exec(readFileSync(portFile, "utf8"))?.[1] ?? 0); } catch { /* locked: retried */ }
      if (!devtoolsPort) await delay(50);
    }
    assert.ok(devtoolsPort > 0, `Chrome wrote a DevTools port to ${portFile} before the deadline`);
    const version = await fetch(`http://${HOST}:${devtoolsPort}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
    socket = new WebSocket(version.webSocketDebuggerUrl!);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id || !pending.has(message.id)) return;
      const waiting = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error))); else waiting.resolve(message);
    });
    await new Promise<void>((ok, bad) => { socket!.once("open", ok); socket!.once("error", bad); });
    const created = await send("Target.createTarget", { url: "about:blank" });
    const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId as string;
    const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error(`Browser expression failed: ${response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text}`);
      return response.result?.result?.value;
    };
    const waitFor = async (expression: string, label: string, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { try { if (await evaluate(expression)) return; } catch { /* page still loading */ } await delay(40); }
      assert.fail(`timed out waiting for ${label} at ${width}px`);
    };
    await page("Page.enable"); await page("Runtime.enable"); await page("DOM.enable");
    await page("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `http://${HOST}:${port}/__audit` });
    await waitForFirstRender(waitFor, `typeof window.CC_FIXED_CREW?.init==="function"&&Boolean(document.querySelector("#fixedView:not([hidden]) #fcWorkSettings"))&&document.querySelectorAll("#crew .seat").length>0&&document.querySelectorAll("#tabs [role=tab]").length>0&&document.querySelector("#view .thread")!==null`, "app render with the fixed crew loaded");
    assert.equal(await evaluate("innerWidth"), width, `viewport is ${width}px`);
    await evaluate(AUDIT_JS);
    // Control: a socket message the page cannot read is reported only through console.error, and the page-error hook must catch that.
    await evaluate(`window.__socket.emit("message",{data:"{not json"});true`);
    const control = await evaluate("window.__ccErrors");
    assert.ok(control.length === 1 && /^console\.error: Invalid Command Center message/.test(control[0]), `the console.error hook caught the unreadable message at ${width}px: ${JSON.stringify(control)}`);
    await evaluate("window.__ccErrors.length=0;true");
    await evaluate(`window.__ovAllowed=${JSON.stringify(INTENTIONAL_STACKS)};true`);
    const settle = () => delay(120);
    const click = (selector: string) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
    const escape = async () => { await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));true`); await delay(320); };
    const audit = async (state: string, root: string | null, expect: { texts?: number; controls?: number } = {}) => {
      await settle();
      const result = await evaluate(`window.__ov(${JSON.stringify(state)}, ${JSON.stringify(root)})`);
      assert.ok(result.found, `${state}: root ${root} was FOUND at ${width}px`);
      assert.ok(result.texts >= (expect.texts ?? 1), `${state}: ${result.texts} visible text rects at ${width}px, expected at least ${expect.texts ?? 1}`);
      assert.ok(result.controls >= (expect.controls ?? 1), `${state}: ${result.controls} visible controls at ${width}px, expected at least ${expect.controls ?? 1}`);
      checked.push(`${state} [${result.root}] texts=${result.texts} controls=${result.controls}`);
      for (const item of result.violations) findings.push({ width, state, type: item.type, a: item.a, b: item.b, detail: item.detail });
      return result;
    };
    const openAndWait = async (opener: string, layer: string) => {
      assert.equal(await click(opener), true, `${opener} exists at ${width}px`);
      await waitFor(`document.querySelector(${JSON.stringify(layer)})?.getAttribute("aria-hidden")==="false"`, `${layer} open`);
      await delay(320);
    };
    // Measure the scroll viewport as well as the first visible content: padding alone
    // disappears on scroll and cannot protect the close button from later cards.
    const checkedCloseModals = new Set<string>();
    // fixedTopInset: the user's later instruction for Settings ("move up the close button a bit"): top inset 8px replaces the title-level and equal-inset rules.
    const closePlacement = async (modal: string, body: string, title: string, fixedTopInset?: number) => {
      checkedCloseModals.add(modal);
      for (const position of ["top", "middle", "bottom"]) {
        const measurement = await evaluate(`(()=>{
          const modal=document.querySelector(${JSON.stringify(modal)}),body=document.querySelector(${JSON.stringify(body)}),title=document.querySelector(${JSON.stringify(title)}),close=modal?.querySelector(".dialog-close");
          if(!modal||!body||!title||!close)throw new Error("close placement target missing: ${modal}, ${body}, ${title}");
          const max=body.scrollHeight-body.clientHeight;body.scrollTop=${position === "top" ? "0" : position === "middle" ? "max/2" : "max"};
          const m=modal.getBoundingClientRect(),b=body.getBoundingClientRect(),x=close.getBoundingClientRect(),h=title.getBoundingClientRect();
          const visible=[...body.children].map(e=>e.getBoundingClientRect()).filter(r=>r.bottom>b.top&&r.top<b.bottom);
          if(!visible.length)throw new Error("close placement found no visible content: ${body}");
          return {centreDelta:(x.top+x.bottom-h.top-h.bottom)/2,topInset:x.top-m.top,rightInset:m.right-x.right,viewportGap:b.top-x.bottom,contentGap:Math.min(...visible.map(r=>Math.max(r.top,b.top)))-x.bottom,scrollTop:body.scrollTop,maxScroll:max};
        })()`);
        console.log(`Close placement ${width}px ${modal} ${position}: ${JSON.stringify(measurement)}`);
        assert.ok(measurement.maxScroll > 0, `${modal}: long content makes top, middle and bottom distinct at ${width}px`);
        const expectedScroll = position === "top" ? 0 : position === "middle" ? measurement.maxScroll / 2 : measurement.maxScroll;
        assert.ok(Math.abs(measurement.scrollTop - expectedScroll) <= 1, `${modal}: reached ${position} at ${width}px`);
        const add = (type: string, detail: string) => findings.push({ width, state: `${modal} close ${position}`, type, a: ".dialog-close", b: title, detail });
        if (fixedTopInset !== undefined) {
          if (Math.abs(measurement.topInset - fixedTopInset) > 2) add("close-top-inset", `top inset ${measurement.topInset}px, expected ${fixedTopInset}px +-2`);
        } else {
          if (Math.abs(measurement.centreDelta) > 2) add("close-title-centre", `centre delta ${measurement.centreDelta}px exceeds 2px`);
          if (Math.abs(measurement.rightInset - measurement.topInset) > 2) add("close-equal-insets", `right ${measurement.rightInset}px, top ${measurement.topInset}px`);
        }
        if (measurement.viewportGap < 16 || measurement.contentGap < 16) add("close-content-gap", `viewport ${measurement.viewportGap}px, visible content ${measurement.contentGap}px; require >=16px`);
      }
    };

    const scrollBody = (expression: string) => evaluate(`(()=>{const b=document.querySelector("#setBody");${expression};return true})()`);
    const sectionTop = (id: string) => scrollBody(`b.scrollTop=0;const s=b.querySelector("#s-${id}");if(!s)throw new Error("missing #s-${id}");b.scrollTop+=s.getBoundingClientRect().top-b.getBoundingClientRect().top`);
    const popOpen = async (opener: string) => { assert.equal(await click(opener), true, `${opener} exists at ${width}px`); await waitFor(`document.querySelector("#pop")?.getAttribute("aria-hidden")==="false"`, "model picker open"); await delay(250); };
    // Every group starts from the freshly loaded page (the leader's chat, nothing open) and leaves nothing open. Order is STATE_GROUPS' order.
    const scenes: Record<string, () => Promise<void>> = {
      // 1. Main view: busy crew, long chat (unbroken words, URLs, paths, files), 12 tabs with long names.
      main: async () => {
        await audit("main: busy crew, long chat, 12 tabs, status line", null, { texts: 40, controls: 20 });
        await audit("main: tab strip with many long tabs", "#top", { texts: 4, controls: 6 });
        await audit("main: status line and save", "#sline", { texts: 2, controls: 2 });
        await audit("main: chat with long unbroken words, URLs, paths and files", "#view", { texts: 10, controls: 0 });
        await evaluate(`document.querySelector("#view").scrollTop=0;true`); await audit("main: chat scrolled to the top", "#view", { texts: 5, controls: 0 });
      },
      // The fixed crew rail: long names and tasks, the positions summary, then collapsed to faces and back.
      rail: async () => {
        await audit("main: crew rail with long names and tasks", "#rail", { texts: 8, controls: 4 });
        await audit("fixed rail: positions summary with Choose models", "#crew .fc-rail", { texts: 2, controls: 1 });
        await click("#railBtn"); await delay(400);
        await audit("main: crew rail collapsed to faces", "#rail", { texts: 1, controls: 4 });
        await click("#railBtn"); await delay(400);
      },
      // 2. Details panel: Activity, Changes, Notes, Usage. It starts closed; the user opens it (floating below 1280px).
      details: async () => {
        assert.equal(await click("#sideBtn"), true, "Details button exists"); await delay(400);
        for (const lower of DETAIL_PILLS) {
          assert.equal(await click(`.pills [data-l="${lower}"]`), true, `Details pill ${lower} exists`);
          await evaluate(`document.querySelector("#sideBody").scrollTop=0;true`);
          await audit(`Details: ${lower}`, "#side", { texts: 3, controls: 2 });
          await evaluate(`(()=>{const b=document.querySelector("#sideBody");b.scrollTop=b.scrollHeight;return true})()`);
          await audit(`Details: ${lower} scrolled to the bottom`, "#side", { texts: 2, controls: 2 });
        }
        await audit("main: Details open beside or over the chat", null, { texts: 30, controls: 20 });
        await click("#sideBtn"); await delay(400);
      },
      // 3. Attachments with long file names (real upload to the temp-data server through the proxy), then the popovers.
      composer: async () => {
        const doc = await page("DOM.getDocument", { depth: 0 });
        const input = await page("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#attachInput" });
        await page("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: extraFiles });
        await waitFor(`document.querySelectorAll("#atts .att").length===${extraFiles.length}`, "attachments render");
        await evaluate(`document.querySelector("#ci").value=${JSON.stringify(spaced("A long draft message ", 300))};document.querySelector("#ci").dispatchEvent(new Event("input",{bubbles:true}));true`);
        await audit("composer: attachments with long file names and a long draft", "#composer", { texts: 3, controls: 3 });
        await openAndWait("#permBtn", "#permPop");
        await audit("permission picker open", "#permPop", { texts: 4, controls: 4 }); await escape();
        await click("#pmore"); await waitFor(`document.querySelector("#projPop")?.getAttribute("aria-hidden")==="false"`, "project popover"); await delay(200);
        await audit("project popover with long project names", "#projPop", { texts: 2, controls: 2 }); await escape();
        assert.equal(await click(`#tabs .tabw.sel .tmore`), true, "tab menu button exists");
        await waitFor(`document.querySelector("#ctxPop")?.getAttribute("aria-hidden")==="false"`, "tab menu"); await delay(200);
        await audit("tab options menu", "#ctxPop", { texts: 1, controls: 1 }); await escape();
        assert.equal(await click(`#ptabs .ptabw.sel [data-project-menu]`), true, "project menu button exists");
        await waitFor(`document.querySelector("#ctxPop")?.getAttribute("aria-hidden")==="false"`, "project menu"); await delay(200);
        await audit("project options menu with a 200-char folder", "#ctxPop", { texts: 2, controls: 2 }); await escape();
        await openAndWait("#chatMore", "#ctxPop");
        await audit("chat options menu", "#ctxPop", { texts: 3, controls: 2 }); await escape();
        await evaluate(`(()=>{const t=document.querySelector("#tabs");t.scrollLeft=t.scrollWidth;return true})()`);
        await audit("main: tab strip scrolled to its last tabs", "#stage .shead", { texts: 3, controls: 4 });
        await evaluate(`document.querySelector("#tabs").scrollLeft=0;true`);
      },
      // 4. Seat cards are read-only facts (a model or advisor is changed only in Settings); a worker's own view has its live runs, Run, Watch and History.
      seat: async () => {
        await openAndWait('#crew [data-seat-id="leader"] [data-seat-pic]', "#seatPop");
        await audit("leader seat card: read-only facts with a long name and status", "#seatPop", { texts: 6, controls: 3 });
        assert.equal(await evaluate(`document.querySelectorAll("#seatPop [data-seat-model],#seatPop [data-seat-advisor]").length`), 0, `the seat card has no model or advisor control at ${width}px`);
        await escape();
        assert.equal(await click('#crew [data-seat-id="coder"] [data-seat-open]'), true, "coder face exists"); await delay(250);
        await audit("worker view: two live runs with long labels and a 200-char folder", "#view", { texts: 8, controls: 6 });
        await openAndWait("#view [data-seat-more]", "#seatPop");
        assert.equal(await evaluate(`document.querySelectorAll("#seatPop [data-run-seat]").length`), 1, `the worker seat card offers Run at ${width}px`);
        await audit("worker seat card: read-only facts, Run and long runs", "#seatPop", { texts: 6, controls: 4 }); await escape();
        assert.equal(await click('#view [data-run-view="history"]'), true, "worker History exists"); await delay(250);
        await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];window.__ccDeliver({type:"historyList",seatKey:tab.crew.find((seat)=>seat.slot==="coder").seatKey,runs:Array.from({length:6},(_,i)=>({timestamp:Date.now()-i*60000,sizeBytes:123456789,outcome:{status:i%2?"failed":"done",exitCode:i}}))});return true})()`); await delay(150);
        await audit("worker History list", "#view", { texts: 8, controls: 6 });
        await click("#view [data-back-chat]"); await delay(250);
      },
      // 5. Needs you: launch safety records, approvals and long requests, and the send form.
      requests: async () => {
        await openAndWait("#inboxBtn", "#inboxPop");
        await evaluate(`document.querySelector("#inboxPop").scrollTop=0;true`);
        // A request body keeps its line breaks, so the long cards are taller and fewer controls fit above the fold.
        await audit("Needs you: launch safety and long request cards", "#inboxPop", { texts: 20, controls: 2 });
        // A card line that is cut with an ellipsis must not widen its card: the panel scrolls sideways when one does (the scan trusts a scrolling parent), so measure the cards and the panel themselves.
        const sideways = await evaluate(`(()=>{const pop=document.querySelector("#inboxPop"),cards=[...pop.querySelectorAll(".ncard")];return {cards:cards.length,lines:pop.querySelectorAll(".ncard>small").length,wide:cards.filter((card)=>card.scrollWidth>card.clientWidth+1).map((card)=>card.textContent.trim().slice(0,40)),popWide:pop.scrollWidth>pop.clientWidth+1}})()`);
        assert.ok(sideways.cards >= 6 && sideways.lines >= 3, `the safety and request cards were found at ${width}px: ${JSON.stringify(sideways)}`);
        assert.deepEqual([sideways.wide, sideways.popWide], [[], false], `no Needs you card or the panel scrolls sideways at ${width}px: ${JSON.stringify(sideways)}`);
        // The cut-off card lines sit below the first screen: scroll the widest one into view so the scan reads it (it must really be longer than its box, or the state checks nothing).
        const cutLine = await evaluate(`(()=>{const pop=document.querySelector("#inboxPop"),line=[...pop.querySelectorAll(".ncard>small")].sort((a,b)=>b.scrollWidth-a.scrollWidth)[0];line.scrollIntoView({block:"center"});return {scroll:line.scrollWidth,box:line.clientWidth,title:line.title.length>0}})()`);
        assert.ok(cutLine.scroll > cutLine.box + 1 && cutLine.title, `a safety card line is longer than its box and has a title at ${width}px: ${JSON.stringify(cutLine)}`);
        await audit("Needs you: launch safety card lines scrolled into view", "#inboxPop", { texts: 10, controls: 0 });
        await evaluate(`document.querySelector("#inboxPop").scrollTop=0;true`);
        // Taller cards mean fewer buttons above the fold, so the minimum above stays low; what must hold is that EVERY request card's buttons can be reached: scrolled to, inside the panel, and not covered.
        const reach = await evaluate(`(()=>{const pop=document.querySelector("#inboxPop"),out=[];for(const b of pop.querySelectorAll(".ncard.req [data-request-action]")){b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect(),p=pop.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);out.push({action:b.dataset.requestAction,inside:r.width>0&&r.height>0&&r.top>=p.top-0.5&&r.bottom<=p.bottom+0.5,hit:Boolean(hit&&(hit===b||b.contains(hit)))})}pop.scrollTop=0;return out})()`);
        assert.ok(reach.length >= 2, `${reach.length} request card buttons were found in Needs you at ${width}px, expected at least 2 (an empty scan checks nothing)`);
        assert.deepEqual(reach.filter((item: { inside: boolean; hit: boolean }) => !item.inside || !item.hit), [], `every request card button is reachable at ${width}px; matched: ${JSON.stringify(reach)}`);
        await evaluate(`(()=>{const b=document.querySelector("#inboxPop");b.scrollTop=(b.scrollHeight-b.clientHeight)/2;return true})()`);
        await audit("Needs you: scrolled to the middle", "#inboxPop", { texts: 10, controls: 3 });
        await evaluate(`(()=>{const b=document.querySelector("#inboxPop");b.scrollTop=b.scrollHeight;return true})()`);
        await audit("Needs you: scrolled to the bottom (sent requests, no controls)", "#inboxPop", { texts: 10, controls: 0 });
        await click("#reqNew"); await delay(150);
        await evaluate(`(()=>{document.querySelector("#reqTitle").value=${JSON.stringify(unbroken("T", 120))};document.querySelector("#reqBody").value=${JSON.stringify(UNBROKEN_300)};const b=document.querySelector("#inboxPop");b.scrollTop=document.querySelector("#reqForm").offsetTop-20;return true})()`);
        await audit("Needs you: long draft in the request form", "#inboxPop", { texts: 6, controls: 4 });
        await escape();
      },
      // 6. Settings: opened from the rail's crew button, every section top and bottom, body top, middle and bottom, the fixed crew's own list, Instructions and model picker, and the add forms.
      settings: async () => {
        await openAndWait("#setupsBtn", "#setModal");
        await audit("settings: opened from the rail crew button", "#setModal", { texts: 10, controls: 4 }); await escape();
        await openAndWait("#setBtn", "#setModal");
        await closePlacement("#setModal", "#setBody", "#setNav h2", 8);
        await scrollBody("b.scrollTop=0");
        await audit("settings: opened", "#setModal", { texts: 20, controls: 6 });
        await audit("settings: body top", "#setModal", { texts: 10, controls: 4 });
        await scrollBody("b.scrollTop=(b.scrollHeight-b.clientHeight)/2"); await audit("settings: body middle", "#setModal", { texts: 10, controls: 3 });
        await scrollBody("b.scrollTop=b.scrollHeight"); await audit("settings: body bottom", "#setModal", { texts: 5, controls: 2 });
        for (const id of SETTINGS_SECTIONS) {
          await sectionTop(id); await audit(`settings: ${id} section scrolled to its top`, "#setModal", { texts: 3, controls: 1 });
          await scrollBody(`const s=b.querySelector("#s-${id}");b.scrollTop+=s.getBoundingClientRect().bottom-b.getBoundingClientRect().bottom`);
          await audit(`settings: ${id} section scrolled to its bottom`, "#setModal", { texts: 3, controls: 1 });
        }
        await sectionTop("crew");
        await audit("settings: fixed crew position list", "#s-crew", { texts: 10, controls: 10 });
        // Instructions: the built-in text arrives from the server (delivered here as it would be) and the user's own long extra text is typed in.
        await evaluate(`document.querySelector('#s-crew [data-fc-toggle="coder"]').click();true`);
        await waitFor(`window.__sent.some((m)=>m.type==="getCrewRolePrompt")`, "the built-in instructions are asked for");
        await evaluate(`(()=>{const ask=window.__sent.filter((m)=>m.type==="getCrewRolePrompt").at(-1);window.__ccDeliver({type:"crewRolePrompt",requestId:ask.requestId,core:${JSON.stringify(`${spaced("Built in", 300)}\n${UNBROKEN_300}`)},guidance:${JSON.stringify(spaced("Guidance", 200))},defaultsVersion:1});const x=document.querySelector('#s-crew [data-fc-extra="coder"]');x.value=${JSON.stringify(`${spaced("Extra", 200)} ${UNBROKEN_300}`)};x.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
        await waitFor(`!document.querySelector('#s-crew [data-fc-row="coder"] .fc-panel').hidden&&document.querySelector('#s-crew [data-fc-row="coder"] .fc-core-text').textContent.length>300`, "the Instructions panel shows the long text");
        await evaluate(`document.querySelector('#s-crew [data-fc-row="coder"]').scrollIntoView({block:"start"});true`);
        await audit("settings: position Instructions open with long text", '#s-crew [data-fc-row="coder"]', { texts: 6, controls: 4 });
        await evaluate(`document.querySelector('#s-crew [data-fc-toggle="coder"]').click();true`);
        // The shared model and effort picker, opened for a position (the geometry the seat card's model row used to own).
        await popOpen('#s-crew [data-fc-model="coder"]');
        await audit("settings: model and effort picker for a position", "#pop", { texts: 2, controls: 1 }); await escape();
        await evaluate(`document.querySelectorAll('#setBody [data-settings-add]').forEach((button)=>button.click());true`);
        await scrollBody("b.scrollTop=0"); await audit("settings: add forms open, top", "#setModal", { texts: 10, controls: 4 });
        await scrollBody("b.scrollTop=(b.scrollHeight-b.clientHeight)/2"); await audit("settings: add forms open, middle", "#setModal", { texts: 10, controls: 4 });
        await scrollBody("b.scrollTop=b.scrollHeight"); await audit("settings: add forms open, bottom", "#setModal", { texts: 5, controls: 2 });
        await escape();
      },
      // 7. Creation: add tab and new project, each with the fixed crew's position list and picker (the .field box that holds the list).
      creation: async () => {
        await openAndWait("#addtab", "#modal");
        await click("#browse"); await delay(250);
        await evaluate(`document.querySelector("#tName").value=${JSON.stringify(unbroken("New", 64))};true`);
        await audit("add-tab modal with a long project name, name, 200-char folder and the position list", "#modal", { texts: 5, controls: 4 });
        await audit("creation: add-tab position list", "#tCrew", { texts: 10, controls: 5 });
        await popOpen('#tCrew [data-fc-new-model="coder"]');
        await audit("creation: position picker", "#pop", { texts: 2, controls: 1 }); await escape(); await escape();
        await openAndWait("#addProj", "#projModal");
        await click("#pBrowse"); await delay(250);
        await evaluate(`document.querySelector("#pName").value=${JSON.stringify(unbroken("New", 64))};document.querySelector("#pName").dispatchEvent(new Event("input",{bubbles:true}));true`);
        await audit("new-project modal with a long name, 200-char folder and the position list", "#projModal", { texts: 5, controls: 4 });
        // The help line holds the unbroken default folder: the .field track keeps the Browse button and the footer buttons inside the dialog.
        const inside = await evaluate(`(()=>{const m=document.querySelector("#projModal").getBoundingClientRect();return ["#pBrowse","#createProj","#projModal [data-close]"].map((sel)=>{const r=document.querySelector(sel).getBoundingClientRect();return {sel,left:r.left,right:r.right,ok:r.width>0&&r.left>=m.left-0.5&&r.right<=m.right+0.5}})})()`);
        assert.equal(inside.length, 3, `the three New project buttons were found at ${width}px`);
        assert.deepEqual(inside.filter((item: { ok: boolean }) => !item.ok), [], `the New project buttons stay inside the dialog at ${width}px; matched: ${JSON.stringify(inside)}`);
        await audit("creation: new-project position list", "#pCrew", { texts: 10, controls: 5 }); await escape();
      },
      // 8. Dialogs: avatar, run a seat, rename, tool approvals.
      dialogs: async () => {
        await openAndWait("#meBtn", "#avModal"); await audit("avatar dialog", "#avModal", { texts: 2, controls: 2 }); await escape();
        await evaluate(`(()=>{const s=document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]');if(s)s.click();return true})()`); await delay(150);
        assert.equal(await click("#stagehead [data-run-seat]"), true, "run seat button exists");
        await waitFor(`document.querySelector("#runModal")?.getAttribute("aria-hidden")==="false"`, "run modal"); await delay(320);
        await audit("run a seat modal with a long seat name", "#runModal", { texts: 2, controls: 2 }); await escape();
        // Rename and confirm dialogs carry server text too.
        assert.equal(await click(`#tabs .tabw.sel .tmore`), true, "tab menu for rename"); await delay(200);
        await evaluate(`[...document.querySelectorAll("#ctxPop button.opt")].find((b)=>b.textContent.includes("Rename"))?.click();true`);
        await waitFor(`document.querySelector("#renameModal")?.getAttribute("aria-hidden")==="false"`, "rename modal"); await delay(320);
        await audit("rename dialog with a 60-char tab name", "#renameModal", { texts: 1, controls: 2 }); await escape();
        await evaluate(`(()=>{const b=document.querySelector("#view [data-back-chat]");if(b)b.click();return true})()`); await delay(150);
        for (const count of [1, 3]) {
          await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];tab.pendingApprovals=Array.from({length:${count}},(_,i)=>({approvalId:"overlap-"+i,tool:"Bash",summary:i===0?${JSON.stringify("echo " + (LONG_PATH + UNBROKEN_300).repeat(20))}:"echo next",createdAt:i}));window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
          await waitFor(`!document.querySelector("#approvalPanel").hidden`, "approval panel");
          await audit(`tool approval panel with long command and ${count} pending`, "#composer", { texts: 3, controls: 3 });
          assert.equal(await evaluate(`(()=>{const p=document.querySelector("#approvalPanel").getBoundingClientRect(),c=document.querySelector(".cbox").getBoundingClientRect(),v=document.querySelector("#view"),last=v.querySelector(".msg:last-of-type");v.scrollTop=v.scrollHeight;return !!last && last.getBoundingClientRect().bottom<=p.top && v.getBoundingClientRect().bottom<=p.top && Math.abs(p.width-c.width)<1 && p.bottom<=c.top})()`),true, `last message stays above approval panel at ${width}px (${count} pending): ${JSON.stringify(await evaluate('(()=>{const v=document.querySelector("#view"),p=document.querySelector("#approvalPanel"),c=document.querySelector(".cbox"),last=v.querySelector(".msg:last-of-type");return {v:v.getBoundingClientRect().toJSON(),p:p.getBoundingClientRect().toJSON(),c:c.getBoundingClientRect().toJSON(),last:last?.getBoundingClientRect().toJSON()}})()'))}`);
        }
        await evaluate(`(()=>{window.__ccSeed.projects[0].tabs[0].pendingApprovals=[];window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});return true})()`);
      },
      // 9. Screenshots: a transcript message with twelve long-named images; its image button opens the viewer.
      shots: async () => {
        await evaluate(`(()=>{const tab=window.__ccSeed.projects[0].tabs[0];window.__ccDeliver({type:"chatHistory",tabId:tab.id,messages:[{id:"ov-shot",role:"user",text:"Screenshots",images:${JSON.stringify(Array.from({ length: 12 }, (_, index) => `${LONG_PATH}\\screenshot-${index}-${unbroken("long-", 140)}.png`))},at:Date.now(),revision:1}],revision:1,savedRevision:1});return true})()`);
        await waitFor(`document.querySelector("#view [data-open-shot]")!==null`, "transcript image buttons");
        await evaluate(`(()=>{const v=document.querySelector("#view");v.scrollTop=v.scrollHeight;return true})()`);
        await audit("transcript: image attachment buttons with long file names", "#view", { texts: 3, controls: 2 });
        await openAndWait("#view [data-open-shot]", "#viewer");
        await audit("screenshots viewer: one screenshot with its long name", "#viewer", { texts: 2, controls: 3 });
        await evaluate(`document.querySelector("#viewerFiles [data-shot-grid]").click();true`); await delay(200);
        await audit("screenshots viewer with long file names", "#viewer", { texts: 2, controls: 1 }); await escape();
      },
    };
    assert.deepEqual(Object.keys(scenes), Object.keys(STATE_GROUPS), "every state group has its scene, in order");
    const selected = Object.keys(STATE_GROUPS).filter((group) => groups === null || groups.includes(group));
    if (groups) assert.deepEqual(groups.filter((group) => !selected.includes(group)), [], "every requested group exists");
    for (const group of selected) await scenes[group]();
    const allCloseModals = await evaluate(`Array.from(document.querySelectorAll(".modal .dialog-close,.drawer .dialog-close"),x=>"#"+x.closest(".modal,.drawer").id).sort()`);
    if (groups === null) assert.deepEqual([...checkedCloseModals].sort(), allCloseModals, `every modal/drawer with an X was measured at ${width}px`);
    else assert.ok([...checkedCloseModals].every((modal) => allCloseModals.includes(modal)), `every measured X belongs to a real modal at ${width}px`);
    const required = selected.flatMap((group) => STATE_GROUPS[group]);
    assert.deepEqual(checked.map((line) => line.split(" [")[0]).sort(), [...required].sort(), `every required state ran exactly once at ${width}px (groups: ${selected.join(", ")})`);

    inventory.push(...checked);
    return { findings, errors: await evaluate("window.__ccErrors") };
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const gone = () => proc.exitCode !== null || proc.signalCode !== null;
    const facts: string[] = [];
    if (socket?.readyState === WebSocket.OPEN) {
      try { await send("Browser.close"); facts.push("Browser.close answered"); } catch (error) { facts.push(`Browser.close error: ${(error as Error).message}`); }
    } else facts.push("Browser.close not sent (socket not open)");
    // Chrome gets a 20 s grace on purpose, then the shared stop kills its whole tree (never proc.kill() first, which would orphan the helpers the tree kill looks for).
    const stop = await stopChromeTree(proc, { graceMs: 20_000 });
    facts.push(...stop.facts);
    socket?.close();
    facts.push(`exitCode=${proc.exitCode} signalCode=${proc.signalCode}`);
    if (!gone()) {
      const message = `Chrome PID ${proc.pid} did not exit after the overlap audit: ${facts.join("; ")}; stderr=${stderr.slice(-800)}`;
      if (bodyError instanceof Error) bodyError.message += `\n${message}`;
      else assert.fail(message);
    }
  }
}
