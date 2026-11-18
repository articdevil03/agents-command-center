// P3 folder admission, permission, steer delivery and plain failure guards.
export const auditP3Mutations = [
  [
    "audit-p3-accept-command-approval",
    "server/leader.ts",
    "return effective !== \"accept\" || !safeLocalTool(tool, input);",
    "return false;"
  ],
  [
    "audit-p3-callback-approval-call",
    "server/leader.ts",
    "(needsNoCard(tool) || await approve(tool, input, context.signal))",
    "(!needsApproval(tool, input) || await approve(tool, input, context.signal))"
  ],
  [
    "audit-p3-live-tab-mode-accessor",
    "server/leader.ts",
    "() => requestedMode) }",
    "() => mode) }"
  ],
  [
    "audit-p3-local-containment",
    "server/leader.ts",
    "isInsideFolder(resolve(tabFolder, path), root)",
    "true"
  ],
  [
    "audit-p3-glob-containment",
    "server/leader.ts",
    "    if (tool === \"Glob\" && (isAbsolute(pattern) || pattern.split(/[\\\\/]/).includes(\"..\") || expandsOutside(pattern))) return false;",
    "    // Glob traversal guard removed"
  ],
  [
    "audit-p3-vault-second-root",
    "server/leader.ts",
    "[tabFolder, vaultPath].filter",
    "[tabFolder].filter"
  ],
  [
    "audit-p3-protected-paths",
    "server/main/workspace.ts",
    "  const protectedPaths = [home, env.USERPROFILE, dirname(env.USERPROFILE || home),\n    env.APPDATA, env.LOCALAPPDATA, env.ProgramFiles, env[\"ProgramFiles(x86)\"], env.ProgramW6432,\n    env.SystemRoot || join(drive, \"Windows\"), env.windir, join(drive, \"Program Files\")];",
    "  const protectedPaths: string[] = [];"
  ],
  [
    "audit-p3-each-path-entry",
    "server/main/workspace.ts",
    "for (const entry of (pathKey ? env[pathKey] ?? \"\" : \"\").split(\";\"))",
    "for (const entry of [])"
  ],
  [
    "audit-p3-admit-first-run",
    "server/first-run/complete.ts",
    "const folder = validateFolderPath(message.folder, \"project folder\");",
    "const folder = (message.folder);"
  ],
  [
    "audit-p3-admit-add-project",
    "server/main/messages/projects.ts",
    "const folder = validateFolderPath(typeof message.folder === \"string\" && message.folder.trim() ? message.folder.trim() : settingsService.state.folders.defaultProjectFolder, \"project folder\");",
    "const folder = (typeof message.folder === \"string\" && message.folder.trim() ? message.folder.trim() : settingsService.state.folders.defaultProjectFolder);"
  ],
  [
    "audit-p3-admit-tab-folder",
    "server/main/messages/projects.ts",
    "const tabFolder = validateFolderPath(message.tabFolder ?? folder, \"tab folder\");",
    "const tabFolder = (message.tabFolder ?? folder);"
  ],
  [
    "audit-p3-admit-add-tab",
    "server/main/messages/projects.ts",
    "const folder = validateFolderPath(typeof message.folder === \"string\" ? message.folder : project.folder || settingsService.state.folders.defaultProjectFolder, \"tab folder\");",
    "const folder = (typeof message.folder === \"string\" ? message.folder : project.folder || settingsService.state.folders.defaultProjectFolder);"
  ],
  [
    "audit-p3-admit-change-tab",
    "server/main/messages/projects.ts",
    "const folder = validateFolderPath(message.folder, \"tab folder\");",
    "const folder = (message.folder);"
  ],
  [
    "audit-p3-admit-change-project",
    "server/main/messages/projects.ts",
    "const folder = validateFolderPath(message.folder, \"project folder\");",
    "const folder = (message.folder);"
  ],
  [
    "audit-p3-preserve-steers-vault",
    "server/main/leader-turn.ts",
    "  if (leaderNeedsVaultReplacement(tabId)) stopLeaderSession(tabId, false, undefined, true);",
    "  if (leaderNeedsVaultReplacement(tabId)) stopLeaderSession(tabId);"
  ],
  [
    "audit-p3-preserve-steers-settings",
    "server/main/leader-turn.ts",
    "  if (fixedTab && isFixedTab(fixedTab) && leaders.has(tabId) && fixedLeaderSettings.get(tabId) !== fixedLeaderSignature(tabId)) stopLeaderSession(tabId, false, undefined, true);",
    "  if (fixedTab && isFixedTab(fixedTab) && leaders.has(tabId) && fixedLeaderSettings.get(tabId) !== fixedLeaderSignature(tabId)) stopLeaderSession(tabId);"
  ],
  [
    "audit-p3-preserve-steers-new-leader",
    "server/main/leader-turn.ts",
    "    stopLeaderSession(tabId, false, undefined, true);",
    "    stopLeaderSession(tabId);"
  ],
  [
    "audit-p3-preserve-steers-branch",
    "server/main/leader-session.ts",
    "if (!preserveSteers) { lateSteers.delete(tabId); steeredTurns.delete(tabId); }",
    "{ lateSteers.delete(tabId); steeredTurns.delete(tabId); }"
  ],
  [
    "audit-p3-missed-steer-setter",
    "server/main/leader-turn.ts",
    "  steeredTurns.add(tabId);\n  void sendLeaderTurn",
    "  void sendLeaderTurn"
  ],
  [
    "audit-p3-start-catch-finishes",
    "server/main/leader-turn.ts",
    "finishLeaderTurn(tabId, true, startFailure(err));",
    "finishLeaderTurn(tabId, false);"
  ],
  [
    "audit-p3-known-startup-allowlist",
    "server/main/leader-turn.ts",
    "if (/ was not found on PATH$/.test(message))",
    "if (false)"
  ],
  [
    "audit-p3-opencode-plain-mapping",
    "server/leader-opencode/errors.ts",
    "return \"OpenCode could not finish this turn. Try again.\";",
    "return message;"
  ],
  [
    "audit-p3-opencode-no-error-body",
    "server/leader-opencode/errors.ts",
    "throw new Error(\"OpenCode could not finish this turn. Try again.\");\n  }\n  if (!text)",
    "throw new Error(text);\n  }\n  if (!text)"
  ],
  [
    "audit-p3-harmless-unknown",
    "server/leader.ts",
    "if (needsNoCard(tool)) return false;",
    "if (needsNoCard(tool) || ![\"Read\", \"Glob\", \"Grep\", \"LS\", \"Edit\", \"MultiEdit\", \"Write\", \"NotebookEdit\", \"Bash\", \"PowerShell\", \"ExitPlanMode\", \"EnterPlanMode\"].includes(tool)) return false;"
  ],
  [
    "audit-p3-callback-catch-deny",
    "server/leader.ts",
    "} catch { return { behavior: \"deny\", message: USER_DENIED }; }",
    "} catch { return { behavior: \"allow\", updatedInput: input }; }"
  ],
  [
    "audit-p3-held-plan-after-exit",
    "server/leader.ts",
    "const input = event.tool_input as Record<string, unknown>;",
    "if (holdsPlan() && event.permission_mode !== \"plan\") return {};\n      const input = event.tool_input as Record<string, unknown>;"
  ],
  [
    "audit-p3-live-plan-cli-enforcement",
    "server/leader.ts",
    "if (holdsPlan() && event.permission_mode === \"plan\") return {};",
    "if (false) return {};"
  ],
  [
    "audit-p3-enter-plan-approval",
    "server/leader.ts",
    "if (tool === \"AskUserQuestion\") return QUESTION_UNAVAILABLE;",
    "if (tool === \"AskUserQuestion\" || tool === \"EnterPlanMode\") return QUESTION_UNAVAILABLE;"
  ],
  [
    "audit-p3-observed-mode-setter",
    "server/leader.ts",
    "if (event.permission_mode) observeMode(event.permission_mode);",
    "if (event.permission_mode) observeMode(permissionModeForSdk(effectiveMode()));"
  ],
  [
    "audit-p3-shown-live-plan",
    "server/main/broadcast.ts",
    "leaders.get(tab.id)?.getPermissionMode?.() === \"plan\" ? \"plan\" : effectiveMode(tab.id)",
    "effectiveMode(tab.id)"
  ],
  [
    "audit-p3-mode-notification",
    "server/leader.ts",
    "cb.onPermissionMode?.();",
    "void 0;"
  ],
  [
    "audit-p3-glob-absolute",
    "server/leader.ts",
    "    if (tool === \"Glob\" && (isAbsolute(pattern) || pattern.split(/[\\\\/]/).includes(\"..\") || expandsOutside(pattern))) return false;",
    "    if (tool === \"Glob\" && (false || pattern.split(/[\\\\/]/).includes(\"..\") || expandsOutside(pattern))) return false;"
  ],
  [
    "audit-p3-glob-parent",
    "server/leader.ts",
    "    if (tool === \"Glob\" && (isAbsolute(pattern) || pattern.split(/[\\\\/]/).includes(\"..\") || expandsOutside(pattern))) return false;",
    "    if (tool === \"Glob\" && (isAbsolute(pattern) || false || expandsOutside(pattern))) return false;"
  ],
  [
    "audit-p3-page-mode-broadcast",
    "server/main/leader-session.ts",
    "onPermissionMode: () => { if (current()) broadcast(stateMessage()); },",
    "onPermissionMode: () => {},"
  ],
  [
    "audit-p3-plan-hook-tool-boundary",
    "server/leader.ts",
    "      if (holdsPlan() && ![\"Edit\", \"MultiEdit\", \"Write\", \"NotebookEdit\", \"Bash\", \"PowerShell\"].includes(event.tool_name)) return {};",
    ""
  ],
  [
    "audit-p3-expands-tilde-path",
    "server/leader.ts",
    "!expandsOutside(value) &&",
    "true &&"
  ],
  [
    "audit-p3-expands-glob-pattern",
    "server/leader.ts",
    "|| expandsOutside(pattern)",
    ""
  ],
  [
    "audit-p3-expands-tilde-regex",
    "server/leader.ts",
    "/^~/.test(text)",
    "false"
  ],
  [
    "audit-p3-expands-env-regex",
    "server/leader.ts",
    "/[%$]/.test(",
    "false && /[%$]/.test("
  ],
  [
    "audit-p3-callback-crew-tools",
    "server/leader.ts",
    "harmless.has(tool) || (tools?.allowedTools.includes(tool) ?? false);",
    "harmless.has(tool);"
  ],
  [
    "audit-p3-harmless-list-emptied",
    "server/leader.ts",
    "const harmless = new Set([\"TodoWrite\", \"Task\", \"Agent\", \"Skill\", \"ToolSearch\", \"TaskCreate\", \"TaskUpdate\", \"TaskGet\", \"TaskList\", \"TaskOutput\", \"TodoRead\", \"KillShell\", \"ListMcpResources\"]);",
    "const harmless = new Set<string>([]);"
  ],
  [
    "audit-p3-harmless-mcp-kill",
    "server/leader.ts",
    ", \"KillShell\", \"ListMcpResources\"]);",
    "]);"
  ],
  [
    "audit-p3-hook-needs-approval-call",
    "server/leader.ts",
    "if (!needsApproval(event.tool_name, input) && !(",
    "if (true && !("
  ],
  [
    "audit-p3-hook-always-asks",
    "server/leader.ts",
    "if (!needsApproval(event.tool_name, input) && !(",
    "if (false && !("
  ],
  [
    "audit-p3-hook-question-refusal",
    "server/leader.ts",
    "      if (denied) return { hookSpecificOutput: { hookEventName: \"PreToolUse\", permissionDecision: \"deny\", permissionDecisionReason: denied } };",
    "      void denied;"
  ],
  [
    "audit-p3-callback-question-refusal",
    "server/leader.ts",
    "        if (denied) return { behavior: \"deny\", message: denied };",
    "        void denied;"
  ],
  [
    "audit-p3-folder-drive-root",
    "server/main/workspace.ts",
    "  if (dirname(folder) === folder) return true;",
    "  if (false) return true;"
  ],
  [
    "audit-p3-folder-cli-install",
    "server/main/workspace.ts",
    "  return installs.some((path) => path && isInsideFolder(dirname(path), folder));",
    "  return false;"
  ],
  [
    "audit-p3-steer-delivery-catch",
    "server/main/leader-turn.ts",
    "    finishLeaderTurn(tabId, true, LEADER_DELIVERY_FAILURE);\n  });\n  broadcast(stateMessage());",
    "    void err;\n  });\n  broadcast(stateMessage());"
  ],
  [
    "audit-p3-start-known-removed",
    "server/main/leader-turn.ts",
    "if (/^The CLI \".*\" was removed in Settings",
    "if (false && /^The CLI \".*\" was removed in Settings"
  ],
  [
    "audit-p3-start-known-inside-tab",
    "server/main/leader-turn.ts",
    "if (/^The Claude CLI \\(.*\\) lies inside the tab folder \\(/",
    "if (false && /^The Claude CLI \\(.*\\) lies inside the tab folder \\(/"
  ],
  [
    "audit-p3-start-known-hidden-named",
    "server/main/leader-turn.ts",
    "  if (hidden) return",
    "  if (false && hidden) return"
  ],
  [
    "audit-p3-start-known-hidden-generic",
    "server/main/leader-turn.ts",
    "if (/ was found only inside a project folder \\(/.test",
    "if (false && / was found only inside a project folder \\(/.test"
  ],
  [
    "audit-p3-start-known-not-on-path",
    "server/main/leader-turn.ts",
    "if (/ was not found on PATH$/.test",
    "if (false && / was not found on PATH$/.test"
  ],
  [
    "audit-p3-start-known-previous-leader",
    "server/main/leader-turn.ts",
    "if (/^The previous leader on this tab (",
    "if (false && /^The previous leader on this tab ("
  ],
  [
    "audit-p3-start-known-no-model",
    "server/main/leader-turn.ts",
    "  if (/^[A-Za-z][A-Za-z0-9 &-]{0,40} has no model",
    "  if (false && /^[A-Za-z][A-Za-z0-9 &-]{0,40} has no model"
  ],
  [
    "audit-p3-start-known-fixed-list",
    "server/main/leader-turn.ts",
    "Check installation and add its connection again.\"].includes(message)) return message;",
    "Check installation and add its connection again.\"].includes(message) && false) return message;"
  ],
  [
    "audit-p3-opencode-install-hint",
    "server/leader-opencode/errors.ts",
    "  if (message === \"OpenCode exited before it started; is it installed?\") return message;",
    "  // install hint removed"
  ],
  [
    "audit-p3-plain-failure-fallback",
    "server/leader-common/plain-failure.ts",
    "? raw : fallback;",
    "? raw : raw;"
  ],
  [
    "audit-p3-codex-error-notification",
    "server/leader-codex.ts",
    "die(CODEX_TURN_FAILED(\"error\", params.error?.message ?? \"\"));",
    "die(`leader turn failed: ${params.error?.message}`);"
  ],
  [
    "audit-p3-codex-turn-start-catch",
    "server/leader-codex.ts",
    "die(plainFailure(\"Codex\", (error as Error).message, CODEX_KNOWN, vendorRemedy(\"Codex\", (error as Error).message) ?? \"The Codex leader turn failed. Try again.\", \"turn-start\"));",
    "die(`leader turn failed: ${(error as Error).message}`);"
  ],
  [
    "audit-p3-acp-error-reply",
    "server/leader-acp.ts",
    "return vendorRemedy(name, message, error?.code === AUTH_REQUIRED) ?? plainFailure(\"ACP\", \"\", [], sessionId ? `${name} could not finish this turn. Try again.` : `${name} could not start. Try again.`, \"error-reply\");",
    "return `${name} reported an error: ${message}`;"
  ],
  [
    "audit-p3-first-run-program-guard",
    "server/first-run/complete.ts",
    "    resolveCliOrThrow(checked.program, process.env, [process.cwd(), folder]);",
    "    // program guard removed"
  ],
  [
    "audit-p3-leading-space-tilde",
    "server/leader.ts",
    "const text = value.trim();",
    "const text = value;"
  ],
  [
    "audit-p3-absolute-project-env-prefix",
    "server/leader.ts",
    "relative(root, resolve(text)) : text",
    "text : text"
  ],
  [
    "audit-p3-relative-env-path",
    "server/leader.ts",
    "relative(root, resolve(text)) : text",
    "relative(root, resolve(text)) : \"\""
  ],
  [
    "audit-p3-mcp-resource-needs-card",
    "server/leader.ts",
    "\"KillShell\", \"ListMcpResources\"]);",
    "\"KillShell\", \"ListMcpResources\", \"ReadMcpResource\"]);"
  ],
  [
    "audit-p3-codex-status-failed",
    "server/leader-codex.ts",
    "CODEX_TURN_FAILED(\"status\", params.turn?.error?.message ?? \"\")",
    "`leader turn failed: ${params.turn?.error?.message}`"
  ],
  [
    "audit-p3-codex-status-interrupted",
    "server/leader-codex.ts",
    "plainFailure(\"Codex\", \"\", [], \"The Codex leader turn interrupted. Try again.\", \"interrupted\")",
    "`leader turn interrupted: ${params.turn?.error?.message}`"
  ],
  [
    "audit-p3-codex-spawn-plain",
    "server/leader-codex.ts",
    "child.on(\"error\", () => die(plainFailure(\"Codex\", \"\", [], \"Codex could not start. Try again.\", \"spawn\")));",
    "child.on(\"error\", (error) => die(error.message));"
  ],
  [
    "audit-p3-codex-ready-plain",
    "server/leader-codex.ts",
    "vendorRemedy(\"Codex\", error.message) ?? plainFailure(\"Codex\", error.message, CODEX_KNOWN, \"Codex could not start. Try again.\", \"start\")",
    "error.message"
  ],
  [
    "audit-p3-acp-start-plain",
    "server/leader-acp.ts",
    "const text = plainFailure(\"ACP\", raw, [/ was not found on PATH$/, / was found only inside a project folder \\(/], `${name} could not start. Try again.`, \"start\");",
    "const text = raw;"
  ],
  [
    "audit-p3-acp-spawn-plain",
    "server/leader-acp.ts",
    "child.on(\"error\", () => die(plainFailure(\"ACP\", \"\", [], `${name} could not start. Try again.`, \"spawn\")));",
    "child.on(\"error\", (error) => die(error.message));"
  ],
  [
    "audit-p3-acp-turn-catch-plain",
    "server/leader-acp.ts",
    "plainFailure(\"ACP\", \"\", [], `${name} could not finish this turn. Try again.`, \"turn\")",
    "error.message"
  ],
  [
    "audit-p3-vendor-auth-remedy",
    "server/leader-common/plain-failure.ts",
    "if (authRequired || /not (?:signed|logged) in|authentication required|^\\s*unauthori[sz]ed\\s*$|\\b401\\b|invalid (?:api[ -]?key|credentials?|token\\b(?!\\s+count\\b))|missing (?:api[ -]?key|credentials?|token\\b)|sign[ -]?in required/i.test(raw))",
    "if (false)"
  ],
  [
    "audit-p3-vendor-limit-remedy",
    "server/leader-common/plain-failure.ts",
    "if (/usage limit|rate[ _-]?limit|insufficient_quota|too many requests/i.test(raw) || (!/\\b(?:disk|storage)\\b/i.test(raw) && /\\b(?:usage|requests?|rate|api)\\b/i.test(raw) && /\\bquota (?:exceeded|reached)\\b/i.test(raw)))",
    "if (false)"
  ],
  [
    "audit-p3-codex-auth-remedy-call",
    "server/leader-codex.ts",
    "vendorRemedy(\"Codex\", error.message) ?? ",
    ""
  ],
  [
    "audit-p3-acp-auth-remedy-call",
    "server/leader-acp.ts",
    "vendorRemedy(name, message, error?.code === AUTH_REQUIRED) ?? ",
    ""
  ],
  [
    "audit-p3-trim-file-path",
    "server/leader.ts",
    "const path = value.trim();",
    "const path = value;"
  ],
  [
    "audit-p3-trim-glob-pattern",
    "server/leader.ts",
    "input.pattern.trim()",
    "input.pattern"
  ],
  [
    "audit-p3-vault-expansion-root",
    "server/leader.ts",
    "allowedRoots.find((root) => isInsideFolder(resolve(text), root))",
    "[tabFolder].find((root) => isInsideFolder(resolve(text), root))"
  ],
  [
    "audit-p3-acp-auth-code-only",
    "server/leader-acp.ts",
    "error?.code === AUTH_REQUIRED",
    "false"
  ],
  [
    "audit-p3-codex-notification-remedy",
    "server/leader-codex.ts",
    "CODEX_TURN_FAILED(\"error\", params.error?.message ?? \"\")",
    "CODEX_TURN_FAILED(\"error\")"
  ],
  [
    "audit-p3-codex-status-remedy",
    "server/leader-codex.ts",
    "CODEX_TURN_FAILED(\"status\", params.turn?.error?.message ?? \"\")",
    "CODEX_TURN_FAILED(\"status\")"
  ],
  [
    "audit-p3-codex-turn-start-remedy",
    "server/leader-codex.ts",
    "vendorRemedy(\"Codex\", (error as Error).message) ?? ",
    ""
  ],
  [
    "audit-p3-auth-token-boundary",
    "server/leader-common/plain-failure.ts",
    "token\\b(?!\\s+count\\b)",
    "token"
  ],
  [
    "audit-p3-auth-unauthorized-status",
    "server/leader-common/plain-failure.ts",
    "^\\s*unauthori[sz]ed\\s*$",
    "unauthori[sz]ed"
  ],
  [
    "audit-p3-usage-quota-context",
    "server/leader-common/plain-failure.ts",
    "if (/usage limit|rate[ _-]?limit|insufficient_quota|too many requests/i.test(raw) || (!/\\b(?:disk|storage)\\b/i.test(raw) && /\\b(?:usage|requests?|rate|api)\\b/i.test(raw) && /\\bquota (?:exceeded|reached)\\b/i.test(raw)))",
    "if (/usage limit|rate[ _-]?limit|quota (?:exceeded|reached)|insufficient_quota|too many requests/i.test(raw))"
  ]
];
