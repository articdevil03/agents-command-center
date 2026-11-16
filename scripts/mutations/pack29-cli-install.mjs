// Each row removes one production guard. Catching files are explicit so proof stays scoped.
const catalog = "server/settings/cli-catalog-validation.ts";
const install = "server/settings/cli-install.ts";
const recipes = "server/settings/cli-installers.ts";
const runner = "server/settings/cli-runner.ts";
const acp = "server/settings/catalog-acp.ts";
const rows = [];
export const pack29CliInstallCatchMap = {};
function row(name, file, from, to, test) {
  const id = `p29-cli-install-${name}`;
  rows.push([id, file, from, to]);
  pack29CliInstallCatchMap[id] = `test/${test}.test.ts`;
}
const unit = "pack29-cli-install", process = "pack29-cli-install-process", inventory = "pack29-cli-catalog";
const registration = "pack29-catalog-acp", leader = "pack29-catalog-leader";
row("id-lookup", catalog, 'if (!entry || !entry.recipe) throw new Error("Unknown or provider-only catalog CLI");',
  'if (!entry) return CLI_CATALOG[0];', inventory);
row("provider-id", catalog, 'if (!entry || !entry.recipe) throw new Error("Unknown or provider-only catalog CLI");',
  'if (!entry) throw new Error("Unknown or provider-only catalog CLI");', inventory);
row("address-http", catalog, 'url.protocol !== "https:" || url.username || url.password',
  'url.username || url.password', inventory);
row("address-credentials", catalog, 'url.protocol !== "https:" || url.username || url.password',
  'url.protocol !== "https:"', inventory);
row("address-other", "server/settings/cli-catalog.ts", 'ps("https://claude.ai/install.ps1")',
  'ps("https://different.example/install.ps1")', inventory);
row("catalog-sweep", "server/settings/cli-catalog.ts", 'provider("muse", "Muse",',
  'provider("imposter", "Muse",', inventory);
row("catalog-empty", catalog, 'if (!entries.length) throw new Error("Catalog is empty");',
  'if (false) throw new Error("Catalog is empty");', inventory);
row("catalog-duplicate", catalog, '|| ids.has(entry.id)', '', inventory);
row("git-bash", recipes, 'if (!bash) throw new InstallFailure("needsGit");',
  'if (!bash) return;', process);
row("node-prerequisite", recipes, 'const { node, npm } = externalNpm(env);',
  'const node = "node", npm = "npm-cli.js";', process);
row("uv-refresh", recipes, '      await refreshPath();', '      /* prerequisite discovery omitted */', process);
row("uv-sequence", recipes, 'runInstallRecipe(recipe.steps[0], run, env, signal, refreshPath, deadline)',
  'runInstallRecipe(recipe.steps[1], run, env, signal, refreshPath, deadline)', "pack29-catalog-flow");
row("registration-write", acp, '    deps.write(next);', '    /* persistence setter omitted */', registration);
row("registration-publish", acp, '    deps.publish(next);', '    /* memory setter omitted */', registration);
row("registration-handler-write", "server/main/catalog-tools.ts", 'write: writeAcpClis,',
  'write: () => {},', registration);
row("registration-handler-publish", "server/main/catalog-tools.ts", 'setAcpClis(next); broadcast(stateMessage());',
  'broadcast(stateMessage());', registration);
row("registration-conflict", acp, 'if (!sameProfile(existing, profile)) throw new Error("Conflicting saved connection; preserved");',
  'if (false) throw new Error("Conflicting saved connection; preserved");', registration);
row("registration-capacity", acp, 'if (saved.length >= ACP_MAX_CLIS)', 'if (false)', registration);
row("registration-idempotence", acp, '      return { id: profile.id };', '      /* append duplicate instead */', registration);
// The leader predicate is: matching saved profile, installed === true and a detected version (qualified, signedIn and connection never gate it).
row("leader-eligibility", acp, "return sameProfile(cli, catalogProfile(entry)) && status?.installed === true\n    && !!status.version;", "return true;", leader);
// The setup entry point rechecks availability; the stale-capability fixture isolates it from the capability filter, so only this row's guard can refuse.
row("leader-selection", "server/first-run/complete.ts", 'if (registered) assertCatalogLeaderEligible(registered, settingsService.state);',
  '    /* availability check omitted */', "pack29-catalog-selection");
row("acp-consent", "server/first-run/complete.ts", 'if (message.acpConsent !== true) throw new Error',
  'if (false) throw new Error', "pack29-first-run-acp");
row("confirm", install, 'value.confirm !== true', 'false', unit);
row("extra-fields", install, 'if (Object.keys(value).some((key) => !fields.includes(key)))', 'if (false)', unit);
row("registration-extra-fields", acp, 'if (Object.keys(value).some((key) => !["type", "requestId", "cli", "confirm"].includes(key)))',
  'if (false)', registration);
row("installed-preflight", install, 'if (installed === true && !unsupported) throw new Error("CLI is already installed");',
  'if (false) throw new Error("CLI is already installed");', unit);
row("unknown-preflight", install, 'if (installed !== false && !unsupported) throw new Error("CLI installation status is unknown");',
  'if (false) throw new Error("CLI installation status is unknown");', unit);
row("lock-setter", install, 'this.active = op; // Admission is synchronous, before preflight or PATH refresh.',
  'this.active = null; // Broken admission setter.', unit);
row("hidden-process", runner, 'spawnProcess(bin, args, { shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,',
  'spawnProcess(bin, args, { shell: false, windowsHide: false, detached: false, windowsVerbatimArguments: shim,', process);
row("absolute-powershell", recipes, 'const program = windowsPowerShellPath();', 'const program = "powershell";', process);
row("stdout-cap", runner, 'Buffer.from(chunk).subarray(0, Math.max(0, INSTALL_OUTPUT_CAP - stdout.length))', 'Buffer.from(chunk)', process);
row("stderr-cap", runner, 'Buffer.from(chunk).subarray(0, Math.max(0, INSTALL_OUTPUT_CAP - stderr.length))', 'Buffer.from(chunk)', process);
row("path-after-install", install, 'this.phase(op, op.abort.signal.aborted ? "cancelling" : "verifying");\n      await this.refresh();',
  'this.phase(op, op.abort.signal.aborted ? "cancelling" : "verifying");', unit);
row("false-success", install, 'if (this.deps.state.catalogTools[op.id].installed !== true) throw new InstallFailure("notFoundAfterInstall");',
  'if (false) throw new InstallFailure("notFoundAfterInstall");', unit);
row("cancel-tree", runner, 'const swept = await tree!.sweep(endedAt, true);', 'const swept = 0;', process);
row("cleanup-uncertainty", install, 'cleanupConfirmed = result.cleanupConfirmed === true;', 'cleanupConfirmed = true;', unit);
row("shutdown-admission", install, 'this.closed || this.deps.admission?.() === false', 'this.deps.admission?.() === false', unit);
row("shutdown-drain", "server/index.ts", 'const installerDrain = settingsService.installer.drain();',
  'const installerDrain = Promise.resolve(true);', unit);
row("phase-setter", install, 'status: "running", phase, reason: null,', 'status: "running", phase: "checking", reason: null,', unit);
row("one-tool-qwen", "server/settings/cli-auth.ts", 'const entry = catalogTool(id), profile = entry.detection!;',
  'const entry = catalogTool(id === "qwen" ? "opencode" : id), profile = entry.detection!;', "pack29-catalog-flow");
row("login-no-false-auth", "server/settings/cli-auth.ts", 'let signedIn: boolean | null = null;',
  'let signedIn: boolean | null = true;', "pack29-cli-login");
row("ui-confirm", "public/first-run/install.js", '{ type: "installCli", cli: id, confirm: true }',
  '{ type: "installCli", cli: id, confirm: false }', "pack29-onboarding-install-page");
row("ui-id", "public/first-run/install.js", '{ type: "installCli", cli: id, confirm: true }',
  '{ type: "installCli", cli: "codex", confirm: true }', "pack29-onboarding-install-page");
row("ui-unknown-install", "public/first-run/install.js", '(installed !== false && !unsupported) || locked()',
  '(installed === true && !unsupported) || locked()', "pack29-onboarding-install-page");
row("ui-enabled-rule", "public/first-run/tools.js", 'tool?.installed === false && entry?.installable === true',
  'tool?.installed !== true && entry?.installable === true', "pack29-onboarding-install-page");
row("ui-disabled-rule", "public/first-run/tools.js", "${locked ? \" disabled\" : \"\"}>${id === \"copilot\" && current?.state === \"failed\" ? \"Try again\" : \"Install\"}</button>",
  "${false ? \" disabled\" : \"\"}>${id === \"copilot\" && current?.state === \"failed\" ? \"Try again\" : \"Install\"}</button>", "pack29-onboarding-install-page");
row("ui-provider-no-install", "public/first-run/tools.js", '${esc(text.chip)}</span></div></div>`;',
  '${esc(text.chip)}</span><button data-frun-install="${id}">Install</button></div></div>`;', "pack29-onboarding-catalog");
export const pack29CliInstallMutations = rows;
