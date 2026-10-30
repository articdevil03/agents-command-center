import { cliCaps, isAcpCli, isSafeSeatId, isObj, type Seat, type SeatCli, type Setup, type Step, type RoundPair } from "./process-types.ts";

// ---- Roles: the role a seat has decides its steps (deriveSteps), its default write permission and the instruction every one of its runs starts with. ----
export interface RoleDef { name: string; canWrite: boolean; runsProcess: boolean; instruction: string }
const noWrite = "never edit, create or delete a file. Report each finding with its file and line.";
export const ROLES: readonly Readonly<RoleDef>[] = Object.freeze([
  { name: "Planner", canWrite: false, runsProcess: true, instruction: "Your role: Planner. You run the process for this tab: hand each step to the seat that owns it, wait for their runs, and move the steps on. You never write code yourself." },
  { name: "Coder", canWrite: true, runsProcess: false, instruction: "Your role: Coder. Build exactly what you are given: no more, no less. Do not change anything outside the task." },
  { name: "Design coder", canWrite: true, runsProcess: false, instruction: "Your role: Design coder. Build exactly the design work you are given: no more, no less. Do not change anything outside the task." },
  { name: "Fixer", canWrite: true, runsProcess: false, instruction: "Your role: Fixer. Fix exactly the findings you are given: no more, no less. Do not change anything outside the findings." },
  { name: "Reviewer", canWrite: false, runsProcess: false, instruction: `Your role: Reviewer. Review only: ${noWrite}` },
  { name: "Final reviewer", canWrite: false, runsProcess: false, instruction: `Your role: Final reviewer. Review the whole piece of work only: ${noWrite}` },
  { name: "Researcher", canWrite: false, runsProcess: false, instruction: "Your role: Researcher. Research what you are given, using the web where it helps. Do not edit project files. Your final message is your report: findings first, then sources." },
  { name: "Helper", canWrite: false, runsProcess: false, instruction: "" },
].map((role) => Object.freeze(role)));
export const LEADER_ROLE = "Leader";
// What the page gets (no instruction text): the table's order, Helper last.
export const rolesForPage = (): { name: string; canWrite: boolean; runsProcess: boolean }[] => ROLES.map(({ name, canWrite, runsProcess }) => ({ name, canWrite, runsProcess }));
const roleOf = (role: string): Readonly<RoleDef> | undefined => ROLES.find((item) => item.name === role.trim());
export const isKnownRole = (role: string): boolean => roleOf(role) !== undefined;

// The role's built-in instruction followed by a blank line and the prompt. A prompt that already starts with it (a relaunch) is left alone.
export function withRoleInstruction(role: string, prompt: string): string {
  const instruction = roleOf(role)?.instruction;
  return !instruction || prompt.startsWith(instruction) ? prompt : `${instruction}\n\n${prompt}`;
}

// ---- Steps are derived from the crew, never edited. ----
const AUTO_ROLES = new Set(["Planner", "Coder", "Design coder", "Reviewer", "Fixer", "Final reviewer"]);
export const MAX_SEATS = 16;
export const MAX_PAIRS = 8;
const work = (id: string, label: string, owners: string[]): Step => ({ id, label, type: "work", owners });

export function deriveSteps(crew: readonly Seat[], lookPause: boolean): Step[] {
  const lead = crew.find((seat) => seat.isLeader) ?? crew[0];
  const others = crew.filter((seat) => !seat.isLeader);
  const withRole = (...roles: string[]): string[] => others.filter((seat) => roles.includes(seat.role.trim())).map((seat) => seat.slot);
  if (!others.some((seat) => AUTO_ROLES.has(seat.role.trim()))) return [];
  const planner = withRole("Planner")[0] ?? lead.slot;
  const builders = withRole("Coder", "Design coder");
  const reviewers = withRole("Reviewer");
  const fixers = withRole("Fixer");
  const build = builders.length ? builders : [lead.slot];
  const fix = fixers.length ? fixers : build;
  const finals = withRole("Final reviewer");
  // A review with no seat of its own role goes to the leader, unless the leader wrote the code: nobody reviews their own work.
  const leaderWrote = build.includes(lead.slot) || fix.includes(lead.slot);
  const standIn = (otherReviewRole: string[]): string => leaderWrote ? withRole("Planner")[0] ?? otherReviewRole[0] ?? lead.slot : lead.slot;
  const review = reviewers.length ? reviewers : [standIn(finals)];
  const final = finals.length ? finals : [standIn(reviewers)];
  const pairs: RoundPair[] = Array.from({ length: Math.max(review.length, fix.length) }, (_, i) => ({ reviewer: review[i % review.length], fixers: [fix[i % fix.length]] }));
  return [
    work("plan", "Plan", [planner]), work("build", "Build", build), work("gate", "Gate", [planner]),
    ...(lookPause ? [{ id: "look", label: "Your look", type: "look", owners: ["user"] } as Step] : []),
    { id: "review", label: "Review", type: "rounds", pairs },
    work("final", "Final review", final),
    { id: "ship", label: "Ship", type: "finish", owners: [planner] },
  ];
}

// The slot of a seat that reviews (a round's reviewer or the Final review) and also writes (Build or a round's fixer); null when nobody does.
export function reviewsOwnWork(steps: readonly Step[]): string | null {
  const writers = new Set<string>();
  const readers = new Set<string>();
  for (const step of steps) {
    if (step.type === "rounds") for (const pair of step.pairs) { readers.add(pair.reviewer); pair.fixers.forEach((slot) => writers.add(slot)); }
    else if (step.type === "work" && (step.id === "build" || step.id === "final")) step.owners.forEach((slot) => (step.id === "build" ? writers : readers).add(slot));
  }
  return [...readers].find((slot) => writers.has(slot)) ?? null;
}

// ---- The one check for a crew: on read, on save and for templates. The steps are the crew's, derived here; any steps in the input are ignored. ----
const SLOT = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function validateSetup(value: unknown): Setup & { lookPause: boolean } {
  if (!isObj(value) || !Array.isArray(value.crew)) throw new Error("a setup needs a crew");
  if (value.crew.length < 1 || value.crew.length > MAX_SEATS) throw new Error(`a crew needs 1 to ${MAX_SEATS} seats`);
  if (value.lookPause !== undefined && typeof value.lookPause !== "boolean") throw new Error("lookPause must be true or false");
  const crew: Seat[] = [];
  const slots = new Set<string>();
  let leaders = 0, planners = 0, fakeLeader = "";
  for (const raw of value.crew) {
    if (!isObj(raw) || typeof raw.slot !== "string" || !SLOT.test(raw.slot) || raw.slot === "user" || !isSafeSeatId(`tab.${raw.slot}`)) throw new Error(`invalid seat id: ${isObj(raw) ? String(raw.slot) : "not an object"}`);
    const slot = raw.slot;
    if (slots.has(slot)) throw new Error(`duplicate seat id: ${slot}`);
    slots.add(slot);
    const caps = cliCaps(raw.cli);
    if (!caps) throw new Error(`seat ${slot}: unknown CLI`);
    if (!text(raw.name, 80)) throw new Error(`seat ${slot}: a name is required`);
    if (!text(raw.role, 60)) throw new Error(`seat ${slot}: a role is required`);
    // The shape of a model or effort (safe characters, length) is judged where it is loaded or saved (config.ts), against the CLI's own lists.
    if (typeof raw.model !== "string" || typeof raw.effort !== "string") throw new Error(`seat ${slot}: model and effort are required`);
    if (isAcpCli(raw.cli) && (raw.model !== "default" || raw.effort !== "default")) throw new Error(`seat ${slot}: a CLI added in Settings always runs its own default model and effort`);
    if (typeof raw.canWrite !== "boolean" || typeof raw.isLeader !== "boolean") throw new Error(`seat ${slot}: canWrite and isLeader must be true or false`);
    if (raw.advisor !== undefined && (typeof raw.advisor !== "string" || !raw.advisor || raw.advisor.length > 100)) throw new Error(`seat ${slot}: invalid advisor`);
    if (raw.advisor !== undefined && !caps.advisor) throw new Error(`seat ${slot}: ${caps.label} cannot have an advisor`);
    if (raw.orchestrates !== undefined && typeof raw.orchestrates !== "boolean") throw new Error(`seat ${slot}: orchestrates must be true or false`);
    if (raw.pic !== undefined && typeof raw.pic !== "string") throw new Error(`seat ${slot}: invalid pic`);
    const role = raw.role.trim();
    if (raw.isLeader) leaders++;
    if (role === LEADER_ROLE && !raw.isLeader) fakeLeader = slot;
    if (role === "Planner" && ++planners > 1) throw new Error("a crew has at most one Planner");
    if (raw.orchestrates === true) {
      if (role !== "Planner") throw new Error(`seat ${slot}: only a Planner can run the process`);
      if (!caps.crewTools) throw new Error(`seat ${slot}: ${caps.label} cannot reach the crew tools`);
      if (isAcpCli(raw.cli) && !raw.canWrite) throw new Error(`seat ${slot}: a seat on a CLI added in Settings that runs the process must be able to write (a read-only one refuses every permission request, its crew tools included)`);
    }
    crew.push({
      slot, name: raw.name.trim(), role, cli: raw.cli as SeatCli, model: raw.model, effort: raw.effort, canWrite: raw.canWrite, isLeader: raw.isLeader,
      ...(raw.advisor !== undefined ? { advisor: raw.advisor } : {}), ...(raw.orchestrates === true ? { orchestrates: true } : {}), ...(raw.pic !== undefined ? { pic: raw.pic } : {}),
    });
  }
  if (leaders !== 1) throw new Error("a crew needs exactly one leader");
  if (fakeLeader) throw new Error(`seat ${fakeLeader}: only the leader can have the role Leader`);
  const lookPause = value.lookPause === true;
  const steps = deriveSteps(crew, lookPause);
  const rounds = steps.find((step) => step.type === "rounds");
  if (rounds?.type === "rounds" && rounds.pairs.length > MAX_PAIRS) throw new Error(`a crew can have at most ${MAX_PAIRS} Reviewers and ${MAX_PAIRS} Fixers`);
  return { crew, lookPause, steps };
}
