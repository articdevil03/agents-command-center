// A fake ACP agent (Agent Client Protocol: JSON-RPC 2.0, one JSON object per line on stdin/stdout). The SHAPES are the ones measured on `opencode acp` 1.18.21 on 2026-10-18
// (initialize -> agentCapabilities/authMethods/agentInfo, session/new -> sessionId + configOptions, session/update kinds, a prompt result with stopReason + usage).
// The scenario comes from the start command's argument: `fake-acp --scenario=<name>`. Everything the agent receives is appended to FAKE_LEADER_LOG.
//   basic        streams two messages around a tool call, a usage update, end_turn
//   permission   asks session/request_permission (reject, allow_once, allow_always) and reports the option it got back
//   permission-always   asks with allow_always as the only allow
//   permission-none     asks with reject options only
//   crew         calls the crew tool get_crew_status through the HTTP bridge it was given in session/new
//   nohttp       says it takes no HTTP MCP servers
//   auth         session/new fails with "authentication required"
//   promptauth   the prompt fails with an auth error
//   die          streams a part of the reply, then exits
//   cancel       streams a part, then waits; session/cancel ends the prompt with stopReason cancelled
//   refusal / maxtokens   the prompt ends with that stop reason
//   echotoken    puts the bridge token into the reply: whole, then split across two reply chunks, the second one also split across two stdout writes (the leader must hide it)
//   modeltoken   reports the bridge token as its model, then answers like basic (the leader must hide it)
//   errtoken     fails the prompt with the bridge token in the error text (the leader must hide it)
//   idtoken      returns the bridge token as its session id (refused)
//   badtool      sends a tool call whose id cannot be turned into text, with the prompt's reply in the SAME stdout write
//   bigline      sends one newline-terminated line longer than the adapter's line limit
//   tokengap3                     a third of the token, a tool call, the next third, the rest (three pieces)
//   tokengap / tokengap-thought   half the bridge token, a tool call (or a thought chunk), the other half (the leader must hide it)
//   breakprefix / breakprefix-long   a reply ending in "t" (or in "tok-", the start of the token), a tool call, then a normal message (the paragraph break must survive)
//   closeout     stays silent and alive on the prompt (the test breaks the pipe to it)
//   exits        exits before answering initialize
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = (process.argv.find((arg) => arg.startsWith("--scenario=")) ?? "--scenario=basic").slice("--scenario=".length);
const log = (entry) => { if (process.env.FAKE_LEADER_LOG) appendFileSync(process.env.FAKE_LEADER_LOG, JSON.stringify({ cli: "acp", scenario, ...entry }) + "\n"); };
log({ started: true, pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000), argv: process.argv.slice(2), cwd: process.cwd() });
if (scenario === "exits") process.exit(3);

const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => out({ method: "session/update", params: { sessionId, update: body } });
const writeSplit = async (message, cut) => { const line = `${JSON.stringify({ jsonrpc: "2.0", ...message })}
`; process.stdout.write(line.slice(0, cut)); await sleep(60); process.stdout.write(line.slice(cut)); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const SECRET = "SECRET-P17-xK39qz";
let nextAgentId = 1000;
const pendingAgentRequests = new Map();
let cancelPrompt = null;
let bridge = null;

async function askPermission(sessionId, options) {
  const id = nextAgentId++;
  const answer = new Promise((ok) => pendingAgentRequests.set(id, ok));
  out({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "call_p", title: `edit ${SECRET}.txt`, kind: "edit", status: "pending" }, options } });
  return answer;
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  log({ prompt: true, text, blocks: (params.prompt ?? []).map((block) => block.type) });
  if (scenario === "closeout") { setInterval(() => {}, 1000); return; }
  update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] });
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thinking about ${SECRET}` } });
  const say = (chunk) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  const finish = (stopReason = "end_turn") => out({ id, result: { stopReason, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 10 } } });
  const usage = () => update(sessionId, { sessionUpdate: "usage_update", used: 4321, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
  if (scenario === "promptauth") { out({ id, error: { code: -32000, message: "Authentication required" } }); return; }
  if (scenario === "refusal") { say("no."); finish("refusal"); return; }
  if (scenario === "maxtokens") { say("cut"); finish("max_tokens"); return; }
  if (scenario === "die") { say("part of the reply"); await sleep(50); process.exit(1); }
  if (scenario === "cancel") { say("-".repeat(100) + "working"); await new Promise((ok) => { cancelPrompt = ok; }); finish("cancelled"); return; }
  if (scenario === "echotoken") {
    const token = bridge?.token ?? "none", half = Math.floor(token.length / 2);
    say(`whole ${token}.`); await sleep(60);
    say(` split ${token.slice(0, half)}`); await sleep(60);
    await writeSplit({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${token.slice(half)} end` } } } }, 40);
    usage(); finish(); return;
  }
  if (scenario === "tokengap" || scenario === "tokengap-thought") {
    const token = bridge?.token ?? "none", half = Math.floor(token.length / 2);
    say(`before ${token.slice(0, half)}`); await sleep(60);
    if (scenario === "tokengap") update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_g", title: "x", kind: "read", status: "pending" });
    else update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    await sleep(60);
    say(`${token.slice(half)} after`); await sleep(60);
    finish(); return;
  }
  if (scenario === "breakprefix" || scenario === "breakprefix-long") {
    const token = bridge?.token ?? "none";
    say(scenario === "breakprefix" ? "A cat" : `A cat ${token.slice(0, 4)}`); await sleep(60);
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_b", title: "x", kind: "read", status: "pending" }); await sleep(60);
    say("Next message."); await sleep(60);
    finish(); return;
  }
  if (scenario === "tokengap3") {
    const token = bridge?.token ?? "none", a = Math.floor(token.length / 3), b = Math.floor(token.length * 2 / 3);
    say(`before ${token.slice(0, a)}`); await sleep(60);
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_g3", title: "x", kind: "read", status: "pending" }); await sleep(60);
    say(token.slice(a, b)); await sleep(60);
    say(`${token.slice(b)} after`); await sleep(60);
    finish(); return;
  }
  if (scenario === "errtoken") { out({ id, error: { code: -32603, message: `failed for ${bridge?.token}` } }); return; }
  if (scenario === "badtool") {
    const wire = (message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}
`;
    process.stdout.write(wire({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: { toString: null }, kind: "edit", status: "pending" } } })
      + wire({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: { toString: null }, status: "completed" } } })
      + wire({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply after the bad messages" } } } })
      + wire({ id, result: { stopReason: "end_turn" } }));
    return;
  }
  if (scenario === "bigline") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "X".repeat(3000) } } } })}
`); await sleep(2000); finish(); return; }
  if (scenario.startsWith("permission")) {
    const options = scenario === "permission" ? [{ optionId: "rej", name: "Reject", kind: "reject_once" }, { optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow always", kind: "allow_always" }]
      : scenario === "permission-always" ? [{ optionId: "rej", name: "Reject", kind: "reject_once" }, { optionId: "always", name: "Allow always", kind: "allow_always" }]
      : [{ optionId: "rej", name: "Reject", kind: "reject_once" }, { optionId: "rejall", name: "Reject always", kind: "reject_always" }];
    const answer = await askPermission(sessionId, options);
    log({ permissionAnswer: answer });
    say(`permission:${answer?.outcome?.outcome}:${answer?.outcome?.optionId ?? "-"}`);
    usage(); finish(); return;
  }
  if (scenario === "crew") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_c", title: "tab-crew: get_crew_status", kind: "other", status: "pending" });
    const call = async (method, p, rpcId) => {
      const response = await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: p }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "1" } }, 1);
    const tools = await call("tools/list", {}, 2);
    const crew = await call("tools/call", { name: "get_crew_status", arguments: {} }, 3);
    log({ bridgeInit: init.status, bridgeTools: tools.body?.result?.tools?.map((tool) => tool.name), bridgeCrew: crew.body?.result?.content?.[0]?.text });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_c", status: "completed" });
    say(`crew ok: ${crew.status}`);
    usage(); finish(); return;
  }
  // basic: a message, a tool call (its title and content hold the secret), a second message
  say(`Hello from the fake. You said: ${text}`);
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: `Edit ${SECRET}/file.txt`, kind: "edit", status: "pending", content: [{ type: "diff", path: `${SECRET}.txt`, newText: SECRET }] });
  await sleep(30);
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
  say("All done.");
  usage();
  finish();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log({ received: message.method ?? "(response)", id: message.id, params: message.method === "session/new" ? message.params : undefined });
  if (message.method === undefined && message.id !== undefined) { pendingAgentRequests.get(message.id)?.(message.result ?? { error: message.error }); pendingAgentRequests.delete(message.id); return; }
  switch (message.method) {
    case "initialize":
      out({ id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: scenario !== "nohttp", sse: true }, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: {} },
        authMethods: [{ id: "login", name: "Login", description: "Run `fakecli auth login` in the terminal" }],
        agentInfo: { name: "FakeACP", version: "1.0.0" },
      } });
      return;
    case "session/new": {
      const http = (message.params.mcpServers ?? []).find((server) => server.type === "http");
      if (http) bridge = { url: http.url, token: String(http.headers?.find((header) => header.name === "Authorization")?.value ?? "").replace(/^Bearer /, "") };
      if (scenario === "auth") { out({ id: message.id, error: { code: -32000, message: "Authentication required" } }); return; }
      out({ id: message.id, result: { sessionId: scenario === "idtoken" ? bridge?.token : "ses_fakeacp1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: scenario === "modeltoken" ? bridge?.token : "fakeprov/fake-default", options: [{ value: "fakeprov/fake-default", name: "Fake default" }] }] } });
      return;
    }
    case "session/prompt": void prompt(message.id, message.params).catch((error) => out({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } })); return;
    case "session/cancel": cancelPrompt?.(); return;
    default:
      if (message.id !== undefined) out({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
});
// closeout stays alive when its input closes, so a broken input pipe is seen only through the stdin error (not through the process exiting and closing its output).
process.stdin.on("end", () => { if (scenario !== "closeout") process.exit(0); else setInterval(() => {}, 1000); });
