// Exclusive lock for scripts/mutation-proof.mjs. The sweep works in a disposable copy, but its start-up deletes every older
// ".cc-test-mutations-*" folder and its cleanup stops processes by folder name, so a second sweep running at the same time would
// delete the first one's live copy. This is dev tooling only, same-user, same-machine: the lock file is created exclusively
// ("wx"), which closes the check-then-write race, and is not a security boundary.
import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process, genuinely dead. Any other error (e.g. EPERM,
    // permission denied to signal it) means it exists but we can't touch it --
    // still alive, so still treated as held.
    return err.code !== "ESRCH";
  }
}

// When the process with this pid started (ISO string), or null when it can't be told. A pid that is alive but started at a different
// time than the lock recorded is another program that reused the number, not the sweep.
export function processStart(pid) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const text = result.status === 0 ? String(result.stdout).trim() : "";
  return text || null;
}

// Pure decision, no filesystem: given the lock file's parsed content (or
// null if there is none), a way to check whether that pid is alive and a way
// to read when it started, decides whether a new acquire may proceed. Kept
// separate from acquireLock so a test can prove every branch without ever
// creating a real lock file or a real dead/alive process.
export function evaluateLock(existing, aliveCheck, startOf = () => null) {
  if (!existing) return { ok: true };
  if (!aliveCheck(existing.pid)) return { ok: true, stale: true };
  // Alive, but not the process that took the lock: Windows reuses pids. Unknown start times (an old lock without one, or a lookup that
  // failed) keep the lock held, which is the safe side.
  const now = existing.created ? startOf(existing.pid) : null;
  if (now && now !== existing.created) return { ok: true, stale: true };
  return {
    ok: false,
    error: `mutation-proof is already running (pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}). Refusing to start a second sweep -- its start-up would delete the other sweep's working copy.`,
  };
}

// The parsed lock, null for an abandoned unreadable one, or throws naming the path for one that may still be mid-write.
function readLock(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (err) { if (err.code === "ENOENT") return undefined; throw err; }
  try {
    const parsed = JSON.parse(text);
    if (!Number.isInteger(parsed?.pid)) throw new Error("no pid recorded");
    return parsed;
  } catch (err) {
    // A sweep that is starting right now writes the file in two steps (create, fill), so an empty file is only abandoned once it is old.
    if (Date.now() - statSync(path).mtimeMs > 60_000) return null;
    throw new Error(`${path}: the lock file is unreadable (${err.message}). If no sweep is running, delete it.`);
  }
}

// Removes a lock this caller judged stale. Two acquirers can judge the same stale lock at once: the first removes it and takes a fresh
// lock, and the second would then delete that live lock from its older judgement. So removal happens under an exclusive recovery lock,
// and the lock is read and judged again inside it. Returns after one try: the caller loops and re-reads whatever is there now.
function recoverStale(path, pid, aliveCheck, startOf, read) {
  const guard = `${path}.recover`;
  try { writeFileSync(guard, String(pid), { flag: "wx" }); }
  catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Another acquirer is recovering right now; one that died mid-recovery leaves the guard behind, so an old one is abandoned.
    try { if (Date.now() - statSync(guard).mtimeMs > 60_000) unlinkSync(guard); } catch { /* gone already */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    return;
  }
  try {
    // No file at the re-read means someone else already removed it, and a lock created since is theirs and live: remove nothing,
    // the caller loops and tries the exclusive create again.
    const held = read(path);
    if (held !== undefined && evaluateLock(held, aliveCheck, startOf).ok) {
      try { unlinkSync(path); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  } finally {
    try { unlinkSync(guard); } catch { /* already gone */ }
  }
}

// Throws (never returns false) so a caller can't accidentally ignore a
// refusal the way a boolean return invites.
// readUnderGuard is a seam for the tests only: it is the re-read inside the recovery lock.
export function acquireLock(path, pid = process.pid, aliveCheck = isPidAlive, startOf = processStart, readUnderGuard = readLock) {
  const body = JSON.stringify({ pid, startedAt: Date.now(), created: startOf(pid) });
  for (let attempt = 0; attempt < 40; attempt++) {
    try { writeFileSync(path, body, { flag: "wx" }); return; } catch (err) { if (err.code !== "EEXIST") throw err; }
    const decision = evaluateLock(readLock(path), aliveCheck, startOf);
    if (!decision.ok) throw new Error(decision.error);
    // A stale lock (dead pid, reused pid or an abandoned unreadable file): remove it under the recovery lock and take the lock again.
    recoverStale(path, pid, aliveCheck, startOf, readUnderGuard);
  }
  throw new Error(`${path}: could not take the lock, another sweep keeps creating it`);
}

export function releaseLock(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone (never acquired, or already released): nothing to clean up.
  }
}
