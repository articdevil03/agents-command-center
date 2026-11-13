import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";
import { boot, client } from "./pack18-harness.ts";
const { modules: m } = await importWithTempDataRoot(async () => {
  const paths = await import("../server/config-files.ts");
  assert.match(relative(resolve(tmpdir()), paths.dataRoot), /^cc-scratch-[^\\/]+$/, "resolved import root before config startup writes");
  return {
  config: await import("../server/config.ts"), recovery: await import("../server/fixed-crew/recovery.ts"),
  state: await import("../server/main/state.ts"), messages: await import("../server/main/messages/index.ts"),
  launch: await import("../server/main/launch.ts"), leader: await import("../server/main/leader-session.ts"),
  tools: await import("../server/main/fixed-task-tools.ts"), prefs: await import("../server/config-prefs.ts"),
  settings: await import("../server/settings.ts"),
}; });
function scratch() {
  const root = scratchDir(); assert.match(relative(resolve(tmpdir()), root), /^cc-scratch-[^\\/]+$/, "resolved scratch root before writes"); return root;
}
test("FC4L recovery blocking gates workspace writes, actual worker and leader launch boundaries", () => {
  const root = scratch(), workspace = m.config.defaultWorkspaces(root), tab = workspace.projects[0].tabs[0];
  m.state.setWorkspaces(workspace); m.state.setSelectedTabId(tab.id);
  m.recovery.blockWorkspaceRecovery();
  try {
    assert.throws(() => m.config.writeWorkspaces(workspace, join(root, "workspace.json")), /Workspace unavailable.*workspace/, "workspace writer must reach recovery gate");
    assert.deepEqual(m.launch.launchWorker(tab.id, "coder", "work"), { ok: false, error: `${m.recovery.workspaceRecovery().notice} (worker-launch)` }, "actual worker call must reach recovery gate");
    assert.throws(() => m.leader.createTabLeader(tab.id), /Workspace unavailable.*leader-launch/, "leader creation must reach recovery gate before choosing a seat");
    assert.throws(() => m.tools.acceptPlannerReport({ tabId: tab.id, instance: {}, sessionId: "s" }, null, "run"), /Workspace unavailable.*task-action/, "leader task mutation must reach recovery gate");
  } finally { m.recovery.initializeWorkspaceRecovery(m.config.defaultWorkspaces); }
});
test("FC4L real task message dispatch refuses mutation and workspace messages while blocked", () => {
  const root = scratch(), workspace = m.config.defaultWorkspaces(root), tab = workspace.projects[0].tabs[0];
  m.state.setWorkspaces(workspace); m.state.setSelectedTabId(tab.id);
  let writes = 0;
  m.state.setFixedTasks({ actor: () => ({}), apply: () => { writes++; return {}; } } as any);
  const replies: any[] = [], ws: any = { send: (bytes: string) => replies.push(JSON.parse(bytes)) };
  m.recovery.blockWorkspaceRecovery();
  try {
    m.messages.handleMessage(ws, JSON.stringify({ type: "approveFixedPlan", tabId: tab.id, requestId: "request", taskId: "task", planVersion: 1, recordRevision: 1 }));
    assert.equal(replies[0].type, "error"); assert.match(replies[0].message, /Workspace unavailable.*task-action/, "real task dispatcher must enforce recovery readiness");
    assert.equal(writes, 0);
    m.messages.handleMessage(ws, JSON.stringify({ type: "renameTab", tabId: tab.id, name: "changed" }));
    assert.match(replies[1].message, /Workspace unavailable/); assert.equal(tab.name, "Development");
  } finally { m.recovery.initializeWorkspaceRecovery(m.config.defaultWorkspaces); }
});
test("FC4L old launch safety keys survive and unreadable brakes are never silently reset", () => {
  const root = scratch(), path = join(root, "launch-safety.json");
  const safety = { blocked: ["old.coder", "legacy"], uncertain: [{ seatId: "old.coder", pid: 123 }], live: [{ seatId: "old.coder", runId: "old-run" }] };
  const bytes = JSON.stringify(safety); writeFileSync(path, bytes);
  const loaded = m.prefs.readLaunchSafety(path);
  assert.deepEqual(loaded.blocked, safety.blocked); assert.deepEqual(loaded.live, safety.live);
  assert.equal(readFileSync(path, "utf8"), bytes);
  writeFileSync(path, "unreadable brake");
  assert.throws(() => m.prefs.readLaunchSafety(path), /unreadable/); assert.equal(readFileSync(path, "utf8"), "unreadable brake");
});
test("FC4L real startup on failed backup serves blocking notice, preserves requests and refuses writes", { timeout: 45_000 }, async () => {
  const request = { id: "00000000-0000-4000-8000-000000000000", fromTabId: "old", toTabId: "gone", title: "title", body: "body", status: "pending", createdAt: 1 };
  const server = await boot({ tabs: () => [{ id: "old", crew: [] }], extra({ data }) {
    assert.equal(resolve(data), join(resolve(data, ".."), "data"), "resolved test data root before write");
    assert.match(relative(resolve(tmpdir()), data), /^cc-p18s-[^\\/]+[\\/]data$/);
    writeFileSync(join(data, "backups"), "prevents recovery archive creation");
    writeFileSync(join(data, "requests.json"), JSON.stringify([request]));
    writeFileSync(join(data, "config", "setups.json"), "do not parse this at startup");
    writeFileSync(join(data, "config", "launch-safety.json"), "unreadable brakes");
  } });
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server);
    const tab = c.state().projects[0].tabs[0];
    assert.equal(tab.fixedCrew.unavailable, true); assert.match(tab.fixedCrew.notice, /Workspace unavailable/);
    const before = readFileSync(join(server.data, "config", "workspaces.json"));
    const refused = await c.request({ type: "renameTab", tabId: tab.id, name: "must not write" });
    assert.equal(refused.ok, false); assert.match(refused.message!, /Workspace unavailable/);
    assert.deepEqual(readFileSync(join(server.data, "config", "workspaces.json")), before);
    assert.equal(readFileSync(join(server.data, "requests.json"), "utf8"), JSON.stringify([request]), "startup must not mark old requests destinationRemoved");
    assert.equal(readFileSync(join(server.data, "config", "launch-safety.json"), "utf8"), "unreadable brakes");
    assert.equal(readFileSync(join(server.data, "config", "setups.json"), "utf8"), "do not parse this at startup");
  } finally { c?.close(); await server.stop(); }
});
test("FC4L old avatar bytes stay archived when the live image changes afterwards", () => {
  const root = scratch(); mkdirSync(join(root, "config")); mkdirSync(join(root, "avatars"));
  writeFileSync(join(root, "config", "workspaces.json"), "old");
  const name = "avatar-00000000-0000-4000-8000-000000000000.png", bytes = Buffer.from([0, 1, 255, 4]);
  writeFileSync(join(root, "avatars", name), bytes);
  const result = m.recovery.recoverWorkspace(root, m.config.defaultWorkspaces);
  assert.equal(result.blocked, false, result.notice);
  writeFileSync(join(root, "avatars", name), Buffer.from([9, 9, 9]));
  assert.deepEqual(readFileSync(join(root, "avatars", name)), Buffer.from([9, 9, 9]), "control: the live image changed");
  assert.deepEqual(readFileSync(join(result.archive!, "avatars", name)), bytes);
});
test("FC4L successful server recovery leaves saved setups unread, state carries none, and preserves old requests and safety keys", { timeout: 45_000 }, async () => {
  const request = { id: "00000000-0000-4000-8000-000000000000", fromTabId: "old", toTabId: "gone", title: "title", body: "body", status: "pending", createdAt: 1 };
  const safety = JSON.stringify({ blocked: ["old.coder"], live: [] });
  const server = await boot({ tabs: () => [{ id: "old", crew: [] }], extra({ data }) {
    assert.match(relative(resolve(tmpdir()), data), /^cc-p18s-[^\\/]+[\\/]data$/, "resolved scratch data root before writes");
    writeFileSync(join(data, "requests.json"), JSON.stringify([request]));
    writeFileSync(join(data, "config", "setups.json"), "never parse saved setups at startup");
    writeFileSync(join(data, "config", "launch-safety.json"), safety);
  } });
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server);
    assert.match(c.state().projects[0].tabs[0].id, /^fresh-/);
    assert.equal(readFileSync(join(server.data, "requests.json"), "utf8"), JSON.stringify([request]));
    assert.equal(readFileSync(join(server.data, "config", "setups.json"), "utf8"), "never parse saved setups at startup");
    assert.equal(readFileSync(join(server.data, "config", "launch-safety.json"), "utf8"), safety);
    assert.deepEqual(c.state().launchSafety.blocked, ["old.coder"]);
    assert.equal(Object.hasOwn(c.state(), "savedSetups"), false, "state no longer carries the removed savedSetups field");
    assert.equal(server.log().includes("saved setups"), false);
    assert.equal(c.state().requests[0].status, "destinationRemoved", "outbound state marks the missing destination while disk bytes stay pending");
    assert.equal(JSON.parse(readFileSync(join(server.data, "requests.json"), "utf8"))[0].status, "pending");
  } finally { c?.close(); await server.stop(); }
});
