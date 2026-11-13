export const serverOtherCoreMutations = [
  ["p26r5-list-scope", "server/fixed-crew/task-archive-files.ts", "scope: archive.task.plan.scope", "scope: archive.manifest.reason"],
  ["p26r5-list-completed-at", "server/fixed-crew/task-archive-files.ts", "completedAt: archive.manifest.completedAt", "completedAt: \"2000-01-01T00:00:00.000Z\""],
  ["p26r5-list-verification", "server/fixed-crew/task-archive-files.ts", "const archive = readTaskArchive(root, tabId, id);", "const archive = { task: JSON.parse(readArchiveBytes(archivePath(root, tabId, id, \"task.json\")).toString(\"utf8\")), manifest: JSON.parse(readArchiveBytes(archivePath(root, tabId, id, \"manifest.json\")).toString(\"utf8\")) };"],
  ["p26r4-finish-dispatch","server/main/fixed-task-tools.ts","const archive = fixedTasks.finish({ tabId, ...expected }, reason, fixedTasks.actor(\"leader\", actor.sessionId), journal);","const archive = { task: { id: expected.taskId }, manifest: null };"],
  ["p26r4-finish-identity","server/fixed-crew/task-store.ts","if (!task || task.id !== expected.taskId || task.planVersion !== expected.planVersion || task.recordRevision !== expected.recordRevision\n        || archiveHash(source) !== sourceHashes.get(expected.tabId)\n        || digest(validate(JSON.parse(source))) !== digest(task)) throw new Error(\"Stale task identity, version or source bytes.\");","void 0;"],
  ["p26r4-finish-owner","server/fixed-crew/task-completion.ts","if (!ownerApproved(task) || task.plan.visibleWork && (!task.roughRevision\n    || task.ownerRoughApproval?.planVersion !== task.planVersion\n    || task.ownerRoughApproval.digest !== task.planDigest\n    || task.ownerRoughApproval.revision !== task.roughRevision)) throw new Error(\"Owner scope and required rough approval are required.\");","void 0;"],
  ["p26r4-finish-results","server/fixed-crew/task-completion.ts","if (task.executions.some((run) => [\"reserved\", \"running\", \"interrupted\"].includes(run.status)\n    || run.processEnd !== \"confirmed\" || run.status === \"success\" && !run.verified)) throw new Error(\"Unresolved or unverified task execution.\");","void 0;"],
  ["p26r4-finish-checks","server/fixed-crew/task-completion.ts","if (!allChecksPassed(task, revision)) throw new Error(\"Required current checks are missing.\");","void 0;"],
  ["p26r4-finish-review","server/fixed-crew/task-completion.ts","if (!freshReview(task, revision)) throw new Error(\"A fresh accepted ordinary review is required.\");","void 0;"],
  ["p26r4-finish-final","server/fixed-crew/task-completion.ts","if (needsFinal(task) && !freshFinal(task, revision)) throw new Error(\"A fresh accepted final review is required.\");","void 0;"],
  ["p26r4-finish-findings","server/fixed-crew/task-completion.ts","if (!allFindingsTriaged(task) || hasOpenFix(task)) throw new Error(\"Triage and resolve every accepted FIX before completion.\");","void 0;"],
  ["p26r4-finish-shipping","server/fixed-crew/task-completion.ts","if (!task.plan.shipping.every((kind) => task.executions.some((run) => run.kind === kind\n    && run.taskId === task.id && run.planVersion === task.planVersion && run.status === \"success\"\n    && run.processEnd === \"confirmed\" && run.verified && run.evidence.length > 0\n    && run.resultRevision === revision))) throw new Error(\"Approved shipping is unfinished.\");","void 0;"],
  ["p26r4-finish-content","server/fixed-crew/task-store.ts","if (fingerprint(folderFor(task.tabId), task.plan).digest !== task.revision.digest) throw new Error(\"Task content changed before completion.\");","void 0;"],
  ["p26r4-finish-journal","server/fixed-crew/task-journal-archive.ts","if (journal.activeExecutionId || journal.executions.some((run) => !settledExecution(run))) throw new Error(\"Journal has active, unended, interrupted or unconsumed successful work.\");","void 0;"],
  ["p26r4-finish-runtime","server/main/fixed-task-tools.ts","if (fixedArchiveRuntimeBlocked(tabId) || completionExecutions(dataRoot, tabId, task, journal).some((run) => isRunning(run.id))) throw new Error(\"Runtime runner, Git, cleanup, saving or owner approval is still pending.\");","void 0;"],
  ["p26r4-archive-source","server/fixed-crew/task-archive.ts","publishImmutable(archivePath(root, tx.tabId, tx.taskId, \"source.json\"), tx.source);","void tx.source;"],
  ["p26r4-archive-verify","server/fixed-crew/task-archive-files.ts","if (!readArchiveBytes(file, Math.max(Buffer.byteLength(expected), 1)).equals(Buffer.from(expected))) throw new Error(`Archive bytes conflict: ${file}`);","void 0;"],
  ["p26r4-archive-marker","server/fixed-crew/task-archive.ts","publishImmutable(transactionPath(root, task.tabId), archiveJson(tx));","void tx;"],
  ["p26r4-archive-source-recheck","server/fixed-crew/task-archive.ts","if (!sourceMatches(file, tx.source, 4 * 1024 * 1024) || !sourceMatches(journalFile, tx.journalBefore, 32 * 1024 * 1024)) throw new Error(\"Rollover source changed before replacement.\");","void 0;"],
  ["p26r4-archive-empty","server/fixed-crew/task-archive.ts","publishConfigFile(tx.target, file, true);","void tx.target;"],
  ["p26r4-archive-prune","server/fixed-crew/task-archive.ts","saveJournal(root, tx.tabId, JSON.parse(tx.journalAfter));","void tx.journalAfter;"],
  ["p26r4-archive-cache","server/fixed-crew/task-store.ts","cache.set(task.tabId, null);","void task.tabId;"],
  ["p26r4-archive-resume","server/fixed-crew/task-store.ts","if (resumeTaskArchive(dataRoot, tabId)) { cache.delete(tabId); sourceHashes.delete(tabId); blocked.delete(tabId); }","void tabId;"],
  ["p26r4-archive-receipt","server/fixed-crew/task-archive.ts","publishImmutable(archivePath(root, tx.tabId, tx.taskId, \"complete.json\"), archiveJson({ version: 1, tabId: tx.tabId,\n    taskId: tx.taskId, manifestHash: archiveHash(archiveJson(tx.manifest)) }));","void tx.manifest;"],
  ["p26r4-journal-admission","server/main/fixed-task-launch.ts","admitJournalExecution(dataRoot, actor.tabId, task, (runId) => fixedArchiveRuntimeBlocked(actor.tabId, runId));","void task;"],
  ["p26r4-journal-cap","server/fixed-crew/task-execution.ts","count <= 2000","count <= 2001"],
  ["p26r4-journal-archive-before-prune","server/fixed-crew/task-journal-archive.ts","for (const run of removable) publishExecutionArchive(root, tabId, run);","for (const run of removable) void run;"],
  ["p26r4-journal-late-callback","server/main/fixed-task-launch.ts","export function fixedRunLog(tabId: string, runId: string, logPath: string): void {\n  const next = executionJournal(dataRoot, tabId);\n  const execution = next.executions.find((e) => e.id === runId);\n  if (!execution) { assertRetiredExecution(dataRoot, tabId, runId); return; }\n  execution.logPath = logPath;\n  saveJournal(dataRoot, tabId, next);\n}\nexport function fixedRunStatus(tabId: string, runId: string, status: \"done\" | \"failed\" | \"stopped\"): void {\n  const next = executionJournal(dataRoot, tabId);\n  const execution = next.executions.find((e) => e.id === runId);\n  if (!execution) { assertRetiredExecution(dataRoot, tabId, runId); return; }\n","export function fixedRunLog(tabId: string, runId: string, logPath: string): void {\n  const next = executionJournal(dataRoot, tabId);\n  const execution = next.executions.find((e) => e.id === runId);\n  if (!execution) throw new Error(\"Archived callback rejected\");\n  execution.logPath = logPath;\n  saveJournal(dataRoot, tabId, next);\n}\nexport function fixedRunStatus(tabId: string, runId: string, status: \"done\" | \"failed\" | \"stopped\"): void {\n  const next = executionJournal(dataRoot, tabId);\n  const execution = next.executions.find((e) => e.id === runId);\n  if (!execution) throw new Error(\"Archived callback rejected\");\n"],
  ["p26r4-archive-read-binding","server/fixed-crew/task-archive-files.ts","if (manifest.version !== 1 || manifest.tabId !== tabId || manifest.taskId !== taskId\n    || task.tabId !== tabId || task.id !== taskId || task.stage !== \"complete\"\n    || task.planVersion !== manifest.planVersion || task.recordRevision !== manifest.recordRevision) throw new Error(\"Archive identity mismatch.\");","void 0;"],
  ["p26r3-recovery-late-status","server/main/fixed-task-launch.ts","if (execution.consumed) return;","void execution.consumed;"],
  ["p26r3-recovery-late-tree","server/fixed-crew/task-execution.ts","if (execution.consumed) return;","void execution.consumed;"],
  ["p26r3-recovery-tool-call","server/main/fixed-task-tools.ts","=> reconcileTaskExecution(actor, expected, runId, reason)","=> ({ runId, reconciled: false })"],
  ["p26r3-recovery-actor-binding","server/main/fixed-task-tools.ts","reason }, fixedTasks.actor(\"leader\", actor.sessionId));","reason }, fixedTasks.actor(\"owner\", actor.sessionId));"],
  ["p26r3-recovery-task-identity","server/main/fixed-task-tools.ts","id(runId); text(reason);\n  const task = currentTask(actor, expected);","id(runId); text(reason);\n  const task = currentTask(actor, expected && { ...expected, recordRevision: fixedTasks.get(actor.tabId)!.recordRevision });"],
  ["p26r3-recovery-execution-binding","server/main/fixed-task-tools.ts","if (journalOnly ? !!run : !run || run.taskId !== task?.id || run.planVersion !== task?.planVersion || run.kind !== execution.kind || run.role !== execution.role) {","if (false) {"],
  ["p26r3-recovery-tree-fact","server/main/fixed-task-tools.ts","if (execution.processEnded !== true) throw new Error(\"The app has not confirmed this whole process tree ended.\");","if (false) throw new Error(\"The app has not confirmed this whole process tree ended.\");"],
  ["p26r3-recovery-live-runner","server/main/fixed-task-tools.ts","if (isRunning(runId)) throw new Error(\"The runner still holds this execution as running.\");","if (false) throw new Error(\"The runner still holds this execution as running.\");"],
  ["p26r3-recovery-git-terminal","server/main/fixed-task-tools.ts","if (operation && (operation.tabId !== actor.tabId || !operation.terminal || !operation.treesEnded || operation.cancelChild || operation.cleanup.size !== 0)) {","if (operation && (operation.tabId !== actor.tabId || !operation.treesEnded || operation.cancelChild || operation.cleanup.size !== 0)) {"],
  ["p26r3-recovery-git-cleanup","server/main/fixed-task-tools.ts","if (operation && (operation.tabId !== actor.tabId || !operation.terminal || !operation.treesEnded || operation.cancelChild || operation.cleanup.size !== 0)) {","if (operation && (operation.tabId !== actor.tabId || !operation.terminal || !operation.treesEnded || operation.cancelChild)) {"],
  ["p26r3-recovery-brake-setter","server/main/fixed-task-tools.ts","journal.activeExecutionId = runId;","void runId;"],
  ["p26r3-recovery-task-call","server/main/fixed-task-tools.ts","if (task && run && !taskSettled) applyTaskEvent(actor.tabId, task,","if (false) applyTaskEvent(actor.tabId, task,"],
  ["p26r3-recovery-journal-setter","server/main/fixed-task-tools.ts","execution.status = \"failed\"; execution.consumed = true;","execution.status = \"done\"; execution.consumed = false;"],
  ["p26r3-recovery-active-id","server/main/fixed-task-tools.ts","if (journal.activeExecutionId === runId) journal.activeExecutionId = null;","void journal.activeExecutionId;"],
  ["p26r3-recovery-registry-call","server/main/fixed-task-tools.ts","fixedGitOperations.retireConfirmed(runId);","void runId;"],
  ["p26r3-reconcile-stage","server/fixed-crew/task-transitions.ts","if (next.stage === \"interrupted\" && !next.executions.some((e) => [\"reserved\", \"running\", \"interrupted\"].includes(e.status) || e.processEnd !== \"confirmed\")) next.stage = \"planned\";","if (next.stage === \"interrupted\") next.stage = \"planned\";"],
  ["p26r3-delivery-cancel-call","server/main/fixed-tasks.ts","applyTaskEvent(tabId, task, { type: \"cancelRequest\", executionId, sessionId, reason: \"Leader delivery failed before execution was consumed.\" }, requestTaskActor());","void executionId;"],
  ["p26r3-delivery-unconsumed","server/main/fixed-tasks.ts","!executionJournal(root, tabId).executions.some((e) => e.id === executionId)","true"],
  ["p26r3-delivery-stage","server/fixed-crew/task-transitions.ts","} else if (event.type === \"cancelRequest\") {","} else if (event.type === \"cancelRequest\") {\n      next.stage = \"planned\";"],
  ["p26r3-delivery-cancel-setter","server/fixed-crew/task-transitions.ts","execution.status = \"failed\"; execution.processEnd = \"confirmed\"; execution.verified = false; execution.evidence = []; execution.resultRevision = null;","void execution.status;"],
  ["p26r1-request-release-error","server/main/fixed-tasks.ts","catch (releaseError) { message += ` Reservation release failed: ${(releaseError as Error).message}`; }","catch (releaseError) { void releaseError; }"],
  ["p26r1-approval-metadata","server/main/fixed-task-tools.ts","\"fixed-action\", { command: summary }","\"fixed-action\", { command: brief }"],
  ["p26r1-approval-selection","server/main/fixed-task-launch.ts","role: requested, ...selection, kind:","role: requested, ...selection, selectedSlot: requested, kind:"],
  ["p26r1-request-busy","server/main/messages/fixed-tasks.ts","if (!replay) assertRequestLeaderIdle(message.tabId);","void replay;"],
  ["p26r1-request-delivery","server/main/fixed-tasks.ts","const delivered = await sendLeaderTurn(tabId,","const delivered = false && await sendLeaderTurn(tabId,"],
  ["p26r1-request-false","server/main/fixed-tasks.ts","if (!delivered) throw new Error(\"The leader did not receive the action request. It was not retried.\");","if (false) throw new Error(\"The leader did not receive the action request. It was not retried.\");"],
  ["p26r1-request-failure-release","server/main/fixed-tasks.ts","applyTaskEvent(tabId, task, { type: \"cancelRequest\", executionId, sessionId, reason: \"Leader delivery failed before execution was consumed.\" }, requestTaskActor());","void executionId;"],
  ["fcb-stale", "server/fixed-crew/bulk-assignment.ts", 'if (expectedDigest !== currentDigest) throw new Error("Crew choices changed. Choose the model again.");', 'if (false) throw new Error("Crew choices changed. Choose the model again.");'],
  ["fcb-confirm", "server/fixed-crew/bulk-assignment.ts", 'if (replacesUserChoice && confirmReplace !== true) throw new Error("Confirm replacing your chosen models.");', 'if (false) throw new Error("Confirm replacing your chosen models.");'],
  ["fcb-busy", "server/fixed-crew/bulk-assignment.ts", 'if (busy(slot)) { skipped.push(slot); continue; }', 'if (false) { skipped.push(slot); continue; }'],
  ["fcb-assignment-setter", "server/fixed-crew/bulk-assignment.ts", 'next.preferences[slot] = { assignment, source: "user" };', 'void assignment;'],
  ["fcb-publish", "server/main/fixed-crew.ts", 'publish(tab, result.crew);', 'void result.crew;'],
  ["fcb-installed", "server/fixed-crew/bulk-assignment.ts", 'item.id === cliId && item.installed === true', 'item.id === cliId'],
  ["fcb-extras", "server/fixed-crew/bulk-assignment.ts", 'const next = structuredClone(current);', 'const next = { ...structuredClone(current), roleExtras: {} };'],
  ["fcb-dispatch", "server/main/messages/fixed-crew.ts", 'fixedCrewService.setModelForAll(message.tabId, message.cli, message.model, message.expectedAssignmentsDigest, message.confirmReplace)', '({ tabId: message.tabId })'],
  ["fc4-partial-backup-repair", "server/fixed-crew/recovery-backup.ts", "publishConfigFile(original, destination, true);", "void original;"],
  ["fc4-source-change-gate", "server/fixed-crew/recovery.ts", 'if (JSON.stringify(backupInventory(root)) !== JSON.stringify(expected)) throw new Error("Recovery source changed during preparation.");', 'if (false) throw new Error("Recovery source changed during preparation.");'],
  ["fc4-requests-preserved", "server/index.ts", 'if (!workspaceRecovery().blocked && !workspaceRecovery().recovered) for (const request', 'if (true) for (const request'],
  ["fc4-backup-copy", "server/fixed-crew/recovery-backup.ts", "copyFileSync(source, destination, constants.COPYFILE_EXCL);", "void source;"],
  ["fc4-backup-hash", "server/fixed-crew/recovery-backup.ts", 'if (actualHash !== entry.sha256) throw new Error("Legacy backup verification failed.");', 'if (false) throw new Error("Legacy backup verification failed.");'],
  ["fc4-fresh-publication", "server/fixed-crew/recovery.ts", "publishConfigFile(freshBytes, workspace, true);", "void freshBytes;"],
  ["fc4-recovery-complete", "server/fixed-crew/recovery.ts", 'record.status = "complete";', "void record;"],
  ["fc4-workspace-write-gate", "server/config.ts", 'assertWorkspaceRecoveryReady("workspace");', "void 0;"],
  ["fc4-task-action-gate", "server/fixed-crew/recovery.ts", 'assertWorkspaceRecoveryReady("task-action");', "void 0;"],
  ["fc4-worker-launch-gate", "server/main/fixed-task-launch.ts", 'assertWorkspaceRecoveryReady("worker-launch");', "void 0;"],
  ["fc4-leader-launch-gate", "server/main/leader-session.ts", 'assertWorkspaceRecoveryReady("leader-launch");', "void 0;"],
  ["fc4-old-format-detection", "server/fixed-crew/recovery.ts", 'if (!tab || typeof tab !== "object" || !Object.hasOwn(tab, "fixedCrew")) old = true;', "if (false) old = true;"],
  ["fc4-old-format-call", "server/config.ts", "initializeWorkspaceRecovery(defaultWorkspaces);", "void defaultWorkspaces;"],
  ["fc4-fresh-identity-setter", "server/fixed-crew/recovery.ts", "fresh.projects[0].tabs[0].id = id;", "void id;"],
  ["fc4-fresh-id-collision", "server/fixed-crew/recovery.ts", 'if (sourceText.toLowerCase().includes(id) || histories.some((name) => name.startsWith(`${id}.`) || name.startsWith(`${id}-`))) continue;', "if (false) continue;"],
  ["fcx-tree-gate","server/fixed-crew/task-execution.ts","if (!execution.processEnded) throw new Error(\"The previous process tree has not been confirmed ended.\");","if (false) throw new Error(\"The previous process tree has not been confirmed ended.\");"],
  ["fcx-tree-setter","server/fixed-crew/task-execution.ts","execution.processEnded = confirmed;","void confirmed;"],
  ["fcx-report-run","server/fixed-crew/task-reports.ts","if (report.runId !== execution.id) throw new Error(\"Report belongs to another run.\");","if (false) throw new Error(\"Report belongs to another run.\");"],
  ["fcx-report-success","server/fixed-crew/task-reports.ts","if (execution.status !== \"done\") throw new Error(\"This run did not finish successfully.\");","if (false) throw new Error(\"This run did not finish successfully.\");"],
  ["fcx-restart-no-replay","server/fixed-crew/task-execution.ts","execution.status = \"interrupted\"; changed = true;","void execution.status;"],
  ["fct-restart-unverified", "server/fixed-crew/task-store.ts", '|| action.status === "success" && !action.verified', ''],
  ["fct-read-evidence", "server/fixed-crew/task-transitions.ts", 'if (!["rough", "build", "polish", "fix"].includes(execution.kind) && execution.revision !== next.revision.digest) throw new Error("Read-only evidence changed its covered revision");', 'if (false) throw new Error("Read-only evidence changed its covered revision");'],
  ["fct-replay-conflict", "server/fixed-crew/task-store.ts", 'if (previous.digest !== requestDigest) throw new Error("Request ID was reused with different contents");', 'if (false) throw new Error("Request ID was reused with different contents");'],
  ["fct-record-setter", "server/fixed-crew/task-store.ts", 'result.task.recordRevision++;', 'void result.task.recordRevision;'],
  ["fct-link-gate", "server/fixed-crew/task-revision.ts", 'if (lstatSync(file).isSymbolicLink()) throw new Error("Linked task paths are refused");', 'if (false) throw new Error("Linked task paths are refused");'],
  ["fct-verify-setter", "server/fixed-crew/task-transitions.ts", 'execution.verified = true;', 'void execution;'],
  ["fct-checkpoint-setter", "server/fixed-crew/task-transitions.ts", 'if (execution.kind === "checkpoint") next.checkpoints.push(evidence);', 'if (false) next.checkpoints.push(evidence);'],
  ["fct-rough-revision-setter", "server/fixed-crew/task-transitions.ts", 'next.roughRevision = next.revision.digest;', 'void next.revision.digest;'],
  ["fct-design-fix-route", "server/fixed-crew/task-gates.ts", 'if (action.route === "postFinal") return task.plan.design ? "fixer1" : "fixer2";', 'if (action.route === "postFinal") return "fixer2";'],
  ["fct-design-review-route", "server/fixed-crew/task-gates.ts", 'if (lastFix?.route === "postFinal") return task.plan.design ? "reviewer2" : "reviewer1";', 'if (lastFix?.route === "postFinal") return "reviewer1";'],
  ["fct-final-coverage", "server/fixed-crew/task-gates.ts", '&& finalCorrectionCoverage(task, r, correction)', '&& true'],
  ["fct-plan-version", "server/fixed-crew/task-plan.ts", 'next.planVersion = current.planVersion + 1;', 'void current.planVersion;'],
  ["fct-final-setter", "server/fixed-crew/task-plan.ts", 'next.reviewPolicy.finalRequired = mustHaveFinal(plan);', 'next.reviewPolicy.finalRequired = false;'],
  ["fct-owner-setter", "server/fixed-crew/task-transitions.ts", 'next.ownerScopeApproval = approval;', 'void approval;'],
  ["fct-rough-setter", "server/fixed-crew/task-transitions.ts", 'next.ownerRoughApproval = approval;', 'void approval;'],
  ["fct-stage-setter", "server/fixed-crew/task-transitions.ts", 'next.stage = event.stage;', 'void event.stage;'],
  ["fct-triage-setter", "server/fixed-crew/task-transitions.ts", 'next.triage[finding.id] = decision;', 'void decision;'],
  ["fct-review-setter", "server/fixed-crew/task-transitions.ts", 'next.reviews.push(review);', 'void review;'],
  ["fct-check-setter", "server/fixed-crew/task-transitions.ts", 'next.checks.push(check);', 'void check;'],
  ["fct-disk-write", "server/fixed-crew/task-store.ts", 'publishConfigFile(serialized, file, true);', 'void serialized;'],
  ["fct-restart-interrupted", "server/fixed-crew/task-store.ts", 'action.status = "interrupted";', 'void action;'],
  ["fct-owner-gate", "server/fixed-crew/task-gates.ts", 'if (!ownerApproved(task)) throw new Error("Approve this plan before building.");', 'if (false) throw new Error("Approve this plan before building.");'],
  ["fct-rough-gate", "server/fixed-crew/task-gates.ts", 'if (needsRoughApproval(task, action)) throw new Error("Approve the rough before polish or review.");', 'if (false) throw new Error("Approve the rough before polish or review.");'],
  ["fct-review-gate", "server/fixed-crew/task-gates.ts", 'if (!freshReview(task, revision)) throw new Error("A fresh review of this revision is required.");', 'if (false) throw new Error("A fresh review of this revision is required.");'],
  ["fct-fix-gate", "server/fixed-crew/task-gates.ts", 'if (hasOpenFix(task)) throw new Error("Finish the accepted fixes before shipping.");', 'if (false) throw new Error("Finish the accepted fixes before shipping.");'],
  ["fct-final-gate", "server/fixed-crew/task-gates.ts", 'if (needsFinal(task) && !freshFinal(task, revision)) throw new Error("A final review of this revision is required.");', 'if (false) throw new Error("A final review of this revision is required.");'],
  ["fct-triage-gate", "server/fixed-crew/task-gates.ts", 'if (!allFindingsTriaged(task)) throw new Error("The Planner must triage every finding.");', 'if (false) throw new Error("The Planner must triage every finding.");'],
  ["fct-checkpoint-gate", "server/fixed-crew/task-gates.ts", 'if (action.kind === "fix" && !validCheckpoint(task)) throw new Error("Create and verify the local checkpoint before fixing.");', 'if (false) throw new Error("Create and verify the local checkpoint before fixing.");'],
  ["fct-session-gate", "server/fixed-crew/task-gates.ts", 'if (execution && !newReviewSession(task, execution)) throw new Error("Review needs a fresh independent session.");', 'if (false) throw new Error("Review needs a fresh independent session.");'],
  ["fct-checks-gate", "server/fixed-crew/task-gates.ts", 'if (!allChecksPassed(task, revision)) throw new Error("Required checks are missing, failed or stale.");', 'if (false) throw new Error("Required checks are missing, failed or stale.");'],
  ["fct-interrupted-gate", "server/fixed-crew/task-gates.ts", 'if (task.stage === "interrupted") throw new Error("Check the interrupted action before continuing.");', 'if (false) throw new Error("Check the interrupted action before continuing.");'],
  ["fct-revision-gate", "server/fixed-crew/task-store.ts", 'if (task.recordRevision !== expected.recordRevision || task.planVersion !== expected.planVersion) throw new Error("Stale task revision");', 'if (false) throw new Error("Stale task revision");'],
  ["fct-actor-authority", "server/fixed-crew/task-store.ts", 'if (!actors.has(actor)) throw new Error("Server actor authority required");', 'if (false) throw new Error("Server actor authority required");'],
  ["fct-actor-role", "server/fixed-crew/task-transitions.ts", 'if (actor.role !== role) throw new Error("This actor cannot record this task event.");', 'if (false) throw new Error("This actor cannot record this task event.");'],
  ["fct-post-final-route", "server/fixed-crew/task-gates.ts", 'if (postFinal !== (action.route !== "normal")) throw new Error("Use the required post-final route.");', 'if (false) throw new Error("Use the required post-final route.");'],
  ["fct-minimal-route", "server/fixed-crew/task-gates.ts", 'if (action.route === "minimal" && (action.change !== "minimal" || fixes.some((f) => !f.minimal))) throw new Error("Logic changes cannot use the minimal route.");', 'if (false) throw new Error("Logic changes cannot use the minimal route.");'],
  ["fct-batch-gate", "server/fixed-crew/task-gates.ts", 'if (execution && JSON.stringify([...execution.batch].sort()) !== JSON.stringify(fixes.map((f) => f.id).sort())) throw new Error("Fix every accepted finding in one sequential batch.");', 'if (false) throw new Error("Fix every accepted finding in one sequential batch.");'],
  ["fct-content-hash","server/fixed-crew/task-revision.ts","hash.update(buffer.subarray(0, count));","hash.update(Buffer.alloc(0));"],
  ["fct-evidence-gate", "server/fixed-crew/task-transitions.ts", 'if (execution.verified || execution.status !== "success" || execution.processEnd !== "confirmed" || !execution.evidence.length || execution.resultRevision !== next.revision.digest) throw new Error("Evidence must be successful, ended and current");', 'if (false) throw new Error("Evidence must be successful, ended and current");'],
  ["fct-evidence-identity", "server/fixed-crew/task-transitions.ts", 'if (actor.sessionId !== execution.sessionId || event.taskId !== next.id || event.planVersion !== next.planVersion || event.role !== execution.role) throw new Error("Evidence identity does not match the server execution");', 'if (false) throw new Error("Evidence identity does not match the server execution");'],
  ["fct-recovery-backup", "server/fixed-crew/task-store.ts", 'keepBadCopy(file);', 'void file;'],
  ["fcs-future-preserve","server/fixed-crew/preferences.ts","if (replacement && JSON.stringify(replacement.fixedCrew) !== JSON.stringify(tab.fixedCrew)) throw new Error(\"Future crew settings cannot be overwritten\");","if (false) throw new Error(\"Future crew settings cannot be overwritten\");"],
  ["fcs-recovery-backup","server/config.ts","if (recovered.length) keepBadCopy(target);","if (false) keepBadCopy(target);"],
  ["fcs-legacy-empty","server/config.ts","if (strict && (!Array.isArray(tab.crew) || tab.crew.length || !Array.isArray(tab.steps) || tab.steps.length || tab.lookPause !== false)) throw new Error(\"Fixed tabs have no legacy crew or steps\");","if (false) throw new Error(\"Fixed tabs have no legacy crew or steps\");"],
  ["fcs-keys","server/fixed-crew/preferences.ts","if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(\"Unknown or locked crew field\");","if (false) throw new Error(\"Unknown or locked crew field\");"],
  ["fcs-slot","server/fixed-crew/preferences.ts","if (!FIXED_CREW.some((seat) => seat.slot === slot)) throw new Error(\"Unknown crew slot\");","if (false) throw new Error(\"Unknown crew slot\");"],
  ["fcs-version","server/fixed-crew/preferences.ts","if (value.version !== 1) throw new Error(\"Unsupported fixed crew version\");","if (false) throw new Error(\"Unsupported fixed crew version\");"],
  ["fcs-preference-read","server/fixed-crew/preferences.ts","const preference = validatePreference(raw);","const preference = { assignment: null, source: \"auto\" as const };"],
  ["fcs-manual-setter","server/fixed-crew/preferences.ts","next.preferences[slot] = { assignment, source: \"user\" };","next.preferences[slot] = { assignment: null, source: \"auto\" };"],
  ["fcs-auto-refill","server/fixed-crew/preferences.ts","if (refill && current.source === \"auto\") current.assignment = null;","if (false) current.assignment = null;"],
  ["fcs-extra-setter","server/fixed-crew/preferences.ts","next.roleExtras[slot] = text;","void text;"],
  ["fcs-extra-reset","server/fixed-crew/preferences.ts","else delete next.roleExtras[slot];","else void next.roleExtras[slot];"],
  ["fcs-extra-limit","server/fixed-crew/preferences.ts","if (Buffer.byteLength(text, \"utf8\") > ROLE_EXTRAS_BYTES) throw new Error(\"Extra instructions are too long\");","if (false) throw new Error(\"Extra instructions are too long\");"],
  ["fcs-prompt-core","server/fixed-crew/role-prompts.ts","return [core, guidance, extras, brief].filter(Boolean).join(\"\\n\\n\");","return [extras, brief].filter(Boolean).join(\"\\n\\n\");"],
  ["guard-round2-codex-stdout-invalidates", "server/runner.ts", 'if (!text) return;\n    if (claudeState) {', 'if (!text) return;\n    if (codexState) Object.assign(codexState, createAgentUsageState());\n    if (claudeState) {'],
  ["guard-round2-stderr-output-wiring","server/runner.ts","    emit(text);\n    if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));","    if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));"],
  ["guard-round2-claude-flush-call-site", "server/runner.ts", 'if (claudeState) emitClaudeEvents(flushClaudeOutput(claudeState));', ''],
  ["guard-round2-system-case", "server/agent-usage.ts", 'case "system": {', 'case "system": return { text: "" }; case "unused": {'],
  ["guard-round2-system-exit", "server/agent-usage.ts", '(parsed.exit_code !== undefined && parsed.exit_code !== 0)', 'false'],
  ["guard-round2-system-stderr", "server/agent-usage.ts", '|| stderr;', '|| false;'],
  ["guard-round2-system-subtype", "server/agent-usage.ts", '/error|fail|abort|timeout/i.test(subtype)', 'false'],
  ["guard-round2-system-unknown-shown", "server/agent-usage.ts", 'return { text: capSystemLine(`[system] ${subtype}`) + "\\n" };', 'return { text: "" };'],
  ["guard-round2-system-cap", "server/agent-usage.ts", 'line.length > SYSTEM_LINE_CAP', 'false'],
  ["guard-round2-codex-terminal-pair", "server/agent-usage.ts", 'state.codexHeldTokens = null;', ''],
  ["guard-usage-model-payload", "server/usage.ts", 'modelId: modelId ?? null, contextTokens,', 'modelId: null, contextTokens,'],
  ["guard-usage-model-accumulator", "server/usage.ts", 'modelId: delta.modelId,', 'modelId: null,'],
  ["guard-usage-model-snapshot", "server/usage.ts", 'modelId: totals.modelId,', 'modelId: null,'],
  ["guard-usage-context-excludes-output", "server/usage.ts", 'contextTokens = toNumber(u.input_tokens)', 'contextTokens = toNumber(u.output_tokens) + toNumber(u.input_tokens)'],
  ["guard-usage-cost-carry-forward", "server/usage.ts", 'currentCostUsd: delta.costUsd ?? totals.currentCostUsd,', 'currentCostUsd: delta.costUsd,'],
  // ---- killSeatAndConfirm (server/runner.ts): the one signal removal is
  // allowed to trust is the process's own real close, never a guess ----
  ["guard-confirm-kill-not-running-is-confirmed", "server/runner.ts", "if (!entry || !entry.proc.pid) return false;", "if (!entry) return true;\n  if (!entry.proc.pid) return false;"],
  ["guard-confirm-kill-real-close-confirms", "server/runner.ts", "  entry.stopRequested = true;\n", ""],
  ["guard-confirm-kill-timeout-unconfirmed", "server/runner.ts", "const grace = setTimeout(() => reportUnconfirmedKill(runId, entry, \"process did not exit within the grace period; it may still be running -- press Kill to try again\"), KILL_GRACE_MS);", "const grace = setTimeout(() => {}, KILL_GRACE_MS);"],
  // ---- P1 fix 1: the stall monitor judges a RUNNING process by the
  // permission it was launched with, never a live re-read of its current
  // role -- an edit to an Underground agent's role mid-run must never flip
  // the safety gate under an already-running process (server/index.ts) ----
  ["guard-run-record-frozen-at-launch", "server/runner.ts", "  run = Object.freeze({ ...run });\n", "  run = run;\n"],
  ["disk-model", "server/fixed-crew/assignment.ts", "!isSafeShape(value.model) || !isSafeShape(value.effort)", "!isSafeShape(value.effort)"],
  ["disk-effort", "server/fixed-crew/assignment.ts", "!isSafeShape(value.model) || !isSafeShape(value.effort)", "!isSafeShape(value.model)"],
  ["disk-seat-unsafe-id", "server/config.ts", "if (!isObject(tab) || !validSlug(tab.id) || !validText(tab.name)", "if (!isObject(tab) || !validText(tab.name)"],
  ["disk-seat-duplicate-id", "server/config.ts", "if (tabIds.has(tab.id.toLowerCase())) throw", "if (false) throw"],
  ["disk-seat-id-length-cap","server/process-types.ts","if (id.trim().length === 0 || id.length > MAX_SEAT_ID_LENGTH) return false;","if (id.trim().length === 0) return false;"],
  ["disk-seat-id-no-ascii-only-regression","server/process-types.ts","return !id.endsWith(\".\") && !id.endsWith(\" \");\n}","return !id.endsWith(\".\") && !id.endsWith(\" \") && /^[\\x00-\\x7f]*$/.test(id);\n}"],
  ["disk-seat-id-no-device-name-regression","server/process-types.ts","return !id.endsWith(\".\") && !id.endsWith(\" \");\n}","return !id.endsWith(\".\") && !id.endsWith(\" \") && ![\"CON\", \"PRN\", \"AUX\", \"NUL\", \"COM1\", \"LPT1\"].includes(id.toUpperCase());\n}"],
  ["raw-prompt", "server/runner.ts", "...commandEnv(run, briefPath)", "...commandEnv(run, prompt)"],
  ["origin", "server/security.ts", 'ALLOWED_ORIGINS.has(origin)', 'origin.startsWith("http://")'],
  ["host", "server/security.ts", 'ALLOWED_HOSTS.has(host)', 'true'],
  ["running-close", "server/runner.ts", "  running.delete(runId);\n", ""],
  ["working-status", "server/runner.ts", "try { cb.onStatus(run, \"working\"); }", "try { }"],
  ["stderr", "server/runner.ts", "proc.stderr?.on(\"data\", (chunk: Buffer) => {", "proc.stderr?.on(\"data-disabled\", (chunk: Buffer) => {"],
  ["shared-decoder", "server/runner.ts", 'const stderrDecoder = new StringDecoder("utf8");', 'const stderrDecoder = stdoutDecoder;'],
  ["seat-array", "server/config.ts", "if (!isObject(data) || !Array.isArray(data.projects)) throw", "if (!isObject(data)) throw"],
  ["empty-seats","server/config.ts","  return data as unknown as Workspaces;\n}\n\n// A fresh install starts with one empty example","  return { projects: [] };\n}\n\n// A fresh install starts with one empty example"],
  ["guard-sidebar-zero", "server/config-prefs.ts", "crewRailOpen: typeof raw.crewRailOpen === \"boolean\" ? raw.crewRailOpen : DEFAULT_CLIENT_PREFS.crewRailOpen,", "crewRailOpen: DEFAULT_CLIENT_PREFS.crewRailOpen,"],
  ["guard-usage-parse-tokens", "server/usage.ts", 'if (typeof usage === "object" && usage !== null) {', 'if (false) {'],
  ["guard-usage-parse-safety", "server/usage.ts", 'if (typeof result !== "object" || result === null) {', 'if (false) {'],
  ["guard-usage-accumulate-turns", "server/usage.ts", 'turns: totals.turns + 1,', 'turns: totals.turns,'],
  // ---- usage panel fix (P2 double-counted spend, traffic-not-occupancy
  // context, misleading zeroes, wrong-model window, fake/negative costs) ----
  ["guard-usage-cost-latest-not-sum", "server/usage.ts", 'currentCostUsd: delta.costUsd ?? totals.currentCostUsd,', 'currentCostUsd: (totals.currentCostUsd ?? 0) + (delta.costUsd ?? 0),'],
  ["guard-usage-context-latest-not-sum", "server/usage.ts", 'contextTokens: delta.contextTokens,', 'contextTokens: (totals.contextTokens ?? 0) + (delta.contextTokens ?? 0),'],
  ["guard-usage-window-no-carryover", "server/usage.ts", 'contextWindow: delta.contextWindow,', 'contextWindow: delta.contextWindow ?? totals.contextWindow,'],
  ["guard-usage-window-model-scoped", "server/usage.ts", 'const entry = (modelUsage as Record<string, unknown>)[modelId];', 'const entry = Object.values(modelUsage as Record<string, unknown>)[0];'],
  ["guard-usage-window-positive-check", "server/usage.ts", 'Number.isFinite(window) && window > 0) contextWindow = window;', 'Number.isFinite(window)) contextWindow = window;'],
  ["guard-usage-cost-negative-rejected", "server/usage.ts", 'Number.isFinite(value) && value >= 0 ? value : null;', 'Number.isFinite(value) ? value : null;'],
  ["guard-usage-bank-on-restart", "server/usage.ts", 'bankedCostUsd: totals.bankedCostUsd + (totals.currentCostUsd ?? 0),', 'bankedCostUsd: totals.bankedCostUsd,'],
  ["guard-usage-snapshot-measured", "server/usage.ts", 'const measured = totals.currentCostUsd !== null || totals.bankedCostUsd > 0;', 'const measured = true;'],
  // guard-usage-cost-tiny-floor and guard-usage-cost-negative-frontend
  // (formatCostUsd's tiny-floor and negative-cost checks) removed: spend was
  // deleted from public/app/*.js entirely, formatCostUsd included (see the
  // brief: "no need for spend count" -- delete the code, don't hide it).
  // Nothing left in usageBadgeText to mutate a cost check out of; see
  // frontend-*.test.ts's "usageBadgeText never references cost/spend"
  // structural guard instead.
  ["guard-usage-bank-model-clear", "server/usage.ts", 'export function bankUsage(totals: UsageTotals): UsageTotals {\n  return {\n    modelId: null,', 'export function bankUsage(totals: UsageTotals): UsageTotals {\n  return {\n    modelId: totals.modelId,'],

  // ---- Underground: the user's own independent roster, no Atlas leader ----
  // Guard 2 (the role list is closed), at all three places a role is ever
  // checked: the shared add/update validator, the add-flow's own early
  // check, and the disk loader.
  // Guard: the agent id is checked for Windows-filename safety on load, and
  // never allowed to collide with the "underground-" namespace itself.
  // Guard 5 (add/remove persist correctly, a removed agent's running process
  // is handled, not orphaned) at the real WS call sites.
  // Removal is always routed through killSeatAndConfirm now, running or not
  // (see server/index.ts's own comment on this) -- deleting the call itself
  // is what guard-underground-remove-dispatch-through-confirm below proves;
  // killSeatAndConfirm's own "nothing running" branch is proven at its real
  // call site by guard-confirm-kill-not-running-is-confirmed further down.
  // P1 fix 2: removal is refused (agent left fully in place) unless the kill
  // was actually confirmed -- reverting this is exactly the old orphan-risk
  // bug, restored (finishRemoval runs regardless of `confirmed`).
  // Defect 5 (P2): sandbox mode follows the role, not the kind -- an
  // Underground coder needs write access, a reviewer stays read-only.
  ["guard-codex-sandbox-follows-canwrite", "server/runner.ts", "--sandbox ${run.canWrite ? \"workspace-write\" : \"read-only\"}", "--sandbox read-only"],
  // Round 2 defects: a name denylist alone is bypassable through a custom
  // opencode model id, an opencode reviewer was always write-enabled, a
  // kind-change to opencode could submit a stale/invalid effort, and the
  // coder-vs-reviewer sandbox split was only proven at the helper level.
  ["guard-opencode-reviewer-permission","server/runner-crew.ts","  if (run.canWrite) return undefined;\n","  if (true) return undefined;\n"],
  ["guard-opencode-reviewer-env-wiring","server/runner.ts","...(run.cli === \"opencode\" && opencode ? { OPENCODE_CONFIG_CONTENT: opencode } : {})","...({})"],
  // ---- roster/CLI-picker pack: permission follows the ROLE on every CLI kind
  // (guard 1), the sidebar kind picker cascades a stale model/effort (guard
  // 3), and spend is gone structurally (guard 6). See test/runner-*.test.ts's
  // "canSeatWrite:"/"buildCommand: claude"/"applySeatKindUpdate:" tests. ----
  // Guard 1, the most important guard in the pack: a claude seat used to run
  // acceptEdits unconditionally with no role check -- dropping this ternary
  // reverts exactly that P1 (a reviewer switched to claude silently writes).
  ["guard-buildcommand-claude-role-check","server/runner.ts","const mode = run.canWrite ? CLAUDE_WRITE_FLAGS : CLAUDE_READ_ONLY_FLAGS;","const mode = CLAUDE_WRITE_FLAGS;"],
  ["guard-claude-readonly-no-prompts", "server/runner.ts",
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";',
    'const CLAUDE_READ_ONLY_FLAGS = "--permission-mode plan --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit";'],
  // Guard 4: discovery's call site never claims a real result on a parse
  // failure -- proven directly by test/cli-discovery.test.ts's injected-fake
  // "degrades to the fallback list, marked as such" tests, never just the
  // pure parser in isolation (the parser can be correct while the caller
  // still mislabels a null result as a live one).
  ["guard-discovery-claude-effort-honest-fallback", "server/cli-discovery.ts",
    'return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };\n}\n\nexport async function discoverOpencodeModels',
    'return { values: parsed ?? [...fallback], fallback: false };\n}\n\nexport async function discoverOpencodeModels'],
  ["guard-discovery-opencode-models-honest-fallback", "server/cli-discovery.ts",
    'const parsed = out ? parseOpencodeModels(out) : null;\n  return parsed ? { values: parsed, fallback: false } : { values: [...fallback], fallback: true };\n}',
    'const parsed = out ? parseOpencodeModels(out) : null;\n  return { values: parsed ?? [...fallback], fallback: false };\n}'],
  // ---- stall detection (server/stall.ts): the pure decision, guard 2 ----
  ["guard-stall-status-gate", "server/stall.ts", 'return status === "working" && currentByteCount === lastByteCount && elapsedMs >= thresholdMs;', 'return currentByteCount === lastByteCount && elapsedMs >= thresholdMs;'],
  ["guard-stall-byte-equality", "server/stall.ts", 'currentByteCount === lastByteCount && elapsedMs >= thresholdMs;', 'elapsedMs >= thresholdMs;'],
  ["guard-stall-threshold-gate", "server/stall.ts", 'elapsedMs >= thresholdMs;', 'elapsedMs >= 0;'],
  // ---- auto-relaunch policy (server/stall.ts): guard 3, the money guard.
  // Every refusal is its own mutation; each must turn test/stall.test.ts red
  // on its own, independent of the other four. See test/round2-*.test.ts's
  // "stall:" tests for the real runSeat/killSeat call-site proof (not just
  // this pure function) -- especially "a second stall... escalates instead
  // of relaunching again", which a mutation here would let loop. ----
  // MONEY GUARD 4: a seat that can edit files must never be auto-relaunched,
  // full stop -- see stall.ts's own top comment on why this can never be a
  // byte threshold. Dropping this line must let a writable seat (sonny, or a
  // seat switched to opencode via updateSeat in test/round2-*.test.ts, or the
  // pure "seatCanWrite: true" cases in test/stall.test.ts) auto-relaunch,
  // turning both suites red.
  // Safety classification: Claude/opencode reviewers remain potentially writable.
  // Both branches are also exercised through real WS launch + tickStall in round2-*.test.ts.
  ["guard-canrunwrite-codex-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"codex\" ? run.canWrite : true;"],
  ["guard-canrunwrite-opencode-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"opencode\" ? run.canWrite : true;"],
  ["guard-canrunwrite-claude-always-true", "server/runner.ts", "  void run;\n  return true;", "  return run.cli === \"claude\" ? run.canWrite : true;"],
  // ---- run history (server/history.ts): guard 4, pure listing/tail-reading
  // over fabricated directory data (test/history.test.ts) plus real files on
  // disk for the exit marker (test/runner-*.test.ts) ----
  ["guard-history-sort-order", "server/history.ts", 'return entries.sort((a, b) => b.timestamp - a.timestamp);', 'return entries.sort((a, b) => a.timestamp - b.timestamp);'],
  ["guard-history-seat-filter", "server/history.ts", 'if (!parsed || parsed.seatId !== seatId) continue;', 'if (!parsed) continue;'],
  ["guard-history-stats-skip", "server/history.ts", '    if (!info) continue;', ''],
  ["guard-readtail-start-calc", "server/history.ts", 'const start = Math.max(0, size - maxBytes);', 'const start = 0;'],
  ["guard-readtail-truncated-flag", "server/history.ts", 'truncated: start > 0, totalBytes: size };', 'truncated: false, totalBytes: size };'],
  ["guard-runner-exit-marker", "server/runner.ts", "      appendLog(formatExitMarker(status, code));\n", ""],
  // ---- an unconfirmed kill must never be treated as a confirmed one (server/
  // runner.ts's reportUnconfirmedKill, the P1 fix replacing the old
  // forceIdle): the seat must stay tracked and killable, not silently
  // dropped from `running` on a guess. Proven through the real runSeat +
  // killSeat call site in test/runner-*.test.ts and test/round2-*.test.ts, never
  // the helper in isolation. ----
  ["guard-unconfirmed-kill-no-delete", "server/runner.ts", "  if (!ownsRun(runId, entry)) return;\n  entry.unconfirmed = true;", "  if (!ownsRun(runId, entry)) return;\n  running.delete(runId);\n  entry.unconfirmed = true;"],
  // Item 3 (P1): any real output at all disqualifies an auto-relaunch, not
  // just output above some old byte threshold -- see test/stall.test.ts's
  // "MONEY GUARD 3" tests and test/round2-*.test.ts's call-site version.
  // Guard 1: a claude worker's command must carry the flags that make
  // per-turn usage/cost/context/rate-limit numbers available at all.
  ["guard-agentusage-stream-json-flags","server/runner.ts","${advisor} ${mode}${search} --output-format stream-json --verbose`;","${advisor} ${mode}${search}`;"],
  // A real bug found by hand during manual verification: onUsage's full state
  // broadcast must never fire before this event's own text has been appended
  // to seatOutput, or the broadcast state is one line behind and a later
  // status-only resync can wipe the line that was just shown (see the real
  // "a result line's text lands in seatOutput before its usage broadcast
  // fires" test in test/round2-*.test.ts).
  ["guard-agentusage-text-before-usage-broadcast","server/runner.ts","      if (event.text) emit(event.text);\n      if (event.usage) cb.onUsage?.(run, event.usage);","      if (event.usage) cb.onUsage?.(run, event.usage);\n      if (event.text) emit(event.text);"],
  // Guard 2 (call site): removing the onUsage/onRateLimit forwarding from the
  // tee must turn the real runSeat-driven suite red, not just a pure-parser test.
  ["guard-agentusage-onusage-claude-wiring", "server/runner.ts", "      if (event.usage) cb.onUsage?.(run, event.usage);\n", ""],
  ["guard-agentusage-onusage-codex-wiring", "server/runner.ts", "for (const delta of deltas) cb.onUsage?.(run, delta);", "for (const delta of deltas) void delta;"],
  ["guard-agentusage-onratelimit-wiring", "server/runner.ts", 'if (event.rateLimit) cb.onRateLimit?.(event.rateLimit);', ''],
  // Guard 3: a JSON object split across two chunks must be parsed exactly
  // once, from the reassembled whole line -- dropping the append silently
  // truncates whatever was held from the previous chunk.
  ["guard-agentusage-claude-buffer-append", "server/agent-usage.ts", 'state.buffer += chunk;\n  const events: AgentUsageEvent[] = [];', 'state.buffer = chunk;\n  const events: AgentUsageEvent[] = [];'],
  // Guard 4: the degradation guarantee -- unparseable/unrecognised output must
  // reach the pane verbatim, never silently disappear.
  ["guard-agentusage-claude-passthrough-catch", "server/agent-usage.ts", '} catch {\n    return { text: rawLine + nl }; // degrade to raw text: never dropped, never silent (guard 4)\n  }', '} catch {\n    return { text: "" };\n  }'],
  ["guard-agentusage-claude-flush-return", "server/agent-usage.ts", 'return [parseClaudeLine(state, rawLine, "")];', 'return [];'],
  // Guard 5: thinking blocks and empty system/user noise stay quiet.
  ["guard-agentusage-thinking-suppressed", "server/agent-usage.ts",
    '    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);\n    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);',
    '    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);\n    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);\n    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);'],
  // guard-agentusage-system-suppressed and guard-agentusage-unknown-event-passthrough
  // (below, in the P2 fix 3 block) together replace the old single "default
  // case hides everything" guard, now that the default case is a known-noise
  // allow-list rather than a blanket hide.
  // Guard 6: codex's only instrument -- the thousands separator must be
  // stripped, and the marker line must actually arm the flag that makes the
  // following line count as the number.
  ["guard-agentusage-codex-comma-strip", "server/agent-usage.ts", 'const digits = trimmedLine.replace(/,/g, "");', 'const digits = trimmedLine;'],
  ["guard-agentusage-codex-pending-flag-set", "server/agent-usage.ts", 'if (trimmedLine === "tokens used") state.codexPendingTokens = true;', 'if (false) state.codexPendingTokens = true;'],
  ["guard-agentusage-codex-flush-leftover", "server/agent-usage.ts", 'return state.codexHeldTokens ? [state.codexHeldTokens] : [];', 'return [];'],
  // P2 fix 4: a codex match must be HELD, never surfaced the moment it's
  // found mid-stream -- only flushCodexTokens (process close) may report a
  // delta, so a later real footer always overwrites an earlier one printed
  // as part of the agent's own prose.
  ["guard-agentusage-codex-hold-not-immediate", "server/agent-usage.ts",
    '    const delta = codexLineTokens(state, rawLine.trim());\n    if (delta) state.codexHeldTokens = delta;\n  }\n  return [];\n}',
    '    const delta = codexLineTokens(state, rawLine.trim());\n    if (delta) return [delta];\n  }\n  return [];\n}'],
  // P1 fix 1: codex's token footer is on stderr, not stdout -- the scan call
  // site itself, both the live-stream one and the close-time tail one.
  ["guard-agentusage-codex-stderr-scan-wiring", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, text));', ''],
  ["guard-round2-codex-stderrtail-scan-wiring", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(scanCodexTokens(codexState, stderrTail));', ''],
  ["guard-agentusage-codex-flush-call-site", "server/runner.ts", 'if (codexState) emitCodexTokenDeltas(flushCodexTokens(codexState));', ''],
];
