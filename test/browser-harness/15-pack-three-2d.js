(() => {
  const { check, waitFor, text, $, requireElement, openTabMenu, clickMenuItem, showChat, openSeatView, openSeatCard, openInbox, pressEscape, confirmIfAsked, sleep, tabId, seedTab, deliverSeed, sentSince, UNBLOCK_CONFIRM } = window.__ccHarness;
  const runPackThreeD = async (part) => {
    // Enter in the message box.
    await part("IME Enter", async () => {
      showChat();
      $("ci").value = "text typed with an input method"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      const from = window.__sent.length, receivedFrom = window.__received.length; // the two lists grow differently: each keeps its own start
      const press = (init) => { const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }); $("ci").dispatchEvent(event); return event.defaultPrevented; };
      const composing = press({ isComposing: true }), imeKey = press({ keyCode: 229 }), shifted = press({ shiftKey: true });
      await sleep(150); // sending is asynchronous: give a wrongly accepted Enter time to show up
      const heldBack = sentSince(from, "chat").length === 0;
      const plain = press({});
      await waitFor(() => sentSince(from, "chat").length > 0, "the plain Enter is sent");
      await sleep(100);
      const sent = sentSince(from, "chat");
      await waitFor(() => window.__received.slice(receivedFrom).some((message) => message.type === "chatDone" && message.tabId === sent[0].tabId), "the reply to the plain Enter");
      check("Enter sends the message, but not while an input method is composing or with Shift held",
        heldBack && !composing && !imeKey && !shifted && plain && sent.length === 1 && sent[0].text === "text typed with an input method", { composing, imeKey, shifted, plain, heldBack, sent });
    });

    // The empty chat's three suggestions.
    await part("suggestion chips", async () => {
      showChat();
      const chips = () => [...document.querySelectorAll("#view [data-suggest]")];
      let revision = 0;
      const emptyChat = () => window.__ccDeliver({ type: "chatCleared", tabId, messages: [], revision: ++revision, savedRevision: 0 });
      // While a reply runs the welcome (and its chips) is not drawn at all; while a Save is waiting for its answer the chips are drawn and cannot be pressed.
      window.__ccSaveDeferred = true; $("saveBtn").click(); emptyChat();
      const lockedWhileSaving = chips().length === 3 && chips().every((chip) => chip.disabled);
      window.__ccDeliver({ type: "saved", tabId, revision, savedRevision: revision }); window.__ccSaveDeferred = false; emptyChat();
      const labels = chips().map((chip) => chip.textContent);
      const idle = chips().every((chip) => !chip.disabled);
      const from = window.__sent.length, receivedFrom = window.__received.length; // the two lists grow differently: each keeps its own start
      chips()[1].click();
      await waitFor(() => sentSince(from, "chat").length > 0, "the chip is sent");
      await sleep(100);
      const sent = sentSince(from, "chat");
      await waitFor(() => window.__received.slice(receivedFrom).some((message) => message.type === "chatDone" && message.tabId === sent[0].tabId), "the reply to the chip");
      check("the empty chat's suggestion chips send their own text, and cannot be pressed while a Save is waiting for its answer",
        labels.join("|") === "Where did we leave off?|What is left?|What should we build next?" && idle && lockedWhileSaving && sent.length === 1 && sent[0].text === "What is left?" && sent[0].tabId === tabId, { labels, idle, lockedWhileSaving, sent });
    });

    // The Disconnected banner.
    await part("Retry now", async () => {
      const old = window.__socket; const states = window.__states.length;
      // The page's own reconnect timer (a second or more) must not be what reconnects: such timers are swallowed here, so only the button can.
      const nativeSetTimeout = window.setTimeout; window.setTimeout = (callback, delay, ...args) => (Number(delay) >= 500 ? 0 : nativeSetTimeout(callback, delay, ...args));
      let banner;
      try {
        old.emit("close", {});
        banner = { hidden: $("conn").hidden, off: $("conn").classList.contains("off"), text: $("conn").textContent };
        requireElement("#conn [data-reconnect]").click();
        await waitFor(() => window.__socket !== old && window.__socket.readyState === 1 && window.__states.length > states, "a new connection and its state");
      } finally { window.setTimeout = nativeSetTimeout; }
      check("Retry now on the Disconnected banner opens a new connection at once", !banner.hidden && banner.off && /Disconnected\. Reconnecting in/.test(banner.text) && $("conn").hidden, { banner, hiddenAfter: $("conn").hidden });
    });

    // The screenshot viewer's Prev, Next and Fit.
    await part("screenshot viewer", async () => {
      const shots = ["C:/shots/one.png", "C:/shots/two.png", "C:/shots/three.png"];
      window.__ccDeliver({ type: "chatHistory", tabId, messages: [{ id: "p3-shots", role: "user", text: "three pictures", images: shots, at: Date.now(), revision: 1 }], revision: 1, savedRevision: 1 });
      requireElement("#view [data-open-shot]").click();
      requireElement('#viewer[aria-hidden="false"]');
      const bar = () => ({ title: text("#viewerFiles .bar2 b"), count: text("#viewerFiles .bar2 span:not(.spacer)"), prev: requireElement('#viewerFiles [data-shot-step="-1"]').disabled, next: requireElement('#viewerFiles [data-shot-step="1"]').disabled, fit: requireElement("#viewerFiles [data-shot-fit]").textContent.trim(), pressed: requireElement("#viewerFiles [data-shot-fit]").getAttribute("aria-pressed"), actual: Boolean(document.querySelector("#viewerFiles figure.actual")) });
      const first = bar();
      requireElement('#viewerFiles [data-shot-step="1"]').click(); const second = bar();
      requireElement('#viewerFiles [data-shot-step="1"]').click(); const third = bar();
      requireElement('#viewerFiles [data-shot-step="-1"]').click(); const back = bar();
      requireElement("#viewerFiles [data-shot-fit]").click(); const actual = bar();
      requireElement("#viewerFiles [data-shot-fit]").click(); const fitted = bar();
      check("the screenshot viewer's Prev, Next and Fit buttons step through the pictures, disable at the ends and toggle the size",
        first.title === "one.png" && first.count === "1 of 3" && first.prev && !first.next && second.title === "two.png" && second.count === "2 of 3" && !second.prev && !second.next
        && third.title === "three.png" && third.count === "3 of 3" && !third.prev && third.next && back.title === "two.png" && back.count === "2 of 3"
        && first.fit === "Actual size" && first.pressed === "false" && !first.actual && actual.fit === "Fit to window" && actual.pressed === "true" && actual.actual && fitted.fit === "Actual size" && fitted.pressed === "false" && !fitted.actual, { first, second, third, back, actual, fitted });
    });

    // A run's live log.
    await part("live output", async () => {
      openSeatView("coder");
      const pre = () => requireElement('#view [data-output-run="audit-parallel-1"]'), jump = () => requireElement("#view [data-jump-log]");
      const lines = (from, to) => Array.from({ length: to - from }, (_, index) => `\nstreamed line ${from + index}`).join("");
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: lines(0, 150) });
      const nearEnd = () => pre().scrollHeight - pre().scrollTop - pre().clientHeight < 24;
      const followed = { scrolls: pre().scrollHeight > pre().clientHeight, atEnd: nearEnd(), jumpHidden: jump().hidden, endsWith: pre().textContent.endsWith("streamed line 149") };
      pre().scrollTop = 0; pre().dispatchEvent(new Event("scroll"));
      const readerUp = { jumpShown: !jump().hidden };
      const textBefore = pre().textContent.length;
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: lines(150, 160) });
      const stayed = { top: pre().scrollTop, grew: pre().textContent.length > textBefore, jumpShown: !jump().hidden, endsWith: pre().textContent.endsWith("streamed line 159") };
      jump().click();
      const jumped = { atEnd: nearEnd(), jumpHidden: jump().hidden };
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: "\nafter the jump" });
      const following = { atEnd: nearEnd(), endsWith: pre().textContent.endsWith("after the jump") };
      check("live output appends to the open run's log, follows the end, stays put when the reader scrolled up, and Jump to latest returns to the end",
        followed.scrolls && followed.atEnd && followed.jumpHidden && followed.endsWith && readerUp.jumpShown && stayed.top === 0 && stayed.grew && stayed.jumpShown && stayed.endsWith && jumped.atEnd && jumped.jumpHidden && following.atEnd && following.endsWith, { followed, readerUp, stayed, jumped, following });
    });

    // Watch on a run row of the seat card.
    await part("Watch a run", async () => {
      openSeatView("coder");
      requireElement("#view [data-seat-more]").click();
      const rows = [...document.querySelectorAll("#seatPop [data-watch-run]")].map((button) => button.dataset.watchRun);
      showChat();
      pressEscape();
      openSeatCard("coder");
      requireElement('#seatPop [data-watch-run="audit-parallel-2"]').click();
      const selected = document.querySelector('#view [data-run-tab][aria-selected="true"]')?.dataset.runTab;
      check("the seat card's Watch on a run opens that run in the work view", rows.join() === "audit-parallel-1,audit-parallel-2" && $("seatPop").hidden && Boolean(document.querySelector("#stagehead.wv")) && selected === "audit-parallel-2" && text('#view [data-output-run="audit-parallel-2"]') === "real runner output 2", { rows, selected, cardHidden: $("seatPop").hidden });
    });

    // Allow again inside the Run dialog.
    await part("Run dialog Allow again", async () => {
      window.__ccSeed.launchSafety = { blocked: [`${tabId}.coder`], uncertain: [], released: [], notices: [] }; deliverSeed();
      openSeatView("coder");
      requireElement("#stagehead [data-run-seat]").click();
      const shown = Boolean(document.querySelector("#runBlk [data-run-unblock]")) && /Allow .* again to start it/.test(text("#runBlk"));
      let from = window.__sent.length;
      window.__ccConfirmResult = false;
      requireElement("#runBlk [data-run-unblock]").click();
      const asked = !$("confirmModal").hidden && $("confirmPhrase").dataset.phrase === UNBLOCK_CONFIRM;
      confirmIfAsked();
      const cancelled = sentSince(from, "unblockSeat").length === 0;
      window.__ccConfirmResult = true;
      requireElement("#runBlk [data-run-unblock]").click();
      confirmIfAsked();
      const sent = sentSince(from, "unblockSeat");
      check("Allow again in the Run dialog asks for the typed phrase, then sends unblockSeat; cancelling sends nothing", shown && asked && cancelled && sent.length === 1 && sent[0].seatKey === `${tabId}.coder` && sent[0].confirm === UNBLOCK_CONFIRM, { shown, asked, cancelled, sent });
    });

    // The first-project screen.
    await part("first-project screen", async () => {
      const noProjects = { ...structuredClone(window.__ccSeed), projects: [], type: "state" };
      noProjects.settings.tools = { claude: { installed: true, version: "2.1.0", signedIn: false }, codex: { installed: true, version: "0.1.0", signedIn: true }, opencode: { installed: false, version: null, signedIn: null }, gemini: { installed: false, version: null, signedIn: null } };
      window.__ccDeliver(noProjects);
      const shown = !$("first").hidden;
      const setups = $("first").querySelectorAll("[data-first-setup]").length;
      requireElement("[data-first-project]", $("first")).click();
      const projectOpen = $("projModal").getAttribute("aria-hidden") === "false";
      pressEscape();
      requireElement("[data-first-setup]", $("first")).click();
      const settingsOpen = $("setModal").getAttribute("aria-hidden") === "false";
      const onTools = requireElement("#setNav [aria-current=true]").dataset.settingsSection;
      check("the first-project screen's New project opens the project dialog and each Set up opens Settings on AI tools", shown && setups === 3 && projectOpen && $("projModal").hidden && settingsOpen && onTools === "tools", { shown, setups, projectOpen, settingsOpen, onTools });
    });

    // The tab menu's Rename.
    await part("Rename tab", async () => {
      clickMenuItem(openTabMenu(tabId), "Rename");
      const opened = !$("renameModal").hidden && $("renameInput").value === seedTab().name;
      const from = window.__sent.length;
      $("renameInput").value = "Renamed tab";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const sent = sentSince(from, "renameTab");
      check("Rename tab in the tab menu sends renameTab with the new name", opened && sent.length === 1 && sent[0].tabId === tabId && sent[0].name === "Renamed tab" && $("renameModal").hidden, { opened, sent });
    });

    // Launch records in Needs you.
    await part("Acknowledge all", async () => {
      window.__ccSeed.launchSafety = { blocked: [], uncertain: [], released: [], notices: [
        { id: 91, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "first record", pending: false },
        { id: 92, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "second record", pending: false },
        { id: 93, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "still unconfirmed", pending: true },
      ] };
      deliverSeed(); openInbox();
      const heading = text("#inboxRecords .grp.row span");
      const from = window.__sent.length;
      requireElement("#inboxRecords [data-ack-all]").click();
      const sent = sentSince(from, "ackLaunchNotices");
      check("Acknowledge all sends ackLaunchNotices for the finished launch records only", /^Launch records · 2$/.test(heading) && sent.length === 1 && sent[0].ids.join() === "91,92", { heading, sent });
    });
  };
  Object.assign(window.__ccHarness, { runPackThreeD });
})();
