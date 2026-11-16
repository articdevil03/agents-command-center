import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsService } from "../server/settings/service.ts";
import { createLoginRunner } from "../server/settings/cli-login-runner.ts";
import { GITHUB_LOGIN_ARGS, GITHUB_STATUS_ARGS } from "../server/settings/github-login.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";
import { fixture } from "./pack29-cli-install.setup.ts";
import { until } from "./pack29-cli-login.setup.ts";
import { importWithTempDataRoot } from "./temp-root.ts";

const DEVICE_URL = "https://github.com/login/device";
const POSITIVE = "Logged in to github.com account synthetic-user\nActive account: true\n";
function actualFixture(mode: string, deviceUrl = DEVICE_URL) {
  const fx = fixture(); fx.write("gh.exe");
  const record = join(fx.root, "input.json"), pidFile = join(fx.root, "descendant.pid");
  const script = fx.write("gh.cjs", `const fs=require('fs');
const input=[];process.stdin.on('data',data=>{input.push(data.toString());fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(input));});
${["cancel", "shutdown", "timeout"].includes(mode) ? `const kid=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(kid.pid));` : ""}
process.stderr.write('! First copy your one-time co');
setTimeout(()=>process.stderr.write('de: AB12-CD34\\n'),15);
setTimeout(()=>process.stdout.write(${JSON.stringify((mode === "prompt" ? "Press Enter to open " : "Open ") + deviceUrl + " in your browser...\n")}),30);
${mode === "flood" ? "setTimeout(()=>process.stderr.write('x'.repeat(1024*1024+1)),50);" : mode === "second-code" ? "setTimeout(()=>process.stderr.write('one-time code: ZZ99-YY88\\n'),50);" : ""}
${mode === "failure" ? "setTimeout(()=>process.exit(1),100);" : ""}
${mode === "prompt" ? "process.stdin.once('data',()=>setTimeout(()=>process.exit(0),20));" : mode === "no-prompt" ? "setTimeout(()=>process.exit(0),120);" : ""}
setInterval(()=>{},1000);`);
  let child: ChildProcess | undefined;
  const spawns: any[] = [], probes: any[] = [], opened: string[] = [];
  const service = new SettingsService({ dataRoot: fx.data, env: { ...fx.env, CC_TEST_FAKE_CLI: "1" }, refreshPath: async () => {},
    loginTimeoutMs: mode === "timeout" ? 2500 : 20000,
    runCli: async (bin, args, options) => { probes.push({ bin, args, options }); return { code: 0, stdout: args[0] === "--version" ? "2.95.0" : POSITIVE, stderr: "" }; },
    openLogin: async (_cli, url) => { opened.push(url); return true; },
    runLogin: createLoginRunner(((bin: string, args: string[], options: any) => {
      spawns.push({ bin, args, options }); child = spawn(process.execPath, [script], options); return child;
    }) as any) });
  return { ...fx, record, pidFile, service, spawns, probes, opened, child: () => child };
}

test("real GitHub handler, service and piped child support prompt and no-prompt flows without a console", { timeout: 45000 }, async () => {
  const { modules: [state, config, stores, requests, messages, broadcasts] } = await importWithTempDataRoot(() => Promise.all([
    import("../server/main/state.ts"), import("../server/config.ts"), import("../server/chat-store.ts"), import("../server/requests.ts"),
    import("../server/main/messages/index.ts"), import("../server/main/broadcast.ts") ]));
  for (const mode of ["prompt", "no-prompt"]) {
    const fx = actualFixture(mode), replies: any[] = [], outsiders: string[] = [];
    state.setWorkspaces({ projects: [], selectedTabId: "" } as any); state.setSelectedTabId(""); state.setAcpClis([]);
    state.setSettingsService(fx.service); state.setChatStore(new stores.ChatStore(join(fx.data, "chats")));
    state.setRequestsStore(new requests.RequestsStore(fx.data)); state.setClientPrefs(config.readClientPrefs());
    state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] } as any);
    const ws = { readyState: 1, send: (raw: string) => replies.push(JSON.parse(raw)) } as any;
    const other = { readyState: 1, send: (raw: string) => outsiders.push(raw) } as any;
    state.clients.add(ws); state.clients.add(other);
    try {
      messages.handleMessage(ws, JSON.stringify({ type: "ghLogin", requestId: "github1" }));
      await until(() => replies.some((event) => event.phase === "waitingBrowser"), "device prompt", 10000);
      const event = replies.find((event) => event.phase === "waitingBrowser");
      assert.equal(event.deviceCode, "AB12-CD34"); assert.equal(event.verificationUrl, DEVICE_URL);
      assert.ok((broadcasts.stateMessage() as any).globalWork.includes("a sign-in may still be running"));
      messages.handleMessage(ws, JSON.stringify({ type: "openCliLogin", cli: "github", requestId: "open1", loginId: event.loginId }));
      await until(() => fx.opened.length === 1); assert.deepEqual(fx.opened, [DEVICE_URL]);
      await until(() => replies.some((reply) => reply.type === "actionResult" && reply.requestId === "github1"), "final result", 15000);
      assert.equal(fx.service.state.github.connected, true);
      assert.deepEqual(existsSync(fx.record) ? JSON.parse(readFileSync(fx.record, "utf8")) : [], mode === "prompt" ? ["\n"] : []);
      assert.equal(fx.child()?.exitCode, 0); assert.equal(fx.service.login.busy, false);
      assert.equal(fx.spawns.length, 1); assert.deepEqual(fx.spawns[0].args, GITHUB_LOGIN_ARGS);
      for (const call of fx.spawns) { assert.doesNotMatch(call.bin, /cmd\.exe/i); assert.equal(call.args.includes("start"), false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false); }
      assert.deepEqual(fx.probes.at(-1).args, GITHUB_STATUS_ARGS); assert.equal(fx.probes.at(-1).options.directExecutable, true);
      assert.doesNotMatch(JSON.stringify(fx.service.snapshot()), /AB12-CD34|login\/device|synthetic-user/);
      assert.doesNotMatch(outsiders.join(""), /AB12-CD34|login\/device|loginId/);
    } finally { state.clients.delete(ws); state.clients.delete(other); assert.equal(await fx.service.login.drain(), true); fx.close(); }
  }
});

for (const mode of ["cancel", "shutdown", "timeout"]) {
  test(`GitHub real sleeping descendant ends on ${mode}, identity checked`, { timeout: 35000 }, async () => {
    const fx = actualFixture(mode);
    try {
      const pending = fx.service.cliLogin({ type: "cliLogin", cli: "github", requestId: "family" }, () => {});
      const failed = assert.rejects(pending, mode === "timeout" ? /expired/ : /stopped/);
      await until(() => existsSync(fx.pidFile), "descendant pid", 10000);
      const descendant = Number(readFileSync(fx.pidFile, "utf8"));
      const before = await listProcesses();
      assert.ok(before, "identity list available");
      const identities = before.filter((row) => row.pid === descendant || row.pid === fx.child()?.pid);
      assert.equal(identities.length, 2, "owned root and descendant found with creation times");
      if (mode === "cancel") await fx.service.cliLogin({ type: "cancelCliLogin", cli: "github", requestId: "stop", loginRequestId: "family" }, () => {});
      if (mode === "shutdown") assert.equal(await fx.service.login.drain(), true);
      await failed;
      const after = await listProcesses(); assert.ok(after);
      for (const identity of identities) assert.equal(after.some((row) => row.pid === identity.pid && row.created === identity.created), false, `owned identity ${identity.pid} ended`);
      assert.equal(fx.service.login.busy, false);
    } finally { assert.equal(await fx.service.login.drain(), true); fx.close(); }
  });
}

test("scripted GitHub child rejects failures and ignores hostile URLs without opening them", { timeout: 45000 }, async () => {
  const cases = [["failure", DEVICE_URL], ["flood", DEVICE_URL], ["second-code", DEVICE_URL],
    ["host", "https://github.com.evil.example/login/device"], ["http", "http://github.com/login/device"],
    ["userinfo", "https://user" + "@github.com/login/device"], ["port", "https://github.com:8443/login/device"], ["path", DEVICE_URL + "/extra"]];
  for (const [mode, url] of cases) {
    const fx = actualFixture(mode, url);
    try {
      const events: any[] = [];
      const pending = fx.service.cliLogin({ type: "cliLogin", cli: "github", requestId: "bad" }, (event) => events.push(event));
      if (["failure", "flood", "second-code"].includes(mode)) await assert.rejects(pending, /did not finish|unsupported sign-in/);
      else {
        const stopped = assert.rejects(pending, /stopped/);
        await until(() => events.some((event) => event.deviceCode === "AB12-CD34"), "code output", 10000);
        const event = events.find((event) => event.deviceCode === "AB12-CD34");
        // Give the delayed URL chunk time to arrive before requesting the opener.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(events.every((frame) => frame.verificationUrl == null));
        await assert.rejects(fx.service.cliLogin({ type: "openCliLogin", cli: "github", requestId: "open-bad", loginId: event.loginId }, () => {}));
        await fx.service.cliLogin({ type: "cancelCliLogin", cli: "github", requestId: "stop-bad", loginRequestId: "bad" }, () => {});
        await stopped;
      }
      assert.equal(fx.service.state.github.connected, false); assert.deepEqual(fx.opened, []);
      assert.equal(fx.service.login.busy, false);
      assert.ok(fx.child()?.exitCode !== null || fx.child()?.signalCode !== null);
    } finally { assert.equal(await fx.service.login.drain(), true); fx.close(); }
  }
});
