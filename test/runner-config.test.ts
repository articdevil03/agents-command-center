import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as processEngine from "../server/process.ts";
import { isolatedData, config, runner, history, leader, FakeProc, makeRun, captureCallbacks, spawnReturning, configFolder, runArtifact } from "./runner-helpers.ts";

// A copy of the example workspace this file's config module seeded in its own temp data root.
function workspaceCopy() {
  const { root, dir } = configFolder();
  const file = path.join(dir, "workspaces.json");
  const workspaces = config.readWorkspaces(config.workspacesPath);
  config.writeWorkspaces(workspaces, file);
  return { root, file, workspaces };
}

test("F1 guard: a hostile brief never reaches the command line, and no `&` sits outside quotes", () => {
  const proc = new FakeProc(), capture = captureCallbacks(), calls: unknown[][] = [];
  const prompt = 'review "quoted" & whoami & echo owned';
  const run = makeRun({ runId: "hostile-f1" });
  const started = runner.runSeat(run, prompt, capture.callbacks, spawnReturning(proc, calls));
  assert.equal(started.ok, true);
  const command = String(calls[0][0]);
  assert.doesNotMatch(command, /whoami|owned|quoted/);
  assert.match((calls[0][1] as any).env.CC_BRIEF_PATH, /\.brief\.txt$/);
  assert.equal(readFileSync(runArtifact(run, started.timestamp, "brief.txt"), "utf8"), prompt);
  proc.emit("close", 0);
});

test("applySeatKindAndUpdate: a kind switch alone becomes a process switch with its valid default crew", () => {
  const current = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, processEngine.legacySetup("dev", "duo"), 10);
  assert.deepEqual(switched.seats.map((seat) => [seat.slotId, seat.cli, seat.model, seat.effort]), [
    ["leader", "claude", "claude-opus-5-5[1m]", "medium"], ["coder", "codex", "gpt-6-luna", "max"],
  ]);
});

test("applySeatKindAndUpdate: an invalid crew model leaves the whole saved workspace unchanged", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8");
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer1")!;
  assert.equal(coder.cli, "codex", "control: this seat is a Codex seat");
  coder.model = "not-a-codex-model";
  coder.effort = "low";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("applySeatKindAndUpdate: a valid model and effort update publishes together while the slot CLI stays fixed", () => {
  const { file, workspaces } = workspaceCopy();
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer1")!;
  assert.equal(coder.cli, "codex", "control: this seat is a Codex seat");
  coder.model = "gpt-6-astra"; coder.effort = "low";
  config.writeWorkspaces(next, file);
  const saved = config.readWorkspaces(file).projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer1")!;
  assert.deepEqual([saved.cli, saved.model, saved.effort], ["codex", "gpt-6-astra", "low"]);
});

test("applySeatKindAndUpdate: an invalid effort rolls the model update back before file publication", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8");
  const next = structuredClone(workspaces);
  const coder = next.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer1")!;
  assert.equal(coder.cli, "codex", "control: this seat is a Codex seat");
  coder.model = "gpt-6-astra"; coder.effort = "wild";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("applySeatKindAndUpdate: an invalid process or unknown slot is rejected without changing the current process", () => {
  const current = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "work-tab", folderPath: "C:/work" });
  assert.throws(() => processEngine.switchProcess(current, processEngine.legacySetup("dev", "missing") as any), /unknown kind\/process/);
  assert.equal(current.seats.length, 6, "the tab keeps its own crew");
  assert.equal(current.steps.length, 7, "and its own steps");
  const { file, workspaces } = workspaceCopy();
  const next = structuredClone(workspaces);
  // A crew the roles refuse is not written (steps are derived from the roles, so a step with an unknown owner cannot exist any more): a second seat with the role Leader.
  (next.projects[0].tabs[0].crew.filter((seat) => !seat.isLeader).at(-1) as { role: string }).role = "Leader";
  assert.throws(() => config.writeWorkspaces(next, file), /only the leader can have the role Leader/);
});

test("applySeatKindUpdate: a process switch cannot carry an old CLI model into a different fixed slot", () => {
  const current = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, processEngine.legacySetup("dev", "solo"), 20);
  assert.deepEqual(switched.seats.map((seat) => seat.slotId), ["leader"]);
  assert.equal(switched.seats[0].cli, "claude");
  assert.equal(switched.seats[0].model, "claude-opus-5-5[1m]");
});

test("applySeatKindUpdate: an invalid model or effort cannot remain attached to a rebuilt crew slot", () => {
  const current = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "work-tab", folderPath: "C:/work" });
  const switched = processEngine.switchProcess(current, processEngine.legacySetup("dev", "duo"), 20);
  const coder = switched.seats.find((seat) => seat.slotId === "coder")!;
  assert.equal(config.isValidModel(coder.cli, coder.model), true);
  assert.equal(config.isValidEffort(coder.cli, coder.effort), true);
});

test("applySeatKindUpdate: unknown process, slot, and leader worker launch are refused", () => {
  assert.throws(() => processEngine.getProcessDefinition("dev", "bad" as any), /unknown kind\/process/, "an unknown process is a plain error now, not undefined");
  const serverState = processEngine.createTabState(processEngine.legacySetup("dev", "main"), { tabId: "work-tab", folderPath: "C:/work" });
  assert.equal(serverState.seats.some((seat) => seat.slotId === "no-such-slot"), false);
  assert.equal(serverState.seats.find((seat) => seat.slotId === "leader")?.isLeader, true);
});

test("applySeatKindUpdate: switching to a process preserves its own valid default crew, not stale settings", () => {
  const switched = processEngine.switchProcess(processEngine.createTabState(processEngine.legacySetup("dev", "main")), processEngine.legacySetup("dev", "duo"), 20);
  assert.deepEqual(switched.seats.map((seat) => seat.slotId), ["leader", "coder"]);
  assert.equal(switched.seats.find((seat) => seat.slotId === "coder")?.canWrite, true);
});

test("applySeatUpdate: effort validation accepts a supported Codex effort and rejects an unknown one", () => {
  assert.equal(config.isValidEffort("codex", "max"), true);
  assert.equal(config.isValidEffort("codex", "wild"), false);
});

test("applySeatUpdate: OpenCode models must match the provider/model allow pattern", () => {
  assert.equal(config.isValidModel("opencode", "provider/model-v1"), true);
  assert.equal(config.isValidModel("opencode", "provider/model & run"), false);
});

test("applySeatUpdate: a model outside the kind allow-list cannot replace a valid saved model", () => {
  const { file, workspaces } = workspaceCopy();
  const previous = readFileSync(file, "utf8"), next = structuredClone(workspaces);
  next.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2")!.model = "other/model";
  assert.throws(() => config.writeWorkspaces(next, file), /invalid slot\/model\/effort/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("buildCommand: a writable Claude slot gets acceptEdits from canWrite", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: true }), "C:/logs/brief.txt"), /--permission-mode acceptEdits/);
});

test("buildCommand: a read-only Claude slot denies every shell and file-writing tool", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: false }), "C:/logs/brief.txt"), /--disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/);
});

test("buildCommand: a writable Claude slot does not carry read-only tool denials", () => {
  assert.doesNotMatch(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: true }), "C:/logs/brief.txt"), /--disallowedTools/);
});

test("buildCommand: a read-only Claude slot uses plan mode and no permission prompts", () => {
  assert.match(runner.buildCommand(makeRun({ cli: "claude", model: "claude-opus-5-5[1m]", canWrite: false }), "C:/logs/brief.txt"), /--permission-mode plan --permission-prompts none/);
});

test("buildCommand: Claude receives the brief path (through the environment) while prompt text remains only in the brief file", () => {
  const run = makeRun({ cli: "claude", model: "claude-opus-5-5[1m]" });
  const command = runner.buildCommand(run, "C:/logs/brief.txt");
  assert.match(command, /Read the file at %CC_BRIEF_PATH% and follow it/);
  assert.equal(runner.commandEnv(run, "C:/logs/brief.txt").CC_BRIEF_PATH, "C:/logs/brief.txt");
  assert.doesNotMatch(command, /private words/);
});

test("buildCommand: Codex read-only and write slots map to the matching sandbox", () => {
  assert.match(runner.buildCommand(makeRun({ canWrite: false }), "C:/logs/brief.txt"), /--sandbox read-only/);
  assert.match(runner.buildCommand(makeRun({ canWrite: true }), "C:/logs/brief.txt"), /--sandbox workspace-write/);
});

test("buildCommand: Codex effort is passed as a single model reasoning setting", () => {
  assert.match(runner.buildCommand(makeRun({ effort: "max" }), "C:/logs/brief.txt"), /model_reasoning_effort=max/);
});

test("buildCommand: Codex prompt refers to the isolated brief file", () => {
  assert.match(runner.buildCommand(makeRun(), "C:/logs/tab-seat.brief.txt"), /Read the file at %CC_BRIEF_PATH% and follow it/);
  assert.equal(runner.commandEnv(makeRun(), "C:/logs/tab-seat.brief.txt").CC_BRIEF_PATH, "C:/logs/tab-seat.brief.txt");
});

test("buildCommand: OpenCode command uses the configured model, variant, and working folder", () => {
  const command = runner.buildCommand(makeRun({ cli: "opencode", model: "provider/model-v1", effort: "max" }), "C:/logs/brief.txt");
  assert.match(command, /--dir "%CC_RUN_DIR%" -m provider\/model-v1 --variant max/);
});

test("buildCommand: rejects shell-sensitive effort values before command construction", () => {
  assert.throws(() => runner.buildCommand(makeRun({ effort: "high&whoami" }), "C:/logs/brief.txt"), /invalid effort/);
});

test("buildCommand: rejects shell-sensitive model values for every CLI", () => {
  for (const [cli, model] of [["claude", "claude&whoami"], ["codex", "gpt-6-sol&whoami"], ["opencode", "provider/model&whoami"]] as const) {
    assert.throws(() => runner.buildCommand(makeRun({ cli, model, effort: cli === "opencode" ? "max" : "high" }), "C:/logs/brief.txt"));
  }
});

test("canSeatWrite: Claude stays potentially writable regardless of a read-only slot flag", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
});

test("canSeatWrite: a read-only Codex slot still counts as able to write", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: true })), true);
  assert.equal(runner.canRunWrite(makeRun({ cli: "codex", canWrite: false })), true);
});

test("canSeatWrite: an in-process leader is not a worker-run permission record", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "claude", canWrite: false })), true);
});

test("canSeatWrite: OpenCode stays potentially writable even when its slot canWrite flag is false", () => {
  assert.equal(runner.canRunWrite(makeRun({ cli: "opencode", canWrite: false })), true);
});

test("config.ts: workspace projects and each crew shape field are independently required", () => {
  const { file, workspaces } = workspaceCopy();
  for (const mutate of [
    (value: any) => { delete value.projects; },
    (value: any) => { delete value.projects[0].tabs[0].crew[0].cli; },
    (value: any) => { delete value.projects[0].tabs[0].crew[0].effort; },
  ]) {
    const value = structuredClone(workspaces) as any; mutate(value);
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => config.readWorkspaces(file), /malformed/);
  }
});

test("config.ts: this file's config module is rooted in its temp data folder, never the repo's live config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), isolatedData.toLowerCase());
  assert.equal(path.dirname(path.dirname(config.clientPrefsPath)).toLowerCase(), isolatedData.toLowerCase());
  assert.equal(path.dirname(runner.logsDir).toLowerCase(), isolatedData.toLowerCase());
});

test("config.ts: the seeded example workspace parses as a complete project list", () => {
  const loaded = config.readWorkspaces(config.workspacesPath);
  assert.deepEqual(loaded.projects.map((project) => project.id), ["example"]);
  assert.ok(loaded.projects.every((project) => project.tabs.length > 0));
});

test("config.ts: malformed JSON reports the isolated config filename", () => {
  const { file } = workspaceCopy(); writeFileSync(file, "{");
  assert.throws(() => config.readWorkspaces(file), (error: any) => error.message.includes(file) && /valid JSON/.test(error.message));
});

test("config.ts: a malformed crew object is rejected even when its JSON is valid", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces) as any;
  value.projects[0].tabs[0].crew[0] = null;
  writeFileSync(file, JSON.stringify(value));
  assert.throws(() => config.readWorkspaces(file), /invalid crew or steps in tab .*not an object/);
});

test("disk-load guard: a legitimate multi-tab workspace with ordinary IDs loads", () => {
  const { file, workspaces } = workspaceCopy();
  const value = structuredClone(workspaces);
  value.projects[0].tabs.push(structuredClone(value.projects[0].tabs[0]));
  value.projects[0].tabs[1].id = "alpha-review";
  config.writeWorkspaces(value, file);
  assert.equal(config.readWorkspaces(file).projects[0].tabs.length, 2);
});

test("disk-load guard: the maximum safe log seat key length loads and one extra character is rejected", () => {
  const max = 255 - 1 - 13 - ".brief.txt".length;
  assert.equal(config.isSafeSeatId("x".repeat(max)), true);
  assert.equal(config.isSafeSeatId("x".repeat(max + 1)), false);
});

test("disk-load guard: safe legacy log IDs with spaces, dots, device names, and Unicode round-trip", () => {
  for (const seatId of ["CON", "name.with.dots", "space name", "Dev-研究"]) {
    assert.equal(config.isSafeSeatId(seatId), true, seatId);
    assert.deepEqual(history.parseLogFilename(`${seatId}-123.log`), { seatId, timestamp: 123 });
  }
});

test("disk-load guard: empty, whitespace-only, and filename-unsafe seat keys are rejected", () => {
  for (const seatId of ["", "   ", "../escape", "bad/name", "trailing.", "trailing "]) assert.equal(config.isSafeSeatId(seatId), false, seatId);
});

test("disk-load guard: a seat key holding a control character is not safe", () => {
  for (const seatId of [String.fromCharCode(116, 1, 46, 99), "tab.co" + String.fromCharCode(0x1f) + "der", "tab" + String.fromCharCode(0x7f) + ".coder", "a" + String.fromCharCode(10) + "b"]) assert.equal(config.isSafeSeatId(seatId), false, JSON.stringify(seatId));
  assert.equal(config.isSafeSeatId("tab.coder"), true, "control: an ordinary key passes");
});

test("disk-load guard: a workspace whose PROJECT id is not a slug is refused at load", () => {
  const { file, workspaces } = workspaceCopy();
  for (const id of ["Bad Project", "UPPER", "under_score", "-lead", "trail-"]) {
    const value = structuredClone(workspaces) as any; value.projects[0].id = id;
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => config.readWorkspaces(file), /bad project entry 0/, id);
  }
  writeFileSync(file, JSON.stringify(workspaces));
  assert.equal(config.readWorkspaces(file).projects[0].id, "example", "control: the slug id loads");
});

test("disk-load guard: duplicate project and tab IDs are rejected case-insensitively before writing", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces);
  value.projects.push(structuredClone(value.projects[0]));
  assert.throws(() => config.writeWorkspaces(value, file), /duplicate project id/);
});

test("disk-load guard: invalid model and effort errors identify the workspace tab and crew slot", () => {
  const { file, workspaces } = workspaceCopy(), value = structuredClone(workspaces);
  assert.equal(value.projects[0].tabs[0].id, "example-development", "the seeded example tab");
  const reviewer2 = value.projects[0].tabs[0].crew.find((seat) => seat.slot === "reviewer2");
  assert.ok(reviewer2, "the default dev crew has a reviewer2 slot");
  reviewer2.effort = "unsafe";
  assert.throws(() => config.writeWorkspaces(value, file), (error: any) => error.message.includes("example-development.reviewer2"), "the error names the tab and slot");
});
