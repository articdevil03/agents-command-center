import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { shellHarness, within, plain } from "./electron-helpers.ts";
import { pack28ClosingNoticeMutations } from "../scripts/mutations/pack28-closing-notice.mjs";
import { PACK28_PROOFS } from "./tooling-sweep-proof-pack28.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const noticeTimers = (h) => [...h.timers.values()].filter(({ ms }) => ms === 1500);
const allowedQuits = (h) => h.quitEvents.filter((event) => event === "allowed").length;
async function ready(options = {}) {
  const h = shellHarness({}, { noticeTesting: true, lifecycle: true, ...options });
  const started = h.ready();
  await Promise.resolve();
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "P28 ready");
  return h;
}
function approve(h) {
  h.app.quit();
  assert.deepEqual(h.sent, [], "File > Quit waits for the working page's approval");
  h.ipcHandlers.get("cc:close-answer")({ sender: h.win.webContents }, "close");
  assert.equal(h.win.isDestroyed(), true);
  assert.deepEqual(h.sent, ["shutdown"]);
}
function fire(h) {
  const entries = [...h.timers].filter(([, { ms }]) => ms === 1500);
  assert.equal(entries.length, 1, "one 1500 ms notice timer");
  const [id, timer] = entries[0];
  h.timers.delete(id);
  assert.doesNotThrow(() => timer.fn());
  return timer;
}
async function exit(h) {
  assert.doesNotThrow(() => { h.proc.exitCode = 0; h.proc.emit("exit", 0); });
  await flush();
  assert.equal(allowedQuits(h), 1, "exactly one final app.quit is allowed");
}

test("P28 slow close shows one passive notice", async () => {
  const h = await ready();
  approve(h);
  assert.equal(h.notices.length, 0, "no immediate window");
  assert.equal(noticeTimers(h).length, 1);
  assert.equal(noticeTimers(h)[0].unrefed, true);
  assert.equal(allowedQuits(h), 0);
  fire(h); await flush();
  assert.equal(h.notices.length, 1);
  const notice = h.notices[0];
  assert.equal(notice.options.width, 440); assert.equal(notice.options.height, 150);
  assert.equal(notice.options.frame, true); assert.equal(notice.options.show, false);
  assert.equal(notice.options.alwaysOnTop, true);
  const html = decodeURIComponent(notice.url.slice("data:text/html,".length));
  assert.ok(html.includes("<title>Command Center</title>"));
  assert.ok(html.includes("Closing Command Center..."));
  assert.ok(html.includes("Finishing work in progress. This can take around 2 minutes."));
  assert.match(html, /system-ui/); assert.match(html, /prefers-color-scheme:dark/);
  assert.doesNotMatch(html, /<script|<img|animation/i);
  assert.deepEqual(notice.calls, ["showInactive"]);
  assert.equal(h.order.includes("focus"), false);
  await exit(h);
  assert.equal(notice.isDestroyed(), true);
});

test("P28 quick close never flashes", async () => {
  const h = await ready(); approve(h);
  assert.equal(noticeTimers(h).length, 1);
  await exit(h);
  assert.equal(noticeTimers(h).length, 0, "settlement clears the notice timer");
  assert.equal(h.notices.length, 0);
  for (const alreadyExited of [false, true]) {
    const quick = shellHarness({}, { noticeTesting: true, lifecycle: true });
    if (alreadyExited) {
      const started = quick.startServer(); await Promise.resolve();
      quick.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
      await within(started, "already-exited startup"); quick.proc.exitCode = 0;
    }
    quick.app.quit(); await flush();
    assert.equal(allowedQuits(quick), 1);
    assert.equal(noticeTimers(quick).length, 0, `no timer, alreadyExited=${alreadyExited}`);
    assert.equal(quick.notices.length, 0);
  }
});

test("P28 settled close ignores late callbacks", async () => {
  const h = await ready(); approve(h);
  const timer = noticeTimers(h)[0];
  await exit(h);
  assert.doesNotThrow(() => timer.fn()); await flush();
  assert.equal(h.notices.length, 0, "retained timer cannot create after settlement");
  const loading = await ready({ pendingNoticeLoad: true }); approve(loading); fire(loading);
  const notice = loading.notices[0];
  await exit(loading);
  assert.equal(notice.isDestroyed(), true);
  // Model a failed disposal too: the pending flag independently guards late load completion.
  notice.isDestroyed = () => false;
  notice.resolveLoad(); await flush();
  assert.equal(notice.calls.includes("showInactive"), false, "late load never shows after stop");
});

test("P28 tests and smoke stay silent", async () => {
  for (const options of [{ noticeTesting: false }, { smokeReadyFile: "ready.json", smokeStopFile: "stop" }, { smokeStopFile: "stop" }]) {
    const h = await ready(options);
    if (options.noticeTesting === false) assert.ok(h.env.NODE_TEST_CONTEXT);
    else assert.equal(h.env.NODE_TEST_CONTEXT, undefined, "smoke is tested without test context");
    h.app.quit();
    if (h.toPage.some(([channel]) => channel === "cc:close-requested")) h.ipcHandlers.get("cc:close-answer")({ sender: h.win.webContents }, "close");
    assert.equal(noticeTimers(h).length, 0, JSON.stringify(options));
    await exit(h); assert.equal(h.notices.length, 0);
  }
  const enabled = await ready(); approve(enabled); fire(enabled); await flush();
  assert.equal(enabled.notices.length, 1, "explicit harness opt-in exercises the real path");
  await exit(enabled);
});

test("P28 notice failures never hold quit", async () => {
  for (const noticeFault of ["constructor", "load-sync", "load-reject", "show", "destroy", "hide"]) {
    const h = await ready({ noticeFault }); approve(h);
    fire(h); await flush();
    assert.equal(h.noticeAttempts(), 1, noticeFault);
    assert.equal(allowedQuits(h), 0, "notice failures cannot bypass the server gate");
    if (["load-sync", "load-reject", "show"].includes(noticeFault)) {
      assert.equal(h.notices[0].isDestroyed(), true, `${noticeFault}: cleanup before server exit`);
      assert.ok(h.notices[0].calls.includes("destroy"));
    }
    await exit(h);
    if (["destroy", "hide"].includes(noticeFault)) assert.ok(h.notices[0].calls.includes("hide"), `${noticeFault}: fallback attempted`);
  }
});

test("P28 pending notice load never holds quit", async () => {
  const h = await ready({ pendingNoticeLoad: true }); approve(h); fire(h);
  await flush();
  assert.equal(allowedQuits(h), 0, "quit remains prevented before server exit");
  assert.equal(h.notices[0].calls.length, 0, "load remains unresolved");
  await exit(h);
  assert.equal(h.notices[0].isDestroyed(), true, "unresolved load does not delay disposal");
  assert.ok(h.notices[0].calls.includes("destroy"));
});

test("P28 repeated quit and notice dismissal stay idempotent", async () => {
  for (const dismiss of [false, true]) {
    const h = await ready(); approve(h);
    const exitListeners = h.proc.listenerCount("exit");
    h.app.quit(); h.app.quit();
    assert.equal(noticeTimers(h).length, 1, "one timer across repeated app.quit");
    fire(h); await flush();
    assert.equal(h.notices.length, 1);
    if (dismiss) assert.doesNotThrow(() => h.notices[0].close());
    h.app.quit();
    assert.equal(noticeTimers(h).length, 0, "dismissal and repeated quit never replace notice");
    assert.equal(h.proc.listenerCount("exit"), exitListeners, "no added stop listener");
    assert.equal(allowedQuits(h), 0);
    await exit(h);
    assert.equal(h.notices[0].isDestroyed(), true);
    if (!dismiss) assert.deepEqual(h.notices[0].calls, ["showInactive", "destroy"], "settlement disposes before final quit; all-closed reenters safely");
    assert.deepEqual(h.sent, ["shutdown"]);
    assert.equal(h.notices.length, 1);
  }
});

test("P28 second launch queues exactly one portable relaunch", async () => {
  const h = await ready();
  h.setMinimized(true); h.app.emit("second-instance");
  assert.deepEqual(h.order.slice(-2), ["restore", "focus"], "normal window focus retained");
  assert.equal(h.relaunches.length, 0);
  approve(h); fire(h); await flush();
  h.env.PORTABLE_EXECUTABLE_FILE = "C:/Portable/Command Center.exe";
  const order = [...h.order], calls = [...h.notices[0].calls];
  assert.doesNotThrow(() => {
    h.app.emit("second-instance"); h.app.emit("second-instance");
  }, "second launch during shutdown never reaches the window lookup");
  assert.deepEqual(h.order, order); assert.deepEqual(h.notices[0].calls, calls, "notice never focused");
  assert.equal(h.spawns.length, 1); assert.equal(h.relaunches.length, 0);
  await exit(h);
  assert.deepEqual(plain(h.relaunches), [{ execPath: "C:/Portable/Command Center.exe" }]);
});

test("P28 sign-out stays silent", async () => {
  const h = await ready();
  h.win.emit("session-end"); h.win.close();
  assert.deepEqual(h.sent, ["shutdown"]);
  assert.equal(noticeTimers(h).length, 0);
  await exit(h); assert.equal(h.notices.length, 0);
});

test("P28 notice has no app privileges", async () => {
  const h = await ready();
  // Keep the main window alive to prove sender identity, rather than destroyed-window rejection.
  h.win.webContents.getURL = () => "data:text/html,loading";
  h.app.quit(); fire(h); await flush();
  const notice = h.notices[0];
  assert.equal(h.win.isDestroyed(), false);
  assert.deepEqual(notice.options.webPreferences, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal("preload" in notice.options.webPreferences, false);
  const before = [...h.order];
  assert.equal(h.ipcHandlers.size, 8, "all privileged channels checked");
  for (const handler of h.ipcHandlers.values()) assert.equal(await handler({ sender: notice.webContents, senderFrame: { url: "http://127.0.0.1:51234" } }, "obsidian://open?path=x"), undefined);
  assert.deepEqual(h.order, before); assert.deepEqual(h.external, []); assert.deepEqual(h.dialogCalls, []);
  await exit(h);
});

test("P28 proof rows select exactly one top-level test", () => {
  const rows = pack28ClosingNoticeMutations.map(([id]) => id);
  assert.equal(rows.length, 22); assert.equal(new Set(rows).size, rows.length);
  assert.deepEqual(Object.keys(PACK28_PROOFS).sort(), [...rows].sort());
  const selectionProblems = (mapping) => Object.entries(mapping).flatMap(([id, [file, pattern]]) => {
    if (!existsSync(file)) return [`${id}: missing ${file}, matched=[]`];
    const titles = [...readFileSync(file, "utf8").matchAll(/^test\("([^"\n]+)"\s*,/gm)].map((match) => match[1]);
    const matched = titles.filter((title) => new RegExp(pattern).test(title));
    return file === "test/electron-closing-notice.test.ts" && pattern.startsWith("^") && pattern.endsWith("$") && pattern.length > 2 && matched.length === 1 && pattern === `^${matched[0]}$` ? [] : [`${id}: pattern=${pattern}, matched=${JSON.stringify(matched)}`];
  });
  assert.deepEqual(selectionProblems(PACK28_PROOFS), []);
  for (const pattern of ["", "^$", "^P28 ", "^missing$"]) {
    assert.throws(() => assert.deepEqual(selectionProblems({ planted: ["test/electron-closing-notice.test.ts", pattern] }), []), /matched=/);
  }
  assert.throws(() => assert.deepEqual(selectionProblems({ planted: ["test/absent-p28.test.ts", "^missing$"] }), []), /matched=\[\]/);
});
