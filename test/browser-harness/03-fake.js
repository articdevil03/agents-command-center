(() => {
  const { check, waitFor, text, $, requireElement, waitToastVisible, latestTab, clickTab, openSeatView, openInbox, pressEscape } = window.__ccHarness;
  const runFake = async () => {
    await waitFor(() => window.__latestState?.type === "state", "fake server state");
    // The bar drags the window; its controls, tabs and popovers are not drag areas. Chrome exposes app-region in computed style, so each target's real value is read (a missing target fails).
    const regionTargets = [["#top", "drag"], ["#soundBtn", "no-drag"], ["#ptabs", "no-drag"], ['#ptabs [role="tab"]', "no-drag"], ["#inboxPop", "no-drag"], ["#setModal", "no-drag"], ["#toast", "no-drag"], ["#undo", "no-drag"], ["#conn", "no-drag"]];
    const regions = regionTargets.map(([selector, wanted]) => { const element = document.querySelector(selector); return { selector, wanted, found: Boolean(element), actual: element ? getComputedStyle(element).getPropertyValue("-webkit-app-region") : null }; });
    check("the top bar drags the window, and its controls, tabs and popovers are not drag areas", regions.every((item) => item.found && item.actual === item.wanted), { regions });
    // This page's window.cc has the folder picker but no window buttons, as in a plain browser: the bar ends at the avatar, as before.
    const topControls = [...$("top").children].filter((node) => node.checkVisibility());
    check("without the app window's bridge the top bar shows no window buttons", $("winBtns").hidden && !$("winBtns").checkVisibility() && topControls.at(-1) === $("meBtn"), { hidden: $("winBtns").hidden, last: topControls.at(-1)?.id });
    // An uploaded picture is shown through one short blob URL (not its data URL, which would be copied into every message): the bytes behind it must be the saved picture.
    if (window.__ccExpectMe) {
      const shownSrc = $("meImg").getAttribute("src") ?? "";
      // (the page's policy lets it load a blob: image but not fetch one, so the two pictures are compared by their decoded pixels)
      const pixelsOf = (url) => new Promise((resolve) => { const image = new Image(); image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); resolve(`${canvas.width}x${canvas.height}:${[...context.getImageData(0, 0, canvas.width, canvas.height).data].join(",")}`); }; image.onerror = () => resolve("did not load"); image.src = url; });
      const keptUpload = window.__ccExpectMe.startsWith("data:") ? shownSrc.startsWith("blob:") && await pixelsOf(shownSrc) === await pixelsOf(window.__ccExpectMe) && !(await pixelsOf(shownSrc)).startsWith("did not") : shownSrc === window.__ccExpectMe;
      check("a personal picture saved before the simple look falls back to Ash, and an uploaded one is kept", keptUpload, { saved: window.__ccOldMe, shown: shownSrc.slice(0, 60), expected: window.__ccExpectMe.slice(0, 60) });
    }
    // A picture whose file is missing swaps to its fallback once; a missing fallback is left alone, never retried.
    const probe = document.createElement("img"); let probeErrors = 0;
    probe.addEventListener("error", () => probeErrors++);
    probe.alt = ""; probe.dataset.fallback = "/avatars/missing-fallback-probe.svg"; probe.src = "/avatars/missing-picture-probe.svg";
    document.body.append(probe);
    await waitFor(() => probeErrors >= 2, "missing picture and its missing fallback both failed");
    for (let index = 0; index < 5; index++) await fetch("/__browser-barrier", { cache: "no-store" });
    check("a picture that fails to load falls back once and never loops", probeErrors === 2 && probe.getAttribute("src") === "/avatars/missing-fallback-probe.svg" && probe.dataset.fellBack === "1", { probeErrors, src: probe.getAttribute("src"), fellBack: probe.dataset.fellBack });
    probe.remove();
    const noUsageState = structuredClone(window.__latestState);
    for (const tab of noUsageState.projects.flatMap((project) => project.tabs)) {
      delete tab.leaderUsage;
      for (const run of tab.runs ?? []) delete run.usage;
    }
    window.__ccDeliver({ ...noUsageState, type: "state" });
    // Every seat has a row; only measured ones carry a number, the rest say Not reported (never a guess).
    const unmeasuredHonest = () => [...document.querySelectorAll("#usage .useRow.unmeasured")].every((row) => !row.querySelector(".v") && /^Not reported( separately)?$/.test(row.querySelector(".nr")?.textContent ?? ""));
    const usageStartsEmpty = text("#usage [data-usage-empty]") === "No usage reported yet." && !document.querySelector("#usage .useRow .v") && document.querySelectorAll("#usage .useRow.unmeasured").length >= window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").crew.length && unmeasuredHonest();
    const measuredUsageState = structuredClone(noUsageState);
    const measuredTab = measuredUsageState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    measuredTab.leaderUsage = { contextTokens: 3072, contextWindow: 10000, costUsd: 0.015, turns: 2 };
    measuredTab.runs.find((run) => run.runId === "audit-parallel-1").usage = { contextTokens: 1536, contextWindow: 8192, costUsd: 0.002, turns: 1 };
    window.__ccDeliver({ ...measuredUsageState, type: "state" });
    const usageRows = [...document.querySelectorAll("#usage .useRow:not(.unmeasured)")].map((row) => row.textContent.replace(/\s+/g, " ").trim());
    const exactUsage = [...document.querySelectorAll("#usage .useRow .v")].map((node) => node.textContent.trim());
    const expectedLeaderUsage = "3,072 / 10,000 ctx · $0.0150 · 2 turns";
    const expectedRunUsage = "1,536 / 8,192 ctx · $0.0020 · 1 turn";
    const exactUsageMatches = exactUsage.slice().sort().join("\n") === [expectedLeaderUsage, expectedRunUsage].sort().join("\n");
    const measuredEmptyGone = !document.querySelector("#usage [data-usage-empty]") && unmeasuredHonest();
    check("Usage shows only measured leader and running-seat snapshots", usageStartsEmpty && usageRows.length === 2 && exactUsageMatches && measuredEmptyGone, { usageStartsEmpty, usageRows, exactUsage, expectedLeaderUsage, expectedRunUsage, exactUsageMatches, measuredEmptyGone });
    const emptyMeters = $("meters").hidden && $("meters").children.length === 0;
    window.__socket.sendMessage({ type: "rateLimit", runId: "audit-parallel-1", windows: { fiveHour: { used: 640, limit: 1000 } } });
    const measuredMeter = [...document.querySelectorAll("#meters .meter .row b")].map((node) => node.textContent.trim());
    check("plan meters stay hidden without data and show the measured rateLimit", emptyMeters && !$("meters").hidden && measuredMeter.includes("64%"), { hiddenBeforeMeasurement: emptyMeters, visibleAfterMeasurement: !$("meters").hidden, measured: measuredMeter });

    const unsafeName = '<img src=x onerror="window.__ccXss()">';
    const renderedName = requireElement('#crew [data-seat-id="leader"] .name');
    check("server supplied seat text is rendered as text", renderedName.textContent === unsafeName && !renderedName.querySelector("img"), { text: renderedName.textContent, injectedImages: renderedName.querySelectorAll("img").length });

    const devTab = requireElement('#tabs [data-tab-id="alpha-dev"]');
    devTab.focus(); devTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await waitFor(() => window.__latestState?.selectedTabId === "alpha-design", "keyboard tab selection");
    check("tab arrow keys change server selection and retain focus", window.__latestState.selectedTabId === "alpha-design" && document.activeElement?.dataset.tabId === "alpha-design", { selectedTabId: window.__latestState.selectedTabId, focusedTabId: document.activeElement?.dataset.tabId, sent: window.__sent.filter((message) => message.type === "selectTab").at(-1) });
    await clickTab("Development");
    await waitFor(() => window.__received.some((message) => message.type === "chatHistory" && message.tabId === "alpha-dev"), "chatHistory server message");
    const transcript = document.querySelector('#view [data-message-id="1"]');
    check("chatHistory renders its server transcript", Boolean(transcript && transcript.textContent.includes("Saved transcript from the server")), { found: Boolean(transcript), messageId: transcript?.dataset.messageId ?? "missing", text: transcript?.textContent.trim() ?? "missing" });
    window.__ccHoldChatDone = true;
    $("ci").value = "Send this through the chat protocol"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-dev" && message.text === "Send this through the chat protocol"), "chat protocol send");
    const sentChat = window.__sent.filter((message) => message.type === "chat").at(-1);
    check("chat sends the current tab and message through the protocol", sentChat?.tabId === "alpha-dev" && sentChat.text === "Send this through the chat protocol", { sent: sentChat });
    await waitFor(() => window.__received.some((message) => message.type === "chatMessage" && message.revision === 2 && message.role === "user"), "chatMessage server echo");
    const echoed = document.querySelector('#view [data-message-id="2"] .bubble p');
    check("chatMessage updates the visible transcript", echoed?.textContent === "Send this through the chat protocol", { text: echoed?.textContent ?? "missing" });
    await waitFor(() => window.__received.some((message) => message.type === "chatDelta" && message.text === "The lead is answering."), "chatDelta server message");
    let streaming;
    await waitFor(() => (streaming = [...document.querySelectorAll("#view .thread .msg .body p")].find((node) => node.textContent === "The lead is answering.")), "chatDelta renders the live transcript");
    check("chatDelta renders the live transcript", Boolean(streaming), { text: streaming?.textContent ?? "missing" });
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "held chatDone");
    window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
    await waitFor(() => window.__received.some((message) => message.type === "chatDone"), "chatDone server message");
    const assistant = document.querySelector('#view [data-message-id="3"] .body p');
    check("chatDone clears streaming text and leaves the final message", Boolean(assistant) && assistant.textContent === "The lead replied." && $("chatStatus").hidden && ![...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent === "The lead is answering."), { text: assistant?.textContent ?? "missing", statusHidden: $("chatStatus").hidden });

    // The server sends no message id: a second turn in the same open tab must show both of its messages without reopening the tab.
    $("ci").value = "Second question in the same tab"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => [...document.querySelectorAll("#view .thread .msg .body p")].filter((node) => node.textContent === "The lead replied.").length === 2, "second turn reply without reopening the tab");
    const secondUser = [...document.querySelectorAll("#view .msg.mine .bubble p")].map((node) => node.textContent);
    check("a second chat turn shows both its message and the leader's reply without reopening the tab", secondUser.includes("Second question in the same tab") && secondUser.length === 2, { secondUser });

    // A finished message is rendered once (its first render replaces the text a few times: escape, then the formatting): later renders of the same server-shaped message (revision, no id) reuse the cached html.
    const cacheProbe = "cache probe marker 7731", realReplace = String.prototype.replace;
    let cacheProbeRenders = 0;
    String.prototype.replace = function (...args) { if (this.valueOf() === cacheProbe) cacheProbeRenders++; return realReplace.apply(this, args); };
    try {
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 40, role: "assistant", text: cacheProbe, at: Date.now() });
      const afterFirstRender = cacheProbeRenders;
      for (let again = 0; again < 3; again++) window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      check("a finished server-shaped message is rendered once and then served from the cache", afterFirstRender >= 1 && cacheProbeRenders === afterFirstRender && Boolean(document.querySelector('#view [data-message-id="40"]')), { afterFirstRender, cacheProbeRenders });
    } finally { String.prototype.replace = realReplace; }

    const view = $("view"); view.style.height = "220px"; view.style.flex = "none"; view.style.overflow = "auto";
    const longTranscript = Array.from({ length: 48 }, (_, index) => ({ id: `audit-scroll-${index}`, role: "assistant", text: `Earlier transcript line ${index}` }));
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-dev", messages: longTranscript });
    const maxBefore = view.scrollHeight - view.clientHeight;
    view.scrollTop = Math.max(0, maxBefore - 5);
    const readerPosition = view.scrollTop;
    window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: " Keep the reader's position." });
    await new Promise((resolve) => setTimeout(resolve, 150)); // deltas now paint once per frame
    const stayedAtReaderPosition = view.scrollTop === readerPosition;
    const maxAtEdge = view.scrollHeight - view.clientHeight;
    view.scrollTop = Math.max(0, maxAtEdge - 4);
    window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: " Follow the four-pixel edge." });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const maxAfterEdge = view.scrollHeight - view.clientHeight;
    const followedBottomAtThreshold = Math.abs(maxAfterEdge - view.scrollTop) <= 1;
    check("chat transcript keeps the reader position and sticks within four pixels", stayedAtReaderPosition && followedBottomAtThreshold && maxBefore > 0, { readerPosition, afterScrolledUpdate: stayedAtReaderPosition ? readerPosition : view.scrollTop, maxBefore, edgeDistance: 4, afterEdgeUpdate: view.scrollTop, maxAfterEdge, stayedAtReaderPosition, followedBottomAtThreshold });

    openSeatView("coder");
    const badge = text('#crew [data-seat-id="coder"] .cnt');
    const runTabs = [...document.querySelectorAll("#view [data-run-tab]")].map((node) => node.dataset.runTab);
    const runOutput = text('#view [data-output-run="audit-parallel-1"]');
    check("two parallel runs show the count badge and independent run tabs", badge === "2" && runTabs.length === 2 && runOutput.includes("real runner output 1"), { badge, runTabs, targetSeat: "coder", runOutput });
    const runFolderPath = latestTab("alpha-dev").runs.find((run) => run.runId === "audit-parallel-1").folderPath;
    check("Writes only inside shows the server's folderPath", text("#view .touched .file") === runFolderPath && Boolean(runFolderPath), { renderedFolder: text("#view .touched .file"), folderPath: runFolderPath });
    const first = requireElement('#view [data-stop-run]'); first.click();
    const stopRun = window.__sent.filter((message) => message.type === "killRun").at(-1);
    check("per-run stop sends only the selected run id", stopRun?.runId === first.dataset.stopRun, { requested: first.dataset.stopRun, sent: stopRun });
    // Stop seat comes before Stop all: once every live run of a seat is already stopping, its Stop seat button is disabled.
    requireElement("#stagehead [data-stop-seat]").click();
    const stopSeat = window.__sent.filter((message) => message.type === "stopSeat").at(-1);
    check("Stop seat sends the selected tab and seat", stopSeat?.tabId === "alpha-dev" && stopSeat.slot === "coder", { sent: stopSeat });
    $("stopAll").click();
    const stopAll = window.__sent.filter((message) => message.type === "stopAll").at(-1);
    check("Stop all sends the server action", Boolean(stopAll), { sent: stopAll });

    requireElement("#stagehead [data-run-seat]").click();
    $("runPrompt").value = "Audit the run request";
    $("runPrompt").dispatchEvent(new Event("input", { bubbles: true }));
    $("runStart").click();
    const runRequest = window.__sent.filter((message) => message.type === "run").at(-1);
    check("run sends the selected tab, seat and prompt", runRequest?.tabId === "alpha-dev" && runRequest.slot === "coder" && runRequest.prompt === "Audit the run request" && $("runModal").hidden, { sent: runRequest, closedOnRunAccepted: $("runModal").hidden });
    requireElement('#stagehead [data-run-view="history"]').click();
    const historyList = window.__sent.filter((message) => message.type === "historyList").at(-1);
    check("seat History requests its server log list", historyList?.seatKey === "alpha-dev.coder" && text("#view").includes("No runs yet"), { sent: historyList, view: text("#view").slice(0, 120) });
    const historyTimestamp = 1780000000000;
    const historyOutcome = { status: "failed", exitCode: 17 };
    window.__ccDeliver({ type: "historyList", seatKey: historyList.seatKey, runs: [{ timestamp: historyTimestamp, sizeBytes: 1536, outcome: historyOutcome }] });
    const historyRow = requireElement(`#view [data-history-timestamp="${historyTimestamp}"]`);
    const historyDate = new Date(historyTimestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const colorProbe = document.createElement("span"); colorProbe.style.color = "var(--failed)"; document.body.append(colorProbe);
    const failedColor = getComputedStyle(colorProbe).color; colorProbe.remove();
    const historyFields = historyRow.textContent.replace(/\s+/g, " ").trim();
    const historyDotMatchesOutcome = getComputedStyle(historyRow.querySelector(".rs")).backgroundColor === failedColor;
    const historyFieldsAreReal = historyFields.includes(historyDate) && historyFields.includes("failed") && historyFields.includes("exit 17") && historyFields.includes("1,536 B") && !historyFields.includes("Today") && !historyFields.includes("1m") && historyDotMatchesOutcome;
    historyRow.click();
    const historyRun = window.__sent.filter((message) => message.type === "historyRun").at(-1);
    window.__ccDeliver({ type: "historyRun", seatKey: historyList.seatKey, timestamp: historyTimestamp, output: "Persisted server run details", brief: "History browser check", totalBytes: 1536, outcome: historyOutcome });
    const historyOutput = text("#view .term pre");
    const historyDetail = text("#view .metarow");
    const detailHasActualFields = historyDetail.includes(historyDate) && historyDetail.includes("failed") && historyDetail.includes("exit 17") && historyDetail.includes("1,536 B") && !historyOutput.includes("[object Object]");
    check("historyRun requests and renders the selected server run", historyRun?.seatKey === historyList.seatKey && historyRun.timestamp === historyTimestamp && historyOutput.includes("Persisted server run details") && historyFieldsAreReal && detailHasActualFields, { requested: historyRun, output: historyOutput, historyFields, historyDate, historyDotMatchesOutcome, historyDetail, detailHasActualFields });
    requireElement('#stagehead [data-run-view="live"]').click();
    const requestCount = () => window.__sent.filter((message) => message.type === "historyList" && message.seatKey === historyList.seatKey).length;
    const beforeReopen = requestCount();
    requireElement('#stagehead [data-run-view="history"]').click();
    const reopenedHistory = requestCount() === beforeReopen + 1;
    const beforeFinish = requestCount();
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", seatKey: "alpha-dev.coder" });
    const refreshedOnFinish = requestCount() === beforeFinish + 1;
    const oldSocket = window.__socket; const beforeReconnect = requestCount();
    oldSocket.emit("close", {});
    await waitFor(() => window.__socket !== oldSocket && requestCount() > beforeReconnect, "History refresh after reconnect");
    const refreshedOnReconnect = requestCount() > beforeReconnect;
    check("History refreshes on reopen, run completion, and reconnect", reopenedHistory && refreshedOnFinish && refreshedOnReconnect, { reopenedHistory, refreshedOnFinish, refreshedOnReconnect, requests: requestCount(), beforeReconnect });

    // Theme and picture are the server's (a new window port is a new, empty localStorage): each choice is sent as a client pref and the server's echo is what the page then shows.
    const looksStart = window.__sent.length;
    $("setBtn").click(); requireElement('#setModal [data-theme="dark"]').click(); requireElement('#setModal [data-theme="light"]').click();
    $("meBtn").click(); requireElement('#avModal[aria-hidden="false"]');
    requireElement('#avgrid [data-avatar="pip"]').click();
    const looksSent = window.__sent.slice(looksStart).filter((message) => message.type === "updateClientPref" && ["theme", "avatar"].includes(message.key)).map((message) => message.key + "=" + message.value);
    await waitFor(() => window.__latestState.clientPrefs?.theme === "light" && window.__latestState.clientPrefs?.avatar === "pip.svg", "the server echoes the theme and picture");
    const appearanceWorks = document.body.classList.contains("light") && looksSent.includes("theme=dark") && looksSent.includes("theme=light");
    const avatarWorks = $("meImg").src.endsWith("/avatars/pip.svg") && looksSent.includes("avatar=pip.svg");
    pressEscape();
    check("theme and personal avatar choices stay usable", appearanceWorks && avatarWorks, { themeApplied: document.body.classList.contains("light"), looksSent, avatarApplied: $("meImg").src.endsWith("/avatars/pip.svg"), serverPrefs: { theme: window.__latestState.clientPrefs?.theme, avatar: window.__latestState.clientPrefs?.avatar }, storageBlocked: window.__ccStorageBlocked });

    const safetyState = structuredClone(window.__ccSeed);
    safetyState.launchSafety = { blocked: ["alpha-dev.coder", "alpha-dev.reviewer1"], uncertain: [{ seatId: "coder", seatKey: "alpha-dev.coder", runId: "audit-uncertain", pid: 4321 }], released: [], notices: [{ id: 41, pending: true, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "Audit launch notice" }] };
    window.__socket.sendMessage({ ...safetyState, type: "state" });
    openInbox();
    const reviewerSeat = latestTab("alpha-dev", safetyState).crew.find((seat) => seat.slot === "reviewer1");
    const warnings = [...document.querySelectorAll("#inboxList .safety-warning")].map((node) => node.textContent.trim());
    // Codex cannot enforce read-only, Claude can: the two cards of the blocked and unconfirmed Codex coder warn, the blocked Claude reviewer's card does not.
    const coderSeat = latestTab("alpha-dev", safetyState).crew.find((seat) => seat.slot === "coder");
    const warning = warnings.length === 2 && warnings.every((line) => line === `${coderSeat.name} runs on Codex, which cannot be held read-only. It can still write.`) && !warnings.some((line) => line.includes(reviewerSeat.name)) ? "The Codex coder is warned about, the Claude reviewer is not." : warnings.join(" | ");
    const releasePhrase = "release may leave a process running and editing files";
    const unblockInput = requireElement('[data-confirm-unblock="alpha-dev.coder"]');
    const releaseInput = requireElement('[data-confirm-release="audit-uncertain"]');
    const safetyStart = window.__sent.length;
    unblockInput.value = "allow this seat to launch again ";
    requireElement('[data-unblock="alpha-dev.coder"]').click();
    releaseInput.value = `${releasePhrase} `;
    requireElement('[data-release="audit-uncertain"]').click();
    const wrongPhrasesNotSent = !window.__sent.slice(safetyStart).some((message) => ["unblockSeat", "releaseUnconfirmed", "releaseUnconfirmedSeat"].includes(message.type));
    const wrongPhraseToastVisible = await waitToastVisible();
    unblockInput.value = "allow this seat to launch again";
    requireElement('[data-unblock="alpha-dev.coder"]').click();
    releaseInput.value = releasePhrase;
    requireElement('[data-release="audit-uncertain"]').click();
    requireElement('[data-retry-kill="audit-uncertain"]').click();
    requireElement('[data-ack-notice="41"]').click();
    const unblock = window.__sent.filter((message) => message.type === "unblockSeat").at(-1);
    const release = window.__sent.filter((message) => message.type === "releaseUnconfirmed").at(-1);
    const retryKill = window.__sent.filter((message) => message.type === "killRun").at(-1);
    const ack = window.__sent.filter((message) => message.type === "ackLaunchNotice").at(-1);
    check("wrong launch-safety phrases stay local and the exact typed phrases are sent", wrongPhrasesNotSent && wrongPhraseToastVisible && unblock?.confirm === unblockInput.value && release?.confirm === releaseInput.value && release.runId === "audit-uncertain" && retryKill?.runId === "audit-uncertain", { wrongPhrasesNotSent, wrongPhraseToastVisible, unblock, typedUnblockPhrase: unblockInput.value, release, typedReleasePhrase: releaseInput.value, retryKill });
    check("launch safety warns about a seat whose CLI cannot enforce read-only, and not about one that can", warning === "The Codex coder is warned about, the Claude reviewer is not." && ack?.id === 41, { warning, ack, warnedSeat: "alpha-dev.coder", enforcedSeat: "alpha-dev.reviewer1" });

    window.__ccDeliver({ type: "leaderLaunch", id: 9001, source: "Audit harness", seatName: "Coder", pending: true });
    window.__ccDeliver({ type: "runStalled", seatKey: "alpha-dev.coder" });
    window.__ccDeliver({ type: "runFinish", seatKey: "alpha-dev.coder" });
    const activityRows = [...document.querySelectorAll("#feed .ev")];
    const activityEntry = (textValue) => activityRows.find((row) => row.querySelector(".x")?.textContent === textValue);
    // A tab-scoped seat key now resolves to the seat's own name in the feed.
    const coderName = latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").name;
    const launchActivity = activityEntry("Audit harness requested Coder · outcome unconfirmed");
    const stallActivity = activityEntry(`${coderName} stalled`);
    const finishActivity = activityEntry(`${coderName} finished`);
    check("activity feed renders real launch, stall and completion events", Boolean(launchActivity && stallActivity && finishActivity) && launchActivity.querySelector(".d")?.classList.contains("waiting") && stallActivity.querySelector(".d")?.classList.contains("waiting") && finishActivity.querySelector(".d")?.classList.contains("done"), { rows: activityRows.map((row) => ({ text: row.querySelector(".x")?.textContent, type: row.querySelector(".d")?.className })) });

    const appBridge = window.cc;
    delete window.cc;
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    $("setBtn").click();
    requireElement('#setNav [data-settings-section="folders"]').click();
    const plainBrowserPickersHidden = $("folderBtn").hidden
      && !document.querySelector('#setBody [data-setting-action="folder-browse"]')
      && !document.querySelector('#setBody [data-setting-action="tab-folder-browse"]')
      && !document.querySelector('#setBody [data-setting-action="vault-browse"]');
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("plain browser hides Electron-only folder pickers", plainBrowserPickersHidden, { folderButtonHidden: $("folderBtn").hidden, defaultBrowse: Boolean(document.querySelector('#setBody [data-setting-action="folder-browse"]')), tabBrowse: Boolean(document.querySelector('#setBody [data-setting-action="tab-folder-browse"]')), vaultBrowse: Boolean(document.querySelector('#setBody [data-setting-action="vault-browse"]')) });
    window.cc = appBridge;
  };
  Object.assign(window.__ccHarness, { runFake });
})();
