export const toolingMutations = [
  ["guard-sweep-confirm-live-flakes", "scripts/sweep/row.mjs", "  for (const [name, prior] of [...finals]) {\n    const flakeKeys = new Set(flakes.keys());", "  const flakeKeys = new Set(flakes.keys());\n  for (const [name, prior] of [...finals]) {"],
  ["guard-sweep-confirm-quiet-error", "scripts/sweep/row.mjs", "status: quiet ? \"ERROR\" : \"SURVIVED\"", "status: \"SURVIVED\""],
  ["guard-sweep-confirm-call", "scripts/sweep/row.mjs", "return outcome.caught ? await confirmCatch(ctx, lane, rec, outcome, quiet) : outcome;", "return outcome;"],
  ["guard-sweep-confirm-file", "scripts/sweep/row.mjs", "testKey(result.catching) === testKey(outcome.caught)", "result.catching.name === outcome.caught.name"],
  ["guard-sweep-confirm-name", "scripts/sweep/row.mjs", "testKey(result.catching) === testKey(outcome.caught)", "result.catching.file === outcome.caught.file"],
  ["guard-sweep-confirm-flakes", "scripts/sweep/row.mjs", "ctx.addFlakes(unconfirmed);", "void unconfirmed;"],
  ["guard-sweep-confirm-pending", "scripts/sweep/row.mjs", "status: quiet ? \"ERROR\" : \"SURVIVED\"", "status: \"RED\""],
  ["guard-sweep-confirm-error", "scripts/sweep/row.mjs", "if (result.outcome !== \"pass\" && result.outcome !== \"assertion\")", "if (false)"],
  ["guard-sweep-confirm-scope", "scripts/sweep/row.mjs", "kind: \"red-confirm\", files: [outcome.caught.file], red: redFlag(rec.name),", "kind: \"red-confirm\", files: null, red: redFlag(rec.name),"],
  ["guard-sweep-confirm-canary", "scripts/sweep/row.mjs", "kind: \"red-confirm\", files: [outcome.caught.file], red: redFlag(rec.name),", "kind: \"red-confirm\", files: [outcome.caught.file], red: true,"],
  ["guard-sweep-confirm-quiet", "scripts/sweep/row.mjs", "rec, () => body(rec, name), true)", "rec, () => body(rec, name), false)"],
  ["guard-sweep-confirm-evidence", "scripts/sweep/row.mjs", "run.catching = result.catching;", "run.catching = null;"],
  ["guard-sweep-r1-reused-root", "scripts/sweep/proctree.mjs", "  tracked.delete(rootPid);\n", ""],
  ["guard-sweep-r1-root-first-sight", "scripts/sweep/proctree.mjs", "root && !tracked.has(rootPid)", "root && tracked.get(rootPid) !== root.created"],
  ["guard-sweep-r1-signal-root", "scripts/sweep/run.mjs", " && child.signalCode === null ? child.pid : undefined", " ? child.pid : undefined"],
  ["guard-sweep-r1-exited-root", "scripts/sweep/run.mjs", "child.exitCode === null && child.signalCode === null ? child.pid : undefined", "child.pid"],
  ["guard-sweep-r1-kill-targets", "scripts/sweep/proctree.mjs", "for (const { pid } of targets) { try { kill(pid);", "for (const { pid } of before) { try { kill(pid);"],
  ["guard-sweep-r1-render-timeout", "test/page-first-render.ts", "await waitFor(expression, label, FIRST_RENDER_MS);", "await waitFor(expression, label);"],
  ["guard-sweep-r1-cleanup-kill-retry", "scripts/sweep/main.mjs", "try { await session.deps.sweep.killTracked(lane.tracked); }", "try { await Promise.resolve(lane.tracked); }"],
  ["guard-sweep-r1-top-level","scripts/sweep/lanes.mjs", "if (!copiedRoots.has(name)) {", "if (false) {"],
  ["guard-sweep-r1-top-level-not-leaked", "scripts/sweep/lanes.mjs", ": report.removed).push(name);", ": report.leaked).push(name);"],
  ["guard-proof-screenshot-directory", "scripts/electron-process-proof.mjs", 'const screenshotPath = join(dir, "electron-process-proof.png");', 'const screenshotPath = join(root, "electron-process-proof.png");'],
  ["guard-temp-root-return", "test/temp-root.ts", 'return dir;', 'return root;'],
  ["guard-temp-root-cleanup", "test/temp-root.ts", 'after(() => removeWithRetry(dir));', ''],
  ["guard-temp-root-safety", "test/temp-root.ts", '    assert.match(rel, /^\\.cc-test-[^\\\\/]+$/, "unsafe test root");', ''],
  ["guard-temp-root-leak-cleanup", "test/temp-root.ts", 'if (rel && !rel.startsWith("..") && !isAbsolute(rel)) rmSync(dir, { recursive: true, force: true });', ''],
  ["guard-temp-root-copy", "test/temp-root.ts", 'for (const name of directories) cpSync(join(root, name), join(dir, name), { recursive: true });', ''],
  ["guard-temp-root-ignore", ".gitignore", '.cc-test-*/', ''],
  ["guard-stale-entry", "scripts/mutation-proof.mjs", "export const mutations = [\n", "export const mutations = [\n  [\"deliberately-stale\", \"server/index.ts\", \"THIS TARGET DOES NOT EXIST\", \"\"],\n"],
  // ---- mutation-harness concurrency lock (scripts/lock.mjs): guard 5 ----
  ["guard-lock-refuses-live", "scripts/lock.mjs", 'if (!aliveCheck(existing.pid)) return { ok: true, stale: true };', 'return { ok: true, stale: true };'],
  ["guard-lock-recovers-stale", "scripts/lock.mjs", 'if (!aliveCheck(existing.pid)) return { ok: true, stale: true };', 'if (false) return { ok: true, stale: true };'],
  ["guard-lock-write-pid", "scripts/lock.mjs", "  const body = JSON.stringify({ pid, startedAt: Date.now(), created: startOf(pid) });\n", "  const body = JSON.stringify({ pid: 0, startedAt: Date.now(), created: startOf(pid) });\n"],

  // ---- MONEY GUARDS: the one-relaunch-per-run guarantee. Proven through the
  // real WS handlers + real runSeat/killSeat plumbing in test/round2-*.test.ts's
  // "MONEY GUARD" tests, never just the pure stall.ts functions in isolation. ----

  // Item 1 (P1): a rejected Run (seat already running) must reset nothing --
  // not the stall tracker's one-relaunch allowance, not the brief/project a
  // later relaunch uses. Each mutation reintroduces the original bug shape:
  // the side effect firing unconditionally, before the result is known.
  // C1 guard-sweep-cleanup-strip-cc-data-dir: deleted: PowerShell text cleanup no longer exists; lane environment stripping is independently covered.
  // C1 guard-sweep-strip-cc-data-dir: rewritten for the current sweep call site.
  ["guard-sweep-strip-cc-data-dir","scripts/sweep/lanes.mjs","CC_DATA_DIR: _dataDir, ",""],
  // C1 guard-mutation-sweep-final-cleanup-retry: rewritten for the current sweep call site.
  ["guard-mutation-sweep-final-cleanup-retry","scripts/sweep/lanes.mjs","if (attempt < REMOVE_ATTEMPTS) sleep(REMOVE_WAIT_MS);","return false;"],

  // ---- home baseline / put-back pack: what each seat is meant to be, and
  // restoring a drifted one -- see server/config.ts's hasSeatDrifted/
  // restoreSeatsToHome, server/index.ts's "restoreSeats" WS handler, and
  // public/app/*.js's own client-side copies. Scoped to what this pack
  // actually touched, per the user's 2026-09-09 rule. ----


  // ---- disable-while-running pack: put back is unavailable whenever any
  // seat (crew or Underground) is running, enforced on both the button and
  // the server -- see server/config.ts's isSeatBusy, server/index.ts's
  // "restoreSeats" refusal, and public/app/*.js's mirrored copy. Scoped to
  // what this pack touched, per the user's 2026-09-09 rule. ----
  ["guard-packc-r2-temp-root-cleanup", "test/temp-root.ts", 'after(() => removeWithRetry(dir));', 'after(() => {});'],
  // C1 guard-packc-r2-test-root-postcheck: rewritten for the current sweep call site.
  ["guard-packc-r2-test-root-postcheck","scripts/sweep/row.mjs","result.outcome === \"pass\" && leaked.length === 0","result.outcome === \"pass\""],
  // C1 guard-sweep-startup-only-own-prefix: rewritten for the current sweep call site.
  ["guard-sweep-startup-only-own-prefix","scripts/sweep/lanes.mjs","entry.startsWith(prefix)","entry.startsWith(\".cc-test-\") || entry.startsWith(prefix)"],
  ["guard-sweep-real-red-exit-code", "scripts/mutation-proof.mjs", "  return code === 1 && /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n", "  return /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n"],
  ["guard-sweep-real-red-assertion-required", "scripts/mutation-proof.mjs", "  return code === 1 && /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n", "  return code === 1;\n"],
  // C1 guard-sweep-red-checked-at-call-site: rewritten for the current sweep call site.
  ["guard-sweep-red-checked-at-call-site","scripts/sweep/row.mjs","if (result.outcome === \"assertion\") return { caught: catchingOf(result) };\n  if (result.outcome === \"pass\") return { status: \"SURVIVED\" };","if (result.outcome !== \"pass\") return { caught: {file: \"test/z.test.ts\", name: \"zz\"} };\n  if (result.outcome === \"pass\") return { status: \"SURVIVED\" };"],
  // C1 guard-sweep-leak-never-makes-red: rewritten for the current sweep call site.
  ["guard-sweep-leak-never-makes-red","scripts/sweep/row.mjs","if (result.outcome === \"pass\") return { status: \"SURVIVED\" };","if (result.outcome === \"pass\") return { status: \"RED\" };"],
  // C1 guard-sweep-baseline-green: rewritten for the current sweep call site.
  ["guard-sweep-baseline-green","scripts/sweep/main.mjs","if (result.outcome === \"pass\" && !leaked.length) {","if (true) {"],
  // C1 guard-sweep-timeout-reported: rewritten for the current sweep call site.
  ["guard-sweep-timeout-reported","scripts/sweep/run.mjs","if (stopReason === \"timeout\" || stopReason === \"aborted\") return stopReason;","if (stopReason === \"aborted\") return stopReason;"],
  // C1 guard-sweep-private-temp: rewritten for the current sweep call site.
  ["guard-sweep-private-temp","scripts/sweep/lanes.mjs","TEMP: lane.temp, TMP: lane.temp,","TEMP: process.env.TEMP, TMP: process.env.TMP,"],
  // C1 guard-sweep-scoped-run-strips-env: rewritten for the current sweep call site.
  ["guard-sweep-scoped-run-strips-env","scripts/sweep/run.mjs","env: laneEnv(lane, red),","env: { ...process.env, ...laneEnv(lane, red) },"],
  // C1 guard-sweep-wholesuite-run-strips-env: rewritten for the current sweep call site.
  ["guard-sweep-wholesuite-run-strips-env","scripts/sweep/lanes.mjs","CC_TEST_FORCE_PACKAGED: _forcePackaged, ",""],
  // C1 guard-sweep-cleanup-matches-own-folder: rewritten: tracked ownership replaces path-text matching.
  ["guard-sweep-cleanup-matches-own-folder","scripts/sweep/proctree.mjs","if (!tracked.has(pid)) throw","if (false) throw"],
  // C1 guard-sweep-cleanup-matches-temp-folder: rewritten: creation identity replaces temp-text matching.
  ["guard-sweep-cleanup-matches-temp-folder","scripts/sweep/proctree.mjs","byPid.get(pid)?.created === tracked.get(pid)","byPid.has(pid)"],
  // C1 guard-sweep-cleanup-excludes-own-shell: rewritten: self and ancestors replace shell-text exclusion.
  ["guard-sweep-cleanup-excludes-own-shell","scripts/sweep/proctree.mjs","new Set([selfPid, ...ancestorPids(byPid, self)])","new Set()"],
  // C1 guard-sweep-cleanup-no-port-kill: rewritten: the kill call site must consult the ownership plan before any kill.
  ["guard-sweep-cleanup-no-port-kill","scripts/sweep/proctree.mjs","const targets = planKill({ list: before, tracked });","const targets = [];"],
  // C1 guard-sweep-parse-check: rewritten for the current sweep call site.
  ["guard-sweep-parse-check","scripts/sweep/row.mjs","if (ctx.syntaxChecked.has(extname(file)) &&","if (false &&"],
  // C1 guard-sweep-dollar-literal: rewritten for the current sweep call site.
  ["guard-sweep-dollar-literal","scripts/sweep/row.mjs","original.replace(from, () => to)","original.replace(from, to)"],
  // C1 guard-sweep-single-match: rewritten for the current sweep call site.
  ["guard-sweep-single-match","scripts/sweep/row.mjs","if (matches > 1) return","if (false) return"],
  // C1 guard-sweep-filter-list: rewritten for the current sweep call site.
  ["guard-sweep-filter-list","scripts/sweep/main.mjs","!filters.length || filters.some((part) => name.includes(part))","true"],
  // C1 guard-sweep-filter-unmatched-rejected: rewritten for the current sweep call site.
  ["guard-sweep-filter-unmatched-rejected","scripts/sweep/main.mjs","if (unmatched.length) throw","if (false) throw"],
  // C1 guard-sweep-cleanup-failure-throws: rewritten for the current sweep call site.
  ["guard-sweep-cleanup-failure-throws","scripts/sweep/run.mjs","if (killError) throw killError;",""],
  // C1 guard-sweep-final-cleanup-failure-releases-lock: rewritten for the current sweep call site.
  ["guard-sweep-final-cleanup-failure-releases-lock","scripts/sweep/main.mjs","cleanup(session); deps.lock.releaseLock(deps.lockPath);","cleanup(session);"],
  // C1 guard-sweep-final-cleanup-failure-keeps-evidence: rewritten: persistent report is written even on cleanup failure.
  ["guard-sweep-final-cleanup-failure-keeps-evidence","scripts/sweep/main.mjs","try { session.finishReport?.(); }","try { /* report omitted */ }"],
  // C1 guard-sweep-final-cleanup-failure-keeps-earlier-error: rewritten for the current sweep call site.
  ["guard-sweep-final-cleanup-failure-keeps-earlier-error","scripts/sweep/main.mjs","if (!thrown) throw session.cleanupFailure;","throw session.cleanupFailure;"],
  // C1 guard-sweep-restores-mutated-file: rewritten for the current sweep call site.
  ["guard-sweep-restores-mutated-file","scripts/sweep/row.mjs","ctx.sweep.writeVerified(lane, file, ctx.sweep.readPristine(lane, file));",""],
  // C1 guard-sweep-evidence-renamed: rewritten: results persist in the report folder, no evidence-folder rename.
  ["guard-sweep-evidence-renamed","scripts/sweep/report.mjs","writeFileSync(join(dir, \"results.json\"), JSON.stringify(m.results, null, 2) + \"\\n\");",""],
  // C1 guard-sweep-evidence-kept: rewritten: survivor/error run logs persist.
  ["guard-sweep-evidence-kept","scripts/sweep/row.mjs","if (status !== \"RED\" || run.keep) run.log =","if (false) run.log ="],
  // C1 guard-sweep-sigint-flag: rewritten for the current sweep call site.
  ["guard-sweep-sigint-flag","scripts/sweep/main.mjs","stop.reason ??= \"Ctrl-C\";","/* stop setter removed */"],
  // C1 guard-sweep-interrupt-checked: rewritten for the current sweep call site.
  ["guard-sweep-interrupt-checked","scripts/sweep/main.mjs","while (groups.length && !stop.requested()) {\n    for (const entry of groups.shift()) {\n      if (stop.requested()) return;","while (groups.length) {\n    for (const entry of groups.shift()) {\n      if (false) return;"],
  // C1 guard-sweep-finished-removes-folder: rewritten: lane removal replaces deleting evidence with the old copy.
  ["guard-sweep-finished-removes-folder","scripts/sweep/main.mjs","session.deps.sweep.removeLane(lane).leftovers","[].concat()"],
  // C1 guard-sweep-old-evidence-removed: deleted: persistent reports must survive future sweeps; cleanupLeftovers retention test protects them.
  // C1 guard-sweep-lock-released: rewritten for the current sweep call site.
  ["guard-sweep-lock-released","scripts/sweep/main.mjs","deps.lock.releaseLock(deps.lockPath);",""],
  ["guard-sweep-copy-list-build","scripts/mutation-proof.mjs","\".gitignore\", \"design/simple/mutate.py\", \"build\"]\n","\".gitignore\", \"design/simple/mutate.py\"]\n"],
  ["guard-sweep-copy-list-mutate-py","scripts/mutation-proof.mjs","\".gitignore\", \"design/simple/mutate.py\", \"build\"]\n","\".gitignore\", \"build\"]\n"],
  ["guard-sweep-design-condition-folder","scripts/mutation-proof.mjs","existsSync(join(repoRoot, \"design\"))","existsSync(join(repoRoot, \"design\", \"simple\", \"mutate.py\"))"],
  ["guard-sweep-design-skip-only-when-absent","scripts/mutation-proof.mjs","!name.startsWith(\"design/\") || hasDesignFolder(REPO_ROOT)","!name.startsWith(\"design/\")"],
  // C1 guard-sweep-temp-removed: rewritten for the current sweep call site.
  ["guard-sweep-temp-removed","scripts/sweep/lanes.mjs","...removeTree(lane.temp, tmpdir()).leftovers","...[]"],
  // C1 guard-sweep-temp-cleared-at-start: rewritten for the current sweep call site.
  ["guard-sweep-temp-cleared-at-start","scripts/sweep/lanes.mjs","[tmpdir(), TEMP_DIR_PREFIX]","[tmpdir(), \"never-matches-\"]"],
  // C1 guard-sweep-temp-clear-only-own-prefix: rewritten for the current sweep call site.
  ["guard-sweep-temp-clear-only-own-prefix","scripts/sweep/lanes.mjs","entry.startsWith(prefix)","true"],
  // C1 guard-sweep-temp-outside-repo: rewritten for the current sweep call site.
  ["guard-sweep-temp-outside-repo","scripts/sweep/lanes.mjs","temp: mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX))","temp: mkdtempSync(join(repoRoot, TEMP_DIR_PREFIX))"],
  ["guard-lock-reused-pid-stale", "scripts/lock.mjs", "  if (now && now !== existing.created) return { ok: true, stale: true };\n", ""],
  ["guard-lock-exclusive-create", "scripts/lock.mjs", "try { writeFileSync(path, body, { flag: \"wx\" }); return; }", "try { writeFileSync(path, body); return; }"],
  ["guard-lock-corrupt-names-path", "scripts/lock.mjs", "    throw new Error(`${path}: the lock file is unreadable (${err.message}). If no sweep is running, delete it.`);\n", "    throw err;\n"],
  ["guard-lock-old-corrupt-abandoned", "scripts/lock.mjs", "    if (Date.now() - statSync(path).mtimeMs > 60_000) return null;\n", ""],
  ["guard-lock-records-start-time", "scripts/lock.mjs", "  const body = JSON.stringify({ pid, startedAt: Date.now(), created: startOf(pid) });\n", "  const body = JSON.stringify({ pid, startedAt: Date.now(), created: null });\n"],
  ["guard-lock-recovery-rejudges-inside-guard","scripts/lock.mjs","    if (held !== undefined && evaluateLock(held, aliveCheck, startOf).ok) {\n","    if (held !== undefined && true) {\n"],
  ["guard-lock-recovery-absent-reread-no-unlink","scripts/lock.mjs","    if (held !== undefined && evaluateLock(","    if (evaluateLock("],
  ["guard-lock-recovery-exclusive-guard", "scripts/lock.mjs", '  try { writeFileSync(guard, String(pid), { flag: "wx" }); }', '  try { writeFileSync(guard, String(pid)); }'],
  ["guard-tempchild-send-error-consumed","test/temp-root.ts","child.send(\"shutdown\", () => { /* the kill below stops a child that did not hear it */ })","child.send(\"shutdown\")"],
  ["guard-tempchild-fails-loudly-when-alive","test/temp-root.ts","  assert.ok(gone(), `child ${child.pid} is still running after the shutdown request, the kill and a ${killWaitMs} ms wait`);\n",""],
  ["guard-pack1-process-data-root-kept","test/pack1-process.test.ts","fakeCliOnPath();\nconst repoRoot","fakeCliOnPath();\nrestoreDataEnv();\nconst repoRoot"],
  ["guard-dist-kill-result-checked","scripts/dist.mjs","{ windowsHide: true, stdio: \"ignore\", timeout: 15000 }).status === 0;","{ windowsHide: true, stdio: \"ignore\", timeout: 15000 }).status === 0 || true;"],
  ["guard-dist-stop-wait-bounded","scripts/dist.mjs","      stopWait = setTimeout(() => {","      stopWait = 0 && setTimeout(() => {"],
  ["guard-livenull-waits-end-on-abort","scripts/live-null-check.mjs","once(target, event, { signal: abort.signal })","once(target, event)"],
  ["guard-electronproof-worker-command-line-checked","scripts/electron-process-proof.mjs",".toLowerCase().includes(workerPath.toLowerCase())) return false;",".toLowerCase().includes(\"\")) return false;"],
  ["guard-electronproof-worker-verified-before-tracked","scripts/electron-process-proof.mjs","  assert.ok(isThisRunsWorker(before, worker, join(dir, \"worker.cjs\"), desktop.pid), `the reported","  assert.ok(true || isThisRunsWorker(before, worker, join(dir, \"worker.cjs\"), desktop.pid), `the reported"],
  ["guard-electronproof-creation-time-compared","scripts/electron-process-proof.mjs","record.created === item.Created && ",""],
  ["guard-electronproof-command-line-compared","scripts/electron-process-proof.mjs"," && record.commandLine === (item.CommandLine ?? null);",";"],
  ["guard-electronproof-cleanup-no-tree-kill","scripts/electron-process-proof.mjs","[\"/pid\", String(item.ProcessId), \"/F\"], { windowsHide: true, stdio: \"ignore\" });","[\"/pid\", String(item.ProcessId), \"/T\", \"/F\"], { windowsHide: true, stdio: \"ignore\" });"],
  ["guard-electronproof-adopts-only-younger-children","scripts/electron-process-proof.mjs"," && item.Created >= parent.Created"," "],
  ["guard-mutate-py-pending-not-caught","design/simple/mutate.py","    if not res or not re.fullmatch(","    if not res or 0 and not re.fullmatch("],
  ["guard-mutate-py-crash-only-not-caught","design/simple/mutate.py","    return any(not re.search(","    return any(True or re.search("],
  ["guard-approvals-modules-on-temp-data-root", "test/approvals.test.ts", "await importWithTempDataRoot(async () => ({", "await ((load: any) => load().then((modules: any) => ({ dataDir: \"\", modules })))(async () => ({"],
  ["guard-dist-exe-fingerprint", "scripts/dist.mjs", "    writeFileSync(nextSidecar, `${digest} *Command Center.exe\\n`);\n", ""],
  ["guard-dist-stale-fingerprint-removed", "scripts/dist.mjs", "      renameSync(sidecar, previousSidecar);\n", "      try { renameSync(sidecar, previousSidecar); } catch {}\n"],
  ["guard-dist-restore-fingerprint", "scripts/dist.mjs", "swapInVerifiedExe(lastGood, \"restore\");", "copyFileSync(lastGood, exe);"],
  // ---- Pack 8: the public export. A hit must stop it before anything is written or committed. -- export-public.test.ts ----
  ["guard-pack8-export-scan-stops","scripts/export-public.mjs","if (hits.size > 0) {","if (false) {"],
  ["guard-pack8-r1-email-noreply-anywhere","scripts/export-public.mjs",String.raw`const EMAIL_OK = /@(?:users\.`,String.raw`const EMAIL_OK = /noreply|@(?:users\.`],
  ["guard-pack8-r1-email-lockfile-exempt","scripts/export-public.mjs",'if (!EMAIL_OK.test(found[0]) && !lockfileDeprecation(label, text, found)) hits.add(','if (!EMAIL_OK.test(found[0]) && label !== "package-lock.json") hits.add('],
  ["guard-pack8-r2-lockfile-exempt-widened","scripts/export-public.mjs",String.raw`return /^\s*"deprecated":/.test(text.slice(text.lastIndexOf("\n", found.index) + 1, found.index));`,"return true;"],
  ["guard-pack8-r2-lockfile-exempt-removed","scripts/export-public.mjs",'if (label !== "package-lock.json" || found[0] !== LOCKFILE_DEPRECATION_EMAIL) return false;',"return false;"],
  ["guard-pack8-r1-profile-token-loose","scripts/export-public.mjs","!PROFILE_TOKEN.test(name)","!/[%$({]/.test(name)"],
  ["guard-pack8-r1-profile-name-stops-at-space","scripts/export-public.mjs",String.raw`[^\\/\r\n"'`,String.raw`[^\\/\s"'`],
  ["guard-pack8-r1-utf16-scan","scripts/export-public.mjs","if (bytes.includes(0)) {","if (false) {"],
  ["guard-pack8-r1-dotdot-prefix-outside","scripts/export-public.mjs",String.raw`inside.split(/[\\/]/)[0] !== ".."`,'!inside.startsWith("..")'],
  ["guard-pack9-build-excludes-own-sessions","package.json","      \"!config/own-sessions.json\",\n",""],
  ["guard-pack9-build-excludes-own-sessions-tmp","package.json","      \"!config/own-sessions.json.tmp\",\n",""],
  // Pack 16: the control crashes a child on purpose, so an attach that does nothing goes red.
  ["guard-pack16-catcher-attach-noop","test/crash-catcher.ts","  if (!pid) return;","  return;"],
  // The inventory of teardown deletes: one bare rmSync of a temp folder put back goes red.
  ["guard-pack16-bare-rmsync-back","test/requests.test.ts","close: () => removeWithRetry(root)","close: () => rmSync(root, { recursive: true, force: true })"],
  // The catcher's own behaviour: the end of procdump is `close`, the wait timer is cleared, old dumps are pruned, a test process attaches to itself.
  ["guard-pack16-codex-day-folder","test/codex-record.ts","new Date(options.day ?? options.now ?? Date.now())","new Date(mtimeMs)"],
  ["guard-pack16-catcher-ends-on-exit","test/crash-catcher.ts","proc.once(\"close\", () => { catcher.closed = true; done(); })","proc.once(\"exit\", () => { catcher.closed = true; done(); })"],
  ["guard-pack16-catcher-timer-kept","test/crash-catcher.ts","    clearTimeout(timer);\n",""],
  ["guard-pack16-catcher-no-retention","test/crash-catcher.ts","  pruneCrashDumps(dumpDir);\n",""],
  ["guard-pack16-self-attach-removed","test/crash-catcher-self.ts","attachCrashCatcher(process.pid, `test-file:${basename(process.argv[1] ?? \"\")}`);",""],
  ["guard-pack16-self-import-removed","test/temp-root.ts","import \"./crash-catcher-self.ts\";\n",""],
  // The test script preloads the catcher into every test file process, including files that never import temp-root.ts.
  ["guard-pack16-preload-all-files","package.json","node --import ./test/crash-catcher-self.ts --test","node --test"],
  // C1 guard-sweep-plan-self: added protection of the current sweep.
  ["guard-sweep-plan-self","scripts/sweep/proctree.mjs","new Set([selfPid, ...ancestorPids(byPid, self)])","new Set(ancestorPids(byPid, self))"],
  // C1 guard-sweep-plan-parent: added protection of the current sweep.
  ["guard-sweep-plan-parent","scripts/sweep/proctree.mjs","...ancestorPids(byPid, self)","...ancestorPids(byPid, self).slice(1)"],
  // C1 guard-sweep-plan-grandparent: added protection of the current sweep.
  ["guard-sweep-plan-grandparent","scripts/sweep/proctree.mjs","...ancestorPids(byPid, self)","...ancestorPids(byPid, self).slice(0, 1)"],
  // C1 guard-sweep-plan-older: added protection of the current sweep.
  ["guard-sweep-plan-older","scripts/sweep/proctree.mjs","if (tracked.get(pid) < self.created)","if (false)"],
  // C1 guard-sweep-plan-missing-self: added protection of the current sweep.
  ["guard-sweep-plan-missing-self","scripts/sweep/proctree.mjs","const self = byPid.get(selfPid);","const self = byPid.get(selfPid) ?? { pid: selfPid, ppid: 0, created: 0 };"],
  // C1 guard-sweep-record-younger: added protection of the current sweep.
  ["guard-sweep-record-younger","scripts/sweep/proctree.mjs","child.created < parent.created || ",""],
  // C1 guard-sweep-record-reused-parent: added protection of the current sweep.
  ["guard-sweep-record-reused-parent","scripts/sweep/proctree.mjs","proc && proc.created === tracked.get(proc.pid)","proc"],
  // C1 guard-sweep-record-dead-parent: added protection of the current sweep.
  ["guard-sweep-record-dead-parent","scripts/sweep/proctree.mjs",".map(([pid]) => byPid.get(pid))",".map(([pid]) => byPid.get(pid) ?? { pid, created: tracked.get(pid) })"],
  // C1 guard-sweep-register-root: added protection of the current sweep.
  ["guard-sweep-register-root","scripts/sweep/run.mjs","unwatch = watchTree(child.pid, lane.tracked);",""],
  // C1 guard-sweep-cleanup-every-run: added protection of the current sweep.
  ["guard-sweep-cleanup-every-run","scripts/sweep/run.mjs","if (lane.tracked.size) await killTracked(lane.tracked);",""],
  // C1 guard-sweep-early-stop-cleanup: added protection of the current sweep.
  ["guard-sweep-early-stop-cleanup","scripts/sweep/run.mjs","stopped = killTracked(lane.tracked, { root }).catch((err) => { killError = err; });","stopped = Promise.resolve();"],
  // C1 guard-sweep-final-cleanup-propagates: added protection of the current sweep.
  ["guard-sweep-final-cleanup-propagates","scripts/sweep/run.mjs","if (lane.tracked.size) await killTracked(lane.tracked);","if (lane.tracked.size) await killTracked(lane.tracked).catch(() => {});"],
  // C1 guard-sweep-only-assertion-early-stop: added protection of the current sweep.
  ["guard-sweep-only-assertion-early-stop","scripts/sweep/run.mjs","failure.cause === \"ERR_ASSERTION\" && !report.catching","!report.catching"],
  // C1 guard-sweep-record-and-continue: added protection of the current sweep.
  ["guard-sweep-record-and-continue","scripts/sweep/main.mjs","if (rec) record(rec);","if (rec) { record(rec); if (rec.status === \"SURVIVED\" && rec.name !== \"control-must-survive\") return; }"],
  // C1 guard-sweep-survivor-setter: added protection of the current sweep.
  ["guard-sweep-survivor-setter","scripts/sweep/row.mjs","return { status: \"SURVIVED\" };","return { status: \"RED\" };"],
  // C1 guard-sweep-survived-exit: added protection of the current sweep.
  ["guard-sweep-survived-exit","scripts/sweep/report.mjs","entry.status === \"RED\" || entry.status === \"SKIPPED\"","entry.status === \"RED\" || entry.status === \"SKIPPED\" || entry.status === \"SURVIVED\""],
  // C1 guard-sweep-error-exit: added protection of the current sweep.
  ["guard-sweep-error-exit","scripts/sweep/report.mjs","entry.status === \"RED\" || entry.status === \"SKIPPED\"","entry.status === \"RED\" || entry.status === \"SKIPPED\" || entry.status === \"ERROR\""],
  // C1 guard-sweep-selected-positive: added protection of the current sweep.
  ["guard-sweep-selected-positive","scripts/sweep/report.mjs","ok: selected.length > 0","ok: true"],
  // C1 guard-sweep-reported-count: added protection of the current sweep.
  ["guard-sweep-reported-count","scripts/sweep/report.mjs","results.length === selected.length && ",""],
  // C1 guard-sweep-reported-unique: added protection of the current sweep.
  ["guard-sweep-reported-unique","scripts/sweep/report.mjs","byName.size === results.length && ",""],
  // C1 guard-sweep-selected-names: added protection of the current sweep.
  ["guard-sweep-selected-names","scripts/sweep/report.mjs","selected.every((name) => byName.has(name))","true"],
  // C1 guard-sweep-canary-red: added protection of the current sweep.
  ["guard-sweep-canary-red","scripts/sweep/report.mjs","ok: byName.get(CANARY)?.status === \"RED\"","ok: true"],
  // C1 guard-sweep-control-survives: added protection of the current sweep.
  ["guard-sweep-control-survives","scripts/sweep/report.mjs","ok: controlNames.every((name) => byName.get(name)?.status === \"SURVIVED\")","ok: true"],
  // C1 guard-sweep-walker-bounds: added protection of the current sweep.
  ["guard-sweep-walker-bounds","scripts/sweep/lanes.mjs","if (!inside || inside.startsWith(\"..\") || isAbsolute(inside)) throw","if (false) throw"],
  // C1 guard-sweep-walker-no-follow: added protection of the current sweep.
  ["guard-sweep-walker-no-follow","scripts/sweep/lanes.mjs","if (info.isSymbolicLink()) return count(path, removeLink);","if (info.isSymbolicLink()) { for (const name of readdirSync(path)) walk(join(path, name)); return count(path, removeLink); }"],
  // C1 guard-sweep-slot-budget: added protection of the current sweep.
  ["guard-sweep-slot-budget","scripts/sweep/lanes.mjs","used + waiting[0].count <= total","true"],
  // C1 guard-sweep-quiet-exclusion: added protection of the current sweep.
  ["guard-sweep-quiet-exclusion","scripts/sweep/row.mjs","quiet ? ctx.slots.total : concurrency","concurrency"],
  // C1 guard-sweep-restored-catching-only: added protection of the current sweep.
  ["guard-sweep-restored-catching-only","scripts/sweep/row.mjs","files: [file], red: false","files: null, red: false"],
  // C1 guard-sweep-own-priority-call: added protection of the current sweep.
  ["guard-sweep-own-priority-call","scripts/sweep/main.mjs","const priority = deps.sweep.lowerOwnPriority();","const priority = 10;"],
  // C1 guard-sweep-child-priority-call: added protection of the current sweep.
  ["guard-sweep-child-priority-call","scripts/sweep/run.mjs","os.setPriority(child.pid, SWEEP_PRIORITY);",""],
  // C1 guard-sweep-stop-detection: added protection of the current sweep.
  ["guard-sweep-stop-detection","scripts/sweep/main.mjs","existsSync(join(dir, \"STOP\"))","false"],
  // C1 guard-sweep-stop-consumption: added protection of the current sweep.
  ["guard-sweep-stop-consumption","scripts/sweep/main.mjs","unlinkSync(join(dir, \"STOP\"));",""],
  // C1 guard-sweep-stop-setter: added protection of the current sweep.
  ["guard-sweep-stop-setter","scripts/sweep/main.mjs","stop.reason = \"STOP file\";",""],
  // C1 guard-sweep-until-setter: added protection of the current sweep.
  ["guard-sweep-until-setter","scripts/sweep/main.mjs","stop.reason = \"--until\";","stop.reason = null;"],
  // C1 guard-sweep-second-sigint: added protection of the current sweep.
  ["guard-sweep-second-sigint","scripts/sweep/main.mjs","else hardStop(\"second Ctrl-C\");","else {}"],
  // C1 guard-sweep-resume-head: added protection of the current sweep.
  ["guard-sweep-resume-head","scripts/sweep/main.mjs","if (state.head !== now.head) return","if (false) return"],
  // C1 guard-sweep-resume-dirty: added protection of the current sweep.
  ["guard-sweep-resume-dirty","scripts/sweep/main.mjs","if (now.dirty) return","if (false) return"],
  // C1 guard-sweep-resume-vanished: added protection of the current sweep.
  ["guard-sweep-resume-vanished","scripts/sweep/main.mjs","state.selected.filter((name) => !names.has(name))","[]"],
  // C1 guard-sweep-resume-complete: added protection of the current sweep.
  ["guard-sweep-resume-complete","scripts/sweep/main.mjs","if (state.selected.every((name) => finals.has(name)) &&","if (false &&"],
  // C1 guard-sweep-never-checked-scheduling: added protection of the current sweep.
  ["guard-sweep-never-checked-scheduling","scripts/sweep/main.mjs","buildGroups(todo, controlNames, checked)","buildGroups(todo, controlNames, new Set())"],
  // C1 guard-sweep-incomplete-no-map: added protection of the current sweep.
  ["guard-sweep-incomplete-no-map","scripts/sweep/main.mjs","if (complete && !failed && controls.every((control) => control.ok))","if (!failed && controls.every((control) => control.ok))"],
  // C1 guard-sweep-failed-no-map: added protection of the current sweep.
  ["guard-sweep-failed-no-map","scripts/sweep/main.mjs","if (complete && !failed && controls.every((control) => control.ok))","if (complete && controls.every((control) => control.ok))"],
  // C1 guard-sweep-controls-no-map: added protection of the current sweep.
  ["guard-sweep-controls-no-map","scripts/sweep/main.mjs","if (complete && !failed && controls.every((control) => control.ok))","if (complete && !failed)"],
  // C1 guard-sweep-record-survivor: added protection of the actual result-recording call site.
  ["guard-sweep-record-survivor","scripts/sweep/main.mjs","if (rec) record(rec);","if (rec && rec.status !== \"SURVIVED\") record(rec);"],
];
