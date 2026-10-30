import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCliSkipFolders } from "../server/leader-common.ts";
import { createCliRunner, parseGitHubAuthStatus, parseMcpCommand, parseMcpList, parsePluginList, SettingsService, type RunCli } from "../server/settings.ts";
import { fakeCliDirs, LOGIN_START, PKGS, harness } from "./settings-helpers.ts";

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
