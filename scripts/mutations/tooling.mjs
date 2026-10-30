export const toolingMutations = [
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
  ["guard-sweep-cleanup-strip-cc-data-dir", "scripts/mutation-proof.mjs",
    '    const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...cleanupEnv } = process.env;\n    // A failed or timed-out',
    '    const cleanupEnv = process.env;\n    // A failed or timed-out'],
  ["guard-sweep-strip-cc-data-dir", "scripts/mutation-proof.mjs", "      const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...childEnv } = process.env;\n      const env = {", "      const childEnv = process.env;\n      const env = {"],
  ["guard-mutation-sweep-final-cleanup-retry", "scripts/mutation-proof.mjs", "    removeWithRetry(sweepTmp);\n    if (completed) {\n      removeWithRetry(directory);", "    rmSync(sweepTmp, { recursive: true, force: true });\n    if (completed) {\n      removeWithRetry(directory);"],

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
  ["guard-packc-r2-test-root-postcheck", "scripts/mutation-proof.mjs", "        if (!red) code = 1;\n", ""],
  ["guard-sweep-startup-only-own-prefix", "scripts/mutation-proof.mjs", "    if (entry.startsWith(MUTATION_DIR_PREFIX)) removeWithRetry(resolve(root, entry));\n", "    if (entry.startsWith(\".cc-test-\")) removeWithRetry(resolve(root, entry));\n"],
  ["guard-sweep-real-red-exit-code", "scripts/mutation-proof.mjs", "  return code === 1 && /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n", "  return /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n"],
  ["guard-sweep-real-red-assertion-required", "scripts/mutation-proof.mjs", "  return code === 1 && /^\\s*AssertionError \\[ERR_ASSERTION\\]/m.test(output);\n", "  return code === 1;\n"],
  ["guard-sweep-red-checked-at-call-site", "scripts/mutation-proof.mjs", "\n      assert.ok(isRealRed(red.code, red.output), ", "\n      assert.ok(true, "],
  ["guard-sweep-leak-never-makes-red", "scripts/mutation-proof.mjs", "        if (!red) code = 1;\n", "        code = 1;\n"],
  ["guard-sweep-baseline-green", "scripts/mutation-proof.mjs", "\n    assert.equal(baseline.code, 0, ", "\n    assert.ok(true, "],
  ["guard-sweep-timeout-reported", "scripts/mutation-proof.mjs", "      if (result.error?.code === \"ETIMEDOUT\") {\n", "      if (false) {\n"],
  ["guard-sweep-private-temp", "scripts/mutation-proof.mjs", "TEMP: sweepTmp, TMP: sweepTmp, CC_MUTATION_PROOF: red ? \"1\" : \"\" };\n", "TEMP: process.env.TEMP, TMP: process.env.TMP, CC_MUTATION_PROOF: red ? \"1\" : \"\" };\n"],
  ["guard-sweep-scoped-run-strips-env", "scripts/mutation-proof.mjs", "{ encoding: \"utf8\", timeout: runTimeoutMs, windowsHide: true, env })\n      : spawnSync(\"npm.cmd\"", "{ encoding: \"utf8\", timeout: runTimeoutMs, windowsHide: true, env: { ...process.env, ...env } })\n      : spawnSync(\"npm.cmd\""],
  ["guard-sweep-wholesuite-run-strips-env", "scripts/mutation-proof.mjs", "spawnSync(\"npm.cmd\", [\"test\"], { shell: true, encoding: \"utf8\", timeout: runTimeoutMs, windowsHide: true, env });\n", "spawnSync(\"npm.cmd\", [\"test\"], { shell: true, encoding: \"utf8\", timeout: runTimeoutMs, windowsHide: true, env: { ...process.env, ...env } });\n"],
  ["guard-sweep-cleanup-matches-own-folder", "scripts/mutation-proof.mjs", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($false -or $_.CommandLine.Contains('${escapedTmp}'))"],
  ["guard-sweep-cleanup-matches-temp-folder", "scripts/mutation-proof.mjs", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $false)"],
  ["guard-sweep-cleanup-excludes-own-shell", "scripts/mutation-proof.mjs", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))"],
  ["guard-sweep-cleanup-no-port-kill", "scripts/mutation-proof.mjs", "\n      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))", "\n      `Get-NetTCPConnection -LocalPort 4332 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${escaped}') -or $_.CommandLine.Contains('${escapedTmp}'))"],
  ["guard-sweep-parse-check", "scripts/mutation-proof.mjs", "      if (SYNTAX_CHECKED.has(extname(file)) && parses(file, original) && !parses(file, mutated)) {\n", "      if (false) {\n"],
  ["guard-sweep-dollar-literal", "scripts/mutation-proof.mjs", "      const mutated = original.replace(from, () => to);\n", "      const mutated = original.replace(from, to);\n"],
  ["guard-sweep-single-match", "scripts/mutation-proof.mjs", "\n      assert.equal(matches, 1, `", "\n      assert.ok(matches >= 1, `"],
  ["guard-sweep-filter-list", "scripts/mutation-proof.mjs", "      if (filters.length && !filters.some((part) => name.includes(part))) continue; // argv[2]: comma-separated name parts\n", ""],
  ["guard-sweep-filter-unmatched-rejected", "scripts/mutation-proof.mjs", "\n  if (unmatchedFilters.length) throw new Error(", "\n  if (false) throw new Error("],
  ["guard-sweep-cleanup-failure-throws", "scripts/mutation-proof.mjs", "    if (cleanup.error || cleanup.status !== 0) {\n", "    if (false) {\n"],
  ["guard-sweep-final-cleanup-failure-releases-lock", "scripts/mutation-proof.mjs", "    try { killStrayServers(); } catch (err) { cleanupFailure = err; completed = false; }\n", "    killStrayServers();\n"],
  ["guard-sweep-final-cleanup-failure-keeps-evidence", "scripts/mutation-proof.mjs", "catch (err) { cleanupFailure = err; completed = false; }\n", "catch (err) { cleanupFailure = err; }\n"],
  ["guard-sweep-final-cleanup-failure-keeps-earlier-error", "scripts/mutation-proof.mjs", "      if (!sweepError) throw cleanupFailure;\n", "      throw cleanupFailure;\n"],
  ["guard-sweep-restores-mutated-file", "scripts/mutation-proof.mjs", "if (file === \"test/temp-root.ts\") restoreTree(); else writeFileVerified(file, originalBytes);", "if (file === \"test/temp-root.ts\") restoreTree();"],
  ["guard-sweep-evidence-renamed", "scripts/mutation-proof.mjs", "\n      try { renameSync(directory, kept); console.log(", "\n      try { console.log("],
  ["guard-sweep-evidence-kept", "scripts/mutation-proof.mjs", "        if (!/\\.txt$/.test(entry) && entry !== \"results.json\") removeWithRetry(resolve(directory, entry));\n", "        removeWithRetry(resolve(directory, entry));\n"],
  ["guard-sweep-sigint-flag", "scripts/mutation-proof.mjs", "  process.on(\"SIGINT\", () => { interrupted = true; });\n", "  process.on(\"SIGINT\", () => {});\n"],
  ["guard-sweep-interrupt-checked", "scripts/mutation-proof.mjs", "\n      if (interrupted) throw new Error(", "\n      if (false) throw new Error("],
  ["guard-sweep-finished-removes-folder", "scripts/mutation-proof.mjs", "    if (completed) {\n      removeWithRetry(directory);\n", "    if (completed) {\n"],
  ["guard-sweep-old-evidence-removed", "scripts/mutation-proof.mjs", "        if (entry.startsWith(EVIDENCE_PREFIX)) removeWithRetry(resolve(root, entry));\n", ""],
  ["guard-sweep-lock-released", "scripts/mutation-proof.mjs", "    releaseLock(LOCK_PATH);\n", ""],
  ["guard-sweep-copy-list-build","scripts/mutation-proof.mjs","\".gitignore\", \"design/simple/mutate.py\", \"build\"]\n","\".gitignore\", \"design/simple/mutate.py\"]\n"],
  ["guard-sweep-copy-list-mutate-py","scripts/mutation-proof.mjs","\".gitignore\", \"design/simple/mutate.py\", \"build\"]\n","\".gitignore\", \"build\"]\n"],
  ["guard-sweep-design-condition-folder","scripts/mutation-proof.mjs","existsSync(join(repoRoot, \"design\"))","existsSync(join(repoRoot, \"design\", \"simple\", \"mutate.py\"))"],
  ["guard-sweep-design-skip-only-when-absent","scripts/mutation-proof.mjs","!name.startsWith(\"design/\") || hasDesignFolder(REPO_ROOT)","!name.startsWith(\"design/\")"],
  ["guard-sweep-temp-removed", "scripts/mutation-proof.mjs", "    removeWithRetry(sweepTmp);\n    if (completed) {", "    if (completed) {"],
  ["guard-sweep-temp-cleared-at-start", "scripts/mutation-proof.mjs", "    if (entry.startsWith(TEMP_DIR_PREFIX)) removeWithRetry(resolve(tmpdir(), entry));\n", ""],
  ["guard-sweep-temp-clear-only-own-prefix", "scripts/mutation-proof.mjs", "    if (entry.startsWith(TEMP_DIR_PREFIX)) removeWithRetry(resolve(tmpdir(), entry));\n", "    removeWithRetry(resolve(tmpdir(), entry));\n"],
  ["guard-sweep-temp-outside-repo", "scripts/mutation-proof.mjs", "const sweepTmp = mkdtempSync(resolve(tmpdir(), TEMP_DIR_PREFIX));\n", "const sweepTmp = mkdtempSync(resolve(root, TEMP_DIR_PREFIX));\n"],
  ["guard-lock-reused-pid-stale", "scripts/lock.mjs", "  if (now && now !== existing.created) return { ok: true, stale: true };\n", ""],
  ["guard-lock-exclusive-create", "scripts/lock.mjs", "try { writeFileSync(path, body, { flag: \"wx\" }); return; }", "try { writeFileSync(path, body); return; }"],
  ["guard-lock-corrupt-names-path", "scripts/lock.mjs", "    throw new Error(`${path}: the lock file is unreadable (${err.message}). If no sweep is running, delete it.`);\n", "    throw err;\n"],
  ["guard-lock-old-corrupt-abandoned", "scripts/lock.mjs", "    if (Date.now() - statSync(path).mtimeMs > 60_000) return null;\n", ""],
  ["guard-lock-records-start-time", "scripts/lock.mjs", "  const body = JSON.stringify({ pid, startedAt: Date.now(), created: startOf(pid) });\n", "  const body = JSON.stringify({ pid, startedAt: Date.now(), created: null });\n"],
  ["guard-lock-recovery-rejudges-inside-guard","scripts/lock.mjs","    if (held !== undefined && evaluateLock(held, aliveCheck, startOf).ok) {\n","    if (held !== undefined && true) {\n"],
  ["guard-lock-recovery-absent-reread-no-unlink","scripts/lock.mjs","    if (held !== undefined && evaluateLock(","    if (evaluateLock("],
  ["guard-lock-recovery-exclusive-guard", "scripts/lock.mjs", '  try { writeFileSync(guard, String(pid), { flag: "wx" }); }', '  try { writeFileSync(guard, String(pid)); }'],
  ["guard-approvalmutation-runner-strips-data-dir", "test/approval-mutation-proof.mjs", "    const { CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, ...childEnv } = process.env;\n", "    const childEnv = process.env;\n"],
  ["guard-approvalmutation-runner-private-temp","test/approval-mutation-proof.mjs","TEMP: privateTmp, TMP: privateTmp, ",""],
  ["guard-approvalmutation-runner-stops-timed-out-descendants","test/approval-mutation-proof.mjs","    if (result.error) stopOwned();\n",""],
  ["guard-approvalmutation-runner-removes-private-temp","test/approval-mutation-proof.mjs","  removeWithRetry(privateTmp);",""],
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
  ["guard-approvalmutation-runner-verified-write", "test/approval-mutation-proof.mjs", "try { writeVerified(target, source.replace(from, () => to)); result", "try { writeFileSync(target, source.replace(from, () => to)); result"],
  ["guard-approvalmutation-runner-real-red", "test/approval-mutation-proof.mjs", "    assert.ok(isRealRed(result.status, result.output), ", "    assert.ok(true, "],
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
];
