// Shared by the pack 18 orchestrator tests: the crew, a fake planner CLI that calls the real bridge, fake coder CLIs, and the helpers around a booted server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";
import { deriveSteps } from "../server/process.ts";

export const seat = (slot: string, name: string, role: string, cli: string, model: string, effort: string, canWrite: boolean, extra: Record<string, unknown> = {}) => ({ slot, name, role, cli, model, effort, canWrite, isLeader: slot === "leader", ...extra });
export const crew = () => [
  seat("leader", "Atlas", "Leader", "codex", "gpt-6-sol", "high", false),
  seat("planner", "Sage", "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true }),
  seat("coderA", "Ann", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true),
  seat("coderB", "Ben", "Coder", "opencode", "opencode/mimo-v2.6-flash-free", "max", true),
  seat("reviewer", "Rae", "Reviewer", "claude", "claude-opus-5-5[1m]", "medium", false),
];
export const tabIn = (work: string, id: string, lookPause = true) => {
  mkdirSync(join(work, id), { recursive: true });
  const members = crew();
  return { id, name: id, kind: "dev", folder: join(work, id), setupName: "Orch", crew: members, lookPause, steps: deriveSteps(members as any, lookPause) };
};

// The fake planner: runs plan.json from its folder against the real bridge, writes session.json (url, token) first and result.json after every call.
// A step is { call, args, save? } | { parallel: [...] } | { sleep } | { ping, every } | { untilStep, timeout }; "{{TOKEN}}" and "{{RUN:name}}" are filled in.
export const PLANNER_JS = `
const fs = require("fs");
const url = process.env.CC_CREW_URL, token = process.env.CC_CREW_TOKEN;
const path = require("path");
// The plan, session and result files live beside the tab folders, never in them (a file written in the folder reads as an outside change).
const base = path.join(__dirname, "plans", path.basename(process.cwd()));
if (!fs.existsSync(base + ".plan.json")) process.exit(0);
fs.writeFileSync(base + ".session.json", JSON.stringify({ url, token }));
const plan = JSON.parse(fs.readFileSync(base + ".plan.json", "utf8"));
const results = [], named = {};
let nextId = 1;
const save = () => fs.writeFileSync(base + ".result.json", JSON.stringify(results));
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text };
}
const sub = (v) => typeof v === "string" ? v.replace(/\\{\\{TOKEN\\}\\}/g, token).replace(/\\{\\{RUN:(\\w+)\\}\\}/g, (_, n) => named[n] ?? "missing") : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
async function one(step) {
  const res = await rpc("tools/call", { name: step.call, arguments: sub(step.args ?? {}) });
  const text = res.body?.result?.content?.[0]?.text ?? res.text;
  if (step.save) named[step.save] = /as run (\\S+)/.exec(text)?.[1];
  return { call: step.call, status: res.status, isError: res.body?.result?.isError === true, text };
}
(async () => {
  for (const step of plan) {
    if (step.sleep) await nap(step.sleep);
    else if (step.parallel) results.push(...await Promise.all(step.parallel.map(one)));
    else if (step.ping) { for (let i = 0; i < step.ping; i++) { const r = await rpc("ping", {}); results.push({ call: "ping", status: r.status }); save(); await nap(step.every); } }
    else if (step.untilStep) {
      const end = Date.now() + (step.timeout ?? 20000);
      for (;;) { const r = await one({ call: "get_crew_status" }); let id = null; try { id = JSON.parse(r.text).process.stepId; } catch {} if (id === step.untilStep || Date.now() > end) { results.push({ call: "untilStep", at: id }); break; } await nap(300); }
    } else results.push(await one(step));
    save();
  }
})().catch((e) => { results.push({ error: String(e) }); save(); });
`;
export const CMD_CODER = (name: string) => `@echo off\r\necho ran> "%CD%\\run-wrote-${name}.txt"\r\necho [%CC_CREW_URL%]> "%CD%\\env-crew-${name}.txt"\r\ntype "%CC_BRIEF_PATH%"\r\nif defined FAKE_SLEEP_${name.toUpperCase()} ping -n %FAKE_SLEEP_${name.toUpperCase()}% 127.0.0.1 >nul\r\nexit /b 0\r\n`;
export const fakeClis = ({ temp, bin }: { temp: string; bin: string }) => {
  writeFileSync(join(temp, "fake-planner.cjs"), PLANNER_JS);
  mkdirSync(join(temp, "plans"), { recursive: true });
  writeFileSync(join(bin, "codex.cmd"), `@echo off\r\nnode "%~dp0..\\fake-planner.cjs"\r\nexit /b 0\r\n`);
  writeFileSync(join(bin, "claude.cmd"), CMD_CODER("claude"));
  writeFileSync(join(bin, "opencode.cmd"), CMD_CODER("opencode"));
};

// The helpers that read and drive a booted server: pass a getter so they see the server and client the file booted in before().
export function orchKit(get: () => { srv: Server; c: Client }) {
  const planPath = (root: string, id: string, kind: string) => join(root, "plans", `${id}.${kind}.json`);
  const readJson = (path: string): any => { for (let i = 0; i < 5; i++) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* a write in progress */ } } return undefined; };
  const results = (id: string): any[] => existsSync(planPath(get().srv.temp, id, "result")) ? readJson(planPath(get().srv.temp, id, "result")) ?? [] : [];
  const setPlan = (id: string, plan: unknown[]) => writeFileSync(planPath(get().srv.temp, id, "plan"), JSON.stringify(plan));
  return {
    planPath, readJson, results, setPlan,
    dirOf: (id: string) => join(get().srv.work, id),
    session: async (id: string): Promise<{ url: string; token: string }> => { await get().c.wait(() => existsSync(planPath(get().srv.temp, id, "session")) && readJson(planPath(get().srv.temp, id, "session")), `${id}: the planner wrote its session`, 20_000); return readJson(planPath(get().srv.temp, id, "session")); },
    runPlanner: (id: string, plan: unknown[]) => { setPlan(id, plan); get().c.send({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: run the plan." }); },
    plannerRun: (id: string) => get().c.wait(() => get().c.tab(id).runs.find((run: any) => run.seatSlotId === "planner"), `${id}: the planner run is in the engine`),
    mode: async (id: string, value: string) => assert.deepEqual(await get().c.request({ type: "setPermissionMode", tabId: id, mode: value, confirm: true }), { ok: true }),
    planDone: (id: string, calls: number) => get().c.wait(() => results(id).length >= calls, `${id}: the planner made ${calls} calls`, 60_000),
    endedRuns: (id: string, count: number, ms = RUN_END_MS) => get().c.wait(() => get().c.runEnds(id) >= count, `${id}: ${count} runs ended`, ms),
  };
}
export const bridgeCall = async (url: string, token: string | null, method: string, params: object = {}) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await r.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
};
