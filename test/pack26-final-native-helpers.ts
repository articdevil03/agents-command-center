import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { CODEX_LIKE_WORKER } from "./pack26-final-reports-helpers.ts";
import { windowsSystem32 } from "../server/leader-common/cli-path.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";

export const NATIVE = process.env.CC_P26_FINAL_NATIVE === "1";
export const notRun = (what: string) => { if (!NATIVE) console.log(`NOT RUN: ${what} requires CC_P26_FINAL_NATIVE=1 (native Windows processes, outside the sandbox).`); };

// The isolated fixed server with its real process lists and real taskkill (nativeProcess), and a real fake codex.cmd that runs the
// Codex-like worker through real pipes. Nothing here injects runner output, a run record or a tree confirmation.
export async function nativeServer(options: { secondTab?: boolean } = {}) {
  return fixedServer({ ...options, nativeProcess: true,
    env: { PATH: `${dirname(process.execPath)};${windowsSystem32()}` },
    extra: ({ temp }) => writeFileSync(join(temp, "worker.cjs"), CODEX_LIKE_WORKER) });
}
export type NativeServer = Awaited<ReturnType<typeof nativeServer>>;
// The pids the worker fixture reported starting that are still in the real process list.
export async function stillRunning(f: NativeServer): Promise<number[]> {
  const listed = await listProcesses(); if (!listed) throw new Error("native process list must succeed");
  const alive = new Set(listed.map((row) => row.pid));
  return f.children().filter((row: any) => row.event === "start" && row.worker).map((row: any) => row.pid).filter((pid: number) => alive.has(pid));
}
