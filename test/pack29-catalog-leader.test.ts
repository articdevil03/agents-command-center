import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, setup } from "./pack29-first-run.setup.ts";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { catalogProfile, catalogLeaderEligible, assertCatalogLeaderEligible, eligibleAcpClis } from "../server/settings/catalog-acp.ts";
import { createTabLeader, stopLeaderSession } from "../server/main/leader-session.ts";
import { fixedCatalogue } from "../server/main/fixed-crew.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { fakeAcp } from "./pack29-fake-acp.setup.ts";

function fixture(id: string) {
  const ctx = setup(), entry = CLI_CATALOG.find((item) => item.id === id)!, profile = catalogProfile(entry), bin = scratchDir();
  writeFileSync(join(bin, `${profile.program}.cmd`), "@echo off\r\n");
  const restore = setEnv({ PATH: bin }), peer = fakeAcp();
  api.state.setFolderActivity({ watchFolders() {}, noteSession() {} } as any);
  api.state.setAcpSpawn(peer.spawn); api.state.setAcpClis([profile]);
  Object.assign(api.state.settingsService.state.catalogTools[id], { installed: true, version: "1.0.0", signedIn: null, registered: true, connection: "unknown" });
  // Gemini has a legacy detection row, which must agree with its catalog facts.
  if (id === "gemini") Object.assign(api.state.settingsService.state.tools.gemini, { installed: true, version: "1.0.0", signedIn: null });
  return { ...ctx, entry, profile, peer, kind: api.config.acpKindOf(profile), close: () => {
    for (const tabId of api.state.leaders.keys()) stopLeaderSession(tabId);
    api.state.setAcpSpawn(undefined); restore();
  } };
}

test("all eight untested ACP catalog profiles allow deliberate setup and fake first chat with unknown or false auth", async () => {
  const entries = CLI_CATALOG.filter((entry) => entry.leader.kind === "acp");
  assert.deepEqual(entries.map((entry) => entry.id), ["grok", "gemini", "copilot", "qwen", "kimi", "mimo", "mistral", "minimax"]);
  for (const entry of entries) for (const signedIn of [null, false]) {
    const fx = fixture(entry.id);
    try {
      assert.equal(entry.leader.qualified, false, entry.id);
      api.state.settingsService.state.catalogTools[entry.id].signedIn = signedIn;
      assert.equal(catalogLeaderEligible(fx.profile, api.state.settingsService.state.catalogTools), true, entry.id);
      assert.ok(fixedCatalogue().clis.some((cli) => cli.id === fx.kind), entry.id);
      const state = api.broadcast.stateMessage() as any;
      assert.ok(state.clis.some((cli: any) => cli.id === fx.kind), entry.id);
      for (const facts of [state.acpClis[0], state.settings.catalogTools[entry.id]]) {
        assert.equal(facts.leaderEligible, true, entry.id); assert.equal(facts.tested, false); assert.equal(facts.leaderLabel, "Not tested yet");
      }
      assert.equal((await fx.dispatch({ cli: fx.kind, acpConsent: true }))?.type, "actionResult", entry.id);
      assert.equal(fx.peer.launches.length, 0, `${entry.id}: setup starts no session`);
      const tab = api.state.workspaces.projects.at(-1)!.tabs[0];
      const leader = createTabLeader(tab.id); leader.send("harmless fake first chat"); await fx.peer.connected();
      assert.deepEqual(fx.peer.launches, [{ program: fx.profile.program, args: fx.profile.args }]);
    } finally { fx.close(); }
  }
});

test("catalog selection refuses missing facts, mismatched profiles, removed registration, unsafe resolution and missing consent without writes or spawn", async () => {
  for (const scenario of ["missing", "unknown", "version", "name", "program", "args", "removed", "unsafe", "consent", "missing facts"]) {
    const fx = fixture("qwen");
    try {
      const facts = api.state.settingsService.state.catalogTools.qwen;
      if (scenario === "missing facts") delete api.state.settingsService.state.catalogTools.qwen;
      if (scenario === "missing") facts.installed = false;
      if (scenario === "unknown") facts.installed = null;
      if (scenario === "version") facts.version = null;
      if (scenario === "name") fx.profile.name = "Mismatch";
      if (scenario === "program") fx.profile.program = "other";
      if (scenario === "args") fx.profile.args = ["wrong"];
      if (scenario === "removed") api.state.setAcpClis([]);
      if (scenario === "unsafe") { writeFileSync(join(fx.work, "qwen.cmd"), "@echo off\r\n"); process.env.PATH = fx.work; }
      writeFileSync(join(fx.work, "keep.txt"), "owner bytes");
      const before = fx.bytes();
      const reply = await fx.dispatch({ cli: fx.kind, acpConsent: scenario !== "consent" });
      assert.equal(reply?.type, "error", scenario); assert.deepEqual(fx.bytes(), before, scenario);
      assert.equal(readFileSync(join(fx.work, "keep.txt"), "utf8"), "owner bytes");
      assert.equal(fx.calls(), 0, scenario); assert.equal(fx.peer.launches.length, 0, scenario);
      // Unknown facts (not checked yet, no version) refuse the setup choice above but never the launch gate: see the launch-gate test below.
      if (!["unsafe", "consent", "unknown", "version", "missing facts"].includes(scenario)) {
        const tab = api.state.workspaces.projects[0].tabs[0];
        tab.fixedCrew!.preferences.leader = { source: "user", assignment: { cli: fx.kind, model: "default", effort: "default" } };
        assert.throws(() => createTabLeader(tab.id), scenario === "removed" ? /removed in Settings/ : /unavailable or its saved connection/);
        assert.equal(fx.peer.launches.length, 0, `${scenario}: first-chat dispatch also refuses`);
      }
    } finally { fx.close(); }
  }
});

for (const installed of [false, null]) {
  test(`installation=${installed}: unavailable catalog tool is absent from both leader lists`, () => {
    const fx = fixture("qwen");
    try {
      api.state.settingsService.state.catalogTools.qwen.installed = installed;
      assert.equal(fixedCatalogue().clis.some((cli) => cli.id === fx.kind), false, `installation=${installed}: unavailable tool offered`);
      assert.equal((api.broadcast.stateMessage() as any).clis.some((cli: any) => cli.id === fx.kind), false, `installation=${installed}: unavailable tool published`);
    } finally { fx.close(); }
  });
}
test("installation=false: a known missing catalog tool cannot launch a first chat", () => {
  const fx = fixture("qwen");
  try {
    api.state.settingsService.state.catalogTools.qwen.installed = false;
    const tab = api.state.workspaces.projects[0].tabs[0];
    tab.fixedCrew!.preferences.leader = { source: "user", assignment: { cli: fx.kind, model: "default", effort: "default" } };
    assert.throws(() => createTabLeader(tab.id), /unavailable or its saved connection/);
    assert.equal(fx.peer.launches.length, 0, "no ACP spawn");
  } finally { fx.close(); }
});
test("launch gate: known missing and a mismatched saved connection are refused; unknown is not; the picker stays strict", () => {
  const fx = fixture("qwen"), state = api.state.settingsService.state, facts = state.catalogTools.qwen;
  try {
    const gate = (cli = fx.profile) => { try { assertCatalogLeaderEligible(cli, state); return "allowed"; } catch (error) { return (error as Error).message; } };
    assert.equal(gate(), "allowed", "installed true with a version");
    facts.installed = false;
    assert.match(gate(), /unavailable or its saved connection/, "known missing");
    facts.installed = true; facts.version = "1.0.0";
    assert.match(gate({ ...fx.profile, args: ["wrong"] }), /unavailable or its saved connection/, "mismatched saved connection");
    facts.installed = null; facts.version = null;
    assert.equal(gate(), "allowed", "unknown installed, no version");
    assert.deepEqual(eligibleAcpClis([fx.profile], state), [], "the picker still hides unknown");
    facts.installed = true; facts.version = "1.0.0";
    assert.deepEqual(eligibleAcpClis([fx.profile], state), [fx.profile], "the picker offers installed with a version");
  } finally { fx.close(); }
});

test("manual custom ACP entries preserve eligibility and both capability lists", () => {
  setup();
  const custom = { id: "gemini-cli", name: "Gemini CLI", program: "gemini", args: ["--acp"] };
  api.state.setAcpClis([custom]);
  assert.equal(catalogLeaderEligible(custom), true);
  assert.ok(fixedCatalogue().clis.some((cli) => cli.id === "acp:gemini-cli"));
  assert.ok((api.broadcast.stateMessage() as any).clis.some((cli: any) => cli.id === "acp:gemini-cli"));
});
