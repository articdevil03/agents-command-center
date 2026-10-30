import { afterEach } from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fakeCliOnPath, importWithTempDataRoot, scratchDir } from "./temp-root.ts";
import * as usage from "../server/usage.ts";
import * as agentUsage from "../server/agent-usage.ts";

// The server modules run on a fresh temp data root (config.ts seeds its example workspace there), never on the repo's live config/.
export const { dataDir: isolatedData, modules: { config, runner, history, leader } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  runner: await import("../server/runner.ts"),
  history: await import("../server/history.ts"),
  leader: await import("../server/leader.ts"),
}));

fakeCliOnPath();

export class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  constructor(pid = 4242) { super(); this.pid = pid; }
}

export function makeRun(overrides: Partial<runner.RunnerRun> = {}): runner.RunnerRun {
  return {
    runId: "run-1", seatKey: "work-tab.reviewer1", slotId: "reviewer1", name: "Vera", cli: "codex",
    model: "gpt-6-sol", effort: "high", folder: "C:/work/project", canWrite: false, startedAt: 100,
    ...overrides,
  };
}

export function captureCallbacks() {
  const outputs: Array<{ runId: string; text: string }> = [];
  const statuses: Array<{ runId: string; status: string; code?: number }> = [];
  const unconfirmed: Array<{ runId: string; pid?: number }> = [];
  return {
    outputs, statuses, unconfirmed,
    callbacks: {
      onOutput: (run: runner.RunnerRun, text: string) => outputs.push({ runId: run.runId, text }),
      onStatus: (run: runner.RunnerRun, status: string, code?: number) => statuses.push({ runId: run.runId, status, code }),
      onUnconfirmedKill: (run: runner.RunnerRun, pid?: number) => unconfirmed.push({ runId: run.runId, pid }),
    } as runner.RunnerCallbacks,
  };
}

export function spawnReturning(proc: FakeProc, calls: unknown[] = []) {
  return ((...args: unknown[]) => { calls.push(args); return proc; }) as unknown as typeof import("node:child_process").spawn;
}

export const { usageDeltaFromResult, addUsage, zeroUsage, bankUsage, toUsageSnapshot } = usage;

export const { createAgentUsageState, feedClaudeOutput, flushClaudeOutput, scanCodexTokens, flushCodexTokens } = agentUsage;

const discoveryBaseline = {
  codex: [...config.MODEL_OPTIONS.codex!],
  claudeEffort: [...config.EFFORT_OPTIONS.claude],
  opencode: [...config.OPENCODE_MODEL_SUGGESTIONS],
  claude: [...config.CLAUDE_MODEL_INFO].map((model) => ({ ...model })),
};

afterEach(async () => {
  await config.refreshDiscovery(
    async () => ({ values: [...discoveryBaseline.claudeEffort], fallback: true }),
    async () => ({ values: [...discoveryBaseline.opencode], fallback: true }),
    async () => ({ values: [...discoveryBaseline.claude].map((model) => ({ ...model })), fallback: true }),
  );
  config.MODEL_OPTIONS.codex!.splice(0, config.MODEL_OPTIONS.codex!.length, ...discoveryBaseline.codex);
});

// A fresh config folder in OS temp (never a copy of the repo's live config/).
export function configFolder(): { root: string; dir: string } {
  const root = scratchDir(), dir = path.join(root, "config");
  mkdirSync(dir);
  return { root, dir };
}

export function runArtifact(run: runner.RunnerRun, timestamp: number, extension: "log" | "brief.txt"): string {
  return path.join(runner.logsDir, `${run.seatKey}-${timestamp}.${extension}`);
}

export function startRunnerRun(run: runner.RunnerRun, prompt: string, callbacks: runner.RunnerCallbacks, spawn: any): number {
  const result = runner.runSeat(run, prompt, callbacks, spawn);
  if (!result.ok) throw new Error(result.error);
  return result.timestamp;
}
