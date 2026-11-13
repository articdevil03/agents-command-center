import { review3Mutations } from "./review3.mjs";
import { neverLaunchedMutations } from "./review2-never-launched.mjs";
export const review2Mutations = [
  [
    "p26r6-unused-planner-abandon",
    "server/main/fixed-task-tools.ts",
    "const unusedPlanner = execution?.role === \"planner\"",
    "const unusedPlanner = false && execution?.role === \"planner\""
  ],
  [
    "p26r6-unused-planner-provenance",
    "server/main/fixed-task-tools.ts",
    "const acceptedPlanner = journalOnly && (execution.consumed || !!task?.coordinatorSessions.includes(runId));",
    "const acceptedPlanner = false;"
  ],
  [
    "p26r6-plan-budget-recovery",
    "server/fixed-crew/task-store.ts",
    "if (![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);",
    "if (event.type === \"plan\" || ![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);"
  ],
  [
    "p26r6-cancel-budget-recovery",
    "server/fixed-crew/task-store.ts",
    "if (![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);",
    "if (event.type === \"cancelRequest\" || ![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);"
  ],
  [
    "p26r6-reconcile-budget-recovery",
    "server/fixed-crew/task-store.ts",
    "if (![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);",
    "if (event.type === \"reconcile\" || ![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);"
  ],
  [
    "p26r6-recovery-no-positive-evidence",
    "server/fixed-crew/task-store.ts",
    "if (![\"plan\", \"cancelRequest\", \"reconcile\"].includes(event.type)) refresh(task);",
    "/* ordinary refresh removed */"
  ],
  [
    "p26r6-git-maintenance-foreground",
    "server/fixed-crew/git-process.ts",
    "\"-c\", \"gc.auto=0\", \"-c\", \"maintenance.auto=false\", ",
    ""
  ],
  [
    "p26r6-archive-accessible-name",
    "public/fixed-crew/task-archive-view.js",
    "          open.append(label, node(\"span\", \"fct-aopen\", \"Open\"));",
    "          open.append(label, node(\"span\", \"fct-aopen\", \"Open\"));\n          open.setAttribute(\"aria-label\", `Open finished task ${archive.id}`);"
  ],
  [
    "p26r6-archive-more-focus",
    "public/fixed-crew/task-events.js",
    "showing && [\"arch-heading\", \"arch-more\"].includes(focusKey) && added.length",
    "showing && added.length"
  ],
  [
    "p26r6-archive-invalid-reason",
    "public/fixed-crew/task-events.js",
    "if (!same) { read.unreadable = true; return false; }",
    "if (!same) return false;"
  ],
  [
    "p26r6-archive-held-detail",
    "public/fixed-crew/task-archive-view.js",
    "const box = region(tab, \"Finished task\", back(\"Back to finished tasks\", \"list\", \"arch-back-list\"), f,",
    "const box = region(tab, \"Finished task\", back(\"Back to finished tasks\", \"list\", \"arch-back-list\"), { ...f, blocked: false },"
  ],
  [
    "p26r6-archive-detail-text",
    "public/fixed-crew/task-archive-view.js",
    "dd.textContent = value",
    "dd.innerHTML = value"
  ],
  ...neverLaunchedMutations,
  ...review3Mutations,
];
