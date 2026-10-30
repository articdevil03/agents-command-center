// Command Center page script, part 3 of 12: applying a server state. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  // Server-confirmed facts settle the client-side waits: a new tab or project appearing, a preset picture saved, a Save confirmed after a reconnect, every stopped run exiting.
  function settleFromState() {
    // The next step's button appears in the same spot as the one just clicked: it ignores clicks for a moment so a fast multi-click cannot walk several steps.
    // The guard starts when the step (or look approval) of a tab with a sent step action actually changes, however late that state arrives.
    const seen = new Set();
    for (const { tab } of allTabs()) {
      seen.add(tab.id);
      const steps = tab.derived?.stepBar ?? [], signature = `${steps.findIndex((step) => step.state === "current")}|${tab.processState?.approval?.state ?? ""}|${tab.processState?.phase ?? ""}|${tab.processState?.round ?? ""}|${tab.processState?.selectedFixer ?? ""}`;
      const moved = tabStepSignature.has(tab.id) && tabStepSignature.get(tab.id) !== signature;
      if (moved && stepActionSent.delete(tab.id)) stepClickGuard.set(tab.id, Date.now() + STEP_CLICK_GUARD_MS);
      tabStepSignature.set(tab.id, signature);
      // A step button stays "Sending…" until the server's state shows the step moved (or its refusal arrives, or a few seconds pass): a state that
      // was already on its way when the button was clicked must not turn it back on before the server has acted, or a double-click skips a step.
      if (processPending.has(tab.id) && (moved || Date.now() - (processPendingSince.get(tab.id) ?? 0) > PROCESS_PENDING_MS)) { processPending.delete(tab.id); processPendingSince.delete(tab.id); }
    }
    for (const tabId of [...tabStepSignature.keys()]) if (!seen.has(tabId)) { tabStepSignature.delete(tabId); stepActionSent.delete(tabId); }
    for (const tabId of [...processPending.keys()]) if (!seen.has(tabId)) { processPending.delete(tabId); processPendingSince.delete(tabId); }
    if (pendingCreate?.kind === "tab") {
      const project = findProject(pendingCreate.projectId);
      const added = project?.tabs.find((tab) => !pendingCreate.knownTabIds.has(tab.id));
      if (added) { pendingCreate = null; updateCreateButtons(); closeLayerOf($("modal")); showToast(`${added.name} tab created`); }
    } else if (pendingCreate?.kind === "project") {
      const added = findProject(pendingCreate.id);
      if (added) { pendingCreate = null; updateCreateButtons(); closeLayerOf($("projModal")); showToast(`${added.name} created`); }
    }
    if (pendingCreate?.dropped && connState === "on") {
      const statusId = pendingCreate.kind === "tab" ? "tStat" : "npStat";
      pendingCreate = null;
      $(statusId).textContent = "Not sure it was created. Check the tabs, then try again"; $(statusId).classList.add("bad");
      updateCreateButtons();
    }
    if (avatarPending) {
      const seat = seatFor(findTab(avatarPending.tabId), avatarPending.slot);
      if (!seat) avatarPending = null;
      else if (seat.pic === avatarPending.pic) { avatarPending = null; if ($("avatarStatus")) { $("avatarStatus").textContent = ""; $("avatarStatus").dataset.status = "done"; } }
    }
    for (const [tabId, state] of saveStates) {
      const tab = findTab(tabId);
      if (!tab) { saveStates.delete(tabId); continue; }
      if (state.status !== "unknown" || connState !== "on") continue;
      if (Number.isSafeInteger(state.startRevision) && Number.isSafeInteger(tab.savedRevision) && tab.savedRevision >= state.startRevision && tab.savedRevision > (state.startSavedRevision ?? 0)) {
        saveStates.delete(tabId); recordActivity("Save confirmed after reconnecting", "done", tabId); showToast(`${tab.name}: the handover save was confirmed`);
      } else saveStates.set(tabId, { ...state, checking: false, message: "The connection dropped before the server confirmed the save, and its saved revision did not move. Save again to be sure" });
    }
    const workingIds = new Set(allTabs().flatMap(({ tab }) => (tab.runs ?? []).filter((run) => run.status === "working").map((run) => run.runId)));
    for (const runId of stopStates.keys()) if (!workingIds.has(runId)) stopStates.delete(runId);
    if (stopAllTrack?.accepted) reportStopAll(workingIds);
  }
  // A live run's log: the server's state carries the tail it holds (up to 200 KiB) for every running run, and each output chunk after it is appended.
  // Taking that tail from every state is what makes a reload start with the earlier lines, and a reconnect (or the server's "fell behind" resync)
  // fill the chunks that were missed. A finished run's log is dropped: its saved log opens from History.
  function rebaseRunOutput(state) {
    const live = new Set();
    for (const { tab } of (state?.projects ?? []).flatMap((project) => project.tabs.map((tab) => ({ tab })))) {
      for (const run of tab.runs ?? []) {
        if (run.status !== "working") continue;
        live.add(run.runId);
        if (typeof run.output === "string") outputByRun.set(run.runId, run.output.length > MAX_OUTPUT_CHARS ? run.output.slice(-MAX_OUTPUT_CHARS) : run.output);
      }
    }
    for (const runId of [...outputByRun.keys()]) if (!live.has(runId)) outputByRun.delete(runId);
    for (const runId of [...stallActions.keys()]) if (!live.has(runId)) stallActions.delete(runId);
  }
  // Appends one chunk; true when the front of the log had to be cut to stay within the cap (the shown text then cannot just be extended).
  function appendOutput(runId, chunk) {
    const next = (outputByRun.get(runId) ?? "") + chunk;
    const trimmed = next.length > MAX_OUTPUT_CHARS;
    outputByRun.set(runId, trimmed ? next.slice(-MAX_OUTPUT_CHARS) : next);
    return trimmed;
  }
  function runEndBody(tab, message) {
    const run = (tab?.runs ?? []).find((item) => item.runId === message.runId);
    const label = mdPlain(message.label ?? run?.label);
    if (message.message) return String(message.message);
    if (message.type === "runFinish") return label ? `${label} finished.` : "The run finished.";
    const code = Number.isInteger(message.exitCode) ? `, exit ${message.exitCode}` : "";
    return label ? `${label} failed (${message.outcome ?? "failed"}${code}).` : `The run failed (${message.outcome ?? "failed"}${code}).`;
  }
  function uncertainRows() { return serverState?.launchSafety?.uncertain ?? []; }
  function uncertainRun(runId) { return uncertainRows().some((row) => row.runId === runId); }
  function reportStopAll(workingIds) {
    const track = stopAllTrack; if (!track) return;
    const remaining = [...track.runIds].filter((id) => workingIds.has(id));
    const unconfirmed = remaining.filter((id) => uncertainRun(id));
    if (remaining.length > unconfirmed.length) return;
    stopAllTrack = null;
    const exited = track.runIds.size - remaining.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (!track.runIds.size) return;
    if (unconfirmed.length) showToast(`Stop all: ${plural(exited, "run")} exited, ${unconfirmed.length} not confirmed and may still be running. Needs you has Try again and Release`);
    else showToast(`Stop sent: all ${plural(exited, "run")} exited. Leaders were told to stop`);
    for (const tabId of track.tabIds) recordActivity(unconfirmed.length ? `Stop all: ${plural(exited, "run")} exited, ${unconfirmed.length} not confirmed` : "Stop all: every run exited", unconfirmed.length ? "failed" : "stopped", tabId);
  }
