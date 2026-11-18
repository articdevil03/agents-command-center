import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

const { modules: { buildLeaderOptions } } = await importWithTempDataRoot(async () => ({
  buildLeaderOptions: (await import("../server/leader.ts")).buildLeaderOptions,
}));
const { createLeader } = await import("../server/leader.ts");
const folder = scratchDir(), vault = scratchDir();
function fixture(mode: "ask" | "accept" | "plan", savedAsks = () => false) {
  const asks: string[] = [];
  const options = buildLeaderOptions({ model: "fake", effort: "medium" }, folder, null, undefined, mode,
    async (tool) => { asks.push(tool); return true; }, savedAsks, undefined, undefined, vault);
  const hook = async (tool: string, input = {}) => options.hooks!.PreToolUse![0].hooks[0]({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, permission_mode: "bypassPermissions",
    tool_use_id: "test", session_id: "child", cwd: folder, transcript_path: "unused",
  }, "test", { signal: new AbortController().signal }) as Promise<any>;
  const callback = (tool: string, input = {}) => options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: "test" });
  return { asks, hook, callback };
}

for (const mode of ["ask", "accept"] as const) test(`${mode}: harmless built-ins need no card but child commands still ask`, async () => {
  const f = fixture(mode);
  for (const tool of ["TodoWrite", "Task", "Agent", "Skill", "ToolSearch", "TaskOutput", "TaskGet", "TaskList"]) {
    assert.deepEqual(await f.hook(tool), {});
    assert.equal((await f.callback(tool)).behavior, "allow");
  }
  assert.deepEqual(f.asks, []);
  assert.equal((await f.hook("Bash", { command: "fake" })).hookSpecificOutput?.permissionDecision, "allow");
  assert.deepEqual(f.asks, ["Bash"], "a bypass child never lowers command approval");
});

test("Accept grants the configured vault but not a third root", async () => {
  const f = fixture("accept");
  for (const tool of ["Read", "Write"]) {
    const input = { file_path: join(vault, "note.md") };
    assert.deepEqual(await f.hook(tool, input), {});
  }
  assert.deepEqual(f.asks, [], "the hook, where the app decides, asks nothing for the vault");
  // A call that reaches the SDK callback is the CLI's own prompt: it always asks.
  for (const tool of ["Read", "Write"]) assert.equal((await f.callback(tool, { file_path: join(vault, "note.md") })).behavior, "allow");
  assert.deepEqual(f.asks, ["Read", "Write"]);
  await f.hook("Write", { file_path: join(scratchDir(), "outside.md") });
  assert.deepEqual(f.asks, ["Read", "Write", "Write"]);
});

test("held Plan live plan leaves enforcement to CLI, and after exit asks and honors Allow", async () => {
  const asks: string[] = [];
  const options = buildLeaderOptions({ model: "fake", effort: "medium" }, folder, null, undefined, "plan",
    async (tool) => { asks.push(tool); return true; });
  const hook = (tool: string, live: string) => options.hooks!.PreToolUse![0].hooks[0]({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, permission_mode: live,
    tool_use_id: "test", session_id: "main", cwd: folder, transcript_path: "unused",
  } as any, "test", { signal: new AbortController().signal }) as Promise<any>;
  for (const tool of ["Write", "Edit", "Bash", "PowerShell", "ExitPlanMode", "AskUserQuestion", "unknown"]) assert.deepEqual(await hook(tool, "plan"), {});
  assert.deepEqual(asks, []);
  for (const tool of ["Write", "Edit", "Bash", "PowerShell"]) assert.equal((await hook(tool, "acceptEdits")).hookSpecificOutput?.permissionDecision, "allow");
  for (const tool of ["Read", "ExitPlanMode", "AskUserQuestion", "unknown"]) assert.deepEqual(await hook(tool, "acceptEdits"), {}, "base hook leaves non-mutating tools to the CLI");
  assert.deepEqual(asks, ["Write", "Edit", "Bash", "PowerShell"]);
  assert.equal((await options.canUseTool!("ExitPlanMode", {}, { signal: new AbortController().signal, toolUseID: "test" })).behavior, "allow");
  assert.deepEqual(asks, ["Write", "Edit", "Bash", "PowerShell", "ExitPlanMode"]);
});

for (const mode of ["ask", "accept"] as const) test(mode + ": EnterPlanMode is approvable as in base", async () => {
  const f = fixture(mode);
  assert.equal((await f.callback("EnterPlanMode")).behavior, "allow");
  assert.deepEqual(f.asks, ["EnterPlanMode"]);
});

test("both permission entry points deny when the saved mode lookup throws", async () => {
  const f = fixture("accept", () => { throw new Error("private failure"); });
  assert.equal((await f.hook("Write")).hookSpecificOutput?.permissionDecision, "deny");
  // The SDK callback never reads the mode: it asks, and it denies when the ask itself throws.
  assert.equal((await f.callback("Write")).behavior, "allow");
  assert.deepEqual(f.asks, ["Write"]);
  const broken = buildLeaderOptions({ model: "fake", effort: "medium" }, folder, null, undefined, "accept", async () => { throw new Error("private failure"); });
  assert.deepEqual(await broken.canUseTool!("Write", {}, { signal: new AbortController().signal, toolUseID: "t" }), { behavior: "deny", message: "The user denied this." });
  assert.deepEqual(await broken.canUseTool!("Write", {}, undefined as any), { behavior: "deny", message: "The user denied this." }, "missing context reaches the outer catch and fails closed");
});

test("the vault keeps Ask and held Plan after-exit approval", async () => {
  const input = { file_path: join(vault, "note.md") };
  const ask = fixture("ask");
  assert.equal((await ask.hook("Write", input)).hookSpecificOutput?.permissionDecision, "allow");
  assert.deepEqual(ask.asks, ["Write"]);
  const plan = fixture("plan");
  assert.deepEqual(await plan.hook("Read", input), {});
  assert.equal((await plan.callback("Read", input)).behavior, "allow");
  assert.equal((await plan.hook("Write", input)).hookSpecificOutput?.permissionDecision, "allow");
  assert.deepEqual(plan.asks, ["Read", "Write"], "the SDK callback asks for the Read, as in the base");
});

test("observed live Plan notifies the page and updates the launch accessor", async () => {
  let options: any, release!: () => void, notifications = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const leader = createLeader({ model: "fake", effort: "medium" }, folder, null,
    { onDelta() {}, onDone() {}, onUsage() {}, onError() {}, onPermissionMode() { notifications++; } },
    undefined, "accept", undefined, ((args: any) => {
      options = args.options;
      return { async *[Symbol.asyncIterator]() { await held; }, async return() { release(); return { done: true }; } };
    }) as any);
  try {
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: "plan", tool_name: "Read", tool_input: {} }, "id", { signal: new AbortController().signal });
    assert.equal(leader.getPermissionMode(), "plan");
    assert.equal(notifications, 1, "the page gets the observed mode change immediately");
  } finally { leader.stop(); release(); await held; }
});
