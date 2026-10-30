export const serverOtherMutations = [
  ["guard-round2-codex-stdout-invalidates", "server/runner.ts", 'if (!text) return;\n    if (claudeState) {', 'if (!text) return;\n    if (codexState) Object.assign(codexState, createAgentUsageState());\n    if (claudeState) {'],
  ["guard-round2-stderr-output-wiring","server/runner.ts","    emit(text, errHider);\n    if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));","    if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));"],
  ["guard-round2-claude-flush-call-site", "server/runner.ts", 'if (claudeState) emitClaudeEvents(flushClaudeOutput(claudeState));', ''],
  ["guard-round2-system-case", "server/agent-usage.ts", 'case "system": {', 'case "system": return { text: "" }; case "unused": {'],
  ["guard-round2-system-exit", "server/agent-usage.ts", '(parsed.exit_code !== undefined && parsed.exit_code !== 0)', 'false'],
  ["guard-round2-system-stderr", "server/agent-usage.ts", '|| stderr;', '|| false;'],
  ["guard-round2-system-subtype", "server/agent-usage.ts", '/error|fail|abort|timeout/i.test(subtype)', 'false'],
  ["guard-round2-system-unknown-shown", "server/agent-usage.ts", 'return { text: capSystemLine(`[system] ${subtype}`) + "\\n" };', 'return { text: "" };'],
  ["guard-round2-system-cap", "server/agent-usage.ts", 'line.length > SYSTEM_LINE_CAP', 'false'],
  ["guard-round2-codex-terminal-pair", "server/agent-usage.ts", 'state.codexHeldTokens = null;', ''],
  ["guard-usage-model-payload", "server/usage.ts", 'modelId: modelId ?? null, contextTokens,', 'modelId: null, contextTokens,'],
  ["guard-usage-model-accumulator", "server/usage.ts", 'modelId: delta.modelId,', 'modelId: null,'],
  ["guard-usage-model-snapshot", "server/usage.ts", 'modelId: totals.modelId,', 'modelId: null,'],
  ["guard-usage-context-excludes-output", "server/usage.ts", 'contextTokens = toNumber(u.input_tokens)', 'contextTokens = toNumber(u.output_tokens) + toNumber(u.input_tokens)'],
  ["guard-usage-cost-carry-forward", "server/usage.ts", 'currentCostUsd: delta.costUsd ?? totals.currentCostUsd,', 'currentCostUsd: delta.costUsd,'],
  // ---- killSeatAndConfirm (server/runner.ts): the one signal removal is
  // allowed to trust is the process's own real close, never a guess ----
  ["guard-confirm-kill-not-running-is-confirmed", "server/runner.ts", "if (!entry || !entry.proc.pid) return false;", "if (!entry) return true;\n  if (!entry.proc.pid) return false;"],
  ["guard-confirm-kill-real-close-confirms", "server/runner.ts", "  entry.stopRequested = true;\n", ""],
  ["guard-confirm-kill-timeout-unconfirmed", "server/runner.ts", "const grace = setTimeout(() => reportUnconfirmedKill(runId, entry, \"process did not exit within the grace period; it may still be running -- press Kill to try again\"), KILL_GRACE_MS);", "const grace = setTimeout(() => {}, KILL_GRACE_MS);"],
  // ---- P1 fix 1: the stall monitor judges a RUNNING process by the
  // permission it was launched with, never a live re-read of its current
  // role -- an edit to an Underground agent's role mid-run must never flip
  // the safety gate under an already-running process (server/index.ts) ----
  ["guard-run-record-frozen-at-launch", "server/runner.ts", "  run = Object.freeze({ ...run });\n", "  run = run;\n"],
  ["disk-model", "server/config.ts", ": isSafeShape(member.model) && isSafeShape(member.effort))) {", ": isSafeShape(member.effort))) {"],
  ["disk-effort", "server/config.ts", ": isSafeShape(member.model) && isSafeShape(member.effort))) {", ": isSafeShape(member.model))) {"],
  ["disk-seat-unsafe-id", "server/config.ts", "if (!isObject(tab) || !validSlug(tab.id) || !validText(tab.name)", "if (!isObject(tab) || !validText(tab.name)"],
  ["disk-seat-duplicate-id", "server/config.ts", "if (tabIds.has(tab.id.toLowerCase())) throw", "if (false) throw"],
  ["disk-seat-id-length-cap","server/process-types.ts","if (id.trim().length === 0 || id.length > MAX_SEAT_ID_LENGTH) return false;","if (id.trim().length === 0) return false;"],
  ["disk-seat-id-no-ascii-only-regression","server/process-types.ts","return !id.endsWith(\".\") && !id.endsWith(\" \");\n}","return !id.endsWith(\".\") && !id.endsWith(\" \") && /^[\\x00-\\x7f]*$/.test(id);\n}"],
  ["disk-seat-id-no-device-name-regression","server/process-types.ts","return !id.endsWith(\".\") && !id.endsWith(\" \");\n}","return !id.endsWith(\".\") && !id.endsWith(\" \") && ![\"CON\", \"PRN\", \"AUX\", \"NUL\", \"COM1\", \"LPT1\"].includes(id.toUpperCase());\n}"],
  ["raw-prompt", "server/runner.ts", "...commandEnv(run, briefPath)", "...commandEnv(run, prompt)"],
  ["origin", "server/security.ts", 'ALLOWED_ORIGINS.has(origin)', 'origin.startsWith("http://")'],
  ["host", "server/security.ts", 'ALLOWED_HOSTS.has(host)', 'true'],
  ["running-close", "server/runner.ts", "  running.delete(runId);\n", ""],
  ["working-status", "server/runner.ts", "try { cb.onStatus(run, \"working\"); }", "try { }"],
  ["stderr", "server/runner.ts", "proc.stderr?.on(\"data\", (chunk: Buffer) => {", "proc.stderr?.on(\"data-disabled\", (chunk: Buffer) => {"],
  ["shared-decoder", "server/runner.ts", 'const stderrDecoder = new StringDecoder("utf8");', 'const stderrDecoder = stdoutDecoder;'],
  ["seat-array", "server/config.ts", "if (!isObject(data) || !Array.isArray(data.projects)) throw", "if (!isObject(data)) throw"],
  ["seat-kind","server/setup.ts","    if (!caps) throw new Error(`seat ${slot}: unknown CLI`);\n",""],
  ["empty-seats","server/config.ts","  return data as unknown as Workspaces;\n}\n\n// A new Development tab starts on Our process.","  return { projects: [] };\n}\n\n// A new Development tab starts on Our process."],
  ["guard-sidebar-zero", "server/config-prefs.ts", "crewRailOpen: typeof raw.crewRailOpen === \"boolean\" ? raw.crewRailOpen : DEFAULT_CLIENT_PREFS.crewRailOpen,", "crewRailOpen: DEFAULT_CLIENT_PREFS.crewRailOpen,"],
  ["guard-usage-parse-tokens", "server/usage.ts", 'if (typeof usage === "object" && usage !== null) {', 'if (false) {'],
  ["guard-usage-parse-safety", "server/usage.ts", 'if (typeof result !== "object" || result === null) {', 'if (false) {'],
  ["guard-usage-accumulate-turns", "server/usage.ts", 'turns: totals.turns + 1,', 'turns: totals.turns,'],
  // ---- usage panel fix (P2 double-counted spend, traffic-not-occupancy
  // context, misleading zeroes, wrong-model window, fake/negative costs) ----
  ["guard-usage-cost-latest-not-sum", "server/usage.ts", 'currentCostUsd: delta.costUsd ?? totals.currentCostUsd,', 'currentCostUsd: (totals.currentCostUsd ?? 0) + (delta.costUsd ?? 0),'],
  ["guard-usage-context-latest-not-sum", "server/usage.ts", 'contextTokens: delta.contextTokens,', 'contextTokens: (totals.contextTokens ?? 0) + (delta.contextTokens ?? 0),'],
  ["guard-usage-window-no-carryover", "server/usage.ts", 'contextWindow: delta.contextWindow,', 'contextWindow: delta.contextWindow ?? totals.contextWindow,'],
  ["guard-usage-window-model-scoped", "server/usage.ts", 'const entry = (modelUsage as Record<string, unknown>)[modelId];', 'const entry = Object.values(modelUsage as Record<string, unknown>)[0];'],
  ["guard-usage-window-positive-check", "server/usage.ts", 'Number.isFinite(window) && window > 0) contextWindow = window;', 'Number.isFinite(window)) contextWindow = window;'],
  ["guard-usage-cost-negative-rejected", "server/usage.ts", 'Number.isFinite(value) && value >= 0 ? value : null;', 'Number.isFinite(value) ? value : null;'],
  ["guard-usage-bank-on-restart", "server/usage.ts", 'bankedCostUsd: totals.bankedCostUsd + (totals.currentCostUsd ?? 0),', 'bankedCostUsd: totals.bankedCostUsd,'],
  ["guard-usage-snapshot-measured", "server/usage.ts", 'const measured = totals.currentCostUsd !== null || totals.bankedCostUsd > 0;', 'const measured = true;'],
  // guard-usage-cost-tiny-floor and guard-usage-cost-negative-frontend
  // (formatCostUsd's tiny-floor and negative-cost checks) removed: spend was
  // deleted from public/app/*.js entirely, formatCostUsd included (see the
  // brief: "no need for spend count" -- delete the code, don't hide it).
  // Nothing left in usageBadgeText to mutate a cost check out of; see
  // frontend-*.test.ts's "usageBadgeText never references cost/spend"
  // structural guard instead.
  ["guard-usage-bank-model-clear", "server/usage.ts", 'export function bankUsage(totals: UsageTotals): UsageTotals {\n  return {\n    modelId: null,', 'export function bankUsage(totals: UsageTotals): UsageTotals {\n  return {\n    modelId: totals.modelId,'],

  // ---- Underground: the user's own independent roster, no Atlas leader ----
  // Guard 2 (the role list is closed), at all three places a role is ever
  // checked: the shared add/update validator, the add-flow's own early
  // check, and the disk loader.
  // Guard: the agent id is checked for Windows-filename safety on load, and
  // never allowed to collide with the "underground-" namespace itself.
  // Guard 5 (add/remove persist correctly, a removed agent's running process
  // is handled, not orphaned) at the real WS call sites.
  // Removal is always routed through killSeatAndConfirm now, running or not
  // (see server/index.ts's own comment on this) -- deleting the call itself
  // is what guard-underground-remove-dispatch-through-confirm below proves;
  // killSeatAndConfirm's own "nothing running" branch is proven at its real
  // call site by guard-confirm-kill-not-running-is-confirmed further down.
  // P1 fix 2: removal is refused (agent left fully in place) unless the kill
  // was actually confirmed -- reverting this is exactly the old orphan-risk
  // bug, restored (finishRemoval runs regardless of `confirmed`).
  // Defect 5 (P2): sandbox mode follows the role, not the kind -- an
  // Underground coder needs write access, a reviewer stays read-only.
  ["guard-codex-sandbox-follows-canwrite", "server/runner.ts", "--sandbox ${run.canWrite ? \"workspace-write\" : \"read-only\"}", "--sandbox read-only"],
  // Round 2 defects: a name denylist alone is bypassable through a custom
  // opencode model id, an opencode reviewer was always write-enabled, a
  // kind-change to opencode could submit a stale/invalid effort, and the
  // coder-vs-reviewer sandbox split was only proven at the helper level.
  ["guard-opencode-reviewer-permission","server/runner-crew.ts","...(run.canWrite ? {} : { permission: { edit: \"deny\", bash: \"deny\" } }),","...({}),"],
  ["guard-opencode-reviewer-env-wiring","server/runner.ts","...(run.cli === \"opencode\" && opencode ? { OPENCODE_CONFIG_CONTENT: opencode } : {})","...({})"],
  // ---- roster/CLI-picker pack: permission follows the ROLE on every CLI kind
  // (guard 1), the sidebar kind picker cascades a stale model/effort (guard
  // 3), and spend is gone structurally (guard 6). See test/runner-*.test.ts's
  // "canSeatWrite:"/"buildCommand: claude"/"applySeatKindUpdate:" tests. ----
  // Guard 1, the most important guard in the pack: a claude seat used to run
  // acceptEdits unconditionally with no role check -- dropping this ternary
  // reverts exactly that P1 (a reviewer switched to claude silently writes).
  ["guard-buildcommand-claude-role-check","server/runner.ts","const mode = run.canWrite ? CLAUDE_WRITE_FLAGS : run.crewTools ? CLAUDE_READ_ONLY_CREW_FLAGS : CLAUDE_READ_ONLY_FLAGS;","const mode = CLAUDE_WRITE_FLAGS;"],
  ["guard-claude-readonly-no-prompts", "server/runner.ts",
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";',
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";'],
  // Guard 4: discovery's call site never claims a real result on a parse
  // failure -- proven directly by test/cli-discovery.test.ts's injected-fake
  // "degrades to the fallback list, marked as such" tests, never just the
  // pure parser in isolation (the parser can be correct while the caller
  // still mislabels a null result as a live one).
  ["guard-discovery-claude-effort-honest-fallback", "server/cli-discovery.ts",
    'return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };\n}\n\nexport async function discoverOpencodeModels',
    'return { values: parsed ?? [...fallback], fallback: false };\n}\n\nexport async function discoverOpencodeModels'],
  ["guard-discovery-opencode-models-honest-fallback", "server/cli-discovery.ts",
    'const parsed = out ? parseOpencodeModels(out) : null;\n  return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };\n}',
    'const parsed = out ? parseOpencodeModels(out) : null;\n  return { values: parsed ?? [...fallback], fallback: false };\n}'],
  // ---- stall detection (server/stall.ts): the pure decision, guard 2 ----
  ["guard-stall-status-gate", "server/stall.ts", 'return status === "working" && currentByteCount === lastByteCount && elapsedMs >= thresholdMs;', 'return currentByteCount === lastByteCount && elapsedMs >= thresholdMs;'],
  ["guard-stall-byte-equality", "server/stall.ts", 'currentByteCount === lastByteCount && elapsedMs >= thresholdMs;', 'elapsedMs >= thresholdMs;'],
  ["guard-stall-threshold-gate", "server/stall.ts", 'elapsedMs >= thresholdMs;', 'elapsedMs >= 0;'],
  // ---- auto-relaunch policy (server/stall.ts): guard 3, the money guard.
  // Every refusal is its own mutation; each must turn test/stall.test.ts red
  // on its own, independent of the other four. See test/round2-*.test.ts's
  // "stall:" tests for the real runSeat/killSeat call-site proof (not just
  // this pure function) -- especially "a second stall... escalates instead
  // of relaunching again", which a mutation here would let loop. ----
  ["guard-relaunch-enabled-check", "server/stall.ts", 'if (!input.autoRelaunchEnabled) return false;', ''],
  ["guard-relaunch-already-check", "server/stall.ts", 'if (input.alreadyRelaunched) return false;', ''],
  ["guard-relaunch-killed-check", "server/stall.ts", 'if (input.wasKilled) return false;', ''],
  ["guard-relaunch-content-check", "server/stall.ts", 'if (input.logHasContent) return false;', ''],
  // MONEY GUARD 4: a seat that can edit files must never be auto-relaunched,
  // full stop -- see stall.ts's own top comment on why this can never be a
  // byte threshold. Dropping this line must let a writable seat (sonny, or a
  // seat switched to opencode via updateSeat in test/round2-*.test.ts, or the
  // pure "seatCanWrite: true" cases in test/stall.test.ts) auto-relaunch,
  // turning both suites red.
  ["guard-relaunch-writable-check", "server/stall.ts", 'if (input.seatCanWrite) return false;', ''],
  // Safety classification: Claude/opencode reviewers remain potentially writable.
  // Both branches are also exercised through real WS launch + tickStall in round2-*.test.ts.
  ["guard-canrunwrite-codex-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"codex\" ? run.canWrite : true;"],
  ["guard-canrunwrite-opencode-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"opencode\" ? run.canWrite : true;"],
  ["guard-canrunwrite-claude-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"claude\" ? run.canWrite : true;"],
  // ---- run history (server/history.ts): guard 4, pure listing/tail-reading
  // over fabricated directory data (test/history.test.ts) plus real files on
  // disk for the exit marker (test/runner-*.test.ts) ----
  ["guard-history-sort-order", "server/history.ts", 'return entries.sort((a, b) => b.timestamp - a.timestamp);', 'return entries.sort((a, b) => a.timestamp - b.timestamp);'],
  ["guard-history-seat-filter", "server/history.ts", 'if (!parsed || parsed.seatId !== seatId) continue;', 'if (!parsed) continue;'],
  ["guard-history-stats-skip", "server/history.ts", '    if (!info) continue;', ''],
  ["guard-readtail-start-calc", "server/history.ts", 'const start = Math.max(0, size - maxBytes);', 'const start = 0;'],
  ["guard-readtail-truncated-flag", "server/history.ts", 'truncated: start > 0, totalBytes: size };', 'truncated: false, totalBytes: size };'],
  ["guard-runner-exit-marker", "server/runner.ts", "      appendLog(formatExitMarker(status, code));\n", ""],
  // ---- an unconfirmed kill must never be treated as a confirmed one (server/
  // runner.ts's reportUnconfirmedKill, the P1 fix replacing the old
  // forceIdle): the seat must stay tracked and killable, not silently
  // dropped from `running` on a guess. Proven through the real runSeat +
  // killSeat call site in test/runner-*.test.ts and test/round2-*.test.ts, never
  // the helper in isolation. ----
  ["guard-unconfirmed-kill-no-delete", "server/runner.ts", "  if (!ownsRun(runId, entry)) return;\n  entry.unconfirmed = true;", "  if (!ownsRun(runId, entry)) return;\n  running.delete(runId);\n  entry.unconfirmed = true;"],
  // Item 3 (P1): any real output at all disqualifies an auto-relaunch, not
  // just output above some old byte threshold -- see test/stall.test.ts's
  // "MONEY GUARD 3" tests and test/round2-*.test.ts's call-site version.
  ["guard-stall-content-threshold-zero", "server/stall.ts", "export const STALL_CONTENT_THRESHOLD_BYTES = 0;", "export const STALL_CONTENT_THRESHOLD_BYTES = 2048;"],
  // Guard 1: a claude worker's command must carry the flags that make
  // per-turn usage/cost/context/rate-limit numbers available at all.
  ["guard-agentusage-stream-json-flags","server/runner.ts","${advisor} ${mode}${crew} --output-format stream-json --verbose`;","${advisor} ${mode}${crew}`;"],
  // A real bug found by hand during manual verification: onUsage's full state
  // broadcast must never fire before this event's own text has been appended
  // to seatOutput, or the broadcast state is one line behind and a later
  // status-only resync can wipe the line that was just shown (see the real
  // "a result line's text lands in seatOutput before its usage broadcast
  // fires" test in test/round2-*.test.ts).
  ["guard-agentusage-text-before-usage-broadcast","server/runner.ts","      if (event.text) emit(event.text, outHider);\n      if (event.usage) cb.onUsage?.(run, event.usage);","      if (event.usage) cb.onUsage?.(run, event.usage);\n      if (event.text) emit(event.text, outHider);"],
  // Guard 2 (call site): removing the onUsage/onRateLimit forwarding from the
  // tee must turn the real runSeat-driven suite red, not just a pure-parser test.
  ["guard-agentusage-onusage-claude-wiring", "server/runner.ts", "      if (event.usage) cb.onUsage?.(run, event.usage);\n", ""],
  ["guard-agentusage-onusage-codex-wiring", "server/runner.ts", "for (const delta of deltas) cb.onUsage?.(run, delta);", "for (const delta of deltas) void delta;"],
  ["guard-agentusage-onratelimit-wiring", "server/runner.ts", 'if (event.rateLimit) cb.onRateLimit?.(event.rateLimit);', ''],
  // Guard 3: a JSON object split across two chunks must be parsed exactly
  // once, from the reassembled whole line -- dropping the append silently
  // truncates whatever was held from the previous chunk.
  ["guard-agentusage-claude-buffer-append", "server/agent-usage.ts", 'state.buffer += chunk;\n  const events: AgentUsageEvent[] = [];', 'state.buffer = chunk;\n  const events: AgentUsageEvent[] = [];'],
  // Guard 4: the degradation guarantee -- unparseable/unrecognised output must
  // reach the pane verbatim, never silently disappear.
  ["guard-agentusage-claude-passthrough-catch", "server/agent-usage.ts", '} catch {\n    return { text: rawLine + nl }; // degrade to raw text: never dropped, never silent (guard 4)\n  }', '} catch {\n    return { text: "" };\n  }'],
  ["guard-agentusage-claude-flush-return", "server/agent-usage.ts", 'return [parseClaudeLine(state, rawLine, "")];', 'return [];'],
  // Guard 5: thinking blocks and empty system/user noise stay quiet.
  ["guard-agentusage-thinking-suppressed", "server/agent-usage.ts",
    '    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);\n    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);',
    '    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);\n    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);\n    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);'],
  // guard-agentusage-system-suppressed and guard-agentusage-unknown-event-passthrough
  // (below, in the P2 fix 3 block) together replace the old single "default
  // case hides everything" guard, now that the default case is a known-noise
  // allow-list rather than a blanket hide.
  // Guard 6: codex's only instrument -- the thousands separator must be
  // stripped, and the marker line must actually arm the flag that makes the
  // following line count as the number.
  ["guard-agentusage-codex-comma-strip", "server/agent-usage.ts", 'const digits = trimmedLine.replace(/,/g, "");', 'const digits = trimmedLine;'],
  ["guard-agentusage-codex-pending-flag-set", "server/agent-usage.ts", 'if (trimmedLine === "tokens used") state.codexPendingTokens = true;', 'if (false) state.codexPendingTokens = true;'],
  ["guard-agentusage-codex-flush-leftover", "server/agent-usage.ts", 'return state.codexHeldTokens ? [state.codexHeldTokens] : [];', 'return [];'],
  // P2 fix 4: a codex match must be HELD, never surfaced the moment it's
  // found mid-stream -- only flushCodexTokens (process close) may report a
  // delta, so a later real footer always overwrites an earlier one printed
  // as part of the agent's own prose.
  ["guard-agentusage-codex-hold-not-immediate", "server/agent-usage.ts",
    '    const delta = codexLineTokens(state, rawLine.trim());\n    if (delta) state.codexHeldTokens = delta;\n  }\n  return [];\n}',
    '    const delta = codexLineTokens(state, rawLine.trim());\n    if (delta) return [delta];\n  }\n  return [];\n}'],
  // P1 fix 1: codex's token footer is on stderr, not stdout -- the scan call
  // site itself, both the live-stream one and the close-time tail one.
  ["guard-agentusage-codex-stderr-scan-wiring", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));', ''],
  ["guard-round2-codex-stderrtail-scan-wiring", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));', ''],
  ["guard-agentusage-codex-flush-call-site", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(flushCodexTokens(codexState));', ''],
  // Known-quiet lifecycle events (init, thinking_tokens, hook_started, a
  // successful hook_response) stay quiet; anything else still gets a short line.
  ["guard-round2-system-suppressed", "server/agent-usage.ts", 'if (isSilentSystemEvent(subtype, parsed)) return { text: "" };', 'if (false) return { text: "" };'],
  ["guard-agentusage-hook-started-silent", "server/agent-usage.ts", 'new Set(["init", "thinking_tokens", "hook_started"]);', 'new Set(["init", "thinking_tokens"]);'],
  ["guard-agentusage-unknown-event-passthrough", "server/agent-usage.ts", 'return KNOWN_NOISE_TYPES.has(parsed.type) ? { text: "" } : { text: rawLine + nl };', 'return { text: "" };'],
  // P2 fix 3: a "result" with is_error but no result string must still say
  // so, not vanish the way an ordinary empty result does.
  ["guard-agentusage-error-result-fallback", "server/agent-usage.ts",
    'if (parsed.is_error) {\n        // No result string, but the run genuinely failed -- report it rather\n        // than silently dropping it (the same "never hide real output" rule\n        // that governs the KNOWN_NOISE_TYPES allow-list below).\n        const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "unknown error";\n        return { text: `[error] ${subtype}\\n`, usage };\n      }\n      return { text: "", usage };',
    'return { text: "", usage };'],
  // P2 fix 7: the final "result" line must not re-render text the last
  // "assistant" line already showed.
  ["guard-agentusage-result-dedupe", "server/agent-usage.ts", 'if (resultText && resultText === state.lastAssistantText) return { text: "", usage };', ''],
  ["guard-agentusage-lastassistant-capture", "server/agent-usage.ts", 'if (text) state.lastAssistantText = text;', ''],

  // P2 fix 5: a token count with no context window is a real measurement,
  // not "nothing measured" -- it must render as a number, never a dash.
  // Final-review finding 4: codex's number is a cumulative tokens-used total,
  // never context occupancy -- it must never render under the "ctx" label a
  // real percentage uses.

  // P2 fix 6b: the per-run accumulator must accumulate across multiple
  // "result" lines in the same run, never reset to a fresh zeroUsage() on
  // every delta -- caught only by a real call-site test that delivers two
  // results in one run (test/round2-*.test.ts).
  // Guard 8: rate limits are one account-wide slot, updated only by a real event.
  ["guard-agentusage-ratelimit-empty-check", "server/agent-usage.ts", 'return windows.five_hour || windows.seven_day ? windows : undefined;', 'return windows;'],
  // Finding 1: a blank line on codex's stderr must never discard a real held
  // measurement. Reverting to "every line invalidates" reproduces the exact
  // bug proved by test/round2-*.test.ts's blank-line guard.
  ["guard-codex-blank-line-preserves-held-tokens", "server/agent-usage.ts",
    '  // A blank line is stray stdout formatting, never the agent\'s own prose --\n  // it must not discard a real held measurement (proven: a trailing blank\n  // line after the real footer was wiping a correct count before flush).\n  if (trimmedLine === "") return null;\n',
    ''],

  // Finding 3: the close handler's stderrTail branch must actually deliver
  // the decoder's held tail to the log and the pane -- proven through the
  // real runSeat with a fake spawn in test/runner-*.test.ts (an incomplete
  // multi-byte character held by the decoder until close).
  // ---- a retired run's handlers must never act for the run that replaced it
  // on the same seat id (server/runner.ts's ownsSeat): one identity check,
  // used at every handler and terminal path. Each mutation removes ONE call
  // site's check; proven through the real runSeat/killSeat call site in
  // test/runner-*.test.ts's "ownership guard" tests, never the ownsSeat helper
  // in isolation. ----
  ["guard-ownership-stdout-check", "server/runner.ts", "proc.stdout?.on(\"data\", (chunk: Buffer) => {\n    if (!ownsRun(run.runId, entry)) return;", "proc.stdout?.on(\"data\", (chunk: Buffer) => {"],
  ["guard-ownership-stderr-check", "server/runner.ts", "proc.stderr?.on(\"data\", (chunk: Buffer) => {\n    if (!ownsRun(run.runId, entry)) return;", "proc.stderr?.on(\"data\", (chunk: Buffer) => {"],
  ["guard-ownership-close-check", "server/runner.ts", "    if (!ownsRun(run.runId, entry)) return;\n    removeRun(run.runId, entry);", "    removeRun(run.runId, entry);"],
  ["guard-ownership-unconfirmed-kill-check", "server/runner.ts", "  if (!ownsRun(runId, entry)) return;\n  entry.unconfirmed = true;", "  entry.unconfirmed = true;"],
  // ---- packaged data root: a portable build re-extracts to a fresh temp
  // "root" on every launch, so config/logs must resolve through the SAME
  // stable per-user directory (see server/data-root.ts) -- proven at both
  // real call sites, not just the pure resolveDataRoot helper. ----
  ["guard-data-root-config-call-site", "server/config-files.ts",
    'const configDir = join(dataRoot, "config");',
    'const configDir = join(repoRoot, "config");'],
  ["guard-data-root-logs-call-site", "server/runner.ts",
    'export const logsDir = join(resolveDataRoot(process.env, repoRoot), "logs");',
    'export const logsDir = join(repoRoot, "logs");'],
  ["guard-data-root-empty-string-fallback", "server/data-root.ts", 'return dir ? resolve(dir) : repoRoot;', 'return dir ?? repoRoot;'],
  ["guard-config-seed-complete-before-publish", "server/config-files.ts",
    'writeFileSynced(temporaryPath, contents);',
    'writeFileSynced(dest, contents);'],
  ["guard-config-seed-cleanup", "server/config-files.ts",
    'rmSync(temporaryDir, { recursive: true, force: true });', ''],
  ["guard-config-seed-errors", "server/config-files.ts",
    'if (!statSync(dest).isFile()) throw err;', ''],
  // Item 4 (P3, 2026-09-07 review): a cleanup failure after a successful
  // publish (Windows can hold the temp file briefly, e.g. antivirus) must
  // never fail the launch -- only the swallow is allowed to go, the rmSync
  // call itself stays.
  ["guard-config-seed-no-replace", "server/config-files.ts",
    'linkSync(temporaryPath, dest);', 'writeFileSync(dest, readFileSync(temporaryPath));'],
  // Never remove the test-context backstop in a whole-suite mutation. The
  // pure decision is checked with both contexts; forcing protection ON is
  // safely red without ever granting access to an inherited user directory.
  ["guard-datadir-test-context-decision", "server/data-root.ts",
    'if (env.NODE_TEST_CONTEXT === undefined || env.NODE_TEST_CONTEXT === "") return false;\n  return env.CC_TEST_FORCE_PACKAGED === undefined || env.CC_TEST_FORCE_PACKAGED === "";',
    'return true;'],
  // Guard 5: a relative or whitespace-only CC_DATA_DIR must never reach a
  // caller unresolved -- history.ts compares an absolute path, so a relative
  // logsDir would silently reject every valid run.
  ["guard-datadir-trim-whitespace", "server/data-root.ts",
    'const dir = env.CC_DATA_DIR?.trim();', 'const dir = env.CC_DATA_DIR;'],
  ["guard-client-pref-stage-call", "server/config-prefs.ts",
    'return publishConfigFile(JSON.stringify(prefs, null, 2) + "\\n", liveWritePath(path, clientPrefsPath), !onlyIfMissing);',
    'writeFileSync(liveWritePath(path, clientPrefsPath), JSON.stringify(prefs, null, 2) + "\\n", "utf8"); return true;'],
  ["guard-client-pref-atomic-replace", "server/config-files.ts",
    'if (replace) replaceFile(temporaryPath, dest);',
    'if (replace) writeFileSync(dest, readFileSync(temporaryPath));'],
  ["guard-preview-url-protocol-check", "server/config-prefs.ts", "return parsed.protocol === \"http:\" || parsed.protocol === \"https:\";", "return true;"],
  ["guard-preview-url-fallback", "server/config-prefs.ts", "previewUrl: isValidPreviewUrlValue(raw.previewUrl) ? raw.previewUrl : DEFAULT_CLIENT_PREFS.previewUrl,", "previewUrl: typeof raw.previewUrl === \"string\" ? raw.previewUrl : DEFAULT_CLIENT_PREFS.previewUrl,"],
  // server/config.ts: usageStripHeight is retired; rightPanelWidth keeps the positive-number validation.
  ["guard-rightpanelwidth-config-read-clamp", "server/config-prefs.ts",
    "rightPanelWidth: typeof raw.rightPanelWidth === \"number\" && Number.isFinite(raw.rightPanelWidth) && raw.rightPanelWidth > 0 ? raw.rightPanelWidth : DEFAULT_CLIENT_PREFS.rightPanelWidth,",
    "rightPanelWidth: typeof raw.rightPanelWidth === \"number\" ? raw.rightPanelWidth : DEFAULT_CLIENT_PREFS.rightPanelWidth,"],
  ["guard-rightpanelwidth-config-update-validation", "server/config-prefs.ts",
    'if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { ok: false, error: `invalid value for client pref "${key}": expected a positive number` };\n    return { ok: true, prefs: { ...prefs, rightPanelWidth: value } };',
    'if (false) return { ok: false, error: `invalid value for client pref "${key}": expected a positive number` };\n    return { ok: true, prefs: { ...prefs, rightPanelWidth: value } };'],

  // ---- both collapse toggles: solid inline-SVG triangle (never a text
  // chevron glyph), each flipping toward the edge its own click moves things
  // into, and the right panel's toggle sharing #preview-controls with the
  // URL bar instead of floating alone in its own header row ----

  // ---- brand-picker pack: six findings, two P1 ----------------------------
  // Item 1, guard 2: buildCommand is the last gate before shell:true and must
  // validate every interpolated value itself, not trust an upstream caller.
  ["guard-buildcommand-validates-model", "server/runner.ts", "  if (!isValidModel(run.cli, run.model)) throw new Error(`buildCommand: refusing invalid model for \"${run.seatKey}\": ${run.model}`);\n", ""],
  ["guard-buildcommand-validates-effort", "server/runner.ts", "  if (!isValidEffort(run.cli, run.effort)) throw new Error(`buildCommand: refusing invalid effort for \"${run.seatKey}\": ${run.effort}`);\n", ""],
  // Item 1, layer 3: discovery output is untrusted -- a line that doesn't
  // look like a real "provider/model" id must never survive into the
  // suggestion list the seat-kind cascade assigns from unvalidated.
  ["guard-opencode-discovery-line-pattern", "server/cli-discovery.ts",
    'const OPENCODE_MODEL_LINE_PATTERN = /^[A-Za-z0-9._-]+\\/[A-Za-z0-9._/-]+$/;',
    'const OPENCODE_MODEL_LINE_PATTERN = /^[A-Za-z0-9._/-]+$/;'],
  // Item 2, guard 3: each CLI's read-only role must genuinely be unable to
  // write via a shell command -- live-verified per CLI (see runner.ts's own
  // comments). Dropping any one of these three reproduces exactly the
  // boundary that failed live before the fix.
  ["guard-claude-readonly-disallowed-tools", "server/runner.ts",
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";',
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --permission-prompts none";'],
  ["guard-opencode-reviewer-deny-bash", "server/runner-crew.ts", "permission: { edit: \"deny\", bash: \"deny\" } }", "permission: { edit: \"deny\" } }"],
  // Item 3, guard 4: the cascade must produce a model that is actually valid
  // for the TARGET kind -- opencode requires a "provider_id/model_id" shape,
  // not just a safe character set.
  ["guard-opencode-model-requires-slash","server/process-types.ts","customModel: \"^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$\" }","customModel: \"^[A-Za-z0-9._/-]+$\" }"],

  // Item 4, guard 5: an existing install's roster migrates forward -- a new
  // cast member is added, a relabeled role lands, a retired seat is dropped,
  // and the user's own kind/model/effort survive untouched. Each mutation
  // targets one of those independently.
  // Item 5, guard: discovery must never block the event loop -- a hung CLI
  // must be killed and degrade to the fallback, not hold the caller open.
  ["guard-discovery-timeout-kills","server/cli-discovery.ts","const killer = spawnFn(windowsTaskkillPath(), [\"/pid\", String(proc.pid), \"/T\", \"/F\"], { windowsHide: true });","const killer = proc; proc.kill();"],
  ["guard-discovery-timeout-tree", "server/cli-discovery.ts",
    'String(proc.pid), "/T", "/F"', 'String(proc.pid), "/F"'],
  ["guard-discovery-timeout-force", "server/cli-discovery.ts",
    'String(proc.pid), "/T", "/F"', 'String(proc.pid), "/T"'],
  ["guard-discovery-timeout-pid", "server/cli-discovery.ts",
    'String(proc.pid), "/T", "/F"', '"0", "/T", "/F"'],
  ["guard-discovery-concurrent", "server/config.ts",
    'const [claudeEffort, opencodeModels, claudeModels] = await Promise.all([\n    discoverEffort(FALLBACK_CLAUDE_EFFORT),\n    discoverModels(OPENCODE_MODEL_SUGGESTIONS_FALLBACK),\n    discoverModelsForClaude(FALLBACK_CLAUDE_MODELS, claudeCliPath),\n  ]);',
    'const claudeEffort = await discoverEffort(FALLBACK_CLAUDE_EFFORT);\n  const opencodeModels = await discoverModels(OPENCODE_MODEL_SUGGESTIONS_FALLBACK);\n  const claudeModels = await discoverModelsForClaude(FALLBACK_CLAUDE_MODELS, claudeCliPath);'],
  // ---- model pickers (2026-09-09): claude's list is discovered via the SDK's
  // Query.supportedModels(), codex's derives from the same opencode catalogue
  // OPENCODE_MODEL_SUGGESTIONS already uses -- see the brief: "the model
  // pickers are incomplete. Ask the tools, do not type the list." ----
  ["guard-claude-models-source", "server/config.ts", "const discovered = claudeModels.fallback ? FALLBACK_CLAUDE_MODELS : claudeModels.values;", "const discovered = FALLBACK_CLAUDE_MODELS;"],
  ["guard-claude-models-preserve-current", "server/config.ts", "if (!merged.some((item) => item.value === value)) merged.push({ value, displayName: value, supportsEffort: true });", "void value;"],
  ["guard-claude-fable-present", "server/config.ts",
    '{ value: "claude-fable-5-1[1m]", displayName: "Fable", supportsEffort: false },\n',
    ''],
  ["guard-codex-luna-present","server/config.ts","const CODEX_BASELINE_MODELS = [\"gpt-6-luna\", \"gpt-6-sol\", \"gpt-6-astra\", \"gpt-6.1-sol\"];","const CODEX_BASELINE_MODELS = [\"gpt-6-sol\", \"gpt-6-astra\", \"gpt-6.1-sol\"];"],
  ["guard-codex-derive-from-opencode", "server/config.ts", "if (isSafeShape(id) && !BASE.codexModels.includes(id)) BASE.codexModels.push(id);", ""],
  // ---- Atlas knows the crew and can put them to work: leader-tools.ts's
  // pure crew snapshot, and index.ts's leaderLaunchSeat wrapper -- the ONE
  // path Atlas's own launch_seat MCP tool is allowed to reach. ----
  ["guard-leader-crew-live-status", "server/leader-tools.ts", "status: deps.statusOf(seat.seatKey),", "status: \"idle\","],
  ["guard-crew-status-marks-leader-not-runnable","server/leader-tools.ts","runnable: (!seat.isLeader || deps.leaderTakesJobs === true) && seat.slot !== deps.callerSlot","runnable: seat.slot !== deps.callerSlot"],
  // ---- the roster must never go stale mid-conversation (guard from the
  // "Atlas knows the crew" brief): a launch that runs against a seat whose
  // config changed since the leader's last get_crew_status call says so. ----
  ["guard-launch-notes-config-drift", "server/leader-tools.ts", "const changed = live && before && (before.model !== live.model || before.effort !== live.effort || before.cli !== live.cli);", "const changed = false;"],
  ["guard-kill-unconfirmed-setter", "server/runner.ts", "entry.unconfirmed = true;", ""],
  ["guard-kill-unconfirmed-callback", "server/runner.ts", "  entry.cb.onUnconfirmedKill?.(entry.run, entry.proc.pid);\n", ""],
  ["guard-packc-test-cli-runner-env-gate", "server/test-cli-runner.ts", 'if (env.CC_TEST_FAKE_CLI !== "1") return undefined;', 'if (false) return undefined;'],
  ["guard-packc-r1-git-no-optional-locks","server/changes.ts","\"--no-optional-locks\", \"-C\", folder, \"status\", \"--porcelain=v1\", \"-z\", \"-b\", \"--no-renames\"","\"-C\", folder, \"status\", \"--porcelain=v1\", \"-z\", \"-b\", \"--no-renames\""],
  ["guard-packc-r1-requests-pending-cap", "server/requests.ts", '.length >= MAX_PENDING_PER_SOURCE) {', '.length >= Infinity) {'],
  ["guard-packc-r1-requests-resolved-trim", "server/requests.ts", 'Math.max(0, resolved.length - MAX_RESOLVED_KEPT)', '0'],
  ["guard-packc-r7-launch-tool-awaits", "server/leader-tools.ts", 'const result = await deps.launch(slot, brief);', 'const result = deps.launch(slot, brief) as LaunchResult;'],
  ["guard-topbar-srv-sound-update-clears-on-notifications-off","server/config-prefs.ts","    return { ok: true, prefs: { ...prefs, [key]: value } };\n  }\n  if (key === \"rightPanelWidth\") {","    return { ok: true, prefs: { ...prefs, [key]: value, ...(key === \"notificationsEnabled\" && !value ? { bellEnabled: false } : {}) } };\n  }\n  if (key === \"rightPanelWidth\") {"],
  ["guard-topbar-srv-sound-refused-when-notifications-off","server/config-prefs.ts","    return { ok: true, prefs: { ...prefs, [key]: value } };\n  }\n  if (key === \"rightPanelWidth\") {","    if (key === \"bellEnabled\" && value && !prefs.notificationsEnabled) return { ok: false, error: \"cannot enable the bell while notifications are off\" };\n    return { ok: true, prefs: { ...prefs, [key]: value } };\n  }\n  if (key === \"rightPanelWidth\") {"],
  ["guard-topbar-srv-sound-read-clamp","server/config-prefs.ts","bellEnabled: typeof raw.bellEnabled === \"boolean\" ? raw.bellEnabled : DEFAULT_CLIENT_PREFS.bellEnabled,","bellEnabled: raw.notificationsEnabled !== false && typeof raw.bellEnabled === \"boolean\" ? raw.bellEnabled : DEFAULT_CLIENT_PREFS.bellEnabled,"],
  ["guard-topbar-srv-sound-default-off","server/config-prefs.ts","bellEnabled: false, bellVolume: 100, previewUrl","bellEnabled: true, bellVolume: 100, previewUrl"],
  ["guard-topbar-srv-sound-key-accepted","server/config-prefs.ts","key === \"bellEnabled\" || key === \"crewRailOpen\" || key === \"detailsOpen\") {","key === \"crewRailOpen\" || key === \"detailsOpen\") {"],
  ["guard-topbar-srv-theme-update-validate","server/config-prefs.ts","    if (!isTheme(value)) return {","    if (false) return {"],
  ["guard-topbar-srv-theme-read-validate","server/config-prefs.ts","theme: isTheme(raw.theme) ? raw.theme : DEFAULT_CLIENT_PREFS.theme,","theme: raw.theme as ClientPrefs[\"theme\"],"],
  ["guard-topbar-srv-theme-setter","server/config-prefs.ts","return { ok: true, prefs: { ...prefs, theme: value } };","return { ok: true, prefs };"],
  ["guard-topbar-srv-theme-default","server/config-prefs.ts","  theme: \"light\", avatar: \"ash.svg\", dismissedRuns: [],","  theme: \"dark\", avatar: \"ash.svg\", dismissedRuns: [],"],
  ["guard-topbar-srv-avatar-default","server/config-prefs.ts","  theme: \"light\", avatar: \"ash.svg\", dismissedRuns: [],","  theme: \"light\", avatar: \"momo.svg\", dismissedRuns: [],"],
  ["guard-topbar-srv-avatar-update-validate","server/config-prefs.ts","    if (!isAvatar(value)) return { ok: false, error: typeof value","    if (false) return { ok: false, error: typeof value"],
  ["guard-topbar-srv-avatar-read-validate","server/config-prefs.ts","avatar: isAvatar(raw.avatar) ? raw.avatar : DEFAULT_CLIENT_PREFS.avatar,","avatar: raw.avatar as string,"],
  ["guard-topbar-srv-avatar-setter","server/config-prefs.ts","return { ok: true, prefs: { ...prefs, avatar: value } };","return { ok: true, prefs };"],
  ["guard-topbar-srv-avatar-cap-removed","server/config-prefs.ts","(/^data:image\\//.test(value) && value.length <= AVATAR_MAX_CHARS)","/^data:image\\//.test(value)"],
  ["guard-topbar-srv-avatar-cap-boundary","server/config-prefs.ts","value.length <= AVATAR_MAX_CHARS","value.length < AVATAR_MAX_CHARS"],
  ["guard-topbar-srv-avatar-preset-regex","server/config-prefs.ts","/^[a-z]+\\.svg$/.test(value)","/\\.svg$/.test(value)"],
  ["guard-topbar-srv-avatar-data-prefix","server/config-prefs.ts","/^data:image\\//.test(value) &&","/^data:/.test(value) &&"],
  ["guard-topbar-srv-dismissed-update-validate","server/config-prefs.ts","    if (!isDismissedRuns(value)) return {","    if (false) return {"],
  ["guard-topbar-srv-dismissed-read-validate","server/config-prefs.ts","dismissedRuns: isDismissedRuns(raw.dismissedRuns) ? [...raw.dismissedRuns] : [],","dismissedRuns: raw.dismissedRuns as string[],"],
  ["guard-topbar-srv-dismissed-setter","server/config-prefs.ts","dismissedRuns: [...value] } };","dismissedRuns: prefs.dismissedRuns } };"],
  ["guard-topbar-srv-dismissed-max-removed","server/config-prefs.ts","value.length <= DISMISSED_RUNS_MAX &&",""],
  ["guard-topbar-srv-dismissed-max-boundary","server/config-prefs.ts","value.length <= DISMISSED_RUNS_MAX","value.length < DISMISSED_RUNS_MAX"],
  ["guard-topbar-srv-dismissed-element-type","server/config-prefs.ts","typeof id === \"string\" && id.length > 0","id.length > 0"],
  ["guard-topbar-srv-dismissed-element-nonempty","server/config-prefs.ts","id.length > 0 &&",""],
  ["guard-topbar-srv-dismissed-id-length","server/config-prefs.ts","&& id.length <= 200)","&& true)"],
  // ---- run G: the sound popover. -snd-pop-srv- client-prefs.test.ts; -snd-pop-pg- browser-*.test.ts with CC_BROWSER_PHASES=b2. ----
  ["guard-topbar-snd-pop-srv-read-validate","server/config-prefs.ts","bellVolume: isBellVolume(raw.bellVolume) ? raw.bellVolume : DEFAULT_CLIENT_PREFS.bellVolume,","bellVolume: raw.bellVolume as number,"],
  ["guard-topbar-snd-pop-srv-read-kept","server/config-prefs.ts","bellVolume: isBellVolume(raw.bellVolume) ? raw.bellVolume : DEFAULT_CLIENT_PREFS.bellVolume,","bellVolume: DEFAULT_CLIENT_PREFS.bellVolume,"],
  ["guard-topbar-snd-pop-srv-update-validate","server/config-prefs.ts","    if (!isBellVolume(value)) return {","    if (false) return {"],
  ["guard-topbar-snd-pop-srv-whole-percent","server/config-prefs.ts","return Number.isInteger(value) && (value as number) >= 0","return typeof value === \"number\" && (value as number) >= 0"],
  ["guard-topbar-snd-pop-srv-range","server/config-prefs.ts","(value as number) >= 0 && (value as number) <= 100;","(value as number) >= -1 && (value as number) <= 101;"],
  ["guard-topbar-snd-pop-srv-default-100","server/config-prefs.ts","bellEnabled: false, bellVolume: 100, previewUrl","bellEnabled: false, bellVolume: 50, previewUrl"],
  ["guard-topbar-snd-pop-srv-key-accepted","server/config-prefs.ts","  if (key === \"bellVolume\") {","  if (key === \"bell-volume\") {"],
  ["guard-topbar-snd-pop-srv-setter","server/config-prefs.ts","return { ok: true, prefs: { ...prefs, bellVolume: value } };","return { ok: true, prefs };"],
  ["guard-pack2-runner-leftover-cleanup-at-run-end","server/runner.ts","const swept = watch.sweep(entry.exitedAt ?? Date.now()).then((killed) => {","const swept = Promise.resolve(0).then((killed) => {"],
  ["guard-pack2-damaged-chat-opens-empty","server/chat-store.ts","    catch { return { messages: [], revision: 0, savedRevision: 0 }; }","    catch (err) { throw err; }"],
  ["guard-pack2-damaged-chat-clear-sets-file-aside","server/chat-store.ts","    keepBadCopy(path);\n    unlinkSync(path);\n","    return false;\n"],
  ["guard-pack2-r1-runner-unchecked-cleanup-says-so", "server/runner.ts", "if (killed === null) return unchecked();\n", "if (killed === null) return;\n"],
  ["guard-runner-stderr-tail-logged","server/runner.ts","    if (shown) { appendLog(shown); cb.onOutput(run, shown); }","    if (shown) { cb.onOutput(run, shown); }"],
  ["guard-dismissed-runs-201-retained","server/config-prefs.ts","return { ok: true, prefs: { ...prefs, dismissedRuns: [...value] } };","return { ok: true, prefs: { ...prefs, dismissedRuns: value.length === 201 ? [] : [...value] } };"],
  ["guard-runner-stdouttail-log-and-output","server/runner.ts","      else emit(stdoutTail, outHider);\n","      else { void stdoutTail; }\n"],
  ["guard-runner-stderrtail-log-and-output","server/runner.ts","      emit(stderrTail, errHider);\n      if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));","      if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));"],
  ["guard-killrun-no-pid-refused", "server/runner.ts", "if (!entry || !entry.proc.pid) return false;", "if (!entry) return false;\n  if (!entry.proc.pid) return true;"],
  ["disk-seat-id-control-char","server/process-types.ts","    if (code < 0x20 || code === 0x7f) return false;\n",""],
  ["seat-id", "server/config.ts", "if (!isObject(project) || !validSlug(project.id) ||", "if (!isObject(project) ||"],
  ["guard-config-seed-cleanup-failure-swallowed", "server/config-files.ts", "    try { rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* the published file is already complete */ }", "    rmSync(temporaryDir, { recursive: true, force: true });"],
  ["guard-pack6-cleanup-failure-said", "server/runner.ts", '      if (failed > 0) say(failed, "could not stop");', ""],
  ["guard-pack6-codex-kill-failure-remembered", "server/leader-codex.ts", "  const unconfirmedKill = (): void => { const said = killFailed; killFailed = true;", "  const unconfirmedKill = (): void => { const said = killFailed;"],
  ["guard-pack6-log-failure-said", "server/runner.ts", "      if (logFailed) return;", "      return;"],
  ["guard-pack6-chat-append-failure-marks-line-open", "server/chat-store.ts", "catch (err) { this.unterminated.add(line.tabId); throw err; }", "catch (err) { throw err; }"],
  ["guard-pack6-handover-per-tab", "server/changes.ts", 'return join(folder, ".command-center", tabId, "RESUME.md");', 'return join(folder, ".command-center", "RESUME.md");'],
  ["guard-pack6-handover-shared-fallback", "server/changes.ts", "for (const candidate of [handoverPath(folder, tabId), legacyHandoverPath(folder)]) {", "for (const candidate of [handoverPath(folder, tabId)]) {"],
  ["guard-pack6-cleanup-failure-in-saved-log", "server/runner.ts", "this run left running\\n`; appendLog(message); cb.onOutput(run, message); };", "this run left running\\n`; cb.onOutput(run, message); };"],
  ["guard-pack6-codex-sweep-failure-callback", "server/leader-codex.ts", "trackLeaderChild(child, watchesLeaderChild(deps.spawnFn), () => unconfirmedKill());", "trackLeaderChild(child, watchesLeaderChild(deps.spawnFn));"],
  ["guard-pack6-r3-codex-kill-notice-once", "server/leader-codex.ts", "if (!said) cb.onNotice?.(", "cb.onNotice?.("],
  // Pack 8 round 1: each `to` reintroduces the reviewed bug. -- export-public.test.ts, workspaces.test.ts ----
  ["guard-pack8-r1-migrate-slash-svg","server/config.ts"," || seat.pic === `/avatars/${LEGACY_LEADER}.svg`",""],
  ["guard-pack8-r1-migrate-slash-photo","server/config.ts",String.raw`seat.pic.match(/^\/?avatars\/`,String.raw`seat.pic.match(/^avatars\/`],
  ["guard-pack9-own-id-excluded","server/folder-activity.ts","  if (own.ids.has(seen.sessionKey)) return true;\n",""],
  ["guard-pack9-own-window-folder","server/folder-activity.ts","seen.touches(window.folder)) return true;","true) return true;"],
  ["guard-pack9-own-window-end","server/folder-activity.ts","&& at <= end + OWN_SLACK_MS;","; "],
  ["guard-pack9-own-window-start","server/folder-activity.ts","(at: number) => at >= window.start - 1000 && ","(at: number) => "],
  ["guard-pack9-reader-isolation","server/folder-activity.ts","    try { seen.push(...read(home, tabFolder, now)); } catch { /* skipped: never blocks a message */ }","    seen.push(...read(home, tabFolder, now));"],
  ["guard-pack9-folder-prefix-lookalike","server/folder-activity.ts","return x === y || y.startsWith(withSlash(x)) || x.startsWith(withSlash(y));","return x === y || y.startsWith(x) || x.startsWith(y);"],
  ["guard-pack9-claude-slug-parent","server/folder-activity.ts","return a === b || b.startsWith(withDash(a)) || a.startsWith(withDash(b));","return a === b || b.startsWith(withDash(a));"],
  ["guard-pack9-claude-top-level-only","server/folder-activity.ts","if (!name.endsWith(\".jsonl\")) continue;","if (false) continue;"],
  ["guard-pack9-claude-two-minute-window","server/folder-activity.ts","      if (now - mtime > ACTIVE_WINDOW_MS) continue;\n      found.push({ tool: \"Claude Code\"","      found.push({ tool: \"Claude Code\""],
  ["guard-pack9-codex-two-minute-window","server/folder-activity.ts","      if (now - mtime > ACTIVE_WINDOW_MS) continue;\n      const line = firstLine(path);","      const line = firstLine(path);"],
  ["guard-pack9-codex-old-day-folders","server/folder-activity.ts","  candidates.push(...freshOldRollouts(sessions, recent, now));\n",""],
  ["guard-pack9-codex-old-scan-interval","server/folder-activity.ts","if (cached && Math.abs(now - cached.at) < OLD_SCAN_MS) return cached.paths;","if (cached) return cached.paths;"],
  ["guard-pack9-opencode-two-minute-window","server/folder-activity.ts","time_created from session where time_updated >= ?\").all(now - ACTIVE_WINDOW_MS)","time_created from session where time_updated >= ?\").all(0)"],
  ["guard-pack9-codex-local-date","server/folder-activity.ts","pad(day.getMonth() + 1), pad(day.getDate())","pad(day.getMonth() + 1), pad(day.getUTCDate())"],
  ["guard-pack9-codex-yesterday","server/folder-activity.ts","for (const back of [0, 1])","for (const back of [0])"],
  ["guard-pack9-codex-long-first-line","server/folder-activity.ts","chunks.push(buffer.subarray(0, read)); total += read; position += read;","return null;"],
  ["guard-pack9-own-keep-window","server/folder-activity.ts","const OWN_KEEP_MS = 10 * 60_000;","const OWN_KEEP_MS = 10 * 60_000 * 1000;"],
  ["guard-pack9-own-id-keep","server/folder-activity.ts","const OWN_ID_KEEP_MS = 7 * 24 * 60 * 60_000;","const OWN_ID_KEEP_MS = 10 * 60_000;"],
  ["guard-pack9-persist-windows","server/folder-activity.ts","windows: [...own.windows.values()].map((window) => ({ ...window, end: window.end ?? at }))","windows: []"],
  ["guard-pack9-persist-ids","server/folder-activity.ts","ids: Object.fromEntries(own.ids), ","ids: {}, "],
  ["guard-pack9-snooze-set","server/folder-activity.ts","snoozed.set(slot(tabId, key), clock() + SNOOZE_MS)","snoozed.set(slot(tabId, key), 0)"],
  ["guard-pack9-snooze-expiry","server/folder-activity.ts","(map.get(slot(tabId, key)) ?? 0) > clock()","(map.get(slot(tabId, key)) ?? 0) > 0"],
  ["guard-pack9-announce-once","server/folder-activity.ts","    for (const item of fresh) noticed.set(slot(tabId, item.sessionKey), clock() + SNOOZE_MS);\n",""],
  ["guard-pack9-ignore-node-modules","server/folder-activity.ts","(\\.git|node_modules|\\.command-center)","(\\.git|\\.command-center)"],
  ["guard-pack9-ignore-git","server/folder-activity.ts","(\\.git|node_modules|\\.command-center)","(node_modules|\\.command-center)"],
  ["guard-pack9-change-folder-relation","server/folder-activity.ts","at <= end + OWN_SLACK_MS && relatedFolders(window.folder, folder)) return true;","at <= end + OWN_SLACK_MS) return true;"],
  ["guard-pack9-change-late-flush-slack","server/folder-activity.ts","at <= end + OWN_SLACK_MS &&","at <= end &&"],
  ["guard-pack9-watcher-unref","server/folder-activity.ts","const watcher = watch(folder, { recursive: true, persistent: false }, onChange); watcher.unref();","const watcher = watch(folder, { recursive: true }, onChange);"],
  ["guard-pack9-close-watcher-forgets-folder","server/folder-activity.ts","    watchers.delete(key); lastChange.delete(key);","    lastChange.delete(key);"],
  ["guard-pack9-close-watcher-forgets-changes","server/folder-activity.ts","    watchers.delete(key); lastChange.delete(key);","    watchers.delete(key);"],
  ["guard-pack9-ignore-data-root","server/folder-activity.ts","      if (name && writtenByApp(join(folder, String(name)), options.dataRoot)) return;\n",""],
  ["guard-pack9-ignore-only-app-files","server/folder-activity.ts","  if (!within(path, dataRoot)) return false;\n","  if (within(path, dataRoot)) return true;\n  if (!within(path, dataRoot)) return false;\n"],
  ["guard-pack9-watch-list-sync","server/folder-activity.ts","    for (const key of [...watchers.keys()]) if (!wanted.has(key)) closeWatcher(key);\n",""],
  ["guard-pack9-drive-root-skipped","server/folder-activity.ts","if (watchers.has(key) || dirname(folder) === folder) return;","if (watchers.has(key)) return;"],
  ["guard-pack9-own-record-created-inside-window","server/folder-activity.ts","(seen.startedAt === null || inside(seen.startedAt)) && ","true && "],
  ["guard-pack9-claude-record-start","server/folder-activity.ts","startedAt: birth > 0 ? birth : null,","startedAt: null,"],
  ["guard-pack9-codex-record-start","server/folder-activity.ts","startedAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : Number.isFinite(stamp) ? stamp : null,","startedAt: null,"],
  ["guard-pack9-opencode-record-start","server/folder-activity.ts","startedAt: typeof row.time_created === \"number\" ? row.time_created : null,","startedAt: null,"],
  ["guard-pack9-codex-leader-session","server/leader-codex.ts","    cb.onSession?.(threadId);\n",""],
  ["guard-pack9-notice-role-known","server/chat-store.ts","const ROLES = new Set([\"user\", \"assistant\", \"notice\"]);","const ROLES = new Set([\"user\", \"assistant\"]);"],
  ["guard-pack9-unknown-role-skipped","server/chat-store.ts","      if (entry.type === \"message\" && typeof entry.role === \"string\" && !ROLES.has(entry.role)) { torn.push(index + 1); continue; }\n",""],
  ["guard-pack9-restore-unknown-role-skipped","server/chat-store.ts","const known = Array.isArray(entry.messages) ? entry.messages.filter((message) => !(message && typeof message.role === \"string\" && !ROLES.has(message.role))) : entry.messages;","const known = entry.messages;"],
  ["guard-pack9-writer-pending-includes","server/folder-activity.ts","return [...outside(folder), ...writers].filter(","return [...outside(folder)].filter("],
  ["guard-pack9-codex-session-refresh-turn-start","server/leader-codex.ts","    turnOpen = true;\n    reportThread();\n","    turnOpen = true;\n"],
  ["guard-pack9-codex-session-refresh-notification","server/leader-codex.ts","    if (turnOpen) reportThread();\n",""],
  // Pack 12: steer in chat. Server and adapters (test/pack12-server-*.test.ts).
  ["guard-pack12-codex-steer-uses-send","server/leader-codex.ts","if (turnId === null) steerHeld.push({ text, images }); else sendSteer(text, images, turnId);","send(text, images);"],
  ["guard-pack12-codex-held-steer-setter","server/leader-codex.ts","if (turnId === null) steerHeld.push({ text, images }); else sendSteer(text, images, turnId);","if (turnId === null) void 0; else sendSteer(text, images, turnId);"],
  ["guard-pack12-codex-held-steer-flush","server/leader-codex.ts","    for (const waiting of steerHeld.splice(0)) sendSteer(waiting.text, waiting.images, id);\n",""],
  ["guard-pack12-codex-missed-handed-back","server/leader-codex.ts","      cb.onSteerMissed?.(text, images);\n",""],
  ["guard-pack13-existing-file-overwritten","server/project-rules.ts","    const found = existing(path);\n    if (found) return found;\n    try { writeFileSynced(path, rulesText(projectName, folder)); }","    try { process.getBuiltinModule(\"node:fs\").writeFileSync(path, rulesText(projectName, folder)); }"],
  ["guard-pack13-name-not-cleaned","server/project-rules.ts","name.replace(/[\\u0000-\\u001f\\u007f-\\u009f]+/g, \" \").replace(/\\s+/g, \" \").trim()","name.trim()"],
  ["guard-pack14-codex-glue-item-key","server/leader-codex.ts","paragraphs.text(params.delta, String(params.itemId ?? \"\"))","paragraphs.text(params.delta, \"\")"],
  ["guard-pack14-codex-label-reads-command","server/leader-codex.ts","        return make(ACTIVITY.command);\n","        return make(`Running ${item.command}`);\n"],
  ["guard-pack14-codex-read-action","server/leader-codex.ts","kinds.every((kind: string) => kind === \"read\")","false"],
  ["guard-pack14-codex-list-action","server/leader-codex.ts","kinds.every((kind: string) => /^(list|search)/i.test(kind))","false"],
  ["guard-pack14-codex-step-end","server/leader-codex.ts","    if (!started) activity.end(id);\n","    if (!started) void 0;\n"],
  ["guard-pack14-codex-dynamic-tool-shown","server/leader-codex.ts","      case \"dynamicToolCall\": return null;\n","      case \"dynamicToolCall\": return make(ACTIVITY.tool);\n"],
  ["guard-pack14-codex-reset-at-send","server/leader-codex.ts","    activity.reset(); paragraphs.reset();\n","    paragraphs.reset();\n"],
  ["guard-pack14-codex-quiet-on-answer","server/leader-codex.ts","    else if (type === \"agentMessage\") activity.quiet();\n","    else if (type === \"agentMessage\") void 0;\n"],
  ["guard-pack15-sweep-wait-covers-list-and-kill","server/runner.ts","const SWEEP_WAIT_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;","const SWEEP_WAIT_MS = 4000;"],
  ["guard-pack15-sweep-wait-call-site","server/runner.ts","setTimeout(resolveBound, SWEEP_WAIT_MS)","setTimeout(resolveBound, 4000)"],
  ["guard-pack15-unreadable-list-says-unchecked","server/runner.ts","if (killed === null) return unchecked();",""],
  ["guard-pack17-adapter-mode-bypass-only","server/leader-acp.ts","mode === \"bypass\"),","true),"],
  ["guard-pack17-session-at-start","server/leader-acp.ts","    cb.onSession?.(sessionId);\n    const modelOption","    const modelOption"],
  ["guard-pack17-session-at-turn-end","server/leader-acp.ts","      cb.onSession?.(sessionId!);\n",""],
  ["guard-pack17-permission-rejected-in-bypass","server/leader-acp.ts","write({ id, result: { outcome: { outcome: \"selected\", optionId: pick.optionId } } }); return; }","write({ id, result: { outcome: { outcome: \"cancelled\" } } }); return; }"],
  ["guard-pack17-token-not-hidden","server/leader-acp.ts","const redact = (text: string): string => (secret ? text.split(secret).join(HIDDEN) : text);","const redact = (text: string): string => text;"],
  ["guard-pack17-steer-takes-message","server/leader-acp.ts","steer: () => false,","steer: () => true,"],
  ["guard-pack17-stop-no-cancel","server/leader-acp.ts","    if (sessionId) write({ method: \"session/cancel\", params: { sessionId } });\n",""],
  ["guard-pack17-step-from-title","server/leader-acp.ts","activity.start(id, acpToolStep(update.kind))","activity.start(id, { label: String(update.title), helper: false })"],
  ["guard-pack17-model-not-reported","server/leader-acp.ts","if (modelName) cb.onModel?.(modelName); }"," }"],
  ["guard-pack17-http-assumed","server/leader-acp.ts","const http = caps.mcpCapabilities?.http === true;","const http = true;"],
  ["guard-pack17-runner-default","server/runner.ts","    default:\n      throw new Error(`buildCommand: no command for CLI \"${String(run.cli)}\" on \"${run.seatKey}\"`);\n",""],
  ["guard-pack17-shell-chars-allowed","server/config-acp.ts","const ACP_ARG = /^[A-Za-z0-9._:=/@+,-]{1,120}$/;","const ACP_ARG = /^[^\u0000-\u001f]{1,120}$/;"],
  ["guard-pack17-program-path-allowed","server/config-acp.ts","const ACP_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;","const ACP_PROGRAM = /^[^\u0000-\u001f]{1,64}$/;"],
  ["guard-pack17-model-not-redacted","server/leader-acp.ts","modelName = safe(modelOption.currentValue, 100) || null;","modelName = clean(modelOption.currentValue, 100) || null;"],
  ["guard-pack17-session-id-token","server/leader-acp.ts","if (redact(session.sessionId) !== session.sessionId) throw new Error(`${name} returned an unusable session`);",""],
  ["guard-pack17-line-throw-net","server/leader-acp.ts","if (line) try { onLine(line); } catch { /* skipped */ }","if (line) onLine(line);"],
  ["guard-pack17-line-size-after-parse","server/leader-acp.ts","if (at > maxLine) { buffer = \"\"; die(`${name} sent unreadable data`); return; }",""],
  ["guard-pack17-sweep-bare-decision","server/config.ts","export const ACP_DEFAULT = \"default\";","export const ACP_DEFAULT = \"default\";\nconst bareDecision = (kind: string) => kind === \"codex\";"],
  ["guard-pack17-token-across-paragraph","server/leader-acp.ts","if (spans.some(([s, e]) => s < g.at && g.at < e)) continue;",""],
  ["guard-pack17-stdin-epipe-strands","server/leader-acp.ts","child.stdin?.on(\"error\", gone);","child.stdin?.on(\"error\", () => {});"],
  ["guard-pack17-stdout-eof-strands","server/leader-acp.ts","    child.stdout?.on(\"end\", gone); child.stdout?.on(\"close\", gone);\n",""],
  ["guard-pack17-default-spawn-untested","server/leader-acp.ts","(deps.spawnFn ?? spawnAcpChild)(deps.cli.program","(deps.spawnFn ?? ((): never => { throw new Error(\"mutated\"); }))(deps.cli.program"],
  ["guard-pack17-token-redacted-per-chunk","server/leader-acp.ts","return out + redact(raw.slice(pos, upto));","return out + raw.slice(pos, upto);"],
  ["guard-pack17-break-kept","server/leader-acp.ts","gaps = gaps.filter((g) => g.at > cut).map((g) => ({ at: g.at - cut, gap: g.gap }));","gaps = [];"],
  ["p18-r1-f3", "server/crew-setup.ts", "    refuseRemovingBusySeats(message.tabId, location.tab, setup.crew);\n    // The live leader", "    // The live leader"],
  ["p18-r1-f4", "server/runner.ts", "    writeFileSync(briefPath, prompt, \"utf8\");\n    leader = createAcpLeader", "    leader = createAcpLeader"],
  ["p18-pair-index","server/process-core.ts","return step.pairs[(round - 1) % step.pairs.length];","return step.pairs[0];"],
  ["p18-select-fixer-ignored","server/process-core.ts","return state.selectedFixer && pair.fixers.includes(state.selectedFixer) ? state.selectedFixer : pair.fixers[0];","return pair.fixers[0];"],
  ["p18-default-template","server/setup-templates.ts","kind === \"mkt\" ? \"marketing\" : \"our-process\"","kind === \"mkt\" ? \"marketing\" : \"duo\""],
  ["p18-set-initial-fixer","server/process-core.ts","    selectedFixer: initialFixer(setup.steps),","    selectedFixer: null,"],
  ["p18-set-select-fixer","server/process-engine.ts","  next.selectedFixer = seatSlotId;","  void 0;"],
  ["p18-one-leader","server/setup.ts","if (leaders !== 1) throw new Error(\"a crew needs exactly one leader\");","if (false) throw new Error(\"a crew needs exactly one leader\");"],
  ["p18-migrate-keep-model","server/config-migrate.ts","cli: old.cli, model: old.model, effort: old.effort","cli: old.cli, model: seat.model, effort: old.effort"],
  ["p18-migrate-advisor","server/config-migrate.ts","if (seat.isLeader && isObject(tab.advisor) && old.cli === \"claude\") next.advisor = tab.advisor.model;","if (false) next.advisor = tab.advisor.model;"],
  ["p18-migrate-backup","server/config.ts","  keepConfigBackups(target);","  void 0;"],
  ["p18-fallback-sonnet","server/config.ts","  { value: \"claude-sonnet-5-5[1m]\", displayName: \"Sonnet 5.5 (1M context)\", supportsEffort: true },",""],
  ["p18-keep-template-models","server/config.ts","  const models = (kind: SeatKind) => [...SAVED_MODELS[kind], ...fromTemplates.models[kind]];","  const models = (kind: SeatKind) => [...SAVED_MODELS[kind]];"],
  ["p18-sweep-control","server/process-types.ts","// CLI-CAPABILITIES-TABLE (the one place","// CLI table (the one place"],
  ["p18-acp-orch-write","server/setup.ts","if (isAcpCli(raw.cli) && !raw.canWrite) throw","if (false) throw"],
  ["p18-crew-tools-cap","server/setup.ts","if (!caps.crewTools) throw","if (false) throw"],
  ["p18-set-migrate-pic","server/config-migrate.ts","...(old.pic !== undefined ? { pic: old.pic } : {})",""],
  ["p18-set-migrate-setupname","server/config-migrate.ts","return { ...rest, setupName: base.name, crew, lookPause: base.lookPause, steps: base.steps };","return { ...rest, setupName: \"\", crew, lookPause: base.lookPause, steps: base.steps };"],
  ["p18-set-adopt-setups","server/config.ts","...setups.map((setup) => setup.crew)]","...[]]"],
  ["p18-gate-caps","server/process-types.ts","label: cli.slice(4), advisor: false, readOnlyEnforced: false","label: cli.slice(4), advisor: false, readOnlyEnforced: true"],
  ["p18-crew-steps","server/leader-tools.ts","steps: deps.steps?.() ?? [], process: deps.processView?.() ?? null })","steps: [], process: deps.processView?.() ?? null })"],
  ["p18-crew-role","server/leader-tools.ts","name: seat.name, role: seat.role, cli: seat.cli,","name: seat.name, cli: seat.cli,"],
  ["p18-use-carry","server/crew-setup.ts","name: was.name, ...(was.pic ? { pic: was.pic } : {})","name: seat.name, ...(was.pic ? { pic: was.pic } : {})"],
  ["p18-advance-waits-runs","server/process-engine.ts","slotId !== \"user\" && slotId !== callerSlot && runIsWorkingForSeat(next, slotId)","false"],
  ["p18-set-commit-setupname","server/crew-setup.ts","  if (meta.setupName) tab.setupName = meta.setupName;",""],
  ["p18-set-commit-kind","server/crew-setup.ts","  if (meta.kind) tab.kind = meta.kind;",""],
  ["p18-set-commit-restart","server/crew-setup.ts","  if (restart) { runtime.state = switchProcess(runtime.state, setup); runtime.stalledRuns.clear(); }","  if (false) { runtime.state = switchProcess(runtime.state, setup); runtime.stalledRuns.clear(); }"],
  ["p18-set-save-setups","server/crew-setup.ts","deps.setSavedSetups(next); adoptSavedValues(deps.workspaces(), next);","adoptSavedValues(deps.workspaces(), next);"],
  ["p18-set-remove-setups","server/crew-setup.ts","deps.setSavedSetups(remaining); adoptSavedValues(deps.workspaces(), remaining);","adoptSavedValues(deps.workspaces(), remaining);"],
  ["p18-bridge-keeps-alive","server/leader-bridge.ts","    try { entry.onCall?.(); } catch { /* noting a call never changes its answer */ }\n","\n"],
  ["p18-bridge-per-run","server/leader-bridge.ts","    entries.set(key, entry);","    entries.clear(); entries.set(key, entry);"],
  ["p18-orchestrator-not-a-worker","server/process-core.ts"," && !findSeat(state, run.seatSlotId)?.orchestrates);",");"],
  ["p18-runner-advisor-flag","server/runner.ts","--effort ${run.effort}${advisor} ${mode}","--effort ${run.effort} ${mode}"],
  ["p18-runner-advisor-check","server/runner.ts","run.advisor !== undefined && !isValidModel(\"claude\", run.advisor)","false"],
  ["p18-acp-worker-done","server/runner.ts","entry.outcome ??= \"done\"; leader?.stop();","leader?.stop();"],
  ["p18-acp-worker-log","server/runner.ts","const note = (text: string): void => { appendLog(text); cb.onOutput(run, text); };","const note = (text: string): void => { cb.onOutput(run, text); };"],
  ["p18-acp-worker-noshell","server/runner.ts","(spawnFn as unknown as AcpSpawn)(program, args, options)","(spawnFn as any)([program, ...args].join(\" \"), { ...options, shell: true })"],
  ["p18-acp-worker-readonly","server/runner.ts","denyPermissions: !run.canWrite","denyPermissions: false"],
  ["p18-claude-mcp-flag","server/runner.ts","--mcp-config \"%${MCP_VAR}%\" --allowedTools","--allowedTools"],
  ["p18-claude-orch-mode","server/runner.ts","run.crewTools ? CLAUDE_READ_ONLY_CREW_FLAGS : CLAUDE_READ_ONLY_FLAGS","run.crewTools ? CLAUDE_READ_ONLY_FLAGS : CLAUDE_READ_ONLY_CREW_FLAGS"],
  ["p18-mcp-file-deleted","server/runner.ts","    removeMcp();\n    try { flush(); }","    try { flush(); }"],
  ["p18-mcp-file-deleted-released","server/runner.ts","      removeMcp();\n      void watch?.sweep","      void watch?.sweep"],
  ["p18-codex-mcp-flag","server/runner.ts"," -c mcp_servers.${CREW_SERVER}.default_tools_approval_mode=approve",""],
  ["p18-token-not-argv","server/runner.ts",".bearer_token_env_var=${CREW_TOKEN_VAR}",".bearer_token_env_var=${CREW_TOKEN_VAR} -c tab_token=${run.crewTools.token}"],
  ["p18-opencode-merge","server/runner-crew.ts","...(run.canWrite ? {} : { permission: { edit: \"deny\", bash: \"deny\" } }),",""],
  ["p18-worker-token-redacted","server/runner.ts","const clean = (held + text).split(secret).join(HIDDEN);","const clean = held + text;"],
  ["p18-acp-orch-nohttp","server/leader-acp.ts","if (deps.bridge && deps.needHttp && !http) throw","if (false) throw"],
  ["p18-no-tools-for-workers","server/runner.ts","const crew = (run.crewTools ?","const crew = (true ?"],
  ["p18-int-backup-first-write","server/config.ts","  keepConfigBackups(target);","  void target;"],
  ["p18-int-acp-done","server/runner.ts","entry.outcome ??= \"done\"; leader?.stop();","leader?.stop();"],
  ["rw-fill-leader","server/setup.ts","const review = reviewers.length ? reviewers : [standIn(finals)];","const review = reviewers.length ? reviewers : build;"],
  ["rw-fixer-falls-to-coder","server/setup.ts","const fix = fixers.length ? fixers : build;","const fix = fixers.length ? fixers : [lead.slot];"],
  ["rw-pair-cycle","server/setup.ts","({ reviewer: review[i % review.length], fixers: [fix[i % fix.length]] })","({ reviewer: review[0], fixers: [fix[i % fix.length]] })"],
  ["rw-planner-owns-gate","server/setup.ts","const planner = withRole(\"Planner\")[0] ?? lead.slot;","const planner = lead.slot;"],
  ["rw-no-look-round-start","server/process-engine.ts","next.approval = { state: \"approved\", reviewWaits: true };","void next;"],
  ["rw-orch-planner-only","server/setup.ts","if (role !== \"Planner\") throw new Error(`seat ${slot}: only a Planner can run the process`);","void role;"],
  ["rw-one-planner","server/setup.ts","if (role === \"Planner\" && ++planners > 1) throw new Error(\"a crew has at most one Planner\");","void planners;"],
  ["rw-migrate-role-map","server/config-migrate.ts","if (pairs.some((pair) => pair.reviewer === seat.slot)) return \"Reviewer\";","if (pairs.some((pair) => pair.reviewer === seat.slot)) return \"Helper\";"],
  ["rw-migrate-backup","server/config-migrate.ts","keepBackup(target, \"workspaces.before-roles.json\", (data) => tabsOf(data).some(","keepBackup(target, \"workspaces.before-roles.json\", (data) => false && tabsOf(data).some("],
  ["rw-role-once","server/setup.ts","return !instruction || prompt.startsWith(instruction) ? prompt","return !instruction ? prompt"],
  ["rw-template-our-process","server/setup-templates.ts","seat(\"fixer2\", \"Nova\", \"Fixer\", \"claude\", SONNET, \"medium\", true),","seat(\"fixer2\", \"Nova\", \"Helper\", \"claude\", SONNET, \"medium\", true),"],
  ["p18-lj-runnable", "server/leader-tools.ts", "(!seat.isLeader || deps.leaderTakesJobs === true) && seat.slot", "!seat.isLeader && seat.slot"],
  ["ow-review-falls-to-leader", "server/setup.ts", "const review = reviewers.length ? reviewers : [standIn(finals)];", "const review = reviewers.length ? reviewers : [lead.slot];"],
  ["ow-final-falls-to-leader", "server/setup.ts", "const final = finals.length ? finals : [standIn(reviewers)];", "const final = finals.length ? finals : [lead.slot];"],
  ["ow-refuse-use", "server/crew-setup.ts", "const setup = checkNewCrew({ crew: carrySeats(location.tab.crew, source.crew), lookPause: source.lookPause });", "const setup = validateSetup({ crew: carrySeats(location.tab.crew, source.crew), lookPause: source.lookPause });"],
  ["ow-refuse-save", "server/crew-setup.ts", "if (!sameSteps) checkNewCrew(setup);", ""],
  ["ow-refuse-seat", "server/crew-setup.ts", "if (changed) checkNewCrew({ crew, lookPause: tab.lookPause });", ""],
  ["ow-planner-reports-own-run", "server/process-engine.ts", "(reviewer === callerSlot || !runIsWorkingForSeat(state, reviewer))", "!runIsWorkingForSeat(state, reviewer)"],
  ["ow-review-caller-only", "server/process-engine.ts", "reviewer === callerSlot || !runIsWorkingForSeat(state, reviewer)", "seat.orchestrates === true || !runIsWorkingForSeat(state, reviewer)"],
  ["ow-refuse-save-as", "server/crew-setup.ts", "    checkNewCrew({ crew: location.tab.crew, lookPause: location.tab.lookPause });\n", ""],
  ["ow-migrate-lookpause-return", "server/config-migrate.ts", "  if (typeof entry.lookPause === \"boolean\") return null;\n", ""],
  ["ow-seat-unchanged-refused", "server/crew-setup.ts", "if (changed) checkNewCrew({ crew, lookPause: tab.lookPause });", "checkNewCrew({ crew, lookPause: tab.lookPause });"],
  ["ow-save-unchanged-refused", "server/crew-setup.ts", "if (!sameSteps) checkNewCrew(setup);", "checkNewCrew(setup);"],
  ["ow-review-any-caller", "server/process-engine.ts", "reviewer === callerSlot", "callerSlot !== undefined"],
  ["ow-planner-standin-first", "server/setup.ts", 'withRole("Planner")[0] ?? otherReviewRole[0]', 'otherReviewRole[0] ?? withRole("Planner")[0]'],
];
