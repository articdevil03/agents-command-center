import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// Another agent working in a tab's folder beside Command Center can undo or overwrite its work. This finds such sessions from what each tool
// records about itself (file times and the session's folder, never its messages) and from a watch on the folder for files changing under no agent of ours.
export const ACTIVE_WINDOW_MS = 2 * 60_000;
export const SNOOZE_MS = 10 * 60_000;
// A CLI may flush its last write just after its run is reported over.
const OWN_SLACK_MS = 10_000;
const OWN_KEEP_MS = 10 * 60_000;
// A session id is unique, so keeping it cannot hide a stranger: a leader silent through one long tool call must not lose its id (windows, which can, stay short).
const OWN_ID_KEEP_MS = 7 * 24 * 60 * 60_000;
// A window nobody closed (a lost end event) must not hide outside work for ever.
const OPEN_WINDOW_MAX_MS = 6 * 60 * 60_000;
const CODEX_FIRST_LINE_MAX = 1 << 20;
export const FILES_CHANGED_KEY = "files-changed";

export type Tool = "Claude Code" | "Codex" | "OpenCode";
// `writer` marks another Command Center tab's seat that is writing in a related folder (not an outside tool): the page words it from these.
export type Outside = { tool: Tool | null; sessionKey: string; lastActiveAt: number; writer?: { seatName: string; roleLabel: string; tabName: string } };
// A session seen on disk. `touches` says whether a Command Center window for the given folder covers the folder this session works in;
// `startedAt` is when the record was created (null when the tool gives no way to tell).
type Seen = Outside & { touches: (windowFolder: string) => boolean; startedAt: number | null };
type Window = { folder: string; start: number; end: number | null };
export type OwnSessions = {
  ids: Map<string, number>;
  windows: Map<number, Window>;
};

export function normFolder(path: string): string {
  let text = path.replace(/\\/g, "/").toLowerCase();
  while (text.length > 1 && text.endsWith("/") && !/^[a-z]:\/$/.test(text)) text = text.slice(0, -1);
  return text;
}
const withSlash = (text: string): string => (text.endsWith("/") ? text : `${text}/`);
// `path` is `root` itself or something inside it.
function within(path: string, root: string): boolean { const x = normFolder(path), y = normFolder(root); return x === y || x.startsWith(withSlash(y)); }
// Same folder, one inside the other, either way round; "c:/a/bc" is not inside "c:/a/b".
export function relatedFolders(a: string, b: string): boolean {
  const x = normFolder(a), y = normFolder(b);
  return x === y || y.startsWith(withSlash(x)) || x.startsWith(withSlash(y));
}
const slugOf = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
const withDash = (text: string): string => (text.endsWith("-") ? text : `${text}-`);
// ponytail: the slug turns every symbol into "-", so "a\b-c" and "a\b\c" look alike; an ambiguous lookalike warns (and can be dismissed). Read cwd from the file if that ever bites.
function slugRelated(a: string, b: string): boolean { return a === b || b.startsWith(withDash(a)) || a.startsWith(withDash(b)); }

// Where the tools keep their records. Under the test runner this is read ONLY from the test variable (stripped by electron/main.js), and never the real home.
export function activityHome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CC_TEST_FAKE_CLI === "1") return env.CC_TEST_FAKE_CLI_ACTIVITY_HOME || null;
  try { return homedir(); } catch { return null; }
}

function claudeSessions(home: string, tabFolder: string, now: number): Seen[] {
  const root = join(home, ".claude", "projects");
  const mine = slugOf(tabFolder), found: Seen[] = [];
  // The slug's case varies on this machine, so the folder is matched from a listing, never computed and stat-ed.
  for (const dir of readdirSync(root)) {
    const slug = dir.toLowerCase();
    if (!slugRelated(mine, slug)) continue;
    // Only the top level: a subagent's file lives deeper and belongs to its parent session.
    let names: string[];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      let mtime: number, birth: number;
      try { const stat = statSync(join(root, dir, name)); mtime = stat.mtimeMs; birth = stat.birthtimeMs; } catch { continue; }
      if (now - mtime > ACTIVE_WINDOW_MS) continue;
      found.push({ tool: "Claude Code", sessionKey: name.slice(0, -".jsonl".length), lastActiveAt: mtime, startedAt: birth > 0 ? birth : null, touches: (windowFolder) => slugRelated(slugOf(windowFolder), slug) });
    }
  }
  return found;
}

function firstLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0, position = 0;
    while (total < CODEX_FIRST_LINE_MAX) {
      const buffer = Buffer.alloc(64 * 1024);
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline >= 0) { chunks.push(buffer.subarray(0, newline)); return Buffer.concat(chunks).toString("utf8"); }
      chunks.push(buffer.subarray(0, read)); total += read; position += read;
    }
    return null;
  } finally { closeSync(fd); }
}
const pad = (value: number): string => String(value).padStart(2, "0");
// Codex keeps writing a resumed session into its ORIGINAL day folder, so every day folder is looked at, not only today's and yesterday's.
// Those two are read on every check; the older ones (~100 folders, thousands of files) at most every OLD_SCAN_MS, from listings kept until the folder's own time changes.
const OLD_SCAN_MS = 30_000;
const dayListings = new Map<string, { mtimeMs: number; names: string[] }>();
const oldFresh = new Map<string, { at: number; paths: string[] }>();
const ROLLOUT = /^rollout-.*\.jsonl$/;
const numbered = (dir: string): string[] => readdirSync(dir).filter((name) => /^\d+$/.test(name));
function freshOldRollouts(sessions: string, recent: Set<string>, now: number): string[] {
  const cached = oldFresh.get(sessions);
  if (cached && Math.abs(now - cached.at) < OLD_SCAN_MS) return cached.paths;
  const paths: string[] = [];
  try {
    for (const year of numbered(sessions)) for (const month of numbered(join(sessions, year))) for (const day of numbered(join(sessions, year, month))) {
      const dir = join(sessions, year, month, day);
      if (recent.has(dir)) continue;
      try {
        const mtimeMs = statSync(dir).mtimeMs;
        let listing = dayListings.get(dir);
        if (!listing || listing.mtimeMs !== mtimeMs) { listing = { mtimeMs, names: readdirSync(dir).filter((name) => ROLLOUT.test(name)) }; dayListings.set(dir, listing); }
        for (const name of listing.names) {
          try { if (now - statSync(join(dir, name)).mtimeMs <= ACTIVE_WINDOW_MS) paths.push(join(dir, name)); } catch { /* gone since it was listed */ }
        }
      } catch { /* an unreadable day is skipped */ }
    }
  } catch { /* no sessions folder */ }
  oldFresh.set(sessions, { at: now, paths });
  return paths;
}
function codexSessions(home: string, tabFolder: string, now: number): Seen[] {
  const found: Seen[] = [];
  const sessions = join(home, ".codex", "sessions");
  const candidates: string[] = [], recent = new Set<string>();
  // The day folder follows local time, while the first line's own timestamp is UTC: days are named by the local date.
  for (const back of [0, 1]) {
    const day = new Date(now - back * 24 * 60 * 60_000);
    const dir = join(sessions, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    recent.add(dir);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) if (ROLLOUT.test(name)) candidates.push(join(dir, name));
  }
  // ponytail: a resumed old session shows up within OLD_SCAN_MS; a watch on the sessions folder would make it instant.
  candidates.push(...freshOldRollouts(sessions, recent, now));
  for (const path of candidates) {
    try {
      const stat = statSync(path), mtime = stat.mtimeMs;
      if (now - mtime > ACTIVE_WINDOW_MS) continue;
      const line = firstLine(path);
      const meta = line ? JSON.parse(line) : null;
      const cwd = meta?.type === "session_meta" ? meta.payload?.cwd : undefined;
      if (typeof cwd !== "string" || !relatedFolders(tabFolder, cwd)) continue;
      const id = typeof meta.payload.id === "string" ? meta.payload.id : basename(path);
      // The file's creation time, else the session_meta timestamp; if neither is known the start stays unknown.
      const stamp = Date.parse(String(meta.payload?.timestamp ?? meta.timestamp));
      found.push({ tool: "Codex", sessionKey: id, lastActiveAt: mtime, startedAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : Number.isFinite(stamp) ? stamp : null, touches: (windowFolder) => relatedFolders(windowFolder, cwd) });
    } catch { /* a record that cannot be read is skipped */ }
  }
  return found;
}

function opencodeSessions(home: string, tabFolder: string, now: number): Seen[] {
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) return [];
  // Read-only and closed straight away: this never writes to, or keeps open, the tool's own database.
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    type Row = { id: unknown; directory: unknown; time_updated: unknown; time_created?: unknown };
    let rows: Row[];
    // A database without the creation column still answers; those rows keep an unknown start.
    try { rows = db.prepare("select id, directory, time_updated, time_created from session where time_updated >= ?").all(now - ACTIVE_WINDOW_MS) as Row[]; }
    catch { rows = db.prepare("select id, directory, time_updated from session where time_updated >= ?").all(now - ACTIVE_WINDOW_MS) as Row[]; }
    const found: Seen[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.directory !== "string" || typeof row.time_updated !== "number") continue;
      const directory = row.directory;
      if (!relatedFolders(tabFolder, directory)) continue;
      found.push({ tool: "OpenCode", sessionKey: row.id, lastActiveAt: row.time_updated, startedAt: typeof row.time_created === "number" ? row.time_created : null, touches: (windowFolder) => relatedFolders(windowFolder, directory) });
    }
    return found;
  } finally { db.close(); }
}

// Command Center's own sessions: by id when a leader told us its session, and by window (folder, start, end) for everything else, because a crew run's
// CLI never tells us its session. A record CREATED and last touched inside a window of an overlapping folder is ours; one that was already running
// before the window opened (or an old one an outsider resumed) is not. An unknown start (no creation time) falls back to the last-touched rule alone.
// ponytail: an outside session STARTED during our own run in the same folder is still taken as ours, since crew CLIs give no id.
export function ownsRecord(own: OwnSessions, seen: Seen, now: number): boolean {
  if (own.ids.has(seen.sessionKey)) return true;
  for (const window of own.windows.values()) {
    const end = window.end ?? Math.min(now, window.start + OPEN_WINDOW_MAX_MS);
    const inside = (at: number) => at >= window.start - 1000 && at <= end + OWN_SLACK_MS;
    if (inside(seen.lastActiveAt) && (seen.startedAt === null || inside(seen.startedAt)) && seen.touches(window.folder)) return true;
  }
  return false;
}

// Never throws: any reader that fails (a missing folder, a locked database, a bad line) is skipped and the others still answer.
export function outsideActivity(tabFolder: string, own: OwnSessions, now: number, home: string | null): Outside[] {
  if (!home) return [];
  const seen: Seen[] = [];
  for (const read of [claudeSessions, codexSessions, opencodeSessions]) {
    try { seen.push(...read(home, tabFolder, now)); } catch { /* skipped: never blocks a message */ }
  }
  const unique = new Map<string, Outside>();
  for (const item of seen) {
    if (ownsRecord(own, item, now)) continue;
    unique.set(`${item.tool}:${item.sessionKey}`, { tool: item.tool, sessionKey: item.sessionKey, lastActiveAt: item.lastActiveAt });
  }
  return [...unique.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// What the app itself writes under its data root. Run from source the data root IS the repo, so only these are skipped: the rest of the repo is a real folder an outsider can edit.
const APP_DIRS = new Set(["chats", "logs", "scratch", "avatars", "config"]);
const APP_ROOT_FILE = /^(settings|requests|leader-check)\.json(\.|$)/;
function writtenByApp(path: string, dataRoot: string): boolean {
  if (!within(path, dataRoot)) return false;
  const [first = "", ...rest] = normFolder(path).slice(normFolder(dataRoot).length).split("/").filter(Boolean);
  // The data folder itself (its own time changes when a file is added inside it) is the app's too.
  return !first || APP_DIRS.has(first) || first.startsWith(".cc-test-") || (!rest.length && APP_ROOT_FILE.test(first));
}

export type FolderActivity = ReturnType<typeof createFolderActivity>;
export function createFolderActivity(options: { env: NodeJS.ProcessEnv; dataRoot: string; now?: () => number; home?: string | null }) {
  const clock = options.now ?? Date.now;
  const home = options.home !== undefined ? options.home : activityHome(options.env);
  const enabled = home !== null;
  const file = join(options.dataRoot, "config", "own-sessions.json");
  const own: OwnSessions = { ids: new Map(), windows: new Map() };
  let nextToken = 1;

  function prune(): void {
    const cutoff = clock() - OWN_KEEP_MS, idCutoff = clock() - OWN_ID_KEEP_MS;
    for (const [id, seenAt] of own.ids) if (seenAt < idCutoff) own.ids.delete(id);
    for (const [token, window] of own.windows) if (window.end !== null && window.end < cutoff) own.windows.delete(token);
  }
  function save(): void {
    if (!enabled) return;
    prune();
    const at = clock();
    const data = { ids: Object.fromEntries(own.ids), windows: [...own.windows.values()].map((window) => ({ ...window, end: window.end ?? at })) };
    const temp = `${file}.tmp`;
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(temp, JSON.stringify(data)); renameSync(temp, file); }
    catch { try { unlinkSync(temp); } catch { /* nothing to remove */ } }
  }
  // An unreadable file is treated as empty: the worst case is one warning against our own session.
  if (enabled) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const [id, seenAt] of Object.entries(data?.ids ?? {})) if (typeof seenAt === "number") own.ids.set(id, seenAt);
      for (const window of data?.windows ?? []) if (typeof window?.folder === "string" && Number.isFinite(window.start) && Number.isFinite(window.end)) own.windows.set(nextToken++, { folder: window.folder, start: window.start, end: window.end });
      prune();
    } catch { /* missing or damaged: empty */ }
  }

  function noteSession(id: string): void {
    if (!enabled || !id) return;
    const fresh = !own.ids.has(id);
    own.ids.set(id, clock());
    if (fresh) save();
  }
  function beginOwn(folder: string): number {
    const token = nextToken++;
    if (enabled) { own.windows.set(token, { folder, start: clock(), end: null }); save(); }
    return token;
  }
  function endOwn(token: number | undefined): void {
    const window = token === undefined ? undefined : own.windows.get(token);
    if (!window || window.end !== null) return;
    window.end = clock();
    save();
  }
  function endAllOwn(): void {
    let changed = false;
    for (const window of own.windows.values()) if (window.end === null) { window.end = clock(); changed = true; }
    if (changed) save();
  }
  // A file change under one of our own agents (or just after one ended) is theirs, not an outsider's.
  function coversChange(folder: string, at: number): boolean {
    for (const window of own.windows.values()) {
      const end = window.end ?? at;
      if (at >= window.start - 1000 && at <= end + OWN_SLACK_MS && relatedFolders(window.folder, folder)) return true;
    }
    return false;
  }

  // The catch-all: only the time of the last change per folder is kept, never a file list.
  const watchers = new Map<string, FSWatcher>();
  const lastChange = new Map<string, number>();
  const IGNORED = /(^|[\\/])(\.git|node_modules|\.command-center)([\\/]|$)/;
  function watchFolder(folder: string): void {
    const key = normFolder(folder);
    // A drive root would watch the whole drive.
    if (watchers.has(key) || dirname(folder) === folder) return;
    // A change under one of our own agents (or just after it) is theirs, not an outsider's: it is never recorded.
    const onChange = (_event: string, name: string | Buffer | null): void => {
      if (name && IGNORED.test(String(name))) return;
      if (name && writtenByApp(join(folder, String(name)), options.dataRoot)) return;
      const at = clock();
      if (!coversChange(folder, at)) lastChange.set(key, at);
    };
    try {
      const watcher = watch(folder, { recursive: true, persistent: false }, onChange); watcher.unref();
      watcher.on("error", () => closeWatcher(key));
      watchers.set(key, watcher);
    } catch { /* an unwatchable folder only loses the catch-all */ }
  }
  function closeWatcher(key: string): void {
    try { watchers.get(key)?.close(); } catch { /* already closed */ }
    watchers.delete(key); lastChange.delete(key);
  }
  function watchFolders(folders: string[]): void {
    if (!enabled) return;
    const wanted = new Set(folders.map(normFolder));
    for (const key of [...watchers.keys()]) if (!wanted.has(key)) closeWatcher(key);
    for (const folder of folders) watchFolder(folder);
  }
  function closeWatchers(): void { for (const key of [...watchers.keys()]) closeWatcher(key); }

  function outside(folder: string): Outside[] {
    if (!enabled) return [];
    const now = clock();
    const found = outsideActivity(folder, own, now, home);
    const changed = lastChange.get(normFolder(folder));
    if (changed !== undefined && now - changed <= ACTIVE_WINDOW_MS) found.push({ tool: null, sessionKey: FILES_CHANGED_KEY, lastActiveAt: changed });
    return found;
  }

  // Per tab and session key: "Continue anyway" quiets that exact session for 10 minutes; a new session asks again.
  const snoozed = new Map<string, number>();
  const noticed = new Map<string, number>();
  const shown = new Map<string, string[]>();
  const slot = (tabId: string, key: string): string => `${tabId}\u0000${key}`;
  const quiet = (map: Map<string, number>, tabId: string, key: string): boolean => (map.get(slot(tabId, key)) ?? 0) > clock();
  function pending(tabId: string, folder: string, writers: Outside[] = []): Outside[] {
    return [...outside(folder), ...writers].filter((item) => !quiet(snoozed, tabId, item.sessionKey));
  }
  function remember(tabId: string, items: Outside[]): void { shown.set(tabId, items.map((item) => item.sessionKey)); }
  // Only what the person was shown is quieted.
  function snoozeShown(tabId: string): void {
    for (const key of shown.get(tabId) ?? []) snoozed.set(slot(tabId, key), clock() + SNOOZE_MS);
    shown.delete(tabId);
  }
  // For a leader-started run: what is active and has not been announced (or snoozed) in the last 10 minutes; announced here.
  function toAnnounce(tabId: string, folder: string, writers: Outside[] = []): Outside[] {
    const fresh = pending(tabId, folder, writers).filter((item) => !quiet(noticed, tabId, item.sessionKey));
    for (const item of fresh) noticed.set(slot(tabId, item.sessionKey), clock() + SNOOZE_MS);
    return fresh;
  }

  return { enabled, watchedCount: () => watchers.size, noteSession, beginOwn, endOwn, endAllOwn, watchFolders, closeWatchers, outside, pending, remember, snoozeShown, toAnnounce, own };
}
