import { createHash } from "node:crypto";
import { lstatSync, opendirSync, openSync, readSync, closeSync, fstatSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { path, type Plan, type Revision } from "./task-types.ts";

export function digest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
// Check every ancestor, including ancestors of the root. Missing leaves are
// allowed so deletions and future additions participate in the fingerprint.
export function refuseLinks(file: string): void {
  const parent = dirname(file);
  if (parent !== file) refuseLinks(parent);
  try { if (lstatSync(file).isSymbolicLink()) throw new Error("Linked task paths are refused"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function fingerprint(root: string, plan: Plan): Revision {
  const base = resolve(root);
  refuseLinks(base);
  const entries = new Map<string, Stats | null>();
  let bytes = 0;
  const signature = (info: Stats | null) => info === null ? "missing" : [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
  const changed = () => { throw new Error("Task coverage changed during fingerprint; no partial fingerprint was accepted."); };
  function visit(name: string): void {
    path(name);
    if (entries.has(name)) return;
    if (entries.size >= MAX_FINGERPRINT_ENTRIES) refuseBudget("entries");
    const file = join(base, ...name.split("/"));
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
  for (const name of coverage) { path(name); refuseLinks(join(base, ...name.split("/"))); visit(name); }
  // Complete metadata preflight precedes ALL content reads, including for overlapping coverage.
  const files: Record<string, string> = {};
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const [name, info] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const file = join(base, ...name.split("/"));
    if (!info) { files[name] = "missing"; continue; }
    if (info.isDirectory()) { files[name] = "directory"; continue; }
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
  for (const name of coverage) refuseLinks(join(base, ...name.split("/")));
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
