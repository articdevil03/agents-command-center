// Pack 9, the readers and the catch-all (server/folder-activity.ts): which sessions of Claude Code, Codex and OpenCode count as "another agent working in
// this folder", how Command Center's own sessions are left out, and the folder watch. Everything runs on fake homes under the OS temp dir; the real
// ~/.claude, ~/.codex and OpenCode database are never read. The real servers (warning flow) are in pack9-server.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFolderActivity, outsideActivity, relatedFolders, activityHome, ACTIVE_WINDOW_MS, type OwnSessions } from "../server/folder-activity.ts";
import { scratchDir } from "./temp-root.ts";
import { codexRecord as plantCodexRecord } from "./codex-record.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const noOwn = (): OwnSessions => ({ ids: new Map(), windows: new Map() });
const touch = (path: string, mtimeMs: number) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
const keys = (found: { sessionKey: string }[]) => found.map((item) => item.sessionKey).sort();
// A reader that throws must fail an ASSERTION (not just crash the test), so the check can be proven red by putting the throw back.
const safely = <T>(read: () => T): T => { let result!: T; assert.doesNotThrow(() => { result = read(); }); return result; };

// ---- fake records, in the shapes the tools write (field names confirmed on this machine; no content) ----
function claudeRecord(home: string, folder: string, id: string, mtimeMs: number, slugCase: "original" | "lower" = "original"): void {
  const slug = folder.replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", slugCase === "lower" ? slug.toLowerCase() : slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `{"type":"user","sessionId":"${id}","cwd":"x"}\n`);
  touch(file, mtimeMs);
}
const pad = (value: number) => String(value).padStart(2, "0");
const codexRecord = (home: string, cwd: string, id: string, mtimeMs: number, options: { dayOf?: number; firstLine?: string; bulk?: number } = {}): string =>
  plantCodexRecord(home, cwd, id, mtimeMs, { day: options.dayOf, firstLine: options.firstLine, bulk: options.bulk ?? 100 });
// `time_created` left out means the row has no known start; `withCreated: false` builds a database without the column at all.
type Row = { id: string; directory: string; time_updated: number; time_created?: number };
function opencodeDb(home: string, rows: Row[], withCreated = true): string {
  const path = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = process.getBuiltinModule("node:sqlite")!;
  const db = new sqlite.DatabaseSync(path);
  db.exec(`create table session (id text primary key, directory text, time_updated integer${withCreated ? ", time_created integer" : ""})`);
  const insert = db.prepare(`insert into session (id, directory, time_updated${withCreated ? ", time_created" : ""}) values (?, ?, ?${withCreated ? ", ?" : ""})`);
  for (const row of rows) withCreated ? insert.run(row.id, row.directory, row.time_updated, row.time_created ?? null) : insert.run(row.id, row.directory, row.time_updated);
  db.close();
  return path;
}

const TAB = "C:/w/proj/app";
const SAME = TAB, PARENT = "C:/w/proj", CHILD = "C:/w/proj/app/sub", OTHER = "C:/w/other", LOOKALIKE = "C:/w/proj/apple", SHORTER = "C:/w/pro";

test("relatedFolders: same, inside and containing count, in any case and separator; a prefix lookalike does not", () => {
  assert.equal(relatedFolders("C:\\W\\Proj\\App", "c:/w/proj/app"), true);
  assert.equal(relatedFolders(TAB, CHILD), true);
  assert.equal(relatedFolders(TAB, PARENT), true);
  assert.equal(relatedFolders("C:/a/b", "C:/a/bc"), false, "C:/a/bc is not inside C:/a/b");
  assert.equal(relatedFolders("C:/a/bc", "C:/a/b"), false);
  assert.equal(relatedFolders("C:/a/b/", "C:/a/b/c"), true, "a trailing slash changes nothing");
  assert.equal(relatedFolders("C:/", "C:/a/b"), true, "a drive root contains the folder");
  assert.equal(relatedFolders("C:/a", "D:/a"), false);
});

test("activityHome: under the test runner only the test variable is read, never the real home", () => {
  assert.equal(activityHome({ CC_TEST_FAKE_CLI: "1" }), null, "no variable, nothing is read");
  assert.equal(activityHome({ CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_ACTIVITY_HOME: "D:/fake" }), "D:/fake");
  assert.equal(activityHome({ CC_TEST_FAKE_CLI_ACTIVITY_HOME: "D:/fake" }), activityHome({}), "outside the test runner the variable is ignored");
  assert.ok(activityHome({}), "a real run reads the user's home");
});

test("Claude Code: finds a session in the folder, a parent and a child; ignores old, unrelated, lookalike, subagent and non-session files", () => {
  const home = scratchDir(), now = Date.now(), recent = now - 30_000;
  claudeRecord(home, SAME, "s-same", recent);
  claudeRecord(home, SAME, "s-same-lower", recent, "lower"); // the slug's case varies on this machine: both spellings are listed and matched
  claudeRecord(home, PARENT, "s-parent", recent);
  claudeRecord(home, CHILD, "s-child", recent);
  claudeRecord(home, SAME, "s-old", now - ACTIVE_WINDOW_MS - 5_000);
  claudeRecord(home, OTHER, "s-other", recent);
  claudeRecord(home, LOOKALIKE, "s-lookalike", recent);
  claudeRecord(home, SHORTER, "s-shorter", recent);
  const slugDir = join(home, ".claude", "projects", TAB.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(join(slugDir, "s-same", "subagents"), { recursive: true });
  writeFileSync(join(slugDir, "s-same", "subagents", "agent-1.jsonl"), "{}\n"); // a subagent belongs to its parent session
  writeFileSync(join(slugDir, "notes.txt"), "x");
  const found = outsideActivity(TAB, noOwn(), now, home);
  assert.deepEqual(keys(found), ["s-child", "s-parent", "s-same", "s-same-lower"]);
  for (const item of found) assert.equal(item.tool, "Claude Code");
  assert.ok(Math.abs(found.find((item) => item.sessionKey === "s-same")!.lastActiveAt - recent) < 1500, "lastActiveAt is the file's time");
});

test("Codex: finds a session by the cwd in its first line (folder, parent, child, a first line larger than one read), today's and yesterday's day folders by local date", () => {
  const home = scratchDir(), now = Date.now(), recent = now - 30_000;
  codexRecord(home, SAME, "c-same", recent);
  codexRecord(home, PARENT, "c-parent", recent);
  codexRecord(home, CHILD, "c-child", recent);
  codexRecord(home, SAME, "c-big", recent, { bulk: 200_000 });
  codexRecord(home, SAME, "c-yesterday", recent, { dayOf: now - 24 * 60 * 60_000 });
  codexRecord(home, SAME, "c-three-days", recent, { dayOf: now - 3 * 24 * 60 * 60_000 });
  codexRecord(home, SAME, "c-old", now - ACTIVE_WINDOW_MS - 5_000);
  codexRecord(home, OTHER, "c-other", recent);
  codexRecord(home, LOOKALIKE, "c-lookalike", recent);
  codexRecord(home, SAME, "c-badjson", recent, { firstLine: "{not json" });
  codexRecord(home, SAME, "c-wrongtype", recent, { firstLine: JSON.stringify({ type: "event_msg", payload: { id: "c-wrongtype", cwd: SAME } }) });
  codexRecord(home, SAME, "c-nocwd", recent, { firstLine: JSON.stringify({ type: "session_meta", payload: { id: "c-nocwd" } }) });
  const found = outsideActivity(TAB, noOwn(), now, home);
  assert.deepEqual(keys(found), ["c-big", "c-child", "c-parent", "c-same", "c-three-days", "c-yesterday"], "bad records are skipped, the good ones still answer; a resumed session in an older day folder counts");
  for (const item of found) assert.equal(item.tool, "Codex");
});

test("Codex: a resumed session is found in its ORIGINAL day folder however old; a stale file there, another cwd, and a new resume after the scan interval behave", () => {
  const home = scratchDir(), now = Date.now(), months3 = now - 90 * 24 * 60 * 60_000;
  codexRecord(home, SAME, "c-resumed", now - 20_000, { dayOf: months3 });
  codexRecord(home, SAME, "c-asleep", now - ACTIVE_WINDOW_MS - 5_000, { dayOf: months3 });
  codexRecord(home, OTHER, "c-elsewhere", now - 20_000, { dayOf: months3 });
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["c-resumed"], "fresh in a 3-month-old folder is found; stale and unrelated are not");
  // The old folders are re-read at most every 30 s (they hold thousands of files); a later resume is picked up on the next read.
  const file = codexRecord(home, SAME, "c-asleep", now + 40_000, { dayOf: months3 });
  assert.ok(existsSync(file));
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now + 1_000, home)), ["c-resumed"], "inside the interval the old folders are not read again");
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now + 40_000, home)), ["c-asleep", "c-resumed"], "after the interval the resume shows");
});

test("Codex: today's and yesterday's day folders are read on every check, never held back by the interval for the older ones", () => {
  const home = scratchDir(), now = Date.now();
  assert.deepEqual(outsideActivity(TAB, noOwn(), now, home), [], "control: nothing yet");
  codexRecord(home, SAME, "c-today", now - 10_000);
  codexRecord(home, SAME, "c-yesterday", now - 10_000, { dayOf: now - 24 * 60 * 60_000 });
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["c-today", "c-yesterday"]);
});

test("Codex: the day folder is named by the LOCAL date, whatever the first line's UTC timestamp says", () => {
  // At local 00:30 and 23:30 the local date differs from the UTC date in every time zone but UTC itself.
  for (const [hour, minute] of [[0, 30], [23, 30]]) {
    const home = scratchDir(), now = new Date(2026, 9, 15, hour, minute).getTime();
    assert.deepEqual(outsideActivity(TAB, noOwn(), now, home), [], "control: nothing yet (this also starts the interval for the older folders)");
    codexRecord(home, SAME, "c-local", now - 20_000, { dayOf: now }); // placed in the day folder of the (fake) local date
    const found = outsideActivity(TAB, noOwn(), now, home); // the same instant: only today's folder is read again, so it must be the local date's
    assert.deepEqual(keys(found), ["c-local"], `local ${hour}:${minute}`);
  }
});

test("Codex: a record whose mtime is past midnight is still in the day folder of the day it was created (planted at 23:59:53 + 30 s)", () => {
  const home = scratchDir(), now = new Date(2026, 9, 17, 23, 59, 53).getTime();
  assert.deepEqual(outsideActivity(TAB, noOwn(), now, home), [], "control: nothing yet (this also starts the interval for the older folders)");
  const file = plantCodexRecord(home, SAME, "c-edge", now + 30_000, { now });
  assert.ok(file.replaceAll("\\", "/").includes("/sessions/2026/10/17/"), `the folder is the creation day, not the mtime's day: ${file}`);
  assert.ok(new Date(statSync(file).mtimeMs).getDate() === 18, "control: the mtime itself is on the next day");
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["c-edge"], "the server's check for the same instant finds it");
});

test("OpenCode: finds a session by the directory column (folder, parent, child); ignores old, unrelated and lookalike; opens the database read-only", () => {
  const home = scratchDir(), now = Date.now(), recent = now - 30_000;
  const db = opencodeDb(home, [
    { id: "o-same", directory: SAME, time_updated: recent }, { id: "o-parent", directory: PARENT, time_updated: recent }, { id: "o-child", directory: CHILD, time_updated: recent },
    { id: "o-old", directory: SAME, time_updated: now - ACTIVE_WINDOW_MS - 5_000 }, { id: "o-other", directory: OTHER, time_updated: recent }, { id: "o-lookalike", directory: LOOKALIKE, time_updated: recent },
  ]);
  const before = readFileSync(db);
  const found = outsideActivity(TAB, noOwn(), now, home);
  assert.deepEqual(keys(found), ["o-child", "o-parent", "o-same"]);
  for (const item of found) assert.equal(item.tool, "OpenCode");
  assert.ok(Buffer.compare(before, readFileSync(db)) === 0, "the database file is byte-identical afterwards");
  assert.deepEqual(readdirSync(dirname(db)).sort(), ["opencode.db"], "no journal or wal file was left beside it");
});

test("the OpenCode database is opened read-only (source check: SQLite falls back silently on a write-protected file, so behaviour cannot show it)", () => {
  assert.ok(readFileSync("server/folder-activity.ts", "utf8").includes("new sqlite.DatabaseSync(dbPath, { readOnly: true })"), "the database is opened with readOnly: true");
});

test("a record that cannot be read is skipped without throwing, and never hides the other tools", () => {
  const now = Date.now(), recent = now - 10_000;
  const empty = scratchDir();
  assert.deepEqual(safely(() => outsideActivity(TAB, noOwn(), now, empty)), [], "no tool folder at all");
  assert.deepEqual(safely(() => outsideActivity(TAB, noOwn(), now, join(empty, "missing"))), [], "a home that does not exist");
  assert.deepEqual(safely(() => outsideActivity(TAB, noOwn(), now, null)), [], "no home, nothing read");
  // A corrupt OpenCode database, and a Codex record: the Codex session is still found.
  const home = scratchDir();
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, Buffer.from("this is not a sqlite file".repeat(50)));
  codexRecord(home, SAME, "c-alive", recent);
  assert.deepEqual(keys(safely(() => outsideActivity(TAB, noOwn(), now, home))), ["c-alive"]);
  // A locked database: another connection holds an exclusive transaction.
  const locked = scratchDir();
  const lockedPath = opencodeDb(locked, [{ id: "o-locked", directory: SAME, time_updated: recent }]);
  const sqlite = process.getBuiltinModule("node:sqlite")!;
  const holder = new sqlite.DatabaseSync(lockedPath);
  try {
    holder.exec("begin exclusive");
    codexRecord(locked, SAME, "c-beside-lock", recent);
    assert.deepEqual(keys(safely(() => outsideActivity(TAB, noOwn(), now, locked))), ["c-beside-lock"], "the locked database is skipped, the Codex record answers");
  } finally { holder.exec("rollback"); holder.close(); }
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, locked)), ["c-beside-lock", "o-locked"], "control: the same database answers once it is not locked");
});

test("own sessions: an id a leader reported is excluded, in every tool", () => {
  const home = scratchDir(), now = Date.now(), recent = now - 10_000;
  claudeRecord(home, SAME, "own-claude", recent); claudeRecord(home, SAME, "ext-claude", recent);
  codexRecord(home, SAME, "own-codex", recent); codexRecord(home, SAME, "ext-codex", recent);
  opencodeDb(home, [{ id: "own-oc", directory: SAME, time_updated: recent }, { id: "ext-oc", directory: SAME, time_updated: recent }]);
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["ext-claude", "ext-codex", "ext-oc", "own-claude", "own-codex", "own-oc"], "control: all six without the registry");
  const own = noOwn();
  for (const id of ["own-claude", "own-codex", "own-oc"]) own.ids.set(id, now);
  assert.deepEqual(keys(outsideActivity(TAB, own, now, home)), ["ext-claude", "ext-codex", "ext-oc"]);
});

// Files are created for real, so their creation time is the moment the test makes them (B); times are laid out around B, and `now` is B + 2 minutes.
test("own windows: a record created and last touched inside a window of an overlapping folder is ours, even after the run ended 60 s ago; outside the window it is not", () => {
  const home = scratchDir(), B = Date.now(), now = B + 120_000, written = B + 55_000;
  const window = (start: number, end: number | null, folder = SAME): OwnSessions => ({ ids: new Map(), windows: new Map([[1, { folder, start, end }]]) });
  // A crew run that started just before its CLI session was created and ended 60 s ago; the session was last written 65 s ago.
  codexRecord(home, CHILD, "run-record", written);
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["run-record"], "control: with no window it is an outsider");
  assert.deepEqual(outsideActivity(TAB, window(B - 5_000, B + 60_000), now, home), [], "ended 60 s ago: still ours");
  assert.deepEqual(outsideActivity(TAB, window(B - 5_000, B + 60_000, PARENT), now, home), [], "a window on a parent folder covers a child session");
  assert.deepEqual(keys(outsideActivity(TAB, window(B - 5_000, B + 60_000, OTHER), now, home)), ["run-record"], "a window on an unrelated folder covers nothing");
  assert.deepEqual(keys(outsideActivity(TAB, window(B - 5_000, B + 60_000, LOOKALIKE), now, home)), ["run-record"], "nor a prefix lookalike");
  assert.deepEqual(keys(outsideActivity(TAB, window(B - 5_000, B + 30_000), now, home)), ["run-record"], "written after the window closed (and its slack): an outsider");
  assert.deepEqual(keys(outsideActivity(TAB, window(B + 57_000, B + 70_000), now, home)), ["run-record"], "written before the window opened: an outsider");
  assert.deepEqual(outsideActivity(TAB, window(B - 5_000, null), now, home), [], "a window still open covers it");
  // Claude and OpenCode records are matched through the same windows.
  claudeRecord(home, SAME, "claude-run", written);
  opencodeDb(home, [{ id: "oc-run", directory: SAME, time_updated: written, time_created: B + 1_000 }]);
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, home)), ["claude-run", "oc-run", "run-record"]);
  assert.deepEqual(outsideActivity(TAB, window(B - 5_000, B + 60_000), now, home), []);
});

test("own windows: a session already running before the window opened is an outsider's however recently it was written, in every tool; one created inside is ours; a leader id is ours regardless", () => {
  const home = scratchDir(), B = Date.now(), now = B + 120_000, written = B + 55_000;
  // The three records below were created at B (Claude, Codex) or B - 30 s (OpenCode); the run's window opens at B + 20 s and is still open.
  const open = (id?: string): OwnSessions => ({ ids: new Map(id ? [[id, now]] : []), windows: new Map([[1, { folder: SAME, start: B + 20_000, end: null }]]) });
  claudeRecord(home, SAME, "before-claude", written);
  codexRecord(home, SAME, "before-codex", written);
  opencodeDb(home, [{ id: "before-oc", directory: SAME, time_updated: written, time_created: B - 30_000 }]);
  assert.deepEqual(keys(outsideActivity(TAB, open(), now, home)), ["before-claude", "before-codex", "before-oc"], "already running, written inside the window: still warns");
  assert.deepEqual(keys(outsideActivity(TAB, open("before-codex"), now, home)), ["before-claude", "before-oc"], "a leader's own session id is never an outsider, whenever it started");
  // The same three created inside a window that opened before them: ours.
  const during: OwnSessions = { ids: new Map(), windows: new Map([[1, { folder: SAME, start: B - 5_000, end: null }]]) };
  const second = scratchDir();
  claudeRecord(second, SAME, "during-claude", written);
  codexRecord(second, SAME, "during-codex", written);
  opencodeDb(second, [{ id: "during-oc", directory: SAME, time_updated: written, time_created: B + 1_000 }]);
  assert.deepEqual(outsideActivity(TAB, during, now, second), [], "created inside the window: ours");
});

test("own windows: a start that cannot be known keeps the last-written rule (Codex session_meta timestamp stands in for a missing file time; OpenCode without the column)", () => {
  const home = scratchDir(), B = Date.now(), now = B + 120_000, written = B + 55_000;
  const window: OwnSessions = { ids: new Map(), windows: new Map([[1, { folder: SAME, start: B + 20_000, end: null }]]) };
  // Codex: the file was created at B, before the window; its own timestamp says the same.
  codexRecord(home, SAME, "stamp-before", written, { firstLine: JSON.stringify({ type: "session_meta", payload: { id: "stamp-before", cwd: SAME, timestamp: new Date(B).toISOString() } }) });
  assert.deepEqual(keys(outsideActivity(TAB, window, now, home)), ["stamp-before"]);
  // OpenCode without time_created: today's rule, so a record written inside the window is ours.
  const old = scratchDir();
  opencodeDb(old, [{ id: "no-column", directory: SAME, time_updated: written }], false);
  assert.deepEqual(outsideActivity(TAB, window, now, old), [], "no creation column: falls back to last-written");
  assert.deepEqual(keys(outsideActivity(TAB, noOwn(), now, old)), ["no-column"], "control: the row is read at all");
});

test("the registry: the clock decides, a crew run ended 60 s ago never warns against itself, and a reader that throws never stops the answer", () => {
  const home = scratchDir(), data = scratchDir();
  let clock = Date.now();
  const activity = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  const start = clock;
  const run = activity.beginOwn(SAME);
  clock += 5_000;
  activity.endOwn(run);
  codexRecord(home, SAME, "ours", start + 2_000); // written during the run
  clock += 60_000; // the run ended 60 s ago
  assert.deepEqual(activity.outside(TAB), [], "ours: inside the run's window");
  codexRecord(home, SAME, "theirs", clock - 20_000); // written after the run ended (past the slack)
  assert.deepEqual(keys(activity.outside(TAB)), ["theirs"]);
  // A reader that throws (a corrupt database) is skipped.
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "garbage");
  assert.deepEqual(keys(safely(() => activity.outside(TAB))), ["theirs"]);
});

test("persistence: own ids and windows survive a restart within 2 minutes; older ones are dropped; an unreadable file is empty; the write is atomic", () => {
  const home = scratchDir(), data = scratchDir();
  let clock = Date.now();
  const first = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  first.noteSession("thread-1");
  const token = first.beginOwn(SAME); clock += 3_000; first.endOwn(token);
  const file = join(data, "config", "own-sessions.json");
  assert.ok(existsSync(file), "the registry is written beside the other config files");
  assert.deepEqual(readdirSync(join(data, "config")), ["own-sessions.json"], "no temp file is left");
  codexRecord(home, SAME, "thread-1", clock + 60_000); // far past every window: only its id can exclude it
  codexRecord(home, SAME, "windowed", clock - 2_000); // inside the window
  codexRecord(home, SAME, "stranger", clock + 60_000);
  clock += 30_000; // the app was closed and reopened 30 s later
  const second = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  assert.deepEqual(keys(second.outside(TAB)), ["stranger"], "the id and the window were read back");
  const fresh = createFolderActivity({ env: {}, dataRoot: scratchDir(), home, now: () => clock });
  assert.deepEqual(keys(fresh.outside(TAB)), ["stranger", "thread-1", "windowed"], "control: without the file all three would warn");
  clock += 11 * 60_000;
  const later = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).ids ?? {}), ["thread-1"], "control: the file still holds the id before it is pruned");
  later.noteSession("another"); // writing prunes
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.ids).sort(), ["another", "thread-1"], "ids outlive windows: still held after 11 minutes");
  assert.deepEqual(saved.windows, [], "windows older than ~10 minutes are pruned");
  clock += 7 * 24 * 60 * 60_000 + 60_000; // past the id keep
  createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock }).noteSession("newest");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).ids), ["newest"], "ids older than 7 days are pruned");
  writeFileSync(file, "{not json");
  assert.doesNotThrow(() => createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock }), "an unreadable file is treated as empty");
});

test("a leader silent for 11 minutes keeps its id while another tab's window opens and closes; a stranger still warns; ids go after 7 days, windows after 10 minutes", () => {
  const home = scratchDir(), data = scratchDir();
  let clock = Date.now();
  const activity = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  const file = join(data, "config", "own-sessions.json");
  activity.noteSession("leader-1");
  clock += 11 * 60_000; // one long tool call, no re-report
  activity.endOwn(activity.beginOwn(SAME)); // another tab's window: saves and prunes
  clock += 60_000;
  const leaderWrote = clock - 5_000;
  codexRecord(home, SAME, "leader-1", leaderWrote, { dayOf: leaderWrote });
  codexRecord(home, SAME, "stranger", leaderWrote);
  assert.deepEqual(keys(activity.outside(TAB)), ["stranger"], "the leader's record is ours, the stranger's is outside");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).ids), ["leader-1"], "persisted too");
  clock += 12 * 60_000; // that window is now older than 10 minutes
  activity.endOwn(activity.beginOwn(SAME));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).windows.length, 1, "the old window was pruned, only the new one is held");
  clock += 7 * 24 * 60 * 60_000 + 60_000;
  activity.endOwn(activity.beginOwn(SAME));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).ids, {}, "persisted: the id is pruned after 7 days");
  assert.equal(activity.own.ids.has("leader-1"), false, "and in memory");
});

test("without a home (the test runner without its variable) nothing is read, written or watched", () => {
  const data = scratchDir(), folder = scratchDir();
  const activity = createFolderActivity({ env: { CC_TEST_FAKE_CLI: "1" }, dataRoot: data });
  assert.equal(activity.enabled, false);
  activity.noteSession("x"); activity.endOwn(activity.beginOwn(folder)); activity.watchFolders([folder]);
  assert.deepEqual(activity.outside(folder), []);
  assert.equal(existsSync(join(data, "config")), false, "no file was written");
  activity.closeWatchers();
});

test("snooze: Continue anyway quiets exactly what was shown for 10 minutes; a new session asks again; a leader-started run is told once", () => {
  const home = scratchDir(), data = scratchDir();
  let clock = Date.now();
  const activity = createFolderActivity({ env: {}, dataRoot: data, home, now: () => clock });
  codexRecord(home, SAME, "x-1", clock - 5_000);
  let pending = activity.pending("tab-a", TAB);
  assert.deepEqual(keys(pending), ["x-1"]);
  activity.remember("tab-a", pending);
  codexRecord(home, SAME, "x-2", clock - 1_000); // appears after the person was shown the list
  activity.snoozeShown("tab-a");
  assert.deepEqual(keys(activity.pending("tab-a", TAB)), ["x-2"], "the one never shown asks again");
  assert.deepEqual(keys(activity.pending("tab-b", TAB)), ["x-1", "x-2"], "another tab is asked on its own");
  clock += 9 * 60_000 + 59_000;
  codexRecord(home, SAME, "x-1", clock - 1_000); // x-1 is still active
  assert.ok(!keys(activity.pending("tab-a", TAB)).includes("x-1"), "still quiet just before 10 minutes");
  clock += 2_000;
  codexRecord(home, SAME, "x-1", clock - 1_000);
  assert.ok(keys(activity.pending("tab-a", TAB)).includes("x-1"), "asks again after 10 minutes");
  // The leader-started notice: once per session per 10 minutes.
  codexRecord(home, SAME, "x-2", clock - 1_000);
  assert.deepEqual(keys(activity.toAnnounce("tab-c", TAB)), ["x-1", "x-2"]);
  assert.deepEqual(activity.toAnnounce("tab-c", TAB), [], "not told twice");
  clock += 10 * 60_000 + 1_000;
  codexRecord(home, SAME, "x-1", clock - 1_000);
  assert.deepEqual(keys(activity.toAnnounce("tab-c", TAB)), ["x-1"], "told again after 10 minutes");
});

// ---- the catch-all: a real fs.watch, which can fire late or in bursts, so every wait retries ----
async function until(condition: () => boolean, label: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (condition()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${label}`);
}
function watched(): { activity: ReturnType<typeof createFolderActivity>; folder: string; changed: (folder?: string) => boolean } {
  const activity = createFolderActivity({ env: {}, dataRoot: scratchDir(), home: scratchDir() });
  const folder = scratchDir();
  activity.watchFolders([folder]);
  return { activity, folder, changed: (target = folder) => activity.outside(target).some((item) => item.tool === null) };
}

test("catch-all: a file written while no agent of ours is working is reported as 'something outside', with a time and no file name", async () => {
  const { activity, folder, changed } = watched();
  try {
    writeFileSync(join(folder, "a.txt"), "x");
    await until(changed, "the change");
    const [item] = activity.outside(folder);
    assert.deepEqual([item.tool, item.sessionKey], [null, "files-changed"]);
    assert.deepEqual(Object.keys(item).sort(), ["lastActiveAt", "sessionKey", "tool"], "only a time is kept, never a file list");
    assert.ok(Math.abs(item.lastActiveAt - Date.now()) < 5_000);
  } finally { activity.closeWatchers(); }
});

test("catch-all: .git, node_modules and .command-center changes are ignored; a real file in the same folder still registers", async () => {
  const { activity, folder, changed } = watched();
  try {
    for (const dir of [".git", "node_modules/pkg", ".command-center/tab"]) { mkdirSync(join(folder, dir), { recursive: true }); writeFileSync(join(folder, dir, "x.txt"), "x"); }
    await sleep(700);
    assert.equal(changed(), false, "ignored folders changed, nothing registered");
    writeFileSync(join(folder, "real.txt"), "x");
    await until(changed, "the real file after the ignored ones (control: the watcher is alive)");
  } finally { activity.closeWatchers(); }
});

test("catch-all: the app's own data folder inside a watched folder is ignored (chats, logs and config are not an outsider); a neighbour file still registers", async () => {
  const folder = scratchDir(), dataRoot = join(folder, "app-data");
  mkdirSync(join(dataRoot, "chats"), { recursive: true });
  const activity = createFolderActivity({ env: {}, dataRoot, home: scratchDir() });
  activity.watchFolders([folder]);
  try {
    writeFileSync(join(dataRoot, "chats", "tab.jsonl"), "x");
    await sleep(700);
    assert.deepEqual(activity.outside(folder), [], "the app's own files do not count");
    writeFileSync(join(folder, "neighbour.txt"), "x");
    await until(() => activity.outside(folder).some((item) => item.tool === null), "the neighbour file (control: the watcher is alive)");
  } finally { activity.closeWatchers(); }
});

test("catch-all: run from source (the data root IS the watched folder) only the app's own files are skipped; an edit to a source file still warns", async () => {
  const folder = scratchDir();
  for (const dir of ["chats", "logs", "config", "server"]) mkdirSync(join(folder, dir), { recursive: true });
  const activity = createFolderActivity({ env: {}, dataRoot: folder, home: scratchDir() });
  activity.watchFolders([folder]);
  try {
    // Everything the app writes under its data root: none of it is an outsider, and the log of what was printed shows the watch is alive below.
    for (const own of ["chats/tab.jsonl", "logs/run.log", "config/own-sessions.json", "config/own-sessions.json.tmp", "config/workspaces.json", "settings.json", "requests.json.1.tmp", ".cc-test-1/x.txt"]) {
      mkdirSync(dirname(join(folder, own)), { recursive: true });
      writeFileSync(join(folder, own), "x");
    }
    await sleep(700);
    assert.deepEqual(activity.outside(folder), [], "the app's own files do not count");
    writeFileSync(join(folder, "server", "index.ts"), "x");
    await until(() => activity.outside(folder).some((item) => item.tool === null), "the source file (control: the watcher is alive and the repo is not ignored)");
  } finally { activity.closeWatchers(); }
});

test("catch-all: files changing under one of our own agents (or just after it) are its own; an unrelated watched folder in the same instance still registers", async () => {
  const activity = createFolderActivity({ env: {}, dataRoot: scratchDir(), home: scratchDir() });
  const mine = scratchDir(), elsewhere = scratchDir();
  activity.watchFolders([mine, elsewhere]);
  try {
    const run = activity.beginOwn(mine);
    writeFileSync(join(mine, "from-the-run.txt"), "x");
    writeFileSync(join(elsewhere, "control.txt"), "x");
    await until(() => activity.outside(elsewhere).some((item) => item.tool === null), "the control change in the folder no agent of ours works in");
    await sleep(500);
    assert.deepEqual(activity.outside(mine), [], "the run's own file is not an outsider");
    activity.endOwn(run);
    writeFileSync(join(mine, "just-after.txt"), "x"); // written a moment after the run was reported over
    await sleep(700);
    assert.deepEqual(activity.outside(mine), [], "a flush just after the run ended is still its own");
  } finally { activity.closeWatchers(); }
});

test("catch-all: another tab on the same folder is one of our agents too (a window opened for the folder covers the whole folder)", async () => {
  const activity = createFolderActivity({ env: {}, dataRoot: scratchDir(), home: scratchDir() });
  const folder = scratchDir(), child = join(folder, "sub"); mkdirSync(child);
  activity.watchFolders([folder]);
  try {
    activity.beginOwn(child); // another tab, working in a folder inside this one
    writeFileSync(join(child, "x.txt"), "x");
    await sleep(700);
    assert.deepEqual(activity.outside(folder), []);
  } finally { activity.closeWatchers(); }
});

test("catch-all: closing the watch stops it, and changing the folder list closes the folders that left", async () => {
  const activity = createFolderActivity({ env: {}, dataRoot: scratchDir(), home: scratchDir() });
  const a = scratchDir(), b = scratchDir();
  activity.watchFolders([a, b]);
  try {
    activity.watchFolders([b]); // a left
    writeFileSync(join(a, "x.txt"), "x");
    writeFileSync(join(b, "y.txt"), "y");
    await until(() => activity.outside(b).some((item) => item.tool === null), "the change in the folder that stayed");
    await sleep(400);
    assert.deepEqual(activity.outside(a), [], "the folder that left is no longer watched");
    activity.closeWatchers();
    assert.equal(activity.watchedCount(), 0, "no watcher is left");
    writeFileSync(join(b, "z.txt"), "z");
    await sleep(500);
    assert.deepEqual(activity.outside(b), [], "after close everything is forgotten and nothing records");
  } finally { activity.closeWatchers(); }
});

test("catch-all: a process that opens the watch and never closes it still exits on its own (the watcher never holds a server or `npm test` open)", () => {
  const folder = scratchDir(), data = scratchDir(), home = scratchDir();
  const url = pathToFileURL(join(process.cwd(), "server", "folder-activity.ts")).href;
  const script = `import { createFolderActivity } from ${JSON.stringify(url)};
const activity = createFolderActivity({ env: {}, dataRoot: ${JSON.stringify(data)}, home: ${JSON.stringify(home)} });
activity.watchFolders([${JSON.stringify(folder)}]);
console.log("watching");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.error, undefined, `the process ended on its own: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /watching/);
});

test("catch-all: a drive root is never watched (it would watch the whole drive); a normal folder is, and leaving the list stops watching it", () => {
  const activity = createFolderActivity({ env: {}, dataRoot: scratchDir(), home: scratchDir() });
  const folder = scratchDir();
  try {
    activity.watchFolders(["C:\\", folder]);
    assert.equal(activity.watchedCount(), 1, "only the real folder");
    activity.watchFolders([]);
    assert.equal(activity.watchedCount(), 0);
  } finally { activity.closeWatchers(); }
});
