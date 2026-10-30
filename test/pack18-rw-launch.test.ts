// Pack 18 rework, through a real server with fake CLIs: D6 the role's built-in instruction reaches every run once (the user's Run, a prompt that already starts with it,
// the leader's launch_seat and a planner's launch_seat), D8 only a Researcher gets the web (Claude: WebSearch and WebFetch allowed; Codex: its --search switch).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot, client, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";
import { tabIn, fakeClis, orchKit, seat } from "./pack18-orch-harness.ts";
import { ROLES } from "../server/process.ts";

const instruction = (role: string): string => ROLES.find((item) => item.name === role)!.instruction;
const CODER = instruction("Coder");
const leader = seat("leader", "Atlas", "Leader", "codex", "gpt-6-sol", "high", false);
const reader = (slot: string, role: string, cli = "claude", model = "claude-opus-5-5[1m]") => seat(slot, slot, role, cli, model, cli === "codex" ? "low" : "medium", false);
const plainTab = (work: string, id: string, crew: object[]) => ({ id, name: id, kind: "dev", folder: join(work, id), setupName: "Launch", lookPause: false, steps: [], crew });

let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    fakeLeader: true,
    extra: (paths) => {
      fakeClis(paths);
      // Both CLIs record the arguments they were started with; Claude also prints its brief, Codex runs the fake planner.
      writeFileSync(join(paths.bin, "claude.cmd"), `@echo off\r\necho ran> "%CD%\\run-wrote-claude.txt"\r\necho %*> "%CD%\\claude-args.txt"\r\ntype "%CC_BRIEF_PATH%"\r\nexit /b 0\r\n`);
      writeFileSync(join(paths.bin, "codex.cmd"), `@echo off\r\necho %*> "%CD%\\codex-args.txt"\r\nnode "%~dp0..\\fake-planner.cjs"\r\nexit /b 0\r\n`);
    },
    tabs: (work) => {
      for (const id of ["l-cod", "l-web", "l-webc", "l-rev"]) mkdirSync(join(work, id), { recursive: true });
      return [
        tabIn(work, "l-orch"),
        plainTab(work, "l-cod", [leader, seat("coder", "Cody", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true), seat("helper", "Hal", "Helper", "claude", "claude-sonnet-5-5[1m]", "medium", true)]),
        plainTab(work, "l-web", [leader, reader("researcher", "Researcher")]),
        plainTab(work, "l-webc", [leader, reader("researcher", "Researcher", "codex", "gpt-6-sol")]),
        plainTab(work, "l-rev", [leader, reader("reviewer", "Reviewer")]),
      ];
    },
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const kit = orchKit(() => ({ srv, c }));
const briefs = (seatKey: string): string[] => readdirSync(join(srv.data, "logs")).filter((name) => name.startsWith(`${seatKey}-`) && name.endsWith(".brief.txt")).sort().map((name) => readFileSync(join(srv.data, "logs", name), "utf8"));
const once = (text: string, part: string) => text.split(part).length - 1;
const runAndWait = async (tabId: string, slot: string, prompt: string) => {
  const ends = c.runEnds(tabId);
  c.send({ type: "run", confirmBusy: true, tabId, slot, prompt });
  await c.wait(() => c.runEnds(tabId) > ends, `${tabId}.${slot} ended`, RUN_END_MS);
};

test("D6 a run starts with its role's instruction exactly once, whoever launches it; a Helper's run is the prompt alone", { timeout: 180_000 }, async () => {
  const id = "l-cod";
  await runAndWait(id, "coder", "TEST ONLY: build it");
  assert.equal(briefs(`${id}.coder`)[0], `${CODER}\n\nTEST ONLY: build it`, "the user's Run: the instruction, a blank line, the prompt");
  // A prompt that already starts with the instruction (a relaunch of an earlier brief) is not given it a second time.
  await runAndWait(id, "coder", `${CODER}\n\nTEST ONLY: build it again`);
  const second = briefs(`${id}.coder`)[1];
  assert.equal(once(second, CODER), 1, `the instruction is there once: ${second.slice(0, 300)}`);
  assert.ok(second.endsWith("TEST ONLY: build it again"));
  // A Helper has no instruction.
  await runAndWait(id, "helper", "TEST ONLY: help");
  assert.equal(briefs(`${id}.helper`)[0], "TEST ONLY: help", "a Helper's brief is the prompt, untouched");
  // The leader's launch_seat goes through the same launch: Codex leader on the fake app-server, Full access, the tool called without a model.
  await kit.mode(id, "bypass");
  await c.chat(id, "start the leader");
  const seen = c.messages.filter((m) => m.type === "testGatedLaunchResult").length;
  c.send({ type: "testGatedLaunch", tabId: id, slot: "coder", brief: "TEST ONLY: from the leader" });
  const launched = await c.wait(() => c.messages.filter((m) => m.type === "testGatedLaunchResult")[seen], "the leader's launch result");
  assert.equal(launched.ok, true, JSON.stringify(launched));
  await c.wait(() => briefs(`${id}.coder`).length === 3, "the leader's run has its brief");
  assert.equal(briefs(`${id}.coder`)[2], `${CODER}\n\nTEST ONLY: from the leader`, "the leader's launch_seat: the same instruction, once");
  await c.wait(() => c.runEnds(id) >= 4, "the leader's run ended", RUN_END_MS);

  // A planner's launch_seat: the fake planner CLI calls the real bridge.
  const orch = "l-orch";
  await kit.mode(orch, "bypass");
  kit.runPlanner(orch, [{ call: "launch_seat", args: { slot: "coderA", brief: "TEST ONLY: from the planner" }, save: "a" }, { call: "wait_for_runs", args: { runIds: ["{{RUN:a}}"], maxWaitSeconds: 30 } }]);
  await kit.planDone(orch, 2);
  assert.equal(briefs(`${orch}.coderA`)[0], `${CODER}\n\nTEST ONLY: from the planner`, "a planner's launch_seat: the same instruction, once");
  const planner = briefs(`${orch}.planner`)[0];
  assert.equal(planner, `${instruction("Planner")}\n\nTEST ONLY: run the plan.`, "and the planner's own run starts with the Planner instruction");
  console.log(`D6 briefs: user=${JSON.stringify(briefs(`${id}.coder`)[0].slice(0, 40))}… leader and planner paths carry it once`);
});

test("D8 only a Researcher is allowed the web: Claude gets WebSearch and WebFetch, Codex its --search switch; a Reviewer gets neither", { timeout: 120_000 }, async () => {
  await runAndWait("l-web", "researcher", "TEST ONLY: look it up");
  await runAndWait("l-webc", "researcher", "TEST ONLY: look it up");
  await runAndWait("l-rev", "reviewer", "TEST ONLY: review");
  const args = (tab: string, cli: string) => readFileSync(join(srv.work, tab, `${cli}-args.txt`), "utf8");
  const claudeWeb = args("l-web", "claude"), codexWeb = args("l-webc", "codex"), reviewer = args("l-rev", "claude");
  assert.match(claudeWeb, /--permission-mode plan .*--allowedTools WebSearch,WebFetch/, "a read-only Claude Researcher keeps plan mode and is allowed the two web tools");
  assert.match(codexWeb, /^--search exec /, "a Codex Researcher starts Codex with its live web search switch");
  assert.doesNotMatch(reviewer, /WebSearch|WebFetch|--search/, "a Reviewer on the same CLI gets no web");
  assert.match(reviewer, /--permission-mode plan/, "control: it is the same read-only command otherwise");
  assert.equal(briefs("l-web.researcher")[0].startsWith(instruction("Researcher")), true, "and the Researcher instruction names the web");
  console.log(`D8 claude researcher: ${claudeWeb.trim().replace(/"Read the file[^"]*"/, "<brief>").slice(0, 200)}`);
  console.log(`D8 codex researcher: ${codexWeb.trim().replace(/"Read the file[^"]*"/, "<brief>").slice(0, 120)}`);
});
