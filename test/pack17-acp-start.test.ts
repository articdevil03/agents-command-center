import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { appSource, sourceFiles, sourceText, styleSource } from "./source-text.ts";
import { join, resolve } from "node:path";
import { getProcessDefinition } from "../server/process.ts";
import { readWorkspaces, parseAcpStartCommand, validateAcpCli, readAcpClis, writeAcpClis, isAcpKind, isValidModel, isValidEffort, defaultEffort, ACP_MAX_CLIS } from "../server/config.ts";
import { KNOWN_CLI_NAMES, leaderKindOf, resolveCliOrThrow, resolveCliPath, spawnAcpChild, withResolvedCli } from "../server/leader-common.ts";
import { createAcpLeader } from "../server/leader-acp.ts";
import { buildCommand } from "../server/runner.ts";
import { CLI_IDS } from "../server/settings.ts";
import { scratch, LEADER_SLOT } from "./pack17-acp-helpers.ts";

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

test("A3: an ACP kind is valid only with the CLI's own default model and effort, and only for the leader seat", () => {
  assert.equal(isAcpKind("acp:gemini"), true);
  for (const bad of ["acp:", "acp:A", "acp:a b", "acp:a/b", "claude", "gemini", "acp:-x", `acp:${"a".repeat(40)}`]) assert.equal(isAcpKind(bad), false, bad);
  assert.equal(isValidModel("acp:gemini", "default"), true);
  assert.equal(isValidModel("acp:gemini", "opus"), false);
  assert.equal(isValidEffort("acp:gemini", "default"), true);
  assert.equal(isValidEffort("acp:gemini", "high"), false);
  assert.equal(defaultEffort("acp:gemini"), "default");
  assert.equal(isValidModel("claude", "default"), false, "the ACP default is not a model of another CLI");
});

test("A4: a saved workspace may use an ACP kind on any seat, an unknown kind is refused, and a command is never made up for it", () => {
  const dir = scratch(); const file = join(dir, "workspaces.json");
  const seats = getProcessDefinition("dev", "main").seats;
  const workspace = (cliFor: (seat: (typeof seats)[number]) => string) => ({ projects: [{ id: "a", name: "A", folder: dir, tabs: [{ id: "a-1", name: "A", kind: "dev", process: "main", folder: dir, crew: seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: cliFor(seat), model: cliFor(seat).startsWith("acp:") ? "default" : seat.model, effort: cliFor(seat).startsWith("acp:") ? "default" : seat.effort })) }] }] });
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader ? "acp:gemini" : seat.cli))));
  assert.equal(readWorkspaces(file).projects[0].tabs[0].crew.find((member) => member.slot === LEADER_SLOT)!.cli, "acp:gemini");
  const crewSeat = seats.find((seat) => !seat.isLeader)!;
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader || seat.slotId === crewSeat.slotId ? "acp:gemini" : seat.cli))));
  assert.equal(readWorkspaces(file).projects[0].tabs[0].crew.find((member) => member.slot === crewSeat.slotId)!.cli, "acp:gemini", "an ACP kind on a crew seat loads (pack 18: any seat)");
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader ? "gemini" : seat.cli))));
  assert.throws(() => readWorkspaces(file), /unknown CLI/, "an unknown kind is refused");
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
  ["public/setup-editor.js", "const isAcp =", "works: the editor recognizes every acp: kind by its prefix"],
  ["public/logos.js", "window.CC_LOGOS =", "n/a: logo path data for the known CLIs; ACP uses its name initial"],
  ["public/setup-editor.js", "if (isAcp(seat.cli) && !seat.canWrite)", "works: a read-only ACP seat is told it cannot use crew tools or write"],
  ["public/setup-editor.js", "const base = tab.crew.find((seat) => !seat.isLeader && !isAcp(seat.cli))", "works: a new seat prefers a known CLI; if only ACP seats exist it inherits their default settings"],
  ["public/setup-editor.js", "if (isAcp(next.cli))", "works: an ACP draft seat gets the default model and effort"],
  ["server/config.ts", "export const isAcpKind = (value: unknown)", "works: the one test for the acp:<id> shape (process.ts isAcpCli); every seat may carry such a kind"],
  ["server/config.ts", "const builtIn = (Object.keys(CLI_CAPS) as SeatKind[])", "works: the three known kinds come from the capability table; every ACP CLI is added after them"],
  ["server/config-migrate.ts", "if (seat.isLeader && isObject(tab.advisor) && old.cli === \"claude\") next.advisor", "n/a: moves an old tab's advisor onto a Claude leader; an ACP leader never had one"],
  ["server/config.ts", "if (!isAcpKind(seat.cli)) { found.models", "works: an ACP seat adds nothing to the known kinds' template lists"],
  ["server/config.ts", "const models = (kind: SeatKind) =>", "works: the three known kinds only (saved plus template models)"],
  ["server/config.ts", "if (!isAcpKind(seat.cli)) { SAVED_MODELS", "works: an ACP seat adds nothing to the known kinds' saved lists"],
  ["server/index.ts", "clis: buildClis(", "works: the capability list the page reads: the three known kinds, then every ACP CLI"],
  ["server/index.ts", "if (isAcpKind(member.cli)) {", "works: a crew seat on an ACP CLI runs through its start command; one removed in Settings is refused with its name before anything is counted"],
  ["server/index.ts", "...(member.cli === \"claude\" && member.advisor", "n/a: the advisor is Claude's only; an ACP seat never has one"],
  ["server/process-types.ts", "export type SeatCli =", "works: the known kinds and the ACP kind"],
  ["server/process-types.ts", "export const CLI_CAPS: Record<", "works: the one capability table of the three known kinds; an ACP kind is answered by acpCaps"],
  ["server/process-types.ts", "opencode: { id: \"opencode\"", "works: one row of the capability table"],
  ["server/process-types.ts", "return isAcpCli(cli) ? acpCaps(cli) : null;", "works: an ACP kind gets the ACP capabilities (read-only not enforced, crew tools by HTTP MCP)"],
  ["server/setup.ts", "if (isAcpCli(raw.cli) && (raw.model !== \"default\"", "works: an ACP seat runs only the CLI's own default model and effort"],
  ["server/setup.ts", "if (isAcpCli(raw.cli) && !raw.canWrite)", "works: an ACP seat that runs the process must be able to write"],
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
  ["server/index.ts", "if (!tab || !lead || lead.cli !== \"claude\") return;", "n/a: the start-up health check is a Claude turn; an ACP leader has none"],
  ["server/runner.ts", "return { [BRIEF_VAR]: briefPath, ...(run.cli === \"opencode\"", "refused: run commands are for crew seats, and an ACP CLI cannot be one"],
  ["server/runner.ts", "case \"claude\":", "refused: buildCommand has a default branch that throws for any other kind"],
  ["server/runner.ts", "case \"codex\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "case \"opencode\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "const env = leaderChildEnv({ ...commandEnv(run, briefPath), ...(run.cli === \"opencode\"", "refused: crew seats only"],
  ["server/runner.ts", "const claudeState: AgentUsageState | null = run.cli === \"claude\"", "refused: crew seats only"],
  ["server/runner.ts", "const codexState: AgentUsageState | null = run.cli === \"codex\"", "refused: crew seats only"],
  ["server/runner-crew.ts", "case \"codex\": case \"opencode\": return", "refused: crew seats only, as above"],
  ["server/runner-crew.ts", "case \"claude\": return Boolean(run.crewTools)", "refused: crew seats only, as above"],
  ["server/leader-common.ts", "export const KNOWN_CLI_NAMES = [\"claude\", \"codex\", \"opencode\", \"gemini\"] as const;", "works: the program names started by name; an ACP program goes through resolveCliOrThrow in spawnAcpChild"],
  ["server/leader-common.ts", "export function leaderKindOf(cli: unknown)", "works: the one dispatch from a leader kind to its adapter; an unknown kind throws"],
  ["server/leader-common.ts", "if (cli === \"claude\" || cli === \"codex\" || cli === \"opencode\") return cli;", "works: leaderKindOf, the one dispatch; ACP is the next line"],
  ["server/settings.ts", "export type CliId = \"claude\" | \"codex\" | \"opencode\" | \"gemini\";", "n/a: Settings tools (install, sign-in status, MCP) for the four known CLIs"],
  ["server/settings.ts", "export const CLI_IDS: CliId[] = [\"claude\", \"codex\", \"opencode\", \"gemini\"];", "n/a: same; test B1 ties it to the safe-resolution list"],
  ["server/settings.ts", "if (cli === \"claude\") {", "n/a: Settings tools only (each such line)"],
  ["server/settings.ts", "if (cli === \"opencode\" && result.code === 0) {", "n/a: Settings tools only"],
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
  ["public/model-picker.js","if (seat.cli === \"codex\") hints.push(","works: the next hint line is the ACP one"],
  ["public/model-picker.js","if (seat.cli === \"opencode\") hints.push(","works: same as the line above"],
  ["public/model-picker.js","hints.push(seat.cli === \"claude\" ?","works: an ACP leader gets the generic line (applies from the next turn)"],
  ["public/app.js", "const toolRows = [\"claude\", \"codex\", \"opencode\", \"gemini\"].map(", "n/a: Settings AI tools rows; ACP CLIs have their own section"],
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
  ["server/index.ts", "if (isAcpKind(kind)) {", "works: the seat-CLI change for an ACP kind: leader slot only, Full access confirmation, safe program"],
  ["server/index.ts", "const installed = settingsService.state.tools[kind].installed;", "works: reached only for the three known kinds (the ACP branch above it returns)"],
  ["server/leader-acp.ts", "export const acpToolStep", "n/a: the adapter's own map from a tool's reported kind to a step label (names a tool kind, not a CLI)"],
  ["server/settings.ts", "const authArgs = AUTH_ARGS[cli];", "n/a: Settings tools only (the four known CLIs)"],
  ["server/settings.ts", "Object.assign(this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "this.state.skills[cli].instructionFiles", "n/a: Settings tools only"],
  ["server/settings.ts", "const inventory = this.state.skills[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "return this.action(this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "if (this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "if (!this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "const result = await this.call(\"npm\", [\"install\", \"-g\", PACKAGES[cli]]", "n/a: Settings tools only"],
  ["server/settings.ts", "const loginArgs = LOGIN_ARGS[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "this.watchSignIn(cli,", "n/a: Settings tools only"],
  ["server/settings.ts", "const target = this.state.skills[cli];", "n/a: Settings tools only"],
  ["public/app.js", "const brand = MODEL_BRAND[cli];", "works: an ACP CLI has no brand; logo() falls back to the first letter of its name on the next line"],
  ["public/app.js", "if (!brand || !path) return `<span class=\"lg\"", "works: the letter fallback for a CLI with no brand logo (an ACP CLI)"],
  ["public/app.js", "if (isAcpCli(cli)) return acpShownModel(cli, tab)", "works: formatModel shows THIS tab's reported model, else the CLI's last used one, else CLI default"],
  ["public/app.js", "function cliLabel(cli) {", "works: an ACP CLI is labelled with its saved name"],
  ["public/app.js", "if (isAcpCli(cli)) return [\"default\"];", "works: modelOptions offers an ACP CLI only its default"],
  ["public/app.js", "let values = serverState?.modelOptions?.[cli];", "n/a: the server's lists for the known kinds (an ACP kind returned above)"],
  ["public/app.js", "function effortOptions(cli)", "n/a: the server's effort lists; an ACP kind has none (modelSupportsEffort is false)"],
  ["public/app.js", "if (isAcpCli(cli)) return false;", "works: modelSupportsEffort is false for an ACP CLI"],
  ["public/app.js", "const status = (cli) => { const tool = tools[cli];", "n/a: first-run status of the four known tools"],
  ["public/model-picker.js","return `<div class=\"grp\" data-grp=","works: the picker group for an ACP CLI shows CLI default plus the model shown for THIS tab (own CLI) or the last used one (other CLIs)"],
  ["public/model-picker.js","if (page.isAcpCli(seat.cli)) hints.push(","works: the picker hint for an ACP leader"],
  ["public/model-picker.js","if (fields.cli && page.isAcpCli(fields.cli)) {","works: picking an ACP CLI asks for the Full access confirmation first"],
  ["public/app.js", "const command = tool?.installed === false ? `npm install -g", "n/a: Settings tools only"],
  ["public/app.js", "return `<div class=\"crow tool-row\"", "n/a: Settings tools only"],
  ["public/app.js", "const header = `<div class=\"skill-head\">", "n/a: Settings tools only"],
  ["public/app.js", "if (action === \"install-cli\")", "n/a: Settings tools only"],
  ["public/app.js", "if (action === \"mcp-remove\")", "n/a: Settings tools only"],
  ["public/app.js", "confirmAction({ title: `Add ${name} to ${CLI_LABEL[cli]}?`", "n/a: Settings tools only"],
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
