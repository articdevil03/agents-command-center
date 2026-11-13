export const neverLaunchedMutations = [
  [
    "p26r7-never-dispatch",
    "server/main/fixed-task-tools.ts",
    "const cancelled = cancelUnlaunchedTask(actor, task, runId, reason, journal);",
    "const cancelled = null;"
  ],
  [
    "p26r7-never-legacy-interrupted",
    "server/fixed-crew/task-transitions.ts",
    "execution.status === \"reserved\" || interruptedCancellation && execution.status === \"interrupted\"",
    "execution.status === \"reserved\""
  ],
  [
    "p26r7-never-normalization-stage",
    "server/fixed-crew/task-store.ts",
    "if (!taskOnly) stageInterrupted = true;",
    "stageInterrupted = true;"
  ],
  [
    "p26r7-never-cancel-publication",
    "server/fixed-crew/task-store.ts",
    "      publish(result.task);",
    "      if (event.type !== \"cancelRequest\") publish(result.task);"
  ],
  [
    "p26r7-never-stage-release",
    "server/fixed-crew/task-transitions.ts",
    "      if (interruptedCancellation && next.stage === \"interrupted\" && !next.executions.some((e) => [\"reserved\", \"running\", \"interrupted\"].includes(e.status) || e.processEnd !== \"confirmed\" || e.status === \"success\" && !e.verified)) next.stage = \"planned\";",
    "      // cancellation stage recovery suppressed"
  ],
  [
    "p26r7-never-completion",
    "server/fixed-crew/task-journal-archive.ts",
    "&& authenticTaskRequest(task, run) && !taskOnlyResultProvenance(task, run)) continue;",
    "&& false) continue;"
  ],
  [
    "p26r7-never-request-proof",
    "server/main/fixed-task-tools.ts",
    "if (!authenticTaskRequest(task, run)) throw",
    "if (false) throw"
  ],
  [
    "p26r7-never-live-journal",
    "server/main/fixed-task-tools.ts",
    "if (journal.executions.some((entry) => entry.id === runId)) return null;",
    "if (false) return null;"
  ],
  [
    "p26r7-never-archive",
    "server/main/fixed-task-tools.ts",
    "if (!archiveAbsent) throw",
    "if (false) throw"
  ],
  [
    "p26r7-never-runtime",
    "server/main/fixed-task-tools.ts",
    "if (taskOnlyRuntimeBlocked(actor.tabId, runId, root)) throw",
    "if (false) throw"
  ],
  [
    "p26r7-never-location",
    "server/main/fixed-task-tools.ts",
    "  if (fixedTasks !== store || dataRoot !== root || tabLocation(actor.tabId)?.tab !== tab || tab.folder !== folder\n    || !isFixedTab(tab) || JSON.stringify(tab.fixedCrew) !== fixedSnapshot || leaders.get(actor.tabId) !== leader || !isCurrentFixedLeader(actor)\n    || JSON.stringify(store.get(actor.tabId)) !== JSON.stringify(task)) throw new Error(\"Captured task-only authority or location changed.\");",
    "  if (false) throw new Error(\"Captured task-only authority or location changed.\");"
  ],
  [
    "p26r7-never-positive-result",
    "server/main/fixed-task-tools.ts",
    "if (taskOnlyResultProvenance(task, run)) throw",
    "if (false) throw"
  ],
  [
    "p26r7-never-journal-facts",
    "server/main/fixed-task-tools.ts",
    "const diskJournal = readJournalSnapshot(root, actor.tabId);",
    "const diskJournal = journal;"
  ]
];
