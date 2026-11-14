import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mutations, controlMutations, SYNTAX_CHECKED } from "../scripts/mutation-proof.mjs";
import { createLane, removeTree, writeVerified } from "../scripts/sweep/lanes.mjs";
import { lowerOwnPriority, runTests, SWEEP_PRIORITY } from "../scripts/sweep/run.mjs";
import { PAGE_PROOFS } from "./tooling-sweep-proof-page.ts";
import { BROWSER_PROOFS } from "./tooling-sweep-proof-browser.ts";
import { SERVER_PROOFS } from "./tooling-sweep-proof-server.ts";
import { PACK27_PROOFS } from "./tooling-sweep-proof-pack27.ts";

// Explicit safe mappings. Ownership guards select pure cases; run guards select fake process seams.
const PROOFS: Record<string, [string, string]> = {
  "fcbui-status-blocked": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-task-panel-retained": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-lost-lock": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-send": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-pending": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-disabled": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-confirm": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-result-identity": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-status-selection": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-status-fresh": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcbui-status-rough": ["test/fixed-crew-bulk-page.test.ts", "^FCBUI "],
  "fcb-stale": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-confirm": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-busy": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-assignment-setter": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-installed": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-extras": ["test/fixed-crew-bulk-assignment.test.ts", "^FCB "],
  "fcb-publish": ["test/fixed-crew-bulk-messages.test.ts", "^FCBM "],
  "fcb-dispatch": ["test/fixed-crew-bulk-messages.test.ts", "^FCBM "],
  ...PAGE_PROOFS,
  ...BROWSER_PROOFS,
  ...SERVER_PROOFS,
  ...PACK27_PROOFS,
  "p18-bridge-per-run": ["test/pack18-orchestrator.test.ts", "^O1 one bridge"],
  "b5-fixed-launcher": ["test/pack18-orchestrator.test.ts", "^O3 "],
  "guard-leader-launch-notifies": ["test/pack18-orchestrator.test.ts", "^O3 "],
  "guard-launch-notice-queue": ["test/pack18-orchestrator.test.ts", "^O3 "],
  "guard-launch-notice-replay": ["test/pack18-orchestrator.test.ts", "^O3 "],
  "guard-launch-safety-writer": ["test/pack18-orchestrator.test.ts", "^O3 "],
  "guard-leader-kill-lock-checked": ["test/pack18-orchestrator.test.ts", "^O4 Stop on"],
  "guard-leader-kill-lock-set": ["test/pack18-orchestrator.test.ts", "^O4 killRun"],
  "guard-approval-iterator-end-callback": ["test/pack18-orchestrator.test.ts", "^O4 Stop all"],
  "b5-fixed-plan-refusal": ["test/pack18-orchestrator.test.ts", "^O5 "],
  "b5-fixed-heavy-gate": ["test/pack18-orchestrator.test.ts", "^O7 "],
  "p18-budget-per-tab": ["test/pack18-orchestrator.test.ts", "^O8 "],
  "p18-budget-limit": ["test/pack18-orchestrator.test.ts", "^O8 "],
  "guard-launch-budget-setter": ["test/pack18-orchestrator.test.ts", "^O8 "],
  "p18-set-stamp-push": ["test/pack18-orchestrator.test.ts", "^O8 "],
  "guard-leader-launch-brake": ["test/pack18-orchestrator.test.ts", "^O8 "],
  "p18-set-run-records": ["test/pack18-orchestrator.test.ts", "^O9/S13 "],
  "p18-set-log-path": ["test/pack18-orchestrator.test.ts", "^O9/S13 "],
  "p18-set-record-status": ["test/pack18-orchestrator.test.ts", "^O9/S13 "],
  "fc4-partial-backup-repair": ["test/fixed-crew-recovery-failures.test.ts", "^FC4F "],
  "fc4-source-change-gate": ["test/fixed-crew-recovery-failures.test.ts", "^FC4F "],
  "fc4-requests-preserved": ["test/fixed-crew-recovery-launch.test.ts", "^FC4L "],
  "fc4-backup-copy": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-backup-hash": ["test/fixed-crew-recovery-failures.test.ts", "^FC4F "],
  "fc4-fresh-publication": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-recovery-complete": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-workspace-write-gate": ["test/fixed-crew-recovery-launch.test.ts", "^FC4L "],
  "fc4-task-action-gate": ["test/fixed-crew-recovery-launch.test.ts", "^FC4L "],
  "fc4-worker-launch-gate": ["test/fixed-crew-recovery-launch.test.ts", "^FC4L "],
  "fc4-leader-launch-gate": ["test/fixed-crew-recovery-launch.test.ts", "^FC4L "],
  "fc4-old-format-detection": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-old-format-call": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-fresh-identity-setter": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fc4-fresh-id-collision": ["test/fixed-crew-recovery.test.ts", "^FC4 "],
  "fcx-historical-seat-setter": ["test/fixed-crew-continuation.test.ts", "^FCXC clearing"],
  "guard-leader-launch-rejects-self": ["test/round2-leader-launch-health.test.ts", "^leaderLaunchSeat: Atlas cannot launch the tab leader as a worker$"],
  "guard-leader-launch-rejects-unknown": ["test/round2-leader-launch-health.test.ts", "^leaderLaunchSeat: an unknown crew slot is refused$"],
  "guard-runseat-startrun-only-on-success": ["test/fixed-crew-launch.test.ts", "^FCX a rejected real runner"],
  "rw-role-instruction": ["test/pack18-rw-launch.test.ts", "^D6 "],
  "rw-researcher-web": ["test/pack18-rw-launch.test.ts", "^D8 "],
  "fcx-launch-call": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-manual-route": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-leader-authority": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-assignment-call": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-reservation-setter": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-action-call": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-runtime-route": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-role-prompt-call": ["test/pack18-rw-launch.test.ts", "^D6 "],
  "fcx-reviewer-selection-setter": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-checkpoint-verification": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-shipping-call": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-priority-spawn-call": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-priority-boundary-call": ["test/fixed-crew-launch.test.ts", "^FCX "],
  "fcx-report-acceptance-call": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-triage-acceptance-call": ["test/fixed-crew-tools.test.ts", "^FCXT "],
  "fcx-tree-gate": ["test/fixed-crew-execution-recovery.test.ts", "^FCXR "],
  "fcx-tree-setter": ["test/fixed-crew-execution-recovery.test.ts", "^FCXR "],
  "fcx-report-run": ["test/fixed-crew-review-evidence.test.ts", "^FCXE "],
  "fcx-report-success": ["test/fixed-crew-review-evidence.test.ts", "^FCXE "],
  "fcx-restart-no-replay": ["test/fixed-crew-execution-recovery.test.ts", "^FCXR "],
  "fct-restart-unverified": ["test/fixed-crew-task-store.test.ts", "^FCS3 "],
  "fct-read-evidence": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-replay-conflict": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-record-setter": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-link-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-verify-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-checkpoint-setter": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-rough-revision-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-design-fix-route": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-design-review-route": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-final-coverage": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-plan-version": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-final-setter": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-owner-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-rough-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-stage-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-triage-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-review-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-check-setter": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-disk-write": ["test/fixed-crew-task-store.test.ts", "^FCS3 "],
  "fct-restart-interrupted": ["test/fixed-crew-task-store.test.ts", "^FCS3 "],
  "fct-owner-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-rough-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-review-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-fix-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-final-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-triage-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-checkpoint-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-session-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-checks-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-interrupted-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-revision-gate": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-actor-authority": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-actor-role": ["test/fixed-crew-task-plan.test.ts", "^FCP "],
  "fct-post-final-route": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-minimal-route": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-batch-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-content-hash": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-evidence-gate": ["test/fixed-crew-task-gates.test.ts", "^FCG "],
  "fct-evidence-identity": ["test/fixed-crew-task-state.test.ts", "^FCT "],
  "fct-recovery-backup": ["test/fixed-crew-task-store.test.ts", "^FCS3 "],
  "fctui-details-identity": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-pending-setter": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-approval-call": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-disabled-listener": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-text-literal": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-reconnect-reread": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fctui-panel-hook": ["test/fixed-crew-task-page.test.ts", "^FCTUI "],
  "fcs-saved-cli": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-advisor-list": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-acp-use": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-acp-future": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-create-boundary": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-future-preserve": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-recovery-backup": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-legacy-empty": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-manual-inventory": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-model-list": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-effort-list": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-leader-active": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-inventory-hook": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-keys": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-slot": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-version": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-preference-read": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-manual-setter": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-auto-refill": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-extra-setter": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-extra-reset": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-extra-limit": ["test/fixed-crew-settings.test.ts", "^FCS "],
  "fcs-selected-tab": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-busy": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-write-setter": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-publish-order": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-dispatch-boundary": ["test/fixed-crew-messages.test.ts", "^FCS "],
  "fcs-prompt-core": ["test/fixed-crew-role-prompts.test.ts", "^FCS "],
  "fc-installed-true": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-preserve-user": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-empty-stays-null": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-single-cli": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-preferred-choice": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-assignment-setter": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-null-run-refused": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-codex-xhigh": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-review-company": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-reviewer-alternation": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-model-default-order": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-acp-last": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "fc-keep-preferred-cli": ["test/fixed-crew-assignment.test.ts", "^FC "],
  "guard-p25-preabort-spawn": ["test/tooling-sweep-run-order.test.ts", "^P25 "],
  "guard-p25-timeout-late": ["test/tooling-sweep-run-order.test.ts", "^P25 "],
  "guard-p25-stop-root": ["test/tooling-sweep-run-order.test.ts", "^P25 "],
  "guard-p25-stop-late": ["test/tooling-sweep-run-order.test.ts", "^P25 "],
  "guard-p24-cleanup-budget": ["test/tooling-temp-cleanup.test.ts", "^P24 budget and retry"],
  "guard-p24-cleanup-retry": ["test/tooling-temp-cleanup.test.ts", "^P24 budget and retry"],
  "guard-p24-cleanup-exit-setter": ["test/tooling-temp-cleanup.test.ts", "^P24 permanent lock"],
  "guard-p24-cleanup-marker": ["test/tooling-temp-cleanup.test.ts", "^P24 permanent lock"],
  "guard-p24-cleanup-root-link": ["test/tooling-temp-cleanup.test.ts", "^P24 linked root"],
  "guard-p24-cleanup-no-follow": ["test/tooling-temp-cleanup.test.ts", "^P24 nested junction"],
  "guard-p24-cleanup-directory": ["test/tooling-temp-cleanup.test.ts", "^P24 immediate success"],
  "guard-p24-cleanup-continue-siblings": ["test/tooling-temp-cleanup.test.ts", "^P24 locked child"],
  "guard-p24-cleanup-temp-root-call": ["test/tooling-temp-cleanup.test.ts", "^P24 tempRoot registered"],
  "guard-p24-cleanup-scratch-call": ["test/tooling-temp-cleanup.test.ts", "^P24 scratchDir registered"],
  "guard-p24-cleanup-overlap-call": ["test/tooling-temp-cleanup.test.ts", "^P24 overlap actual"],
  "guard-p24-cleanup-dist-call": ["test/tooling-temp-cleanup.test.ts", "^P24 dist actual"],
  "guard-p24-cleanup-dist-status": ["test/tooling-temp-cleanup.test.ts", "^P24 dist actual"],
  "guard-p24-cleanup-icon-call": ["test/tooling-temp-cleanup.test.ts", "^P24 icon partial"],
  "guard-p24-cleanup-pack1-call": ["test/tooling-temp-cleanup.test.ts", "^P24 pack1 actual"],
  "guard-p24-cleanup-pack2-call": ["test/tooling-temp-cleanup.test.ts", "^P24 pack2 actual"],
  "guard-p24-cleanup-health-call": ["test/tooling-temp-cleanup.test.ts", "^P24 health actual"],
  "guard-p24-cleanup-any-cli-call": ["test/tooling-temp-cleanup.test.ts", "^P24 any-cli actual"],
  "guard-p24-cleanup-acp-call": ["test/tooling-temp-cleanup.test.ts", "^P24 acp actual"],
  "guard-p24-cleanup-lanes-call": ["test/tooling-temp-cleanup.test.ts", "^P24 lanes actual"],
  "guard-p24-cleanup-run-call": ["test/tooling-temp-cleanup.test.ts", "^P24 run actual"],
  "guard-sweep-confirm-live-flakes": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-quiet-error": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-call": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-file": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-name": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-flakes": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-pending": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-error": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-scope": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-canary": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-quiet": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-evidence": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-r1-reused-root": ["test/tooling-sweep-proctree.test.ts", "^R1 watchTree registration"],
  "guard-sweep-r1-root-first-sight": ["test/tooling-sweep-proctree.test.ts", "^R1 recordTree never replaces"],
  "guard-sweep-r1-exited-root": ["test/tooling-sweep-run.test.ts", "^R1 fake runner passes root"],
  "guard-sweep-r1-signal-root": ["test/tooling-sweep-run.test.ts", "^R1 fake runner passes root"],
  "guard-sweep-r1-top-level-not-leaked": ["test/tooling-sweep-lanes.test.ts", "^R1 resyncLane removes and reports"],
  "guard-sweep-r1-kill-targets": ["test/tooling-sweep-proctree.test.ts", "^R1 killTracked calls only"],
  "guard-sweep-r1-render-timeout": ["test/tooling-render-wait.test.ts", "^R1 waitForFirstRender forwards"],
  "guard-sweep-r1-cleanup-kill-retry": ["test/tooling-sweep-main.test.ts", "^R1 cleanup kills a lane"],
  "guard-sweep-r1-top-level": ["test/tooling-sweep-lanes.test.ts", "^R1 resyncLane removes and reports"],
  "guard-sweep-record-survivor": ["test/tooling-sweep-main.test.ts","^a survivor does not"],
  "guard-sweep-strip-cc-data-dir": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-mutation-sweep-final-cleanup-retry": ["test/tooling-sweep-lanes.test.ts","^C1 removal retry"],
  "guard-packc-r2-test-root-postcheck": ["test/tooling-sweep-row.test.ts","^a leak after"],
  "guard-sweep-startup-only-own-prefix": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-red-checked-at-call-site": ["test/tooling-sweep-row.test.ts","^a failure that is not"],
  "guard-sweep-leak-never-makes-red": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-baseline-green": ["test/tooling-sweep-main.test.ts","^baseline: red twice"],
  "guard-sweep-timeout-reported": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-private-temp": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-sweep-scoped-run-strips-env": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-wholesuite-run-strips-env": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-sweep-cleanup-matches-own-folder": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-cleanup-matches-temp-folder": ["test/tooling-sweep-proctree.test.ts","^(planKill|pid reuse)"],
  "guard-sweep-cleanup-excludes-own-shell": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-cleanup-no-port-kill": ["test/tooling-sweep-proctree.test.ts","^killTracked on a refusal"],
  "guard-sweep-parse-check": ["test/tooling-sweep-row.test.ts","^a mutation that breaks"],
  "guard-sweep-dollar-literal": ["test/tooling-sweep-row.test.ts","^the canary"],
  "guard-sweep-single-match": ["test/tooling-sweep-row.test.ts","^a mutation that breaks"],
  "guard-sweep-filter-list": ["test/tooling-sweep-main.test.ts","^a name part"],
  "guard-sweep-filter-unmatched-rejected": ["test/tooling-sweep-main.test.ts","^a filter part"],
  "guard-sweep-cleanup-failure-throws": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-final-cleanup-failure-releases-lock": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-final-cleanup-failure-keeps-evidence": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-final-cleanup-failure-keeps-earlier-error": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-restores-mutated-file": ["test/tooling-sweep-row.test.ts","^C1 restore call"],
  "guard-sweep-evidence-renamed": ["test/tooling-sweep-main.test.ts","^a finished all-RED"],
  "guard-sweep-evidence-kept": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-sigint-flag": ["test/tooling-sweep.test.ts","^the first Ctrl-C"],
  "guard-sweep-interrupt-checked": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-finished-removes-folder": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-lock-released": ["test/tooling-sweep-main.test.ts","^lowerOwnPriority"],
  "guard-sweep-temp-removed": ["test/tooling-sweep-lanes.test.ts","^removeLane"],
  "guard-sweep-temp-cleared-at-start": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-temp-clear-only-own-prefix": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-temp-outside-repo": ["test/tooling-sweep-lanes.test.ts","^createLane copies"],
  "guard-sweep-plan-self": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-parent": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-grandparent": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-older": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-missing-self": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-record-younger": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-record-reused-parent": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-record-dead-parent": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-register-root": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-cleanup-every-run": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-early-stop-cleanup": ["test/tooling-sweep-run-order.test.ts", "^P25 "],
  "guard-sweep-final-cleanup-propagates": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-only-assertion-early-stop": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-record-and-continue": ["test/tooling-sweep-main.test.ts","^a survivor does not"],
  "guard-sweep-survivor-setter": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-survived-exit": ["test/tooling-sweep-report.test.ts","^exit code"],
  "guard-sweep-error-exit": ["test/tooling-sweep-report.test.ts","^exit code"],
  "guard-sweep-selected-positive": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-reported-count": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-reported-unique": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-selected-names": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-canary-red": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-control-survives": ["test/tooling-sweep-report.test.ts","^control rows"],
  "guard-sweep-walker-bounds": ["test/tooling-sweep-lanes.test.ts","^removeTree refuses"],
  "guard-sweep-walker-no-follow": ["test/tooling-sweep-lanes.test.ts","^removeTree removes a junction"],
  "guard-sweep-slot-budget": ["test/tooling-sweep-lanes.test.ts","^createSlots hands"],
  "guard-sweep-quiet-exclusion": ["test/tooling-sweep-row.test.ts","^survivor re-check"],
  "guard-sweep-restored-catching-only": ["test/tooling-sweep-row.test.ts","^a catching scoped"],
  "guard-sweep-own-priority-call": ["test/tooling-sweep-main.test.ts","^lowerOwnPriority"],
  "guard-sweep-child-priority-call": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-stop-detection": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-stop-consumption": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-stop-setter": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-until-setter": ["test/tooling-sweep.test.ts","^--until stops"],
  "guard-sweep-second-sigint": ["test/tooling-sweep.test.ts","^the first Ctrl-C"],
  "guard-sweep-resume-head": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-dirty": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-vanished": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-complete": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-never-checked-scheduling": ["test/tooling-sweep-main.test.ts","^never-checked"],
  "guard-sweep-incomplete-no-map": ["test/tooling-sweep.test.ts","^a stop after the last"],
  "guard-sweep-failed-no-map": ["test/tooling-sweep-main.test.ts","^C1 failed controls"],
  "guard-sweep-controls-no-map": ["test/tooling-sweep-main.test.ts","^a control row"],
};

const root = fileURLToPath(new URL("..", import.meta.url));
const selection = process.env.CC_SWEEP_PROOF_ROW;
const lf = (text: string) => text.replaceAll("\r\n", "\n");
const passedNames = (log: string) => [...log.matchAll(/^✔ (.+) \([\d.]+m?s\)$/gm)].map((match) => match[1]);

// Only the copy is mutated. Imports above keep the controller and its cleanup on trusted real source.
// No main(), startup cleanup, calibration, full baseline or survivor fallback is reachable here.
test("C1 scoped mutation proof", { skip: !selection && "CC_SWEEP_PROOF_ROW unset: expensive proof explicitly skipped" }, async () => {
  const name = selection!;
  const entries = [...mutations, ...controlMutations].filter(([row]) => row === name);
  assert.equal(entries.length, 1, `proof failure: unknown or duplicate row ${name} (${entries.length})`);
  const mapped = name === "control-must-survive" ? ["test/tooling-sweep-main.test.ts", "^lowerOwnPriority"] : PROOFS[name];
  assert.ok(mapped, `proof failure: missing explicit mapping for ${name}`);
  const [file, pattern] = mapped;
  const [_, target, from, to] = entries[0];
  const original = readFileSync(join(root, target));
  const text = lf(original.toString("utf8"));
  assert.ok(from.length > 0, `${name}: empty target`);
  assert.equal(text.split(from).length - 1, 1, `${name}: missing or multiple target matches in ${target}`);
  const mutated = text.replace(from, () => to);
  assert.notEqual(mutated, text, `${name}: mutation must change bytes`);
  const parse = (source: string) => {
    if (!SYNTAX_CHECKED.has(extname(target))) return; // an HTML target is not JavaScript: its order is checked by the mapped test
    const input = target.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
    const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${name}: parse failure, never a catch: ${result.stderr}`);
  };
  parse(text); parse(mutated);
  const priority = lowerOwnPriority();
  assert.equal(priority, SWEEP_PRIORITY);
  const lane = createLane(root, ["scripts", "test", "server", "public", "electron", "package.json"], 1);
  mkdirSync(join(lane.dir, "config")); // the HTTP tests copy config/ into their own temp root; the live files are never copied into the lane
  const files = [`--test-name-pattern=${pattern}`, file];
  let sequence = 0;
  const run = async (red: boolean, earlyStop: boolean) => {
    // The test-name option is deliberately passed with the sole mapped file, never with a glob.
    const logPath = join(lane.temp, `proof-${++sequence}.log`);
    const result = await runTests({ lane, files, red, earlyStop, concurrency: 1, timeoutMs: 90_000, logPath });
    const log = readFileSync(logPath, "utf8");
    const count = Math.max(passedNames(log).length + result.failures.length, result.catching ? 1 : 0);
    assert.ok(count > 0, `${name}: proof failure: zero executed tests\n${log}`);
    return { result, log, count };
  };
  let restoreVerified = false;
  try {
    const baseline = await run(false, false);
    assert.equal(baseline.result.outcome, "pass", `${name}: unrelated unmutated failure\n${baseline.log}`);
    console.log(`BASELINE ${name}: GREEN ${file}, executed=${baseline.count}`);
    const expectedNames = new Set(passedNames(baseline.log));
    assert.ok(expectedNames.size > 0, `${name}: baseline did not execute a mapped assertion`);
    let caught;
    try {
      writeVerified(lane, target, mutated);
      assert.equal(lf(readFileSync(join(lane.dir, target), "utf8")), mutated, `${name}: mutation write verified`);
      caught = await run(true, true);
    } finally {
      writeVerified(lane, target, original);
      assert.deepEqual(readFileSync(join(lane.dir, target)), original, `${name}: byte-exact restoration`);
      restoreVerified = true;
      const restored = await run(false, false);
      assert.equal(restored.result.outcome, "pass", `${name}: restored catching file is not GREEN\n${restored.log}`);
      console.log(`RESTORED ${name}: byte equality=${restoreVerified}, GREEN ${file}, executed=${restored.count}`);
    }
    assert.equal(caught.result.outcome, "assertion", `${name}: proof failure: scoped ${caught.result.outcome}, no whole-suite confirmation\n${caught.log}`);
    assert.equal(caught.result.catching?.file, file, `${name}: unrelated catching file`);
    assert.ok(expectedNames.has(caught.result.catching!.name), `${name}: unrelated catching assertion ${caught.result.catching!.name}`);
    assert.ok(caught.result.failures.every((failure: any) => failure.cause === "ERR_ASSERTION" && expectedNames.has(failure.name)), `${name}: unrelated non-assertion failure`);
    const assertion = caught.result.failures.find((failure: any) => failure.name === caught.result.catching!.name);
    console.log(`ASSERTION ${name}:\n${caught.log}`);
    console.log(`PROOF ${JSON.stringify({ row: name, target, from, to, assertion, executed: caught.count, baselineExecuted: baseline.count, priority, restored: restoreVerified })}`);
  } finally {
    // Trusted no-follow walker, restricted to the two folders createLane created for this test.
    assert.deepEqual(removeTree(lane.dir, root).leftovers, [], `${name}: proof copy leftovers`);
    assert.deepEqual(removeTree(lane.temp, tmpdir()).leftovers, [], `${name}: proof temp leftovers`);
  }
});
