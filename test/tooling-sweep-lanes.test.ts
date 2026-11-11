import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createLane, createSlots, laneEnv, readPristine, removeLane, removeTree, resyncLane, writeVerified, cleanupLeftovers } from "../scripts/sweep/lanes.mjs";

// Every lane's copy sits in a fake repo root and its temp folder under a scratch "OS temp", so nothing here touches the real repo or the real temp dir.
const REAL_TMP = tmpdir();
const scratch = mkdtempSync(join(REAL_TMP, "cc-lanes-test-"));
const [savedTemp, savedTmp] = [process.env.TEMP, process.env.TMP];
process.env.TEMP = process.env.TMP = scratch;
after(() => {
  process.env.TEMP = savedTemp;
  process.env.TMP = savedTmp;
  removeWithRetry(scratch);
});

function fakeRepo(withModules = true) {
  const root = mkdtempSync(join(scratch, "repo-"));
  for (const [path, text] of [["a/f1.txt", "one"], ["a/f2.txt", "two"], ["a/sub/f3.txt", "three"], ["b.json", "{}"], ["other/skipped.txt", "not copied"], ...(withModules ? [["node_modules/x/index.js", "dep"]] : [])]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("C1 removal retry retries a transient file handle before declaring a leftover", () => {
  const source = readFileSync(fileURLToPath(new URL("../scripts/sweep/lanes.mjs", import.meta.url)), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("function removeEntry("), end = source.indexOf("// A link", start);
  assert.ok(start >= 0 && end > start, "removeEntry source found");
  const removeEntry = new Function("sleep", "REMOVE_ATTEMPTS", "REMOVE_WAIT_MS", `${source.slice(start, end)}; return removeEntry;`)(() => {}, 5, 0);
  let calls = 0;
  assert.equal(removeEntry(() => { if (++calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, "fake-file"), true);
  assert.equal(calls, 2, "the second attempt succeeds");
});

test("createLane copies only the named paths, records hashes, and keeps the lane folder and its private temp apart", () => {
  const root = fakeRepo();
  const lane = createLane(root, ["a", "b.json"], 2);
  assert.deepEqual([...lane.pristine.keys()].sort(), ["a/f1.txt", "a/f2.txt", "a/sub/f3.txt", "b.json"]);
  assert.equal(readFileSync(join(lane.dir, "a/sub/f3.txt"), "utf8"), "three");
  assert.equal(existsSync(join(lane.dir, "other")), false, "a path that was not named is not copied");
  assert.equal(lane.hashes.size, 4);
  assert.match(lane.dir, /\.cc-test-mutations-/);
  assert.match(lane.temp, /cc-sweep-/);
  assert.equal(dirname(lane.temp), scratch, "the private temp is directly under OS temp, outside the repo");
  assert.equal(readPristine(lane, "b.json").toString(), "{}");
  assert.throws(() => readPristine(lane, "other/skipped.txt"), /not in lane 2's copy/);
  removeLane(lane);
});

test("createLane refuses a link inside the source and leaves no half-made lane behind", { skip: process.platform !== "win32" }, () => {
  const root = fakeRepo();
  const outside = mkdtempSync(join(scratch, "outside-"));
  symlinkSync(outside, join(root, "a", "escape"), "junction");
  const before = readdirSync(root);
  assert.throws(() => createLane(root, ["a"], 1), /is a link/);
  assert.deepEqual(readdirSync(root), before, "the lane folder made before the failure is removed again");
  assert.deepEqual(readdirSync(outside), [], "nothing was copied through the link");
});

test("laneEnv strips CC_DATA_DIR, CC_TEST_FORCE_PACKAGED and NODE_TEST_CONTEXT, keeps PATH, sets TEMP, TMP and CC_MUTATION_PROOF, and never touches process.env", () => {
  const lane = { temp: join(scratch, "lane-temp") } as any;
  const saved = { dataDir: process.env.CC_DATA_DIR, packaged: process.env.CC_TEST_FORCE_PACKAGED };
  process.env.CC_DATA_DIR = "data";
  process.env.CC_TEST_FORCE_PACKAGED = "1";
  try {
    for (const red of [false, true]) {
      const env = laneEnv(lane, red);
      assert.equal(Object.hasOwn(env, "CC_DATA_DIR"), false);
      assert.equal(Object.hasOwn(env, "CC_TEST_FORCE_PACKAGED"), false);
      assert.equal(Object.hasOwn(env, "NODE_TEST_CONTEXT"), false, "this test itself runs under node --test, so the variable is set here");
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
      assert.ok(pathKey, "the copied environment keeps a PATH key");
      assert.equal(env[pathKey], process.env.PATH);
      assert.equal(env.CC_MUTATION_PROOF, red ? "1" : "");
      assert.equal(env.TEMP, lane.temp);
      assert.equal(env.TMP, lane.temp);
      assert.equal(process.env.CC_DATA_DIR, "data", "the parent environment is unchanged");
      assert.equal(process.env.CC_TEST_FORCE_PACKAGED, "1");
    }
  } finally {
    for (const [key, value] of [["CC_DATA_DIR", saved.dataDir], ["CC_TEST_FORCE_PACKAGED", saved.packaged]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("writeVerified writes and reads back, creating the folder if a mutation target needs one", () => {
  const lane = createLane(fakeRepo(), ["a"], 1);
  writeVerified(lane, "a/new/deep.txt", "hello");
  assert.equal(readFileSync(join(lane.dir, "a/new/deep.txt"), "utf8"), "hello");
  writeVerified(lane, "a/f1.txt", Buffer.from("bytes"));
  assert.equal(readFileSync(join(lane.dir, "a/f1.txt"), "utf8"), "bytes");
  removeLane(lane);
});

test("resyncLane puts back a changed or deleted file, removes extras, lists a leaked .cc-test folder, and empties temp", () => {
  const lane = createLane(fakeRepo(), ["a", "b.json"], 1);
  assert.deepEqual(resyncLane(lane), { recopied: [], removed: [], leaked: [], tempLeftovers: [] }, "control: an untouched lane reports nothing");
  writeFileSync(join(lane.dir, "a/f1.txt"), "changed by a red run");
  writeFileSync(join(lane.dir, "b.json"), "{\"written\":true}");
  writeFileSync(join(lane.dir, "a/extra.txt"), "extra");
  mkdirSync(join(lane.dir, "a/extra-folder/inner"), { recursive: true });
  writeFileSync(join(lane.dir, "a/extra-folder/inner/x.txt"), "x");
  mkdirSync(join(lane.dir, ".cc-test-x/inside"), { recursive: true });
  writeFileSync(join(lane.dir, ".cc-test-x/inside/y.txt"), "y");
  writeFileSync(join(lane.dir, "a/sub/f3.txt"), "");
  mkdirSync(join(lane.temp, "cc-http-test-1/deeper"), { recursive: true });
  writeFileSync(join(lane.temp, "cc-http-test-1/deeper/z.txt"), "z");
  writeFileSync(join(lane.temp, "loose.txt"), "loose");
  const report = resyncLane(lane);
  assert.deepEqual([...report.recopied].sort(), ["a/f1.txt", "a/sub/f3.txt", "b.json"]);
  assert.deepEqual([...report.removed].sort(), ["a/extra-folder", "a/extra.txt"]);
  assert.deepEqual(report.leaked, [".cc-test-x"]);
  assert.deepEqual(report.tempLeftovers, []);
  assert.equal(readFileSync(join(lane.dir, "a/f1.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(lane.dir, "b.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(lane.dir, "a/sub/f3.txt"), "utf8"), "three");
  assert.deepEqual(readdirSync(join(lane.dir, "a")).sort(), ["f1.txt", "f2.txt", "sub"]);
  assert.equal(existsSync(join(lane.dir, ".cc-test-x")), false);
  assert.deepEqual(readdirSync(lane.temp), [], "temp is emptied");
  unlinkAndResync(lane);
  removeLane(lane);
});

// A deleted file comes back from the lane's own bytes, not from the (possibly changed) source.
function unlinkAndResync(lane: any) {
  removeTree(join(lane.dir, "a/f2.txt"), lane.dir);
  assert.deepEqual(resyncLane(lane).recopied, ["a/f2.txt"]);
  assert.equal(readFileSync(join(lane.dir, "a/f2.txt"), "utf8"), "two");
}

test("removeTree removes a junction as a link, never enters it, and the folder it pointed at survives", { skip: process.platform !== "win32" }, () => {
  const base = mkdtempSync(join(scratch, "junction-"));
  const outside = join(base, "outside");
  const tree = join(base, "tree");
  mkdirSync(outside);
  mkdirSync(join(tree, "inner"), { recursive: true });
  writeFileSync(join(outside, "canary.txt"), "must survive");
  writeFileSync(join(tree, "inner", "file.txt"), "f");
  symlinkSync(outside, join(tree, "inner", "node_modules"), "junction");
  const result = removeTree(tree, base);
  assert.equal(existsSync(tree), false, "the tree is gone");
  assert.equal(existsSync(join(outside, "canary.txt")), true, "deletion never entered the fixture junction");
  assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "must survive", "the canary behind the junction is untouched");
  assert.deepEqual(result.leftovers, []);
  assert.equal(result.removed, 4, "file, junction, inner, tree");
});

test("removeTree refuses a target that is not strictly inside the allowed folder and removes nothing", () => {
  const base = mkdtempSync(join(scratch, "bounds-"));
  const inside = join(base, "inside");
  const elsewhere = join(base, "elsewhere");
  mkdirSync(inside);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep.txt"), "k");
  assert.throws(() => removeTree(elsewhere, inside), /not strictly inside/);
  assert.throws(() => removeTree(inside, inside), /not strictly inside/, "the allowed folder itself is not removable");
  assert.throws(() => removeTree(join(inside, "..", "elsewhere"), inside), /not strictly inside/, "a .. escape is resolved first");
  assert.equal(existsSync(join(elsewhere, "keep.txt")), true);
});

test("removeLane removes both folders, and fails loudly if the real node_modules is gone", () => {
  const root = fakeRepo();
  const lane = createLane(root, ["a"], 1);
  assert.deepEqual(removeLane(lane), { leftovers: [] });
  assert.equal(existsSync(lane.dir) || existsSync(lane.temp), false);
  assert.equal(existsSync(join(root, "node_modules/x/index.js")), true);
  const bare = createLane(fakeRepo(false), ["a"], 1);
  assert.throws(() => removeLane(bare), /node_modules is gone/);
});

test("cleanupLeftovers removes older lane folders and sweep temp folders and nothing else", () => {
  const root = fakeRepo();
  for (const name of [".cc-test-mutations-old", ".cc-test-evidence-1", ".cc-test-AbC123"]) mkdirSync(join(root, name, "inner"), { recursive: true });
  for (const name of ["cc-sweep-old", "cc-sweep-old2", "cc-other"]) { mkdirSync(join(scratch, name), { recursive: true }); writeFileSync(join(scratch, name, "f.txt"), "f"); }
  const result = cleanupLeftovers(root);
  assert.deepEqual(result.removed.map((path: string) => path.split("\\").pop()).sort(), [".cc-test-mutations-old", "cc-sweep-old", "cc-sweep-old2"]);
  assert.deepEqual(result.leftovers, []);
  for (const kept of [join(root, ".cc-test-evidence-1"), join(root, ".cc-test-AbC123"), join(root, "a"), join(scratch, "cc-other")]) assert.equal(existsSync(kept), true, `${kept} is not ours to delete`);
});

test("createSlots hands slots out first come first served, and a request for all of them cannot be starved", async () => {
  const slots = createSlots(4);
  const order: string[] = [];
  await slots.acquire(3);
  const all = slots.acquire(4).then(() => order.push("all"));
  const small = slots.acquire(1).then(() => order.push("small"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "one slot is free, but the request for all four is first in line and the small one waits behind it");
  assert.equal(slots.inUse(), 3);
  slots.release(3);
  await all;
  assert.deepEqual(order, ["all"]);
  assert.equal(slots.inUse(), 4, "nothing else runs while all four are held");
  slots.release(4);
  await small;
  assert.deepEqual(order, ["all", "small"]);
  assert.equal(slots.inUse(), 1);
});

test("createSlots clamps requests to 1..total and refuses to release more than is held", async () => {
  const slots = createSlots(3);
  await slots.acquire(99);
  assert.equal(slots.inUse(), 3, "over-asking takes all, not forever");
  slots.release(3);
  await slots.acquire(0);
  assert.equal(slots.inUse(), 1, "asking for none still takes one");
  assert.throws(() => slots.release(2), /only 1 held/);
  slots.release(1);
  assert.throws(() => slots.release(1), /only 0 held/);
  assert.equal(slots.total, 3);
});

test("R1 resyncLane removes and reports new top-level entries while retaining copied roots", () => {
  const root = fakeRepo();
  const lane = createLane(root, ["a/f1.txt", "b.json"], 1);
  mkdirSync(join(lane.dir, "extra-folder"));
  writeFileSync(join(lane.dir, "extra-folder/file.txt"), "extra");
  writeFileSync(join(lane.dir, "extra.txt"), "extra");
  mkdirSync(join(lane.dir, ".cc-test-x"));
  const report = resyncLane(lane);
  assert.deepEqual(report.removed.sort(), ["extra-folder", "extra.txt"], "app data folders are removed and noted, not leaks");
  assert.deepEqual(report.leaked, [".cc-test-x"], "a leftover test root is still a leak");
  assert.deepEqual(readdirSync(lane.dir).sort(), ["a", "b.json"]);
  assert.equal(readFileSync(join(lane.dir, "a/f1.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(root, "a/f1.txt"), "utf8"), "one", "source stays untouched");
  removeLane(lane);
});

test("R1 resyncLane removes a top-level junction without touching its target", { skip: process.platform !== "win32" }, () => {
  const root = fakeRepo();
  const lane = createLane(root, ["a/f1.txt"], 1);
  const outside = mkdtempSync(join(scratch, "resync-outside-"));
  writeFileSync(join(outside, "canary.txt"), "must survive");
  symlinkSync(outside, join(lane.dir, "escape"), "junction");
  const report = resyncLane(lane);
  assert.deepEqual(report.removed, ["escape"]);
  assert.deepEqual(report.leaked, []);
  assert.deepEqual(readdirSync(lane.dir), ["a"]);
  assert.equal(readFileSync(join(outside, "canary.txt"), "utf8"), "must survive");
  removeLane(lane);
});
