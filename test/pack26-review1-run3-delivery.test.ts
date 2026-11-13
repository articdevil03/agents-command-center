import test from "node:test";
import assert from "node:assert/strict";
import { deliveryFixture } from "./pack26-review1-run3-delivery-helpers.ts";
import { STAGES } from "../server/fixed-crew/task-types.ts";
import { saveJournal } from "../server/fixed-crew/task-execution.ts";

for (const stage of STAGES) test(`P26R3D every stage ${stage} request eligibility and cancellation`, async (t) => {
  assert.equal(STAGES.filter((value) => value === stage).length, 1, `stage ${stage} explicitly FOUND`);
  const f = await deliveryFixture(t, stage); f.reject();
  const before = JSON.parse(f.disk()); f.ws.message(f.message);
  const error = await f.wait(); assert.equal(error.tabId, f.tabId); assert.equal(error.action, f.message.type);
  const task = JSON.parse(f.disk());
  assert.equal(task.stage, stage, "cancelRequest preserves the current stage exactly");
  if (stage === "interrupted") {
    assert.deepEqual(task, before, "interrupted requests refuse before reservation");
  } else {
    assert.equal(task.executions.length, 1, "request reserves in every non-interrupted stage");
    assert.equal(task.executions[0].status, "failed", "unconsumed failed delivery cancels its reservation");
    assert.equal(task.executions[0].processEnd, "confirmed");
    assert.deepEqual(task.executions[0].evidence, []); assert.equal(task.executions[0].verified, false);
  }
  assert.equal(f.server.launched.length, 0);
});

test("P26R3D inspected rough approved polish cancellation keeps both approvals and rough revision", async (t) => {
  const f = await deliveryFixture(t, "inspected", true), before = JSON.parse(f.disk()); f.reject();
  f.ws.message(f.message); await f.wait();
  const task = JSON.parse(f.disk());
  assert.equal(task.executions.at(-1).status, "failed"); assert.equal(task.stage, "inspected");
  assert.equal(task.roughRevision, before.roughRevision);
  assert.deepEqual(task.ownerScopeApproval, before.ownerScopeApproval);
  assert.deepEqual(task.ownerRoughApproval, before.ownerRoughApproval);
  assert.deepEqual(task.executions.slice(0, -1), before.executions, "accepted rough evidence survives");
  const bytes = f.disk(), turns = f.server.chats.length;
  f.ws.message(f.message); await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.disk(), bytes, "replay keeps bytes"); assert.equal(f.server.chats.length, turns, "no second delivery");
});

for (const change of ["consumed", "session", "started", "task", "version", "store", "folder", "tab", "newer", "false", "publication"] as const) {
  test(`P26R3D delivery await rechecks ${change}`, async (t) => {
    const f = await deliveryFixture(t, "review"), store = f.server.fixedTasks, apply = store.apply, get = store.get;
    let reservedBytes = "";
    const changeAfterDelivery = () => {
      const task = get(f.tabId), execution = task.executions.at(-1);
      if (change === "consumed") {
        saveJournal(f.data, f.tabId, { version: 1, activeExecutionId: execution.id, executions: [{ id: execution.id, tabId: f.tabId, taskId: task.id, planVersion: task.planVersion,
          kind: "build", role: "coder", selectedSlot: "coder", assignment: task.seats.coder, selectionReason: "Fixture consumed", status: "reserved", processEnded: false, consumed: false, logPath: null }] });
      }
      if (change === "started") apply({ tabId: f.tabId, ...f.expected(), requestId: "start-exact-reservation" }, { type: "start", executionId: execution.id }, store.actor("leader"));
      if (["task", "version"].includes(change)) store.get = (id: string) => {
        const value = get(id);
        if (change === "task") value.id = "replacement-task";
        if (change === "version") value.planVersion++;
        return value;
      };
      if (change === "store") store.run3Install({ ...store });
      if (change === "folder") f.server.tabLocation(f.tabId).tab.folder += "-changed";
      if (change === "tab") {
        const location = f.server.tabLocation(f.tabId);
        const index = location.project.tabs.findIndex((tab: any) => tab.id === f.tabId);
        location.project.tabs[index] = { ...location.tab };
      }
      if (change === "newer") apply({ tabId: f.tabId, ...f.expected(), requestId: "newer-owner-approval" }, { type: "approvePlan" }, store.actor("owner"));
      f.ws.message({ type: "selectTab", tabId: "alpha-design" });
      reservedBytes = f.disk();
    };
    if (change === "false") store.apply = (expected: any, event: any, actor: any) => {
      const result = apply(expected, event, actor);
      if (event.type === "action") { f.server.activeLeaderTurns.add(f.tabId); reservedBytes = f.disk(); }
      return result;
    };
    else if (change === "session") store.apply = (expected: any, event: any, actor: any) => {
      // Change the actual reservation setter, so disk AND the transition's cache carry the foreign session.
      const result = apply(expected, event.type === "action" ? { ...event, sessionId: "different-reservation" } : event, actor);
      if (event.type === "action") reservedBytes = f.disk();
      return result;
    };
    else f.reject(changeAfterDelivery);
    if (change === "publication") store.apply = (expected: any, event: any, actor: any) => {
      if (event.type === "cancelRequest") throw new Error("injected cancellation publication failure");
      return apply(expected, event, actor);
    };
    try {
      f.ws.message(f.message); const error = await f.wait();
      assert.equal(error.requestId, f.message.requestId); assert.equal(error.tabId, f.tabId);
      assert.ok(f.ws.messages.some((m: any) => m.type === "state"), "failure broadcasts state");
      const task = JSON.parse(f.disk());
      if (change === "false" || change === "newer") {
        assert.equal(task.executions.at(-1).status, "failed"); assert.equal(task.stage, "review");
        if (change === "newer") assert.ok(task.requests.some((r: any) => r.id === "newer-owner-approval"));
      } else {
        assert.equal(f.disk(), reservedBytes, "different or consumed reservation stays byte-identical");
        assert.equal(task.executions.at(-1).status, change === "started" ? "running" : "reserved");
      }
      if (change === "publication") assert.match(error.message, /Reservation release failed: injected cancellation publication failure/);
      assert.equal(f.server.launched.length, 0);
    } finally { store.get = get; store.apply = apply; }
  });
}
