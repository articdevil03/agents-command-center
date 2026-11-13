// The leader's tool layer for a fixed crew: the SDK/JSON shape, the argument schemas and the awaited handlers.
// The tools themselves are the explicit fixed specs (never the retired four legacy tools); the real ones come from fixedLeaderSpecs.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildLeaderToolDefs, buildLeaderToolSpecs, createLeaderTools, leaderToolJsonSchema, runLeaderTool, LAUNCH_BRIEF_MAX_CHARS, type LeaderToolSpec } from "../server/leader-tools.ts";
import { importWithTempDataRoot } from "./temp-root.ts";

const { modules: { tools } } = await importWithTempDataRoot(async () => ({ tools: await import("../server/main/fixed-task-tools.ts") }));
const FIXED_NAMES = ["finish_fixed_task", "list_task_archives", "get_task_archive", "get_fixed_task", "reconcile_task_execution", "begin_planning", "accept_planner_report", "request_task_action", "verify_task_evidence"];
const LEGACY_NAMES = ["get_crew_status", "launch_seat", "send_request", "list_requests", "advance_step", "report_round", "finish_fix", "wait_for_runs"];
const realSpecs = () => tools.fixedLeaderSpecs("fixed", {});
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
// Explicit fixed specs for a fixture: the only dependency the tool layer takes.
const deps = (specs: LeaderToolSpec[]) => ({ fixedSpecs: () => specs, tabName: "Development" });
const find = (specs: { name: string }[], name: string) => { const found = specs.find((item) => item.name === name); assert.ok(found, `tool "${name}" not found`); return found!; };

test("fixed leader tools are exactly the nine fixed tools, served by name through the SDK defs and the allowed-tool names, and none of the retired tools", () => {
  const specs = buildLeaderToolSpecs(deps(realSpecs()) as any);
  assert.deepEqual(specs.map((item) => item.name), FIXED_NAMES);
  assert.deepEqual(buildLeaderToolDefs(deps(realSpecs()) as any).map((item) => item.name), FIXED_NAMES);
  assert.deepEqual(specs.map((item) => `mcp__tab-crew__${item.name}`), FIXED_NAMES.map((name) => `mcp__tab-crew__${name}`));
  for (const name of LEGACY_NAMES) assert.equal(specs.some((item) => item.name === name), false, `${name} is retired`);
});

test("supplied fixed specs are returned as they are, and without them nothing is built", () => {
  const supplied = [{ name: "get_fixed_task", description: "d", shape: {}, handler: async () => ok("{}") }];
  const built = buildLeaderToolSpecs(deps(supplied));
  assert.deepEqual(built.map((item) => item.name), ["get_fixed_task"]);
  assert.equal(built[0], supplied[0], "the very spec that was supplied");
  // The retired generated tools are gone: a tool layer with no supplied specs refuses instead of inventing the old four.
  assert.throws(() => buildLeaderToolSpecs({ tabName: "Development" } as any), /fixedSpecs is required/);
  assert.throws(() => buildLeaderToolDefs({} as any), /fixedSpecs is required/);
});

test("createLeaderTools builds the SDK MCP server named tab-crew from the supplied fixed specs", () => {
  const server = createLeaderTools(deps(realSpecs()) as any);
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "tab-crew");
  assert.ok(server.instance, "an SDK server instance was built");
});

test("fixed tool argument schemas hold through the real validation: the brief cap, the action kinds and the required task identity", async () => {
  const specs = realSpecs();
  const expected = { taskId: "t", planVersion: 1, recordRevision: 1 };
  // At the cap the arguments are valid, so the call reaches the handler, which refuses this instance as not the current leader.
  const atCap = await runLeaderTool(specs, "begin_planning", { expected: null, brief: "x".repeat(LAUNCH_BRIEF_MAX_CHARS) });
  assert.equal(atCap.isError, true);
  assert.match(atCap.text, /^begin_planning failed: Only the current leader/, "valid arguments reached the handler");
  const over = await runLeaderTool(specs, "begin_planning", { expected: null, brief: "x".repeat(LAUNCH_BRIEF_MAX_CHARS + 1) });
  assert.equal(over.isError, true);
  assert.match(over.text, /^invalid arguments for begin_planning: brief:/);
  assert.match((await runLeaderTool(specs, "begin_planning", { expected: null, brief: "" })).text, /^invalid arguments for begin_planning: brief:/);
  assert.match((await runLeaderTool(specs, "begin_planning", { brief: "work" })).text, /^invalid arguments for begin_planning: expected:/, "the task identity is required, even as null");
  assert.match((await runLeaderTool(specs, "begin_planning", { expected: { taskId: "t", planVersion: 0, recordRevision: 1 }, brief: "work" })).text, /^invalid arguments for begin_planning: expected/, "a plan version is positive");
  assert.match((await runLeaderTool(specs, "request_task_action", { expected, kind: "launch_anything", brief: "work" })).text, /^invalid arguments for request_task_action: kind:/);
  assert.match((await runLeaderTool(specs, "request_task_action", { expected, kind: "build", route: "sideways", brief: "work" })).text, /^invalid arguments for request_task_action: route:/);
  assert.match((await runLeaderTool(specs, "request_task_action", { expected, kind: "build", brief: "work" })).text, /^request_task_action failed: Only the current leader/, "a valid action reaches the handler");
  assert.match((await runLeaderTool(specs, "verify_task_evidence", { expected })).text, /^invalid arguments for verify_task_evidence: runId:/);
  assert.match((await runLeaderTool(specs, "accept_planner_report", { expected })).text, /^invalid arguments for accept_planner_report: runId:/);
});

test("fixed tool JSON schemas keep their required fields and the brief cap", () => {
  const schema = (name: string) => leaderToolJsonSchema(find(realSpecs(), name) as LeaderToolSpec) as any;
  assert.deepEqual(schema("get_fixed_task").properties, {});
  assert.deepEqual([...schema("begin_planning").required].sort(), ["brief", "expected"]);
  assert.equal(schema("begin_planning").properties.brief.maxLength, LAUNCH_BRIEF_MAX_CHARS);
  for (const name of ["expected", "kind", "brief"]) assert.ok(schema("request_task_action").required.includes(name), `${name} is required`);
  assert.ok(schema("request_task_action").properties.kind.enum.includes("build"));
});

// The awaited handlers. runLeaderTool is the one place the Codex, OpenCode and ACP routes await a handler; the SDK route hands the same handler to the SDK.
const asyncSpecs = (): LeaderToolSpec[] => [
  { name: "slow_ok", description: "answers later", shape: { value: z.string() }, handler: async ({ value }) => { await new Promise((resolve) => setTimeout(resolve, 5)); return ok(`got ${value}`); } },
  { name: "slow_refused", description: "an error result", shape: {}, handler: async () => ({ content: [{ type: "text" as const, text: "refused: busy" }], isError: true as const }) },
  { name: "slow_throws", description: "rejects", shape: {}, handler: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("the launch failed"); } },
];

test("fixed tool handlers are awaited: an asynchronous answer, an error result and a rejection each come back as the tool's own result", async () => {
  const specs = buildLeaderToolSpecs(deps(asyncSpecs()));
  const answered = await runLeaderTool(specs, "slow_ok", { value: "yes" });
  assert.deepEqual(answered, { text: "got yes", isError: false }, "the resolved content, never a pending promise");
  assert.deepEqual(await runLeaderTool(specs, "slow_refused", {}), { text: "refused: busy", isError: true });
  assert.deepEqual(await runLeaderTool(specs, "slow_throws", {}), { text: "slow_throws failed: the launch failed", isError: true });
  assert.deepEqual(await runLeaderTool(specs, "no_such_tool", {}), { text: "unknown tool: no_such_tool", isError: true });
  const invalid = await runLeaderTool(specs, "slow_ok", { value: 7 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /^invalid arguments for slow_ok: value:/, "a bad argument is refused before the handler runs");
});

test("the SDK defs carry each fixed spec's name, description and awaited handler", async () => {
  const defs = buildLeaderToolDefs(deps(asyncSpecs()));
  assert.deepEqual(defs.map((item) => [item.name, item.description]), asyncSpecs().map((item) => [item.name, item.description]));
  const slow = find(defs, "slow_ok") as any;
  assert.deepEqual(await slow.handler({ value: "sdk" }, {}), ok("got sdk"));
  assert.equal(((await (find(defs, "slow_refused") as any).handler({}, {})) as any).isError, true);
  await assert.rejects((find(defs, "slow_throws") as any).handler({}, {}), /the launch failed/, "the SDK route sees the rejection, never a pending promise");
});
