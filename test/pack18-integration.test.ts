// Pack 18, Block 4: end to end, through real servers with fake CLIs on PATH (never the repo's own config/).
// I1 a real Run on a Claude planner builds a command with --advisor and the crew-tool flags, I2 a real Run on an ACP coder (the fake agent): done, log saved, Stop works, the per-tab budget counts it,
// I3 a leader's launch_seat on an ACP seat in Ask mode asks first, I4 a server started on an old-format file keeps it until the next write, then the new shape and the backup are on disk,
// I5 the main one: a fake planner CLI reads CC_CREW_TOKEN and calls the real bridge (3 parallel launch_seat answered in Ask mode, wait_for_runs, advance_step only after all three end), then Stop gives 401.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importWithTempDataRoot } from "./temp-root.ts";
import { boot, client, tabOf, workspaceBytes, workspaceFile, sleep, RUN_END_MS, type Client, type Server } from "./pack18-harness.ts";

const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const OUR = config.templateCopy("our-process");
const FAKE_ACP = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));
const FAKE_PLANNER = fileURLToPath(new URL("./fake-planner-cli.cjs", import.meta.url));

const seat = (slot: string, name: string, role: string, cli: string, model: string, effort: string, canWrite: boolean, extra: Record<string, unknown> = {}) => ({ slot, name, role, cli, model, effort, canWrite, isLeader: slot === "leader", ...extra });
const read = (path: string): any => { for (let i = 0; i < 5; i++) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* a write in progress */ } } return undefined; };

// The fake CLIs of this file. claude records its arguments; codex is the fake planner; fake-acp runs the fake ACP agent (the server spawns it as a worker, with no test seam).
const fakeClis = ({ temp, bin }: { temp: string; bin: string }) => {
  writeFileSync(join(bin, "claude.cmd"), `@echo off\r\necho ran> "%CD%\\run-wrote-claude.txt"\r\necho %*> "%CD%\\claude-args.txt"\r\nif defined FAKE_SLEEP_CLAUDE ping -n %FAKE_SLEEP_CLAUDE% 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  writeFileSync(join(bin, "opencode.cmd"), `@echo off\r\necho ran> "%CD%\\run-wrote-opencode.txt"\r\nif defined FAKE_SLEEP_OPENCODE ping -n %FAKE_SLEEP_OPENCODE% 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  writeFileSync(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_PLANNER}" "%~dp0..\\plans"\r\nexit /b 0\r\n`);
  writeFileSync(join(bin, "fake-acp.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_ACP}" %*\r\n`);
  mkdirSync(join(temp, "plans"), { recursive: true });
};

let srv: Server, c: Client;
before(async () => {
  srv = await boot({
    fakeLeader: true, env: { FAKE_SLEEP_CLAUDE: "4", FAKE_SLEEP_OPENCODE: "9" }, extra: fakeClis,
    acpClis: [
      { id: "fake-int", name: "Fake int", program: "fake-acp", args: ["--scenario=basic"] },
      { id: "fake-hold", name: "Fake hold", program: "fake-acp", args: ["--scenario=cancel"] },
    ],
    tabs: (work) => {
      for (const id of ["i-adv", "i-acp", "i-ask", "i-e2e"]) mkdirSync(join(work, id), { recursive: true });
      const acpCrew = (leader: any) => [leader, seat("coder", "Kay", "Coder", "acp:fake-int", "default", "default", true), seat("holder", "Hal", "Helper", "acp:fake-hold", "default", "default", true)];
      const codexLeader = seat("leader", "Atlas", "Leader", "codex", "gpt-6-sol", "high", false);
      return [
        tabOf("i-adv", work, OUR),
        { id: "i-acp", name: "i-acp", kind: "dev", folder: join(work, "i-acp"), setupName: "Acp", crew: acpCrew(seat("leader", "Atlas", "Leader", "claude", "claude-opus-5-5[1m]", "medium", false)), lookPause: false, steps: [] },
        { id: "i-ask", name: "i-ask", kind: "dev", folder: join(work, "i-ask"), setupName: "Ask", crew: [codexLeader, seat("acpCoder", "Ace", "Coder", "acp:fake-int", "default", "default", true)], lookPause: false, steps: [] },
        { id: "i-e2e", name: "i-e2e", kind: "dev", folder: join(work, "i-e2e"), setupName: "End to end", crew: [
            codexLeader,
            seat("planner", "Sage", "Planner", "codex", "gpt-6-sol", "high", false, { orchestrates: true }),
            seat("coderA", "Ann", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true),
            seat("coderB", "Ben", "Coder", "opencode", "opencode/mimo-v2.6-flash-free", "max", true),
            seat("coderC", "Cy", "Coder", "claude", "claude-sonnet-5-5[1m]", "medium", true),
            seat("reviewer", "Rae", "Reviewer", "claude", "claude-opus-5-5[1m]", "medium", false),
          ], lookPause: true, steps: [] },
      ];
    },
  });
  c = await client(srv);
});
after(async () => { c?.close(); await srv?.stop(); });

const logFiles = (prefix: string, ext: string) => readdirSync(join(srv.data, "logs")).filter((name) => name.startsWith(prefix) && name.endsWith(ext));
const mode = async (id: string, value: string) => assert.deepEqual(await c.request({ type: "setPermissionMode", tabId: id, mode: value, confirm: true }), { ok: true });
const stamps = (id: string): any[] => (read(join(srv.data, "config", "launch-safety.json"))?.timestamps ?? []).filter((s: any) => s.tabId === id);
const ended = (id: string, count: number, ms = RUN_END_MS) => c.wait(() => c.runEnds(id) >= count, `${id}: ${count} runs ended`, ms);
const bridgeStatus = async (url: string, token: string) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status;

test("I1 a real Run on a Claude planner that runs the process builds its command with --advisor and the crew-tool flags, no token on it, and the crew-tools file is gone after the run", { timeout: 90_000 }, async () => {
  const id = "i-adv";
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: plan." });
  await ended(id, 1);
  const argsFile = join(srv.work, "claude-args.txt"); // tabOf puts this tab in the work folder itself
  await c.wait(() => existsSync(argsFile), "the fake claude recorded its arguments");
  const args = readFileSync(argsFile, "utf8");
  assert.match(args, /--model claude-opus-5-5\[1m\]/);
  assert.match(args, / --advisor claude-fable-5-1 /, "the planner's own advisor is on the command");
  assert.match(args, /--permission-mode default --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/, "read-only, and not plan mode (plan mode blocks the crew tools)");
  assert.match(args, /--mcp-config \S+ --allowedTools mcp__tab-crew/);
  const status = c.messages.find((m) => m.type === "runFinish" && m.tabId === id);
  assert.equal(status.outcome, "done");
  assert.deepEqual(logFiles(`${id}.planner-`, ".mcp.json"), [], "the crew-tools file (it holds the token) is deleted when the run ends");
  const bridgeToken = /Bearer ([A-Za-z0-9._~+-]{8,256})/.exec(args)?.[1];
  assert.equal(bridgeToken, undefined, "no bearer token on the command line");
  console.log(`I1 command: ${args.trim().replace(/"Read the file[^"]*"/, "<brief>").slice(0, 400)}`);
});

test("I2 a real Run on an ACP coder: the brief reaches the agent, the run is done, its log is saved, a held run stops on Stop, and the per-tab budget counted both", { timeout: 120_000 }, async () => {
  const id = "i-acp";
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "coder", prompt: "TEST ONLY: acp work" });
  const finish = await c.wait(() => c.messages.find((m) => m.type === "runFinish" && m.tabId === id && m.seatKey === "i-acp.coder"), "the ACP coder run is done", RUN_END_MS);
  assert.equal(finish.outcome, "done", "a normal end of the prompt is done");
  const [log] = logFiles("i-acp.coder-", ".log");
  assert.ok(log, "the run's log is saved");
  const text = readFileSync(join(srv.data, "logs", log), "utf8");
  assert.ok(text.includes("Hello from the fake. You said: Your role: Coder.") && text.includes("TEST ONLY: acp work"), `the log holds the agent's text, the Coder instruction first: ${text.slice(0, 300)}`);
  assert.equal(text.split("Your role: Coder.").length - 1, 1, "the role instruction is there once");
  // The held run: Stop ends it as stopped, never as done.
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "holder", prompt: "TEST ONLY: hold" });
  await c.wait(() => c.tab(id).runs.find((run: any) => run.seatSlotId === "holder" && run.status === "working"), "the held run is working");
  await c.wait(() => c.messages.find((m) => m.type === "output" && m.seatKey === "i-acp.holder" && m.chunk.includes("working")), "the held agent streamed working");
  c.send({ type: "stopSeat", tabId: id, slot: "holder" });
  const stop = await c.wait(() => c.messages.find((m) => m.type === "runStop" && m.tabId === id && m.seatKey === "i-acp.holder"), "the held run is stopped", RUN_END_MS);
  assert.equal(stop.outcome, "stopped");
  assert.equal(c.messages.some((m) => m.type === "runFinish" && m.seatKey === "i-acp.holder"), false, "a stopped run is never reported done");
  assert.equal(stamps(id).length, 2, "the per-tab budget counted each of the two launches");
  console.log(`I2: coder=${finish.outcome} holder=${stop.outcome}; budget stamps on the tab=${stamps(id).length}; log=${log}`);
});

test("I3 a leader's launch_seat on an ACP seat in Ask mode asks first (naming the leader), starts nothing until it is answered, then runs the ACP seat to done", { timeout: 120_000 }, async () => {
  const id = "i-ask";
  await mode(id, "ask");
  await c.chat(id, "start the leader");
  const reply = c.chat(id, JSON.stringify([{ tool: "launch_seat", args: { slot: "acpCoder", brief: "TEST ONLY: acp build after you say yes" } }]));
  const item = await c.wait(() => c.tab(id).pendingApprovals?.[0], "the leader's approval card");
  assert.deepEqual(item.askedBy, { kind: "leader", slot: "leader", name: "Atlas" });
  assert.equal(item.tool, "launch:Ace");
  assert.equal(c.tab(id).runs.length, 0, "nothing is started before the user answers");
  assert.deepEqual(await c.request({ type: "answerApproval", tabId: id, approvalId: item.approvalId, allow: true }), { ok: true });
  assert.match((await reply).trim(), /^\[tool ok: launched "i-ask\.acpCoder" as run [0-9a-f-]{36}\]$/);
  const finish = await c.wait(() => c.messages.find((m) => m.type === "runFinish" && m.tabId === id && m.seatKey === "i-ask.acpCoder"), "the ACP seat's run is done", RUN_END_MS);
  assert.equal(finish.outcome, "done");
  await c.wait(() => c.tab(id).pendingApprovals.length === 0, "the answered approval leaves the page");
  assert.equal(c.tab(id).pendingApprovals.length, 0);
  console.log(`I3: approval ${item.tool} asked by ${item.askedBy.name}; run ${finish.outcome}`);
});

test("I5 a fake planner CLI reads CC_CREW_TOKEN and calls the real bridge: Ask mode is answered for 3 parallel launch_seat, the per-tab budget counts each, advance_step succeeds only after all three end, and Stop on the planner gives 401", { timeout: 180_000 }, async () => {
  const id = "i-e2e", plans = join(srv.temp, "plans");
  await mode(id, "ask");
  writeFileSync(join(plans, `${id}.plan.json`), JSON.stringify([
    { parallel: ["coderA", "coderB", "coderC"].map((slot, i) => ({ call: "launch_seat", args: { slot, brief: `TEST ONLY: build ${slot}` }, save: String(i) })) },
    { call: "advance_step", args: { fromStepId: "plan" } },                                                     // 3: plan -> build (the planner's own run is excepted)
    { call: "advance_step", args: { fromStepId: "build" } },                                                    // 4: all three coders work
    { call: "wait_for_runs", args: { runIds: ["{{RUN:0}}", "{{RUN:1}}", "{{RUN:2}}"], maxWaitSeconds: 60 } },  // 5
    { call: "advance_step", args: { fromStepId: "build" } },                                                    // 6: all three ended (build -> gate)
    { sleep: 120_000 },                                                                                         // the planner stays alive for the Stop below
  ]));
  c.send({ type: "run", confirmBusy: true, tabId: id, slot: "planner", prompt: "TEST ONLY: run the plan." });
  // Ask mode: three approvals, each naming the planner; the user answers all of them.
  await c.wait(() => c.tab(id).pendingApprovals?.length === 3, "three approval cards from the planner", 30_000);
  const cards = [...c.tab(id).pendingApprovals];
  assert.deepEqual(cards.map((card: any) => card.askedBy), Array(3).fill({ kind: "seat", slot: "planner", name: "Sage" }));
  assert.deepEqual(cards.map((card: any) => card.tool).sort(), ["launch:Ann", "launch:Ben", "launch:Cy"]);
  assert.equal(c.tab(id).runs.filter((run: any) => run.seatSlotId !== "planner").length, 0, "no coder is started before the user answers");
  for (const card of cards) assert.deepEqual(await c.request({ type: "answerApproval", tabId: id, approvalId: card.approvalId, allow: true }), { ok: true });
  const resultFile = join(plans, `${id}.result.json`);
  await c.wait(() => (read(resultFile) ?? []).length >= 7, "the planner made its seven calls", 90_000);
  const out = read(resultFile).map((r: any) => ({ ...r, body: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }));
  assert.deepEqual(out.slice(0, 3).map((r: any) => r.isError), [false, false, false], out.slice(0, 3).map((r: any) => r.text).join(" | "));
  assert.equal(out[3].body.changed, true, `plan -> build: ${out[3].text}`);
  assert.equal(out[4].body.changed, false, "refused while the three coders work");
  assert.match(out[4].body.reason, /Ann, Ben and Cy still have runs working on Build|still have runs working on Build/);
  assert.equal(out[5].body.allEnded, true, "wait_for_runs returned only when all three had ended");
  assert.deepEqual(out[5].body.runs.map((r: any) => r.status), ["done", "done", "done"]);
  assert.equal(out[6].body.changed, true, `allowed once all three ended: ${out[6].text}`);
  assert.equal(out[6].body.stepBar.find((s: any) => s.state === "current").stepId, "gate");
  // The budget counted the planner's own Run and each of its three launches; the notices name the planner.
  assert.equal(stamps(id).length, 4, "1 Run + 3 launches");
  await c.wait(() => c.state().launchSafety.notices.filter((n: any) => n.seatId.startsWith(`${id}.`) && n.seatId !== `${id}.planner`).length >= 3, "the three coder notices arrive");
  const notices = c.state().launchSafety.notices.filter((n: any) => n.seatId.startsWith(`${id}.`) && n.seatId !== `${id}.planner`);
  assert.deepEqual(notices.map((n: any) => n.source), Array(3).fill("Sage"));
  // Stop on the planner: its entry answered a moment ago and is dead the moment Stop is sent.
  const { url, token } = read(join(plans, `${id}.session.json`));
  assert.equal(await bridgeStatus(url, token), 200, "the planner's entry answers while it runs");
  c.send({ type: "stopSeat", tabId: id, slot: "planner" });
  const deadline = Date.now() + 5000;
  let status = 200;
  while (status !== 401 && Date.now() < deadline) { status = await bridgeStatus(url, token); if (status !== 401) await sleep(50); }
  assert.equal(status, 401, "after Stop the planner's token gets 401");
  await ended(id, 4);
  console.log(`I5: approvals=${cards.length} stamps=${stamps(id).length} wait=${out[5].body.allEnded} refused="${out[4].body.reason}" -> ${out[6].body.stepBar.find((s: any) => s.state === "current").stepId}; after Stop: ${status}`);
});

test("I4 a server started on an old-format workspaces file keeps it byte for byte until the next write; that write puts the new shape and the one-time backup on disk", { timeout: 90_000 }, async () => {
  const classic = config.templateCopy("classic-main");
  const b = await boot({
    tabs: (work) => [{ id: "old-dev", name: "Old dev", kind: "dev", process: "main", folder: work, crew: classic.crew.map((member) => ({ slot: member.slot, name: `Old ${member.slot}`, cli: member.cli, model: member.model, effort: member.effort })) }],
  });
  const bc = await client(b);
  try {
    const original = workspaceBytes(b);
    const before = workspaceFile(b).projects[0].tabs[0];
    assert.equal(before.process, "main", "the file on disk is in the old shape");
    assert.equal("steps" in before, false);
    const tabIn = () => bc.tab("old-dev");
    assert.equal(tabIn().steps.length, classic.steps.length, "the page is served the migrated tab");
    assert.equal(workspaceBytes(b), original, "starting the server wrote nothing");
    assert.equal(existsSync(join(b.data, "config", "workspaces.before-setups.json")), false, "no backup before the first write");
    const slot = classic.crew.find((member) => !member.isLeader)!.slot;
    bc.send({ type: "updateSeat", tabId: "old-dev", slot, name: "Renamed" });
    await bc.wait(() => bc.tab("old-dev").crew.find((m: any) => m.slot === slot)?.name === "Renamed", "the new shape is written");
    const after = workspaceFile(b).projects[0].tabs[0];
    assert.equal("process" in after, false, "no process id any more");
    assert.deepEqual(after.steps, classic.steps, "the typed steps of the old Main Crew");
    assert.equal(after.crew.find((member: any) => member.slot === slot).name, "Renamed");
    assert.deepEqual(after.crew.filter((member: any) => member.slot !== slot).map((member: any) => member.name), classic.crew.filter((member) => member.slot !== slot).map((member) => `Old ${member.slot}`), "every other seat keeps the name the user saved");
    const backup = join(b.data, "config", "workspaces.before-setups.json");
    assert.ok(existsSync(backup), "the one-time backup is on disk after the first write");
    assert.equal(readFileSync(backup, "utf8"), original, "the backup is the old file, byte for byte");
    console.log(`I4: ${classic.crew.length} seats, ${after.steps.length} steps; backup ${original.length} bytes`);
  } finally { bc.close(); await b.stop(); }
});
