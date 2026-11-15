import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDetachedLoginLauncher } from "../server/settings/cli-login-runner.ts";
import { SettingsService } from "../server/settings/service.ts";
import { fixture } from "./pack29-cli-install.setup.ts";

test("GitHub launcher succeeds on spawn with ignored pipes even when exit has no close", async () => {
  const fx = fixture(); let unrefs = 0; const calls: any[] = [];
  const launch = createDetachedLoginLauncher(((bin: string, args: string[], options: any) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter() as any; child.unref = () => { unrefs++; };
    queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0); });
    return child;
  }) as any);
  const service = new SettingsService({ dataRoot: fx.data, launchGitHub: launch, loginRecheckMs: 1,
    runCli: async () => ({ code: 0, stdout: "Logged in to github.com account test-user", stderr: "" }) });
  try {
    await service.loginGitHub("github");
    assert.equal(service.state.github.action?.status, "done"); assert.equal(unrefs, 1);
    assert.equal(calls.length, 1); assert.match(calls[0].bin, /[\\/]System32[\\/]cmd\.exe$/i);
    assert.deepEqual(calls[0].args, ["/d", "/c", "start", "", "gh", "auth", "login", "--web"]);
    assert.equal(calls[0].options.stdio, "ignore"); assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
    const deadline = Date.now() + 2000;
    while (service.state.github.connected !== true) {
      assert.ok(Date.now() < deadline, "GitHub status watcher timeout");
      await new Promise((done) => setTimeout(done, 5));
    }
  } finally { fx.close(); }
});

test("GitHub launcher reports spawn error and thrown launch as failures", async () => {
  for (const throws of [true, false]) {
    const launch = createDetachedLoginLauncher((() => {
      if (throws) throw new Error("synthetic");
      const child = new EventEmitter() as any;
      queueMicrotask(() => child.emit("error", new Error("synthetic"))); return child;
    }) as any);
    assert.equal(await launch(), false);
  }
});
