import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { api, setup } from "./pack29-first-run.setup.ts";
import { fakeAcp } from "./pack29-fake-acp.setup.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { createTabLeader, stopLeaderSession } from "../server/main/leader-session.ts";
import { launchFixedAction } from "../server/main/fixed-task-tools.ts";
import { executionJournal } from "../server/fixed-crew/task-execution.ts";
import { isRunning } from "../server/runner.ts";
import { createTaskStore } from "../server/fixed-crew/task-store.ts";

// The REAL call sites (launch.ts keyLaunch, leader-session.ts loadKey, fixed-task-tools.ts prepareConnection)
// with a fake credential store. The only fakes are the ACP peer (in memory) and a scratch stub program that records its environment.
const KEY = "ccTEST-KEY-" + randomUUID();
const ASSIST = { kind: "assist", route: "normal", change: "none" } as const;
const wait = async (done: () => boolean, label: string) => {
  for (let n = 0; n < 600; n++) { if (done()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(label);
};

async function fixture(saved: string) {
  const ctx = setup(), bin = scratchDir(), seenFile = join(bin, "env-seen.txt"), store = new MemoryCredentialStore();
  const service = new api.SettingsService({ dataRoot: scratchDir(), credentialStore: store, runCli: async () => { assert.fail("No vendor calls"); } });
  for (const cli of ["claude", "codex", "opencode"] as const) Object.assign(service.state.tools[cli], { installed: true, signedIn: cli === "codex" });
  Object.assign(service.state.catalogTools.opencode, { installed: true, version: "1.0.0", supportedVersion: true, signedIn: false });
  await store.set(saved, { key: KEY }); // saved in an earlier session: the service cache is empty until a launch prepares it
  api.state.setSettingsService(service);
  const ids = ["gemini", "grok"], profiles = ids.map((id) => catalogProfile(catalogTool(id)));
  for (const [index, profile] of profiles.entries()) {
    const id = ids[index];
    Object.assign(service.state.catalogTools[id], { installed: true, version: "1.0.0", signedIn: null, registered: true, connection: "unknown" });
    writeFileSync(join(bin, `${profile.program}.cmd`), `@echo off\r\n>"${seenFile}" echo %GEMINI_API_KEY%\r\n`);
  }
  Object.assign(service.state.tools.gemini, { installed: true, version: "1.0.0", signedIn: null });
  const restore = setEnv({ PATH: bin + ";" + process.env.PATH, CC_TEST_FAKE_CLI: "1" });
  const peer = fakeAcp(), seen: Array<Record<string, string | undefined>> = [];
  api.state.setAcpSpawn(((program: string, args: string[], options: any) => { seen.push(options.env); return peer.spawn(program, args, options); }) as any);
  api.state.setFolderActivity({ watchFolders() {}, noteSession() {}, beginOwn: () => ({}), endOwn() {} } as any);
  api.state.setAcpClis(profiles);
  const tab = api.state.workspaces.projects[0].tabs[0];
  const assign = (slot: string, profile: (typeof profiles)[number]) => {
    (tab.fixedCrew!.preferences as any)[slot] = { source: "user", assignment: { cli: api.config.acpKindOf(profile), model: "default", effort: "default" } };
  };
  return { ...ctx, service, store, peer, seen, seenFile, tab, profiles, assign, close: () => {
    for (const tabId of [...api.state.leaders.keys()]) stopLeaderSession(tabId);
    api.state.setAcpSpawn(undefined); restore();
  } };
}

test("leader-session.ts loadKey: a leader start through the real session path puts the saved key in the ACP leader's spawn env", async () => {
  const fx = await fixture("gemini");
  try {
    fx.assign("leader", fx.profiles[0]);
    const leader = createTabLeader(fx.tab.id); leader.send("harmless fake first chat"); await fx.peer.connected();
    assert.equal(fx.seen.length, 1, "the leader spawned once");
    assert.equal(fx.seen[0].GEMINI_API_KEY, KEY);
    assert.equal(fx.peer.launches[0].args.some((arg) => arg.includes(KEY)), false, "key never in argv");
  } finally { fx.close(); }
});

test("launch.ts keyLaunch and fixed-task-tools.ts prepareConnection: a fixed worker of a saved-key tool is prepared before reservation and spawns with the key", async () => {
  const fx = await fixture("gemini");
  try {
    // The leader is another tool, so the worker's own tool is prepared ONLY by the fixed-task path.
    fx.assign("leader", fx.profiles[1]); fx.assign("helper", fx.profiles[0]);
    fx.tab.folder = scratchDir();
    api.state.setUnconfirmedRunIds(new Set()); api.state.setLaunchSafety(api.config.readLaunchSafety(join(scratchDir(), "absent.json")));
    api.state.setFixedTasks(createTaskStore(api.state.dataRoot, () => api.state.workspaces.projects[0]));
    createTabLeader(fx.tab.id);
    const prepared: Array<string | null> = [], original = fx.service.cliKeys.prepareConnection.bind(fx.service.cliKeys);
    fx.service.cliKeys.prepareConnection = async (cli) => { prepared.push(executionJournal(api.state.dataRoot, fx.tab.id).activeExecutionId); return original(cli); };
    const instance = api.state.leaderInstances.get(fx.tab.id)!;
    let result: any;
    await assert.doesNotReject(async () => { result = await launchFixedAction({ tabId: fx.tab.id, instance, sessionId: "key-callsite" }, null, ASSIST, "synthetic brief", "helper"); });
    assert.deepEqual(prepared, [null], "prepared once, before any reservation exists");
    assert.ok(fx.store.calls.includes("get:gemini"), "the credential store was read");
    await wait(() => existsSync(fx.seenFile), "the stub program never recorded its environment");
    await wait(() => !isRunning(result.runId), "the stub run did not end");
    assert.equal(readFileSync(fx.seenFile, "utf8").trim(), KEY, "the worker's spawn env carries the saved key");
  } finally { fx.close(); }
});
