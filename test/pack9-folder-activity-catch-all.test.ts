// Pack 9, the readers and the catch-all (server/folder-activity.ts), part 2: persistence of own ids and windows, the snooze, and the folder watch (a real fs.watch). Everything runs on fake homes under the OS temp folder; the real servers (warning flow) are in pack9-server-*.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFolderActivity } from "../server/folder-activity.ts";
import { scratchDir } from "./temp-root.ts";
import { sleep, keys, codexRecord, TAB, SAME } from "./pack9-folder-activity-helpers.ts";

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
