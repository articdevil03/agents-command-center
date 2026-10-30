import test from "node:test";
import assert from "node:assert/strict";
import * as usage from "../server/usage.ts";
import { leader, usageDeltaFromResult, addUsage, zeroUsage, bankUsage, toUsageSnapshot, createAgentUsageState, feedClaudeOutput, flushClaudeOutput, scanCodexTokens, flushCodexTokens } from "./runner-helpers.ts";

// ---- usage.ts: SDK result -> per-seat usage delta, and the accumulator ----

test("usageDeltaFromResult: ctx estimate excludes output tokens and includes all input buckets, scoped to the given model id", () => {
  const result = {
    type: "result", subtype: "success", total_cost_usd: 0.0234,
    usage: { input_tokens: 120, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 120, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 200,
        webSearchRequests: 0, costUSD: 0.0234, contextWindow: 200000,
      },
    },
  };
  assert.deepEqual(usageDeltaFromResult(result, "claude-opus-5"), { modelId: "claude-opus-5", contextTokens: 5320, contextWindow: 200000, costUsd: 0.0234 });
});

// Guard 4a: the window must come from the SEAT'S OWN model entry, never the
// first (or only other) entry in modelUsage -- a worker or a differently
// -provisioned model with a much larger window must not leak into this seat's
// percentage.
test("usageDeltaFromResult: selects the window for the given model id, never a different model's entry", () => {
  const result = {
    total_cost_usd: 0.01,
    usage: { input_tokens: 50000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      other: { contextWindow: 1000000 },
      leader: { contextWindow: 200000 },
    },
  };
  assert.equal(usageDeltaFromResult(result, "leader").contextWindow, 200000);
  assert.equal(usageDeltaFromResult(result, "other").contextWindow, 1000000);
  assert.equal(usageDeltaFromResult(result, "nonexistent").contextWindow, null, "an unknown model id must not fall back to any other entry");
  assert.equal(usageDeltaFromResult(result).contextWindow, null, "no model id at all must not guess from the first entry");
});

// Guard 4b: a result that omits contextWindow, or reports a non-positive one,
// must report the window as unknown, never reuse an earlier turn's or another
// model's number (that reuse used to defeat the frontend's "not reported for
// this turn" handling).
test("usageDeltaFromResult: a missing or non-positive contextWindow reports as unknown, not zero-as-real or borrowed", () => {
  for (const modelUsage of [
    {}, { leader: {} }, { leader: { contextWindow: 0 } }, { leader: { contextWindow: -5 } }, { leader: { contextWindow: "200000" } },
  ]) {
    assert.equal(usageDeltaFromResult({ modelUsage }, "leader").contextWindow, null, `modelUsage: ${JSON.stringify(modelUsage)}`);
  }
});

test("usageDeltaFromResult: missing or malformed usage/modelUsage never throws and reports as unmeasured, not zero", () => {
  const unmeasured = { modelId: "leader", contextTokens: null, contextWindow: null, costUsd: null };
  for (const bad of [
    null, undefined, "not an object", 42, [],
    {},
    { usage: null, modelUsage: null },
    { usage: "nope", modelUsage: "nope" },
    { total_cost_usd: "free" },
    { total_cost_usd: NaN },
    { total_cost_usd: -1 }, // Guard 6: a negative cost is rejected, not shown as debt
  ]) {
    assert.doesNotThrow(() => usageDeltaFromResult(bad, "leader"));
    assert.deepEqual(usageDeltaFromResult(bad, "leader"), unmeasured, `input: ${JSON.stringify(bad)}`);
  }
  // A present-but-malformed usage object is still a measured turn (the SDK
  // never sends a partial bucket set in practice); missing fields sum as 0.
  assert.equal(usageDeltaFromResult({ usage: { input_tokens: "not a number" } }, "leader").contextTokens, 0);
});

test("addUsage: latest turn wins for context and cost (never summed), window is never carried over unreported, one turn per call", () => {
  const first = addUsage(zeroUsage(), { modelId: null, contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 });
  assert.deepEqual(first, { modelId: null, contextTokens: 1000, contextWindow: 200000, bankedCostUsd: 0, currentCostUsd: 0.5, turns: 1 });
  const second = addUsage(first, { modelId: null, contextTokens: 500, contextWindow: null, costUsd: 0.0538 });
  assert.deepEqual(second, { modelId: null, contextTokens: 500, contextWindow: null, bankedCostUsd: 0, currentCostUsd: 0.0538, turns: 2 },
    "context tokens and cost must reflect only the latest turn, and a turn with no reported window must not keep the previous one");
});

test("addUsage: a turn with no measured cost keeps the last known cost, unlike window", () => {
  const first = addUsage(zeroUsage(), { modelId: null, contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 });
  const second = addUsage(first, { modelId: null, contextTokens: 500, contextWindow: 200000, costUsd: null });
  assert.equal(second.currentCostUsd, 0.5, "a single malformed cost must not blank out a real running total");
});

test("bankUsage: folds the finished instance's cost into the bank and clears per-instance figures, without losing turns", () => {
  const totals = addUsage(addUsage(zeroUsage(), { modelId: "claude-opus-5", contextTokens: 1000, contextWindow: 200000, costUsd: 0.5 }),
    { modelId: "claude-opus-5", contextTokens: 1500, contextWindow: 200000, costUsd: 0.9 });
  const banked = bankUsage(totals);
  assert.deepEqual(banked, { modelId: null, contextTokens: null, contextWindow: null, bankedCostUsd: 0.9, currentCostUsd: null, turns: 2 },
    "a banked total must not carry the dead instance's model forward");

  // The next instance's own turns must add onto the bank, not replace it or double it.
  const nextInstance = addUsage(banked, { modelId: null, contextTokens: 200, contextWindow: 200000, costUsd: 0.1 });
  assert.deepEqual(toUsageSnapshot(nextInstance), { modelId: null, contextTokens: 200, contextWindow: 200000, costUsd: 1.0, turns: 3 });
});

test("bankUsage: banking an entry that never measured a cost is a harmless no-op", () => {
  assert.deepEqual(bankUsage(zeroUsage()), zeroUsage());
});

test("toUsageSnapshot: costUsd is null (not $0.0000) until something is actually measured", () => {
  assert.equal(toUsageSnapshot(zeroUsage()).costUsd, null);
  const measured = addUsage(zeroUsage(), { modelId: null, contextTokens: 0, contextWindow: 200000, costUsd: 0 });
  assert.equal(toUsageSnapshot(measured).costUsd, 0, "a real zero cost is still a measurement, once a turn has actually reported it");
});

test("addUsage: reset actually zeroes the accumulator, not merely the display of it", () => {
  const totals = addUsage(addUsage(zeroUsage(), { modelId: null, contextTokens: 9999, contextWindow: 200000, costUsd: 9.99 }),
    { modelId: null, contextTokens: 1, contextWindow: 200000, costUsd: 0.01 });
  assert.notDeepEqual(totals, zeroUsage());
  const reset = zeroUsage();
  assert.deepEqual(reset, { modelId: null, contextTokens: null, contextWindow: null, bankedCostUsd: 0, currentCostUsd: null, turns: 0 });
  const afterReset = addUsage(reset, { modelId: null, contextTokens: 42, contextWindow: 200000, costUsd: 0.42 });
  assert.deepEqual(afterReset, { modelId: null, contextTokens: 42, contextWindow: 200000, bankedCostUsd: 0, currentCostUsd: 0.42, turns: 1 },
    "post-reset totals must reflect only the new delta, not anything from before the reset");
});

// ---- agent-usage.ts: turns a claude/codex worker's raw stdout into
// rendered text plus whatever usage/rate-limit signal it carries. Pure-parser
// level here (buffer handling, one line at a time); the real runSeat/onUsage
// call-site wiring is proven separately in test/round2-*.test.ts's
// "agent-usage:" tests, per the "guard the call site, not the helper" rule. ----

test("agent-usage/claude: a JSON object split across two chunks is parsed exactly once (guard 3)", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "hello" }] } });
  assert.deepEqual(feedClaudeOutput(state, line.slice(0, 10)), [], "an incomplete line must not be parsed or emitted yet");
  const events = feedClaudeOutput(state, line.slice(10) + "\n");
  assert.equal(events.length, 1, "the reassembled line must be parsed exactly once, not dropped or double-rendered");
  assert.equal(events[0].text, "hello\n");
});

test("agent-usage/claude: unparseable output passes through verbatim -- the degradation guarantee (guard 4)", () => {
  const state = createAgentUsageState();
  const events = feedClaudeOutput(state, "Building the feature...\nnot json at all {{{\n");
  assert.deepEqual(events.map((e) => e.text), ["Building the feature...\n", "not json at all {{{\n"]);
});

test("agent-usage/claude: thinking blocks and system lines produce no display text, while text blocks do (guard 5)", () => {
  const state = createAgentUsageState();
  const thinking = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "thinking", thinking: "pondering" }] } });
  const text = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "text", text: "hi" }] } });
  const system = JSON.stringify({ type: "system", subtype: "init" });
  const events = feedClaudeOutput(state, `${thinking}\n${text}\n${system}\n`);
  assert.deepEqual(events.map((e) => e.text), ["", "hi\n", ""]);
});

// P2 fix 3: the noise suppression is an allow-list of KNOWN noise types
// ("system", "user"), never a default-hide -- a type this CLI has never
// reported before must degrade to raw passthrough, exactly like unparseable
// JSON, so a future event type that carries real output can never go
// silently missing.
test("agent-usage/claude: an unrecognised event type falls through to raw passthrough, never silently hidden (guard: known-noise allow-list, not a default hide)", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "some_future_event", payload: "new" });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, line + "\n");
});

// P2 fix 3: a "result" that reports failure but carries no `result` string
// must still say so, not vanish the way an ordinary empty result does.
test("agent-usage/claude: a result with no result string but is_error reports the failure instead of vanishing", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.02 });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, "[error] error_max_turns\n");
});

// P2 fix 7: the final "result" line usually repeats the text the last
// "assistant" line already rendered -- must not be shown a second time, but
// the usage delta it carries must still be reported.
test("agent-usage/claude: a result line's text is not re-rendered when it exactly repeats the prior assistant line", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "text", text: "All done." }] } }) + "\n");
  const resultLine = JSON.stringify({ type: "result", result: "All done.", total_cost_usd: 0.01, usage: { input_tokens: 5 }, modelUsage: {} });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events[0].text, "", "must not render the same text twice");
  assert.ok(events[0].usage, "the usage delta must still be reported even though the text is suppressed");
});

test("agent-usage/claude: a result line with text that was never shown by an assistant line is still rendered", () => {
  const state = createAgentUsageState();
  const resultLine = JSON.stringify({ type: "result", result: "Never shown before.", total_cost_usd: 0.01, usage: {}, modelUsage: {} });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events[0].text, "Never shown before.\n");
});

test("agent-usage/claude: a tool_use block renders as a compact [tool: X] line, not raw JSON", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", name: "Read", input: {} }] } });
  assert.equal(feedClaudeOutput(state, line + "\n")[0].text, "[tool: Read]\n");
});

test("agent-usage/claude: a real captured result line produces a usage delta scoped to the seat's model, from the model id captured off the prior assistant line", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "working" }] } }) + "\n");
  const resultLine = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "All done.",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow: 200000 } },
  });
  const events = feedClaudeOutput(state, resultLine + "\n");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].usage, { modelId: "claude-haiku-4-5-20251001", contextTokens: 300, contextWindow: 200000, costUsd: 0.0123 });
  assert.equal(events[0].text, "All done.\n");
});

test("agent-usage/claude: rate_limit_event yields the parsed plan windows and no display text", () => {
  const state = createAgentUsageState();
  const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
    five_hour: { utilization: 0.21, resetsAt: 1788750600 }, seven_day: { utilization: 0.57, resetsAt: 1788865200 },
  } } });
  const events = feedClaudeOutput(state, line + "\n");
  assert.equal(events[0].text, "");
  assert.deepEqual(events[0].rateLimit, { five_hour: { utilization: 0.21, resetsAt: 1788750600 }, seven_day: { utilization: 0.57, resetsAt: 1788865200 } });
});

test("agent-usage/claude: a malformed rate_limit_info never fabricates a windows object", () => {
  const state = createAgentUsageState();
  for (const bad of [{}, { rate_limit_info: {} }, { rate_limit_info: { unifiedWindows: {} } }, { rate_limit_info: { unifiedWindows: { five_hour: {} } } }]) {
    const events = feedClaudeOutput(state, JSON.stringify({ type: "rate_limit_event", ...bad }) + "\n");
    assert.equal(events[0].rateLimit, undefined, JSON.stringify(bad));
  }
});

test("agent-usage/claude: a final line with no trailing newline is flushed once, not dropped or repeated", () => {
  const state = createAgentUsageState();
  feedClaudeOutput(state, "no newline yet");
  assert.deepEqual(flushClaudeOutput(state).map((e) => e.text), ["no newline yet"]);
  assert.deepEqual(flushClaudeOutput(state), [], "a second flush with nothing left over must be a no-op");
});

// P2 fix 4: a match is never surfaced mid-stream -- it is held, and only
// flushCodexTokens (called once, at process close) ever returns a delta.
test("agent-usage/codex: \"tokens used\" is parsed with its comma -- 19,878 reads as 19878, never 19 -- but only surfaced at flush (guard 4/6)", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "some output\ntokens used\n19,878\n"), [], "never surfaced mid-stream");
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: the \"tokens used\"/count pair still parses when split across chunks, however it lands (guard 6)", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens us"), []);
  assert.deepEqual(scanCodexTokens(state, "ed\n19,"), []);
  assert.deepEqual(scanCodexTokens(state, "878\n"), []);
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: a trailing count with no newline before the process exits is still caught at flush", () => {
  const state = createAgentUsageState();
  scanCodexTokens(state, "tokens used\n19,878");
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }]);
});

test("agent-usage/codex: a non-numeric line after \"tokens used\" is never mistaken for a count", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens used\nnot a number\n"), []);
  assert.deepEqual(flushCodexTokens(state), [], "nothing was ever actually held");
});

// P2 fix 4: the whole reason a match is held instead of reported immediately
// -- an earlier match (the agent's own prose coincidentally printing the
// exact line "tokens used") must never survive a later, real footer.
test("agent-usage/codex: a later real footer overwrites an earlier match, and nothing is reported until flush", () => {
  const state = createAgentUsageState();
  assert.deepEqual(scanCodexTokens(state, "tokens used\n111\n"), [], "an earlier match must not be surfaced immediately");
  assert.deepEqual(scanCodexTokens(state, "more work happening\ntokens used\n19,878\n"), []);
  assert.deepEqual(flushCodexTokens(state), [{ modelId: null, contextTokens: 19878, contextWindow: null, costUsd: null }],
    "the later, real footer must win over the earlier one");
});
