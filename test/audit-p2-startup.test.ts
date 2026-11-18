import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";
import { fixedWorkspaces } from "./fixed-server-fixture.ts";
import { newAppKey, stopOwnedChild } from "./temp-root.ts";
import { waitForServerStart } from "./server-start.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { RequestsStore } from "../server/requests.ts";
import { stopChromeTree } from "./chrome-stop.ts";
import { taskFixture } from "./pack18-editor-task-fixture.ts";

const roots: string[] = [];
function scratch() { const root = fs.mkdtempSync(join(tmpdir(), "cc-p2-startup-")); roots.push(root); return root; }
function clean(path: string): void {
  assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const child = join(path, entry.name);
    if (entry.isDirectory()) clean(child); else fs.unlinkSync(child);
  }
  assert.deepEqual(fs.readdirSync(path), []); fs.rmdirSync(path);
}
after(() => { for (const root of roots) clean(root); });
const env = { CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED };
process.env.CC_DATA_DIR = scratch(); process.env.CC_TEST_FORCE_PACKAGED = "1";
const acp = await import("../server/config-acp.ts");
for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
const original = { readFileSync: fs.readFileSync, copyFileSync: fs.copyFileSync, renameSync: fs.renameSync };
function fault(name: keyof typeof original, predicate: (path: string) => boolean, code = "EACCES") {
  (fs as any)[name] = (path: any, ...args: any[]) => {
    if (predicate(String(name === "renameSync" ? args[0] : path))) throw Object.assign(new Error("injected file failure"), { code });
    return (original[name] as any)(path, ...args);
  };
  syncBuiltinESMExports();
  return () => { (fs as any)[name] = original[name]; syncBuiltinESMExports(); };
}
const copies = (path: string) => fs.readdirSync(resolve(path, "..")).filter((name) => name.startsWith(`${basename(path)}.bad-`));
const input = { fromTabId: "alpha-development", toTabId: "gone", title: "Saved request", body: "keep this" };

for (const code of ["EBUSY", "EACCES"]) test(`requests ${code} starts safely and refuses blind writes without changing bytes or memory`, () => {
  const root = scratch(), path = join(root, "requests.json"), bytes = '[{"saved":"original"}]'; fs.writeFileSync(path, bytes);
  const restore = fault("readFileSync", (p) => p === path, code);
  let store: RequestsStore;
  try { assert.doesNotThrow(() => { store = new RequestsStore(root); }); } finally { restore(); }
  assert.deepEqual(store!.list(), []);
  assert.throws(() => store!.send(input, () => true), /cannot be changed/);
  assert.deepEqual(store!.list(), []); assert.equal(fs.readFileSync(path, "utf8"), bytes);
});
for (const bytes of ["damaged json", '{"invalid":"schema"}']) test(`requests failed preservation blocks writes: ${bytes}`, () => {
  const root = scratch(), path = join(root, "requests.json"); fs.writeFileSync(path, bytes);
  const restore = fault("copyFileSync", (p) => p === path);
  let store: RequestsStore;
  try { assert.doesNotThrow(() => { store = new RequestsStore(root); }); } finally { restore(); }
  assert.throws(() => store!.send(input, () => true), /cannot be changed/);
  assert.deepEqual(store!.list(), []); assert.equal(fs.readFileSync(path, "utf8"), bytes); assert.equal(copies(path).length, 0);
});
test("requests refused destination update and resolution retain exact prior row and disk bytes", () => {
  const root = scratch(), store = new RequestsStore(root), row = store.send(input, () => true), bytes = fs.readFileSync(store.path);
  const restore = fault("renameSync", (p) => p === store.path, "EIO");
  try {
    assert.throws(() => store.markDestinationRemoved("gone"));
    assert.deepEqual(store.list(), [row]); assert.deepEqual(fs.readFileSync(store.path), bytes);
    assert.throws(() => store.resolve(row.id, "accepted", "gone", () => true));
    assert.deepEqual(store.list(), [row]); assert.deepEqual(fs.readFileSync(store.path), bytes);
  } finally { restore(); }
});
test("requests repeated loads deduplicate identical damage and preserve different bytes separately", () => {
  const root = scratch(), path = join(root, "requests.json");
  fs.writeFileSync(path, "damage one"); new RequestsStore(root); new RequestsStore(root);
  assert.equal(copies(path).length, 1); assert.equal(fs.readFileSync(path, "utf8"), "damage one");
  fs.writeFileSync(path, "damage two"); new RequestsStore(root);
  assert.equal(copies(path).length, 2);
  assert.deepEqual(copies(path).map((name) => fs.readFileSync(join(root, name), "utf8")).sort(), ["damage one", "damage two"]);
});
for (const failure of ["read", "copy"]) test(`saved tools ${failure} failure refuses replacing original`, () => {
  const path = join(scratch(), "acp-clis.json"), bytes = "damaged tools"; fs.writeFileSync(path, bytes);
  const restore = fault(failure === "read" ? "readFileSync" : "copyFileSync", (p) => p === path);
  try { assert.throws(() => acp.writeAcpClis([], path), /cannot be changed/); } finally { restore(); }
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
});

type Failure = { file: string; operation: keyof typeof original; code?: string };
async function boot(root: string, failures: Failure[] = []) {
  const script = join(root, "faults.mjs");
  // The only fake is the filesystem boundary. The actual index.ts and dispatch run unchanged.
  fs.writeFileSync(script, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const faults = ${JSON.stringify(failures)};
for (const op of ['readFileSync','copyFileSync','renameSync']) { const real = fs[op]; fs[op] = function(path,...args) {
 const target = String(op === 'renameSync' ? args[0] : path);
 const fault = faults.find(f => f.operation === op && target.replaceAll('\\\\','/').endsWith('/'+f.file));
 if (fault) throw Object.assign(new Error('injected file failure'),{code:fault.code || 'EACCES'});
 return real.call(fs,path,...args);
}; } syncBuiltinESMExports();`);
  const key = newAppKey();
  const child = spawn(process.execPath, ["--import", pathToFileURL(script).href, "server/index.ts"], { cwd: resolve("."), windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, CC_DATA_DIR: root, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: "0",
      CC_APP_KEY: key, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", HOME: root, USERPROFILE: root,
      CC_TEST_FAKE_CLI_ACTIVITY_HOME: root, CLAUDE_CLI_PATH: process.execPath } });
  attachCrashCatcher(child.pid, "audit-p2-startup");
  let log = ""; child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  try {
    const port = await waitForServerStart(child, () => log, 20_000);
    return { child, key, port, stop: () => stopOwnedChild(child), log: () => log };
  } catch (error) { await stopOwnedChild(child); throw error; }
}
function fixture() {
  const root = scratch(); fs.mkdirSync(join(root, "config"));
  const workspace = fixedWorkspaces(); workspace.projects[0].folder = root; workspace.projects[0].tabs[0].folder = root;
  fs.writeFileSync(join(root, "config", "workspaces.json"), JSON.stringify(workspace));
  return { root, workspace, tabId: workspace.projects[0].tabs[0].id };
}
test("saved tools stay blocked after a startup lock clears; transient reads retry", () => {
  const path = join(scratch(), "acp-clis.json"), clis = [{ id: "saved", name: "Saved", program: "saved", args: [] }];
  const bytes = JSON.stringify({ clis }); fs.writeFileSync(path, bytes);
  const restore = fault("readFileSync", (p) => p === path, "EBUSY");
  try { assert.throws(() => acp.readAcpClis(path), /could not be read/); } finally { restore(); }
  assert.throws(() => acp.writeAcpClis([], path), /cannot be changed/);
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
  let reads = 0;
  const retry = fault("readFileSync", (p) => p === path && ++reads === 1, "EBUSY");
  try {
    let loaded: ReturnType<typeof acp.readAcpClis>;
    assert.doesNotThrow(() => { loaded = acp.readAcpClis(path); });
    assert.deepEqual(loaded!, clis); assert.equal(reads, 2);
  } finally { retry(); }
});

test("a restored hold keeps live and uncertain facts across startup and exit", async () => {
  const { root } = fixture(), path = join(root, "config", "launch-safety.json");
  const facts = { recoveryHold: true, blocked: ["old.coder"], live: [{ seatId: "old.coder", runId: "old-run" }], uncertain: [{ seatId: "old.coder", runId: "old-run", pid: 123 }] };
  fs.writeFileSync(path, JSON.stringify(facts));
  const server = await boot(root); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); assert.equal((await c.wait((m) => m.type === "launchSafetyRecovery")).held, true);
    c.send({ type: "chat", tabId: c.state.projects[0].tabs[0].id, text: "held" });
    await c.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message));
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).live, facts.live);
  } finally { c?.close(); await server.stop(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).live, facts.live);
});
test("a failed release publication keeps the hold and every unresolved fact", async () => {
  const { root } = fixture(), path = join(root, "config", "launch-safety.json");
  const facts = { recoveryHold: true, blocked: ["old.coder"], live: [{ seatId: "old.coder", runId: "old-run" }], uncertain: [{ seatId: "old.coder", runId: "old-run", pid: 123 }] };
  const bytes = JSON.stringify(facts); fs.writeFileSync(path, bytes);
  const server = await boot(root, [{ file: "launch-safety.json", operation: "renameSync", code: "EIO" }]); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); const start = c.messages.length;
    c.send({ type: "releaseLaunchSafetyHold", confirm: "allow launches with unreadable process history" });
    await c.wait((m) => m.type === "error" && /could not be released/.test(m.message), start);
    assert.equal((await c.wait((m) => m.type === "launchSafetyRecovery", start)).held, true);
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
    c.send({ type: "chat", tabId: c.state.projects[0].tabs[0].id, text: "held" });
    await c.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message), start);
  } finally { c?.close(); await server.stop(); }
});
async function client(server: Awaited<ReturnType<typeof boot>>) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  const messages: any[] = []; ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(ws, "open");
  const send = (message: any) => ws.send(JSON.stringify(message));
  async function wait(predicate: (m: any) => boolean, from = 0) {
    const end = Date.now() + 5000;
    while (Date.now() < end) { const found = messages.slice(from).find(predicate); if (found) return found; await new Promise((done) => setTimeout(done, 10)); }
    assert.fail(`No matching reply: ${JSON.stringify(messages.slice(-3).map((m) => ({ type: m.type, message: m.message })))}; ${server.log()}`);
  }
  send({ type: "hello" }); const state = await wait((m) => m.type === "state");
  return { ws, messages, state, send, wait, close: () => ws.close() };
}
for (const future of [false, true]) test(`real startup blocks invalid fixed workspace without changing histories, future=${future}`, async () => {
  const { root, workspace } = fixture(), path = join(root, "config", "workspaces.json");
  workspace.projects[0].tabs[0].kind = "newer-kind" as any;
  if (future) (workspace.projects[0].tabs[0].fixedCrew as any).version = 50;
  const bytes = JSON.stringify(workspace); fs.writeFileSync(path, bytes);
  fs.mkdirSync(join(root, "tasks")); fs.writeFileSync(join(root, "tasks", "history.json"), "saved history");
  const server = await boot(root); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); const tab = c.state.projects[0].tabs[0];
    assert.equal(tab.fixedCrew.unavailable, true); assert.match(tab.fixedCrew.notice, /saved workspace/);
    c.send({ type: "renameTab", tabId: tab.id, name: "refused" }); await c.wait((m) => m.type === "error");
    assert.equal(fs.readFileSync(path, "utf8"), bytes); assert.equal(copies(path).length, 1);
    assert.equal(fs.readFileSync(join(root, "tasks", "history.json"), "utf8"), "saved history");
  } finally { c?.close(); await server.stop(); }
});
for (const failure of ["read", "copy", "read+copy", "replace"]) test(`real startup survives requests ${failure} failure and keeps original bytes`, async () => {
  const { root, tabId } = fixture(), path = join(root, "requests.json");
  const row = { id: "00000000-0000-4000-8000-000000000000", ...input, status: "pending", createdAt: 1 };
  const bytes = failure === "copy" ? "broken requests" : JSON.stringify([row]); fs.writeFileSync(path, bytes);
  const failures: Failure[] = failure === "read+copy" ? ["readFileSync", "copyFileSync"].map((operation) => ({ file: "requests.json", operation: operation as Failure["operation"], code: "EIO" }))
    : [{ file: "requests.json", operation: failure === "read" ? "readFileSync" : failure === "copy" ? "copyFileSync" : "renameSync", code: "EIO" }];
  const server = await boot(root, failures); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); assert.equal(c.state.projects[0].tabs[0].id, tabId);
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
    if (failure !== "replace") {
      c.send({ type: "sendRequest", fromTabId: tabId, toTabId: "gone", title: "No", body: "No" });
      await c.wait((m) => m.type === "error"); assert.equal(fs.readFileSync(path, "utf8"), bytes);
    }
    assert.equal(server.child.exitCode, null);
  } finally { c?.close(); await server.stop(); }
});
test("recovery retains readable copied brake facts, unresolved runs and journals across restart", async () => {
  const { root, workspace, tabId } = fixture(), path = join(root, "config", "launch-safety.json");
  workspace.projects[0].tabs[0].fixedCrew!.preferences.coder = { source: "user", assignment: { cli: "codex", model: "gpt-6-saved-test", effort: "saved-effort" } };
  fs.writeFileSync(join(root, "config", "workspaces.json"), JSON.stringify(workspace));
  const facts = { blocked: ["old.coder"], live: [{ seatId: "old.coder", runId: "old-run" }], uncertain: [{ seatId: "old.coder", runId: "old-run", pid: 123 }] };
  const bytes = JSON.stringify(facts); fs.writeFileSync(path, bytes);
  const server = await boot(root, [{ file: "launch-safety.json", operation: "readFileSync", code: "EBUSY" }]); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); c.send({ type: "recoverLaunchSafety" });
    const state = await c.wait((m) => m.type === "state" && m.projects[0].tabs[0].id === tabId);
    assert.ok(state.launchSafety.blocked.includes("old.coder"));
    assert.ok(state.modelOptions.codex.includes("gpt-6-saved-test")); assert.ok(state.effortOptions.codex.includes("saved-effort"));
    const saved = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.deepEqual(saved.live, facts.live); assert.deepEqual(saved.uncertain, facts.uncertain); assert.equal(saved.recoveryHold, undefined);
    await c.wait((m) => m.type === "launchSafetyRecovery" && !m.required && !m.held);
    assert.equal(fs.readFileSync(join(root, "config", copies(path)[0]), "utf8"), bytes);
  } finally { c?.close(); await server.stop(); }
  const again = await boot(root); let next: Awaited<ReturnType<typeof client>> | undefined;
  try {
    next = await client(again); const saved = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.deepEqual(saved.live, []); assert.deepEqual(saved.uncertain, facts.uncertain);
    assert.deepEqual(next.state.launchSafety.blocked.includes("old.coder"), true);
  } finally { next?.close(); await again.stop(); }
});
test("two actual starts deduplicate damaged tools and requests; different bytes get a second copy", async () => {
  const { root } = fixture(), tools = join(root, "config", "acp-clis.json"), requests = join(root, "requests.json");
  for (const path of [tools, requests]) fs.writeFileSync(path, "damage one");
  for (let i = 0; i < 2; i++) { const server = await boot(root); await server.stop(); }
  for (const path of [tools, requests]) { assert.equal(copies(path).length, 1); fs.writeFileSync(path, "damage two"); }
  const server = await boot(root); await server.stop();
  for (const path of [tools, requests]) {
    assert.equal(copies(path).length, 2); assert.equal(fs.readFileSync(path, "utf8"), "damage two");
  }
});
test("authenticated recovery reopens damaged-brake workspace with a durable hold and no invented ends", async () => {
  const { root, tabId } = fixture(), path = join(root, "config", "launch-safety.json"), bytes = "unreadable safety facts";
  fs.writeFileSync(path, bytes);
  for (const folder of ["tasks", "executions"]) { fs.mkdirSync(join(root, folder)); fs.writeFileSync(join(root, folder, "unresolved.json"), "unresolved original facts"); }
  const taskBytes = JSON.stringify(taskFixture(root, tabId, "interrupted"));
  const journalBytes = JSON.stringify({ version: 1, activeExecutionId: "build1", executions: [{ id: "build1", tabId, taskId: "task-one", planVersion: 1,
    role: "coder", selectedSlot: "coder", selectionReason: "Unresolved build", assignment: { cli: "codex", model: "gpt-6.1-sol", effort: "medium" },
    kind: "build", status: "interrupted", processEnded: false, consumed: false, logPath: null }] });
  fs.writeFileSync(join(root, "tasks", `${tabId}.json`), taskBytes); fs.writeFileSync(join(root, "executions", `${tabId}.json`), journalBytes);
  const server = await boot(root); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const unauthorized = new WebSocket(`ws://127.0.0.1:${server.port}/`, { origin: `http://127.0.0.1:${server.port}` });
    const refused = await new Promise<number>((done, reject) => {
      unauthorized.on("unexpected-response", (_req, res) => { res.resume(); unauthorized.terminate(); done(res.statusCode!); });
      unauthorized.on("error", () => {}); unauthorized.on("open", () => { unauthorized.close(); reject(new assert.AssertionError({ message: "unauthenticated recovery connection opened" })); });
    });
    assert.equal(refused, 403); assert.equal(fs.readFileSync(path, "utf8"), bytes);
    c = await client(server); assert.match(c.state.projects[0].tabs[0].fixedCrew.notice, /launch-safety.json/);
    const notice = await c.wait((m) => m.type === "launchSafetyRecovery"); assert.equal(notice.required, true); assert.equal(notice.message.includes(root), false);
    c.send({ type: "releaseLaunchSafetyHold", confirm: "allow launches with unreadable process history" });
    await c.wait((m) => m.type === "error" && /Recover the saved workspace/.test(m.message));
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
    c.send({ type: "recoverLaunchSafety" });
    const updated = await c.wait((m) => m.type === "state" && m.projects[0].tabs[0].id === tabId);
    assert.equal(updated.projects[0].tabs[0].fixedCrew.unavailable, undefined);
    await c.wait((m) => m.type === "launchSafetyRecovery" && m.held === true && m.required === false);
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).recoveryHold, true);
    assert.equal(fs.readFileSync(join(root, "config", copies(path)[0]), "utf8"), bytes);
    c.send({ type: "chat", tabId, text: "must not launch" }); await c.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message));
    c.send({ type: "clearLaunchBlock", seatKey: `${tabId}.coder`, confirm: "allow this seat to launch again" });
    await c.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message));
    assert.ok(updated.launchSafety.blocked.includes(`${tabId}.coder`));
    assert.equal(fs.readFileSync(join(root, "tasks", `${tabId}.json`), "utf8"), taskBytes);
    assert.equal(fs.readFileSync(join(root, "executions", `${tabId}.json`), "utf8"), journalBytes);
    assert.equal(updated.projects[0].tabs[0].fixedTask.stage, "interrupted");
    for (const folder of ["tasks", "executions"]) assert.equal(fs.readFileSync(join(root, folder, "unresolved.json"), "utf8"), "unresolved original facts");
  } finally { c?.close(); await server.stop(); }
  const again = await boot(root); let next: Awaited<ReturnType<typeof client>> | undefined;
  try {
    next = await client(again); const status = await next.wait((m) => m.type === "launchSafetyRecovery"); assert.equal(status.held, true);
    next.send({ type: "chat", tabId, text: "still held" }); await next.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message));
    const before = fs.readFileSync(path, "utf8");
    next.send({ type: "releaseLaunchSafetyHold", confirm: "wrong" });
    await next.wait((m) => m.type === "error" && /Confirm/.test(m.message));
    assert.equal(fs.readFileSync(path, "utf8"), before);
    const start = next.messages.length;
    next.send({ type: "releaseLaunchSafetyHold", confirm: "allow launches with unreadable process history" });
    await next.wait((m) => m.type === "launchSafetyRecovery" && !m.held && !m.required, start);
    const released = JSON.parse(fs.readFileSync(path, "utf8")), prior = JSON.parse(before);
    delete prior.recoveryHold; assert.deepEqual(released, prior);
    const afterRelease = next.messages.length;
    next.send({ type: "chat", tabId, text: "check released admission" });
    const reply = await next.wait((m) => m.type === "error" || m.type === "chatError", afterRelease);
    assert.doesNotMatch(reply.message, /Launch safety is held/);
    assert.equal(fs.readFileSync(join(root, "tasks", `${tabId}.json`), "utf8"), taskBytes);
    assert.equal(fs.readFileSync(join(root, "executions", `${tabId}.json`), "utf8"), journalBytes);
  } finally { next?.close(); await again.stop(); }
});
for (const failure of ["copyFileSync", "renameSync"] as const) test(`recovery ${failure} failure retains source and blocked memory`, async () => {
  const { root } = fixture(), path = join(root, "config", "launch-safety.json"), bytes = "damaged original"; fs.writeFileSync(path, bytes);
  const server = await boot(root, [{ file: "launch-safety.json", operation: failure, code: "EIO" }]); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); const before = c.state; const start = c.messages.length;
    c.send({ type: "recoverLaunchSafety" }); await c.wait((m) => m.type === "error" && /refused|could not be saved/.test(m.message), start);
    c.send({ type: "hello" }); const after = await c.wait((m) => m.type === "state", start);
    assert.deepEqual(after.launchSafety, before.launchSafety); assert.deepEqual(after.projects, before.projects);
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
  } finally { c?.close(); await server.stop(); }
});

test("a hold value that is not the plain hold still counts as a hold after recovery, and is written back plainly", async () => {
  const { root, tabId } = fixture(), path = join(root, "config", "launch-safety.json");
  const facts = { recoveryHold: "yes", blocked: ["old.coder"], live: [], uncertain: [], timestamps: [], notices: [], nextNoticeId: 1, released: [] };
  fs.writeFileSync(path, JSON.stringify(facts));
  const server = await boot(root); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server);
    const notice = await c.wait((m) => m.type === "launchSafetyRecovery"); assert.equal(notice.required, true);
    assert.doesNotMatch(notice.message, /launches will stay held/, "the notice does not promise a hold a readable copy would not keep");
    c.send({ type: "recoverLaunchSafety" });
    await c.wait((m) => m.type === "launchSafetyRecovery" && m.held === true && m.required === false);
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).recoveryHold, true);
    c.send({ type: "chat", tabId, text: "must not launch" }); await c.wait((m) => m.type === "error" && /Launch safety is held/.test(m.message));
  } finally { c?.close(); await server.stop(); }
});
test("hello answers with the state first, then the launch safety status", async () => {
  const { root } = fixture(); fs.writeFileSync(join(root, "config", "launch-safety.json"), "damaged safety");
  const server = await boot(root); let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(server); await c.wait((m) => m.type === "launchSafetyRecovery");
    const kinds = c.messages.map((m) => m.type);
    assert.ok(kinds.indexOf("state") >= 0 && kinds.indexOf("state") < kinds.indexOf("launchSafetyRecovery"), `state comes before the status: ${kinds.join(",")}`);
    assert.equal(kinds.indexOf("launchSafetyRecovery"), kinds.lastIndexOf("launchSafetyRecovery"), "one status per hello");
  } finally { c?.close(); await server.stop(); }
});
test("real task page offers recovery, sends the authenticated action, and displays the remaining hold", { timeout: 90_000 }, async () => {
  const { root } = fixture(), path = join(root, "config", "launch-safety.json"); fs.writeFileSync(path, "damaged safety");
  const server = await boot(root), profile = join(root, "browser"); fs.mkdirSync(profile);
  const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--no-sandbox", "--disable-gpu", "--disable-gpu-sandbox", "--no-proxy-server", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let socket: WebSocket | undefined, watcher: Awaited<ReturnType<typeof client>> | undefined;
  try {
    const portPath = join(profile, "DevToolsActivePort"), deadline = Date.now() + 15_000;
    while (!fs.existsSync(portPath) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 30));
    assert.ok(fs.existsSync(portPath), "Chrome opened its isolated debugging port");
    const port = Number(fs.readFileSync(portPath, "utf8").split("\n")[0]);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()) as any[];
    const target = targets.find((item) => item.type === "page"); assert.ok(target, "Chrome exposes the test page");
    socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0; const pending = new Map<number, (value: any) => void>();
    socket.on("message", (raw) => { const value = JSON.parse(String(raw)); if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); } });
    async function command(method: string, params = {}, sessionId?: string): Promise<any> {
      const id = ++sequence;
      const response = new Promise<any>((done, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10_000);
        pending.set(id, (value) => { clearTimeout(timer); done(value); });
      });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      const result = await response; assert.equal(result.error, undefined); return result.result;
    }
    const page = (method: string, params = {}) => command(method, params);
    async function evaluate(expression: string) {
      const value = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(value.exceptionDetails, undefined); return value.result.value;
    }
    async function shown(expression: string) {
      const end = Date.now() + 15_000;
      while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise((done) => setTimeout(done, 30)); }
      assert.fail(`Page did not show ${expression}`);
    }
    await page("Page.enable"); await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.cc={appKey:async()=>${JSON.stringify(server.key)}};` });
    await page("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await shown('Boolean(document.querySelector("[data-fct-recover-safety]"))');
    assert.equal(await evaluate('document.querySelector("[data-fct-recover-safety]").textContent'), "Recover saved workspace");
    assert.match(await evaluate('document.querySelector("#fixedView").innerText'), /launch-safety.json/);
    await evaluate('document.querySelector("[data-fct-recover-safety]").click()');
    await shown('document.querySelector("#fixedView").innerText.includes("No earlier process has been confirmed ended")');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-fct-recover-safety]"))'), false);
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).recoveryHold, true);
    await shown('Boolean(document.querySelector("[data-fct-release-safety]"))');
    await evaluate('window.confirm=()=>false; document.querySelector("[data-fct-release-safety]").click()');
    // Wait for a positive signal, not just one look: ask the server (a second connection) for the status several times after the declined click.
    // If the confirmation were gone, the release would be sent and the status would show the hold gone (and the file would change).
    watcher = await client(server);
    for (let attempt = 0; attempt < 6; attempt++) {
      const from = watcher.messages.length; watcher.send({ type: "hello" });
      assert.equal((await watcher.wait((m) => m.type === "launchSafetyRecovery", from)).held, true, "a declined confirmation leaves the hold in place");
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).recoveryHold, true);
    await evaluate('window.confirm=()=>true; document.querySelector("[data-fct-release-safety]").click()');
    await shown('!document.querySelector("[data-fct-release-safety]")');
    assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).recoveryHold, undefined);
  } finally {
    watcher?.close(); socket?.close(); const stopped = await stopChromeTree(chrome);
    assert.ok(chrome.exitCode !== null || chrome.signalCode !== null, stopped.facts.join("; "));
    await server.stop();
  }
});
