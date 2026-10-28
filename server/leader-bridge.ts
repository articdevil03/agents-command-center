import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { leaderToolJsonSchema, runLeaderTool, type LeaderToolSpec } from "./leader-tools.ts";

// The crew tools for an OpenCode leader, served as a minimal MCP server over plain JSON-RPC POST.
// One entry per tab, one fresh token per leader instance; the token dies when that leader stops or dies.
export const BRIDGE_BODY_LIMIT = 1024 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

type Entry = { token: Buffer; specs: LeaderToolSpec[] };

export function createLeaderBridge() {
  const entries = new Map<string, Entry>();

  function open(tabId: string, specs: LeaderToolSpec[]): { token: string; revoke: () => void } {
    const token = randomBytes(32).toString("hex");
    const entry: Entry = { token: Buffer.from(token, "utf8"), specs };
    entries.set(tabId, entry);
    return { token, revoke: () => { if (entries.get(tabId) === entry) entries.delete(tabId); } };
  }

  function authorized(tabId: string, header: string | undefined): Entry | null {
    const entry = entries.get(tabId);
    const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
    if (!entry || !match) return null;
    const given = Buffer.from(match[1], "utf8");
    return given.length === entry.token.length && timingSafeEqual(given, entry.token) ? entry : null;
  }

  async function readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > BRIDGE_BODY_LIMIT) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, tabId: string): Promise<void> {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // A web page must never reach this: a real MCP client sends no Origin at all.
    if (req.headers.origin !== undefined) { send(403, { error: "forbidden origin" }); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    const entry = authorized(tabId, req.headers.authorization);
    if (!entry) { send(401, { error: "unauthorized" }); return; }
    const raw = await readBody(req);
    if (!raw) { send(413, { error: "request body too large" }); return; }
    let message: any;
    try { message = JSON.parse(raw.toString("utf8")); } catch { send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") { send(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }); return; }
    if (message.id === undefined) { send(202); return; }
    const reply = (result: unknown): void => send(200, { jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "tab-crew", version: "1.0.0" } });
        return;
      case "ping": reply({}); return;
      case "tools/list":
        reply({ tools: entry.specs.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: leaderToolJsonSchema(spec) })) });
        return;
      case "tools/call": {
        // A tool the leader no longer owns after Stop cannot run: re-check the token before the handler.
        if (!authorized(tabId, req.headers.authorization)) { send(401, { error: "unauthorized" }); return; }
        const result = await runLeaderTool(entry.specs, String(message.params?.name), message.params?.arguments);
        reply({ content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
        return;
      }
      default: send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
    }
  }

  // The route boundary: a client that drops mid-body (or any throw) ends only its own response, never the server.
  async function handle(req: IncomingMessage, res: ServerResponse, tabId: string): Promise<void> {
    try { await handleRequest(req, res, tabId); }
    catch {
      try { if (!res.writableEnded) { if (!res.headersSent) res.writeHead(400); res.end(); } } catch { /* the socket is gone */ }
    }
  }

  return { open, handle, isOpen: (tabId: string) => entries.has(tabId) };
}
