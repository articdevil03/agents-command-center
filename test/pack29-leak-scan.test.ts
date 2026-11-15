import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FORBIDDEN_PACKAGED_ENTRIES, MIN_PACKAGED_FILES, loadReviewedFiles, scanFiles } from "../scripts/export-public/scan.mjs";
import { removeOwnedTree } from "../scripts/dist-installer.mjs";

// Synthetic words and addresses only. Never use the owner's private list in tests.
const word = "quartzplatypus";
const script = resolve("scripts/export-public.mjs");
function fixture(count = MIN_PACKAGED_FILES) {
  const temp = mkdtempSync(join(tmpdir(), "cc-p29-leak-"));
  const app = join(temp, "app"), patterns = join(temp, "patterns");
  mkdirSync(app);
  writeFileSync(patterns, word + "\n");
  const reviewed = join(temp, "reviewed.json");
  writeFileSync(reviewed, JSON.stringify({ version: 1, files: [] }));
  const put = (name: string, text: string | Buffer) => {
    mkdirSync(dirname(join(app, name)), { recursive: true });
    writeFileSync(join(app, name), text);
  };
  for (let n = 0; n < count; n++) put(`node_modules/filler/${n}.js`, "clean\n");
  const run = (folder = app, list = patterns, flags = ["--scan-packaged"]) => {
    const result = spawnSync(process.execPath, [script, ...flags, folder], {
      encoding: "utf8", windowsHide: true, timeout: 20000,
      env: { ...process.env, CC_EXPORT_PATTERNS: list, CC_EXPORT_REVIEWED: reviewed },
    });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  return { temp, app, patterns, reviewed, put, run };
}

const reviewedEntry = (path: string, bytes: string | Buffer) => ({
  package: "synthetic-test-package", version: "1.0.0", path,
  sha256: createHash("sha256").update(bytes).digest("hex"), reason: "Synthetic test bytes reviewed.",
});

test("reviewed dependency requires matching bytes and reports absent and changed files", () => {
  const f = fixture();
  const path = "node_modules/x/blob.bin";
  try {
    f.put(path, word);
    assert.equal(f.run().code, 1, "unlisted dependency is scanned");
    writeFileSync(f.reviewed, JSON.stringify({ version: 1, files: [reviewedEntry(path, word)] }));
    const clean = f.run();
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /reviewed third-party files exempt from the word scan: 1 of 1/);
    // One extra byte keeps the synthetic word intact but invalidates its checksum.
    f.put(path, word + "!");
    const changed = f.run();
    assert.equal(changed.code, 1, changed.out);
    assert.ok(changed.out.includes(`reviewed file changed, scanning it normally: ${path}`), changed.out);
    assert.match(changed.out, /exempt from the word scan: 0 of 1/);
    assert.ok(changed.out.includes(`${path}:1:`), changed.out);
    unlinkSync(join(f.app, path));
    const absent = f.run();
    assert.equal(absent.code, 0, absent.out);
    assert.ok(absent.out.includes(`reviewed entry not present: ${path}`), absent.out);
  } finally { removeOwnedTree(f.temp); }
});

test("reviewed checksum exempts the dependency name too, but never a normal export", () => {
  const f = fixture();
  const path = `node_modules/x/${word}.bin`;
  try {
    f.put(path, "clean");
    assert.equal(f.run().code, 1);
    writeFileSync(f.reviewed, JSON.stringify({ version: 1, files: [reviewedEntry(path, "clean")] }));
    assert.equal(f.run().code, 0);
    const hits = scanFiles([{ path, bytes: Buffer.from("clean") }], [{ line: 1, regex: new RegExp(word) }], { reviewedFile: f.reviewed });
    assert.equal(hits.size, 1, "non-packaged name scan does not use allowlist");
    unlinkSync(f.reviewed);
    assert.equal(scanFiles([], [], { reviewedFile: f.reviewed }).size, 0, "normal export never loads allowlist");
  } finally { removeOwnedTree(f.temp); }
});

test("own files remain scanned and cannot be added to the reviewed allowlist", () => {
  const f = fixture();
  const path = "server/x.js";
  try {
    f.put(path, word);
    assert.equal(f.run().code, 1, "own file is scanned");
    writeFileSync(f.reviewed, JSON.stringify({ version: 1, files: [reviewedEntry(path, word)] }));
    const result = f.run();
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /allowlist is missing or malformed/);
  } finally { removeOwnedTree(f.temp); }
});

test("missing or malformed reviewed allowlists fail closed with exit 2", () => {
  const f = fixture();
  const entry = reviewedEntry("node_modules/x/blob.bin", word);
  const invalid = [
    "{", { version: 2, files: [] }, { version: 1, files: [entry, entry] },
    { version: 1, files: [{ ...entry, sha256: "bad" }] },
    { version: 1, files: [{ ...entry, extra: true }] }, { version: 1, files: [], extra: true },
    ...["package", "version", "reason"].map((key) => ({ version: 1, files: [{ ...entry, [key]: " " }] })),
    ...["other/x", "node_modules/../server/x.js", "node_modules//x", "node_modules/x\\blob.bin"].map((path) => ({ version: 1, files: [{ ...entry, path }] })),
  ];
  try {
    for (const data of invalid) {
      writeFileSync(f.reviewed, typeof data === "string" ? data : JSON.stringify(data));
      const result = f.run();
      assert.equal(result.code, 2, result.out);
      assert.match(result.out, /allowlist is missing or malformed/);
    }
    unlinkSync(f.reviewed);
    const missing = f.run();
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, /CC_EXPORT_REVIEWED file is missing/);
  } finally { removeOwnedTree(f.temp); }
});

test("committed reviewed allowlist validates all four dependency entries", () => {
  let entries;
  assert.doesNotThrow(() => { entries = loadReviewedFiles(); });
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.ok(entry.path.startsWith("node_modules/"), entry.path);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/i);
  }
});

test("packaged scan reports actual file/byte counts and clean exit", () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp(`packaged scan: ${MIN_PACKAGED_FILES} files, ${MIN_PACKAGED_FILES * 6} bytes; node_modules: ${MIN_PACKAGED_FILES} files, ${MIN_PACKAGED_FILES * 6} bytes`));
  } finally { removeOwnedTree(f.temp); }
});

for (const name of ["server/app.js", "node_modules/x/index.js", `public/${word}.txt`]) {
  test(`private patterns cover bytes and names: ${name}`, () => {
    const f = fixture();
    try {
      f.put(name, `clean\n${word}\n`);
      const result = f.run();
      assert.equal(result.code, 1, result.out);
      assert.ok(result.out.includes(`${name}:2: pattern #1`), result.out);
      if (name.includes(word)) assert.match(result.out, /\(file name\): pattern #1/);
    } finally { removeOwnedTree(f.temp); }
  });
}

for (const [label, content] of [
  ["email", `author@${"mailhost"}.com`],
  ["profile", ["C:", "Users", "Jane Doe", "Documents"].join("\\")],
]) {
  test(`built-in ${label} exemption is exactly top-level node_modules`, () => {
    const f = fixture();
    try {
      f.put("node_modules/x/package.json", content);
      assert.equal(f.run().code, 0);
      for (const own of ["package.json", "server/app.js", "other/file.txt", "nested/node_modules/x.js", "node_modules-extra/x.js"]) {
        f.put(own, content);
        const result = f.run();
        assert.equal(result.code, 1, result.out);
        assert.ok(result.out.includes(`${own}:1: built-in`), result.out);
        f.put(own, "clean");
      }
    } finally { removeOwnedTree(f.temp); }
  });
}

test("every forbidden entry is refused, including nested config and private-list paths", () => {
  const seen = [];
  assert.equal(FORBIDDEN_PACKAGED_ENTRIES.length, 20, "control: full forbidden inventory found");
  for (const entry of FORBIDDEN_PACKAGED_ENTRIES) {
    const f = fixture();
    try {
      const names = entry.includes("/") || entry.startsWith(".") ? [entry, `node_modules/x/${entry}`] : [entry];
      for (const name of names) {
        if (entry.includes("/") || entry.startsWith(".")) f.put(name, "private");
        else mkdirSync(join(f.app, name));
        const result = f.run();
        assert.equal(result.code, 2, result.out);
        assert.ok(result.out.includes(`forbidden entry ${name}`), result.out);
        if (entry.includes("/") || entry.startsWith(".")) unlinkSync(join(f.app, name));
        else rmdirSync(join(f.app, name));
      }
      seen.push(entry);
    } finally { removeOwnedTree(f.temp); }
  }
  assert.deepEqual(seen, FORBIDDEN_PACKAGED_ENTRIES);
});

test("missing and empty lists, missing or incomplete folders and bad usage refuse with exit 2", () => {
  const f = fixture(0);
  try {
    const check = (result: ReturnType<typeof f.run>, message: RegExp) => {
      assert.equal(result.code, 2, result.out);
      assert.match(result.out, message);
      assert.doesNotMatch(result.out, /0 hits/);
    };
    check(f.run(f.app, join(f.temp, "missing-list")), /pattern file is missing/);
    writeFileSync(f.patterns, "# empty\n");
    check(f.run(), /no patterns/);
    writeFileSync(f.patterns, word);
    check(f.run(join(f.temp, "absent")), /folder is missing/);
    check(f.run(), /only 0 files; minimum/);
    f.put("one.txt", "clean");
    check(f.run(), /only 1 files; minimum/);
    check(f.run(f.app, f.patterns, ["--bogus"]), /usage:/);
    check(f.run(f.app, f.patterns, ["--scan-packaged", "--working-tree"]), /usage:/);
  } finally { removeOwnedTree(f.temp); }
});

test("UTF-16 both byte orders and binary bytes are scanned in dependencies", () => {
  for (const bytes of [Buffer.from(`first\n${word}`, "utf16le"), Buffer.from(`first\n${word}`, "utf16le").swap16(), Buffer.concat([Buffer.from([255, 0, 7]), Buffer.from(`\n${word}`)])]) {
    const f = fixture();
    try {
      f.put("node_modules/x/data.bin", bytes);
      const result = f.run();
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /node_modules\/x\/data.bin:2: pattern #1/);
    } finally { removeOwnedTree(f.temp); }
  }
});

test("links are refused without following them", (t) => {
  const f = fixture();
  const link = join(f.app, "linked");
  let linked = false;
  try {
    try { symlinkSync(f.temp, link, "junction"); linked = true; }
    catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) { t.skip("link creation requires privileges here"); return; }
      throw error;
    }
    const result = f.run();
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /linked is a link/);
  } finally { if (linked) unlinkSync(link); removeOwnedTree(f.temp); }
});


test("explicit missing reviewed list refuses both packaged and ordinary exports", () => {
  const f = fixture();
  try {
    unlinkSync(f.reviewed);
    for (const flags of [["--scan-packaged"], ["--working-tree"], []]) {
      const result = f.run(f.app, f.patterns, flags);
      assert.equal(result.code, 2, result.out);
      assert.match(result.out, /CC_EXPORT_REVIEWED file is missing/);
    }
    assert.throws(() => loadReviewedFiles(f.reviewed), /allowlist is missing or malformed/);
  } finally { removeOwnedTree(f.temp); }
});
