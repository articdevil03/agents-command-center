import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixedServer, plan } from "./fixed-crew-execution-helpers.ts";

// A Codex-like worker: it echoes the actual brief and a lot of tool output on stderr, then prints its final report on stderr AND stdout,
// through real pipes (the server's own stdout/stderr listeners feed the log). Everything it does is driven by worker-options.json.
export const CODEX_LIKE_WORKER = `
const fs = require('fs'), path = require('path');
const brief = fs.readFileSync(process.env.CC_BRIEF_PATH, 'utf8');
const o = JSON.parse(fs.readFileSync(path.join(path.resolve(process.cwd(), '..'), 'worker-options.json'), 'utf8'));
const identity = (key) => { const part = brief.split(key + ' (')[1]; if (!part) return undefined; try { return JSON.parse(part.split(')')[0]); } catch { return undefined; } };
const runId = identity('runId'), taskId = identity('taskId'), planVersion = identity('planVersion');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const put = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
const size = (report) => Buffer.byteLength(JSON.stringify(report));
function build() {
  const report = { version: 1, runId: o.foreign ? 'another-run' : runId, taskId, planVersion, evidence: o.evidence ?? ['owned.txt'], plan: o.plan ?? null, findings: [], resolved: [], baseFinal: null, unchanged: [], decisions: [] };
  if (o.bytes) {
    // A schema-valid report of exactly o.bytes: padded with unique safe paths (500 per list), then 'é' (2 bytes) swapped for 'a' inside the plan scope.
    report.plan = { ...report.plan, scope: 'a'.repeat(3000) };
    report.evidence = [];
    for (let n = 0; size(report) + 504 <= o.bytes; n++) (report.unchanged.length < 500 ? report.unchanged : report.evidence).push(('p' + n + '/').padEnd(499, 'x') + 'y');
    const missing = o.bytes - size(report);
    if (missing < 0 || missing > 3000) throw new Error('cannot reach ' + o.bytes + ': ' + missing);
    report.plan.scope = 'é'.repeat(missing) + 'a'.repeat(3000 - missing);
    if (size(report) !== o.bytes) throw new Error('size ' + size(report) + ' != ' + o.bytes);
  }
  return report;
}
const block = (json, eol = '\\n') => 'CC_REPORT_BEGIN' + eol + json + eol + 'CC_REPORT_END' + eol;
async function emit(stream, text) {
  if (!o.split) return put(stream, text);
  for (let at = 0; at < text.length; at += o.split) { await put(stream, text.slice(at, at + o.split)); await sleep(1); }
}
(async () => {
  fs.appendFileSync(path.join(path.resolve(process.cwd(), '..'), 'worker-observed.jsonl'), JSON.stringify({ pid: process.pid, briefPath: process.env.CC_BRIEF_PATH, brief }) + '\\n');
  await sleep(Math.min(o.delay ?? 0, 15000));
  if (o.write) fs.writeFileSync(path.join(process.cwd(), 'owned.txt'), o.write);
  await put(process.stderr, 'user instructions:\\n' + brief + '\\n');
  const line = 'exec: tool output that is not a report '.padEnd(120, '.') + '\\n';
  for (let sent = 0; sent < (o.megabytes ?? 0) * 1024 * 1024; sent += line.length * 512) await put(process.stderr, line.repeat(512));
  if (o.giantLineMb) { await put(process.stderr, 'g'.repeat(o.giantLineMb * 1024 * 1024)); await put(process.stderr, '\\n'); }
  const json = JSON.stringify(build());
  const eol = o.crlf ? '\\r\\n' : '\\n';
  let outText = block(json, eol), errText = block(json);
  if (o.variant === 'different') outText = block(JSON.stringify({ ...build(), evidence: [] }));
  if (o.variant === 'unfinished') { outText = 'CC_REPORT_BEGIN\\n' + json + '\\n'; errText = ''; }
  if (o.variant === 'nested') { outText = 'CC_REPORT_BEGIN\\nCC_REPORT_BEGIN\\n' + json + '\\nCC_REPORT_END\\n'; errText = ''; }
  if (o.variant === 'malformed') { outText = block(json.slice(0, 40)); errText = ''; }
  if (o.variant === 'single') errText = '';
  const first = o.order === 'stdout-first' ? [process.stdout, outText] : [process.stderr, errText];
  const second = o.order === 'stdout-first' ? [process.stderr, errText] : [process.stdout, outText];
  if (first[1]) await emit(first[0], first[1]);
  await sleep(40);
  if (second[1]) await emit(second[0], second[1]);
  process.exitCode = o.exit ?? 0;
})();
`;

export async function reportsServer(options: { secondTab?: boolean } = {}) {
  return fixedServer({ ...options, extra: ({ temp }) => writeFileSync(join(temp, "worker.cjs"), CODEX_LIKE_WORKER) });
}
export type ReportsServer = Awaited<ReturnType<typeof reportsServer>>;

// One real Planner run with the given worker behaviour; accept() goes through the actual tool route.
export async function planned(f: ReportsServer, options: Record<string, unknown> = {}) {
  f.worker({ plan: plan(), ...options });
  const started = await f.tool("begin_planning", { expected: f.expected(), brief: "Inspect and return a plan" });
  if (!started.ok) throw new Error(started.text);
  await f.ended(started.value.runId);
  return { runId: started.value.runId as string, accept: () => f.tool("accept_planner_report", { expected: f.expected(), runId: started.value.runId }) };
}
// One real worker run of an approved task action; verify() is the actual evidence tool.
export async function acted(f: ReportsServer, kind: string, options: Record<string, unknown> = {}) {
  f.worker({ ...options });
  const run = await f.action(kind);
  if (!run.ok) throw new Error(run.text);
  await f.ended(run.value.runId);
  return { runId: run.value.runId as string, verify: (checkName: string | null = null) => f.verify(run.value.runId, checkName) };
}
export const logSize = (f: ReportsServer, runId: string): number => statSync(f.journal().executions.find((entry: any) => entry.id === runId).logPath).size;
export const unchanged = (f: ReportsServer) => ({ task: JSON.stringify(f.task()), journal: JSON.stringify(f.journal().executions.map((entry: any) => [entry.id, entry.status, entry.consumed, entry.processEnded])) });
export const CAP = 256 * 1024;
