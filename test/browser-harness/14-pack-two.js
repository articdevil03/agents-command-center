(() => {
  const { fail, check, dropSocket, waitFor, text, $, requireElement, installTenSecondClock, latestTab, leaderNameOf, openTabMenu, clickMenuItem, showChat, openSeatView, openInbox, openRequests, pressEscape } = window.__ccHarness;
  // ---- fix pack 2, block 3: the page's behaviour fixes. Each check drives the real page through the same entry point a user or the server uses. ----
  const runPackTwo = async () => {
    await waitFor(() => window.__latestState?.type === "state", "pack 2 fake state");
    const holdClock = installTenSecondClock(40000);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const seedTab = (id = "alpha-dev") => latestTab(id, window.__ccSeed);
    const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const sentSince = (start, type) => window.__sent.slice(start).filter((message) => message.type === type);
    const reconnect = async () => {
      const old = window.__socket, states = window.__states.length;
      dropSocket(old);
      await waitFor(() => window.__socket !== old && window.__socket.readyState === 1 && window.__states.length > states, "reconnect and its first state", 10000);
    };

    // The page is unpainted only until the first state; the theme is then already the server's.
    const bootRule = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((rule) => rule.selectorText === "body.boot #app");
    check("while body.boot is set the app is hidden, so a dark launch never flashes the light look", bootRule?.style.visibility === "hidden" && !document.body.classList.contains("boot"), { rule: bootRule?.cssText, bodyClass: document.body.className });

    // C1: Needs you lists requests for every tab; Accept and Decline name the tab the request is addressed to, not the open one.
    window.__ccStrictRequests = true;
    const crossAccept = "00000000-0000-4000-8000-0000000002a1", crossDecline = "00000000-0000-4000-8000-0000000002a2";
    window.__ccSeed.requests = [
      { id: crossAccept, fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Cross tab accept", body: "For the other tab", status: "pending", createdAt: Date.now() },
      { id: crossDecline, fromTabId: "alpha-dev", toTabId: "alpha-design", title: "Cross tab decline", body: "For the design tab", status: "pending", createdAt: Date.now() - 1000 },
    ];
    window.__ccSeed.selectedTabId = "alpha-dev"; deliverSeed();
    openInbox();
    const acceptButton = requireElement(`#inboxList [data-request-action="accept:${crossAccept}"]`);
    const handoffLabel = acceptButton.textContent.trim();
    let from = window.__sent.length;
    acceptButton.click();
    const accepted = sentSince(from, "resolveRequest").at(-1);
    await waitFor(() => window.__latestState.requests?.find((request) => request.id === crossAccept)?.status === "accepted", "the other tab's request is accepted by the server");
    openInbox();
    from = window.__sent.length;
    requireElement(`#inboxList [data-request-action="decline:${crossDecline}"]`).click();
    const declined = sentSince(from, "resolveRequest").at(-1);
    await waitFor(() => window.__latestState.requests?.find((request) => request.id === crossDecline)?.status === "declined", "the design tab's request is declined by the server");
    check("Accept and Decline on a request for another tab name that tab, and the server takes both", accepted?.tabId === "beta-dev" && accepted.status === "accepted" && declined?.tabId === "alpha-design" && declined.status === "declined" && handoffLabel === `Hand to Development's ${leaderNameOf("beta-dev")}` && !window.__ccErrors.length, { accepted, declined, handoffLabel });
    window.__ccStrictRequests = false; window.__ccSeed.requests = []; deliverSeed(); pressEscape();

    // C14: a renamed leader is called by its new name in the approval panel, the Waiting status and the Needs you card, and in the hand-over button.
    const renamed = structuredClone(window.__ccSeed);
    latestTab("alpha-dev", renamed).crew.find((seat) => seat.isLeader).name = "Rowan";
    latestTab("beta-dev", renamed).crew.find((seat) => seat.isLeader).name = "Ines";
    latestTab("alpha-dev", renamed).pendingApprovals = [{ approvalId: "rename-1", tool: "Bash", summary: "echo renamed", createdAt: 1 }];
    renamed.requests = [{ id: "00000000-0000-4000-8000-0000000002a3", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Rename check", body: "x", status: "pending", createdAt: Date.now() }];
    window.__ccDeliver({ ...renamed, type: "state" });
    openInbox();
    const renamedChecks = { panel: text("#approvalTitle"), pill: text("#statusBtn .pill"), card: text("#inboxList .ncard.apx > b"), handoff: text('#inboxList [data-request-action^="accept:"]') };
    check("a renamed leader is named in the approval title, the Waiting status, the Needs you card and the hand-over button", renamedChecks.panel === "Rowan wants to run a command" && renamedChecks.pill === "Waiting on you: Rowan wants to run a command" && renamedChecks.card === "Rowan wants to run a command" && renamedChecks.handoff === "Hand to Development's Ines", renamedChecks);
    pressEscape(); deliverSeed();

    // C2 + C13: a live run's log starts from the server's tail, only appends, and is kept to the server's 200 KiB.
    openSeatView("coder");
    const log = () => requireElement('#view [data-output-run="audit-parallel-1"]');
    const logBefore = log().textContent, logNode = log().firstChild;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: "\nsecond line" });
    const appendedInPlace = log().textContent === logBefore + "\nsecond line" && log().firstChild === logNode;
    const resync = structuredClone(window.__ccSeed);
    const resyncRun = latestTab("alpha-dev", resync).runs.find((run) => run.runId === "audit-parallel-1");
    resyncRun.output = "EARLIER LINE\nreal runner output 1\nsecond line\nMISSED WHILE CUT OFF";
    window.__ccDeliver({ ...resync, type: "state" });
    const rebased = log().textContent === resyncRun.output;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: "\nafter" });
    const appendsAfterRebase = log().textContent === `${resyncRun.output}\nafter`;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: `${"x".repeat(300 * 1024)}THE END` });
    const capped = log().textContent.length === 200 * 1024 && log().textContent.endsWith("THE END");
    const afterCap = log().textContent.length;
    deliverSeed();
    check("a run's log starts from the server's tail, a chunk only appends, a resync fills what was missed, and the page keeps 200 KiB", appendedInPlace && rebased && appendsAfterRebase && capped && log().textContent === "real runner output 1", { appendedInPlace, rebased, appendsAfterRebase, capped, afterCap, restored: log().textContent });

    // C9: the stalled card and notice say what the server really does.
    const stallState = structuredClone(window.__ccSeed);
    for (const run of latestTab("alpha-dev", stallState).runs.filter((item) => item.status === "working")) run.stalled = true;
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", runId: "audit-parallel-1", seatKey: "alpha-dev.coder", action: "relaunch" });
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", runId: "audit-parallel-2", seatKey: "alpha-dev.coder", action: "escalate" });
    window.__ccDeliver({ ...stallState, type: "state" });
    openInbox();
    const stallCards = [...document.querySelectorAll("#inboxList .ncard.bad")].filter((card) => card.textContent.includes("run stalled")).map((card) => card.querySelector("p").textContent);
    const relaunchCard = stallCards.find((line) => line.startsWith("Parallel run 1")), escalateCard = stallCards.find((line) => line.startsWith("Parallel run 2"));
    check("a stalled run the server relaunches says so, and one it leaves for you says it was not relaunched", Boolean(relaunchCard?.includes("stopping it and starting it once more") && !relaunchCard.includes("not relaunched")) && Boolean(escalateCard?.includes("It was not relaunched by itself")), { stallCards });
    pressEscape(); deliverSeed();

    // C11: a launch notice is one line in Activity, however it arrives, updated in place when its outcome is confirmed.
    $("sideBtn").click();
    const noticeRows = () => [...document.querySelectorAll("#feed .ev .x")].map((node) => node.textContent).filter((line) => line.startsWith("Pack2 requested Coder"));
    const noticeState = (pending, extra = []) => { const next = structuredClone(window.__ccSeed); next.launchSafety = { ...(next.launchSafety ?? {}), notices: [{ type: "leaderLaunch", id: 7001, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Pack2", pending }, ...extra] }; return { ...next, type: "state" }; };
    window.__ccDeliver({ type: "leaderLaunch", id: 7001, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Pack2", pending: true });
    window.__ccDeliver(noticeState(true));
    window.__ccDeliver(noticeState(true));
    const onceShown = noticeRows().length === 1 && noticeRows()[0].endsWith("outcome unconfirmed");
    window.__ccDeliver(noticeState(false));
    const updatedInPlace = noticeRows().length === 1 && !noticeRows()[0].includes("unconfirmed");
    const manyNotices = Array.from({ length: 90 }, (_, index) => ({ type: "leaderLaunch", id: 8000 + index, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Flood", pending: false }));
    window.__ccDeliver(noticeState(false, manyNotices));
    const feedTexts = () => [...document.querySelectorAll("#feed .ev .x")].map((node) => node.textContent);
    const finished = (rows) => rows.filter((line) => line.endsWith(" finished")).length;
    const rowsA = feedTexts();
    window.__ccDeliver(noticeState(false, manyNotices)); window.__ccDeliver(noticeState(false, manyNotices));
    const rowsB = feedTexts();
    const stable = JSON.stringify(rowsA) === JSON.stringify(rowsB) && rowsA.length <= 80;
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", runId: "audit-parallel-1", seatKey: "alpha-dev.coder", outcome: "done", exitCode: 0 });
    window.__ccDeliver(noticeState(false, manyNotices));
    const rowsC = feedTexts();
    const noChurn = stable && rowsC[0].endsWith(" finished") && finished(rowsC) === finished(rowsA) + 1 && rowsC.length <= 80;
    check("a launch notice is one Activity line however it arrives, updated in place, and repeated states never push real events out", onceShown && updatedInPlace && noChurn, { onceShown, updatedInPlace, stable, rows: rowsA.length, top: rowsC[0], finishedBefore: finished(rowsA), finishedAfter: finished(rowsC) });
    $("sideBtn").click(); deliverSeed();

    // C10: what was sent and not answered before a drop is sent again (a held removal) or forgotten (a Stop), so nothing stays hidden or disabled.
    const lostTab = structuredClone(seedTab("alpha-design")); lostTab.id = "alpha-lost"; lostTab.name = "Lost"; window.__ccSeed.projects[0].tabs.push(lostTab); deliverSeed();
    window.__ccSwallowRemove = true;
    from = window.__sent.length;
    clickMenuItem(openTabMenu("alpha-lost"), "Remove tab");
    await holdClock.advance(10_000);
    const firstRemove = sentSince(from, "removeTab").filter((message) => message.tabId === "alpha-lost").length;
    const hiddenWhileWaiting = !document.querySelector('#tabs [data-tab-id="alpha-lost"]');
    await reconnect();
    try { await waitFor(() => !latestTab("alpha-lost") && !document.querySelector("#undo .undo-item"), "the lost removal is sent again and done"); }
    catch (error) { fail(`${error.message}; sent=${JSON.stringify(sentSince(from, "removeTab"))} undo=${$("undo").textContent} stateHasTab=${Boolean(latestTab("alpha-lost"))} errors=${JSON.stringify(window.__ccErrors)}`); }
    const removeSends = sentSince(from, "removeTab").filter((message) => message.tabId === "alpha-lost").length;
    check("a removal sent just before the connection dropped is sent again after the reconnect and completes", firstRemove === 1 && hiddenWhileWaiting && removeSends === 2 && !document.querySelector('#tabs [data-tab-id="alpha-lost"]'), { firstRemove, hiddenWhileWaiting, removeSends });

    openSeatView("coder");
    const stopButton = (runId) => requireElement(`#view [data-stop-run="${runId}"]`);
    window.__ccSwallowKill = 1;
    stopButton("audit-parallel-1").click();
    const stopAsked = stopButton("audit-parallel-1").disabled;
    await reconnect();
    openSeatView("coder");
    const stopFreed = !stopButton("audit-parallel-1").disabled;
    check("a Stop that never got its answer before the drop is forgotten, so its button works again", stopAsked && stopFreed && window.__ccSwallowKill === 0, { stopAsked, stopFreed });

    // One refused Stop frees only its own run (the refusal names none: the server answers in order).
    window.__ccSwallowKill = 2;
    stopButton("audit-parallel-1").click();
    requireElement('#view [data-run-tab="audit-parallel-2"]').click();
    stopButton("audit-parallel-2").click();
    window.__ccDeliver({ type: "error", action: "killRun", message: "the first stop was refused" });
    const secondStillAsked = stopButton("audit-parallel-2").disabled;
    requireElement('#view [data-run-tab="audit-parallel-1"]').click();
    const firstFreed = !stopButton("audit-parallel-1").disabled;
    check("a refused Stop frees only the run it was for", secondStillAsked && firstFreed, { secondStillAsked, firstFreed });
    await reconnect(); window.__ccSwallowKill = 0;

    // Settings "Check again": the server's answer, success or failure, ends "Checking…".
    $("setBtn").click();
    const settingsHelp = () => text("#s-tools .settings-help");
    window.__ccRefreshReply = "ok"; from = window.__sent.length;
    requireElement("#setBody [data-settings-refresh]").click();
    const refreshRequest = sentSince(from, "refreshSettings").at(-1);
    try { await waitFor(() => /^Checked/.test(settingsHelp()) && !requireElement("#setBody [data-settings-refresh]").disabled, "Check again finished"); }
    catch (error) { fail(`${error.message}; help=${settingsHelp()} disabled=${requireElement("#setBody [data-settings-refresh]").disabled} sent=${JSON.stringify(sentSince(from, "refreshSettings"))} received=${JSON.stringify(window.__received.slice(-3).map((m) => ({ type: m.type, action: m.action, requestId: m.requestId })))}`); }
    window.__ccRefreshReply = "error";
    requireElement("#setBody [data-settings-refresh]").click();
    await waitFor(() => settingsHelp().startsWith("Could not check just now") && !requireElement("#setBody [data-settings-refresh]").disabled, "Check again failed cleanly");
    window.__ccRefreshReply = "drop";
    requireElement("#setBody [data-settings-refresh]").click();
    const stillChecking = requireElement("#setBody [data-settings-refresh]").disabled;
    await holdClock.advance(30_000);
    const gaveUpChecking = settingsHelp().startsWith("Could not check just now") && !requireElement("#setBody [data-settings-refresh]").disabled;
    check("Check again sends a request id, ends on the server's success or failure answer, and never hangs when there is none", typeof refreshRequest?.requestId === "string" && refreshRequest.requestId.length >= 16 && stillChecking && gaveUpChecking, { refreshRequest, stillChecking, gaveUpChecking, help: settingsHelp() });
    pressEscape();

    // A message over the server's 2 MiB limit is refused here with a reason, never sent (the server would close the connection).
    showChat();
    $("ci").value = "x".repeat(2 * 1024 * 1024 + 10); $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    from = window.__sent.length;
    $("sendBtn").click();
    await sleep(80);
    const bigSent = sentSince(from, "chat").length;
    const bigToast = text("#toast");
    check("a chat over 2 MiB is not sent, says so, and keeps the connection and the draft", bigSent === 0 && /too large/i.test(bigToast) && window.__socket.readyState === 1 && $("ci").value.length > 2 * 1024 * 1024 && !$("ci").readOnly, { bigSent, bigToast, readyState: window.__socket.readyState, readOnly: $("ci").readOnly });
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));

    // Request details: the form's limit is bytes, not characters.
    openRequests();
    const bodyField = $("reqBody");
    $("reqTitle").value = "Bytes check";
    bodyField.value = "é".repeat(12289);
    from = window.__sent.length;
    $("reqSend").click();
    await sleep(40);
    const overRefused = sentSince(from, "sendRequest").length === 0 && /too long/i.test($("reqStatus").textContent);
    bodyField.value = "é".repeat(12288);
    $("reqSend").click();
    await sleep(40);
    const exactSent = sentSince(from, "sendRequest").at(-1);
    check("request details are measured in bytes: 24 KiB goes, one byte more is refused here with a reason", overRefused && Boolean(exactSent) && exactSent.body.length === 12288, { overRefused, status: $("reqStatus").textContent, exactSent: exactSent && { bodyChars: exactSent.body.length } });
    if (exactSent) window.__ccDeliver({ type: "actionResult", action: "sendRequest", requestId: exactSent.requestId });
    pressEscape();

    // Saved-run lists and runs that the server never answers stop spinning; a list can be asked for again.
    window.__ccDropHistory = true;
    openSeatView("reviewer1");
    requireElement('#view [data-run-view="history"]').click();
    const spinning = /Loading saved runs/.test(text("#view"));
    await holdClock.advance(15_000);
    const gaveUp = /Could not load the saved runs just now/.test(text("#view")) && !/Loading saved runs/.test(text("#view")) && Boolean(document.querySelector("#view [data-history-retry]"));
    if (!gaveUp) fail(`history never gave up: spinning=${spinning} view=${text("#view").slice(0, 300)} sent=${JSON.stringify(sentSince(from, "historyList"))}`);
    window.__ccDropHistory = false;
    window.__ccHistoryRuns = { "alpha-dev.reviewer1": [{ timestamp: 1780000000999, outcome: { status: "done", exitCode: 0 }, sizeBytes: 10 }] };
    requireElement("#view [data-history-retry]").click();
    await waitFor(() => document.querySelector("#view [data-history-timestamp]"), "the saved-runs list after Try again");
    const row = requireElement("#view [data-history-timestamp]");
    row.click();
    const reading = /Reading its saved files/.test(row.textContent);
    await holdClock.advance(15_000);
    const rowReset = !/Reading its saved files/.test(text("#view")) && /Could not read that saved run/.test(text("#toast"));
    check("a saved-runs list or saved run the server never answers stops spinning, and the list can be asked for again", spinning && gaveUp && reading && rowReset, { spinning, gaveUp, reading, rowReset });
    window.__ccHistoryRuns = null;
    requireElement('#view [data-back-chat]').click();

    // C8 (page side): a successful Save lists the new entry in the leader's Past sessions.
    from = window.__sent.length;
    $("saveBtn").click();
    await waitFor(() => sentSince(from, "historyList").some((message) => message.seatKey === "alpha-dev.leader"), "the leader's Past sessions are listed again after Save");
    check("a successful Save asks for the leader's saved sessions again", true, { listed: sentSince(from, "historyList").map((message) => message.seatKey) });

    // A refused selectTab is forgotten, so the tab's transcript is asked for again when the server does select it.
    window.__ccRefuseSelect = "alpha-design";
    requireElement('#tabs [data-tab-id="alpha-design"]').click();
    await waitFor(() => /cannot open alpha-design/.test(text("#toast")), "the refusal is shown");
    from = window.__sent.length;
    window.__ccSeed.selectedTabId = "alpha-design"; deliverSeed();
    const askedAgain = sentSince(from, "selectTab").some((message) => message.tabId === "alpha-design");
    check("a refused tab selection does not stop the page asking for that tab's transcript later", askedAgain, { sent: sentSince(from, "selectTab") });
    window.__ccSeed.selectedTabId = "alpha-dev"; deliverSeed();

    // The tab strips hold no button inside a tab.
    const nested = [...document.querySelectorAll("[role=tab]")].filter((tab) => tab.querySelector("button, a[href], input, select, textarea, [tabindex]")).map((tab) => tab.className);
    check("no tab in the project strip or the tab strip contains another button", nested.length === 0 && document.querySelectorAll("#ptabs [role=tab]").length > 0 && document.querySelectorAll("#tabs [role=tab]").length > 0, { nested });

    // An attachment that failed has an error ring in the theme's own colours, not a fixed light pink.
    window.__ccSeed.clientPrefs = { ...(window.__ccSeed.clientPrefs ?? {}), theme: "dark" }; deliverSeed();
    const probe = document.createElement("span"); probe.className = "att err"; $("atts").append(probe);
    const darkShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    window.__ccSeed.clientPrefs = { ...window.__ccSeed.clientPrefs, theme: "light" }; deliverSeed();
    check("a failed attachment's ring is not the fixed light pink in the dark theme", darkShadow !== "none" && !darkShadow.includes("244, 199, 195") && !darkShadow.includes("#f4c7c3"), { darkShadow });
    holdClock.restore();
  };
  Object.assign(window.__ccHarness, { runPackTwo });
})();
