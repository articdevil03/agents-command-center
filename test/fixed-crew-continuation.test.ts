import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixedServer, assignment } from "./fixed-crew-execution-helpers.ts";
import { bridgeCall } from "./pack18-orch-harness.ts";

type Fixture = Awaited<ReturnType<typeof fixedServer>>;
const journal = (f: Fixture) => JSON.parse(readFileSync(join(f.server.data, "executions", "fixed.json"), "utf8"));
const children = (f: Fixture) => existsSync(join(f.server.temp, "children.jsonl"))
  ? readFileSync(join(f.server.temp, "children.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
async function httpTools(f: Fixture) {
  await f.tool("get_fixed_task");
  const { token } = await f.control("bridge");
  return async (name: string, args: any) => {
    const response = await bridgeCall(`http://127.0.0.1:${f.server.port}/api/leader-mcp/fcx-test`, token, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200);
    const result = response.body.result;
    const text = result.content[0].text;
    let value: any; try { value = JSON.parse(text); } catch { value = text; }
    return { ok: !result.isError, text, value };
  };
}

test("FCXC clearing an executed role preserves historical snapshots through replanning and cold restart", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve(); f.worker({});
    const build = await f.action("build"); assert.equal(build.ok, true, build.text);
    await f.ended(build.value.runId); assert.equal((await f.verify(build.value.runId)).ok, true);
    const before = f.task().executions;
    assert.equal((await f.c.request({ type: "clearCrewAssignment", tabId: "fixed", slot: "coder" })).ok, true);
    await f.planning();
    assert.deepEqual(f.task().seats.coder, assignment, "the historical executed role remains valid");
    assert.deepEqual(f.task().executions, before, "replanning must preserve every historical execution");
    const refused = await f.action("build"); assert.equal(refused.ok, false);
    assert.equal(refused.text, "request_task_action failed: Coder has no model. Choose one in Settings before continuing.");
    const pids = await f.restart(); assert.notEqual(pids.oldPid, pids.newPid);
    const read = await f.tool("get_fixed_task"); assert.equal(read.ok, true, read.text);
    assert.deepEqual(read.value.task.seats.coder, assignment);
    assert.deepEqual(read.value.task.executions, before);
    assert.equal(f.c.tab("fixed").fixedCrew.preferences.coder.assignment, null);
  } finally { await f.close(); }
});

test("FCXC simultaneous HTTP requests reserve and spawn exactly one worker", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve(); const call = await httpTools(f);
    f.worker({ delay: 800 });
    const before = journal(f).executions.length, starts = children(f).filter((e) => e.worker && e.event === "start").length;
    const args = { expected: f.expected(), kind: "build", brief: "Build", route: "normal", change: "none" };
    const replies = await Promise.all([call("request_task_action", args), call("request_task_action", args)]);
    assert.equal(replies.filter((r) => r.ok).length, 1, JSON.stringify(replies));
    assert.equal(journal(f).executions.length, before + 1, "one durable reservation");
    assert.match(replies.find((r) => !r.ok)!.text, /Stale task|process tree|reserved/);
    await f.ended(replies.find((r) => r.ok)!.value.runId);
    assert.equal(children(f).filter((e) => e.worker && e.event === "start").length, starts + 1, "one actual spawn");
  } finally { await f.close(); }
});

test("FCXC unknown-tree report stays pending through HTTP intake and holds the worker slot", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    const call = await httpTools(f);
    writeFileSync(join(f.server.temp, "unknown-tree"), "1"); f.worker({});
    const start = await call("begin_planning", { expected: null, brief: "Plan" }); assert.equal(start.ok, true, start.text);
    await f.ended(start.value.runId);
    const before = journal(f), execution = before.executions.at(-1);
    assert.equal(execution.status, "interrupted"); assert.equal(execution.processEnded, false);
    assert.match(readFileSync(execution.logPath, "utf8"), /CC_REPORT_BEGIN/);
    const intake = await call("accept_planner_report", { expected: null, runId: start.value.runId });
    assert.equal(intake.ok, false); assert.match(intake.text, /did not finish successfully|process tree/);
    assert.equal(journal(f).activeExecutionId, start.value.runId);
    assert.equal(journal(f).executions.at(-1).consumed, false); assert.equal(f.task(), null);
    const starts = children(f).filter((e) => e.worker && e.event === "start").length;
    assert.equal((await call("begin_planning", { expected: null, brief: "Cannot repeat" })).ok, false);
    assert.deepEqual(journal(f), before, "rejected intake accepts no evidence and releases nothing");
    assert.equal(children(f).filter((e) => e.worker && e.event === "start").length, starts);
  } finally { await f.close(); }
});

test("FCXC same-session review and reused execution identity are refused, same model in a fresh run is allowed", { timeout: 60_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.planning(); await f.approve(); f.worker({});
    const build = await f.action("build"); await f.ended(build.value.runId); assert.equal((await f.verify(build.value.runId)).ok, true);
    const writer = f.task().executions.find((e: any) => e.id === build.value.runId);
    const check = await f.action("check"); await f.ended(check.value.runId); assert.equal((await f.verify(check.value.runId, "focused")).ok, true);
    const call = await httpTools(f), starts = journal(f).executions.length;
    await f.control("reuse-session", { sessionId: writer.sessionId });
    const args = { expected: f.expected(), kind: "review", brief: "Review", route: "normal", change: "none" };
    const same = await call("request_task_action", args); assert.equal(same.ok, false); assert.match(same.text, /fresh independent session/);
    assert.equal(journal(f).executions.length, starts, "same-session review never reserves or spawns");
    const reused = await call("request_task_action", { ...args, reservedExecutionId: writer.id });
    assert.equal(reused.ok, false); assert.match(reused.text, /reservation does not match/);
    const fresh = await call("request_task_action", args); assert.equal(fresh.ok, true, fresh.text);
    assert.deepEqual(fresh.value.assignment, assignment); assert.notEqual(fresh.value.runId, writer.id);
    await f.ended(fresh.value.runId); assert.equal((await f.verify(fresh.value.runId)).ok, true);
    const review = f.task().executions.at(-1); assert.notEqual(review.sessionId, writer.sessionId);
    assert.equal(f.task().reviews.length, 1);
  } finally { await f.close(); }
});

test("FCXC real server restart interrupts crash snapshots without replaying writers or Git operations", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ git: true });
  try {
    await f.planning(); await f.approve(); f.worker({ delay: 5000 });
    const build = await f.action("build"); assert.equal(build.ok, true, build.text);
    const snapshot = f.task(), savedJournal = journal(f);
    const taskFile = join(f.server.data, "tasks", "fixed.json"), journalFile = join(f.server.data, "executions", "fixed.json");
    for (const kind of ["checkpoint", "commit", "push"]) {
      const id = `crashed-${kind}`;
      snapshot.executions.push({ ...snapshot.executions.at(-1), id, sessionId: id, kind, role: "leader" });
      savedJournal.executions.push({ ...savedJournal.executions.at(-1), id, kind, role: "leader", selectedSlot: "leader" });
    }
    const starts = children(f).filter((e) => e.worker && e.event === "start").length;
    const pids = await f.restart(() => {
      writeFileSync(taskFile, JSON.stringify(snapshot)); writeFileSync(journalFile, JSON.stringify(savedJournal));
    });
    assert.notEqual(pids.oldPid, pids.newPid);
    const read = await f.tool("get_fixed_task"); assert.equal(read.ok, true, read.text);
    assert.equal(read.value.task.stage, "interrupted");
    for (const kind of ["build", "checkpoint", "commit", "push"]) {
      assert.equal(read.value.task.executions.find((e: any) => e.kind === kind).status, "interrupted", kind);
      assert.equal(read.value.executions.find((e: any) => e.kind === kind).status, "interrupted", kind);
      assert.equal((await f.action(kind)).ok, false, `${kind} is never repeated after restart`);
    }
    assert.equal(journal(f).activeExecutionId, build.value.runId);
    assert.equal(children(f).filter((e) => e.worker && e.event === "start").length, starts);
    assert.equal(existsSync(join(f.server.temp, "git-observed.jsonl")), false, "no checkpoint, commit or push command ran");
  } finally { await f.close(); }
});

test("FCXC CLI, advisor, extras and default-prompt replacement wait for retired leader tree confirmation", { timeout: 90_000 }, async () => {
  const f = await fixedServer();
  try {
    await f.tool("get_fixed_task"); assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    const log = () => readFileSync(join(f.server.temp, "fake-leader.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const kind of ["CLI", "advisor", "extras", "defaults"]) {
      await f.control("retirement"); writeFileSync(join(f.server.temp, "hold-retirement"), "1");
      const startCount = children(f).filter((e) => !e.worker && e.event === "start").length;
      if (kind === "CLI" || kind === "advisor") {
        const next = { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", ...(kind === "advisor" ? { advisor: "claude-opus-5-5[1m]" } : {}) };
        assert.equal((await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "leader", assignment: next })).ok, true);
      } else if (kind === "extras") assert.equal((await f.c.request({ type: "setCrewRoleExtra", tabId: "fixed", slot: "leader", text: "Extra instruction marker" })).ok, true);
      else await f.control("defaults");
      const from = f.c.messages.length;
      await f.c.chat("fixed", "Try replacement");
      assert.ok(f.c.messages.slice(from).some((m) => m.type === "chatError" && /previous leader.*could not be confirmed stopped/.test(m.message)), kind);
      assert.ok(existsSync(join(f.server.temp, "retired")), "old leader is retired first");
      assert.equal(children(f).filter((e) => !e.worker && e.event === "start").length, startCount, "no new child beside unconfirmed old tree");
      assert.equal(f.c.tab("fixed").leaderStatus, "not-started", "failed replacement is never reported as live/applied");
      unlinkSync(join(f.server.temp, "hold-retirement"));
      assert.equal(await f.c.chat("fixed", JSON.stringify([{ say: "Replacement can answer" }])), "Replacement can answer");
      assert.equal(f.c.tab("fixed").leaderStatus, "ready");
      if (kind === "CLI") {
        const records = children(f), leaderStart = records.find((e) => !e.worker && e.event === "start");
        assert.ok(records.some((e) => e.pid === leaderStart.pid && e.event === "exit"), "actual owned old Codex child exited");
        assert.equal(log().at(-1).cli, "claude");
      }
      if (kind === "extras") assert.match(log().at(-1).userText, /Extra instruction marker/);
    }
  } finally { await f.close(); }
});
