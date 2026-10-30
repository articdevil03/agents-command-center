// Pack 18 look-fix: Start blank on the server. B1 validateSetup takes a setup with no steps and still refuses 21; B2 the engine on no steps;
// B3 useSetup with blank, through a real server's WebSocket, on an Our process tab and a Marketing tab: the leader alone (its name kept), no
// step, the tab's own kind kept, and then the page's Advance, a chat with the leader, its crew tool and the process view all work; B4 a seat
// that runs the process on a tab with no steps is told "there is no current step" by advance_step. Fake CLIs, temp data root.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, clone, tabOf, workspaceFile, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";
import {
  TEMPLATES, validateSetup, createTabState, advanceStep, approveLook, reviewFindings, reviewClean, finishFix, selectFixer, stopAll,
  getStepBar, getStepOwners, getLeaderStatusLine, getApprovedCardLine, getSeatTaskLine, getRoundFlag, isBusy,
} from "../server/process.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const codexLeader = (name: string) => ({ slot: "leader", name, role: "Leader", cli: "codex", model: "gpt-6-sol", effort: "high", canWrite: false, isLeader: true });
const toolText = (text: string): any => { const m = /^\[tool ok: ([\s\S]*)\]$/.exec(text.trim()); assert.ok(m, `a tool result, got: ${text.slice(0, 200)}`); return JSON.parse(m[1]); };

test("B1 Start blank is the first template (the leader, no steps); a leader-only crew derives no steps whatever the look switch says, and a crew is still required", () => {
  const blank = TEMPLATES[0];
  assert.deepEqual([blank.id, blank.name, blank.kind, blank.crew.map((seat) => [seat.slot, seat.isLeader]), blank.steps.length, blank.lookPause], ["blank", "Start blank", "dev", [["leader", true]], 0, false]);
  for (const lookPause of [false, true]) assert.deepEqual(validateSetup({ crew: clone(blank.crew), lookPause }).steps, [], `a leader-only crew passes with no steps (lookPause ${lookPause})`);
  assert.deepEqual(validateSetup({ crew: clone(blank.crew), lookPause: false, steps: [{ id: "x", label: "X", type: "work", owners: ["ghost"] }] }).steps, [], "steps sent along are ignored");
  assert.throws(() => validateSetup({ crew: [], lookPause: false }), /1 to 16 seats/, "a crew is still required");
});

test("B2 the engine on a tab with no steps: every step reader and mover answers without throwing, and nothing moves", () => {
  const state = createTabState({ crew: clone(TEMPLATES[0].crew) as any, steps: [] }, { tabId: "t" });
  assert.deepEqual([state.currentStepIndex, state.selectedFixer, state.steps], [0, null, []]);
  const movers: [string, (s: typeof state) => typeof state][] = [["advanceStep", (s) => advanceStep(s)], ["advanceStep by a seat", (s) => advanceStep(s, "leader")], ["approveLook", approveLook], ["reviewFindings", reviewFindings], ["reviewClean", reviewClean], ["finishFix", finishFix], ["selectFixer", (s) => selectFixer(s, "leader")], ["stopAll", (s) => stopAll(s)]];
  for (const [name, move] of movers) {
    const next = move(state);
    assert.deepEqual({ step: next.currentStepIndex, steps: next.steps, approval: next.approval, phase: next.phase, round: next.round }, { step: 0, steps: [], approval: state.approval, phase: state.phase, round: 1 }, `${name} leaves a tab with no steps where it was`);
  }
  assert.deepEqual([getStepBar(state), getStepOwners(state), getSeatTaskLine(state, "leader"), getRoundFlag(state), isBusy(state)], [[], [], "", null, false]);
  assert.equal(getLeaderStatusLine(state), "Idle · Ready");
  assert.equal(getApprovedCardLine(state), null);
  assert.equal(getApprovedCardLine({ ...state, approval: { state: "approved", reviewWaits: false } }), "Waiting for the next step.", "an approved look with no step left answers in words");
});

let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    fakeLeader: true,
    // codex.cmd is the fake planner (test/fake-planner-cli.cjs): it runs <tab folder name>.plan.json from <temp>/plans against the real bridge.
    extra: ({ temp, bin, work }) => {
      mkdirSync(join(temp, "plans"), { recursive: true });
      mkdirSync(join(work, "b-orch"), { recursive: true });
      writeFileSync(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${resolve("test/fake-planner-cli.cjs")}" "%~dp0..\\plans"\r\nexit /b 0\r\n`);
    },
    tabs: (work) => [
      tabOf("b-dev", work, config.templateCopy("our-process"), (setup) => { setup.crew[0] = codexLeader("Ada"); }),
      { ...tabOf("b-mkt", work, config.templateCopy("marketing"), (setup) => { setup.crew[0] = { ...codexLeader("Mia"), role: "Leads marketing" }; }), kind: "mkt" },
      { id: "b-orch", name: "b-orch", kind: "dev", folder: join(work, "b-orch"), setupName: "Runner", lookPause: false, steps: [],
        crew: [codexLeader("Lee"), { slot: "planner", name: "Sage", role: "Planner", cli: "codex", model: "gpt-6-sol", effort: "high", canWrite: false, isLeader: false, orchestrates: true },
          { slot: "coder", name: "Sonny", role: "Coder", cli: "codex", model: "gpt-6-sol", effort: "high", canWrite: true, isLeader: false }] },
    ],
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

test("B3 useSetup with Start blank on an Our process tab and on a Marketing tab: the leader alone with its name, no step, the kind kept; Advance, a chat, the crew tool and the process view all work", { timeout: 120_000 }, async () => {
  for (const [id, kind, name] of [["b-dev", "dev", "Ada"], ["b-mkt", "mkt", "Mia"]] as const) {
    assert.equal(c.tab(id).kind, kind, `control: ${id} starts as ${kind}`);
    assert.deepEqual(await c.attempt({ type: "useSetup", tabId: id, templateId: "blank" }), {}, `${id}: the switch is taken`);
    const tab = await c.wait(() => c.tab(id).setupName === "Start blank" ? c.tab(id) : undefined, `${id} is on Start blank`);
    const shown = { kind: tab.kind, seats: tab.crew.map((seat: any) => [seat.slot, seat.name, seat.isLeader]), steps: tab.steps, bar: tab.derived.stepBar };
    console.log(`B3 ${id}: ${JSON.stringify(shown)}`);
    assert.deepEqual(shown, { kind, seats: [["leader", name, true]], steps: [], bar: [] }, `${id}: one seat (the leader, its name kept), no step, its kind kept`);
    const saved = workspaceFile(srv).projects[0].tabs.find((item: any) => item.id === id);
    assert.deepEqual([saved.kind, saved.setupName, saved.crew.length, saved.steps], [kind, "Start blank", 1, []], `${id}: and so on disk`);
    // The page's Advance on a tab with no step: no error, nothing moves.
    assert.deepEqual(await c.attempt({ type: "advanceStep", tabId: id }), {});
    assert.equal(c.tab(id).processState.currentStepIndex, 0);
    // A chat with the leader, then its crew tool: the crew, no steps, and where the process stands.
    await c.chat(id, "hello on a blank tab");
    const status = toolText(await c.chat(id, JSON.stringify([{ tool: "get_crew_status" }])));
    assert.deepEqual([status.crew.map((seat: any) => seat.slot), status.steps], [["leader"], []]);
    assert.deepEqual(status.process, { stepId: null, stepLabel: null, stepType: null, phase: "review", round: 1, look: "none", orchestrator: null });
  }
  assert.equal(c.messages.filter((m) => m.type === "error").length, 0, "no error reached the page");
});

test("B4 a seat that runs the process cannot be on a tab with no steps (a Planner makes steps), and advance_step names the real current step when it is given a stale one", { timeout: 120_000 }, async () => {
  const id = "b-orch", plans = join(srv.temp, "plans"), result = join(plans, `${id}.result.json`);
  assert.deepEqual(c.tab(id).steps.map((step: any) => step.id), ["plan", "build", "gate", "review", "final", "ship"], "the stale empty steps in the file were replaced by the derived ones");
  writeFileSync(join(plans, `${id}.plan.json`), JSON.stringify([{ call: "advance_step", args: { fromStepId: "brief" } }, { call: "get_crew_status" }]));
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: run the plan." });
  const calls = await c.wait(() => { try { const done = existsSync(result) && JSON.parse(readFileSync(result, "utf8")); return done?.length >= 2 ? done : undefined; } catch { return undefined; } }, `${id}: the planner made its two calls`, 60_000);
  console.log(`B4 advance_step: ${calls[0].text}`);
  assert.equal(calls[0].isError, true);
  const refused = JSON.parse(calls[0].text);
  assert.deepEqual([refused.changed, refused.reason, refused.stepBar.length], [false, 'the current step is "plan", not "brief"', 6]);
  const status = JSON.parse(calls[1].text);
  assert.deepEqual([status.steps.map((step: any) => step.id), status.process.stepId, status.process.orchestrator], [["plan", "build", "gate", "review", "final", "ship"], "plan", "planner"]);
  await c.wait(() => c.runEnds(id) >= 1, `${id}: the planner run ended`, RUN_END_MS);
});
