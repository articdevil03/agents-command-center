// Pack 9, the warning flow through real servers: chat and Run are held with a `folderBusy` message when another agent is working in the tab's folder,
// "Continue anyway" (confirmBusy) sends them and quiets exactly what was shown for 10 minutes, a leader-started run launches with one notice, and Command
// Center's own sessions never count. Another tab's writing seat (a coder or fixer run, a Stand-alone leader's turn) in a related folder warns too. Each server runs on a temp data root with a Codex leader (fake app-server), a fake HOME and a fake activity home
// (CC_TEST_FAKE_CLI_ACTIVITY_HOME): the real ~/.claude, ~/.codex and OpenCode database are never read. PATH holds fake claude/codex/opencode .cmd files
// that write a file into their working folder (a crew run's own file change) and exit.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { KILL_TIMEOUT_MS, LIST_TIMEOUT_MS } from "../server/leader-common.ts";
import { scratchDir } from "./temp-root.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { codexRecord as plantCodexRecord } from "./codex-record.ts";

const SEATS = getProcessDefinition("dev", "main").seats;
const LEADERS = { codex: { cli: "codex", model: "gpt-6-sol", effort: "high" }, claude: { cli: "claude", model: SEATS.find((seat) => seat.isLeader)!.model, effort: SEATS.find((seat) => seat.isLeader)!.effort }, opencode: { cli: "opencode", model: "fakeprov/fake-model", effort: "max" } };
const crewFor = (process: "main" | "solo" = "main", leader: keyof typeof LEADERS = "codex") => getProcessDefinition("dev", process).seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? LEADERS[leader] : {}) }));
const TAB_A = "p9-a", TAB_B = "p9-b";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// A crew run is reported over only after its cleanup sweep, which the runner caps at SWEEP_WAIT_MS (LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000): a wait for a run's end outlasts that cap.
const RUN_END_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 1000 + 7000;
const touch = (path: string, mtimeMs: number) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);

// The fake CLIs: a crew run "writes a file" in the folder it runs in, optionally stays a few seconds (FAKE_RUN_SLEEP), and ends.
const cliDir = scratchDir();
for (const name of ["claude", "codex", "opencode"]) writeFileSync(join(cliDir, `${name}.cmd`), "@echo off\r\necho ran> \"%CD%\\run-wrote.txt\"\r\nif defined FAKE_RUN_SLEEP ping -n %FAKE_RUN_SLEEP% 127.0.0.1 >nul\r\nexit /b 0\r\n");

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

type Server = { port: number; key: string; temp: string; data: string; work: string; activityHome: string; child: ChildProcess; log: () => string; stop: (keep?: boolean) => Promise<void> };
type TabSpec = { id: string; name?: string; process?: "main" | "solo"; folder: string };
async function boot(options: { temp?: string; env?: Record<string, string>; noActivityHome?: boolean; leader?: keyof typeof LEADERS; tabs?: (work: string) => TabSpec[] } = {}): Promise<Server> {
  const fresh = !options.temp;
  const temp = options.temp ?? mkdtempSync(join(tmpdir(), "cc-pack9-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), activityHome = join(temp, "activity-home");
  for (const dir of [home, work, activityHome, join(data, "config")]) mkdirSync(dir, { recursive: true });
  if (fresh) {
    const tab = (spec: TabSpec) => ({ id: spec.id, name: spec.name ?? spec.id, kind: "dev", process: spec.process ?? "main", folder: spec.folder, crew: crewFor(spec.process ?? "main", options.leader) });
    const specs = options.tabs?.(work) ?? [{ id: TAB_A, folder: work }, { id: TAB_B, folder: work }];
    for (const spec of specs) mkdirSync(spec.folder, { recursive: true });
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p9", name: "P9", folder: work, tabs: specs.map(tab) }] }));
  }
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  const port = await freePort();
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [cliDir, dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, ...(options.noActivityHome ? {} : { CC_TEST_FAKE_CLI_ACTIVITY_HOME: activityHome }), ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack9-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const end = Date.now() + 10_000;
  while (!log.includes("127.0.0.1") && Date.now() < end) await sleep(10);
  assert.ok(log.includes("127.0.0.1"), `server did not start: ${log}`);
  return {
    port, key, temp, data, work, activityHome, child, log: () => log,
    stop: async (keep = false) => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      // A crew run's fake CLI can still hold the work folder for a few seconds (a failed test leaves it running): retry rather than let the removal error hide the real failure.
      } finally { if (!keep) removeWithRetry(temp, 40, 500); }
    },
  };
}

async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open");
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const wait = async <T>(fn: () => T, label: string, ms = 10_000): Promise<NonNullable<T>> => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-5))}`);
  };
  send({ type: "hello" });
  await wait(() => messages.find((m) => m.type === "state"), "first state");
  let n = 0;
  const api = {
    messages, send, wait, close: () => socket.terminate(),
    state: () => messages.filter((m) => m.type === "state").at(-1),
    tab: (id: string) => api.state().projects[0].tabs.find((t: any) => t.id === id),
    // A chat message and what the server answered to it: held (folderBusy), taken (the user's message echoed with this request id), or refused (error).
    chat: async (tabId: string, text: string, options: { confirmBusy?: boolean } = {}) => {
      const requestId = `p9r${++n}`;
      send({ type: "chat", tabId, text, requestId, ...(options.confirmBusy ? { confirmBusy: true } : {}) });
      const answer = await wait(() => messages.find((m) => (m.type === "folderBusy" || m.type === "error") && m.requestId === requestId) ?? messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `an answer to ${requestId}`);
      return { requestId, answer, held: answer.type === "folderBusy", taken: answer.type === "chatMessage" };
    },
    turnDone: (tabId: string) => messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length,
    chatAndFinish: async (tabId: string, text: string, options: { confirmBusy?: boolean } = {}) => {
      const before = api.turnDone(tabId);
      const result = await api.chat(tabId, text, options);
      if (result.taken) await wait(() => api.turnDone(tabId) > before, `the turn of ${result.requestId} finished`);
      return result;
    },
    busyProbe: async (tabId: string) => {
      const start = messages.length;
      send({ type: "testFolderBusy", tabId });
      return (await wait(() => messages.slice(start).find((m) => m.type === "testFolderBusyResult" && m.tabId === tabId), "the folder probe")).items as { tool: string | null; agoSeconds: number; writer?: { seatName: string; roleLabel: string; tabName: string } }[];
    },
    // Windows can report a file change late or in bursts: retry on the read-only probe, never assert on the first tick.
    busyUntil: async (tabId: string, ms = 10_000) => {
      const until = Date.now() + ms;
      for (;;) { const probe = await api.busyProbe(tabId); if (probe.length || Date.now() > until) return probe; await sleep(50); }
    },
    runEnds: () => messages.filter((m) => m.type === "runFinish" || m.type === "runFail" || m.type === "runStop").length,
  };
  return api;
}

// ---- fake records ----
function codexRecord(server: Server, id: string, mtimeMs: number, cwd = server.work): string {
  return plantCodexRecord(server.activityHome, cwd, id, mtimeMs);
}
function claudeRecord(server: Server, id: string, mtimeMs: number): string {
  const dir = join(server.activityHome, ".claude", "projects", server.work.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `{"type":"user","sessionId":"${id}"}\n`);
  touch(file, mtimeMs);
  return file;
}
function opencodeRecord(server: Server, id: string, mtimeMs: number, createdMs = mtimeMs): void {
  const path = join(server.activityHome, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new (process.getBuiltinModule("node:sqlite")!).DatabaseSync(path);
  db.exec("create table if not exists session (id text primary key, directory text, time_updated integer, time_created integer)");
  db.prepare("insert or replace into session (id, directory, time_updated, time_created) values (?, ?, ?, ?)").run(id, server.work, mtimeMs, createdMs);
  db.close();
}
const fakeLeaderTurns = (server: Server) => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e: any) => e.method === "turn/start").length;

async function withServer(options: Parameters<typeof boot>[0], body: (server: Server, c: Awaited<ReturnType<typeof client>>) => Promise<void>): Promise<void> {
  const server = await boot(options);
  const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
}

test("chat: an outside Codex session holds the message (nothing saved, no turn, no leader), Continue anyway sends it, the next message is not asked again, a NEW outside session asks again", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    codexRecord(server, "ext-codex-1", Date.now() - 40_000);
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual([held.answer.action, held.answer.tabId, held.answer.requestId], ["chat", TAB_A, held.requestId]);
    assert.deepEqual(held.answer.items.map((i: any) => i.tool), ["Codex"]);
    assert.ok(held.answer.items[0].agoSeconds >= 38 && held.answer.items[0].agoSeconds <= 70, `about 40 seconds ago, got ${held.answer.items[0].agoSeconds}`);
    await sleep(400);
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === held.requestId), false, "the user's message was not appended");
    assert.equal(existsSync(join(server.data, "chats", `${TAB_A}.jsonl`)), false, "no transcript was written");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started", "no leader was started");
    assert.equal(c.tab(TAB_A).derived.leaderTurnActive, false);
    assert.equal(fakeLeaderTurns(server), 0, "no turn reached the leader");

    const confirmed = await c.chatAndFinish(TAB_A, "hello", { confirmBusy: true });
    assert.ok(confirmed.taken, "Continue anyway sends it under a fresh request id");
    assert.notEqual(confirmed.requestId, held.requestId);
    assert.equal(fakeLeaderTurns(server), 1);
    const second = await c.chatAndFinish(TAB_A, "and another");
    assert.ok(second.taken, "within 10 minutes the same session is not asked about again");

    claudeRecord(server, "ext-claude-1", Date.now() - 10_000);
    const again = await c.chat(TAB_A, "third");
    assert.ok(again.held, "a new outside session asks again");
    assert.deepEqual(again.answer.items.map((i: any) => i.tool), ["Claude Code"], "only the new one: the Codex session stays quiet");
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === again.requestId), false);
    const sent = await c.chatAndFinish(TAB_A, "third", { confirmBusy: true });
    assert.ok(sent.taken);
    // A confirm with nothing shown snoozes nothing: a stranger that appears now still asks.
    opencodeRecord(server, "ext-oc-1", Date.now() - 5_000);
    const stranger = await c.chat(TAB_A, "fourth", { confirmBusy: true });
    assert.ok(stranger.held, "confirmBusy only quiets what this tab was shown last");
    assert.deepEqual(stranger.answer.items.map((i: any) => i.tool), ["OpenCode"]);
  });
});

test("user Run: held with the same warning, nothing launched; Continue anyway launches; the next Run is not asked; a Run on a seat that cannot be launched is not held", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    opencodeRecord(server, "ext-oc-1", Date.now() - 20_000);
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build it" });
    const held = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run"), "the Run is held");
    assert.deepEqual([held.tabId, held.items.map((i: any) => i.tool)], [TAB_A, ["OpenCode"]]);
    await sleep(500);
    assert.equal(c.messages.some((m) => m.type === "runAccepted" || m.type === "runStart"), false, "nothing was launched");
    assert.equal(existsSync(join(server.work, "run-wrote.txt")), false, "the fake CLI never ran");
    assert.equal(c.tab(TAB_A).runs.length, 0);

    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build it", confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "runAccepted" && m.tabId === TAB_A), "Continue anyway launches");
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    assert.ok(existsSync(join(server.work, "run-wrote.txt")), "the fake CLI ran in the tab's folder");
    const accepted = c.messages.filter((m) => m.type === "runAccepted").length;
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "build more" });
    await c.wait(() => c.messages.filter((m) => m.type === "runAccepted").length > accepted, "the next Run goes straight through");
    assert.equal(c.messages.filter((m) => m.type === "folderBusy").length, 1, "asked once");
    // A leader slot cannot be launched as a worker: that refusal is the normal one, not a warning.
    codexRecord(server, "ext-codex-x", Date.now() - 5_000);
    c.send({ type: "run", tabId: TAB_A, slot: "leader", prompt: "x" });
    await c.wait(() => c.messages.find((m) => m.type === "error" && m.action === "run" && /leader/.test(m.message)), "the normal refusal");
    assert.equal(c.messages.filter((m) => m.type === "folderBusy").length, 1);
  });
});

test("a leader-started crew run is never held: it launches, and says once per outside session per 10 minutes that one is active", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader"); // no outside session yet
    const results = () => c.messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A);
    // The heads-up is a quiet chat line only: the page turns a chatNotice into a pop-up, so none may be sent for it.
    const notices = () => c.messages.filter((m) => m.type === "chatMessage" && m.role === "notice" && m.tabId === TAB_A && /Heads up/.test(m.text)).map((m) => ({ message: m.text }));
    const popups = () => c.messages.filter((m) => m.type === "chatNotice" && /Heads up/.test(m.message));
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "quiet launch" });
    await c.wait(() => results()[0], "a launch with nothing outside");
    assert.equal(results()[0].ok, true);
    assert.equal(notices().length, 0, "no outside session, no notice");

    codexRecord(server, "ext-codex-2", Date.now() - 5_000);
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "with an outsider" });
    await c.wait(() => results()[1], "the launch with an outsider");
    assert.equal(results()[1].ok, true, "never blocked");
    assert.deepEqual(notices().map((m) => m.message), ["Heads up: a Codex session outside Command Center is active in this folder."]);
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "again" });
    await c.wait(() => results()[2], "the second launch");
    assert.equal(results()[2].ok, true);
    assert.equal(notices().length, 1, "once per outside session");
    assert.equal(popups().length, 0, "no pop-up for it");
    assert.equal(c.messages.some((m) => m.type === "folderBusy"), false, "a leader launch never asks");
    await c.wait(() => c.runEnds() >= 3, "the three runs ended", RUN_END_MS);
    // The heads-up is kept with that launch's notice (so it survives a reload and a new connection), once, and is not chat.
    const kept = (await client(server));
    try {
      const withHeadsUp = kept.state().launchSafety.notices.filter((n: any) => n.headsUp);
      assert.deepEqual(withHeadsUp.map((n: any) => [n.brief, n.headsUp]), [["with an outsider", "a Codex session outside Command Center is active in this folder"]], "only the launch that announced it carries it");
      // The heads-up is also a quiet line inside the tab's chat: saved with it (once), shown to a new connection, and never told to the leader.
      const line = "Heads up: a Codex session outside Command Center is active in this folder.";
      const live = c.messages.filter((m) => m.type === "chatMessage" && m.tabId === TAB_A && m.role === "notice");
      assert.deepEqual(live.map((m) => m.text), [line], "sent to the open page as a chat line");
      const saved = readFileSync(join(server.data, "chats", `${TAB_A}.jsonl`), "utf8").trim().split("\n").map((row) => JSON.parse(row)).filter((row) => row.role === "notice");
      assert.deepEqual(saved.map((row) => row.text), [line], "saved with the chat, so it survives a restart");
      const history = kept.messages.find((m) => m.type === "chatHistory" && m.tabId === TAB_A);
      assert.deepEqual(history.messages.filter((m: any) => m.role === "notice").map((m: any) => m.text), [line], "a new connection reads it back");
      assert.equal(readFileSync(join(server.temp, "fake-leader.log"), "utf8").includes("outside Command Center"), false, "never sent to the leader");
    } finally { kept.close(); }
  });
});

test("Command Center's own leader session never warns, also after a restart within 2 minutes; a stranger still does", { timeout: 120_000 }, async () => {
  const server = await boot();
  let second: Server | undefined;
  try {
    const c = await client(server);
    const started = await c.chatAndFinish(TAB_A, "start the leader"); // the fake Codex leader's thread is thread-1
    assert.ok(existsSync(join(server.data, "config", "own-sessions.json")), "the own-session registry was saved");
    // A record last written while that leader turn was running: only the turn's window can say it is ours.
    codexRecord(server, "written-during-the-turn", started.answer.at + 100);
    // Written far past every window of ours (30 s ahead), so only its id can say it is ours.
    codexRecord(server, "thread-1", Date.now() + 30_000);
    const own = await c.chatAndFinish(TAB_A, "second");
    assert.ok(own.taken, "our own leader's session record and a record written during its turn do not warn");
    codexRecord(server, "stranger-1", Date.now() + 30_000);
    const stranger = await c.chat(TAB_A, "third");
    assert.ok(stranger.held && stranger.answer.items.length === 1, `only the stranger: ${JSON.stringify(stranger.answer)}`);
    c.close();
    await server.stop(true);

    // The app is closed and reopened: the leader is gone, but its session is remembered.
    second = await boot({ temp: server.temp });
    const c2 = await client(second);
    assert.equal(c2.tab(TAB_A).leaderStatus, "not-started", "no leader has started yet: only the saved registry can know thread-1");
    const after = await c2.chat(TAB_A, "first message after the restart");
    assert.ok(after.held, "the stranger still warns");
    assert.equal(after.answer.items.length, 1, "and neither thread-1 (its saved id) nor the record written during the turn (its saved window) does");
    c2.close();
  } finally {
    await second?.stop();
    if (!second) await server.stop();
    else if (existsSync(server.temp)) removeWithRetry(server.temp);
  }
});

test("a crew run's own session (window by time) never warns, also after the run ended; one written after its window does", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "work" });
    const started = await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_A), "the run started");
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    assert.ok(existsSync(join(server.work, "run-wrote.txt")), "its CLI wrote a file into the folder");
    // The run's CLI session, last written during the run.
    codexRecord(server, "crew-run-session", started.startedAt + 300);
    await sleep(300);
    const ours = await c.chatAndFinish(TAB_A, "after the run");
    assert.ok(ours.taken, `the run's own record and its own file change do not warn: ${JSON.stringify(ours.answer)}`);
    codexRecord(server, "late-stranger", Date.now() + 30_000); // after the window and its slack
    const late = await c.chat(TAB_A, "next");
    assert.ok(late.held && late.answer.items.length === 1, "control: a record outside the window warns");
  });
});

test("an outside session that was already running when our crew run started still warns (chat and leader heads-up); one created inside the run's window is taken as ours", { timeout: 120_000 }, async () => {
  await withServer({ env: { FAKE_RUN_SLEEP: "20" }, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader");
    await sleep(11_000); // past the leader turn's window and its slack, so only the crew run's window is in play
    const early = Date.now();
    const files = [codexRecord(server, "ext-codex-before", early), claudeRecord(server, "ext-claude-before", early)];
    opencodeRecord(server, "ext-oc-before", early, early);
    await sleep(1_600); // the run's window opens clearly after these were created
    c.send({ type: "run", tabId: TAB_B, slot: "coder", prompt: "work" });
    await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run" && m.tabId === TAB_B), "the Run is held for the outsiders");
    c.send({ type: "run", tabId: TAB_B, slot: "coder", prompt: "work", confirmBusy: true }); // held for the outsiders, so the person continues
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_B), "the run in the other tab started");
    // The outsiders keep working inside the run's window; one more starts inside it (a crew CLI gives no id, so that one is taken as ours).
    for (const file of files) touch(file, Date.now());
    opencodeRecord(server, "ext-oc-before", Date.now(), early);
    codexRecord(server, "started-inside", Date.now());
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual(held.answer.items.filter((i: any) => !i.writer).map((i: any) => i.tool).sort(), ["Claude Code", "Codex", "OpenCode"], "all three already-running outsiders warn; the session created inside the window does not (one Codex, not two)");
    assert.equal(held.answer.items.filter((i: any) => i.writer).length, 1, "and the other tab's coder, as before");
    // A leader-started run says the same in its heads-up line.
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "reviewer1", brief: "with outsiders" });
    await c.wait(() => c.messages.find((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A), "the launch");
    const line = c.messages.find((m) => m.type === "chatMessage" && m.role === "notice" && m.tabId === TAB_A && /Heads up/.test(m.text))?.text ?? "";
    assert.match(line, /a Codex session outside Command Center is active/);
    assert.match(line, /a Claude Code session outside Command Center is active/);
    assert.match(line, /an OpenCode session outside Command Center is active/);
    assert.equal(line.match(/Codex session/g)?.length, 1, "the session created inside the window is not announced");
    await c.wait(() => c.runEnds() >= 2, "the runs ended", 60_000);
  });
});

test("another Command Center tab working on the same folder is not an outsider (its run and its file change warn only as that tab's writer)", { timeout: 120_000 }, async () => {
  await withServer({ env: { FAKE_RUN_SLEEP: "7" } }, async (server, c) => {
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "long work" });
    await c.wait(() => c.messages.find((m) => m.type === "runStart" && m.tabId === TAB_A), "the run in the first tab started");
    await c.wait(() => existsSync(join(server.work, "run-wrote.txt")), "its CLI wrote a file");
    await sleep(600); // the watch event for that file arrives (late events are common)
    assert.equal(c.runEnds(), 0, "the first tab's run is still working");
    const seen = await c.busyProbe(TAB_B);
    assert.deepEqual(seen.map((i) => i.writer?.tabName), [TAB_A], "the second tab sees the first tab's coder and nothing outside");
    assert.ok((await c.chat(TAB_B, "from the other tab")).held, "the message is held for it");
    const other = await c.chatAndFinish(TAB_B, "from the other tab", { confirmBusy: true });
    assert.ok(other.taken, "Continue anyway sends it");
    await c.wait(() => c.runEnds() >= 1, "the run ended", 30_000);
  });
});

test("catch-all: a file written into the folder while none of our agents works there warns ('something outside'); Continue anyway sends it and quiets it for 10 minutes", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    assert.deepEqual(await c.busyProbe(TAB_A), [], "control: quiet before the write");
    writeFileSync(join(server.work, "outside-edit.txt"), "someone else");
    const seen = await c.busyUntil(TAB_A);
    assert.deepEqual(seen.map((i) => i.tool), [null]);
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, "the message is held");
    assert.deepEqual(held.answer.items.map((i: any) => i.tool), [null], "it cannot name the tool");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started");
    const sent = await c.chatAndFinish(TAB_A, "hello", { confirmBusy: true });
    assert.ok(sent.taken);
    writeFileSync(join(server.work, "outside-edit-2.txt"), "again");
    await sleep(700);
    const next = await c.chatAndFinish(TAB_A, "and again");
    assert.ok(next.taken, "the same catch-all is quiet for 10 minutes");
  });
});

test("our own windows end with the work: 12 s after a leader turn and a crew run, a file an outsider writes warns (nothing stays 'ours' for ever)", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    await c.chatAndFinish(TAB_A, "a leader turn");
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "work" });
    await c.wait(() => c.runEnds() >= 1, "the run ended", RUN_END_MS);
    await sleep(12_000); // a window still covers a late flush for 10 s after its work ended
    writeFileSync(join(server.work, "outsider.txt"), "someone else");
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.tool), [null]);
  });
});

test("a tab whose folder is changed is watched at its new folder (and the folder it left stays watched for the tab that remains)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const elsewhere = join(server.temp, "work-elsewhere");
    mkdirSync(elsewhere);
    c.send({ type: "changeFolder", tabId: TAB_B, folder: elsewhere });
    await c.wait(() => c.tab(TAB_B).folder.toLowerCase() === realpathSync(elsewhere).toLowerCase(), "the folder changed");
    writeFileSync(join(server.work, "old-folder.txt"), "x"); // the old folder (tab A still works there, so it is watched)
    writeFileSync(join(elsewhere, "new-folder.txt"), "x");
    assert.deepEqual((await c.busyUntil(TAB_B)).map((i) => i.tool), [null], "the new folder is watched");
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.tool), [null], "control: the old folder still is, for the tab that stayed");
  });
});

test("catch-all: a change inside .git, node_modules or .command-center does not warn", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const dir of [".git", "node_modules/pkg", ".command-center/tab"]) { mkdirSync(join(server.work, dir), { recursive: true }); writeFileSync(join(server.work, dir, "x.txt"), "x"); }
    await sleep(900);
    assert.deepEqual(await c.busyProbe(TAB_A), []);
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken);
  });
});

test("records that cannot be read never block a message (a corrupt OpenCode database, a bad Codex record, a Claude project that is a file)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const dbPath = join(server.activityHome, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "this is not a database".repeat(100));
    const day = new Date(), pad = (v: number) => String(v).padStart(2, "0");
    const dir = join(server.activityHome, ".codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-bad.jsonl"), "{broken\n");
    mkdirSync(join(server.activityHome, ".claude"), { recursive: true });
    writeFileSync(join(server.activityHome, ".claude", "projects"), "not a folder");
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken, `the message went through: ${JSON.stringify(sent.answer)}`);
  });
});

test("without CC_TEST_FAKE_CLI_ACTIVITY_HOME the server reads no records at all (the test runner never touches a real home)", { timeout: 60_000 }, async () => {
  await withServer({ noActivityHome: true }, async (server, c) => {
    codexRecord(server, "ignored", Date.now() - 5_000); // the folder exists but the server was never told about it
    writeFileSync(join(server.work, "x.txt"), "x");
    await sleep(500);
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken);
  });
});

// ---- another Command Center tab's writer ----
const slowRuns = { FAKE_RUN_SLEEP: "9" };
const startRun = async (c: Awaited<ReturnType<typeof client>>, tabId: string, slot: string) => {
  const before = c.messages.filter((m) => m.type === "runStart" && m.tabId === tabId).length;
  c.send({ type: "run", tabId, slot, prompt: "work" });
  await c.wait(() => c.messages.filter((m) => m.type === "runStart" && m.tabId === tabId).length > before, `the ${slot} run in ${tabId} started`);
};

test("another tab's coder run in the same folder holds a chat and a Run: names its seat and tab, Continue anyway sends, the same run is not asked again, a NEW run asks again", { timeout: 120_000 }, async () => {
  await withServer({ env: slowRuns, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await startRun(c, TAB_B, "coder");
    const coder = SEATS.find((seat) => seat.slotId === "coder")!;
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held, `held, got ${JSON.stringify(held.answer)}`);
    assert.deepEqual(held.answer.items.map((i: any) => i.writer), [{ seatName: coder.defaultName, roleLabel: "Coder", tabName: "Design" }]);
    await sleep(300);
    assert.equal(c.messages.some((m) => m.type === "chatMessage" && m.requestId === held.requestId), false, "no user message appended");
    assert.equal(fakeLeaderTurns(server), 0, "no turn started");
    assert.equal(c.tab(TAB_A).leaderStatus, "not-started");

    // A user Run in the first tab is held for the same writer, then Continue anyway launches it.
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "mine" });
    const runHeld = await c.wait(() => c.messages.find((m) => m.type === "folderBusy" && m.action === "run" && m.tabId === TAB_A), "the Run is held");
    assert.equal(runHeld.items[0].writer.tabName, "Design");
    assert.equal(c.messages.some((m) => m.type === "runAccepted" && m.tabId === TAB_A), false, "nothing launched");
    c.send({ type: "run", tabId: TAB_A, slot: "coder", prompt: "mine", confirmBusy: true });
    await c.wait(() => c.messages.find((m) => m.type === "runAccepted" && m.tabId === TAB_A), "Continue anyway launches the Run");

    const second = await c.chatAndFinish(TAB_A, "and a message", {});
    assert.ok(second.taken, "the same run is not asked about again within 10 minutes");
    await c.wait(() => c.runEnds() >= 2, "both runs ended", 30_000);
    await sleep(300);
    await startRun(c, TAB_B, "coder");
    const again = await c.chat(TAB_A, "after a new run");
    assert.ok(again.held, "a NEW run in the other tab asks again");
    assert.equal(again.answer.items.filter((i: any) => i.writer).length, 1);
    await c.wait(() => c.runEnds() >= 3, "the new run ended", 30_000);
  });
});

test("no warning for another tab that only has a reviewer working, sits idle, works in an unrelated folder or a prefix lookalike of this one; the asking tab's own run never warns", { timeout: 120_000 }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: TAB_B, folder: work }, { id: "p9-c", folder: `${work}2` }, { id: "p9-d", folder: join(dirname(work), "elsewhere") }];
  await withServer({ env: slowRuns, tabs }, async (server, c) => {
    assert.deepEqual(await c.busyProbe(TAB_A), [], "control: the other tabs are idle");
    await startRun(c, "p9-b", "reviewer1");
    await startRun(c, "p9-c", "coder");
    await startRun(c, "p9-d", "coder");
    await sleep(600);
    assert.equal(c.runEnds(), 0, "all three runs are still working");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "reviewer, lookalike folder and unrelated folder: no writer line");
    const sent = await c.chatAndFinish(TAB_A, "hello");
    assert.ok(sent.taken, `not held: ${JSON.stringify(sent.answer)}`);
    // The asking tab's own coder run is not a writer for itself.
    await startRun(c, TAB_A, "coder");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "own run never warns");
    await c.wait(() => c.runEnds() >= 4, "the runs ended", 40_000);
  });
});

test("a Stand-alone tab's active leader turn warns (its leader codes itself); a Main Crew tab's leader turn with no writer run does not", { timeout: 120_000 }, async () => {
  const tabs = (work: string): TabSpec[] => [{ id: TAB_A, folder: work }, { id: "p9-solo", name: "Solo", process: "solo", folder: work }, { id: "p9-solo2", name: "Solo 2", process: "solo", folder: work }, { id: "p9-main", name: "Main", folder: work }, { id: "p9-far", name: "Far", process: "solo", folder: join(dirname(work), "elsewhere") }];
  await withServer({ env: { FAKE_CODEX_TURN_START_NEVER_ANSWERED: "1" }, tabs }, async (server, c) => {
    const main = await c.chat("p9-main", "a leader turn in a Main Crew tab");
    assert.ok(main.taken);
    await sleep(500);
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "a Main Crew leader only plans: no writer");
    const solo = await c.chat("p9-solo", "code it yourself");
    assert.ok(solo.taken);
    assert.ok((await c.chat("p9-far", "a stand-alone turn in an unrelated folder")).taken);
    const items = await c.busyUntil(TAB_A);
    assert.deepEqual(items.map((i) => i.writer), [{ seatName: "Atlas", roleLabel: "Leader", tabName: "Solo" }]);
    assert.deepEqual((await c.busyProbe("p9-solo")).filter((i) => i.writer), [], "a tab's own turn is never a writer for itself");
    const held = await c.chat(TAB_A, "hello");
    assert.ok(held.held);
    assert.equal((await c.chat(TAB_A, "hello", { confirmBusy: true })).taken, true, "Continue anyway sends it");
    assert.deepEqual((await c.busyProbe(TAB_A)).filter((i) => i.writer), [], "the same turn is quiet for 10 minutes");
    // That tab is itself held for the first one (a stand-alone turn there writes too).
    assert.ok((await c.chat("p9-solo2", "another stand-alone turn")).held);
    assert.ok((await c.chat("p9-solo2", "another stand-alone turn", { confirmBusy: true })).taken);
    assert.deepEqual((await c.busyUntil(TAB_A)).map((i) => i.writer), [{ seatName: "Atlas", roleLabel: "Leader", tabName: "Solo 2" }], "another tab's turn asks again");
  });
});

test("a leader-started crew run also says when another tab's coder is writing in the folder (once per run), in the chat and not as a pop-up", { timeout: 120_000 }, async () => {
  await withServer({ env: slowRuns, tabs: (work) => [{ id: TAB_A, folder: work }, { id: TAB_B, name: "Design", folder: work }] }, async (server, c) => {
    await c.chatAndFinish(TAB_A, "start the leader"); // before the other tab works, so nobody has confirmed anything
    await startRun(c, TAB_B, "coder");
    const coder = SEATS.find((seat) => seat.slotId === "coder")!;
    const results = () => c.messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === TAB_A);
    const line = `Heads up: ${coder.defaultName} (Coder) in your Design tab is writing code in this folder right now.`;
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "reviewer1", brief: "first" });
    c.send({ type: "testGatedLaunch", tabId: TAB_A, slot: "coder", brief: "second" });
    await c.wait(() => results()[1], "both launches answered");
    assert.deepEqual(c.messages.filter((m) => m.type === "chatMessage" && m.tabId === TAB_A && m.role === "notice").map((m) => m.text), [line], "told once, not per launch, as a chat line");
    assert.equal(c.messages.filter((m) => m.type === "chatNotice" && /Heads up/.test(m.message)).length, 0, "and no pop-up");
    assert.equal(c.messages.some((m) => m.type === "folderBusy" && m.action !== "chat"), false, "a leader launch never asks");
    await c.wait(() => c.runEnds() >= 3, "the runs ended", 40_000);
  });
});

// ---- every leader's own session id is registered (a Claude / OpenCode / Codex leader's own record must never warn against itself) ----
const leaderCases = [
  { leader: "codex" as const, id: "thread-1", env: {}, text: "start the leader", plant: (server: Server, id: string, at: number) => codexRecord(server, id, at) },
  { leader: "claude" as const, id: "claude-leader-sess", env: { CC_TEST_FAKE_LEADER: "1", FAKE_CLAUDE_SESSION_ID: "claude-leader-sess" }, text: JSON.stringify([{ tool: "Read", input: { file_path: "x" } }]), plant: (server: Server, id: string, at: number) => claudeRecord(server, id, at) },
  { leader: "opencode" as const, id: "ses_fake1", env: {}, text: "start the leader", plant: (server: Server, id: string, at: number) => opencodeRecord(server, id, at) },
];
for (const spec of leaderCases) {
  test(`the ${spec.leader} leader reports its session id: its own record (written long after any window) never warns, a stranger's still does`, { timeout: 120_000 }, async () => {
    await withServer({ leader: spec.leader, env: spec.env }, async (server, c) => {
      await c.chatAndFinish(TAB_A, spec.text);
      assert.ok(Object.keys(JSON.parse(readFileSync(join(server.data, "config", "own-sessions.json"), "utf8")).ids).includes(spec.id), "the leader's session id was saved");
      spec.plant(server, spec.id, Date.now() + 30_000); // past every window of ours: only the id can say it is ours
      const own = await c.chatAndFinish(TAB_A, spec.text);
      assert.ok(own.taken, `its own record does not warn: ${JSON.stringify(own.answer)}`);
      spec.plant(server, "a-stranger", Date.now() + 30_000);
      const stranger = await c.chat(TAB_A, spec.text);
      assert.ok(stranger.held && stranger.answer.items.length === 1, `control: a stranger of the same tool warns: ${JSON.stringify(stranger.answer)}`);
    });
  });
}
