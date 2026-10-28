import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import realFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { setCliSkipFolders } from "../server/leader-common.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import {
  createCliRunner, parseGitHubAuthStatus, parseMcpCommand, parseMcpList, parsePluginList,
  permissionModeForSdk, pruneAvatars, SettingsService, windowsPowerShellPath, windowsTaskkillPath, type CliId, type PermissionMode, type RunCli,
} from "../server/settings.ts";

// An empty PATH keeps the fake-spawn runner tests independent of what is installed here.
const NO_PATH = { PATH: "" } as NodeJS.ProcessEnv;
// A CLI that cannot be found on PATH is refused before any spawn, so fake-spawn tests of a known CLI put an (empty) fake of it on an absolute PATH.
const fakeCliDirs: string[] = [];
function fakeCliEnv(name: string): { env: NodeJS.ProcessEnv; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-fakecli-")); fakeCliDirs.push(dir);
  const path = join(dir, `${name}.exe`); writeFileSync(path, "");
  return { env: { PATH: dir } as NodeJS.ProcessEnv, path };
}
after(() => { for (const dir of fakeCliDirs) removeWithRetry(dir); });
type Call = { bin: string; args: string[]; timeoutMs: number; env?: Record<string, string>; verbatimArgs?: boolean };
const LOGIN_START = ["/c", "start", '""', '"%CC_LOGIN_PROGRAM%"'];
const PKGS: Record<CliId, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai", gemini: "@google/gemini-cli" };

function harness(initiallyInstalled: CliId[] = ["claude", "codex", "opencode"]) {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-test-"));
  const home = join(root, "home"), dataRoot = join(root, "data"), project = join(root, "project"), vault = join(root, "vault");
  mkdirSync(home, { recursive: true }); mkdirSync(dataRoot, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(vault, { recursive: true });
  // The login window is started by the CLI's resolved path, so the CLIs must be found on an (absolute) PATH.
  const binDir = join(root, "bin"); mkdirSync(binDir, { recursive: true });
  for (const name of ["claude", "codex", "opencode"]) writeFileSync(join(binDir, `${name}.exe`), "");
  const env = { HOME: home, USERPROFILE: home, PATH: binDir, APPDATA: join(root, "appdata") } as NodeJS.ProcessEnv;
  const installed = new Set<CliId>(initiallyInstalled);
  const signedIn: Record<CliId, boolean | null> = { claude: true, codex: false, opencode: false, gemini: null };
  const calls: Call[] = [];
  const runner: RunCli = async (bin, args, options) => {
    calls.push({ bin, args: [...args], timeoutMs: options.timeoutMs, env: options.env, verbatimArgs: options.verbatimArgs });
    if (bin === "npm" && args[0] === "install") {
      const cli = (Object.keys(PKGS) as CliId[]).find((id) => args[2] === PKGS[id]);
      if (cli) installed.add(cli);
      return { code: 0, stdout: "added", stderr: "" };
    }
    if (bin === "cmd" && args[0] === "/c" && args[1] === "start") {
      if (args[3] === "gh") githubConnected = true;
      const started = basename(String(options.env?.CC_LOGIN_PROGRAM ?? args[3]), ".exe") as CliId;
      if (started === "claude" || started === "codex" || started === "opencode") signedIn[started] = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "gh" && args.join(" ") === "auth status") {
      return githubConnected
        ? { code: 0, stdout: "Logged in to github.com account octocat (keyring)\nToken: ghp_SHOULD_NEVER_LEAK", stderr: "" }
        : { code: 1, stdout: "You are not logged into any GitHub hosts.", stderr: "" };
    }
    if (bin === "gh") return { code: 0, stdout: "", stderr: "" };
    if (bin === "claude" || bin === "codex" || bin === "opencode" || bin === "gemini") {
      if (args.length === 1 && args[0] === "--version") return installed.has(bin) ? { code: 0, stdout: `${bin} 1.2.3\n`, stderr: "" } : { code: 127, stdout: "", stderr: "missing" };
      if (args[0] === "auth" || args[0] === "login") {
        const yes = signedIn[bin];
        return yes ? { code: 0, stdout: "Logged in successfully", stderr: "" } : { code: 1, stdout: "Not logged in", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "list") return { code: 0, stdout: "demo-server: stdio connected\n", stderr: "" };
      if (args[0] === "plugin" && args[1] === "list") return { code: 0, stdout: "Installed plugins:\n  - helper@official enabled\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  let githubConnected = true;
  return {
    root, home, dataRoot, project, vault, env, installed, signedIn, calls, runner,
    service: (onChange?: () => void, permissionTimeoutMs?: number) => new SettingsService({ dataRoot, env, runCli: runner, onChange, permissionTimeoutMs, loginRecheckMs: 10 }),
    close: () => removeWithRetry(root),
    setGithub: (connected: boolean) => { githubConnected = connected; },
  };
}

function persistedPermissionMode(path: string, tabId: string): string {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { permissionModes?: Record<string, string> };
    return value.permissionModes?.[tabId] ?? "accept";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "accept";
    throw error;
  }
}

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

test("Settings inventory uses injected CLI results and only the temporary HOME and USERPROFILE", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.home, ".claude", "skills", "imagegen"), { recursive: true });
    mkdirSync(join(h.home, ".codex", "skills", "openai-docs"), { recursive: true });
    mkdirSync(join(h.home, ".config", "opencode", "skills", "web-search"), { recursive: true });
    mkdirSync(join(h.home, ".gemini"), { recursive: true });
    writeFileSync(join(h.home, ".claude", "CLAUDE.md"), "test");
    writeFileSync(join(h.home, ".codex", "AGENTS.md"), "test");
    writeFileSync(join(h.project, "CLAUDE.md"), "project claude");
    writeFileSync(join(h.project, "AGENTS.md"), "project codex");
    writeFileSync(join(h.home, ".gemini", "GEMINI.md"), "global gemini");
    writeFileSync(join(h.project, "GEMINI.md"), "project gemini");
    const service = h.service();
    await service.refreshAll(h.project);
    const state = service.snapshot();
    assert.deepEqual(state.tools.claude, { installed: true, version: "1.2.3", signedIn: true });
    assert.deepEqual(state.tools.codex, { installed: true, version: "1.2.3", signedIn: false });
    assert.equal(state.tools.opencode.signedIn, false);
    assert.deepEqual(state.tools.gemini, { installed: false, version: null, signedIn: null });
    assert.deepEqual(state.skills.claude.skills, ["imagegen"]);
    assert.deepEqual(state.skills.codex.skills, ["openai-docs"]);
    assert.deepEqual(state.skills.opencode.skills, ["web-search"]);
    assert.deepEqual(state.skills.claude.instructionFiles.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(state.skills.codex.instructionFiles.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(state.skills.opencode.instructionFiles.map((item) => item.path), [join(h.project, "AGENTS.md")]);
    assert.deepEqual(state.skills.gemini.instructionFiles, [
      { path: join(h.home, ".gemini", "GEMINI.md"), scope: "global" },
      { path: join(h.project, "GEMINI.md"), scope: "project" },
    ]);
    assert.deepEqual(state.skills.gemini.skills, []);
    assert.deepEqual(state.skills.gemini.mcpServers, []);
    assert.deepEqual(state.skills.codex.mcpServers, [{ name: "demo-server" }]);
    assert.deepEqual(state.skills.claude.plugins, ["helper@official"]);
    assert.deepEqual(state.github, { connected: true, account: "octocat" });
    assert.doesNotMatch(JSON.stringify(state), /ghp_SHOULD_NEVER_LEAK|Token:/);
    assert.ok(h.calls.every((call) => Number.isFinite(call.timeoutMs) && call.timeoutMs > 0));
    assert.ok(h.calls.some((call) => call.bin === "claude" && call.args[0] === "--version"));
    assert.ok(h.calls.some((call) => call.bin === "gh" && call.args.join(" ") === "auth status"));
    assert.ok(state.skills.claude.instructionFiles.some((item) => item.path === join(h.home, ".claude", "CLAUDE.md")), "global instructions come from the injected temporary home");
  } finally { h.close(); }
});

test("installCli requires confirmation, uses each fixed package, and refuses an installed CLI", async () => {
  const h = harness([]);
  try {
    const service = h.service();
    for (const cli of ["claude", "codex", "opencode", "gemini"] as const) {
      await service.installCli(cli, `install_${cli}`, true);
      assert.ok(h.calls.some((call) => call.bin === "npm" && JSON.stringify(call.args) === JSON.stringify(["install", "-g", PKGS[cli]])), `${cli} used its fixed package`);
      assert.equal(service.state.tools[cli].action?.requestId, `install_${cli}`);
      assert.equal(service.state.tools[cli].action?.status, "done");
    }
    const before = h.calls.filter((call) => call.bin === "npm").length;
    await assert.rejects(service.installCli("claude", "install_no", false), /already installed/);
    assert.equal(h.calls.filter((call) => call.bin === "npm").length, before, "present CLI never reaches npm");
    assert.equal(service.state.tools.claude.action?.status, "failed");
    const missing = harness([]);
    try {
      await assert.rejects(missing.service().installCli("claude", "install_unconfirmed", false), /confirmation is required/);
      assert.equal(missing.calls.some((call) => call.bin === "npm"), false);
    } finally { missing.close(); }

    const uncertain = harness();
    try {
      const calls: string[][] = [];
      const service = new SettingsService({
        dataRoot: uncertain.dataRoot,
        env: uncertain.env,
        runCli: async (bin, args) => { calls.push([bin, ...args]); return { code: -1, stdout: "", stderr: "could not start command" }; },
      });
      await assert.rejects(service.installCli("claude", "install_unknown", true), /installation status is unknown/);
      await assert.rejects(service.loginCli("claude", "login_unknown", uncertain.project), /installation status is unknown/);
      assert.equal(service.state.tools.claude.action?.status, "failed");
      assert.equal(calls.some((call) => call[0] === "npm"), false, "unknown is never treated as missing");
    } finally { uncertain.close(); }
  } finally { h.close(); }
});

test("a late CLI action cannot replace the latest server-owned action state", async () => {
  const h = harness([]);
  try {
    let releaseInstall!: (result: { code: number; stdout: string; stderr: string }) => void;
    let versionCalls = 0;
    const runner: RunCli = async (bin, args) => {
      if (bin === "claude" && args[0] === "--version") {
        versionCalls++;
        return versionCalls === 1 ? { code: 127, stdout: "", stderr: "missing" } : { code: 0, stdout: "claude 1.2.3", stderr: "" };
      }
      if (bin === "npm") return new Promise((resolve) => { releaseInstall = resolve; });
      return { code: 1, stdout: "", stderr: "unavailable" };
    };
    const service = new SettingsService({ dataRoot: h.dataRoot, env: h.env, runCli: runner });
    const first = service.installCli("claude", "install_first", true);
    while (!releaseInstall) await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(service.installCli("claude", "install_latest", true), /already installed/);
    assert.deepEqual(service.state.tools.claude.action, { requestId: "install_latest", status: "failed", message: "CLI is already installed" });
    releaseInstall({ code: 0, stdout: "added", stderr: "" });
    await first;
    assert.deepEqual(service.state.tools.claude.action, { requestId: "install_latest", status: "failed", message: "CLI is already installed" });
  } finally { h.close(); }
});

test("cliLogin opens every CLI's login in a new console, then rereads its own status command until it says signed in", async () => {
  const h = harness();
  try {
    const service = h.service();
    const expected = {
      claude: { login: ["auth", "login"], status: ["auth", "status"] },
      codex: { login: ["login"], status: ["login", "status"] },
      opencode: { login: ["auth", "login"], status: ["auth", "list"] },
    } as const;
    for (const cli of ["claude", "codex", "opencode"] as const) {
      const requestId = `login_${cli}`;
      const statusReadsBefore = h.calls.filter((call) => call.bin === cli && JSON.stringify(call.args) === JSON.stringify(expected[cli].status)).length;
      await service.loginCli(cli, requestId, h.project);
      const opened = h.calls.findLast((call) => call.bin === "cmd");
      assert.deepEqual(opened?.args, [...LOGIN_START, ...expected[cli].login], "the window starts the program named by the variable, quoted for cmd");
      assert.equal(opened?.env?.CC_LOGIN_PROGRAM, join(h.env.PATH!, `${cli}.exe`), "the variable holds the resolved program, not a bare name");
      assert.equal(opened?.verbatimArgs, true, "cmd gets the quotes as written");
      assert.equal(h.calls.filter((call) => call.bin === cli && JSON.stringify(call.args) === JSON.stringify(expected[cli].status)).length, statusReadsBefore + 1,
        "the status is read once before the window opens (installed check), not again at the instant the window opens");
      assert.equal(service.state.tools[cli].action?.requestId, requestId);
      assert.equal(service.state.tools[cli].action?.status, "done");
      const end = Date.now() + 3000;
      while (service.state.tools[cli].signedIn !== true && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(service.state.tools[cli].signedIn, true, `${cli}: the later re-read picks up the sign-in`);
      assert.deepEqual(h.calls.findLast((call) => call.bin === cli && JSON.stringify(call.args) === JSON.stringify(expected[cli].status))?.args, expected[cli].status);
    }
  } finally { h.close(); }
});

test("login re-read: it keeps asking every interval, tells the page each time, and stops once signed in", async () => {
  const h = harness();
  try {
    let reads = 0, changes = 0;
    const runner: RunCli = async (bin, args) => {
      if (bin === "codex" && args[0] === "--version") return { code: 0, stdout: "codex 1.2.3", stderr: "" };
      if (bin === "codex" && args[0] === "login" && args[1] === "status") { reads++; return reads >= 4 ? { code: 0, stdout: "Logged in using ChatGPT", stderr: "" } : { code: 1, stdout: "Not logged in", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    };
    const service = new SettingsService({ dataRoot: h.dataRoot, env: h.env, runCli: runner, onChange: () => { changes++; }, loginRecheckMs: 10 });
    await service.loginCli("codex", "login_poll", h.project);
    assert.equal(reads, 1, "only the installed check read it; the window has only just opened");
    const end = Date.now() + 3000;
    while (service.state.tools.codex.signedIn !== true && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.state.tools.codex.signedIn, true);
    const readsAtSignIn = reads;
    assert.ok(readsAtSignIn >= 4, `it asked more than once: ${readsAtSignIn}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(reads, readsAtSignIn, "no more reads after it said signed in");
    assert.ok(changes >= 4, `the page was told after each re-read: ${changes}`);
  } finally { h.close(); }
});

test("Gemini stays install-only with unknown sign-in and no auth or MCP calls", async () => {
  const h = harness(["gemini"]);
  try {
    const service = h.service();
    await service.refreshAll(h.project);
    assert.deepEqual(service.state.tools.gemini, { installed: true, version: "1.2.3", signedIn: null });
    const geminiCalls = h.calls.filter((call) => call.bin === "gemini").map((call) => call.args);
    assert.deepEqual(geminiCalls, [["--version"]], "Gemini runs its read-only version command only");
    const before = h.calls.length;
    await assert.rejects(service.loginCli("gemini", "gemini_login", h.project), /unknown and sign-in is unavailable/);
    assert.equal(service.state.tools.gemini.action?.requestId, "gemini_login", "the sign-in refusal is recorded against its request id");
    assert.equal(service.state.tools.gemini.action?.status, "failed");
    await assert.rejects(service.addMcp("gemini", "gemini_mcp", "tool", "https://mcp.example"), /MCP changes are unavailable/);
    assert.equal(h.calls.length, before, "Gemini auth and MCP actions never reach a CLI");
    assert.equal(service.state.skills.gemini.action?.requestId, "gemini_mcp", "the MCP refusal is recorded against its request id");
    assert.equal(service.state.skills.gemini.action?.status, "failed");
  } finally { h.close(); }
});

test("round 1 fix 14: the login window starts the CLI the status check would use, never one planted in a workspace folder on PATH", async () => {
  const h = harness();
  const planted = join(h.root, "planted"), real = join(h.root, "real");
  mkdirSync(planted); mkdirSync(real);
  writeFileSync(join(planted, "claude.exe"), ""); writeFileSync(join(real, "claude.exe"), "");
  setCliSkipFolders(() => [planted]);
  try {
    h.env.PATH = `${planted};${real}`;
    await h.service().loginCli("claude", "login_planted", h.project);
    assert.equal(h.calls.findLast((call) => call.bin === "cmd")?.env?.CC_LOGIN_PROGRAM, join(real, "claude.exe"), "the copy inside the workspace folder is skipped");
    h.calls.length = 0;
    h.env.PATH = planted;
    await assert.rejects(h.service().loginCli("claude", "login_only_planted", h.project), /found only inside a project folder/);
    assert.equal(h.calls.some((call) => call.bin === "cmd"), false, "nothing is launched when the only copy is the planted one");
  } finally { setCliSkipFolders(() => []); h.close(); }
});

test("round 2 fix 4: a login path with spaces, (x86), & and ^ reaches the launcher unchanged", { skip: process.platform !== "win32" }, async () => {
  const h = harness();
  try {
    for (const name of ["Program Files (x86)", "A&B", "a ^ b & (c)"]) {
      const dir = join(h.root, name, "bin"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude.exe"), "");
      h.env.PATH = dir;
      h.calls.length = 0;
      await h.service().loginCli("claude", "login_odd_path", h.project);
      const opened = h.calls.findLast((call) => call.bin === "cmd");
      assert.deepEqual(opened?.args, [...LOGIN_START, "auth", "login"], name);
      assert.equal(opened?.env?.CC_LOGIN_PROGRAM, join(dir, "claude.exe"), name);
      assert.equal(opened?.verbatimArgs, true, name);
    }
  } finally { h.close(); }
});

test("round 2 fix 4: the real cmd.exe hands a launcher whose path holds & ^ ( ) % and spaces its own path and arguments intact", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-loginpath-")); fakeCliDirs.push(root);
  const dir = join(root, "Program Files (x86)", "A&B ^ 100%"); mkdirSync(dir, { recursive: true });
  // A copy of node.exe stands in for the CLI; its script records the path it was started by and its arguments, and starts nothing else.
  const launcher = join(dir, "fakeclaude.exe"), script = join(root, "record.js"), record = join(root, "argv.json");
  copyFileSync(process.execPath, launcher);
  writeFileSync(script, "require('fs').writeFileSync(__dirname + '/argv.json', JSON.stringify([process.execPath, ...process.argv.slice(2)]))");
  const run = createCliRunner(spawn, { ...process.env } as NodeJS.ProcessEnv);
  // "/b" right after the empty title runs the launcher in the (hidden) parent console, so the test opens no window.
  const [cmdSwitch, startVerb, title, ...programArg] = LOGIN_START;
  const result = await run("cmd", [cmdSwitch, startVerb, title, "/b", ...programArg, script, "auth", "login"], { timeoutMs: 10_000, env: { CC_LOGIN_PROGRAM: launcher }, verbatimArgs: true });
  assert.equal(result.code, 0, result.stderr);
  const end = Date.now() + 10_000;
  while (!existsSync(record) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(record), "the launcher ran");
  // start /b does not wait: a running .exe cannot be deleted, so deleting the launcher proves it has exited (no file lock at cleanup).
  const exitedBy = Date.now() + 10_000;
  while (existsSync(launcher) && Date.now() < exitedBy) { try { unlinkSync(launcher); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  assert.ok(!existsSync(launcher), "the launcher exited and released its file");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), [launcher, "auth", "login"]);
});

test("ghLogin opens web auth and stores only the connected flag and account name", async () => {
  const h = harness([]);
  try {
    h.setGithub(false);
    const service = h.service();
    await service.loginGitHub("github_login");
    assert.deepEqual(h.calls.find((call) => call.bin === "cmd")?.args, ["/c", "start", "", "gh", "auth", "login", "--web"]);
    const end = Date.now() + 3000;
    while (service.state.github.connected !== true && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(service.state.github, { connected: true, account: "octocat", action: { requestId: "github_login", status: "done", message: "Done" } });
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /ghp_SHOULD_NEVER_LEAK|Token:/);
  } finally { h.close(); }
});

test("MCP add/remove and Claude plugin install/uninstall use exact argv and reject unsafe values", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.addMcp("codex", "mcp_codex_url", "safe-name", "https://mcp.example/v1");
    await service.addMcp("codex", "mcp_codex_command", "codex-tool", "npx -y codex-server");
    await service.addMcp("claude", "mcp_claude_command", "tool_1", "npx -y @scope/server");
    await service.addMcp("claude", "mcp_claude_url", "claude-tool", "https://claude.example/mcp");
    await service.addMcp("opencode", "mcp_opencode_url", "open-tool", "https://open.example/mcp");
    await service.addMcp("opencode", "mcp_opencode_command", "open-command", "npx -y open-server");
    await service.removeMcp("codex", "mcp_remove_codex", "safe-name", true);
    await service.removeMcp("claude", "mcp_remove_claude", "tool_1", true);
    await service.installPlugin("plugin_install", "helper@official");
    await service.uninstallPlugin("plugin_remove", "helper@official", true);
    const args = h.calls.filter((call) => ["claude", "codex", "opencode"].includes(call.bin)).map((call) => [call.bin, ...call.args]);
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "add", "safe-name", "--url", "https://mcp.example/v1"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "add", "codex-tool", "--", "npx", "-y", "codex-server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "add", "-s", "user", "tool_1", "--", "npx", "-y", "@scope/server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "add", "-s", "user", "--transport", "http", "claude-tool", "https://claude.example/mcp"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["opencode", "mcp", "add", "open-tool", "--url", "https://open.example/mcp"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["opencode", "mcp", "add", "open-command", "--", "npx", "-y", "open-server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "remove", "safe-name"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "remove", "-s", "user", "tool_1"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "plugin", "install", "helper@official"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "plugin", "uninstall", "helper@official"])));
    assert.equal(h.calls.filter((call) => call.args.join(" ") === "mcp list").length, 10, "every MCP and Claude plugin action refreshes inventory");
    assert.equal(h.calls.filter((call) => call.args.join(" ") === "plugin list").length, 5, "every Claude inventory change refreshes plugin inventory too");
    const before = h.calls.length;
    await assert.rejects(service.addMcp("codex", "mcp_bad_name", "../bad", "npx server"), /invalid MCP name/);
    for (const leading of ["-s", "--transport", "_x", ".x"]) {
      await assert.rejects(service.addMcp("claude", "mcp_dash_add", leading, "https://mcp.example/v1"), /invalid MCP name/);
      await assert.rejects(service.removeMcp("claude", "mcp_dash_remove", leading, true), /invalid MCP name/);
    }
    for (const leading of ["-g", "--scope", "@x/y", ".x", "/x"]) {
      await assert.rejects(service.installPlugin("plugin_dash_add", leading), /invalid plugin name/);
      await assert.rejects(service.uninstallPlugin("plugin_dash_remove", leading, true), /invalid plugin name/);
    }
    await assert.rejects(service.addMcp("codex", "mcp_bad_shell", "safe", "npx server && whoami"), /shell metacharacters/);
    await assert.rejects(service.addMcp("claude", "mcp_url_password", "safe", "https://user:secret@mcp.example/v1"), /without credentials/);
    await assert.rejects(service.addMcp("codex", "mcp_url_user", "safe", "https://token@mcp.example/v1"), /without credentials/);
    assert.throws(() => parseMcpCommand("https://user:secret@mcp.example"), /without credentials/);
    assert.throws(() => parseMcpCommand("https://token@mcp.example"), /without credentials/);
    assert.equal(h.calls.slice(before).some((call) => call.args.some((arg) => arg.includes("secret") || arg.includes("token@"))), false, "a URL with credentials never reaches a CLI");
    await assert.rejects(service.removeMcp("opencode", "mcp_no_remove", "safe", true), /unavailable/);
    await assert.rejects(service.removeMcp("claude", "mcp_no_confirm", "safe", false), /confirmation is required/);
    await assert.rejects(service.uninstallPlugin("plugin_no_confirm", "helper", false), /confirmation is required/);
    assert.equal(h.calls.slice(before).some((call) => call.args.includes("../bad") || call.args.includes("whoami")), false);
  } finally { h.close(); }
});

test("notes vault and default folder require real absolute directories and survive reload", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.setNotesVault("vault_set", h.vault);
    await service.setDefaultProjectFolder("folder_set", h.project);
    assert.equal(service.state.vault.path, h.vault);
    assert.equal(service.state.folders.defaultProjectFolder, h.project);
    await assert.rejects(service.setNotesVault("vault_traversal", "../outside"), /without traversal/);
    await assert.rejects(service.setDefaultProjectFolder("folder_traversal", `${h.project}\\..\\outside`), /without traversal/);
    await assert.rejects(service.setDefaultProjectFolder("folder_file", service.path), /must be a directory/);
    assert.equal(service.state.preferenceAction?.requestId, "folder_file");
    assert.equal(service.state.preferenceAction?.status, "failed");
    const restarted = h.service();
    assert.equal(restarted.state.vault.path, h.vault);
    assert.equal(restarted.state.folders.defaultProjectFolder, h.project);
    await restarted.setNotesVault("vault_clear", null);
    assert.equal(restarted.state.vault.path, null);
  } finally { h.close(); }
});

test("permission mode maps to SDK values, applies live before saving, and persists per tab", async () => {
  const h = harness();
  try {
    const service = h.service();
    const calls: string[] = [];
    const shouldNotStop = () => false;
    assert.deepEqual(["ask", "accept", "plan", "bypass"].map((mode) => permissionModeForSdk(mode as any)), ["default", "acceptEdits", "plan", "bypassPermissions"]);
    assert.equal(service.permissionMode("alpha-development"), "accept");
    await assert.rejects(service.setPermissionMode("alpha-development", "perm_no_confirm", "bypass", false, async () => true, shouldNotStop), /confirmation is required/);
    assert.deepEqual(calls, []);
    await service.setPermissionMode("alpha-development", "perm_plan", "plan", false, async (mode) => {
      calls.push(mode);
      assert.equal(service.permissionMode("alpha-development"), "accept", "state remains saved until the live change succeeds");
      assert.equal(persistedPermissionMode(service.path, "alpha-development"), "accept", "disk remains saved until the live change succeeds");
      return true;
    }, shouldNotStop);
    assert.deepEqual(calls, ["plan"]);
    await service.setPermissionMode("beta-development", "perm_bypass", "bypass", true, async (mode) => {
      calls.push(mode);
      assert.equal(service.permissionMode("beta-development"), "accept");
      assert.equal(persistedPermissionMode(service.path, "beta-development"), "accept");
      return true;
    }, shouldNotStop);
    assert.deepEqual(calls, ["plan", "bypass"]);
    const restarted = h.service();
    assert.equal(restarted.permissionMode("alpha-development"), "plan");
    assert.equal(restarted.permissionMode("beta-development"), "bypass");
  } finally { h.close(); }
});

test("removing workspace tabs deletes their persisted permission modes and actions", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.setPermissionMode("alpha-development", "perm_remove_tab", "plan", false, async () => true, () => false);
    assert.equal(service.permissionMode("alpha-development"), "plan");
    assert.equal(service.state.permissionActions["alpha-development"].status, "done");

    service.removePermissionModes(["alpha-development"]);

    assert.equal(Object.hasOwn(service.state.permissionModes, "alpha-development"), false);
    assert.equal(Object.hasOwn(service.state.permissionActions, "alpha-development"), false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(service.path, "utf8")).permissionModes, "alpha-development"), false);
    assert.equal(h.service().permissionMode("alpha-development"), "accept", "a restarted service uses the default mode");
  } finally { h.close(); }
});

test("permission mode interleavings keep saved state aligned or stop the chat", async (t) => {
  const scenarios = ["success", "false", "throw", "hang", "late resolve after timeout", "save failure", "three queued A->B->C"] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const h = harness();
      try {
        const timeout = scenario === "hang" || scenario === "late resolve after timeout" ? 25 : undefined;
        const service = h.service(undefined, timeout);
        const tabId = "alpha-development";
        let sessionRunning = true;
        let liveMode: PermissionMode | undefined = "accept";
        let stops = 0;
        const calls: PermissionMode[] = [];
        const stopLiveSession = () => {
          stops++;
          const wasRunning = sessionRunning;
          sessionRunning = false;
          liveMode = undefined;
          return wasRunning;
        };
        const change = (requestId: string, mode: PermissionMode, applyLive: (mode: PermissionMode) => Promise<boolean>) =>
          service.setPermissionMode(tabId, requestId, mode, mode === "bypass", applyLive, stopLiveSession);
        const assertStopped = (expectedSaved: PermissionMode = "accept") => {
          assert.equal(sessionRunning, false, `${scenario}: the chat session must be stopped`);
          assert.equal(stops, 1, `${scenario}: stop the session exactly once`);
          assert.equal(liveMode, undefined, `${scenario}: a stopped session has no live mode`);
          assert.equal(service.permissionMode(tabId), expectedSaved, `${scenario}: saved state stays in the prior mode`);
          assert.equal(persistedPermissionMode(service.path, tabId), expectedSaved, `${scenario}: disk stays in the prior mode`);
        };
        const assertChatStoppedError = async (operation: Promise<PermissionMode>, expected: RegExp) => {
          await assert.rejects(operation, (error: Error) => {
            assert.match(error.message, expected, `${scenario}: includes the failure reason`);
            assert.match(error.message, /the chat was stopped/i, `${scenario}: tells the user the chat stopped`);
            assert.match(error.message, /next message starts a fresh session in saved mode accept/i, `${scenario}: says the next message starts fresh in saved mode`);
            assert.match(error.message, /conversation context is lost/i, `${scenario}: says the conversation context is lost`);
            return true;
          });
        };

        if (scenario === "success") {
          const result = await change("perm_success", "plan", async (mode) => { calls.push(mode); liveMode = mode; return true; });
          assert.equal(result, "plan");
          assert.equal(sessionRunning, true);
          assert.equal(stops, 0);
          assert.equal(liveMode, "plan");
          assert.equal(service.permissionMode(tabId), "plan");
          assert.equal(persistedPermissionMode(service.path, tabId), "plan");
        } else if (scenario === "false") {
          await assertChatStoppedError(change("perm_false", "plan", async (mode) => { calls.push(mode); return false; }), /failed/i);
          assertStopped();
        } else if (scenario === "throw") {
          await assertChatStoppedError(change("perm_throw", "plan", async (mode) => { calls.push(mode); throw new Error("sdk failure"); }), /failed/i);
          assertStopped();
        } else if (scenario === "hang") {
          await assertChatStoppedError(change("perm_hang", "plan", async (mode) => { calls.push(mode); return new Promise<boolean>(() => {}); }), /timed out/i);
          assertStopped();
        } else if (scenario === "late resolve after timeout") {
          let resolveLate!: (ok: boolean) => void;
          let signalStarted!: () => void;
          const started = new Promise<void>((resolve) => { signalStarted = resolve; });
          const applyLive = (mode: PermissionMode): Promise<boolean> => {
            calls.push(mode);
            if (mode === "plan") {
              signalStarted();
              return new Promise<boolean>((resolve) => {
                resolveLate = (ok) => { if (sessionRunning && ok) liveMode = mode; resolve(ok); };
              });
            }
            if (!sessionRunning) return Promise.resolve(true);
            liveMode = mode;
            return Promise.resolve(true);
          };
          const timedOut = change("perm_late", "plan", applyLive);
          await started;
          const next = change("perm_after_timeout", "ask", applyLive);
          const [firstResult, nextResult] = await Promise.allSettled([timedOut, next]);
          assert.equal(firstResult.status, "rejected", `${scenario}: timed out request must fail`);
          assert.equal(nextResult.status, "fulfilled", `${scenario}: later request must drain the queue`);
          const error = firstResult.status === "rejected" ? firstResult.reason as Error : new Error("expected timeout");
          assert.match(error.message, /timed out/);
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          const modeBeforeLateResolve = liveMode;
          resolveLate(true);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(liveMode, modeBeforeLateResolve, `${scenario}: late resolution on a stopped handle changes nothing`);
          assert.equal(sessionRunning, false, `${scenario}: the timed out handle was stopped`);
          assert.equal(stops, 1, `${scenario}: the timed out handle was stopped once`);
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          assert.match(error.message, /the chat was stopped/i);
          assert.match(error.message, /next message starts a fresh session in saved mode accept/i);
          assert.match(error.message, /conversation context is lost/i);
        } else if (scenario === "save failure") {
          mkdirSync(service.path);
          await assertChatStoppedError(change("perm_save_fail", "plan", async (mode) => { calls.push(mode); liveMode = mode; return true; }), /could not be saved/i);
          assert.equal(sessionRunning, false, `${scenario}: a successful live apply with a failed save stops the session`);
          assert.equal(stops, 1);
          assert.equal(liveMode, undefined);
          assert.equal(service.permissionMode(tabId), "accept", `${scenario}: state is not advanced before save succeeds`);
          removeWithRetry(service.path);
          assert.equal(persistedPermissionMode(service.path, tabId), "accept", `${scenario}: reloading cannot see the unsaved mode`);
        } else {
          let finishA!: (ok: boolean) => void;
          let signalAStarted!: () => void;
          const aStarted = new Promise<void>((resolve) => { signalAStarted = resolve; });
          const gateA = new Promise<boolean>((resolve) => { finishA = resolve; });
          const applyLive = (mode: PermissionMode): Promise<boolean> => {
            calls.push(mode);
            if (mode === "plan") {
              signalAStarted();
              return gateA.then((ok) => { if (ok && sessionRunning) liveMode = mode; return ok; });
            }
            if (!sessionRunning) return Promise.resolve(true);
            liveMode = mode;
            return Promise.resolve(true);
          };
          const a = change("perm_a", "plan", applyLive);
          await aStarted;
          const b = change("perm_b", "bypass", applyLive);
          const c = change("perm_c", "ask", applyLive);
          const results = Promise.allSettled([a, b, c]);
          finishA(true);
          const [ra, rb, rc] = await results;
          assert.deepEqual(calls, ["plan", "ask"], `${scenario}: the unstarted middle request is skipped`);
          assert.equal(ra.status, "fulfilled");
          assert.equal(rb.status, "rejected");
          if (rb.status === "rejected") assert.match(rb.reason.message, /superseded/);
          assert.deepEqual(rc, { status: "fulfilled", value: "ask" });
          assert.equal(sessionRunning, true);
          assert.equal(stops, 0);
          assert.equal(liveMode, "ask");
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          assert.deepEqual(service.state.permissionActions[tabId], { requestId: "perm_c", status: "done", message: "Done" });
        }
      } finally { h.close(); }
    });
  }
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

test("uploads status stays at 32 entries whether they start or finish, so finishing alone cannot grow state", () => {
  const h = harness();
  try {
    const service = h.service();
    for (let index = 0; index < 40; index++) service.finishUpload(`finish_only_${index}`, false, "refused");
    const kept = Object.keys(service.state.uploads);
    assert.equal(kept.length, 32);
    assert.equal(kept[0], "finish_only_8");
    for (let index = 0; index < 40; index++) service.beginUpload(`begin_${index}`);
    assert.equal(Object.keys(service.state.uploads).length, 32);
  } finally { h.close(); }
});

test("CLI inventory parsers return names only and reject unknown auth as unknown", () => {
  assert.deepEqual(parseMcpCommand("npx -y \"server with spaces\""), { type: "command", argv: ["npx", "-y", "server with spaces"] });
  assert.deepEqual(parseMcpCommand("https://mcp.example/server"), { type: "url", url: "https://mcp.example/server" });
  assert.throws(() => parseMcpCommand("http://mcp.example"), /https URL/);
  assert.deepEqual(parseMcpList("claude", "Checking MCP server health...\nserver_one: npx --token ghp_secret"), [{ name: "server_one" }]);
  assert.deepEqual(parseMcpList("codex", "• connected server_two: npx server"), [{ name: "server_two" }]);
  assert.deepEqual(parsePluginList("Installed plugins:\n- helper@official enabled"), ["helper@official"]);
  assert.deepEqual(parsePluginList("• helper-two@official enabled"), ["helper-two@official"]);
  const parsed = parseGitHubAuthStatus({ code: 0, stdout: "Logged in to github.com account octocat\nToken: ghp_SECRET", stderr: "" });
  assert.deepEqual(parsed, { connected: true, account: "octocat" });
  assert.equal(JSON.stringify(parsed).includes("ghp_SECRET"), false);
  assert.equal(parseGitHubAuthStatus({ code: 0, stdout: "checking", stderr: "" }).connected, null);
});

// ---- a settings.json that cannot be used starts the app on defaults and is kept as settings.json.bad-<timestamp> ----

for (const [label, content] of [["empty", ""], ["unparsable", '{"notesVaultPath": "C:/vau'], ["malformed", '{"permissionModes": []}'], ["an invalid mode", '{"permissionModes": {"alpha-dev": "yolo"}}']] as const) {
  test(`SettingsService: a ${label} settings.json starts on defaults and keeps a .bad copy`, () => {
    const root = mkdtempSync(join(tmpdir(), "cc-settings-bad-"));
    const original = console.error;
    console.error = () => {};
    try {
      writeFileSync(join(root, "settings.json"), content);
      const service = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
      assert.equal(service.state.vault.path, null);
      assert.deepEqual(service.state.permissionModes, {});
      const kept = readdirSync(root).filter((name) => /^settings\.json\.bad-\d+/.test(name));
      assert.equal(kept.length, 1, `one kept copy: ${JSON.stringify(readdirSync(root))}`);
      assert.equal(readFileSync(join(root, kept[0]), "utf8"), content, "the kept copy is the bad file, byte for byte");
    } finally { console.error = original; removeWithRetry(root); }
  });
}

test("SettingsService: a good settings.json is read as before and no .bad copy is made", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-good-"));
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ notesVaultPath: null, defaultProjectFolder: "C:/work", permissionModes: { "alpha-dev": "plan" } }));
    const service = new SettingsService({ dataRoot: root, env: NO_PATH });
    assert.equal(service.permissionMode("alpha-dev"), "plan");
    assert.deepEqual(readdirSync(root), ["settings.json"]);
  } finally { removeWithRetry(root); }
});

test("SettingsService: after a damaged settings.json every tab without a saved mode asks, through a save and a restart; a fresh install still accepts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-recover-")), fresh = mkdtempSync(join(tmpdir(), "cc-settings-fresh-"));
  const original = console.error;
  console.error = () => {};
  try {
    writeFileSync(join(root, "settings.json"), '{"permissionModes": {"alpha-dev": "pla');
    const first = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
    assert.equal(first.permissionMode("alpha-dev"), "ask", "the tab that was Plan no longer auto-accepts");
    assert.match(first.takeRecoveryNotice() ?? "", /damaged/);
    assert.equal(first.takeRecoveryNotice(), null, "the owner is told once");
    await first.setNotesVault("recover_vault", root);
    await first.setPermissionMode("beta-dev", "recover_pick", "accept", false, async () => true, () => false);
    const second = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
    assert.equal(second.permissionMode("alpha-dev"), "ask", "still Ask after a save and a restart");
    assert.equal(second.permissionMode("beta-dev"), "accept", "a mode the owner picked sticks");
    assert.equal(second.takeRecoveryNotice(), null, "a good file is not a recovery");
    assert.equal(new SettingsService({ dataRoot: fresh, env: NO_PATH }).permissionMode("alpha-dev"), "accept", "control: no file at all is a fresh install");
  } finally { console.error = original; removeWithRetry(root); removeWithRetry(fresh); }
});

test("SettingsService: a save is flushed to disk (fsync) before the atomic rename", async () => {
  // Real fs calls, recorded in order: node:fs's named exports are re-synced after the recorders are installed and again after they are removed.
  const events: string[] = [];
  const real = { fsyncSync: realFs.fsyncSync, renameSync: realFs.renameSync };
  const h = harness();
  try {
    realFs.fsyncSync = ((fd: number) => { events.push("fsync"); return real.fsyncSync(fd); }) as typeof realFs.fsyncSync;
    realFs.renameSync = ((from: string, to: string) => { events.push(`rename ${basename(to)}`); return real.renameSync(from, to); }) as typeof realFs.renameSync;
    syncBuiltinESMExports();
    await h.service().setNotesVault("vault_fsync", h.vault);
  } finally { realFs.fsyncSync = real.fsyncSync; realFs.renameSync = real.renameSync; syncBuiltinESMExports(); h.close(); }
  const rename = events.findIndex((e) => e === "rename settings.json");
  assert.ok(rename > 0, `the save renamed settings.json into place: ${JSON.stringify(events)}`);
  assert.ok(events.slice(0, rename).includes("fsync"), `an fsync ran before the rename: ${JSON.stringify(events)}`);
});

// ---- avatars no longer referenced are deleted when a new one is saved ----

test("pruneAvatars: deletes unreferenced uploaded pictures, keeps the new one and every picture a seat still uses, nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-avatars-"));
  try {
    const id = (n: number) => `avatar-${String(n).repeat(8)}-1111-2222-3333-${String(n).repeat(12)}.png`;
    const [oldOne, used, fresh] = [id(1), id(2), id(3)];
    for (const name of [oldOne, used, fresh, "notes.txt", "avatar-not-a-uuid.png"]) writeFileSync(join(dir, name), "x");
    const young = id(4);
    writeFileSync(join(dir, young), "x");
    const longAgo = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(dir, oldOne), longAgo, longAgo);
    const removed = pruneAvatars(dir, [`/api/avatar/${used}`, "avatars/ash.svg", undefined as any], fresh);
    assert.deepEqual(removed, [oldOne], "only the unreferenced file older than 10 minutes goes");
    assert.deepEqual(readdirSync(dir).sort(), [fresh, used, young, "avatar-not-a-uuid.png", "notes.txt"].sort(), "an unreferenced file younger than 10 minutes stays");
    assert.deepEqual(pruneAvatars(join(dir, "missing"), [], fresh), [], "a missing folder is not an error");
  } finally { removeWithRetry(dir); }
});

// ---- sign-in parsing against the formats the real CLIs print ----

test("sign-in status reads the real output formats: claude JSON, codex words, opencode's credential count", async () => {
  const h = harness();
  try {
    const outputs: Record<string, { code: number; stdout: string; stderr?: string }> = {
      "claude auth status": { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "user@example.com", subscriptionType: "max" }, null, 2) },
      "codex login status": { code: 0, stdout: "Logged in using ChatGPT" },
      "opencode auth list": { code: 0, stdout: "\n┌  Credentials ~\\.local\\share\\opencode\\auth.json\n│\n●  OpenCode Go api\n│\n●  Anthropic api\n│\n└  2 credentials\n\n" },
    };
    const read = async (patch: Record<string, { code: number; stdout: string }>) => {
      const runner: RunCli = async (bin, args) => {
        if (args.length === 1 && args[0] === "--version") return { code: 0, stdout: `${bin} 1.2.3`, stderr: "" };
        const row = { ...outputs, ...patch }[`${bin} ${args.join(" ")}`];
        return row ? { stderr: "", ...row } : { code: 0, stdout: "", stderr: "" };
      };
      const service = new SettingsService({ dataRoot: h.dataRoot, env: h.env, runCli: runner });
      await service.refreshAll(null);
      return service.state.tools;
    };
    let tools = await read({});
    assert.equal(tools.claude.signedIn, true, "JSON \"loggedIn\": true (the old words never matched it, so it always read unknown)");
    assert.equal(tools.codex.signedIn, true);
    assert.equal(tools.opencode.signedIn, true, "credentials listed");
    tools = await read({
      "claude auth status": { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) },
      "codex login status": { code: 1, stdout: "Not logged in" },
      "opencode auth list": { code: 0, stdout: "\n┌  Credentials ~\\.local\\share\\opencode\\auth.json\n│\n└  0 credentials\n\n" },
    });
    assert.equal(tools.claude.signedIn, false);
    assert.equal(tools.codex.signedIn, false);
    assert.equal(tools.opencode.signedIn, false, "zero credentials is signed out (the box-drawing lines used to read as a credential)");
    tools = await read({ "claude auth status": { code: 0, stdout: "something new" }, "opencode auth list": { code: 0, stdout: "┌  Credentials\n│\n●  Something\n" } });
    assert.equal(tools.claude.signedIn, null, "unrecognised output stays unknown");
    assert.equal(tools.opencode.signedIn, null);
  } finally { h.close(); }
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
