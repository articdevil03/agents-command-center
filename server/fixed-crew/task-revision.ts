import { createHash } from "node:crypto";
import { lstatSync, opendirSync, openSync, readSync, closeSync, fstatSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { path, type Plan, type Revision } from "./task-types.ts";
import { resolveOwnedRoot, assertOwnedPath } from "../owned-path.js";
import { dataRoot as configuredDataRoot } from "../config-files.ts";

export function digest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const taskRoots = new Map<string, ReturnType<typeof resolveOwnedRoot>>();
// Keep successful pins after refusal. Only a restart may adopt a replaced root.
export function refuseLinks(file: string, root?: string): void {
  const contains = (base: string) => {
    const rel = relative(base, resolve(file));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  // Production has one configured boundary. Explicit temporary stores also
  // pin theirs before archive/journal helpers use the legacy single-path API.
  if (!root && contains(configuredDataRoot)) root = configuredDataRoot;
  if (!root) root = [...taskRoots.keys()].sort((a, b) => b.length - a.length).find(contains);
  if (!root) throw new Error("A task storage root is required.");
  root = resolve(root);
  let boundary = taskRoots.get(root);
  if (!boundary) { boundary = resolveOwnedRoot(root, { allowRootLink: true }); taskRoots.set(root, boundary); }
  assertOwnedPath(boundary, file, { allowMissingLeaf: true });
}
export function fingerprint(root: string, plan: Plan): Revision {
  let boundary: ReturnType<typeof resolveOwnedRoot>;
  try { boundary = resolveOwnedRoot(root); }
  catch (error) {
    if (/linked/i.test((error as Error).message)) throw new Error("Linked task paths are refused", { cause: error });
    throw error;
  }
  const base = boundary.path;
  const check = (file: string) => assertOwnedPath(boundary, file, { allowMissingLeaf: true });
  const entries = new Map<string, Stats | null>();
  let bytes = 0;
  const signature = (info: Stats | null) => info === null ? "missing" : [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
  const changed = () => { throw new Error("Task coverage changed during fingerprint; no partial fingerprint was accepted."); };
  function visit(name: string): void {
    path(name);
    if (entries.has(name)) return;
    if (entries.size >= MAX_FINGERPRINT_ENTRIES) refuseBudget("entries");
    const file = join(base, ...name.split("/"));
    check(file);
    let info: Stats;
    try { info = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries.set(name, null); return; }
    if (info.isSymbolicLink()) throw new Error("Linked task paths are refused");
    entries.set(name, info);
    if (info.isDirectory()) {
      // Iteration is bounded before the next entry is visited. Never materialize a giant directory.
      const dir = opendirSync(file, { bufferSize: 32 });
      try { for (let child; (child = dir.readSync()) !== null;) visit(`${name}/${child.name}`); }
      finally { dir.closeSync(); }
    } else {
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Unsupported task input");
      bytes += info.size;
      if (bytes > MAX_FINGERPRINT_BYTES) refuseBudget("bytes");
    }
  }
  const coverage = [...plan.paths, ...plan.consumers, ...plan.sharedInputs].sort();
  for (const name of coverage) { path(name); check(join(base, ...name.split("/"))); visit(name); }
  // Complete metadata preflight precedes ALL content reads, including for overlapping coverage.
  const files: Record<string, string> = {};
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const [name, info] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const file = join(base, ...name.split("/"));
    if (!info) { files[name] = "missing"; continue; }
    if (info.isDirectory()) { files[name] = "directory"; continue; }
    check(file);
    const fd = openSync(file, "r");
    try {
      const hash = createHash("sha256");
      let read = 0;
      while (read < info.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - read), null);
        if (!count) changed();
        hash.update(buffer.subarray(0, count)); read += count;
      }
      if (signature(fstatSync(fd)) !== signature(info)) changed();
      files[name] = hash.digest("hex");
    } finally { closeSync(fd); }
  }
  // Detect observed replacement, growth, deletions and directory membership changes after reads.
  for (const [name, info] of entries) {
    let current: Stats | null;
    try { current = lstatSync(join(base, ...name.split("/"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; current = null; }
    if (signature(current) !== signature(info)) changed();
  }
  for (const name of coverage) check(join(base, ...name.split("/")));
  return { files, digest: digest(files) };
}
export const MAX_FINGERPRINT_ENTRIES = 4096;
export const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
function refuseBudget(dimension: "entries" | "bytes"): never {
  throw new Error(`Task coverage exceeds the ${dimension} dimension of the 4,096-entry/64-MiB fingerprint budget. Narrow plan.paths, consumers or sharedInputs to the pack's files and exclude dependency/generated/build folders. Revise the plan before removing a required consumer. No partial fingerprint was accepted.`);
}
export function changedPaths(before: Revision, after: Revision): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((name) => before.files[name] !== after.files[name]).sort();
}
