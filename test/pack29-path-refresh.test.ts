import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { scratchDir, setEnv } from "./temp-root.ts";
import { leaderChildEnv, resolveCliPath, setCliSkipFolders, windowsSystem32 } from "../server/leader-common/cli-path.ts";

// Replace only the OS boundary, leaving the reader, merge and registered handlers real.
let registry: (file: string, args: string[], options: any) => Promise<{ stdout: string }>;
(globalThis as any).__p29Registry = (...args: any[]) => registry(...args as [string, string[], any]);
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/server/leader-common/path-refresh.ts")) return result;
  const source = String(result.source), target = "const execute = promisify(execFile);";
  assert.equal(source.split(target).length, 2, "registry seam found exactly once");
  return { ...result, source: source.replace(target, "const execute = (...args: any[]) => (globalThis as any).__p29Registry(...args);") };
} });
const { refreshProcessPath, parseRegistryPath } = await import("../server/leader-common/path-refresh.ts");
hook.deregister();
const options = { platform: "win32" as const, skipFolders: [] };

test("default registry reads are blocked by injected fake, host fake and node-test; injected readers remain usable", async () => {
  for (const mode of ["injected", "host", "node-test"]) {
    const restore = setEnv({ CC_TEST_FAKE_CLI: mode === "host" ? "1" : undefined, NODE_TEST_CONTEXT: mode === "node-test" ? "child-v8" : undefined });
    let calls = 0;
    registry = async () => { calls++; return { stdout: "Path REG_SZ C:\\fake" }; };
    const env = { PATH: "keep", CC_TEST_FAKE_CLI: mode === "injected" ? "1" : "" };
    try {
      assert.deepEqual(await refreshProcessPath({ ...options, env, isDirectory: () => true }), { added: [] });
      assert.equal(calls, 0, mode + " default OS boundary calls"); assert.equal(env.PATH, "keep");
      let injected = 0;
      assert.deepEqual(await refreshProcessPath({ ...options, env, isDirectory: () => true, readRegistryPath: () => { injected++; return ["C:\\fake"]; } }), { added: ["C:\\fake"] });
      assert.equal(injected, 1, mode + " injected positive control");
    } finally { restore(); }
  }
});

test("appends new directories once, preserves old bytes and expands known variables", async () => {
  const env = { pAtH: 'C:\\old;"C:\\KEEP\\";C:\\dot\\.\\bin;', USERPROFILE: "C:\\Users\\Tester" };
  const before = env.pAtH;
  const added = ["C:\\machine", "C:\\Users\\Tester\\bin", "C:\\user"];
  const readRegistryPath = () => ["c:\\OLD\\;C:\\keep;C:\\dot\\bin;C:\\machine;C:\\MACHINE\\",
    "%userprofile%\\bin;%MISSING%\\bin;C:\\user"];
  const result = await refreshProcessPath({ ...options, env, readRegistryPath, isDirectory: () => true });
  assert.deepEqual(result.added, added, "duplicates must never be appended");
  assert.equal(env.pAtH, before + added.join(";"), "existing PATH bytes and order must stay untouched");
  assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath, isDirectory: () => true }), { added: [] });
  assert.deepEqual(Object.keys(env), ["pAtH", "USERPROFILE"]);
});

test("refuses missing paths, files, relative paths and every workspace folder", async () => {
  const root = scratchDir(), bin = join(root, "bin"), workspace = join(root, "work"), nested = join(workspace, "bin");
  mkdirSync(bin); mkdirSync(nested, { recursive: true });
  const file = join(root, "file"); writeFileSync(file, "bytes");
  const env = { Path: "old bytes" };
  const readRegistryPath = () => [["relative", "\\drive-relative", join(root, "missing"), file, workspace, nested, bin].join(";")];
  setCliSkipFolders(() => [workspace]);
  try {
    assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath }), { added: [bin] }, "only existing outside directories accepted");
    assert.equal(env.Path, `old bytes;${bin}`);
  } finally { setCliSkipFolders(() => []); }
  const skipped = { Path: "old bytes" };
  assert.deepEqual(await refreshProcessPath({ ...options, env: skipped, readRegistryPath: () => [nested], skipFolders: [workspace] }), { added: [] });
  assert.equal(skipped.Path, "old bytes");
});

test("cap rejects the entire batch while exactly 8000 characters is allowed", async () => {
  for (const length of [7999, 8000]) {
    const env = { Path: "x".repeat(length), KEEP: "untouched" }, before = { ...env };
    assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath: () => ["C:\\new"], isDirectory: () => true }), { added: [] }, "PATH cap must refuse growth");
    assert.deepEqual(env, before, "cap must preserve all bytes");
  }
  const env = { Path: "x".repeat(7993) };
  assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath: () => ["C:\\new"], isDirectory: () => true }), { added: ["C:\\new"] });
  assert.equal(env.Path.length, 8000);
});

test("reader failures, garbage, unknown expansions and filesystem errors preserve the environment", async () => {
  for (const readRegistryPath of [() => { throw new Error("reader failed"); }, async () => { throw new Error("reader rejected"); },
    () => [], () => [""], () => ["garbage output"], () => ["%UNKNOWN%\\bin"], () => [null] as any, () => null as any]) {
    const env = { PATH: "keep;;exact bytes", KEEP: "same" }, before = { ...env };
    assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath }), { added: [] });
    assert.deepEqual(env, before);
  }
  const env = {};
  assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath: () => ["C:\\new"], isDirectory: () => { throw new Error("stat failed"); } }), { added: [] });
  assert.deepEqual(env, {});
  await refreshProcessPath({ ...options, env, readRegistryPath: () => ["C:\\new"], isDirectory: () => true });
  assert.deepEqual(env, { Path: "C:\\new" });
});

test("non-Windows is a no-op before even consulting the reader", async () => {
  const env = { Path: "bytes" };
  assert.deepEqual(await refreshProcessPath({ env, platform: "linux", readRegistryPath: () => assert.fail("must not read registry") }), { added: [] });
  assert.deepEqual(env, { Path: "bytes" });
});

test("registry parser accepts the two string types and refuses malformed output", () => {
  for (const kind of ["REG_SZ", "REG_EXPAND_SZ"]) {
    assert.equal(parseRegistryPath(`HKEY_CURRENT_USER\\Environment\r\n    Path    ${kind}    C:\\bin;%USERPROFILE%\\bin\r\n`), "C:\\bin;%USERPROFILE%\\bin");
  }
  for (const bad of ["", "garbage", "Path REG_DWORD 42", "Path REG_SZ C:\\a\nPath REG_SZ C:\\b"]) assert.throws(() => parseRegistryPath(bad));
});

test("real registry reader uses absolute reg.exe with fixed arguments and fails atomically", async (t) => {
  const restore = setEnv({ NODE_TEST_CONTEXT: undefined, CC_TEST_FAKE_CLI: undefined }); t.after(restore);
  const bin = scratchDir(), env = { Path: "old", USERPROFILE: bin }, calls: any[] = [];
  registry = async (file, args, settings) => {
    calls.push({ file, args, settings });
    return { stdout: `    Path    REG_EXPAND_SZ    %USERPROFILE%\r\n` };
  };
  assert.deepEqual(await refreshProcessPath({ ...options, env }), { added: [bin] });
  assert.deepEqual(calls.map((call) => call.args), [
    ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "Path"],
    ["query", "HKCU\\Environment", "/v", "Path"],
  ]);
  for (const call of calls) {
    assert.equal(call.file, join(windowsSystem32(), "reg.exe"));
    assert.equal(call.settings.env, env); assert.equal(call.settings.shell, false);
    assert.equal(call.settings.windowsHide, true); assert.equal(call.settings.timeout, 5000);
  }
  for (const bad of ["", "garbage", "Path REG_DWORD 42"]) {
    const preserved = { Path: "old" };
    registry = async (_file, args) => ({ stdout: args[1].startsWith("HKLM") ? `Path REG_SZ ${bin}` : bad });
    assert.deepEqual(await refreshProcessPath({ ...options, env: preserved }), { added: [] });
    assert.deepEqual(preserved, { Path: "old" });
  }
});

test("newly installed fake CLI resolves after refresh and a child inherits PATH", async () => {
  const root = scratchDir(), bin = join(root, "bin"); mkdirSync(bin);
  const fake = join(bin, "fakecli.cmd"); writeFileSync(fake, "@echo off\r\n");
  const env = { Path: "" };
  assert.equal(resolveCliPath("fakecli", env), null);
  assert.deepEqual(await refreshProcessPath({ ...options, env, readRegistryPath: () => [bin] }), { added: [bin] });
  assert.equal(resolveCliPath("fakecli", env), fake);
  const restore = setEnv({ PATH: env.Path });
  try {
    const inherited = leaderChildEnv();
    assert.equal(inherited.PATH, bin, "leader child copies the current environment");
    const child = spawnSync(process.execPath, ["-e", 'process.stdout.write(process.env.PATH || "")'], { env: inherited, encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, bin);
  } finally { restore(); }
});

// Managed login refresh is now inside its synchronous service lock (pack29-cli-login tests).
// Install refresh now runs within the synchronous service lock, covered by pack29-cli-install.test.ts.
test("registered settings handlers refresh once before detection; reader failure leaves replies unchanged", { skip: process.platform !== "win32" }, async (t) => {
  const restoreContext = setEnv({ NODE_TEST_CONTEXT: undefined, CC_TEST_FAKE_CLI: undefined }); t.after(restoreContext);
  const { api, setup } = await import("./pack29-first-run.setup.ts");
  const { settingsMessages } = await import("../server/main/messages/settings.ts");
  const handlers = new Map(settingsMessages());
  setup();
  const bin = scratchDir(), restore = setEnv({ PATH: "" });
  const events: string[] = [], replies: any[] = [];
  const socket = { readyState: 1, send: (raw: string) => replies.push(JSON.parse(raw)) } as any;
  try {
    for (const [type, method] of [["refreshSettings", "refreshAll"]] as const) {
      const mock = t.mock.method(api.state.settingsService, method, async () => {
        events.push("detect"); assert.equal(process.env.PATH, bin, "registry merge must precede detection");
      });
      events.length = 0; process.env.PATH = "";
      registry = async (_file, args) => { events.push(args[1].startsWith("HKLM") ? "machine" : "user"); return { stdout: `Path REG_SZ ${bin}` }; };
      handlers.get(type)!(socket, { type, cli: "codex", requestId: type });
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(events, ["machine", "user", "detect"], `${type}: exactly one refresh before detection`);
      assert.ok(replies.some((reply) => reply.type === "actionResult" && reply.requestId === type));
      mock.mock.restore();
    }
    for (const failure of [false, true]) {
      process.env.PATH = ""; replies.length = 0;
      registry = async () => { if (failure) throw new Error("registry unavailable"); return { stdout: "Path REG_SZ relative" }; };
      const mock = t.mock.method(api.state.settingsService, "refreshAll", async () => {});
      handlers.get("refreshSettings")!(socket, { type: "refreshSettings", requestId: "same" });
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(replies, [{ type: "settingsRefreshed" }, { type: "actionResult", action: "refreshSettings", requestId: "same" }]);
      assert.equal(process.env.PATH, ""); mock.mock.restore();
    }
  } finally { restore(); delete (globalThis as any).__p29Registry; }
});
