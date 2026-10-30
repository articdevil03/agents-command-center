// A fake `opencode serve`: basic-auth HTTP + SSE. The prompt text is a JSON array of steps (see runTurn); plain text gets a reply.
// Every request is appended to FAKE_LEADER_LOG. On POST /mcp it connects to the given bridge URL the way OpenCode does.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const password = process.env.OPENCODE_SERVER_PASSWORD;
const log = (entry) => { if (process.env.FAKE_LEADER_LOG) appendFileSync(process.env.FAKE_LEADER_LOG, JSON.stringify({ cli: "opencode", ...entry }) + "\n"); };
// startedAt (about the process's creation time) lets a teardown tell this process from a later one that reused its pid.
log({ started: true, pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000), args: process.argv.slice(2), config: process.env.OPENCODE_CONFIG_CONTENT });
const streams = new Set();
const emit = (type, properties) => { for (const res of streams) res.write(`data: ${JSON.stringify({ type, properties })}\n\n`); };
const waiting = new Map();
// The session rules OpenCode was given (a PATCH appends); the last matching rule wins, no match asks. Used by the read step.
let rules = [];
const ruleAction = (permission, target) => {
  const match = (pattern, text) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(text);
  return rules.filter((r) => match(r.permission, permission) && match(r.pattern, target)).at(-1)?.action ?? "ask";
};
let bridge = null, nextMessage = 0, permissionCount = 0, questionCount = 0, providersFailedOnce = false, activeRun = null, steerMessages = 0, promptsSeen = 0, steerGatedDupSent = false;
const refusedOnce = new Set();
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const mcp = async (method, params, id = 1) => {
  const response = await fetch(bridge.url, { method: "POST", headers: { Authorization: bridge.authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const rawBody = await new Promise((resolve) => { let data = ""; req.on("data", (c) => { data += c; }); req.on("end", () => resolve(data)); });
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : undefined; }
  catch { log({ method: req.method, path: url.pathname, malformedBody: true }); return json(res, 400, { error: "request body is not JSON" }); }
  const authorized = req.headers.authorization === "Basic " + Buffer.from("opencode:" + password).toString("base64");
  log({ method: req.method, path: url.pathname, directory: url.searchParams.get("directory"), authorized, body });
  if (!authorized) return json(res, 401, { error: "unauthorized" });
  if (url.pathname === "/global/health") return json(res, 200, { healthy: true });
  if (url.pathname === "/mcp" && req.method === "POST") {
    bridge = { url: body.config.url, authorization: body.config.headers.Authorization };
    const init = await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-opencode", version: "1" } });
    const list = await mcp("tools/list", {}, 2);
    log({ bridgeInit: init.status, bridgeTools: list.body?.result?.tools?.map((t) => t.name) });
    return json(res, 200, { "tab-crew": { status: init.status === 200 && list.status === 200 ? "connected" : "failed" } });
  }
  if (url.pathname === "/session" && req.method === "POST") {
    if (process.env.FAKE_OPENCODE_SESSION_FAILS === "1") return json(res, 500, { message: `session refused, password ${password}, token ${bridge?.authorization}` });
    // A 200 that is not JSON and starts with the secrets: a parse error that quotes it would leak.
    if (process.env.FAKE_OPENCODE_SESSION_MALFORMED === "1") { log({ leaked: { password, token: bridge?.authorization?.slice("Bearer ".length) } }); res.writeHead(200, { "content-type": "application/json" }); return res.end(`x${password}${bridge?.authorization}`); }
    rules = body?.permission ?? [];
    return json(res, 200, { id: "ses_fake1" });
  }
  if (/^\/session\/[^/]+$/.test(url.pathname) && req.method === "PATCH") {
    // Dies mid-request without answering it: the event stream ends first (the leader sees the death), the process goes later.
    if (process.env.FAKE_OPENCODE_PATCH_EXITS === "1") { for (const res of streams) res.end(); await sleep(300); process.exit(1); }
    if (process.env.FAKE_OPENCODE_PATCH_DELAY_MS) await sleep(Number(process.env.FAKE_OPENCODE_PATCH_DELAY_MS));
    rules = rules.concat(body?.permission ?? []);
    return json(res, 200, { id: "ses_fake1" });
  }
  if (url.pathname === "/config/providers" && process.env.FAKE_OPENCODE_PROVIDERS_DELAY_MS) await sleep(Number(process.env.FAKE_OPENCODE_PROVIDERS_DELAY_MS));
  // FAKE_OPENCODE_PROVIDERS_FAIL_ONCE: the first read of the providers fails, later ones work.
  if (url.pathname === "/config/providers" && process.env.FAKE_OPENCODE_PROVIDERS_FAIL_ONCE === "1" && !providersFailedOnce) { providersFailedOnce = true; return json(res, 500, { message: "providers unavailable" }); }
  if (url.pathname === "/config/providers") return json(res, 200, { providers: [{ id: "fakeprov", name: "Fake", key: "SECRET-KEY-MUST-NOT-LEAK", models: { "fake-model": { limit: { context: 200000 } } } }], default: {} });
  if (url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streams.add(res); res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    req.on("close", () => streams.delete(res)); return;
  }
  if (/\/permission\/[^/]+\/reply$/.test(url.pathname) && process.env.FAKE_OPENCODE_REPLY_FAILS === "1") return json(res, 500, { message: "reply refused by fake" });
  if (/\/permission\/[^/]+\/reply$/.test(url.pathname)) {
    waiting.get(url.pathname.split("/")[2])?.(body.reply);
    // The acknowledgement can be slow: the id must stay open until it arrives.
    if (process.env.FAKE_OPENCODE_REPLY_DELAY_MS) await sleep(Number(process.env.FAKE_OPENCODE_REPLY_DELAY_MS));
    return json(res, 200, true);
  }
  if (/\/question\/[^/]+\/reject$/.test(url.pathname) && process.env.FAKE_OPENCODE_QUESTION_REJECT_FAILS === "1") return json(res, 500, { message: "question reject refused by fake" });
  if (/\/question\/[^/]+\/reject$/.test(url.pathname)) return json(res, 200, true);
  if (/\/abort$/.test(url.pathname)) return json(res, 200, true);
  if (/\/prompt_async$/.test(url.pathname)) {
    promptsSeen++;
    // PROMPT_LEAK: 180 ordinary characters, then the password, so a 200 character cut lands inside it.
    if (process.env.FAKE_OPENCODE_PROMPT_FAILS === "1") return json(res, 500, { name: "UnknownError", data: { message: process.env.FAKE_OPENCODE_PROMPT_LEAK === "1" ? "x".repeat(180) + password : "prompt refused by fake" } });
    // A prompt whose text holds REFUSE-ONCE is refused the first time it arrives (REFUSE-ONCE-SLOW: after 1200 ms) and accepted when it is sent again.
    const promptText = String(body?.parts?.[0]?.text);
    if (promptText.includes("REFUSE-ONCE") && !refusedOnce.has(promptText)) {
      refusedOnce.add(promptText);
      if (promptText.includes("REFUSE-ONCE-SLOW")) await sleep(1200);
      return json(res, 500, { name: "UnknownError", data: { message: "prompt refused once by fake" } });
    }
    // A prompt while a run goes on (probed 2026-10-16): accepted at once, its user message appears at once, and the running loop answers it before its one session.idle.
    // The running turn's step { steerLate: "late" } makes OpenCode finish that loop first and start the prompt as a second run (its own idle); { steerLate: "fail" } refuses the prompt.
    if (activeRun && !activeRun.finished) {
      const run = activeRun;
      if (run.mode === "fail") { run.mode = "fold"; return json(res, 500, { name: "UnknownError", data: { message: "steer refused by fake" } }); }
      // failSecond: the first prompt is folded as usual (its user message shows at once, its answer begins at the next step), the second is refused only after a pause.
      if (run.mode === "failSecond" && ++run.prompts === 2) { await sleep(1500); return json(res, 500, { name: "UnknownError", data: { message: "second steer refused by fake" } }); }
      // lateFail: the loop ends first (its idle goes out), and only then is the prompt refused.
      if (run.mode === "lateFail") { run.finished = true; activeRun = null; endRun(run); await sleep(250); return json(res, 500, { name: "UnknownError", data: { message: "steer refused after the idle" } }); }
      // lateSeen: the steer's user message shows at once (as in a fold), but the loop ends first and the prompt is answered by a second run with its own idle.
      if (run.mode === "lateSeen") emit("message.updated", { sessionID: "ses_fake1", info: { id: `msg_s${++steerMessages}`, sessionID: "ses_fake1", role: "user", time: { created: 1 } } });
      if (run.mode === "late" || run.mode === "lateSeen") { run.finished = true; activeRun = null; endRun(run); json(res, 204); setTimeout(() => void runTurn(body), 300); return; } // the second run starts a moment later, as a real one does
      json(res, 204);
      log({ midRun: true, text: body.parts[0].text });
      const id = `msg_s${++steerMessages}`;
      emit("message.updated", { sessionID: "ses_fake1", info: { id, sessionID: "ses_fake1", role: "user", time: { created: 1 } } });
      // Like the real one, the user message of a steer has its own text part (pack 14: it must not read as the assistant starting to write).
      emit("message.part.updated", { sessionID: "ses_fake1", part: { id: `prt_${id}`, sessionID: "ses_fake1", messageID: id, type: "text", text: body.parts[0].text } });
      run.mid.push(body);
      return;
    }
    json(res, 204); void runTurn(body);
    return;
  }
  json(res, 404, { error: "not found" });
});
// FAKE_OPENCODE_NEVER_UP: stays alive but never opens its port (a server that does not come up).
// Like the real `opencode serve`: with --port 0 it picks a port itself and prints the one it bound (the leader reads that line).
if (process.env.FAKE_OPENCODE_NEVER_UP === "1") setInterval(() => {}, 1000);
else server.listen(port, "127.0.0.1", () => process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}
`));

async function runTurn(prompt) {
  // The first message after a server start carries the handover preamble; the steps are the part after it (same as the Codex fake).
  const text = prompt.parts[0].text.split("Current message:\n").pop();
  let steps; try { steps = JSON.parse(text); } catch { steps = [{ say: `opencode says hi to: ${text.slice(0, 40)}` }]; }
  const sessionID = "ses_fake1";
  const userId = `msg_u${++nextMessage}`, assistantId = `msg_a${nextMessage}`;
  emit("message.updated", { sessionID, info: { id: userId, sessionID, role: "user", time: { created: 1 } } });
  emit("message.part.updated", { sessionID, part: { id: `prt_u${nextMessage}`, sessionID, messageID: userId, type: "text", text } });
  emit("message.part.delta", { sessionID, messageID: userId, partID: `prt_u${nextMessage}`, field: "text", delta: "USER-ECHO" });
  emit("message.updated", { sessionID, info: { id: assistantId, sessionID, role: "assistant", time: { created: 2 }, modelID: prompt.model.modelID, providerID: prompt.model.providerID } });
  let failed = false;
  const run = { assistantId, prompt, mid: [], mode: "fold", finished: false, prompts: 0 };
  activeRun = run;
  const say = (delta, partID = `prt_t${nextMessage}`, messageID = assistantId) => { if (run.finished) return; emit("message.part.updated", { sessionID, part: { id: partID, sessionID, messageID, type: "text" } }); emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta }); };
  // Prompts that arrived during this run are answered inside it (plain text gets an echo, a JSON list of steps is played).
  const foldMid = async () => {
    while (run.mid.length && !run.finished) {
      const steered = run.mid.shift().parts[0].text;
      let nested; try { nested = JSON.parse(steered.split("Current message:\n").pop()); } catch { nested = null; }
      // As the real one does (probed 2026-10-16): the answer to the steer is a NEW assistant message.
      const answerId = `msg_sa${++steerMessages}`;
      emit("message.updated", { sessionID, info: { id: answerId, sessionID, role: "assistant", time: { created: 3 }, modelID: prompt.model.modelID, providerID: prompt.model.providerID } });
      if (Array.isArray(nested)) { for (const item of nested) { if (item.sleep) await sleep(item.sleep); if (item.say) say(item.say, `prt_${answerId}`, answerId); } }
      else say(`[steer: ${steered.slice(0, 40)}]`, `prt_${answerId}`, answerId);
      // The real one completes every assistant message (without tokens here) before the run's session.idle.
      if (!run.finished) emit("message.updated", { sessionID, info: { id: answerId, sessionID, role: "assistant", time: { created: 3, completed: 4 }, modelID: prompt.model.modelID, providerID: prompt.model.providerID } });
    }
  };
  // A sub-agent: OpenCode's task tool opens a child session whose parentID is this one; what it asks names the child's id.
  const made = new Set();
  const session = (id, parentID) => { if (made.has(id)) return; made.add(id); emit("session.created", { sessionID: id, info: { id, parentID, title: "sub-agent" } }); };
  const askFrom = async (sid, permission, pattern, metadata = {}) => {
    const id = `per_${++permissionCount}`;
    const reply = new Promise((ok) => waiting.set(id, ok));
    emit("permission.asked", { id, sessionID: sid, permission, patterns: [pattern], metadata, always: [] });
    return await reply;
  };
  for (const step of steps) {
    if (step.steerLate) run.mode = step.steerLate;
    if (step.noTokens) run.noTokens = true; // the assistant message ends without token counts
    if (step.sleep) await sleep(step.sleep);
    if (run.finished) return;
    if (step.childBash) { session("ses_child1", sessionID); say(`[child bash ${await askFrom("ses_child1", "bash", step.childBash)}]`); }
    if (step.childEdit) { session("ses_child1", sessionID); say(`[child edit ${await askFrom("ses_child1", "edit", "C:/work/a.txt", { filepath: "C:/work/a.txt" })}]`); }
    if (step.childRead) { session("ses_child1", sessionID); say(`[child read ${step.childRead} ${await askFrom("ses_child1", "read", step.childRead)}]`); }
    if (step.grandBash) { session("ses_child1", sessionID); session("ses_grand1", "ses_child1"); say(`[grand bash ${await askFrom("ses_grand1", "bash", step.grandBash)}]`); }
    if (step.childQuestion) { session("ses_child1", sessionID); emit("question.asked", { id: `que_${++questionCount}`, sessionID: "ses_child1", questions: [] }); }
    // A session nobody created under this one: its requests are not the leader's to answer.
    if (step.foreignBash) { emit("permission.asked", { id: `per_foreign_${++permissionCount}`, sessionID: "ses_other", permission: "bash", patterns: [step.foreignBash], metadata: {}, always: [] }); say("[foreign sent]"); }
    // Text that prints the server password and the bridge token, cut into small deltas so a secret is split across several.
    if (step.leakDelta) for (const piece of `before ${password} between ${bridge?.authorization?.slice("Bearer ".length)} after`.match(/.{1,7}/gs)) say(piece);
    // A visible sentence, then the first part of the password; the rest of it arrives after a pause (a steer lands in between). The password is logged for the test to look for.
    if (step.leakHalf) { log({ leakHalfSecret: password }); say("visible-end " + password.slice(0, 20)); await sleep(step.leakHalf); say(password.slice(20) + " after"); }
    // { leakParts: { form: "password" | "token" | "basic", at, sleep } }: a secret cut in two, its first half at the end of one text part and the rest at the start of the NEXT text part
    // (the leader puts a paragraph break between two parts). The secret is logged for the test to look for.
    if (step.leakParts) {
      const { form, at = 20, sleep: gap = 0 } = step.leakParts;
      const secret = { password, token: bridge?.authorization?.slice("Bearer ".length), basic: Buffer.from(`opencode:${password}`).toString("base64") }[form];
      log({ splitSecret: secret, form });
      say(`visible-end ${secret.slice(0, at)}`, "prt_la");
      if (gap) await sleep(gap);
      say(`${secret.slice(at)} after`, "prt_lb");
    }
    // Many parts: the oldest is forgotten, the newest still known (the leader keeps a bounded memory of parts).
    if (step.flood) {
      for (let i = 0; i < step.flood; i++) emit("message.part.updated", { sessionID, part: { id: `prt_f${i}`, sessionID, messageID: assistantId, type: "text" } });
      emit("message.part.delta", { sessionID, messageID: assistantId, partID: "prt_f0", field: "text", delta: "[OLDEST]" });
      emit("message.part.delta", { sessionID, messageID: assistantId, partID: `prt_f${step.flood - 1}`, field: "text", delta: "[NEWEST]" });
    }
    // Many completed assistant messages, then the first and the last of them once more: a bounded memory counts the first again, not the last.
    if (step.floodMessages) {
      const completed = (n) => ({ id: `msg_f${n}`, sessionID, role: "assistant", time: { created: 2, completed: 3 }, tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 });
      for (let i = 0; i < step.floodMessages; i++) emit("message.updated", { sessionID, info: completed(i) });
      emit("message.updated", { sessionID, info: completed(0) });
      emit("message.updated", { sessionID, info: completed(step.floodMessages - 1) });
    }
    if (step.reasoning) { emit("message.part.updated", { sessionID, part: { id: "prt_r1", sessionID, messageID: assistantId, type: "reasoning" } }); emit("message.part.delta", { sessionID, messageID: assistantId, partID: "prt_r1", field: "text", delta: step.reasoning }); }
    // { say, part: "prt_x" }: the words belong to another text part (the default part is prt_t<n>).
    if (step.say) for (const piece of step.say.match(/.{1,6}/gs)) say(piece, step.part);
    // Pack 14, the measured shapes (probe 2026-10-17): a tool part is announced as pending (empty input), then running (the input), then completed (input, output, title, metadata).
    // { toolPart: { tool, id, input, output, hold } } plays that; the input and output are secret-laden on purpose in the tests.
    if (step.toolPart) {
      const { tool, id = "prt_tool1", hold = 40, noComplete = false } = step.toolPart;
      // "$PASSWORD" / "$TOKEN" in the input or output become this server's real password / bridge token (logged for the test), so a leak of either is caught.
      const real = (value) => JSON.parse(JSON.stringify(value ?? "").replaceAll("$PASSWORD", password).replaceAll("$TOKEN", bridge?.authorization?.slice("Bearer ".length) ?? "no-token"));
      const input = real(step.toolPart.input ?? {}), output = real(step.toolPart.output ?? "");
      log({ toolSecrets: { password, token: bridge?.authorization?.slice("Bearer ".length) } });
      const part = (state) => ({ id, sessionID, messageID: assistantId, type: "tool", callID: `call_${id}`, tool, state });
      emit("message.part.updated", { sessionID, part: part({ status: "pending", input: {}, raw: "" }) });
      emit("message.part.updated", { sessionID, part: part({ status: "running", input, time: { start: 1 } }) });
      await sleep(hold);
      if (!noComplete) emit("message.part.updated", { sessionID, part: part({ status: "completed", input, output, title: output, metadata: { output }, time: { start: 1, end: 2 } }) });
    }
    if (step.tool) {
      const result = await mcp("tools/call", { name: step.tool, arguments: step.args ?? {} }, 9);
      say(`[tool ${result.body?.result?.isError ? "failed" : "ok"}: ${result.body?.result?.content?.[0]?.text}]`);
    }
    if (step.bash || step.edit || step.editFull) {
      const id = `per_${++permissionCount}`;
      const reply = new Promise((ok) => waiting.set(id, ok));
      // editFull: the way OpenCode asks for a multi-file edit, two paths in patterns and the diff in metadata.
      emit("permission.asked", { id, sessionID, permission: step.bash ? "bash" : "edit", patterns: step.bash ? [step.bash] : step.editFull ? ["C:/work/a.txt", "C:/work/b.txt"] : ["C:/work/a.txt"], metadata: step.bash ? {} : { filepath: "C:/work/a.txt", ...(step.editFull ? { diff: "-OLD-LINE\n+NEW-LINE" } : {}) }, always: [] });
      say(`[permission ${await reply}]`);
    }
    // A read: allowed by the rules it was given runs silently, otherwise it asks like any permission.
    if (step.read) {
      if (ruleAction("read", step.read) === "allow") say(`[read ${step.read} auto]`);
      else {
        const id = `per_${++permissionCount}`;
        const reply = new Promise((ok) => waiting.set(id, ok));
        emit("permission.asked", { id, sessionID, permission: "read", patterns: [step.read], metadata: {}, always: [] });
        say(`[read ${step.read} ${await reply}]`);
      }
    }
    // A permission request nobody waits for: the turn can fail while it is still open.
    if (step.bashNoWait) emit("permission.asked", { id: `per_${++permissionCount}`, sessionID, permission: "bash", patterns: [step.bashNoWait], metadata: {}, always: [] });
    // A question nobody can answer here: the leader must reject it.
    if (step.question) emit("question.asked", { id: `que_${++questionCount}`, sessionID, questions: [] });
    if (step.error) { emit("session.error", { sessionID, error: { name: "UnknownError", data: { message: step.leak ? `${step.error} password ${password} token ${bridge?.authorization}` : step.leakB64 ? `${step.error} credential ${Buffer.from(`opencode:${password}`).toString("base64")}` : step.error } } }); failed = true; }
    if (step.exit) process.exit(1);
    // exitAfter: the process ends on its own once the turn is over (an idle leader that dies).
    if (step.exitAfter) setTimeout(() => process.exit(1), step.exitAfter);
    if (step.hang) await new Promise(() => {});
    await foldMid();
  }
  if (failed) { activeRun = null; return; }
  await foldMid();
  if (run.finished) return;
  endRun(run);
}

// The end of a run: the assistant message completes, then the one session.idle.
async function endRun(run) {
  const { assistantId, prompt } = run, sessionID = "ses_fake1";
  if (activeRun === run) activeRun = null;
  const info = { id: assistantId, sessionID, role: "assistant", time: { created: 2, completed: 3 }, modelID: prompt.model.modelID, providerID: prompt.model.providerID, tokens: run.noTokens ? undefined : { input: 900 + (nextMessage - 1) * 1000, output: 50, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0.25 };
  emit("message.updated", { sessionID, info }); emit("message.updated", { sessionID, info });
  emit("session.idle", { sessionID });
  const promptsAtIdle = promptsSeen;
  // A duplicate idle for the same turn (FAKE_OPENCODE_DUP_IDLE=1): 50 ms after the first, or FAKE_OPENCODE_DUP_IDLE_MS later. The log line says when it went out.
  // FAKE_OPENCODE_DUP_IDLE_AFTER_STEER=1: it goes out only once a later /prompt_async (the steer) has arrived, so the order does not depend on timing (gives up after 15 s and says so).
  if (process.env.FAKE_OPENCODE_DUP_IDLE === "1") {
    if (process.env.FAKE_OPENCODE_DUP_IDLE_AFTER_STEER === "1" && !steerGatedDupSent) { // only the first turn's duplicate is gated; the steer's own run ends with a plain one
      steerGatedDupSent = true;
      const end = Date.now() + 15_000;
      while (promptsSeen <= promptsAtIdle && Date.now() < end) await sleep(10);
      if (promptsSeen <= promptsAtIdle) { log({ dupIdleGaveUp: true }); return; }
      log({ dupIdleAfterSteer: true });
    } else await sleep(Number(process.env.FAKE_OPENCODE_DUP_IDLE_MS) || 50);
    log({ dupIdle: true }); emit("session.idle", { sessionID });
  }
}
