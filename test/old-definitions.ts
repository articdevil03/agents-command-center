// The old fixed crews with their stored steps (how the app shipped before the crew's roles decided the steps). The engine tests walk these
// shapes: the engine takes any steps, so they stay a good set of inputs. Nothing here is used by the server.
import { copy, deepFreeze, stepOwners, type Template, type DeepReadonly, type ProcessId, type ProcessKind, type Seat, type SeatCli, type Setup, type Step, type RoundPair } from "../server/process.ts";


export interface SeatDefinition { slotId: string; defaultName: string; roleLabel: string; cli: string; model: string; effort: string; isLeader: boolean; canWrite?: boolean }
export interface ProcessStep { id: string; label: string; owners: readonly string[] }
export interface ProcessDefinition { kind: ProcessKind; process: ProcessId; supportsRounds: boolean; steps: readonly ProcessStep[]; seats: readonly SeatDefinition[] }
// ---- Templates (the starting setups) and the hidden old crews ----
const OPUS = "claude-opus-5-5[1m]";
const SONNET = "claude-sonnet-5-5[1m]";
const FABLE = "claude-fable-5-1";
const SOL = "gpt-6.1-sol";
function seat(slot: string, name: string, role: string, cli: SeatCli, model: string, effort: string, canWrite: boolean, extra: Partial<Seat> = {}): Seat {
  return { slot, name, role, cli, model, effort, canWrite, isLeader: slot === "leader", ...extra };
}
const work = (id: string, label: string, ...owners: string[]): Step => ({ id, label, type: "work", owners });
const finish = (id: string, label: string, ...owners: string[]): Step => ({ id, label, type: "finish", owners });
const look = (): Step => ({ id: "look", label: "Your look", type: "look", owners: ["user"] });
const rounds = (id: string, label: string, ...pairs: RoundPair[]): Step => ({ id, label, type: "rounds", pairs });

const leadDev = seat("leader", "Atlas", "Leader", "claude", OPUS, "medium", false);
const coderCodex = seat("coder", "Sonny", "Coder", "codex", "gpt-6-luna", "max", true);

// A tab on no steps just chats with its leader; switching an existing tab to it keeps the tab's kind (useSetup in server/index.ts).
const BLANK: Template = {
  id: "blank", name: "Start blank", kind: "dev", desc: "Just the leader and no steps. Add seats and steps yourself.",
  crew: [leadDev],
  steps: [],
};
const OUR_PROCESS: Template = {
  id: "our-process", name: "Our process", kind: "dev",
  desc: "The planner runs the process: Sonnet builds, Sol and Opus review in turns, you look before review.",
  crew: [
    seat("leader", "Atlas", "Leader", "claude", OPUS, "low", false, { advisor: FABLE }),
    seat("planner", "Sage", "Planner", "claude", OPUS, "high", false, { advisor: FABLE, orchestrates: true }),
    seat("coder", "Sonny", "Coder", "claude", SONNET, "medium", true),
    seat("reviewer1", "Vera", "Reviewer 1", "codex", SOL, "low", false),
    seat("fixer1", "Juno", "Fixer 1", "codex", SOL, "low", true),
    seat("reviewer2", "Sol", "Reviewer 2", "claude", OPUS, "medium", false),
    seat("fixer2", "Nova", "Fixer 2", "claude", SONNET, "medium", true),
    seat("final", "Terra", "Final reviewer", "claude", OPUS, "medium", false),
  ],
  steps: [
    work("brief", "Brief", "planner"), work("build", "Build", "coder"), work("gate", "Gate", "planner"), look(),
    rounds("review", "Review", { reviewer: "reviewer1", fixers: ["fixer1"] }, { reviewer: "reviewer2", fixers: ["fixer2"] }),
    work("finalReview", "Final review", "final"), finish("ship", "Ship", "planner"),
  ],
};
const DUO: Template = {
  id: "duo", name: "The Duo", kind: "dev", desc: "The leader and one coder; the leader reviews.",
  crew: [leadDev, coderCodex],
  steps: [
    work("brief", "Brief", "leader"), work("build", "Build", "coder"), work("gate", "Gate", "leader"), look(),
    rounds("review", "Review", { reviewer: "leader", fixers: ["coder"] }), finish("ship", "Ship", "leader"),
  ],
};
const SOLO: Template = {
  id: "solo", name: "Stand-alone", kind: "dev", desc: "Just the leader.",
  crew: [leadDev],
  steps: [work("brief", "Brief", "leader"), work("work", "Work", "leader"), look(), finish("done", "Done", "leader")],
};
const DESIGN: Template = {
  id: "design", name: "Design", kind: "design", desc: "A designer builds the mock, a design reviewer checks it.",
  crew: [
    seat("leader", "Atlas", "Leads design", "claude", OPUS, "high", false),
    seat("designer", "Terra", "UI and UX designer", "claude", OPUS, "high", true),
    seat("imageAndAssets", "X", "Image and assets", "codex", "gpt-6-astra", "medium", true),
    seat("designReviewer", "Sol", "Design reviewer", "codex", "gpt-6-sol", "high", false),
  ],
  steps: [
    work("brief", "Brief", "leader"), work("mock", "Mock", "designer"), look(),
    rounds("review", "Review", { reviewer: "designReviewer", fixers: ["designer"] }), finish("handOff", "Hand off", "leader"),
  ],
};
const MARKETING: Template = {
  id: "marketing", name: "Marketing", kind: "mkt", desc: "A second opinion, three makers (you pick who fixes), a final check.",
  crew: [
    seat("leader", "Atlas", "Leads marketing", "claude", OPUS, "high", false),
    seat("secondOpinion", "Astra", "Second opinion and research", "codex", "gpt-6-astra", "high", false),
    seat("socialMedia", "Vera", "Social media manager", "claude", OPUS, "medium", true),
    seat("image", "X", "Image generation", "codex", "gpt-6-astra", "medium", true),
    seat("videoAndMotion", "Terra", "Video and motion", "claude", OPUS, "high", true),
  ],
  steps: [
    work("brief", "Brief", "leader"), work("secondOpinion", "Second opinion", "secondOpinion"),
    work("create", "Create", "socialMedia", "image", "videoAndMotion"), look(),
    rounds("finalCheck", "Final check", { reviewer: "secondOpinion", fixers: ["socialMedia", "image", "videoAndMotion"] }),
    finish("ready", "Ready", "leader"),
  ],
};
// Hidden: the old six-seat Main Crew. It exists only so old tabs migrate without loss.
const CLASSIC_MAIN: Template = {
  id: "classic-main", name: "The Main Crew", kind: "dev", desc: "The earlier six-seat crew.",
  crew: [
    leadDev, coderCodex,
    seat("reviewer1", "Vera", "Reviewer 1", "claude", OPUS, "medium", false),
    seat("reviewer2", "Sol", "Reviewer 2", "codex", "gpt-6-sol", "high", false),
    seat("fixer", "Nova", "Fixer", "claude", OPUS, "medium", true),
    seat("finalReviewer", "Terra", "Final reviewer", "codex", "gpt-6-sol", "high", false),
  ],
  steps: [
    work("brief", "Brief", "leader"), work("build", "Build", "coder"), work("gate", "Gate", "leader"), look(),
    rounds("review", "Review", { reviewer: "reviewer1", fixers: ["coder"] }, { reviewer: "reviewer2", fixers: ["fixer"] }),
    work("finalReview", "Final review", "finalReviewer"), finish("ship", "Ship", "leader"),
  ],
};
export const TEMPLATES: readonly DeepReadonly<Template>[] = deepFreeze([BLANK, OUR_PROCESS, DUO, SOLO, DESIGN, MARKETING]);
export const HIDDEN_TEMPLATES: readonly DeepReadonly<Template>[] = deepFreeze([CLASSIC_MAIN]);
// Which template an old (kind, process) tab becomes. Every old pair is here, so no old file is left without a way in.
export const LEGACY: DeepReadonly<Record<ProcessKind, Record<ProcessId, string>>> = deepFreeze({
  dev: { main: "classic-main", duo: "duo", solo: "solo" },
  design: { main: "design", duo: "duo", solo: "solo" },
  mkt: { main: "marketing", duo: "duo", solo: "solo" },
});
export function findTemplate(id: unknown): DeepReadonly<Template> | undefined {
  return typeof id === "string" ? [...TEMPLATES, ...HIDDEN_TEMPLATES].find((template) => template.id === id) : undefined;
}
export function defaultTemplateId(kind: ProcessKind): string {
  return kind === "design" ? "design" : kind === "mkt" ? "marketing" : "our-process";
}
function legacyTemplate(kind: unknown, process: unknown): DeepReadonly<Template> {
  // Own-property lookup: an unknown kind/process (or "constructor") is a plain error, never undefined or a TypeError downstream.
  const id = typeof kind === "string" && typeof process === "string" && Object.hasOwn(LEGACY, kind) && Object.hasOwn(LEGACY[kind as ProcessKind], process) ? LEGACY[kind as ProcessKind][process as ProcessId] : undefined;
  const template = id ? findTemplate(id) : undefined;
  if (!template) throw new Error(`unknown kind/process: ${String(kind)}/${String(process)}`);
  return template;
}
// A mutable copy of what an old (kind, process) tab starts from.
export function legacySetup(kind: unknown, process: unknown): Setup & { templateId: string; name: string } {
  const template = legacyTemplate(kind, process);
  return { templateId: template.id, name: template.name, crew: copy(template.crew) as Seat[], steps: copy(template.steps) as Step[] };
}
// The old fixed-crew view of an old (kind, process), for old-format fixtures.
export function getProcessDefinition(kind: ProcessKind, process: ProcessId): DeepReadonly<ProcessDefinition> {
  const setup = legacySetup(kind, process);
  return deepFreeze({
    kind, process,
    supportsRounds: setup.steps.some((step) => step.type === "rounds"),
    steps: setup.steps.map((step) => ({ id: step.id, label: step.label, owners: stepOwners(step) })),
    seats: setup.crew.map((member): SeatDefinition => ({ slotId: member.slot, defaultName: member.name, roleLabel: member.role, cli: member.cli, model: member.model, effort: member.effort, isLeader: member.isLeader, ...(member.isLeader ? {} : { canWrite: member.canWrite }) })),
  });
}