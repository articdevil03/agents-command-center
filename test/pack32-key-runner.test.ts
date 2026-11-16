import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { registerHooks } from "node:module";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

const KEY = 'ccTEST-KEY-' + randomUUID() + '"/+\\';
let callbacks: any;
// Fake the adapter boundary so its own redaction cannot hide a broken runner guard.
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/server/runner.ts")) return result;
  const target = 'import { createAcpLeader } from "./leader-acp.ts";';
  assert.equal(String(result.source).split(target).length, 2);
  return { ...result, source: String(result.source).replace(target, 'const createAcpLeader = (globalThis as any).__p32RunnerAdapter;') };
} });
(globalThis as any).__p32RunnerAdapter = (_options: any, _folder: any, cb: any, deps: any) => {
  callbacks = cb;
  deps.spawnFn("synthetic", [], {});
  return { send() {}, stop() {} };
};
const { modules: runner } = await importWithTempDataRoot(() => import("../server/runner.ts"));
hook.deregister(); delete (globalThis as any).__p32RunnerAdapter;

for (const failure of [false, true]) test(`runner independently redacts whole and split output plus ${failure ? "spawn error" : "normal close"}`, () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const output: string[] = [], statuses: string[] = [];
  const run = { runId: randomUUID(), seatKey: "synthetic.runner", slotId: "coder", name: "Synthetic", cli: "acp:synthetic" as const, acp: { name: "Synthetic", program: "synthetic", args: [] }, model: "default", effort: "default", folder: scratchDir(), canWrite: false, startedAt: Date.now() };
  const result = runner.runSeat(run, "synthetic", { onOutput: (_, text) => output.push(text), onStatus: (_, status) => statuses.push(status) }, (() => child) as any, { keyLaunch: { env: {}, secrets: [KEY] } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const log = join(runner.logsDir, `${run.seatKey}-${result.timestamp}.log`), brief = join(runner.logsDir, `${run.seatKey}-${result.timestamp}.brief.txt`);
  try {
    callbacks.onDelta("Whole: " + KEY + " split: ");
    callbacks.onDelta(KEY.slice(0, 11)); callbacks.onDelta(KEY.slice(11) + " end.");
    if (failure) child.emit("error", new Error("Synthetic spawn " + KEY)); else child.emit("close", 0);
    assert.equal(runner.isRunning(run.runId), false);
    assert.equal(statuses.at(-1), failure ? "failed" : "done");
    const persisted = readFileSync(log, "utf8");
    for (const text of [persisted, output.join("")]) { assert.equal(text.includes(KEY), false); assert.match(text, /Whole: \[hidden\] split: \[hidden\] end\./); }
    if (failure) assert.match(persisted, /spawn error.*\[hidden\]/);
  } finally {
    if (runner.isRunning(run.runId)) child.emit("close", 1);
    for (const file of [log, brief]) unlinkSync(file);
    child.stdout.destroy(); child.stderr.destroy();
  }
});
