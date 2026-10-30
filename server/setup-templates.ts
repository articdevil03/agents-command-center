import { copy, deepFreeze, stepOwners, type DeepReadonly, type ProcessId, type ProcessKind, type Seat, type SeatCli, type Setup, type Step, type Template } from "./process-types.ts";
import { deriveSteps } from "./setup.ts";

// ---- Templates (the starting setups) and the hidden old crews. A template names its crew and the look switch; its steps are derived from the roles. ----
const OPUS = "claude-opus-5-5[1m]";
const SONNET = "claude-sonnet-5-5[1m]";
const FABLE = "claude-fable-5-1";
const SOL = "gpt-6.1-sol";
function seat(slot: string, name: string, role: string, cli: SeatCli, model: string, effort: string, canWrite: boolean, extra: Partial<Seat> = {}): Seat {
  return { slot, name, role, cli, model, effort, canWrite, isLeader: slot === "leader", ...extra };
}
function template(id: string, name: string, kind: ProcessKind, desc: string, crew: Seat[], lookPause: boolean): Template {
  return { id, name, kind, desc, crew, lookPause, steps: deriveSteps(crew, lookPause) };
}

const leadDev = seat("leader", "Atlas", "Leader", "claude", OPUS, "medium", false);
const coderCodex = seat("coder", "Sonny", "Coder", "codex", "gpt-6-luna", "max", true);

// A tab on no steps just chats with its leader; switching an existing tab to it keeps the tab's kind (useSetup in server/crew-setup.ts).
const BLANK = template("blank", "Start blank", "dev", "Just the leader. Add seats and give them roles.", [leadDev], false);
const OUR_PROCESS = template("our-process", "Our process", "dev", "The planner runs the process: Sonnet builds, Sol and Opus review in turns, you look before review.", [
  seat("leader", "Atlas", "Leader", "claude", OPUS, "low", false, { advisor: FABLE }),
  seat("planner", "Sage", "Planner", "claude", OPUS, "high", false, { advisor: FABLE, orchestrates: true }),
  seat("coder", "Sonny", "Coder", "claude", SONNET, "medium", true),
  seat("reviewer1", "Vera", "Reviewer", "codex", SOL, "low", false),
  seat("fixer1", "Juno", "Fixer", "codex", SOL, "low", true),
  seat("reviewer2", "Sol", "Reviewer", "claude", OPUS, "medium", false),
  seat("fixer2", "Nova", "Fixer", "claude", SONNET, "medium", true),
  seat("final", "Terra", "Final reviewer", "claude", OPUS, "medium", false),
], true);
const DUO = template("duo", "The Duo", "dev", "The leader and one coder; the leader reviews.", [leadDev, coderCodex], true);
const DESIGN = template("design", "Design", "design", "A designer builds the mock, a design reviewer checks it.", [
  seat("leader", "Atlas", "Leader", "claude", OPUS, "high", false),
  seat("designer", "Terra", "Design coder", "claude", OPUS, "high", true),
  seat("imageAndAssets", "X", "Helper", "codex", "gpt-6-astra", "medium", true),
  seat("designReviewer", "Sol", "Reviewer", "codex", "gpt-6-sol", "high", false),
], true);
const MARKETING = template("marketing", "Marketing", "mkt", "A second opinion and three makers who take the fixes in turn.", [
  seat("leader", "Atlas", "Leader", "claude", OPUS, "high", false),
  seat("secondOpinion", "Astra", "Reviewer", "codex", "gpt-6-astra", "high", false),
  seat("socialMedia", "Vera", "Coder", "claude", OPUS, "medium", true),
  seat("image", "X", "Coder", "codex", "gpt-6-astra", "medium", true),
  seat("videoAndMotion", "Terra", "Coder", "claude", OPUS, "high", true),
], true);
// Hidden: the old six-seat Main Crew and Stand-alone. They exist only so old tabs migrate without loss.
const CLASSIC_MAIN = template("classic-main", "The Main Crew", "dev", "The earlier six-seat crew.", [
  leadDev, coderCodex,
  seat("reviewer1", "Vera", "Reviewer", "claude", OPUS, "medium", false),
  seat("reviewer2", "Sol", "Reviewer", "codex", "gpt-6-sol", "high", false),
  seat("fixer", "Nova", "Fixer", "claude", OPUS, "medium", true),
  seat("finalReviewer", "Terra", "Final reviewer", "codex", "gpt-6-sol", "high", false),
], true);
const SOLO = template("solo", "Stand-alone", "dev", "Just the leader.", [leadDev], false);
export const TEMPLATES: readonly DeepReadonly<Template>[] = deepFreeze([BLANK, OUR_PROCESS, DUO, DESIGN, MARKETING]);
export const HIDDEN_TEMPLATES: readonly DeepReadonly<Template>[] = deepFreeze([CLASSIC_MAIN, SOLO]);
// Which template an old (kind, process) tab becomes. Every old pair is here, so no old file is left without a way in.
export const LEGACY: DeepReadonly<Record<ProcessKind, Record<ProcessId, string>>> = deepFreeze({
  dev: { main: "classic-main", duo: "duo", solo: "solo" },
  design: { main: "design", duo: "duo", solo: "solo" },
  mkt: { main: "marketing", duo: "duo", solo: "solo" },
});
export function findTemplate(id: unknown): DeepReadonly<Template> | undefined {
  return typeof id === "string" ? [...TEMPLATES, ...HIDDEN_TEMPLATES].find((item) => item.id === id) : undefined;
}
export function defaultTemplateId(kind: ProcessKind): string {
  return kind === "design" ? "design" : kind === "mkt" ? "marketing" : "our-process";
}
function legacyTemplate(kind: unknown, process: unknown): DeepReadonly<Template> {
  // Own-property lookup: an unknown kind/process (or "constructor") is a plain error, never undefined or a TypeError downstream.
  const id = typeof kind === "string" && typeof process === "string" && Object.hasOwn(LEGACY, kind) && Object.hasOwn(LEGACY[kind as ProcessKind], process) ? LEGACY[kind as ProcessKind][process as ProcessId] : undefined;
  const found = id ? findTemplate(id) : undefined;
  if (!found) throw new Error(`unknown kind/process: ${String(kind)}/${String(process)}`);
  return found;
}
// A mutable copy of what an old (kind, process) tab starts from.
export function legacySetup(kind: unknown, process: unknown): Setup & { lookPause: boolean; templateId: string; name: string } {
  const found = legacyTemplate(kind, process);
  return { templateId: found.id, name: found.name, crew: copy(found.crew) as Seat[], lookPause: found.lookPause, steps: copy(found.steps) as Step[] };
}

// The old fixed-crew shape, kept only for old-format test fixtures.
export interface SeatDefinition { slotId: string; defaultName: string; roleLabel: string; cli: string; model: string; effort: string; isLeader: boolean; canWrite?: boolean }
export interface ProcessStep { id: string; label: string; owners: readonly string[] }
export interface ProcessDefinition { kind: ProcessKind; process: ProcessId; supportsRounds: boolean; steps: readonly ProcessStep[]; seats: readonly SeatDefinition[] }
export function getProcessDefinition(kind: ProcessKind, process: ProcessId): DeepReadonly<ProcessDefinition> {
  const setup = legacySetup(kind, process);
  return deepFreeze({
    kind, process,
    supportsRounds: setup.steps.some((step) => step.type === "rounds"),
    steps: setup.steps.map((step) => ({ id: step.id, label: step.label, owners: stepOwners(step) })),
    seats: setup.crew.map((member): SeatDefinition => ({ slotId: member.slot, defaultName: member.name, roleLabel: member.role, cli: member.cli, model: member.model, effort: member.effort, isLeader: member.isLeader, ...(member.isLeader ? {} : { canWrite: member.canWrite }) })),
  });
}
