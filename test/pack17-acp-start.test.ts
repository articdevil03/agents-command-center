import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { appSource, sourceFiles, sourceText, styleSource } from "./source-text.ts";
import { join, resolve } from "node:path";
import { validateAssignment } from "../server/fixed-crew/assignment.ts";
import { fixedProject, fixedTab, fixedWorkspaces, type FixedChoices } from "./fixed-server-fixture.ts";
import { readWorkspaces, parseAcpStartCommand, validateAcpCli, readAcpClis, writeAcpClis, isAcpKind, isValidModel, isValidEffort, defaultEffort, ACP_MAX_CLIS } from "../server/config.ts";
import { KNOWN_CLI_NAMES, leaderKindOf, resolveCliOrThrow, resolveCliPath, spawnAcpChild, withResolvedCli } from "../server/leader-common.ts";
import { createAcpLeader } from "../server/leader-acp.ts";
import { buildCommand } from "../server/runner.ts";
import { CLI_IDS } from "../server/settings.ts";
import { scratch, WORKER_SLOT, ACP_DEFAULT } from "./pack17-acp-helpers.ts";

// ---------------------------------------------------------------- A: the start command and the saved list
test("A1: a start command is a program and plain words; anything that needs a shell is refused", () => {
  assert.deepEqual(parseAcpStartCommand("  gemini   --acp "), { program: "gemini", args: ["--acp"] });
  assert.deepEqual(parseAcpStartCommand("opencode acp"), { program: "opencode", args: ["acp"] });
  assert.throws(() => parseAcpStartCommand("   "), /start command is required/i);
  const ok = validateAcpCli({ name: "Gemini CLI", ...parseAcpStartCommand("gemini --acp --model=flash-2.5") });
  assert.deepEqual(ok, { id: "gemini-cli", name: "Gemini CLI", program: "gemini", args: ["--acp", "--model=flash-2.5"] });
  const bad = [
    "gemini --acp && calc", "gemini | more", 'gemini "a b"', "gemini %PATH%", "gemini $(whoami)", "gemini `x`", "gemini;calc", "gemini --a>b", "gemini ^x", "gemini (x)", "gemini 'x'", "gemini --a=b&c",
    "..\\gemini --acp", "C:\\tools\\gemini --acp", "./gemini", "/usr/bin/gemini", "gemini\\evil", ".gemini", "-gemini", "gemini --x=\\\\share\\x",
  ];
  const refused: string[] = [];
  for (const command of bad) { try { validateAcpCli({ name: "X", ...parseAcpStartCommand(command) }); } catch { refused.push(command); } }
  assert.deepEqual(refused, bad, "every one of the shell-needing or path-like commands is refused (printed: what was refused)");
  assert.throws(() => validateAcpCli({ name: "", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "x".repeat(41), program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "bad<name>", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "bad\u0007name", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "---", program: "gemini", args: [] }), /letter or digit/);
  assert.throws(() => validateAcpCli({ name: "x", program: "gemini", args: Array.from({ length: 17 }, () => "a") }), /arguments/);
  assert.throws(() => validateAcpCli({ name: "x", program: "gemini", args: [5] }), /arguments/);
});

test("A2: the list is saved with the safe-write pattern, read back, and a damaged or duplicate list is refused", () => {
  const dir = scratch(); const file = join(dir, "config", "acp-clis.json");
  assert.deepEqual(readAcpClis(file), [], "no file = no CLIs");
  const a = validateAcpCli({ name: "Alpha", program: "alpha", args: ["--acp"] }), b = validateAcpCli({ name: "Beta", program: "beta", args: [] });
  writeAcpClis([a, b], file);
  assert.deepEqual(readAcpClis(file), [a, b]);
  assert.deepEqual(readdirSync(join(dir, "config")), ["acp-clis.json"], "no temp folder is left beside the saved file");
  assert.throws(() => writeAcpClis([a, validateAcpCli({ name: "alpha!", program: "other", args: [] })], file), /already used/);
  assert.throws(() => writeAcpClis(Array.from({ length: ACP_MAX_CLIS + 1 }, (_, n) => validateAcpCli({ name: `cli ${n}`, program: "p", args: [] })), file), /at most/);
  writeFileSync(file, "{ not json");
  assert.throws(() => readAcpClis(file), /unreadable/);
  writeFileSync(file, JSON.stringify({ clis: [{ name: "Z", program: "a b", args: [] }] }));
  assert.throws(() => readAcpClis(file), /plain command name/i);
  writeFileSync(file, JSON.stringify({ clis: [a, { ...a }] }));
  assert.throws(() => readAcpClis(file), /duplicate/);
});

test("A3: an ACP kind is valid only with the CLI's own default model and effort", () => {
  assert.equal(isAcpKind("acp:gemini"), true);
  for (const bad of ["acp:", "acp:A", "acp:a b", "acp:a/b", "claude", "gemini", "acp:-x", `acp:${"a".repeat(40)}`]) assert.equal(isAcpKind(bad), false, bad);
  assert.equal(isValidModel("acp:gemini", "default"), true);
  assert.equal(isValidModel("acp:gemini", "opus"), false);
  assert.equal(isValidEffort("acp:gemini", "default"), true);
  assert.equal(isValidEffort("acp:gemini", "high"), false);
  assert.equal(defaultEffort("acp:gemini"), "default");
  assert.equal(isValidModel("claude", "default"), false, "the ACP default is not a model of another CLI");
});

test("A4: a saved fixed crew may use an ACP kind on any seat (default model and effort only), an unknown kind is refused, and a command is never made up for it", () => {
  const dir = scratch(); const file = join(dir, "workspaces.json");
  const saved = (choices: FixedChoices) => { writeFileSync(file, JSON.stringify(fixedWorkspaces([fixedProject("a", dir, [fixedTab("a-1", dir, choices, "A")])]))); return readWorkspaces(file).projects[0].tabs[0]; };
  const acp = { cli: "acp:gemini", ...ACP_DEFAULT } as const;
  assert.deepEqual(saved({ leader: acp }).fixedCrew!.preferences.leader.assignment, acp, "an ACP kind on the leader loads");
  assert.deepEqual(saved({ [WORKER_SLOT]: acp }).fixedCrew!.preferences[WORKER_SLOT].assignment, acp, "an ACP kind on a worker seat loads (pack 18: any seat)");
  for (const bad of [{ cli: "gemini", ...ACP_DEFAULT }, { cli: "acp:gemini", model: "opus", effort: "default" }, { cli: "acp:gemini", model: "default", effort: "high" }]) {
    assert.throws(() => validateAssignment(bad), /Invalid crew assignment|ACP assignment uses its default model and effort/, JSON.stringify(bad));
    assert.equal(saved({ leader: bad as any }).fixedCrew!.preferences.leader.assignment, null, `a saved ${JSON.stringify(bad)} is recovered to a fresh crew, never kept`);
  }
  const run = { runId: "p17-run", seatKey: "p17-tab.reviewer1", slotId: "reviewer1", name: "Vera", cli: "acp:gemini" as any, model: "default", effort: "default", folder: dir, canWrite: false, startedAt: 1 };
  assert.throws(() => buildCommand(run, join(dir, "brief.txt")), /no command for CLI "acp:gemini"/, "a run command is never made up for an ACP kind");
});

// ---------------------------------------------------------------- B: every CLI start goes through the safe resolution
test("B1: every program name the app starts by name fails closed when it is not on PATH or only inside a project folder", () => {
  assert.deepEqual([...KNOWN_CLI_NAMES].sort(), [...CLI_IDS].sort(), "the resolution list is the settings list (a CLI added to one and not the other goes RED)");
  const outside = scratch(), inside = scratch();
  writeFileSync(join(inside, "x.cmd"), "@echo off\r\n");
  for (const name of KNOWN_CLI_NAMES) {
    assert.throws(() => withResolvedCli(`${name} --version`, { PATH: "" }), new RegExp(`^Error: ${name} was not found on PATH$`), `${name}: not on PATH`);
    writeFileSync(join(inside, `${name}.cmd`), "@echo off\r\n");
    assert.throws(() => withResolvedCli(`${name} --version`, { PATH: inside }, inside), /was found only inside a project folder/, `${name}: only inside a project folder`);
    writeFileSync(join(outside, `${name}.cmd`), "@echo off\r\n");
    assert.equal(withResolvedCli(`${name} --version`, { PATH: outside }, inside), `"${join(outside, `${name}.cmd`)}" --version`, `${name}: resolved to the absolute path outside the folder`);
  }
  assert.equal(withResolvedCli("node server.js", { PATH: "" }), "node server.js", "a command that is not a CLI start is left alone");
});

test("B2: an ACP program resolves the same safe way: PATH folders only, never inside the tab folder, never a bare name", () => {
  const outside = scratch(), inside = scratch();
  writeFileSync(join(inside, "evilacp.cmd"), "@echo off\r\n"); writeFileSync(join(outside, "goodacp.exe"), "");
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: inside }, inside), (error: Error) => error.message === `evilacp was found only inside a project folder (${inside}), which is never used; install it outside your project folders or remove that project folder`);
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: "" }, inside), /evilacp was not found on PATH/);
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: "." }, inside), /not found on PATH/, "a relative PATH entry is never searched");
  assert.equal(resolveCliOrThrow("goodacp", { PATH: outside }, inside), join(outside, "goodacp.exe"));
  assert.equal(resolveCliPath("goodacp", { PATH: outside }, outside), null, "a PATH folder that is the tab folder is skipped");
  // The real spawn function refuses before any process exists.
  assert.throws(() => spawnAcpChild("evilacp", [], { cwd: inside, env: { PATH: inside } }), /found only inside a project folder/);
  assert.throws(() => spawnAcpChild("ghostacp", [], { cwd: inside, env: { PATH: outside } }), /ghostacp was not found on PATH/);
});

test("B3: a leader kind is one of the four adapters; an unknown kind fails closed (never started as Claude)", () => {
  assert.equal(leaderKindOf("claude"), "claude"); assert.equal(leaderKindOf("codex"), "codex"); assert.equal(leaderKindOf("opencode"), "opencode"); assert.equal(leaderKindOf("acp:gemini"), "acp");
  for (const bad of ["gemini", "", undefined, null, 5, "acp:", "acp:A b", "CLAUDE", "claude "]) assert.throws(() => leaderKindOf(bad), /Unknown leader CLI/, String(bad));
});

// ---------------------------------------------------------------- E: the sweep over every place that decides per CLI
// Every line of the app's own source that compares a CLI kind or lists the kinds, found by scanning the files (not a hand-picked set).
// A new line, or a line that moved or went, is RED until it is listed here with what an ACP leader does there.
const ROOT = resolve(".");
const SCANNED = sourceFiles().filter((file) => (file.startsWith("server/") && file.endsWith(".ts")) || (file.startsWith("public/") && file.endsWith(".js")));
const DECIDES = /\bcli\b[^;]{0,50}(?:===|!==|==|!=)\s*"(?:claude|codex|opencode)"|"(?:claude|codex|opencode)"\s*(?:===|!==)\s*[A-Za-z_.?]*cli\b|case "(?:claude|codex|opencode)":|"opencode"|leaderKind\s*===\s*"|\bconst isAcp\b|\bisAcp(?:Kind|Cli)?\(|\[\s*(?:kind|cli|[A-Za-z_.?]*\.(?:cli|kind))\s*\]|\bas SeatKind\b|\b(?:kind|leaderKind|[A-Za-z_.?]*\.(?:cli|kind))\s*(?:===|!==)\s*"(?:claude|codex|opencode|gemini)"|"(?:claude|codex|opencode|gemini)"\s*(?:===|!==)\s*(?:kind|leaderKind)\b|\[\s*"(?:claude|codex|opencode)"\s*,\s*"/;
const VERDICTS: Array<[string, string, string]> = [
  ["public/app.js","if (cli === \"opencode\" || cli === \"copilot\") {","works: managed install admission covers Copilot ACP without changing other ACP registrations"],
  ["server/leader-common.ts","const managed = name === \"opencode\" || name === \"copilot\" ?","works: registered Copilot ACP leaders and crew resolve a checked managed executable before PATH"],
  ["server/settings.ts","case \"opencode\":","works: managed release recipes are handled transactionally rather than by the generic recipe dispatcher"],
  ["server/settings.ts","| { kind: \"opencode\" | \"copilot\";","works: the catalog owns the two managed release recipe kinds; arbitrary ACP commands are not installers"],
  ["server/settings.ts","transaction = op.id === \"opencode\" || op.id === \"copilot\" ?","works: both managed tools share verification and atomic publication; other ACP installs retain their own routes"],
  ["server/settings.ts","if (managedCli(this.deps.env, op.id as \"opencode\" | \"copilot\")","works: successful activation must resolve to the checked candidate for that exact managed tool"],
  ["server/settings.ts","if ((op.id === \"opencode\" || op.id === \"copilot\") && previousFacts)","works: failed managed activation restores the original facts for the selected tool"],
  ["server/settings.ts","if (op.id === \"opencode\") Object.assign","n/a: only OpenCode has legacy built-in facts; Copilot uses its authoritative catalog facts"],
  ["server/settings.ts","export async function extractExecutable(archive: string, dir: string, signal: AbortSignal, tool: ReleaseTool =","works: server-owned tool profiles select archive limits and the expected executable for Copilot ACP"],
  ["server/settings.ts","options: OpenCodeInstallOptions = {}, tool: ReleaseTool =","works: existing OpenCode callers keep the default; Copilot explicitly selects its managed release profile"],
  ["server/settings.ts","export function managedRoot(env: NodeJS.ProcessEnv, tool: ReleaseTool =","works: separate managed roots prevent a Copilot install from modifying OpenCode"],
  ["server/settings.ts","export function managedCli(env: NodeJS.ProcessEnv, tool: ReleaseTool =","works: descriptor resolution validates the selected managed tool before ACP launch"],
  ["server/settings.ts","if (tool === \"opencode\" && (typeof value.executable","works: legacy OpenCode shim descriptors remain supported; Copilot permits only its single native executable"],
  ["server/settings.ts","export async function createCandidate(env: NodeJS.ProcessEnv, tool: ReleaseTool =","works: each managed tool gets its own candidate directory; ACP project folders are never descriptors"],
  ["server/settings.ts","export async function request(transport: InstallTransport, url: string, signal: AbortSignal, tool: ReleaseTool =","works: requests use the selected server-owned release origin; ACP launch arguments supply no URLs"],
  ["server/settings.ts","export async function selectRelease(transport: InstallTransport, signal: AbortSignal, arch: string, tool: ReleaseTool =","works: selection validates stable metadata and architecture for the selected managed tool"],
  ["public/app.js","pop.innerHTML = `<div class=\"sc\"><div class=\"top\">","works: seat cards label empty OpenCode effort explicitly; ACP effort display is unchanged"],
  ["public/model-picker.js","if (cli === \"opencode\" && page.cliCaps()","works: unavailable saved OpenCode models cannot be reselected; ACP eligibility is unchanged"],
  ["public/model-picker.js","const unavailable = seat.cli === \"opencode\"","works: unsupported OpenCode has no effort controls; ACP keeps its default"],
  ["server/settings.ts","const facts = cli === \"opencode\" ? state.catalogTools.opencode : state.tools[cli];","works: OpenCode uses canonical supported-version facts; ACP availability stays separate"],
  ["server/settings.ts","if (cli === \"opencode\" && facts.installed === true) return facts.supportedVersion === false ? false : true;","works: known unsupported OpenCode is unavailable; unknown versions stay eligible and ACP availability remains separate"],
  ["server/settings.ts","if (cli !== \"opencode\") return;","works: the built-in OpenCode launch guard leaves ACP to its existing eligibility gate"],
  ["server/settings.ts","if (op.id !== \"opencode\" && this.state.catalogTools[op.id].signedIn === true)","works: cached positive managed sign-in refuses before detection erases ACP tool status"],
  ["public/app.js","if (id === \"opencode\") return facts;","n/a: canonical OpenCode tool facts bypass legacy fallback; ACP tools use their own catalog records"],
  ["public/app.js","const unsupportedVersion = cli === \"opencode\" && tool?.installed === true && tool.supportedVersion !== true;","n/a: only the built-in OpenCode adapter requires supported major 1; ACP eligibility is separate"],
  ["public/app.js","const subtitle = installing ? window.CC_FIRST_RUN_CATALOG?.phaseText(progress.phase, toolName(cli), progress.message) ?? \"Installing…\" : sig","n/a: OpenCode status copy distinguishes key presence from verified connection; ACP status is unchanged"],
  ["public/app.js","const connected = tool?.signedIn === true && !unsupportedVersion && !needsConnect ? `<span class=\"tool-connected\" data-tool-status=\"connected\"><i></i>${cli =","n/a: OpenCode says Ready for a stored key; ACP connection labels remain separate"],
  ["public/app.js","const guide = cli !== \"copilot\" && tool?.installed === false ?","works: Copilot uses in-app retry only; other ACP tools retain official setup guides"],
  ["public/first-run/catalog.js","if (entry?.id === \"opencode\") return \"Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account.","n/a: consent describes the transactional OpenCode download; ACP recipes keep their own copy"],
  ["public/first-run/install.js","const installed = id === \"opencode\" ? tool?.installed : legacy ? legacy.installed ?? tool?.installed : tool?.installed;","n/a: OpenCode installed state is canonical rather than a legacy overlay; ACP facts are unchanged"],
  ["public/first-run/install.js","const unsupported = id === \"opencode\" && tool?.installed === true && tool.supportedVersion !== true;","n/a: unsupported OpenCode versions get replacement installation; ACP versions use their profiles"],
  ["public/first-run/login.js","if (id === \"opencode\") return more ?? {};","n/a: OpenCode login reads canonical catalog facts; other tool fallback remains available"],
  ["public/first-run/login.js","if (cli === \"opencode\" && view.state === \"refused\" && !Object.values(REASON).includes(view.text)) view.text = REASON.keyFailed;","n/a: OpenCode key failures use static redacted messages; ACP browser sign-in is unchanged"],
  ["public/first-run/login.js","const keySupported = (cli) => cli !== \"opencode\" || facts(cli).supportedVersion === true;","n/a: key saving requires supported OpenCode 1; ACP tools keep their managed login eligibility"],
  ["public/first-run/login.js","const replaceOffered = (cli) => cli === \"opencode\" && managed(cli) && facts(cli).installed === true && keySupported(cli) && facts(cli).crede","n/a: key replacement is offered only for a stored managed OpenCode key; ACP has no replacement-key action"],
  ["public/first-run/login.js","if (view.state !== \"running\" || !mine?.loginId || view.stopping || (cli === \"opencode\" && (view.phase !== \"waitingKey\" || mine.codeSent >= m","n/a: OpenCode key submission requires the current waitingKey revision; ACP code flow is separate"],
  ["public/first-run/login.js","const input = parts.input, code = cli === \"opencode\" ? input.value : input.value.trim();","n/a: OpenCode key input preserves whitespace for validation; ACP browser codes are trimmed"],
  ["public/first-run/login.js","if (cli === \"opencode\") { parts.label.textContent = \"OpenCode Go API key\"; parts.input.maxLength = 4096; }","n/a: OpenCode key field has a specific label and limit; ACP fields retain their own profile"],
  ["public/first-run/login.js","if (cli === \"opencode\") {","n/a: OpenCode sends the private key submission message; ACP sends its own login-code message"],
  ["public/first-run/login.js","if (!running || (message.cli === \"opencode\" && message.phase !== \"waitingKey\")) clearInputs(message.cli);","n/a: OpenCode key inputs clear outside waitingKey; ACP ordinary completion cleanup still runs"],
  ["public/first-run/login.js","const isKey = cli === \"opencode\", replacing = replaceOffered(cli) && !live && view.state !== \"stuck\";","n/a: OpenCode key replacement renders separately from ordinary managed ACP sign-in"],
  ["public/first-run/login.js","function clearHiddenKeys() { for (const panel of panels.values()) if (panel.cli === \"opencode\" && (!panel.root.isConnected || !panel.parts.i","n/a: hidden OpenCode key fields are cleared; ACP panels do not contain this key"],
  ["public/first-run/login.js","window.addEventListener(\"pagehide\", () => clearInputs(\"opencode\"));","n/a: pagehide clears OpenCode key inputs; ACP connection state is unaffected"],
  ["public/first-run/tools.js","if (id === \"opencode\") return facts;","n/a: OpenCode tool status reads canonical facts; ACP uses its own catalog row"],
  ["public/first-run/tools.js","if (id === \"opencode\" && tool.supportedVersion !== true) return \"unsupported\";","n/a: only OpenCode requires major 1 before ready status; ACP qualification remains separate"],
  ["public/first-run/tools.js","if (id === \"opencode\" && tool.signedIn !== true) return \"nosignin\";","n/a: OpenCode requires stored sign-in facts; ACP registration and connection use their own rules"],
  ["public/first-run/tools.js","if (id === \"opencode\" && tool?.credentialSource === \"environment\") return { text: \"A key is set outside Command Center. Its connection is no","n/a: environment OpenCode keys are not presented as verified; ACP tool status is unchanged"],
  ["public/first-run/tools.js","if (status === \"unsupported\") return { button: `<button type=\"button\" class=\"btn primary sm\" data-frun-install=\"opencode\" data-focus-key=\"fr","n/a: unsupported OpenCode offers the managed major-1 installer; ACP recipes keep their own actions"],
  ["public/first-run/tools.js","const more = byHand ? `<button type=\"button\" class=\"frun-more frun-byhand\" data-frun-help=\"${id}\" data-focus-key=\"frun-help-${id}\" aria-expa","n/a: OpenCode setup help names its key flow; ACP keeps ordinary manual install guidance"],
  ["server/settings.ts","const result = await run(profile.program, profile.args, { timeoutMs: CLI_TIMEOUT_MS, ...(id === \"opencode\" ? { env: { OPENCODE_DISABLE_AUTOU","n/a: OpenCode version probes disable vendor auto-update; ACP probes use their catalog profiles"],
  ["server/settings.ts","const result = await run(profile.program, auth, { timeoutMs: CLI_TIMEOUT_MS, ...(id === \"opencode\" ? { env: { OPENCODE_DISABLE_AUTOUPDATE: \"","n/a: OpenCode auth probes disable vendor auto-update; ACP auth probes keep their own arguments"],
  ["server/settings.ts","const facts = { installed, version, signedIn, supportedVersion, ...(id === \"opencode\" ? { credentialSource } : {}) };","n/a: OpenCode facts include credential provenance; ACP catalog facts do not invent it"],
  ["server/settings.ts","const unsupported = op.id === \"opencode\" && installed === true && this.deps.state.catalogTools[op.id].supportedVersion === false;","n/a: unsupported OpenCode can be replaced; already-installed ACP tools retain install refusal"],
  ["server/settings.ts","if (cli === \"opencode\") return value === \"https://opencode.ai/auth\" ? value : null;","n/a: OpenCode login opens only its allowlisted auth URL; ACP URLs use their own policies"],
  ["server/settings.ts","if ([\"replaceCliLogin\", \"submitCliLoginKey\"].includes(value.type) && value.cli !== \"opencode\") throw new Error(\"Invalid sign-in request.\");","n/a: private key and replace messages are exclusive to OpenCode; ACP cannot enter that route"],
  ["server/settings.ts","if (value.type === \"submitCliLoginCode\" && [\"opencode\", \"github\"].includes(value.cli as string)) throw new Error(\"Invalid sign-in request.\");","n/a: OpenCode and GitHub refuse pasted-code submission; ACP code login uses its own profile"],
  ["server/settings.ts","message: reason ? LOGIN_MESSAGES[reason] : status === \"done\" ? op.id === \"opencode\" ? \"Key saved. OpenCode will check it when you first chat","n/a: OpenCode reports key saved without claiming connection; ACP managed login reports its own completion"],
  ["server/settings.ts","if (op.id !== \"opencode\" && !entry.signIn.managed) throw new Error(\"unsupported\");","n/a: OpenCode key login bypasses browser-managed support; ACP still requires a managed sign-in profile"],
  ["server/settings.ts","if (op.id !== \"opencode\") {","n/a: OpenCode key flow avoids browser CLI resolution; ACP browser login resolves its executable"],
  ["server/settings.ts","if (op.id === \"opencode\") {","n/a: OpenCode starts its private waiting-key flow; ACP starts its managed login runner"],
  ["server/settings.ts","if (op.id === \"opencode\" && op.event.phase !== \"waitingKey\") throw new Error(\"No sign-in address is available.\");","n/a: OpenCode auth address is available only while waiting for key; ACP browser phases are unaffected"],
  ["server/settings.ts","fd = openSync(join(base, \"opencode\", \"auth.json\"), \"r\");","n/a: credential detection reads OpenCode auth.json only; ACP authentication has separate storage"],
  ["server/settings.ts","const childEnv = { ...loginEnv(env), OPENCODE_DISABLE_AUTOUPDATE: \"1\", OPENCODE_SERVER_USERNAME: \"opencode\", OPENCODE_SERVER_PASSWORD: passw","n/a: OpenCode key helper disables updates and authenticates its local server; ACP runners use their profiles"],
  ["server/settings.ts","const program = process.platform === \"win32\" ? resolveCliOrThrow(\"opencode\", childEnv, process.cwd(), true) : posixCli(\"opencode\", childEnv);","n/a: native OpenCode auth opts into direct resolution; ACP shell restrictions remain unchanged"],
  ["server/settings.ts","const version = await run(\"opencode\", [\"--version\"], { timeoutMs, directExecutable: true, env: { OPENCODE_DISABLE_AUTOUPDATE: \"1\" } });","n/a: native OpenCode version probes use direct resolution; ACP probes remain separate"],
  ["server/settings.ts","const auth = await run(\"opencode\", [\"auth\", \"list\"], { timeoutMs, directExecutable: true, env: { OPENCODE_DISABLE_AUTOUPDATE: \"1\" } });","n/a: native OpenCode auth probes use direct resolution; ACP probes remain separate"],
  ["server/settings.ts","if (cli === \"opencode\") {","n/a: OpenCode service branch handles its specific tool integration; ACP registration remains separate"],
  ["public/fixed-crew/events.js","return cli === \"opencode\" ? \"\" : efforts.includes(\"medium\") ? \"medium\" : efforts[0];","works: ACP effort returns default before model-aware OpenCode choices are used"],
  ["public/fixed-crew/task-archive-view.js","const model = run.assignment ? `${page.cliLabel(run.assignment.cli)} · ${run.assignment.model} · ${run.assignm","n/a: archived OpenCode default gets a readable label; ACP archived values are unchanged"],
  ["public/model-picker.js","const info = cli === \"opencode\" ? page.openCodeInfo?.(model) : null;","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","const saved = cli === \"opencode\" && !info;","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","return `<button type=\"button\" class=\"opt\" data-model=\"${esc(model)}\" data-cli=\"${esc(cli)}\" title=\"${esc(model","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","const groups = cli === \"opencode\" ? [...new Set(listed.map((model) => model.split(\"/\")[0]))] : [null];","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","const info = seat.cli === \"opencode\" ? page.openCodeInfo?.(seat.model) : null;","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","const savedEffort = !unavailable && seat.cli === \"opencode\" && seat.effort && !efforts.includes(seat.effort);","works: unavailable saved OpenCode efforts stay visible without selectable controls; ACP keeps its default"],
  ["public/model-picker.js","const noEffort = seat.cli === \"opencode\" ? `<div class=\"hint\">${esc(info?.variants ? savedEffort ? \"This model","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["public/model-picker.js","pop.innerHTML = `<div class=\"msearch\"><input class=\"inp\" id=\"mq\" type=\"search\" aria-label=\"Search models\" plac","works: OpenCode metadata and provider groups apply only to OpenCode; ACP retains CLI default and no effort control"],
  ["server/config.ts","export function modelEfforts(kind: SeatKind | AcpKind, model: string): string[] { return kind === \"opencode\" ?","works: OpenCode model efforts and saved pairs are separate from ACP defaults"],
  ["server/config.ts","if (seat.cli === \"opencode\") SAVED_PAIRS.add(JSON.stringify([seat.model, seat.effort]));","works: OpenCode model efforts and saved pairs are separate from ACP defaults"],
  ["server/fixed-crew/assignment.ts","if (!isObj(value) || !cliCaps(value.cli) || !isSafeShape(value.model) || !(value.cli === \"opencode\" && value.e","works: only OpenCode accepts empty default effort; ACP still requires default model and effort"],
  ["server/fixed-crew/assignment.ts","if (cli.id === \"opencode\") return openCodeEfforts(catalogue.opencodeModelInfo ?? [], model);","works: only OpenCode accepts empty default effort; ACP still requires default model and effort"],
  ["public/app.js", "if (cli === \"opencode\") return (serverState?.opencodeModelInfo", "works: OpenCode effort support comes from the selected model; ACP still has no effort setting"],
  ["server/settings.ts", "if (op.id === \"opencode\") await this.deps.refreshModels", "n/a: successful OpenCode installation refreshes its catalogue, independent of ACP registration"],
  ["server/settings.ts", "const result = await this.run(\"opencode\", [\"models\", \"--verbose\"]", "n/a: OpenCode catalogue probe uses the injected tracked runner; ACP discovery is unchanged"],
  ["server/settings.ts", 'const target = cli === "github" ? this.state.github : this.state.catalogTools[cli];', "n/a: internal GitHub authentication publishes to GitHub state; catalog and ACP authentication keep their own state"],
  ["public/app.js", "const progress = serverState?.settings?.catalogTools?.[cli]?.action", "works: Settings install progress comes from canonical catalog state for each tool"],
  ["public/first-run/tools.js", "const opencodeReady = statusOf(\"opencode\")", "works: the provider guide can offer OpenCode while standalone catalog tools keep their own routes"],
  ["public/first-run/view.js", "if (!catalog.matches(\"opencode\", draft.search))", "n/a: provider guidance reveals the OpenCode row by clearing a search filter"],
  ["public/first-run/view.js", "const row = q(\"frunTools\").querySelector", "n/a: provider guidance focuses the existing OpenCode row"],
  ["server/index.ts", "Object.assign(settingsService.state.catalogTools[message.cli]", "works: successful catalog registration updates installed and registered facts, never sign-in or leader qualification"],
  ["server/settings.ts","detection: { program, args: [\"--version\"],","works: all catalog tools use offline version detection; only OpenCode restricts the supported major"],
  ["server/settings.ts", "tool(\"opencode\", \"OpenCode 1\"", "works: the catalog preserves the built-in OpenCode adapter and its fixed installation profile"],
  ["server/settings.ts", "login(\"opencode auth login\"", "works: OpenCode uses its existing authentication and built-in adapter"],
  ["server/first-run/complete.ts", "const acp = isAcpKind(cli);", "works: first-run ACP picks require live registration, validated command, safe PATH resolution and Full access consent"],
  ["public/fixed-crew/task-view.js", "for (const run of (task.executions ?? []).filter", "n/a: KIND[run.kind] labels interrupted execution types, not CLI kinds; ACP uses the same display"],
  ["server/fixed-crew/assignment.ts", "if (isAcpCli(cli) &&", "works: saved ACP assignments accept only default model and default effort"],
  ["server/fixed-crew/assignment.ts", "if (isAcpCli(cli.id)) return", "works: the ACP model list contains only default"],
  ["server/fixed-crew/assignment.ts", "const models = cli.models ??", "works: OpenCode uses supplied suggestions; ACP returned its default above"],
  ["server/fixed-crew/assignment.ts", "return isAcpCli(cli.id) ?", "works: ACP effort is default; other CLIs use their advertised safe efforts"],
  ["server/fixed-crew/assignment.ts", "if (!seat.preferredAdvisor ||", "works: advisor support is limited to an advertised Claude capability"],
  ["server/fixed-crew/assignment.ts", "return isAcpCli(id) ?", "works: deterministic built-in preference order puts ACP after known providers"],
  ["server/fixed-crew/assignment.ts", "if (!assignment || isAcpCli", "works: ACP company identity is unknown and cannot establish review independence"],
  ["server/fixed-crew/assignment.ts", '|| (assignment.cli === "claude"', "works: bare family aliases identify Anthropic only on the Claude transport"],
  ["server/fixed-crew/assignment.ts", "const sameModel = !isAcpCli", "works: two ACP defaults never establish equal model identity"],
  ["server/index.ts", "if (!models.includes(assignment.model)", "works: manual model choices use inventory; OpenCode accepts validated custom provider models"],
  // Catalogue callback delegates CLI decisions to cliAvailability, classified above.
  ["public/fixed-crew/events.js", "if (page.isAcpCli(cli)) return \"default\";", "works: a fixed crew pick on an ACP CLI always sends its default effort, as the server requires"],
  ["public/fixed-crew/events.js", "else if (page.isAcpCli(seat.cli)) list.push(", "works: the fixed crew's model menu says an ACP CLI runs with Full access only"],
  ["public/fixed-crew/view.js", "return pref.source === \"auto\" && Boolean(cli) && (cli === \"opencode\"", "works: an automatic OpenCode or ACP pick asks the user to check they can use that model; manual picks do not"],
  ["public/logos.js", "window.CC_LOGOS =", "n/a: logo path data for the known CLIs; ACP uses its name initial"],
  ["server/config.ts", "export const isAcpKind = (value: unknown)", "works: the one test for the acp:<id> shape (process.ts isAcpCli); every seat may carry such a kind"],
  ["server/config.ts", "const builtIn = (Object.keys(CLI_CAPS) as SeatKind[])", "works: the three known kinds come from the capability table; every ACP CLI is added after them"],
  ["server/config.ts", "if (!isAcpKind(seat.cli)) { SAVED_MODELS", "works: an ACP seat adds nothing to the known kinds' saved lists"],
  // Broadcast callback delegates CLI decisions to cliAvailability, classified above.
  ["server/index.ts", "if (isAcpKind(member.cli)) {", "works: a crew seat on an ACP CLI runs through its start command; one removed in Settings is refused with its name before anything is counted"],
  ["server/index.ts", "...(member.cli === \"claude\" && member.advisor", "n/a: the advisor is Claude's only; an ACP seat never has one"],
  ["server/process-types.ts", "export type SeatCli =", "works: the known kinds and the ACP kind"],
  ["server/process-types.ts", "export const CLI_CAPS: Record<", "works: the one capability table of the three known kinds; an ACP kind is answered by acpCaps"],
  ["server/process-types.ts", "opencode: { id: \"opencode\"", "works: one row of the capability table"],
  ["server/process-types.ts", "return isAcpCli(cli) ? acpCaps(cli) : null;", "works: an ACP kind gets the ACP capabilities (read-only not enforced, crew tools by HTTP MCP)"],
  ["server/runner.ts", "const acp = isAcpKind(run.cli);", "works: an ACP crew run goes through the ACP worker path (Block 2)"],
  // [file, start of the line (trimmed), verdict]
  ["server/cli-discovery.ts", "// \"--help\", \"opencode\"/\"models\"), never user input, so building one command", "n/a: a comment about the models list command"],
  ["server/cli-discovery.ts", "const out = await runCaptured(\"opencode\", [\"models\"], spawnFn);", "n/a: asks OpenCode for ITS model list; an ACP CLI reports its own model at session start"],
  ["server/config.ts", "export type SeatKind = \"claude\" | \"codex\" | \"opencode\";", "works: the three known kinds; an ACP kind is the separate AcpKind (acp:<id>) next to it"],
  ["server/config.ts", ": kind === \"opencode\" && model.length <= 100 && OPENCODE_MODEL_PATTERN.test(model);", "works: isValidModel answers an ACP kind first (only the CLI's own default)"],
  ["server/folder-activity.ts", "const dbPath = join(home, \".local\", \"share\", \"opencode\", \"opencode.db\");", "n/a: reads OpenCode's own records; an ACP CLI is seen by the generic file-change watch and by the session id it reports (onSession)"],
  ["server/index.ts", "if (value !== \"claude\" && value !== \"codex\" && value !== \"opencode\" && value !== \"gemini\") throw new Error(\"unknown CLI\");", "n/a: Settings tool actions (install, sign in, MCP) are for the four known CLIs; an ACP CLI is signed in through its own terminal command"],
  ["server/index.ts", "const opensOwnReplies = lead.cli === \"claude\";", "n/a: only the Claude CLI starts a reply by itself; an ACP CLI answers only prompts"],
  ["server/index.ts", "if (leaderKind === \"acp\") {", "works: the ACP adapter is started with the CLI's saved start command, a bridge token of its own, and the tab folder"],
  ["server/index.ts", "} else if (leaderKind === \"codex\") {", "works: leaderKindOf picks the adapter; \"acp\" goes to createAcpLeader, an unknown kind throws"],
  ["server/index.ts", "} else if (leaderKind === \"opencode\") {", "works: same dispatch"],
  ["server/runner.ts", "return { [BRIEF_VAR]: briefPath, ...(run.cli === \"opencode\"", "refused: run commands are for crew seats, and an ACP CLI cannot be one"],
  ["server/runner.ts", "case \"claude\":", "refused: buildCommand has a default branch that throws for any other kind"],
  ["server/runner.ts", "case \"codex\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "case \"opencode\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "const env = leaderChildEnv({ ...commandEnv(run, briefPath), ...(run.cli === \"opencode\"", "refused: crew seats only"],
  ["server/runner.ts", "const claudeState: AgentUsageState | null = run.cli === \"claude\"", "refused: crew seats only"],
  ["server/runner.ts", "const codexState: AgentUsageState | null = run.cli === \"codex\"", "refused: crew seats only"],
  ["server/leader-common.ts", "export const KNOWN_CLI_NAMES = [\"claude\", \"codex\", \"opencode\", \"gemini\"] as const;", "works: the program names started by name; an ACP program goes through resolveCliOrThrow in spawnAcpChild"],
  ["server/leader-common.ts", "export function leaderKindOf(cli: unknown)", "works: the one dispatch from a leader kind to its adapter; an unknown kind throws"],
  ["server/leader-common.ts", "if (cli === \"claude\" || cli === \"codex\" || cli === \"opencode\") return cli;", "works: leaderKindOf, the one dispatch; ACP is the next line"],
  ["server/settings.ts", "export type CliId = \"claude\" | \"codex\" | \"opencode\" | \"gemini\";", "n/a: Settings tools (install, sign-in status, MCP) for the four known CLIs"],
  ["server/settings.ts", "export const CLI_IDS: CliId[] = [\"claude\", \"codex\", \"opencode\", \"gemini\"];", "n/a: same; test B1 ties it to the safe-resolution list"],
  ["server/settings.ts", "if (cli === \"claude\") {", "n/a: Settings tools only (each such line)"],
  ["server/settings.ts","if (id === \"opencode\") credentialSource = openCodeCredentialSource(result);","n/a: OpenCode credential source is derived from auth output; ACP registration is separate"],
  ["server/settings.ts", "this.state.skills.opencode.skills =", "n/a: Settings tools only"],
  ["server/settings.ts", "if (cli === \"codex\") args = [\"mcp\", \"add\"", "n/a: Settings tools only"],
  ["server/settings.ts", "else if (cli === \"claude\") args = [\"mcp\", \"add\"", "n/a: Settings tools only"],
  ["server/settings.ts", "if (cli !== \"claude\" && cli !== \"codex\") throw new SettingsActionError", "n/a: Settings tools only"],
  ["server/settings.ts", "const result = await this.call(cli, [\"mcp\", \"remove\"", "n/a: Settings tools only"],
  ["public/app.js", "const MODEL_BRAND = {", "works: an ACP CLI has no brand logo; logo() falls back to the first letter of its name"],
  ["public/app.js", "const info = cli === \"claude\" ? serverState?.claudeModels", "works: formatModel answers an ACP kind first (the model the CLI reports, else CLI default)"],
  ["public/app.js", "if (cli === \"claude\" && Array.isArray(serverState?.claudeModels))", "works: modelOptions answers an ACP kind first (only the default)"],
  ["public/app.js", "if (cli === \"opencode\" && Array.isArray(serverState?.opencodeModels))", "works: same as the line above"],
  ["public/app.js", "if (cli !== \"claude\") return true;", "works: modelSupportsEffort answers an ACP kind first (no effort)"],
  ["public/app.js", "...(cli === \"claude\" ? (inventory.plugins", "n/a: Settings tools only"],
  ["public/app.js", "[\"ask\", \"Ask before edits\", (name, cli) => cli === \"codex\"", "works: not offered for an ACP leader (the permission picker shows Full access only)"],
  ["public/app.js", ": cli === \"opencode\" ? `${name} asks before edits and commands.", "works: same as the line above"],
  ["public/app.js", "[\"accept\", \"Auto-accept edits\", (_name, cli) => cli === \"codex\"", "works: same as the line above"],
  ["public/app.js", "[\"plan\", \"Plan only\", (_name, cli) => cli === \"codex\"", "works: same as the line above"],
  ["public/app.js", ": cli === \"opencode\" ? \"Edits are denied.", "works: same as the line above"],
  ["public/app.js", "$(\"first\").innerHTML = `<div class=\"fcard\">", "works: the first-run text names ACP CLIs too; the tool list there is the four known CLIs"],
  ["public/first-run/key-panel.js", "const facts = (cli) => page.state?.settings?.catalogTools?.[cli];", "works: key fields and saved state come only from the catalog tool ID; matching ACP connections use the same profile without requiring signedIn"],
  ["public/first-run/cli-help.js", "order: Object.freeze([\"claude\", \"codex\", \"opencode\"]),", "n/a: the first-run screen lists the three leader CLIs completeFirstRun accepts; an ACP CLI is added later in Settings"],
  ["public/first-run/view.js", "if (!autoChecked) { autoChecked = true; if (HELP.order.some((cli) => typeof page.state?.settings?.tools?.[cli]", "n/a: the one automatic tool check when a first-run leader CLI's status is not known yet"],
  ["public/app.js", "const counts = cli === \"gemini\"", "n/a: Settings tools only"],
  ["public/app.js", "const canRemoveMcp = cli === \"claude\" || cli === \"codex\";", "n/a: Settings tools only"],
  ["public/app.js", "const plugins = cli === \"claude\" ?", "n/a: Settings tools only"],
  ["public/app.js", "const savedBy = {", "n/a: the Settings form drafts; the ACP form is listed in it"],
  ["public/app.js", "<section class=\"settings-section\" id=\"s-skills\"", "n/a: Settings tools only (skills and MCP of the four known CLIs)"],
  ["server/config.ts", "if (isAcpKind(kind)) return model === ACP_DEFAULT;", "works: isValidModel answers an ACP kind first: only the CLI's own default model"],
  ["server/config.ts", "const list = MODEL_OPTIONS[kind];", "works: reached only for the three known kinds (the ACP answer returns above it)"],
  ["server/config.ts", "if (list?.includes(model) || SAVED_MODELS[kind]", "works: same, known kinds only"],
  ["server/config.ts", "return kind === \"codex\"", "works: the Codex model pattern, known kinds only (the ACP answer returns first)"],
  ["server/config.ts", "export function isValidEffort(kind: SeatKind | AcpKind", "works: an ACP kind answers first: only the CLI's own default effort; the rest is for the known kinds"],
  ["server/config.ts", "export function defaultEffort(kind: SeatKind | AcpKind", "works: an ACP kind answers first with the default effort"],
  ["server/config.ts", "for (const kind of Object.keys(SAVED_EFFORTS) as SeatKind[])", "works: the saved model and effort lists exist for the three known kinds only; an ACP kind is skipped on line 369"],
  ["server/config.ts", "for (const kind of Object.keys(SAVED_MODELS) as SeatKind[])", "works: same, the three known kinds"],
  ["server/index.ts", "return lead && isAcpKind(lead.cli) ?", "works: acpLeaderOf finds the saved CLI of a tab's ACP leader"],
  ["server/index.ts", "return Boolean(lead && isAcpKind(lead.cli));", "works: hasAcpLeader is true only for the leader slot holding an ACP kind"],
  ["server/leader-acp.ts", "export const acpToolStep", "n/a: the adapter's own map from a tool's reported kind to a step label (names a tool kind, not a CLI)"],
  ["server/settings.ts", "this.state.skills[cli].instructionFiles", "n/a: Settings tools only"],
  ["server/settings.ts", "const inventory = this.state.skills[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "const target = this.state.skills[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "export function loginProfile(cli)", "works: the sign-in table is keyed by catalog id; an ACP tool such as Grok has its own managed profile and every tool without one answers the unsupported message"],
  ["public/app.js", "const brand = MODEL_BRAND[cli];", "works: an ACP CLI has no brand; logo() falls back to the first letter of its name on the next line"],
  ["public/app.js", "if (!brand || !path) return `<span class=\"lg\"", "works: the letter fallback for a CLI with no brand logo (an ACP CLI)"],
  ["public/app.js", "if (isAcpCli(cli)) return acpShownModel(cli, tab)", "works: formatModel shows THIS tab's reported model, else the CLI's last used one, else CLI default"],
  ["public/app.js", "function cliLabel(cli) {", "works: an ACP CLI is labelled with its saved name"],
  ["public/app.js", "if (isAcpCli(cli)) return [\"default\"];", "works: modelOptions offers an ACP CLI only its default"],
  ["public/app.js", "let values = serverState?.modelOptions?.[cli];", "n/a: the server's lists for the known kinds (an ACP kind returned above)"],
  ["public/app.js", "function effortOptions(cli, model)", "n/a: the server's effort lists; an ACP kind has none (modelSupportsEffort is false)"],
  ["public/app.js", "if (isAcpCli(cli)) return false;", "works: modelSupportsEffort is false for an ACP CLI"],
  ["public/app.js", "const status = (cli) => { const tool = tools[cli];", "n/a: first-run status of the four known tools"],
  ["public/model-picker.js","if (fields.cli && page.isAcpCli(fields.cli)) {","works: picking an ACP CLI asks for the Full access confirmation first"],
  ["public/app.js", "const header = `<div class=\"skill-head\">", "n/a: Settings tools only"],
  ["public/app.js", "if (action === \"mcp-remove\")", "n/a: Settings tools only"],
  ["public/app.js", "confirmAction({ title: `Add ${name} to ${CLI_LABEL[cli]}?`", "n/a: Settings tools only"],
  ["public/fixed-crew/task-archive-view.js", "const runs = (task.executions ?? []).filter((run) => SHIPPING[run.kind]);", "n/a: shipping action labels, independent of worker CLI"],
  ["public/fixed-crew/task-archive-view.js", "const el = item(SHIPPING[run.kind]", "n/a: recorded shipping result labels, independent of worker CLI"],
  ["server/fixed-crew/bulk-assignment.ts", "if (!models.includes(selected.model)", "works: registered ACP assignments use their default model without a discovered-model list"],
];
test("E1: every place in the source that decides per CLI kind is listed with what an ACP leader does there", () => {
  const found: string[] = [], listed = new Set<number>();
  for (const file of SCANNED) {
    const lines = sourceText(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!DECIDES.test(line)) return;
      const text = line.trim();
      const at = VERDICTS.findIndex(([f, start]) => f === file && text.startsWith(start));
      if (at < 0) found.push(`${file}:${index + 1}: ${text.slice(0, 140)}`); else listed.add(at);
    });
  }
  const stale = VERDICTS.filter((_, index) => !listed.has(index)).map(([file, start]) => `${file}: ${start.slice(0, 100)}`);
  console.log(`pack17 sweep: ${listed.size} listed places matched in ${SCANNED.length} files`);
  assert.ok(listed.size >= 100, `control: the scan must find the places (found ${listed.size})`);
  assert.deepEqual(found, [], `places that decide per CLI and are not listed (add them with a verdict):\n${found.join("\n")}`);
  assert.deepEqual(stale, [], `listed places that are gone or changed:\n${stale.join("\n")}`);
  for (const [, , verdict] of VERDICTS) assert.match(verdict, /^(works|refused|n\/a): .{8,}/, verdict);
});

test("E2: the model shown for an ACP leader is the one reported by the tab being shown, never another tab's; with none yet, the CLI's last used one", () => {
  const app = appSource();
  const start = app.indexOf("function formatModel(cli, model, tab = null) {"), end = app.indexOf("\n", app.indexOf("const acpShownModel ="));
  assert.ok(start > 0 && end > start, `control: the model helpers were found (${start}, ${end})`);
  const make = (state: unknown) => new Function("serverState", "MODEL_LABEL", "CLI_LABEL", "titleCase", `${app.slice(start, end)}; return formatModel;`)(state, {}, {}, (text: string) => text) as (cli: string, model: string, tab?: unknown) => string;
  const tabA = { acpLeader: { name: "Fake", model: "prov/model-A" } }, tabB = { acpLeader: { name: "Fake", model: "prov/model-B" } }, tabNone = { acpLeader: { name: "Fake", model: null } };
  const format = make({ acpClis: [{ kind: "acp:fake", name: "Fake", lastModel: "prov/last-used" }], projects: [{ tabs: [{ ...tabA, crew: [{ isLeader: true, cli: "acp:fake" }] }, { ...tabB, crew: [{ isLeader: true, cli: "acp:fake" }] }] }] });
  assert.equal(format("acp:fake", "default", tabA), "prov/model-A");
  assert.equal(format("acp:fake", "default", tabB), "prov/model-B", "tab B shows its own model, not tab A's");
  assert.equal(format("acp:fake", "default", tabNone), "prov/last-used", "a tab with no model yet shows the CLI's last used one");
  assert.equal(format("acp:fake", "default"), "prov/last-used", "no tab: the CLI's last used one");
  assert.equal(make({ acpClis: [{ kind: "acp:fake", name: "Fake" }], projects: [{ tabs: [{ ...tabA, crew: [] }] }] })("acp:fake", "default", tabNone), "CLI default");
});

test("F1: the Full access warning sits inside the composer next to the chat box and takes its width and centring from the same layout", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), css = styleSource();
  const composer = html.slice(html.indexOf('id="composer"'), html.indexOf('id="cbox"'));
  assert.match(composer, /id="acpNote"/, "the warning is a child of the composer, ahead of the chat box");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\n)${selector.replace(/\./g, "\.")}\{([^}]*)\}`))?.[1] ?? "";
  for (const part of ["max-width:760px", "margin:0 auto"]) { assert.ok(rule(".cbox").includes(part), `.cbox has ${part}`); assert.ok(rule(".acp-note").includes(part), `.acp-note has ${part}`); }
});
