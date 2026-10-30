// Fix pack 2, block 1 (server core), part 1: real server processes (a taken port, client prefs across a restart, an older launch-safety file, a data root behind a junction) and the pure tests for the stores and the config reader.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, lstatSync, fsyncSync, renameSync } from "node:fs";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tempRoot } from "./temp-root.ts";
import { isWithinDir } from "../server/security.ts";
import { ChatStore, isTabSlug } from "../server/chat-store.ts";
import { RequestsStore } from "../server/requests.ts";
import { readLaunchSafety, writeClientPrefs, DEFAULT_CLIENT_PREFS } from "../server/config.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { sleep, plain, type Server, boot, connect, makeData } from "./pack2-server-helpers.ts";

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

