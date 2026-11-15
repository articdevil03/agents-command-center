import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolveCliOrThrow } from "../server/leader-common.ts";

// A protocol peer in memory, never a vendor executable or an operating-system process.
export function fakeAcp() {
  const launches: Array<{ program: string; args: string[] }> = [], requests: any[] = [];
  const spawn = ((program: string, args: string[], options: any) => {
    resolveCliOrThrow(program, process.env, options.cwd);
    launches.push({ program, args });
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.kill = () => true;
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        const request = JSON.parse(line); requests.push(request);
        if (request.id === undefined) continue;
        const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }
          : request.method === "session/new" ? { sessionId: "fake-session" } : { stopReason: "end_turn" };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
      }
    });
    return child;
  }) as any;
  const connected = async () => {
    const deadline = Date.now() + 2000;
    while (!requests.some((request) => request.method === "session/prompt")) {
      assert.ok(Date.now() < deadline, `fake ACP timeout: ${requests.map((request) => request.method)}`);
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.deepEqual(requests.slice(0, 3).map((request) => request.method), ["initialize", "session/new", "session/prompt"]);
  };
  return { spawn, launches, requests, connected };
}
