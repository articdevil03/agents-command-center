// Pack 9, a live leader's own sessions never age out of the own-session list (server/folder-activity.ts keeps an id 10 minutes after it was last reported).
// The real Codex and OpenCode leaders run against their fake CLIs on a fake clock wired the way server/index.ts wires them: a window per turn, onSession -> noteSession.
// A turn 11+ minutes after the first writes the leader's own record (created before this turn's window), and neither a chat nor a Run may be held for it; a stranger still is.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFolderActivity } from "../server/folder-activity.ts";
import { createCodexLeader } from "../server/leader-codex.ts";
import { createOpencodeLeader } from "../server/leader-opencode.ts";
import type { LeaderCallbacks, LeaderHandle } from "../server/leader-common.ts";
import { spawnFakeLeaderCli } from "./fake-leader-cli.ts";
import { scratchDir } from "./temp-root.ts";
import { codexRecord } from "./codex-record.ts";

const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pad = (value: number) => String(value).padStart(2, "0");

function opencodeRecord(home: string, directory: string, id: string, updatedMs: number, createdMs: number): void {
  const path = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new (process.getBuiltinModule("node:sqlite")!).DatabaseSync(path);
  db.exec("create table if not exists session (id text primary key, directory text, time_updated integer, time_created integer)");
  db.prepare("insert or replace into session (id, directory, time_updated, time_created) values (?, ?, ?, ?)").run(id, directory, updatedMs, createdMs);
  db.close();
}

// OpenCode holds back the end of a reply (to hide secrets), so only a long reply streams text while the turn runs.
const LONG_REPLY = JSON.stringify([{ say: "A long answer. ".repeat(30) }]);
type Kind = "codex" | "opencode";
async function scenario(kind: Kind, options: { child: boolean }): Promise<void> {
  const temp = scratchDir(), home = join(temp, "home"), work = join(temp, "work");
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
  let now = Date.now();
  const start = now;
  const activity = createFolderActivity({ env: {}, dataRoot: join(temp, "data"), now: () => now, home });
  const plant = (id: string, at: number, created = at) => (kind === "codex" ? codexRecord(home, work, id, at) : opencodeRecord(home, work, id, at, created));
  const bridge = createHttpServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  await new Promise<void>((ok) => bridge.listen(0, "127.0.0.1", ok));

  let midTurn: (() => void) | null = null;
  let finished = 0;
  let sawAtUsage: string[] | null = null;
  const ownRecords = options.child ? ["ses_fake1", "ses_child1"] : [kind === "codex" ? "thread-1" : "ses_fake1"];
  const cb: LeaderCallbacks = {
    onSession: (id) => activity.noteSession(id),
    // The first text of a turn: 11 minutes pass, and another tab's window opens and closes (every save drops ids not reported for 10 minutes).
    onDelta: () => { const hook = midTurn; midTurn = null; hook?.(); },
    // Just before the turn is reported over: what a chat from another tab would be told right now.
    onUsage: () => { if (midTurn === null) sawAtUsage = activity.pending("other-tab", work).map((item) => item.sessionKey); },
    onDone: () => { finished++; },
    onError: (message: string) => { throw new Error(message); },
  } as LeaderCallbacks;
  const seat = kind === "codex" ? { model: "gpt-6-sol", effort: "high" } : { model: "fakeprov/fake-model", effort: "max" };
  const leader: LeaderHandle = kind === "codex"
    ? createCodexLeader(seat, work, cb, { tools: [], mode: "bypass", ask: async () => true, spawnFn: spawnFakeLeaderCli as any })
    : createOpencodeLeader(seat, work, cb, { bridge: { url: `http://127.0.0.1:${(bridge.address() as { port: number }).port}/mcp`, token: "bridge-token-0123456789abcdef0123456789abcdef" }, mode: "bypass", ask: async () => true, spawnFn: spawnFakeLeaderCli as any });
  const until = async (check: () => boolean, label: string) => { for (const end = Date.now() + 20_000; Date.now() < end;) { if (check()) return; await sleep(20); } assert.fail(label); };
  // The same shape as index.ts: a window for the turn, closed when the turn is reported over.
  const turn = async (text: string) => {
    const before = finished, token = activity.beginOwn(work);
    leader.send(text);
    await until(() => finished > before, "the turn finished");
    activity.endOwn(token);
  };
  try {
    await turn(options.child ? JSON.stringify([{ childRead: "a.txt" }]) : "first turn");
    assert.deepEqual([...activity.own.ids.keys()].sort(), [...ownRecords].sort(), "the first turn reported every session of this leader");

    now = start + 12 * MINUTE;
    // The leader's own records, last written now but created before this turn's window (a resumed session).
    for (const id of ownRecords) plant(id, now, start);
    plant("a-stranger", now, start);
    // Mid-turn: 11 more minutes pass and another tab's window opens and closes.
    midTurn = () => { now += 11 * MINUTE; activity.endOwn(activity.beginOwn(join(work, "..", "elsewhere"))); for (const id of ownRecords) plant(id, now, start); plant("a-stranger", now, start); };
    const registryRightAfterSend = (() => { const before = finished, token = activity.beginOwn(work); leader.send(LONG_REPLY); return { before, token, ids: [...activity.own.ids.keys()].sort() }; })();
    assert.deepEqual(registryRightAfterSend.ids, [...ownRecords].sort(), "a turn start reports the leader's sessions again, after the window opened and dropped the old ones");
    await until(() => finished > registryRightAfterSend.before, "the second turn finished");
    activity.endOwn(registryRightAfterSend.token);

    // A sub-agent session is next reported when the turn ends (after this point), so only the main session is checked mid-turn.
    if (!options.child) assert.deepEqual(sawAtUsage, ["a-stranger"], "while the long turn was still running, only the stranger showed as outside");
    // Right after the turn: a chat and a user Run (both ask the same question of the same folder) hold for the stranger alone.
    for (const asker of ["chat-tab", "run-tab"]) assert.deepEqual(activity.pending(asker, work).map((item) => item.sessionKey), ["a-stranger"], `${asker}: only the stranger holds it`);
    // Control: nothing else is there once the stranger is gone.
    now += 3 * MINUTE;
    assert.deepEqual(activity.pending("chat-tab", work), [], "nothing outside once the stranger is quiet");
  } finally {
    leader.stop();
    bridge.close();
    await sleep(500);
  }
}

test("the Codex leader's thread is reported at every turn start and notification: 11 minutes later its own record never holds a chat or a Run, a stranger's still does", { timeout: 60_000 }, async () => {
  await scenario("codex", { child: false });
});

test("the OpenCode leader's session is reported at every turn start, event and turn end: 11 minutes later its own record never holds a chat or a Run, a stranger's still does", { timeout: 60_000 }, async () => {
  await scenario("opencode", { child: false });
});

test("the OpenCode leader's sub-agent sessions are reported again too (their ids are not kept alive by the main session's events)", { timeout: 60_000 }, async () => {
  await scenario("opencode", { child: true });
});
