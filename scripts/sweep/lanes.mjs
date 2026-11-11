import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MUTATION_DIR_PREFIX, TEMP_DIR_PREFIX } from "../mutation-proof.mjs";

// The sweep never imports app code (server/, public/, electron/, test/): if the app's own helpers are broken, the tool that checks them must still work.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const forward = (path) => path.split("\\").join("/");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const REMOVE_ATTEMPTS = 5;
const REMOVE_WAIT_MS = 200;

// ---- removal that never follows a link ----

// A busy entry (antivirus scan, a just-exited child) is retried a few times; returns false when it never went.
function removeEntry(remove, path) {
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
    try { remove(path); return true; } catch (err) {
      if (err.code === "ENOENT") return true;
      if (attempt < REMOVE_ATTEMPTS) sleep(REMOVE_WAIT_MS);
    }
  }
  return false;
}

// A link (symlink or junction) is removed as a link, a directory link by rmdir (unlink refuses a directory junction on some Windows builds).
function removeLink(path) {
  try { unlinkSync(path); } catch { rmdirSync(path); }
}

export function removeTree(target, within) {
  const [absTarget, absWithin] = [resolve(target), resolve(within)];
  const inside = relative(absWithin, absTarget);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`removeTree: ${absTarget} is not strictly inside ${absWithin}`);
  const result = { removed: 0, leftovers: [] };
  const count = (path, remove) => { if (removeEntry(remove, path)) result.removed++; else result.leftovers.push(path); };
  const walk = (path) => {
    let info;
    try { info = lstatSync(path); } catch (err) { if (err.code === "ENOENT") return; throw err; }
    if (info.isSymbolicLink()) return count(path, removeLink);
    if (!info.isDirectory()) return count(path, unlinkSync);
    for (const name of readdirSync(path)) walk(join(path, name));
    count(path, rmdirSync);
  };
  walk(absTarget);
  return result;
}

// ---- lanes: one disposable copy of the tree under test plus a private temp folder ----

// Every file under a copied path, read no-follow: a link inside the source throws, so a copy can never reach outside the repo.
function readTree(root, rel, into) {
  const info = lstatSync(join(root, rel));
  if (info.isSymbolicLink()) throw new Error(`createLane: ${rel} is a link; the sweep never copies through links`);
  if (info.isDirectory()) { for (const name of readdirSync(join(root, rel))) readTree(root, `${rel}/${name}`, into); } else into.set(forward(rel), readFileSync(join(root, rel)));
}

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function createLane(repoRoot, copiedPaths, index) {
  const lane = { index, dir: mkdtempSync(join(repoRoot, MUTATION_DIR_PREFIX)), temp: mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX)), source: repoRoot, copiedPaths, pristine: new Map(), hashes: new Map(), tracked: new Map() };
  try {
    for (const path of copiedPaths) readTree(repoRoot, forward(path), lane.pristine);
    for (const [file, bytes] of lane.pristine) { writeBytes(join(lane.dir, file), bytes); lane.hashes.set(file, sha256(bytes)); }
  } catch (err) {
    removeTree(lane.dir, repoRoot);
    removeTree(lane.temp, tmpdir());
    throw err;
  }
  return lane;
}

// NODE_TEST_CONTEXT is stripped too: set when the sweep itself runs under node --test (its own tests), it would make the inner node --test skip every file.
export function laneEnv(lane, red) {
  const { CC_DATA_DIR: _dataDir, CC_TEST_FORCE_PACKAGED: _forcePackaged, NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  return { ...env, TEMP: lane.temp, TMP: lane.temp, CC_MUTATION_PROOF: red ? "1" : "" };
}

export function readPristine(lane, file) {
  const bytes = lane.pristine.get(file);
  if (!bytes) throw new Error(`readPristine: ${file} is not in lane ${lane.index}'s copy`);
  return bytes;
}

// Writes are synchronous, but a spawned run has been seen reading stale content back on this filesystem, so every write is read back first.
export function writeVerified(lane, file, content) {
  const path = join(lane.dir, file);
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  for (let attempt = 1; attempt <= 5; attempt++) {
    writeBytes(path, expected);
    if (readFileSync(path).equals(expected)) return;
    console.log(`WARNING: ${path} did not read back as written (attempt ${attempt}/5), retrying`);
  }
  throw new Error(`${path}: content did not settle after 5 write/read-back attempts`);
}

// Runs after every row: what a red run wrote into the copy (real files such as config/*.json, a leaked folder) is put back or removed.
export function resyncLane(lane) {
  const report = { recopied: [], removed: [], leaked: [], tempLeftovers: [] };
  const wantedDirs = new Set(lane.copiedPaths.map(forward));
  for (const file of lane.pristine.keys()) for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) wantedDirs.add(dir);
  const seen = new Set();
  const visit = (rel) => {
    const abs = join(lane.dir, rel);
    let info;
    try { info = lstatSync(abs); } catch { return; }
    if (info.isSymbolicLink()) { removeEntry(removeLink, abs); report.removed.push(rel); }
    else if (info.isDirectory() && wantedDirs.has(rel)) readdirSync(abs).forEach((name) => visit(`${rel}/${name}`));
    else if (info.isDirectory()) { removeTree(abs, lane.dir); report.removed.push(rel); }
    else if (!lane.pristine.has(rel)) { unlinkSync(abs); report.removed.push(rel); }
    else { seen.add(rel); if (sha256(readFileSync(abs)) !== lane.hashes.get(rel)) { writeVerified(lane, rel, lane.pristine.get(rel)); report.recopied.push(rel); } }
  };
  lane.copiedPaths.forEach((path) => visit(forward(path)));
  for (const [file, bytes] of lane.pristine) if (!seen.has(file)) { writeVerified(lane, file, bytes); report.recopied.push(file); }
  const copiedRoots = new Set(lane.copiedPaths.map((path) => forward(path).split("/")[0]));
  for (const name of readdirSync(lane.dir)) if (!copiedRoots.has(name)) {
    removeTree(join(lane.dir, name), lane.dir);
    // Under node --test the app's data root is the lane folder, so chats/, logs/ and the like appear here on every real run: removed and noted, never a failure.
    // Only a leftover test-root folder (a test that did not clean up after itself) is a leak.
    (name.startsWith(".cc-test-") ? report.leaked : report.removed).push(name);
  }
  for (const name of readdirSync(lane.temp)) report.tempLeftovers.push(...removeTree(join(lane.temp, name), lane.temp).leftovers);
  return report;
}

// No process cleanup here: runTests guarantees its process tree is gone after every run (proctree.mjs), or it threw.
export function removeLane(lane) {
  const leftovers = [...removeTree(lane.dir, lane.source).leftovers, ...removeTree(lane.temp, tmpdir()).leftovers];
  if (!existsSync(join(lane.source, "node_modules"))) throw new Error(`removeLane: ${join(lane.source, "node_modules")} is gone after removing lane ${lane.index}`);
  return { leftovers };
}

// Start-up only: the lock guarantees no live sweep, so every older lane folder is a leftover of one that died.
export function cleanupLeftovers(repoRoot) {
  const result = { removed: [], leftovers: [] };
  for (const [parent, prefix] of [[repoRoot, MUTATION_DIR_PREFIX], [tmpdir(), TEMP_DIR_PREFIX]]) {
    for (const name of readdirSync(parent).filter((entry) => entry.startsWith(prefix))) {
      const { leftovers } = removeTree(join(parent, name), parent);
      result.removed.push(join(parent, name));
      result.leftovers.push(...leftovers);
    }
  }
  return result;
}

// ---- load budget ----

// FIFO on purpose: only the head of the queue is considered, so acquire(total) ("quiet": nothing else runs) cannot be starved by smaller later requests.
export function createSlots(total) {
  let used = 0;
  const waiting = [];
  const clamp = (count) => Math.min(Math.max(1, Math.trunc(count)), total);
  const admit = () => {
    while (waiting.length && used + waiting[0].count <= total) { const next = waiting.shift(); used += next.count; next.resolve(); }
  };
  return {
    total,
    acquire: (count) => new Promise((resolve) => { waiting.push({ count: clamp(count), resolve }); admit(); }),
    release(count) {
      if (clamp(count) > used) throw new Error(`createSlots: release(${count}) but only ${used} held`);
      used -= clamp(count);
      admit();
    },
    inUse: () => used,
  };
}
