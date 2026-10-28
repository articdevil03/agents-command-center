// Pack 12 (steer in chat), the server side through real servers: a message steered into the running reply goes to the CLI as a steer (never a new turn),
// the chat reads [reply so far][steer][rest of the reply] with one chatDone, and every end-of-turn race delivers the message exactly once. One real server per
// group on a temp data root, a Claude, a Codex and an OpenCode leader (the far-boundary fakes record WHEN each message arrived).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

const MAIN = getProcessDefinition("dev", "main").seats, SOLO = getProcessDefinition("dev", "solo").seats;
const crewFor = (seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }) => seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
const CLIS = ["claude", "codex", "opencode"] as const;
type Cli = (typeof CLIS)[number];
const LEADERS: Record<Cli, { cli: string; model: string; effort: string } | undefined> = {
  claude: undefined, codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" },
};
const TAB_COUNT = 7;
const tabOf = (cli: Cli, n: number) => `p12-${cli}-${n}`;
const SOLO_TAB = "p12-solo", SPARE_TAB = "p12-spare";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const ECHO: Record<Cli, (text: string) => RegExp> = {
  claude: (text) => new RegExp(`\\[folded: ${text}\\]`), codex: (text) => new RegExp(`\\[steer: ${text}\\]`), opencode: (text) => new RegExp(`\\[steer: ${text}\\]`),
};
// A reply with a pause in the middle: the steer lands during the pause.
const slow = (cli: Cli, head: string, tail: string, ms = 900): string => JSON.stringify([{ say: head }, cli === "claude" ? { wait: ms } : { sleep: ms }, { say: tail }]);

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(env: Record<string, string> = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack12-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work");
  for (const dir of [home, work, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  const tab = (id: string, seats: typeof MAIN, leader?: { cli: string; model: string; effort: string }, process = "main") => ({ id, name: id, kind: "dev", process, folder: work, crew: crewFor(seats, leader) });
  const tabs = [
    ...CLIS.flatMap((cli) => Array.from({ length: TAB_COUNT }, (_, index) => tab(tabOf(cli, index + 1), MAIN, LEADERS[cli]))),
    tab(SPARE_TAB, MAIN, LEADERS.codex), tab(SOLO_TAB, SOLO, LEADERS.codex, "solo"),
  ];
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p12", name: "P12", folder: work, tabs }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const port = await freePort();
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    // A native Claude path, so the leader passes --replay-user-messages (the Claude fake echoes only when it gets that flag, as the real CLI does).
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath, ...env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack12-server");
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
  const wait = async <T>(fn: () => T, label: string, ms = 10_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  let n = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const tabState = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
  const done = (tabId: string) => messages.filter((m) => m.type === "chatDone" && m.tabId === tabId).length;
  const failed = (tabId: string) => messages.filter((m) => m.type === "chatError" && m.tabId === tabId).length;
  const answers = (tabId: string) => messages.filter((m) => m.type === "chatMessage" && m.tabId === tabId && m.role !== "notice").map((m) => ({ role: m.role as string, text: m.text as string, requestId: m.requestId as string | undefined, files: m.files as string[] | undefined, split: m.split === true }));
  const streamed = (tabId: string, from = 0) => messages.slice(from).filter((m) => m.type === "chatDelta" && m.tabId === tabId).map((m) => m.text).join("");
  // Starts a turn and returns once the server took the message; the reply is left running.
  const start = async (tabId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const requestId = `p12c${++n}`;
    send({ type: "chat", tabId, text, requestId, ...extra });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
    return requestId;
  };
  const steer = (tabId: string, text: string, extra: Record<string, unknown> = {}): string => { const requestId = `p12s${++n}`; send({ type: "steer", tabId, text, requestId, ...extra }); return requestId; };
  const finished = async (tabId: string, count: number, label: string, ms = 15_000) => { await wait(() => done(tabId) >= count, label, ms); await sleep(120); };
  return { messages, state, tabState, wait, send, start, steer, done, failed, answers, streamed, finished, close: () => socket.terminate() };
}
type Client = Awaited<ReturnType<typeof client>>;

// What the fake leaders recorded (the far boundary): every line carries its CLI.
const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
type Seen = { kind: "steer" | "start"; whileTurnOpen?: boolean; images?: string[] };
// Every time `text` reached a leader of this CLI, and how: as a steer into the running turn or as the start of a turn.
function reached(server: Server, cli: Cli, text: string): Seen[] {
  const out: Seen[] = [];
  for (const entry of fakeLog(server)) {
    if (cli === "claude" && entry.cli === "claude" && typeof entry.userText === "string" && entry.userText.includes(text)) out.push({ kind: entry.whileTurnOpen ? "steer" : "start", whileTurnOpen: entry.whileTurnOpen });
    if (cli === "codex" && entry.cli === "codex" && entry.method === "turn/steer" && String(entry.params?.input?.[0]?.text).includes(text)) out.push({ kind: "steer", images: entry.params.input.slice(1).map((item: any) => item.path) });
    if (cli === "codex" && entry.cli === "codex" && entry.method === "turn/start" && String(entry.params?.input?.[0]?.text).includes(text)) out.push({ kind: "start" });
    if (cli === "opencode" && entry.cli === "opencode" && entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(text)) out.push({ kind: "start" });
  }
  // OpenCode's fake also notes a prompt that arrived while its run was going: that one was a steer.
  if (cli === "opencode") for (const entry of fakeLog(server)) if (entry.midRun && String(entry.text).includes(text)) out[out.findIndex((item) => item.kind === "start")]!.kind = "steer";
  return out;
}
// OpenCode holds back the last ~80 characters of a reply (its secret filter), so test replies start with more than that to stream at once.
const PAD = "-".repeat(100);
const HEAD = `part one ${PAD}`;
const promptCount = (server: Server) => fakeLog(server).filter((entry) => entry.cli === "opencode" && entry.path?.endsWith("/prompt_async")).length;
// The chat file on disk is the independent measurement of what the chat held.
const chatFile = (server: Server, tabId: string): any[] => readFileSync(join(server.data, "chats", `${tabId}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.type === "message" && row.role !== "notice");
const upload = (server: Server, name: string): string => { const path = join(server.data, "scratch", name); writeFileSync(path, "x"); return path; };

async function withServer(env: Record<string, string>, body: (server: Server, c: Client) => Promise<void>): Promise<void> {
  const server = await boot(env);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}

test("steer in the middle of a reply, on each CLI: the CLI gets a steer (not a turn), the chat reads [user][reply so far][steer][rest], one chatDone", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), text = `STEER-MID-${cli}`;
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: the first part streamed`);
      const requestId = c.steer(tab, text);
      await c.finished(tab, 1, `${cli}: the reply ends`);
      assert.equal(c.done(tab), 1, `${cli}: one chatDone for the reply and its steer: ${JSON.stringify(c.messages.filter((m) => m.tabId === tab && m.type !== "state").map((m) => [m.type, m.role, m.text ?? m.message]))}`);
      assert.equal(c.failed(tab), 0);
      const rows = c.answers(tab);
      assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], `${cli}: ${JSON.stringify(rows)}`);
      // OpenCode's filter holds back the end of what it said until later: that part is written after the steer.
      if (cli === "opencode") assert.ok(rows[1]!.text.length > 0 && HEAD.startsWith(rows[1]!.text), `${cli}: the reply so far was written down at the steer: ${rows[1]!.text}`);
      else assert.equal(rows[1]!.text, HEAD, `${cli}: the reply so far was written down at the steer`);
      assert.equal(rows[1]!.split, true, "and marked, so the page drops its draft");
      assert.deepEqual([rows[2]!.text, rows[2]!.requestId], [text, requestId]);
      assert.match(rows[3]!.text, ECHO[cli](text), `${cli}: the rest of the reply answers the steer`);
      assert.ok(rows[3]!.text.includes("part two"), `${cli}: and carries the rest`);
      // The OpenCode fake says "part two" in another text part than the steer's answer: pack 14 puts a paragraph break between separate parts, so line breaks are not compared here.
      assert.equal((rows[1]!.text + rows[3]!.text.replace(ECHO[cli](text), "")).replaceAll("\n", ""), HEAD + "part two", `${cli}: nothing lost, nothing doubled`);
      assert.equal(chatFile(server, tab).filter((row) => row.role === "user" && row.text === text).length, 1, `${cli}: the steer is in the chat file once`);
      const seen = reached(server, cli, text);
      assert.deepEqual(seen.map((item) => item.kind), ["steer"], `${cli}: the steer text reached the CLI once, as a steer: ${JSON.stringify(seen)}`);
      if (cli === "opencode") assert.equal(promptCount(server) >= 2, true);
    }
  });
});

test("a steer with an image and a file: they travel with it, the file as the usual suffix, and the chat row keeps both", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 3), text = `STEER-FILES-${cli}`;
      const image = upload(server, `paste-${randomUUID()}.png`), file = upload(server, `file-${randomUUID()}.txt`);
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      c.steer(tab, text, { images: [image], files: [file] });
      await c.finished(tab, 1, `${cli}: ends`);
      const row = c.answers(tab).find((item) => item.role === "user" && item.text === text)!;
      assert.deepEqual(row.files, [file], `${cli}: the row keeps the file`);
      const seen = reached(server, cli, text);
      assert.equal(seen.length, 1, `${cli}: once`);
      assert.equal(seen[0]!.kind, "steer");
      if (cli === "codex") assert.deepEqual(seen[0]!.images, [image], "the image is a localImage item of the steer");
      if (cli === "claude") assert.equal(fakeLog(server).find((entry) => entry.cli === "claude" && String(entry.userText).includes(text))!.imageBlocks, 1, "the image reaches the CLI as an image block of the steer");
      const sent = fakeLog(server).find((entry) => (entry.method === "turn/steer" && entry.params.input[0].text.includes(text)) || (entry.userText ?? "").includes(text) || (entry.path?.endsWith("/prompt_async") && entry.body?.parts?.[0]?.text?.includes(text)));
      const sentText = String(sent.userText ?? sent.params?.input?.[0]?.text ?? sent.body?.parts?.[0]?.text);
      assert.ok(sentText.includes(`Attached files. Read these local paths if they are useful:\n- ${file}`), `${cli}: ${sentText}`);
      assert.ok(!sentText.includes("Before replying, first read the existing handover"), "never the handover wrapper");
      if (cli === "opencode") assert.equal(fakeLog(server).filter((entry) => entry.path?.endsWith("/prompt_async") && entry.body?.parts?.[0]?.text?.includes(text)).every((entry) => entry.body.parts.some((part: any) => part.type === "file")), true, "the image is a file part");
    }
  });
});

test("race a: the reply ended before the steer arrived, so it is a normal message (a new turn, appended once)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 2), text = JSON.stringify([{ say: `answer STEER-AFTER-${cli}` }]);
      await c.start(tab, JSON.stringify([{ say: `first-${cli}` }]));
      await c.finished(tab, 1, `${cli}: the first reply ends`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: taken`);
      await c.finished(tab, 2, `${cli}: the second reply ends`);
      assert.equal(c.messages.some((m) => m.type === "steerRefused" && m.requestId === requestId), false);
      assert.deepEqual(c.answers(tab).map((row) => row.role), ["user", "assistant", "user", "assistant"], cli);
      assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 1, `${cli}: once in the chat`);
      const seen = reached(server, cli, text);
      assert.deepEqual(seen.map((item) => item.kind), ["start"], `${cli}: it reached the CLI as a normal turn, never as a steer: ${JSON.stringify(seen)}`);
    }
  });
});

test("race b, Claude: a steer the CLI queues behind the running turn keeps the turn open: one chatDone after the last answer, nothing dropped, nothing leaking", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 4), text = JSON.stringify([{ say: "STEER-ANSWER-claude" }]);
    await c.start(tab, JSON.stringify([{ noFold: true }, { say: "first " }, { wait: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 1, "the turn and the queued steer are answered");
    await sleep(600);
    assert.equal(c.done(tab), 1, "one chatDone, not one per CLI result");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.includes("end ") && rows[3]!.text.includes("STEER-ANSWER-claude"), `both the rest of the reply and the steer's answer are kept: ${rows[3]!.text}`);
    assert.deepEqual(reached(server, "claude", "STEER-ANSWER-claude").map((item) => item.kind), ["steer"], "the CLI had it while the first turn was open");
    await c.start(tab, "next-message");
    await c.finished(tab, 2, "the next turn works");
    assert.ok(!c.answers(tab).at(-1)!.text.includes("STEER-ANSWER"), "no text of the old turn leaked into the next");
  });
});

test("race b, Codex: turn/steer answered 'no active turn' after the turn ended (or while it still runs): the message goes out as the next turn, once, never appended twice", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const [mode, n] of [["complete", 4], ["error", 5]] as const) {
      const tab = tabOf("codex", n), text = `STEER-LATE-${mode}`;
      await c.start(tab, JSON.stringify([{ steerLate: mode }, { say: "first " }, { sleep: 900 }, { say: "end " }]));
      await c.wait(() => c.streamed(tab).includes("first"), `${mode}: streaming`);
      c.steer(tab, text);
      await c.finished(tab, 2, `${mode}: the reply and the resent steer both end`);
      await sleep(300);
      assert.equal(c.done(tab), 2, `${mode}: two turns, two chatDone`);
      const rows = c.answers(tab);
      const expectedRoles = mode === "complete" ? ["user", "assistant", "user", "assistant"] : ["user", "assistant", "user", "assistant", "assistant"];
      assert.deepEqual(rows.map((row) => row.role), expectedRoles, `${mode}: ${JSON.stringify(rows)}`);
      assert.equal(rows.filter((row) => row.text === text).length, 1, `${mode}: the steer is in the chat once`);
      assert.equal(rows.at(-1)!.text, `codex says hi to: ${text}`, `${mode}: and its answer comes last`);
      if (mode === "error") assert.equal(rows[3]!.text, "end ", "the running turn's own rest stays before the steer's answer");
      assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 1);
      assert.deepEqual(reached(server, "codex", text).map((item) => item.kind), ["steer", "start"], `${mode}: tried as a steer once, then sent as a turn once`);
    }
  });
});

test("race b, OpenCode: a steer that starts a second run (its own idle) stays in the same turn; a refused prompt is resent as the next turn", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    // Twice: the first run's end carries token counts (the idle waits for the context window) and, on the other tab, none (the idle ends the turn at once).
    for (const [n, noTokens] of [[4, false], [6, true]] as const) {
      const late = tabOf("opencode", n), lateText = `STEER-LATE-opencode-${n}`;
      await c.start(late, JSON.stringify([{ steerLate: "late" }, ...(noTokens ? [{ noTokens: true }] : []), { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
      await c.wait(() => c.streamed(late).includes("first"), "late: streaming");
      c.steer(late, lateText);
      await c.finished(late, 1, "late: the turn ends");
      await sleep(600);
      assert.equal(c.done(late), 1, "one chatDone although OpenCode went idle twice");
      const rows = c.answers(late);
      assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
      assert.ok(rows[3]!.text.endsWith(`opencode says hi to: ${lateText}`), `the second run's text was not dropped: ${rows[3]!.text}`);
      assert.equal(reached(server, "opencode", lateText).length, 1, "the prompt was posted once");
    }

    const fail = tabOf("opencode", 5), failText = "STEER-FAIL-opencode";
    await c.start(fail, JSON.stringify([{ steerLate: "fail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(fail).includes("first"), "fail: streaming");
    c.steer(fail, failText);
    await c.finished(fail, 2, "fail: the reply and the resent steer end");
    await sleep(300);
    assert.equal(c.done(fail), 2);
    const failRows = c.answers(fail);
    assert.equal(failRows.filter((row) => row.text === failText).length, 1, "the steer is in the chat once");
    assert.equal(failRows.at(-1)!.text, `opencode says hi to: ${failText}`);
    assert.equal(chatFile(server, fail).filter((row) => row.text === failText).length, 1);
  });
});

test("race c: a chat that meets a running reply comes back typed (reason busy, its request id), appends nothing, and the reply is untouched", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 7);
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      c.send({ type: "chat", tabId: tab, text: `COLLIDES-${cli}`, requestId: `busy${cli}` });
      const refusal = await c.wait(() => c.messages.find((m) => m.type === "error" && m.requestId === `busy${cli}`), `${cli}: the typed refusal`);
      assert.deepEqual([refusal.action, refusal.reason, refusal.tabId], ["chat", "busy", tab]);
      assert.match(refusal.message, /leader is still answering/);
      await c.finished(tab, 1, `${cli}: the reply ends`);
      assert.deepEqual(c.answers(tab).map((row) => row.role), ["user", "assistant"], `${cli}: nothing was appended for the refused chat`);
      assert.equal(reached(server, cli, `COLLIDES-${cli}`).length, 0);
    }
  });
});

test("refusals: an approval card waiting and a Save running refuse the steer with a typed reply carrying the request id, and nothing reaches the CLI", { timeout: 90_000 }, async () => {
  await withServer({ CC_TEST_SAVE_WRITE_DELAY_MS: "1500" }, async (server, c) => {
    const tab = tabOf("codex", 6), text = "STEER-APPROVAL";
    await c.start(tab, JSON.stringify([{ say: "x " }, { command: "echo hi" }]));
    const card = await c.wait(() => c.tabState(tab).pendingApprovals?.[0], "the approval card");
    const requestId = c.steer(tab, text);
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "the refusal");
    assert.deepEqual([refused.reason, refused.tabId], ["approval", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing reached the CLI");
    assert.equal(c.answers(tab).some((row) => row.text === text), false, "and nothing was appended");
    c.send({ type: "answerApproval", tabId: tab, approvalId: card.approvalId, allow: false, requestId: "p12deny" });
    await c.finished(tab, 1, "the turn ends after the denial");

    // Save runs as a leader turn through the same machinery: a steer into it is refused too.
    const claude = tabOf("claude", 6);
    await c.start(claude, "hello before save");
    await c.finished(claude, 1, "the leader has read its handover");
    c.send({ type: "save", tabId: claude });
    await c.wait(() => reached(server, "claude", "Save a concise handover").length === 1, "the Save turn is running");
    const saveSteer = c.steer(claude, "STEER-SAVE");
    const saveRefused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === saveSteer), "the refusal during Save");
    assert.equal(saveRefused.reason, "save");
    assert.equal(reached(server, "claude", "STEER-SAVE").length, 0);
    await c.wait(() => c.messages.find((m) => m.type === "saved" && m.tabId === claude), "the Save finishes", 20_000);
  });
});

test("a steer on a leader that cannot tell its steers from queued messages (no echo) is refused as unavailable; one sent before Codex named its turn waits for the id", { timeout: 60_000 }, async () => {
  await withServer({ FAKE_CLAUDE_NO_REPLAY: "1", FAKE_CODEX_TURN_START_DELAY_MS: "400" }, async (server, c) => {
    const claude = tabOf("claude", 1);
    await c.start(claude, slow("claude", "part one ", "part two"));
    await c.wait(() => c.streamed(claude).includes("part one"), "streaming");
    const requestId = c.steer(claude, "STEER-NOECHO");
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "refused");
    assert.equal(refused.reason, "unavailable");
    assert.equal(reached(server, "claude", "STEER-NOECHO").length, 0, "nothing was sent to a CLI that would answer it as a second turn");
    await c.finished(claude, 1, "the reply is untouched");
    assert.equal(c.answers(claude).length, 2);

    const codex = tabOf("codex", 3), text = "STEER-EARLY";
    await c.start(codex, JSON.stringify([{ sleep: 500 }, { say: "ok " }]));
    c.steer(codex, text); // the turn id is not known yet: the steer waits for it
    await c.finished(codex, 1, "codex: ends");
    const sent = fakeLog(server).find((entry) => entry.method === "turn/steer" && entry.params.input[0].text === text);
    assert.ok(sent, "turn/steer was sent");
    assert.equal(sent.params.expectedTurnId, "turn-1", "with the id from the turn/start reply");
    assert.match(c.answers(codex).at(-1)!.text, /\[steer: STEER-EARLY\]/);
    assert.equal(c.done(codex), 1);
  });
});

test("folder busy: a steer is held with the same request id (nothing steered), Continue anyway steers it; a normal send to an idle tab is held the same way", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 6), text = "STEER-BUSY";
    await c.start(tab, JSON.stringify([{ say: "a " }, { sleep: 3500 }, { say: "b" }]));
    await c.wait(() => c.streamed(tab).includes("a"), "the target is replying");
    // A Stand-alone tab's leader codes itself: its turn in the same folder is a writer.
    await c.start(SOLO_TAB, JSON.stringify([{ sleep: 3000 }, { say: "solo" }]));
    const held = c.steer(tab, text);
    const busy = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.requestId === held), "the steer is held");
    assert.deepEqual([busy.action, busy.tabId], ["chat", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing was steered");
    assert.equal(c.answers(tab).some((row) => row.text === text), false, "and nothing was appended");
    const confirmed = c.steer(tab, text, { confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === confirmed), "Continue anyway steers it");
    await c.wait(() => reached(server, "codex", text).length, "the steer reached the CLI (the fake logs it a moment after the server wrote the chat row)");
    assert.deepEqual(reached(server, "codex", text).map((item) => item.kind), ["steer"]);
    // The automatic send of a queued message is a normal chat: held the same way while the writer is active.
    const auto = `auto${randomUUID().slice(0, 6)}`;
    c.send({ type: "chat", tabId: SPARE_TAB, text: "queued message", requestId: auto });
    await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.requestId === auto), "the normal send is held");
    assert.equal(c.answers(SPARE_TAB).length, 0);
    await c.finished(tab, 1, "the target ends", 20_000);
    await c.finished(SOLO_TAB, 1, "the solo tab ends", 20_000);
  });
});

const unansweredNotices = (c: Client, tab: string) => c.messages.filter((m) => m.type === "chatMessage" && m.tabId === tab && m.role === "notice" && /may not have been answered/.test(m.text));

test("polish 1: a steer waiting behind a FAILED Claude turn is answered, not forgotten: it keeps the turn open, the turn ends once with the failure after the steer's answer, and the chat says so", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 5), text = JSON.stringify([{ say: "STEER-AFTER-FAIL-ANSWER" }]);
    await c.start(tab, JSON.stringify([{ noFold: true }, { say: "first " }, { wait: 900 }, { failTurn: true }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.wait(() => c.failed(tab) >= 1, "the turn ends with the failure", 20_000);
    await sleep(600);
    assert.equal(c.failed(tab), 1, "one chatError, not one per CLI result");
    assert.equal(c.done(tab), 0);
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.includes("STEER-AFTER-FAIL-ANSWER") && rows[3]!.text.includes("leader turn failed"), `the steer's answer is kept and the failure follows it: ${rows[3]!.text}`);
    assert.equal(unansweredNotices(c, tab).length, 1, "and the chat says a steered message may be unanswered");
    assert.deepEqual(reached(server, "claude", "STEER-AFTER-FAIL-ANSWER").map((item) => item.kind), ["steer"]);
    await c.start(tab, "next-message");
    await c.finished(tab, 1, "the next turn works");
    assert.ok(!c.answers(tab).at(-1)!.text.includes("STEER-AFTER-FAIL"), "no text of the old turn leaked into the next");
  });
});

test("polish 5: a reply that FAILS or is STOPPED with a steered message in it says so in the chat, on every CLI; a Clear (which empties the chat) adds nothing", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const failing: Record<Cli, string> = {
      claude: JSON.stringify([{ say: "first " }, { wait: 900 }, { failTurn: true }]),
      codex: JSON.stringify([{ say: "first " }, { sleep: 900 }, { error: "boom" }]),
      opencode: JSON.stringify([{ say: `first ${PAD}` }, { sleep: 900 }, { error: "boom" }]),
    };
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), text = `STEER-FAILING-${cli}`;
      await c.start(tab, failing[cli]);
      await c.wait(() => c.streamed(tab).includes("first"), `${cli}: streaming`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: the steer is taken`);
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the reply fails`, 20_000);
      await sleep(300);
      assert.equal(unansweredNotices(c, tab).length, 1, `${cli}: failed reply, steer in the chat: the chat says it may be unanswered`);
    }
    for (const cli of CLIS) {
      const tab = tabOf(cli, 2), text = `STEER-STOPPED-${cli}`;
      await c.start(tab, slow(cli, HEAD, "part two"));
      await c.wait(() => c.streamed(tab).includes(cli === "opencode" ? "part one" : HEAD), `${cli}: streaming`);
      const requestId = c.steer(tab, text);
      await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `${cli}: the steer is taken`);
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the stop ends the reply`);
      await sleep(300);
      assert.equal(unansweredNotices(c, tab).length, 1, `${cli}: stopped reply, steer in the chat: the chat says it may be unanswered`);
    }
    // Clear empties the chat: nothing to explain, and no notice is written into the fresh chat.
    const tab = tabOf("codex", 3);
    await c.start(tab, slow("codex", HEAD, "part two"));
    await c.wait(() => c.streamed(tab).includes(HEAD), "clear: streaming");
    const requestId = c.steer(tab, "STEER-CLEARED");
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "clear: the steer is taken");
    c.send({ type: "clear", tabId: tab });
    await c.wait(() => c.failed(tab) >= 1, "clear: the reply ends");
    await sleep(300);
    assert.equal(unansweredNotices(c, tab).length, 0, "a Clear adds no notice");
    const lines = readFileSync(join(server.data, "chats", `${tab}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const clearedAt = lines.findLastIndex((row) => row.type === "clear");
    assert.ok(clearedAt >= 0, "the chat file records the clear");
    assert.deepEqual(lines.slice(clearedAt + 1), [], "nothing is written into the chat after the clear");
    assert.equal(lines.some((row) => /may not have been answered/.test(row.text ?? "")), false, "and the notice was never written");
  });
});

test("polish 2: OpenCode releases the reply so far at a steer through the redaction: the text before the steer is complete before the steered message, a secret only partly received is never shown in any form", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 1), text = "STEER-SECRET-SPLIT";
    await c.start(tab, JSON.stringify([{ say: PAD }, { leakHalf: 1200 }]));
    await c.wait(() => fakeLog(server).some((entry) => entry.leakHalfSecret), "the fake sent the first half of the secret");
    const secret: string = fakeLog(server).find((entry) => entry.leakHalfSecret).leakHalfSecret;
    await sleep(300);
    const requestId = c.steer(tab, text);
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "the steer is taken");
    const rowsAtSteer = c.answers(tab);
    assert.ok(rowsAtSteer[1]!.text.endsWith("visible-end "), `the reply so far is complete before the steered message: ${JSON.stringify(rowsAtSteer[1]!.text.slice(-40))}`);
    await c.finished(tab, 1, "the turn ends");
    const everything = JSON.stringify([c.messages.filter((m) => m.type !== "state"), c.streamed(tab), chatFile(server, tab)]);
    assert.equal(everything.includes(secret.slice(0, 8)), false, "no part of the secret was ever shown, saved or broadcast");
    assert.ok(c.answers(tab).map((row) => row.text).join("").includes("[hidden] after"), "the secret was hidden once it was complete");
  });
});

test("polish 3: OpenCode runs a steer as a SECOND run although its message was seen before the first idle: the turn stays open, the second run's text is kept, one chatDone", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 3), text = "STEER-LATE-SEEN";
    await c.start(tab, JSON.stringify([{ steerLate: "lateSeen" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 1, "the turn ends");
    await sleep(600);
    assert.equal(c.done(tab), 1, "one chatDone although OpenCode went idle twice");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "assistant"], JSON.stringify(rows));
    assert.ok(rows[3]!.text.endsWith(`opencode says hi to: ${text}`), `the second run's text was not dropped: ${rows[3]!.text}`);
    assert.equal(reached(server, "opencode", text).length, 1, "the prompt was posted once");
    await c.start(tab, "next-message");
    await c.finished(tab, 2, "the next turn works");
  });
});

test("polish 3b: OpenCode refuses the steer's prompt AFTER the first idle was held: the turn still ends, and the steer goes out as the next turn once", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 4), text = "STEER-REFUSED-AFTER-IDLE";
    await c.start(tab, JSON.stringify([{ steerLate: "lateFail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, text);
    await c.finished(tab, 2, "the reply ends and the handed-back steer is answered", 20_000);
    await sleep(300);
    assert.equal(c.done(tab), 2, "two turns, two chatDone, none stuck");
    const rows = c.answers(tab);
    assert.equal(rows.filter((row) => row.text === text).length, 1, "the steer is in the chat once");
    assert.equal(rows.at(-1)!.text, `opencode says hi to: ${text}`);
  });
});

test("polish 4: a steer that arrives while the tab's new leader is still waiting for a retired one is refused as 'starting' with its request id, reaches no CLI, appends nothing", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 1), text = "STEER-STARTING";
    await c.start(tab, slow("codex", HEAD, "part two", 3000));
    await c.wait(() => c.streamed(tab).includes(HEAD), "streaming");
    c.send({ type: "stopAll" });
    // The old Codex process is still being ended: the new message's turn is the tab's, but its leader does not exist yet.
    c.send({ type: "chat", tabId: tab, text: "AFTER-STOP", requestId: "p12after" });
    const requestId = c.steer(tab, text);
    const refused = await c.wait(() => c.messages.find((m) => m.type === "steerRefused" && m.requestId === requestId), "the refusal");
    assert.deepEqual([refused.reason, refused.tabId], ["starting", tab]);
    assert.equal(reached(server, "codex", text).length, 0, "nothing reached the CLI");
    await c.finished(tab, 1, "the message sent after the stop is answered");
    const rows = c.answers(tab);
    assert.equal(rows.some((row) => row.text === text), false, "the refused steer was not appended");
    assert.equal(rows.filter((row) => row.text === "AFTER-STOP").length, 1);
    assert.equal(chatFile(server, tab).filter((row) => row.text === text).length, 0);
  });
});

test("the sweep: every leader implementation has steer, sendLeaderTurn has exactly the call sites this file knows, and steerLeaderTurn never starts a turn itself", () => {
  const read = (path: string) => readFileSync(resolve(path), "utf8");
  for (const [file, pattern] of [["server/leader.ts", /return \{ send, steer, stop,/], ["server/leader-codex.ts", /return \{ send, steer, stop,/], ["server/leader-opencode.ts", /return \{ send, steer, stop,/]] as const) {
    assert.match(read(file), pattern, `${file} returns a steer`);
  }
  assert.match(read("server/leader-common.ts"), /steer: \(text: string, images: string\[\]\) => boolean;/);
  const index = read("server/index.ts");
  // The definition, then the places that start a turn: a normal chat, Save, and the resend of a steer the CLI handed back.
  const calls = index.split("\n").map((line, at) => ({ line: line.trim(), at })).filter(({ line }) => /\bsendLeaderTurn\(/.test(line) && !line.startsWith("//"));
  assert.deepEqual(calls.map(({ line }) => line.slice(0, 68)).sort(), [
    "function sendLeaderTurn(tabId: string, text: string, images: string[",
    "const turn = sendLeaderTurn(tabId, `Save a concise handover of this ",
    "void sendLeaderTurn(tabId, steer.text, steer.images).catch((err) => ",
    "void sendLeaderTurn(message.tabId, message.text, images, files, user",
  ].sort(), "a new sendLeaderTurn call site needs its own handling of a running reply");
  const body = index.slice(index.indexOf("function steerLeaderTurn("), index.indexOf("const OUTCOME_PEEK_BYTES"));
  assert.ok(body.length > 200 && !body.includes("sendLeaderTurn("), "steerLeaderTurn never starts a turn (the no-turn case is acceptChat)");
  assert.ok(body.includes("live.steer("), "and it steers through the leader handle");
  assert.equal(index.split("\n").filter((line) => line.includes("onSteerMissed:")).length, 1, "the tab hands a missed steer back in one place");
  // Every way a steered reply can end without an answer says so: a failed finish and a Stop both write the notice (a Clear empties the chat and does not).
  const finish = index.slice(index.indexOf("function finishLeaderTurn("), index.indexOf("function noteUnansweredSteer("));
  const stop = index.slice(index.indexOf("function stopLeaderSession("), index.indexOf("// Runs when an answer ends"));
  assert.ok(finish.includes("(steeredTurns.delete(tabId) || waitingBehind) && failed) noteUnansweredSteer(tabId)"), "a failed reply notes an unanswered steer, also one waiting behind it in lateSteers");
  assert.ok(stop.includes("(steeredTurns.has(tabId) || waitingBehind) && !clearUsage) noteUnansweredSteer(tabId)"), "a stopped reply notes an unanswered steer, also one waiting behind it in lateSteers");
  assert.ok(index.includes("steeredTurns.add(tabId)"), "and a taken steer marks its reply");
  // No steer path ends silently in an adapter: the Claude and OpenCode leaders no longer carry a 'forgotten' simplification.
  for (const file of ["server/leader.ts", "server/leader-opencode.ts"]) assert.equal(/ponytail:[^\n]*steer/i.test(read(file)), false, `${file} has no ponytail note about a steer left unhandled`);
});

// Fix round 4: every order in which OpenCode's idles, a steer's answer and a steer's refusal can meet the usage lookup, through the real server and the real adapter.
// Each case ends with exactly `done` chatDone (one per turn), after the complete text in order, nothing after it, no chatError; a steer is in the chat once; the usage
// is the newest idle's own (one report per turn). Times are ms from the moment the first idle's lookup began (or from the first text, when there is no lookup delay).
// Usage tokens: the fake's run N reports 900 + (N - 1) * 1000 input + 100 cache, so 1000 / 2000 / 3000 for the first / second / third run.
type MatrixSteer = { text: string; at: number; posts: number };
type MatrixCase = {
  label: string; env: Record<string, string>; first: string; on: "lookup" | "text"; steers: MatrixSteer[]; dup: "before" | "after" | "only" | null;
  roles: string[]; answer: number; ordered: string[]; done: number; usage: number;
};
const LOOKUP = { FAKE_OPENCODE_PROVIDERS_DELAY_MS: "1500" }, FIRST = JSON.stringify([{ say: `first ${PAD}` }]);
const steps = (name: string, ms: number): string => JSON.stringify([{ say: `${name}-start ` }, { sleep: ms }, { say: `${name}-end!` }]); // ends in a character that is not a hex digit: a held-back tail that could start a secret would otherwise show up as its own row after a later steer
const FOUR = ["user", "assistant", "user", "assistant"];
const MATRIX: MatrixCase[] = [
  { label: "a: a duplicate idle BEFORE the steer (dup at 50 ms, steer at 250 ms, lookup 1500 ms), the steered answer streams past the lookup", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1" }, first: FIRST, on: "lookup",
    steers: [{ text: steps("a", 2500), at: 250, posts: 1 }], dup: "before", roles: FOUR, answer: 3, ordered: ["a-start ", "a-end!"], done: 1, usage: 2000 },
  { label: "b: the steer is posted BEFORE the duplicate idle (steer at once, dup at 200 ms), the answer streams past the lookup", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1", FAKE_OPENCODE_DUP_IDLE_MS: "200" }, first: FIRST, on: "lookup",
    steers: [{ text: steps("b", 2500), at: 0, posts: 1 }], dup: "after", roles: FOUR, answer: 3, ordered: ["b-start ", "b-end!"], done: 1, usage: 2000 },
  { label: "c (was fix 3b): the steer's own run ends DURING the lookup (200 ms): its idle is not lost, the usage is its run's", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("c", 200), at: 0, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["c-start ", "c-end!"], done: 1, usage: 2000 },
  { label: "d (was fix 3 and 3c): the steer's own run ends AFTER the lookup (2500 ms): the turn stays open to its idle", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("d", 2500), at: 0, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["d-start ", "d-end!"], done: 1, usage: 2000 },
  { label: "e: steer A answered and its idle in, then steer B posted and refused, all inside the lookup: the turn ends, B goes out as the next turn", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("e-a", 150), at: 0, posts: 1 }, { text: "REFUSE-ONCE e-b", at: 500, posts: 2 }], dup: null, roles: [...FOUR, "user", "assistant"], answer: 3, ordered: ["e-a-start ", "e-a-end!"], done: 2, usage: 3000 },
  { label: "e2: as e but B is refused only after the lookup returned (the idle waits for it, the refusal ends the turn)", env: LOOKUP, first: FIRST, on: "lookup",
    steers: [{ text: steps("e2-a", 150), at: 0, posts: 1 }, { text: "REFUSE-ONCE-SLOW e2-b", at: 500, posts: 2 }], dup: null, roles: [...FOUR, "user", "assistant"], answer: 3, ordered: ["e2-a-start ", "e2-a-end!"], done: 2, usage: 3000 },
  { label: "f: the steer is answered inside the first run: one idle for both", env: {}, first: JSON.stringify([{ say: `first ${PAD}` }, { sleep: 900 }, { say: "tail-end" }]), on: "text",
    steers: [{ text: JSON.stringify([{ say: "f-start " }, { say: "f-end " }]), at: 300, posts: 1 }], dup: null, roles: FOUR, answer: 3, ordered: ["f-start ", "f-end ", "tail-end"], done: 1, usage: 1000 },
  { label: "g: a refused steer alone (the first idle is held, the refusal ends the turn), the steer goes out as the next turn", env: {}, first: JSON.stringify([{ steerLate: "lateFail" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]), on: "text",
    steers: [{ text: "STEER-G", at: 300, posts: 2 }], dup: null, roles: FOUR, answer: 3, ordered: ["opencode says hi to: STEER-G"], done: 2, usage: 2000 },
  { label: "h: no steer, a duplicate idle during the lookup: one usage, one chatDone", env: { ...LOOKUP, FAKE_OPENCODE_DUP_IDLE: "1" }, first: JSON.stringify([{ say: `first ${PAD}` }, { say: "h-end" }]), on: "lookup",
    steers: [], dup: "only", roles: ["user", "assistant"], answer: 1, ordered: ["first ", "h-end"], done: 1, usage: 1000 },
];
async function runMatrixCase(spec: MatrixCase): Promise<void> {
  await withServer(spec.env, async (server, c) => {
    const tab = tabOf("opencode", 1);
    await c.start(tab, spec.first);
    // The providers log line is written when the lookup request arrives (the first turn of a leader).
    if (spec.on === "lookup") await c.wait(() => fakeLog(server).some((entry) => entry.path === "/config/providers"), "the usage window lookup started");
    else await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    const began = Date.now();
    for (const steer of spec.steers) { await sleep(Math.max(0, steer.at - (Date.now() - began))); c.steer(tab, steer.text); }
    await c.finished(tab, spec.done, "the turn(s) end", 25_000);
    await sleep(900);
    assert.equal(c.done(tab), spec.done, "one chatDone per turn, none extra after the wait");
    assert.equal(c.failed(tab), 0, "no chatError");
    const rows = c.answers(tab);
    assert.deepEqual(rows.map((row) => row.role), spec.roles, JSON.stringify(rows));
    const text = rows[spec.answer]!.text;
    const at = spec.ordered.map((marker) => text.indexOf(marker));
    assert.ok(at.every((place, index) => place >= 0 && (index === 0 || place > at[index - 1]!)), `the whole text, in order: ${JSON.stringify(text)}`);
    assert.ok(text.endsWith(spec.ordered.at(-1)!), `nothing cut off, nothing after the end: ${JSON.stringify(text)}`);
    const log = fakeLog(server), dupAt = log.findIndex((entry) => entry.dupIdle);
    if (spec.on === "lookup") assert.equal(log.filter((entry) => entry.path === "/config/providers").length, 1, "overlapping idles share one providers read");
    if (spec.dup) assert.ok(dupAt >= 0, "the duplicate idle was sent");
    for (const steer of spec.steers) {
      assert.equal(rows.filter((row) => row.role === "user" && row.text === steer.text).length, 1, "the steer is in the chat once");
      assert.equal(log.filter((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(steer.text)).length, steer.posts, "posted as many times as expected");
    }
    if (spec.dup === "before" || spec.dup === "after") {
      const postedAt = log.findIndex((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(spec.steers[0]!.text));
      assert.ok(spec.dup === "before" ? dupAt < postedAt : postedAt < dupAt, `the order under test happened (dup at log line ${dupAt}, steer at ${postedAt})`);
    }
    const usage = c.tabState(tab).leaderUsage;
    assert.deepEqual([usage?.contextTokens, usage?.turns], [spec.usage, spec.done], "one usage report per turn, the newest idle's numbers");
  });
}
for (const spec of MATRIX) test(`fix 4r: OpenCode idle matrix, ${spec.label}`, { timeout: 60_000 }, () => runMatrixCase(spec));

test("fix 4: OpenCode, two steers where the second is refused after the first one's answer began: the turn still ends (once) and the refused one goes out as the next turn, once", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 2), a = "STEER-A-opencode", b = "STEER-B-opencode";
    await c.start(tab, JSON.stringify([{ steerLate: "failSecond" }, { say: `first ${PAD}` }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, a);
    await sleep(150);
    c.steer(tab, b);
    await c.finished(tab, 2, "the reply ends and the refused steer is answered as the next turn", 20_000);
    await sleep(300);
    assert.equal(c.done(tab), 2, "two turns, two chatDone, none stuck");
    assert.equal(c.failed(tab), 0);
    const rows = c.answers(tab);
    assert.ok(rows.some((row) => row.role === "assistant" && row.text.includes(`[steer: ${a}]`)), "the first steer was answered inside the reply");
    assert.equal(rows.filter((row) => row.text === b).length, 1, "the refused steer is in the chat once");
    assert.equal(rows.at(-1)!.text, `opencode says hi to: ${b}`, "and its answer comes last");
    assert.equal(chatFile(server, tab).filter((row) => row.text === b).length, 1);
    assert.equal(fakeLog(server).filter((entry) => entry.path?.endsWith("/prompt_async") && String(entry.body?.parts?.[0]?.text).includes(b)).length, 2, "posted as a steer (refused) and once more as a turn");
  });
});

test("fix 5: OpenCode, a secret only partly received is never shown when the reply is stopped (with a steer, and without one) or when the leader dies; the part is shown as [hidden]", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    // The fake logs the password when it sends the first half of it; `count` is how many such logs there should be by now.
    const half = async (count: number): Promise<string> => {
      await c.wait(() => fakeLog(server).filter((entry) => entry.leakHalfSecret).length >= count, "the fake sent the first half of the secret");
      return fakeLog(server).filter((entry) => entry.leakHalfSecret)[count - 1].leakHalfSecret;
    };
    const everythingOf = (tab: string) => JSON.stringify([c.messages.filter((m) => m.type !== "state" && m.tabId === tab), c.streamed(tab), chatFile(server, tab)]);
    // Stop after a steer.
    const steered = tabOf("opencode", 2);
    await c.start(steered, JSON.stringify([{ say: PAD }, { leakHalf: 8000 }]));
    const secret = await half(1);
    await sleep(300);
    const requestId = c.steer(steered, "STEER-THEN-STOP");
    await c.wait(() => c.messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), "the steer is taken");
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(steered) >= 1, "the stop ends the reply");
    await sleep(300);
    assert.equal(everythingOf(steered).includes(secret.slice(0, 8)), false, "stop after a steer: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, steered).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "the held part was written as [hidden]");
    // Stop with no steer at all.
    const plain = tabOf("opencode", 3);
    await c.start(plain, JSON.stringify([{ say: PAD }, { leakHalf: 8000 }]));
    const secret2 = await half(2);
    await sleep(300);
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(plain) >= 1, "the stop ends the reply");
    await sleep(300);
    assert.equal(everythingOf(plain).includes(secret2.slice(0, 8)), false, "plain stop: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, plain).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "plain stop: written as [hidden]");
    // The leader dies (its process ends) while the secret is half there.
    const dying = tabOf("opencode", 4);
    await c.start(dying, JSON.stringify([{ say: PAD }, { exitAfter: 1200 }, { leakHalf: 8000 }]));
    const secret3 = await half(3);
    await c.wait(() => c.failed(dying) >= 1, "the death ends the reply", 20_000);
    await sleep(300);
    assert.equal(everythingOf(dying).includes(secret3.slice(0, 8)), false, "death: no part of the secret was shown, saved or broadcast");
    assert.ok(chatFile(server, dying).some((row) => row.role === "assistant" && row.text.includes("[hidden]")), "death: written as [hidden]");
  });
});

test("fix 7: a second handed-back steer waiting behind the first one's resent turn: when that turn FAILS or is STOPPED the chat says so once; after a Clear it says nothing", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const firstTurn = JSON.stringify([{ steerLate: "error" }, { say: "first " }, { sleep: 900 }, { say: "end " }]);
    const B = "STEER-B-WAITING";
    // Both steers are handed back by the CLI; the first turn succeeds; A goes out as the next turn, B waits behind it.
    const run = async (tab: string, a: string) => {
      await c.start(tab, firstTurn);
      await c.wait(() => c.streamed(tab).includes("first"), `${tab}: streaming`);
      c.steer(tab, a);
      c.steer(tab, B);
      await c.wait(() => c.done(tab) >= 1, `${tab}: the first turn ends`, 20_000);
      await c.wait(() => reached(server, "codex", a).some((item) => item.kind === "start"), `${tab}: A runs as the next turn`);
    };
    const failing = tabOf("codex", 1);
    await run(failing, JSON.stringify([{ sleep: 300 }, { error: "boom" }]));
    await c.wait(() => c.failed(failing) >= 1, "A's turn fails", 20_000);
    await sleep(500);
    assert.equal(unansweredNotices(c, failing).length, 1, "fail: one notice for the ended reply (not one per message)");
    assert.equal(reached(server, "codex", B).filter((item) => item.kind === "start").length, 0, "B was not sent on its own after the failure");

    const stopped = tabOf("codex", 2);
    await run(stopped, JSON.stringify([{ sleep: 5000 }, { say: "A-long-stop" }]));
    c.send({ type: "stopAll" });
    await c.wait(() => c.failed(stopped) >= 1, "the stop ends A's turn");
    await sleep(500);
    assert.equal(unansweredNotices(c, stopped).length, 1, "stop: one notice");
    assert.equal(reached(server, "codex", B).filter((item) => item.kind === "start").length, 0, "B was not sent on its own after the stop");

    const cleared = tabOf("codex", 3);
    await run(cleared, JSON.stringify([{ sleep: 5000 }, { say: "A-long-clear" }]));
    c.send({ type: "clear", tabId: cleared });
    await c.wait(() => c.failed(cleared) >= 1, "the clear ends A's turn");
    await sleep(500);
    assert.equal(unansweredNotices(c, cleared).length, 0, "clear: no notice");
    const lines = readFileSync(join(server.data, "chats", `${cleared}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.slice(lines.findLastIndex((row) => row.type === "clear") + 1), [], "nothing was written into the cleared chat");
  });
});

test("fix 8: Save clicked while a reply runs and a handed-back steer waits behind it: Save waits for the steer's turn too, then saves; nothing is sent twice", { timeout: 90_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("codex", 1), steerText = JSON.stringify([{ sleep: 600 }, { say: "A-done" }]);
    await c.start(tab, JSON.stringify([{ steerLate: "error" }, { say: "first " }, { sleep: 900 }, { say: "end " }]));
    await c.wait(() => c.streamed(tab).includes("first"), "streaming");
    c.steer(tab, steerText); // the CLI hands it back: it waits behind this reply
    // The fake CLI writes no handover, so the test plants one whose time is a minute ahead: the server only asks that the file is newer than the moment Save
    // started (which is taken after the steer's turn ends). A writer rewriting it every 2 ms could not do that under load: when the test process got no time
    // inside Save's few milliseconds the file was older and Save was refused (the folder is the test's own temp folder).
    const file = join(server.work, ".command-center", tab, "RESUME.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "handover");
    const ahead = new Date(Date.now() + 60_000); utimesSync(file, ahead, ahead);
    c.send({ type: "save", tabId: tab });
    try {
      await c.wait(() => c.messages.find((m) => m.type === "saved" && m.tabId === tab), "Save succeeds after the steer's turn", 30_000);
    } catch (error) {
      // Seen once under heavy load with nothing else to go on: say exactly what happened (what the client received, what reached the fake CLI).
      const types: string[] = [];
      for (const m of c.messages) { const t = `${m.type}${m.tabId && m.tabId !== tab ? `(${m.tabId})` : ""}`; if (types.at(-1)?.startsWith(`${t} x`) || types.at(-1) === t) types[types.length - 1] = `${t} x${(Number(types.at(-1)!.split(" x")[1]) || 1) + 1}`; else types.push(t); }
      const turns = fakeLog(server).filter((entry) => entry.cli === "codex" && entry.method === "turn/start").map((entry) => `${entry.at ?? ""} ${String(entry.params?.input?.[0]?.text).slice(0, 70)}`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}
message types the client received, in order: ${types.join(", ")}
the fake CLI's turn/start log for this tab: ${JSON.stringify(turns)}
handover file mtime - now: ${statSync(file).mtimeMs - Date.now()} ms
server log tail: ${server.log().slice(-1500)}`, { cause: error });
    }
    assert.equal(c.messages.some((m) => m.type === "error" && m.action === "save"), false, "no Save failure was reported");
    const log = fakeLog(server).filter((entry) => entry.cli === "codex" && entry.method === "turn/start");
    const order = log.map((entry) => String(entry.params.input[0].text));
    assert.equal(order.filter((text) => text.includes("A-done")).length, 1, "the steer's turn started once");
    assert.equal(order.filter((text) => text.includes("Save a concise handover")).length, 1, "the handover prompt reached the CLI once");
    assert.ok(order.findIndex((text) => text.includes("A-done")) < order.findIndex((text) => text.includes("Save a concise handover")), "after the steer's turn");
    assert.equal(c.done(tab), 3, "the reply, the steer's turn and Save each ended once");
    assert.equal(c.answers(tab).filter((row) => row.text === steerText).length, 1, "the steer is in the chat once");
  });
});

test("fix 5b: at the end of a reply an end that only looks like the start of a secret is kept when it is short (3 characters of ordinary text) and hidden from 4 characters on", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 5);
    // Every OpenCode leader's secrets include the base64 of "opencode:<password>", which always starts with b3BlbmNvZGU6.
    await c.start(tab, JSON.stringify([{ say: `${PAD} ends b3B` }]));
    await c.finished(tab, 1, "the first reply ends");
    assert.ok(c.answers(tab).at(-1)!.text.endsWith(" ends b3B"), `3 characters are ordinary text: ${c.answers(tab).at(-1)!.text.slice(-20)}`);
    await c.start(tab, JSON.stringify([{ say: `${PAD} ends b3Bl` }]));
    await c.finished(tab, 2, "the second reply ends");
    const last = c.answers(tab).at(-1)!.text;
    assert.ok(last.endsWith(" ends [hidden]") && !last.includes("b3Bl"), `4 characters of a secret are hidden: ${last.slice(-20)}`);
  });
});
