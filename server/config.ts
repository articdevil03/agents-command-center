import { readFileSync, existsSync, mkdirSync, mkdtempSync, linkSync, lstatSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveDataRoot } from "./data-root.ts";
import { keepBadCopy, writeFileSynced } from "./safe-file.ts";
import { discoverClaudeEffort, discoverOpencodeModels, discoverClaudeModels, type Discovered, type ClaudeModelInfo, type DiscoveredClaudeModels } from "./cli-discovery.ts";
import { getProcessDefinition, type ProcessKind, type ProcessId } from "./process.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataRoot = resolveDataRoot(process.env, repoRoot);
const configDir = join(dataRoot, "config");
export const workspacesPath = join(configDir, "workspaces.json");
export const projectsPath = join(configDir, "projects.json");
export const clientPrefsPath = join(configDir, "client-prefs.json");
export const launchSafetyPath = join(configDir, "launch-safety.json");
export const acpClisPath = join(configDir, "acp-clis.json");

export type SeatKind = "claude" | "codex" | "opencode";
// A leader CLI added from Settings by its start command (Agent Client Protocol): "acp:<id>". Leader seat only; its model and effort are always the CLI's own default.
export type AcpKind = `acp:${string}`;
export const ACP_DEFAULT = "default";
export const isAcpKind = (value: unknown): value is AcpKind => typeof value === "string" && value.length <= 40 && /^acp:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export type CrewMember = { slot: string; name: string; cli: SeatKind | AcpKind; model: string; effort: string; pic?: string };
export type WorkspaceAdvisor = { model: string };
export type WorkspaceTab = {
  id: string;
  name: string;
  kind: ProcessKind;
  process: ProcessId;
  folder: string;
  crew: CrewMember[];
  advisor?: WorkspaceAdvisor;
};
export type WorkspaceProject = { id: string; name: string; folder: string; tabs: WorkspaceTab[] };
export type Workspaces = { projects: WorkspaceProject[] };

// Atomic publication means a racing server never observes a partial seed. A
// hard link publishes without replacing a winner; ordinary preference writes
// use an atomic same-volume rename.
function publishConfigFile(contents: string | Buffer, dest: string, replace = false): boolean {
  mkdirSync(dirname(dest), { recursive: true });
  const temporaryDir = mkdtempSync(join(dirname(dest), ".seed-"));
  const temporaryPath = join(temporaryDir, "config.json");
  try {
    writeFileSynced(temporaryPath, contents);
    try {
      if (replace) renameSync(temporaryPath, dest);
      else linkSync(temporaryPath, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!replace && code === "EEXIST") {
        if (!statSync(dest).isFile()) throw err;
        return false;
      }
      throw new Error(`${replace ? "config write" : "config seeding"}: could not ${replace ? "write" : "publish"} "${dest}": ${(err as Error).message}`, { cause: err });
    }
    return true;
  } finally {
    try { rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* the published file is already complete */ }
  }
}

// A crash between mkdtemp and the final rename leaves a ".seed-XXXXXX" folder holding one config.json. Only such a folder,
// a minute or more old (a racing server's live publish is younger), is removed: its one file, then the empty folder.
function sweepSeedTemps(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names.filter((item) => /^\.seed-[A-Za-z0-9]{6}$/.test(item))) {
    const folder = join(dir, name);
    try {
      const info = lstatSync(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || Date.now() - info.mtimeMs < 60_000) continue;
      try { unlinkSync(join(folder, "config.json")); } catch { /* already gone */ }
      rmdirSync(folder);
    } catch { /* not ours to clean, or busy: leave it */ }
  }
}

function readJson(path: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) { throw new Error(`config file missing or unreadable: ${path} (${(err as Error).message})`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`config file is not valid JSON: ${path} (${(err as Error).message})`); }
}

const WINDOWS_RESERVED_CHARS = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
const LOG_TS_DIGITS = 13;
const MAX_SEAT_ID_LENGTH = 255 - (1 + LOG_TS_DIGITS + ".brief.txt".length);

export function isSafeSeatId(id: string): boolean {
  if (id.trim().length === 0 || id.length > MAX_SEAT_ID_LENGTH) return false;
  if (WINDOWS_RESERVED_CHARS.some((ch) => id.includes(ch))) return false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !id.endsWith(".") && !id.endsWith(" ");
}

const FALLBACK_CLAUDE_MODELS: ClaudeModelInfo[] = [
  { value: "claude-opus-5-5[1m]", displayName: "Opus 5.5 (1M context)", supportsEffort: true },
  { value: "claude-opus-5", displayName: "Opus", supportsEffort: true },
  { value: "claude-opus-5[1m]", displayName: "Opus (1M context)", supportsEffort: true },
  { value: "claude-fable-5-1[1m]", displayName: "Fable", supportsEffort: false },
  { value: "sonnet", displayName: "Sonnet", supportsEffort: true },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku", supportsEffort: false },
];
export let CLAUDE_MODEL_INFO: ClaudeModelInfo[] = [...FALLBACK_CLAUDE_MODELS];
const CODEX_BASELINE_MODELS = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
export const MODEL_OPTIONS: Record<SeatKind, string[] | null> = {
  claude: FALLBACK_CLAUDE_MODELS.map((m) => m.value),
  codex: [...CODEX_BASELINE_MODELS],
  opencode: null,
};
const FALLBACK_CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_OPTIONS: Record<SeatKind, string[]> = {
  claude: [...FALLBACK_CLAUDE_EFFORT],
  codex: ["low", "medium", "high", "max"],
  // Only the fake-CLI test runner may widen it, to prove the leader reads the saved effort on every turn.
  opencode: process.env.CC_TEST_FAKE_CLI === "1" && process.env.CC_TEST_OPENCODE_EFFORTS ? process.env.CC_TEST_OPENCODE_EFFORTS.split(",") : ["max"],
};
export const OPENCODE_MODEL_SUGGESTIONS_FALLBACK = ["opencode/claude-sonnet-5", "opencode/gpt-6-astra", "opencode/glm-5.2", "opencode/qwen3.6-plus", "opencode/grok-4.6"];
export let OPENCODE_MODEL_SUGGESTIONS: string[] = [...OPENCODE_MODEL_SUGGESTIONS_FALLBACK];
export type DiscoveryInfo = { claudeEffort: { fallback: boolean }; opencodeModels: { fallback: boolean }; claudeModels: { fallback: boolean } };
export const discoveryInfo: DiscoveryInfo = { claudeEffort: { fallback: true }, opencodeModels: { fallback: true }, claudeModels: { fallback: true } };

const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const CODEX_MODEL_PATTERN = /^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
// Values the file already holds. Discovery only completes after the server listens, so a saved model or effort is
// adopted at boot (adoptSavedValues) and stays valid through every later refresh; only user input is checked against
// the live list.
const SAVED_MODELS: Record<SeatKind, Set<string>> = { claude: new Set(), codex: new Set(), opencode: new Set() };
const SAVED_EFFORTS: Record<SeatKind, Set<string>> = { claude: new Set(), codex: new Set(), opencode: new Set() };
// A write or a user pick needs a safe shape (the same rule a load applies) AND the list/CLI check, so nothing
// can be saved that the next start would refuse.
export function isValidModel(kind: SeatKind | AcpKind, model: string): boolean {
  if (isAcpKind(kind)) return model === ACP_DEFAULT;
  if (!isSafeShape(model)) return false;
  const list = MODEL_OPTIONS[kind];
  if (list?.includes(model) || SAVED_MODELS[kind]?.has(model)) return true;
  return kind === "codex"
    ? model.length <= 100 && CODEX_MODEL_PATTERN.test(model)
    : kind === "opencode" && model.length <= 100 && OPENCODE_MODEL_PATTERN.test(model);
}
export function isValidEffort(kind: SeatKind | AcpKind, effort: string): boolean { if (isAcpKind(kind)) return effort === ACP_DEFAULT; return isSafeShape(effort) && (EFFORT_OPTIONS[kind].includes(effort) || SAVED_EFFORTS[kind]?.has(effort) === true); }
// The one load-time rule for a saved model or effort: it can never be dangerous in argv or a path. No list is
// consulted. Letter or digit first (never a flag), a conservative charset, a length cap, and no ".." segment.
const SAFE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
function isSafeShape(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && SAFE_SHAPE.test(value) && !value.split("/").includes("..");
}
// What a seat gets when its CLI changes and its old effort does not exist there.
export function defaultEffort(kind: SeatKind | AcpKind): string { if (isAcpKind(kind)) return ACP_DEFAULT; return EFFORT_OPTIONS[kind].includes("medium") ? "medium" : EFFORT_OPTIONS[kind][0]; }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && isSafeSeatId(value);
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function defaultCrew(kind: ProcessKind, process: ProcessId): CrewMember[] {
  const definition = getProcessDefinition(kind, process);
  return definition.seats.map((seat) => ({
    slot: seat.slotId,
    name: seat.defaultName,
    cli: seat.cli as SeatKind,
    model: seat.model,
    effort: seat.effort,
  }));
}

// strict = a write: values must be in the live lists. A read only checks shape (see isSafeShape).
function validateWorkspaces(data: unknown, path: string, strict = false): Workspaces {
  if (!isObject(data) || !Array.isArray(data.projects)) throw new Error(`config file malformed, expected { projects: [] }: ${path}`);
  const projectIds = new Set<string>();
  const tabIds = new Set<string>();
  for (const [projectIndex, project] of data.projects.entries()) {
    if (!isObject(project) || !validSlug(project.id) || !validText(project.name) || typeof project.folder !== "string" || !project.folder.trim() || !Array.isArray(project.tabs)) {
      throw new Error(`config file malformed, bad project entry ${projectIndex}: ${path}`);
    }
    if (projectIds.has(project.id.toLowerCase())) throw new Error(`config file malformed, duplicate project id "${project.id}": ${path}`);
    projectIds.add(project.id.toLowerCase());
    if (project.tabs.length === 0) throw new Error(`config file malformed, project "${project.id}" must have at least one tab: ${path}`);
    for (const [tabIndex, tab] of project.tabs.entries()) {
      if (!isObject(tab) || !validSlug(tab.id) || !validText(tab.name) || typeof tab.folder !== "string" || !tab.folder.trim() || !Array.isArray(tab.crew)) {
        throw new Error(`config file malformed, bad tab ${tabIndex} in project "${project.id}": ${path}`);
      }
      if (tabIds.has(tab.id.toLowerCase())) throw new Error(`config file malformed, duplicate tab id "${tab.id}": ${path}`);
      tabIds.add(tab.id.toLowerCase());
      let definition;
      try { definition = getProcessDefinition(tab.kind as ProcessKind, tab.process as ProcessId); }
      catch { throw new Error(`config file malformed, unknown kind/process "${String(tab.kind)}/${String(tab.process)}" in tab "${tab.id}": ${path}`); }
      const expectedSlots = new Map(definition.seats.map((seat) => [seat.slotId, seat]));
      if (tab.crew.length !== expectedSlots.size) throw new Error(`config file malformed, crew slot count does not match process for tab "${tab.id}": ${path}`);
      const seenSlots = new Set<string>();
      for (const member of tab.crew) {
        if (!isObject(member) || typeof member.slot !== "string" || !expectedSlots.has(member.slot) || !validText(member.name) || !(["claude", "codex", "opencode"].includes(String(member.cli)) || (isAcpKind(member.cli) && expectedSlots.get(member.slot)!.isLeader)) || typeof member.model !== "string" || typeof member.effort !== "string") {
          throw new Error(`config file malformed, invalid crew member in tab "${tab.id}": ${path}`);
        }
        if (seenSlots.has(member.slot) || !(strict ? isValidModel(member.cli as SeatKind, member.model) && isValidEffort(member.cli as SeatKind, member.effort) : isSafeShape(member.model) && isSafeShape(member.effort))) {
          throw new Error(`config file malformed, invalid slot/model/effort for "${tab.id}.${member.slot}": ${path}`);
        }
        seenSlots.add(member.slot);
        if (!isSafeSeatId(`${tab.id}.${member.slot}`)) throw new Error(`config file malformed, unsafe seat key "${tab.id}.${member.slot}": ${path}`);
        if (member.pic !== undefined && (typeof member.pic !== "string" || member.pic.length > 512 || /[\u0000-\u001f\u007f]/.test(member.pic))) {
          throw new Error(`config file malformed, invalid pic for "${tab.id}.${member.slot}": ${path}`);
        }
      }
      if (tab.advisor !== undefined && (!isObject(tab.advisor) || typeof tab.advisor.model !== "string" || !(strict ? isValidModel("claude", tab.advisor.model) : isSafeShape(tab.advisor.model)))) {
        throw new Error(`config file malformed, invalid advisor for tab "${tab.id}": ${path}`);
      }
    }
  }
  return data as unknown as Workspaces;
}

// A missing workspaces file is an upcast from projects.json only. Legacy
// seats and Underground picks are intentionally ignored and left untouched.
export function migrateWorkspaces(projectsFile: string, destination: string): boolean {
  if (existsSync(destination)) {
    if (!statSync(destination).isFile()) throw new Error(`config destination is not a file: ${destination}`);
    return false;
  }
  const old = readJson(projectsFile);
  if (!Array.isArray(old)) throw new Error(`config file malformed, expected an array: ${projectsFile}`);
  const workspaces: Workspaces = {
    projects: old.map((entry, index) => {
      if (!isObject(entry) || !validSlug(entry.id) || !validText(entry.name) || typeof entry.dir !== "string") {
        throw new Error(`config file malformed, bad legacy project entry ${index}: ${projectsFile}`);
      }
      return {
        id: entry.id,
        name: entry.name,
        folder: entry.dir,
        tabs: [{ id: `${entry.id}-development`, name: "Development", kind: "dev", process: "main", folder: entry.dir, crew: defaultCrew("dev", "main") }],
      };
    }),
  };
  validateWorkspaces(workspaces, destination, true);
  return publishConfigFile(JSON.stringify(workspaces, null, 2) + "\n", destination);
}

// A fresh install starts with one empty example project and tab, never the repo owner's own projects. Its folder is a
// new empty one in the data root, so no seat starts with write access to a real project or the home folder.
export function defaultWorkspaces(folder: string = join(dataRoot, "example-project")): Workspaces {
  return { projects: [{ id: "example", name: "Example project", folder, tabs: [{ id: "example-development", name: "Development", kind: "dev", process: "main", folder, crew: defaultCrew("dev", "main") }] }] };
}

// Under node --test whenever the resolved data root is the repo itself (no CC_DATA_DIR, or one the resolver ignores), its live files must not be written.
function liveFilesProtected(): boolean {
  return !!process.env.NODE_TEST_CONTEXT && resolve(dataRoot).toLowerCase() === resolve(repoRoot).toLowerCase();
}
function liveWritePath(path: string | undefined, live: string): string {
  if (path !== undefined) return path;
  if (liveFilesProtected()) throw new Error(`refusing to write the live config file under a test, pass a temp path or set CC_DATA_DIR: ${live}`);
  return live;
}

function publishDefaultWorkspaces(replace: boolean): void {
  const defaults = defaultWorkspaces();
  validateWorkspaces(defaults, workspacesPath, true);
  mkdirSync(defaults.projects[0].folder, { recursive: true });
  publishConfigFile(JSON.stringify(defaults, null, 2) + "\n", workspacesPath, replace);
}

function seedAndMigrate(): void {
  sweepSeedTemps(configDir);
  if (existsSync(workspacesPath)) {
    if (!statSync(workspacesPath).isFile()) throw new Error(`config destination is not a file: ${workspacesPath}`);
    // An empty or unparsable file starts the app on the example workspace; the bad file is kept first.
    let unreadable = false;
    try { JSON.parse(readFileSync(workspacesPath, "utf8")); } catch { unreadable = true; }
    if (unreadable && !liveFilesProtected()) { keepBadCopy(workspacesPath); publishDefaultWorkspaces(true); }
    return;
  }
  if (liveFilesProtected()) return;
  // Only the user's own earlier projects.json (never a bundled one) is upgraded; otherwise the example workspace.
  if (existsSync(projectsPath)) migrateWorkspaces(projectsPath, workspacesPath);
  else publishDefaultWorkspaces(false);
}
seedAndMigrate();

// The leader's earlier default name, still found in saved seats, pictures and launch notices. Split so the word never appears whole in the source.
const LEGACY_LEADER = "boo" + "gie";

// Old photo presets "avatars/<name>.jpg|png": the five that have a flat SVG move to it, every other one is
// dropped so the seat falls back to its default picture. The leader's earlier preset (photo or flat) is now "atlas".
// Persisted with the next workspaces write.
const FLAT_AVATAR_NAMES = new Set(["atlas", "sonny", "vera", "sol", "terra"]);
function migrateOldPresetPics(workspaces: Workspaces): Workspaces {
  for (const project of workspaces.projects) for (const tab of project.tabs) for (const seat of tab.crew) {
    if (seat.pic === `avatars/${LEGACY_LEADER}.svg` || seat.pic === `/avatars/${LEGACY_LEADER}.svg`) { seat.pic = "avatars/atlas.svg"; continue; }
    const old = typeof seat.pic === "string" ? seat.pic.match(/^\/?avatars\/([A-Za-z0-9-]{1,40})\.(?:png|jpg)$/) : null;
    if (!old) continue;
    const name = old[1] === LEGACY_LEADER ? "atlas" : old[1];
    if (FLAT_AVATAR_NAMES.has(name)) seat.pic = `avatars/${name}.svg`;
    else delete seat.pic;
  }
  return workspaces;
}
export function readWorkspaces(path: string = workspacesPath): Workspaces { return migrateOldPresetPics(validateWorkspaces(readJson(path), path)); }
export function writeWorkspaces(workspaces: Workspaces, path?: string): void {
  const target = liveWritePath(path, workspacesPath);
  const validated = validateWorkspaces(workspaces, target, true);
  publishConfigFile(JSON.stringify(validated, null, 2) + "\n", target, true);
  if (target === workspacesPath) adoptSavedValues(validated);
}

// ---- ACP CLIs: leader CLIs the user added from Settings by their start command (config/acp-clis.json). No shell ever: the program is a bare name resolved on PATH, the arguments are a list of plain tokens. ----
export type AcpCli = { id: string; name: string; program: string; args: string[]; lastModel?: string };
export const ACP_MAX_CLIS = 12;
const ACP_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACP_ARG = /^[A-Za-z0-9._:=/@+,-]{1,120}$/;
export const acpIdFromName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
export const acpKindOf = (cli: AcpCli): AcpKind => `acp:${cli.id}`;
export function validateAcpCli(value: unknown): AcpCli {
  if (!isObject(value)) throw new Error("An ACP CLI needs a name and a start command");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f<>]/.test(name)) throw new Error("The CLI name must be 1 to 40 characters, with no control characters or < >");
  const id = acpIdFromName(name);
  if (!id || (typeof value.id === "string" && value.id !== id)) throw new Error("The CLI name needs at least one letter or digit");
  if (typeof value.program !== "string" || !ACP_PROGRAM.test(value.program)) throw new Error("The program must be a plain command name (like gemini), not a path or anything that needs a shell");
  if (!Array.isArray(value.args) || value.args.length > 16 || !value.args.every((arg) => typeof arg === "string" && ACP_ARG.test(arg))) throw new Error("The arguments must be plain words (letters, digits and . _ : = / @ + , -), 16 at most");
  const lastModel = typeof value.lastModel === "string" && /^[ -~]{1,100}$/.test(value.lastModel) ? value.lastModel : undefined;
  return { id, name, program: value.program, args: [...value.args] as string[], ...(lastModel ? { lastModel } : {}) };
}
// "gemini --acp" -> { program: "gemini", args: ["--acp"] }. Quotes, pipes, redirects or variables are refused (there is no shell to run them).
export function parseAcpStartCommand(text: unknown): { program: string; args: string[] } {
  const words = typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) throw new Error("The start command is required (for example: gemini --acp)");
  return { program: words[0], args: words.slice(1) };
}
export function readAcpClis(path: string = acpClisPath): AcpCli[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`ACP CLI list is unreadable: ${path} (${(err as Error).message}); fix or delete it`); }
  if (!isObject(raw) || !Array.isArray(raw.clis)) throw new Error(`ACP CLI list is malformed, expected { clis: [] }: ${path}`);
  const list = raw.clis.map(validateAcpCli);
  if (new Set(list.map((cli) => cli.id)).size !== list.length) throw new Error(`ACP CLI list has a duplicate name: ${path}`);
  return list;
}
export function writeAcpClis(clis: AcpCli[], path?: string): void {
  const checked = clis.map(validateAcpCli);
  if (new Set(checked.map((cli) => cli.id)).size !== checked.length) throw new Error("that name is already used by another ACP CLI");
  if (checked.length > ACP_MAX_CLIS) throw new Error(`at most ${ACP_MAX_CLIS} ACP CLIs`);
  publishConfigFile(JSON.stringify({ clis: checked }, null, 2) + "\n", liveWritePath(path, acpClisPath), true);
}

// The saved sets always mirror the CURRENT workspace (never a union over time); each catalogue is its
// discovery/baseline part plus the saved values.
const BASE: { claudeModels: ClaudeModelInfo[]; codexModels: string[]; opencodeModels: string[]; efforts: Record<SeatKind, string[]> } = {
  claudeModels: FALLBACK_CLAUDE_MODELS.map((item) => ({ ...item })),
  codexModels: [...CODEX_BASELINE_MODELS],
  opencodeModels: [...OPENCODE_MODEL_SUGGESTIONS_FALLBACK],
  efforts: { claude: [...EFFORT_OPTIONS.claude], codex: [...EFFORT_OPTIONS.codex], opencode: [...EFFORT_OPTIONS.opencode] },
};
function rebuildCatalogues(): void {
  for (const kind of Object.keys(SAVED_EFFORTS) as SeatKind[]) EFFORT_OPTIONS[kind] = [...BASE.efforts[kind], ...[...SAVED_EFFORTS[kind]].filter((effort) => !BASE.efforts[kind].includes(effort))];
  MODEL_OPTIONS.codex = [...BASE.codexModels, ...[...SAVED_MODELS.codex].filter((model) => !BASE.codexModels.includes(model))];
  OPENCODE_MODEL_SUGGESTIONS = [...BASE.opencodeModels, ...[...SAVED_MODELS.opencode].filter((model) => !BASE.opencodeModels.includes(model))];
  CLAUDE_MODEL_INFO = mergeClaudeModelInfo(BASE.claudeModels, [...SAVED_MODELS.claude]);
  MODEL_OPTIONS.claude = CLAUDE_MODEL_INFO.map((item) => item.value);
}
export function adoptSavedValues(workspaces: Workspaces): void {
  for (const kind of Object.keys(SAVED_MODELS) as SeatKind[]) { SAVED_MODELS[kind].clear(); SAVED_EFFORTS[kind].clear(); }
  for (const tab of workspaces.projects.flatMap((project) => project.tabs)) {
    for (const seat of tab.crew) if (!isAcpKind(seat.cli)) { SAVED_MODELS[seat.cli].add(seat.model); SAVED_EFFORTS[seat.cli].add(seat.effort); }
    if (tab.advisor) SAVED_MODELS.claude.add(tab.advisor.model);
  }
  rebuildCatalogues();
}
function mergeClaudeModelInfo(discovered: ClaudeModelInfo[], preserve: string[]): ClaudeModelInfo[] {
  const merged = [...discovered];
  for (const value of preserve) if (!merged.some((item) => item.value === value)) merged.push({ value, displayName: value, supportsEffort: true });
  return merged;
}
function applyDiscovery(claudeEffort: Discovered, opencodeModels: Discovered, claudeModels: DiscoveredClaudeModels): void {
  // A discovered value that is not safe-shaped is never offered (a write of it would be refused).
  BASE.efforts.claude = claudeEffort.values.filter(isSafeShape);
  discoveryInfo.claudeEffort.fallback = claudeEffort.fallback;
  BASE.opencodeModels = opencodeModels.values.filter(isSafeShape);
  discoveryInfo.opencodeModels.fallback = opencodeModels.fallback;
  BASE.codexModels = [...CODEX_BASELINE_MODELS];
  if (!opencodeModels.fallback) {
    for (const model of BASE.opencodeModels.filter((item) => item.startsWith("opencode/gpt-"))) {
      const id = model.slice("opencode/".length);
      if (isSafeShape(id) && !BASE.codexModels.includes(id)) BASE.codexModels.push(id);
    }
  }
  const discovered = claudeModels.fallback ? FALLBACK_CLAUDE_MODELS : claudeModels.values;
  BASE.claudeModels = discovered.filter((item) => isSafeShape(item.value)).map((item) => ({ ...item }));
  try { adoptSavedValues(readWorkspaces()); } catch { rebuildCatalogues(); }
  discoveryInfo.claudeModels.fallback = claudeModels.fallback;
}
export async function refreshDiscovery(
  discoverEffort: (fallback: readonly string[]) => Discovered | Promise<Discovered> = discoverClaudeEffort,
  discoverModels: (fallback: readonly string[]) => Discovered | Promise<Discovered> = discoverOpencodeModels,
  discoverModelsForClaude: (fallback: readonly ClaudeModelInfo[], cliPath: string | null) => DiscoveredClaudeModels | Promise<DiscoveredClaudeModels> = discoverClaudeModels,
  claudeCliPath: string | null = null,
): Promise<void> {
  const [claudeEffort, opencodeModels, claudeModels] = await Promise.all([
    discoverEffort(FALLBACK_CLAUDE_EFFORT),
    discoverModels(OPENCODE_MODEL_SUGGESTIONS_FALLBACK),
    discoverModelsForClaude(FALLBACK_CLAUDE_MODELS, claudeCliPath),
  ]);
  applyDiscovery(claudeEffort, opencodeModels, claudeModels);
}

export const IMAGE_EXT_TO_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
export const IMAGE_MIME_TO_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export type LaunchNotice = { type: "leaderLaunch"; id: number; seatId: string; seatName: string; brief: string; source: string; pending?: boolean; headsUp?: string };
export type LaunchSafety = {
  blocked: string[];
  timestamps: number[];
  notices: LaunchNotice[];
  nextNoticeId: number;
  released: { seatId: string; pid: number; runId?: string }[];
  uncertain: { seatId: string; pid: number; runId?: string }[];
  // Runs started and not yet seen to end. After a hard crash these are what nobody tracks any more: the next start blocks their seats.
  live: { seatId: string; runId: string }[];
};
export function readLaunchSafety(path: string = launchSafetyPath): LaunchSafety {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] };
    throw new Error(`launch safety file is unreadable: ${path} (${(err as Error).message}); fix or delete it`, { cause: err });
  }
  // A file from an older version lacks the newer lists: those start empty. A list that is there but damaged is still refused.
  // Its notices may carry the leader's earlier message type; they are read as the current one.
  if (raw && Array.isArray(raw.notices)) for (const n of raw.notices) if (n && n.type === `${LEGACY_LEADER}Launch`) n.type = "leaderLaunch";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of ["timestamps", "notices", "released", "uncertain", "live"]) if (raw[key] === undefined) raw[key] = [];
    if (raw.nextNoticeId === undefined && Array.isArray(raw.notices)) raw.nextNoticeId = 1 + Math.max(0, ...raw.notices.map((n: any) => (Number.isSafeInteger(n?.id) ? n.id : 0)));
  }
  const validPidRows = (rows: any) => Array.isArray(rows) && rows.every((item: any) => item && typeof item.seatId === "string" && isSafeSeatId(item.seatId) && Number.isSafeInteger(item.pid) && item.pid > 0 && (item.runId === undefined || (typeof item.runId === "string" && isSafeSeatId(item.runId))));
  if (!raw || !Array.isArray(raw.blocked) || !raw.blocked.every((id: unknown) => typeof id === "string" && isSafeSeatId(id))
    || !Array.isArray(raw.timestamps) || !raw.timestamps.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0)
    || !Number.isSafeInteger(raw.nextNoticeId) || raw.nextNoticeId < 1
    || !Array.isArray(raw.notices) || !raw.notices.every((n: LaunchNotice) => n && n.type === "leaderLaunch" && Number.isSafeInteger(n.id) && n.id > 0 && n.id < raw.nextNoticeId && typeof n.seatId === "string" && isSafeSeatId(n.seatId) && typeof n.seatName === "string" && typeof n.brief === "string" && typeof n.source === "string")
    || !validPidRows(raw.released)) throw new Error(`invalid launch safety state in ${path}; refusing to reset the brakes (fix or delete the file to start with none)`);
  if (!validPidRows(raw.uncertain)) throw new Error(`invalid unconfirmed process state in ${path}`);
  if (!Array.isArray(raw.live) || !raw.live.every((item: any) => item && typeof item.seatId === "string" && isSafeSeatId(item.seatId) && typeof item.runId === "string" && isSafeSeatId(item.runId))) throw new Error(`invalid running-process state in ${path}`);
  return raw;
}
export function writeLaunchSafety(state: LaunchSafety, path?: string): void { publishConfigFile(JSON.stringify(state, null, 2) + "\n", liveWritePath(path, launchSafetyPath), true); }

export type ClientPrefs = {
  sidebarCollapsed: boolean; notificationsEnabled: boolean; bellEnabled: boolean; bellVolume: number; previewUrl: string;
  rightPanelCollapsed: boolean; rightPanelWidth: number;
  theme: "light" | "dark" | "system"; avatar: string; dismissedRuns: string[];
  crewRailOpen: boolean; detailsOpen: boolean;
};
export const DEFAULT_CLIENT_PREFS: ClientPrefs = {
  sidebarCollapsed: false, notificationsEnabled: true, bellEnabled: false, bellVolume: 100, previewUrl: "http://localhost:8081",
  rightPanelCollapsed: false, rightPanelWidth: 320,
  theme: "light", avatar: "ash.svg", dismissedRuns: [],
  crewRailOpen: true, detailsOpen: false,
};
// The app window opens on a new random port every launch, so the page cannot keep these in its own localStorage (a new port
// is a new, empty one): the server keeps them, including whether the crew rail and the details panel are open. An uploaded picture is a data URL that rides in every state message, so it is
// capped at 512 KiB (the picture dialog says so too); a preset is a short name.
export const AVATAR_MAX_CHARS = 512 * 1024;
// A tab keeps 50 finished runs (MAX_FINISHED_RUNS), so this holds every dismissal of 40 tabs; the page trims to the same number (public/app.js).
export const DISMISSED_RUNS_MAX = 2000;
function isTheme(value: unknown): value is ClientPrefs["theme"] { return value === "light" || value === "dark" || value === "system"; }
// The completion sound's volume, a whole percent: 0 is silent, 100 is the bell at full level.
function isBellVolume(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100; }
function isAvatar(value: unknown): value is string {
  return typeof value === "string" && (/^[a-z]+\.svg$/.test(value) || (/^data:image\//.test(value) && value.length <= AVATAR_MAX_CHARS));
}
function isDismissedRuns(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= DISMISSED_RUNS_MAX && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200);
}
function isValidPreviewUrlValue(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try { const parsed = new URL(value.trim()); return parsed.protocol === "http:" || parsed.protocol === "https:"; }
  catch { return false; }
}
export function readClientPrefs(path: string = clientPrefsPath): ClientPrefs {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...DEFAULT_CLIENT_PREFS }; }
  if (!isObject(raw)) return { ...DEFAULT_CLIENT_PREFS };
  if (raw.avatar === `${LEGACY_LEADER}.svg`) raw.avatar = "atlas.svg"; // the leader's earlier preset name
  return {
    sidebarCollapsed: typeof raw.sidebarCollapsed === "boolean" ? raw.sidebarCollapsed : DEFAULT_CLIENT_PREFS.sidebarCollapsed,
    notificationsEnabled: typeof raw.notificationsEnabled === "boolean" ? raw.notificationsEnabled : DEFAULT_CLIENT_PREFS.notificationsEnabled,
    // The completion sound is its own switch (the top bar's sound button): it plays with desktop notices on or off.
    bellEnabled: typeof raw.bellEnabled === "boolean" ? raw.bellEnabled : DEFAULT_CLIENT_PREFS.bellEnabled,
    bellVolume: isBellVolume(raw.bellVolume) ? raw.bellVolume : DEFAULT_CLIENT_PREFS.bellVolume,
    previewUrl: isValidPreviewUrlValue(raw.previewUrl) ? raw.previewUrl : DEFAULT_CLIENT_PREFS.previewUrl,
    rightPanelCollapsed: typeof raw.rightPanelCollapsed === "boolean" ? raw.rightPanelCollapsed : DEFAULT_CLIENT_PREFS.rightPanelCollapsed,
    rightPanelWidth: typeof raw.rightPanelWidth === "number" && Number.isFinite(raw.rightPanelWidth) && raw.rightPanelWidth > 0 ? raw.rightPanelWidth : DEFAULT_CLIENT_PREFS.rightPanelWidth,
    theme: isTheme(raw.theme) ? raw.theme : DEFAULT_CLIENT_PREFS.theme,
    avatar: isAvatar(raw.avatar) ? raw.avatar : DEFAULT_CLIENT_PREFS.avatar,
    dismissedRuns: isDismissedRuns(raw.dismissedRuns) ? [...raw.dismissedRuns] : [],
    crewRailOpen: typeof raw.crewRailOpen === "boolean" ? raw.crewRailOpen : DEFAULT_CLIENT_PREFS.crewRailOpen,
    detailsOpen: typeof raw.detailsOpen === "boolean" ? raw.detailsOpen : DEFAULT_CLIENT_PREFS.detailsOpen,
  };
}
export function writeClientPrefs(prefs: ClientPrefs, path?: string, onlyIfMissing = false): boolean {
  return publishConfigFile(JSON.stringify(prefs, null, 2) + "\n", liveWritePath(path, clientPrefsPath), !onlyIfMissing);
}
export function applyClientPrefUpdate(prefs: ClientPrefs, key: unknown, value: unknown): { ok: true; prefs: ClientPrefs } | { ok: false; error: string } {
  if (key === "sidebarCollapsed" || key === "rightPanelCollapsed" || key === "notificationsEnabled" || key === "bellEnabled" || key === "crewRailOpen" || key === "detailsOpen") {
    if (typeof value !== "boolean") return { ok: false, error: `invalid value for client pref "${key}": expected boolean` };
    return { ok: true, prefs: { ...prefs, [key]: value } };
  }
  if (key === "rightPanelWidth") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { ok: false, error: `invalid value for client pref "${key}": expected a positive number` };
    return { ok: true, prefs: { ...prefs, rightPanelWidth: value } };
  }
  if (key === "bellVolume") {
    if (!isBellVolume(value)) return { ok: false, error: 'invalid value for client pref "bellVolume": expected a whole number from 0 to 100' };
    return { ok: true, prefs: { ...prefs, bellVolume: value } };
  }
  if (key === "theme") {
    if (!isTheme(value)) return { ok: false, error: 'invalid value for client pref "theme": expected light, dark or system' };
    return { ok: true, prefs: { ...prefs, theme: value } };
  }
  if (key === "avatar") {
    if (!isAvatar(value)) return { ok: false, error: typeof value === "string" && value.startsWith("data:image/") ? `That picture is too large to keep (limit ${AVATAR_MAX_CHARS / 1024} KB). Pick a smaller one.` : 'invalid value for client pref "avatar": expected a preset name or an image' };
    return { ok: true, prefs: { ...prefs, avatar: value } };
  }
  if (key === "dismissedRuns") {
    if (!isDismissedRuns(value)) return { ok: false, error: `invalid value for client pref "dismissedRuns": expected up to ${DISMISSED_RUNS_MAX} run ids` };
    return { ok: true, prefs: { ...prefs, dismissedRuns: [...value] } };
  }
  if (key === "previewUrl") {
    if (!isValidPreviewUrlValue(value)) return { ok: false, error: "invalid value for client pref \"previewUrl\": expected an http(s) URL" };
    return { ok: true, prefs: { ...prefs, previewUrl: value } };
  }
  return { ok: false, error: `unknown client pref: ${String(key)}` };
}
