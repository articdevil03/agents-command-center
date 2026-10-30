import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as usage from "../server/usage.ts";
import * as stall from "../server/stall.ts";
import * as agentUsage from "../server/agent-usage.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { fixtureWorkspaces, loadServer, loadRunnerHarness, isolatedRunnerProc, isolatedRunnerCapture, isolatedRun, connect, lastState, tick } from "./round2-helpers.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";

test("cleanScratch removes expired uploads while preserving fresh files", async () => {
  const server = await loadServer({ skipHealth: true });
  const dir = path.join(server.testRoot, "scratch-clean-test");
  mkdirSync(dir);
  const fresh = path.join(dir, "paste-33333333-3333-3333-3333-333333333333.png"), expired = path.join(dir, "paste-44444444-4444-4444-4444-444444444444.png");
  writeFileSync(fresh, "fresh");
  writeFileSync(expired, "expired");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(expired, old, old);
  try {
    await server.cleanScratch(dir);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(expired), false);
  } finally { removeWithRetry(dir); }
});

test("cleanScratch deletes only its own generated upload names, only regular files, and never through a link", async () => {
  const server = await loadServer({ skipHealth: true });
  const dir = path.join(server.testRoot, "scratch-own-names"), outside = path.join(server.testRoot, "scratch-outside"), link = path.join(server.testRoot, "scratch-link");
  mkdirSync(dir); mkdirSync(outside);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const uuid = "55555555-5555-5555-5555-555555555555";
  const generated = [path.join(dir, "paste-" + uuid + ".png"), path.join(dir, "file-" + uuid + ".txt")];
  const foreign = [path.join(dir, "notes.txt"), path.join(dir, "paste-" + uuid + ".exe"), path.join(dir, "mine.png")];
  for (const file of [...generated, ...foreign]) { writeFileSync(file, "x"); utimesSync(file, old, old); }
  const lookalikeDir = path.join(dir, "paste-66666666-6666-6666-6666-666666666666.png"); mkdirSync(lookalikeDir); utimesSync(lookalikeDir, old, old);
  const important = path.join(outside, "paste-" + uuid + ".png"); writeFileSync(important, "keep me"); utimesSync(important, old, old);
  try {
    await server.cleanScratch(dir);
    assert.deepEqual(generated.map((file) => existsSync(file)), [false, false], "the generated names go");
    assert.deepEqual(foreign.map((file) => existsSync(file)), [true, true, true], "anything else stays, however old");
    assert.equal(existsSync(lookalikeDir), true, "a folder named like an upload stays");
    symlinkSync(outside, link, "junction");
    await server.cleanScratch(link);
    assert.equal(existsSync(important), true, "a scratch folder that is a junction is skipped, nothing outside is deleted");
  } finally { try { rmdirSync(link); } catch { /* removes the link itself only, never what it points at */ } removeWithRetry(dir); removeWithRetry(outside); }
});

test("start-up cleans the scratch folder itself: an old generated upload is deleted, an old file that is not one of ours and a fresh upload stay", async () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const names = { oldUpload: "paste-77777777-7777-7777-7777-777777777777.png", freshUpload: "paste-88888888-8888-8888-8888-888888888888.png", oldForeign: "notes.txt" };
  // The files exist BEFORE the server starts: nothing here calls cleanScratch, so only the call made while the server starts can remove one.
  const server = await loadServer({ skipHealth: true, preload: (root) => {
    const dir = path.join(root, "scratch");
    mkdirSync(dir, { recursive: true });
    for (const name of Object.values(names)) writeFileSync(path.join(dir, name), "x");
    utimesSync(path.join(dir, names.oldUpload), old, old);
    utimesSync(path.join(dir, names.oldForeign), old, old);
  } });
  const dir = server.scratchDir;
  assert.equal(path.dirname(dir), server.testRoot, "the scratch folder the server cleaned is the one the fixture was put in");
  assert.equal(existsSync(path.join(dir, names.oldUpload)), false, "the old generated upload was deleted at start-up");
  assert.equal(existsSync(path.join(dir, names.freshUpload)), true, "a fresh upload stays");
  assert.equal(existsSync(path.join(dir, names.oldForeign)), true, "an old file that is not a generated upload name stays");
});

test("MONEY GUARD 1: a rejected runner start preserves the active run's relaunch allowance and next prompt", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "run", tabId: "alpha-dev", slot: "reviewer2", prompt: "active brief" });
  const active = server.launched[0]; server.stallTrackers.markRelaunched(active.run.runId, active.run.startedAt);
  const priorTimestamps = [...server.safety().timestamps], priorNotices = [...server.safety().notices];
  server.rejectRun();
  const refused = server.launchWorker("alpha-dev", "reviewer2", "refused brief");
  assert.equal(refused.ok, false);
  assert.deepEqual(server.safety().timestamps, priorTimestamps, "a runner refusal rolls back its launch-budget reservation");
  assert.deepEqual(server.safety().notices, priorNotices, "a runner refusal removes its pending notice");
  assert.equal(server.runContexts.get(active.run.runId).prompt, "active brief");
  assert.equal(server.stallTrackers.trackers.get(active.run.runId).relaunched, true);
  const accepted = server.launchWorker("alpha-dev", "reviewer2", "next brief");
  assert.equal(accepted.ok, true);
  assert.equal(server.launched.at(-1).prompt, "next brief");
  assert.equal(server.safety().timestamps.length, priorTimestamps.length + 1);
});

test("MONEY GUARD 1c: a rejected second start leaves the active tab, slot, and prompt context unchanged", async () => {
  const server = await loadServer({ skipHealth: true });
  server.launchWorker("alpha-design", "designer", "design the page");
  const active = server.launched[0]; server.rejectRun();
  const refused = server.launchWorker("alpha-design", "designer", "must not replace it");
  assert.equal(refused.ok, false);
  assert.deepEqual([server.runContexts.get(active.run.runId).tabId, server.runContexts.get(active.run.runId).slot, server.runContexts.get(active.run.runId).prompt], ["alpha-design", "designer", "design the page"]);
});

test("MONEY GUARD 3 (call site): any actual output before the stall causes escalation and no relaunch", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "has started real work"); const active = server.launched[0];
  server.emitOutput(active.run.runId, "made progress");
  server.stallTrackers.trackers.get(active.run.runId).lastGrowthAt = Date.now() - stall.STALL_THRESHOLD_MS - 1; server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("MONEY GUARD 4: a writable Claude crew slot is escalated, never automatically rerun", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  server.launchWorker("alpha-design", "designer", "design task"); const active = server.launched[0];
  assert.equal(active.run.cli, "claude"); assert.equal(active.run.canWrite, true);
  server.stallTrackers.startRun(active.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("MONEY GUARD 4: an OpenCode worker is unsafe for automatic relaunch even when its slot is read-only", async () => {
  const workspaces = fixtureWorkspaces();
  const reviewer = workspaces.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2")!;
  reviewer.cli = "opencode"; reviewer.model = "vendor/model-a"; reviewer.effort = "max";
  const server = await loadServer({ skipHealth: true, workspaces }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "review task"); const active = server.launched[0];
  assert.equal(active.run.cli, "opencode"); assert.equal(active.run.canWrite, false);
  server.stallTrackers.startRun(active.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.kills.length, 0);
  assert.ok(ws.messages.some((item: any) => item.type === "runStalled" && item.action === "escalate"));
});

test("WS call site: client preference updates validate, persist to the isolated file, and broadcast", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "updateClientPref", key: "sidebarCollapsed", value: true });
  assert.equal(server.prefWrites.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(server.testRoot, "client-prefs.json"), "utf8")).sidebarCollapsed, true);
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, true);
  ws.message({ type: "updateClientPref", key: "sidebarCollapsed", value: "yes" });
  assert.equal(server.prefWrites.length, 1, "invalid input must never write");
  assert.equal(lastState(ws).clientPrefs.sidebarCollapsed, true);
});

test("an Atlas-started run can be killed immediately by its real run ID", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  assert.equal(server.leaderLaunch("alpha-dev", "coder", "Atlas task").ok, true);
  const run = server.launched[0].run;
  ws.message({ type: "killRun", runId: run.runId });
  assert.deepEqual(server.kills, [run.runId]);
  assert.equal(server.active.has(run.runId), false);
  assert.ok(ws.messages.some((item: any) => item.type === "runStop" && item.runId === run.runId));
});

test("a rejected leader transport marks the leader dead, reports once, and makes the next send safe", async () => {
  const errors: string[] = [];
  const createLeader = loadLeaderHarness(() => ({ [Symbol.asyncIterator]() { return this; }, next: () => Promise.reject(new Error("transport rejected")), return: async () => ({ done: true }) }));
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (value: string) => errors.push(value) });
  await tick(0); assert.equal(instance.isDead(), true); assert.equal(errors.length, 1);
  assert.doesNotThrow(() => instance.send("queued after failure"));
  assert.equal(errors.length, 2); assert.match(errors[1], /not available/);
});

test("a message queued before the leader iterator fails is still reported and never throws on send", async () => {
  let reject!: (error: Error) => void;
  const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness(() => handle);
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (value: string) => errors.push(value) });
  await tick(0); instance.send("first queued message"); instance.send("second queued message");
  reject(new Error("stream failed while input waited")); await tick(0);
  assert.equal(instance.isDead(), true); assert.equal(errors.filter((value) => value.includes("stream failed")).length, 1);
  assert.doesNotThrow(() => instance.send("later"));
});

test("agent-usage: a Claude final partial line is held through an unconfirmed kill and flushed once on close", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), killer = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  const line = JSON.stringify({ type: "result", result: "final Claude answer", usage: {}, modelUsage: {} });
  harness.runSeat(isolatedRun({ runId: "claude-held", seatKey: "usage-tab.claude", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(line));
  harness.killRun("claude-held", ((command: string) => command === "taskkill" ? killer : proc) as any); killer.emit("error", new Error("kill refused"));
  assert.equal(capture.events.some((event) => event.text?.includes("final Claude answer")), false);
  proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.text?.includes("final Claude answer")).length, 1);
});

test("agent-usage: the actual Claude run command carries stream-json flags", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(); let command = "";
  const run = isolatedRun({ runId: "claude-stream-flags", cli: "claude", model: "claude-opus-5-5[1m]" });
  const started = harness.runSeat(run, "x", isolatedRunnerCapture().callbacks, ((cmd: string) => { command = cmd; return proc; }) as any);
  assert.equal(started.ok, true); assert.match(command, /--output-format stream-json --verbose/); proc.emit("close", 0);
});

test("agent-usage: a huge Claude system error line is capped before it reaches the output pane", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  const run = isolatedRun({ runId: "system-cap", cli: "claude", model: "claude-opus-5-5[1m]" });
  harness.runSeat(run, "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "error_diagnostic", is_error: true, stderr: "x".repeat(20_000) }) + "\n")); proc.emit("close", 0);
  const shown = capture.events.filter((event) => event.type === "output").map((event) => event.text).join("");
  assert.ok(shown.length <= 220); assert.match(shown, /truncated/);
});

test("agent-usage: each new Claude run starts with its own usage accumulator", () => {
  const harness = loadRunnerHarness(), first = isolatedRunnerProc(), second = isolatedRunnerProc();
  const a = isolatedRunnerCapture(), b = isolatedRunnerCapture();
  const run = isolatedRun({ runId: "usage-first", seatKey: "usage-tab.sonny", model: "claude-opus-5-5[1m]" });
  const result1 = { type: "result", usage: { input_tokens: 7 }, modelUsage: {}, total_cost_usd: 0.1 };
  harness.runSeat(run, "x", a.callbacks, (() => first) as any); first.stdout.emit("data", Buffer.from(JSON.stringify(result1) + "\n")); first.emit("close", 0);
  harness.runSeat({ ...run, runId: "usage-second" }, "x", b.callbacks, (() => second) as any); second.stdout.emit("data", Buffer.from(JSON.stringify({ ...result1, usage: { input_tokens: 2 }, total_cost_usd: 0.02 }) + "\n")); second.emit("close", 0);
  assert.equal(a.events.find((event) => event.type === "usage").usage.contextTokens, 7);
  assert.equal(b.events.find((event) => event.type === "usage").usage.contextTokens, 2);
});

test("agent-usage: a normal Claude close emits one usage delta for its one result", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "once-usage", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: 5 }, modelUsage: {}, total_cost_usd: 0.01 }) + "\n")); proc.emit("close", 0); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: a captured Claude assistant and result stream renders text and scopes its usage", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "claude-stream", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5[1m]", content: [{ type: "text", text: "clean response" }] } }) + "\n"));
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "clean response", usage: { input_tokens: 12 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1_000_000 } }, total_cost_usd: 0.1 }) + "\n")); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "output").map((event) => event.text).join(""), "clean response\n");
  assert.deepEqual(capture.events.find((event) => event.type === "usage").usage, { modelId: "claude-opus-5-5[1m]", contextTokens: 12, contextWindow: 1_000_000, costUsd: 0.1 });
});

test("agent-usage: Claude result text reaches output before the usage callback fires", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "order-usage", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result: "text first", usage: {}, modelUsage: {} }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.filter((event) => ["output", "usage"].includes(event.type)).map((event) => event.type), ["output", "usage"]);
});

test("agent-usage: a blank line after the Codex footer does not erase its held measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-blank", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n19,878\n\n"));
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", 0);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 19878);
});

test("agent-usage: OpenCode never fabricates a usage entry when it reports no measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "opencode-no-usage", cli: "opencode", model: "vendor/model-a", effort: "max" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from("ordinary text\n")); proc.emit("close", 0);
  assert.equal(capture.events.some((event) => event.type === "usage"), false);
});

test("agent-usage: an unconfirmed kill does not flush a held Codex measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), killer = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-held-kill", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n1000\n")); harness.killRun("codex-held-kill", ((command: string) => command === "taskkill" ? killer : proc) as any); killer.emit("error", new Error("no taskkill"));
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: a taskkill spawn error holds Codex usage until the later real close", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-taskkill-error", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n2000\n"));
  harness.killRun("codex-taskkill-error", (() => { const killer = isolatedRunnerProc(); queueMicrotask(() => killer.emit("error", new Error("spawn failed"))); return killer; }) as any);
  assert.equal(capture.events.some((event) => event.type === "usage"), false); proc.emit("close", null);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
});

test("agent-usage: Codex footer counts are held, not surfaced before close", () => {
  const state = agentUsage.createAgentUsageState();
  assert.deepEqual(agentUsage.scanCodexTokens(state, "tokens used\n1234\n"), []);
  assert.deepEqual(agentUsage.flushCodexTokens(state), [{ modelId: null, contextTokens: 1234, contextWindow: null, costUsd: null }]);
});

test("agent-usage: footer-like prose followed by ordinary text is unmeasured at close", () => {
  const state = agentUsage.createAgentUsageState();
  agentUsage.scanCodexTokens(state, "tokens used\n1234\nnot a footer\n");
  assert.deepEqual(agentUsage.flushCodexTokens(state), []);
});

test("agent-usage: a Claude rate-limit event reaches the runner's plan-window callback", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "rate-limit", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 123 } } } }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.find((event) => event.type === "rateLimit").windows, { five_hour: { utilization: 0.2, resetsAt: 123 } });
});

test("agent-usage: Codex stdout after its stderr footer does not erase the held measurement", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "stdout-after-footer", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n5000\n")); proc.stdout.emit("data", Buffer.from("final answer\n")); proc.emit("close", 0);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 5000);
  assert.ok(capture.events.some((event) => event.text === "final answer\n"));
});

test("agent-usage: system failures and unknown Claude shapes stay visible while known lifecycle noise stays quiet", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "system-shapes", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  proc.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "system", subtype: "error", stderr: "failed" }),
    JSON.stringify({ type: "future_event", value: 1 }),
  ].join("\n") + "\n")); proc.emit("close", 0);
  const text = capture.events.filter((event) => event.type === "output").map((event) => event.text).join("");
  assert.doesNotMatch(text, /\[system\] init/); assert.match(text, /\[error\] error/); assert.match(text, /future_event/);
});

test("agent-usage: Codex stderr footer, stdout answer, and close produce one real usage delta", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "codex-order", cli: "codex", model: "gpt-6-sol" }), "x", capture.callbacks, (() => proc) as any);
  proc.stderr.emit("data", Buffer.from("tokens used\n3,210\n")); proc.stdout.emit("data", Buffer.from("done\n")); proc.emit("close", 0);
  assert.equal(capture.events.filter((event) => event.type === "usage").length, 1);
  assert.equal(capture.events.find((event) => event.type === "usage").usage.contextTokens, 3210);
});

test("agent-usage: two results in one Claude run produce two deltas instead of resetting the turn count", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "two-turns", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  for (const tokens of [3, 8]) proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: tokens }, modelUsage: {}, total_cost_usd: tokens / 100 }) + "\n")); proc.emit("close", 0);
  assert.deepEqual(capture.events.filter((event) => event.type === "usage").map((event) => event.usage.contextTokens), [3, 8]);
});

test("agent-usage: malformed Claude JSON is passed through verbatim by the real runner", () => {
  const harness = loadRunnerHarness(), proc = isolatedRunnerProc(), capture = isolatedRunnerCapture();
  harness.runSeat(isolatedRun({ runId: "malformed-claude", model: "claude-opus-5-5[1m]" }), "x", capture.callbacks, (() => proc) as any);
  const bad = "{not json but visible}"; proc.stdout.emit("data", Buffer.from(bad + "\n")); proc.emit("close", 0);
  assert.ok(capture.events.some((event) => event.type === "output" && event.text === bad + "\n"));
});
