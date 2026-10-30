// Pack 18, Block 1, through real servers with fake CLIs on PATH: S8 the launch gate reads the capability table, S9 the leader's crew status and a custom seat id,
// S10 switching to another setup carries the seats across, S11 saving a crew (and saved setups), S13 a step cannot be advanced while its owners' runs work.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, clone, tabOf, workspaceBytes, workspaceFile, sleep, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const OUR = config.templateCopy("our-process");

const seat = (slot: string, name: string, role: string, cli: string, model: string, effort: string, canWrite: boolean, extra: Record<string, unknown> = {}) => ({ slot, name, role, cli, model, effort, canWrite, isLeader: slot === "leader", ...extra });
const CODEX_LEADER = seat("leader", "Atlas", "Leader", "codex", "gpt-6-sol", "high", false);

let gate: Server, g: Client, work: Server, w: Client;
before(async () => {
  // The leader server: a Codex leader (fake app-server) with read-only seats on Codex, on an ACP CLI and on Claude, and a custom seat id.
  gate = await boot({
    fakeLeader: true,
    acpClis: [{ id: "fake-gate", name: "Fake gate", program: "fake-acp", args: ["--scenario=basic"] }],
    tabs: (folder) => [
      { id: "p18-gate", name: "gate", kind: "dev", folder, setupName: "Gate", crew: [CODEX_LEADER, seat("codexRead", "Cody", "Codex reader", "codex", "gpt-6-sol", "low", false), seat("acpRead", "Acpy", "ACP reader", "acp:fake-gate", "default", "default", false), seat("claudeRead", "Clay", "Claude reader", "claude", "claude-opus-5-5[1m]", "medium", false)], lookPause: false, steps: [] },
      { id: "p18-status", name: "status", kind: "dev", folder, setupName: "Custom", crew: [CODEX_LEADER, seat("researcher", "Rex", "Researcher", "claude", "claude-opus-5-5[1m]", "medium", false, { advisor: "claude-fable-5-1" })], lookPause: false, steps: [] },
    ],
  });
  g = await client(gate);
  // The run server: no leader needed. A Claude run lasts about 3 s, a Codex run about 11 s.
  work = await boot({
    env: { FAKE_SLEEP_CLAUDE: "4", FAKE_SLEEP_CODEX: "12" },
    tabs: (folder) => [
      tabOf("p18-use", folder, OUR), tabOf("p18-acpsaved", folder, OUR), tabOf("p18-guard", folder, OUR),
      tabOf("p18-setups", folder, OUR, (setup) => { setup.crew[0].pic = "avatars/atlas.svg"; }),
      { id: "p18-advance", name: "advance", kind: "dev", folder, setupName: "Two coders", crew: [seat("leader", "Atlas", "Leader", "claude", "claude-opus-5-5[1m]", "medium", false), seat("coderA", "Ann", "Coder", "claude", "claude-opus-5-5[1m]", "medium", true), seat("coderB", "Bo", "Coder", "codex", "gpt-6-sol", "low", true), seat("checker", "Chi", "Reviewer", "claude", "claude-opus-5-5[1m]", "medium", false)],
        lookPause: true, steps: [] },
    ],
  });
  w = await client(work);
});
after(async () => { g?.close(); w?.close(); await gate?.stop(); await work?.stop(); });

const seatIn = (tab: any, slot: string) => tab.crew.find((item: any) => item.slot === slot);
const toolResult = (text: string): any => { const m = /^\[tool ok: ([\s\S]*)\]$/.exec(text.trim()); assert.ok(m, `a tool result, got: ${text.slice(0, 200)}`); return m[1]; };

test("S8 the launch gate: in Plan mode a read-only Codex or ACP seat is refused (their read-only is not enforced), a read-only Claude seat launches", { timeout: 120_000 }, async () => {
  const id = "p18-gate";
  await g.chat(id, "start the leader");
  assert.deepEqual(await g.request({ type: "setPermissionMode", tabId: id, mode: "plan", confirm: true }), { ok: true });
  const results = () => g.messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === id);
  const launch = async (slot: string) => { const seen = results().length; g.send({ type: "testGatedLaunch", tabId: id, slot, brief: "TEST ONLY: do nothing." }); return g.wait(() => results()[seen], `launch result for ${slot}`); };
  for (const slot of ["codexRead", "acpRead"]) {
    const refused = await launch(slot);
    assert.equal(refused.ok, false, `${slot} is refused`);
    assert.match(refused.error, /Plan mode/, slot);
  }
  assert.equal(g.tab(id).runs.length, 0, "nothing was started for the two refused seats");
  const allowed = await launch("claudeRead");
  assert.equal(allowed.ok, true, "a read-only Claude seat has enforced read-only: Plan mode lets it launch");
  await g.wait(() => g.tab(id).runs.length === 1, "the Claude run is in the engine");
  assert.equal(g.tab(id).runs[0].seatSlotId, "claudeRead");
  await g.wait(() => g.runEnds(id) >= 1, "the run ended", RUN_END_MS);
});

test("S9 the leader's crew status carries role, advisor, write permission and the steps, and launch_seat works on a custom seat id", { timeout: 120_000 }, async () => {
  const id = "p18-status";
  await g.chat(id, "start the leader");
  const status = JSON.parse(toolResult(await g.chat(id, JSON.stringify([{ tool: "get_crew_status" }]))));
  assert.equal(status.tab, "status");
  const rex = status.crew.find((item: any) => item.slot === "researcher");
  assert.deepEqual([rex.name, rex.role, rex.cli, rex.model, rex.advisor, rex.canWrite, rex.orchestrates, rex.runnable, rex.seatKey], ["Rex", "Researcher", "claude", "claude-opus-5-5[1m]", "claude-fable-5-1", false, false, true, "p18-status.researcher"]);
  const lead = status.crew.find((item: any) => item.slot === "leader");
  assert.deepEqual([lead.role, lead.advisor, lead.runnable], ["Leader", null, false]);
  assert.deepEqual(status.steps, [], "a leader and a Researcher alone have no steps: the leader does the work and asks the Researcher by name");

  const launched = toolResult(await g.chat(id, JSON.stringify([{ tool: "launch_seat", args: { slot: "researcher", brief: "TEST ONLY: look it up." } }])));
  assert.match(launched, /launched "p18-status\.researcher"/);
  await g.wait(() => g.tab(id).runs.some((run: any) => run.seatSlotId === "researcher"), "the researcher run exists");
  await g.wait(() => g.runEnds(id) >= 1, "the run ended", RUN_END_MS);
  assert.ok(existsSync(join(gate.work, "run-wrote-claude.txt")), "the Claude fake ran in the tab's folder");
});

test("S10 useSetup carries a seat's settings across by id, bumps the crew generation, and is refused while a seat works", { timeout: 120_000 }, async () => {
  const id = "p18-use";
  w.send({ type: "updateSeat", tabId: id, slot: "coder", name: "Zed", effort: "high" });
  await w.wait(() => seatIn(w.tab(id), "coder").name === "Zed", "the coder is renamed");
  assert.match((await w.attempt({ type: "useSetup", tabId: id })).error ?? "", /exactly one of templateId or setupId/);
  assert.match((await w.attempt({ type: "useSetup", tabId: id, templateId: "duo", setupId: "x" })).error ?? "", /exactly one/);
  assert.match((await w.attempt({ type: "useSetup", tabId: id, templateId: "nope" })).error ?? "", /unknown template/);
  assert.match((await w.attempt({ type: "useSetup", tabId: id, templateId: "classic-main" })).error ?? "", /unknown template/, "the hidden old crew cannot be picked");

  // A seat that works keeps the setup: the switch is refused while the run is going, and nothing changes.
  w.send({ type: "run", tabId: id, slot: "reviewer1", prompt: "TEST ONLY: stay a while." });
  await w.wait(() => w.tab(id).runs.some((run: any) => run.status === "working"), "the reviewer run is working");
  const before = workspaceBytes(work);
  assert.match((await w.attempt({ type: "useSetup", tabId: id, templateId: "duo" })).error ?? "", /busy/);
  assert.equal(workspaceBytes(work), before, "a refused switch leaves the file alone");
  await w.wait(() => w.tab(id).runs.every((run: any) => run.status !== "working"), "the reviewer run ended", RUN_END_MS);

  const generation = w.tab(id).processState.crewGenerationId;
  w.send({ type: "useSetup", tabId: id, templateId: "duo" });
  await w.wait(() => w.tab(id).setupName === "The Duo", "the tab is on the Duo");
  const tab = w.tab(id);
  assert.deepEqual(tab.crew.map((item: any) => item.slot), ["leader", "coder"]);
  const coder = seatIn(tab, "coder");
  // The Duo's own coder is Codex gpt-6-luna; the user's coder was Claude Sonnet, named Zed, on high effort, and keeps all of that.
  assert.deepEqual([coder.name, coder.cli, coder.model, coder.effort, coder.role, coder.canWrite], ["Zed", "claude", "claude-sonnet-5-5[1m]", "high", "Coder", true]);
  assert.equal(seatIn(tab, "leader").name, "Atlas");
  assert.equal(seatIn(tab, "leader").advisor, undefined, "the Duo's leader has none");
  assert.deepEqual(tab.steps.map((item: any) => item.id), ["plan", "build", "gate", "look", "review", "final", "ship"]);
  assert.equal(tab.processState.crewGenerationId, generation + 1);
  assert.equal(tab.processState.currentStepIndex, 0);
  assert.deepEqual(tab.processState.seats.map((item: any) => item.slotId), ["leader", "coder"]);
  const saved = workspaceFile(work).projects[0].tabs.find((item: any) => item.id === id);
  assert.deepEqual([saved.setupName, saved.steps.length, saved.crew.length, saved.kind], ["The Duo", 7, 2, "dev"], "and it is on disk");
  // The tab's kind follows the setup it uses.
  w.send({ type: "useSetup", tabId: id, templateId: "design" });
  await w.wait(() => w.tab(id).setupName === "Design", "on the Design setup");
  assert.equal(w.tab(id).kind, "design");
  assert.equal(workspaceFile(work).projects[0].tabs.find((item: any) => item.id === id).kind, "design");
});

test("S11 setSetup refuses to take out a blocked seat (the file is unchanged); a save, a switch back and a removal of a saved setup round-trip", { timeout: 120_000 }, async () => {
  const id = "p18-setups";
  const current = () => w.tab(id);
  const without = (slot: string) => {
    const crew = clone(current().crew).filter((item: any) => item.slot !== slot).map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest);
    return { crew, lookPause: current().lookPause };
  };
  // fixer2 is blocked after a stop, even with nothing running on it.
  w.send({ type: "stopSeat", tabId: id, slot: "fixer2" });
  await w.wait(() => (w.state().launchSafety.blocked as string[]).includes(`${id}.fixer2`), "fixer2 is blocked");
  const before = workspaceBytes(work);
  const refused = await w.attempt({ type: "setSetup", tabId: id, ...without("fixer2"), setupName: "Smaller" });
  assert.match(refused.error ?? "", /Nova cannot be taken out yet/);
  const crewBefore = clone(current().crew);
  const switched = await w.attempt({ type: "useSetup", tabId: id, templateId: "blank" });
  assert.equal(switched.error, refused.error, "a template switch refuses the same blocked seat");
  assert.deepEqual(current().crew, crewBefore, "a refused template switch keeps the crew");
  assert.equal(workspaceBytes(work), before, "the file is byte for byte what it was");
  assert.equal(current().crew.length, 8, "the page still has all eight seats");
  assert.equal(current().setupName, "Our process");

  w.send({ type: "clearLaunchBlock", seatKey: `${id}.fixer2`, confirm: "allow this seat to launch again" });
  await w.wait(() => !(w.state().launchSafety.blocked as string[]).includes(`${id}.fixer2`), "the block is cleared");
  const generation = current().processState.crewGenerationId;
  w.send({ type: "setSetup", tabId: id, ...without("fixer2"), setupName: "Smaller" });
  await w.wait(() => current().crew.length === 7, "the smaller crew is saved");
  assert.equal(current().setupName, "Smaller");
  assert.deepEqual(current().steps.find((item: any) => item.type === "rounds").pairs[1].fixers, ["fixer1"]);
  assert.equal(current().processState.crewGenerationId, generation + 1, "different steps and seats start the process again");
  assert.equal(workspaceFile(work).projects[0].tabs.find((item: any) => item.id === id).crew.length, 7);
  assert.match((await w.attempt({ type: "setSetup", tabId: id, crew: [], lookPause: false })).error ?? "", /1 to 16 seats/);

  // Names and pictures only: the process is not restarted.
  const renamed = { crew: clone(current().crew).map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest.slot === "coder" ? { ...rest, name: "Rae" } : rest), lookPause: current().lookPause };
  w.send({ type: "setSetup", tabId: id, ...renamed });
  await w.wait(() => seatIn(current(), "coder").name === "Rae", "the rename is saved");
  assert.equal(current().processState.crewGenerationId, generation + 1, "a rename keeps the process where it is");
  assert.equal(current().processState.seats.find((item: any) => item.slotId === "coder").name, "Rae");

  // Saved setups: by name, without pictures, same name replaces, a switch uses it, a removal deletes it.
  const setupsFile = join(work.data, "config", "setups.json");
  assert.equal(existsSync(setupsFile), false, "nothing is saved yet");
  w.send({ type: "saveSetup", tabId: id, name: "My Crew!", requestId: "final-save-first" });
  await w.wait(() => w.messages.find((m) => m.type === "setupSaved" && m.requestId === "final-save-first" && m.tabId === id), "FF3 save: the first save is acknowledged");
  await w.wait(() => w.state().savedSetups.length === 1, "the setup is saved");
  const entry = w.state().savedSetups[0];
  assert.deepEqual([entry.id, entry.name, entry.kind, entry.crew.length, entry.steps.length], ["my-crew", "My Crew!", "dev", 7, 7]);
  assert.equal(entry.crew.some((item: any) => "pic" in item), false, "a saved setup keeps no pictures");
  assert.equal(JSON.parse(readFileSync(setupsFile, "utf8")).setups[0].id, "my-crew");
  assert.equal(seatIn(current(), "leader").pic, "avatars/atlas.svg", "the tab keeps its own picture");
  w.send({ type: "saveSetup", tabId: id, name: "my crew", requestId: "final-save-replace" });
  await w.wait(() => w.messages.find((m) => m.type === "setupSaved" && m.requestId === "final-save-replace" && m.tabId === id), "FF3 save: the overwrite is acknowledged separately");
  await w.wait(() => w.state().savedSetups[0]?.name === "my crew", "the replacement spelling arrives");
  const savedBefore = w.messages.filter((m) => m.type === "setupSaved").length;
  w.send({ type: "saveSetup", tabId: id, name: "my crew", requestId: "not safe!" });
  const unsafeAck = await w.wait(() => w.messages.filter((m) => m.type === "setupSaved")[savedBefore], "R4 save: an unsafe request id still gets an acknowledgement");
  assert.equal("requestId" in unsafeAck, false, "R4 save: an unsafe request id is not echoed");
  assert.equal(w.state().savedSetups.length, 1, "the same name replaces");

  w.send({ type: "useSetup", tabId: id, templateId: "blank" });
  await w.wait(() => current().setupName === "Start blank", "on the Start blank setup");
  assert.equal(seatIn(current(), "leader").pic, "avatars/atlas.svg", "the picture is carried by seat id");
  w.send({ type: "useSetup", tabId: id, setupId: "my-crew" });
  await w.wait(() => current().crew.length === 7, "back on the saved crew");
  assert.equal(current().setupName, "my crew", "the replacing save kept the newer spelling of the name");
  assert.equal(seatIn(current(), "coder").name, "Rae", "the saved crew comes back with its names");
  assert.match((await w.attempt({ type: "useSetup", tabId: id, setupId: "nope" })).error ?? "", /unknown saved setup/);

  w.send({ type: "removeSetup", setupId: "my-crew" });
  await w.wait(() => w.state().savedSetups.length === 0, "the saved setup is removed");
  assert.deepEqual(JSON.parse(readFileSync(setupsFile, "utf8")), { setups: [] });
  assert.match((await w.attempt({ type: "removeSetup", setupId: "my-crew" })).error ?? "", /unknown saved setup/);
});

test("S13 advanceStep (the page button) is refused while either of two coder runs works, and allowed once both have ended", { timeout: 180_000 }, async () => {
  const id = "p18-advance";
  const index = () => w.tab(id).processState.currentStepIndex;
  w.send({ type: "advanceStep", tabId: id });
  await w.wait(() => index() === 1, "plan -> build");
  w.send({ type: "run", tabId: id, slot: "coderA", prompt: "TEST ONLY: short run." });
  w.send({ type: "run", tabId: id, slot: "coderB", prompt: "TEST ONLY: long run." });
  await w.wait(() => w.tab(id).runs.filter((run: any) => run.status === "working").length === 2, "both runs are working");
  w.send({ type: "advanceStep", tabId: id });
  await sleep(300);
  assert.equal(index(), 1, "refused while both runs work");
  // The short Claude run ends first; the long Codex one still holds the step.
  await w.wait(() => w.tab(id).runs.find((run: any) => run.seatSlotId === "coderA")?.status === "done", "coder A's run ended", RUN_END_MS);
  assert.equal(w.tab(id).runs.find((run: any) => run.seatSlotId === "coderB").status, "working", "coder B is still working");
  w.send({ type: "advanceStep", tabId: id });
  await sleep(300);
  assert.equal(index(), 1, "still refused while one of the two works");
  await w.wait(() => w.tab(id).runs.every((run: any) => run.status !== "working"), "coder B's run ended", RUN_END_MS);
  w.send({ type: "advanceStep", tabId: id });
  await w.wait(() => index() === 2, "allowed once both have ended (build -> gate)");
  w.send({ type: "advanceStep", tabId: id });
  await w.wait(() => index() === 3, "gate -> look");
  assert.equal(w.tab(id).processState.approval.state, "pending", "the next step is the user's look");
});

test("S16 a CLI added in Settings cannot be removed while a tab or a saved setup uses it; a project can start on any template", { timeout: 120_000 }, async () => {
  // The gate server's ACP reader seat uses its CLI: the message names the seat and the tab.
  const inUse = await g.request({ type: "removeAcpCli", id: "fake-gate" });
  assert.equal(inUse.ok, false);
  assert.match(inUse.message ?? "", /Fake gate is used by Acpy \(ACP reader\) in "gate"/);

  const id = "p18-acpsaved";
  assert.deepEqual(await w.request({ type: "addAcpCli", name: "Fake saved", command: "fake-acp --scenario=basic" }), { ok: true });
  assert.deepEqual(await w.request({ type: "refreshSettings" }), { ok: true });
  w.send({ type: "updateSeat", tabId: id, slot: "coder", cli: "acp:fake-saved", model: "default", confirm: true });
  await w.wait(() => seatIn(w.tab(id), "coder").cli === "acp:fake-saved", "the coder takes the added CLI");
  w.send({ type: "saveSetup", tabId: id, name: "With acp" });
  await w.wait(() => w.state().savedSetups.some((item: any) => item.id === "with-acp"), "saved");
  w.send({ type: "updateSeat", tabId: id, slot: "coder", cli: "claude", model: "claude-sonnet-5-5[1m]" });
  await w.wait(() => seatIn(w.tab(id), "coder").cli === "claude", "the tab no longer uses it");
  const savedUse = await w.request({ type: "removeAcpCli", id: "fake-saved" });
  assert.equal(savedUse.ok, false);
  assert.match(savedUse.message ?? "", /Fake saved is used by the saved setup "With acp"/, "a saved setup keeps the CLI in use too");
  w.send({ type: "removeSetup", setupId: "with-acp" });
  await w.wait(() => !w.state().savedSetups.some((item: any) => item.id === "with-acp"), "the saved setup is removed");
  assert.deepEqual(await w.request({ type: "removeAcpCli", id: "fake-saved" }), { ok: true });

  // A new project starts on the template it names, and takes its kind.
  const folder = work.work;
  w.send({ type: "addProject", id: "newp", name: "New", folder, template: "marketing" });
  const project = await w.wait(() => w.state().projects.find((item: any) => item.id === "newp"), "the new project");
  assert.deepEqual([project.tabs[0].setupName, project.tabs[0].kind, project.tabs[0].steps.find((step: any) => step.type === "rounds").id, project.tabs[0].crew.length, project.tabs[0].lookPause], ["Marketing", "mkt", "review", 5, true]);
  assert.match((await w.attempt({ type: "addProject", id: "newq", name: "Newq", folder, template: "nope" })).error ?? "", /unknown template: nope/);
  assert.match((await w.attempt({ type: "addTab", projectId: "p18", folder, kind: "nope" })).error ?? "", /unknown kind: nope/);
});

test("S17 setSetup refuses a picture, a model or a second process runner it should not take, and leaves the file as it was", { timeout: 120_000 }, async () => {
  const id = "p18-guard";
  const plain = () => clone(w.tab(id).crew).map(({ seatKey: _k, status: _s, task: _t, runs: _r, ...rest }: any) => rest);
  const send = (change: (crew: any[]) => void) => { const crew = plain(); change(crew); return w.attempt({ type: "setSetup", tabId: id, crew, lookPause: w.tab(id).lookPause }); };
  const before = workspaceBytes(work);
  assert.match((await send((crew) => { crew[2].pic = "data:image/png;base64,AAAA"; })).error ?? "", /invalid seat pic/);
  assert.match((await send((crew) => { crew[2].model = "nope"; })).error ?? "", /invalid model or effort for coder/);
  assert.match((await send((crew) => { crew[3].orchestrates = true; })).error ?? "", /only a Planner can run the process/);
  assert.match((await send((crew) => { crew[0].advisor = "not a model"; })).error ?? "", /invalid advisor model for leader/);
  assert.equal(workspaceBytes(work), before, "four refusals, and the file is byte for byte what it was");
  const ok = await send((crew) => { crew[2].pic = "avatars/atlas.svg"; });
  assert.equal(ok.error, undefined, "a real preset picture is fine");
  await w.wait(() => seatIn(w.tab(id), "coder").pic === "avatars/atlas.svg", "the picture is saved");
});
