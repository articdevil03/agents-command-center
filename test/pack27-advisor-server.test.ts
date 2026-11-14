import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

const { dataDir, modules: { config, state, service, messages, runtime, digest, SettingsService, ChatStore, RequestsStore } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"), state: await import("../server/main/state.ts"),
  service: await import("../server/main/fixed-crew.ts"), messages: await import("../server/main/messages/index.ts"),
  runtime: await import("../server/fixed-crew/runtime.ts"), digest: await import("../server/fixed-crew/bulk-assignment.ts"),
  SettingsService: (await import("../server/settings.ts")).SettingsService,
  ChatStore: (await import("../server/chat-store.ts")).ChatStore,
  RequestsStore: (await import("../server/requests.ts")).RequestsStore,
}));
const main = { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" };
const advisors = config.CLAUDE_MODEL_INFO.map((model) => model.value);
assert.ok(advisors.length >= 2, "two real catalogue advisors FOUND");
const tab = (id = "first") => state.workspaces.projects[0].tabs.find((tab) => tab.id === id)!;
const disk = () => readFileSync(config.workspacesPath, "utf8");

function setup() {
  const workspace = config.defaultWorkspaces(dataDir);
  workspace.projects[0].tabs[0].id = "first";
  workspace.projects[0].tabs.push({ ...structuredClone(workspace.projects[0].tabs[0]), id: "second" });
  state.setWorkspaces(workspace); state.setSelectedTabId("first");
  state.tabs.clear(); state.clients.clear(); state.runContexts.clear(); state.activeLeaderTurns.clear();
  state.pendingApprovals.clear(); state.savingTabs.clear();
  state.setLaunchSafety(config.readLaunchSafety(join(scratchDir(), "absent.json")));
  state.setChatStore(new ChatStore(join(dataDir, "chats"))); state.setRequestsStore(new RequestsStore(dataDir));
  state.setClientPrefs(config.readClientPrefs()); state.setAcpClis([]);
  state.setFolderActivity({ watchFolders() {} } as any);
  state.setSettingsService(new SettingsService({ dataRoot: dataDir, runCli: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  state.settingsService.state.tools.claude.installed = true;
  state.settingsService.state.tools.codex.installed = true;
  writeFileSync(config.workspacesPath, JSON.stringify(workspace));
  const replies: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(raw: string) { replies.push(JSON.parse(raw)); } } as any;
  let sequence = 0;
  const dispatch = async (type: string, fields: any = {}) => {
    const requestId = `p27-${++sequence}`, start = replies.length;
    messages.handleMessage(socket, JSON.stringify({ type, requestId, tabId: "first", ...fields }));
    await new Promise((resolve) => setImmediate(resolve));
    const result = replies.slice(start).find((reply) => reply.requestId === requestId);
    assert.ok(result, `response FOUND for ${type}: ${JSON.stringify(replies.slice(start))}`);
    return result;
  };
  const save = (assignment: any, slot = "leader") => dispatch("setCrewAssignment", { slot, assignment });
  return { dispatch, save };
}

test("P27 saves advisor and Off through the message route", async () => {
  const ctx = setup(), other = structuredClone(tab("second"));
  for (const advisor of [advisors[0], advisors[1], undefined]) {
    const assignment = { ...main, ...(advisor ? { advisor } : {}) };
    assert.equal((await ctx.save(assignment)).type, "actionResult");
    assert.deepEqual(tab().fixedCrew!.preferences.leader, { source: "user", assignment });
    assert.deepEqual(config.readWorkspaces().projects[0].tabs[0].fixedCrew, tab().fixedCrew, "disk reload equals live preferences");
    const projected = runtime.fixedMembers(tab()).find((seat) => seat.slot === "leader");
    assert.ok(projected, "runtime Leader FOUND");
    assert.equal(projected.advisor, advisor);
    const seat = runtime.fixedState(tab()).seats.find((seat) => seat.slotId === "leader");
    assert.ok(seat, "process-state Leader FOUND");
    assert.equal(seat.advisor, advisor, "process-core retains the saved advisor");
    assert.equal(Object.hasOwn(seat, "advisor"), Boolean(advisor), "Off has no runtime advisor field");
    assert.deepEqual(tab("second"), other, "other tab is isolated");
  }
  assert.equal(Object.hasOwn(tab().fixedCrew!.preferences.leader.assignment!, "advisor"), false);
  assert.equal(Object.hasOwn(JSON.parse(disk()).projects[0].tabs[0].fixedCrew.preferences.leader.assignment, "advisor"), false);
});

test("P27 rejects invalid and busy advisor edits", async () => {
  const ctx = setup();
  const refuse = async (assignment: any, slot = "leader") => {
    const bytes = disk(), before = structuredClone(state.workspaces);
    const reply = await ctx.save(assignment, slot);
    assert.equal(reply.type, "error", JSON.stringify({ assignment, reply }));
    assert.equal(disk(), bytes, "refusal leaves bytes unchanged");
    assert.deepEqual(state.workspaces, before, "refusal leaves state unchanged");
  };
  for (const advisor of [null, "", "bad;command", "unknown-advisor"]) await refuse({ ...main, advisor });
  await refuse({ cli: "codex", model: "gpt-6.1-sol", effort: "medium", advisor: advisors[0] });
  await refuse({ advisor: advisors[0] }); // An advisor-only wire object is not an assignment.
  assert.equal((await ctx.save(main)).type, "actionResult");
  assert.equal((await ctx.save(main, "helper")).type, "actionResult");
  const changed = { ...main, advisor: advisors[0] };
  state.tabs.get("first")!.state.runs.push({ id: "working", seatSlotId: "helper", status: "working" } as any);
  await refuse(changed, "helper");
  state.tabs.get("first")!.state.runs = [];
  state.activeLeaderTurns.add("first"); await refuse(changed); state.activeLeaderTurns.clear();
  state.pendingApprovals.set("approval", { tabId: "first", origin: { kind: "leader", instance: {} } } as any);
  await refuse(changed); state.pendingApprovals.clear();
  state.savingTabs.set("first", {} as any); await refuse(changed); state.savingTabs.clear();
  assert.equal((await ctx.save(changed)).type, "actionResult", "the identical choice saves once idle");
});

test("P27 Auto assign preserves a user advisor choice", async () => {
  const ctx = setup();
  const catalogue = service.fixedCatalogue();
  const fable = "claude-fable-5-2";
  const injected = { ...catalogue, clis: catalogue.clis.filter((cli) => cli.id === "claude").map((cli) => ({ ...cli, models: [...cli.models!, fable] })),
    claudeModels: [...catalogue.claudeModels!, { value: fable, displayName: "Fable 5.2" }] };
  const auto = service.createFixedCrewService({ workspace: () => state.workspaces, selectedTabId: () => "first", catalogue: () => injected,
    seatBusy: () => false, leaderActive: () => false, writeWorkspace: config.writeWorkspaces,
    setWorkspace: state.setWorkspaces, announce() {} });
  auto.change("first", "autoAssignCrew");
  assert.equal(tab().fixedCrew!.preferences.leader.assignment?.advisor, fable, "untouched automatic Leader gets discovered Fable 5.2");
  for (const advisor of [advisors[0], undefined]) {
    const assignment = { ...main, ...(advisor ? { advisor } : {}) };
    assert.equal((await ctx.save(assignment)).type, "actionResult");
    assert.deepEqual(tab().fixedCrew!.preferences.leader, { source: "user", assignment });
    assert.equal((await ctx.dispatch("autoAssignCrew")).type, "actionResult");
    auto.refresh();
    assert.deepEqual(tab().fixedCrew!.preferences.leader, { source: "user", assignment }, "manual advisor and manual Off survive refill and refresh");
  }
  const old = config.defaultWorkspaces(dataDir);
  old.projects[0].tabs[0].fixedCrew!.preferences.leader = { source: "auto", assignment: main as any };
  writeFileSync(config.workspacesPath, JSON.stringify(old));
  const bytes = disk();
  assert.deepEqual(config.readWorkspaces(), old, "old version-1 assignments are loaded without migration or new defaults");
  assert.equal(disk(), bytes, "loading old data never rewrites it");
});

test("P27 advisor edits invalidate stale bulk digests", async () => {
  const ctx = setup();
  assert.equal((await ctx.save(main)).type, "actionResult");
  const before = digest.assignmentsDigest(tab().fixedCrew!);
  assert.equal((await ctx.save({ ...main, advisor: advisors[0] })).type, "actionResult");
  const after = digest.assignmentsDigest(tab().fixedCrew!);
  assert.notEqual(after, before, "advisor-only change invalidates the bulk digest");
  const bulk = (expectedAssignmentsDigest: string, cli = "claude", model = main.model) => ctx.dispatch("setCrewModelForAll", {
    cli, model, expectedAssignmentsDigest, confirmReplace: true,
  });
  const bytes = disk(), live = structuredClone(state.workspaces);
  assert.equal((await bulk(before)).type, "error");
  assert.equal(disk(), bytes); assert.deepEqual(state.workspaces, live);
  assert.equal((await ctx.save(main, "helper")).type, "actionResult");
  assert.equal((await bulk(digest.assignmentsDigest(tab().fixedCrew!))).type, "actionResult");
  assert.equal(tab().fixedCrew!.preferences.leader.assignment?.advisor, advisors[0]);
  assert.equal(Object.hasOwn(tab().fixedCrew!.preferences.helper.assignment!, "advisor"), false, "bulk keeps user Off");
  assert.equal((await bulk(digest.assignmentsDigest(tab().fixedCrew!), "codex", "gpt-6.1-sol")).type, "actionResult");
  assert.equal(Object.hasOwn(tab().fixedCrew!.preferences.leader.assignment!, "advisor"), false, "incompatible CLI removes advisor");
});
