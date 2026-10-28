// Turns a worker seat's raw stdout into renderable text plus whatever usage
// signal it carries, so the live terminal pane and the usage panel both work
// off the same bytes. Kept pure and separate from runner.ts so a captured
// real CLI line can be asserted directly, with no spawning.
//
// Two unrelated jobs live here, kept apart because they have opposite display
// requirements:
//   - claude (--output-format stream-json --verbose): the pane must never
//     show raw JSON, so a full line has to be buffered, parsed, and replaced
//     with rendered text before anything reaches onOutput.
//   - codex: plain text, unchanged, must reach onOutput immediately. Its only
//     instrument is a "tokens used" / "<count>" line pair printed to STDERR
//     at the very end, so that's scanned on the side, without ever gating
//     display, and held rather than surfaced until the process actually closes.
// opencode has no equivalent instrumentation and is never routed through
// this module at all (see runner.ts) -- it stays a pure passthrough.
import { usageDeltaFromResult, type UsageDelta } from "./usage.ts";

export type RateLimitWindow = { utilization: number; resetsAt: number };
export type RateLimitWindows = { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow };

// text: "" means nothing to display for this line (hook/system noise, or a
// rate-limit event, which is signal but not transcript) -- never a stand-in
// for "unparsed": an unparsed or unrecognised line always carries its own raw
// text instead (see feedClaudeOutput's degradation guarantee).
export type AgentUsageEvent = {
  text: string;
  usage?: UsageDelta;
  rateLimit?: RateLimitWindows;
};

export type AgentUsageState = {
  buffer: string; // held partial line -- claude's stdout JSON on a claude state, codex's stderr token-footer text on a codex state (never both at once: runner.ts creates one or the other per seat, never a shared instance)
  lastModelId: string | null; // captured from the most recent assistant line's message.model
  lastAssistantText: string | null; // the most recent non-empty assistant text actually rendered this run, so an identical trailing "result" string is never shown twice
  codexPendingTokens: boolean; // true right after a codex line was exactly "tokens used"
  codexHeldTokens: UsageDelta | null; // held until close, invalidated by any following line
};

export function createAgentUsageState(): AgentUsageState {
  return { buffer: "", lastModelId: null, lastAssistantText: null, codexPendingTokens: false, codexHeldTokens: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);
    // "thinking" and anything else: no display text (guard 5).
  }
  return parts.join("\n");
}

function parseRateLimitWindows(unifiedWindows: unknown): RateLimitWindows | undefined {
  if (!isRecord(unifiedWindows)) return undefined;
  const windows: RateLimitWindows = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = unifiedWindows[key];
    if (isRecord(w) && typeof w.utilization === "number" && typeof w.resetsAt === "number") {
      windows[key] = { utilization: w.utilization, resetsAt: w.resetsAt };
    }
  }
  return windows.five_hour || windows.seven_day ? windows : undefined;
}

// Event types this CLI is known to emit that carry no user-facing output at
// all. Deliberately an allow-list of KNOWN NOISE, not a default-hide: a type
// this list has never seen (a future CLI version adding one) falls through
// to raw passthrough below, exactly like unparseable JSON, so a real
// output-carrying type can never go silently missing.
const KNOWN_NOISE_TYPES = new Set(["user"]);

// Every rendered system line is capped hard, error lines included -- a real
// failure is worth showing, a 60KB one is still debris, and this is what
// stops any future CLI payload from ever dumping kilobytes into the pane.
const SYSTEM_LINE_CAP = 200;
function capSystemLine(line: string): string {
  return line.length > SYSTEM_LINE_CAP ? `${line.slice(0, SYSTEM_LINE_CAP)} …[truncated]` : line;
}

// system subtypes observed on real runs and confirmed to carry no outcome or
// signal worth a pane line: pure lifecycle metadata (init, thinking_tokens),
// a hook merely starting (hook_started -- the matching hook_response carries
// the actual outcome), or a hook reporting its own success. Deliberately an
// allow-list of KNOWN QUIET shapes, not a default-hide: anything else -- a
// failure (handled above this check), an unrecognised subtype, or a
// hook_response that didn't report success -- still gets a short one-line
// summary, never suppressed and never the full payload (the full payload is
// what flooded the pane in the first place).
const SILENT_SYSTEM_SUBTYPES = new Set(["init", "thinking_tokens", "hook_started"]);
function isSilentSystemEvent(subtype: string, parsed: Record<string, unknown>): boolean {
  return SILENT_SYSTEM_SUBTYPES.has(subtype) || (subtype === "hook_response" && parsed.outcome === "success");
}

function parseClaudeLine(state: AgentUsageState, rawLine: string, nl: string): AgentUsageEvent {
  if (rawLine.trim() === "") return { text: rawLine + nl };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { text: rawLine + nl }; // degrade to raw text: never dropped, never silent (guard 4)
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return { text: rawLine + nl };

  switch (parsed.type) {
    case "system": {
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "system";
      const stderr = typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";
      const failed = parsed.is_error || /error|fail|abort|timeout/i.test(subtype)
        || (parsed.exit_code !== undefined && parsed.exit_code !== 0) || stderr;
      if (failed) {
        const line = `[error] ${subtype}${parsed.exit_code !== undefined ? ` (exit ${parsed.exit_code})` : ""}${stderr ? `: ${stderr.replace(/\s+/g, " ")}` : ""}`;
        return { text: capSystemLine(line) + "\n" };
      }
      if (isSilentSystemEvent(subtype, parsed)) return { text: "" };
      return { text: capSystemLine(`[system] ${subtype}`) + "\n" };
    }
    case "assistant": {
      const message = isRecord(parsed.message) ? parsed.message : null;
      if (message && typeof message.model === "string") state.lastModelId = message.model;
      const text = message ? textFromContent(message.content) : "";
      if (text) state.lastAssistantText = text;
      return { text: text ? text + "\n" : "" };
    }
    case "result": {
      const usage = usageDeltaFromResult(parsed, state.lastModelId ?? undefined);
      const resultText = typeof parsed.result === "string" ? parsed.result : "";
      // The final assistant line already rendered this exact text -- never show it twice.
      if (resultText && resultText === state.lastAssistantText) return { text: "", usage };
      if (resultText) return { text: resultText + "\n", usage };
      if (parsed.is_error) {
        // No result string, but the run genuinely failed -- report it rather
        // than silently dropping it (the same "never hide real output" rule
        // that governs the KNOWN_NOISE_TYPES allow-list below).
        const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "unknown error";
        return { text: `[error] ${subtype}\n`, usage };
      }
      return { text: "", usage };
    }
    case "rate_limit_event": {
      const info = isRecord(parsed.rate_limit_info) ? parsed.rate_limit_info : null;
      const windows = info ? parseRateLimitWindows(info.unifiedWindows) : undefined;
      return { text: "", ...(windows ? { rateLimit: windows } : {}) };
    }
    default:
      return KNOWN_NOISE_TYPES.has(parsed.type) ? { text: "" } : { text: rawLine + nl };
  }
}

// A chunk arrives mid-line; a partial line is held in state.buffer until its
// newline arrives, so a JSON object split across two chunks is parsed exactly
// once, from the reassembled whole line (guard 3).
export function feedClaudeOutput(state: AgentUsageState, chunk: string): AgentUsageEvent[] {
  state.buffer += chunk;
  const events: AgentUsageEvent[] = [];
  let idx: number;
  while ((idx = state.buffer.indexOf("\n")) !== -1) {
    const rawLine = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    events.push(parseClaudeLine(state, rawLine, "\n"));
  }
  return events;
}

// Called once, when the process closes: a final line with no trailing
// newline (common -- a CLI's very last "result" line rarely ends in one)
// must still be parsed, not silently dropped.
export function flushClaudeOutput(state: AgentUsageState): AgentUsageEvent[] {
  if (state.buffer.length === 0) return [];
  const rawLine = state.buffer;
  state.buffer = "";
  return [parseClaudeLine(state, rawLine, "")];
}

// codex: plain text passes straight through to onOutput unmodified and
// immediately (see runner.ts) -- this scans a side copy of its STDERR bytes
// (proven against a real captured run: codex prints "tokens used"/<count> to
// stderr, never stdout -- stdout carries only the agent's final answer) for
// that pair only, and never gates or delays display.
function codexLineTokens(state: AgentUsageState, trimmedLine: string): UsageDelta | null {
  // A blank line is stray stdout formatting, never the agent's own prose --
  // it must not discard a real held measurement (proven: a trailing blank
  // line after the real footer was wiping a correct count before flush).
  if (trimmedLine === "") return null;
  // Prefer no measurement over a guessed one: a footer must remain last.
  state.codexHeldTokens = null;
  if (state.codexPendingTokens) {
    state.codexPendingTokens = false;
    const digits = trimmedLine.replace(/,/g, "");
    if (/^\d+$/.test(digits)) return { modelId: null, contextTokens: Number(digits), contextWindow: null, costUsd: null };
    return null; // didn't match: not re-armed, falls through as ordinary text (already shown verbatim)
  }
  if (trimmedLine === "tokens used") state.codexPendingTokens = true;
  return null;
}

// Stateful across chunks (guard 6): "tokens used" and its number can land in
// different chunks, and the number's thousands separators must survive. Never
// returns a delta itself -- a match found here is only HELD (codexHeldTokens),
// because the agent's own prose could coincidentally contain the exact line
// "tokens used" mid-run. Only flushCodexTokens, called once at process close,
// ever reports a delta, so a later real footer always overwrites an earlier
// false match instead of both being reported.
export function scanCodexTokens(state: AgentUsageState, chunk: string): UsageDelta[] {
  state.buffer += chunk;
  let idx: number;
  while ((idx = state.buffer.indexOf("\n")) !== -1) {
    const rawLine = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    const delta = codexLineTokens(state, rawLine.trim());
    if (delta) state.codexHeldTokens = delta;
  }
  return [];
}

// Called once, at process close: the only place a codex usage delta is ever
// returned. Also catches a trailing count with no newline before the process exits.
export function flushCodexTokens(state: AgentUsageState): UsageDelta[] {
  if (state.buffer.length > 0) {
    const rawLine = state.buffer;
    state.buffer = "";
    const delta = codexLineTokens(state, rawLine.trim());
    if (delta) state.codexHeldTokens = delta;
  }
  return state.codexHeldTokens ? [state.codexHeldTokens] : [];
}
