import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { runInNewContext } from "node:vm";
import * as path from "node:path";
import * as agentUsage from "../server/agent-usage.ts";
import * as leaderCommon from "../server/leader-common.ts";
import { leaderChildEnv, withResolvedCli, isInsideFolder } from "../server/leader-common.ts";
import * as history from "../server/history.ts";
import { tempRoot } from "./temp-root.ts";
import { config, createAcpLeader } from "./round2-setup.ts";

export function loadRunnerHarness(options: { treeWatch?: () => leaderCommon.TreeWatch | null; testRoot?: string; spawn?: (command: string, argsOrOptions: any, options?: any) => any } = {}) {
  const testRoot = options.testRoot ?? tempRoot();
  mkdirSync(path.join(testRoot, "server"), { recursive: true });
  mkdirSync(path.join(testRoot, "logs"), { recursive: true });
  // The runner, the crew-tools helpers it imports (runner-crew.ts) and its shutdown tracking (runner/lifecycle.ts) are loaded as one source.
  const runnerSource = ["server/runner-crew.ts", "server/runner/lifecycle.ts", "server/runner.ts"].map((file) => stripTypeScriptTypes(readFileSync(file, "utf8"))
    .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replaceAll("import.meta.url", '"file:///server/runner.ts"')
    .replaceAll("export ", "")).join("\n");
  const module = runInNewContext(`(() => { ${runnerSource}\n const optional = (name) => { try { return eval(name); } catch { return undefined; } };
 return { buildCommand, runSeat, killRun, killRunAndConfirm: optional("killRunAndConfirm"), isRunning, isSeatRunning: optional("isSeatRunning"), runIdsForSeat, canRunWrite, unconfirmedPid, releaseUnconfirmedRun, stopAllRunning, logsDir, drainWorkers, closeWorkerAdmission, workerAdmissionClosed, WORKER_DRAIN_MS }; })()`, {
    ...path, mkdirSync, writeFileSync, appendFileSync, unlinkSync, Buffer, StringDecoder, spawn: options.spawn ?? (() => isolatedRunnerProc(0)),
    fileURLToPath: () => path.join(testRoot, "server", "runner.ts"), process: { env: { CC_DATA_DIR: "C:/never-open-this", CC_TEST_FORCE_PACKAGED: "1" } },
    isValidModel: config.isValidModel, isValidEffort: config.isValidEffort, isAcpKind: config.isAcpKind, createAcpLeader, formatExitMarker: history.formatExitMarker,
    // Everything the runner imports from leader-common reaches the loaded source whole (new exports included); the fake pids here name no real process tree, so none is watched.
    resolveDataRoot: () => testRoot, ...agentUsage, ...leaderCommon, watchProcessTree: options.treeWatch ?? (() => null),
    // Synthetic pids must never reach the operating system priority API.
    setPriority: () => {}, osConstants: { priority: { PRIORITY_BELOW_NORMAL: 0 } }, leaderChildEnv, withResolvedCli, isInsideFolder, setTimeout, clearTimeout, console,
  }) as any;
  return { ...module, testRoot };
}

export function isolatedRunnerProc(pid = 9123) {
  return Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() }) as any;
}

export function isolatedRunnerCapture() {
  const events: any[] = [];
  return { events, callbacks: {
    onOutput: (_run: any, text: string) => events.push({ type: "output", text }),
    onStatus: (_run: any, status: string, code?: number) => events.push({ type: "status", status, code }),
    onUsage: (_run: any, usage: any) => events.push({ type: "usage", usage }),
    onRateLimit: (windows: any) => events.push({ type: "rateLimit", windows }),
    onUnconfirmedKill: (_run: any, pid?: number) => events.push({ type: "unconfirmed", pid }),
  } };
}

export function isolatedRun(overrides: any = {}) {
  return { runId: "isolated-run", seatKey: "alpha-tab.reviewer", slotId: "reviewer", name: "Vera", cli: "claude", model: "claude-opus-5-5[1m]", effort: "medium", folder: "C:/work/alpha", canWrite: false, startedAt: Date.now(), ...overrides };
}

export function startIsolatedRunner(harness: any, run: any, prompt: string, capture: any, proc: any) {
  const result = harness.runSeat(run, prompt, capture.callbacks, ((_command: string, _options: any) => proc) as any);
  if (!result.ok) throw new Error(result.error);
  return result.timestamp;
}

