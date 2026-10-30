// Pack 9, the readers (server/folder-activity.ts), part 1: which sessions of Claude Code, Codex and OpenCode count as "working in this folder", how Command Center's own sessions and windows are left out, and the registry. Everything runs on fake homes under the OS temp folder; the real servers (warning flow) are in pack9-server-*.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFolderActivity, outsideActivity, relatedFolders, activityHome, ACTIVE_WINDOW_MS, type OwnSessions } from "../server/folder-activity.ts";
import { scratchDir } from "./temp-root.ts";
import { codexRecord as plantCodexRecord } from "./codex-record.ts";
import { noOwn, keys, safely, claudeRecord, codexRecord, opencodeDb, TAB, SAME, PARENT, CHILD, OTHER, LOOKALIKE, SHORTER } from "./pack9-folder-activity-helpers.ts";

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

