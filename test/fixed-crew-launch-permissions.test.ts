import test from "node:test";
import assert from "node:assert/strict";
import { installReviewDependencies } from "./pack26-review1-helpers.ts";
installReviewDependencies();
import { loadFixed, connect, ASSIST, tick, endRun, setAssignment } from "./round2-helpers.ts";

// These actors and tools are captured from the real fixed leader session.
async function fixture() {
  let sdk: any;
  const server = await loadFixed({ skipHealth: true, sdkLeader: ({ options }: any) => {
    sdk = options;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, async return() { return { done: true }; }, async setModel() {}, async setPermissionMode() {} };
  } });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  const actor = server.currentActor("alpha-dev");
  const specs = server.leaderDeps.get("Development").fixedSpecs();
  const tool = specs.find((spec: any) => spec.name === "request_task_action");
  const launch = () => tool.handler({ expected: null, ...ASSIST, brief: "permission launch" });
  const observe = (mode: string) => sdk.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: mode,
    tool_name: "mcp__tab-crew__request_task_action", tool_input: {} }, "id", { signal: new AbortController().signal });
  const pending = () => [...server.pendingApprovals.values()];
  const answer = (allow: boolean) => ws.message({ type: "answerApproval", requestId: "permission_answer", tabId: "alpha-dev", approvalId: pending()[0].approvalId, allow });
  const idle = () => {
    assert.equal(server.launched.length, 0, "the gate starts no process");
    assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "the gate reserves no execution");
  };
  const close = async () => {
    for (const entry of server.launched) await endRun(server, entry.run.runId);
    server.stopLeaderSession("alpha-dev");
  };
  return { server, ws, actor, launch, observe, pending, answer, idle, close };
}

for (const mode of ["saved Ask", "live default"]) test(`FCP ${mode} waits for Allow through the fixed tool call site`, async () => {
  const f = await fixture();
  try {
    if (mode === "saved Ask") f.server.settingsService.state.permissionModes["alpha-dev"] = "ask";
    else await f.observe("default");
    const waiting = f.launch(); waiting.catch(() => {});
    await tick();
    assert.equal(f.pending().length, 1, `${mode} must ask before starting`);
    f.idle();
    f.answer(true);
    const result = JSON.parse((await waiting).content[0].text);
    assert.equal(f.server.launched.length, 1, "the fixed tool delegates to the actual worker launch");
    assert.equal(result.runId, f.server.launched[0].run.runId);
    const journal = f.server.executionJournal(f.server.testRoot, "alpha-dev");
    assert.equal(journal.activeExecutionId, result.runId, "the real fixed reservation owns the run");
    assert.equal(journal.executions[0].status, "running");
    assert.equal(f.pending().length, 0);
  } finally { await f.close(); }
});

for (const mode of ["saved Plan", "live Plan"]) test(`FCP ${mode} refuses immediately`, async () => {
  const f = await fixture();
  try {
    if (mode === "saved Plan") f.server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    else await f.observe("plan");
    const result = await f.launch().then(() => "launched", (error: Error) => error.message);
    assert.equal(result, "Switch out of Plan mode before starting fixed work.");
    assert.equal(f.pending().length, 0);
    f.idle();
  } finally { await f.close(); }
});

test("FCP Deny starts nothing", async () => {
  const f = await fixture();
  try {
    await f.observe("default");
    const waiting = f.launch(); waiting.catch(() => {});
    await tick(); assert.equal(f.pending().length, 1);
    f.answer(false);
    const result = await waiting.then(() => "launched", (error: Error) => error.message);
    assert.equal(result, "The owner denied this action.");
    f.idle();
  } finally { await f.close(); }
});

test("FCP initial current actor is required before any approval is asked", async () => {
  const f = await fixture();
  try {
    f.server.stopLeaderSession("alpha-dev");
    f.server.createTabLeader("alpha-dev");
    f.server.settingsService.state.permissionModes["alpha-dev"] = "ask";
    const outcome = f.server.launchFixedAction(f.actor, null, ASSIST, "stale actor").then(() => "launched", (error: Error) => error.message);
    const result = await Promise.race([outcome, tick(50).then(() => "still waiting")]);
    assert.equal(result, "The leader instance is no longer current.");
    assert.equal(f.pending().length, 0, "a stale actor never reaches the approval");
    f.idle();
  } finally { await f.close(); }
});

for (const change of ["current actor", "saved Plan", "live Plan", "assignment"]) test(`FCP resume rechecks ${change} after Allow`, async () => {
  const f = await fixture();
  try {
    await f.observe("default");
    const waiting = f.launch(); waiting.catch(() => {});
    await tick(); assert.equal(f.pending().length, 1);
    if (change === "assignment") {
      const result = await setAssignment(f.ws, "alpha-dev", "helper", { cli: "codex", model: "gpt-6.1-sol", effort: "high" });
      assert.equal(result.type, "actionResult");
    }
    f.answer(true);
    if (change === "current actor") {
      f.server.stopLeaderSession("alpha-dev");
      f.server.createTabLeader("alpha-dev");
    } else if (change === "saved Plan") f.server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    else if (change === "live Plan") await f.observe("plan");
    const result = await waiting.then(() => "launched", (error: Error) => error.message);
    assert.equal(result, change === "current actor" ? "The leader instance is no longer current." : "The assignment or permission changed while approving.");
    assert.equal(f.pending().length, 0);
    f.idle();
  } finally { await f.close(); }
});

for (const slot of ["leader", "unknown"]) test(`FCP refuses ${slot} worker position`, async () => {
  const f = await fixture();
  try {
    const result = await f.server.launchFixedAction(f.actor, null, ASSIST, "invalid worker", slot).then(() => "launched", (error: Error) => error.message);
    assert.equal(result, slot === "leader" ? "This position does not own the approved action." : "Unknown crew position.", `${slot} may never become a fixed worker`);
    f.idle();
  } finally { await f.close(); }
});
