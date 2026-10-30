import type { PermissionMode } from "../settings.ts";

export const OPENCODE_CREW_SERVER = "tab-crew";
// OpenCode 1.18's own list of permissions that only look (checked in its binary: new Set(["read","glob","grep","list"])).
const READ_ONLY_PERMISSIONS = ["read", "glob", "grep", "list"];
type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };
// OpenCode evaluates the LAST matching rule, so the broad rule comes first and the specific ones override it.
export function opencodeRules(mode: PermissionMode): Rule[] {
  const crew: Rule = { permission: `${OPENCODE_CREW_SERVER}_*`, pattern: "*", action: "allow" };
  if (mode === "bypass") return [{ permission: "*", pattern: "*", action: "allow" }, crew];
  const rules: Rule[] = [{ permission: "*", pattern: "*", action: "ask" }];
  // Looking is free, as in Claude's default mode and in Codex; secrets files still ask. Anything else, outside folders included, asks.
  for (const permission of READ_ONLY_PERMISSIONS) rules.push({ permission, pattern: "*", action: "allow" });
  for (const pattern of ["*.env", "*.env.*"]) rules.push({ permission: "read", pattern, action: "ask" });
  if (mode === "accept") rules.push({ permission: "edit", pattern: "*", action: "allow" });
  if (mode === "plan") rules.push({ permission: "edit", pattern: "*", action: "deny" });
  rules.push(crew);
  return rules;
}

// OpenCode's wildcard: * matches any run of characters.
function wildcard(pattern: string, text: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(text);
}
// The last matching rule wins (as in OpenCode); no match asks.
export function decideByRules(rules: Rule[], permission: string, patterns: string[]): "allow" | "deny" | "ask" {
  const actions = (patterns.length ? patterns : ["*"]).map((pattern) => rules.filter((rule) => wildcard(rule.permission, permission) && wildcard(rule.pattern, pattern)).at(-1)?.action ?? "ask");
  return actions.includes("deny") ? "deny" : actions.every((action) => action === "allow") ? "allow" : "ask";
}
// A sub-agent session inherits only its parent's deny rules (checked in OpenCode 1.18's task tool), so left alone it runs on OpenCode's permissive defaults.
// This baseline makes every sub-agent request ask; the leader then answers each one by the tab's mode (see onPermission).
export const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { "*": "ask", read: { "*": "allow", "*.env": "ask", "*.env.*": "ask" }, glob: "allow", grep: "allow", list: "allow", [`${OPENCODE_CREW_SERVER}_*`]: "allow" },
});

// bash -> Bash, edit/write/patch -> Edit, anything else keeps its own name so the approval card says what it is.
export function opencodeApprovalRequest(permission: string, patterns: string[], metadata: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  if (permission === "bash") return { tool: "Bash", input: { command: patterns.join("\n"), ...metadata } };
  if (permission === "edit" || permission === "write" || permission === "patch") {
    const path = typeof metadata.filepath === "string" ? metadata.filepath : patterns[0];
    return { tool: "Edit", input: { file_path: path, patterns, ...metadata } };
  }
  return { tool: permission, input: { patterns, ...metadata } };
}

export function splitOpencodeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
