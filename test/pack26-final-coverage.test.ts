// Pack 26 final cleanup: a restored guard that drives the real stopLeaderSession.
import test from "node:test";
import assert from "node:assert/strict";
import { loadStopSession } from "./pack26-final-coverage-helpers.ts";

test("P26F stopped reply callback retains the earlier prefix", async () => {
  const { state, stopLeaderSession, tabId } = await loadStopSession();
  const replies: string[] = [], settled: boolean[] = [];
  // A turn that already delivered "Earlier part. " (a handed-back reply) and has "current partial" still held when Stop arrives.
  state.leaderTurnResolvers.set(tabId, { resolve: (ok: boolean) => settled.push(ok), text: "", earlier: "Earlier part. ", onReply: (text: string) => replies.push(text) });
  state.leaderTurnText.set(tabId, "current partial");
  try {
    stopLeaderSession(tabId);
    assert.deepEqual(replies, ["Earlier part. current partial"], "the callback gets the earlier text and the current partial, in that order, once");
    assert.deepEqual(settled, [false], "the turn's resolver settles false exactly once");
    assert.equal(state.leaderTurnResolvers.has(tabId), false, "the pending turn is gone");
  } finally {
    state.leaderTurnResolvers.delete(tabId); state.leaderTurnText.delete(tabId);
  }
});
