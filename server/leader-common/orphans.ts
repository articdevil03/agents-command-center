import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TreeDeps } from "./process-tree.ts";
import { SWEEP_CAP_MS } from "./types.ts";

export type RegistryFile = { owner: { pid: number; created: number | null }; roots: Array<{ pid: number; rootCreated: number | null; known: Array<[number, number]> }> };
const REGISTRY_FILE = /^\.children-(\d+)\.json$/;

// Run at start: the registry files of servers that no longer exist name children that survived them. Each is killed only if it is still
// alive with the creation time that was recorded (a reused pid is left alone).
// The whole sweep has one cap (the server waits for it before listening, and Electron waits longer for the server: READY_TIMEOUT_MS); what is not done by then keeps running: `late` settles with the final counts, and anything unfinished stays in its registry file for the next start.
export { SWEEP_CAP_MS };
type SweepCounts = { checked: number; killed: number; unchecked: boolean };
export type SweepResult = SweepCounts & { finished: boolean; late: Promise<SweepCounts> };
export async function sweepOrphanedChildren(deps: Pick<TreeDeps, "list" | "kill" | "registryDir"> & { capMs?: number }): Promise<SweepResult> {
  const result = { checked: 0, killed: 0, unchecked: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<boolean>((done) => { timer = setTimeout(() => done(false), deps.capMs ?? SWEEP_CAP_MS); timer.unref(); });
  const late = sweepFiles(deps, result).then(() => ({ ...result }));
  late.catch(() => { /* a failure after the cap is read by whoever reads `late` */ });
  let finished: boolean;
  try { finished = await Promise.race([late.then(() => true), cap]); } finally { clearTimeout(timer); }
  return { ...result, finished, late };
}
// What the server start says about its sweep, line by line.
export function describeStartupSweep(swept: { killed: number; finished: boolean; unchecked?: boolean }, capMs: number, alreadyKilled = 0): string[] {
  const lines: string[] = [];
  if (!swept.finished) lines.push(`[cleanup] the check for processes left by an earlier server did not finish within ${Math.round(capMs / 1000)} s; the server starts now and finishes it in the background`);
  if (swept.unchecked) lines.push("[cleanup] could not check for processes left by an earlier server; their registry files are kept for the next start");
  const killed = swept.killed - alreadyKilled;
  if (killed > 0) lines.push(`[cleanup] stopped ${killed} processes left by an earlier server`);
  return lines;
}
// The whole start-up report: the lines for the result at the cap, then (when the cap won) the late lines with only the kills made after it.
export function reportStartupSweep(swept: SweepResult, capMs: number, log: (line: string) => void, describe: (err: unknown) => string = String): void {
  for (const line of describeStartupSweep(swept, capMs)) log(line);
  if (swept.finished) return;
  swept.late.then((final) => { for (const line of describeStartupSweep({ ...final, finished: true }, capMs, swept.killed)) log(line); }, (err) => log(`Orphan sweep failed: ${describe(err)}`));
}
async function sweepFiles(deps: Pick<TreeDeps, "list" | "kill" | "registryDir">, result: SweepCounts): Promise<void> {
  const dir = deps.registryDir?.();
  if (!dir) return;
  let names: string[];
  try { names = readdirSync(dir).filter((name) => REGISTRY_FILE.test(name) && name !== `.children-${process.pid}.json`); } catch { return; }
  if (!names.length) return;
  const list = await deps.list();
  if (!list) { result.unchecked = true; return; }
  const alive = new Map(list.map((proc) => [proc.pid, proc.created]));
  // Every file's kills run at once, so one hung kill does not queue the others behind it.
  await Promise.all(names.map(async (name) => {
    const file = join(dir, name);
    let body: RegistryFile | null = null;
    try { body = JSON.parse(readFileSync(file, "utf8")) as RegistryFile; } catch { /* unreadable: removed below */ }
    if (body && Number.isSafeInteger(body.owner?.pid)) {
      const ownerCreated = alive.get(body.owner.pid);
      const ownerAlive = ownerCreated !== undefined && (body.owner.created === null || Math.abs(ownerCreated - body.owner.created) < 2_000);
      if (ownerAlive) return;
      const targets: number[] = [];
      for (const root of Array.isArray(body.roots) ? body.roots : []) {
        if (Number.isSafeInteger(root?.pid) && root.rootCreated !== null && alive.get(root.pid) === root.rootCreated) targets.push(root.pid);
        for (const entry of Array.isArray(root?.known) ? root.known : []) if (Array.isArray(entry) && alive.get(entry[0]) === entry[1]) targets.push(entry[0]);
      }
      result.checked += targets.length;
      const killed = await Promise.all(targets.map((pid) => deps.kill(pid)));
      result.killed += killed.filter(Boolean).length;
      if (!killed.every(Boolean)) return; // a failed kill keeps the file, so the next start retries
    }
    try { unlinkSync(file); } catch { /* a locked file is retried at the next start */ }
  }));
}
