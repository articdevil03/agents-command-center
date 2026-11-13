import { serverOtherCoreMutations } from "./server-other-core.mjs";
export const serverOtherMutations = [
  ...serverOtherCoreMutations,
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
  ["guard-opencode-reviewer-deny-bash", "server/runner-crew.ts", "permission: { edit: \"deny\", bash: \"deny\" },", "permission: { edit: \"deny\" },"],
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
  // ---- the roster must never go stale mid-conversation (guard from the
  // "Atlas knows the crew" brief): a launch that runs against a seat whose
  // config changed since the leader's last get_crew_status call says so. ----
  ["guard-kill-unconfirmed-setter", "server/runner.ts", "entry.unconfirmed = true;", ""],
  ["guard-kill-unconfirmed-callback", "server/runner.ts", "  entry.cb.onUnconfirmedKill?.(entry.run, entry.proc.pid);\n", ""],
  ["guard-packc-test-cli-runner-env-gate", "server/test-cli-runner.ts", 'if (env.CC_TEST_FAKE_CLI !== "1") return undefined;', 'if (false) return undefined;'],
  ["guard-packc-r1-git-no-optional-locks","server/changes.ts","\"--no-optional-locks\", \"-C\", folder, \"status\", \"--porcelain=v1\", \"-z\", \"-b\", \"--no-renames\"","\"-C\", folder, \"status\", \"--porcelain=v1\", \"-z\", \"-b\", \"--no-renames\""],
  ["guard-packc-r1-requests-pending-cap", "server/requests.ts", '.length >= MAX_PENDING_PER_SOURCE) {', '.length >= Infinity) {'],
  ["guard-packc-r1-requests-resolved-trim", "server/requests.ts", 'Math.max(0, resolved.length - MAX_RESOLVED_KEPT)', '0'],
  ["guard-packc-r7-launch-tool-awaits", "server/leader-tools.ts", 'const result = await found.handler(parsed.data);', 'const result = found.handler(parsed.data) as unknown as ToolContent;'],
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
  ["guard-runner-stderr-tail-logged","server/runner.ts","    if (text) { appendLog(text); cb.onOutput(run, text); }","    if (text) { cb.onOutput(run, text); }"],
  ["guard-dismissed-runs-201-retained","server/config-prefs.ts","return { ok: true, prefs: { ...prefs, dismissedRuns: [...value] } };","return { ok: true, prefs: { ...prefs, dismissedRuns: value.length === 201 ? [] : [...value] } };"],
  ["guard-runner-stdouttail-log-and-output","server/runner.ts","      else emit(stdoutTail);\n","      else { void stdoutTail; }\n"],
  ["guard-runner-stderrtail-log-and-output","server/runner.ts","      emit(stderrTail);\n      if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));","      if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));"],
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
  ["guard-pack15-sweep-wait-covers-list-and-kill","server/runner/lifecycle.ts","const SWEEP_WAIT_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000;","const SWEEP_WAIT_MS = 4000;"],
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
  ["p18-r1-f4", "server/runner.ts", "    writeFileSync(briefPath, prompt, \"utf8\");\n    leader = createAcpLeader", "    leader = createAcpLeader"],
  ["p18-fallback-sonnet","server/config.ts","  { value: \"claude-sonnet-5-5[1m]\", displayName: \"Sonnet 5.5 (1M context)\", supportsEffort: true },",""],
  ["p18-sweep-control","server/process-types.ts","// CLI-CAPABILITIES-TABLE (the one place","// CLI table (the one place"],
  ["p18-gate-caps","server/process-types.ts","label: cli.slice(4), advisor: false, readOnlyEnforced: false","label: cli.slice(4), advisor: false, readOnlyEnforced: true"],
  ["p18-bridge-keeps-alive","server/leader-bridge.ts","    try { entry.onCall?.(); } catch { /* noting a call never changes its answer */ }\n","\n"],
  ["p18-bridge-per-run","server/leader-bridge.ts","    entries.set(key, entry);","    entries.clear(); entries.set(key, entry);"],
  ["p18-runner-advisor-flag","server/runner.ts","--effort ${run.effort}${advisor} ${mode}","--effort ${run.effort} ${mode}"],
  ["p18-runner-advisor-check","server/runner.ts","run.advisor !== undefined && !isValidModel(\"claude\", run.advisor)","false"],
  ["p18-acp-worker-done","server/runner.ts","entry.outcome ??= \"done\"; leader?.stop();","leader?.stop();"],
  ["p18-acp-worker-log","server/runner.ts","const note = (text: string): void => { appendLog(text); cb.onOutput(run, text); };","const note = (text: string): void => { cb.onOutput(run, text); };"],
  ["p18-acp-worker-noshell","server/runner.ts","(spawnFn as unknown as AcpSpawn)(program, args, options)","(spawnFn as any)([program, ...args].join(\" \"), { ...options, shell: true })"],
  ["p18-acp-worker-readonly","server/runner.ts","denyPermissions: !run.canWrite","denyPermissions: false"],
  ["p18-acp-orch-nohttp","server/leader-acp.ts","if (deps.bridge && deps.needHttp && !http) throw","if (false) throw"],
  ["p18-int-acp-done","server/runner.ts","entry.outcome ??= \"done\"; leader?.stop();","leader?.stop();"],
  ["fc-installed-true", "server/fixed-crew/assignment.ts", 'cli.installed === true', 'cli.installed !== false'],
  ["fc-preserve-user", "server/fixed-crew/assignment.ts", 'if (current.source === "user") return current;', 'if (false) return current;'],
  ["fc-empty-stays-null", "server/fixed-crew/assignment.ts", 'if (available.length === 0) return { assignment: null, source: "auto" };', 'if (available.length === 0) return automatic({ ...seat.preferred });'],
  ["fc-single-cli", "server/fixed-crew/assignment.ts", 'if (available.length === 1) return automatic(singleAssignment(seat, available[0]));', 'if (available.length === 1) return automatic(null);'],
  ["fc-preferred-choice", "server/fixed-crew/assignment.ts", 'models.includes(seat.preferred.model) ? seat.preferred.model', 'false ? seat.preferred.model'],
  ["fc-assignment-setter", "server/fixed-crew/assignment.ts", 'next[seat.slot] = resolved;', 'next[seat.slot] = current;'],
  ["fc-null-run-refused", "server/fixed-crew/assignment.ts", 'if (!preference.assignment) throw new Error("Choose a model in Settings before running this seat.");', 'if (false) throw new Error("Choose a model in Settings before running this seat.");'],
  ["fc-codex-xhigh", "server/config.ts", 'codex: ["low", "medium", "high", "xhigh", "max"],', 'codex: ["low", "medium", "high", "max"],'],
  ["fc-review-company", "server/fixed-crew/assignment.ts", 'const fallback = differentCompany ?? candidates[0];', 'const fallback = candidates[0];'],
  ["fc-reviewer-alternation", "server/fixed-crew/assignment.ts", 'if (preferred && writerCompany && assignmentCompany(preferred) === writerCompany && differentCompany) {', 'if (false) {'],
  ["fc-model-default-order", "server/fixed-crew/assignment.ts", 'defaults.find((candidate) => models.includes(candidate)) ?? models[0]', 'models[0]'],
  ["fc-acp-last", "server/fixed-crew/assignment.ts", 'return isAcpCli(id) ? 3 :', 'return isAcpCli(id) ? -1 :'],
  ["fc-keep-preferred-cli", "server/fixed-crew/assignment.ts", 'const preferredCli = available.find((cli) => cli.id === seat.preferred.cli);', 'const preferredCli = available.find((cli) => cli.id === seat.preferred.cli && modelChoices(cli, catalogue).includes(seat.preferred.model) && effortChoices(cli).includes(seat.preferred.effort));'],
];
