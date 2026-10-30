import {
  adoptSavedValues, visibleTemplates, validateSetupValues, setupIdFromName, MAX_SAVED_SETUPS,
  isValidModel, isValidEffort, defaultEffort,
  type Workspaces, type WorkspaceProject, type WorkspaceTab, type CrewMember, type SavedSetup, type SetupTemplate,
} from "./config.ts";
import { validateSetup, reviewsOwnWork, switchProcess, cliCaps, defaultTemplateId, KINDS, type ProcessKind, type ProcessState, type Setup, type Step } from "./process.ts";

type Location = { project: WorkspaceProject; tab: WorkspaceTab };
type Checked = Setup & { lookPause: boolean };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// What the setup messages (useSetup, setSetup, saveSetup, removeSetup) need from the server: the live workspace, the engine per tab and the leader.
export interface CrewSetupDeps {
  tabLocation(tabId: string): Location | null;
  tabHasActiveWork(tabId: string): boolean;
  seatIsWorking(tabId: string, slot: string): boolean;
  seatIsBlocked(seatKey: string): boolean;
  stopLeaderSession: (tabId: string) => void;
  workspaces(): Workspaces;
  setWorkspaces(next: Workspaces): void;
  tabs: Map<string, { state: ProcessState; stalledRuns: Set<string> }>;
  updateRuntimeSeat(tabId: string, seat: CrewMember): void;
  savedSetups(): SavedSetup[];
  setSavedSetups(next: SavedSetup[]): void;
  isValidPic(pic: unknown): boolean;
  announce(): void;
  // The two writes are the caller's (the server passes the config module's; a test passes its own).
  writeWorkspaces(next: Workspaces): void;
  writeSetups(next: SavedSetup[]): void;
}

// The check for a crew a user is making (not for one read from a file, which must always load): refused when a seat would review its own work.
function checkNewCrew(value: unknown): Checked {
  const setup = validateSetup(value);
  const slot = reviewsOwnWork(setup.steps);
  if (slot !== null) {
    const name = setup.crew.find((seat) => seat.slot === slot)?.name ?? slot;
    throw new Error(`${name} would review its own work: add a Planner, Reviewer or Final reviewer, or a Coder to build`);
  }
  return setup;
}

export function createCrewSetup(deps: CrewSetupDeps) {
  const locate = (tabId: unknown): Location => {
    const location = deps.tabLocation(String(tabId));
    if (!location) throw new Error(`unknown tab: ${String(tabId)}`);
    return location;
  };

  // Switching to another setup: a seat with the same id keeps its name, picture, CLI, model and effort (a CLI it was moved to keeps its model, as the model alone always was).
  function carrySeats(old: CrewMember[], fresh: CrewMember[]): CrewMember[] {
    const oldBySlot = new Map(old.map((seat) => [seat.slot, seat]));
    return fresh.map((seat) => {
      const was = oldBySlot.get(seat.slot);
      if (!was) return seat;
      const cli = isValidModel(was.cli, was.model) ? was.cli : seat.cli;
      const next: CrewMember = { ...seat, cli, name: was.name, ...(was.pic ? { pic: was.pic } : {}) };
      if (cli === was.cli) next.model = was.model;
      if (isValidEffort(cli, was.effort)) next.effort = was.effort;
      else if (cli !== seat.cli) next.effort = defaultEffort(cli);
      if (next.advisor && !cliCaps(cli)?.advisor) delete next.advisor;
      return next;
    });
  }

  // Puts a checked crew on the tab (its steps are the crew's): saved first, then the engine either follows in place (same steps and seats) or starts again from step one.
  function commitSetup(location: Location, setup: Checked, meta: { kind?: ProcessKind; setupName?: string }, restart: boolean): void {
    const draft = clone(deps.workspaces());
    const tab = draft.projects.find((project) => project.id === location.project.id)!.tabs.find((item) => item.id === location.tab.id)!;
    if (meta.kind) tab.kind = meta.kind;
    if (meta.setupName) tab.setupName = meta.setupName;
    tab.crew = setup.crew; tab.lookPause = setup.lookPause; tab.steps = setup.steps;
    deps.writeWorkspaces(draft);
    deps.setWorkspaces(draft);
    const runtime = deps.tabs.get(tab.id)!;
    if (restart) { runtime.state = switchProcess(runtime.state, setup); runtime.stalledRuns.clear(); }
    else for (const seat of setup.crew) deps.updateRuntimeSeat(tab.id, seat);
    deps.announce();
  }

  // A seat taken out of the crew must have nothing left running, blocked or unconfirmed.
  function refuseRemovingBusySeats(tabId: string, tab: WorkspaceTab, kept: CrewMember[]): void {
    for (const old of tab.crew) {
      if (kept.some((seat) => seat.slot === old.slot)) continue;
      if (deps.seatIsBlocked(`${tabId}.${old.slot}`) || deps.seatIsWorking(tabId, old.slot)) {
        throw new Error(`${old.name} cannot be taken out yet: it is blocked after a stop, has a process that was not confirmed closed, or is still working.`);
      }
    }
  }

  // The template a new project or tab starts on: the one named, else the default for its kind (Our process for Development).
  function pickTemplate(message: any): SetupTemplate {
    if (message.kind !== undefined && (typeof message.kind !== "string" || !Object.hasOwn(KINDS, message.kind))) throw new Error(`unknown kind: ${String(message.kind)}`);
    const id = message.template ?? defaultTemplateId((message.kind ?? "dev") as ProcessKind);
    const found = visibleTemplates().find((template) => template.id === id);
    if (!found) throw new Error(`unknown template: ${String(id)}`);
    return found;
  }
  // A new tab: its steps are the ones its template's roles derive.
  const newTab = (id: string, name: string, kind: ProcessKind, folder: string, template: SetupTemplate): WorkspaceTab =>
    ({ id, name, kind, folder, setupName: template.name, crew: template.crew, lookPause: template.lookPause, steps: template.steps });

  function useSetup(message: any): void {
    const location = locate(message.tabId);
    if (deps.tabHasActiveWork(message.tabId)) throw new Error("cannot change process while the tab is busy");
    if ((message.templateId === undefined) === (message.setupId === undefined)) throw new Error("name exactly one of templateId or setupId");
    const source: { name: string; kind: ProcessKind; crew: CrewMember[]; lookPause: boolean } | undefined = message.templateId !== undefined
      ? visibleTemplates().find((template) => template.id === message.templateId)
      : deps.savedSetups().map((setup) => clone(setup)).find((setup) => setup.id === message.setupId);
    if (!source) throw new Error(`unknown ${message.templateId !== undefined ? "template" : "saved setup"}: ${String(message.templateId ?? message.setupId)}`);
    const setup = checkNewCrew({ crew: carrySeats(location.tab.crew, source.crew), lookPause: source.lookPause });
    validateSetupValues(setup, true);
    refuseRemovingBusySeats(message.tabId, location.tab, setup.crew);
    // The live leader was started with the old setup's settings and tools: bank and stop it, and the next chat starts one from the new crew.
    deps.stopLeaderSession(message.tabId);
    // Start blank has no kind of its own: a Design or Marketing tab that starts again from nothing stays what it is.
    const kind = message.templateId === "blank" ? location.tab.kind : source.kind;
    commitSetup(location, setup, { kind, setupName: source.name }, true);
  }

  // The editor's Save: the whole crew and the look switch are replaced, after the same check a template passes. Any steps sent with it are ignored: they are derived.
  function setSetup(message: any): void {
    const location = locate(message.tabId);
    if (deps.tabHasActiveWork(message.tabId)) throw new Error("cannot change the crew while the tab is busy");
    if (typeof message.lookPause !== "boolean") throw new Error("lookPause must be true or false");
    const setup = validateSetup({ crew: message.crew, lookPause: message.lookPause });
    const sameSteps = JSON.stringify(setup.steps) === JSON.stringify(location.tab.steps);
    if (!sameSteps) checkNewCrew(setup);
    // A picture the seat did not have must be a real preset or upload.
    setup.crew = setup.crew.map((seat) => {
      const before = location.tab.crew.find((item) => item.slot === seat.slot);
      if (seat.pic === undefined || seat.pic === before?.pic || deps.isValidPic(seat.pic)) return seat;
      throw new Error("invalid seat pic");
    });
    validateSetupValues(setup, true);
    refuseRemovingBusySeats(message.tabId, location.tab, setup.crew);
    const sameSeats = setup.crew.length === location.tab.crew.length && setup.crew.every((seat) => location.tab.crew.some((item) => item.slot === seat.slot));
    const bare = (crew: CrewMember[]) => JSON.stringify(crew.map(({ name: _name, pic: _pic, ...rest }) => rest));
    // A change to anything but names and pictures changes what the leader was started with.
    if (!sameSteps || !sameSeats || bare(setup.crew) !== bare(location.tab.crew)) deps.stopLeaderSession(message.tabId);
    const setupName = typeof message.setupName === "string" ? message.setupName.trim().slice(0, 80) : "";
    commitSetup(location, setup, { setupName }, !(sameSteps && sameSeats));
  }

  function saveSetup(message: any): void {
    const location = locate(message.tabId);
    checkNewCrew({ crew: location.tab.crew, lookPause: location.tab.lookPause });
    const name = typeof message.name === "string" ? message.name.trim() : "";
    if (!name || name.length > 60) throw new Error("a setup name of 1 to 60 characters is required");
    const id = setupIdFromName(name);
    if (!id) throw new Error("the setup name needs at least one letter or digit");
    // A picture belongs to the tab's seat (uploads are pruned by what seats use), so a saved setup keeps none.
    const entry: SavedSetup = { id, name, kind: location.tab.kind, crew: clone(location.tab.crew).map(({ pic: _pic, ...rest }) => rest), lookPause: location.tab.lookPause, steps: clone(location.tab.steps) };
    const saved = deps.savedSetups();
    const exists = saved.some((item) => item.id === id);
    if (!exists && saved.length >= MAX_SAVED_SETUPS) throw new Error(`at most ${MAX_SAVED_SETUPS} saved setups`);
    const next = exists ? saved.map((item) => item.id === id ? entry : item) : [...saved, entry];
    deps.writeSetups(next);
    deps.setSavedSetups(next); adoptSavedValues(deps.workspaces(), next);
    deps.announce();
  }

  function removeSetup(message: any): void {
    const saved = deps.savedSetups();
    if (!saved.some((item) => item.id === message.setupId)) throw new Error(`unknown saved setup: ${String(message.setupId)}`);
    const remaining = saved.filter((item) => item.id !== message.setupId);
    deps.writeSetups(remaining);
    deps.setSavedSetups(remaining); adoptSavedValues(deps.workspaces(), remaining);
    deps.announce();
  }

  // A seat's role or "runs the process" changed: the crew's steps follow. Returns the steps to save, and whether they differ from the tab's.
  function stepsAfterSeatChange(tabId: string, tab: WorkspaceTab, crew: CrewMember[]): { steps: Step[]; changed: boolean } {
    const steps = validateSetup({ crew, lookPause: tab.lookPause }).steps;
    const changed = JSON.stringify(steps) !== JSON.stringify(tab.steps);
    if (changed) checkNewCrew({ crew, lookPause: tab.lookPause });
    if (changed && deps.tabHasActiveWork(tabId)) throw new Error("cannot change the roles while the tab is busy");
    return { steps, changed };
  }
  // After the changed steps are saved: the leader was started with the old ones, and the engine starts again from step one on the new steps.
  function restartOnNewSteps(tabId: string, tab: WorkspaceTab): void {
    deps.stopLeaderSession(tabId);
    const runtime = deps.tabs.get(tabId)!;
    runtime.state = switchProcess(runtime.state, { crew: tab.crew, steps: tab.steps });
    runtime.stalledRuns.clear();
  }

  return { useSetup, setSetup, saveSetup, removeSetup, pickTemplate, newTab, stepsAfterSeatChange, restartOnNewSteps };
}
