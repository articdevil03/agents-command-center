import test from "node:test";
import assert from "node:assert/strict";
import { openWs, nextMessage } from "./http-helpers.ts";

// The type of a message comes from the page. A name that also sits on Object.prototype must be refused like any made-up type, never looked up and called.
for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "no-such-message"]) {
  test(`WebSocket: message type "${type}" is refused as an unknown type`, async () => {
    const ws = await openWs();
    try {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type }));
      const answer = await reply;
      assert.equal(answer.type, "error");
      assert.equal(answer.message, `unknown message type: ${type}`);
    } finally {
      ws.close();
    }
  });
}
