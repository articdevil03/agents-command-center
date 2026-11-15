// Bundled-runtime launch and child isolation guards. Each target is unique.
export const pack29RuntimeMutations = [
  [
    "p29-runtime-path",
    "electron/server-process.js",
    "spawn(runtime.command, runtime.args, {",
    "spawn(\"node\", runtime.args, {"
  ],
  [
    "p29-runtime-missing",
    "electron/node-runtime.js",
    "executable = process.execPath",
    "executable = process.execPath + \".missing\""
  ],
  [
    "p29-runtime-flag-setter",
    "electron/node-runtime.js",
    "env: { ELECTRON_RUN_AS_NODE: \"1\" }",
    "env: {}"
  ],
  [
    "p29-env-first-import",
    "server/index.ts",
    "import \"./runtime-env.ts\";",
    ""
  ],
  [
    "p29-env-worker",
    "server/leader-common/cli-path.ts",
    "return stripElectronNodeEnv({ ...childEnv, NoDefaultCurrentDirectoryInExePath: \"1\", ...extra });",
    "return { ...childEnv, NoDefaultCurrentDirectoryInExePath: \"1\", ...extra };"
  ],
  [
    "p29-env-settings",
    "server/settings/cli-runner.ts",
    "stripElectronNodeEnv({ ...inherited, ...options.env, NoDefaultCurrentDirectoryInExePath: \"1\" })",
    "({ ...inherited, ...options.env, NoDefaultCurrentDirectoryInExePath: \"1\" })"
  ],
  [
    "p29-env-sdk",
    "server/leader-common/children.ts",
    "delete process.env[key]; } await import",
    "void 0; } await import"
  ],
  [
    "p29-sdk-fallback",
    "server/leader-common/children.ts",
    "command = process.execPath;",
    "command = \"node\";"
  ],
  [
    "p29-env-git",
    "server/leader-common/cli-path.ts",
    "return stripElectronNodeEnv({ ...childEnv, NoDefaultCurrentDirectoryInExePath: \"1\", ...extra });",
    "return Object.keys(extra).length ? stripElectronNodeEnv({ ...childEnv, ...extra }) : { ...childEnv, NoDefaultCurrentDirectoryInExePath: \"1\" };"
  ],
  [
    "p29-tree-killer",
    "server/leader-common/process-tree.ts",
    "...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: \"1\" } : {})",
    "...{}"
  ]
];

pack29RuntimeMutations.push(["p29-runtime-r1-discovery-spawn-gate","server/cli-discovery.ts","  if (spawnFn === spawn && (process.env.CC_TEST_FAKE_CLI === \"1\" || process.env.NODE_TEST_CONTEXT !== undefined)) return Promise.resolve(null);",""]);
pack29RuntimeMutations.push(["p29-runtime-r1-discovery-query-gate","server/cli-discovery.ts","  if (queryFn === query && (process.env.CC_TEST_FAKE_CLI === \"1\" || process.env.NODE_TEST_CONTEXT !== undefined)) return { values: [...fallback], fallback: true };",""]);
