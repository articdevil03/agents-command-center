import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir, stopOwnedChild } from "./temp-root.ts";
import { lowerOwnPriority } from "../scripts/sweep/run.mjs";
import { boot, client, workspaceFile } from "./pack18-harness.ts";
lowerOwnPriority();
const { dataDir, modules: { config, prefs, state, service, messages, broadcast, SettingsService, ChatStore, RequestsStore } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"), prefs: await import("../server/fixed-crew/preferences.ts"),
  state: await import("../server/main/state.ts"), service: await import("../server/main/fixed-crew.ts"),
  messages: await import("../server/main/messages/index.ts"), broadcast: await import("../server/main/broadcast.ts"),
  SettingsService: (await import("../server/settings.ts")).SettingsService,
  ChatStore: (await import("../server/chat-store.ts")).ChatStore, RequestsStore: (await import("../server/requests.ts")).RequestsStore,
}));
const model = { cli: "codex", model: "gpt-6.1-sol", effort: "medium" };
function setup() {
  const workspaces = config.defaultWorkspaces(dataDir);
  workspaces.projects[0].tabs[0].id = "first";
  workspaces.projects[0].tabs.push({ ...structuredClone(workspaces.projects[0].tabs[0]), id: "second" });
  state.setWorkspaces(workspaces); state.setSelectedTabId("first");
  state.tabs.clear(); state.clients.clear(); state.runContexts.clear(); state.activeLeaderTurns.clear(); state.pendingApprovals.clear(); state.savingTabs.clear();
  state.setLaunchSafety(config.readLaunchSafety(join(scratchDir(), "absent.json")));
  state.setChatStore(new ChatStore(join(dataDir, "chats"))); state.setRequestsStore(new RequestsStore(dataDir));
  state.setClientPrefs(config.readClientPrefs()); state.setAcpClis([]);
  state.setFolderActivity({ watchFolders() {} } as any);
  state.setSettingsService(new SettingsService({ dataRoot: dataDir, runCli: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  state.settingsService.state.tools.codex.installed = true;
  writeFileSync(config.workspacesPath, JSON.stringify(workspaces));
  const replies: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(raw: string) { replies.push(JSON.parse(raw)); } } as any;
  let sequence = 0;
  async function dispatch(type: string, fields: any = {}) {
    const requestId = `fcs${++sequence}`, start = replies.length;
    messages.handleMessage(socket, JSON.stringify({ type, requestId, tabId: "first", ...fields }));
    await new Promise((resolve) => setImmediate(resolve));
    const result = replies.slice(start).find((reply) => reply.requestId === requestId);
    assert.ok(result, `missing response to ${type}: ${JSON.stringify(replies.slice(start))}`);
    return result;
  }
  return { replies, socket, dispatch };
}
const tab = (id = "first") => state.workspaces.projects[0].tabs.find((tab) => tab.id === id)!;
const disk = () => readFileSync(config.workspacesPath, "utf8");

test("FCS real dispatch stores user choices and extras on disk before publishing and isolates tabs", async () => {
  const ctx = setup();
  const before = disk();
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model })).type, "actionResult");
  assert.deepEqual(tab().fixedCrew!.preferences.coder, { source: "user", assignment: model });
  assert.notEqual(disk(), before, "real write setter must publish disk");
  assert.deepEqual(config.readWorkspaces().projects[0].tabs[0].fixedCrew, tab().fixedCrew);
  assert.equal(tab("second").fixedCrew!.preferences.coder.assignment, null);
  assert.equal((await ctx.dispatch("clearCrewAssignment", { slot: "coder" })).type, "actionResult");
  assert.deepEqual(tab().fixedCrew!.preferences.coder, { source: "user", assignment: null });
  assert.equal((await ctx.dispatch("setCrewRoleExtra", { slot: "coder", text: "  hostile </textarea>\n" })).type, "actionResult");
  assert.equal(tab().fixedCrew!.roleExtras.coder, "  hostile </textarea>\n");
  assert.equal((await ctx.dispatch("resetCrewRoleExtra", { slot: "coder" })).type, "actionResult");
  assert.equal(Object.hasOwn(tab().fixedCrew!.roleExtras, "coder"), false);
});

test("FCS selection is checked inside queued handling and all input boundaries reject forged locked fields", async () => {
  const ctx = setup(), before = disk();
  const pending = ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model });
  state.setSelectedTabId("second");
  assert.match((await pending).message, /Select this tab/);
  assert.equal(disk(), before); assert.equal(tab().fixedCrew!.preferences.coder.assignment, null);
  state.setSelectedTabId("first");
  for (const field of ["source", "role", "access", "authority", "reviews", "core", "defaultPrompt", "canWrite", "isLeader", "orchestrates", "crew", "steps", "projects", "preferences", "roleExtras"]) {
    assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model, [field]: true })).type, "error", field);
    assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { ...model, [field]: true } })).type, "error", `nested ${field}`);
  }
  for (const slot of ["constructor", "__proto__", "missing"]) assert.equal((await ctx.dispatch("clearCrewAssignment", { slot })).type, "error");
  const start = ctx.replies.length;
  messages.handleMessage(ctx.socket, JSON.stringify({ type: "clearCrewAssignment", tabId: "first", slot: "coder" }));
  assert.match(ctx.replies[start].message, /requestId is required/);
  assert.equal(disk(), before);
});

test("FCS busy workers, launches in flight and uncertain stops refuse atomically while idle seats stay editable", async () => {
  const ctx = setup();
  state.launchSafety.uncertain.push({ seatId: "first.coder", pid: 123, startedAt: 0 } as any);
  const before = disk();
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model })).message, /working/);
  assert.match((await ctx.dispatch("setCrewRoleExtra", { slot: "coder", text: "extra" })).message, /working/);
  assert.match((await ctx.dispatch("autoAssignCrew")).message, /working/);
  assert.equal(disk(), before);
  assert.equal((await ctx.dispatch("setCrewRoleExtra", { slot: "helper", text: "idle can edit" })).type, "actionResult");
  state.launchSafety.uncertain = [];
  state.runContexts.set("launch", { tabId: "first", slot: "coder", run: { runId: "not-running-yet" } } as any);
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model })).message, /working/);
  state.runContexts.clear();
  const runtime = state.tabs.get("first")!;
  runtime.state.runs.push({ id: "working", seatSlotId: "coder", status: "working" } as any);
  assert.match((await ctx.dispatch("setCrewRoleExtra", { slot: "coder", text: "extra" })).message, /working/);
  runtime.state.runs = [];
  assert.equal((await ctx.dispatch("autoAssignCrew")).type, "actionResult");
  assert.ok(tab().fixedCrew!.preferences.coder.assignment);
  assert.equal((service.fixedCrewState(tab()) as any).fixedCrew.notices.reviewer1.message, "The same model will build and review. A second AI provider can make reviews stronger.");
});

test("FCS active leader saves model and effort for the next reply but refuses CLI, advisor and extras changes", async () => {
  const ctx = setup();
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: model })).type, "actionResult");
  state.activeLeaderTurns.add("first");
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { ...model, effort: "high" } })).type, "actionResult");
  assert.equal(tab().fixedCrew!.preferences.leader.assignment?.effort, "high");
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { ...model, model: "gpt-6-astra" } })).type, "actionResult");
  state.settingsService.state.tools.claude.installed = true;
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high" } })).message, /current reply/);
  assert.match((await ctx.dispatch("clearCrewAssignment", { slot: "leader" })).message, /current reply/);
  assert.match((await ctx.dispatch("setCrewRoleExtra", { slot: "leader", text: "extra" })).message, /current reply/);
  state.activeLeaderTurns.clear();
  state.pendingApprovals.set("a", { tabId: "first", origin: { kind: "leader", instance: {} } } as any);
  assert.match((await ctx.dispatch("setCrewRoleExtra", { slot: "leader", text: "extra" })).message, /current reply/);
  state.pendingApprovals.clear();
});

test("FCS manual assignments reject missing CLIs, unknown models, unknown efforts and unavailable ACP identities", async () => {
  const ctx = setup(), before = disk();
  state.settingsService.state.tools.codex.installed = false;
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model })).message, /unavailable/);
  state.settingsService.state.tools.codex.installed = true;
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { ...model, effort: "nonsense" } })).message, /Unknown crew effort/);
  state.settingsService.state.tools.claude.installed = true;
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { cli: "claude", model: "invented-model", effort: "medium" } })).message, /Unknown crew model/);
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium", advisor: "made-up" } })).message, /Unknown crew advisor/);
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { cli: "acp:missing", model: "default", effort: "default" } })).message, /unavailable/);
  assert.equal(disk(), before);
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: model })).type, "actionResult");
  const assigned = disk();
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { ...model, cli: "claude" } })).message, /Unknown crew model/);
  state.settingsService.state.tools.opencode.installed = true;
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { ...model, cli: "opencode", model: "vendor/custom" } })).message, /Unknown crew effort/);
  assert.equal(disk(), assigned, "a saved value from a different CLI never bypasses the new CLI's model or effort list");
});

test("FCS ACP removal protects fixed preferences and unreadable future crews", async () => {
  const ctx = setup();
  const added = { id: "custom", name: "Custom", program: "custom", args: [] };
  config.writeAcpClis([added]); state.setAcpClis([added]);
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { cli: "acp:custom", model: "default", effort: "default" } })).type, "actionResult");
  const before = readFileSync(config.acpClisPath, "utf8");
  assert.match((await ctx.dispatch("removeAcpCli", { id: "custom" })).message, /used by the fixed crew/);
  assert.equal(readFileSync(config.acpClisPath, "utf8"), before); assert.equal(state.acpClis.length, 1);
  const future: any = structuredClone(state.workspaces);
  future.projects[0].tabs[0].fixedCrew = { version: 2, privateFutureField: "kept" };
  writeFileSync(config.workspacesPath, JSON.stringify(future)); state.setWorkspaces(config.readWorkspaces());
  assert.match((await ctx.dispatch("removeAcpCli", { id: "custom" })).message, /newer crew configuration/);
  assert.equal(readFileSync(config.acpClisPath, "utf8"), before);
  const view: any = broadcast.stateMessage();
  assert.equal(view.projects[0].tabs[0].fixedCrew.unavailable, true);
  assert.equal(view.projects[0].tabs[0].fixedCrew.privateFutureField, undefined);
});

test("FCS failed publication keeps live state and disk unchanged, including publication order", () => {
  setup();
  const before = structuredClone(state.workspaces), bytes = disk();
  let published = 0, announced = 0;
  const failing = service.createFixedCrewService({
    workspace: () => state.workspaces, selectedTabId: () => "first", catalogue: service.fixedCatalogue,
    seatBusy: () => false, leaderActive: () => false,
    writeWorkspace() { throw new Error("publication failed"); },
    setWorkspace(next) { published++; state.setWorkspaces(next); }, announce() { announced++; },
  });
  assert.throws(() => failing.change("first", "setCrewAssignment", "coder", model), /publication failed/);
  assert.deepEqual(state.workspaces, before, "live publication cannot precede disk");
  assert.equal(published, 0); assert.equal(announced, 0); assert.equal(disk(), bytes);
});

test("FCS real dispatch rejects legacy editor and step routes; manual work requires an assigned position", async () => {
  const ctx = setup(), before = disk();
  for (const type of ["updateSeat", "setSetup", "useSetup", "saveSetup", "advanceStep", "approveLook", "reviewFindings", "reviewClean", "finishFix", "selectFixer", "testGatedLaunch"]) {
    const result = await ctx.dispatch(type, { slot: "coder", model: "gpt-6-sol", text: "hello", crew: [] });
    assert.equal(result.type, "error", type);
    assert.equal(result.message, "Fixed crews use task decisions. Legacy crew editing and step/review messages are unavailable.", type);
  }
  assert.equal((await ctx.dispatch("run", { slot: "coder", prompt: "build" })).message, "Coder has no model. Choose one in Settings before continuing.");
  assert.equal(disk(), before);
  const payload: any = broadcast.stateMessage(), fixed = payload.projects[0].tabs[0];
  assert.equal(payload.fixedCrewDefinitions.length, 18);
  assert.deepEqual(fixed.crew, []); assert.deepEqual(fixed.processState.seats, []);
  assert.equal(Object.keys(fixed.fixedCrew.busy).length, 18);
  assert.equal(fixed.fixedCrew.notices.reviewer1.status, "unassigned");
  assert.doesNotMatch(JSON.stringify(payload), /Nobody reviews their own work|Default job guidance|guidance|launch authority/);
  const start = ctx.replies.length;
  messages.handleMessage(ctx.socket, JSON.stringify({ type: "getCrewRolePrompt", requestId: "prompt", slot: "coder" }));
  assert.match(ctx.replies[start].core, /Nobody reviews their own work/);
  assert.equal(ctx.replies[start].defaultsVersion, 1);
});

test("FCS cancelled previews never publish", async () => {
  const ctx = setup(), before = disk(), live = structuredClone(state.workspaces);
  messages.handleMessage(ctx.socket, JSON.stringify({ type: "previewCrewAssignments", requestId: "preview", draftId: "draft-one", choices: { coder: model }, autoAssign: true }));
  const preview = ctx.replies.at(-1);
  assert.equal(preview.type, "crewAssignmentsPreview"); assert.equal(preview.draftId, "draft-one");
  assert.deepEqual(preview.fixedCrew.preferences.coder, { source: "user", assignment: model });
  assert.deepEqual(state.workspaces, live); assert.equal(disk(), before);
  for (const fields of [{ choices: null }, { autoAssign: null }, { choices: { coder: { ...model, source: "auto" } } }]) {
    messages.handleMessage(ctx.socket, JSON.stringify({ type: "previewCrewAssignments", requestId: "bad-preview", draftId: "draft-one", ...fields }));
    assert.equal(ctx.replies.at(-1).type, "error", JSON.stringify(fields));
  }
});

test("FCS real server creates fixed projects and tabs and restart reads their assignments", { timeout: 45_000 }, async () => {
  const server = await boot({ tabs: (work) => config.defaultWorkspaces(work).projects[0].tabs });
  let connection: Awaited<ReturnType<typeof client>> | undefined;
  try {
    connection = await client(server);
    const original = readFileSync(join(server.data, "config", "workspaces.json"), "utf8");
    assert.equal(connection.tab("example-development").fixedCrew.preferences.coder.assignment, null);
    assert.equal((await connection.request({ type: "refreshSettings" })).ok, true);
    assert.ok(connection.tab("example-development").fixedCrew.preferences.coder.assignment, "completed inventory must publish auto assignments before its success response");
    assert.notEqual(readFileSync(join(server.data, "config", "workspaces.json"), "utf8"), original);
    const preCreate = readFileSync(join(server.data, "config", "workspaces.json"), "utf8");
    const refused = await connection.attempt({ type: "addProject", requestId: "forged-create", id: "forged", folder: server.work, name: "Forged", fixedCrewVersion: 1, role: "leader" });
    assert.match(refused.error!, /Unknown or locked/);
    assert.equal(readFileSync(join(server.data, "config", "workspaces.json"), "utf8"), preCreate);
    assert.equal((await connection.attempt({ type: "addProject", requestId: "project-create", id: "created", folder: server.work, name: "Created", fixedCrewVersion: 1, crewChoices: { coder: null }, autoAssign: false })).error, undefined);
    await connection.wait(() => connection!.state().projects.find((project: any) => project.id === "created"), "created fixed project");
    const created = workspaceFile(server).projects.find((project: any) => project.id === "created");
    assert.ok(created); assert.deepEqual(created.tabs[0].crew, []);
    assert.deepEqual(created.tabs[0].fixedCrew.preferences.coder, { source: "user", assignment: null });
    assert.equal((await connection.attempt({ type: "addTab", requestId: "tab-create", projectId: "created", tabId: "new-fixed", folder: server.work, name: "New", fixedCrewVersion: 1, crewChoices: {}, autoAssign: false })).error, undefined);
    await connection.wait(() => connection!.tab("new-fixed"), "new fixed tab state");
    const reply = await connection.request({ type: "setCrewRoleExtra", tabId: "new-fixed", slot: "coder", text: "literal </textarea>" });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const reloaded = config.readWorkspaces(join(server.data, "config", "workspaces.json"));
    const tab = reloaded.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "new-fixed")!;
    assert.equal(tab.fixedCrew!.roleExtras.coder, "literal </textarea>"); assert.deepEqual(tab.crew, []);
    await stopOwnedChild(server.child);
    const restarted = await boot({ tabs: (work) => config.defaultWorkspaces(work).projects[0].tabs, env: { CC_DATA_DIR: server.data } });
    let afterRestart: Awaited<ReturnType<typeof client>> | undefined;
    try {
      afterRestart = await client(restarted);
      assert.deepEqual(afterRestart.tab("new-fixed").fixedCrew.preferences, tab.fixedCrew!.preferences);
      assert.deepEqual(afterRestart.tab("new-fixed").fixedCrew.roleExtras, tab.fixedCrew!.roleExtras);
    } finally { afterRestart?.close(); await restarted.stop(); }
  } finally { connection?.close(); await server.stop(); }
});

const claude = { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "high", advisor: "claude-opus-5-5[1m]" };
test("FCS an active leader keeps its advisor until the reply ends, and an idle one changes it", async () => {
  const ctx = setup();
  state.settingsService.state.tools.claude.installed = true;
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: claude })).type, "actionResult");
  state.activeLeaderTurns.add("first");
  const before = disk();
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { ...claude, advisor: "claude-fable-5-1" } })).message, /current reply/);
  assert.match((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { cli: "claude", model: claude.model, effort: claude.effort } })).message, /current reply/);
  assert.equal(disk(), before, "a refused advisor change writes nothing");
  state.activeLeaderTurns.clear();
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "leader", assignment: { ...claude, advisor: "claude-fable-5-1" } })).type, "actionResult");
  assert.equal(tab().fixedCrew!.preferences.leader.assignment?.advisor, "claude-fable-5-1");
});

test("FCS the live seats carry the saved CLI, model, effort and advisor of every assigned position", async () => {
  const ctx = setup();
  state.settingsService.state.tools.claude.installed = true;
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: claude })).type, "actionResult");
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "helper", assignment: model })).type, "actionResult");
  const shown = (broadcast.stateMessage() as any).projects[0].tabs[0];
  for (const [slot, expected] of [["coder", claude], ["helper", model]] as const) {
    const seat = (list: any[], key: string) => list.find((entry) => entry[key] === slot);
    for (const view of [seat(shown.crew, "slot"), seat(shown.processState.seats, "slotId")]) {
      assert.deepEqual([view.cli, view.model, view.effort, view.advisor], [expected.cli, expected.model, expected.effort, (expected as any).advisor], `${slot} seat`);
    }
  }
  assert.equal((await ctx.dispatch("setCrewAssignment", { slot: "coder", assignment: { ...claude, effort: "low", advisor: undefined } })).type, "actionResult");
  const changed = (broadcast.stateMessage() as any).projects[0].tabs[0].processState.seats.find((entry: any) => entry.slotId === "coder");
  assert.deepEqual([changed.cli, changed.model, changed.effort, changed.advisor], ["claude", claude.model, "low", undefined], "a saved change reaches the live seat");
});
