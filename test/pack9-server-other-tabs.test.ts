// Pack 9, the warning flow through real servers, part 2: catch-all file changes, another Command Center tab's writer, and every leader's own session id being registered.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { SEATS, TAB_A, TAB_B, sleep, runEndMs, testTimeoutMs, type Server, type TabSpec, client, codexRecord, claudeRecord, opencodeRecord, fakeLeaderTurns, withServer } from "./pack9-server-helpers.ts";

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

// ---- another Command Center tab's writer ----
const slowRuns = { FAKE_RUN_SLEEP: "9" };
const slowRunEndMs = runEndMs(slowRuns.FAKE_RUN_SLEEP);
const startRun = async (c: Awaited<ReturnType<typeof client>>, tabId: string, slot: string) => {
  const before = c.messages.filter((m) => m.type === "runStart" && m.tabId === tabId).length;
  c.send({ type: "run", tabId, slot, prompt: "work" });
  await c.wait(() => c.messages.filter((m) => m.type === "runStart" && m.tabId === tabId).length > before, `the ${slot} run in ${tabId} started`);
};

test("another tab's coder run in the same folder holds a chat and a Run: names its seat and tab, Continue anyway sends, the same run is not asked again, a NEW run asks again", { timeout: testTimeoutMs(slowRunEndMs, slowRunEndMs) }, async () => {
  await withServer({ env: slowRuns, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await startRun(c, TAB_B, "coder");
    const coder = SEATS.find((seat) => seat.slotId === "coder")!;
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual(held.answer.items.map((i: any) => i.writer), [{ seatName: coder.defaultName, roleLabel: "Coder", tabName: "Design" }]);
    await sleep(300);
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === held.requestId), false, "no user message appended");
    assert.equal(fakeLeaderTurns(server), 0, "no turn started");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started");

    // A user Run in the first tab is held for the same writer, then Continue anyway launches it.
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "mine" });
    const runHeld = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run" && m.tabId === TAB_A), "the Run is held");
    assert.equal(runHeld.items[0].writer.tabName, "Design");
    assert.equal(c.messages.some((m) => m.type === "runAccepted" && m.tabId === TAB_A), false, "nothing launched");
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "mine", confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "runAccepted" && m.tabId === TAB_A), "Continue anyway launches the Run");

    const second = await c.chatAndFinish(TAB_A, "and a message", {});
    assert.ok(second.taken, "the same run is not asked about again within 10 minutes");
    await c.wait(() => c.runEnds() >= 2, "both runs ended", slowRunEndMs);
    await sleep(300);
    await startRun(c, TAB_B, "coder");
    const again = await c.chat(TAB_A, "after a new run");
    assert.ok(again.held, "a NEW run in the other tab asks again");
    assert.equal(again.answer.items.filter((i: any) => i.writer).length, 1);
    await c.wait(() => c.runEnds() >= 3, "the new run ended", slowRunEndMs);
  });
});

test("no warning for another tab that only has a reviewer working, sits idle, works in an unrelated folder or a prefix lookalike of this one; the asking tab's own run never warns", { timeout: testTimeoutMs(slowRunEndMs) }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: TAB_B, folder: work }, { id: "p9-c", folder: `${work}2` }, { id: "p9-d", folder: join(dirname(work), "elsewhere") }];
  await withServer({ env: slowRuns, tabs }, async (server, c) => {
    assert.deepEqual(await c.busyProbe(TAB_A), [], "control: the other tabs are idle");
    await startRun(c, "p9-b", "reviewer1");
    await startRun(c, "p9-c", "coder");
    await startRun(c, "p9-d", "coder");
    await sleep(600);
    assert.equal(c.runEnds(), 0, "all three runs are still working");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "reviewer, lookalike folder and unrelated folder: no writer line");
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken, `not held: ${JSON.stringify(sent.answer)}`);
    // The asking tab's own coder run is not a writer for itself.
    await startRun(c, TAB_A, "coder");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "own run never warns");
    await c.wait(() => c.runEnds() >= 4, "the runs ended", slowRunEndMs);
  });
});

test("a Stand-alone tab's active leader turn warns (its leader codes itself); a Main Crew tab's leader turn with no writer run does not", { timeout: 120_000 }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: "p9-solo", name: "Solo", process: "solo", folder: work }, { id: "p9-solo2", name: "Solo 2", process: "solo", folder: work }, { id: "p9-main", name: "Main", folder: work }, { id: "p9-far", name: "Far", process: "solo", folder: join(dirname(work), "elsewhere") }];
  await withServer({ env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1" }, tabs }, async (server, c) => {
    const main = await c.chat("p9-main", "a leader turn in a Main Crew tab");
    assert.ok(main.taken);
    await sleep(500);
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "a Main Crew leader only plans: no writer");
    const solo = await c.chat("p9-solo", "code it yourself");
    assert.ok(solo.taken);
    assert.ok((await c.chat("p9-far", "a stand-alone turn in an unrelated folder")).taken);
    const items = await c.busyUntil(TAB_A);
    assert.deepEqual(items.map((i) => i.writer), [{ seatName: "Atlas", roleLabel: "Leader", tabName: "Solo" }]);
    assert.deepEqual((await c.busyProbe("p9-solo")).filter((i) => i.writer), [], "a tab's own turn is never a writer for itself");
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held);
    assert.equal((await c.chat(TAB_A, "hello", { confirmBusy: true })).taken, true, "Continue anyway sends it");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "the same turn is quiet for 10 minutes");
    // That tab is itself held for the first one (a stand-alone turn there writes too).
    assert.ok((await c.chat("p9-solo2", "another stand-alone turn")).held);
    assert.ok((await c.chat("p9-solo2", "another stand-alone turn", { confirmBusy: true })).taken);
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.writer), [{ seatName: "Atlas", roleLabel: "Leader", tabName: "Solo 2" }], "another tab's turn asks again");
  });
});

test("a leader-started crew run also says when another tab's coder is writing in the folder (once per run), in the chat and not as a pop-up", { timeout: testTimeoutMs(slowRunEndMs) }, async () => {
  await withServer({ env: slowRuns, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader"); // before the other tab works, so nobody has confirmed anything
    await startRun(c, TAB_B, "coder");
    const coder = SEATS.find((seat) => seat.slotId === "coder")!;
    const results = () => c.messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A);
    const line = `Heads up: ${coder.defaultName} (Coder) in your Design tab is writing code in this folder right now.`;
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "reviewer1", brief: "first" });
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "second" });
    await c.wait(() => results()[1], "both launches answered");
    assert.deepEqual(c.messages.filter((m) => m.type === "chatMessage" && m.tabId === TAB_A && m.role === "notice").map((m) => m.text), [line], "told once, not per launch, as a chat line");
    assert.equal(c.messages.filter((m) => m.type === "chatNotice" && /Heads up/.test(m.message)).length, 0, "and no pop-up");
    assert.equal(c.messages.some((m) => m.type === "folderBusy" && m.action !== "chat"), false, "a leader launch never asks");
    await c.wait(() => c.runEnds() >= 3, "the runs ended", slowRunEndMs);
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

test("FF1: a Leader plus Researcher warns by leader name; a Leader plus Coder does not", { timeout: 120_000 }, async () => {
  await withServer({ env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1" } }, async (server, c) => {
    const leader = { ...c.tab(TAB_B).crew.find((s: any) => s.isLeader), name: "Writing leader" };
    const seat = { ...c.tab(TAB_B).crew.find((s: any) => s.slot === "coder"), role: "Coder", canWrite: true };
    c.send({ type: "setSetup", tabId: TAB_B, crew: [leader, seat], lookPause: false });
    await c.wait(() => c.tab(TAB_B).crew.length === 2, "the two seats saved");
    assert.ok((await c.chat(TAB_B, "plan only")).taken);
    await c.wait(() => c.tab(TAB_B).derived.leaderTurnActive, "the leader is active");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "a Leader plus Coder leader is not writing");
  });
  for (const role of ["Researcher", "Reviewer"]) await withServer({ env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1" } }, async (server, c) => {
    const leader = { ...c.tab(TAB_B).crew.find((s: any) => s.isLeader), name: "Writing leader" };
    const seat = { ...c.tab(TAB_B).crew.find((s: any) => s.slot === "coder"), role, canWrite: false };
    c.send({ type: "setSetup", tabId: TAB_B, crew: [leader, seat], lookPause: false });
    await c.wait(() => c.tab(TAB_B).crew.length === 2, "the two seats saved");
    assert.ok((await c.chat(TAB_B, "build it")).taken);
    await c.wait(() => c.tab(TAB_B).derived.leaderTurnActive, "the writing leader is active");
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, "FF1: the writing leader holds the other tab chat");
    assert.deepEqual(held.answer.items.map((i: any) => i.writer), [{ seatName: "Writing leader", roleLabel: "Leader", tabName: TAB_B }]);
  });
});
