import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root.ts";
import { isPidAlive, evaluateLock, acquireLock, releaseLock, processStart } from "../scripts/lock.mjs";

const dir = tempRoot();

// ---- evaluateLock: pure decision, no filesystem ----

test("evaluateLock: no existing lock permits acquiring", () => {
  assert.deepEqual(evaluateLock(null, () => true), { ok: true });
});

test("evaluateLock: an existing lock held by a LIVE pid refuses, naming the pid and start time", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const result = evaluateLock({ pid: 4242, startedAt }, () => true);
  assert.equal(result.ok, false);
  assert.match(result.error, /4242/);
  assert.match(result.error, /2026-01-01/);
});

test("evaluateLock: an existing lock from a DEAD pid is recoverable (stale)", () => {
  const result = evaluateLock({ pid: 9999, startedAt: Date.now() }, () => false);
  assert.deepEqual(result, { ok: true, stale: true });
});

// ---- isPidAlive: the current process is alive; a pid that doesn't exist is not ----

test("isPidAlive: the current process reports alive", () => {
  assert.equal(isPidAlive(process.pid), true);
});

test("isPidAlive: an implausible pid reports not alive", () => {
  // Not a security-relevant guarantee, just an ESRCH-shaped probe: a pid this
  // large cannot be a real Windows process id.
  assert.equal(isPidAlive(999_999_999), false);
});

// ---- acquireLock / releaseLock: real files in a temp dir ----

test("acquireLock: writes a lock file naming this process; releaseLock removes it", () => {
  const path = join(dir, "a.lock");
  acquireLock(path, 1234, () => true, () => "T1");
  assert.ok(existsSync(path));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pid, 1234);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).created, "T1", "the lock records when the holder started");
  releaseLock(path);
  assert.equal(existsSync(path), false);
});

test("acquireLock: a second acquire fails while the first is still held (live pid)", () => {
  const path = join(dir, "b.lock");
  acquireLock(path, 1111, () => true, () => null);
  assert.throws(() => acquireLock(path, 2222, () => true, () => null), /already running/);
  // The lock must still name the FIRST holder, not have been overwritten by the refused attempt.
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 1111);
  releaseLock(path);
});

test("acquireLock: a stale lock (dead pid) is recovered and overwritten, not refused", () => {
  const path = join(dir, "c.lock");
  writeFileSync(path, JSON.stringify({ pid: 5555, startedAt: Date.now() - 100000 }));
  acquireLock(path, 6666, () => false, () => null); // the recorded pid 5555 is reported dead
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 6666);
  releaseLock(path);
});

test("releaseLock: releasing a lock that was never acquired is a harmless no-op", () => {
  assert.doesNotThrow(() => releaseLock(join(dir, "never-existed.lock")));
});

// ---- a reused pid, and an empty or corrupt lock ----

test("evaluateLock: a live pid that started at a different time than the lock recorded is another program, so the lock is stale", () => {
  const lock = { pid: 4242, startedAt: Date.now(), created: "2026-10-13T08:00:00.0000000Z" };
  assert.deepEqual(evaluateLock(lock, () => true, () => "2026-10-13T09:30:00.0000000Z"), { ok: true, stale: true });
});

test("evaluateLock: the same start time, an unknown start time, or an old lock with no start time keeps the lock held", () => {
  const lock = { pid: 4242, startedAt: Date.now(), created: "2026-10-13T08:00:00.0000000Z" };
  assert.equal(evaluateLock(lock, () => true, () => lock.created).ok, false, "same process");
  assert.equal(evaluateLock(lock, () => true, () => null).ok, false, "start time unknown: safe side");
  assert.equal(evaluateLock({ pid: 4242, startedAt: Date.now() }, () => true, () => "anything").ok, false, "a lock without a start time cannot be judged");
});

test("acquireLock: a lock whose pid was reused by another program is recovered through the real read of the file", () => {
  const path = join(dir, "reused.lock");
  writeFileSync(path, JSON.stringify({ pid: 7777, startedAt: Date.now(), created: "old-start" }));
  acquireLock(path, 8888, () => true, (pid) => (pid === 7777 ? "new-start" : "mine"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 8888);
  releaseLock(path);
});

test("acquireLock: a fresh empty lock file is refused with its path, not a bare SyntaxError", () => {
  const path = join(dir, "empty.lock");
  writeFileSync(path, "");
  assert.throws(() => acquireLock(path, 1, () => false, () => null), (err: Error) => err.message.includes(path) && /unreadable/.test(err.message) && !(err instanceof SyntaxError));
  assert.equal(readFileSync(path, "utf8"), "", "a lock that may be mid-write is left alone");
  releaseLock(path);
});

test("acquireLock: an old corrupt lock file is abandoned and replaced", () => {
  for (const [name, body] of [["old-empty.lock", ""], ["old-corrupt.lock", "{not json"], ["old-nopid.lock", "{}"]]) {
    const path = join(dir, name);
    writeFileSync(path, body);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path, old, old);
    assert.doesNotThrow(() => acquireLock(path, 4321, () => true, () => null), name);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 4321, name);
    releaseLock(path);
  }
});

test("processStart: the current process has a stable start time, an implausible pid has none", { skip: process.platform !== "win32" }, () => {
  const first = processStart(process.pid);
  assert.match(String(first), /^\d{4}-\d\d-\d\dT/);
  assert.equal(processStart(process.pid), first);
  assert.equal(processStart(999_999_999), null);
});

test("acquireLock: two acquirers that both judged the same stale lock never both end up holding it", () => {
  const path = join(dir, "race.lock");
  writeFileSync(path, JSON.stringify({ pid: 5555, startedAt: Date.now() - 100000 }));
  let nested = false;
  // While acquirer A is still deciding that pid 5555 is dead, acquirer B runs to completion: it sees the same stale lock, removes it
  // and takes a live lock. A then acts on its older judgement.
  const alive = (pid: number) => {
    if (pid !== 5555) return true;
    if (!nested) { nested = true; acquireLock(path, 2222, alive, () => null); }
    return false;
  };
  assert.throws(() => acquireLock(path, 3333, alive, () => null), /already running .pid 2222/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 2222, "B's live lock was not deleted by A");
  assert.equal(existsSync(path + ".recover"), false, "the recovery lock is released");
  releaseLock(path);
});

test("acquireLock: a recovery lock left behind by a sweep that died is abandoned once it is old", () => {
  const path = join(dir, "guard.lock");
  writeFileSync(path, JSON.stringify({ pid: 5555, startedAt: Date.now() - 100000 }));
  writeFileSync(path + ".recover", "9");
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(path + ".recover", old, old);
  assert.doesNotThrow(() => acquireLock(path, 6666, () => false, () => null));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 6666);
  assert.equal(existsSync(path + ".recover"), false);
  releaseLock(path);
});

test("acquireLock: while another acquirer holds the recovery lock, a stale lock is left alone and the acquire gives up", () => {
  const path = join(dir, "guarded.lock");
  writeFileSync(path, JSON.stringify({ pid: 5555, startedAt: Date.now() - 100000 }));
  writeFileSync(path + ".recover", "9"); // fresh: another acquirer is in the middle of recovering
  assert.throws(() => acquireLock(path, 6666, () => false, () => null), /could not take the lock/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 5555, "the lock is not touched while the recovery lock is held by someone else");
  assert.equal(existsSync(path + ".recover"), true, "and the other acquirer's recovery lock is not removed");
  rmSync(path + ".recover"); releaseLock(path);
});

test("acquireLock: when the re-read under the recovery lock finds no file, a lock created right after is never deleted", () => {
  const path = join(dir, "absent.lock");
  writeFileSync(path, JSON.stringify({ pid: 5555, startedAt: Date.now() - 100000 }));
  // Acquirer B removed the stale lock before A's re-read saw it, and takes its live lock right after that read, before A would remove anything.
  const reread = () => {
    rmSync(path);
    writeFileSync(path, JSON.stringify({ pid: 2222, startedAt: Date.now() }));
    return undefined;
  };
  assert.throws(() => acquireLock(path, 3333, (pid: number) => pid !== 5555, () => null, reread), /already running .pid 2222/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 2222, "B's live lock was not deleted by A");
  assert.equal(existsSync(path + ".recover"), false);
  releaseLock(path);
});
