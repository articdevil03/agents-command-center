// Pack 9, the warning flow through real servers, part 2 (fixed crew tabs): catch-all file changes, another Command Center tab's activity in related folders, and every leader's own session id being registered.
// These cases use read-only Helpers. Fixed Coders can write; the positive live
// writer route is guarded by pack26-review1-server.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { TAB_A, TAB_B, sleep, runEndMs, testTimeoutMs, type Server, type TabSpec, codexRecord, claudeRecord, opencodeRecord, withServer, launchHelper } from "./pack9-server-helpers.ts";

test("a tab whose folder is changed is watched at its new folder (and the folder it left stays watched for the tab that remains)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const elsewhere = join(server.temp, "work-elsewhere");
    mkdirSync(elsewhere);
    c.send({ type: "changeFolder", tabId: TAB_B, folder: elsewhere });
    await c.wait(() => c.tab(TAB_B).folder.toLowerCase() === realpathSync(elsewhere).toLowerCase(), "the folder changed");
    writeFileSync(join(server.work, "old-folder.txt"), "x"); // the old folder (tab A still works there, so it is watched)
    writeFileSync(join(elsewhere, "new-folder.txt"), "x");
    assert.deepEqual((await c.busyUntil(TAB_B)).map((i) => i.tool), [null], "the new folder is watched");
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.tool), [null], "control: the old folder still is, for the tab that stayed");
  });
});

test("catch-all: a change inside .git, node_modules or .command-center does not warn", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const dir of [".git", "node_modules/pkg", ".command-center/tab"]) { mkdirSync(join(server.work, dir), { recursive: true }); writeFileSync(join(server.work, dir, "x.txt"), "x"); }
    await sleep(900);
    assert.deepEqual(await c.busyProbe(TAB_A), []);
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken);
  });
});

test("records that cannot be read never block a message (a corrupt OpenCode database, a bad Codex record, a Claude project that is a file)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const dbPath = join(server.activityHome, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "this is not a database".repeat(100));
    const day = new Date(), pad = (v: number) => String(v).padStart(2, "0");
    const dir = join(server.activityHome, ".codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-bad.jsonl"), "{broken\n");
    mkdirSync(join(server.activityHome, ".claude"), { recursive: true });
    writeFileSync(join(server.activityHome, ".claude", "projects"), "not a folder");
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken, `the message went through: ${JSON.stringify(sent.answer)}`);
  });
});

test("without CC_TEST_FAKE_CLI_ACTIVITY_HOME the server reads no records at all (the test runner never touches a real home)", { timeout: 60_000 }, async () => {
  await withServer({ noActivityHome: true }, async (server, c) => {
    codexRecord(server, "ignored", Date.now() - 5_000); // the folder exists but the server was never told about it
    writeFileSync(join(server.work, "x.txt"), "x");
    await sleep(500);
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken);
  });
});

// ---- another Command Center tab in related and unrelated folders ----
const slowRuns = { FAKE_RUN_SLEEP: "9" };
const slowRunEndMs = runEndMs(slowRuns.FAKE_RUN_SLEEP);

test("no warning for another tab that only has a read-only worker running, sits idle, works in an unrelated folder or a prefix lookalike of this one; the asking tab's own worker never warns", { timeout: testTimeoutMs(slowRunEndMs, slowRunEndMs) }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: TAB_B, folder: work }, { id: "p9-c", folder: `${work}2` }, { id: "p9-d", folder: join(dirname(work), "elsewhere") }];
  await withServer({ fixedControls: true, env: slowRuns, tabs }, async (server, c) => {
    assert.deepEqual(await c.busyProbe(TAB_A), [], "control: the other tabs are idle");
    await c.chatAndFinish(TAB_B, "start the leader");
    await launchHelper(server, TAB_B, "read only");
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_B), "the read-only run in the other tab started");
    await sleep(600);
    assert.equal(c.runEnds(), 0, "the run is still working");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "a read-only worker in a related folder: no writer line");
    for (const id of ["p9-c", "p9-d"]) assert.deepEqual(await c.busyProbe(id), [], `${id}: the lookalike and the unrelated folder see nothing of it`);
    await c.wait(() => c.runEnds() >= 1, "the run ended", slowRunEndMs);
    await c.chatAndFinish(TAB_A, "start the leader");
    await launchHelper(server, TAB_A, "mine");
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_A), "the asking tab's own worker started");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "own run never warns");
    await c.wait(() => c.runEnds() >= 2, "the second run ended", slowRunEndMs);
  });
});

test("FF1: a fixed tab's active leader turn is never a writer for another tab (the leader plans and delegates; Solo and leader-writes cases no longer exist)", { timeout: 120_000 }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Planning", folder: work }, { id: "p9-far", name: "Far", folder: join(dirname(work), "elsewhere") }];
  await withServer({ env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1" }, tabs }, async (server, c) => {
    assert.ok((await c.chat(TAB_B, "plan only")).taken);
    await c.wait(() => c.tab(TAB_B).derived.leaderTurnActive, "the leader is active");
    assert.ok((await c.chat("p9-far", "a turn in an unrelated folder")).taken);
    await sleep(500);
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "a fixed leader only plans: no writer, in the same folder or another");
    const sent = await c.chatAndFinish(TAB_A, "hello").catch(() => null);
    assert.equal(sent, null, "control: this tab's own leader turn never finishes here (the fake leader never answers)");
  });
});

// ---- every leader's own session id is registered (a Claude / OpenCode / Codex leader's own record must never warn against itself) ----
const leaderCases = [
  { leader: "codex" as const, id: "thread-1", env: {}, text: "start the leader", plant: (server: Server, id: string, at: number) => codexRecord(server, id, at) },
  { leader: "claude" as const, id: "claude-leader-sess", env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_SESSION_ID: "claude-leader-sess" }, text: JSON.stringify([{ tool: "Read", input: { file_path: "x" } }]), plant: (server: Server, id: string, at: number) => claudeRecord(server, id, at) },
  { leader: "opencode" as const, id: "ses_fake1", env: {}, text: "start the leader", plant: (server: Server, id: string, at: number) => opencodeRecord(server, id, at) },
];
for (const spec of leaderCases) {
  test(`the ${spec.leader} leader reports its session id: its own record (written long after any window) never warns, a stranger's still does`, { timeout: 120_000 }, async () => {
    await withServer({ leader: spec.leader, env: spec.env }, async (server, c) => {
      await c.chatAndFinish(TAB_A, spec.text);
      assert.ok(Object.keys(JSON.parse(readFileSync(join(server.data, "config", "own-sessions.json"), "utf8")).ids).includes(spec.id), "the leader's session id was saved");
      spec.plant(server, spec.id, Date.now() + 30_000); // past every window of ours: only the id can say it is ours
      const own = await c.chatAndFinish(TAB_A, spec.text);
      assert.ok(own.taken, `its own record does not warn: ${JSON.stringify(own.answer)}`);
      spec.plant(server, "a-stranger", Date.now() + 30_000);
      const stranger = await c.chat(TAB_A, spec.text);
      assert.ok(stranger.held && stranger.answer.items.length === 1, `control: a stranger of the same tool warns: ${JSON.stringify(stranger.answer)}`);
    });
  });
}
