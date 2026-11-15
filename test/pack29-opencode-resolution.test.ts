import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { installFixture, ok } from "./pack29-opencode-install.setup.ts";
import { createCandidate, managedCli, managedRoot, publishCandidate } from "../server/settings/opencode/paths.ts";
import { leaderChildEnv, resolveCliPath, withResolvedCli, setCliSkipFolders, windowsSystem32 } from "../server/leader-common/cli-path.ts";
import { refreshProcessPath } from "../server/leader-common/path-refresh.ts";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import { detectCatalogTool, openCodeCredentialSource } from "../server/settings/cli-auth.ts";

test("valid managed descriptors refuse internal links and outside-root realpaths independently", async (t) => {
  const fx = await installFixture(t);
  try {
    const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe"); writeFileSync(exe, "inert");
    await publishCandidate(candidate.root, exe, "1.19.5");
    assert.equal(managedCli(fx.env), exe, "healthy valid descriptor control");
    for (const kind of ["link", "outside"]) {
      const stat = fs.lstatSync, real = fs.realpathSync; let reached = 0;
      const spy = kind === "link" ? t.mock.method(fs, "lstatSync", ((path: any, ...args: any[]) => {
        const value = (stat as any)(path, ...args);
        if (String(path) === exe) { reached++; return new Proxy(value, { get(target, key) { return key === "isSymbolicLink" ? () => true : Reflect.get(target, key); } }); }
        return value;
      }) as any) : t.mock.method(fs, "realpathSync", ((path: any, ...args: any[]) => {
        if (String(path) === exe) { reached++; return join(fx.root, "outside.exe"); }
        return (real as any)(path, ...args);
      }) as any);
      syncBuiltinESMExports();
      try { assert.equal(managedCli(fx.env), null, kind); assert.ok(reached > 0, kind + " filesystem boundary reached"); }
      finally { spy.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(managedCli(fx.env), exe, "restored healthy control");
    }
  } finally { await fx.close(); }
});

test("a descriptor naming a DIRECTORY called opencode.exe is refused, a real file at the same path is accepted", async (t) => {
  const fx = await installFixture(t);
  try {
    const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe");
    fs.mkdirSync(exe); // a real directory, no link or junction, inside the temp managed folder
    await publishCandidate(candidate.root, exe, "1.19.5");
    assert.equal(fs.lstatSync(exe).isDirectory(), true, "control: the descriptor target is a directory");
    assert.equal(managedCli(fx.env), null, "a directory is never a managed executable");
    fs.rmdirSync(exe); writeFileSync(exe, "inert");
    assert.equal(managedCli(fx.env), exe, "control: the same path as a real file resolves");
  } finally { await fx.close(); }
});

test("managed resolution survives restart and PATH refresh, precedes PATH v2 and preserves workspace exclusion", async (t) => {
  const fx = await installFixture(t);
  try {
    const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe"); writeFileSync(exe, "inert");
    writeFileSync(join(fx.bin, "opencode.exe"), "PATH v2 inert");
    await publishCandidate(candidate.root, exe, "1.19.5");
    for (const env of [fx.env, { ...fx.env }]) {
      await refreshProcessPath({ env, readRegistryPath: () => [fx.bin], platform: "win32" });
      assert.equal(resolveCliPath("opencode", env), exe);
      for (const command of ["opencode models", "opencode serve --hostname 127.0.0.1 --port 0", "opencode run --model opencode-go/test"])
        assert.equal(withResolvedCli(command, env), `"${exe}"${command.slice("opencode".length)}`);
    }
    setCliSkipFolders(() => [candidate.dir]);
    assert.equal(resolveCliPath("opencode", fx.env), join(fx.bin, "opencode.exe"));
    setCliSkipFolders(() => [candidate.dir, fx.bin]);
    assert.equal(resolveCliPath("opencode", fx.env), null);
    assert.equal(managedCli({ PATH: fx.env.PATH }), null, "missing injected profile never uses host LOCALAPPDATA");
    assert.equal(managedCli({ ...fx.env, LOCALAPPDATA: join(fx.root, "other-profile") }), null);
  } finally { setCliSkipFolders(() => []); await fx.close(); }
});

test("active descriptor cannot escape, select another major, or name an arbitrary executable", async (t) => {
  const fx = await installFixture(t);
  try {
    const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe"); writeFileSync(exe, "inert");
    await publishCandidate(candidate.root, exe, "1.19.5");
    const descriptor = join(candidate.root, "active.json"), before = readFileSync(descriptor);
    for (const value of [
      { executable: "../../bin/opencode.exe", version: "1.19.5" }, { executable: exe, version: "1.19.5" },
      { executable: "install-abc/opencode.exe", version: "2.0.0" }, { executable: "install-abc/other.exe", version: "1.19.5" },
      { executable: "install-abc/opencode.exe", version: "1.19.5", arbitrary: true },
    ]) { writeFileSync(descriptor, JSON.stringify(value)); assert.equal(managedCli(fx.env), null, JSON.stringify(value)); }
    writeFileSync(descriptor, before); assert.equal(managedCli(fx.env), exe);
  } finally { await fx.close(); }
});

test("native candidate uses no shell, hides its window and inherits no provider credentials; all common children disable updates", async (t) => {
  const fx = await installFixture(t);
  try {
    const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe"); writeFileSync(exe, "inert");
    await publishCandidate(candidate.root, exe, "1.19.5");
    const calls: any[] = [];
    const run = createCliRunner(((bin, args, options) => {
      calls.push({ bin, args, options });
      const proc: any = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      queueMicrotask(() => { proc.stdout.end("1.19.5"); proc.emit("exit", 0); proc.emit("close", 0); }); return proc;
    }) as any, fx.env);
    const result = await run(exe, ["--version"], { timeoutMs: 1000, cwd: windowsSystem32(), installer: { signal: new AbortController().signal } });
    assert.equal(result.code, 0); assert.equal(result.cleanupConfirmed, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].bin, exe);
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(calls[0].options.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.equal((await run("opencode", ["--version"], { timeoutMs: 1000, env: { OPENCODE_DISABLE_AUTOUPDATE: "0" } })).code, 0);
    assert.equal(calls.length, 2); assert.equal(calls[1].bin, exe, "the real Settings runner resolves the managed executable");
    assert.equal(calls[1].options.shell, false); assert.equal(calls[1].options.windowsHide, true);
    assert.equal(calls[1].options.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
    assert.equal(leaderChildEnv({ OPENCODE_DISABLE_AUTOUPDATE: "0" }).OPENCODE_DISABLE_AUTOUPDATE, "1");
  } finally { await fx.close(); }
});

test("default runner refuses injected AND host fake flags before the throwing spawn backstop", async (t) => {
  const fx = await installFixture(t), previous = process.env.CC_TEST_FAKE_CLI;
  try {
    for (const source of ["host", "injected"]) {
      process.env.CC_TEST_FAKE_CLI = source === "host" ? "1" : "";
      const run = createCliRunner(undefined, { ...fx.env, CC_TEST_FAKE_CLI: source === "injected" ? "1" : "" });
      const candidate = await createCandidate(fx.env), exe = join(candidate.dir, "opencode.exe"); writeFileSync(exe, "inert");
      for (const installer of [undefined, { signal: new AbortController().signal }]) {
        const result = await run(exe, ["--version"], { timeoutMs: 1000, cwd: windowsSystem32(), installer });
        assert.equal(result.code, -1); assert.equal(fx.spawned.mock.callCount(), 0, source);
      }
    }
  } finally { if (previous === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = previous; await fx.close(); }
});

test("presence and supported major are distinct; unsupported versions never reach credential probes; facts expose source enums only", async (t) => {
  const fx = await installFixture(t);
  try {
    for (const version of ["2.3.0", "unknown", "1.19.5"]) {
      const calls: string[][] = [];
      await detectCatalogTool("opencode", fx.service.state, async (_bin, args, options) => {
        calls.push(args); assert.equal(options.env?.OPENCODE_DISABLE_AUTOUPDATE, "1");
        return ok(args[0] === "auth" ? "0 credentials\nEnvironment\nOPENCODE_API_KEY synthetic-not-a-real-key" : version);
      });
      const facts = fx.service.state.catalogTools.opencode;
      assert.equal(calls.length, version === "1.19.5" ? 2 : 1);
      assert.equal(facts.installed, true, "a successful executable probe proves presence even with unknown version text");
      assert.equal(facts.supportedVersion, version === "unknown" ? null : version === "1.19.5");
      assert.equal(facts.signedIn, version === "1.19.5" ? false : null);
      assert.equal(facts.credentialSource, version === "1.19.5" ? "environment" : "unknown");
      assert.doesNotMatch(JSON.stringify(facts), /synthetic-not-a-real-key|OPENCODE_API_KEY/);
    }
    for (const [text, expected] of [["1 credential", "stored"], ["0 credentials", "none"], ["nonsense", "unknown"]])
      assert.equal(openCodeCredentialSource(ok(text)), expected);
    assert.equal(openCodeCredentialSource(ok("1 credential", { code: 1 })), "unknown");
  } finally { await fx.close(); }
});
