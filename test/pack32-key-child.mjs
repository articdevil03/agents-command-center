import { createInterface } from "node:readline";
if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Synthetic CLI only");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (request.method === "session/new") return reply({ sessionId: "synthetic-session" });
  if (request.method === "session/cancel") { lines.close(); process.stdin.destroy(); return; }
  if (request.method === "session/prompt") {
    const key = process.env[process.env.CC_FAKE_KEY_ENV];
    const response = await fetch(process.env.CC_FAKE_PROVIDER, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) return send({ id: request.id, error: { code: -1, message: "Synthetic authentication failed" } });
    const echo = (text) => send({ method: "session/update", params: { sessionId: "synthetic-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    echo("Authenticated. " + key + " ");
    echo(key.slice(0, 9)); echo(key.slice(9));
    echo(" " + JSON.stringify(key).slice(1, -1) + " " + encodeURIComponent(key) + " End.");
    reply({ stopReason: "end_turn" });
  }
});
