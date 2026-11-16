import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { managedCli, managedRoot } from "../server/settings/opencode/paths.ts";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { PARTIAL_REMOVAL } from "../server/settings/opencode/remove.ts";
import { runSeat, isRunning } from "../server/runner.ts";
import { fakeAcp } from "./pack29-fake-acp.setup.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { assertCliAvailable } from "../server/settings/cli-availability.ts";
import { assertCatalogLeaderEligible } from "../server/settings/catalog-acp.ts";
import { fixture as copilotInstallFixture } from "./pack34-copilot.setup.ts";
import { requireFixedAssignment } from "../server/main/fixed-task-launch.ts";

async function fixture(tool: "opencode" | "copilot" = "copilot", refreshPath = async () => {}) {
  const context = setup(), home = scratchDir(), data = scratchDir();
  api.state.leaders.clear(); api.state.fixedLeaderSettings.clear();
  const env = { LOCALAPPDATA: home, USERPROFILE: home, HOME: home, APPDATA: home, CC_TEST_FAKE_CLI: "1", PATH: "" };
  const store = new MemoryCredentialStore(); await store.set("copilot", { key: "synthetic-key" });
  const service = new api.SettingsService({ dataRoot: data, env, credentialStore: store, refreshPath, runCli: async (bin) => ({
    code: (bin === "opencode" || bin === "copilot") && managedCli(env, bin) ? 0 : 127, stdout: "1.0.112", stderr: "", cleanupConfirmed: true,
  }) });
  api.state.setSettingsService(service);
  const root = managedRoot(env, tool)!, install = join(root, "install-abc-123"), exe = join(install, `${tool}.exe`);
  fs.mkdirSync(install, { recursive: true }); fs.writeFileSync(exe, "fake, never execute");
  fs.writeFileSync(join(root, "active.json"), JSON.stringify({ executable: `install-abc-123/${tool}.exe`, version: "1.0.112" }));
  Object.assign(service.state.catalogTools[tool], { installed: true, version: "1.0.112", managedInstall: true });
  const socket = [...api.state.clients][0];
  const dispatch = async (extra = {}) => {
    const requestId = randomUUID();
    api.messages.handleMessage(socket, JSON.stringify({ type: "removeCliInstall", cli: tool, confirm: true, requestId, ...extra }));
    for (let i = 0; i < 400; i++) {
      const reply = context.replies.find((r) => r.requestId === requestId && ["error", "actionResult"].includes(r.type));
      if (reply) return reply;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail("Removal handler did not answer");
  };
  return { ...context, env, root, install, exe, service, store, dispatch, close: async () => {
    await service.installer.drain(); await service.login.drain(); service.cliKeys.close();
    api.state.leaders.clear(); api.state.fixedLeaderSettings.clear(); api.state.runContexts.clear();
  } };
}

test("a newly committed managed install immediately offers removal without another check", async (t) => {
  const f = await copilotInstallFixture(t);
  try {
    await f.service.installCli(f.request);
    assert.equal(f.service.state.catalogTools.copilot.installed, true);
    assert.equal(f.service.state.catalogTools.copilot.managedInstall, true);
    f.assertBoundaries();
  } finally { await f.close(); }
});

for (const tool of ["opencode", "copilot"] as const) test(`${tool}: real handler removes only managed installs, refreshes picker facts, preserves saved connections and keys`, async () => {
  const f = await fixture(tool);
  try {
    const foreign = join(f.root, "install-notes"), sibling = managedRoot(f.env, tool === "opencode" ? "copilot" : "opencode")!;
    fs.mkdirSync(foreign); fs.writeFileSync(join(foreign, "keep"), "keep");
    fs.mkdirSync(sibling, { recursive: true }); fs.writeFileSync(join(sibling, "keep"), "keep");
    const profile = catalogProfile(catalogTool("copilot")); api.state.setAcpClis([profile]);
    assert.equal((await f.dispatch()).type, "actionResult");
    assert.equal(fs.existsSync(join(f.root, "active.json")), false); assert.equal(fs.existsSync(f.install), false);
    assert.ok(fs.existsSync(join(foreign, "keep")), "foreign folder preserved");
    assert.ok(fs.existsSync(join(sibling, "keep")), "sibling tool preserved");
    assert.equal(fs.readFileSync(join(foreign, "keep"), "utf8"), "keep");
    assert.equal(fs.readFileSync(join(sibling, "keep"), "utf8"), "keep");
    assert.equal(managedCli(f.env, tool), null);
    assert.equal(f.service.state.catalogTools[tool].installed, false);
    assert.equal(f.service.state.catalogTools[tool].managedInstall, false);
    assert.deepEqual(api.state.acpClis, [profile]); assert.deepEqual(await f.store.get("copilot"), { key: "synthetic-key" });
    const state = api.broadcast.stateMessage() as any;
    if (tool === "copilot") assert.equal(state.acpClis.find((c: any) => c.id === profile.id).leaderEligible, false);
    assert.equal((await f.dispatch()).message, "Nothing installed by Command Center to remove.");
  } finally { await f.close(); }
});

test("real handler rejects missing confirmation, extra paths, nonmanaged tools and in-use live leaders", async () => {
  const f = await fixture();
  try {
    for (const extra of [{ confirm: false }, { confirm: undefined }, { cli: "claude" }, { path: scratchDir() }, { cli: "../copilot" }]) {
      assert.equal((await f.dispatch(extra)).type, "error"); assert.ok(fs.existsSync(f.exe));
    }
    const tab = api.state.workspaces.projects[0].tabs[0], profile = catalogProfile(catalogTool("copilot"));
    api.state.setAcpClis([profile]);
    tab.fixedCrew!.preferences.leader = { source: "user", assignment: { cli: api.config.acpKindOf(profile), model: "default", effort: "default" } };
    api.state.leaders.set(tab.id, { isDead: () => false } as any);
    assert.equal((await f.dispatch()).message, "Stop the chats and seats that use it first, then try again.");
    assert.ok(fs.existsSync(f.exe));
    api.state.leaders.clear();
    assert.equal((await f.dispatch()).type, "actionResult");
    assert.equal(fs.existsSync(f.root), false, "empty tool root removed non-recursively");
  } finally { await f.close(); }
});

for (const [label, signature, inUse] of [
  ["saved Copilot assignment", JSON.stringify({ assignment: { cli: api.config.acpKindOf(catalogProfile(catalogTool("copilot"))) } }), true],
  ["unparseable saved assignment", "{broken", true],
  ["saved assignment for another tool", JSON.stringify({ assignment: { cli: "claude" } }), false],
] as const) test(`real removal handler checks ${label} independently of the current tab assignment`, async () => {
  const f = await fixture();
  try {
    const tab = api.state.workspaces.projects[0].tabs[0];
    api.state.setAcpClis([catalogProfile(catalogTool("copilot"))]);
    tab.fixedCrew!.preferences.leader = { source: "user", assignment: { cli: "claude", model: "sonnet", effort: "medium" } };
    api.state.leaders.set(tab.id, { isDead: () => false } as any);
    api.state.fixedLeaderSettings.set(tab.id, signature);
    const result = await f.dispatch();
    if (inUse) {
      assert.equal(result.message, "Stop the chats and seats that use it first, then try again.");
      assert.ok(fs.existsSync(f.exe));
    } else {
      assert.equal(result.type, "actionResult");
      assert.equal(fs.existsSync(f.exe), false);
    }
  } finally { await f.close(); }
});

test("real handler refuses a running crew process", async () => {
  const f = await fixture(), peer = fakeAcp(), profile = catalogProfile(catalogTool("copilot"));
  const run = { runId: randomUUID(), seatKey: "synthetic.remove", slotId: "helper", name: "Synthetic", cli: api.config.acpKindOf(profile), acp: profile, model: "default", effort: "default", folder: scratchDir(), canWrite: false, startedAt: Date.now() };
  api.state.setAcpClis([profile]);
  const bin = scratchDir(); fs.writeFileSync(join(bin, "copilot.cmd"), "@echo off\r\n");
  const restore = setEnv({ PATH: bin, CC_TEST_FAKE_CLI: "1" }), children: any[] = [];
  try {
    const result = runSeat(run, "synthetic", { onOutput() {}, onStatus() {} }, ((...args: any[]) => { const child = peer.spawn(...args); children.push(child); return child; }) as any);
    assert.equal(result.ok, true); assert.equal(isRunning(run.runId), true);
    api.state.runContexts.set(run.runId, { tabId: "example-development", slot: "helper", run, prompt: "", source: "client" });
    assert.equal((await f.dispatch()).message, "Stop the chats and seats that use it first, then try again.");
    assert.ok(fs.existsSync(f.exe));
  } finally {
    for (const child of children) child.emit("close", 0);
    restore();
    assert.equal(isRunning(run.runId), false); await f.close();
  }
});

test("removal and installation share synchronous admission; a second removal cannot enter", async (t) => {
  const f = await fixture(), unlink = fsp.unlink;
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>((r) => { reached = r; }), gate = new Promise<void>((r) => { release = r; });
  t.mock.method(fsp, "unlink", async (path: any) => { if (String(path) === join(f.root, "active.json")) { reached(); await gate; } return unlink(path); }); syncBuiltinESMExports();
  const first = f.dispatch();
  try {
    await entered; assert.equal(f.service.installer.busy, true);
    const profile = catalogProfile(catalogTool("copilot")), tab = api.state.workspaces.projects[0].tabs[0];
    api.state.setAcpClis([profile]);
    const assignment = { cli: api.config.acpKindOf(profile), model: "default", effort: "default" };
    tab.fixedCrew!.preferences.coder = { source: "user", assignment };
    await f.service.cliKeys.prepare("copilot");
    const refusal = { message: "This tool is being removed. Try again when it finishes." };
    assert.throws(() => assertCatalogLeaderEligible(profile, f.service.state), refusal);
    assert.throws(() => requireFixedAssignment(tab.id, "coder"), refusal);
    assert.throws(() => f.service.cliKeys.launch(profile), refusal);
    const removal = f.service.state.catalogTools.copilot.action;
    f.service.state.catalogTools.opencode.action = removal;
    assert.throws(() => assertCliAvailable("opencode", f.service.state), /being removed/);
    delete f.service.state.catalogTools.opencode.action;
    assert.match((await f.dispatch()).message, /running/);
    await assert.rejects(f.service.installCli("copilot", randomUUID(), true), /active/);
    release(); assert.equal((await first).type, "actionResult");
    assert.deepEqual(requireFixedAssignment(tab.id, "coder"), assignment, "seat admission reopens after removal");
    assert.deepEqual(f.service.cliKeys.launch(profile).secrets, ["synthetic-key"], "key launch admission reopens");
    assert.doesNotThrow(() => assertCliAvailable("opencode", f.service.state));
  } finally { release(); await first; t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test("an active installation blocks removal without touching files", async () => {
  let release!: () => void;
  const f = await fixture("copilot", () => new Promise<void>((r) => { release = r; }));
  const installing = f.service.installCli("copilot", randomUUID(), true).catch(() => {});
  try {
    for (let i = 0; i < 400 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(typeof release, "function");
    assert.match((await f.dispatch()).message, /running/); assert.ok(fs.existsSync(f.exe));
  } finally { release?.(); await installing; await f.close(); }
});

test("locked file returns partial message after deactivation, removes other files, and can retry", async (t) => {
  const f = await fixture(), unlink = fsp.unlink;
  const other = join(f.install, "other.txt"); fs.writeFileSync(other, "fake"); let attempted = false, deactivatedBeforeCleanup = false;
  t.mock.method(fsp, "unlink", async (path: any) => {
    if (String(path) === f.exe) { attempted = true; deactivatedBeforeCleanup = !fs.existsSync(join(f.root, "active.json")); throw Object.assign(new Error("locked"), { code: "EBUSY" }); }
    return unlink(path);
  }); syncBuiltinESMExports();
  try {
    assert.equal((await f.dispatch()).message, PARTIAL_REMOVAL); assert.equal(attempted, true);
    assert.equal(deactivatedBeforeCleanup, true, "descriptor removed before attempting the locked file");
    assert.equal(fs.existsSync(join(f.root, "active.json")), false); assert.equal(fs.existsSync(other), false);
    assert.equal(f.service.state.catalogTools.copilot.installed, false);
    t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal((await f.dispatch()).type, "actionResult");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test("links and escaped descriptors never delete an outside file", async () => {
  const f = await fixture(), outside = scratchDir(), keep = join(outside, "keep"); fs.writeFileSync(keep, "keep");
  const link = join(f.install, "linked");
  try {
    fs.symlinkSync(outside, link, "junction");
    assert.equal((await f.dispatch()).type, "error");
    assert.ok(fs.existsSync(join(f.root, "active.json"))); assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(keep, "utf8"), "keep");
    fs.rmdirSync(link);
    fs.writeFileSync(join(f.root, "active.json"), JSON.stringify({ executable: keep, version: "1.0.112" }));
    assert.equal((await f.dispatch()).type, "actionResult"); assert.equal(fs.readFileSync(keep, "utf8"), "keep");
  } finally { if (fs.existsSync(link)) fs.rmdirSync(link); await f.close(); }
});
