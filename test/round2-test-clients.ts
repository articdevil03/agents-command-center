import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

export function connect(server: any) {
  const ws = new EventEmitter() as any;
  ws.OPEN = ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.messages = [];
  ws.send = (raw: string) => ws.messages.push(JSON.parse(raw));
  server.wss.emit("connection", ws);
  ws.message = (message: unknown) => ws.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)));
  return ws;
}

export function lastState(ws: any) { return [...ws.messages].reverse().find((message: any) => message.type === "state"); }

// A test that fails part-way leaves its leader turns running; they write to the chat store after the file is done and re-create its folder. A finally waits them out.
export async function settleLeaderTurns(...servers: any[]) {
  for (const server of servers) {
    await waitFor(() => server.activeLeaderTurns.size === 0, "the leader turns settle", 3_000).catch(() => {});
    await server.getQueue();
  }
}

export async function tick(ms = 20) { await new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

export async function waitFor(check: () => boolean, description: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`); // an assertion, so the mutation sweep counts a red wait
    await tick(10);
  }
}

export async function flushMicrotasks(rounds = 12) { for (let i = 0; i < rounds; i++) await Promise.resolve(); }
