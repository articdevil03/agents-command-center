import test from "node:test";
import assert from "node:assert/strict";
import { buildLeaderToolDefs, createLeaderTools, LEADER_ALLOWED_TOOLS } from "../server/leader-tools.ts";

function seat(slot: string, over = {}) {
  return { slot, seatKey: `alpha-development.${slot}`, name: slot, cli: "codex", model: "gpt-6-sol", effort: "high", isLeader: slot === "leader", ...over };
}

function deps(over = {}) {
  return {
    tabName: "Development",
    crew: () => [seat("coder"), seat("reviewer1")],
    statusOf: () => "idle",
    launch: () => ({ ok: true }),
    ...over,
  };
}

function findTool(defs, name) {
  const found = defs.find((item) => item.name === name);
  assert.ok(found, `tool "${name}" not found`);
  return found;
}

test("leader tools register only the tab-scoped crew and launch tools", () => {
  const defs = buildLeaderToolDefs(deps());
  assert.deepEqual(LEADER_ALLOWED_TOOLS, defs.map((item) => `mcp__tab-crew__${item.name}`));
});

test("get_crew_status reads current settings and status for this tab only", async () => {
  let model = "gpt-6-sol", status = "idle";
  const d = deps({ crew: () => [seat("coder", { model })], statusOf: () => status });
  const { handler } = findTool(buildLeaderToolDefs(d), "get_crew_status");
  const before = JSON.parse((await handler({}, {})).content[0].text);
  assert.equal(before.tab, "Development");
  assert.equal(before.crew[0].model, "gpt-6-sol");
  assert.equal(before.crew[0].status, "idle");
  model = "gpt-6-astra";
  status = "working";
  const after = JSON.parse((await handler({}, {})).content[0].text);
  assert.equal(after.crew[0].model, "gpt-6-astra");
  assert.equal(after.crew[0].status, "working");
});

test("get_crew_status includes the leader but marks it non-runnable", async () => {
  const d = deps({ crew: () => [seat("coder"), seat("leader")] });
  const result = JSON.parse((await findTool(buildLeaderToolDefs(d), "get_crew_status").handler({}, {})).content[0].text);
  assert.deepEqual(result.crew.map((item) => item.slot), ["coder", "leader"]);
  assert.equal(result.crew[0].runnable, true);
  assert.equal(result.crew[1].runnable, false);
  assert.equal(result.crew.every((item) => item.seatKey.startsWith("alpha-development.")), true);
});

test("launch_seat delegates a slot and brief and reports the tab-scoped key", async () => {
  const calls = [];
  const d = deps({ launch: (slot, brief) => { calls.push({ slot, brief }); return { ok: true }; } });
  const { handler } = findTool(buildLeaderToolDefs(d), "launch_seat");
  const result = await handler({ slot: "coder", brief: "fix the thing" }, {});
  assert.deepEqual(calls, [{ slot: "coder", brief: "fix the thing" }]);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /launched "alpha-development\.coder"/);
});

test("launch_seat reports a real launch refusal", async () => {
  const d = deps({ launch: () => ({ ok: false, error: "tab is busy" }) });
  const result = await findTool(buildLeaderToolDefs(d), "launch_seat").handler({ slot: "coder", brief: "x" }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tab is busy/);
});

test("launch_seat notes when slot settings changed after the last status check", async () => {
  let model = "gpt-6-sol";
  const d = deps({ crew: () => [seat("coder", { model })] });
  const defs = buildLeaderToolDefs(d);
  await findTool(defs, "get_crew_status").handler({}, {});
  model = "gpt-6-astra";
  const result = await findTool(defs, "launch_seat").handler({ slot: "coder", brief: "work" }, {});
  assert.match(result.content[0].text, /settings changed since the last status check/);
  assert.match(result.content[0].text, /gpt-6-astra/);
});

test("launch_seat has no stale-settings note before a status check", async () => {
  const result = await findTool(buildLeaderToolDefs(deps()), "launch_seat").handler({ slot: "coder", brief: "work" }, {});
  assert.equal(result.content[0].text, 'launched "alpha-development.coder"');
});

test("send_request can only name a destination and delegates the current tab scope", async () => {
  const calls = [];
  const d = deps({ sendRequest: (toTabId, title, body) => {
    calls.push({ fromTabId: "alpha-development", toTabId, title, body });
    return { ok: true, requestId: "server_request_1", request: { id: "row-1", fromTabId: "alpha-development", toTabId, title, body, status: "pending", createdAt: 1 } };
  } });
  const result = await findTool(buildLeaderToolDefs(d), "send_request").handler({ toTabId: "beta-development", title: "Review", body: "Look at this." }, {});
  assert.deepEqual(calls, [{ fromTabId: "alpha-development", toTabId: "beta-development", title: "Review", body: "Look at this." }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    requestId: "server_request_1",
    request: { id: "row-1", fromTabId: "alpha-development", toTabId: "beta-development", title: "Review", body: "Look at this.", status: "pending", createdAt: 1 },
  });
});

test("send_request reports validation refusals and list_requests returns only its injected tab scope", async () => {
  const incoming = [{ id: "row-2", fromTabId: "beta-development", toTabId: "alpha-development", title: "For alpha", body: "Only alpha should see this.", status: "pending", createdAt: 2 }];
  const d = deps({
    sendRequest: () => ({ ok: false, error: "destination does not exist" }),
    listRequests: () => incoming,
  });
  const send = await findTool(buildLeaderToolDefs(d), "send_request").handler({ toTabId: "missing-development", title: "x", body: "y" }, {});
  assert.equal(send.isError, true);
  assert.match(send.content[0].text, /destination does not exist/);
  const listed = JSON.parse((await findTool(buildLeaderToolDefs(d), "list_requests").handler({}, {})).content[0].text);
  assert.equal(listed.tab, "Development");
  assert.deepEqual(listed.requests, incoming);
});

test("createLeaderTools builds the SDK MCP server named tab-crew", () => {
  const server = createLeaderTools(deps());
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "tab-crew");
});

test("launch_seat waits for an asynchronous launch and reports a denial as an error", async () => {
  const { handler } = findTool(buildLeaderToolDefs(deps({ launch: async () => ({ ok: false, error: "The user denied this." }) })), "launch_seat");
  const denied = await handler({ slot: "coder", brief: "work" }, {});
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /The user denied this\./);
  const { handler: allowedHandler } = findTool(buildLeaderToolDefs(deps({ launch: async () => ({ ok: true }) })), "launch_seat");
  const allowed = await allowedHandler({ slot: "coder", brief: "work" }, {});
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.content[0].text, /launched/);
});

// A brief goes to a file, so it may be long; one without an end would ride in every state message as a launch notice.
test("launch_seat refuses a brief over the cap through the real argument validation, and still takes one at the cap", async () => {
  const { buildLeaderToolSpecs, runLeaderTool, LAUNCH_BRIEF_MAX_CHARS } = await import("../server/leader-tools.ts");
  const calls: string[] = [];
  const specs = buildLeaderToolSpecs(deps({ launch: (_slot: string, brief: string) => { calls.push(brief); return { ok: true }; } }) as any);
  const atCap = await runLeaderTool(specs, "launch_seat", { slot: "coder", brief: "x".repeat(LAUNCH_BRIEF_MAX_CHARS) });
  assert.equal(atCap.isError, false);
  assert.equal(calls.length, 1);
  const over = await runLeaderTool(specs, "launch_seat", { slot: "coder", brief: "x".repeat(LAUNCH_BRIEF_MAX_CHARS + 1) });
  assert.equal(over.isError, true);
  assert.match(over.text, /invalid arguments for launch_seat: brief:/);
  assert.equal(calls.length, 1, "nothing was launched");
});

test("get_crew_status names each seat's role, advisor, write permission and whether it runs the process, and lists the steps with their owners", async () => {
  const steps = [
    { id: "brief", label: "Brief", type: "work", owners: ["planner"] },
    { id: "review", label: "Review", type: "rounds", pairs: [{ reviewer: "reviewer1", fixers: ["coder"] }] },
  ];
  const d = deps({
    crew: () => [seat("planner", { role: "Planner", cli: "claude", advisor: "claude-fable-5-1", canWrite: false, orchestrates: true }), seat("coder", { role: "Coder", canWrite: true })],
    steps: () => steps,
  });
  const status = JSON.parse((await findTool(buildLeaderToolDefs(d), "get_crew_status").handler({}, {})).content[0].text);
  assert.deepEqual(status.crew.map((item: any) => [item.slot, item.role, item.advisor, item.canWrite, item.orchestrates]), [["planner", "Planner", "claude-fable-5-1", false, true], ["coder", "Coder", null, true, false]]);
  assert.deepEqual(status.steps, steps);
  const description = findTool(buildLeaderToolDefs(d), "get_crew_status").description;
  assert.match(description, /Each step names its owner seat; hand a step's work to its owner/);
  const none = JSON.parse((await findTool(buildLeaderToolDefs(deps()), "get_crew_status").handler({}, {})).content[0].text);
  assert.deepEqual(none.steps, [], "a caller with no steps gets an empty list, never a crash");
});

test("runnable depends on who asks: never yourself, never the leader, and only the one seat a talk-only leader may launch", async () => {
  const crewOf = () => [seat("leader"), seat("planner"), seat("coder")];
  const slots = async (over: object) => JSON.parse((await findTool(buildLeaderToolDefs(deps({ crew: crewOf, ...over })), "get_crew_status").handler({}, {})).content[0].text).crew.filter((item: any) => item.runnable).map((item: any) => item.slot);
  assert.deepEqual(await slots({}), ["planner", "coder"], "the leader's view");
  assert.deepEqual(await slots({ callerSlot: "planner" }), ["coder"], "a seat is not runnable by itself");
  assert.deepEqual(await slots({ onlyLaunchable: () => "planner" }), ["planner"], "a leader beside a planner that runs the process");
  assert.deepEqual(await slots({ onlyLaunchable: () => undefined }), ["planner", "coder"]);
  assert.deepEqual(await slots({ callerSlot: "planner", leaderTakesJobs: true }), ["leader", "coder"], "the seat that runs the process may hand a job to the leader");
});

test("get_crew_status carries where the process stands, and launch_seat names the run it started", async () => {
  const view = { stepId: "build", stepLabel: "Build", stepType: "work", phase: "review", round: 1, look: "not reached", orchestrator: "planner" };
  const d = deps({ processView: () => view, launch: () => ({ ok: true, runId: "run-123" }) });
  const status = JSON.parse((await findTool(buildLeaderToolDefs(d), "get_crew_status").handler({}, {})).content[0].text);
  assert.deepEqual(status.process, view);
  assert.equal(JSON.parse((await findTool(buildLeaderToolDefs(deps()), "get_crew_status").handler({}, {})).content[0].text).process, null);
  const launched = await findTool(buildLeaderToolDefs(d), "launch_seat").handler({ slot: "coder", brief: "x" }, {});
  assert.equal(launched.content[0].text, 'launched "alpha-development.coder" as run run-123');
});

test("the step tools and wait_for_runs exist only when the server hands them in, and keep their caps", async () => {
  const { buildLeaderToolSpecs, runLeaderTool, WAIT_MAX_RUNS, WAIT_MAX_SECONDS } = await import("../server/leader-tools.ts");
  const names = (over: object) => buildLeaderToolSpecs(deps(over) as any).map((item) => item.name);
  assert.deepEqual(names({}), ["get_crew_status", "launch_seat", "send_request", "list_requests"], "the leader's four");
  const bar = [{ stepId: "build", label: "Build", type: "work", state: "current", owners: ["coder"] }];
  const calls: unknown[] = [];
  const stepOps = {
    advance: (id: string) => { calls.push(["advance", id]); return { changed: false, reason: "Ann still has a run working on Build", stepBar: bar }; },
    reportRound: (round: number, outcome: string) => { calls.push(["report", round, outcome]); return { changed: true, stepBar: bar }; },
    finishFix: (round: number) => { calls.push(["fix", round]); return { changed: true, stepBar: bar }; },
  };
  const waited: unknown[] = [];
  const waitForRuns = async (runIds: string[], seconds: number) => { waited.push([runIds, seconds]); return runIds.map((runId) => ({ runId, seatKey: "k", status: "done", outcome: "done", logPath: "p", tail: "" })); };
  assert.deepEqual(names({ stepOps }), ["get_crew_status", "launch_seat", "send_request", "list_requests", "advance_step", "report_round", "finish_fix"]);
  assert.deepEqual(names({ waitForRuns }), ["get_crew_status", "launch_seat", "send_request", "list_requests", "wait_for_runs"]);
  const specs = buildLeaderToolSpecs(deps({ stepOps, waitForRuns }) as any);
  const refused = await runLeaderTool(specs, "advance_step", { fromStepId: "build" });
  assert.equal(refused.isError, true, "nothing changed is an error result");
  assert.deepEqual(JSON.parse(refused.text), { changed: false, reason: "Ann still has a run working on Build", stepBar: bar });
  assert.equal((await runLeaderTool(specs, "report_round", { round: 2, outcome: "findings" })).isError, false);
  assert.equal((await runLeaderTool(specs, "report_round", { round: 2, outcome: "maybe" })).isError, true, "only findings or clean");
  assert.equal((await runLeaderTool(specs, "finish_fix", { round: 2 })).isError, false);
  assert.deepEqual(calls, [["advance", "build"], ["report", 2, "findings"], ["fix", 2]]);
  const ok = await runLeaderTool(specs, "wait_for_runs", { runIds: ["a", "b"] });
  assert.equal(JSON.parse(ok.text).allEnded, true);
  assert.deepEqual(waited, [[["a", "b"], 60]], "the default wait is a minute");
  assert.equal((await runLeaderTool(specs, "wait_for_runs", { runIds: Array.from({ length: WAIT_MAX_RUNS + 1 }, (_, i) => `r${i}`) })).isError, true, "at most eight runs");
  assert.equal((await runLeaderTool(specs, "wait_for_runs", { runIds: ["a"], maxWaitSeconds: WAIT_MAX_SECONDS + 1 })).isError, true, "at most 120 seconds");
  assert.equal(waited.length, 1, "a refused call never waited");
});
