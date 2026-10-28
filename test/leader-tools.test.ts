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
