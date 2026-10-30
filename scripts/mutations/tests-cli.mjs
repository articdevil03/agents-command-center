export const testsCliMutations = [
  ["guard-anycli-boot-failure-cleans-up","test/any-cli-helpers.ts","return wait(state, \"initial state\"); }).catch(abandon);","return wait(state, \"initial state\"); }).catch((error) => { child.kill(); throw error; });"],
  ["guard-anycli-teardown-checks-command-line","test/any-cli-helpers.ts","  return FAKE_CLI_SCRIPTS.some((name) => line.includes(name)) && line.includes(runFolder);","  return true;"],
  ["guard-anycli-teardown-requires-run-folder","test/any-cli-helpers.ts"," && line.includes(runFolder);",";"],
  ["guard-anycli-boot-failure-reports-surviving-server","test/any-cli-helpers.ts","    const stillRunning = child.exitCode === null && child.signalCode === null;","    const stillRunning = false;"],
  ["guard-anycli-boot-failure-kills-server","test/any-cli-helpers.ts","    if (!exit) { try { child.kill(); } catch { /* already gone */ } await Promise.race([closed, sleep(5000)]); }","    if (!exit) { await Promise.race([closed, sleep(5000)]); }"],
  ["guard-anycli-teardown-checks-creation-time","test/any-cli-helpers.ts","  if (!proc || Math.abs(proc.created - loggedStartedAt) >= FAKE_CLI_CREATION_TOLERANCE_MS) return false;","  if (!proc) return false;"],
];
