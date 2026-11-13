(() => {
  const { check, text, $, requireElement, pressEscape, tabId, deliverSeed, sentSince, closeAll } = window.__ccHarness;
  const runPackThreeB = async (part) => {
    // Pack 7 on the fixed crew: a position the server reports busy keeps its model chip and open picker locked (the leader too); an idle one stays free.
    await part("model lock", async () => {
      const { fixed } = window.__ccHarness;
      const setBusy = (slot, busy) => fixed.setBusy(tabId, slot, busy);
      const chipOf = (slot) => requireElement(`#setBody section.fc[data-fc-tab="${tabId}"] [data-fc-row="${slot}"] [data-fc-model]`);
      const pickerButtons = () => [...document.querySelectorAll("#pop [data-model], #pop [data-effort], #pop [data-clear-model]")];
      const pickerFree = () => pickerButtons().length > 0 && pickerButtons().every((button) => !button.disabled) && !document.querySelector("#pop [data-picker-locked]");
      const pickerLocked = () => pickerButtons().length > 0 && pickerButtons().every((button) => button.disabled && button.getAttribute("aria-disabled") === "true") && /Locked while working\./.test(text("[data-picker-locked]", $("pop")));
      const assignSends = (from) => sentSince(from, "setCrewAssignment").length + sentSince(from, "clearCrewAssignment").length;
      const openSettings = () => { closeAll(); $("setBtn").click(); };
      const surfaceOf = (el) => el?.closest?.("#pop, #setModal") ?? null;
      const focusOk = (root) => { const active = document.activeElement; return Boolean(active) && active !== document.body && root.contains(active) && !active.disabled; };

      // Idle: the chip opens a free picker. Busy: both lock, a forced click sends nothing, the working note shows and an idle position stays free. Done: both unlock.
      for (const slot of ["coder", "leader"]) { setBusy(slot, false); }
      openSettings();
      const idleChip = !chipOf("coder").disabled;
      chipOf("coder").click();
      const idleOpen = !$("pop").hidden && pickerFree() && /Choose model and effort/.test($("pop").getAttribute("aria-label"));
      setBusy("coder", true);
      const lockedOpen = pickerLocked();
      const coderRow = chipOf("coder").closest("[data-fc-row]");
      const chipLocked = chipOf("coder").disabled && !coderRow.querySelector(".fc-busy").hidden && /Working now/.test(coderRow.querySelector(".fc-busy").textContent);
      const otherFree = !chipOf("reviewer1").disabled && chipOf("reviewer1").closest("[data-fc-row]").querySelector(".fc-busy").hidden;
      const from = window.__sent.length;
      const forced = pickerButtons()[0]; forced.disabled = false; forced.click();
      const forcedSent = assignSends(from);
      closeAll(); openSettings();
      setBusy("leader", true);
      const leaderLocked = chipOf("leader").disabled && !chipOf("leader").closest("[data-fc-row]").querySelector(".fc-busy").hidden;
      setBusy("leader", false); setBusy("coder", false);
      const unlockedChip = !chipOf("coder").disabled && !chipOf("leader").disabled;
      chipOf("coder").click();
      const unlockedPicker = pickerFree();
      check("a fixed Settings model chip and its open picker lock while the position is busy and unlock when it ends", idleChip && idleOpen && lockedOpen && chipLocked && otherFree && forcedSent === 0 && leaderLocked && unlockedChip && unlockedPicker, { idleChip, idleOpen, lockedOpen, chipLocked, otherFree, forcedSent, leaderLocked, unlockedChip, unlockedPicker });
      closeAll();

      // An open picker follows the lock both ways, searching a locked picker keeps its models locked, focus stays on an enabled control, and an unconfirmed stop locks the position until it is released.
      setBusy("coder", false); openSettings();
      chipOf("coder").click();
      setBusy("coder", true);
      const searchLocked = (() => { const first = pickerButtons().find((button) => button.matches("[data-model]")); if (!first) return false; $("mq").value = first.textContent.trim().slice(0, 2).toLowerCase(); $("mq").dispatchEvent(new Event("input", { bubbles: true })); const rows = [...document.querySelectorAll("#pop [data-model]")]; return rows.length > 0 && rows.every((button) => button.disabled && button.getAttribute("aria-disabled") === "true"); })();
      const searchSent = assignSends(from);
      setBusy("coder", false);
      const pickerUnlocked = pickerFree() && !chipOf("coder").disabled;
      closeAll(); setBusy("coder", false); openSettings();
      chipOf("coder").click();
      pickerButtons().find((button) => button.matches("[data-model]")).focus();
      setBusy("coder", true);
      const pickerFocus = focusOk($("pop")) && surfaceOf(document.activeElement) === $("pop");
      closeAll(); setBusy("coder", false); openSettings();
      chipOf("coder").focus();
      setBusy("coder", true);
      const chipFocus = Boolean(document.activeElement) && document.activeElement !== document.body && $("setModal").contains(document.activeElement); // the page leaves a locked chip focused inside Settings; the enabled-focus rule is held by the picker leg above and the Escape check below
      closeAll(); setBusy("coder", false);
      const safetyBefore = window.__ccSeed.launchSafety;
      const withRows = (uncertain) => { window.__ccSeed.launchSafety = { blocked: [], released: [], notices: [], uncertain }; deliverSeed(); };
      openSettings();
      setBusy("coder", true); withRows([{ seatId: `${tabId}.coder`, seatKey: `${tabId}.coder`, runId: "lock-uncertain", pid: 4242 }]);
      const uncertainLocked = chipOf("coder").disabled;
      withRows([]);
      const stillLockedUntilRelease = chipOf("coder").disabled;
      setBusy("coder", false);
      const uncertainReleased = !chipOf("coder").disabled;
      withRows([{ seatId: "coder", pid: 4343 }]);
      const rowAloneFree = !chipOf("coder").disabled; // an old row that names no position locks nothing
      closeAll(); window.__ccSeed.launchSafety = safetyBefore; deliverSeed();
      check("an open fixed picker and Settings chip unlock when work ends, locked search sends nothing, focus stays enabled, and an unconfirmed stop stays locked until released", searchLocked && searchSent === 0 && pickerUnlocked && pickerFocus && chipFocus && uncertainLocked && stillLockedUntilRelease && uncertainReleased && rowAloneFree, { searchLocked, searchSent, pickerUnlocked, pickerFocus, chipFocus, uncertainLocked, stillLockedUntilRelease, uncertainReleased, rowAloneFree });

      // Final review: Settings > chip > picker opens > the run starts (the chip disables) > Escape must not drop focus on the body.
      setBusy("coder", false); openSettings();
      chipOf("coder").click();
      const pickerOpened = !$("pop").hidden;
      setBusy("coder", true);
      pressEscape();
      const escActive = document.activeElement;
      check("Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body", pickerOpened && $("pop").hidden && !$("setModal").hidden && Boolean(escActive) && escActive !== document.body && $("setModal").contains(escActive) && !escActive.matches(":disabled"), { pickerOpened, setHidden: $("setModal").hidden, popHidden: $("pop").hidden, active: escActive?.tagName, id: escActive?.id });
      closeAll(); setBusy("coder", false);
    });
  };
  Object.assign(window.__ccHarness, { runPackThreeB });
})();
