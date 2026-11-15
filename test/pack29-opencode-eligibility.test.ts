import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { noVendor } from "./opencode-models.setup.ts";

let bridges = 0;
(globalThis as any).__r1Bridge = () => { bridges++; throw new Error("injected bridge boundary"); };
const hooks = registerHooks({ load(url, context, next) {
  const result = next(url, context), source = String(result.source);
  if (url.endsWith("/server/main/leader-session.ts")) {
    const anchor = 'if (isFixedTab(location.tab)) requireFixedAssignment(tabId, "leader");';
    assert.equal(source.split(anchor).length, 2);
    // Independently exercise the resolved-leader gate, without the fixed-assignment gate masking it.
    return { ...result, source: source.replace(anchor, 'if (!(globalThis as any).__r1ResolvedOnly && isFixedTab(location.tab)) requireFixedAssignment(tabId, "leader");') };
  }
  if (url.endsWith("/server/main/crew-tools.ts")) {
    const anchor = /export function openBridge\([^\n]+\{/;
    assert.ok(anchor.test(source));
    return { ...result, source: source.replace(anchor, (match) => match + '\n(globalThis as any).__r1Bridge();') };
  }
  return result;
} });
const { api, setup } = await import("./pack29-first-run.setup.ts");
const crew = await import("../server/main/fixed-crew.ts");
const launch = await import("../server/main/fixed-task-launch.ts");
const leader = await import("../server/main/leader-session.ts");
const { assignmentsDigest } = await import("../server/fixed-crew/bulk-assignment.ts");
const { readJournalSnapshot } = await import("../server/fixed-crew/task-execution.ts");
hooks.deregister();
const pair = { cli: "opencode", model: "provider/model", effort: "" } as const;
function facts(installed: boolean | null, supportedVersion: boolean | null) {
  Object.assign(api.state.settingsService.state.tools.opencode, { installed, supportedVersion });
  Object.assign(api.state.settingsService.state.catalogTools.opencode, { installed, supportedVersion });
}

test("registered manual, Auto and bulk paths reject unavailable OpenCode; both catalogues retain raw Settings and saved assignments", async (t) => {
  noVendor(t); const ctx = setup(), state = api.state;
  (globalThis as any).__p29BeforeWrite = undefined;
  api.config.applyOpenCodeModels([{ value: pair.model, providerID: "provider", modelID: "model", displayName: "Model", variants: [] }], {});
  const tabId = state.selectedTabId;
  for (const [installed, supported, offered] of [[false, null, false], [null, null, false], [true, false, false], [true, null, true], [true, true, true]] as const) {
    facts(installed, supported);
    assert.equal(crew.fixedCatalogue().clis.find((c) => c.id === "opencode")!.installed, installed === null ? null : offered);
    const snapshot: any = api.broadcast.stateMessage();
    assert.equal(snapshot.clis.find((c: any) => c.id === "opencode").installed, installed === null ? null : offered);
    assert.equal(snapshot.settings.catalogTools.opencode.installed, installed);
    const socket = [...state.clients][0];
    const dispatch = async (type: string, extra: any) => {
      const requestId = `${type}-${installed}-${supported}`, at = ctx.replies.length;
      api.messages.handleMessage(socket, JSON.stringify({ type, requestId, tabId, ...extra }));
      await new Promise((done) => setImmediate(done));
      const result = ctx.replies.slice(at).find((r) => r.requestId === requestId && ["error", "actionResult"].includes(r.type));
      assert.ok(result, type + " registered response FOUND"); return result;
    };
    assert.equal((await dispatch("setCrewAssignment", { slot: "coder", assignment: pair })).type, offered ? "actionResult" : "error");
    const fixed = () => state.workspaces.projects[0].tabs[0].fixedCrew!;
    assert.equal((await dispatch("setCrewModelForAll", { cli: "opencode", model: pair.model, expectedAssignmentsDigest: assignmentsDigest(fixed()), confirmReplace: true })).type, offered ? "actionResult" : "error");
    if (!offered) {
      await dispatch("autoAssignCrew", {});
      assert.equal(Object.values(fixed().preferences).some((p) => p.assignment?.cli === "opencode"), false);
    }
  }
  const tab = state.workspaces.projects[0].tabs[0];
  tab.fixedCrew!.preferences.coder = { assignment: { ...pair }, source: "user" };
  const before = structuredClone(tab.fixedCrew!.preferences);
  facts(true, false); crew.fixedCrewService.refresh();
  crew.fixedCrewService.change(tabId, "setCrewRoleExtra", "helper", "unrelated");
  assert.deepEqual(state.workspaces.projects[0].tabs[0].fixedCrew!.preferences, before);
  assert.deepEqual(JSON.parse(readFileSync(api.config.workspacesPath, "utf8")).projects[0].tabs[0].fixedCrew.preferences, before);
  assert.deepEqual((api.broadcast.stateMessage() as any).projects[0].tabs[0].fixedCrew.preferences.coder.assignment, pair);
});

test("saved worker launch refuses known unsupported and known missing installations before reservation or start persistence; v1, unknown version and unchecked installation pass", (t) => {
  noVendor(t); setup(); const state = api.state, tab = state.workspaces.projects[0].tabs[0];
  state.setFixedTasks({ get: () => undefined } as any);
  tab.fixedCrew!.preferences.planner = { assignment: { ...pair }, source: "user" };
  const instance = {}; state.leaderInstances.set(tab.id, instance); state.leaders.set(tab.id, { isDead: () => false } as any);
  const actor = { tabId: tab.id, instance, sessionId: "session" };
  for (const [installed, supported, message] of [[true, false, /OpenCode 1 is needed/], [false, null, /Install the tool first/]] as const) {
    facts(installed, supported);
    const journal = readJournalSnapshot(state.dataRoot, tab.id);
    assert.throws(() => launch.selectFixedExecution(actor, "planning"), message);
    assert.throws(() => launch.reserveFixedExecution(actor, "planning"), message);
    assert.deepEqual(readJournalSnapshot(state.dataRoot, tab.id), journal, "refusal leaves reservation and execution-start persistence unchanged");
  }
  // Unknown version and unchecked installation do not block saved launches.
  for (const [installed, supported] of [[true, true], [true, null], [null, null]] as const) {
    facts(installed, supported);
    assert.deepEqual(launch.selectFixedExecution(actor, "planning").selection.assignment, pair);
  }
  state.leaders.clear(); state.leaderInstances.clear();
});

test("resolved leader checks supportedVersion before bridge and adapter, independently of the fixed-assignment gate; unknown version and unchecked installation pass", (t) => {
  noVendor(t); setup(); const state = api.state, tab = state.workspaces.projects[0].tabs[0];
  tab.fixedCrew!.preferences.leader = { assignment: { ...pair }, source: "user" };
  (globalThis as any).__r1ResolvedOnly = true;
  try {
    for (const [installed, supported, message] of [[true, false, /OpenCode 1 is needed/], [false, null, /Install the tool first/]] as const) {
      facts(installed, supported); bridges = 0;
      assert.throws(() => leader.createTabLeader(tab.id), message);
      assert.equal(bridges, 0); assert.equal(state.leaderInstances.has(tab.id), false);
    }
    for (const [installed, supported] of [[true, true], [true, null], [null, null]] as const) {
      facts(installed, supported); bridges = 0;
      assert.throws(() => leader.createTabLeader(tab.id), /injected bridge boundary/);
      assert.equal(bridges, 1, "supported v1, unknown version and unchecked installation reach the injected bridge only");
    }
  } finally { delete (globalThis as any).__r1ResolvedOnly; state.leaders.clear(); state.leaderInstances.clear(); }
});
