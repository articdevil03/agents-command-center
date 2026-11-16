import test from "node:test";
import assert from "node:assert/strict";
import { attemptRequest, sleep } from "./pack18-harness.ts";

async function exercise(payload: any, delayed: any[] = []) {
  const messages: any[] = [{ type: "error", message: "old error" }];
  const barrier = "unknown message type: p36-barrier";
  const send = (message: any) => {
    if (message.type !== "p36-barrier") return;
    messages.push({ type: "error", message: barrier });
    setImmediate(() => messages.push(...delayed));
  };
  const wait = async (fn: () => any) => { for (let n = 0; n < 100; n++) { const reply = fn(); if (reply) return reply; await sleep(5); } assert.fail("barrier FOUND"); };
  const start = Date.now(), result = await attemptRequest(messages, send, wait, payload, barrier);
  assert.equal(messages.some((m) => m.message === barrier), false, "barrier removed");
  return { result, elapsed: Date.now() - start };
}

test("attempt returns an error one macrotask after its barrier", async () => {
  assert.deepEqual((await exercise({ type: "run" }, [{ type: "error", message: "late refusal" }])).result, { error: "late refusal" });
});
test("attempt correlates errors by requestId when supplied", async () => {
  const delayed = [{ type: "error", requestId: "other", message: "unrelated" }, { type: "error", requestId: "ours", message: "matched" }];
  assert.deepEqual((await exercise({ type: "run", requestId: "ours" }, delayed)).result, { error: "matched" });
});
test("attempt with no error returns an empty result within its bounded settle", async () => {
  const { result, elapsed } = await exercise({ type: "run", requestId: "ours" }, [{ type: "error", requestId: "other", message: "unrelated" }]);
  assert.deepEqual(result, {}); assert.ok(elapsed < 1000, `no-error settle took ${elapsed}ms`);
});
