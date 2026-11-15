import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { noVendor, ownedTemp } from "./opencode-models.setup.ts";
import { resolveCliOrThrow, setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { createLoginRunner } from "../server/settings/cli-login-runner.ts";
import { startKeyServer } from "../server/settings/opencode/key-server.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";

test("native authentication paths with ! and % reach injected spawn with fixed argv and shell false; unsafe shims refuse", { skip: process.platform !== "win32" }, async (t) => {
  noVendor(t); const root = ownedTemp(t);
  for (const char of ["!", "%"]) for (const ext of ["exe", "cmd", "bat"]) {
    const bin = join(root, `profile${char}-${ext}`); mkdirSync(bin);
    const env = { PATH: bin, USERPROFILE: root, SystemRoot: process.env.SystemRoot, CC_TEST_FAKE_CLI: "1" };
    for (const name of ["codex", "opencode"]) writeFileSync(join(bin, `${name}.${ext}`), "inert");
    const calls: any[] = [];
    const spawn = ((program: string, args: string[], options: any) => {
      calls.push({ program, args, options });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null });
      setImmediate(() => { child.stdout.write("listening on http://127.0.0.1:1234\n"); child.emit("exit", 0); child.emit("close", 0); }); return child;
    }) as any;
    const native = ext === "exe";
    if (native) {
      assert.doesNotThrow(() => assert.equal(resolveCliOrThrow("codex", env, undefined, true), join(bin, "codex.exe")), "native resolution must accept the literal profile path");
      setCliSkipFolders(() => [bin]);
      try { assert.throws(() => resolveCliOrThrow("codex", env, undefined, true), /project folder/); }
      finally { setCliSkipFolders(() => []); }
      if (char === "%") assert.throws(() => resolveCliOrThrow("codex", env), /not found/);
    }
    const login = createLoginRunner(spawn)({ cli: "codex", env, signal: new AbortController().signal, timeoutMs: 1000, output() {} });
    assert.equal((await login.done).code, native ? 0 : -1);
    if (native) {
      let server!: ReturnType<typeof startKeyServer>;
      assert.doesNotThrow(() => { server = startKeyServer(env, new AbortController().signal, { spawn }); }, `native ${char}-${ext} profile path must start the key server, not refuse with launchFailed`);
      assert.equal(await server.origin, "http://127.0.0.1:1234");
      await new Promise((done) => setImmediate(done)); assert.equal(await server.stop(), true);
      const probe = createCliRunner(spawn, env);
      assert.equal((await probe("opencode", ["auth", "list"], { timeoutMs: 1000, directExecutable: true })).code, 0);
      assert.deepEqual(calls.map((c) => c.args), [["login", "--device-auth"], ["serve", "--hostname", "127.0.0.1", "--port", "0"], ["auth", "list"]]);
      assert.ok(calls.every((c) => c.options.shell === false && c.program.startsWith(bin)));
    } else {
      assert.throws(() => startKeyServer(env, new AbortController().signal, { spawn }), /launchFailed|not found/);
      assert.equal(calls.length, 0, "unsafe shim never reaches injected spawn");
    }
  }
});
