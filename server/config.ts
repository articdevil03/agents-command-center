import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { keepBadCopy } from "./safe-file.ts";
import { discoverClaudeEffort, discoverOpencodeModels, discoverClaudeModels, type Discovered, type ClaudeModelInfo, type DiscoveredClaudeModels } from "./cli-discovery.ts";
import { CLI_CAPS, KINDS, TEMPLATES, findTemplate, validateSetup, isSafeSeatId, isAcpCli, cliCaps, type ProcessKind, type Seat, type Setup, type Step } from "./process.ts";
import { dataRoot, configDir, LEGACY_LEADER, workspacesPath, projectsPath, publishConfigFile, sweepSeedTemps, readJson, isSafeShape, isObject, validSlug, validText, liveFilesProtected, liveWritePath } from "./config-files.ts";
import { migrateOldTabs, keepConfigBackups } from "./config-migrate.ts";
import type { SavedSetup } from "./config-setups.ts";
import { acpKindOf, type AcpCli } from "./config-acp.ts";

export { workspacesPath, projectsPath, clientPrefsPath, launchSafetyPath, acpClisPath, setupsPath } from "./config-files.ts";
export * from "./config-acp.ts";
export * from "./config-prefs.ts";
export * from "./config-setups.ts";


export type SeatKind = "claude" | "codex" | "opencode";
// A CLI added from Settings by its start command (Agent Client Protocol): "acp:<id>". It can sit on any seat; its model and effort are always the CLI's own default.
export type AcpKind = `acp:${string}`;
export const ACP_DEFAULT = "default";
export const isAcpKind = (value: unknown): value is AcpKind => isAcpCli(value);
export type CrewMember = Seat;
export type WorkspaceTab = {
  id: string;
  name: string;
  kind: ProcessKind;
  folder: string;
  setupName: string;
  crew: CrewMember[];
  lookPause: boolean;
  steps: Step[];
};
export type WorkspaceProject = { id: string; name: string; folder: string; tabs: WorkspaceTab[] };
export type Workspaces = { projects: WorkspaceProject[] };


export { isSafeSeatId };

const FALLBACK_CLAUDE_MODELS: ClaudeModelInfo[] = [
  { value: "claude-opus-5-5[1m]", displayName: "Opus 5.5 (1M context)", supportsEffort: true },
  { value: "claude-sonnet-5-5[1m]", displayName: "Sonnet 5.5 (1M context)", supportsEffort: true },
  { value: "claude-opus-5", displayName: "Opus", supportsEffort: true },
  { value: "claude-opus-5[1m]", displayName: "Opus (1M context)", supportsEffort: true },
  { value: "claude-fable-5-1[1m]", displayName: "Fable", supportsEffort: false },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", supportsEffort: false },
  { value: "sonnet", displayName: "Sonnet", supportsEffort: true },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku", supportsEffort: false },
];
export let CLAUDE_MODEL_INFO: ClaudeModelInfo[] = [...FALLBACK_CLAUDE_MODELS];
const CODEX_BASELINE_MODELS = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"];
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

const OPENCODE_MODEL_PATTERN = new RegExp(CLI_CAPS.opencode.customModel!);
const CODEX_MODEL_PATTERN = new RegExp(CLI_CAPS.codex.customModel!);
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
// What a seat gets when its CLI changes and its old effort does not exist there.
export function defaultEffort(kind: SeatKind | AcpKind): string { if (isAcpKind(kind)) return ACP_DEFAULT; return EFFORT_OPTIONS[kind].includes("medium") ? "medium" : EFFORT_OPTIONS[kind][0]; }


export type CliCap = { id: string; label: string; advisor: boolean; readOnlyEnforced: boolean; crewTools: boolean; customModel: string | null; installed: boolean | null; models: string[] | null; efforts: string[] };
export type SetupTemplate = { id: string; name: string; kind: ProcessKind; desc: string; crew: CrewMember[]; lookPause: boolean; steps: Step[] };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// A mutable copy of a template (a visible one, or the hidden old Main Crew), ready to put on a tab.
export function templateCopy(id: string): SetupTemplate {
  const template = findTemplate(id);
  if (!template) throw new Error(`unknown template: ${String(id)}`);
  return clone(template) as SetupTemplate;
}
export function visibleTemplates(): SetupTemplate[] { return TEMPLATES.map((template) => templateCopy(template.id)); }
export const DEFAULT_SETUP_ID = "our-process";

// What the page shows for each CLI: the capability table (process.ts) plus whether it is installed and what it offers.
export function buildClis(installed: (cli: SeatKind) => boolean | null, acp: AcpCli[]): CliCap[] {
  const builtIn = (Object.keys(CLI_CAPS) as SeatKind[]).map((id): CliCap => ({ ...CLI_CAPS[id], installed: installed(id), models: MODEL_OPTIONS[id] ? [...MODEL_OPTIONS[id]!] : null, efforts: [...EFFORT_OPTIONS[id]] }));
  const added = acp.map((cli): CliCap => ({ ...cliCaps(acpKindOf(cli))!, label: cli.name, installed: true, models: [ACP_DEFAULT], efforts: [ACP_DEFAULT] }));
  return [...builtIn, ...added];
}

// The values a seat carries must be ones the CLI accepts. strict = a write: they must be in the live lists. A read only checks shape (see isSafeShape).
export function validateSetupValues(setup: Setup, strict = true): void {
  for (const seat of setup.crew) {
    if (!(strict ? isValidModel(seat.cli, seat.model) && isValidEffort(seat.cli, seat.effort) : isSafeShape(seat.model) && isSafeShape(seat.effort))) throw new Error(`invalid model or effort for ${seat.slot}`);
    if (seat.advisor !== undefined && !(strict ? isValidModel("claude", seat.advisor) : isSafeShape(seat.advisor))) throw new Error(`invalid advisor model for ${seat.slot}`);
  }
}


// The values and pictures of every seat, with the messages a damaged file has always got.
export function checkSeatValues(tabKey: string, crew: CrewMember[], strict: boolean, path: string): void {
  for (const member of crew) {
    if (!(strict ? isValidModel(member.cli, member.model) && isValidEffort(member.cli, member.effort) : isSafeShape(member.model) && isSafeShape(member.effort))) {
      throw new Error(`config file malformed, invalid slot/model/effort for "${tabKey}.${member.slot}": ${path}`);
    }
    if (!isSafeSeatId(`${tabKey}.${member.slot}`)) throw new Error(`config file malformed, unsafe seat key "${tabKey}.${member.slot}": ${path}`);
    if (member.pic !== undefined && (typeof member.pic !== "string" || member.pic.length > 512 || /[\u0000-\u001f\u007f]/.test(member.pic))) {
      throw new Error(`config file malformed, invalid pic for "${tabKey}.${member.slot}": ${path}`);
    }
    if (member.advisor !== undefined && !(strict ? isValidModel("claude", member.advisor) : isSafeShape(member.advisor))) {
      throw new Error(`config file malformed, invalid advisor for "${tabKey}.${member.slot}": ${path}`);
    }
  }
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
      if (typeof tab.kind !== "string" || !Object.hasOwn(KINDS, tab.kind)) throw new Error(`config file malformed, unknown kind "${String(tab.kind)}" in tab "${tab.id}": ${path}`);
      if (typeof tab.setupName !== "string" || tab.setupName.length > 80) throw new Error(`config file malformed, invalid setup name in tab "${tab.id}": ${path}`);
      let setup: Setup;
      try { setup = validateSetup({ crew: tab.crew, lookPause: tab.lookPause }); }
      catch (err) { throw new Error(`config file malformed, invalid crew or steps in tab "${tab.id}" (${(err as Error).message}): ${path}`, { cause: err }); }
      // The steps and the look switch are the crew's: whatever the file or the caller held is replaced by what the roles derive.
      tab.steps = setup.steps; tab.lookPause = setup.lookPause;
      checkSeatValues(tab.id, setup.crew, strict, path);
    }
  }
  return data as unknown as Workspaces;
}

// A new Development tab starts on Our process.
function defaultTab(id: string, folder: string): WorkspaceTab {
  const template = templateCopy(DEFAULT_SETUP_ID);
  return { id, name: "Development", kind: template.kind, folder, setupName: template.name, crew: template.crew, lookPause: template.lookPause, steps: template.steps };
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
        tabs: [defaultTab(`${entry.id}-development`, entry.dir)],
      };
    }),
  };
  validateWorkspaces(workspaces, destination, true);
  return publishConfigFile(JSON.stringify(workspaces, null, 2) + "\n", destination);
}

// A fresh install starts with one empty example project and tab, never the repo owner's own projects. Its folder is a
// new empty one in the data root, so no seat starts with write access to a real project or the home folder.
export function defaultWorkspaces(folder: string = join(dataRoot, "example-project")): Workspaces {
  return { projects: [{ id: "example", name: "Example project", folder, tabs: [defaultTab("example-development", folder)] }] };
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
export function readWorkspaces(path: string = workspacesPath): Workspaces { return migrateOldPresetPics(validateWorkspaces(migrateOldTabs(readJson(path), path), path)); }
export function writeWorkspaces(workspaces: Workspaces, path?: string): void {
  const target = liveWritePath(path, workspacesPath);
  const validated = validateWorkspaces(workspaces, target, true);
  keepConfigBackups(target);
  publishConfigFile(JSON.stringify(validated, null, 2) + "\n", target, true);
  if (target === workspacesPath) adoptSavedValues(validated);
}


// The saved sets always mirror the CURRENT workspace (never a union over time); each catalogue is its
// discovery/baseline part plus the saved values.
const BASE: { claudeModels: ClaudeModelInfo[]; codexModels: string[]; opencodeModels: string[]; efforts: Record<SeatKind, string[]> } = {
  claudeModels: FALLBACK_CLAUDE_MODELS.map((item) => ({ ...item })),
  codexModels: [...CODEX_BASELINE_MODELS],
  opencodeModels: [...OPENCODE_MODEL_SUGGESTIONS_FALLBACK],
  efforts: { claude: [...EFFORT_OPTIONS.claude], codex: [...EFFORT_OPTIONS.codex], opencode: [...EFFORT_OPTIONS.opencode] },
};
// Every template's own models and efforts stay valid whatever a live list says: a new tab on a template must always be writable.
function templateValues(): { models: Record<SeatKind, Set<string>>; efforts: Record<SeatKind, Set<string>> } {
  const found = { models: { claude: new Set<string>(), codex: new Set<string>(), opencode: new Set<string>() }, efforts: { claude: new Set<string>(), codex: new Set<string>(), opencode: new Set<string>() } };
  for (const template of TEMPLATES) for (const seat of template.crew) {
    if (!isAcpKind(seat.cli)) { found.models[seat.cli].add(seat.model); found.efforts[seat.cli].add(seat.effort); }
    if (seat.advisor) found.models.claude.add(seat.advisor);
  }
  return found;
}
function rebuildCatalogues(): void {
  const fromTemplates = templateValues();
  const models = (kind: SeatKind) => [...SAVED_MODELS[kind], ...fromTemplates.models[kind]];
  for (const kind of Object.keys(SAVED_EFFORTS) as SeatKind[]) EFFORT_OPTIONS[kind] = [...BASE.efforts[kind], ...[...SAVED_EFFORTS[kind], ...fromTemplates.efforts[kind]].filter((effort, at, all) => !BASE.efforts[kind].includes(effort) && all.indexOf(effort) === at)];
  MODEL_OPTIONS.codex = [...BASE.codexModels, ...models("codex").filter((model, at, all) => !BASE.codexModels.includes(model) && all.indexOf(model) === at)];
  OPENCODE_MODEL_SUGGESTIONS = [...BASE.opencodeModels, ...[...SAVED_MODELS.opencode].filter((model) => !BASE.opencodeModels.includes(model))];
  CLAUDE_MODEL_INFO = mergeClaudeModelInfo(BASE.claudeModels, models("claude"));
  MODEL_OPTIONS.claude = CLAUDE_MODEL_INFO.map((item) => item.value);
}
// The saved setups (config/setups.json) as last read or written: their models stay valid like a tab's.
let adoptedSetups: SavedSetup[] = [];
export function adoptSavedValues(workspaces: Workspaces, setups: SavedSetup[] = adoptedSetups): void {
  adoptedSetups = setups;
  for (const kind of Object.keys(SAVED_MODELS) as SeatKind[]) { SAVED_MODELS[kind].clear(); SAVED_EFFORTS[kind].clear(); }
  const crews = [...workspaces.projects.flatMap((project) => project.tabs.map((tab) => tab.crew)), ...setups.map((setup) => setup.crew)];
  for (const seat of crews.flat()) {
    if (!isAcpKind(seat.cli)) { SAVED_MODELS[seat.cli].add(seat.model); SAVED_EFFORTS[seat.cli].add(seat.effort); }
    if (seat.advisor) SAVED_MODELS.claude.add(seat.advisor);
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

