// Crash catcher: ProcDump attached BY PID to a test server (or test process), so the next rare native death (0xC0000409) leaves the exact
// exception and a dump file. Never `procdump -x` (that would change the server's pid, stdout and kill path) and never kills a procdump:
// a debugger that dies can take its debuggee with it. ProcDump exits on its own when the process exits.
// Limits: the moments before the attach are not covered; a debugger can change timing enough to hide the bug, so a quiet gate is not proof.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Catcher = { label: string; chunks: Buffer[]; exited: Promise<void>; closed: boolean };
const catchers = new Map<number, Catcher>();
let noticed = false;
const notice = (why: string): void => { if (!noticed) { noticed = true; console.log(`crash catcher off: ${why}`); } };

// <repo>/../audits/crash-dumps, found by walking up to the folder named "app" (a mutation copy or .cc-test-* copy sits inside it), not under TEMP.
export function crashDumpDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6 && basename(dir).toLowerCase() !== "app"; i++) dir = dirname(dir);
  const base = basename(dir).toLowerCase() === "app" ? dir : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(base, "..", "audits", "crash-dumps");
}

// Keeps the newest `keep` *.dmp files directly in the folder and deletes the older ones, exact files only: never the folder, never a subfolder or a non-dump file.
export function pruneCrashDumps(dumpDir: string, keep = 10): void {
  try {
    const dumps = readdirSync(dumpDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.dmp$/i.test(e.name))
      .map((e) => ({ path: join(dumpDir, e.name), time: statSync(join(dumpDir, e.name)).mtimeMs })).sort((a, b) => b.time - a.time);
    for (const old of dumps.slice(keep)) { try { unlinkSync(old.path); } catch { /* in use: the next attach retries */ } }
  } catch { /* an unreadable folder must never fail a test */ }
}

export function crashCatcherDisabled(): string | null {
  if (process.platform !== "win32") return "not Windows";
  if (process.env.CC_NO_CRASH_CATCHER === "1") return "off by CC_NO_CRASH_CATCHER";
  return null;
}

// Starts procdump on a running pid. Never throws and never fails a test: a missing tool prints one line and does nothing.
export function attachCrashCatcher(pid: number | undefined, label: string, dumpDir: string = crashDumpDir()): void {
  if (!pid) return;
  const off = crashCatcherDisabled();
  if (off) return notice(off);
  if (catchers.get(pid)?.closed === false) return; // never two procdumps on one pid (the preload and temp-root.ts both attach a test file)
  try { mkdirSync(dumpDir, { recursive: true }); } catch { return notice("dump folder not writable"); }
  // CC_CRASH_CATCHER_LOG=<file>: one line per attach, so a run can prove which processes were watched.
  if (process.env.CC_CRASH_CATCHER_LOG) { try { appendFileSync(process.env.CC_CRASH_CATCHER_LOG, `${pid} ${label}\n`); } catch { /* a log must never fail a test */ } }
  pruneCrashDumps(dumpDir);
  let proc;
  try { proc = spawn("procdump", ["-accepteula", "-e", "-mm", String(pid), dumpDir], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { return notice("procdump not found"); }
  watchCatcher(pid, label, proc);
}

// Split from attachCrashCatcher so a test can hand in a fake procdump process. `close` (not `exit`) is the end: all of its output has been read by then.
export function watchCatcher(pid: number, label: string, proc: ChildProcess): void {
  const chunks: Buffer[] = [];
  const catcher: Catcher = { label, chunks, closed: false, exited: undefined as unknown as Promise<void> };
  catcher.exited = new Promise<void>((done) => { proc.once("close", () => { catcher.closed = true; done(); }); proc.once("error", (error: NodeJS.ErrnoException) => { catcher.closed = true; if (error.code === "ENOENT") notice("procdump not found"); done(); }); });
  proc.stdout!.on("data", (d: Buffer) => chunks.push(d)); proc.stderr!.on("data", (d: Buffer) => chunks.push(d));
  // It lives as long as its target; it must never hold the test process open (a test file attaches to itself).
  proc.unref(); (proc.stdout as unknown as { unref(): void }).unref(); (proc.stderr as unknown as { unref(): void }).unref();
  catchers.set(pid, catcher);
}

const text = (c: Catcher): string => Buffer.concat(c.chunks).toString("utf16le");

// Resolves true once procdump has printed that it is monitoring this pid, false when `ms` runs out first (or it ended without saying so).
export async function waitCatcherMonitoring(pid: number | undefined, ms = 30000): Promise<boolean> {
  const c = pid ? catchers.get(pid) : undefined;
  if (!c) return false;
  for (const end = Date.now() + ms; Date.now() < end && !c.closed; await new Promise((r) => setTimeout(r, 100))) {
    if (/Press Ctrl-C to end monitoring/.test(text(c))) return true;
  }
  return /Press Ctrl-C to end monitoring/.test(text(c));
}

// The exception lines and the dump path procdump reported for this pid, or "" when it saw no crash.
export function crashFacts(pid: number | undefined): string {
  const c = pid ? catchers.get(pid) : undefined;
  if (!c) return "";
  const lines = text(c).split(/\r?\n/).map((l) => l.replace(/\0/g, "").trim()).filter((l) => /Exception:|Unhandled:|Dump \d+ complete|Writing dump file|\.dmp/i.test(l));
  return lines.length ? `\ncrash catcher (${c.label}, pid ${pid}):\n${lines.slice(-15).join("\n")}` : "";
}

// After a death: give procdump a short bounded time to finish writing, then report. Never waits for ever, never kills it.
export async function crashFactsAfterDeath(pid: number | undefined, ms = 3000): Promise<string> {
  const c = pid ? catchers.get(pid) : undefined;
  if (c) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([c.exited, new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
    clearTimeout(timer);
  }
  return crashFacts(pid);
}

export function crashDumpPaths(pid: number | undefined): string[] {
  const c = pid ? catchers.get(pid) : undefined;
  if (!c) return [];
  return [...text(c).matchAll(/(?:Writing dump file|Dump \d+ initiated:)\s*(.+?\.dmp)/gi)].map((m) => m[1]!).filter((p) => existsSync(p));
}
