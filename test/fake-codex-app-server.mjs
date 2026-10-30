// A fake `codex app-server`: newline-delimited JSON-RPC over stdio. The user message text is a JSON array of steps
// (see runTurn); plain text just gets a reply. Every message the server sends us is appended to FAKE_LEADER_LOG.
import { appendFileSync } from "node:fs";
const log = (entry) => { if (process.env.FAKE_LEADER_LOG) appendFileSync(process.env.FAKE_LEADER_LOG, JSON.stringify({ cli: "codex", ...entry }) + "\n"); };
// startedAt (about the process's creation time) lets a teardown tell this process from a later one that reused its pid.
log({ started: true, pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000) });
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const waiting = new Map();
const lateRaws = [];
let nextServerId = 1000, turns = 0, usageTotal = 0, staleBefore = null, staleTurnBefore = false, noIdBefore = false, unidentBefore = false, unidentErrorBefore = false, staleCallBefore = false, earlyBefore = null, earlyMethod = "item/tool/call", lastTurnId = null;
const callClient = (method, params) => new Promise((resolve) => { const id = nextServerId++; waiting.set(id, resolve); out({ id, method, params }); });
const notify = (method, params) => out({ method, params });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function handle(message) {
  if (message.method === undefined && message.id !== undefined) { log({ response: message.id, result: message.result, error: message.error }); waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  log({ method: message.method, params: message.params });
  if (message.method === "initialize") out({ id: message.id, result: { userAgent: "fake-codex", codexHome: "fake", platformFamily: "windows", platformOs: "windows" } });
  else if (message.method === "thread/start") out({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params.model } });
  else if (message.method === "turn/start" && process.env.FAKE_CODEX_TURN_START_FAILS === "1") out({ id: message.id, error: { message: "turn start refused by fake" } });
  else if (message.method === "turn/start" && process.env.FAKE_CODEX_TURN_START_NEVER_ANSWERED === "1") return;
  else if (message.method === "turn/start") {
    // A straggler from an older turn that lands before this turn is announced (step staleNext on the turn before).
    if (staleBefore) { notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-old", itemId: "m0", delta: staleBefore }); staleBefore = null; }
    // A whole older turn (started, text, completed) announced before this turn's reply (step staleTurnNext on the turn before).
    if (staleTurnBefore) {
      notify("turn/started", { threadId: "thread-1", turn: { id: "turn-old", status: "inProgress" } });
      notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-old", itemId: "m0", delta: "OLD-TURN-TEXT" });
      notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-old", status: "completed", error: null } });
      staleTurnBefore = false;
    }
    // Notifications that name no turn, before this turn's reply (step unidentNext on the turn before).
    if (unidentBefore) {
      unidentBefore = false;
      notify("item/agentMessage/delta", { threadId: "thread-1", itemId: "m0", delta: "UNIDENTIFIED-TEXT" });
      notify("turn/completed", { threadId: "thread-1", turn: { status: "completed", error: null } });
    }
    // A final error that names no turn, before and after this turn's reply (step unidentErrorNext on the turn before).
    const unidentError = unidentErrorBefore; unidentErrorBefore = false;
    const unidentErrorNotice = () => notify("error", { threadId: "thread-1", error: { message: "UNIDENTIFIED-ERROR" }, willRetry: false });
    if (unidentError) unidentErrorNotice();
    // A reply that names no turn at all (step noIdNext on the turn before).
    if (noIdBefore) { noIdBefore = false; out({ id: message.id, result: { turn: { status: "inProgress" } } }); return; }
    // A crew-tool call that lands before this turn's reply, naming this turn or another (step earlyOwnNext / earlyOtherNext on the turn before).
    let early = null;
    if (earlyBefore) {
      const named = earlyBefore === "own" ? `turn-${turns + 1}` : "turn-old";
      early = callClient(earlyMethod, earlyMethod === "item/tool/call" ? { threadId: "thread-1", turnId: named, callId: "c-early", namespace: null, tool: "get_crew_status", arguments: {} } : { threadId: "thread-1", turnId: named, itemId: "i-early", command: "echo early", cwd: "C:/work", reason: "x" });
      earlyBefore = null; earlyMethod = "item/tool/call";
    }
    const turnId = `turn-${++turns}`; out({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (unidentError) unidentErrorNotice();
    void runTurn(turnId, message.params, early); }
  else if (message.method === "turn/interrupt") out({ id: message.id, result: {} });
  else if (message.method === "turn/steer") {
    // Like the real app-server: a steer joins the turn that is running (probed 2026-10-16), and "no active turn to steer" once it is over.
    // The running turn's step { steerLate: "complete" } ends the turn first and then answers the error; { steerLate: "error" } answers the error while the turn goes on.
    const turn = activeTurn;
    const noTurn = () => out({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
    if (!turn || turn.finished || message.params.expectedTurnId !== turn.id) { noTurn(); return; }
    if (turn.mode === "complete") { turn.finished = true; finishTurn(turn.id, "completed"); noTurn(); return; }
    if (turn.mode === "error") { noTurn(); return; }
    turn.steers.push(String(message.params.input?.[0]?.text ?? ""));
    out({ id: message.id, result: { turnId: turn.id } });
  }
}

let activeTurn = null;
function finishTurn(turnId, status) {
  if (activeTurn?.id === turnId) activeTurn = null;
  usageTotal += 1000;
  notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId, tokenUsage: { total: { inputTokens: usageTotal }, last: { totalTokens: 1100, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }, modelContextWindow: 258000 } });
  notify("turn/completed", { threadId: "thread-1", turn: { id: turnId, status, error: status === "failed" ? { message: "turn failed in fake" } : null } });
}

async function runTurn(turnId, params, early = null) {
  const previousTurn = lastTurnId; lastTurnId = turnId;
  // After a CLI switch the first message carries a handover preamble; the steps are the part after it.
  // A job the planner hands the leader carries its steps after "The job:".
  const text = params.input[0].text.split("Current message:\n").pop().split("The job:\n").pop();
  let steps; try { steps = JSON.parse(text); } catch { steps = [{ say: `codex says hi to: ${text.slice(0, 40)}` }]; }
  notify("turn/started", { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } });
  const turn = { id: turnId, steers: [], mode: "fold", finished: false };
  activeTurn = turn;
  const delta = (value, itemId = "m1") => { if (!turn.finished) notify("item/agentMessage/delta", { threadId: "thread-1", turnId, itemId, delta: value }); };
  // Messages steered into this turn are answered inside it (plain text gets an echo, a JSON list of steps is played).
  const foldSteers = async () => {
    while (turn.steers.length && !turn.finished) {
      const steered = turn.steers.shift();
      let nested; try { nested = JSON.parse(steered.split("Current message:\n").pop()); } catch { nested = null; }
      if (Array.isArray(nested)) { for (const item of nested) { if (item.sleep) await sleep(item.sleep); if (item.say) delta(item.say); } }
      else delta(`[steer: ${steered.slice(0, 40)}]`);
    }
  };
  let status = "completed";
  if (early) { const reply = await early; delta(`[early call ${reply.result?.success || reply.result?.decision === "accept" ? "ran" : "refused"}]`); }
  // A crew-tool call that names the PREVIOUS turn, made during this one (step staleCallNext on the turn before).
  if (staleCallBefore) {
    staleCallBefore = false;
    const reply = await callClient("item/tool/call", { threadId: "thread-1", turnId: previousTurn, callId: "c-old", namespace: null, tool: "get_crew_status", arguments: {} });
    delta(`[stale call ${reply.result?.success ? "ran" : "refused"}]`);
  }
  for (const step of steps) {
    if (step.steerLate) turn.mode = step.steerLate;
    if (step.sleep) await sleep(step.sleep);
    if (turn.finished) return;
    if (step.reasoning) notify("item/reasoning/textDelta", { threadId: "thread-1", turnId, itemId: "r1", delta: step.reasoning, contentIndex: 0 });
    // { say, item: "m2" }: the words belong to another agentMessage item (the default item is m1).
    if (step.say) for (const piece of step.say.match(/.{1,6}/gs)) delta(piece, step.item);
    // Pack 14, the measured shapes (probe 2026-10-17): item/started then item/completed for one item. { itemRun: { type, id, hold, ...fields } } sends the fields as given
    // (commandExecution: command, cwd, status, exitCode, aggregatedOutput, commandActions[{ type, command, name, path }]; webSearch: query, action, results[{ url, title, snippet }]).
    if (step.itemRun) {
      const { hold = 40, noComplete = false, ...item } = step.itemRun;
      notify("item/started", { threadId: "thread-1", turnId, item: { status: "inProgress", ...item } });
      await sleep(hold);
      if (!noComplete) notify("item/completed", { threadId: "thread-1", turnId, item: { ...item, status: "completed" } });
    }
    if (step.tool) {
      const reply = await callClient("item/tool/call", { threadId: "thread-1", turnId, callId: "c1", namespace: null, tool: step.tool, arguments: step.args ?? {} });
      delta(`[tool ${reply.result?.success ? "ok" : "failed"}: ${reply.result?.contentItems?.[0]?.text}]`);
    }
    if (step.command) {
      const reply = await callClient("item/commandExecution/requestApproval", { kind: "command", threadId: "thread-1", turnId, itemId: "i1", startedAtMs: 1, environmentId: "local", command: step.command, cwd: "C:/work", reason: "needs it" });
      delta(`[command ${reply.result?.decision}]`);
    }
    if (step.fileChange) {
      notify("item/started", { threadId: "thread-1", turnId, item: { type: "fileChange", id: "f1", changes: [{ path: "C:/work/a.txt", kind: { type: "add" }, diff: "+hello" }, ...(step.fileChange === "two" ? [{ path: "C:/work/b.txt", kind: { type: "add" }, diff: "+SECOND-FILE-TEXT" }] : [])], status: "inProgress" } });
      const reply = await callClient("item/fileChange/requestApproval", { threadId: "thread-1", turnId, itemId: "f1", startedAtMs: 1, reason: "write it" });
      delta(`[file ${reply.result?.decision}]`);
    }
    // A request nobody waits for: the turn can finish while it is still open.
    if (step.commandNoWait) out({ id: nextServerId++, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "thread-1", turnId, itemId: "i2", startedAtMs: 1, environmentId: "local", command: step.commandNoWait, cwd: "C:/work", reason: "left open" } });
    // A string is written as one raw line; an object is a server request (below).
    if (typeof step.raw === "string") process.stdout.write(`${step.raw}\n`);
    // One delta line cut in the middle of a multi-byte character across two writes.
    if (step.splitUnicode) {
      const bytes = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: step.splitUnicode } })}\n`);
      const cut = bytes.indexOf(Buffer.from(step.splitUnicode)) + 1;
      process.stdout.write(bytes.subarray(0, cut)); await sleep(60); process.stdout.write(bytes.subarray(cut));
    }
    // A delta that belongs to another turn.
    if (step.staleDelta) notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-old", itemId: "m0", delta: step.staleDelta });
    if (step.staleNext) staleBefore = step.staleNext;
    if (step.staleTurnNext) staleTurnBefore = true;
    if (step.noIdNext) noIdBefore = true;
    if (step.staleCallNext) staleCallBefore = true;
    if (step.earlyOwnNext) earlyBefore = "own";
    if (step.earlyOtherNext) earlyBefore = "other";
    // The same, for a command or file approval: { who: "own" | "other", method } (step earlyApprovalNext on the turn before).
    if (step.earlyApprovalNext) { earlyBefore = step.earlyApprovalNext.who; earlyMethod = step.earlyApprovalNext.method; }
    // A raw server request sent after this turn has completed (it names the finished turn).
    if (step.lateRaw) lateRaws.push(step.lateRaw);
    if (step.unidentNext) unidentBefore = true;
    if (step.unidentErrorNext) unidentErrorBefore = true;
    // A turn/started that names an older turn, after this turn is already established.
    if (step.staleStarted) notify("turn/started", { threadId: "thread-1", turn: { id: "turn-old", status: "inProgress" } });
    // A file-change item whose changes cannot be read: the approval handler throws on it.
    if (step.badFileChange) {
      notify("item/started", { threadId: "thread-1", turnId, item: { type: "fileChange", id: "f2", changes: [null], status: "inProgress" } });
      const reply = await callClient("item/fileChange/requestApproval", { threadId: "thread-1", turnId, itemId: "f2", startedAtMs: 1, reason: "bad" });
      delta(`[file ${reply.result?.decision}]`);
    }
    // A raw server request (params may use "$turn" for this turn's id); the reply is shown in the text.
    if (step.raw && typeof step.raw === "object") {
      const params = JSON.parse(JSON.stringify(step.raw.params).replaceAll("$turn", turnId));
      const reply = await callClient(step.raw.method, params);
      delta(`[${step.raw.method} -> ${JSON.stringify(reply.result ?? reply.error)}]`);
    }
    if (step.unknownRequest) {
      const reply = await callClient(step.unknownRequest, {});
      delta(`[${step.unknownRequest} -> ${JSON.stringify(reply.result ?? reply.error)}]`);
    }
    if (step.retryError) notify("error", { error: { message: step.retryError }, willRetry: true, threadId: "thread-1", turnId });
    if (step.error) { notify("error", { error: { message: step.error }, willRetry: false, threadId: "thread-1", turnId }); status = "failed"; }
    if (step.status) status = step.status;
    if (step.exit) process.exit(1);
    if (step.exitAfter) setTimeout(() => process.exit(1), step.exitAfter);
    if (step.hang) await new Promise(() => {});
    await foldSteers();
  }
  await foldSteers();
  if (turn.finished) return;
  finishTurn(turnId, status);
  for (const raw of lateRaws.splice(0)) void callClient(raw.method, JSON.parse(JSON.stringify(raw.params).replaceAll("$turn", turnId)));
}

if (process.env.FAKE_CODEX_NEVER_ANSWER === "1") process.stdin.resume();
else {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      // FAKE_CODEX_TURN_START_DELAY_MS: the turn/start answer comes late (the steer must wait for the turn id).
      if (parsed.method === "turn/start" && process.env.FAKE_CODEX_TURN_START_DELAY_MS) setTimeout(() => handle(parsed), Number(process.env.FAKE_CODEX_TURN_START_DELAY_MS));
      else handle(parsed);
    }
  });
}
