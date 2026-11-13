import { pack26FinalMutations } from "./pack26-final.mjs";
export const review3Mutations = [
  [
    "p26r8-reservation-duplicate",
    "server/main/fixed-task-launch.ts",
    "if (executionId && journal.executions.some((entry) => entry.id === executionId))",
    "if (false)"
  ],
  [
    "p26r8-prestart-reconcile",
    "server/main/fixed-task-tools.ts",
    "const refusedStart = !!task",
    "const refusedStart = false && !!task"
  ],
  [
    "p26r8-prestart-provenance",
    "server/main/fixed-task-tools.ts",
    "&& execution.status === \"failed\" && execution.processEnded",
    "&& execution.processEnded"
  ],
  [
    "p26r8-planner-consume-retry",
    "server/main/fixed-task-tools.ts",
    "if (task?.coordinatorSessions.includes(runId) && accepted?.tabId",
    "if (false && task?.coordinatorSessions.includes(runId) && accepted?.tabId"
  ],
  [
    "p26r8-planner-consume-setter",
    "server/main/fixed-task-tools.ts",
    "if (!accepted.consumed) consume(actor, runId);",
    "/* accepted consume setter removed */"
  ],
  [
    "p26r8-planner-consume-provenance",
    "server/main/fixed-task-tools.ts",
    "if (task?.coordinatorSessions.includes(runId) && accepted?.tabId",
    "if (task && accepted?.tabId"
  ],
  [
    "p26r8-archive-retry-focus",
    "public/fixed-crew/task-events.js",
    "else if (a.more.status === \"error\") { a.focus = \"arch-heading\";",
    "else if (a.more.status === \"error\") {"
  ],
  [
    "p26r8-archive-incomplete-reason",
    "public/fixed-crew/task-events.js",
    "if (!complete) { read.unreadable = true; return false; }",
    "if (!complete) { return false; }"
  ],
  [
    "p26r8-archive-deadline",
    "public/fixed-crew/task-events.js",
    "ARCHIVE_WAIT_MS = 20_000",
    "ARCHIVE_WAIT_MS = 40_000"
  ],
  [
    "p26r8-shutdown-unknown-gate",
    "server/index.ts",
    "if (!gitConfirmed || !workersConfirmed) { process.exit(1); return; }",
    "if (false) { process.exit(1); return; }"
  ],
  [
    "p26r8-shutdown-unknown-exit",
    "server/index.ts",
    "if (!gitConfirmed || !workersConfirmed) { process.exit(1); return; }",
    "if (!gitConfirmed || !workersConfirmed) { process.exit(0); return; }"
  ],
  [
    "p26r8-unused-planner-future",
    "server/main/fixed-task-tools.ts",
    "execution.planVersion >= 1 && execution.planVersion <= task.planVersion",
    "execution.planVersion >= 1"
  ],
  [
    "p26r8-never-settled-retry",
    "server/main/fixed-task-tools.ts",
    "const settled = cancelledTaskOnly(run);",
    "const settled = false;"
  ],
  [
    "p26r8-never-cold-launch-facts",
    "server/fixed-crew/task-store.ts",
    "taskOnly = !launched && action.status",
    "taskOnly = action.status"
  ],
  [
    "p26r8-never-cold-journal-facts",
    "server/fixed-crew/task-store.ts",
    "&& !journal.executions.some((run) => run.id === action.id)\n              && !journal.activeExecutionId",
    ""
  ],
  [
    "p26r8-journal-field-validation",
    "server/fixed-crew/task-execution.ts",
    "    if (execution.taskId !== null) id(execution.taskId);\n    if (!Number.isSafeInteger(execution.planVersion) || execution.planVersion < (execution.taskId === null ? 0 : 1)) throw new Error(\"Invalid journal execution version.\");\n    for (const role of [execution.role, execution.selectedSlot]) enumeration(role, FIXED_CREW.map((slot) => slot.slot));\n    enumeration(execution.kind, [...ACTIONS, \"planning\", \"triage\"]); text(execution.selectionReason);\n    if (execution.logPath !== null) text(execution.logPath);\n    validateAssignment(execution.assignment);\n    enumeration(execution.status, [\"reserved\", \"running\", \"done\", \"failed\", \"interrupted\"]);\n    enumeration(execution.processEnded, [true, false]); enumeration(execution.consumed, [true, false]);\n  }\n  if (new Set(journal.executions.map((entry) => entry.id)).size !== journal.executions.length) throw new Error(\"Duplicate journal execution.\");\n",
    "    validateAssignment(execution.assignment);\n    enumeration(execution.status, [\"reserved\", \"running\", \"done\", \"failed\", \"interrupted\"]);\n    enumeration(execution.processEnded, [true, false]); enumeration(execution.consumed, [true, false]);\n  }\n"
  ],
  [
    "p26r8-git-maintenance-native",
    "server/fixed-crew/git-process.ts",
    "\"maintenance.auto=false\"",
    "\"maintenance.auto=true\""
  ],
  ...pack26FinalMutations
];
