import test from "node:test";
import assert from "node:assert/strict";
import { stateFixture, shutdownFixture } from "./pack26-review1-run2-process-helpers.ts";
import { socketGitFixture } from "./pack26-review1-run2-git-helpers.ts";
import { startHelper } from "./round2-fixed-deps.ts";

for (const route of ["run", "seat", "killSeat", "retirement", "all", "shutdown"] as const) {
  test(`P26R2S registry ${route} actual Stop dispatch cancels pending Git before next command`, async (t) => {
    const f = await stateFixture(t), pending = f.launch();
    try {
      const runId = f.journal().activeExecutionId;
      assert.ok(runId); assert.equal(f.spawns.length, 1);
      if (route === "run") f.ws.message({ type: "killRun", runId });
      if (route === "seat") f.ws.message({ type: "stopSeat", tabId: f.tabId, slot: "leader" });
      if (route === "killSeat") f.ws.message({ type: "killSeat", seatId: `${f.tabId}.leader` });
      if (route === "retirement") f.server.leaderHandles[0].callbacks.onStop();
      if (route === "all") f.ws.message({ type: "stopAll" });
      if (route === "shutdown") f.server.processHandlers.message("shutdown");
      if (route === "run") assert.ok(f.ws.messages.some((m: any) => m.type === "killAccepted"), "registered Git is recognized before runner rejection");
      if (route === "all") assert.ok(f.ws.messages.some((m: any) => m.type === "stopAllAccepted"), "Stop all acknowledges cancellation synchronously");
      f.child.stdout.write("true"); f.exit();
      await assert.rejects(pending, /cancelled/);
      assert.equal(f.spawns.length, 1, "no NEXT child after Stop");
      const records = f.terminal(); assert.equal(records.length, 1); assert.equal(records[0].cancelled, true); assert.equal(records[0].verification, "rejected");
      assert.equal(records[0].command, "success", "a later observed exit 0 is a command fact, never successful cancelled-operation evidence");
      if (route === "shutdown") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(f.server.exitCodes, [0], "clean shutdown waits for Git cleanup and finalization");
      }
    } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
  });
}

test("P26R2S seat unrelated tab leaves held Git alone and real socket Stop acknowledges before external release", async () => {
  const f = await socketGitFixture({ hold: "rev-parse", releaseMs: 4000 });
  const pending = f.call();
  try {
    await f.waitHeld();
    f.c.send({ type: "stopSeat", tabId: "fixed-second", slot: "leader" });
    await f.c.attempt({ type: "stopSeat", tabId: "fixed-second", slot: "helper" });
    assert.ok(f.pendingId(), "unrelated Stop cannot release the global Git reservation");
    const before = f.c.messages.length;
    f.c.send({ type: "killRun", runId: f.pendingId() });
    await f.c.wait(() => f.c.messages.slice(before).some((m) => m.type === "killAccepted"), "Stop acknowledgement while Git pending");
    const reply = await pending; assert.equal(reply.body.result.isError, true);
    assert.equal(f.rows("git-process-start.jsonl").length, 1);
    assert.equal(f.terminal().length, 1); assert.equal(f.terminal()[0].cancelled, true);
  } finally { f.release(); await pending; await f.close(); }
});

test("P26R2S seat common retirement seam cancels Git on actual folder-change dispatch", async (t) => {
  const f = await stateFixture(t), pending = f.launch();
  try {
    const id = f.journal().activeExecutionId;
    f.ws.message({ type: "changeFolder", tabId: f.tabId, folder: f.bin });
    assert.equal(f.operations.get(id)?.cancelled, true, "common Leader Stop seam must latch cancellation outside the run inventory");
    f.child.stdout.write("true"); f.exit(); await assert.rejects(pending, /cancelled/);
    assert.equal(f.spawns.length, 1);
  } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
});

test("P26R2S registry Stop before first child prevents every Git spawn", async (t) => {
  const f = await stateFixture(t), register = f.operations.register;
  f.operations.register = (...args: Parameters<typeof register>) => {
    const op = register(...args); f.ws.message({ type: "killRun", runId: op.id }); return op;
  };
  try {
    await assert.rejects(f.launch, /cancelled/);
    assert.equal(f.spawns.length, 0); assert.equal(f.terminal().length, 1); assert.equal(f.terminal()[0].cancelled, true);
  } finally { f.server.stopLeaderSession(f.tabId); }
});

test("P26R2S gap Stop after child cleanup before next command leaves irreversible cancellation", async (t) => {
  const f = await stateFixture(t), register = f.operations.register;
  let observed = false;
  f.operations.register = (...args: Parameters<typeof register>) => {
    const op = register(...args); let cancel: (() => void) | null = null;
    Object.defineProperty(op, "cancelChild", { get: () => cancel, set(value) {
      cancel = value;
      if (value === null && !observed) { observed = true; f.ws.message({ type: "killRun", runId: op.id }); }
    } });
    return op;
  };
  const pending = f.launch();
  try {
    f.child.stdout.write("true"); f.exit();
    await assert.rejects(pending, /cancelled/);
    assert.equal(observed, true); assert.equal(f.spawns.length, 1); assert.equal(f.terminal()[0].cancelled, true);
  } finally { f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
});

test("P26R2S gap cancellation is irreversible while Leader remains current; no heavy release during cleanup", async (t) => {
  const f = await stateFixture(t, { holdCleanup: true });
  const pending = f.launch();
  try {
    const id = f.journal().activeExecutionId;
    f.child.stdout.write("true"); f.exit();
    await Promise.resolve();
    assert.equal(f.journal().executions.at(-1).processEnded, false);
    f.server.createTabLeader("beta-dev");
    await assert.rejects(() => f.server.launchFixedAction(f.server.currentActor("beta-dev"), null, { kind: "assist", route: "normal", change: "none" }, "Read"), /previous process tree|reserved/);
    f.ws.message({ type: "killRun", runId: id });
    assert.equal(f.operations.get(id)?.cancelled, true, "cancellation setter must latch in command cleanup gap");
    assert.equal(f.server.leaders.get(f.tabId).isDead(), false, "run Stop leaves otherwise-current Leader available");
    f.releaseCleanup(); await assert.rejects(pending, /cancelled/);
    assert.equal(f.spawns.length, 1, "stopped gap launches no next command");
  } finally { f.releaseCleanup(); f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); f.server.stopLeaderSession("beta-dev"); }
});

test("P26R2S all registry cancellation includes operations outside Leader and runner inventories", async (t) => {
  const f = await stateFixture(t);
  const outside = f.operations.register("outside", "removed-tab", {});
  try {
    f.ws.message({ type: "stopAll" });
    assert.equal(outside.cancelled, true, "registry-wide Stop all must cover command gaps without live Leader/runner");
  } finally { outside.terminal = true; outside.finalized = true; f.operations.complete(outside); f.server.stopLeaderSession(f.tabId); }
});

test("P26R2S retirement late old callback cannot cancel replacement instance operation", async (t) => {
  const f = await stateFixture(t), replacement = {};
  const newer = f.operations.register("newer", f.tabId, replacement);
  try {
    f.server.leaderHandles[0].callbacks.onStop();
    assert.equal(newer.cancelled, false, "old onStop targets its exact originating instance");
  } finally { newer.terminal = true; newer.finalized = true; f.operations.complete(newer); f.server.stopLeaderSession(f.tabId); }
});

test("P26R2S shutdown admission closes synchronously and exit waits for cleanup and terminal record", async (t) => {
  const f = await stateFixture(t, { holdCleanup: true }), pending = f.launch();
  try {
    f.server.processHandlers.message("shutdown");
    assert.throws(() => f.operations.register("late", f.tabId, {}), /admission is closed/);
    await Promise.resolve(); assert.deepEqual(f.server.exitCodes, [], "server.close cannot bypass Git drain");
    f.releaseCleanup(); f.exit(1); await pending.catch(() => {});
    await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(f.server.exitCodes, [0]); assert.equal(f.terminal().length, 1);
  } finally { f.releaseCleanup(); f.exit(1); await pending.catch(() => {}); f.server.stopLeaderSession(f.tabId); }
});

for (const route of ["startup", "disconnect", "ipc", "workers", "leader", "http", "retain"] as const) {
  test(`P26R2S shutdown existing ${route} branch preserves dispatcher and cleanup`, async (t) => {
    const f = await shutdownFixture(t, ["disconnect", "retain"].includes(route), route === "startup"), s = f.server;
    let runId: string | undefined, closes = 0;
    const close = s.server.close;
    s.server.close = (callback: () => void) => { closes++; close(callback); };
    try {
      if (route === "workers" || route === "leader") runId = (await startHelper(s)).runId;
      if (route !== "startup") {
        const event = route === "disconnect" ? "disconnect" : "message";
        assert.equal(typeof s.processHandlers[event], "function", "shutdown event boundary is registered");
        s.processHandlers[event](route === "retain" ? undefined : "shutdown");
        if (route === "retain") s.processHandlers.SIGTERM();
      }
      await new Promise((done) => setTimeout(done, 20));
      if (route === "http") assert.equal(closes, 1, "HTTP server close must be requested");
      if (route === "retain") assert.equal(closes, 0, "disconnected branch retains the existing root handling");
      if (route === "workers") assert.ok(s.kills.includes(runId!), "shutdown requests worker Stop");
      if (route === "leader") assert.ok(s.leaderHandles[0].stopCalls > 0, "shutdown requests Leader Stop");
      if (route === "disconnect" || route === "startup") assert.ok(f.calls.some(([program, args]) => args.includes("/T")), "disconnect keeps self-tree fallback");
      assert.deepEqual(s.exitCodes, [0], "existing branch reaches clean exit after empty Git drain");
    } finally { if (runId) s.closeRun(runId, 1); for (const tab of ["alpha-dev", "beta-dev"]) s.stopLeaderSession(tab); }
  });
}
