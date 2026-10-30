(() => {
  const { check, text, $, requireElement, openSeatCard, pressEscape, tabId, seedTab, deliverSeed, sentSince, closeAll, coderName } = window.__ccHarness;
  const runPackThreeB = async (part) => {
    // The pencil on a seat card.
    await part("seat rename", async () => {
      const name = coderName();
      openSeatCard("coder");
      requireElement("[data-seat-rename]", $("seatPop")).click();
      const opened = !$("renameModal").hidden && $("renameInput").value === name && $("renameTitle").textContent === `Rename ${name}`;
      let from = window.__sent.length;
      $("renameInput").value = "Renamed coder";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const renamed = sentSince(from, "updateSeat");
      const closed = $("renameModal").hidden;
      openSeatCard("coder");
      requireElement("[data-seat-rename]", $("seatPop")).click();
      from = window.__sent.length;
      $("renameInput").value = "Discarded name";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      const discarded = sentSince(from, "updateSeat").length === 0 && $("renameModal").hidden;
      check("the seat card's pencil renames the seat: Enter sends updateSeat with the new name, Escape sends nothing", opened && renamed.length === 1 && renamed[0].tabId === tabId && renamed[0].slot === "coder" && renamed[0].name === "Renamed coder" && closed && discarded, { opened, renamed, closed, discarded });
    });

    // Pack 7: a crew seat with a working run keeps its model, effort and CLI; the leader never locks.
    await part("model lock", async () => {
      const setWorking = (working) => {
        const tab = seedTab();
        tab.runs = (tab.runs ?? []).filter((run) => run.runId !== "lock-run" && !(run.seatSlotId === "coder" && run.status === "working"));
        if (working) tab.runs.push({ runId: "lock-run", id: "lock-run", status: "working", seatIsLeader: false, crewGenerationId: tab.processState?.crewGenerationId, seatName: coderName(), seatSlotId: "coder", seatKey: "alpha-dev.coder", label: "Locked build", startedAt: Date.now() });
        deliverSeed();
      };
      const pickerButtons = () => [...document.querySelectorAll("#pop [data-model], #pop [data-effort]")];
      // In Settings a seat's model button is in its card in the crew editor, opened from its row (an open card is left open).
      const settingsModel = (slot) => { const row = requireElement(`#setModal [data-se-row="${slot}"]`); if (row.getAttribute("aria-expanded") !== "true") row.click(); return requireElement(`#setModal [data-se-model="${slot}"]`); };
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      const idleOpen = pickerButtons().length > 0 && pickerButtons().every((button) => !button.disabled) && !document.querySelector("#pop [data-picker-locked]") && /Applies to the next run/.test($("pop").textContent);
      setWorking(true);
      const lockedButtons = pickerButtons();
      const pickerLocked = lockedButtons.length > 0 && lockedButtons.every((button) => button.disabled && button.getAttribute("aria-disabled") === "true") && /Locked while working./.test(text("[data-picker-locked]", $("pop")));
      let from = window.__sent.length;
      lockedButtons[0].click();
      const pickerSent = sentSince(from, "updateSeat").length;
      closeAll();
      const card = openSeatCard("coder"), row = requireElement("[data-seat-model]", card);
      const cardLocked = row.disabled && row.getAttribute("aria-disabled") === "true" && /Model, effort and tool can change when its runs finish./.test(row.title) && /Locked while working/.test(card.textContent);
      from = window.__sent.length; row.click();
      const rowOpened = !$("pop").hidden || sentSince(from, "updateSeat").length > 0;
      closeAll(); $("setBtn").click();
      const chip = settingsModel("coder");
      const settingsLocked = chip.disabled && chip.getAttribute("aria-disabled") === "true" && /Locked while working/.test(chip.closest(".se-card").textContent);
      closeAll();
      requireElement("[data-seat-model]", openSeatCard("leader"));
      const leaderFree = !requireElement("[data-seat-model]", $("seatPop")).disabled && !/Locked while working/.test($("seatPop").textContent);
      closeAll();
      setWorking(false);
      const open = openSeatCard("coder");
      const unlocked = !requireElement("[data-seat-model]", open).disabled && !/Locked while working/.test(open.textContent);
      closeAll();
      check("a working crew seat's Model row, open picker and Settings button lock with Locked while working, the leader never locks, and they unlock when the run ends", idleOpen && pickerLocked && pickerSent === 0 && cardLocked && !rowOpened && settingsLocked && leaderFree && unlocked, { idleOpen, pickerLocked, pickerSent, cardLocked, rowOpened, settingsLocked, leaderFree, unlocked });
      // Round 1: open surfaces follow the lock both ways without reopening, searching while locked keeps the models locked, and focus never falls to the page body.
      const surfaceOf = (el) => el?.closest?.("#pop, #seatPop, #setModal") ?? null;
      const focusOk = (root) => { const active = document.activeElement; return Boolean(active) && active !== document.body && root.contains(active) && !active.disabled; };
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      setWorking(true);
      const searchLocked = (() => { const first = pickerButtons().find((button) => button.matches("[data-model]")); if (!first) return false; $("mq").value = first.textContent.trim().slice(0, 2).toLowerCase(); $("mq").dispatchEvent(new Event("input", { bubbles: true })); const rows = [...document.querySelectorAll("#pop [data-model]")]; return rows.length > 0 && rows.every((button) => button.disabled && button.getAttribute("aria-disabled") === "true"); })();
      setWorking(false);
      const pickerUnlocked = pickerButtons().length > 0 && pickerButtons().every((button) => !button.disabled) && !document.querySelector("#pop [data-picker-locked]");
      closeAll();
      setWorking(false);
      const openCard = openSeatCard("coder");
      const cardWasFree = !requireElement("[data-seat-model]", openCard).disabled;
      setWorking(true);
      const cardLockedOpen = requireElement("[data-seat-model]", $("seatPop")).disabled;
      setWorking(false);
      const cardUnlockedOpen = !requireElement("[data-seat-model]", $("seatPop")).disabled && !/Locked while working/.test($("seatPop").textContent);
      closeAll();
      $("setBtn").click();
      const settingsWasFree = !settingsModel("coder").disabled;
      setWorking(true);
      const settingsLockedOpen = settingsModel("coder").disabled;
      setWorking(false);
      const settingsUnlockedOpen = !settingsModel("coder").disabled && !/Locked while working/.test(settingsModel("coder").closest(".se-card").textContent);
      closeAll();
      // Focus on a model button / the Model row / the Settings chip when the run starts.
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      pickerButtons().find((button) => button.matches("[data-model]")).focus();
      setWorking(true);
      const pickerFocus = focusOk($("pop")) && surfaceOf(document.activeElement) === $("pop");
      closeAll(); setWorking(false);
      openSeatCard("coder"); requireElement("[data-seat-model]", $("seatPop")).focus();
      setWorking(true);
      const cardFocus = focusOk($("seatPop"));
      closeAll(); setWorking(false);
      $("setBtn").click(); settingsModel("coder").focus();
      setWorking(true);
      const settingsFocus = focusOk($("setModal"));
      closeAll(); setWorking(false);
      // An unconfirmed stop locks the seat on the page too; an old row that names no seat locks nothing.
      const safetyBefore = window.__ccSeed.launchSafety;
      const withRows = (uncertain) => { window.__ccSeed.launchSafety = { blocked: [], released: [], notices: [], uncertain }; deliverSeed(); };
      withRows([{ seatId: `${tabId}.coder`, seatKey: `${tabId}.coder`, runId: "lock-uncertain", pid: 4242 }]);
      const uncertainCard = openSeatCard("coder");
      const uncertainLocked = requireElement("[data-seat-model]", uncertainCard).disabled && /Locked while working/.test(uncertainCard.textContent);
      withRows([]);
      const uncertainReleased = !requireElement("[data-seat-model]", $("seatPop")).disabled;
      withRows([{ seatId: "coder", pid: 4343 }]);
      const legacyFree = !requireElement("[data-seat-model]", $("seatPop")).disabled;
      closeAll(); window.__ccSeed.launchSafety = safetyBefore; deliverSeed();
      check("an open picker, seat card and Settings unlock when the run ends, searching a locked picker keeps its models locked, focus stays inside the surface when its control locks, and an unconfirmed stop locks the seat until released", searchLocked && pickerUnlocked && cardWasFree && cardLockedOpen && cardUnlockedOpen && settingsWasFree && settingsLockedOpen && settingsUnlockedOpen && pickerFocus && cardFocus && settingsFocus && uncertainLocked && uncertainReleased && legacyFree, { searchLocked, pickerUnlocked, cardWasFree, cardLockedOpen, cardUnlockedOpen, settingsWasFree, settingsLockedOpen, settingsUnlockedOpen, pickerFocus, cardFocus, settingsFocus, uncertainLocked, uncertainReleased, legacyFree });
      // Final review: Settings > chip > picker opens > the run starts (the chip disables) > Escape must not drop focus on the body.
      setWorking(false); $("setBtn").click();
      settingsModel("coder").click();
      const pickerOpened = !$("pop").hidden;
      setWorking(true);
      pressEscape();
      const escActive = document.activeElement;
      check("Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body", pickerOpened && $("pop").hidden && !$("setModal").hidden && Boolean(escActive) && escActive !== document.body && $("setModal").contains(escActive) && !escActive.matches(":disabled"), { pickerOpened, setHidden: $("setModal").hidden, popHidden: $("pop").hidden, active: escActive?.tagName, id: escActive?.id });
      closeAll(); setWorking(false);
    });
  };
  Object.assign(window.__ccHarness, { runPackThreeB });
})();
