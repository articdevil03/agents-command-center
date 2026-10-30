import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { WebSocket } from "ws";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { HOST, APP_KEY, child, BASE_ORIGIN, stopChild, waitReady, root, request, keyedSocket, openWs, nextMessage, nextState, nextMessages } from "./http-helpers.ts";

test("HTTP request helper fails when a server does not answer before its deadline", async () => {
  const stalled = http.createServer(() => {});
  await new Promise<void>((resolveListen, reject) => {
    stalled.once("error", reject);
    stalled.listen(0, HOST, resolveListen);
  });
  const address = stalled.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(request({ port: address.port, path: "/never-answers", deadlineMs: 100 }), /HTTP request timed out after 100ms/);
  } finally {
    stalled.closeAllConnections();
    await new Promise<void>((resolveClose) => stalled.close(() => resolveClose()));
  }
});

test("WebSocket helpers fail with a message when the server never answers, instead of waiting for the runner's timeout", { timeout: 10_000 }, async () => {
  const ws = await openWs();
  try {
    await assert.rejects(nextMessage(ws, 100), /no WebSocket message within 100ms/);
    await assert.rejects(nextMessages(ws, 2, 100), /only 0 of 2 WebSocket messages within 100ms/);
    assert.equal(ws.listenerCount("message"), 0, "the timed-out waits left no listener behind");
  } finally { ws.close(); }
});

test("HTTP request helper rejects a response that aborts mid-body", async () => {
  const interrupted = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
    setImmediate(() => res.destroy());
  });
  await new Promise<void>((resolveListen, reject) => {
    interrupted.once("error", reject);
    interrupted.listen(0, HOST, resolveListen);
  });
  const address = interrupted.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(request({ port: address.port, path: "/interrupted", deadlineMs: 1000 }), (error: Error) => {
      assert.match(error.message, /aborted|ECONNRESET|socket hang up/i);
      return true;
    });
  } finally {
    interrupted.closeAllConnections();
    await new Promise<void>((resolveClose) => interrupted.close(() => resolveClose()));
  }
});

test("Save error names the tab and action that failed", async () => {
  const ws = keyedSocket({ origin: BASE_ORIGIN });
  try {
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new assert.AssertionError({ message: "Save error response timed out" })), 5000);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type !== "error") return;
        clearTimeout(timer); resolve(message);
      });
      ws.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "save", tabId: "missing-tab" }));
    const error = await result;
    assert.equal(error.action, "save", `matched Save action metadata: ${JSON.stringify(error)}`);
    assert.equal(error.tabId, "missing-tab", `matched failed tab id: ${JSON.stringify(error)}`);
  } finally { ws.close(); }
});

test("refused requests name their action and target; history errors name no held action", async () => {
  const ws = await openWs();
  try {
    const refusedChat = nextMessage(ws);
    ws.send(JSON.stringify({ type: "chat", tabId: "missing-tab", text: "hi", images: Array.from({ length: 9 }, () => "x.png") }));
    const chatError = await refusedChat;
    assert.deepEqual([chatError.type, chatError.action, chatError.tabId, chatError.projectId], ["error", "chat", "missing-tab", undefined], `matched ${JSON.stringify(chatError)}`);
    const refusedProject = nextMessage(ws);
    ws.send(JSON.stringify({ type: "removeProject", projectId: "missing-project" }));
    const projectError = await refusedProject;
    assert.deepEqual([projectError.action, projectError.projectId, projectError.tabId], ["removeProject", "missing-project", undefined], `matched ${JSON.stringify(projectError)}`);
    const history = nextMessage(ws);
    ws.send(JSON.stringify({ type: "historyList", seatKey: "../outside/run" }));
    const historyError = await history;
    assert.equal(historyError.type, "error");
    assert.equal(historyError.action, undefined, `history lookups are not held actions: ${JSON.stringify(historyError)}`);
  } finally { ws.close(); }
});

test("setPermissionMode with no live leader saves for the next session", async () => {
  const ws = await openWs();
  try {
    const initialState = nextMessages(ws, 2);
    ws.send(JSON.stringify({ type: "hello" }));
    const [initial] = await initialState;
    const tabId = initial.projects[0].tabs[0].id;
    const requestId = "perm_no_leader";
    const changed = nextState(ws, (state) => {
      const tab = state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === tabId);
      const action = state.settings.permissionActions[tabId];
      return tab?.permissionMode === "plan" && action?.requestId === requestId && action.status === "done";
    });
    ws.send(JSON.stringify({ type: "setPermissionMode", requestId, tabId, mode: "plan" }));
    const state = await changed;
    const tab = state.projects.flatMap((project: any) => project.tabs).find((item: any) => item.id === tabId);
    assert.equal(tab.permissionMode, "plan");
    assert.equal(state.settings.permissionActions[tabId].status, "done");
  } finally { ws.close(); }
});

// ---- guard 6 (P2): scratch (pasted images) must follow the same data root
// as config/logs, not the app's own re-extracted-on-every-launch directory --
// proven through a real running server, not the pure resolveDataRoot helper.
// This child needs CC_DATA_DIR honoured (real packaged behaviour), while
// NODE_TEST_CONTEXT stays set. CC_TEST_FORCE_PACKAGED is the narrow override
// that lets the data-root test exercise both conditions at once.
//
// Pure so the decision -- NODE_TEST_CONTEXT preserved, the override added --
// is provable without spawning anything real.
function packagedDataRootChildEnv(baseEnv: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  return { ...baseEnv, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1", CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1" };
}

test("packaged-data-root child env keeps NODE_TEST_CONTEXT set while forcing the packaged data root", () => {
  const env = packagedDataRootChildEnv({ NODE_TEST_CONTEXT: "child-v8", PATH: "kept" }, "C:\\fake\\data-dir");
  assert.equal(env.NODE_TEST_CONTEXT, "child-v8");
  assert.equal(env.CC_TEST_FORCE_PACKAGED, "1");
  assert.equal(env.CC_DATA_DIR, "C:\\fake\\data-dir");
  assert.equal(env.PATH, "kept");
});

// Both the capture guard and the live test execute this exact spawn call.
function spawnPackagedServer(dataDir: string): ChildProcess {
  const options = {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"] as const,
    windowsHide: true,
    env: packagedDataRootChildEnv(process.env, dataDir),
  };
  // Fail before launching anything if a mutation removes the vault backstop.
  assert.ok(options.env.NODE_TEST_CONTEXT, "packaged spawn must retain NODE_TEST_CONTEXT");
  return spawn(process.execPath, [join(root, "server", "index.ts")], options);
}

test("packaged spawn actual options retain the test context", () => {
  const source = readFileSync("test/http-requests-packaged.test.ts", "utf8");
  const match = source.match(/function spawnPackagedServer\([^]*?^}/m);
  assert.ok(match);
  let captured;
  const launch = runInNewContext(stripTypeScriptTypes(`${match[0]}; spawnPackagedServer`), {
    assert, root: "fake-root", join, packagedDataRootChildEnv, testHome: "fake-home",
    process: { execPath: "node", env: { NODE_TEST_CONTEXT: "child-v8", PATH: "kept", HOME: "fake-home", USERPROFILE: "fake-home", CC_TEST_FAKE_CLI: "1" } },
    spawn: (_command, _args, options) => { captured = options; return {}; },
  });
  launch("fake-data");
  assert.ok(captured, "must execute the real spawn call");
  assert.equal(captured.env.NODE_TEST_CONTEXT, "child-v8");
  assert.equal(captured.env.CC_TEST_FORCE_PACKAGED, "1");
  assert.equal(captured.env.CC_DATA_DIR, "fake-data");
  assert.equal(captured.env.HOME, "fake-home");
  assert.equal(captured.env.USERPROFILE, "fake-home");
  assert.equal(captured.env.CC_TEST_FAKE_CLI, "1");
  assert.equal(captured.env.PATH, "kept");
});

test("POST /api/paste-image: a packaged data root moves scratch with it", async () => {
  // Root this fixture under OS temp so a killed test worker cannot leave a .cc-test-* tree in the repo.
  const dataDir = mkdtempSync(join(tmpdir(), "cc-packaged-data-"));
  let proc: ChildProcess | undefined;
  try {
    proc = spawnPackagedServer(dataDir);
    attachCrashCatcher(proc.pid, "http-packaged");
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const port = await waitReady(proc);
    const res = await request({ port, method: "POST", path: "/api/paste-image",
      headers: { Origin: `http://${HOST}:${port}`, "Content-Type": "image/png", "X-Request-Id": "upload_packaged" },
      body: "packaged test png", deadlineMs: 5000 });
    assert.equal(res.status, 200);
    const saved = JSON.parse(res.body).path;
    assert.equal(dirname(saved), join(dataDir, "scratch"), "scratch must follow CC_DATA_DIR, not the app's own root");
    assert.equal(readFileSync(saved, "utf8"), "packaged test png");
  } finally {
    try { if (proc) await stopChild(proc); }
    finally { removeWithRetry(dataDir); }
  }
});
