import test from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as usage from "../server/usage.ts";
import * as stall from "../server/stall.ts";
import * as processEngine from "../server/process.ts";
import { tempRoot } from "./temp-root.ts";
import { config, leaderApi } from "./round2-setup.ts";
import { loadServer, connect, lastState, tick } from "./round2-helpers.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";

test("createLeader: a null native CLI path reaches the SDK builder without a fallback", () => {
  let options: any;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { options = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  assert.equal(Object.hasOwn(options, "pathToClaudeCodeExecutable"), false); instance.stop();
});

test("createLeader: a real result message reaches the usage callback scoped to the current model", async () => {
  const output: any[] = []; let resolve!: (value: any) => void;
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness(() => handle);
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (event: any) => output.push(event), onError() {} });
  await tick(0); resolve({ done: false, value: { type: "result", usage: { input_tokens: 4 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1000000 } }, total_cost_usd: 0.04 } }); await tick(0);
  assert.deepEqual(output[0], { modelId: "claude-opus-5-5[1m]", contextTokens: 4, contextWindow: 1000000, costUsd: 0.04 }); instance.stop();
});

test("createLeader: a resolved CLI path reaches the SDK options unchanged", () => {
  let options: any; const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }) };
  const createLeader = loadLeaderHarness((args) => { options = args.options; return handle; });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", "C:/bin/claude.exe", { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  assert.equal(options.pathToClaudeCodeExecutable, "C:/bin/claude.exe"); assert.equal(options.extraArgs.effort, "high"); instance.stop();
});

test("createLeader: a successful live model change scopes the next result to the new model", async () => {
  let resolve!: (value: any) => void; const received: any[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }), setModel: async () => {} };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (delta: any) => received.push(delta), onError() {} });
  await tick(0); assert.equal(await instance.setModel("claude-opus-5"), true);
  resolve({ done: false, value: { type: "result", usage: { input_tokens: 6 }, modelUsage: { "claude-opus-5": { contextWindow: 200000 } } } }); await tick(0);
  assert.equal(received[0].modelId, "claude-opus-5"); assert.equal(received[0].contextWindow, 200000); instance.stop();
});

test("createLeader: a live model change does not rewrite the model captured by an in-flight turn", async () => {
  let resolve!: (value: any) => void; const received: any[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((done) => { resolve = done; }), return: async () => ({ done: true }), setModel: async () => {} };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage: (delta: any) => received.push(delta), onError() {} });
  await tick(0); resolve({ done: false, value: { type: "result", usage: { input_tokens: 6 }, modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1000000 } } } }); await tick(0);
  assert.equal(received[0].modelId, "claude-opus-5-5[1m]"); instance.stop();
});

test("createLeader: setModel calls the SDK handle directly without stop, return, abort, or restart", async () => {
  let returns = 0, abortSignal: any; const models: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => { returns++; return { done: true }; }, setModel: async (model: string) => { models.push(model); } };
  const instance = loadLeaderHarness((args) => { abortSignal = args.options.abortController.signal; return handle; })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  await tick(0); assert.equal(await instance.setModel("claude-opus-5"), true);
  assert.deepEqual(models, ["claude-opus-5"]); assert.equal(returns, 0); assert.equal(abortSignal.aborted, false); instance.stop();
});

test("createLeader: setModel after stop is a no-op and never reaches the SDK handle", async () => {
  let calls = 0; const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: async () => ({ done: true }), setModel: async () => { calls++; } };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError() {} });
  await tick(0); instance.stop(); assert.equal(await instance.setModel("claude-opus-5"), false); assert.equal(calls, 0);
});

test("createLeader applies its startup mode and forwards live mode changes to the SDK handle", async () => {
  const startupModes: string[] = [], liveModes: string[] = [];
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => ({ done: true }),
    setPermissionMode: async (mode: string) => { liveModes.push(mode); },
  };
  const instance = loadLeaderHarness((args) => { startupModes.push(args.options.permissionMode); return handle; })(
    { model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null,
    { onDelta() {}, onDone() {}, onUsage() {}, onError() {} }, undefined, "bypass",
  );
  await tick(0);
  assert.deepEqual(startupModes, ["bypassPermissions"]);
  assert.equal(await instance.setPermissionMode("ask"), true);
  assert.deepEqual(liveModes, ["default"]);
  instance.stop();
});

test("createLeader returns false when a live permission apply resolves after stop", async () => {
  let resolvePermission!: () => void;
  const handle = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => ({ done: true }),
    setPermissionMode: () => new Promise<void>((resolve) => { resolvePermission = resolve; }),
  };
  const instance = loadLeaderHarness(() => handle)(
    { model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null,
    { onDelta() {}, onDone() {}, onUsage() {}, onError() {} },
  );
  await tick(0);
  const applying = instance.setPermissionMode("plan");
  await tick(0);
  instance.stop();
  resolvePermission();
  assert.equal(await applying, false, "the stopped SDK handle cannot report a successful live change");
});

test("isSeatBusy: working runs count as busy and completed process state does not", () => {
  const state = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "tab", folderPath: "C:/work" });
  assert.equal(processEngine.isBusy(state), false);
  const working = processEngine.runEvent(state, { type: "start", run: { id: "run-1", seatSlotId: "coder", label: "work", startedAt: 1 } });
  assert.equal(processEngine.isBusy(working), true);
  const done = processEngine.runEvent(working, { type: "finish", runId: "run-1", endedAt: 2, outcome: "done" });
  assert.equal(processEngine.isBusy(done), false);
});

test("launch brakes: kill blocks and launch-budget timestamps survive a fresh server module", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.launchWorker("alpha-dev", "reviewer2", "run then stop");
  const ws = connect(first); ws.message({ type: "killRun", runId: first.launched[0].run.runId });
  const restarted = await loadServer({ skipHealth: true, safetyPath });
  assert.deepEqual(restarted.safety().blocked, ["alpha-dev.reviewer2"]);
  assert.equal(restarted.safety().timestamps.length, 1);
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "client bypass").error, /launch blocked/);
  assert.match(restarted.leaderLaunch("alpha-dev", "reviewer2", "blocked").error, /launch blocked/);
});

test("launch brakes: a stall relaunch is recorded only after its real close callback and keeps the same brief", async () => {
  const server = await loadServer({ relaunchable: true, skipHealth: true, deferKill: true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "same original brief"); const first = server.launched[0];
  server.stallTrackers.startRun(first.run.runId, Date.now() - stall.STALL_THRESHOLD_MS - 1); server.tick();
  assert.equal(server.launched.length, 1); assert.equal(server.safety().timestamps.length, 1);
  server.closeRun(first.run.runId);
  assert.equal(server.launched.length, 2); assert.equal(server.launched[1].prompt, "same original brief");
  assert.equal(server.safety().timestamps.length, 1, "the automatic retry reuses its reserved launch and costs no second slot");
  assert.ok(ws.messages.some((message: any) => message.type === "runStop" && message.runId === first.run.runId));
});

test("launch notices: an offline launch survives restart, replays to the client, and its single-message ACK persists", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.leaderLaunch("alpha-dev", "coder", "offline notice");
  const restarted = await loadServer({ skipHealth: true, safetyPath }), ws = connect(restarted);
  ws.message({ type: "hello" });
  const notice = lastState(ws).launchSafety.notices[0];
  assert.equal(notice.brief, "offline notice");
  ws.message({ type: "ackLaunchNotice", id: notice.id });
  assert.equal(config.readLaunchSafety(safetyPath).notices.length, 0);
});

test("launch recovery UI: the released PID warning survives state replay and a confirmed close removes it", async () => {
  const server = await loadServer({ skipHealth: true, releaseUnconfirmed: () => true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0];
  entry.callback.onUnconfirmedKill(entry.run, 4321);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.deepEqual(JSON.parse(JSON.stringify(server.stateMessage().releasedProcesses)), [{ seatId: "alpha-dev.reviewer2", pid: 4321 }]);
  assert.equal(server.stateMessage().launchSafety.uncertain.length, 0);
  server.closeRun(entry.run.runId);
  assert.deepEqual(server.stateMessage().releasedProcesses, []);
});

test("launch recovery: a restarted server preserves unconfirmed ownership until the user deliberately releases it", async () => {
  const safetyPath = path.join(tempRoot(), "launch-safety.json"), first = await loadServer({ skipHealth: true, safetyPath });
  first.launchWorker("alpha-dev", "reviewer2", "uncertain"); const entry = first.launched[0]; entry.callback.onUnconfirmedKill(entry.run, 7654);
  const restarted = await loadServer({ skipHealth: true, safetyPath });
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "blocked").error, /unconfirmed process/);
  const ws = connect(restarted); ws.message({ type: "releaseUnconfirmedSeat", seatId: "alpha-dev.reviewer2", confirm: "release may leave a process running and editing files" });
  assert.equal(restarted.launchSafety.uncertain.length, 0);
  assert.equal(restarted.launchSafety.released[0].pid, 7654);
  assert.match(restarted.launchWorker("alpha-dev", "reviewer2", "still blocked").error, /launch blocked/);
  ws.message({ type: "unblockSeat", seatKey: "alpha-dev.reviewer2", confirm: "allow this seat to launch again" });
  assert.equal(restarted.launchWorker("alpha-dev", "reviewer2", "explicitly released").ok, true);
});

test("launch recovery: retry keeps unconfirmed ownership until explicit release frees the seat", async () => {
  const server = await loadServer({ skipHealth: true, deferKill: true, releaseUnconfirmed: () => true }), ws = connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "uncertain run"); const entry = server.launched[0]; entry.callback.onUnconfirmedKill(entry.run, 2222);
  assert.match(server.launchWorker("alpha-dev", "reviewer2", "blocked").error, /unconfirmed process/);
  ws.message({ type: "killRun", runId: entry.run.runId }); assert.deepEqual(server.kills, [entry.run.runId]);
  ws.message({ type: "releaseUnconfirmedSeat", seatId: entry.run.seatKey, confirm: "release may leave a process running and editing files" });
  assert.equal(server.launchSafety.released[0].runId, entry.run.runId);
  assert.match(server.launchWorker("alpha-dev", "reviewer2", "still blocked").error, /launch blocked/);
  ws.message({ type: "unblockSeat", seatKey: entry.run.seatKey, confirm: "allow this seat to launch again" });
  assert.equal(server.launchWorker("alpha-dev", "reviewer2", "after explicit release").ok, true);
  for (const launched of server.launched) server.closeRun(launched.run.runId, 0);
  assert.equal(server.active.size, 0, "every run this test started is closed");
});

test("launch safety: a failed durable reservation blocks spawn, but disk failure never suppresses Kill", async () => {
  let fail = true; const server = await loadServer({ skipHealth: true, failSafety: () => fail }), ws = connect(server);
  assert.equal(server.launchWorker("alpha-dev", "reviewer2", "must not spawn").ok, false);
  assert.equal(server.launched.length, 0); fail = false;
  server.launchWorker("alpha-dev", "reviewer2", "running"); const id = server.launched[0].run.runId; fail = true;
  ws.message({ type: "killRun", runId: id }); assert.deepEqual(server.kills, [id]);
});

test("launch safety: corrupt persisted state refuses startup instead of resetting brakes", async () => {
  const safetyPath = path.join(tempRoot(), "corrupt-launch-safety.json"); await writeFile(safetyPath, "not JSON");
  await assert.rejects(loadServer({ skipHealth: true, safetyPath }), /JSON|Unexpected/);
});

test("leader health-check options strip CC_DATA_DIR from the actual SDK environment", async () => {
  const previousRoot = process.env.CC_DATA_DIR, previousPackaged = process.env.CC_TEST_FORCE_PACKAGED;
  process.env.CC_DATA_DIR = "C:/private/never-open-this"; process.env.CC_TEST_FORCE_PACKAGED = "1"; process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  let env: any;
  try {
    const server = await loadServer({ realLeaderOptions: true, query: (args) => { env = args.options.env; return { [Symbol.asyncIterator]: async function* () { yield { type: "result" }; } }; } });
    await server.leaderHealthCheck;
  } finally {
    delete process.env.CC_APP_KEY;
    if (previousRoot === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previousRoot;
    if (previousPackaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = previousPackaged;
  }
  assert.equal(Object.hasOwn(env, "CC_DATA_DIR"), false); assert.equal(Object.hasOwn(env, "CC_TEST_FORCE_PACKAGED"), false); assert.equal(Object.hasOwn(env, "CC_APP_KEY"), false, "the leader's SDK child never sees the app key");
});

test("leader launch strips CC_DATA_DIR from the actual SDK options", () => {
  const previousRoot = process.env.CC_DATA_DIR, previousPackaged = process.env.CC_TEST_FORCE_PACKAGED;
  process.env.CC_DATA_DIR = "C:/private/never-open-this"; process.env.CC_TEST_FORCE_PACKAGED = "1"; process.env.CC_APP_KEY = "test-app-key-must-not-leak";
  try {
    const options = leaderApi.buildLeaderOptions({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null);
    assert.equal(Object.hasOwn(options.env, "CC_DATA_DIR"), false); assert.equal(Object.hasOwn(options.env, "CC_TEST_FORCE_PACKAGED"), false); assert.equal(Object.hasOwn(options.env, "CC_APP_KEY"), false);
  } finally {
    delete process.env.CC_APP_KEY;
    if (previousRoot === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previousRoot;
    if (previousPackaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = previousPackaged;
  }
});

test("leader stop settles waiting input, aborts and returns the query, and suppresses late errors", async () => {
  let input: any, output!: (value: any) => void, returns = 0; const errors: string[] = [], deltas: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((resolve) => { output = resolve; }), return: async () => { returns++; output?.({ done: true }); return { done: true }; } };
  const instance = loadLeaderHarness((args) => { input = args.prompt; return handle; })({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta: (text: string) => deltas.push(text), onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); const pending = input.next(); instance.stop();
  const settled = await Promise.race([pending, tick(100).then(() => "hung")]); assert.notEqual(settled, "hung");
  output({ done: false, value: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } } } }); await tick(0);
  assert.equal(returns, 1); assert.deepEqual(deltas, []); assert.deepEqual(errors, []);
});

test("leader stop then a rejecting iterator reports no error to the client and the leader is dead", async () => {
  let reject!: (error: Error) => void; const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((_ok, no) => { reject = no; }), return: async () => ({ done: true }) };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); instance.stop();
  reject(new Error("late sdk failure")); await tick(0);
  assert.deepEqual(errors, []); assert.equal(instance.isDead(), true);
});

test("leader send after an intentional stop is ignored: no 'not available' error reaches the client", async () => {
  let output!: (value: any) => void; const errors: string[] = [];
  const handle = { [Symbol.asyncIterator]() { return this; }, next: () => new Promise((resolve) => { output = resolve; }), return: async () => { output?.({ done: true }); return { done: true }; } };
  const instance = loadLeaderHarness(() => handle)({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); instance.stop(); await tick(0);
  assert.equal(instance.isDead(), true, "control: the stopped leader's loop has ended, so send would reach the dead branch");
  instance.send("after stop");
  assert.deepEqual(errors, []);
});

test("listHistory rejects an unsafe seat key before asking the filesystem for any directory", async () => {
  const reads: string[] = [], server = await loadServer({ skipHealth: true, readdir: (async (dir: any) => { reads.push(String(dir)); return readdir(dir); }) as any }), ws = connect(server);
  const before = reads.length; ws.message({ type: "historyList", seatKey: "../escape" }); await tick();
  assert.equal(reads.length, before); assert.match(ws.messages.at(-1).message, /invalid seat key/);
});

test("listHistory reports a missing or unreadable logs directory instead of returning fake empty history", async () => {
  const server = await loadServer({ skipHealth: true, readdir: (async () => { throw new Error("logs directory missing"); }) as any }), ws = connect(server);
  ws.message({ type: "historyList", seatKey: "alpha-dev.reviewer2" }); await tick();
  assert.match(ws.messages.at(-1).message, /logs directory missing/);
});

test("message handler catches a dispatch error and continues handling a following valid message", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "useSetup", tabId: "missing", templateId: "solo" });
  ws.message({ type: "hello" });
  assert.ok(ws.messages.some((message: any) => message.type === "error" && /unknown tab/.test(message.message)));
  assert.ok(lastState(ws));
});

test("normal leader iterator completion marks the leader dead and reports the ended instance once", async () => {
  const errors: string[] = [], createLeader = loadLeaderHarness(() => ({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => ({ done: true }) }));
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0); assert.equal(instance.isDead(), true); assert.equal(errors.length, 1);
});

test("a dead tab leader rejects new chat instead of silently queueing it for a replacement", async () => {
  let input: any;
  const errors: string[] = [];
  const createLeader = loadLeaderHarness((args) => {
    input = args.prompt;
    return { [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => ({ done: true }) };
  });
  const instance = createLeader({ model: "claude-opus-5-5[1m]", effort: "high" }, "C:/work", null, { onDelta() {}, onDone() {}, onUsage() {}, onError: (error: string) => errors.push(error) });
  await tick(0);
  assert.equal(instance.isDead(), true);
  instance.send("must not queue");
  assert.match(errors.at(-1) ?? "", /not available/);
  const pending = input.next();
  const result = await Promise.race([pending, tick(20).then(() => undefined)]);
  assert.equal(result, undefined, "dead leader input must not yield the rejected chat to its old prompt stream");
  instance.stop();
  assert.equal((await pending).done, true);
});

test("null-message guard: the actual WebSocket callback rejects invalid envelopes and stays alive", async () => {
  const server = await loadServer({ skipHealth: true }), ws = connect(server);
  for (const raw of ["null", "[]", "3", "{}", "{\"type\":3}"]) ws.message(raw);
  assert.equal(ws.messages.filter((message: any) => message.type === "error").length, 5);
  ws.message({ type: "hello" }); assert.ok(lastState(ws));
});

test("output trim: the real runner callback keeps a 200KB UTF-8 cap at whole-character boundaries", async () => {
  const server = await loadServer({ skipHealth: true }); connect(server);
  server.launchWorker("alpha-dev", "reviewer2", "large output"); const entry = server.launched[0];
  server.emitOutput(entry.run.runId, "🙂".repeat(90_000));
  const run = server.stateMessage().projects[0].tabs[0].runs.find((item: any) => item.runId === entry.run.runId);
  assert.equal(Buffer.byteLength(run.output, "utf8"), 200 * 1024); assert.equal(run.output.endsWith("🙂"), true);
});
