import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { api, setup } from "./pack29-first-run.setup.ts";
import { chatRequestErrorDetails } from "../server/chat-store.ts";

// The Run handler must stay synchronous: the dispatcher only catches synchronous throws, so an async handler
// turns every refusal into an unhandled rejection ("internal error" for every page, no rollback of the Run).
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function watchRejections() {
  const seen: unknown[] = [], listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  return { seen, stop: () => process.off("unhandledRejection", listener) };
}

test("the real dispatcher answers a refused Run with a request-scoped error, never an internal error or unhandled rejection", async () => {
  const ctx = setup(), watch = watchRejections();
  try {
    const tab = api.state.workspaces.projects[0].tabs[0]; delete (tab as any).fixedCrew; // not a fixed tab: launchWorker refuses
    const start = ctx.replies.length;
    api.messages.handleMessage(api.state.clients.values().next().value as any, JSON.stringify({ type: "run", tabId: tab.id, slot: "coder", prompt: "work", requestId: "p32_onrun_1" }));
    await sleep(50);
    const frames = ctx.replies.slice(start);
    const error = frames.find((frame) => frame.type === "error");
    assert.ok(error, `no error frame arrived: ${JSON.stringify(frames)}`);
    assert.deepEqual({ action: error.action, tabId: error.tabId, requestId: error.requestId }, { action: "run", tabId: tab.id, requestId: "p32_onrun_1" });
    assert.equal(frames.some((frame) => /internal error/.test(String(frame.message))), false);
    assert.deepEqual(watch.seen, [], "no unhandled rejection");
  } finally { watch.stop(); }
});

// The key path needs a non-fixed tab whose slot names a catalog tool, which real tab data cannot produce, so the real handler source runs with fakes
// only at its boundaries and behind a dispatcher with the same synchronous try/catch as handleMessage.
function runHandler(options: { prepare: () => Promise<void>; launch: () => any }) {
  const source = readFileSync("server/main/messages/setups-runs.ts", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const connection = { program: "synthetic" }, replies: any[] = [];
  const context = runInNewContext(stripTypeScriptTypes(source) + "\n({setupMessages})", {
    tabLocation: () => ({ tab: {} }), isFixedTab: () => false, crewDefinition: () => ({ cli: "acp:synthetic" }),
    refuseIfFolderBusy: () => false, acpClis: [connection], acpKindOf: () => "acp:synthetic",
    settingsService: { cliKeys: { prepareConnection: options.prepare } }, launchWorker: options.launch,
    describeError: (err: Error) => err.message, chatRequestErrorDetails,
    sendError: (_ws: any, message: string, details: any) => replies.push({ type: "error", message, ...details }),
  });
  const handler = context.setupMessages().find(([name]: any) => name === "run")[1];
  const ws = { send: (raw: string) => replies.push(JSON.parse(raw)) };
  const message = { type: "run", tabId: "t1", slot: "coder", prompt: "work", requestId: "p32_onrun_2" };
  const dispatch = () => { try { handler(ws, message); } catch (err: any) { context.sendError(ws, err.message, chatRequestErrorDetails(message)); } };
  return { replies, dispatch };
}

test("a Run whose saved key is still being read and then refuses gets the request-scoped error after the delay", async () => {
  const watch = watchRejections();
  try {
    const run = runHandler({ prepare: async () => { await sleep(30); }, launch: () => ({ ok: false, error: "launch refused" }) });
    run.dispatch();
    assert.deepEqual(run.replies, [], "nothing answers before the key read ends");
    await sleep(100);
    assert.deepEqual(run.replies, [{ type: "error", message: "launch refused", action: "run", tabId: "t1", requestId: "p32_onrun_2" }]);
    const failing = runHandler({ prepare: async () => { await sleep(10); throw new Error("read failed"); }, launch: () => assert.fail("must not launch") });
    failing.dispatch(); await sleep(100);
    assert.deepEqual(failing.replies.map((reply) => reply.message), ["read failed"]);
    assert.deepEqual(watch.seen, [], "no unhandled rejection");
  } finally { watch.stop(); }
});

test("a Run with a key launches after the key read and answers runAccepted", async () => {
  const order: string[] = [];
  const run = runHandler({ prepare: async () => { await sleep(20); order.push("prepared"); }, launch: () => { order.push("launched"); return { ok: true, runId: "r1" }; } });
  run.dispatch(); await sleep(100);
  assert.deepEqual(order, ["prepared", "launched"]);
  assert.deepEqual(run.replies, [{ type: "runAccepted", tabId: "t1", runId: "r1" }]);
});
