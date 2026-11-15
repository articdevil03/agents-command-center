// First-run server guards. Each literal target must match exactly once.
export const pack29FirstRunMutations = [
  [
    "p29-first-run-link-guard",
    "server/first-run/state.ts",
    "  recover();",
    "  if (!pristine) recover();"
  ],
  [
    "p29-first-run-empty-logs",
    "server/fixed-crew/recovery.ts",
    "return readdirSync(logs).length > 0;",
    "return existsSync(logs);"
  ],
  [
    "p29-first-run-unique-id",
    "server/first-run/complete.ts",
    "for (let suffix = 2; workspaces.projects.some((project) => project.id.toLowerCase() === id); suffix++) id = `${slug}-${suffix}`;",
    "void 0;"
  ],
  [
    "p29-first-run-cli-validation",
    "server/first-run/complete.ts",
    "typeof cli !== \"string\" || !Object.hasOwn(settingsService.state.tools, cli)",
    "typeof cli !== \"string\""
  ],
  [
    "p29-first-run-create",
    "server/first-run/state.ts",
    "publishConfigFile(JSON.stringify({ version: 1, status: \"pending\", createdAt: new Date().toISOString() }) + \"\\n\", firstRunPath);",
    "void 0;"
  ],
  [
    "p29-first-run-existing",
    "server/first-run/state.ts",
    "const pristine = !hasPriorAppData();",
    "const pristine = true;"
  ],
  [
    "p29-first-run-recovery",
    "server/first-run/state.ts",
    "const pristine = !hasPriorAppData();",
    "const pristine = !existsSync(workspacesPath);"
  ],
  [
    "p29-first-run-scaffold",
    "server/first-run/state.ts",
    "\"settings.json\", \"requests.json\", \"chats\",",
    "\"settings.json\", \"requests.json\", \"logs\", \"chats\","
  ],
  [
    "p29-first-run-resume",
    "server/first-run/state.ts",
    "if (firstRunMarker()?.status !== \"pending\" || !existsSync(workspacesPath)) return;",
    "if (firstRunMarker()?.status === \"pending\" && existsSync(workspacesPath)) finishFirstRun();\n  if (firstRunMarker()?.status !== \"pending\" || !existsSync(workspacesPath)) return;"
  ],
  [
    "p29-first-run-save-order",
    "server/main/messages/projects.ts",
    "syncWorkspace(draft);\n  try { options.afterSave?.(); }",
    "try { options.afterSave?.(); } finally { syncWorkspace(draft); }\n  try { void 0; }"
  ],
  [
    "p29-first-run-crash-recover",
    "server/first-run/state.ts",
    "workspaceHasRealProject(saved)",
    "false"
  ],
  [
    "p29-ready-server",
    "server/first-run/complete.ts",
    "if (tool.installed !== true || tool.signedIn !== true) {",
    "if (false) {"
  ],
  [
    "p29-ready-unknown",
    "server/first-run/complete.ts",
    "if (tool.installed !== true || tool.signedIn !== true) {",
    "if (tool.installed === false || tool.signedIn === false) {"
  ],
  [
    "p29-ready-leader",
    "server/first-run/complete.ts",
    "crewChoices: { leader }, autoAssign: true",
    "crewChoices: {}, autoAssign: true"
  ],
  [
    "p29-folder-validation",
    "server/first-run/complete.ts",
    "const folder = validateFolderPath(message.folder, \"project folder\");",
    "const folder = typeof message.folder === \"string\" && message.folder.includes(\"..\") ? message.folder.split(\"..\")[0] : message.folder;"
  ],
  [
    "p29-example-preservation",
    "server/first-run/complete.ts",
    "draft.projects.filter((project) => !exampleUntouched(project))",
    "draft.projects.filter((project) => !isSeededExample(project))"
  ],
  [
    "p29-state-field",
    "server/main/broadcast.ts",
    "firstRun: { required: firstRunRequired(workspaces) }",
    "firstRun: { required: true }"
  ],
  [
    "p29-blocked-gate",
    "server/main/fixed-crew.ts",
    "[\"completeFirstRun\", \"skipFirstRun\", \"addProject\",",
    "[\"addProject\","
  ],
  [
    "p29-first-run-skip-broadcast",
    "server/first-run/messages.ts",
    "assertFirstRunPending(); finishFirstRun(); broadcast(stateMessage());",
    "assertFirstRunPending(); finishFirstRun();"
  ],
  [
    "p29-first-run-example-folder",
    "server/first-run/state.ts",
    "&& resolve(project.folder) === folder && resolve(project.tabs[0].folder) === folder",
    "&& resolve(project.tabs[0].folder) === folder"
  ],
  [
    "p29-first-run-example-tabs",
    "server/first-run/state.ts",
    "project.tabs.length === 1 && ",
    ""
  ],
  [
    "p29-first-run-example-files",
    "server/first-run/complete.ts",
    "if ([join(chatStore.directory, \"example-development.jsonl\"), ...[\"tasks\", \"executions\"].map((dir) => join(dataRoot, dir, \"example-development.json\"))].some(existsSync)) return false;",
    "void 0;"
  ],
  [
    "p29-first-run-example-heal",
    "server/first-run/state.ts",
    "&& !workspaceHasRealProject(workspace)",
    ""
  ],
  [
    "p29-first-run-logs-link",
    "server/fixed-crew/recovery.ts",
    "  noLinks(logs);",
    "  // link guard removed"
  ]
];
