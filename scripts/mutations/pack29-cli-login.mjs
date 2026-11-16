// Pack 29 W5 sign-in guards, server side. Each row removes or weakens ONE production guard; the catching file is named per row (catch-map.json
// carries the same names) so the proof run stays scoped. Rows that guard the real vendor programs run through fakes only, never a vendor.
const policy = "server/settings/cli-login-policy.js";
const login = "server/settings/cli-login.ts";
const runner = "server/settings/cli-login-runner.ts";
const output = "server/settings/cli-login-output.ts";
const auth = "server/settings/cli-auth.ts";
const service = "server/settings/setup-actions.ts";
const rows = [];
export const pack29CliLoginCatchMap = {};
function row(name, file, from, to, test) {
  const id = `p29-cli-login-${name}`;
  rows.push([id, file, from, to]);
  pack29CliLoginCatchMap[id] = `test/${test}.test.ts`;
}
const logic = "pack29-cli-login", proc = "pack29-cli-login-process", safety = "pack29-service-spawn-safety", plain = "pack29-default-runner-safety";

// Host validation: the browser opener only ever sees an address that passes every one of these.
row("host-https", policy, 'url.protocol !== "https:" || url.username', "url.username", logic);
row("host-userinfo", policy, "url.username || url.password || ", "", logic);
row("host-port", policy, "url.port || ", "", logic);
row("host-allowlist", policy, "!policy.hosts.includes(url.hostname) || ", "", logic);
row("host-path", policy, '!policy.paths.some((path) => path.endsWith("/") ? url.pathname.startsWith(path) : url.pathname === path)', "false", logic);
row("host-encoded-separators", policy, "if (/%(?:2f|5c|2e)/i.test(url.pathname)) return null;", "if (false) return null;", logic);
row("host-controls", policy, String.raw` || /[\s\u0000-\u001f\u007f\\]/.test(value)`, "", logic);
// A pasted code is plain text: no address, no control character, bounded length.
row("code-url", policy, String.raw` && !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|mailto|file|data|javascript):|www\.)/i.test(value)`, "", logic);
row("code-length", policy, String.raw`{1,2048}$/`, String.raw`{1,4096}$/`, logic);
row("code-printable", policy, String.raw`/^[\x20-\x7e]{1,2048}$/`, String.raw`/^[\s\x20-\x7e]{1,2048}$/`, logic);

// Fixed request keys: a request names only its type, ids and the one private field of its kind.
row("request-extra-keys", login, "Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) || Object.keys(value).some((field) => !fields.includes(field)) || ",
  "fields.some((field) => !Object.hasOwn(value, field)) || ", logic);

// Capability ownership, tool ownership, waiting state, rate limit, attempt ceiling and the attempt setter.
row("capability-match", login, " || !op.capability || op.capability !== message.loginId", "", logic);
row("tool-ownership", login, "op.id !== message.cli || !op.capability", "!op.capability", logic);
row("capability-running-only", login, ' || op.event.status !== "running" || op.abort.signal.aborted) throw new Error("Sign-in is already running. Cancel to start again.");',
  ') throw new Error("Sign-in is already running. Cancel to start again.");', logic);
row("waiting-state", login, 'op.event.phase !== "waitingCode" || !op.event.pasteRequired || !op.child?.writable()', "false", logic);
row("waiting-child-writable", login, " || !op.child?.writable()", "", logic);
row("rate-limit", login, 'if (op.attempts >= 5 || now - op.lastAttempt < 2000) throw new Error("Wait before submitting another code.");', 'if (false) throw new Error("Wait before submitting another code.");', logic);
row("attempt-ceiling", login, 'if (op.attempts >= 5 || now - op.lastAttempt < 2000) throw new Error("Wait before submitting another code.");', 'if (now - op.lastAttempt < 2000) throw new Error("Wait before submitting another code.");', logic);
row("attempt-spacing", login, 'if (op.attempts >= 5 || now - op.lastAttempt < 2000) throw new Error("Wait before submitting another code.");', 'if (op.attempts >= 5) throw new Error("Wait before submitting another code.");', logic);
row("attempt-setter", login, "op.attempts++; op.lastAttempt = now;\n      if (!validLoginCode", "op.lastAttempt = now;\n      if (!validLoginCode", logic);
row("paste-once", login, "op.parser.consumePaste(); op.event.pasteRequired = false;", "op.parser.consumePaste();", logic);
// Admission: the synchronous lock, shared with the installer.
row("admission-setter", login, "this.active = op; // Synchronous lock before the first await, shared with installer admission.", "/* lock omitted */", logic);
row("admission-installer-busy", login, "this.active || this.deps.busy() || ", "this.active || ", logic);
// Secret handling: the capability, address and code leave the event when it ends and never enter shared state.
row("secret-clear-capability", login, "{ loginId: null, verificationUrl: null, deviceCode: null,", "{ verificationUrl: null, deviceCode: null,", logic);
row("secret-clear-address", login, "{ loginId: null, verificationUrl: null, deviceCode: null,", "{ loginId: null, deviceCode: null,", logic);
row("secret-shared-state", login, 'const action = { requestId: op.requestId, kind: "login" as const, phase, reason, status,',
  'const action = { requestId: op.requestId, kind: "login" as const, phase, reason, status, verificationUrl: op.event.verificationUrl,', logic);
// Truthful success: only a positive supported status probe means signed in.
row("truthful-reason", login, 'const reason = (op.id === "github" || AUTH_ARGS[op.id as CliId]) ? op.positive ? null : "notSignedIn" : "statusUnknown";', "const reason = null;", logic);
row("truthful-probe", login, "op.positive = signedIn === true;", "op.positive = signedIn !== false;", logic);
row("truthful-exit-code", login, 'if (op.result.code !== 0) throw new Error(op.result.code === -1 ? "launchFailed" : "loginFailed");', "if (false) throw new Error(\"loginFailed\");", proc);
row("truthful-codex-text", auth, String.raw`if (id === "codex") return /^Logged in using (?:ChatGPT|an? API key)(?:\s|$)/i.test(text) ? true : null;`,
  String.raw`if (id === "codex") return /^Logged in using (?:ChatGPT|an? API key)(?:\s|$)/i.test(text) ? true : true;`, logic);
row("truthful-status-exit", auth, "if (result.code !== 0) return null;", "", logic);
// Shutdown: admission closes at once, the drain is awaited, and an unconfirmed cleanup is a failed exit.
row("shutdown-close", "server/index.ts", "settingsService.login.close();", "/* login close omitted */", logic);
row("shutdown-drain", "server/index.ts", "const loginDrain = settingsService.login.drain();", "const loginDrain = Promise.resolve(true);", logic);
row("shutdown-gate", "server/index.ts", "|| !installerConfirmed || !loginConfirmed) { process.exit(1); return; }", "|| !installerConfirmed) { process.exit(1); return; }", logic);
row("shutdown-clean", "server/index.ts", "installerConfirmed && loginConfirmed && closed;", "installerConfirmed && closed;", logic);
// Output bounds: total bytes and the incremental carry.
row("output-total", output, 'if (this.bytes > 1024 * 1024) throw new Error("outputLimit");', 'if (false) throw new Error("outputLimit");', logic);
row("output-carry", output, "if (Buffer.byteLength(this.buffer) > 8192) this.buffer =", "if (false) this.buffer =", logic);
row("output-carry-bytes", output, "if (Buffer.byteLength(this.buffer) > 8192)", "if (this.buffer.length > 8192)", logic);
// Fixed execution and hidden launch: exact argv, no shell, no `start`, absolute cmd, System32 folder, piped stdin, allow-listed environment.
row("exec-fixed-argv", runner, "args = fixedArgs;", 'args = [...fixedArgs, "--evil"];', logic);
row("hidden-window", runner, "{ shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,", "{ shell: false, windowsHide: false, detached: false, windowsVerbatimArguments: shim,", proc);
row("hidden-no-shell", runner, "{ shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,", "{ shell: true, windowsHide: true, detached: false, windowsVerbatimArguments: shim,", proc);
row("hidden-detached", runner, "{ shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,", "{ shell: false, windowsHide: true, detached: true, windowsVerbatimArguments: shim,", proc);
row("hidden-no-start", runner, '`"${[program, ...args].map(cmdQuote).join(" ")}"`', '`"start ${[program, ...args].map(cmdQuote).join(" ")}"`', proc);
row("hidden-absolute-cmd", runner, 'bin = shim ? join(windowsSystem32(), "cmd.exe") : program;', 'bin = shim ? "cmd.exe" : program;', proc);
row("hidden-folder", runner, 'cwd: process.platform === "win32" ? windowsSystem32() : "/", env: disableCopilotUpdate(env, program),', "cwd: process.cwd(), env: disableCopilotUpdate(env, program),", proc);
row("hidden-stdin-pipe", runner, 'env: disableCopilotUpdate(env, program), stdio: ["pipe", "pipe", "pipe"] });', 'env: disableCopilotUpdate(env, program), stdio: ["ignore", "pipe", "pipe"] });', proc);
row("env-allowlist", runner, "return { ...installEnv(env), ...Object.fromEntries(", "return { ...env, ...Object.fromEntries(", proc);
// Owned sweep and cleanup truth.
row("owned-sweep", runner, "const swept = await tree!.sweep(endedAt, true);", "const swept = 0;", proc);
row("cleanup-unconfirmed", runner, "if (swept === null || tree!.failed !== 0) return false;", "if (false) return false;", logic);
// Safety gates: under the fake-CLI flag (injected or host environment) no default runner, installer or launcher may reach a vendor program.
row("gate-login-injected", runner, 'options.env.CC_TEST_FAKE_CLI === "1" || ', "", safety);
row("gate-login-host", runner, ' || process.env.CC_TEST_FAKE_CLI === "1")) { failed(); return; }', ")) { failed(); return; }", safety);
row("gate-login-default", runner, 'if (!spawnProcess && (options.env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) { failed(); return; }', "", plain);
row("gate-installer-injected", service, 'settings.installer && (env.CC_TEST_FAKE_CLI === "1" || ', "settings.installer && (", "pack29-opencode-mutation-guards");
row("gate-installer-host", service, ' || process.env.CC_TEST_FAKE_CLI === "1")) return Promise.resolve({ code: -1', ")) return Promise.resolve({ code: -1", "pack29-opencode-mutation-guards");
row("gate-probe-runner", service, "const probeRun = createTestCliRunner(env) ?? createTestCliRunner(process.env) ?? defaultRun;", "const probeRun = defaultRun;", "pack29-opencode-mutation-guards");
// GitHub now shares the managed runner and its safety guards. Pack 33 covers its fixed native argv and lifecycle.
row("r1-existing-cached", "server/settings/cli-login.ts", "      if (op.id !== \"opencode\" && this.state.catalogTools[op.id].signedIn === true) throw new Error(\"existingCredentials\");", "", "pack29-cli-login");
row("r1-existing-refreshed", "server/settings/cli-login.ts", "        if (this.state.catalogTools[op.id].signedIn === true) throw new Error(\"existingCredentials\");", "", "pack29-cli-login");
export const pack29CliLoginMutations = rows;
