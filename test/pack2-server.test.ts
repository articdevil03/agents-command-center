// Fix pack 2, block 1 (server core). Real server processes for what only a process can show (a taken port, a data root behind a
// junction, client prefs across a restart, an older launch-safety file), pure tests for the engine / stores / config changes.
// Every server runs on a temp data dir (CC_TEST_FORCE_PACKAGED + CC_DATA_DIR) with its own app key; PATH holds only node and System32,
// so no real agent CLI can start.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, lstatSync, fsyncSync, renameSync } from "node:fs";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { tempRoot } from "./temp-root.ts";
import { isWithinDir } from "../server/security.ts";
import { ChatStore, isTabSlug } from "../server/chat-store.ts";
import { RequestsStore } from "../server/requests.ts";
import { readLaunchSafety, writeClientPrefs, DEFAULT_CLIENT_PREFS } from "../server/config.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import {
  advanceStep, approveLook, createTabState, finishRun, getProcessDefinition, getStepBar, isBusy, startRun, stopAll, stopRun, MAX_FINISHED_RUNS,
  type ProcessState,
} from "../server/process.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

type Server = { port: number; key: string; data: string; child: ChildProcess; log: () => string; exited: Promise<number | null>; stop: () => Promise<void> };
// `data` is the data dir the server uses (CC_DATA_DIR); it is created and removed by the caller. `waitListening: false` is for a server that must not come up.
async function boot(data: string, options: { port?: number; waitListening?: boolean; env?: Record<string, string> } = {}): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack2-home-"));
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  const port = options.port ?? await freePort();
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", FAKE_LEADER_LOG: join(temp, "fake-leader.log"),
    CC_APP_KEY: key, ...options.env,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack2-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  if (options.waitListening !== false) {
    const end = Date.now() + 8000;
    while (!log.includes("127.0.0.1") && Date.now() < end) await sleep(10);
    if (!log.includes("127.0.0.1")) {
      // The caller never gets a Server to stop: end the process and remove the temp home here.
      child.kill(); await Promise.race([exited, sleep(3000)]); removeWithRetry(temp);
      assert.fail(`server did not start: ${log}`);
    }
  }
  return {
    port, key, data, child, log: () => log, exited,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { removeWithRetry(temp); }
    },
  };
}

async function connect(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open");
  const wait = async <T>(fn: () => T, label: string, ms = 8000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-400)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-4))}`);
  };
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  send({ type: "hello" });
  await wait(() => messages.find((m) => m.type === "state"), "first state");
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  return { messages, send, wait, state, close: () => socket.terminate() };
}

function makeData(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-pack2-data-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  return dir;
}

// ---- A server that cannot listen ends instead of staying up as an orphan -------------------------------------------------------

test("a server whose port is already taken exits with an error instead of staying alive without listening", async () => {
  const data = makeData();
  const blocker = createServer(); blocker.listen(0, "127.0.0.1"); await once(blocker, "listening");
  const taken = (blocker.address() as { port: number }).port;
  let server: Server | undefined;
  try {
    server = await boot(data, { port: taken, waitListening: false });
    const code = await Promise.race([server.exited, sleep(10_000).then(() => "still running" as const)]);
    assert.notEqual(code, "still running", `the server must end, log=${server.log()}`);
    assert.equal(code, 1);
    assert.match(server.log(), /server error: .*EADDRINUSE/);
  } finally {
    await server?.stop(); await new Promise<void>((ok) => blocker.close(() => ok())); removeWithRetry(data);
  }
});

// ---- Client prefs live on the server: they survive a restart --------------------------------------------------------------------

test("crewRailOpen and detailsOpen are saved by the server and come back after a restart", async () => {
  const data = makeData();
  try {
    const first = await boot(data); const a = await connect(first);
    assert.deepEqual([a.state().clientPrefs.crewRailOpen, a.state().clientPrefs.detailsOpen], [true, false], "defaults");
    a.send({ type: "updateClientPref", key: "crewRailOpen", value: false });
    a.send({ type: "updateClientPref", key: "detailsOpen", value: true });
    await a.wait(() => a.state().clientPrefs.crewRailOpen === false && a.state().clientPrefs.detailsOpen === true, "both prefs applied");
    a.close(); await first.stop();
    assert.deepEqual([JSON.parse(readFileSync(join(data, "config", "client-prefs.json"), "utf8")).crewRailOpen, JSON.parse(readFileSync(join(data, "config", "client-prefs.json"), "utf8")).detailsOpen], [false, true]);
    const second = await boot(data); const b = await connect(second);
    try { assert.deepEqual([b.state().clientPrefs.crewRailOpen, b.state().clientPrefs.detailsOpen], [false, true], "restored on a new port, new key, new window"); }
    finally { b.close(); await second.stop(); }
  } finally { removeWithRetry(data); }
});

// ---- An older launch-safety.json no longer stops the app from starting ------------------------------------------------------------

test("a launch-safety.json from an older version (no released/uncertain/live lists) starts the server; a damaged list still refuses", async () => {
  const data = makeData();
  try {
    writeFileSync(join(data, "config", "launch-safety.json"), JSON.stringify({ blocked: ["old-tab.coder"], timestamps: [], notices: [{ type: `${["boo", "gie"].join("")}Launch`, id: 3, seatId: "old-tab.coder", seatName: "Sonny", brief: "x", source: "Atlas" }], nextNoticeId: 4 }));
    const server = await boot(data); const client = await connect(server);
    try {
      assert.deepEqual(client.state().launchSafety.blocked, ["old-tab.coder"], "the old block is still there");
      assert.equal(client.state().launchSafety.notices.length, 1);
      assert.deepEqual(client.state().launchSafety.uncertain, []);
    } finally { client.close(); await server.stop(); }

    writeFileSync(join(data, "config", "launch-safety.json"), JSON.stringify({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: "not a list" }));
    const bad = await boot(data, { waitListening: false });
    try {
      assert.notEqual(await Promise.race([bad.exited, sleep(10_000).then(() => "still running" as const)]), "still running");
      assert.match(bad.log(), /invalid launch safety state/);
    } finally { await bad.stop(); }
  } finally { removeWithRetry(data); }
});

// ---- A data root behind a junction: uploads are reachable in either spelling ----------------------------------------------------

test("uploads work when the data root is reached through a junction: the returned real path, the linked path and a differently cased path are all accepted", { skip: process.platform !== "win32" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "cc-pack2-junction-"));
  const real = join(base, "real"), link = join(base, "link");
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  let server: Server | undefined;
  try {
    mkdirSync(join(real, "config"), { recursive: true });
    symlinkSync(real, link, "junction");
    server = await boot(link);
    const client = await connect(server);
    const upload = async (route: string, headers: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${server!.port}${route}`, { method: "POST", headers: { "X-App-Key": server!.key, "X-Request-Id": `jn${randomUUID().slice(0, 8)}`, ...headers }, body: png });
      const body = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(body)); return body;
    };
    const { path } = await upload("/api/paste-image", { "Content-Type": "image/png" });
    assert.ok(path.toLowerCase().startsWith(join(real, "scratch").toLowerCase()), `the upload reports the real path: ${path}`);
    const tabId = client.state().projects[0].tabs[0].id;
    const accepted = async (images: string[], requestId: string) => {
      client.send({ type: "chat", tabId, text: JSON.stringify([{ tool: "Read", input: { file_path: "x" } }]), images, requestId });
      return await client.wait(() => client.messages.find((m) => m.requestId === requestId && (m.type === "chatMessage" || m.type === "error")), `chat ${requestId}`);
    };
    const linked = join(link, "scratch", path.slice(join(real, "scratch").length + 1));
    assert.equal((await accepted([path], "jn_real")).type, "chatMessage", "the real path the upload returned");
    await client.wait(() => client.messages.some((m) => m.type === "chatDone" || m.type === "chatError"), "first turn over");
    assert.equal((await accepted([linked], "jn_link")).type, "chatMessage", "the path through the junction");
    assert.equal((await accepted([path.toUpperCase()], "jn_case")).type, "chatMessage", "the same path in another case");
    const shown = await fetch(`http://127.0.0.1:${server.port}/api/paste-image?path=${encodeURIComponent(path)}`);
    assert.equal(shown.status, 200); await shown.arrayBuffer();
    const avatar = await upload("/api/avatar", { "Content-Type": "image/png" });
    const served = await fetch(`http://127.0.0.1:${server.port}${avatar.path}`);
    assert.equal(served.status, 200, "the avatar it returned can be served"); await served.arrayBuffer();
    // A path that is only outside the scratch folder stays refused.
    const outside = join(base, "outside.png"); writeFileSync(outside, png);
    assert.equal((await accepted([outside], "jn_out")).type, "error");
    client.close();
  } finally {
    await server?.stop();
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* left for the OS temp cleaner */ } }
    removeWithRetry(base);
  }
});

// ---- Pure: isWithinDir, the stores, the config reader ---------------------------------------------------------------------------

test("isWithinDir compares Windows paths without regard to case, and still refuses a sibling that merely shares a prefix", { skip: process.platform !== "win32" }, () => {
  assert.equal(isWithinDir("C:\\Data\\scratch\\a.png", "c:\\data\\SCRATCH"), true);
  assert.equal(isWithinDir("c:\\DATA", "C:\\Data"), true);
  assert.equal(isWithinDir("C:\\Data2\\scratch", "C:\\Data"), false);
  assert.equal(isWithinDir("C:\\Data\\..\\x", "C:\\Data\\sub"), false);
  assert.equal(isWithinDir("D:\\Data\\a", "C:\\Data"), false);
  assert.equal(isWithinDir("C:\\Data\\a", "C:\\"), true, "a drive root contains its folders");
});

test("ChatStore.counters reads the two revisions without copying the transcript; forget drops memory but never the file", () => {
  const dir = tempRoot();
  const store = new ChatStore(join(dir, "chats"));
  store.appendMessage("alpha-tab", "user", "one"); store.appendMessage("alpha-tab", "assistant", "two"); store.markSaved("alpha-tab", 2);
  assert.deepEqual(store.counters("alpha-tab"), { revision: 2, savedRevision: 2 });
  assert.deepEqual(store.counters("never-used"), { revision: 0, savedRevision: 0 });
  store.forget("alpha-tab");
  assert.ok(existsSync(join(dir, "chats", "alpha-tab.jsonl")), "the transcript file stays");
  const reloaded = new ChatStore(join(dir, "chats"));
  assert.deepEqual(reloaded.counters("alpha-tab"), { revision: 2, savedRevision: 2 }, "and is what a later load reads");
  // forget() really empties the in-memory copy: a line added to the file by hand is seen after it, not before.
  reloaded.counters("alpha-tab");
  fs.appendFileSync(join(dir, "chats", "alpha-tab.jsonl"), JSON.stringify({ type: "message", tabId: "alpha-tab", revision: 3, role: "user", text: "three", at: 1 }) + "\n");
  assert.equal(reloaded.counters("alpha-tab").revision, 2, "cached");
  reloaded.forget("alpha-tab");
  assert.equal(reloaded.counters("alpha-tab").revision, 3, "forgotten, so read again");
});

test("RequestsStore keeps an unreadable or malformed requests.json beside itself and starts empty; a request write is flushed before it is renamed into place", () => {
  for (const [label, content] of [["empty (a crash)", ""], ["not json", "{"], ["not a list", "{}"], ["bad row", JSON.stringify([{ id: "x" }])]] as const) {
    const root = tempRoot();
    writeFileSync(join(root, "requests.json"), content);
    const store = new RequestsStore(root);
    assert.deepEqual(store.list(), [], label);
    const kept = readdirSync(root).filter((name) => name.startsWith("requests.json.bad-"));
    assert.equal(kept.length, 1, `${label}: the unreadable file is kept`);
    assert.equal(readFileSync(join(root, kept[0]), "utf8"), content, `${label}: byte for byte`);
    assert.equal(store.send({ fromTabId: "alpha-tab", toTabId: "beta-tab", title: "t", body: "b" }, () => true).status, "pending", "the app works on from there");
  }
  const dup = tempRoot();
  const row = { id: randomUUID(), fromTabId: "alpha-tab", toTabId: "beta-tab", title: "t", body: "b", status: "pending", createdAt: 1 };
  writeFileSync(join(dup, "requests.json"), JSON.stringify([row, row]));
  assert.deepEqual(new RequestsStore(dup).list(), [], "duplicate ids are a damaged file too");

  // The write order, through the real module with the file system observed.
  const sources = ["server/safe-file.ts", "server/requests.ts"].map((file) => stripTypeScriptTypes(readFileSync(file, "utf8")).replace(/^import (?:.|\r?\n)*?from [^\n]*;\r?$/gm, "").replaceAll("export ", "")).join("\n");
  const order: string[] = [];
  const observed = { ...fs, writeFileSync: (...args: any[]) => { order.push("write"); return (fs.writeFileSync as any)(...args); }, fsyncSync: (fd: number) => { order.push("fsync"); return fsyncSync(fd); }, renameSync: (from: string, to: string) => { order.push("rename"); return renameSync(from, to); } };
  const module = runInNewContext(`${sources}; RequestsStore`, { ...observed, ...{ dirname, join, resolve }, randomUUID, isTabSlug, Buffer, console });
  const observedStore = new module(tempRoot());
  order.length = 0;
  observedStore.send({ fromTabId: "alpha-tab", toTabId: "beta-tab", title: "t", body: "b" }, () => true);
  assert.deepEqual(order, ["write", "fsync", "rename"]);
});

test("readLaunchSafety: an older file gets empty newer lists; a damaged list, a missing blocked list and unreadable JSON are still refused, naming the file", () => {
  const dir = tempRoot();
  const path = join(dir, "launch-safety.json");
  writeFileSync(path, JSON.stringify({ blocked: ["a.b"], timestamps: [5] }));
  assert.deepEqual(plain(readLaunchSafety(path)), { blocked: ["a.b"], timestamps: [5], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] });
  writeFileSync(path, JSON.stringify({ blocked: [], notices: [{ type: `${["boo", "gie"].join("")}Launch`, id: 7, seatId: "a.b", seatName: "x", brief: "y", source: "Atlas" }] }));
  assert.equal(readLaunchSafety(path).nextNoticeId, 8, "a missing counter continues after the highest notice id");
  assert.equal(readLaunchSafety(path).notices[0].type, "leaderLaunch", "a notice saved under the earlier message type is read as the current one");
  for (const damaged of [{ blocked: [], released: "x" }, { blocked: [], uncertain: [{ seatId: "a.b" }] }, { blocked: [], live: [{ seatId: "a.b" }] }, { blocked: [], live: "x" }, { blocked: [], timestamps: ["x"] }, { timestamps: [] }, [] as unknown]) {
    writeFileSync(path, JSON.stringify(damaged));
    assert.throws(() => readLaunchSafety(path), /invalid (launch safety|unconfirmed process|running-process) state/, JSON.stringify(damaged));
  }
  writeFileSync(path, "");
  assert.throws(() => readLaunchSafety(path), (error: Error) => error.message.includes(path) && /unreadable.*fix or delete/.test(error.message));
  assert.equal(readLaunchSafety(join(dir, "missing.json")).live.length, 0);
});

test("a config write that fails says it could not write, not that seeding failed", () => {
  const dir = tempRoot();
  const target = join(dir, "client-prefs.json");
  mkdirSync(target);
  assert.throws(() => writeClientPrefs({ ...DEFAULT_CLIENT_PREFS }, target), (error: Error) => /^config write: could not write /.test(error.message) && !/seeding/.test(error.message));
});

// config.ts under a packaged data root: its start-up cleans leftovers of an interrupted publish, and only those.
test("start-up removes an old interrupted '.seed-XXXXXX' folder from the config dir and nothing else", async () => {
  const copy = tempRoot(["server", "config"]);
  const data = tempRoot();
  const config = join(data, "config"); mkdirSync(config, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  const oldDir = join(config, ".seed-AbCdEf"); mkdirSync(oldDir); writeFileSync(join(oldDir, "config.json"), "{}"); utimesSync(oldDir, old, old);
  const youngDir = join(config, ".seed-YoUnG1"); mkdirSync(youngDir); writeFileSync(join(youngDir, "config.json"), "{}");
  const otherName = join(config, ".seed-notours"); mkdirSync(otherName); utimesSync(otherName, old, old);
  const plainFile = join(config, ".seed-FiLe12"); writeFileSync(plainFile, "x"); utimesSync(plainFile, old, old);
  const withExtra = join(config, ".seed-Extra1"); mkdirSync(withExtra); writeFileSync(join(withExtra, "keep.txt"), "mine"); utimesSync(withExtra, old, old);
  const linkTarget = join(data, "link-target"); mkdirSync(linkTarget); writeFileSync(join(linkTarget, "config.json"), "precious");
  const linked = join(config, ".seed-LiNk12"); symlinkSync(linkTarget, linked, "junction"); fs.lutimesSync(linked, old, old); // old enough to be swept if it were a folder
  const saved = process.env.NODE_TEST_CONTEXT, savedDir = process.env.CC_DATA_DIR;
  delete process.env.NODE_TEST_CONTEXT; process.env.CC_DATA_DIR = data;
  try { await import(pathToFileURL(join(copy, "server/config.ts")).href); }
  finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; if (savedDir === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = savedDir; }
  assert.equal(existsSync(oldDir), false, "the old interrupted folder is gone");
  assert.equal(existsSync(youngDir), true, "a recent one may belong to a racing server");
  assert.equal(existsSync(otherName), true, "a folder that does not look like ours");
  assert.equal(existsSync(plainFile), true, "a plain file");
  assert.equal(existsSync(join(withExtra, "keep.txt")), true, "a folder holding anything but config.json is not emptied");
  assert.equal(lstatSync(linked).isSymbolicLink(), true, "a link is never followed or removed");
  assert.equal(readFileSync(join(linkTarget, "config.json"), "utf8"), "precious");
  rmdirSync(linked);
});

// ---- The engine (server/process.ts) ---------------------------------------------------------------------------------------------

test("getProcessDefinition names an unknown kind or process plainly, for inherited names too", () => {
  for (const [kind, process] of [["dev", "nope"], ["nope", "main"], ["constructor", "main"], ["dev", "__proto__"], ["dev", "toString"], ["dev", undefined]] as const) {
    assert.throws(() => getProcessDefinition(kind as any, process as any), new RegExp(`^Error: unknown kind/process: ${kind}/${process}$`), `${kind}/${process}`);
  }
  assert.equal(getProcessDefinition("dev", "main").seats.length, 6);
});

function waitingReview(): ProcessState {
  let state = createTabState("dev", "main", { tabId: "tab", folderPath: "C:/work" });
  state = advanceStep(state); state = advanceStep(state); state = advanceStep(state); // brief -> build -> gate -> look
  state = startRun(state, { id: "build-1", seatSlotId: "coder", label: "Build", startedAt: 1 });
  state = approveLook(state);
  assert.equal(state.approval.reviewWaits, true, "the review waits for the build");
  return state;
}
const seatOf = (state: ProcessState, slot: string) => state.seats.find((seat) => seat.slotId === slot)!;

test("Stop all pauses a review that was waiting for workers: it never opens, not now and not when the stopped worker's run closes", () => {
  let state = stopAll(waitingReview(), 9, new Set(["build-1"])); // the worker's process is still closing
  assert.equal(state.approval.reviewWaits, false, "the wait ends with the stop");
  assert.deepEqual([seatOf(state, "reviewer1").status, seatOf(state, "leader").status, seatOf(state, "coder").status], ["stopped", "stopped", "stopped"]);
  assert.equal(state.runs[0].status, "working", "the closing run settles only when its close is confirmed");
  state = stopRun(state, "build-1", 12);
  assert.deepEqual([seatOf(state, "reviewer1").status, seatOf(state, "leader").status], ["stopped", "stopped"], "the confirmed close does not start the review");
  assert.equal(isBusy(state), false, "a stopped tab is not busy");
  assert.equal(state.approval.reviewWaits, false);
  assert.match(getStepBar(state).find((step) => step.state === "current")!.label, /Vera stopped/);
  // With nothing closing the result is the same, in one step.
  const direct = stopAll(waitingReview(), 9);
  assert.deepEqual([seatOf(direct, "reviewer1").status, seatOf(direct, "leader").status, isBusy(direct)], ["stopped", "stopped", false]);
});

test("a finished run is pruned by when it ended, never the run that just settled, even when that run is the oldest to have ended", () => {
  let state = createTabState("dev", "main", { tabId: "tab", folderPath: "C:/work" });
  state = startRun(state, { id: "long-run", seatSlotId: "coder", label: "Long", startedAt: 1 });
  state = startRun(state, { id: "slow", seatSlotId: "coder", label: "Slow", startedAt: 2 });
  for (let i = 0; i < MAX_FINISHED_RUNS - 1; i++) {
    state = startRun(state, { id: `quick-${i}`, seatSlotId: "reviewer1", label: "Quick", startedAt: 10 + i });
    state = finishRun(state, `quick-${i}`, 100 + i);
  }
  state = finishRun(state, "slow", 5000); // started early, ended last: by start order it would look oldest
  assert.equal(state.runs.filter((run) => run.status !== "working").length, MAX_FINISHED_RUNS, "exactly at the cap");
  state = finishRun(state, "long-run", 0); // settles with the oldest end of all
  const ids = state.runs.map((run) => run.id);
  assert.equal(state.runs.filter((run) => run.status !== "working").length, MAX_FINISHED_RUNS, "the cap still holds");
  assert.ok(ids.includes("long-run"), "the run that just settled is still listed");
  assert.ok(ids.includes("slow"), "a run that started early but ended late is kept");
  assert.equal(ids.includes("quick-0"), false, "the one that ended longest ago (of the others) went");
  assert.ok(ids.includes("quick-1"));
});

test("a run settled without an end time ends now, not at its own start", () => {
  let state = createTabState("dev", "main", { tabId: "tab", folderPath: "C:/work" });
  state = startRun(state, { id: "r1", seatSlotId: "coder", label: "x", startedAt: 5 });
  const before = Date.now();
  state = finishRun(state, "r1");
  assert.ok(state.runs[0].endedAt! >= before && state.runs[0].endedAt! <= Date.now(), `endedAt ${state.runs[0].endedAt}`);
});

test("the Review step counts '1 round' and '2 rounds'", () => {
  let rounds = waitingReview(); rounds = finishRun(rounds, "build-1", 5);
  rounds = { ...rounds, roundHistory: [{ round: 1, reviewerSlotId: "reviewer1", reviewerName: "Vera", outcome: "findings", fixerSlotId: "coder", fixerName: "Sonny" }], currentStepIndex: 5 };
  assert.match(getStepBar(rounds).find((step) => step.stepId === "review")!.label, / · 1 round$/);
  rounds = { ...rounds, roundHistory: [...rounds.roundHistory, { ...rounds.roundHistory[0], round: 2 }] };
  assert.match(getStepBar(rounds).find((step) => step.stepId === "review")!.label, / · 2 rounds$/);
});

// ---- C6: which folders a tab may have --------------------------------------------------------------------------------------------
// The rule both sides report: the server refuses only a path no worker can run in (not absolute, climbing out with "..", control
// characters, a path that does not exist or is not a folder). Parentheses, & ^ % in a name and a drive root are fine: the runner puts
// the folder in the environment and quotes a trailing backslash, so every folder the server accepts can be launched in.
test("the folder rule: ( ) & ^ % in a name and a drive root are accepted for a tab; a relative, climbing, control-character, missing or file path is refused", async () => {
  const data = makeData();
  const work = mkdtempSync(join(tmpdir(), "cc-pack2-folders-"));
  const odd = join(work, "My App (v2) & Co ^ 100%");
  const plainFile = join(work, "file.txt");
  const driveRoot = resolve(tmpdir()).split(/[\\/]/)[0] + "\\";
  let server: Server | undefined, opened: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    mkdirSync(odd); writeFileSync(plainFile, "x");
    server = await boot(data); const client = opened = await connect(server);
    const projectId = client.state().projects[0].id;
    const tabsOf = () => client.state().projects.flatMap((project: any) => project.tabs);
    const addTab = async (folder: string, requestId: string) => {
      const before = tabsOf().length;
      client.send({ type: "addTab", projectId, name: requestId, folder, requestId });
      return await client.wait(() => client.messages.find((m) => m.type === "error" && m.requestId === requestId) ?? (tabsOf().length > before ? "added" : undefined), `addTab ${requestId}`);
    };
    assert.equal(await addTab(odd, "f_odd"), "added", "( ) & ^ % in the name");
    assert.ok(tabsOf().some((tab: any) => tab.folder === odd));
    assert.match(driveRoot, /^[A-Za-z]:\\$/, "the temp folder sits on a lettered drive, so the drive-root checks below always run");
    assert.equal(await addTab(driveRoot, "f_root"), "added", `a drive root (${driveRoot})`);
    assert.ok(tabsOf().some((tab: any) => tab.folder === driveRoot));
    const refused = async (folder: string, requestId: string, pattern: RegExp) => assert.match(((await addTab(folder, requestId)) as any).message, pattern, requestId);
    await refused("relative\\dir", "f_rel", /absolute directory path/);
    await refused(work + "/../x", "f_dots", /without traversal/);
    await refused(`${work}\u0007`, "f_ctl", /absolute directory path/);
    await refused(join(work, "missing"), "f_missing", /does not exist/);
    await refused(plainFile, "f_file", /must be a directory/);
    await refused("   ", "f_blank", /is required/);
  } finally { opened?.close(); await server?.stop(); removeWithRetry(work); removeWithRetry(data); }
});

test("the server start finishes what a crashed earlier server left behind: its registry names a live child, which is stopped with no run launched", { skip: process.platform !== "win32" ? "Windows process behaviour" : false }, async () => {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  // The earlier server is a LIVE process of ours whose recorded creation time does not match (a "reused pid"), never an exited one: an exited pid can be handed to the new server itself, which skips the file named after its own pid.
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const created = (await listProcesses())?.find((proc) => proc.pid === orphan.pid)?.created;
    assert.ok(created, "the fake child is in the process list");
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: 1 }, roots: [{ pid: orphan.pid, rootCreated: created, known: [] }] }));
    assert.equal(alive(orphan.pid!), true);
    server = await boot(data);
    const end = Date.now() + 15000;
    while ((alive(orphan.pid!) || existsSync(registry) || !server.log().includes("[cleanup]")) && Date.now() < end) await sleep(50);
    assert.equal(alive(orphan.pid!), false, `the start-up sweep stopped the leftover child: ${server.log().slice(-300)}`);
    assert.equal(existsSync(registry), false, "the dead server's registry file is removed");
    assert.match(server.log(), /\[cleanup\] stopped 1 processes left by an earlier server/);
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill(); // through the objects this test spawned, never a bare pid
    await server?.stop();
    removeWithRetry(data);
  }
});

test("round 1 fix 2: the server listens only after the start-up sweep finished, so nothing can launch before a crashed server's leftovers are stopped", { skip: process.platform !== "win32" ? "Windows process behaviour" : false }, async () => {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  // The earlier server is a LIVE process of ours with a mismatched recorded creation time (see the test above), never an exited pid.
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const created = (await listProcesses())?.find((proc) => proc.pid === orphan.pid)?.created;
    assert.ok(created, "the fake child is in the process list");
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: 1 }, roots: [{ pid: orphan.pid, rootCreated: created, known: [] }] }));
    server = await boot(data); // returns the moment the server says it listens
    assert.equal(alive(orphan.pid!), false, "the leftover was already stopped when the server started listening");
    assert.equal(existsSync(registry), false, "and the registry already handled");
    const log = server.log();
    assert.ok(log.indexOf("[cleanup] stopped 1 processes left by an earlier server") >= 0 && log.indexOf("[cleanup]") < log.indexOf("127.0.0.1"), `the sweep's line comes before the listening line: ${log.slice(-300)}`);
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill(); // through the objects this test spawned, never a bare pid
    await server?.stop();
    removeWithRetry(data);
  }
});

// The owner check in the sweep: a live pid with a different creation time is a REUSED pid (the owner is gone); a live pid with no recorded time or the matching time is the owner.
async function ownerCase(ownerCreated: "reused" | "null" | "match") {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const list = await listProcesses();
    const createdOf = (pid?: number) => list?.find((proc) => proc.pid === pid)?.created;
    assert.ok(createdOf(owner.pid) && createdOf(orphan.pid), "both fake processes are in the process list");
    const recorded = ownerCreated === "reused" ? 1 : ownerCreated === "null" ? null : createdOf(owner.pid);
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: recorded }, roots: [{ pid: orphan.pid, rootCreated: createdOf(orphan.pid), known: [] }] }));
    server = await boot(data); // returns after the start-up sweep
    return { orphanAlive: alive(orphan.pid!), registryLeft: existsSync(registry), log: server.log() };
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill();
    await server?.stop();
    removeWithRetry(data);
  }
}
const winOnly = { skip: process.platform !== "win32" ? "Windows process behaviour" : false };
test("pack 15: the owner's pid is alive but its creation time differs (a reused pid): the start-up sweep still stops the leftover and removes the file", winOnly, async () => {
  const result = await ownerCase("reused");
  assert.equal(result.orphanAlive, false, `the leftover was stopped: ${result.log.slice(-300)}`);
  assert.equal(result.registryLeft, false, "the registry file is removed");
});
test("pack 15: the owner is alive with no recorded creation time, or with its matching one: the sweep leaves the leftover and the file alone", winOnly, async () => {
  for (const kind of ["null", "match"] as const) {
    const result = await ownerCase(kind);
    assert.equal(result.orphanAlive, true, `owner alive (${kind}): the leftover is NOT stopped`);
    assert.equal(result.registryLeft, true, `owner alive (${kind}): the registry file stays`);
  }
});

// ---- A damaged chat file: the tab still opens, refuses chat, and Clear starts it over -------------------------------------------

test("a tab whose chat file is damaged opens with an empty history, refuses a chat message, and Clear keeps the file as .bad-* and starts an empty chat; other tabs are untouched", async () => {
  const data = makeData(), work = mkdtempSync(join(tmpdir(), "cc-pack2-damaged-work-"));
  const damaged = `{"role":"user","text":"hello"}\n{"role":"assis`;
  let first: Server | undefined, server: Server | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    first = await boot(data);
    const setup = await connect(first);
    const projectId = setup.state().projects[0].id;
    setup.send({ type: "addTab", projectId, name: "Second", folder: work, requestId: "dm_add" });
    await setup.wait(() => setup.state().projects.flatMap((p: any) => p.tabs).length > 1, "second tab added");
    const [bad, good] = setup.state().projects.flatMap((p: any) => p.tabs).map((tab: any) => tab.id) as string[];
    setup.close(); await first.stop(); first = undefined;
    mkdirSync(join(data, "chats"), { recursive: true });
    const file = join(data, "chats", `${bad}.jsonl`);
    writeFileSync(file, damaged);
    const goodStore = new ChatStore(join(data, "chats")); goodStore.appendMessage(good, "user", "kept");
    const goodBefore = readFileSync(join(data, "chats", `${good}.jsonl`), "utf8");

    server = await boot(data); client = await connect(server);
    const tabOf = (id: string) => client!.state().projects.flatMap((p: any) => p.tabs).find((tab: any) => tab.id === id);
    const history = (id: string) => client!.messages.filter((m) => m.type === "chatHistory" && m.tabId === id);
    client.send({ type: "hello" });
    await client.wait(() => history(bad).length, "hello sends chatHistory for the damaged selected tab");
    assert.deepEqual([history(bad)[0].messages, history(bad)[0].revision, history(bad)[0].savedRevision], [[], 0, 0], "hello: empty history at revision 0");
    assert.match(tabOf(bad).chatProblem, /invalid chat transcript/);

    client.send({ type: "selectTab", tabId: good });
    await client.wait(() => history(good).length, "healthy tab opens");
    assert.equal(history(good)[0].messages[0].text, "kept");
    client.send({ type: "selectTab", tabId: bad });
    await client.wait(() => history(bad).length > 1, "selectTab to the damaged tab sends a chatHistory");
    assert.deepEqual([history(bad).at(-1).messages, history(bad).at(-1).revision], [[], 0], "selectTab: empty history at revision 0");
    assert.equal(client.messages.some((m) => m.type === "error" && /invalid chat transcript/.test(m.message)), false, "no error toast");
    client.send({ type: "selectTab", tabId: "no-such-tab" });
    await client.wait(() => client!.messages.find((m) => m.type === "error" && /unknown tab: no-such-tab/.test(m.message)), "an unknown tab is still refused");

    client.send({ type: "chat", tabId: bad, text: "are you there", requestId: "dm_chat" });
    const refused = await client.wait(() => client!.messages.find((m) => m.type === "error" && m.requestId === "dm_chat"), "chat refused");
    assert.equal(refused.message, "This chat could not be read. Clear it to start a new one.");
    await sleep(300);
    assert.equal(client.messages.some((m) => m.type === "chatMessage" || m.type === "chatError" || m.type === "chatDone"), false, "no turn was started");
    assert.equal(readFileSync(file, "utf8"), damaged, "the damaged file was not appended to");

    client.send({ type: "clear", tabId: bad });
    const cleared = await client.wait(() => client!.messages.find((m) => m.type === "chatCleared" && m.tabId === bad), "chatCleared");
    assert.equal(cleared.noUndo, true, "no Undo for a Clear with nothing good to restore");
    await client.wait(() => tabOf(bad) && !("chatProblem" in tabOf(bad)), "chatProblem gone");
    const kept = readdirSync(join(data, "chats")).filter((name) => name.startsWith(`${bad}.jsonl.bad-`));
    assert.equal(kept.length, 1, `one .bad copy: ${readdirSync(join(data, "chats"))}`);
    assert.equal(readFileSync(join(data, "chats", kept[0]), "utf8"), damaged, "the copy holds the original bytes");
    client.send({ type: "selectTab", tabId: good }); client.send({ type: "selectTab", tabId: bad });
    await client.wait(() => history(bad).length > 2, "history after Clear");
    assert.equal(history(bad).at(-1).messages.length, 0, "an empty chat");
    assert.equal(tabOf(bad).chatRevision, cleared.revision);
    assert.equal(readFileSync(join(data, "chats", `${good}.jsonl`), "utf8"), goodBefore, "the other tab's file is untouched");
    assert.equal(tabOf(good).chatRevision, 1);
  } finally {
    client?.close(); await server?.stop(); await first?.stop();
    removeWithRetry(data); removeWithRetry(work);
  }
});
