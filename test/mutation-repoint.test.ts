import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./temp-root.ts";

// Drives the real scripts/mutation-repoint.mjs on a throwaway folder (cwd), with relative paths like the real use.
const script = fileURLToPath(new URL("../scripts/mutation-repoint.mjs", import.meta.url));

const CATALOGUE = `// header comment
export const sampleMutations = [
  ["row-moved", "src/old.ts", "const moved = 1;", "const moved = 2;"],
  ["row-ambiguous", "src/old.ts", 'const twice = 1;', ''],
  ["row-vanished", "src/old.ts", "const gone = 1;", ""],
  ["row-stays", "src/old.ts", "const stays = 1;", "const stays = 0;"],
  ["row-other-file", "src/other.ts", "const moved = 1;", ""],
];
`;

function setup(): string {
  const dir = scratchDir();
  const files: Record<string, string> = {
    "cat.mjs": CATALOGUE,
    "src/old.ts": "const stays = 1;\n",
    "src/new-a.ts": "const moved = 1;\nconst twice = 1;\n",
    "src/new-b.ts": "const twice = 1;\r\n",
  };
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
}

const run = (dir: string, ...args: string[]) => { const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", windowsHide: true }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test("a decoy before the real row stays byte-identical", () => {
  const dir = setup();
  const decoy = `  ["decoy", "src/other.ts", "call('row-moved', 'src/old.ts')", ""],\n`;
  const catalogue = CATALOGUE.replace('  ["row-moved"', decoy + '  ["row-moved"');
  writeFileSync(join(dir, "cat.mjs"), catalogue);
  run(dir, "cat.mjs", "src/old.ts", "src/new-a.ts", "src/new-b.ts");
  const actual = readFileSync(join(dir, "cat.mjs"), "utf8");
  assert.ok(actual.includes(decoy), "decoy row must be byte-identical");
  assert.equal(actual, catalogue.replace('["row-moved", "src/old.ts"', '["row-moved", "src/new-a.ts"'));
});

test("zero or duplicate row anchors are refused without changing the catalogue", () => {
  for (const [row, count] of [
    [`["row-" + "moved", "src/old.ts", "const moved = 1;", ""]`, 0],
    [`['row-moved', "src/old.ts", "const moved = 1;", ""],\n['row-moved', "src/old.ts", "const moved = 1;", ""]`, 2],
  ] as const) {
    const dir = setup();
    const catalogue = `export const rows = [${row}];\n`;
    writeFileSync(join(dir, "cat.mjs"), catalogue);
    const { code, err } = run(dir, "cat.mjs", "src/old.ts", "src/new-a.ts");
    assert.equal(code, 1);
    assert.ok(err.includes(`expected exactly one row in cat.mjs, found ${count}`), err);
    assert.equal(readFileSync(join(dir, "cat.mjs"), "utf8"), catalogue);
  }
});

test("a moved row is re-pointed (only its path changes), an ambiguous and a vanished row are refused, rows still in the old file are untouched", () => {
  const dir = setup();
  const { code, out, err } = run(dir, "cat.mjs", "src/old.ts", "src/new-a.ts", "src/new-b.ts");
  assert.equal(code, 1, "refused rows make the exit code 1");
  assert.equal(out.trim(), "row-moved", "the output lists exactly the re-pointed names");
  assert.match(err, /REFUSED row-ambiguous: text found 1x in src\/new-a\.ts, 1x in src\/new-b\.ts/);
  assert.match(err, /REFUSED row-vanished: text found in no new file/);
  assert.equal(readFileSync(join(dir, "cat.mjs"), "utf8"), CATALOGUE.replace('["row-moved", "src/old.ts"', '["row-moved", "src/new-a.ts"'));
});

test("with nothing to refuse the exit code is 0 and several moved names are comma-joined", () => {
  const dir = setup();
  writeFileSync(join(dir, "cat.mjs"), CATALOGUE.replace(/  \["row-(ambiguous|vanished)".*\n/g, "").replace('"row-stays", "src/old.ts", "const stays = 1;"', '"row-also", "src/old.ts", "const moved = 1;"'));
  const { code, out } = run(dir, "cat.mjs", "src/old.ts", "src/new-a.ts");
  assert.equal(code, 0);
  assert.equal(out.trim(), "row-moved,row-also");
  assert.equal((readFileSync(join(dir, "cat.mjs"), "utf8").match(/src\/new-a\.ts/g) ?? []).length, 2);
});

test("a row whose text sits twice inside the one new file is refused and the file is unchanged", () => {
  const dir = setup();
  writeFileSync(join(dir, "src/new-a.ts"), "const moved = 1;\nconst moved = 1;\n");
  const { code, out, err } = run(dir, "cat.mjs", "src/old.ts", "src/new-a.ts");
  assert.equal(code, 1);
  assert.equal(out.trim(), "");
  assert.match(err, /REFUSED row-moved: text found 2x in src\/new-a\.ts/);
  assert.equal(readFileSync(join(dir, "cat.mjs"), "utf8"), CATALOGUE);
});

test("a missing old file counts as not found", () => {
  const dir = setup();
  const { out } = run(dir, "cat.mjs", "src/missing.ts", "src/new-a.ts");
  assert.equal(out.trim(), "");
  assert.equal(readFileSync(join(dir, "cat.mjs"), "utf8"), CATALOGUE);
});
