// Intentionally overrides the older root retention mapping via SERVER_PROOFS.
// The existing row is retained; the exact repaint test now observes every detach.
import { FINAL_PROOFS } from "./tooling-sweep-proof-final.ts";
export const REVIEW3_PROOFS: Record<string, [string, string]> = {
  "p26r8-reservation-duplicate": [
    "test/pack26-review3-server.test.ts",
    "^P26R8S duplicate journal admission refuses before publication$"
  ],
  "p26r8-prestart-reconcile": [
    "test/pack26-review3-server.test.ts",
    "^P26R8S refused start explicitly reconciles without replay$"
  ],
  "p26r8-prestart-provenance": [
    "test/pack26-review3-server.test.ts",
    "^P26R8S refused start recovery keeps contradictory admissions held$"
  ],
  "p26r8-planner-consume-retry": [
    "test/pack26-review3-planner.test.ts",
    "^P26R8S accepted Planner consumption retry$"
  ],
  "p26r8-planner-consume-setter": [
    "test/pack26-review3-planner.test.ts",
    "^P26R8S accepted Planner consumption retry persists$"
  ],
  "p26r8-planner-consume-provenance": [
    "test/pack26-review3-planner.test.ts",
    "^P26R8S Planner consumption retry requires accepted provenance$"
  ],
  "p26r8-archive-retry-focus": [
    "test/pack26-review3-page.test.ts",
    "^P26R8P Show more retry preserves keyboard continuation$"
  ],
  "p26r8-archive-incomplete-reason": [
    "test/pack26-review3-page.test.ts",
    "^P26R8P incomplete detail deadline reason$"
  ],
  "p26r8-archive-deadline": [
    "test/fixed-crew-task-archives-polish.test.ts",
    "^FCARCH unanswered read$"
  ],
  "p26r8-shutdown-unknown-gate": [
    "test/electron-navigation.test.ts",
    "^server shutdown is idempotent and unknown Git drain refuses successful exit and taskkill$"
  ],
  "p26r8-shutdown-unknown-exit": [
    "test/electron-navigation.test.ts",
    "^server shutdown is idempotent and unknown Git drain refuses successful exit and taskkill$"
  ],
  "p26r8-unused-planner-future": [
    "test/pack26-review2-recovery.test.ts",
    "^P26R6R unrelated future and invalid Planner versions stay held$"
  ],
  "p26r8-never-settled-retry": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N durable cancellation response failure and stale continuation$"
  ],
  "p26r8-never-cold-launch-facts": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N cold persisted launch contradiction interrupts the stage$"
  ],
  "p26r8-never-cold-journal-facts": [
    "test/pack26-review3-never-launched.test.ts",
    "^P26R8N cold journal admissions keep the stage interrupted$"
  ],
  "p26r8-journal-field-validation": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N malformed retained journal facts cannot prove no admission$"
  ],
  "p26r8-git-maintenance-native": [
    "test/pack26-review1-run2-native.test.ts",
    "^P26R8G native automatic maintenance stays disabled$"
  ],
  "p26r2c-git-safe-options": ["test/pack26-review1-run2-git.test.ts", "^P26R2G await executable cwd options responsive real socket and production spawn$"],
  "fcbui-task-panel-retained": [
    "test/frontend-messages.test.ts",
    "^a tab whose saved chat cannot be read says why its chat is empty, in the existing failed-status look$"
  ],
  ...FINAL_PROOFS
};
