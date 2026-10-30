export const testsToolingMutations = [
  ["guard-http-test-no-fixed-port", "test/http-helpers.ts", "CC_DATA_DIR: join(root, \"data\"), CC_TEST_FORCE_PACKAGED: \"1\", CC_PORT: \"0\"", "CC_DATA_DIR: join(root, \"data\"), CC_TEST_FORCE_PACKAGED: \"1\", CC_PORT: \"4331\""],

  // ---- Underground defect fixes: Claude-model rejection, inbox env override,
  // realpath containment, filename sanitization, opencode model UI, coder sandbox ----

  // Defect 1 (P1): a Claude model must be rejected whatever the kind, at all
  // three entry points (assignment path, disk loader, WS handler -- WS routes
  // through the assignment path, already proven in underground-ws.test.ts).

  // Defect 2 (P1): production must never read an inbox directory override
  // from the environment; re-introducing it must fail a real test.

  // Guard 1 (structural, replaces the old text-search guard): writeUndergroundHandoff
  // has no default directory, so a caller that omits it throws instead of
  // silently landing in the real vault. These two mutations prove both halves:
  // the runtime check inside inbox.ts, and production's call site actually
  // supplying the argument that check exists to require.

  // The actual regression that happened: reintroducing a default value on
  // `dir` so a forgotten argument silently falls through to the real vault
  // instead of throwing. Caught by the arity check (guard 1) without ever
  // calling the function -- see test/underground.test.ts's comment on why
  // that test can never itself be the thing that writes to the real vault.

  // Belt-and-braces backstop: deleting the test-runner refusal must turn the
  // suite red on its own dedicated test, independent of every other guard.

  // Defect 3 (P1): containment must resolve real paths (follow junctions and
  // symlinks), not just a string-based resolve() -- and must catch the inbox
  // FOLDER ITSELF being a link, not just something inside it.

  // Filename-component sanitization (guard 4): a malformed project id or role
  // must be rejected before it ever reaches a path or the written content.

  // Defect 4 (P2): switching an Underground role to opencode must never
  // submit an empty model.
  // Item 3 (P3, 2026-09-07 review): the one call site that must simulate a
  // packaged launch (http-requests-packaged.test.ts's real-scratch-follows-CC_DATA_DIR test)
  // without disarming server/inbox.ts's real-vault backstop, which reads the
  // exact same NODE_TEST_CONTEXT var.
  ["guard-http-packaged-datadir-call-site", "test/http-requests-packaged.test.ts",
    'env: packagedDataRootChildEnv(process.env, dataDir),',
    'env: packagedDataRootChildEnv({}, dataDir),'],
  ["guard-http-packaged-datadir-keeps-node-test-context", "test/http-requests-packaged.test.ts",
    'function packagedDataRootChildEnv(baseEnv: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {\n  return { ...baseEnv, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1", CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1" };\n}',
    'function packagedDataRootChildEnv(baseEnv: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {\n  const { NODE_TEST_CONTEXT: _s, ...rest } = baseEnv;\n  return { ...rest, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_LEADER_CHECK: "1", CC_SKIP_DISCOVERY: "1", CC_TEST_FAKE_CLI: "1", CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1" };\n}'],
  ["guard-packc-r5-http-server-root-os-temp", "test/http-helpers.ts", 'const root = mkdtempSync(join(tmpdir(), "cc-http-test-"));', 'const root = mkdtempSync(join(process.cwd(), ".cc-test-http-root-"));'],
  ["guard-packc-r5-http-outside-root-os-temp", "test/http-uploads.test.ts", 'const outsideRoot = mkdtempSync(join(tmpdir(), "cc-http-outside-"));', 'const outsideRoot = mkdtempSync(join(process.cwd(), ".cc-test-http-outside-"));'],
];
