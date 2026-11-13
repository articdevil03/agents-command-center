import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, workspaceFile } from "./pack18-harness.ts";
const { dataDir, modules: { config, prefs, bulk, service, state, runtimeFor, SettingsService, ChatStore, RequestsStore } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"), prefs: await import("../server/fixed-crew/preferences.ts"),
  bulk: await import("../server/fixed-crew/bulk-assignment.ts"), service: await import("../server/main/fixed-crew.ts"),
  state: await import("../server/main/state.ts"),
  runtimeFor: (await import("../server/main/tabs.ts")).runtimeFor,
  SettingsService: (await import("../server/settings.ts")).SettingsService,
  ChatStore: (await import("../server/chat-store.ts")).ChatStore, RequestsStore: (await import("../server/requests.ts")).RequestsStore,
}));
const cli = "codex", model = "gpt-6.1-sol";
const catalogue = { clis: [{ id: cli, installed: true, models: [model], efforts: ["low", "medium", "high"], advisor: false }] };

test("FCBM service saves once before memory, skips busy/leader, contains failures and repeat requests", () => {
  let workspace = config.defaultWorkspaces("scratch"), writes = 0, publishes = 0, announced = 0, fail = false, allBusy = false;
  const tab = () => workspace.projects[0].tabs[0];
  tab().fixedCrew!.roleExtras.coder = "keep extras";
  let disk = structuredClone(workspace);
  const svc = service.createFixedCrewService({
    workspace: () => workspace, selectedTabId: () => tab().id, catalogue: () => catalogue,
    seatBusy: (_, slot) => allBusy || slot === "coder", leaderActive: () => true,
    writeWorkspace(next) { writes++; assert.equal(publishes, announced); if (fail) throw new Error("disk failed"); disk = structuredClone(next); },
    setWorkspace(next) { assert.deepEqual(next, disk, "disk before publication"); publishes++; workspace = next; },
    announce() { announced++; },
  });
  const change = (id: unknown = tab().id, digest = bulk.assignmentsDigest(tab().fixedCrew!)) => svc.setModelForAll(id, cli, model, digest, true);
  assert.throws(() => change("other"), /Select this tab/);
  const old = structuredClone(workspace);
  fail = true; assert.throws(() => change(), /disk failed/);
  assert.deepEqual(workspace, old); assert.deepEqual(disk, old); assert.equal(publishes, 0); assert.equal(announced, 0);
  fail = false; writes = 0;
  const result = change();
  assert.equal(writes, 1); assert.equal(publishes, 1); assert.equal(announced, 1);
  assert.deepEqual(result.skipped.map((row) => row.slot), ["leader", "coder"]);
  assert.equal(result.changed.length, 16); assert.equal(tab().fixedCrew!.roleExtras.coder, "keep extras");
  assert.equal(tab().fixedCrew!.preferences.planner.source, "user", "service publishes assignment setter");
  assert.equal(change().changed.length, 0); assert.equal(writes, 1);
  allBusy = true; assert.match(change().notice, /All positions are busy/); assert.equal(writes, 1);
  assert.throws(() => change(tab().id, bulk.assignmentsDigest(old.projects[0].tabs[0].fixedCrew!)), /Crew choices changed/);
});

test("FCBM real server busy state skips pending, unconfirmed, working, active leader and saving tab", async () => {
  const work = config.defaultWorkspaces("scratch"), tab = work.projects[0].tabs[0], id = tab.id;
  state.setWorkspaces(work); state.setSelectedTabId(id);
  state.tabs.clear(); state.clients.clear(); state.runContexts.clear(); state.activeLeaderTurns.clear(); state.pendingApprovals.clear(); state.savingTabs.clear();
  state.setChatStore(new ChatStore(join(dataDir, "chats")));
  state.setRequestsStore(new RequestsStore(dataDir));
  state.setClientPrefs(config.readClientPrefs()); state.setAcpClis([]);
  state.setLaunchSafety(config.readLaunchSafety(join(dataDir, "absent-safety.json")));
  state.setFolderActivity({ watchFolders() {} } as any);
  state.setSettingsService(new SettingsService({ dataRoot: dataDir, runCli: async () => { assert.fail("no CLI probe permitted"); } }));
  state.settingsService.state.tools.codex.installed = true;
  const savedUncertain = state.launchSafety.uncertain;
  function dispatch() {
    return service.fixedCrewService.setModelForAll(id, cli, model,
      bulk.assignmentsDigest(state.workspaces.projects[0].tabs[0].fixedCrew!), true);
  }
  try {
    state.launchSafety.uncertain = [{ seatId: `${id}.helper` } as any];
    state.runContexts.set("pending", { tabId: id, slot: "coder", run: { runId: "not-started" } } as any);
    state.activeLeaderTurns.add(id);
    runtimeFor(tab).state.runs.push({ seatSlotId: "planner", status: "working" } as any);
    assert.deepEqual((await dispatch()).skipped.map((row: any) => row.slot), ["leader", "planner", "coder", "helper"]);
    const before = structuredClone(state.workspaces);
    state.savingTabs.set(id, 1);
    const saving = await dispatch(); assert.equal(saving.changed.length, 0); assert.equal(saving.skipped.length, 18);
    assert.deepEqual(state.workspaces, before);
    assert.equal(state.runContexts.size, 1, "no task execution added");
  } finally {
    state.launchSafety.uncertain = savedUncertain; state.runContexts.clear(); state.activeLeaderTurns.clear(); state.savingTabs.clear(); state.tabs.clear();
  }
});

test("FCBM real WebSocket validates envelope and selection, persists bulk choices and never executes tasks", { timeout: 45_000 }, async () => {
  const server = await boot({ tabs: (work) => {
    const tabs = config.defaultWorkspaces(work).projects[0].tabs;
    tabs[0].fixedCrew = prefs.setCrewAssignment(tabs[0].fixedCrew!, "coder", null);
    tabs[0].fixedCrew.roleExtras.coder = "  keep literal extras\n";
    return tabs;
  } });
  let connection: Awaited<ReturnType<typeof client>> | undefined;
  try {
    connection = await client(server);
    const c = connection, tabId = "example-development";
    const payload = () => ({ type: "setCrewModelForAll", tabId, cli, model,
      expectedAssignmentsDigest: c.tab(tabId).fixedCrew.assignmentsDigest, confirmReplace: true });
    const file = join(server.data, "config", "workspaces.json");
    const before = () => readFileSync(file, "utf8");
    assert.match(payload().expectedAssignmentsDigest, /^[a-f0-9]{64}$/);
    const original = before();
    const unavailable = await c.request(payload()); assert.equal(unavailable.ok, false); assert.match(unavailable.message!, /unavailable/);
    assert.equal((await c.request({ type: "refreshSettings" })).ok, true);
    for (const fields of [{ extra: true }, { busy: {} }, { model: "gpt-unknown" }, { expectedAssignmentsDigest: "stale" },
      { confirmReplace: false }, { confirmReplace: "yes" }, { tabId: "example-design" }]) {
      const bytes = before(), reply = await c.request({ ...payload(), ...fields });
      assert.equal(reply.ok, false, JSON.stringify(fields)); assert.equal(before(), bytes);
    }
    const missingId = await c.attempt(payload()); assert.match(missingId.error!, /requestId is required/);
    const from = c.messages.length;
    const request = { ...payload(), requestId: "bulk-repeat" };
    c.send(request);
    await c.wait(() => c.messages.slice(from).find((row) => row.requestId === request.requestId && ["actionResult", "error"].includes(row.type)), "bulk reply");
    const reply = c.messages.slice(from).find((row) => row.requestId === request.requestId);
    assert.equal(reply.type, "actionResult"); assert.ok(reply.changed.length > 0);
    const saved = workspaceFile(server).projects[0].tabs[0].fixedCrew;
    assert.deepEqual(saved.preferences.coder, { assignment: { cli, model, effort: "medium" }, source: "user" }, "real dispatcher must call bulk service");
    assert.equal(saved.roleExtras.coder, "  keep literal extras\n"); assert.equal(saved.assignmentsDigest, undefined);
    assert.notEqual(before(), original);
    const bytes = before();
    const repeated = await c.request(request); assert.equal(repeated.ok, false); assert.match(repeated.message!, /Crew choices changed/);
    assert.equal((await c.request(payload())).ok, true); assert.equal(before(), bytes, "fresh repeat is no-op");
    assert.equal(c.runEnds(), 0);
    for (const name of ["codex", "claude", "opencode"]) assert.equal(existsSync(join(server.work, `run-wrote-${name}.txt`)), false);
    for (const name of ["tasks", "executions"]) assert.equal(existsSync(join(server.data, name)) && readdirSync(join(server.data, name)).length > 0, false);
  } finally {
    connection?.close(); await server.stop();
    assert.ok(server.child.exitCode !== null || server.child.signalCode !== null, "owned server ended");
  }
});
