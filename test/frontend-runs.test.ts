import test from "node:test";
import assert from "node:assert/strict";
import { appSource, pageHarness, plain } from "./frontend-helpers.ts";

test("final review 5: dismissed failure cards stay dismissed with 201 retained failures across five tabs (41+41+41+41+37), and the page and server caps both hold every retained run", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const counts = [41, 41, 41, 41, 37];
  const tabs = counts.map((count, t) => h.tab({ id: `t${t + 1}`, runs: Array.from({ length: count }, (_, i) => h.run(`r${t}-${i}`, { status: "failed" })) }));
  const ids = tabs.flatMap((tab: any) => tab.runs.map((run: any) => run.runId));
  assert.equal(ids.length, 201);
  const message: any = h.state({}, { clientPrefs: { dismissedRuns: ids } });
  message.projects[0].tabs = tabs;
  h.api.onMessage(message);
  socket.sent.length = 0;
  h.api.saveDismissed();
  const sent = socket.sent.filter((item: any) => item.type === "updateClientPref" && item.key === "dismissedRuns");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].value, ids, "every retained dismissal is kept, the oldest included");
  assert.match(appSource, /const DISMISSED_RUNS_MAX = (\d+);/);
  assert.ok(Number(/const DISMISSED_RUNS_MAX = (\d+);/.exec(appSource)![1]) >= 50 * 40, "the page cap holds 50 runs for 40 tabs");
});

test("final review 6: clicking the same saved run again within 15 s is not cancelled by the first click's timeout", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers: Array<() => void> = [];
  const button: any = { dataset: { historyTimestamp: "5" }, addEventListener: (_name: string, fn: () => void) => handlers.push(fn), removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const view: any = { querySelector: () => null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  assert.equal(handlers.length, 1);
  const before = h.timers.length;
  handlers[0](); handlers[0]();
  const waits = h.timers.slice(before).filter((timer) => timer.ms === 15_000);
  assert.equal(waits.length, 2, "each click arms its own timeout");
  waits[0].fn();
  assert.equal(h.api.snap().historyRunRequested.get(key), 5, "the older click's timeout leaves the newer request standing");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 5, outcome: "done", output: "log", totalBytes: 3 });
  assert.equal(h.api.snap().historyDetails.has(key + ":5"), true, "and its reply still shows");
  waits[1].fn();
  assert.equal(h.api.snap().historyDetails.has(key + ":5"), true);
});

test("final review 7: a stale Check again error or an untagged settingsRefreshed does not settle a newer refresh; only its own requestId does", () => {
  const h = pageHarness();
  h.api.onMessage(h.state());
  h.api.setRefresh({ status: "running", at: 0, requestId: "new" });
  h.api.onMessage({ type: "error", action: "refreshSettings", requestId: "old", message: "stale" });
  assert.equal(h.api.snap().refreshState.status, "running", "an error for an older request leaves the newer refresh running");
  h.api.onMessage({ type: "settingsRefreshed" });
  assert.equal(h.api.snap().refreshState.status, "running", "an untagged settingsRefreshed does not end a refresh that carries a requestId");
  h.api.onMessage({ type: "actionResult", action: "refreshSettings", requestId: "new" });
  assert.equal(h.api.snap().refreshState.status, "done", "the matching reply ends it");
  h.api.setRefresh({ status: "running", at: 0, requestId: "next" });
  h.api.onMessage({ type: "error", action: "refreshSettings", requestId: "next", message: "failed" });
  assert.equal(h.api.snap().refreshState.status, "failed");
});

test("final review 8: the Claude model picker says a change made during an answer waits for the answer to end", () => {
  const h = pageHarness();
  const claude = h.api.pickerHints({ isLeader: true, cli: "claude" });
  assert.match(claude, /A model change applies right away, or after the current answer if one is running\./);
  assert.match(h.api.pickerHints({ isLeader: true, cli: "codex" }), /A model change applies from the next turn./);
});

function historyBinding(h: any, key: string) {
  const handlers: Record<string, () => void> = {};
  const button: any = { dataset: { historyTimestamp: "5" }, addEventListener: (_n: string, fn: () => void) => { handlers.run = fn; }, removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const full: any = { dataset: { fullTimestamp: "7" }, addEventListener: (_n: string, fn: (event: any) => void) => { handlers.full = () => fn({ currentTarget: full }); } };
  const view: any = { querySelector: (selector: string) => selector === "[data-full-log]" ? full : null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  return handlers;
}

test("scoped round 1: a saved-run click whose send fails leaves the earlier request and its timer as they were, and a timeout clears an unanswered request", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const key = "t1.coder", handlers = historyBinding(h, key);
  const before = h.timers.length;
  handlers.run();
  const wait = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(wait.length, 1);
  assert.equal(h.api.snap().historyRunTokens.has(key), true, "the request records its token");
  socket.readyState = 3; handlers.run(); socket.readyState = 1;
  assert.equal(h.timers.slice(before).filter((timer: any) => timer.ms === 15_000).length, 1, "the failed click armed no timer");
  wait[0].fn();
  assert.equal(h.api.snap().historyRunRequested.has(key), false, "the first request's timer still clears the unanswered request");
});

test("scoped round 1: a fuller-log request has its own token (an older timer cannot clear a newer one) and a failed send changes nothing", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const key = "t1.coder", handlers = historyBinding(h, key), detailKey = `${key}:7`;
  socket.readyState = 3; handlers.full(); socket.readyState = 1;
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "a failed send leaves no pending fuller log");
  assert.equal(h.api.snap().historyRunRequested.has(key), false, "and no pending saved run");
  const before = h.timers.length;
  handlers.full();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true });
  handlers.full();
  const waits = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(waits.length, 2);
  waits[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true, "the older request's timer leaves the newer one pending");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: true });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, true, "the newer reply is shown as the fuller log");
});

function historyBinding7(h: any, key: string) {
  const handlers: Record<string, () => void> = {};
  const button: any = { dataset: { historyTimestamp: "7" }, addEventListener: (_n: string, fn: () => void) => { handlers.run = fn; }, removeAttribute() {}, setAttribute() {}, querySelector: () => null };
  const full: any = { dataset: { fullTimestamp: "7" }, addEventListener: (_n: string, fn: (event: any) => void) => { handlers.full = () => fn({ currentTarget: full }); } };
  const back: any = { addEventListener: (_n: string, fn: () => void) => { handlers.back = fn; } };
  const view: any = { querySelector: (selector: string) => selector === "[data-full-log]" ? full : selector === "[data-back-history]" ? back : null, querySelectorAll: (selector: string) => selector === "[data-history-timestamp]" ? [button] : [] };
  h.api.bindHistoryView(view, h.tab(), h.tab().crew[1], key);
  return handlers;
}

test("scoped round 2: a fuller-log reply that arrives after its timer fired is still shown as the fuller log (the label comes from the reply)", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  const before = h.timers.length;
  handlers.full();
  h.timers.slice(before).filter((timer: any) => timer.ms === 15_000)[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "the timer cleared the pending marker");
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: true });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, true, "the late fuller reply is labelled as the fuller log");
});

test("scoped round 2: Back clears the fuller-log marker, so reopening the run shows its short reply as short", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  handlers.run();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: false });
  handlers.full();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true);
  handlers.back();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "Back clears the run's fuller-log marker");
  handlers.run();
  h.api.onMessage({ type: "historyRun", seatKey: key, timestamp: 7, outcome: "done", output: "log", totalBytes: 3, truncated: true, full: false });
  assert.equal(h.api.snap().historyDetails.get(detailKey).full, false, "the reopened run's short reply is labelled short");
});

test("scoped round 2: a fuller-log request's own timer clears it when no reply comes", async () => {
  const h = pageHarness();
  await h.open();
  const key = "t1.coder", handlers = historyBinding7(h, key), detailKey = `${key}:7`;
  const before = h.timers.length;
  handlers.full();
  const waits = h.timers.slice(before).filter((timer: any) => timer.ms === 15_000);
  assert.equal(waits.length, 1);
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), true);
  waits[0].fn();
  assert.equal(h.api.snap().historyFullRequested.has(detailKey), false, "its own timer cleared the unanswered request");
});

// ---- fix pack 3, block 2: page behaviour that had no test ----

test("Stop all: the toasts say what was asked, what the server accepted, and how the runs ended (all exited, some not confirmed, or none were working)", async () => {
  const live = (...ids: string[]) => ids.map((id) => ({ ...(pageHarness().run(id)) }));
  const toast = (h: ReturnType<typeof pageHarness>) => h.node("toast").textContent as string;
  const activityTexts = (h: ReturnType<typeof pageHarness>) => plain(h.api.snap().activity.map((item: any) => item.text));
  // Every run exits.
  const h = pageHarness();
  h.api.onMessage(h.state({ derived: { stepBar: [], busy: true }, runs: live("r1", "r2") }));
  const socket = await h.open();
  h.api.stopAll();
  assert.equal(socket.sent.filter((message: any) => message.type === "stopAll").length, 1);
  assert.equal(toast(h), "Asking the server to stop everything in every tab…");
  h.api.onMessage({ type: "stopAllAccepted" });
  assert.equal(toast(h), "Stop accepted; waiting for exits: 2 runs in 1 tab");
  h.api.onMessage(h.state({ runs: [{ ...h.run("r1"), status: "stopped" }, h.run("r2")] }));
  assert.equal(toast(h), "Stop accepted; waiting for exits: 2 runs in 1 tab", "one run still working: no final report yet");
  h.api.onMessage(h.state({ runs: [{ ...h.run("r1"), status: "stopped" }, { ...h.run("r2"), status: "stopped" }] }));
  assert.equal(toast(h), "Stop sent: all 2 runs exited. Leaders were told to stop");
  assert.deepEqual(activityTexts(h).slice(0, 2), ["Stop all: every run exited", "Stop all accepted: waiting for runs to exit"]);
  assert.equal(h.api.snap().stopAllTrack, null, "reported once");
  // One run never confirms its exit: the report says so and where to go.
  const u = pageHarness();
  u.api.onMessage(u.state({ derived: { stepBar: [], busy: true }, runs: live("r1", "r2") }));
  await u.open();
  u.api.stopAll(); u.api.onMessage({ type: "stopAllAccepted" });
  u.api.onMessage(u.state({ runs: [{ ...u.run("r1"), status: "stopped" }, u.run("r2")] }, { launchSafety: { notices: [], uncertain: [{ seatKey: "t1.coder", runId: "r2", pid: 99 }] } }));
  assert.equal(toast(u), "Stop all: 1 run exited, 1 not confirmed and may still be running. Needs you has Try again and Release");
  assert.equal(activityTexts(u)[0], "Stop all: 1 run exited, 1 not confirmed");
  // Nothing was working: accepted at once and said so.
  const n = pageHarness();
  n.api.onMessage(n.state({ derived: { stepBar: [], busy: true }, runs: [] }));
  await n.open();
  n.api.stopAll(); n.api.onMessage({ type: "stopAllAccepted" });
  assert.equal(toast(n), "Stop sent to 1 tab. No runs were working");
  assert.equal(n.api.snap().stopAllTrack, null);
});

test("Match my PC: the page follows the PC's light or dark setting, saves the choice as theme system, and takes it from the server on a fresh page", async () => {
  const h = pageHarness();
  const socket = await h.open();
  h.media.light = true;
  h.api.setTheme("system");
  assert.deepEqual(socket.sent.filter((message: any) => message.type === "updateClientPref" && message.key === "theme").map((message: any) => message.value), ["system"], "the choice is saved as 'system', not as light or dark");
  assert.equal(h.bodyClasses.has("light"), true, "a light PC gives the light look");
  assert.ok(h.media.listeners.length > 0, "the page registers a change listener on the PC's colour scheme");
  h.media.light = false; h.media.change(); // the PC switched to dark: nothing else reaches the page, so only the registered listener can move the theme
  assert.equal(h.bodyClasses.has("light"), false, "a dark PC gives the dark look");
  h.media.light = true; h.media.change();
  assert.equal(h.bodyClasses.has("light"), true, "and light again");
  // A fresh page that is handed 'system' by the server reads the PC; a fixed choice ignores it.
  for (const [pcLight, theme, expectLight] of [[true, "system", true], [false, "system", false], [true, "dark", false], [false, "light", true]] as const) {
    const fresh = pageHarness();
    fresh.media.light = pcLight;
    fresh.api.onMessage(fresh.state({}, { clientPrefs: { theme } }));
    assert.equal(fresh.bodyClasses.has("light"), expectLight, `PC ${pcLight ? "light" : "dark"}, server theme ${theme}: ${expectLight ? "light" : "dark"} look`);
  }
});

test("a message's time label is the clock time of its `at`, for the leader and for you, and no label without one", () => {
  const h = pageHarness();
  h.api.onMessage(h.state());
  const tab = h.tab();
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  assert.match(h.api.renderMessage(tab, { role: "assistant", text: "hello", revision: 1, at }), /<span class="meta"><b>Atlas<\/b>09:05<\/span>/, "the leader's message carries its time after the name");
  assert.match(h.api.renderMessage(tab, { role: "user", text: "hello", revision: 2, at: at + 60_000 }), /<span class="meta">09:06 <b>You<\/b><\/span>/, "your message carries its time before your name");
  assert.match(h.api.renderMessage(tab, { role: "assistant", text: "no stamp", revision: 3 }), /<span class="meta"><b>Atlas<\/b><\/span>/, "a message with no `at` shows no time");
});

// ---- pack 3: page behaviour that no test pinned yet ----

test("pack 3: a stalled worker's desktop notice says what happens next", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1")] }));
  h.api.onMessage({ type: "runStalled", tabId: "t1", seatKey: "t1.coder", runId: "r1", action: "escalate" });
  assert.deepEqual(h.notifications, [{ title: "Sonny is stalled", body: "Check the run before it can continue." }]);
  h.api.onMessage({ type: "runStalled", tabId: "t1", seatKey: "t1.coder", runId: "r1", action: "relaunch" });
  assert.equal(h.notifications.at(-1)?.body, "No output for 5 minutes. It is being stopped and started once more.");
});

test("pack 3: the crew rail starts open when the server has no crewRailOpen pref, and follows it once there is one", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({}, { clientPrefs: {} }));
  assert.equal(h.api.snap().railWide, true);
  h.api.onMessage(h.state({}, { clientPrefs: { crewRailOpen: false } }));
  assert.equal(h.api.snap().railWide, false);
  h.api.onMessage(h.state({}, { clientPrefs: {} }));
  assert.equal(h.api.snap().railWide, true, "removing the pref goes back to open");
});

test("pack 3: a streamed reply follows the bottom only while the reader is at the bottom", () => {
  const frames: (() => void)[] = [];
  const h = pageHarness({ raf: (fn) => { frames.push(fn); return frames.length; } });
  h.api.onMessage(h.state());
  const paragraph = { innerHTML: "" }, view = h.node("view");
  Object.assign(view, { dataset: { tabId: "t1", mode: "chat" }, scrollHeight: 1000, clientHeight: 400, scrollTop: 100, querySelector: (selector: string) => selector === "[data-stream] .md" ? paragraph : null });
  const delta = (text: string) => { h.api.onMessage({ type: "chatDelta", tabId: "t1", text }); frames.splice(0).forEach((frame) => frame()); };
  delta("first ");
  assert.equal(paragraph.innerHTML, "<p>first </p>", "the delta is painted");
  assert.equal(view.scrollTop, 100, "a reader scrolled up (500 px from the bottom) is left where they are");
  view.scrollTop = 596; // exactly 4 px from the bottom: still counts as at the bottom
  delta("second");
  assert.equal(paragraph.innerHTML, "<p>first second</p>");
  assert.equal(view.scrollTop, 1000, "a reader at the bottom follows the stream");
  view.scrollTop = 595; // 5 px from the bottom: no longer at the bottom
  delta(" third");
  assert.equal(view.scrollTop, 595);
});

test("pack 3: the leader's context meter reads the leader's usage, not a worker's, and a window of 0 is not reported", () => {
  const h = pageHarness();
  const tab = (over: object) => ({ runs: [{ usage: { contextTokens: 50_000 } }], ...over });
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: 200_000 } })), "0.5% of 200k (estimate from the last turn)", "1000 of 200000 from the leader, not 50000 from the worker");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: 0 } })), "not reported yet", "a window of exactly 0");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: 1000, contextWindow: null } })), "not reported yet");
  assert.equal(h.api.real.contextLine(tab({ leaderUsage: { contextTokens: null, contextWindow: 200_000 } })), "not reported yet");
});

test("pack 3: the plan-limit meters skip a window that reports no usable percent", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1", { cli: "claude" })] }));
  h.api.onMessage({ type: "rateLimit", tabId: "t1", runId: "r1", windows: { five_hour: { utilization: 0.5 }, seven_day: { note: "none" }, empty: { limit: 0, used: 3 } } });
  h.api.real.renderMeters();
  const html = h.node("meters").innerHTML as string;
  assert.equal(html.match(/class="meter"/g)?.length, 1, "only the window with a percent gets a row");
  assert.match(html, /Five hour/);
  assert.match(html, /<b>50%<\/b>/);
  assert.doesNotMatch(html, /Seven day|Empty|<b>0%<\/b>/);
});

test("pack 3: the details panel width is kept between 280 and 560, when read and when a drag is saved", async () => {
  const h = pageHarness();
  const width = (value: number) => { h.api.onMessage(h.state({}, { clientPrefs: { rightPanelWidth: value } })); return h.api.real.sideWidth(); };
  assert.equal(width(100), 280, "below the minimum");
  assert.equal(width(900), 560, "above the maximum");
  assert.equal(width(400), 400, "control: inside the limits it is kept");
  h.api.onMessage(h.state());
  const socket = await h.open();
  h.api.real.saveSideWidth(100);
  h.api.real.saveSideWidth(900);
  h.api.real.saveSideWidth(480);
  const sent = socket.sent.filter((message: any) => message.type === "updateClientPref" && message.key === "rightPanelWidth").map((message: any) => message.value);
  assert.deepEqual(sent, [280, 560, 480]);
});

test("pack 3: a crew picture preset the page does not know falls back to the seat's own default", () => {
  const h = pageHarness();
  const seat = (pic?: string) => ({ slot: "coder", name: "Sonny", pic });
  assert.equal(h.api.real.avatarKeyFor(seat("/avatars/vera.svg")), "vera", "a known preset is kept");
  assert.equal(h.api.real.avatarKeyFor(seat("/avatars/zzzz.svg")), "sonny", "an unknown name gives the slot's default");
  assert.equal(h.api.real.seatPic(seat("/avatars/zzzz.svg")), "/avatars/sonny.svg");
});

test("pack 3: a stalled run is still a live run, so its Stop shows and the seat says Stop requested", async () => {
  const h = pageHarness();
  const stalledRun = h.run("r1", { stalled: true });
  h.api.onMessage(h.state({ runs: [stalledRun], crew: h.tab().crew.map((seat: any) => seat.slot === "coder" ? { ...seat, status: "stalled" } : seat) }));
  const tab = h.state({ runs: [stalledRun], crew: h.tab().crew.map((seat: any) => seat.slot === "coder" ? { ...seat, status: "stalled" } : seat) }).projects[0].tabs[0];
  const coder = tab.crew.find((seat: any) => seat.slot === "coder");
  assert.equal(h.api.real.liveRuns(tab, coder).length, 1, "the stalled run is listed as live");
  assert.equal(h.api.real.seatLine(tab, coder).text, "Stalled: no output");
  await h.open();
  h.api.killRun("r1");
  assert.equal(h.api.real.seatLine(tab, coder).text, "Stop requested…", "Stop on a stalled run is shown on the seat");
});

test("pack 3: the model list always offers the seat's own saved model, even when the server's list lacks it", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({}, { modelOptions: { claude: ["claude-opus-5-5[1m]"], codex: ["gpt-6-sol"] }, effortOptions: { claude: ["low", "high"], codex: ["low"] }, settings: {} }));
  const rows = h.api.real.modelRows({ cli: "codex", model: "gpt-6-old-model" }, "");
  assert.match(rows, /data-model="gpt-6-old-model"/, "the saved model is listed");
  assert.match(rows, /data-model="gpt-6-sol"/, "and so are the server's");
  assert.match(h.api.real.modelRows({ cli: "codex", model: "gpt-6-sol" }, ""), /data-model="gpt-6-sol"/, "control: a listed model is not doubled");
  assert.equal(h.api.real.modelRows({ cli: "codex", model: "gpt-6-sol" }, "").match(/data-model="gpt-6-sol"/g)?.length, 1);
});

test("pack 3: a Claude model with no effort level shows no effort in its line and no effort row in the picker", () => {
  const h = pageHarness();
  const claudeModels = [{ value: "claude-haiku-4-5", displayName: "Haiku", supportsEffort: false }, { value: "sonnet", displayName: "Sonnet", supportsEffort: true }];
  h.api.onMessage(h.state({}, { modelOptions: { claude: claudeModels.map((model) => model.value) }, claudeModels, effortOptions: { claude: ["low", "high"] } }));
  assert.doesNotMatch(h.api.real.modelLine("claude", "claude-haiku-4-5", "high"), /· high/, "no effort level on the line");
  assert.match(h.api.real.modelLine("claude", "sonnet", "high"), /· high$/, "control: a model with effort shows it");
  const seat = (model: string) => ({ slot: "coder", name: "Sonny", cli: "claude", model, effort: "high" });
  const tab = { id: "t1" };
  h.api.real.drawModelPicker(tab, seat("claude-haiku-4-5"), null, false);
  assert.match(h.node("pop").innerHTML, /has no effort setting/);
  assert.doesNotMatch(h.node("pop").innerHTML, /data-effort=/);
  h.api.real.drawModelPicker(tab, seat("sonnet"), null, false);
  assert.match(h.node("pop").innerHTML, /data-effort="high"/);
  assert.doesNotMatch(h.node("pop").innerHTML, /has no effort setting/);
});
