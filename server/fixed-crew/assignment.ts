import { cliCaps, isAcpCli, isObj } from "../process-types.ts";
import { isSafeShape } from "../config-files.ts";
import type { CliCap } from "../config.ts";
import { DEFAULT_WORKER_MODELS, FIXED_CREW, type Assignment, type FixedSeat, type FixedSlot } from "./roster.ts";

export type Preference = { assignment: Assignment | null; source: "auto" | "user" };
export type CrewPreferences = Record<FixedSlot, Preference>;
export type CliInventory = Pick<CliCap, "id" | "installed" | "models" | "efforts" | "advisor">;
export type ModelIdentity = { value: string; displayName: string };
export interface AssignmentCatalogue {
  clis: readonly CliInventory[];
  opencodeSuggestions?: readonly string[];
  claudeModels?: readonly ModelIdentity[];
}

export function freshPreferences(): CrewPreferences {
  return Object.fromEntries(FIXED_CREW.map(({ slot }) => [slot, { assignment: null, source: "auto" }])) as CrewPreferences;
}

// Stored values are shape-checked independently of discovery. A refresh omitting
// a previously valid model or effort must not erase an existing choice.
export function validateAssignment(value: unknown): Assignment | null {
  if (value === null) return null;
  if (!isObj(value) || !cliCaps(value.cli) || !isSafeShape(value.model) || !isSafeShape(value.effort)) {
    throw new Error("Invalid crew assignment");
  }
  const cli = value.cli as Assignment["cli"];
  const caps = cliCaps(cli)!;
  if (isAcpCli(cli) && (value.model !== "default" || value.effort !== "default")) {
    throw new Error("An ACP assignment uses its default model and effort");
  }
  if (caps.customModel && !new RegExp(caps.customModel).test(value.model)) throw new Error("Invalid crew model");
  if (value.advisor !== undefined && (!caps.advisor || !isSafeShape(value.advisor))) throw new Error("Invalid crew advisor");
  return { cli, model: value.model, effort: value.effort, ...(value.advisor === undefined ? {} : { advisor: value.advisor }) };
}

export function validatePreference(value: unknown): Preference {
  if (!isObj(value) || (value.source !== "auto" && value.source !== "user")) throw new Error("Invalid assignment source");
  return { assignment: validateAssignment(value.assignment), source: value.source };
}

function modelChoices(cli: CliInventory, catalogue: AssignmentCatalogue): string[] {
  if (isAcpCli(cli.id)) return ["default"];
  const models = cli.models ?? (cli.id === "opencode" ? catalogue.opencodeSuggestions ?? [] : []);
  return [...new Set(models)].filter((model) => {
    try { return validateAssignment({ cli: cli.id, model, effort: "medium" }) !== null; }
    catch { return false; }
  }).sort();
}

function effortChoices(cli: CliInventory): string[] {
  return isAcpCli(cli.id) ? ["default"] : [...new Set(cli.efforts)].filter(isSafeShape).sort();
}

function withAdvisor(seat: Readonly<FixedSeat>, assignment: Assignment, cli: CliInventory,
  catalogue: AssignmentCatalogue): Assignment {
  if (!seat.preferredAdvisor || assignment.cli !== "claude" || !cli.advisor) return assignment;
  const models = modelChoices(cli, catalogue);
  const advisor = catalogue.claudeModels?.filter((model) => models.includes(model.value)
    && /\bfable[ -]5[. -]2\b/i.test(`${model.value} ${model.displayName}`))
    .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)[0]?.value;
  return advisor ? { ...assignment, advisor } : assignment;
}

const automatic = (assignment: Assignment | null): Preference => ({ assignment, source: "auto" });

function cliOrder(id: string): number {
  return isAcpCli(id) ? 3 : ["claude", "codex", "opencode"].indexOf(id);
}

// Company is model provenance, not transport. Unknown providers and ACP defaults
// cannot establish independence. OpenCode's known model families retain identity.
export function assignmentCompany(assignment: Assignment | null): "anthropic" | "openai" | null {
  if (!assignment || isAcpCli(assignment.cli)) return null;
  const model = assignment.model.split("/").at(-1)!;
  if (/^claude-(?:sonnet|opus|haiku|fable)(?:-|$)/i.test(model)
    || (assignment.cli === "claude" && /^(?:sonnet|opus|haiku|fable)(?:\[|$)/i.test(model))) return "anthropic";
  if (/^gpt-\d/i.test(model)) return "openai";
  return null;
}

export type IndependenceNotice = { status: "unassigned" | "same-model" | "same-company" | "different-company" | "unknown"; blocking: false; message: string };
export function independenceNotice(writer: Assignment | null, reviewer: Assignment | null): IndependenceNotice {
  let status: IndependenceNotice["status"] = "unassigned";
  if (writer && reviewer) {
    const writerCompany = assignmentCompany(writer), reviewerCompany = assignmentCompany(reviewer);
    const sameModel = !isAcpCli(writer.cli) && !isAcpCli(reviewer.cli)
      && (writer.cli === reviewer.cli ? writer.model === reviewer.model
        : writerCompany !== null && writerCompany === reviewerCompany && writer.model.split("/").at(-1) === reviewer.model.split("/").at(-1));
    status = sameModel ? "same-model" : !writerCompany || !reviewerCompany ? "unknown"
      : writerCompany === reviewerCompany ? "same-company" : "different-company";
  }
  const messages = {
    unassigned: "Assign both seats to assess review independence.",
    "same-model": "The same model will build and review. A second AI provider can make reviews stronger.",
    "same-company": "Writer and reviewer use models from the same company.",
    "different-company": "Writer and reviewer use models from different known companies.",
    unknown: "Model company is unknown, so different-company review cannot be confirmed.",
  };
  return { status, blocking: false, message: messages[status] };
}

export function autoFillPreferences(preferences: Partial<CrewPreferences>, catalogue: AssignmentCatalogue): CrewPreferences {
  for (const slot of Object.keys(preferences)) {
    if (!FIXED_CREW.some((seat) => seat.slot === slot)) throw new Error(`Unknown crew slot: ${slot}`);
  }
  const next = freshPreferences();
  const available = catalogue.clis.filter((cli) => cli.installed === true && cliCaps(cli.id))
    .sort((a, b) => cliOrder(a.id) - cliOrder(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  function workerModels(seat: Readonly<FixedSeat>, cli: CliInventory): string[] {
    const models = modelChoices(cli, catalogue).filter((model) => !/fable/i.test(model));
    const defaults = DEFAULT_WORKER_MODELS[cli.id] ?? [];
    const model = models.includes(seat.preferred.model) ? seat.preferred.model
      : defaults.find((candidate) => models.includes(candidate)) ?? models[0];
    return model ? [model, ...models.filter((candidate) => candidate !== model)] : [];
  }

  function singleAssignment(seat: Readonly<FixedSeat>, cli: CliInventory): Assignment | null {
    const efforts = effortChoices(cli);
    const model = workerModels(seat, cli)[0];
    const effort = efforts.includes(seat.preferred.effort) ? seat.preferred.effort
      : efforts.includes("medium") ? "medium" : efforts[0];
    if (!model || !effort) return null;
    return withAdvisor(seat, { cli: cli.id as Assignment["cli"], model, effort }, cli, catalogue);
  }

  function resolve(seat: Readonly<FixedSeat>, current: Preference): Preference {
    if (current.source === "user") return current;
    if (current.assignment) return current;
    if (available.length === 0) return { assignment: null, source: "auto" };
    if (available.length === 1) return automatic(singleAssignment(seat, available[0]));
    const preferredCli = available.find((cli) => cli.id === seat.preferred.cli);
    const preferred = preferredCli ? singleAssignment(seat, preferredCli) : null;
    const ordered = preferredCli ? [preferredCli, ...available.filter((cli) => cli !== preferredCli)] : available;
    const candidates = ordered.flatMap((cli) => {
      const selected = singleAssignment(seat, cli);
      return selected ? workerModels(seat, cli).map((model): Assignment => ({ ...selected, model })) : [];
    });
    const writerCompany = seat.reviews ? assignmentCompany(next[seat.reviews].assignment) : null;
    const differentCompany = writerCompany ? candidates.find((candidate) => {
      const company = assignmentCompany(candidate);
      return company !== null && company !== writerCompany;
    }) : undefined;
    if (preferred && writerCompany && assignmentCompany(preferred) === writerCompany && differentCompany) {
      return automatic(differentCompany);
    }
    if (preferred) return automatic(preferred);
    const fallback = differentCompany ?? candidates[0];
    if (!fallback) return automatic(null);
    const cli = available.find((item) => item.id === fallback.cli)!;
    return automatic(withAdvisor(seat, fallback, cli, catalogue));
  }

  for (const seat of FIXED_CREW) {
    const current = validatePreference(Object.hasOwn(preferences, seat.slot) ? preferences[seat.slot] : next[seat.slot]);
    const resolved = resolve(seat, current);
    next[seat.slot] = resolved;
  }
  return next;
}

export function requireAssignment(preference: Preference): Assignment {
  if (!preference.assignment) throw new Error("Choose a model in Settings before running this seat.");
  return validateAssignment(preference.assignment)!;
}
