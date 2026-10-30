import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type LeaderCallbacks } from "../server/leader-common.ts";
import { createAcpLeader } from "../server/leader-acp.ts";
import { spawnFakeAcp } from "./fake-leader-cli.ts";
import { sleep, SECRET, scratch } from "./pack17-acp-helpers.ts";

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
