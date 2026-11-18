import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { shellHarness, within } from "./electron-helpers.ts";
import { loadFixed, connect, waitFor } from "./round2-helpers.ts";
import { scratchDir } from "./temp-root.ts";

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fire(h: any, ms: number) {
  const timer = [...h.timers.values()].find((t: any) => t.ms === ms) as any;
  assert.ok(timer, `timer ${ms} found`); timer.fn();
}
async function running() {
  const h = shellHarness(); const pending = h.ready(); await tick();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(pending, "ready"); return h;
}

test("P7 environment helper installs no process handlers", () => {
  const events: string[] = [], env = { ELECTRON_RUN_AS_NODE: "1", keep: "yes" };
  runInNewContext(stripTypeScriptTypes(readFileSync("server/runtime-env.ts", "utf8")).replaceAll("export ", ""), {
    process: { env, on: (event: string) => events.push(event) },
  });
  assert.deepEqual(events, []);
  assert.deepEqual(env, { keep: "yes" });
});

for (const order of ["exit-first", "killer-first"]) test(`P7 taskkill confirms child exit in either delivery order: ${order}`, async () => {
  const h = await running(); let result: unknown;
  const stopping = h.stopServer().then((value: boolean) => { result = value; });
  fire(h, 125_000);
  if (order === "killer-first") {
    h.killer.emit("close", 0); await tick();
    assert.equal(result, undefined, "killer close alone does not establish child exit");
    assert.ok(h.proc.listenerCount("exit") > 0);
  }
  h.proc.exitCode = 0; h.proc.emit("exit", 0);
  if (order === "exit-first") h.killer.emit("close", 0);
  await within(stopping, "stop"); assert.equal(result, true);
  assert.equal(h.timers.size, 0, "exit cancels both bounds");
});

test("P7 killed exit status confirms termination even without exit event delivery", async () => {
  const h = await running(); const stopping = h.stopServer();
  fire(h, 125_000); h.killer.emit("close", 0);
  h.proc.signalCode = "SIGTERM"; fire(h, 2_000);
  assert.equal(await within(stopping, "stop"), true);
});

test("P7 unconfirmed stop is retried and quit retries once before exiting", async () => {
  const h = await running();
  const first = h.stopServer(); fire(h, 125_000); h.killer.emit("error", new Error("denied")); fire(h, 2_000);
  assert.equal(await within(first, "first stop"), false);
  h.loaded.push("data:failed"); // quit from an error page requires no busy-page answer
  h.app.emit("before-quit", { preventDefault() {} }); await tick();
  assert.equal(h.sent.length, 2, "quit retries the previously unconfirmed stop");
  fire(h, 125_000); h.killer.emit("close", 1); fire(h, 2_000); await tick();
  assert.equal(h.sent.length, 3, "quit makes one further attempt on false");
  assert.equal(h.quits(), 0, "quit waits for its retry");
  h.proc.exitCode = 0; h.proc.emit("exit", 0); await tick();
  assert.equal(h.quits(), 1);
});

test("P7 second launch focuses failed startup but relaunches during actual shutdown", async () => {
  const h = shellHarness(); const pending = h.ready(); await tick();
  fire(h, 60_000); h.proc.exitCode = 0; h.proc.emit("exit", 0);
  await within(pending, "failure page");
  h.setMinimized(true); h.app.emit("second-instance");
  assert.deepEqual(h.order.slice(-2), ["restore", "focus"]);
  h.app.emit("before-quit", { preventDefault() {} }); await tick();
  assert.equal(h.relaunches.length, 0, "focusing did not queue a relaunch");
  const closing = await running(); closing.stopServer(); closing.app.emit("second-instance");
  closing.loaded.push("data:closing"); closing.app.emit("before-quit", { preventDefault() {} });
  closing.proc.exitCode = 0; closing.proc.emit("exit", 0); await tick();
  assert.equal(closing.relaunches.length, 1, "an actual shutdown queues a relaunch");
});

test("P7 a session stopping after readiness has an accurate plain heading", async () => {
  const h = await running(); h.proc.emit("exit", 2);
  assert.match(decodeURIComponent(h.loaded.at(-1)), /<h2>Command Center stopped\.<\/h2><p>Close Command Center and open it again\.<\/p>/);
  assert.doesNotMatch(decodeURIComponent(h.loaded.at(-1)), /could not start/);
});

test("P7 a folder refresh failure after persistence keeps new folder and stops old session", async () => {
  const server = await loadFixed({ testRoot: scratchDir(), skipHealth: true });
  const folder = join(server.testRoot, "new-project"); mkdirSync(folder);
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create idle session" });
  await waitFor(() => server.leaders.has("alpha-dev") && server.activeLeaderTurns.size === 0, "idle leader");
  const oldLeader = server.leaders.get("alpha-dev");
  assert.ok(oldLeader);
  server.settingsService.refreshProjectInstructions = () => { throw new Error("refresh failed"); };
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder });
  assert.equal(server.getWorkspaces().projects[0].tabs[0].folder, folder);
  assert.equal(server.tabs.get("alpha-dev").state.folderPath, folder);
  assert.equal(server.leaders.has("alpha-dev"), false);
  assert.match(ws.messages.at(-1).message, /new folder was saved.*previous session stopped/);
  assert.doesNotMatch(ws.messages.at(-1).message, /previous folder.*kept/);
});

// The latch alone, with a counting handler: the handler's own once-guard (index.ts) must not be what hides a double dispatch.
function latchHarness() {
  const proc: any = new EventEmitter(); proc.connected = true; proc.send = () => {};
  const source = stripTypeScriptTypes(readFileSync("server/shutdown-latch.ts", "utf8")).replaceAll("export ", "");
  const api: any = runInNewContext(`${source}\n({ bindShutdown, shutdownRequested });`, { process: proc });
  return { proc, ...api };
}
test("P7 shutdown latch dispatches the handler once however many requests arrive, before or after binding", () => {
  const before = latchHarness(), seenBefore: string[] = [];
  before.proc.emit("SIGINT"); before.proc.emit("SIGTERM"); before.proc.emit("message", "shutdown");
  assert.equal(before.shutdownRequested(), true);
  before.bindShutdown((signal: string) => seenBefore.push(signal));
  before.proc.emit("SIGTERM"); before.bindShutdown((signal: string) => seenBefore.push(signal));
  assert.deepEqual(seenBefore, ["SIGINT"], "the first request is replayed once and never repeated");
  const after = latchHarness(), seenAfter: string[] = [];
  after.bindShutdown((signal: string) => seenAfter.push(signal));
  assert.equal(after.shutdownRequested(), false);
  after.proc.emit("SIGTERM"); after.proc.emit("SIGINT"); after.proc.emit("disconnect");
  assert.deepEqual(seenAfter, ["SIGTERM"]);
});
