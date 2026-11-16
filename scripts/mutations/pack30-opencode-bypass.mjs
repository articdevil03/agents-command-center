export const pack30OpenCodeBypassMutations = [
  ["p30-mode-before-patch","server/leader-opencode.ts","const previous = mode; mode = next;\n    try {\n      await ready;\n      await api(\"PATCH\", `/session/${sessionId}`, { permission: opencodeRules(next, deps.vaultPath?.()) });","const previous = mode;\n    try {\n      await ready;\n      await api(\"PATCH\", `/session/${sessionId}`, { permission: opencodeRules(next, deps.vaultPath?.()) });\n      mode = next;"],
  ["p30-bypass-asks", "server/leader-opencode/rules.ts", 'if (liveMode === "bypass") return "allow";', 'if (liveMode === "bypass") return "ask";'],
  ["p30-bypass-saved-asks", "server/leader-opencode.ts", 'opencodePermissionVerdict(deps.savedAsks?.() ? "ask" : mode, subagent,', 'opencodePermissionVerdict(mode, subagent,'],
  ["p30-main-auto-allow", "server/leader-opencode/rules.ts", 'return subagent ? decideByRules(opencodeRules(liveMode, vaultPath), permission, patterns) : "ask";', 'return subagent ? decideByRules(opencodeRules(liveMode, vaultPath), permission, patterns) : "allow";'],
];
export const pack30OpenCodeBypassCatchMap = Object.fromEntries(pack30OpenCodeBypassMutations.map(([id]) => [id, "test/pack30-opencode-bypass.test.ts"]));
