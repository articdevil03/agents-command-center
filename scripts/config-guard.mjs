import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { isMain } from "./is-main.mjs";

export function configSnapshot(root) {
  const files = new Map();
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of entries) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Config guard refuses link: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.set(relative(root, path), { hash: createHash("sha256").update(readFileSync(path)).digest("hex"), mtime: stat.mtimeMs });
    }
  }
  walk(root);
  return files;
}

export function compareConfig(before, after, log = console.error) {
  const changed = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(name), now = after.get(name);
    if (!old || !now || old.hash !== now.hash) changed.push(name);
    if (old && now && old.mtime !== now.mtime) log(`WARNING config mtime changed: ${name}`);
  }
  if (changed.length) log(`Config files changed during tests: ${changed.join(", ")}`);
  return changed;
}

export async function guardConfig(root, run, log = console.error) {
  const before = configSnapshot(root);
  try { return await run(); }
  finally {
    if (compareConfig(before, configSnapshot(root), log).length) process.exitCode = 1;
  }
}

// The wrapped run is the old `npm test`: test/browser-constants.ts refuses a narrowed browser run only when the lifecycle event is "test".
export function runTests(args = ["--test", "test/*.test.ts"], env = process.env, stdio = "inherit") {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "./test/crash-catcher-self.ts", ...args], { stdio, windowsHide: true, env: { ...env, npm_lifecycle_event: "test" } });
    child.once("error", (error) => { console.error(error.message); done(1); });
    child.once("close", (code) => done(code ?? 1));
  });
}

if (isMain(import.meta.url)) {
  const code = await guardConfig(join(process.cwd(), "config"), () => runTests());
  process.exitCode = process.exitCode || code;
}
