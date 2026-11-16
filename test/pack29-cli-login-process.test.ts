import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsService } from "../server/settings/service.ts";
import { createLoginRunner } from "../server/settings/cli-login-runner.ts";
import { fixture } from "./pack29-cli-install.setup.ts";
import { loginRoot, loginFixture, until, start, cancel, codexOutput } from "./pack29-cli-login.setup.ts";

test("hidden spawn has safe environment, stdin pipes, absolute shim and no start", async () => {
  const fx = loginFixture();
  try {
    const done = fx.service.cliLogin(start(), fx.send); await until(() => fx.spawns.length === 1);
    const launch = fx.spawns[0];
    assert.equal(launch.settings.windowsHide, true); assert.equal(launch.settings.shell, false); assert.equal(launch.settings.detached, false);
    assert.deepEqual(launch.settings.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(launch.settings.env.CC_APP_KEY, undefined); assert.equal(launch.settings.env.OPENAI_API_KEY, undefined); assert.equal(launch.settings.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.notEqual(launch.settings.cwd, fx.root); assert.notEqual(launch.settings.cwd, fx.data);
    assert.equal(launch.args.includes("start"), false);
    // exit 0 before close must never be converted to a window-launch failure.
    launch.proc.finish(0, false); setTimeout(() => launch.proc.emit("close", 0), 20);
    await done; assert.equal(fx.events.at(-1).status, "done"); assert.ok(fx.sweeps() >= 1, "normal exit runs strict owned sweep");
  } finally { await fx.cleanup(); }
});

test("failed spawn reports static error with confirmed cleanup", async () => {
  const fx = loginFixture({ runner: createLoginRunner((() => { throw new Error("secret exception"); }) as any) });
  try { await assert.rejects(fx.service.cliLogin(start(), fx.send), /^Error: Could not start sign-in\.$/); assert.equal(fx.service.login.busy, false); }
  finally { await fx.cleanup(); }
});

test("actual fake script handles stdin through registered handler, private output and cancel drain", async () => {
  const fx = fixture(loginRoot), script = fx.write("login.cjs", `process.stdout.write(${JSON.stringify("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=synthetic\nPaste code here if prompted >")});
process.stdin.once('data', data => { require('fs').writeFileSync(${JSON.stringify(join(fx.root, "stdin.json"))}, JSON.stringify([data.toString()])); process.exit(0); }); setInterval(()=>{},1000);`);
  fx.write("claude.exe");
  let child: ReturnType<typeof spawn> | undefined;
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {},
    runCli: async (_bin, args) => ({ code: 0, stdout: args[0] === "--version" ? "1.2.3" : !child ? '{"loggedIn":false}' : '{"loggedIn":true}', stderr: "" }),
    runLogin: createLoginRunner(((_bin: string, _args: string[], options: any) => { child = spawn(process.execPath, [script], options); return child; }) as any) });
  const state = await import("../server/main/state.ts"), config = await import("../server/config.ts");
  const { ChatStore } = await import("../server/chat-store.ts"), { RequestsStore } = await import("../server/requests.ts");
  const { handleMessage } = await import("../server/main/messages/index.ts"), { stateMessage } = await import("../server/main/broadcast.ts");
  state.setWorkspaces({ projects: [], selectedTabId: "" } as any); state.setSelectedTabId(""); state.setSettingsService(service); state.setAcpClis([]);
  state.setChatStore(new ChatStore(join(fx.data, "chats"))); state.setRequestsStore(new RequestsStore(fx.data));
  state.setClientPrefs(config.readClientPrefs()); state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] } as any);
  const replies: any[] = [], outsider: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => replies.push(JSON.parse(raw)) } as any;
  const other = { readyState: 1, send: (raw: string) => outsider.push(JSON.parse(raw)) } as any;
  state.clients.add(ws); state.clients.add(other);
  try {
    handleMessage(ws, JSON.stringify(start("claude")));
    await until(() => replies.some((reply) => reply.phase === "waitingCode"), "script paste prompt", 10000);
    assert.equal(replies.some((reply) => reply.type === "actionResult" && reply.requestId === "login1"), false, "admission is not Done");
    const event = replies.find((reply) => reply.phase === "waitingCode");
    assert.ok((stateMessage() as any).globalWork.includes("a sign-in may still be running"));
    assert.doesNotMatch(JSON.stringify(outsider), /loginId|verificationUrl|deviceCode|synthetic/);
    handleMessage(ws, JSON.stringify({ type: "submitCliLoginCode", cli: "claude", requestId: "paste1", loginId: event.loginId, code: "synthetic-paste-secret" }));
    await until(() => replies.some((reply) => reply.type === "actionResult" && reply.requestId === "login1"), "terminal result", 15000);
    assert.deepEqual(JSON.parse(readFileSync(join(fx.root, "stdin.json"), "utf8")), ["synthetic-paste-secret\n"]);
    assert.doesNotMatch(JSON.stringify(replies), /synthetic-paste-secret/);
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /loginId|verificationUrl|deviceCode|synthetic/);
    assert.equal(service.login.busy, false);
    assert.equal(child?.exitCode, 0);
  } finally { state.clients.delete(ws); state.clients.delete(other); await service.login.drain(); fx.close(); }
});

for (const mode of ["cancel", "shutdown", "orphan"] as const) {
  test(`owned actual sleeping descendant ends on ${mode}, bounded PID confirmation`, { timeout: 40000 }, async () => {
    const fx = fixture(loginRoot); fx.write("codex.exe");
    const pidFile = join(fx.root, "descendant.pid");
    const script = fx.write("family.cjs", `const {spawn}=require('child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore',detached:false});
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
process.stdout.write(${JSON.stringify(codexOutput)});
${mode === "orphan" ? 'setTimeout(()=>process.exit(0),6200);' : ''}
setInterval(()=>{},1000);`);
    let rootPid: number | undefined;
    const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {},
      runCli: async (_bin, args) => ({ code: 0, stdout: args.includes("--version") ? "1.2.3" : !rootPid ? "not logged in" : "Logged in using ChatGPT", stderr: "" }),
      runLogin: createLoginRunner(((_bin: string, _args: string[], options: any) => { const child = spawn(process.execPath, [script], options); rootPid = child.pid; return child; }) as any) });
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
    try {
      const done = service.cliLogin(start(), () => {});
      const result = mode === "orphan" ? done : assert.rejects(done, /stopped/);
      await until(() => existsSync(pidFile), "owned descendant pid", 10000);
      const descendant = Number(readFileSync(pidFile, "utf8")); assert.ok(descendant > 0);
      if (mode === "cancel") await service.cliLogin(cancel(), () => {});
      if (mode === "shutdown") { service.login.close(); assert.equal(await service.login.drain(), true); }
      await result;
      await until(() => gone(descendant), `descendant ${descendant} ended on ${mode}`, 5000);
      // The root has exited by now, but Windows can still list its pid for a moment under load: wait for it like the descendant.
      assert.ok(rootPid, "owned root pid");
      await until(() => gone(rootPid!), `owned root ${rootPid} gone`, 5000);
      assert.equal(service.login.busy, false);
      console.log(`owned tree ${mode}: root ${rootPid}, descendant ${descendant}, confirmed gone`);
    } finally { assert.equal(await service.login.drain(), true); fx.close(); }
  });
}
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { windowsSystem32 } from "../server/leader-common/cli-path.ts";

test("Windows login shim uses absolute System32 cmd and fixed quoted argv without start", { skip: process.platform !== "win32" }, async () => {
  const fx = fixture(loginRoot); const program = fx.write("codex.cmd"); let launch: any;
  const run = createLoginRunner(((bin: string, args: string[], options: any) => {
    launch = { bin, args, options };
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    setImmediate(() => { child.emit("exit", 0); child.emit("close", 0); }); return child;
  }) as any);
  try {
    const child = run({ cli: "codex", env: { ...fx.env, ComSpec: "hostile.exe" }, signal: new AbortController().signal, timeoutMs: 1000, output() {} });
    assert.equal((await child.done).cleanupConfirmed, true);
    assert.equal(launch.bin, join(windowsSystem32(), "cmd.exe"));
    assert.deepEqual(launch.args, ["/d", "/s", "/c", `""${program}" "login" "--device-auth""`]);
    assert.equal(launch.options.windowsVerbatimArguments, true); assert.equal(launch.options.windowsHide, true); assert.equal(launch.args.includes("start"), false);
  } finally { fx.close(); }
});
