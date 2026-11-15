import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { SettingsService } from "../server/settings/service.ts";
import { fixture } from "./pack29-cli-install.setup.ts";
import { setEnv } from "./temp-root.ts";

test("test mode default managed login refuses every managed tool before spawn or stdin", async (t) => {
  const fx = fixture(), restore = setEnv({ CC_TEST_FAKE_CLI: "1" });
  const spy = t.mock.method(childProcess, "spawn", () => { throw new Error("spawn forbidden"); });
  syncBuiltinESMExports();
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {},
    runCli: async () => ({ code: 0, stdout: "1.2.3", stderr: "" }) });
  try {
    const managed = CLI_CATALOG.filter((entry) => entry.signIn.managed && entry.id !== "opencode");
    assert.ok(managed.length > 0, "managed catalog FOUND");
    for (const entry of managed) {
      fx.write(`${entry.detection!.program}.exe`);
      const events: any[] = [];
      await assert.rejects(service.cliLogin({ type: "cliLogin", requestId: `safe-${entry.id}`, cli: entry.id }, (event) => events.push(event)), /^Error: Could not start sign-in\.$/);
      assert.equal(events.at(-1).reason, "launchFailed", entry.id);
      assert.equal(service.state.catalogTools[entry.id].action?.message, "Could not start sign-in.", entry.id);
      assert.equal(events.at(-1).pasteRequired, false, entry.id);
      assert.equal(service.login.busy, false, entry.id);
      assert.equal(spy.mock.callCount(), 0, `${entry.id}: no spawn, hence no stdin`);
    }
    console.log(`SAFETY managed tools FOUND: ${managed.map((entry) => entry.id).join(", ")}; spawn=0`);
  } finally { await service.login.drain(); spy.mock.restore(); syncBuiltinESMExports(); restore(); fx.close(); }
});

test("test mode default installer cannot spawn for any installable catalog tool", async (t) => {
  const fx = fixture(), restore = setEnv({ CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: "" });
  const spy = t.mock.method(childProcess, "spawn", () => { throw new Error("installer spawn forbidden"); });
  syncBuiltinESMExports();
  const service = new SettingsService({ dataRoot: fx.data, env: fx.env, refreshPath: async () => {} });
  try {
    const entries = CLI_CATALOG.filter((entry) => entry.recipe);
    assert.equal(entries.length, 11, "all installable tools FOUND");
    for (const entry of entries) {
      await assert.rejects(service.installCli(entry.id, `safe-${entry.id}`, true));
      assert.equal(spy.mock.callCount(), 0, entry.id);
    }
    console.log(`SAFETY installers FOUND: ${entries.map((entry) => entry.id).join(", ")}; spawn=0`);
  } finally { await service.installer.drain(); spy.mock.restore(); syncBuiltinESMExports(); restore(); fx.close(); }
});

import { createKeyRunner } from "../server/settings/opencode/key.ts";
for (const source of ["host", "injected"]) {
  test(source + " fake-CLI flag blocks default key-server runner with supplied probe runner", async (t) => {
    const fx = fixture(), restore = setEnv({ CC_TEST_FAKE_CLI: source === "host" ? "1" : "" });
    fx.write("opencode.exe");
    const spawnSpy = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN vendor process"); });
    const fetchSpy = t.mock.method(globalThis, "fetch", () => { throw new Error("FORBIDDEN vendor network"); });
    syncBuiltinESMExports();
    try {
      const runner = createKeyRunner({ run: async (_bin, args) => ({ code: 0, stdout: args[0] === "--version" ? "1.19.5" : "0 credentials", stderr: "" }) });
      const result = await runner({ env: { ...fx.env, ...(source === "injected" ? { CC_TEST_FAKE_CLI: "1" } : {}) },
        apiKey: "synthetic-default-key", replace: false, signal: new AbortController().signal, timeoutMs: 1000 });
      assert.equal(result.saved, false); assert.equal(result.cleanupConfirmed, true);
      assert.equal((result as any).reason, "launchFailed");
      assert.equal(spawnSpy.mock.callCount(), 0); assert.equal(fetchSpy.mock.callCount(), 0);
    } finally { spawnSpy.mock.restore(); fetchSpy.mock.restore(); syncBuiltinESMExports(); restore(); fx.close(); }
  });
}
