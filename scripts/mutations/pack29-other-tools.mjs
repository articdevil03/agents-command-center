// Server-side eligibility guards for user-added first-run tools.
export const pack29OtherToolsMutations = [
  ["p29-other-registration", "server/first-run/complete.ts", "acpClis.find((item) => acpKindOf(item) === cli)", "acpClis[0]"],
  ["p29-other-command-validation", "server/first-run/complete.ts", "const checked = validateAcpCli(registered);", "const checked = registered!;"],
  ["p29-other-path-check", "server/first-run/complete.ts", "resolveCliOrThrow(checked.program, process.env, [process.cwd(), folder]);", "void checked.program;"],
  ["p29-other-project-exclusion", "server/first-run/complete.ts", "resolveCliOrThrow(checked.program, process.env, [process.cwd(), folder]);", "resolveCliOrThrow(checked.program, process.env, process.cwd());"],
  ["p29-other-consent-server", "server/first-run/complete.ts", "if (message.acpConsent !== true) throw new Error", "if (false) throw new Error"],
  ["p29-other-chosen-leader", "server/first-run/complete.ts", "crewChoices: { leader }, autoAssign: true", 'crewChoices: { leader: { cli: "codex", model: "gpt-6.1-sol", effort: "low" } }, autoAssign: true'],
];
