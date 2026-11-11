import test from "node:test";
import assert from "node:assert/strict";
import { fakeRun } from "./tooling-sweep-run-fakes.ts";

const earlyKills = (world: ReturnType<typeof fakeRun>) => world.events.filter(([kind, , , early]) => kind === "kill" && early);
const expectKill = (world: ReturnType<typeof fakeRun>, at: number) => {
  assert.deepEqual(earlyKills(world), [["kill", at, world.child.pid, true]], `exactly one immediate kill of the spawned root; ${world.message()}`);
};

test("P25 timeout stops the pending fixture at 1500, before its natural end", async () => {
  const world = fakeRun();
  const running = world.start({ timeoutMs: 1500 });
  try {
    world.fixture();
    assert.deepEqual(world.events.filter(([kind]) => kind === "ready"), [["ready", 0]], world.message());
    await world.advance(1499);
    assert.deepEqual(earlyKills(world), [], `no premature timeout; ${world.message()}`);
    await world.advance(1500);
    expectKill(world, 1500);
    assert.equal(world.events.some(([kind]) => kind === "natural-end"), false, `fixture still pending; ${world.message()}`);
    assert.equal((await running).outcome, "timeout", world.message());
  } finally { await world.finish(); }
});

for (const reason of ["assertion", "abort"]) {
  test(`P25 ${reason} requests the root kill immediately`, async () => {
    const world = fakeRun();
    const controller = new AbortController();
    const running = world.start({ signal: controller.signal });
    try {
      world.fixture();
      await world.advance(123);
      if (reason === "abort") controller.abort();
      else world.emit({ type: "fail", file: "fake-lane/test/fake.test.ts", name: "fixture", cause: "ERR_ASSERTION" });
      expectKill(world, 123);
      assert.equal(world.events.some(([kind]) => kind === "natural-end"), false, world.message());
      assert.equal((await running).outcome, reason === "abort" ? "aborted" : "assertion", world.message());
    } finally { await world.finish(); }
  });
}

test("P25 pre-aborted input spawns nothing", async () => {
  const world = fakeRun();
  const running = world.start({ signal: AbortSignal.abort() });
  try {
    assert.deepEqual(world.events, [], `pre-abort must not spawn; ${world.message()}`);
    assert.equal((await running).outcome, "aborted", world.message());
  } finally { await world.finish(); }
});

for (const assertion of [false, true]) {
  test(`P25 ${assertion ? "earlyStop:false" : "normal completion"} waits for the fixture without an early kill`, async () => {
    const world = fakeRun();
    const running = world.start({ earlyStop: !assertion });
    try {
      world.fixture();
      if (assertion) world.emit({ type: "fail", file: "fake-lane/test/fake.test.ts", name: "fixture", cause: "ERR_ASSERTION" });
      await world.advance(9999);
      assert.deepEqual(earlyKills(world), [], world.message());
      assert.equal(world.events.some(([kind]) => kind === "close"), false, world.message());
      await world.advance(10_000);
      assert.deepEqual(world.events.filter(([kind]) => kind === "natural-end"), [["natural-end", 10_000]], world.message());
      assert.deepEqual(earlyKills(world), [], world.message());
      assert.equal((await running).outcome, assertion ? "assertion" : "pass", world.message());
    } finally { await world.finish(); }
  });
}
