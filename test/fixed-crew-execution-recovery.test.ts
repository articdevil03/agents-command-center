import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./temp-root.ts";
import { fixedServer, modules, assignment, fixedTab } from "./fixed-crew-execution-helpers.ts";

test("FCXR unknown descendant evidence retains the execution slot and cannot accept a successful report", () => {
  const root = scratchDir(), tab = fixedTab(root);
  modules.state.setDataRoot(root); modules.state.setWorkspaces({ projects: [{ id: "p", name: "P", folder: root, tabs: [tab] }] });
  const execution: any = { id: "run", tabId: "fixed", taskId: null, planVersion: 0, role: "planner", selectedSlot: "planner", selectionReason: "Assigned", assignment,
    kind: "planning", status: "running", processEnded: false, consumed: false, logPath: null };
  modules.journal.saveJournal(root, "fixed", { version: 1, activeExecutionId: "run", executions: [execution] });
  modules.journal.recordTreeEnd(root, "fixed", "run", false);
  assert.throws(() => modules.fixed.assertHeavySlotFree(), /previous process tree has not been confirmed ended/);
  modules.journal.recordTreeEnd(root, "fixed", "run", true);
  const saved = modules.journal.executionJournal(root, "fixed");
  assert.equal(saved.executions[0].processEnded, true, "the confirmed-tree setter is required to release execution");
  assert.equal(saved.activeExecutionId, null);
  assert.doesNotThrow(() => modules.fixed.assertHeavySlotFree());
});

test("FCXR restart interrupts a reservation and never replays a writer automatically", async () => {
  const root = scratchDir(), tab = fixedTab(root);
  const journal: any = { version: 1, activeExecutionId: "old", executions: [{ id: "old", tabId: "fixed", taskId: null, planVersion: 0, role: "coder", selectedSlot: "coder", selectionReason: "Assigned", assignment,
    kind: "build", status: "running", processEnded: false, consumed: false, logPath: null }] };
  const { mkdirSync } = await import("node:fs"); mkdirSync(join(root, "executions")); writeFileSync(join(root, "executions", "fixed.json"), JSON.stringify(journal));
  const read = modules.journal.executionJournal(root, "fixed");
  assert.equal(read.executions[0].status, "interrupted");
  assert.equal(read.activeExecutionId, "old"); assert.equal(read.executions[0].processEnded, false);
  assert.equal(JSON.parse(readFileSync(join(root, "executions", "fixed.json"), "utf8")).executions[0].status, "interrupted");
  assert.equal(tab.crew.length, 0);
});

test("FCXR a changed leader assignment applies on the next reply, and a manual request never directly launches a writer", { timeout: 90_000 }, async () => {
  const f = await fixedServer();
  try {
    assert.equal((await f.tool("get_fixed_task")).ok, true);
    assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    const log = () => readFileSync(join(f.server.temp, "fake-leader.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const beforeTurns = log().filter((entry) => entry.method === "turn/start").length;
    const reply = f.c.chat("fixed", JSON.stringify([{ sleep: 600 }, { say: "starting assignment retained" }]));
    await f.c.wait(() => log().filter((entry) => entry.method === "turn/start").length > beforeTurns, "reply started with original assignment");
    assert.deepEqual(await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "leader", assignment: { ...assignment, effort: "high" } }), { ok: true });
    assert.match(await reply, /starting assignment retained/);
    const active = log().filter((entry) => entry.method === "turn/start").at(-1);
    assert.equal(active.params.effort, "medium", "the active reply keeps its starting assignment");
    assert.equal((await f.tool("get_fixed_task")).ok, true);
    const next = log().filter((entry) => entry.method === "turn/start").at(-1);
    assert.equal(next.params.effort, "high", "the next reply applies the saved assignment");
    const starts = f.c.tab("fixed").runs.length;
    const from = f.c.messages.length;
    f.c.send({ type: "run", tabId: "fixed", slot: "coder", prompt: "build" });
    await f.c.wait(() => f.c.messages.slice(from).find((m) => m.type === "fixedRunRequested"), "manual request acknowledged");
    await f.c.wait(() => f.c.messages.slice(from).find((m) => m.type === "chatDone"), "leader answered request");
    assert.equal(f.c.tab("fixed").runs.length, starts, "manual Run is leader intent, never an unrestricted client writer");
  } finally { await f.close(); }
});

test("FCXR replacement assignment requires a new Planner snapshot and invalidates owner approval", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve();
    assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    assert.deepEqual(await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "coder", assignment: { ...assignment, effort: "high" } }), { ok: true });
    assert.match((await f.action("build")).text, /assignment changed/);
    await f.planning();
    assert.equal(f.task().planVersion, 2);
    assert.equal(f.task().seats.coder.effort, "high");
    assert.equal(f.task().ownerScopeApproval, null, "replacement assignments invalidate the old approval");
    assert.equal((await f.action("build")).ok, false);
    await f.approve(); f.worker({});
    const built = await f.action("build"); assert.equal(built.ok, true, built.text); assert.equal(built.value.assignment.effort, "high");
    await f.ended(built.value.runId);
  } finally { await f.close(); }
});
