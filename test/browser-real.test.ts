import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { harnessSource } from "./source-text.ts";
import { APP_KEY, CHROME, REPO, phase } from "./browser-constants.ts";
import { workspaces, waitServer, stopServer, getServerState, fakeParallelState, proxyServer, shutProxy } from "./browser-helpers.ts";
import { realAudit, layoutAuditAtWidth, titleBarAudit, pack2Audit, pack3Audit } from "./browser-real-steps-layout.ts";
import { b2Audit } from "./browser-real-steps-b2.ts";
import { packCWidthAudit, packCRealSettingsAudit, requestsRealAudit, looksWriteAudit, looksRefusalAudit, looksReadAudit, fakeRunnerRecordAudit } from "./browser-real-steps-packc.ts";

test("browser harness exercises the real app, server actions, safety shell and responsive layout", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);

  const temp = mkdtempSync(join(tmpdir(), "cc-packb-browser-"));
  const dataDir = join(temp, "data"); const configDir = join(dataDir, "config"); mkdirSync(configDir, { recursive: true });
  const testHome = join(temp, "test-home"); mkdirSync(testHome, { recursive: true });
  const workspaceData = workspaces(temp);
  mkdirSync(join(testHome, ".gemini"), { recursive: true });
  writeFileSync(join(testHome, ".gemini", "GEMINI.md"), "temporary global Gemini instructions\n", "utf8");
  const alphaDevFolder = workspaceData.projects[0].tabs[0].folder;
  writeFileSync(join(alphaDevFolder, "GEMINI.md"), "temporary project Gemini instructions\n", "utf8");
  writeFileSync(join(configDir, "workspaces.json"), JSON.stringify(workspaceData, null, 2));
  const fakeResponses = Object.fromEntries([
    [["claude", "--version"], { code: 0, stdout: "Claude Code 2.1.0\n", stderr: "" }],
    [["claude", "auth", "status"], { code: 0, stdout: "Not logged in\n", stderr: "" }],
    [["claude", "mcp", "list"], { code: 0, stdout: "claude_mcp: npx -y local-server\n", stderr: "" }],
    [["claude", "mcp", "add", "-s", "user", "valid_mcp", "--", "npx", "-y", "server"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "mcp", "remove", "-s", "user", "claude_mcp"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "plugin", "list"], { code: 0, stdout: "sample-plugin\n", stderr: "" }],
    [["claude", "plugin", "install", "sample-plugin"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["claude", "plugin", "uninstall", "sample-plugin"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["cmd", "/c", "start", "", "claude", "auth", "login"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["cmd", "/c", "start", "", "gh", "auth", "login", "--web"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["codex", "--version"], { code: 0, stdout: "codex-cli 0.155.1\n", stderr: "" }],
    [["codex", "login", "status"], { code: 0, stdout: "Not logged in\n", stderr: "" }],
    [["codex", "mcp", "list"], { code: 0, stdout: "No MCP servers configured.\n", stderr: "" }],
    [["opencode", "--version"], { code: 0, stdout: "OpenCode 1.2.3\n", stderr: "" }],
    [["opencode", "auth", "list"], { code: 0, stdout: "No providers configured\n", stderr: "" }],
    [["opencode", "mcp", "list"], { code: 0, stdout: "No MCP servers configured.\n", stderr: "" }],
    [["gemini", "--version"], { code: 127, stdout: "", stderr: "not installed" }],
    [["npm", "install", "-g", "@google/gemini-cli"], { code: 1, stdout: "", stderr: "scripted refusal" }],
    [["gh", "auth", "status"], { code: 0, stdout: "not logged in\n", stderr: "" }],
  ].map(([argv, result]) => [JSON.stringify(argv), result]));
  const fakeScript = join(temp, "fake-cli-script.json");
  const fakeRecord = join(temp, "fake-cli-argv.jsonl");
  writeFileSync(fakeScript, JSON.stringify({ responses: fakeResponses }));
  const childEnv = { ...process.env, HOME: testHome, USERPROFILE: testHome, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: fakeScript, CC_TEST_FAKE_CLI_RECORD: fakeRecord, CC_DATA_DIR: dataDir, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_TEST_FORCE_PACKAGED: "1", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.equal(childEnv.CC_TEST_FAKE_CLI, "1", "browser server must start with the fake CLI runner enabled");
  assert.equal(childEnv.CC_TEST_FAKE_CLI_SCRIPT, fakeScript, "browser fake responses must come from this test's temp directory");
  assert.equal(childEnv.CC_TEST_FAKE_CLI_RECORD, fakeRecord, "browser CLI calls must be recorded in this test's temp directory");
  assert.equal(childEnv.CC_DATA_DIR, dataDir, "browser server data must stay in this test's temp directory");
  assert.equal(childEnv.CC_PORT, "0", "the OS picks the port at the server's own listen, so no other test can take it first");
  assert.equal(childEnv.CC_SKIP_LEADER_CHECK, "1");
  assert.equal(childEnv.CC_SKIP_DISCOVERY, "1");
  assert.equal(childEnv.HOME, testHome);
  assert.equal(childEnv.USERPROFILE, testHome);
  const child = spawn(process.execPath, [join(REPO, "server", "index.ts")], {
    cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  attachCrashCatcher(child.pid, "browser");
  let proxy: ReturnType<typeof proxyServer> | null = null;
  try {
    const actualPort = await waitServer(child);
    assert.notEqual(actualPort, 4317, "the test server must never use the real app's port");
    const folder = join(temp, "folders", "picker-choice");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "GEMINI.md"), "temporary project Gemini instructions\n", "utf8");
    const settingsFolder = join(temp, "folders", "settings-picker-choice");
    mkdirSync(settingsFolder, { recursive: true });
    writeFileSync(join(settingsFolder, "GEMINI.md"), "temporary Settings picker Gemini instructions\n", "utf8");
    const script = harnessSource();
    const seed = fakeParallelState(await getServerState(actualPort));
    if (process.env.CC_BROWSER_DEBUG_ONLY !== "1" && phase("real")) {
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    await realAudit(proxy, temp, folder);
    shutProxy(proxy);
    }
    const widths = process.env.CC_BROWSER_WIDTHS ? process.env.CC_BROWSER_WIDTHS.split(",").map(Number) : [1600, 1280, 1100, 1024];
    const layoutResults = [];
    // Saved personal pictures from before the simple look: an old preset and an old portrait fall back to Ash; an upload stays.
    const uploadedMe = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pHUAAAAASUVORK5CYII=";
    const oldMe: Record<number, { saved: string; expected: string }> = { 1600: { saved: "astra.jpg", expected: "/avatars/ash.svg" }, 1280: { saved: "me-3.jpg", expected: "/avatars/ash.svg" }, 1100: { saved: uploadedMe, expected: uploadedMe } };
    for (const width of phase("layout") ? widths : []) {
      proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: width === 1024, oldMe: oldMe[width] }, script);
      await layoutAuditAtWidth(proxy, temp, folder, width, layoutResults, oldMe);
      shutProxy(proxy);
      proxy = null;
    }
    assert.equal(layoutResults.length, phase("layout") ? widths.length : 0);
    if (phase("titlebar")) {
    // The window's own minimize, maximize/restore and close buttons: a fresh fake page with the Electron bridge, at the app's minimum width (MIN_WIDTH in electron/window-state.js, used by sanitizeWindowBounds).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed, windowButtons: true }, script);
    await titleBarAudit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    }
    if (phase("pack2")) {
    // Fix pack 2, block 3: the page's behaviour fixes, one named check each (see runPackTwo in test/browser-harness/*.js).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed }, script);
    await pack2Audit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    }
    if (phase("pack3")) {
    // Fix pack 3, block 2: page behaviour that had no test at all (see runPackThree in test/browser-harness/*.js).
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed }, script);
    await pack3Audit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    }
    if (phase("b2")) {
    proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: true }, script);
    await b2Audit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    }

    if (phase("packc")) {
    const packCWidths = [1600, 1280, 1024];
    for (const width of packCWidths) {
      proxy = proxyServer(actualPort, { folder, mode: "fake", seed, storageBlocked: width === 1024 }, script);
      await packCWidthAudit(proxy, temp, folder, width);
      shutProxy(proxy); proxy = null;
    }

    for (const width of packCWidths) {
      assert.equal(childEnv.CC_TEST_FAKE_CLI, "1", `real Settings browser audit at ${width}px must use the scripted fake CLI runner`);
      assert.equal(childEnv.CC_TEST_FAKE_CLI_SCRIPT, fakeScript, `real Settings browser audit at ${width}px must use its temporary response script`);
      assert.equal(childEnv.CC_DATA_DIR, dataDir, `real Settings browser audit at ${width}px must use temporary server data`);
      assert.equal(childEnv.CC_PORT, "0", `real Settings browser audit at ${width}px must use the isolated server it started`);
      assert.notEqual(actualPort, 4317);
      proxy = proxyServer(actualPort, { folder: settingsFolder, mode: "real" }, script);
      await packCRealSettingsAudit(proxy, temp, settingsFolder, width);
      shutProxy(proxy); proxy = null;
    }

    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    await requestsRealAudit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    }

    if (phase("looks")) {
    // The actual restart bug: the app window opens on a new random port each launch, so its localStorage is a new, empty one. The same real
    // server is opened from two different proxy ports (two origins, two Chrome profiles); the second page must wear what the first chose.
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    const { looksWrite, writePort } = await looksWriteAudit(proxy, temp, folder);
    shutProxy(proxy); proxy = null;
    await looksRefusalAudit(actualPort);
    proxy = proxyServer(actualPort, { folder, mode: "real" }, script);
    await looksReadAudit(proxy, temp, folder, looksWrite, writePort);
    shutProxy(proxy); proxy = null;
    }

    if (phase("packc")) {
    await fakeRunnerRecordAudit(fakeRecord);
    }
  } finally {
    if (proxy) { proxy.wss.close(); proxy.proxy.close(); }
    try { await stopServer(child); } // a stop that rejects or times out still surfaces, after the temp folder is gone
    finally { rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 }); }
  }
});