// Turns the Agent SDK's `result` message into per-seat usage numbers. Kept
// pure and separate from leader.ts/index.ts so the parsing and accumulation
// can be asserted directly, without spawning a leader or a server.

// A single turn's parsed numbers. `null` means "not measured this turn",
// never a stand-in zero: a missing field must not render the same as a real
// zero measurement (see toUsageSnapshot).
export type UsageDelta = {
  modelId: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
};

// The running accumulator kept per seat. bankedCostUsd and currentCostUsd are
// split apart so a leader restart can fold the finished instance's total into
// the bank (bankUsage) without the new instance's own small early totals ever
// being summed on top of the old ones -- total_cost_usd is already the
// cumulative total for whichever query() call produced it, so adding deltas
// together across turns of the SAME instance would double-count.
export type UsageTotals = {
  modelId: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  bankedCostUsd: number;
  currentCostUsd: number | null;
  turns: number;
};

// The shape actually sent to the browser: one spend figure, never the
// bank/current split (that split is this module's own bookkeeping).
export type UsageSnapshot = {
  modelId: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  turns: number;
};

export function zeroUsage(): UsageTotals {
  return { modelId: null, contextTokens: null, contextWindow: null, bankedCostUsd: 0, currentCostUsd: null, turns: 0 };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// A cost only counts as measured when it's a real, finite, non-negative
// number. Anything else (missing, NaN, a string, a negative value) reports as
// "not measured" rather than as free or as debt.
function toCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// `usage` is the Messages API's snake_case token buckets; `modelUsage` is the
// SDK's own per-model camelCase summary, which is the only place the model's
// context window size is reported. contextTokens sums input-side buckets
// (fresh input + both cache buckets), excluding output. This is an estimate,
// not true context occupancy, which the SDK does not expose.
// `modelId` (captured when the leader starts) selects which model's
// window applies; without it, or if that model's entry is missing or reports
// a non-positive window, contextWindow is unknown rather than guessed from
// whichever entry happens to be first or reused from an earlier turn. Never
// throws: a missing or malformed `usage`/`modelUsage` (or a non-object
// result) yields nulls for the fields it would have filled.
export function usageDeltaFromResult(result: unknown, modelId?: string): UsageDelta {
  if (typeof result !== "object" || result === null) {
    return { modelId: modelId ?? null, contextTokens: null, contextWindow: null, costUsd: null };
  }
  const r = result as Record<string, unknown>;

  let contextTokens: number | null = null;
  const usage = r.usage;
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    contextTokens = toNumber(u.input_tokens) + toNumber(u.cache_read_input_tokens) + toNumber(u.cache_creation_input_tokens);
  }

  let contextWindow: number | null = null;
  const modelUsage = r.modelUsage;
  if (modelId && typeof modelUsage === "object" && modelUsage !== null) {
    const entry = (modelUsage as Record<string, unknown>)[modelId];
    const window = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).contextWindow : undefined;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) contextWindow = window;
  }

  return { modelId: modelId ?? null, contextTokens, contextWindow, costUsd: toCost(r.total_cost_usd) };
}

// contextTokens/contextWindow reflect the LATEST turn only: input-side token
// usage against the model window, not an occupancy reading. Summing turns
// would count re-sent input again. A turn that
// doesn't report a window renders as unknown rather than reusing an earlier
// turn's (possibly different model's) window. currentCostUsd, in contrast, IS
// carried forward when a turn's cost is unmeasured, since total_cost_usd is a
// monotonic running total for the instance and a single malformed delta
// shouldn't blank out a real spend figure. turns counts completed calls to
// this function -- one per finished leader turn -- not anything read out of
// the delta itself, so a delta with no usable numbers still counts as a turn.
export function addUsage(totals: UsageTotals, delta: UsageDelta): UsageTotals {
  return {
    modelId: delta.modelId,
    contextTokens: delta.contextTokens,
    contextWindow: delta.contextWindow,
    bankedCostUsd: totals.bankedCostUsd,
    currentCostUsd: delta.costUsd ?? totals.currentCostUsd,
    turns: totals.turns + 1,
  };
}

// Called whenever a leader instance is about to be replaced by a fresh one
// while the seat's usage is otherwise being kept (a dead leader restarting
// mid-project -- a project switch clears the whole map instead, deliberately,
// since usage is session-scoped by design). Folds the finished instance's
// latest total into the bank and clears the per-instance figures, so the next
// instance starts counting from zero without losing what came before or
// double-counting it.
export function bankUsage(totals: UsageTotals): UsageTotals {
  return {
    modelId: null,
    contextTokens: null,
    contextWindow: null,
    bankedCostUsd: totals.bankedCostUsd + (totals.currentCostUsd ?? 0),
    currentCostUsd: null,
    turns: totals.turns,
  };
}

// costUsd is null (not $0.0000) until something has actually been measured --
// otherwise a seat that never got a real result would report a real-looking
// free session.
export function toUsageSnapshot(totals: UsageTotals): UsageSnapshot {
  const measured = totals.currentCostUsd !== null || totals.bankedCostUsd > 0;
  return {
    modelId: totals.modelId,
    contextTokens: totals.contextTokens,
    contextWindow: totals.contextWindow,
    costUsd: measured ? totals.bankedCostUsd + (totals.currentCostUsd ?? 0) : null,
    turns: totals.turns,
  };
}
