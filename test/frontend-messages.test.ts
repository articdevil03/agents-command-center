import test from "node:test";
import assert from "node:assert/strict";
import { appSource as readAppSource } from "./source-text.ts";
import { pageHarness, heldTimer, plain, noTabs } from "./frontend-helpers.ts";

test("a late 'saved' clears the earlier Save failed card, notice and pending flag, which all read saveStates", () => {
  const app = readAppSource();
  const handler = /if \(message\.type === "saved"\) \{[^]*?\n    \}/.exec(app)?.[0] ?? "";
  assert.ok(handler, "the saved handler was found");
  assert.match(handler, /savePending\.delete\(message\.tabId\)/);
  assert.match(handler, /saveStates\.delete\(message\.tabId\)/);
  // The Save failed notice and the Needs you card both derive from saveStates, so deleting it removes every trace.
  assert.ok(/const save = saveStates\.get\(tab\.id\);\s*\n\s*if \(save\?\.status === "failed"\) return/.test(app), "the notice reads saveStates");
  assert.ok(/items\.push\(\{ type: "save", tab, save, bad: true \}\)/.test(app), "the Needs you card reads saveStates");
});

test("approvals already waiting when the page loads never ring; a new one rings once, named after the leader's current name", () => {
  const h = pageHarness();
  const approval = (id: string) => ({ approvalId: id, tool: "Bash", summary: `echo ${id}`, createdAt: 1 });
  h.api.onMessage(h.state({ pendingApprovals: [approval("a")], processState: { approval: { state: "pending" } } }));
  assert.deepEqual(h.notifications, [], "the first state after a load is not news: an approval and a look already waiting do not ring");
  h.api.onMessage(h.state({ pendingApprovals: [approval("a"), approval("b")], processState: { approval: { state: "pending" } } }));
  assert.deepEqual(h.notifications.map((item) => item.title), ["Atlas needs your answer"], "a new approval rings once");
  h.api.onMessage(h.state({ pendingApprovals: [approval("a"), approval("b")], processState: { approval: { state: "pending" } } }));
  assert.equal(h.notifications.length, 1, "the same state again rings nothing");
  const renamed: any = h.state({ pendingApprovals: [approval("a"), approval("b"), approval("c")], processState: { approval: { state: "pending" } } });
  renamed.projects[0].tabs[0].crew[0].name = "Rowan";
  h.api.onMessage(renamed);
  assert.deepEqual(h.notifications.map((item) => item.title), ["Atlas needs your answer", "Rowan needs your answer"], "a renamed leader is called by its new name");
  h.api.onMessage(h.state({ processState: { approval: { state: "none" } } }));
  h.api.onMessage(h.state({ processState: { approval: { state: "pending" } } }));
  assert.equal(h.notifications.at(-1)?.title, "Your look is needed", "a look that becomes pending after the page loaded still rings");
  const named: any = h.tab(); named.crew[0].name = "Rowan";
  assert.equal(h.api.approvalTitle("Edit", named), "Rowan wants to edit a file", "the approval title uses the leader's current name");
  assert.equal(h.api.approvalTitle("launch:Sonny", named), "Rowan wants to launch Sonny");
});

test("closing the app also warns about work that belongs to no tab (a Settings action, an upload), and alone it holds the close", () => {
  const h = pageHarness();
  const nbsp = " · ";
  h.api.onMessage(h.state({}, { globalWork: [] }));
  h.api.answerCloseRequest();
  assert.deepEqual(h.closeAnswers, ["close"], "nothing working: closes at once");
  h.api.onMessage(h.state({}, { globalWork: ["a Settings action is running"] }));
  h.api.answerCloseRequest();
  assert.deepEqual(h.closeAnswers, ["close", "hold"], "work with no tab holds the close");
  assert.equal(h.api.confirmCalls.at(-1).body, "Still working: a Settings action is running. Closing stops it.");
  h.api.onMessage(h.state({ activeWork: true }, { globalWork: ["an upload is running", "a Settings action is running"] }));
  h.api.answerCloseRequest();
  assert.equal(h.api.confirmCalls.at(-1).body, `1 tab is still working: P${nbsp}Dev. Also: an upload is running, a Settings action is running. Closing stops them.`);
  h.api.onMessage(h.state({ activeWork: true }, { globalWork: [] }));
  h.api.answerCloseRequest();
  assert.equal(h.api.confirmCalls.at(-1).body, `1 tab is still working: P${nbsp}Dev. Closing stops it.`, "a working tab alone reads as it always did");
});

test("a tab whose saved chat cannot be read says why its chat is empty, in the existing failed-status look", () => {
  const h = pageHarness();
  const withProblem: any = h.state({ chatProblem: "Unexpected token < in <b>JSON" });
  h.api.onMessage(withProblem);
  h.api.renderChat(withProblem.projects[0].tabs[0]);
  const html = h.node("view").innerHTML as string;
  assert.match(html, /<p class="action-status" data-status="failed" role="alert" data-chat-problem>This chat could not be read \(Unexpected token &lt; in &lt;b&gt;JSON\)\. Clear the chat to start a new one; the damaged file is kept as a copy\.<\/p>/, "one plain error line, reason escaped");
  assert.match(html, /is ready/, "the empty-chat welcome still shows under it");
  const fine: any = h.state({});
  h.api.onMessage(fine);
  h.api.renderChat(fine.projects[0].tabs[0]);
  assert.doesNotMatch(h.node("view").innerHTML as string, /data-chat-problem/, "a readable chat shows no such line");
});

test("a worker launch never rings or sends a notice; a finish or failure says which run and how it ended", () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1", { label: "Fix the login" })] }));
  h.api.onMessage({ type: "runStart", tabId: "t1", seatKey: "t1.coder", runId: "r1", model: "gpt-6-sol" });
  assert.deepEqual(h.notifications, [], "starting a worker is not finishing, failing or needing you");
  h.api.onMessage({ type: "runFinish", tabId: "t1", seatKey: "t1.coder", runId: "r1", outcome: "done", exitCode: 0 });
  h.api.onMessage({ type: "runFail", tabId: "t1", seatKey: "t1.coder", runId: "r1", outcome: "failed", exitCode: 3 });
  assert.deepEqual(h.notifications, [{ title: "Sonny finished", body: "Fix the login finished." }, { title: "Sonny failed", body: "Fix the login failed (failed, exit 3)." }]);
  assert.ok(h.notifications.every((item) => item.body !== "The run ended."), "never the old always-the-same text");
});

test("a live run's log: the server's tail is its base, chunks append, a resync fills what was missed, the page keeps 200 KiB, a finished run's log is freed", () => {
  const h = pageHarness();
  const live = (output: string, status = "working") => h.state({ runs: [h.run("r1", { output, status })] });
  h.api.onMessage(live("line one\n"));
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\n", "a reload starts from the server's tail");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "line two\n" });
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\nline two\n", "a chunk is appended to that tail, not started from nothing");
  h.api.onMessage(live("line one\nline two\nMISSED\n"));
  assert.equal(h.api.snap().outputByRun.get("r1"), "line one\nline two\nMISSED\n", "a state after a gap fills in what the page missed");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "z".repeat(300 * 1024) + "END" });
  const kept = h.api.snap().outputByRun.get("r1");
  assert.equal(kept.length, 200 * 1024, "the page keeps what the server keeps");
  assert.ok(kept.endsWith("END"), "and it is the end of the log");
  h.api.onMessage(live("y".repeat(300 * 1024)));
  assert.equal(h.api.snap().outputByRun.get("r1").length, 200 * 1024, "a state's tail is capped too");
  h.api.onMessage(live("", "done"));
  assert.equal(h.api.snap().outputByRun.has("r1"), false, "a finished run's log is freed");
  h.api.onMessage({ type: "output", runId: "r1", chunk: "late" });
  h.api.onMessage(h.state({ runs: [] }));
  assert.equal(h.api.snap().outputByRun.has("r1"), false, "nothing keeps a log for a run that is not listed");
});

test("a launch notice is one Activity line however many pile up or arrive twice, and updates in place when its outcome is confirmed", () => {
  const h = pageHarness();
  const notice = (id: number, pending = false) => ({ type: "leaderLaunch", id, seatId: "t1.coder", seatKey: "t1.coder", seatName: "Sonny", brief: "x", source: "Atlas", pending });
  const withNotices = (list: any[]) => h.state({}, { launchSafety: { notices: list } });
  h.api.onMessage(notice(1, true));
  h.api.onMessage(withNotices([notice(1, true)]));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.text)), ["Atlas requested Sonny \u00b7 outcome unconfirmed"], "the message and the state it also arrives in make one line");
  h.api.onMessage(withNotices([notice(1, false)]));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.text)), ["Atlas requested Sonny"], "the outcome got confirmed: that line is updated, not a second one added");
  const many = Array.from({ length: 120 }, (_, index) => notice(100 + index));
  h.api.onMessage(withNotices(many));
  const first = plain(h.api.snap().activity.map((item: any) => item.id));
  assert.equal(first.length, 80, "the feed keeps 80");
  h.api.onMessage(withNotices(many)); h.api.onMessage(withNotices(many));
  assert.deepEqual(plain(h.api.snap().activity.map((item: any) => item.id)), first, "repeated states change nothing: notices that fell off are not added back");
  h.api.onMessage({ type: "runFinish", tabId: "t1", seatKey: "t1.coder", runId: "r9", outcome: "done", exitCode: 0 });
  h.api.onMessage(withNotices(many));
  assert.match(h.api.snap().activity[0].text, /finished$/, "a real event stays on top and is not pushed out by notices");
  h.api.onMessage(withNotices(many.slice(100)));
  assert.equal(h.api.snap().seenNotices.size, 20, "a notice the server dropped is forgotten");
});

test("a Stop, a held removal and a Stop all that were sent but never answered are not left stuck by a dropped connection", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ runs: [h.run("r1"), h.run("r2")] }));
  let socket = await h.open();
  h.api.killRun("r1"); h.api.killRun("r2");
  assert.deepEqual(plain([...h.api.snap().stopStates.entries()]), [["r1", "requested"], ["r2", "requested"]]);
  assert.deepEqual(plain(h.api.snap().killOrder), ["r1", "r2"]);
  h.api.onMessage({ type: "error", action: "killRun", message: "refused" });
  assert.deepEqual(plain([...h.api.snap().stopStates.entries()]), [["r2", "requested"]], "a refusal frees only the oldest unanswered Stop, not every one");
  h.api.onMessage({ type: "killAccepted", runId: "r2" });
  assert.equal(h.api.snap().stopStates.get("r2"), "accepted");
  assert.deepEqual(plain(h.api.snap().killOrder), [], "an answered Stop leaves the queue");
  h.api.killRun("r1");
  assert.equal(h.api.snap().stopStates.get("r1"), "requested");
  // a removal whose timer fired and was sent
  h.api.holdAction({ type: "removeTab", tabId: "t1" }, "Dev tab will be removed", { type: "removeTab", tabId: "t1", hideTabId: "t1" });
  const held = heldTimer(h.timers); held.fn();
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 1);
  assert.equal([...h.api.snap().pendingActions.values()][0].sent, true);
  socket.close();
  assert.equal(h.api.snap().stopStates.has("r1"), false, "a Stop that got no answer before the drop is forgotten, so its button works again");
  assert.equal(h.api.snap().stopStates.get("r2"), "accepted", "an accepted Stop stays: the run really is stopping");
  assert.deepEqual(plain(h.api.snap().killOrder), []);
  socket = await h.open();
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 0, "nothing is resent before the first state says whether it was applied");
  h.api.onMessage(h.state({ runs: [h.run("r1"), h.run("r2")] }));
  assert.equal(socket.sent.filter((message: any) => message.type === "removeTab").length, 1, "the tab is still there: the removal is sent again");
  h.api.onMessage(noTabs);
  assert.equal(h.api.snap().pendingActions.size, 0, "once the state shows the tab gone, the held action is finished");
  // the removal went through but its answer was lost: the first state shows the tab gone and nothing is sent twice
  const again = pageHarness();
  again.api.onMessage(again.state());
  let s2 = await again.open();
  again.api.holdAction({ type: "removeTab", tabId: "t1" }, "x", { type: "removeTab", tabId: "t1", hideTabId: "t1" });
  heldTimer(again.timers).fn();
  s2.close(); s2 = await again.open();
  again.api.onMessage(noTabs);
  assert.equal(s2.sent.filter((message: any) => message.type === "removeTab").length, 0, "a removal the server did apply is not sent a second time");
  assert.equal(again.api.snap().pendingActions.size, 0);
});

test("a step button stays Sending until the step moves, so a state already on its way cannot turn it back on and skip a step", async () => {
  const h = pageHarness();
  const steps = (current: number) => ({ derived: { stepBar: [{ stepId: "brief", state: current === 0 ? "current" : "done" }, { stepId: "build", state: current === 1 ? "current" : "todo" }, { stepId: "ship", state: "todo" }], busy: false } });
  h.api.onMessage(h.state(steps(0)));
  const socket = await h.open();
  const tab = h.state(steps(0)).projects[0].tabs[0];
  h.api.runProcessAction(tab, "advanceStep");
  h.api.onMessage(h.state(steps(0))); // a state that was already on its way
  h.api.runProcessAction(tab, "advanceStep");
  assert.equal(socket.sent.filter((message: any) => message.type === "advanceStep").length, 1, "the second click is ignored: the server has not acted yet");
  h.api.onMessage(h.state(steps(1)));
  assert.equal(h.api.snap().processPending.has("t1"), false, "the step moved: the button is free again");
  await new Promise((resolve) => setTimeout(resolve, 650)); // the next step's button ignores clicks for 600 ms after the step changes
  h.api.runProcessAction(h.state(steps(1)).projects[0].tabs[0], "advanceStep");
  assert.equal(h.api.snap().processPending.has("t1"), true);
  h.api.onMessage({ type: "error", action: "advanceStep", tabId: "t1", message: "no" });
  assert.equal(h.api.snap().processPending.has("t1"), false, "a refusal frees it too");
});

test("round 1 fix 17: a step button waits at most 5 s for a state; with no further state it is freed and redrawn", async () => {
  const h = pageHarness();
  h.api.onMessage(h.state({ derived: { stepBar: [{ stepId: "brief", state: "current" }, { stepId: "build", state: "todo" }], busy: false } }));
  const socket = await h.open();
  const tab = h.state({ derived: { stepBar: [{ stepId: "brief", state: "current" }, { stepId: "build", state: "todo" }], busy: false } }).projects[0].tabs[0];
  h.api.runProcessAction(tab, "advanceStep");
  assert.equal(socket.sent.filter((message: any) => message.type === "advanceStep").length, 1);
  assert.equal(h.api.snap().processPending.has("t1"), true, "Sending while the server has not answered");
  const timer = h.timers.filter((entry) => entry.ms === 5_000 && !entry.cleared).at(-1);
  assert.ok(timer, "a 5 s timer was armed when the action was sent");
  timer.fn(); // five seconds pass with no state message at all
  assert.equal(h.api.snap().processPending.has("t1"), false, "the button is usable again");
  // a timer left over from an earlier click never frees a newer one
  h.api.runProcessAction(tab, "advanceStep");
  await new Promise((resolve) => setTimeout(resolve, 650));
  h.api.onMessage({ type: "error", action: "advanceStep", tabId: "t1", message: "no" }); // the answer came first
  h.api.runProcessAction(tab, "advanceStep");
  timer.fn();
  assert.equal(h.api.snap().processPending.has("t1"), true, "the old timer does not free the newer click");
});

test("round 1 fix 16: after pictures X, Y, X again, a message drawn earlier never shows the revoked picture URL", () => {
  const h = pageHarness();
  const png = (n: number) => `data:image/png;base64,${Buffer.from(`not really a picture ${n}`).toString("base64")}`;
  const message = (revision: number) => ({ role: "user", revision, text: "hi", at: 1 });
  const tabOf = (id: string) => ({ ...h.tab(), id });
  const src = (html: string) => /<img src="([^"]*)"[^>]*class="uav"/.exec(html)?.[1];
  h.api.setMe(png(1));
  const first = src(h.api.renderMessage(tabOf("t1"), message(1)));
  assert.match(first!, /^blob:/);
  h.api.setMe(png(2));
  h.api.renderMessage(tabOf("t2"), message(1)); // another tab is drawn while picture Y is set: this makes Y's URL and revokes X's
  h.api.setMe(png(1));
  const again = src(h.api.renderMessage(tabOf("t1"), message(1)));
  assert.equal(again, h.api.mePic(), "the first tab's message uses the URL that is current now");
  assert.notEqual(again, first, "not the one the later picture revoked");
});

test("round 1 fix 18: Clear on a tab whose chat cannot be read says it cannot be undone and makes no promise of Undo or a handover", () => {
  const h = pageHarness();
  const menus: any[][] = [];
  h.api.setMakeMenu((_pop: unknown, _anchor: unknown, items: any[]) => { menus.push(items); });
  h.api.onMessage(h.state({ chatProblem: "invalid chat transcript" }));
  h.api.clearConfirmMenu(null);
  const damaged = menus.at(-1)![0].hint as string;
  assert.equal(damaged, "Clear moves the damaged chat file aside as a copy and starts a fresh chat. This cannot be undone.");
  h.api.onMessage(h.state({}));
  h.api.clearConfirmMenu(null);
  assert.match(menus.at(-1)![0].hint, /You can undo for 10 seconds/, "an ordinary tab still gets the Undo hint");
});

test("choosing who fixes a round stays Sending until the server's choice shows, and a Stop all nobody answered is forgotten by a drop", async () => {
  const h = pageHarness();
  const maker = (slot: string) => ({ processState: { approval: { state: "none" }, selectedFixer: slot } });
  h.api.onMessage(h.state(maker("socialMedia")));
  const socket = await h.open();
  const tab = h.state(maker("socialMedia")).projects[0].tabs[0];
  h.api.runProcessAction(tab, "selectFixer", { slot: "image" });
  h.api.onMessage(h.state(maker("socialMedia"))); // a state already on its way: the choice has not been applied yet
  h.api.runProcessAction(tab, "selectFixer", { slot: "videoAndMotion" });
  assert.equal(socket.sent.filter((message: any) => message.type === "selectFixer").length, 1, "the second pick waits for the first to show");
  h.api.onMessage(h.state(maker("image")));
  assert.equal(h.api.snap().processPending.has("t1"), false, "the server's choice showed: free again");
  // Stop all: sent, never answered, then the connection drops
  h.api.onMessage(h.state({ runs: [h.run("r1")] }));
  h.api.stopAll();
  assert.ok(h.api.snap().stopAllTrack, "Stop all is being tracked");
  socket.close();
  assert.equal(h.api.snap().stopAllTrack, null, "a Stop all that was never accepted is forgotten when the connection drops");
});

test("a message over the server's 2 MiB limit (counted in bytes) is refused before it is sent, with a reason", async () => {
  const h = pageHarness();
  const socket = await h.open();
  const before = socket.sent.length;
  assert.equal(h.api.send({ type: "chat", text: "\u00e9".repeat(1_100_000) }), false, "2.2 MB of two-byte characters is over 2 MiB though it is under 2 million characters");
  assert.equal(h.api.send({ type: "chat", text: "x".repeat(2 * 1024 * 1024) }), false);
  assert.equal(socket.sent.length, before, "nothing reached the socket");
  assert.match(h.node("toast").textContent, /too large to send \(2 MiB at most\)/);
  assert.equal(h.api.send({ type: "chat", text: "\u00e9".repeat(1_000_000) }), true, "just under the limit still goes");
  assert.equal(socket.sent.length, before + 1);
});

test("the Usage panel names the leader's model for the leader's own CLI, not always as a Claude model", () => {
  const h = pageHarness();
  const shared = { claudeModels: [{ value: "shared-id", displayName: "Claude Shared Name" }] };
  const view = (cli: string) => {
    const lead = { slot: "leader", name: "Atlas", cli, model: "shared-id", effort: "low", isLeader: true, seatKey: "t1.leader" };
    h.api.onMessage(h.state({ crew: [lead] }, shared));
    h.api.renderUsage(h.state({ crew: [lead] }).projects[0].tabs[0]);
    return h.node("usage").innerHTML;
  };
  assert.match(view("claude"), /Claude Shared Name/);
  assert.doesNotMatch(view("codex"), /Claude Shared Name/);
  assert.match(view("codex"), /Shared Id/); // an unlisted id is shown cleaned up, never as the raw id
});

test("MCP and plugin names are escaped inside data-focus-key, and a request card never shows a file chip or a hard-coded leader name", () => {
  const h = pageHarness();
  const html = h.api.skillBlock("claude", { mcpServers: [{ name: 'a"b' }], plugins: ['x"y'], skills: [], instructionFiles: [] });
  assert.match(html, /data-focus-key="mcp-remove-claude-a&quot;b"/);
  assert.match(html, /data-focus-key="plugin-remove-x&quot;y"/);
  h.api.onMessage(h.state());
  const card = h.api.requestCard({ id: "r", fromTabId: "t1", toTabId: "gone", title: "T", body: "B", status: "pending", files: ["a.md"], createdAt: Date.now() }, true);
  assert.doesNotMatch(card, /request-files|a\.md/);
  assert.doesNotMatch(card, /Atlas/);
  const renamed: any = h.state(); renamed.projects[0].tabs[0].crew[0].name = "Rowan"; h.api.onMessage(renamed);
  const handOver = h.api.requestCard({ id: "r2", fromTabId: "gone", toTabId: "t1", title: "T", body: "B", status: "pending", createdAt: Date.now() }, true);
  assert.match(handOver, /Hand to Dev's Rowan/, "the hand-over button names the destination leader's current name");
});
