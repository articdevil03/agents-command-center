import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCliSkipFolders } from "../server/leader-common.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { createCliRunner, windowsPowerShellPath, windowsTaskkillPath } from "../server/settings.ts";
import { NO_PATH, fakeCliEnv } from "./settings-helpers.ts";

test("CLI resolution skips a PATH entry inside ANY workspace folder, not only the server's own cwd", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cc-skipfolder-")));
  const project = join(base, "project"), real = join(base, "real");
  try {
    mkdirSync(project); mkdirSync(real);
    writeFileSync(join(project, "codex.cmd"), "@echo off\r\n"); writeFileSync(join(real, "codex.exe"), "");
    setCliSkipFolders(() => [project]);
    let spawned = "";
    const fakeSpawn = ((bin: string) => {
      spawned = bin;
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => { child.stdout.end("ok\n"); child.stderr.end(""); child.emit("close", 0); });
      return child;
    }) as any;
    const env ={ PATH: `${project};${real}` } as NodeJS.ProcessEnv;
    await createCliRunner(fakeSpawn, env)("codex", ["--version"], { timeoutMs: 500 });
    assert.equal(spawned, join(real, "codex.exe"), "the project folder's codex.cmd is not picked");
    spawned = "";
    const onlyProject = await createCliRunner(fakeSpawn, { PATH: project } as NodeJS.ProcessEnv)("codex", ["--version"], { timeoutMs: 500 });
    assert.equal(spawned, "", "nothing is spawned when the only match is inside a project folder");
    assert.equal(onlyProject.code, 127);
  } finally { setCliSkipFolders(() => []); removeWithRetry(base); }
});

test("runCli forwards the exact argv array and always spawns with shell false", async () => {
  let captured: { bin: string; args: string[]; options: any } | undefined;
  const fakeSpawn = ((bin: string, args: string[], options: any) => {
    captured = { bin, args, options };
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stdout.end("ok\n"); child.stderr.end(""); child.emit("close", 0); });
    return child;
  }) as any;
  const fake = fakeCliEnv("codex");
  const result = await createCliRunner(fakeSpawn, fake.env)("codex", ["mcp", "add", "safe-name", "--", "npx", "-y", "server"], { timeoutMs: 500 });
  assert.deepEqual(captured?.args, ["mcp", "add", "safe-name", "--", "npx", "-y", "server"]);
  assert.equal(captured?.bin, fake.path, "the resolved absolute path is spawned");
  assert.equal(captured?.options.shell, false);
  assert.equal(captured?.options.windowsHide, true, "a CLI call must not flash a console window");
  assert.deepEqual(result, { code: 0, stdout: "ok\n", stderr: "" });
});

test("runCli never passes the app key to the CLI, keeps it out of the current folder, and resolves a known CLI from PATH to an absolute path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-resolve-test-"));
  try {
    writeFileSync(join(dir, "codex.cmd"), "@echo off");
    const spawned: Array<[string, string[], any]> = [];
    const fakeSpawn = ((file: string, argv: string[], options: any) => {
      spawned.push([file, argv, options]);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => { child.stdout.end(""); child.stderr.end(""); child.emit("close", 0); });
      return child;
    }) as any;
    await createCliRunner(fakeSpawn, { PATH: dir, ComSpec: "cmd.exe", CC_APP_KEY: "secret-app-key" } as NodeJS.ProcessEnv)("codex", ["--version"], { timeoutMs: 500 });
    const [file, argv, options] = spawned[0];
    assert.equal("CC_APP_KEY" in options.env, false, "the app key is stripped from the child env");
    assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, "1");
    if (process.platform === "win32") assert.ok(`${file} ${argv.join(" ")}`.toLowerCase().includes(join(dir, "codex.cmd").toLowerCase()), `absolute path used: ${file} ${argv.join(" ")}`);
  } finally { removeWithRetry(dir); }
});

test("runCli does not pick a CLI out of the current folder even when PATH lists it", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cwd-test-"));
  const original = process.cwd();
  try {
    writeFileSync(join(dir, "planted.cmd"), "@echo off");
    const spawned: string[] = [];
    const fakeSpawn = ((file: string) => { spawned.push(file); throw new Error("stop"); }) as any;
    process.chdir(dir);
    await createCliRunner(fakeSpawn, { PATH: dir, ComSpec: "cmd.exe" } as NodeJS.ProcessEnv)("planted", [], { timeoutMs: 500 });
    assert.deepEqual(spawned, ["planted"], "the bare name is kept; the planted file in the current folder is not chosen");
  } finally { process.chdir(original); removeWithRetry(dir); }
});

// The real runner against a real .cmd shim (npm, codex and opencode are .cmd launchers on Windows).
test("runCli starts a .cmd launcher from PATH and every argument round-trips, & runs nothing", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-shim-test-"));
  try {
    const marker = join(dir, "injected.txt");
    writeFileSync(join(dir, "echo-args.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(join(dir, "shimcli.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0echo-args.mjs" %*\r\n`);
    const spawned: Array<[string, string[], any]> = [];
    const spyingSpawn = ((file: string, argv: string[], options: any) => { spawned.push([file, argv, options]); return spawn(file, argv, options); }) as typeof spawn;
    const runner = createCliRunner(spyingSpawn, { PATH: dir, ComSpec: process.env.ComSpec } as NodeJS.ProcessEnv);
    const args = ["mcp", "add", "with space", "a&echo x>" + marker, "p|q", "https://example.com/a?b=1&c=2", "-y", "C:\\dir with space\\",
      "https://example.com/a%20b?token=%2B%21&q=^up", "100%", "%PATH%", "50%\\", "^caret ^^ & (paren)"];
    const result = await runner("shimcli", args, { timeoutMs: 20_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(existsSync(marker), false, "an & in an argument must not run a second command");
    assert.equal(spawned[0][0], process.env.ComSpec);
    assert.deepEqual(spawned[0][1].slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(spawned[0][2].shell, false);
    assert.equal(spawned[0][2].windowsHide, true, "the cmd.exe path must not flash a console window");
    assert.doesNotMatch(String(spawned[0][1][3]), /\bcall\b/, "no `call`: it parses the line a second time and doubles every ^");
    assert.equal(String(spawned[0][1][3]).includes("%2B"), false, "an argument with % never sits on the command line; cmd expands it once from the environment");
    for (const bad of ['say "hi"', "hey!"]) {
      assert.deepEqual(await runner("shimcli", ["x", bad], { timeoutMs: 5_000 }), { code: -1, stdout: "", stderr: "unsupported characters in command arguments" });
    }
    assert.equal((await runner("no-such-launcher", ["--version"], { timeoutMs: 5_000 })).code, 127);
  } finally { removeWithRetry(dir); }
});

test("runCli settles at its timeout and requests a process kill", async () => {
  let killed = false;
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed = true; return true; };
    return child;
  }) as any;
  const result = await createCliRunner(fakeSpawn, fakeCliEnv("claude").env)("claude", ["--help"], { timeoutMs: 10 });
  assert.deepEqual(result, { code: 124, stdout: "", stderr: "command timed out" });
  assert.equal(killed, true);
});

test("runCli does not taskkill by pid when the timed out CLI has already exited (its pid may be somebody else's)", async () => {
  const spawned: string[] = [];
  let destroyed = 0;
  const fakeSpawn = ((file: string) => {
    spawned.push(file);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number; exitCode: number | null; signalCode: null };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdout.on("close", () => { destroyed++; });
    child.pid = 4242; child.exitCode = 0; child.signalCode = null; // exited, but a descendant keeps the pipes open so `close` never came
    return child;
  }) as any;
  const result = await createCliRunner(fakeSpawn, fakeCliEnv("claude").env)("claude", ["--help"], { timeoutMs: 10 });
  assert.deepEqual(result, { code: 124, stdout: "", stderr: "command timed out" });
  assert.equal(spawned.length, 1, `only the CLI itself was spawned, no taskkill: ${JSON.stringify(spawned)}`);
  assert.equal(destroyed, 1, "its pipes are closed");
});

test("runCli kills the whole timed out .cmd process tree before reporting timeout", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-timeout-tree-"));
  const marker = join(dir, "child-finished.txt");
  const childInfo = join(dir, "child-info.txt");
  const shim = join(dir, "slowcli.cmd");
  try {
    writeFileSync(join(dir, "marker-child.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[3], `${process.pid},${process.ppid}`); setTimeout(() => writeFileSync(process.argv[2], "late"), 6000);\n');
    writeFileSync(shim, `@echo off\r\nstart "" /b "${process.execPath}" "%~dp0marker-child.mjs" "${marker}" "${childInfo}"\r\n"%SystemRoot%\\System32\\ping.exe" -n 8 127.0.0.1 >nul\r\n`);
    const spawned: Array<{ file: string; args: string[]; options: any; pid?: number; exitCode?: number | null; output?: string }> = [];
    const spyingSpawn = ((file: string, args: string[], options: any) => {
      const actualOptions = file.toLowerCase().endsWith("taskkill.exe") ?{ ...options, stdio: ["ignore", "pipe", "pipe"] } : options;
      const child = spawn(file, args, actualOptions);
      const record: { file: string; args: string[]; options: any; pid?: number; exitCode?: number | null; output?: string } = { file, args, options, pid: child.pid, output: "" };
      child.stdout?.on("data", (chunk) => { record.output += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { record.output += chunk.toString(); });
      child.once("close", (code) => { record.exitCode = code; });
      spawned.push(record);
      return child;
    }) as typeof spawn;
    const runner = createCliRunner(spyingSpawn, { PATH: dir, ComSpec: process.env.ComSpec } as NodeJS.ProcessEnv);
    const result = await runner("slowcli", [], { timeoutMs: 1000 });
    assert.equal(result.code, 124);
    assert.equal(existsSync(childInfo), true, "the shim child must have started before timeout");
    const [childPid, childParentPid] = readFileSync(childInfo, "utf8").split(",").map(Number);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(childParentPid, spawned[0].pid, "child must be created by the timed-out launcher");
    await new Promise((resolve) => setTimeout(resolve, 6200));
    assert.equal(existsSync(marker), false, `child=${childPid}, parent=${childParentPid}; a child of the .cmd launcher must not write after timeout is reported; ${result.stderr}; spawned=${JSON.stringify(spawned.map(({ file, args, pid, exitCode, output }) => ({ file, args, pid, exitCode, output })))}`);
    const killer = spawned.find((entry) => entry.file.toLowerCase().endsWith("taskkill.exe"));
    assert.ok(killer, "timeout must launch taskkill");
    assert.equal(killer.file, windowsTaskkillPath(), "taskkill must be launched by absolute System32 path, not PATH lookup");
    assert.equal(killer.file, join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"));
    assert.deepEqual(killer.args, ["/pid", String(spawned[0].pid), "/T", "/F"]);
    assert.equal(killer.options.windowsHide, true);
    assert.match(result.stderr, /command timed out; process tree (?:terminated|exit not confirmed after bounded wait)/);
  } finally { removeWithRetry(dir); }
});
test("runCli distinguishes a missing executable from other launch failures", async () => {
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
    return child;
  }) as any;
  assert.deepEqual(await createCliRunner(fakeSpawn, fakeCliEnv("claude").env)("claude", ["--version"], { timeoutMs: 500 }), {
    code: 127, stdout: "", stderr: "could not start command",
  });
});

test("runCli refuses a known CLI it cannot resolve to an absolute path, and spawns nothing", async () => {
  let spawned = 0;
  const fakeSpawn = (() => { spawned += 1; throw new Error("must not spawn"); }) as any;
  assert.deepEqual(await createCliRunner(fakeSpawn, NO_PATH)("codex", ["--version"], { timeoutMs: 500 }), { code: 127, stdout: "", stderr: "codex was not found on PATH" });
  assert.equal(spawned, 0);
});

test("a timed out .cmd tree kill falls back through absolute System32 taskkill and PowerShell paths", { skip: process.platform !== "win32" }, async () => {
  const files: string[] = [];
  const fakeSpawn = ((file: string, args: string[]) => {
    files.push(file);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.pid = 4242;
    if (file === windowsTaskkillPath()) queueMicrotask(() => child.emit("close", 1));
    else if (file === windowsPowerShellPath()) { child.stdout.end(""); /* empty list: never signal a real process */ queueMicrotask(() => child.emit("close", 0)); }
    return child;
  }) as any;
  const dir = mkdtempSync(join(tmpdir(), "cc-abs-path-"));
  try {
    writeFileSync(join(dir, "hang.cmd"), "@echo off\r\n");
    await createCliRunner(fakeSpawn, { PATH: dir, ComSpec: process.env.ComSpec } as NodeJS.ProcessEnv)("hang", [], { timeoutMs: 20 });
    assert.ok(files.includes(windowsTaskkillPath()), `taskkill by absolute path, spawned=${JSON.stringify(files)}`);
    assert.ok(files.includes(windowsPowerShellPath()), `powershell by absolute path, spawned=${JSON.stringify(files)}`);
    assert.equal(files.some((file) => file === "taskkill" || file === "powershell.exe"), false);
    assert.equal(windowsTaskkillPath().toLowerCase().endsWith("\\system32\\taskkill.exe"), true);
    assert.equal(windowsPowerShellPath().toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe"), true);
  } finally { removeWithRetry(dir); }
});

// ---- the .cmd path ----

test("a real .cmd launcher keeps ^ in a URL as typed and accepts an encoded URL (% and ^ in one argument)", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-shim-url-"));
  try {
    writeFileSync(join(dir, "echo-args.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(join(dir, "shimcli.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0echo-args.mjs" %*\r\n`);
    const runner = createCliRunner(spawn, { PATH: dir, ComSpec: process.env.ComSpec } as NodeJS.ProcessEnv);
    const url = "https://mcp.example/a%20b/c?token=%7Esecret&x=a^b&y=100%";
    const result = await runner("shimcli", ["mcp", "add", "--url", url], { timeoutMs: 20_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["mcp", "add", "--url", url]);
  } finally { removeWithRetry(dir); }
});

// ---- child tracking and the descendants fallback ----

test("a settings CLI call is tracked for the server's shutdown while it runs and forgotten when it ends", async () => {
  const common = await import("../server/leader-common.ts");
  const before = common.trackedLeaderChildren();
  let during = -1;
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.pid = 4141;
    queueMicrotask(() => { during = common.trackedLeaderChildren(); child.stdout.end("ok"); child.stderr.end(""); child.emit("exit", 0); child.emit("close", 0); });
    return child;
  }) as any;
  await createCliRunner(fakeSpawn, fakeCliEnv("claude").env)("claude", ["--version"], { timeoutMs: 500 });
  assert.equal(during, before + 1);
  assert.equal(common.trackedLeaderChildren(), before);
});

test("the timeout fallback reads the process list through the shared lister and signals exactly the descendants it names", { skip: process.platform !== "win32" }, async () => {
  const signalled: number[] = [];
  const realKill = process.kill;
  process.kill = ((pid: number) => { signalled.push(pid); return true; }) as typeof process.kill;
  const now = Date.now();
  const fakeSpawn = ((file: string) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid: number };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.pid = 4242;
    if (file === windowsTaskkillPath()) queueMicrotask(() => child.emit("close", 1));
    else if (file === windowsPowerShellPath()) {
      child.stdout.end(`4242,1,${now}\r\n7001,4242,${now + 10}\r\n7002,7001,${now + 20}\r\n7003,1,${now + 30}\r\n`);
      child.stdout.once("end", () => child.emit("close", 0)); // as a real process: close comes after its output was read
    }
    return child;
  }) as any;
  const dir = mkdtempSync(join(tmpdir(), "cc-desc-"));
  try {
    writeFileSync(join(dir, "hang.cmd"), "@echo off\r\n");
    await createCliRunner(fakeSpawn, { PATH: dir, ComSpec: process.env.ComSpec } as NodeJS.ProcessEnv)("hang", [], { timeoutMs: 20 });
    assert.deepEqual(signalled.sort(), [7001, 7002], "the child and its child, not the unrelated 7003");
  } finally { process.kill = realKill; removeWithRetry(dir); }
});

test("dead exports are gone: the unused login-args and permission-mode helpers", async () => {
  const module = await import("../server/settings.ts") as Record<string, unknown>;
  assert.equal("cliLoginArgs" in module, false);
  assert.equal("isPermissionMode" in module, false);
  assert.equal(typeof module.permissionModeForSdk, "function");
});


test("a tree killer answering after three seconds confirms termination", { skip: process.platform !== "win32" }, async () => {
  let cli: any;
  let fallback = false;
  const fakeSpawn = ((file: string) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true; child.pid = 4242;
    if (file === windowsTaskkillPath()) {
      setTimeout(() => { cli.emit("close", 0); child.emit("close", 0); }, 3000);
    } else if (file === windowsPowerShellPath()) {
      fallback = true;
      child.stdout.end(""); queueMicrotask(() => child.emit("close", 0));
    } else cli = child;
    return child;
  }) as any;
  const result = await createCliRunner(fakeSpawn, fakeCliEnv("claude").env)("claude", [], { timeoutMs: 10 });
  assert.equal(result.stderr, "command timed out; process tree terminated");
  assert.equal(fallback, false, "a still-working tree killer must not trigger fallback");
});
