import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// Pack 17: any CLI that speaks the Agent Client Protocol (ACP) can lead a tab, added from Settings by its start command.
// Sections: A the start command and the saved list (no shell, ever), B the safe program resolution (every CLI start), C the adapter against the fake ACP agent
// (shapes measured on `opencode acp` 1.18.21), D the real server through a client (add, pick, chat, Stop, modes, fixed tools, errors), E the sweep over every place that decides per CLI.
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const SECRET = "SECRET-P17-xK39qz";
export const temps: string[] = [];
export function scratch(prefix = "cc-pack17-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; }
test.after(() => { for (const dir of temps) removeWithRetry(dir, 40, 500); });
// ---------------------------------------------------------------- D: the real server, through a client
// The fixed crew: the leader slot and one worker slot (the Coder) are the two seats these tests give an ACP CLI.
export const LEADER_SLOT = "leader";
export const WORKER = FIXED_CREW.find((seat) => seat.slot === "coder")!;
export const WORKER_SLOT = WORKER.slot;
export const CLAUDE_LEADER = FIXED_CREW.find((seat) => seat.slot === LEADER_SLOT)!.preferred;
export const ACP_DEFAULT = { model: "default", effort: "default" } as const;
