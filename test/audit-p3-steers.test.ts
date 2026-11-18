import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, unlinkSync, rmdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cc-p3-steers-"));
const previous = { data: process.env.CC_DATA_DIR, packaged: process.env.CC_TEST_FORCE_PACKAGED };
process.env.CC_DATA_DIR = root; process.env.CC_TEST_FORCE_PACKAGED = "1";
// Prove isolation before config.ts (which seeds files) is imported.
const paths = await import("../server/config-files.ts");
assert.equal(resolve(paths.dataRoot), resolve(root));
const state = await import("../server/main/state.ts");
const turns = await import("../server/main/leader-turn.ts");
const sessions = await import("../server/main/leader-session.ts");
const { SettingsService } = await import("../server/settings.ts");
const { ChatStore } = await import("../server/chat-store.ts");
const { RequestsStore } = await import("../server/requests.ts");
const { readClientPrefs } = await import("../server/config.ts");
const { createTaskStore } = await import("../server/fixed-crew/task-store.ts");
const { fixedProject, fixedTab, fixedWorkspaces } = await import("./fixed-server-fixture.ts");

after(() => {
  if (previous.data === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previous.data;
  if (previous.packaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = previous.packaged;
  const folders = [root];
  for (const folder of folders) {
    assert.equal(lstatSync(folder).isSymbolicLink(), false, folder);
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), info = lstatSync(path);
      assert.equal(info.isSymbolicLink(), false, path);
      if (info.isDirectory()) folders.push(path); else unlinkSync(path);
    }
  }
  for (const folder of folders.reverse()) { assert.deepEqual(readdirSync(folder), []); rmdirSync(folder); }
});
const tick = () => new Promise<void>((ok) => setImmediate(ok));
async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 200; n++) { if (check()) return; await tick(); }
  assert.fail(label);
}

// Fake only the vendor process boundary. All admission, steering, replacement,
// callbacks, persistence and page broadcasts are the real server modules.
function codexPeer() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const starts: any[] = [], steers: any[] = [];
  let current = "", serial = 0;
  const emit = (message: any) => stdout.write(JSON.stringify(message) + "\n");
  const child: any = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split("\n")) {
      const request = JSON.parse(line);
      if (request.method === "turn/steer") { steers.push(request); continue; }
      if (!request.method || request.id === undefined) continue;
      let result = {};
      if (request.method === "thread/start") result = { thread: { id: "fake-thread" } };
      if (request.method === "turn/start") { starts.push(request); current = `turn-${++serial}`; result = { turn: { id: current } }; }
      queueMicrotask(() => emit({ id: request.id, result }));
    }
    done();
  } });
  return { child, starts, steers,
    handBack: () => { for (const request of steers.splice(0)) emit({ id: request.id, error: { message: "no active turn to steer" } }); },
    complete: () => emit({ method: "turn/completed", params: { turn: { id: current, status: "completed" } } }),
    close: () => { child.stdin.destroy(); stdout.destroy(); stderr.destroy(); },
  };
}
let fixtureNumber = 0;
function fixture() {
  const folder = join(root, `case-${++fixtureNumber}`); mkdirSync(folder);
  const tab = fixedTab("steers", folder, { leader: { cli: "codex", model: "gpt-6-sol", effort: "low" } });
  const replies: any[] = [], peers: ReturnType<typeof codexPeer>[] = [];
  let failStart = false;
  const ws: any = { readyState: 1, bufferedAmount: 0, send: (raw: string) => replies.push(JSON.parse(raw)) };
  state.setDataRoot(folder); state.setWorkspaces(fixedWorkspaces([fixedProject("p3", folder, [tab])]));
  state.setFixedTasks(createTaskStore(folder, () => state.workspaces.projects[0]));
  state.setSelectedTabId(""); state.tabs.clear(); state.clients.clear(); state.clients.add(ws);
  state.setBlockedSeatKeys(new Set()); state.setUnconfirmedRunIds(new Set());
  state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] });
  state.setChatStore(new ChatStore(join(folder, "chats"))); state.setRequestsStore(new RequestsStore(folder));
  state.setClientPrefs(readClientPrefs()); state.setAcpClis([]);
  state.setFolderActivity({ beginOwn: () => 0, endOwn() {}, watchFolders() {}, noteSession() {}, pending: () => [] } as any);
  state.setCliRunner(async () => ({ code: 1, stdout: "", stderr: "not a repository" }));
  state.setSettingsService(new SettingsService({ dataRoot: folder, runCli: state.cliRunner }));
  state.settingsService.state.tools.codex.installed = true;
  let startError = "error_during_execution POST /session/ses_private/permission/permission_private";
  state.setLeaderSpawn((() => {
    if (failStart) throw new Error(startError);
    const peer = codexPeer(); peers.push(peer); return peer.child;
  }) as any);
  const rows = () => state.chatStore.snapshot(tab.id).messages;
  const sent = () => peers.flatMap((peer) => peer.starts.map((request) => request.params.input[0].text.split("Current message:\n").at(-1)));
  const queue = async () => {
    turns.acceptChat(ws, { tabId: tab.id, text: "original" });
    await until(() => peers[0]?.starts.length === 1, `initial turn reached the CLI: ${JSON.stringify(replies.filter((row) => row.type !== "state"))}`);
    await tick();
    for (const text of ["first", "second", "third"]) turns.steerLeaderTurn(ws, { tabId: tab.id, text });
    assert.equal(peers[0].steers.length, 3);
    peers[0].handBack();
    await until(() => state.lateSteers.get(tab.id)?.length === 3, "all three hand-backs entered the real queue");
  };
  const replace = (reason = "settings") => {
    if (reason === "vault") { const vault = join(folder, "notes"); mkdirSync(vault); state.settingsService.state.vault.path = vault; }
    else tab.fixedCrew!.roleExtras.leader = "Changed instructions";
    peers[0].complete();
  };
  return { tab, peers, replies, rows, sent, ws, queue, replace, fail: (message?: string) => { failStart = true; if (message) startError = message; },
    disk: () => readFileSync(join(folder, "chats", `${tab.id}.jsonl`), "utf8"),
    close: async () => {
      sessions.stopLeaderSession(tab.id, true);
      state.clients.clear(); state.setLeaderSpawn(undefined);
      for (const peer of peers) peer.close();
      await tick(); await tick();
    },
  };
}

for (const reason of ["settings", "vault"]) test(`three handed-back steers survive ${reason} replacement in their original order`, async () => {
  const fx = fixture();
  try {
    await fx.queue(); fx.replace(reason);
    await until(() => fx.peers[1]?.starts.length === 1, "replacement received first steer");
    fx.peers[1].complete(); await tick();
    assert.deepEqual(fx.sent(), ["original", "first", "second"], "second steer survives replacement");
    fx.peers[1].complete(); await tick();
    assert.deepEqual(fx.sent(), ["original", "first", "second", "third"]);
    fx.peers[1].complete(); await tick();
    assert.equal(state.activeLeaderTurns.has(fx.tab.id), false);
    assert.deepEqual(fx.rows().filter((row) => row.role === "user").map((row) => row.text), ["original", "first", "second", "third"]);
  } finally { await fx.close(); }
});

for (const clear of [false, true]) test(`${clear ? "Clear" : "Stop"} cancels remaining steers after replacement`, async () => {
  const fx = fixture();
  try {
    await fx.queue(); fx.replace();
    await until(() => fx.peers[1]?.starts.length === 1, "replacement started");
    assert.deepEqual(state.lateSteers.get(fx.tab.id)?.map((row) => row.text), ["second", "third"], "queue survives until explicit cancellation");
    sessions.stopLeaderSession(fx.tab.id, clear);
    if (clear) state.chatStore.clear(fx.tab.id);
    fx.peers[1].complete(); await tick();
    assert.deepEqual(fx.sent(), ["original", "first"]);
    assert.equal(state.lateSteers.has(fx.tab.id), false);
    assert.equal(state.activeLeaderTurns.has(fx.tab.id), false);
    if (clear) assert.deepEqual(fx.rows(), []);
  } finally { await fx.close(); }
});

test("failed replacement saves an unanswered notice and a plain page error, never success", async () => {
  const fx = fixture();
  try {
    await fx.queue(); fx.fail(); fx.replace(); await tick();
    const notice = fx.rows().find((row) => row.role === "notice");
    assert.ok(notice, "the accepted steers must never disappear silently");
    assert.match(notice.text, /not have been answered; send it again/);
    const errors = fx.replies.filter((row) => row.type === "chatError");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "The leader could not answer your message. Send it again.");
    assert.equal(fx.replies.filter((row) => row.type === "chatDone").length, 1, "only the original turn finished successfully");
    assert.deepEqual(fx.sent(), ["original"]);
    assert.equal(state.activeLeaderTurns.has(fx.tab.id), false);
    assert.equal(state.lateSteers.has(fx.tab.id), false);
    assert.doesNotMatch(fx.disk() + JSON.stringify(errors), /error_during_execution|\/session\/|ses_private|permission_private/);
    assert.deepEqual(fx.rows().filter((row) => row.role === "user").map((row) => row.text), ["original", "first", "second", "third"]);
  } finally { await fx.close(); }
});

test("a normal turn startup exception is saved and reported as plain text with a false result", async () => {
  const fx = fixture();
  try {
    fx.fail();
    let reply = "";
    let result: boolean | undefined;
    await assert.doesNotReject(async () => {
      result = await turns.sendLeaderTurn(fx.tab.id, "start", [], [], undefined, (text) => { reply = text; });
    }, "a startup error must end as a failed turn, not a raw rejected SDK exception");
    assert.equal(result, false);
    assert.equal(reply, "The leader could not answer your message. Send it again.");
    assert.equal(fx.rows().at(-1)?.text, reply);
    const errors = fx.replies.filter((row) => row.type === "chatError");
    assert.equal(errors.length, 1); assert.equal(errors[0].message, reply);
    assert.doesNotMatch(fx.disk() + JSON.stringify(errors), /error_during_execution|\/session\/|ses_private|permission_private/);
    assert.equal(state.leaderTurnResolvers.has(fx.tab.id), false);
  } finally { await fx.close(); }
});

test("the last handed-back steer still gets an unanswered notice if its replacement fails", async () => {
  const fx = fixture();
  try {
    await fx.queue(); fx.replace();
    await until(() => fx.peers[1]?.starts.length === 1, "first resend started");
    fx.peers[1].complete(); await tick();
    assert.deepEqual(fx.sent(), ["original", "first", "second"]);
    fx.tab.fixedCrew!.roleExtras.leader = "Replace once more";
    fx.fail(); fx.peers[1].complete(); await tick();
    assert.ok(fx.rows().some((row) => row.role === "notice" && /not have been answered/.test(row.text)), "even without another steer behind it, the failed resend must be explained");
    assert.equal(fx.replies.filter((row) => row.type === "chatError").length, 1);
    assert.equal(fx.replies.filter((row) => row.type === "chatDone").length, 3);
    assert.deepEqual(fx.sent(), ["original", "first", "second"]);
  } finally { await fx.close(); }
});

const HOME_DIR = ["C:", "Users", "private"].join("/");
for (const [cause, expected] of [
  ['The CLI "ghost" was removed in Settings. Pick another leader CLI for Private.', 'The CLI was removed in Settings. Pick another leader CLI for this tab.'],
  [`The Claude CLI (${HOME_DIR}/cli) lies inside the tab folder (${HOME_DIR}); refusing to start it from there.`, 'The CLI is inside the tab folder. Choose a different project folder or install it outside project folders.'],
  [`codex was found only inside a project folder (${HOME_DIR}), which is never used; install it outside your project folders or remove that project folder`, 'codex was found only inside a project folder. Choose a different project folder or install it outside project folders.'],
  ['codex was not found on PATH', 'The CLI was not found. Install it from Settings.'],
]) test('known startup failure supplies a safe remedy: ' + expected, async () => {
  const fx = fixture();
  try {
    fx.fail(cause);
    assert.equal(await turns.sendLeaderTurn(fx.tab.id, "start"), false);
    const error = fx.replies.find((row) => row.type === "chatError");
    assert.equal(error.message, expected);
    assert.equal(fx.rows().at(-1)?.text, expected);
    assert.doesNotMatch(fx.disk(), /C:\/Users|ghost|Private/);
    assert.equal(state.activeLeaderTurns.has(fx.tab.id), false);
  } finally { await fx.close(); }
});

test("a handed-back steer whose delivery rejects ends the turn with a plain error and leaves the tab free", async () => {
  const fx = fixture();
  const realSet = state.leaderTurnResolvers.set;
  try {
    state.leaderTurnResolvers.set = function () { state.leaderTurnResolvers.set = realSet; throw new Error(`private failure at ${HOME_DIR}`); } as any;
    turns.handleMissedSteer(fx.tab.id, "late steer", []);
    await until(() => fx.replies.some((row) => row.type === "chatError"), "the failed delivery is reported");
    const errors = fx.replies.filter((row) => row.type === "chatError");
    assert.equal(errors[0].message, "The leader could not answer your message. Send it again.");
    assert.equal(state.activeLeaderTurns.has(fx.tab.id), false, "the tab is not left busy");
    assert.doesNotMatch(JSON.stringify(errors), /private/);
  } finally { state.leaderTurnResolvers.set = realSet; await fx.close(); }
});
