export const pack32KeyMutations = [
  ["p32-key-validation", "server/settings/cli-key-profiles.ts", 'if (!Object.hasOwn(raw, field.id) || typeof value !== "string" || /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/u.test(value)) throw new Error("Invalid key field value.");\n    const trimmed = value.trim();\n    if (field.kind === "secret" && (Buffer.byteLength(trimmed) < 8 || Buffer.byteLength(trimmed) > 4096)) throw new Error("The key must be between 8 and 4096 bytes.");', 'if (typeof value !== "string") throw new Error("Invalid key field value.");\n    const trimmed = value.trim();'],
  ["p32-key-unknown-field", "server/settings/cli-key-profiles.ts", 'if (Object.keys(raw).some((id) => !fields.some((field) => field.id === id))) throw new Error("Unknown key field.");', '/* mutation: unknown fields accepted */'],
  ["p32-key-unavailable", "server/settings/cli-key.ts", 'if (this.#closed || !this.store.available()) throw new Error(record ? UNSAFE_KEY_STORE : UNSAFE_KEY_REMOVAL);', 'if (this.#closed) throw new Error(UNSAFE_KEY_STORE);'],
  ["p32-key-argv", "server/leader-acp.ts", '(deps.cli.program, deps.cli.args, { cwd: tabFolder, env: leaderChildEnv(key?.env, deps.cli.program, tabFolder),', '(deps.cli.program, [...deps.cli.args, ...(key?.secrets ?? [])], { cwd: tabFolder, env: leaderChildEnv(key?.env, deps.cli.program, tabFolder),'],
  ["p32-key-global-env", "server/leader-acp.ts", 'env: leaderChildEnv(key?.env, deps.cli.program, tabFolder), stdio:', 'env: Object.assign(process.env, key?.env), stdio:'],
  ["p32-key-wrong-tool", "server/settings/cli-key.ts", 'const record = this.#cache.get(tool.id);', 'const record = [...this.#cache.values()].find(Boolean);'],
  ["p32-key-endpoint", "server/settings/cli-key-profiles.ts", 'if (field.kind === "choice" && !field.choices!.some((choice) => choice.value === value)) throw new Error("Choose an allowed region.");', '/* mutation: endpoint accepted */'],
  ["p32-key-redaction", "server/leader-acp.ts", 'secrets = secretVariants([deps.bridge?.token ?? "", ...(key?.secrets ?? [])]);', 'secrets = secretVariants([deps.bridge?.token ?? ""]);'],
  ["p32-key-proof", "server/settings/cli-key.ts", 'target.signedIn = null; target.connection = "unknown";', 'target.signedIn = true; target.connection = "verified";'],
  ["p32-key-shutdown", "server/settings/cli-key.ts", 'this.#cache.clear();', '/* mutation: cache retained */'],
  ["p32-key-admission", "server/settings/cli-key.ts", 'this.#busy.add(tool);', '/* mutation: admission omitted */'],
  ["p32-key-run-prepare", "server/main/messages/setups-runs.ts", "void settingsService.cliKeys.prepareConnection(keyConnection).then(launch)", "void Promise.resolve().then(launch)"],
  ["p32-onrun-sync", "server/main/messages/setups-runs.ts", "function onRun(ws: WebSocket, message: any): void {", "async function onRun(ws: WebSocket, message: any): Promise<void> {"],
  ["p32-key-read-retry", "server/settings/cli-key.ts", "saved = await this.store.get(tool);\n          }", "throw new Error(\"mutation: no retry\");\n          }"],
  ["p32-key-timeout-cache", "server/settings/cli-key.ts", "this.#cache.delete(tool);", "/* mutation: stale cached key retained */"],
  ["p32-key-minimum", "server/settings/cli-key-profiles.ts", "Buffer.byteLength(trimmed) < 8", "Buffer.byteLength(trimmed) < 1"],
  ["p32-key-runner-redaction", "server/runner.ts", "const secrets = secretVariants(keyLaunch?.secrets ?? []);", "const secrets = secretVariants([]);"],
  ["p32-key-case-env", "server/leader-common/cli-path.ts", "if (overridden.has(key.toLowerCase())) delete childEnv[key];", "if (overridden.has(key)) delete childEnv[key];"],
  ["p32-fix-unavailable-read", "server/settings/cli-key.ts", "if (!this.store.available()) return; // Encryption is unavailable here, so no key can exist.", "/* mutation: no availability re-check */"],
  ["p32-fix-legacy-signin", "server/settings/cli-key.ts", 'this.state.tools[tool as keyof SettingsState["tools"]].signedIn = null;', 'this.state.tools[tool as keyof SettingsState["tools"]].signedIn = false;'],
  ["p32-fix-removal-text", "server/settings/cli-key.ts", "throw new Error(record ? UNSAFE_KEY_STORE : UNSAFE_KEY_REMOVAL);\n      }\n      finally", "throw new Error(UNSAFE_KEY_STORE);\n      }\n      finally"],
  ["p32-fix-model-trim", "server/settings/cli-key-profiles.ts", '.test(trimmed)) throw new Error("Invalid model name.");', '.test(value)) throw new Error("Invalid model name.");'],
  ["p32-fix-launch-wiring", "server/main/launch.ts", "{ keyLaunch: acp ? settingsService.cliKeys.launch(acp) : undefined }", "{}"],
  ["p32-fix-leader-loadkey", "server/main/leader-session.ts", "loadKey: async () => { await settingsService.cliKeys.prepareConnection(acp); return settingsService.cliKeys.launch(acp); }, ", ""],
  ["p32-fix-fixed-prepare", "server/main/fixed-task-tools.ts", "if (keyConnection) await settingsService.cliKeys.prepareConnection(keyConnection);", "/* mutation: fixed task skips preparation */"],
  ["p32-refresh-bounded", "server/settings/cli-key.ts", "await Promise.race([reads, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);", "await reads;"],
  ["p32-fake-mode-store", "server/settings/cli-key-store.ts", 'if (this.channel === process && process.env.CC_TEST_FAKE_CLI === "1") return false; ', "/* mutation: fake mode talks to the parent */ "],
];
export const pack32KeyCatchMap = Object.fromEntries(pack32KeyMutations.map(([id]) => [id, ["p32-key-argv", "p32-key-global-env", "p32-key-redaction"].includes(id) ? "test/pack32-key-launch.test.ts" : "test/pack32-key.test.ts"]));

Object.assign(pack32KeyCatchMap, {"p32-key-run-prepare": "test/pack32-key-recovery.test.ts", "p32-key-read-retry": "test/pack32-key-recovery.test.ts", "p32-key-timeout-cache": "test/pack32-key-recovery.test.ts", "p32-key-minimum": "test/pack32-key-recovery.test.ts", "p32-key-runner-redaction": "test/pack32-key-runner.test.ts", "p32-key-case-env": "test/pack32-key-recovery.test.ts"});

Object.assign(pack32KeyCatchMap, {"p32-fix-unavailable-read": "test/pack32-key-recovery.test.ts", "p32-fix-legacy-signin": "test/pack32-key.test.ts", "p32-fix-removal-text": "test/pack32-key-recovery.test.ts", "p32-fix-model-trim": "test/pack32-key-recovery.test.ts", "p32-fix-launch-wiring": "test/pack32-key-callsites.test.ts", "p32-fix-leader-loadkey": "test/pack32-key-callsites.test.ts", "p32-fix-fixed-prepare": "test/pack32-key-callsites.test.ts"});

Object.assign(pack32KeyCatchMap, {"p32-refresh-bounded": "test/pack32-key-refresh.test.ts", "p32-fake-mode-store": "test/pack32-key-refresh.test.ts"});

Object.assign(pack32KeyCatchMap, {"p32-onrun-sync": "test/pack32-onrun-dispatch.test.ts"});
