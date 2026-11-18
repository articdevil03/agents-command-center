import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

const { modules: { buildLeaderOptions, knownLeaderStartFailure, plainOpencodeFailure } } = await importWithTempDataRoot(async () => ({
  buildLeaderOptions: (await import("../server/leader.ts")).buildLeaderOptions,
  knownLeaderStartFailure: (await import("../server/main/leader-turn.ts")).knownLeaderStartFailure,
  plainOpencodeFailure: (await import("../server/leader-opencode/errors.ts")).plainOpencodeFailure,
}));
const folder = scratchDir();
function fixture(mode: "ask" | "accept" | "bypass", tools?: { mcpServers: Record<string, never>; allowedTools: string[] }) {
  const asks: string[] = [];
  const options = buildLeaderOptions({ model: "fake", effort: "medium" }, folder, null, tools as any, mode,
    async (tool) => { asks.push(tool); return true; });
  const live = mode === "ask" ? "default" : mode === "accept" ? "acceptEdits" : "bypassPermissions";
  const hook = (tool: string, input = {}) => options.hooks!.PreToolUse![0].hooks[0]({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, permission_mode: live,
    tool_use_id: "t", session_id: "s", cwd: folder, transcript_path: "unused",
  } as any, "t", { signal: new AbortController().signal }) as Promise<any>;
  const callback = (tool: string, input = {}) => options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: "t" });
  return { asks, hook, callback };
}

// R-1: the CLI expands "~", "%VAR%" and "$VAR", so none of these may count as inside the project.
for (const mode of ["ask", "accept"] as const) test(`${mode}: paths the CLI expands outside the folder ask a card, plain project paths do not`, async () => {
  const f = fixture(mode);
  const outside: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: "~/.ssh/id_rsa" }], ["Write", { file_path: "~/Documents/x" }], ["Glob", { pattern: "~/.ssh/*" }],
    ["Read", { file_path: "~" }], ["Edit", { file_path: "%USERPROFILE%/x" }], ["Read", { file_path: "$HOME/x" }], ["Grep", { path: "~/x", pattern: "a" }],
  ];
  for (const [tool, input] of outside) await f.hook(tool, input);
  assert.equal(f.asks.length, outside.length, `every expanded path asked: ${f.asks}`);
  const before = f.asks.length;
  await f.hook("Write", { file_path: "src/a.ts" }); await f.hook("Glob", { pattern: "src/**/*.ts" }); await f.hook("Read", { file_path: join(folder, "a.ts") });
  if (mode === "accept") assert.equal(f.asks.length, before, "ordinary project paths still need no card in Accept");
  else assert.equal(f.asks.length, before + 1, "Ask still asks for the project write, not for read-only search");
});

// R-2: the CLI's own prompts arrive in canUseTool; only harmless built-ins and crew tools skip the card there.
for (const mode of ["accept", "bypass"] as const) test(`${mode}: canUseTool asks for sensitive project files and any other call, not for harmless built-ins or crew tools`, async () => {
  const f = fixture(mode, { mcpServers: {}, allowedTools: ["mcp__crew__get_fixed_task"] });
  const sensitive = [".claude/settings.json", ".git/hooks/pre-commit", ".mcp.json", ".gitconfig"].map((name) => join(folder, name));
  for (const file_path of sensitive) assert.equal((await f.callback("Write", { file_path })).behavior, "allow");
  assert.equal((await f.callback("Bash", { command: "echo" })).behavior, "allow");
  assert.deepEqual(f.asks, ["Write", "Write", "Write", "Write", "Bash"], "each sensitive write and the command asked a card");
  f.asks.length = 0;
  for (const tool of ["TodoWrite", "KillShell", "ListMcpResources", "mcp__crew__get_fixed_task"]) assert.equal((await f.callback(tool)).behavior, "allow");
  assert.deepEqual(f.asks, [], "harmless built-ins and crew tools skip the card");
  assert.equal((await f.callback("AskUserQuestion")).behavior, "deny");
  assert.deepEqual(f.asks, []);
});

test("the hook keeps its inside-folder shortcut (Accept) and never asks in Bypass", async () => {
  const accept = fixture("accept");
  assert.deepEqual(await accept.hook("Write", { file_path: join(folder, "a.ts") }), {});
  assert.deepEqual(accept.asks, []);
  const bypass = fixture("bypass");
  assert.deepEqual(await bypass.hook("Bash", { command: "x" }), {});
  assert.equal((await bypass.hook("AskUserQuestion")).hookSpecificOutput?.permissionDecision, "deny", "the question refusal stays in the hook");
  assert.deepEqual(bypass.asks, []);
});

// R-4: built-ins that run nothing.
for (const mode of ["ask", "accept"] as const) test(`${mode}: KillShell and the MCP resource lister need no card; resource reads and WebFetch still ask`, async () => {
  const f = fixture(mode);
  for (const tool of ["KillShell", "ListMcpResources"]) assert.deepEqual(await f.hook(tool), {});
  assert.deepEqual(f.asks, []);
  await f.hook("WebFetch", { url: "https://example.com" });
  assert.deepEqual(f.asks, ["WebFetch"]);
  await f.hook("ReadMcpResource", { uri: "file:///private" });
  assert.equal((await f.callback("ReadMcpResource", { uri: "file:///private" })).behavior, "allow");
  assert.deepEqual(f.asks, ["WebFetch", "ReadMcpResource", "ReadMcpResource"]);
});

// R-3: fixed, plain start failures are shown; anything else stays generic.
test("known start failures tell the user what to do and hold no path or id", () => {
  for (const message of [
    "Planner has no model. Choose one in Settings before continuing.", "OpenCode 1 is needed.", "Install the tool first.",
    "This tool is being removed. Try again when it finishes.",
    "This tool is unavailable or its saved connection does not match. Check installation and add its connection again.",
  ]) assert.equal(knownLeaderStartFailure(message), message);
  assert.equal(knownLeaderStartFailure("C:\\Users\\someone\\x has no model. Choose one in Settings before continuing."), null);
  assert.equal(knownLeaderStartFailure("boom at C:\\Users\\someone"), null);
  assert.equal(knownLeaderStartFailure("The Claude CLI (C:/Users/someone/cli) lies inside the tab folder (C:/Users/someone); refusing to start it from there."), "The CLI is inside the tab folder. Choose a different project folder or install it outside project folders.");
  assert.equal(knownLeaderStartFailure("fake-acp was found only inside a project folder (C:/Users/someone), which is never used"), "The CLI was found only inside a project folder. Choose a different project folder or install it outside project folders.");
  assert.equal(knownLeaderStartFailure("The previous leader on this tab did not exit within 5 seconds and may still be running, pid 123 at C:/Users/someone"), "The previous leader on this tab could not be confirmed stopped and may still be running. Close it in Task Manager before starting another leader.");
  assert.equal(plainOpencodeFailure("OpenCode exited before it started; is it installed?", "exit"), "OpenCode exited before it started; is it installed?");
});
