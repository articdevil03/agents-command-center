import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, lstatSync, unlinkSync, rmdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const root = mkdtempSync(join(tmpdir(), "cc-p3-leader-"));
const previous = { data: process.env.CC_DATA_DIR, packaged: process.env.CC_TEST_FORCE_PACKAGED };
process.env.CC_DATA_DIR = root;
process.env.CC_TEST_FORCE_PACKAGED = "1";
const { createLeader } = await import("../server/leader.ts");
const { createOpencodeLeader } = await import("../server/leader-opencode.ts");
after(() => {
  for (const [key, value] of [["CC_DATA_DIR", previous.data], ["CC_TEST_FORCE_PACKAGED", previous.packaged]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  // Only this test's disposable root: exact files, then empty directories, never links.
  const folders = [root];
  for (const folder of folders) for (const name of readdirSync(folder)) {
    const path = join(folder, name), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, path);
    if (stat.isDirectory()) folders.push(path); else unlinkSync(path);
  }
  for (const folder of folders.reverse()) { assert.deepEqual(readdirSync(folder), []); rmdirSync(folder); }
});

const seat = { model: "fake", effort: "medium" };
function claude(mode: "ask" | "accept" | "plan" | "bypass", ask: any, onError = (_message: string) => {}) {
  let options: any, release!: () => void, complete!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const ended = new Promise<void>((ok) => { complete = ok; });
  const handle: any = {
    async *[Symbol.asyncIterator]() { try { await held; } finally { complete(); } },
    setPermissionMode: async () => {}, setModel: async () => {}, return: async () => { release(); return { done: true }; },
  };
  const leader = createLeader(seat, root, null, { onDelta() {}, onDone() {}, onUsage() {}, onError }, undefined, mode, ask,
    ((args: any) => { options = args.options; return handle; }) as any);
  return { leader, options, stop: async () => { leader.stop(); release(); await ended; } };
}
const event = (tool: string, input = {}, mode = "bypassPermissions") => ({
  hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, permission_mode: mode,
  session_id: "child", transcript_path: "unused", cwd: root, tool_use_id: "tool",
});
const hook = (options: any, tool: string, input = {}, signal = new AbortController().signal, mode = "bypassPermissions") =>
  options.hooks.PreToolUse[0].hooks[0](event(tool, input, mode), "tool", { signal });

for (const tool of ["Bash", "PowerShell", "Read"]) for (const outcome of ["deny", "abort", "error"]) {
  test(`Accept child bypass cannot execute ${tool} after approval ${outcome}`, async () => {
    let asks = 0, executions = 0;
    const controller = new AbortController();
    const h = claude("accept", async () => {
      asks++;
      if (outcome === "error") throw new Error("approval failed");
      if (outcome === "abort") controller.abort();
      return outcome === "abort";
    });
    const input = tool === "Read" ? { file_path: join(root, "..", "outside.txt") } : { command: "fake-command" };
    try {
      const result = await hook(h.options, tool, input, controller.signal);
      if (result.hookSpecificOutput?.permissionDecision !== "deny") executions++;
      assert.equal(asks, 1, "the real hook calls the app approval boundary");
      assert.equal(executions, 0, "a refused hook must prevent execution even if canUseTool is skipped");
      const decision = await h.options.canUseTool(tool, input, { signal: controller.signal, toolUseID: "tool" });
      assert.equal(decision.behavior, "deny", "the SDK callback also fails closed");
    } finally { await h.stop(); }
  });
}

test("Claude approval follows tab mode across Bypass while observing SDK event mode", async () => {
  let asks = 0;
  const h = claude("accept", async () => { asks++; return true; });
  try {
    assert.equal((await hook(h.options, "Bash")).hookSpecificOutput?.permissionDecision, "allow");
    assert.equal(asks, 1);
    assert.equal(h.leader.getPermissionMode(), "bypassPermissions", "SDK hook mode is observed when no agent identifier exists");
    await h.leader.setPermissionMode("bypass");
    assert.deepEqual(await hook(h.options, "Bash", {}, undefined, "bypassPermissions"), {});
    assert.equal((await h.options.canUseTool("Bash", {}, {})).behavior, "allow");
    assert.equal(asks, 2, "the SDK callback asks in Bypass as in the base: it only runs for the CLI's own prompts");
    await h.leader.setPermissionMode("accept");
    await hook(h.options, "PowerShell");
    assert.equal(asks, 3);
    assert.equal(h.leader.getPermissionMode(), "bypassPermissions");
  } finally { await h.stop(); }
});

test("Accept keeps local edits automatic while outside edits and unknown tools require approval", async () => {
  let asks = 0;
  const h = claude("accept", async () => { asks++; return false; });
  try {
    const local = { file_path: join(root, "new.txt") };
    assert.deepEqual(await hook(h.options, "Write", local), {});
    assert.equal(asks, 0, "the hook decides an inside-folder Write without a card");
    assert.equal((await h.options.canUseTool("Write", local, {})).behavior, "deny", "the SDK callback is the CLI's own prompt and asks");
    assert.equal(asks, 1);
    for (const [tool, input] of [["Write", { file_path: join(root, "..", "outside.txt") }], ["mcp__shell__run", { command: "fake" }], ["Glob", { pattern: "../outside/*" }], ["Glob", { pattern: join(root, "absolute", "*") }]] as const) {
      assert.equal((await hook(h.options, tool, input)).hookSpecificOutput?.permissionDecision, "deny");
    }
    assert.equal(asks, 5);
  } finally { await h.stop(); }
});

test("Ask and held Plan after ExitPlanMode honor approval", async () => {
  for (const mode of ["ask", "plan"] as const) {
    let asks = 0;
    const h = claude(mode, async () => { asks++; return true; });
    try {
      for (const tool of ["Bash", "Write"]) {
        const decision = (await hook(h.options, tool, { file_path: join(root, "file") })).hookSpecificOutput?.permissionDecision;
        assert.equal(decision, "allow");
        assert.equal((await h.options.canUseTool(tool, {}, {})).behavior, "allow");
      }
      assert.equal(asks, 4, "held Plan after exit asks and honors approval");
    } finally { await h.stop(); }
  }
});

test("Claude question callback refuses without a card while the Plan hook preserves base behavior", async () => {
  for (const mode of ["ask", "accept", "plan", "bypass"] as const) {
    let asks = 0;
    const h = claude(mode, async () => { asks++; return true; });
    try {
      const result = await hook(h.options, "AskUserQuestion");
      if (mode === "plan") assert.deepEqual(result, {}, "base Plan hook leaves non-mutating tools to the CLI");
      else assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
      assert.equal((await h.options.canUseTool("AskUserQuestion", {}, {})).behavior, "deny");
      assert.equal(asks, 0);
    } finally { await h.stop(); }
  }
});

test("Claude failed result and thrown SDK error expose only plain errors, with private bounded diagnostics", async (t) => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  for (const throws of [false, true]) {
    const errors: string[] = [];
    let ended!: () => void;
    const done = new Promise<void>((ok) => { ended = ok; });
    const h = createLeader(seat, root, null, { onDelta() {}, onUsage() {}, onDone() {}, onError(message) { errors.push(message); ended(); } },
      undefined, "accept", undefined, (() => ({
        async *[Symbol.asyncIterator]() {
          if (throws) throw new Error("POST /session/ses_private/message permission_private credential-body");
          yield { type: "result", is_error: true, subtype: "error_during_execution" };
        }, return: async () => ({ done: true }),
      })) as any);
    await done;
    h.stop();
    assert.ok(errors.length > 0);
    for (const message of errors) {
      assert.match(message, /Claude/);
      assert.doesNotMatch(message, /error_during_execution|POST|ses_private|permission_private|credential-body/);
    }
  }
  assert.ok(diagnostics.length > 0, "failure diagnostics stay in the private server log");
  assert.ok(JSON.stringify(diagnostics).length < 2000);
  assert.doesNotMatch(JSON.stringify(diagnostics), /credential-body/);
});

for (const failure of ["prompt", "permission", "unreadable"]) test(`OpenCode ${failure} failure hides routes, ids and response bodies from callbacks and private logs`, async (t) => {
  const errors: string[] = [], diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  let complete!: () => void;
  const done = new Promise<void>((ok) => { complete = ok; });
  let controller!: ReadableStreamDefaultController;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/event") return new Response(stream);
    if (path === "/mcp") return Response.json({ "tab-crew": { status: "connected" } });
    if (path === "/session") return Response.json({ id: "ses_private" });
    if (path.endsWith("/prompt_async")) {
      if (failure === "permission") {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_private", id: "permission_private", permission: "bash", patterns: ["fake command"] } })}\n\n`));
        return new Response(null, { status: 204 });
      }
      if (failure === "unreadable") return new Response("credential-body unreadable JSON");
      return Response.json({ message: "POST /session/ses_private/message permission_private credential-body" }, { status: 500 });
    }
    if (path.includes("/permission/")) return Response.json({ message: "permission_private credential-body" }, { status: 500 });
    return Response.json({});
  });
  const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: { resume() {} }, exitCode: 0, signalCode: null });
  const h = createOpencodeLeader({ model: "fake/model", effort: "medium" }, root,
    { onDelta() {}, onUsage() {}, onDone() {}, onError(message) { errors.push(message); complete(); } },
    { mode: "accept", ask: async () => false, bridge: { url: "http://fake", token: "fake-token" }, pickPort: async () => 1234, spawnFn: () => child });
  try {
    h.send("test", []);
    await done;
    assert.deepEqual(errors, ["OpenCode could not finish this turn. Try again."]);
    assert.ok(diagnostics.some((row: any) => row[1]?.reason === (failure === "permission" ? "permission-reply" : "prompt")), "the diagnostic identifies the failed operation");
    assert.ok(diagnostics.some((row: any) => row[1]?.kind === "Error"), "thrown errors retain only their class");
    assert.ok(JSON.stringify(diagnostics).length < 2000);
    assert.doesNotMatch(JSON.stringify(diagnostics), /ses_private|permission_private|credential-body|fake-token/);
  } finally { h.stop(); controller.close(); }
});

test("Claude failed SDK turn saves only the plain message through the real server", { timeout: 60000 }, async () => {
  const { withServer, CLAUDE_LEADER, TAB } = await import("./any-cli-helpers.ts");
  await withServer({ leader: CLAUDE_LEADER, env: { CC_TEST_FAKE_LEADER: "1" } }, async (h) => {
    const start = h.chat(JSON.stringify([{ failTurn: true }]));
    await h.wait(() => h.turnEnded(start).length === 1, "failed SDK turn");
    const message = h.turnEnded(start)[0].message;
    assert.equal(message, "The Claude leader turn failed. Try again.");
    assert.doesNotMatch(JSON.stringify(h.tab()), /error_during_execution/);
    const saved = readFileSync(join(h.temp, "data", "chats", `${TAB}.jsonl`), "utf8");
    assert.doesNotMatch(saved, /error_during_execution/);
    assert.ok(saved.includes(message), "the real chat store saved the same plain error");
  });
});
