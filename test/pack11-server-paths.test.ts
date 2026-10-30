// Pack 11: a leader that starts with no memory of the tab is handed the tab's chat on its first turn, part 1: the inventory of every call site in server/index.ts that makes the next leader forget the tab, and the tests that walk those paths (this file holds all `path:` test names the inventory checks).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import { sourceText } from "./source-text.ts";
import { TABS, type CliName, HEAD, READ_FIRST, sleep, count, type Server, boot, client, chatBlock, type Harness, turnAfter, expectChatGiven, seed } from "./pack11-server-helpers.ts";

// ---- the inventory: every line of server/index.ts that makes the next leader forget the tab ----
const INVENTORY: Record<string, { count: number; paths: string[] }> = {
  "for (const project of workspaces.projects) for (const tab of project.tabs) pendingHandoverReads.add(tab.id);": { count: 1, paths: ["restart"] },
  "pendingHandoverReads.add(tabId); handoverReadTurns.delete(tabId);": { count: 1, paths: ["every stopLeaderSession caller"] },
  "stopLeaderSession(tab.id, true);": { count: 1, paths: ["removeTab"] },
  "stopLeaderSession(tabId);": { count: 1, paths: ["deadLeader"] },
  "if (isLeader) stopLeaderSession(tabId);": { count: 1, paths: ["stopSeat"] },
  "if (cliChanged && leaderSlot) { stopLeaderSession(tabId); pendingHandoverReads.add(tabId); }": { count: 1, paths: ["cliSwitch"] },
  "stopLeaderSession(tabId, false, reason);": { count: 1, paths: ["permissionModeFails"] },
  "pendingHandoverReads.add(tabId);": { count: 3, paths: ["permissionModeFails", "clear", "undoClear"] },
  "stopLeaderSession(message.tabId);": { count: 1, paths: ["changeFolder"] },
  "deps.stopLeaderSession(message.tabId);": { count: 1, paths: ["useSetup"] },
  "if (!sameSteps || !sameSeats || bare(setup.crew) !== bare(location.tab.crew)) deps.stopLeaderSession(message.tabId);": { count: 1, paths: ["setSetup"] },
  "deps.stopLeaderSession(tabId);": { count: 1, paths: ["roleChange"] },
  "for (const tabId of leadersAndWaitingTurns()) stopLeaderSession(tabId);": { count: 2, paths: ["stopAll", "restart (shutdown)"] },
  "stopLeaderSession(tabId, true);": { count: 2, paths: ["clear", "undoClear"] },
};
// removeTab ends the tab itself: ids are never handed out again, so nothing is left to give a leader.
const NOT_APPLICABLE = new Set(["removeTab"]);
const COVERED = new Set(["restart", "restart (shutdown)", "every stopLeaderSession caller", "stopSeat", "stopAll", "changeFolder", "useSetup", "setSetup", "roleChange", "cliSwitch", "deadLeader", "permissionModeFails", "clear", "undoClear"]);

// ---- the creation inventory: every place a leader is created or registered. A leader made anywhere else would skip `deliver`'s chat hand-back. ----
const CREATION_PATTERN = /\b(startTabLeader|createTabLeader|createCodexLeader|createOpencodeLeader|createLeader)\(|\bleaders\.set\(/g;
const CREATION: Record<string, { count: number; paths: string[] }> = {
  "createTabLeader(": { count: 2, paths: ["createNow", "createAfterRetired"] }, // sendLeaderTurn's two creations, both handed to `deliver`
  "startTabLeader(": { count: 1, paths: ["createNow", "createAfterRetired"] }, // inside createTabLeader
  "createCodexLeader(": { count: 1, paths: ["createNow", "createAfterRetired"] }, "createOpencodeLeader(": { count: 1, paths: ["createNow", "createAfterRetired"] },
  "createLeader(": { count: 1, paths: ["createNow", "createAfterRetired"] }, "leaders.set(": { count: 1, paths: ["createNow", "createAfterRetired"] },
};
const DELIVERED = ["try { leader = createTabLeader(tabId); }", "try { deliver(createTabLeader(tabId)); }", "if (!afterRetired) { deliver(leader!); return; }"];
const CREATION_COVERED = new Set(["createNow", "createAfterRetired"]);
function inventory(source: string): { stop: [string, number][]; creation: [string, number][]; delivered: number[] } {
  const lines = source.split(/\r?\n/).map((line) => line.trim().replace(/^export /, "")).filter((line) => !line.startsWith("//") && !/^(async )?function (stopLeaderSession|createTabLeader|startTabLeader)\b/.test(line));
  const stop = new Map<string, number>(), creation = new Map<string, number>();
  for (const line of lines) {
    if (/pendingHandoverReads\.add\(|stopLeaderSession\(/.test(line)) stop.set(line, (stop.get(line) ?? 0) + 1);
    for (const match of line.matchAll(CREATION_PATTERN)) creation.set(match[0], (creation.get(match[0]) ?? 0) + 1);
  }
  return { stop: [...stop].sort(), creation: [...creation].sort(), delivered: DELIVERED.map((needle) => lines.filter((line) => line.includes(needle)).length) };
}

test("pack 11: the call sites that make a leader forget the tab are exactly the ones this file walks", () => {
  // The setup messages moved out of index.ts into crew-setup.ts: the scan covers both files.
  const source = [sourceText("server/index.ts"), readFileSync("server/crew-setup.ts", "utf8")].join("\n");
  const found = inventory(source);
  assert.ok(found.stop.reduce((sum, [, n]) => sum + n, 0) >= 15, "the scan found the call sites");
  assert.deepEqual(found.stop, Object.entries(INVENTORY).map(([line, entry]) => [line, entry.count] as [string, number]).sort(), "a new or removed call site needs a path here");
  for (const entry of Object.values(INVENTORY)) for (const path of entry.paths) assert.ok(COVERED.has(path) || NOT_APPLICABLE.has(path), `path ${path} has a test`);
  // every place a leader is created or registered, each mapped to a path; the two creations in sendLeaderTurn reach the leader through `deliver`
  assert.deepEqual(found.creation, Object.entries(CREATION).map(([token, entry]) => [token, entry.count] as [string, number]).sort(), "a new leader creation site needs a path here");
  for (const entry of Object.values(CREATION)) for (const path of entry.paths) assert.ok(CREATION_COVERED.has(path), `creation path ${path} has a test`);
  assert.deepEqual(found.delivered, [1, 1, 1], "each creation in sendLeaderTurn hands the new leader to deliver");
  // controls: a creation or forget site added anywhere goes red; the scan is not blind
  assert.notDeepEqual(inventory(`${source}\nconst rogue = createTabLeader(tabId);`).creation, found.creation, "control: a new createTabLeader( is seen");
  assert.notDeepEqual(inventory(`${source}\nleaders.set(tabId, rogue);`).creation, found.creation, "control: a new leaders.set( is seen");
  assert.notDeepEqual(inventory(`${source}\nstopLeaderSession(tabId);`).stop, found.stop, "control: a new stopLeaderSession( is seen");
  assert.notDeepEqual(inventory(source.replace("try { deliver(createTabLeader(tabId)); }", "try { createTabLeader(tabId).send(text, images); }")).delivered, found.delivered, "control: a creation that skips deliver is seen");
  // The tests below announce themselves by path; each covered path really has one.
  // createAfterRetired (a leader started once the old one has exited) cannot be forced here: it is held by the `deliver` check above.
  const self = readFileSync(new URL(import.meta.url), "utf8");
  for (const path of [...COVERED, "createNow"]) assert.ok(self.includes(`path:${path}:`), `a test for path ${path}`);
});

test("path:restart: the first turn after a restart (new process, same data folder) carries the earlier chat, on all three leader CLIs", { timeout: 120_000 }, async () => {
  // path:restart (shutdown): the stop of the first process is the server's own shutdown; path:every stopLeaderSession caller: all of the others go through it.
  // path:createNow: each first turn here creates its leader on the spot (Codex, Claude and OpenCode creation functions).
  const first = await boot();
  let second: Server | undefined;
  try {
    let c = await client(first);
    const upload = await fetch(`http://127.0.0.1:${first.port}/api/paste-file`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "plan.txt", "X-Request-Id": "p11up1", "X-App-Key": first.key }, body: "the plan" });
    const stored = (await upload.json() as { path: string }).path;
    const earlier: Record<string, string[]> = {};
    for (const name of Object.keys(TABS) as CliName[]) {
      earlier[name] = [`${name}-hello`];
      await c.chat(TABS[name], earlier[name]![0]!, name === "codex" ? [stored] : undefined);
      await c.chat(TABS[name], `${name}-more`); earlier[name]!.push(`${name}-more`);
    }
    c.close(); await first.stop(true);
    second = await boot({ temp: first.temp });
    c = await client(second);
    const markers = new Set<string>();
    for (const name of Object.keys(TABS) as CliName[]) {
      const next = `${name}-after-restart`;
      const got = await turnAfter({ server: second, c }, TABS[name], async () => {}, next);
      assert.equal(got.cli, name);
      expectChatGiven(got.text, next, earlier[name]!, name !== "claude");
      const marker = chatBlock(got.text).marker;
      assert.ok(!markers.has(marker) && !/^0+$/.test(marker), "the fence marker is made up fresh for every turn"); markers.add(marker);
      if (name === "codex") {
        assert.ok(chatBlock(got.text).entries.some((entry) => entry.attached?.includes(stored)), "an attachment is listed as its path");
        if (process.env.PACK11_ROUGH_OUT) writeFileSync(process.env.PACK11_ROUGH_OUT, got.text);
      }
    }
    c.close();
  } finally { await (second ?? first).stop(); }
});

test("in-session paths: Stop on each CLI, Stop all, folder change, process change, CLI switch, a dead leader, a failed mode change, Clear and Undo", { timeout: 240_000 }, async () => {
  const server = await boot({ env: { FAKE_OPENCODE_PATCH_EXITS: "1" } });
  const c = await client(server); const h: Harness = { server, c };
  try {
    // path:stopSeat: Stop on the leader of each CLI
    for (const name of Object.keys(TABS) as CliName[]) {
      const earlier = await seed(h, TABS[name], `stop-${name}`);
      const got = await turnAfter(h, TABS[name], async () => { c.send({ type: "stopSeat", tabId: TABS[name], slot: "leader" }); await c.wait(() => c.tabOf(TABS[name]).leaderStatus === "not-started", "leader stopped"); }, `after-stop-${name}`);
      assert.equal(got.cli, name); expectChatGiven(got.text, `after-stop-${name}`, earlier, name !== "claude");
      assert.equal((await turnAfter(h, TABS[name], async () => {}, `second-${name}`)).text, `second-${name}`, "the requirement is used up by one good turn");
    }
    // path:stopAll:
    {
      const earlier = await seed(h, TABS.claude, "stopall");
      const got = await turnAfter(h, TABS.claude, async () => { c.send({ type: "stopAll" }); await c.wait(() => c.tabOf(TABS.claude).leaderStatus === "not-started", "all stopped"); }, "after-stopall");
      expectChatGiven(got.text, "after-stopall", earlier, false);
    }
    // path:changeFolder:
    {
      const earlier = await seed(h, TABS.opencode, "folder");
      const got = await turnAfter(h, TABS.opencode, async () => { c.send({ type: "changeFolder", tabId: TABS.opencode, folder: server.work2 }); await c.wait(() => c.tabOf(TABS.opencode).folder === realpathSync(server.work2), "folder changed"); }, "after-folder");
      assert.equal(got.cli, "opencode"); expectChatGiven(got.text, "after-folder", earlier);
    }
    // path:permissionModeFails: the fake OpenCode dies on the mode change, which stops the session
    {
      const earlier = await seed(h, TABS.opencode, "mode");
      const got = await turnAfter(h, TABS.opencode, async () => { const reply = await c.action({ type: "setPermissionMode", tabId: TABS.opencode, mode: "plan", confirm: true }); assert.equal(reply.type, "error"); await sleep(300); }, "after-mode");
      expectChatGiven(got.text, "after-mode", earlier);
    }
    // path:deadLeader: the Claude query ends by itself
    {
      const earlier = await seed(h, TABS.claude, "dead");
      const got = await turnAfter(h, TABS.claude, async () => {
        // The leader marks itself dead just before that error (the state broadcast that follows is walked by the next test).
        const errors = () => c.messages.filter((m) => m.type === "chatError" && m.tabId === TABS.claude && /leader session ended/.test(m.message)).length, before = errors();
        server.child.send("end-query"); await c.wait(() => errors() > before, "leader ended", 30_000);
      }, "after-dead");
      assert.equal(got.cli, "claude"); expectChatGiven(got.text, "after-dead", earlier, false);
    }
    // path:clear: Clear means start fresh, so nothing is handed back; path:undoClear: the restored chat is
    {
      const earlier = await seed(h, TABS.claude, "clear");
      const cleared = await turnAfter(h, TABS.claude, async () => { c.send({ type: "clear", tabId: TABS.claude }); await c.wait(() => c.messages.some((m) => m.type === "chatCleared" && m.tabId === TABS.claude), "cleared"); }, "after-clear");
      assert.ok(cleared.text.startsWith(READ_FIRST), "the handover is still read");
      assert.ok(!cleared.text.includes(HEAD) && !cleared.text.includes(earlier[0]!), "a cleared chat gives nothing back");
      assert.ok(cleared.text.endsWith("Current message:\nafter-clear"));
      assert.ok(cleared.text.includes("If it is missing, continue without inventing prior work."), "with no chat the old wording stays");
      const again = await seed(h, TABS.claude, "undo");
      const undone = await turnAfter(h, TABS.claude, async () => {
        c.send({ type: "clear", tabId: TABS.claude }); await c.wait(() => c.messages.filter((m) => m.type === "chatCleared" && m.tabId === TABS.claude).length >= 2, "cleared again");
        c.send({ type: "undoClear", tabId: TABS.claude }); await c.wait(() => c.messages.some((m) => m.type === "chatRestored" && m.tabId === TABS.claude), "restored");
      }, "after-undo");
      expectChatGiven(undone.text, "after-undo", [...again, "after-clear"], false);
    }
    // path:useSetup:
    {
      const earlier = await seed(h, TABS.codex, "process");
      const got = await turnAfter(h, TABS.codex, async () => { c.send({ type: "useSetup", tabId: TABS.codex, templateId: "blank" }); await c.wait(() => c.tabOf(TABS.codex).setupName === "Start blank", "setup changed"); }, "after-process");
      expectChatGiven(got.text, "after-process", earlier);
    }
    // path:setSetup: a saved crew whose leader settings changed (names and pictures alone would not end the leader)
    {
      const earlier = await seed(h, TABS.codex, "setup");
      const tab = c.tabOf(TABS.codex);
      const crew = tab.crew.map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest.slot === "leader" ? { ...rest, effort: rest.effort === "low" ? "medium" : "low" } : rest);
      const got = await turnAfter(h, TABS.codex, async () => { c.send({ type: "setSetup", tabId: TABS.codex, crew, lookPause: tab.lookPause }); await c.wait(() => c.tabOf(TABS.codex).crew.find((seat: any) => seat.slot === "leader")?.effort === crew[0].effort, "setup saved"); }, "after-setup");
      expectChatGiven(got.text, "after-setup", earlier);
    }
    // path:roleChange: a seat's new role changes the steps the leader was started with (a Helper is added first, which ends that leader once)
    {
      const tab = c.tabOf(TABS.codex);
      const crew = [...tab.crew.map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest), { slot: "helper", name: "Hal", role: "Helper", cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", canWrite: true, isLeader: false }];
      c.send({ type: "setSetup", tabId: TABS.codex, crew, lookPause: false });
      await c.wait(() => c.tabOf(TABS.codex).crew.some((seat: any) => seat.slot === "helper"), "the helper is added");
      const earlier = await seed(h, TABS.codex, "role");
      const got = await turnAfter(h, TABS.codex, async () => { c.send({ type: "updateSeat", tabId: TABS.codex, slot: "helper", role: "Coder" }); await c.wait(() => c.tabOf(TABS.codex).steps.length > 0, "the steps follow the role"); }, "after-role");
      expectChatGiven(got.text, "after-role", earlier);
    }
    // path:cliSwitch: the Claude tab's leader becomes Codex
    {
      const earlier = await seed(h, TABS.claude, "cli");
      const got = await turnAfter(h, TABS.claude, async () => { await c.action({ type: "refreshSettings" }); c.send({ type: "updateSeat", tabId: TABS.claude, slot: "leader", cli: "codex", model: "gpt-6-sol", effort: "high" }); await c.wait(() => c.tabOf(TABS.claude).crew.find((seat: any) => seat.slot === "leader")?.cli === "codex", "leader CLI changed"); }, "after-cli");
      assert.equal(got.cli, "codex"); expectChatGiven(got.text, "after-cli", earlier, false);
    }
  } finally { c.close(); await server.stop(); }
});

