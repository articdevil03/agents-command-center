(() => {
  const { check, text, $, requireElement, installTenSecondClock, latestTab, openInbox, sleep, tabId, deliverSeed, sentSince, STOP_CONFIRM, coderName } = window.__ccHarness;
  const runPackThreeA = async (part) => {
    // The fake clock the Undo tests use hands out ids: they must never be ids a real timer has, or clearing a real timer would drop a fake one.
    await part("fake clock", async () => {
      const realCleared = []; const wrapped = window.clearTimeout;
      window.clearTimeout = (id) => { realCleared.push(id); return wrapped.call(window, id); }; // stands in for the page's own clearTimeout, which the clock captures
      const fired = [];
      let ids;
      try {
        const clock = installTenSecondClock();
        const fakeId = window.setTimeout(() => fired.push("fake"), 5000);
        const realId = window.setTimeout(() => fired.push("real"), 200);
        const fakeOther = window.setTimeout(() => fired.push("fakeOther"), 6000);
        window.clearTimeout(realId); // clearing the REAL timer must leave the fake ones alone
        window.clearTimeout(fakeOther); // and clearing a fake one must really remove it
        await clock.advance(7000);
        await sleep(300);
        const stale = window.setTimeout(() => fired.push("stale"), 6000);
        clock.restore();
        const before = realCleared.length;
        window.clearTimeout(stale); // a fake id the page still holds after restore
        const reachedReal = realCleared.slice(before);
        const control = window.setTimeout(() => {}, 1_000_000); // a real timer cleared after restore does reach the real clearTimeout
        window.clearTimeout(control);
        ids = { fakeId, realId, fakeOther, stale, control, reachedReal, afterControl: realCleared.slice(before), fired };
        check("the fake clock's ids are never the positive integers real timers use, clearing a real timer leaves a fake one alone, and a fake id never reaches the real clearTimeout after restore",
          Number.isInteger(realId) && realId > 0 && [fakeId, fakeOther, stale].every((id) => !(Number.isInteger(id) && id > 0)) && new Set([fakeId, fakeOther, stale]).size === 3
          && fired.join() === "fake" && reachedReal.length === 0 && ids.afterControl.length === 1 && ids.afterControl[0] === control, ids);
      } finally { window.clearTimeout = wrapped; }
    });

    // Needs you: several unconfirmed stops of one seat get a Release all button next to each one's own.
    await part("Release all", async () => {
      window.__ccSeed.launchSafety = { blocked: [], released: [], notices: [], uncertain: [
        { seatId: "coder", seatKey: "alpha-dev.coder", runId: "rel-1", pid: 5101 }, { seatId: "coder", seatKey: "alpha-dev.coder", runId: "rel-2", pid: 5102 }, { seatId: "reviewer1", seatKey: "alpha-dev.reviewer1", runId: "rel-3", pid: 5103 },
      ] };
      deliverSeed(); openInbox();
      const labels = [...document.querySelectorAll("#inboxList [data-release-all]")].map((button) => button.textContent.trim());
      const loneSeatHasNone = !document.querySelector('#inboxList [data-release-ref="rel-3"]');
      const from = window.__sent.length;
      requireElement('#inboxList [data-confirm-release="rel-1"]').value = "release it";
      requireElement('#inboxList [data-release-all][data-release-ref="rel-1"]').click();
      const wrongSent = sentSince(from, "releaseUnconfirmedSeat").length;
      const wrongToast = /to release them/.test($("toast").textContent);
      requireElement('#inboxList [data-confirm-release="rel-1"]').value = STOP_CONFIRM;
      requireElement('#inboxList [data-release-all][data-release-ref="rel-1"]').click();
      const sent = sentSince(from, "releaseUnconfirmedSeat");
      check("Needs you offers Release all N for a seat with several unconfirmed stops, refuses a wrong phrase, and sends one releaseUnconfirmedSeat with the typed phrase",
        labels.length === 2 && labels.every((label) => label === `Release all 2 for ${coderName()}`) && loneSeatHasNone && wrongSent === 0 && wrongToast && sent.length === 1 && sent[0].seatId === "alpha-dev.coder" && sent[0].confirm === STOP_CONFIRM, { labels, loneSeatHasNone, wrongSent, wrongToast, sent });
    });

    // A failed Save is a card in Needs you with its own Retry save.
    await part("Retry save", async () => {
      window.__ccDeliver({ type: "error", action: "save", tabId, message: "Save failed in the pack 3 test" });
      openInbox();
      const card = [...document.querySelectorAll("#inboxList .ncard.bad")].find((node) => text("b", node) === "Save failed");
      const button = card?.querySelector(`[data-save-tab="${tabId}"]`);
      const shown = { label: button?.textContent.trim(), reason: card?.querySelector("p")?.textContent };
      const from = window.__sent.length;
      button?.click();
      const save = sentSince(from, "save");
      const closed = $("inboxPop").hidden;
      openInbox();
      const gone = !document.querySelector("#inboxList [data-save-tab]");
      check("a failed Save shows a Retry save card in Needs you; its button closes Needs you and sends save for that tab, and the card is gone once the save lands",
        shown.label === "Retry save" && shown.reason === "Save failed in the pack 3 test" && save.length === 1 && save[0].tabId === tabId && closed && gone, { shown, save, closed, gone });
    });

    // A stalled run's card can stop that run: the coder holds one live run and one retained unconfirmed record, both stalled, and a targeted Stop leaves the other record as it was.
    await part("stalled Stop", async () => {
      window.__ccHarness.fixed.seedLiveAndRetainedRecords(tabId, "coder");
      const stalled = structuredClone(window.__ccSeed);
      for (const run of latestTab(tabId, stalled).runs.filter((item) => item.status === "working")) run.stalled = true;
      window.__ccDeliver({ ...stalled, type: "state" });
      openInbox();
      const cardOf = (runId) => requireElement(`#inboxList [data-stop-run="${runId}"]`).closest(".ncard");
      const cards = [...document.querySelectorAll("#inboxList .ncard.bad")].filter((card) => card.textContent.includes("run stalled"));
      const otherBefore = cardOf("audit-parallel-2").textContent;
      const from = window.__sent.length;
      requireElement('#inboxList [data-stop-run="audit-parallel-1"]').click();
      const kills = sentSince(from, "killRun");
      const otherStillLive = !requireElement('#inboxList [data-stop-run="audit-parallel-2"]').disabled;
      const otherSame = cardOf("audit-parallel-2").textContent === otherBefore;
      check("a stalled run's card has a Stop this run button that sends killRun for that run only", cards.length === 2 && kills.length === 1 && kills[0].runId === "audit-parallel-1" && otherStillLive && otherSame, { cards: cards.length, kills, otherStillLive, otherSame });
    });
  };
  Object.assign(window.__ccHarness, { runPackThreeA });
})();
