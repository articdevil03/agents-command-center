import { REVIEW3_PROOFS } from "./tooling-sweep-proof-review3.ts";
import { NEVER_LAUNCHED_PROOFS } from "./tooling-sweep-proof-never-launched.ts";
export const REVIEW2_PROOFS: Record<string, [string, string]> = {
  "guard-disconnected-startup": ["test/electron-navigation.test.ts", "^server disconnect handler and startup parent-loss check stop the process tree$"],
  "guard-server-disconnect": ["test/electron-navigation.test.ts", "^server disconnect handler and startup parent-loss check stop the process tree$"],
  "guard-server-disconnect-tree": ["test/electron-navigation.test.ts", "^server disconnect handler and startup parent-loss check stop the process tree$"],
  "guard-server-disconnect-tree-flag": ["test/electron-navigation.test.ts", "^server disconnect handler and startup parent-loss check stop the process tree$"],
  "guard-server-ipc-shutdown": ["test/electron-navigation.test.ts", "^Electron's real shutdown message drives the server IPC handler$"],
  "guard-server-ipc-message": ["test/electron-navigation.test.ts", "^Electron's real shutdown message drives the server IPC handler$"],
  "guard-server-shutdown-workers": ["test/electron-navigation.test.ts", "^server signal shutdown stops tab leaders and workers, closes every connection, then exits$"],
  "guard-server-shutdown-leader": ["test/electron-navigation.test.ts", "^server signal shutdown stops tab leaders and workers, closes every connection, then exits$"],
  "guard-server-shutdown-http": ["test/electron-navigation.test.ts", "^server signal shutdown stops tab leaders and workers, closes every connection, then exits$"],
  "guard-server-shutdown-connections": ["test/electron-navigation.test.ts", "^server signal shutdown stops tab leaders and workers, closes every connection, then exits$"],
  "guard-server-shutdown-websocket": ["test/electron-navigation.test.ts", "^server signal shutdown stops tab leaders and workers, closes every connection, then exits$"],
  "guard-data-root-config-call-site": ["test/data-root.test.ts", "^config.ts: a packaged data root actually drives workspace and legacy config paths$"],
  "p26r6-unused-planner-abandon": [
    "test/pack26-review2-recovery.test.ts",
    "^P26R6R unused Planner abandonment$"
  ],
  "p26r6-unused-planner-provenance": [
    "test/pack26-review2-recovery.test.ts",
    "^P26R6R accepted Planner cannot be abandoned$"
  ],
  "p26r6-plan-budget-recovery": [
    "test/pack26-review2-budget.test.ts",
    "^P26R6H replan oversized old coverage$"
  ],
  "p26r6-cancel-budget-recovery": [
    "test/pack26-review2-budget.test.ts",
    "^P26R6H cancel oversized old coverage$"
  ],
  "p26r6-reconcile-budget-recovery": [
    "test/pack26-review2-budget.test.ts",
    "^P26R6H reconcile oversized old coverage$"
  ],
  "p26r6-recovery-no-positive-evidence": [
    "test/pack26-review2-budget.test.ts",
    "^P26R6H ordinary evidence remains fingerprinted$"
  ],
  "p26r6-git-maintenance-foreground": [
    "test/pack26-review2-git.test.ts",
    "^P26R6G automatic maintenance disabled spawn contract$"
  ],
  "p26r6-archive-accessible-name": [
    "test/pack26-review2-page.test.ts",
    "^P26R6P archive accessible row name$"
  ],
  "p26r6-archive-more-focus": [
    "test/pack26-review2-page.test.ts",
    "^P26R6P late page preserves composer focus$"
  ],
  "p26r6-archive-invalid-reason": [
    "test/pack26-review2-page.test.ts",
    "^P26R6P invalid detail deadline reason$"
  ],
  "p26r6-archive-held-detail": [
    "test/pack26-review2-page.test.ts",
    "^P26R6P held archive detail notice$"
  ],
  "p26r6-archive-detail-text": [
    "test/fixed-crew-task-archives-page.test.ts",
    "^FCARCH hostile text:"
  ],
  ...NEVER_LAUNCHED_PROOFS,
  ...REVIEW3_PROOFS
};
