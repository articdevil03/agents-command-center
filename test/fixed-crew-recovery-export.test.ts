import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const read = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
test("FC4E archive, private setup, recovery and task state are excluded from commit, package and public export", () => {
  const ignored = read(".gitignore").split(/\r?\n/), build = JSON.parse(read("package.json")).build.files;
  for (const dir of ["backups", "tasks", "executions", "execution-logs"]) {
    assert.ok(ignored.includes(`/${dir}/`), `ignore ${dir}`); assert.ok(build.includes(`!${dir}/**`), `package excludes ${dir}`);
  }
  for (const name of ["setups", "fixed-crew-recovery"]) {
    assert.ok(ignored.includes(`config/${name}.json`)); assert.ok(build.includes(`!config/${name}.json`));
  }
  const script = read("scripts/export-public.mjs");
  // Execute the exporter's actual selection predicate without running its
  // copy/git entry point. No export is performed by this test.
  const prefixes = script.match(/const EXCLUDE_PREFIXES = (\[[^;]+\]);/)?.[1];
  const files = script.match(/const EXCLUDE_FILES = new Set\((\[[\s\S]*?\])\);/)?.[1];
  const predicate = script.match(/const excluded = (\(path\) => [^;]+);/)?.[1];
  assert.ok(prefixes && files && predicate, "export selection source was found");
  const excluded = new Function(`const PATTERN_FILE_NAME=".leak-patterns.local"; const EXCLUDE_PREFIXES=${prefixes}; const EXCLUDE_FILES=new Set(${files}); return ${predicate};`)();
  for (const name of ["backups/fixed-crew-v1-private/manifest.json", "tasks/tab.json", "executions/tab.json", "execution-logs/run.log", "config/setups.json", "config/fixed-crew-recovery.json"]) assert.equal(excluded(name), true, name);
  assert.equal(excluded("server/fixed-crew/recovery.ts"), false, "recovery code still ships");
});
