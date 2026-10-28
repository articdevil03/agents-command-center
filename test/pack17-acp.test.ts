// Pack 17: any CLI that speaks the Agent Client Protocol (ACP) can lead a tab, added from Settings by its start command.
// Sections: A the start command and the saved list (no shell, ever), B the safe program resolution (every CLI start), C the adapter against the fake ACP agent
// (shapes measured on `opencode acp` 1.18.21), D the real server through a client (add, pick, chat, Stop, modes, crew tools, errors), E the sweep over every place that decides per CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { readWorkspaces, parseAcpStartCommand, validateAcpCli, readAcpClis, writeAcpClis, isAcpKind, isValidModel, isValidEffort, defaultEffort, ACP_MAX_CLIS } from "../server/config.ts";
import { KNOWN_CLI_NAMES, leaderKindOf, resolveCliOrThrow, resolveCliPath, spawnAcpChild, withResolvedCli, type LeaderCallbacks } from "../server/leader-common.ts";
import { createAcpLeader } from "../server/leader-acp.ts";
import { buildCommand } from "../server/runner.ts";
import { CLI_IDS } from "../server/settings.ts";
import { spawnFakeAcp } from "./fake-leader-cli.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const SECRET = "SECRET-P17-xK39qz";
const temps: string[] = [];
function scratch(prefix = "cc-pack17-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; }
test.after(() => { for (const dir of temps) removeWithRetry(dir, 40, 500); });

// ---------------------------------------------------------------- A: the start command and the saved list
test("A1: a start command is a program and plain words; anything that needs a shell is refused", () => {
  assert.deepEqual(parseAcpStartCommand("  gemini   --acp "), { program: "gemini", args: ["--acp"] });
  assert.deepEqual(parseAcpStartCommand("opencode acp"), { program: "opencode", args: ["acp"] });
  assert.throws(() => parseAcpStartCommand("   "), /start command is required/i);
  const ok = validateAcpCli({ name: "Gemini CLI", ...parseAcpStartCommand("gemini --acp --model=flash-2.5") });
  assert.deepEqual(ok, { id: "gemini-cli", name: "Gemini CLI", program: "gemini", args: ["--acp", "--model=flash-2.5"] });
  const bad = [
    "gemini --acp && calc", "gemini | more", 'gemini "a b"', "gemini %PATH%", "gemini $(whoami)", "gemini `x`", "gemini;calc", "gemini --a>b", "gemini ^x", "gemini (x)", "gemini 'x'", "gemini --a=b&c",
    "..\\gemini --acp", "C:\\tools\\gemini --acp", "./gemini", "/usr/bin/gemini", "gemini\\evil", ".gemini", "-gemini", "gemini --x=\\\\share\\x",
  ];
  const refused: string[] = [];
  for (const command of bad) { try { validateAcpCli({ name: "X", ...parseAcpStartCommand(command) }); } catch { refused.push(command); } }
  assert.deepEqual(refused, bad, "every one of the shell-needing or path-like commands is refused (printed: what was refused)");
  assert.throws(() => validateAcpCli({ name: "", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "x".repeat(41), program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "bad<name>", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "bad\u0007name", program: "gemini", args: [] }), /name/);
  assert.throws(() => validateAcpCli({ name: "---", program: "gemini", args: [] }), /letter or digit/);
  assert.throws(() => validateAcpCli({ name: "x", program: "gemini", args: Array.from({ length: 17 }, () => "a") }), /arguments/);
  assert.throws(() => validateAcpCli({ name: "x", program: "gemini", args: [5] }), /arguments/);
});

test("A2: the list is saved with the safe-write pattern, read back, and a damaged or duplicate list is refused", () => {
  const dir = scratch(); const file = join(dir, "config", "acp-clis.json");
  assert.deepEqual(readAcpClis(file), [], "no file = no CLIs");
  const a = validateAcpCli({ name: "Alpha", program: "alpha", args: ["--acp"] }), b = validateAcpCli({ name: "Beta", program: "beta", args: [] });
  writeAcpClis([a, b], file);
  assert.deepEqual(readAcpClis(file), [a, b]);
  assert.deepEqual(readdirSync(join(dir, "config")), ["acp-clis.json"], "no temp folder is left beside the saved file");
  assert.throws(() => writeAcpClis([a, validateAcpCli({ name: "alpha!", program: "other", args: [] })], file), /already used/);
  assert.throws(() => writeAcpClis(Array.from({ length: ACP_MAX_CLIS + 1 }, (_, n) => validateAcpCli({ name: `cli ${n}`, program: "p", args: [] })), file), /at most/);
  writeFileSync(file, "{ not json");
  assert.throws(() => readAcpClis(file), /unreadable/);
  writeFileSync(file, JSON.stringify({ clis: [{ name: "Z", program: "a b", args: [] }] }));
  assert.throws(() => readAcpClis(file), /plain command name/i);
  writeFileSync(file, JSON.stringify({ clis: [a, { ...a }] }));
  assert.throws(() => readAcpClis(file), /duplicate/);
});

test("A3: an ACP kind is valid only with the CLI's own default model and effort, and only for the leader seat", () => {
  assert.equal(isAcpKind("acp:gemini"), true);
  for (const bad of ["acp:", "acp:A", "acp:a b", "acp:a/b", "claude", "gemini", "acp:-x", `acp:${"a".repeat(40)}`]) assert.equal(isAcpKind(bad), false, bad);
  assert.equal(isValidModel("acp:gemini", "default"), true);
  assert.equal(isValidModel("acp:gemini", "opus"), false);
  assert.equal(isValidEffort("acp:gemini", "default"), true);
  assert.equal(isValidEffort("acp:gemini", "high"), false);
  assert.equal(defaultEffort("acp:gemini"), "default");
  assert.equal(isValidModel("claude", "default"), false, "the ACP default is not a model of another CLI");
});

test("A4: a saved workspace may use an ACP kind on the leader slot only, and a command is never made up for it", () => {
  const dir = scratch(); const file = join(dir, "workspaces.json");
  const seats = getProcessDefinition("dev", "main").seats;
  const workspace = (cliFor: (seat: (typeof seats)[number]) => string) => ({ projects: [{ id: "a", name: "A", folder: dir, tabs: [{ id: "a-1", name: "A", kind: "dev", process: "main", folder: dir, crew: seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: cliFor(seat), model: cliFor(seat).startsWith("acp:") ? "default" : seat.model, effort: cliFor(seat).startsWith("acp:") ? "default" : seat.effort })) }] }] });
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader ? "acp:gemini" : seat.cli))));
  assert.equal(readWorkspaces(file).projects[0].tabs[0].crew.find((member) => member.slot === LEADER_SLOT)!.cli, "acp:gemini");
  const crewSeat = seats.find((seat) => !seat.isLeader)!;
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader || seat.slotId === crewSeat.slotId ? "acp:gemini" : seat.cli))));
  assert.throws(() => readWorkspaces(file), /invalid crew member/, "an ACP kind on a crew seat is refused");
  writeFileSync(file, JSON.stringify(workspace((seat) => (seat.isLeader ? "gemini" : seat.cli))));
  assert.throws(() => readWorkspaces(file), /invalid crew member/, "an unknown kind is refused");
  const run = { runId: "p17-run", seatKey: "p17-tab.reviewer1", slotId: "reviewer1", name: "Vera", cli: "acp:gemini" as any, model: "default", effort: "default", folder: dir, canWrite: false, startedAt: 1 };
  assert.throws(() => buildCommand(run, join(dir, "brief.txt")), /no command for CLI "acp:gemini"/, "a run command is never made up for an ACP kind");
});

// ---------------------------------------------------------------- B: every CLI start goes through the safe resolution
test("B1: every program name the app starts by name fails closed when it is not on PATH or only inside a project folder", () => {
  assert.deepEqual([...KNOWN_CLI_NAMES].sort(), [...CLI_IDS].sort(), "the resolution list is the settings list (a CLI added to one and not the other goes RED)");
  const outside = scratch(), inside = scratch();
  writeFileSync(join(inside, "x.cmd"), "@echo off\r\n");
  for (const name of KNOWN_CLI_NAMES) {
    assert.throws(() => withResolvedCli(`${name} --version`, { PATH: "" }), new RegExp(`^Error: ${name} was not found on PATH$`), `${name}: not on PATH`);
    writeFileSync(join(inside, `${name}.cmd`), "@echo off\r\n");
    assert.throws(() => withResolvedCli(`${name} --version`, { PATH: inside }, inside), /was found only inside a project folder/, `${name}: only inside a project folder`);
    writeFileSync(join(outside, `${name}.cmd`), "@echo off\r\n");
    assert.equal(withResolvedCli(`${name} --version`, { PATH: outside }, inside), `"${join(outside, `${name}.cmd`)}" --version`, `${name}: resolved to the absolute path outside the folder`);
  }
  assert.equal(withResolvedCli("node server.js", { PATH: "" }), "node server.js", "a command that is not a CLI start is left alone");
});

test("B2: an ACP program resolves the same safe way: PATH folders only, never inside the tab folder, never a bare name", () => {
  const outside = scratch(), inside = scratch();
  writeFileSync(join(inside, "evilacp.cmd"), "@echo off\r\n"); writeFileSync(join(outside, "goodacp.exe"), "");
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: inside }, inside), (error: Error) => error.message === `evilacp was found only inside a project folder (${inside}), which is never used; install it outside your project folders or remove that project folder`);
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: "" }, inside), /evilacp was not found on PATH/);
  assert.throws(() => resolveCliOrThrow("evilacp", { PATH: "." }, inside), /not found on PATH/, "a relative PATH entry is never searched");
  assert.equal(resolveCliOrThrow("goodacp", { PATH: outside }, inside), join(outside, "goodacp.exe"));
  assert.equal(resolveCliPath("goodacp", { PATH: outside }, outside), null, "a PATH folder that is the tab folder is skipped");
  // The real spawn function refuses before any process exists.
  assert.throws(() => spawnAcpChild("evilacp", [], { cwd: inside, env: { PATH: inside } }), /found only inside a project folder/);
  assert.throws(() => spawnAcpChild("ghostacp", [], { cwd: inside, env: { PATH: outside } }), /ghostacp was not found on PATH/);
});

test("B3: a leader kind is one of the four adapters; an unknown kind fails closed (never started as Claude)", () => {
  assert.equal(leaderKindOf("claude"), "claude"); assert.equal(leaderKindOf("codex"), "codex"); assert.equal(leaderKindOf("opencode"), "opencode"); assert.equal(leaderKindOf("acp:gemini"), "acp");
  for (const bad of ["gemini", "", undefined, null, 5, "acp:", "acp:A b", "CLAUDE", "claude "]) assert.throws(() => leaderKindOf(bad), /Unknown leader CLI/, String(bad));
});

// ---------------------------------------------------------------- C: the adapter against the fake ACP agent
type Events = { deltas: string[]; errors: string[]; done: number; stops: number; notices: string[]; usage: any[]; sessions: string[]; models: string[]; activity: Array<string | null> };
function recorder(): { cb: LeaderCallbacks; ev: Events } {
  const ev: Events = { deltas: [], errors: [], done: 0, stops: 0, notices: [], usage: [], sessions: [], models: [], activity: [] };
  const cb: LeaderCallbacks = {
    onDelta: (text) => ev.deltas.push(text), onDone: () => { ev.done++; }, onUsage: (delta) => ev.usage.push(delta), onError: (message) => ev.errors.push(message),
    onStop: () => { ev.stops++; }, onNotice: (message) => ev.notices.push(message), onSession: (id) => ev.sessions.push(id), onModel: (model) => ev.models.push(model), onActivity: (label) => ev.activity.push(label),
  };
  return { cb, ev };
}
const TOKEN = `tok-${randomBytes(16).toString("hex")}`;
function adapter(scenario: string, extra: Partial<Parameters<typeof createAcpLeader>[3]> = {}) {
  const dir = scratch(); const log = join(dir, "fake.log");
  process.env.FAKE_LEADER_LOG = log;
  const { cb, ev } = recorder();
  const leader = createAcpLeader({ model: "default", effort: "default" }, dir, cb, { cli: { name: "Fake", program: "fake-acp", args: [`--scenario=${scenario}`] }, bridge: { url: "http://127.0.0.1:1/api/leader-mcp/x", token: TOKEN }, spawnFn: spawnFakeAcp, startTimeoutMs: 8000, ...extra });
  const logged = (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const until = async (fn: () => unknown, label: string, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(10); } assert.fail(`${label}: ${JSON.stringify(ev)}`); };
  const finish = async () => { leader.stop(); const end = Date.now() + 5000; while (leader.process?.().running && Date.now() < end) await sleep(20); };
  return { leader, ev, dir, log, logged, until, finish };
}

test("C1: a turn streams the reply (a new paragraph after a tool step), reports the CLI's model, session and usage, and shows only the KIND of a step", async () => {
  const a = adapter("basic");
  try {
    await a.until(() => a.ev.sessions.length >= 1, "session id reported at start");
    assert.deepEqual(a.ev.sessions, ["ses_fakeacp1"]);
    assert.deepEqual(a.ev.models, ["fakeprov/fake-default"]);
    a.leader.send("Reply with exactly: OK", []);
    await a.until(() => a.ev.done === 1, "turn done");
    assert.equal(a.ev.deltas.join(""), "Hello from the fake. You said: Reply with exactly: OK\n\nAll done.");
    assert.deepEqual(a.ev.errors, []);
    assert.equal(a.ev.sessions.length, 2, "the session is reported again at the end of the turn (it never ages out of the own-session list)");
    assert.deepEqual(a.ev.usage, [{ modelId: "fakeprov/fake-default", contextTokens: 4321, contextWindow: 200000, costUsd: 0.0123 }]);
    const labels = a.ev.activity.filter((label): label is string => label !== null);
    assert.ok(labels.includes("Editing files") && labels.includes("Thinking"), JSON.stringify(a.ev.activity));
    for (const label of labels) assert.match(label, /^(Thinking|Running a command|Reading a file|Searching files|Editing files|Searching the web|Reading a web page|Planning|Using a tool)$/);
    assert.ok(!JSON.stringify(a.ev).includes(SECRET), "a step's title, path and content never reach the callbacks");
    assert.ok(!a.ev.deltas.join("").includes("thinking about"), "thought chunks are not shown");
    const sent = a.logged();
    const init = sent.find((row) => row.received === "initialize"), session = sent.find((row) => row.received === "session/new");
    assert.ok(init && session);
    assert.equal(session.params.cwd, a.dir, "the CLI works in the tab folder");
    assert.equal(session.params.mcpServers[0].type, "http");
    assert.equal(session.params.mcpServers[0].name, "tab-crew");
    assert.equal(session.params.mcpServers[0].headers[0].value, `Bearer ${TOKEN}`);
    assert.equal(sent.find((row) => row.started).cwd.toLowerCase(), a.dir.toLowerCase());
  } finally { await a.finish(); }
});

test("C2: steer hands the message back, only Full access is accepted, and a closed adapter says so", async () => {
  const a = adapter("basic");
  try {
    assert.equal(a.leader.steer("more", []), false, "no turn is open");
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("x", []);
    assert.equal(a.leader.steer("more", []), false, "ACP has no mid-turn input");
    assert.equal(a.leader.getPermissionMode(), "bypassPermissions");
    assert.equal(await a.leader.setPermissionMode("ask"), false);
    assert.equal(await a.leader.setPermissionMode("plan"), false);
    assert.equal(await a.leader.setPermissionMode("accept"), false);
    assert.equal(await a.leader.setPermissionMode("bypass"), true);
    assert.equal(await a.leader.setModel("default"), true);
    await a.until(() => a.ev.done === 1, "turn done");
  } finally { await a.finish(); }
  assert.equal(await a.leader.setPermissionMode("bypass"), false, "a stopped leader changes nothing");
});

test("C3: in Full access a permission request is answered with allow_once, else allow_always, else refused with a notice", async () => {
  const answers: Record<string, string> = {};
  for (const scenario of ["permission", "permission-always", "permission-none"]) {
    const a = adapter(scenario);
    try {
      await a.until(() => a.ev.sessions.length >= 1, "started");
      a.leader.send("edit it", []);
      await a.until(() => a.ev.done === 1, `${scenario} done`);
      answers[scenario] = a.ev.deltas.join("");
      const row = a.logged().find((entry) => entry.permissionAnswer);
      assert.ok(row, `${scenario}: the agent got an answer`);
      if (scenario === "permission-none") assert.deepEqual(a.ev.notices, ["Fake asked for permission with no way to allow it, so the request was refused."]);
      else assert.deepEqual(a.ev.notices, []);
    } finally { await a.finish(); }
  }
  assert.deepEqual(answers, { permission: "permission:selected:once", "permission-always": "permission:selected:always", "permission-none": "permission:cancelled:-" });
});

test("C4: not signed in is shown with the CLI's own sign-in description (at session start and at a prompt)", async () => {
  const start = adapter("auth");
  try {
    await start.until(() => start.ev.errors.length >= 1, "start error");
    assert.deepEqual(start.ev.errors, ["Fake is not signed in: Run `fakecli auth login` in the terminal"]);
    assert.equal(start.leader.isDead(), true);
    assert.equal(start.ev.stops, 1);
  } finally { await start.finish(); }
  const prompt = adapter("promptauth");
  try {
    await prompt.until(() => prompt.ev.sessions.length >= 1, "started");
    prompt.leader.send("hi", []);
    await prompt.until(() => prompt.ev.errors.length >= 1, "prompt error");
    assert.deepEqual(prompt.ev.errors, ["Fake is not signed in: Run `fakecli auth login` in the terminal"]);
    assert.equal(prompt.ev.done, 0);
  } finally { await prompt.finish(); }
});

test("C5: a process that dies mid-turn fails the turn once with a plain message; one that never starts says so", async () => {
  const a = adapter("die");
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("hi", []);
    await a.until(() => a.ev.errors.length >= 1, "death reported");
    await sleep(300);
    assert.deepEqual(a.ev.errors, ["Fake stopped unexpectedly; a new one will start on the next message"]);
    assert.equal(a.ev.deltas.join(""), "part of the reply", "what it had said is kept");
    assert.equal(a.ev.done, 0); assert.equal(a.ev.stops, 1); assert.equal(a.leader.isDead(), true);
    a.leader.send("again", []);
    assert.equal(a.ev.errors.length, 2); assert.match(a.ev.errors[1], /leader is not available/);
  } finally { await a.finish(); }
  const exits = adapter("exits");
  try {
    await exits.until(() => exits.ev.errors.length >= 1, "exit before start");
    assert.deepEqual(exits.ev.errors, ["Fake exited before it started; is it installed?"]);
  } finally { await exits.finish(); }
  const broken = adapter("basic", { spawnFn: () => { throw new Error("Fake was not found on PATH"); } });
  await broken.until(() => broken.ev.errors.length >= 1, "spawn failure");
  assert.deepEqual(broken.ev.errors, ["Fake failed to start: Fake was not found on PATH"]);
});

test("C6: Stop sends session/cancel and ends the process tree; the turn ends without an error", async () => {
  const a = adapter("cancel");
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("long job", []);
    await a.until(() => a.ev.deltas.join("").length > 0, "streaming");
    const pid = a.logged().find((row) => row.started).pid as number;
    a.leader.stop();
    assert.equal(a.ev.stops, 1); assert.equal(a.leader.isDead(), true);
    assert.equal(a.ev.deltas.join(""), `${"-".repeat(100)}working`, "what it had said is released when Stop ends the turn");
    await a.until(() => a.logged().some((row) => row.received === "session/cancel"), "cancel reached the agent");
    const end = Date.now() + 8000;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < end) await sleep(50);
    assert.equal(alive(), false, "the agent process is gone after Stop");
    assert.deepEqual(a.ev.errors, []); assert.equal(a.ev.done, 0);
    a.leader.stop();
    assert.equal(a.ev.stops, 1, "stopping twice is harmless");
  } finally { await a.finish(); }
});

test("C7: other stop reasons end the turn with a plain message", async () => {
  const said: Record<string, string> = {};
  for (const scenario of ["refusal", "maxtokens"]) {
    const a = adapter(scenario);
    try {
      await a.until(() => a.ev.sessions.length >= 1, "started");
      a.leader.send("hi", []);
      await a.until(() => a.ev.errors.length >= 1, `${scenario} ended`);
      said[scenario] = a.ev.errors[0]; assert.equal(a.ev.done, 0);
    } finally { await a.finish(); }
  }
  assert.deepEqual(said, { refusal: "Fake declined to continue.", maxtokens: "Fake stopped because the reply reached its length limit." });
});

test("C8: the bridge token never reaches the reply, even split across chunks; a CLI without HTTP tool servers gets a notice and none", async () => {
  const a = adapter("echotoken");
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("hi", []);
    await a.until(() => a.ev.done === 1, "done");
    const text = a.ev.deltas.join("");
    assert.ok(!text.includes(TOKEN), text);
    assert.equal(text, "whole [hidden]. split [hidden] end", "a whole token and a token split across two reply chunks (the second also split across two stdout writes) are both hidden");
  } finally { await a.finish(); }
  const none = adapter("nohttp");
  try {
    await none.until(() => none.ev.notices.length >= 1, "notice");
    assert.deepEqual(none.ev.notices, ["The crew tools are not available for Fake: it does not take tool servers over HTTP."]);
    assert.deepEqual(none.logged().find((row) => row.received === "session/new").params.mcpServers, []);
    none.leader.send("hi", []);
    await none.until(() => none.ev.done === 1, "still answers");
  } finally { await none.finish(); }
});

test("C8b: a token split by a tool step or a thought (which inserts a paragraph break) never reaches the reply", async () => {
  for (const scenario of ["tokengap", "tokengap-thought", "tokengap3"]) {
    const a = adapter(scenario);
    try {
      await a.until(() => a.ev.sessions.length >= 1, "started");
      a.leader.send("hi", []);
      await a.until(() => a.ev.done === 1, `${scenario} done`);
      const text = a.ev.deltas.join("");
      assert.ok(!text.replace(/\s+/g, "").includes(TOKEN), `${scenario}: ${JSON.stringify(text)}`);
      assert.ok(text.startsWith("before ") && text.endsWith(" after"), text);
    } finally { await a.finish(); }
  }
});

test("C8e: a paragraph break survives when the text before it ends like the start of the token but the next message is not the token", async () => {
  const want: Record<string, string> = { breakprefix: "A cat\n\nNext message.", "breakprefix-long": `A cat ${TOKEN.slice(0, 4)}\n\nNext message.` };
  for (const scenario of Object.keys(want)) {
    const a = adapter(scenario);
    try {
      await a.until(() => a.ev.sessions.length >= 1, "started");
      a.leader.send("hi", []);
      await a.until(() => a.ev.done === 1, `${scenario} done`);
      assert.equal(a.ev.deltas.join(""), want[scenario]);
    } finally { await a.finish(); }
  }
});

test("C8c: a CLI that closes its output, or a pipe to it that breaks, while it keeps running ends the turn once, with an error, and the leader is dead", async () => {
  // The CLI stays alive and silent (scenario closeout); the test breaks the pipe on the prompt: closeout = the output ends, closein = writing to its input fails.
  for (const breakIt of ["closeout", "closein"]) {
    const spawnFn = (program: string, args: string[], options: any) => {
      const child = spawnFakeAcp(program, args, options); const write = child.stdin!.write.bind(child.stdin!);
      (child.stdin as any).write = (data: any, ...rest: any[]) => { if (String(data).includes("session/prompt")) { if (breakIt === "closeout") child.stdout!.destroy(); else child.stdin!.destroy(new Error("write EPIPE")); } return (write as any)(data, ...rest); };
      return child;
    };
    const a = adapter("closeout", { spawnFn });
    try {
      await a.until(() => a.ev.sessions.length >= 1, "started");
      a.leader.send("hi", []);
      await a.until(() => a.ev.errors.length >= 1, `${breakIt}: the turn ends with an error`);
      await sleep(400);
      assert.equal(a.ev.errors.length, 1, `${breakIt}: exactly one error ${JSON.stringify(a.ev.errors)}`);
      assert.equal(a.ev.done, 0);
      assert.equal(a.leader.isDead(), true);
    } finally { await a.finish(); }
  }
});

test("C8d: with no injected spawn the real start (safe PATH resolution) runs a whole turn", async () => {
  const a = adapter("basic", { spawnFn: undefined, cli: { name: "Fake", program: "node", args: [fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url)), "--scenario=basic"] } });
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started through the real spawn");
    a.leader.send("hi", []);
    await a.until(() => a.ev.done === 1, "turn done");
    assert.deepEqual(a.ev.errors, []);
    assert.ok(a.ev.deltas.join("").startsWith("Hello from the fake."), a.ev.deltas.join(""));
  } finally { await a.finish(); }
});

test("C9: everything the CLI supplies that leaves the adapter is hidden if it holds the bridge token: model, usage model, error text, session id", async () => {
  const m = adapter("modeltoken");
  try {
    await m.until(() => m.ev.models.length >= 1, "model reported");
    m.leader.send("hi", []);
    await m.until(() => m.ev.done === 1, "done");
    assert.deepEqual(m.ev.models, ["[hidden]"]);
    assert.equal(m.ev.usage[0].modelId, "[hidden]");
    assert.ok(!JSON.stringify(m.ev).includes(TOKEN), JSON.stringify(m.ev));
  } finally { await m.finish(); }
  const e = adapter("errtoken");
  try {
    await e.until(() => e.ev.sessions.length >= 1, "started");
    e.leader.send("hi", []);
    await e.until(() => e.ev.errors.length === 1, "error");
    assert.equal(e.ev.errors[0], "Fake reported an error: failed for [hidden]");
    assert.ok(!JSON.stringify(e.ev).includes(TOKEN));
  } finally { await e.finish(); }
  const i = adapter("idtoken");
  try {
    await i.until(() => i.ev.errors.length === 1, "session refused");
    assert.deepEqual(i.ev.sessions, []);
    assert.ok(!JSON.stringify(i.ev).includes(TOKEN));
  } finally { await i.finish(); }
});

test("C10: a message from the CLI that makes the handling throw is skipped; the rest of the same chunk (the prompt's reply) is still read and the turn ends once", async () => {
  const uncaught: string[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(String(err instanceof Error ? err.message : "non-error")); };
  const others = process.listeners("uncaughtException"); // the runner's own handler would fail the test with the raw TypeError, not an assertion
  process.removeAllListeners("uncaughtException"); process.on("uncaughtException", onUncaught);
  const a = adapter("badtool");
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("hi", []);
    try { await a.until(() => a.ev.done >= 1 || uncaught.length > 0, "turn ends"); } catch (waitError) { assert.deepEqual(uncaught, [], "uncaught exception while the turn never ended"); throw waitError; }
    await sleep(150);
    assert.deepEqual(uncaught, [], "the throwing message must not escape the data handler");
    assert.equal(a.ev.done, 1);
    assert.deepEqual(a.ev.errors, []);
    assert.equal(a.ev.deltas.join(""), "reply after the bad messages");
  } finally { process.off("uncaughtException", onUncaught); for (const fn of others) process.on("uncaughtException", fn); await a.finish(); }
});

test("C11: a newline-terminated line over the limit is refused like an unterminated one; nothing from it is shown", async () => {
  const a = adapter("bigline", { maxLine: 1000 });
  try {
    await a.until(() => a.ev.sessions.length >= 1, "started");
    a.leader.send("hi", []);
    await a.until(() => a.ev.errors.length >= 1, "refused");
    assert.deepEqual(a.ev.errors, ["Fake sent unreadable data"]);
    assert.equal(a.ev.deltas.join(""), "");
    assert.equal(a.ev.done, 0);
  } finally { await a.finish(); }
});

// ---------------------------------------------------------------- D: the real server, through a client
const MAIN = getProcessDefinition("dev", "main").seats;
const LEADER_SLOT = MAIN.find((seat) => seat.isLeader)!.slotId;
const crewFor = (leader?: { cli: string; model: string; effort: string }) => MAIN.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
const TAB_COUNT = 12;
const tabId = (n: number) => `p17-${n}`;
async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}
type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack17s-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), bin = join(temp, "bin");
  for (const dir of [home, work, bin, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "fake-acp.cmd"), "@echo off\r\n"); // found on PATH (outside every project folder); the test spawn runs the fake agent in its place
  writeFileSync(join(work, "evilacp.cmd"), "@echo off\r\n"); // a program planted INSIDE the tab folder, which is on PATH
  const tab = (id: string, leader?: { cli: string; model: string; effort: string }) => ({ id, name: id, kind: "dev", process: "main", folder: work, crew: crewFor(leader) });
  const tabs = [...Array.from({ length: TAB_COUNT }, (_, index) => tab(tabId(index + 1))), tab("p17-evil", { cli: "acp:evil", model: "default", effort: "default" }), tab("p17-ghost", { cli: "acp:ghost", model: "default", effort: "default" })];
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p17", name: "P17", folder: work, tabs }] }));
  writeFileSync(join(data, "config", "acp-clis.json"), JSON.stringify({ clis: [{ id: "evil", name: "Evil", program: "evilacp", args: [] }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const port = await freePort();
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32, bin, work].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack17-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const end = Date.now() + 10_000;
  while (!log.includes("127.0.0.1") && Date.now() < end) await sleep(10);
  assert.ok(log.includes("127.0.0.1"), `server did not start: ${log}`);
  return {
    port, key, temp, data, work, child, log: () => log,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { removeWithRetry(temp, 40, 500); }
    },
  };
}
async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello" }));
  const wait = async <T>(fn: () => T, label: string, ms = 12_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-600)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  let n = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const tabState = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
  const done = (id: string) => messages.filter((m) => m.type === "chatDone" && m.tabId === id).length;
  const errors = (id: string) => messages.filter((m) => m.type === "chatError" && m.tabId === id);
  const answers = (id: string) => messages.filter((m) => m.type === "chatMessage" && m.tabId === id && m.role !== "notice").map((m) => ({ role: m.role as string, text: m.text as string }));
  // A request that answers with actionResult or an error carrying its requestId.
  const request = async (payload: any): Promise<{ ok: boolean; message?: string }> => {
    const requestId = `p17r${++n}`; const from = messages.length;
    send({ ...payload, requestId });
    const reply = await wait(() => messages.slice(from).find((m) => m.requestId === requestId && (m.type === "actionResult" || m.type === "error")), `reply to ${payload.type}`);
    return reply.type === "actionResult" ? { ok: true } : { ok: false, message: reply.message };
  };
  const chat = async (id: string, text: string): Promise<void> => {
    const requestId = `p17c${++n}`;
    send({ type: "chat", tabId: id, text, requestId });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
  };
  const finished = async (id: string, count: number, label: string, ms = 20_000) => { await wait(() => done(id) >= count || errors(id).length >= count, label, ms); await sleep(150); };
  return { messages, state, tabState, wait, send, request, chat, done, errors, answers, finished, close: () => socket.terminate() };
}
type Client = Awaited<ReturnType<typeof client>>;
const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const chatFile = (server: Server, id: string): any[] => readFileSync(join(server.data, "chats", `${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const workspaceFile = (server: Server): any => JSON.parse(readFileSync(join(server.data, "config", "workspaces.json"), "utf8"));
const leaderOf = (tab: any) => tab.crew.find((member: any) => member.slot === LEADER_SLOT);

// Adds the scenario's CLI (once) and makes it the tab's leader, the way the page does.
async function useAcp(c: Client, id: string, scenario: string): Promise<string> {
  const name = `Fake ${scenario}`, kind = `acp:fake-${scenario}`;
  if (!c.state().acpClis.some((cli: any) => cli.kind === kind)) assert.deepEqual(await c.request({ type: "addAcpCli", name, command: `fake-acp --scenario=${scenario}` }), { ok: true });
  const from = c.messages.length;
  c.send({ type: "updateSeat", tabId: id, slot: LEADER_SLOT, cli: kind, model: "default", confirm: true });
  await c.wait(() => leaderOf(c.tabState(id)).cli === kind, `${id} leads with ${kind}: ${JSON.stringify(c.messages.slice(from).filter((m) => m.type === "error"))}`);
  return kind;
}

test("D1: Settings adds a CLI by its start command; nothing that needs a shell is saved; it cannot be removed while it leads a tab", async () => {
  const server = await boot(); const c = await client(server);
  try {
    assert.deepEqual(c.state().acpClis.map((cli: any) => cli.id), ["evil"], "the saved list is loaded at start");
    assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake basic", command: "fake-acp --scenario=basic" }), { ok: true });
    const added = c.state().acpClis.find((cli: any) => cli.id === "fake-basic");
    assert.deepEqual(added, { id: "fake-basic", name: "Fake basic", program: "fake-acp", args: ["--scenario=basic"], kind: "acp:fake-basic" });
    assert.deepEqual(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.map((cli: any) => cli.id), ["evil", "fake-basic"]);
    const before = readFileSync(join(server.data, "config", "acp-clis.json"), "utf8");
    for (const command of ["fake-acp && calc", "fake-acp | more", 'fake-acp "x y"', "..\\fake-acp", "C:\\tools\\fake-acp --acp", "fake-acp %PATH%"]) {
      const result = await c.request({ type: "addAcpCli", name: "Shell", command });
      assert.equal(result.ok, false, command);
    }
    assert.equal((await c.request({ type: "addAcpCli", name: "FAKE BASIC", command: "fake-acp" })).ok, false, "the same name twice");
    const missing = await c.request({ type: "addAcpCli", name: "Not real", command: "notarealcli --acp" });
    assert.equal(missing.ok, false); assert.equal(missing.message, "notarealcli was not found. Install it first, or check the name.");
    assert.equal(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8"), before, "a refused add changes nothing on disk");
    assert.equal(c.state().acpClis.length, 2);
    await useAcp(c, tabId(1), "basic");
    const refusal = await c.request({ type: "removeAcpCli", id: "fake-basic" });
    assert.equal(refusal.ok, false); assert.match(refusal.message!, /leader CLI of "p17-1"/);
    assert.ok(c.state().acpClis.some((cli: any) => cli.id === "fake-basic"));
    assert.deepEqual(await c.request({ type: "refreshSettings" }), { ok: true });
    c.send({ type: "updateSeat", tabId: tabId(1), slot: LEADER_SLOT, cli: "claude", model: "claude-opus-5-5[1m]" });
    await c.wait(() => leaderOf(c.tabState(tabId(1))).cli === "claude", "back to Claude");
    assert.deepEqual(await c.request({ type: "removeAcpCli", id: "fake-basic" }), { ok: true });
    assert.deepEqual(c.state().acpClis.map((cli: any) => cli.id), ["evil"]);
    assert.deepEqual(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.map((cli: any) => cli.id), ["evil"]);
  } finally { c.close(); await server.stop(); }
});

test("D2: picking an ACP leader needs the Full access confirmation, is leader-only, and shows Full access only", async () => {
  const server = await boot(); const c = await client(server);
  try {
    assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake basic", command: "fake-acp --scenario=basic" }), { ok: true });
    const slots = MAIN.map((seat) => seat.slotId);
    const crewSlot = slots.find((slot) => slot !== LEADER_SLOT)!;
    let from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:fake-basic", model: "default" });
    const noConfirm = await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "refused without the confirmation");
    assert.match(noConfirm.message, /Full access confirmation is required: Fake basic may edit files and run commands without asking/);
    assert.equal(leaderOf(c.tabState(tabId(2))).cli, "claude");
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: crewSlot, cli: "acp:fake-basic", model: "default", confirm: true });
    const crew = await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "refused for a crew seat");
    assert.match(crew.message, /can be a leader only/);
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:nobody", model: "default", confirm: true });
    assert.match((await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "unknown ACP CLI")).message, /not in your ACP CLIs list/);
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:fake-basic", model: "opus", confirm: true });
    assert.match((await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "a model of another CLI")).message, /valid acp:fake-basic model is required/);
    await useAcp(c, tabId(2), "basic");
    const tab = c.tabState(tabId(2));
    assert.equal(leaderOf(tab).model, "default"); assert.equal(leaderOf(tab).effort, "default");
    assert.equal(tab.permissionMode, "bypass", "an ACP leader shows Full access");
    assert.deepEqual(tab.acpLeader, { name: "Fake basic", model: null });
    const saved = workspaceFile(server).projects[0].tabs.find((t: any) => t.id === tabId(2));
    assert.equal(saved.crew.find((m: any) => m.slot === LEADER_SLOT).cli, "acp:fake-basic");
    // Ask, Plan and Accept are refused for it; Full access is what it already has (nothing changes, and the tab's saved mode stays as it was).
    for (const mode of ["ask", "accept", "plan"]) {
      const result = await c.request({ type: "setPermissionMode", tabId: tabId(2), mode });
      assert.equal(result.ok, false, mode); assert.match(result.message!, /Fake basic can only run with Full access: it may edit files and run commands without asking, and Command Center cannot make it ask yet\./);
    }
    assert.deepEqual(await c.request({ type: "setPermissionMode", tabId: tabId(2), mode: "bypass", confirm: true }), { ok: true });
    assert.equal(c.state().settings.permissionModes[tabId(2)], undefined, "the saved mode is untouched (it applies again if the leader is switched back)");
    assert.equal(c.tabState(tabId(2)).permissionMode, "bypass");
    // Switching back restores the tab's own saved mode.
    assert.deepEqual(await c.request({ type: "refreshSettings" }), { ok: true });
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "claude", model: "claude-opus-5-5[1m]" });
    await c.wait(() => leaderOf(c.tabState(tabId(2))).cli === "claude", "back to Claude");
    assert.equal(c.tabState(tabId(2)).permissionMode, c.tabState(tabId(12)).permissionMode, "the tab's own saved mode applies again"); assert.equal(c.tabState(tabId(2)).acpLeader, null);
    assert.equal(leaderOf(c.tabState(tabId(2))).effort !== "default", true);
  } finally { c.close(); await server.stop(); }
});

test("D3: an ACP leader chats through the real server: the reply is streamed and saved, the model it reports is shown, a step shows only its kind, nothing secret is saved", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(3), "basic");
    const from = c.messages.length;
    await c.chat(tabId(3), "Reply with exactly: OK");
    await c.finished(tabId(3), 1, "turn done");
    assert.equal(c.errors(tabId(3)).length, 0);
    const [user, reply] = c.answers(tabId(3));
    assert.equal(user.role, "user"); assert.equal(reply.role, "assistant");
    assert.match(reply.text, /^Hello from the fake\. You said: [\s\S]*Reply with exactly: OK\n\nAll done\.$/);
    const saved = chatFile(server, tabId(3)).filter((row) => row.type === "message" && row.role === "assistant");
    assert.equal(saved.length, 1); assert.equal(saved[0].text, reply.text, "the reply is saved");
    assert.ok(!readFileSync(join(server.data, "chats", `${tabId(3)}.jsonl`), "utf8").includes(SECRET), "no step title, path or content in the saved chat");
    assert.ok(!JSON.stringify(c.messages.slice(from)).includes(SECRET), "nothing of a step or a thought reaches the page");
    const labels = c.messages.slice(from).filter((m) => m.type === "leaderActivity" && m.tabId === tabId(3)).map((m) => m.label).filter(Boolean);
    assert.ok(labels.includes("Editing files"), JSON.stringify(labels));
    const tab = c.tabState(tabId(3));
    assert.deepEqual(tab.acpLeader, { name: "Fake basic", model: "fakeprov/fake-default" }, "the model the CLI reports is in the state");
    assert.equal(c.state().acpClis.find((cli: any) => cli.id === "fake-basic").lastModel, "fakeprov/fake-default", "the CLI's model is remembered for the picker");
    assert.equal(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.find((cli: any) => cli.id === "fake-basic").lastModel, "fakeprov/fake-default", "and saved");
    assert.equal(tab.leaderUsage.contextTokens, 4321); assert.equal(tab.leaderUsage.contextWindow, 200000); assert.equal(tab.leaderUsage.costUsd, 0.0123);
    const sent = fakeLog(server).filter((row) => row.cli === "acp" && row.scenario === "basic");
    assert.equal(sent.find((row) => row.received === "session/new").params.cwd, server.work);
    // The reply works a second time on the same session (one prompt per turn).
    await c.chat(tabId(3), "again");
    await c.finished(tabId(3), 2, "second turn");
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp" && row.prompt).length, 2);
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp" && row.started).length, 1, "one process for the whole session");
  } finally { c.close(); await server.stop(); }
});

test("D4: Stop ends the ACP leader's process; the next message starts a new one", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(4), "cancel");
    await c.chat(tabId(4), "long job");
    await c.wait(() => c.messages.find((m) => m.type === "chatDelta" && m.tabId === tabId(4)), "streaming");
    const pid = fakeLog(server).find((row) => row.started && row.scenario === "cancel").pid as number;
    c.send({ type: "stopSeat", tabId: tabId(4), slot: LEADER_SLOT });
    await c.wait(() => c.messages.find((m) => m.type === "chatError" && m.tabId === tabId(4) && m.message === "leader turn stopped"), "stopped");
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const end = Date.now() + 8000; while (alive() && Date.now() < end) await sleep(50);
    assert.equal(alive(), false, "the agent process is gone");
    assert.ok(fakeLog(server).some((row) => row.received === "session/cancel"), "the agent was asked to cancel");
    const partial = c.answers(tabId(4)).filter((m) => m.role === "assistant").map((m) => m.text);
    assert.deepEqual(partial, [`${"-".repeat(100)}working

(Stopped before it finished.)`]);
    await c.chat(tabId(4), "second");
    await c.wait(() => fakeLog(server).filter((row) => row.started && row.scenario === "cancel").length === 2, "a new process starts on the next message");
    c.send({ type: "stopSeat", tabId: tabId(4), slot: LEADER_SLOT });
    await sleep(500);
  } finally { c.close(); await server.stop(); }
});

test("D5: the crew tools reach an ACP leader through the real bridge with its own token; an error and a death are shown plainly", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(5), "crew");
    await c.chat(tabId(5), "who is in the crew?");
    await c.finished(tabId(5), 1, "crew turn");
    assert.match(c.answers(tabId(5)).at(-1)!.text, /^crew ok: 200$/);
    const row = fakeLog(server).find((entry) => entry.bridgeTools);
    assert.ok(row, "the agent used the bridge");
    assert.deepEqual([...row.bridgeTools].sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    assert.match(row.bridgeCrew, /"tab":"p17-5"/);
    const labels = c.messages.filter((m) => m.type === "leaderActivity" && m.tabId === tabId(5)).map((m) => m.label).filter(Boolean);
    assert.ok(!labels.some((label: string) => /crew/i.test(label)), `a crew tool shows as a crew run, not a step: ${JSON.stringify(labels)}`);
    // Not signed in.
    await useAcp(c, tabId(6), "auth");
    await c.chat(tabId(6), "hello");
    await c.finished(tabId(6), 1, "auth failure");
    assert.equal(c.errors(tabId(6)).at(-1).message, "Fake auth is not signed in: Run `fakecli auth login` in the terminal");
    assert.equal(c.answers(tabId(6)).at(-1)!.text, "Fake auth is not signed in: Run `fakecli auth login` in the terminal", "the plain error is saved as the reply");
    // Death mid-turn.
    await useAcp(c, tabId(7), "die");
    await c.chat(tabId(7), "hello");
    await c.finished(tabId(7), 1, "death");
    assert.match(c.errors(tabId(7)).at(-1).message, /Fake die stopped unexpectedly/);
    assert.equal(c.errors(tabId(7)).length, 1, "the turn fails once");
    // A permission request in Full access is allowed; the reply says which option the CLI got.
    await useAcp(c, tabId(8), "permission");
    await c.chat(tabId(8), "edit it");
    await c.finished(tabId(8), 1, "permission turn");
    assert.equal(c.answers(tabId(8)).at(-1)!.text, "permission:selected:once");
    assert.equal(c.tabState(tabId(8)).pendingApprovals.length, 0, "no approval card: Full access never asks");
    // The token is hidden if the CLI echoes it.
    await useAcp(c, tabId(9), "echotoken");
    await c.chat(tabId(9), "hello");
    await c.finished(tabId(9), 1, "echo");
    assert.equal(c.answers(tabId(9)).at(-1)!.text, "whole [hidden]. split [hidden] end");
    assert.ok(!readFileSync(join(server.data, "chats", `${tabId(9)}.jsonl`), "utf8").match(/[0-9a-f]{64}/), "no 64-character token in the saved chat");
  } finally { c.close(); await server.stop(); }
});

test("D6: a program found only inside the tab folder is refused (at the pick and at the start); a removed CLI says so", async () => {
  const server = await boot(); const c = await client(server);
  try {
    // Picked from Settings: refused before it is saved.
    const from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(10), slot: LEADER_SLOT, cli: "acp:evil", model: "default", confirm: true });
    const refusal = await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "inside-folder pick refused");
    assert.match(refusal.message, /evilacp was found only inside a project folder/);
    assert.equal(leaderOf(c.tabState(tabId(10))).cli, "claude");
    // Saved as the leader already: the start is refused, nothing runs.
    await c.chat("p17-evil", "hello");
    await c.finished("p17-evil", 1, "evil start");
    assert.match(c.errors("p17-evil").at(-1).message, /evilacp was found only inside a project folder/);
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp").length, 0, "no ACP process was started");
    // A leader whose CLI left the list.
    await c.chat("p17-ghost", "hello");
    await c.finished("p17-ghost", 1, "ghost start");
    assert.match(c.errors("p17-ghost").at(-1).message, /The CLI "ghost" was removed in Settings\. Pick another leader CLI for /);
    assert.equal(c.tabState("p17-ghost").permissionMode, "bypass", "a leader of this kind has Full access, listed or not");
  } finally { c.close(); await server.stop(); }
});

test("D7: a tab whose process changes keeps its ACP leader; a Claude tab still starts as Claude (not the ACP adapter)", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(11), "basic");
    c.send({ type: "setProcess", tabId: tabId(11), kind: "dev", process: "main" });
    await sleep(300);
    assert.equal(leaderOf(c.tabState(tabId(11))).cli, "acp:fake-basic");
    await c.chat(tabId(12), "hello claude");
    await c.finished(tabId(12), 1, "claude turn");
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp").length, 0, "a Claude leader never starts the ACP adapter");
    assert.equal(c.errors(tabId(12)).length, 0);
  } finally { c.close(); await server.stop(); }
});

// ---------------------------------------------------------------- E: the sweep over every place that decides per CLI
// Every line of the app's own source that compares a CLI kind or lists the kinds, found by scanning the files (not a hand-picked set).
// A new line, or a line that moved or went, is RED until it is listed here with what an ACP leader does there.
const ROOT = resolve(".");
const SCANNED = [...readdirSync(join(ROOT, "server")).filter((name) => name.endsWith(".ts")).map((name) => `server/${name}`), "public/app.js"];
const DECIDES = /\bcli\b[^;]{0,50}(?:===|!==|==|!=)\s*"(?:claude|codex|opencode)"|"(?:claude|codex|opencode)"\s*(?:===|!==)\s*[A-Za-z_.?]*cli\b|case "(?:claude|codex|opencode)":|"opencode"|leaderKind\s*===\s*"|\bisAcp(?:Kind|Cli)\(|\[\s*(?:kind|cli|[A-Za-z_.?]*\.(?:cli|kind))\s*\]|\bas SeatKind\b|\b(?:kind|leaderKind|[A-Za-z_.?]*\.(?:cli|kind))\s*(?:===|!==)\s*"(?:claude|codex|opencode|gemini)"|"(?:claude|codex|opencode|gemini)"\s*(?:===|!==)\s*(?:kind|leaderKind)\b|\[\s*"(?:claude|codex|opencode)"\s*,\s*"/;
const VERDICTS: Array<[string, string, string]> = [
  // [file, start of the line (trimmed), verdict]
  ["server/cli-discovery.ts", "// \"--help\", \"opencode\"/\"models\"), never user input, so building one command", "n/a: a comment about the models list command"],
  ["server/cli-discovery.ts", "const out = await runCaptured(\"opencode\", [\"models\"], spawnFn);", "n/a: asks OpenCode for ITS model list; an ACP CLI reports its own model at session start"],
  ["server/config.ts", "export type SeatKind = \"claude\" | \"codex\" | \"opencode\";", "works: the three known kinds; an ACP kind is the separate AcpKind (acp:<id>) next to it"],
  ["server/config.ts", ": kind === \"opencode\" && model.length <= 100 && OPENCODE_MODEL_PATTERN.test(model);", "works: isValidModel answers an ACP kind first (only the CLI's own default)"],
  ["server/config.ts", "if (!isObject(member) || typeof member.slot !== \"string\"", "works: a saved crew member may use an ACP kind on the LEADER slot only; any other slot is refused"],
  ["server/folder-activity.ts", "const dbPath = join(home, \".local\", \"share\", \"opencode\", \"opencode.db\");", "n/a: reads OpenCode's own records; an ACP CLI is seen by the generic file-change watch and by the session id it reports (onSession)"],
  ["server/index.ts", "if (value !== \"claude\" && value !== \"codex\" && value !== \"opencode\" && value !== \"gemini\") throw new Error(\"unknown CLI\");", "n/a: Settings tool actions (install, sign in, MCP) are for the four known CLIs; an ACP CLI is signed in through its own terminal command"],
  ["server/index.ts", "const mayWrite = (cli: CrewMember[\"cli\"] | undefined", "n/a: crew seats only, and an ACP CLI can never be a crew seat"],
  ["server/index.ts", "const opensOwnReplies = lead.cli === \"claude\";", "n/a: only the Claude CLI starts a reply by itself; an ACP CLI answers only prompts"],
  ["server/index.ts", "if (leaderKind === \"acp\") {", "works: the ACP adapter is started with the CLI's saved start command, a bridge token of its own, and the tab folder"],
  ["server/index.ts", "} else if (leaderKind === \"codex\") {", "works: leaderKindOf picks the adapter; \"acp\" goes to createAcpLeader, an unknown kind throws"],
  ["server/index.ts", "} else if (leaderKind === \"opencode\") {", "works: same dispatch"],
  ["server/index.ts", "if (typeof message.cli !== \"string\" || !([\"claude\", \"codex\", \"opencode\"].includes(message.cli) || isAcpKind(message.cli)))", "works: an ACP kind is accepted for the leader slot only, with the Full access confirmation and a safe program"],
  ["server/index.ts", "if (!tab || !lead || lead.cli !== \"claude\") return;", "n/a: the start-up health check is a Claude turn; an ACP leader has none"],
  ["server/runner.ts", "return { [BRIEF_VAR]: briefPath, ...(run.cli === \"opencode\"", "refused: run commands are for crew seats, and an ACP CLI cannot be one"],
  ["server/runner.ts", "case \"claude\":", "refused: buildCommand has a default branch that throws for any other kind"],
  ["server/runner.ts", "case \"codex\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "case \"opencode\":", "refused: crew seats only, as above"],
  ["server/runner.ts", "const env = leaderChildEnv({ ...commandEnv(run, briefPath), ...(run.cli === \"opencode\"", "refused: crew seats only"],
  ["server/runner.ts", "const claudeState: AgentUsageState | null = run.cli === \"claude\"", "refused: crew seats only"],
  ["server/runner.ts", "const codexState: AgentUsageState | null = run.cli === \"codex\"", "refused: crew seats only"],
  ["server/leader-common.ts", "export const KNOWN_CLI_NAMES = [\"claude\", \"codex\", \"opencode\", \"gemini\"] as const;", "works: the program names started by name; an ACP program goes through resolveCliOrThrow in spawnAcpChild"],
  ["server/leader-common.ts", "export function leaderKindOf(cli: unknown)", "works: the one dispatch from a leader kind to its adapter; an unknown kind throws"],
  ["server/leader-common.ts", "if (cli === \"claude\" || cli === \"codex\" || cli === \"opencode\") return cli;", "works: leaderKindOf, the one dispatch; ACP is the next line"],
  ["server/settings.ts", "export type CliId = \"claude\" | \"codex\" | \"opencode\" | \"gemini\";", "n/a: Settings tools (install, sign-in status, MCP) for the four known CLIs"],
  ["server/settings.ts", "export const CLI_IDS: CliId[] = [\"claude\", \"codex\", \"opencode\", \"gemini\"];", "n/a: same; test B1 ties it to the safe-resolution list"],
  ["server/settings.ts", "if (cli === \"claude\") {", "n/a: Settings tools only (each such line)"],
  ["server/settings.ts", "if (cli === \"opencode\" && result.code === 0) {", "n/a: Settings tools only"],
  ["server/settings.ts", "this.state.skills.opencode.skills =", "n/a: Settings tools only"],
  ["server/settings.ts", "if (cli === \"codex\") args = [\"mcp\", \"add\"", "n/a: Settings tools only"],
  ["server/settings.ts", "else if (cli === \"claude\") args = [\"mcp\", \"add\"", "n/a: Settings tools only"],
  ["server/settings.ts", "if (cli !== \"claude\" && cli !== \"codex\") throw new SettingsActionError", "n/a: Settings tools only"],
  ["server/settings.ts", "const result = await this.call(cli, [\"mcp\", \"remove\"", "n/a: Settings tools only"],
  ["public/app.js", "const MODEL_BRAND = {", "works: an ACP CLI has no brand logo; logo() falls back to the first letter of its name"],
  ["public/app.js", "const info = cli === \"claude\" ? serverState?.claudeModels", "works: formatModel answers an ACP kind first (the model the CLI reports, else CLI default)"],
  ["public/app.js", "if (cli === \"claude\" && Array.isArray(serverState?.claudeModels))", "works: modelOptions answers an ACP kind first (only the default)"],
  ["public/app.js", "if (cli === \"opencode\" && Array.isArray(serverState?.opencodeModels))", "works: same as the line above"],
  ["public/app.js", "if (cli !== \"claude\") return true;", "works: modelSupportsEffort answers an ACP kind first (no effort)"],
  ["public/app.js", "...(cli === \"claude\" ? (inventory.plugins", "n/a: Settings tools only"],
  ["public/app.js", "if (seat?.cli === \"codex\") return canWrite === false", "n/a: access text of crew seats"],
  ["public/app.js", "const advisor = leader(tab)?.cli === \"claude\"", "n/a: the advisor is Claude only"],
  ["public/app.js", "function nonCodexWarning(seat)", "n/a: crew seats"],
  ["public/app.js", "[\"ask\", \"Ask before edits\", (name, cli) => cli === \"codex\"", "works: not offered for an ACP leader (the permission picker shows Full access only)"],
  ["public/app.js", ": cli === \"opencode\" ? `${name} asks before edits and commands.", "works: same as the line above"],
  ["public/app.js", "[\"accept\", \"Auto-accept edits\", (_name, cli) => cli === \"codex\"", "works: same as the line above"],
  ["public/app.js", "[\"plan\", \"Plan only\", (_name, cli) => cli === \"codex\"", "works: same as the line above"],
  ["public/app.js", ": cli === \"opencode\" ? \"Edits are denied.", "works: same as the line above"],
  ["public/app.js", "$(\"first\").innerHTML = `<div class=\"fcard\">", "works: the first-run text names ACP CLIs too; the tool list there is the four known CLIs"],
  ["public/app.js", "return [...[\"claude\", \"codex\", \"opencode\"].filter((cli) => cli === seat.cli", "works: the leader's picker adds the ACP CLIs (leader seat only)"],
  ["public/app.js", "if (seat.cli === \"codex\") hints.push(", "works: the next hint line is the ACP one"],
  ["public/app.js", "if (seat.cli === \"opencode\") hints.push(", "works: same as the line above"],
  ["public/app.js", "hints.push(seat.cli === \"claude\" ?", "works: an ACP leader gets the generic line (applies from the next turn)"],
  ["public/app.js", "const toolRows = [\"claude\", \"codex\", \"opencode\", \"gemini\"].map(", "n/a: Settings AI tools rows; ACP CLIs have their own section"],
  ["public/app.js", "const counts = cli === \"gemini\"", "n/a: Settings tools only"],
  ["public/app.js", "const canRemoveMcp = cli === \"claude\" || cli === \"codex\";", "n/a: Settings tools only"],
  ["public/app.js", "const plugins = cli === \"claude\" ?", "n/a: Settings tools only"],
  ["public/app.js", "const savedBy = {", "n/a: the Settings form drafts; the ACP form is listed in it"],
  ["public/app.js", "return `<section class=\"settings-section\" id=\"s-crew\"", "n/a: the Settings crew list shows each seat through formatModel; its advisor row is Claude only"],
  ["public/app.js", "<section class=\"settings-section\" id=\"s-skills\"", "n/a: Settings tools only (skills and MCP of the four known CLIs)"],
  ["public/app.js", "pop.innerHTML = `<div class=\"sc\">", "n/a: the seat card; its advisor button is Claude only, its model row goes through formatModel"],
  ["server/config.ts", "if (isAcpKind(kind)) return model === ACP_DEFAULT;", "works: isValidModel answers an ACP kind first: only the CLI's own default model"],
  ["server/config.ts", "const list = MODEL_OPTIONS[kind];", "works: reached only for the three known kinds (the ACP answer returns above it)"],
  ["server/config.ts", "if (list?.includes(model) || SAVED_MODELS[kind]", "works: same, known kinds only"],
  ["server/config.ts", "return kind === \"codex\"", "works: the Codex model pattern, known kinds only (the ACP answer returns first)"],
  ["server/config.ts", "export function isValidEffort(kind: SeatKind | AcpKind", "works: an ACP kind answers first: only the CLI's own default effort; the rest is for the known kinds"],
  ["server/config.ts", "export function defaultEffort(kind: SeatKind | AcpKind", "works: an ACP kind answers first with the default effort"],
  ["server/config.ts", "cli: seat.cli as SeatKind,", "works: a type cast in the seat copy; an ACP kind is kept as the string it is"],
  ["server/config.ts", "if (seenSlots.has(member.slot) ||", "works: a saved seat is checked with isValidModel and isValidEffort, which answer an ACP kind first"],
  ["server/config.ts", "for (const kind of Object.keys(SAVED_EFFORTS) as SeatKind[])", "works: the saved model and effort lists exist for the three known kinds only; an ACP kind is skipped on line 369"],
  ["server/config.ts", "for (const kind of Object.keys(SAVED_MODELS) as SeatKind[])", "works: same, the three known kinds"],
  ["server/config.ts", "for (const seat of tab.crew) if (!isAcpKind(seat.cli))", "works: an ACP seat adds nothing to the known kinds' saved lists"],
  ["server/index.ts", "return lead && isAcpKind(lead.cli) ?", "works: acpLeaderOf finds the saved CLI of a tab's ACP leader"],
  ["server/index.ts", "return Boolean(location?.tab.crew.some((member) => crewDefinition(", "works: hasAcpLeader is true only for the leader slot holding an ACP kind"],
  ["server/index.ts", "if (isAcpKind(kind)) {", "works: the seat-CLI change for an ACP kind: leader slot only, Full access confirmation, safe program"],
  ["server/index.ts", "const installed = settingsService.state.tools[kind].installed;", "works: reached only for the three known kinds (the ACP branch above it returns)"],
  ["server/index.ts", "const kind = isValidModel(old.cli, old.model) && (!isAcpKind(old.cli)", "works: when a tab's process changes an ACP kind is kept on the leader slot only; any other slot gets the new slot's own default"],
  ["server/leader-acp.ts", "export const acpToolStep", "n/a: the adapter's own map from a tool's reported kind to a step label (names a tool kind, not a CLI)"],
  ["server/process.ts", "const definition = Object.hasOwn(PROCESS_DEFINITIONS, kind)", "n/a: kind here is the tab kind (dev, design, mkt), not a CLI kind"],
  ["server/settings.ts", "const authArgs = AUTH_ARGS[cli];", "n/a: Settings tools only (the four known CLIs)"],
  ["server/settings.ts", "Object.assign(this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "this.state.skills[cli].instructionFiles", "n/a: Settings tools only"],
  ["server/settings.ts", "const inventory = this.state.skills[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "return this.action(this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "if (this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "if (!this.state.tools[cli]", "n/a: Settings tools only"],
  ["server/settings.ts", "const result = await this.call(\"npm\", [\"install\", \"-g\", PACKAGES[cli]]", "n/a: Settings tools only"],
  ["server/settings.ts", "const loginArgs = LOGIN_ARGS[cli];", "n/a: Settings tools only"],
  ["server/settings.ts", "this.watchSignIn(cli,", "n/a: Settings tools only"],
  ["server/settings.ts", "const target = this.state.skills[cli];", "n/a: Settings tools only"],
  ["public/app.js", "const brand = MODEL_BRAND[cli];", "works: an ACP CLI has no brand; logo() falls back to the first letter of its name on the next line"],
  ["public/app.js", "if (!brand || !path) return `<span class=\"lg\"", "works: the letter fallback for a CLI with no brand logo (an ACP CLI)"],
  ["public/app.js", "if (isAcpCli(cli)) return acpShownModel(cli, tab)", "works: formatModel shows THIS tab's reported model, else the CLI's last used one, else CLI default"],
  ["public/app.js", "function cliLabel(cli) {", "works: an ACP CLI is labelled with its saved name"],
  ["public/app.js", "if (isAcpCli(cli)) return [\"default\"];", "works: modelOptions offers an ACP CLI only its default"],
  ["public/app.js", "let values = serverState?.modelOptions?.[cli];", "n/a: the server's lists for the known kinds (an ACP kind returned above)"],
  ["public/app.js", "function effortOptions(cli)", "n/a: the server's effort lists; an ACP kind has none (modelSupportsEffort is false)"],
  ["public/app.js", "if (isAcpCli(cli)) return false;", "works: modelSupportsEffort is false for an ACP CLI"],
  ["public/app.js", "const status = (cli) => { const tool = tools[cli];", "n/a: first-run status of the four known tools"],
  ["public/app.js", "return { dev: \"Leader, coder, two reviewers", "n/a: crew descriptions by tab kind, not CLI kind"],
  ["public/app.js", "function crewFaces(kind, process)", "n/a: kind here is the tab kind, not a CLI kind"],
  ["public/app.js", "const custom = typed && CUSTOM_MODEL[cli]?.test(typed)", "works: no custom-model pattern exists for an ACP CLI, so none is offered"],
  ["public/app.js", "return `<div class=\"grp\" data-grp=", "works: the picker group for an ACP CLI shows CLI default plus the model shown for THIS tab (own CLI) or the last used one (other CLIs)"],
  ["public/app.js", "if (isAcpCli(seat.cli)) hints.push(", "works: the picker hint for an ACP leader"],
  ["public/app.js", "if (message.cli && isAcpCli(message.cli)) {", "works: picking an ACP CLI asks for the Full access confirmation first"],
  ["public/app.js", "const command = tool?.installed === false ? `npm install -g", "n/a: Settings tools only"],
  ["public/app.js", "return `<div class=\"crow tool-row\"", "n/a: Settings tools only"],
  ["public/app.js", "const header = `<div class=\"skill-head\">", "n/a: Settings tools only"],
  ["public/app.js", "if (action === \"install-cli\")", "n/a: Settings tools only"],
  ["public/app.js", "if (action === \"mcp-remove\")", "n/a: Settings tools only"],
  ["public/app.js", "confirmAction({ title: `Add ${name} to ${CLI_LABEL[cli]}?`", "n/a: Settings tools only"],
];
test("E1: every place in the source that decides per CLI kind is listed with what an ACP leader does there", () => {
  const found: string[] = [], listed = new Set<number>();
  for (const file of SCANNED) {
    const lines = readFileSync(join(ROOT, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!DECIDES.test(line)) return;
      const text = line.trim();
      const at = VERDICTS.findIndex(([f, start]) => f === file && text.startsWith(start));
      if (at < 0) found.push(`${file}:${index + 1}: ${text.slice(0, 140)}`); else listed.add(at);
    });
  }
  const stale = VERDICTS.filter((_, index) => !listed.has(index)).map(([file, start]) => `${file}: ${start.slice(0, 100)}`);
  console.log(`pack17 sweep: ${listed.size} listed places matched in ${SCANNED.length} files`);
  assert.ok(listed.size >= 100, `control: the scan must find the places (found ${listed.size})`);
  assert.deepEqual(found, [], `places that decide per CLI and are not listed (add them with a verdict):\n${found.join("\n")}`);
  assert.deepEqual(stale, [], `listed places that are gone or changed:\n${stale.join("\n")}`);
  for (const [, , verdict] of VERDICTS) assert.match(verdict, /^(works|refused|n\/a): .{8,}/, verdict);
});

test("E2: the model shown for an ACP leader is the one reported by the tab being shown, never another tab's; with none yet, the CLI's last used one", () => {
  const app = readFileSync(join(ROOT, "public/app.js"), "utf8");
  const start = app.indexOf("function formatModel(cli, model, tab = null) {"), end = app.indexOf("\n", app.indexOf("const acpShownModel ="));
  assert.ok(start > 0 && end > start, `control: the model helpers were found (${start}, ${end})`);
  const make = (state: unknown) => new Function("serverState", "MODEL_LABEL", "CLI_LABEL", "titleCase", `${app.slice(start, end)}; return formatModel;`)(state, {}, {}, (text: string) => text) as (cli: string, model: string, tab?: unknown) => string;
  const tabA = { acpLeader: { name: "Fake", model: "prov/model-A" } }, tabB = { acpLeader: { name: "Fake", model: "prov/model-B" } }, tabNone = { acpLeader: { name: "Fake", model: null } };
  const format = make({ acpClis: [{ kind: "acp:fake", name: "Fake", lastModel: "prov/last-used" }], projects: [{ tabs: [{ ...tabA, crew: [{ isLeader: true, cli: "acp:fake" }] }, { ...tabB, crew: [{ isLeader: true, cli: "acp:fake" }] }] }] });
  assert.equal(format("acp:fake", "default", tabA), "prov/model-A");
  assert.equal(format("acp:fake", "default", tabB), "prov/model-B", "tab B shows its own model, not tab A's");
  assert.equal(format("acp:fake", "default", tabNone), "prov/last-used", "a tab with no model yet shows the CLI's last used one");
  assert.equal(format("acp:fake", "default"), "prov/last-used", "no tab: the CLI's last used one");
  assert.equal(make({ acpClis: [{ kind: "acp:fake", name: "Fake" }], projects: [{ tabs: [{ ...tabA, crew: [] }] }] })("acp:fake", "default", tabNone), "CLI default");
});

test("F1: the Full access warning sits inside the composer next to the chat box and takes its width and centring from the same layout", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const composer = html.slice(html.indexOf('id="composer"'), html.indexOf('id="cbox"'));
  assert.match(composer, /id="acpNote"/, "the warning is a child of the composer, ahead of the chat box");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\n)${selector.replace(/\./g, "\.")}\{([^}]*)\}`))?.[1] ?? "";
  for (const part of ["max-width:760px", "margin:0 auto"]) { assert.ok(rule(".cbox").includes(part), `.cbox has ${part}`); assert.ok(rule(".acp-note").includes(part), `.acp-note has ${part}`); }
});
