import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root.ts";
import { parseLogFilename, listSeatRuns, formatExitMarker, parseOutcome, readTail, HISTORY_TAIL_BYTES, HISTORY_FULL_MAX_BYTES } from "../server/history.ts";

// ---- parseLogFilename ----

test("parseLogFilename: extracts seatId and timestamp from a normal log name", () => {
  assert.deepEqual(parseLogFilename("sonny-1788652509301.log"), { seatId: "sonny", timestamp: 1788652509301 });
});

test("parseLogFilename: a seat id containing hyphens (e.g. underground-coder) is kept whole", () => {
  assert.deepEqual(parseLogFilename("underground-coder-1788652509301.log"), { seatId: "underground-coder", timestamp: 1788652509301 });
});

test("parseLogFilename: rejects non-log names and a non-numeric timestamp", () => {
  for (const name of ["sonny-1788652509301.brief.txt", "sonny.log", "sonny-abc.log", "not-a-log-at-all"]) {
    assert.equal(parseLogFilename(name), null, name);
  }
});

// ---- listSeatRuns: pure over fabricated filenames/stats ----

test("listSeatRuns: newest first", () => {
  const stats = new Map([
    ["sonny-100.log", { size: 10, mtimeMs: 100 }],
    ["sonny-300.log", { size: 10, mtimeMs: 300 }],
    ["sonny-200.log", { size: 10, mtimeMs: 200 }],
  ]);
  const entries = listSeatRuns("sonny", [...stats.keys()], stats);
  assert.deepEqual(entries.map((e) => e.timestamp), [300, 200, 100]);
});

test("listSeatRuns: filters to the requested seat only, ignoring other seats' logs", () => {
  const stats = new Map([
    ["sonny-100.log", { size: 1, mtimeMs: 100 }],
    ["sol-200.log", { size: 1, mtimeMs: 200 }],
  ]);
  const entries = listSeatRuns("sonny", [...stats.keys()], stats);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].seatId, "sonny");
});

test("listSeatRuns: pairs a log with its sibling brief file when present, null when absent", () => {
  const stats = new Map([
    ["sonny-100.log", { size: 1, mtimeMs: 100 }],
    ["sonny-200.log", { size: 1, mtimeMs: 200 }],
  ]);
  const filenames = [...stats.keys(), "sonny-100.brief.txt"]; // only 100 has a brief
  const entries = listSeatRuns("sonny", filenames, stats);
  assert.equal(entries.find((e) => e.timestamp === 100).briefFile, "sonny-100.brief.txt");
  assert.equal(entries.find((e) => e.timestamp === 200).briefFile, null);
});

test("listSeatRuns: a log with no matching stat entry (unreadable/raced away) is skipped, not thrown", () => {
  const stats = new Map([["sonny-100.log", { size: 1, mtimeMs: 100 }]]);
  let entries: ReturnType<typeof listSeatRuns> = [];
  assert.doesNotThrow(() => { entries = listSeatRuns("sonny", ["sonny-100.log", "sonny-200.log"], stats); }, "a log whose stat is missing does not throw");
  assert.deepEqual(entries.map((e) => e.timestamp), [100]);
});

// ---- formatExitMarker / parseOutcome: one shared format ----

test("formatExitMarker + parseOutcome round-trip for done and failed, with and without an exit code", () => {
  assert.deepEqual(parseOutcome(formatExitMarker("done", 0)), { status: "done", exitCode: 0 });
  assert.deepEqual(parseOutcome(formatExitMarker("failed", 1)), { status: "failed", exitCode: 1 });
  assert.deepEqual(parseOutcome(formatExitMarker("failed")), { status: "failed", exitCode: null });
});

test("parseOutcome: a log with no marker (still running, or the marker is outside this tail) reports null, not a crash", () => {
  assert.equal(parseOutcome(""), null);
  assert.equal(parseOutcome("some ordinary agent output\nwith no marker at all\n"), null);
});

test("parseOutcome: only reads the marker from the END of the text, ignoring an unrelated earlier mention", () => {
  const tail = `some output mentioning [exit] status=done code=0 mid-stream\n${formatExitMarker("failed", 2)}`;
  assert.deepEqual(parseOutcome(tail), { status: "failed", exitCode: 2 });
});

// ---- readTail: real temp files, never the whole file for a huge one ----

const dir = tempRoot();

test("readTail: a small file is read whole and reports not truncated", async () => {
  const path = join(dir, "small.log");
  writeFileSync(path, "hello world");
  const result = await readTail(path, 1024);
  assert.equal(result.text, "hello world");
  assert.equal(result.truncated, false);
  assert.equal(result.totalBytes, 11);
});

test("readTail: a file larger than the cap is truncated to exactly the last maxBytes", async () => {
  const path = join(dir, "big.log");
  const content = "a".repeat(1000) + "b".repeat(50); // last 50 bytes are 'b'
  writeFileSync(path, content);
  const result = await readTail(path, 50);
  assert.equal(result.text, "b".repeat(50));
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, 1050);
});

test("readTail: an empty file is not truncated and yields empty text", async () => {
  const path = join(dir, "empty.log");
  closeSync(openSync(path, "w"));
  const result = await readTail(path);
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
  assert.equal(result.totalBytes, 0);
});

test("readTail: defaults to HISTORY_TAIL_BYTES when no cap is given", async () => {
  const path = join(dir, "default-cap.log");
  writeFileSync(path, "x".repeat(HISTORY_TAIL_BYTES + 100));
  const result = await readTail(path);
  assert.equal(result.text.length, HISTORY_TAIL_BYTES);
  assert.equal(result.truncated, true);
});

test("readTail: a missing file rejects rather than returning an empty/fake result", async () => {
  await assert.rejects(readTail(join(dir, "does-not-exist.log")));
});

test("readTail: a maxBytes larger than the file returns the whole file, untruncated", async () => {
  const path = join(dir, "small-again.log");
  writeFileSync(path, "abc");
  const result = await readTail(path, 10_000_000);
  assert.equal(result.text, "abc");
  assert.equal(result.truncated, false);
});

// item 6: the explicit "Load full output" escape hatch past HISTORY_TAIL_BYTES
// still needs a hard ceiling of its own -- a multi-gigabyte log must never be
// read whole just because the user asked for "everything".
test("HISTORY_FULL_MAX_BYTES: an explicit 'full' request still has a hard ceiling, never the entire file unconditionally", async () => {
  const path = join(dir, "huge-full.log");
  writeFileSync(path, "y".repeat(HISTORY_FULL_MAX_BYTES + 100));
  const result = await readTail(path, HISTORY_FULL_MAX_BYTES);
  assert.equal(result.text.length, HISTORY_FULL_MAX_BYTES);
  assert.equal(result.truncated, true);
});

test("readTail: a cut inside a multi-byte character drops its leftover bytes instead of decoding to U+FFFD, and a cut on a boundary keeps the character", async () => {
  const path = join(dir, "multibyte.log");
  writeFileSync(path, "a\u20ACb\u{1F600}c"); // bytes: a | E2 82 AC | b | F0 9F 98 80 | c  (10 bytes)
  const inEmoji = await readTail(path, 3); // last 3 bytes = 98 80 63: the tail of the emoji
  assert.equal(inEmoji.text, "c");
  assert.equal(inEmoji.truncated, true);
  assert.equal(inEmoji.totalBytes, 10);
  const inEuro = await readTail(path, 8); // starts on 82 AC, the last two bytes of the euro sign
  assert.equal(inEuro.text, "b\u{1F600}c");
  const onEuro = await readTail(path, 9); // starts exactly on E2: the character stays whole
  assert.equal(onEuro.text, "\u20ACb\u{1F600}c");
  const onEmoji = await readTail(path, 5); // starts exactly on F0
  assert.equal(onEmoji.text, "\u{1F600}c");
  const whole = await readTail(path, 10); // cap equals the file: nothing is cut, nothing skipped
  assert.equal(whole.text, "a\u20ACb\u{1F600}c");
  assert.equal(whole.truncated, false);
});
