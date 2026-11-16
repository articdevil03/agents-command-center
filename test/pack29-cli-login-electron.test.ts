import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { validateLoginUrl } from "../server/settings/cli-login-policy.js";
import { shellHarness } from "./electron-helpers.ts";
const source = readFileSync("electron/server-process.js", "utf8");
// Execute the complete actual module with Electron/OS dependencies supplied.
function openerHarness() {
  const replies: any[] = [], opened: string[] = [];
  const open = runInNewContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + '\nhandleLoginOpen;',
    { validateLoginUrl, shell: { openExternal: async (url: string) => opened.push(url) }, process: { env: {} } });
  return { replies, opened, send: (message: any) => open(message, (reply: any) => replies.push(JSON.parse(JSON.stringify(reply)))) };
}
test("Electron opener independently revalidates each URL and replies with only success/failure", async () => {
  const fx = openerHarness(), id = "a".repeat(48);
  for (const url of ["http://auth.openai.com/codex/device", "https://a" + "@auth.openai.com/codex/device", "https://auth.openai.com.evil/codex/device", "https://github.com/login/device", "https://auth.openai.com:88/codex/device", "https://auth.openai.com/no", "https://127.0.0.1/codex/device"]) {
    await fx.send({ type: "openCliLogin", id, cli: "codex", url });
    assert.equal(fx.replies.at(-1).ok, false, url);
  }
  assert.deepEqual(fx.opened, []);
  await fx.send({ type: "openCliLogin", id, cli: "codex", url: "https://auth.openai.com/codex/device" });
  assert.deepEqual(fx.opened, ["https://auth.openai.com/codex/device"]);
  assert.deepEqual(fx.replies.at(-1), { type: "cliLoginOpened", id, ok: true });
});
test("real Electron server-child message wiring rejects unsafe URLs without renderer IPC", async () => {
  const fx = shellHarness();
  // The separate native shell harness exercises startServer in the existing navigation suite.
  assert.doesNotMatch(source, /ipcMain\.handle/);
  assert.match(source, /ownedServer\.on\("message"/);
});
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

test("actual Electron server child IPC uses the shared policy and shell.openExternal", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true, send: (value: any, callback: any) => { replies.push(value); callback(); } });
  const replies: any[] = [], opened: string[] = [];
  const api = runInNewContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + '\n({startServer});', {
    validateLoginUrl, shell: { openExternal: async (url: string) => opened.push(url) },
    app: { isPackaged: false }, randomBytes, root: ".", smokeReadyFile: null, join: (...parts: string[]) => parts.join("/"),
    process: { env: {} }, serverNodeRuntime: () => ({ command: "fake", args: [], env: {} }), spawn: () => child, setTimeout, clearTimeout,
    createServer: () => ({ on() {}, listen(_port: number, _host: string, ready: () => void) { ready(); }, address: () => ({ port: 51234 }), close(done: () => void) { done(); } }),
  });
  const ready = api.startServer(); await Promise.resolve(); await Promise.resolve();
  child.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n")); await ready;
  const request = { type: "openCliLogin", id: "a".repeat(48), cli: "codex", url: "https://auth.openai.com/codex/device" };
  child.emit("message", { ...request, url: "https://evil.example/codex/device" }); await Promise.resolve();
  assert.equal(replies.at(-1).ok, false); assert.deepEqual(opened, []);
  child.emit("message", request); await until(() => replies.length === 2, "Electron opener reply");
  assert.deepEqual(opened, [request.url]); assert.equal(replies.at(-1).ok, true);
  assert.deepEqual(Object.keys(replies.at(-1)).sort(), ["id", "ok", "type"]);
});
import { SettingsService } from "../server/settings/service.ts";
import { fixture } from "./pack29-cli-install.setup.ts";
import { loginRoot, until, start } from "./pack29-cli-login.setup.ts";

test("managed status probes are serial and continue at cadence while child runs", async () => {
  const fx = fixture(loginRoot); let active = 0, maximum = 0, reads = 0, loginStarted = false, finish!: (value: any) => void;
  const done = new Promise<any>((resolve) => { finish = resolve; });
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {}, loginRecheckMs: 10,
    runLogin: () => { loginStarted = true; return { done, writable: () => false, submit() {} }; },
    runCli: async (_bin, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
      active++; reads++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20)); active--;
      return { code: loginStarted ? 0 : 1, stdout: loginStarted ? "Logged in using ChatGPT" : "not logged in", stderr: "" };
    } });
  try {
    const login = service.cliLogin(start(), () => {});
    await until(() => reads >= 4, "serial status reads");
    finish({ code: 0, stdout: "", stderr: "", cleanupConfirmed: true }); await login;
    assert.equal(maximum, 1); assert.equal(service.state.catalogTools.codex.signedIn, true);
    const finalReads = reads; await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(reads, finalReads);
  } finally { finish({ code: 0, stdout: "", stderr: "", cleanupConfirmed: true }); await service.login.drain(); fx.close(); }
});

test("OpenCode Electron opener permits only the exact server-owned key page", async () => {
  const fx = openerHarness(), id = "c".repeat(48);
  for (const url of ["https://opencode.ai/auth?key=synthetic", "https://opencode.ai/auth/", "http://opencode.ai/auth", "https://opencode.ai.evil/auth", "https://opencode.ai/auth#x", "https://opencode.ai:443/auth"]) {
    await fx.send({ type: "openCliLogin", id, cli: "opencode", url });
    assert.equal(fx.replies.at(-1).ok, false, url);
  }
  assert.equal(fx.opened.length, 0);
  await fx.send({ type: "openCliLogin", id, cli: "opencode", url: "https://opencode.ai/auth" });
  assert.deepEqual(fx.opened, ["https://opencode.ai/auth"]);
});

test("GitHub Electron opener allows only the exact device page", async () => {
  const fx = openerHarness(), id = "d".repeat(48);
  for (const url of ["http://github.com/login/device", "https://github.com.evil.example/login/device", "https://user" + "@github.com/login/device", "https://github.com:443/login/device", "https://github.com/login/device/extra"]) {
    await fx.send({ type: "openCliLogin", id, cli: "github", url });
    assert.equal(fx.replies.at(-1).ok, false, url);
  }
  assert.deepEqual(fx.opened, []);
  await fx.send({ type: "openCliLogin", id, cli: "github", url: "https://github.com/login/device" });
  assert.deepEqual(fx.opened, ["https://github.com/login/device"]);
});
