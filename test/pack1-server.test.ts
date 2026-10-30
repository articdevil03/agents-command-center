import { waitForServerStart } from "./server-start.ts";
// Fix pack 1, server core: app key, response headers, launch gate for Codex seats, full approval text,
// changeFolder starting no leader, read-RESUME-first after every stop, declined request bodies, Save late finish.
// One real server on a temp data dir (CC_TEST_FORCE_PACKAGED + CC_DATA_DIR), its own app key, a Codex leader tab
// (fake app-server) and a Claude leader tab (fake query). PATH holds only node and System32, so no real agent CLI can start.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

const SEATS = getProcessDefinition("dev", "main").seats;
const crewFor = (leader?: { cli: string; model: string; effort: string }) => SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort, ...(seat.isLeader ? leader : {}) }));
const CODEX_TAB = "p1-codex", CLAUDE_TAB = "p1-claude";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const newKey = () => randomBytes(32).toString("hex");
const READ_FIRST = "Before replying, first read the existing handover";

type Server = { port: number; key: string; temp: string; data: string; work: string; work2: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(options: { key?: string; withWorkspace?: boolean; env?: Record<string, string> } = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack1-server-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), work2 = join(temp, "work2");
  for (const dir of [home, work, work2, join(data, "config")]) mkdirSync(dir, { recursive: true });
  if (options.withWorkspace !== false) {
    const tabs = [
      { id: CODEX_TAB, name: CODEX_TAB, kind: "dev", process: "main", folder: work, crew: crewFor({ cli: "codex", model: "gpt-6-sol", effort: "high" }) },
      { id: CLAUDE_TAB, name: CLAUDE_TAB, kind: "dev", process: "main", folder: work, crew: crewFor() },
    ];
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p1", name: "P1", folder: work, tabs }] }));
  }
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  const key = options.key ?? newKey();
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_TEST_CHAT_TIMEOUT_MS: "600", CC_TEST_SAVE_WRITE_DELAY_MS: "1500", ...options.env,
  };
  if (options.key === "") delete env.CC_APP_KEY; else env.CC_APP_KEY = key;
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack1-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
  return {
    port, key, temp, data, work, work2, child, log: () => log,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok)); // resolve-only: once() would reject on an IPC "error"
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally {
        removeWithRetry(temp);
      }
    },
  };
}

// A refused upgrade shows up as "unexpected-response" with the status, never "open".
function wsOutcome(server: Server, key: string | null, withOrigin = true): Promise<number | "open"> {
  const url = `ws://127.0.0.1:${server.port}/${key === null ? "" : `?key=${key}`}`;
  const socket = new WebSocket(url, withOrigin ? { origin: `http://127.0.0.1:${server.port}` } : {});
  return new Promise((ok) => {
    socket.on("open", () => { socket.terminate(); ok("open"); });
    socket.on("unexpected-response", (_req, res) => { res.resume(); ok(res.statusCode ?? 0); });
    socket.on("error", () => ok(0));
  });
}

let server: Server;
const messages: any[] = [];
let socket: WebSocket;
let requestNumber = 0;
const state = () => messages.filter((m) => m.type === "state").at(-1);
const tabOf = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
const wait = async <T>(fn: () => T, label: string, ms = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
  assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-5))}`);
};
const send = (payload: any) => socket.send(JSON.stringify(payload));
const action = async (payload: any) => {
  const requestId = `p1_${++requestNumber}`; send({ ...payload, requestId });
  return await wait(() => messages.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "actionResult")), payload.type);
};
const doneCount = (tabId: string) => messages.filter((m) => (m.type === "chatDone" || m.type === "chatError") && m.tabId === tabId).length;
async function chat(tabId: string, text: string): Promise<void> {
  const before = doneCount(tabId); send({ type: "chat", tabId, text });
  await wait(() => doneCount(tabId) > before, `chat "${text.slice(0, 30)}" finished`);
}
const fakeLog = () => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) as any[];
const turnTexts = () => fakeLog().filter((e) => e.method === "turn/start").map((e) => String(e.params.input[0].text));
const startedCount = () => fakeLog().filter((e) => e.started).length;
const pendingOf = (tabId: string) => tabOf(tabId).pendingApprovals as any[];

before(async () => {
  server = await boot();
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open"); send({ type: "hello" }); await wait(state, "initial state");
});
after(async () => { socket?.terminate(); await server?.stop(); });

test("WebSocket: no key and a wrong key are refused with 403, the right key opens", async () => {
  assert.equal(await wsOutcome(server, null), 403, "no key");
  assert.equal(await wsOutcome(server, null, false), 403, "no key and no Origin header (a local process)");
  assert.equal(await wsOutcome(server, newKey()), 403, "a wrong key of the right length");
  assert.equal(await wsOutcome(server, server.key.slice(0, 10)), 403, "a short key");
  assert.equal(await wsOutcome(server, `${server.key}00`), 403, "a long key");
  assert.equal(await wsOutcome(server, server.key, false), "open", "the right key, no Origin header");
  assert.equal(await wsOutcome(server, server.key), "open");
});

test("every write route needs X-App-Key; a refused request writes nothing; the right key works", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const routes: { path: string; headers: Record<string, string>; body: Buffer }[] = [
    { path: "/api/paste-image", headers: { "Content-Type": "image/png" }, body: png },
    { path: "/api/paste-file", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "note.txt" }, body: Buffer.from("hello") },
    { path: "/api/avatar", headers: { "Content-Type": "image/png" }, body: png },
  ];
  const stored = () => [join(server.data, "scratch"), join(server.data, "avatars")].flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : []));
  for (const route of routes) {
    const attempt = (key?: string) => fetch(base + route.path, { method: "POST", headers: { ...route.headers, "X-Request-Id": `p1up${++requestNumber}`, ...(key === undefined ? {} : { "X-App-Key": key }) }, body: route.body });
    for (const [label, key] of [["no key", undefined], ["wrong key", newKey()], ["short key", "abc"]] as const) {
      const response = await attempt(key); await response.arrayBuffer();
      assert.equal(response.status, 403, `${route.path} with ${label}`);
    }
  }
  assert.deepEqual(stored(), [], "a refused upload wrote nothing");
  for (const route of routes) {
    const response = await fetch(base + route.path, { method: "POST", headers: { ...route.headers, "X-Request-Id": `p1up${++requestNumber}`, "X-App-Key": server.key }, body: route.body });
    assert.equal(response.status, 200, `${route.path} with the right key: ${await response.text()}`);
  }
  assert.equal(stored().length, 3, "the three accepted uploads were stored");
  // Any other non-GET method needs the key too, before it can even be told "method not allowed".
  for (const method of ["DELETE", "PUT", "POST"]) {
    const response = await fetch(base + "/", { method }); await response.arrayBuffer();
    assert.equal(response.status, 403, `${method} / without a key`);
  }
  const allowed = await fetch(base + "/", { method: "DELETE", headers: { "X-App-Key": server.key } }); await allowed.arrayBuffer();
  assert.equal(allowed.status, 405, "with the key a stray method gets the normal 405");
});

test("every HTTP response carries X-Frame-Options, a frame-ancestors CSP and nosniff", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const responses: [string, Response][] = [
    ["static page", await fetch(base + "/")],
    ["static 404", await fetch(base + "/no-such-file.js")],
    ["bad avatar path", await fetch(base + "/api/avatar/nope.png")],
    ["refused POST", await fetch(base + "/api/paste-image", { method: "POST", body: "x" })],
  ];
  assert.equal(responses[0][1].status, 200);
  assert.equal(responses[1][1].status, 404);
  for (const [label, response] of responses) {
    await response.arrayBuffer();
    assert.equal(response.headers.get("x-frame-options"), "DENY", label);
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
  }
});

test("a bare start makes its own key and prints one Open line; that key works and no key does not", async () => {
  const bare = await boot({ key: "", withWorkspace: false });
  try {
    for (let waited = 0; !bare.log().includes("#key=") && waited < 3000; waited += 20) await sleep(20);
    const open = bare.log().split(/\r?\n/).filter((line) => line.startsWith("Open http://"));
    assert.equal(open.length, 1, `exactly one Open line: ${bare.log()}`);
    const match = new RegExp(`^Open http://127\\.0\\.0\\.1:${bare.port}/#key=([0-9a-f]{64})$`).exec(open[0]);
    assert.ok(match, `Open line shape: ${open[0]}`);
    assert.equal(await wsOutcome(bare, null), 403);
    assert.equal(await wsOutcome(bare, match![1]), "open");
    // A key handed in by the environment is used and never printed.
    assert.equal(server.log().includes("#key="), false, "a supplied key is not printed");
    assert.equal(server.log().includes(server.key), false, "the supplied key is not in the log");
  } finally { await bare.stop(); }
});

test("Codex leader: the first turn after an app start reads RESUME.md first, then asks nothing more", async () => {
  await chat(CODEX_TAB, "first");
  const texts = turnTexts();
  assert.equal(texts.length, 1);
  assert.ok(texts[0].startsWith(READ_FIRST), texts[0]);
  assert.ok(texts[0].includes(join(server.work, ".command-center", CODEX_TAB, "RESUME.md")), "names this tab's own handover");
  assert.ok(texts[0].endsWith("Current message:\nfirst"));
  await chat(CODEX_TAB, "second");
  assert.equal(turnTexts()[1], "second", "a read turn that succeeded consumes the requirement");
});

test("Stop leaves the next leader turn reading RESUME.md first", async () => {
  send({ type: "stopSeat", tabId: CODEX_TAB, slot: "leader" });
  await wait(() => tabOf(CODEX_TAB).leaderStatus === "not-started", "leader stopped");
  await chat(CODEX_TAB, "third");
  assert.ok(turnTexts().at(-1)!.startsWith(READ_FIRST), "after Stop");
  await chat(CODEX_TAB, "fourth");
  assert.equal(turnTexts().at(-1), "fourth");
});

test("changeFolder stops the leader and starts none; the next chat starts one in the new folder and reads RESUME.md", async () => {
  assert.equal(tabOf(CODEX_TAB).leaderStatus, "ready");
  const spawned = startedCount();
  send({ type: "changeFolder", tabId: CODEX_TAB, folder: server.work2 });
  await wait(() => tabOf(CODEX_TAB).folder === realpathSync(server.work2), "folder changed");
  assert.equal(tabOf(CODEX_TAB).leaderStatus, "not-started", "no leader was started for the new folder");
  await sleep(400);
  assert.equal(startedCount(), spawned, "no leader process was spawned by changeFolder");
  assert.equal(tabOf(CODEX_TAB).leaderStatus, "not-started");
  await chat(CODEX_TAB, "fifth");
  assert.equal(startedCount(), spawned + 1, "the next chat message starts the leader");
  const text = turnTexts().at(-1)!;
  assert.ok(text.startsWith(READ_FIRST) && text.includes(join(realpathSync(server.work2), ".command-center", CODEX_TAB, "RESUME.md")), text);
});

test("a declined request reaches the leader as declined with no body; accepted and pending keep theirs", async () => {
  send({ type: "selectTab", tabId: CLAUDE_TAB }); await wait(() => state().selectedTabId === CLAUDE_TAB, "select the sender tab");
  for (const [title, body] of [["Declined one", "SECRET-DECLINED-BODY"], ["Accepted one", "VISIBLE-ACCEPTED-BODY"], ["Pending one", "VISIBLE-PENDING-BODY"]]) {
    assert.equal((await action({ type: "sendRequest", fromTabId: CLAUDE_TAB, toTabId: CODEX_TAB, title, body })).type, "actionResult");
  }
  send({ type: "selectTab", tabId: CODEX_TAB }); await wait(() => state().selectedTabId === CODEX_TAB, "select the destination tab");
  const idOf = (title: string) => (state().requests as any[]).find((r) => r.title === title).id;
  assert.equal((await action({ type: "resolveRequest", id: idOf("Declined one"), status: "declined", tabId: CODEX_TAB })).type, "actionResult");
  assert.equal((await action({ type: "resolveRequest", id: idOf("Accepted one"), status: "accepted", tabId: CODEX_TAB })).type, "actionResult");
  assert.equal((state().requests as any[]).find((r) => r.title === "Declined one").body, "SECRET-DECLINED-BODY", "The user's own list keeps the body");
  const start = messages.length;
  await chat(CODEX_TAB, JSON.stringify([{ tool: "list_requests" }]));
  const text = messages.slice(start).filter((m) => m.type === "chatDelta" && m.tabId === CODEX_TAB).map((m) => m.text).join("");
  assert.ok(text.startsWith("[tool ok: "), text);
  assert.ok(text.includes("Declined one") && text.includes('"status":"declined"'), "the leader still sees that it was declined");
  assert.equal(text.includes("SECRET-DECLINED-BODY"), false, "but never the declined body");
  assert.ok(text.includes("VISIBLE-ACCEPTED-BODY") && text.includes("VISIBLE-PENDING-BODY"), "the other bodies are untouched");
});

test("a Codex file approval shows every line it was given plus the grantRoot line", async () => {
  const before = doneCount(CODEX_TAB);
  send({ type: "chat", tabId: CODEX_TAB, text: JSON.stringify([{ raw: { method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "$turn", itemId: "fx", startedAtMs: 1, reason: "grant", grantRoot: "C:/granted-root" } } }]) });
  const approval = await wait(() => pendingOf(CODEX_TAB)[0], "the file approval appears");
  assert.ok(approval.summary.endsWith("\nAlso asks for write access to: C:/granted-root"), approval.summary);
  await action({ type: "answerApproval", tabId: CODEX_TAB, approvalId: approval.approvalId, allow: false });
  await wait(() => doneCount(CODEX_TAB) > before, "turn finished");
});

test("a read-only Codex seat is gated like a write seat: Ask shows the whole brief, Plan refuses", async () => {
  await action({ type: "setPermissionMode", tabId: CODEX_TAB, mode: "ask", confirm: true });
  const brief = "TEST ONLY: do nothing.\nsecond line of the brief\nthird line of the brief";
  const results = () => messages.filter((m) => m.type === "testGatedLaunchResult" && m.tabId === CODEX_TAB);
  let seen = results().length;
  send({ type: "testGatedLaunch", tabId: CODEX_TAB, slot: "reviewer2", brief });
  const approval = await wait(() => pendingOf(CODEX_TAB)[0], "the launch approval appears for a read-only Codex seat");
  assert.equal(approval.tool, "launch:Sol");
  assert.equal(approval.summary, `Sol (Reviewer)\n${brief}`, "the whole brief with its line breaks, not the first line");
  await action({ type: "answerApproval", tabId: CODEX_TAB, approvalId: approval.approvalId, allow: false });
  const denied = await wait(() => results()[seen], "denied result");
  assert.deepEqual([denied.ok, denied.error], [false, "The user denied this."]);

  // A huge brief is cut at 20000 characters with a last line saying how much was left out.
  const huge = `TEST ONLY: do nothing.\n${"y".repeat(25000)}`;
  seen = results().length;
  send({ type: "testGatedLaunch", tabId: CODEX_TAB, slot: "reviewer2", brief: huge });
  const long = await wait(() => pendingOf(CODEX_TAB)[0], "the long launch approval appears");
  const full = `Sol (Reviewer)\n${huge}`;
  assert.ok(long.summary.length <= 20100, `capped: ${long.summary.length}`);
  assert.ok(long.summary.startsWith("Sol (Reviewer)\nTEST ONLY: do nothing.\nyyyy"));
  assert.match(long.summary, /\n\.\.\. \((\d+) more characters not shown\)$/);
  const hidden = Number(/\((\d+) more characters not shown\)$/.exec(long.summary)![1]);
  assert.equal(long.summary.length - `\n... (${hidden} more characters not shown)`.length + hidden, full.length, "shown + hidden = the whole text");
  await action({ type: "answerApproval", tabId: CODEX_TAB, approvalId: long.approvalId, allow: false });
  await wait(() => results()[seen], "long denied");

  await action({ type: "setPermissionMode", tabId: CODEX_TAB, mode: "plan", confirm: true });
  seen = results().length;
  send({ type: "testGatedLaunch", tabId: CODEX_TAB, slot: "reviewer2", brief });
  const refused = await wait(() => results()[seen], "plan refusal");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Plan mode/);
  assert.equal(pendingOf(CODEX_TAB).length, 0, "Plan asks nothing");
});

test("a Save that times out but whose turn still writes the handover is marked saved and the failed card is cleared", async () => {
  await chat(CLAUDE_TAB, JSON.stringify([{ tool: "Read", input: { file_path: "x" } }])); // the read-first turn
  const row = () => tabOf(CLAUDE_TAB);
  const start = messages.length;
  send({ type: "save", tabId: CLAUDE_TAB });
  const failed = await wait(() => messages.slice(start).find((m) => m.type === "error" && m.action === "save"), "Save timed out");
  assert.match(failed.message, /timed out/);
  assert.notEqual(row().savedRevision, row().chatRevision, "not saved yet when the timeout fired");
  const saved = await wait(() => messages.slice(start).find((m) => m.type === "saved" && m.tabId === CLAUDE_TAB), "the late finish is marked saved", 6000);
  assert.equal(saved.savedRevision, saved.revision);
  await wait(() => row().savedRevision === row().chatRevision, "state shows it saved");
  assert.ok(existsSync(join(server.work, ".command-center", CLAUDE_TAB, "RESUME.md")));
});

test("two tabs on one folder keep separate handovers: one tab's Save never confirms the other's, and a read names the right file", async () => {
  // CLAUDE_TAB saved just above, into its own file; the Codex tab shares its folder once it is moved back.
  const claudeFile = join(server.work, ".command-center", CLAUDE_TAB, "RESUME.md");
  assert.ok(existsSync(claudeFile), "the Claude tab saved to its own file");
  assert.equal(existsSync(join(server.work, ".command-center", "RESUME.md")), false, "nothing was written to the old shared file");
  send({ type: "changeFolder", tabId: CODEX_TAB, folder: server.work });
  await wait(() => tabOf(CODEX_TAB).folder === realpathSync(server.work), "the Codex tab is on the shared folder");
  await chat(CODEX_TAB, "first message in the shared folder");
  const readText = turnTexts().at(-1)!;
  // The chat handed back may mention the other tab (an earlier request list does), so only the handover path is checked.
  assert.ok(readText.startsWith(READ_FIRST) && !readText.includes(join(".command-center", CLAUDE_TAB)), `the read must not name the other tab's file: ${readText}`);
  // The old shared file exists and this tab has none of its own: it is read, with a note that it is for reading only.
  mkdirSync(join(server.work, ".command-center"), { recursive: true });
  writeFileSync(join(server.work, ".command-center", "RESUME.md"), "older shared handover");
  send({ type: "stopSeat", tabId: CODEX_TAB, slot: "leader" });
  await wait(() => tabOf(CODEX_TAB).leaderStatus === "not-started", "stopped");
  await chat(CODEX_TAB, "after the stop");
  const sharedText = turnTexts().at(-1)!;
  assert.ok(sharedText.includes(join(server.work, ".command-center", "RESUME.md")) && /older shared handover, kept for reading only/.test(sharedText), sharedText);
  // Save on the Codex tab: the Claude tab's newer file must not stand in for it.
  await chat(CODEX_TAB, "one more");
  const start = messages.length;
  send({ type: "save", tabId: CODEX_TAB });
  const refused = await wait(() => messages.slice(start).find((m) => m.type === "error" && m.action === "save" && m.tabId === CODEX_TAB), "Save is not confirmed by the other tab's file", 8000);
  assert.match(refused.message, /could not save the handover|timed out/);
  assert.equal(messages.slice(start).some((m) => m.type === "saved" && m.tabId === CODEX_TAB), false);
  assert.equal(existsSync(join(server.work, ".command-center", CODEX_TAB, "RESUME.md")), false);
});

test("a supplied CC_APP_KEY that is not 64 lowercase hex stops the server with one clear line and never prints the key", () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack1-badkey-"));
  try {
    for (const bad of ["short", "A".repeat(64), "g".repeat(64), "a".repeat(63), ""]) {
      const run = spawnSync(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, timeout: 15000, encoding: "utf8", env: { ...process.env, HOME: temp, USERPROFILE: temp, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: join(temp, "data"), CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_APP_KEY: bad } });
      assert.notEqual(run.status, 0, `exit code for ${JSON.stringify(bad)}`);
      assert.match(run.stderr, /CC_APP_KEY must be 64 lowercase hex characters/);
      assert.equal(run.stdout.includes("127.0.0.1"), false, "it never started listening");
      if (bad) { assert.equal((run.stdout + run.stderr).includes(bad), false, "the key is never printed"); }
    }
  } finally { removeWithRetry(temp); }
});
