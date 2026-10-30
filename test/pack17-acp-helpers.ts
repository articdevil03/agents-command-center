import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

// Pack 17: any CLI that speaks the Agent Client Protocol (ACP) can lead a tab, added from Settings by its start command.
// Sections: A the start command and the saved list (no shell, ever), B the safe program resolution (every CLI start), C the adapter against the fake ACP agent
// (shapes measured on `opencode acp` 1.18.21), D the real server through a client (add, pick, chat, Stop, modes, crew tools, errors), E the sweep over every place that decides per CLI.
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const SECRET = "SECRET-P17-xK39qz";
export const temps: string[] = [];
export function scratch(prefix = "cc-pack17-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; }
test.after(() => { for (const dir of temps) removeWithRetry(dir, 40, 500); });
// ---------------------------------------------------------------- D: the real server, through a client
export const MAIN = getProcessDefinition("dev", "main").seats;
export const LEADER_SLOT = MAIN.find((seat) => seat.isLeader)!.slotId;
export const crewFor = (leader?: { cli: string; model: string; effort: string }) => MAIN.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
