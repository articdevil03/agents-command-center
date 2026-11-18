// Command Center page script, part 4 of 12: the server message handler. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function onMessage(message) {
    if (message.type === "cliLoginState") { cliLoginUi?.onEvent(message); renderAll(); return; } // private to this page (public/first-run/login.js)
    // A reply only the fixed crew understands (public/fixed-crew/events.js) ends here; its saves and refusals go on through the handling below.
    if (fixedCrewUi?.onMessage(message)) { if (!$("setModal").hidden) renderSettings(); return; }
    // Settings "Check again": the server answers its refreshSettings request with an actionResult, or an error, carrying the page's requestId.
    if ((message.type === "actionResult" || message.type === "error") && typeof message.requestId === "string" && refreshState?.status === "running" && refreshState.requestId === message.requestId) {
      refreshState = { status: message.type === "error" ? "failed" : "done", at: Date.now() };
      if (!$("setModal").hidden) renderSettings();
      if (message.type === "actionResult") return;
    }
    if ((message.type === "actionResult" || message.type === "error") && typeof message.requestId === "string" && message.action !== "answerApproval") {
      retireAction({ requestId: message.requestId, status: message.type === "error" ? "failed" : "done", message: message.type === "error" ? message.message ?? "Failed" : "Done" });
    }
    if ((message.type === "actionResult" || message.type === "error") && message.action === "answerApproval") {
      const item = [...approvalAnswers.values()].find((item) => item.requestId === message.requestId);
      if (item) { item.status = message.type === "error" ? "failed" : "done"; item.message = message.message ?? ""; renderToolApproval(); }
      return;
    }
    if (message.type === "actionResult") { renderAll(); return; }
    if (message.type === "state") {
      const previous = serverState;
      serverState = message;
      for (const item of listedActions()) retireAction(item);
      const listedIds = new Set(listedActions().map((item) => item?.requestId));
      for (const id of pendingActionIds()) {
        if (listedIds.has(id)) seenListedActions.add(id);
        else if (seenListedActions.has(id) || lostActions.has(id)) retireAction({ requestId: id, status: "unknown", message: "" });
      }
      const stillPending = pendingActionIds();
      for (const id of seenListedActions) if (!stillPending.has(id)) seenListedActions.delete(id);
      lostActions = new Set();
      const tabIds = new Set(allTabs().map(({ tab }) => tab.id));
      for (const id of transcripts.keys()) if (!tabIds.has(id)) { transcripts.delete(id); completeTranscripts.delete(id); streamingByTab.delete(id); interruptedReplies.delete(id); transcriptRequests.delete(id); }
      for (const map of [permissionActionResults, requestActionResults, requestFormCleared]) for (const id of map.keys()) if (!tabIds.has(id)) map.delete(id);
      const requestKeys = new Set((message.requests ?? []).map((request) => `request-resolve-${request.id}`));
      for (const key of settingsActionResults.keys()) if (key.startsWith("request-resolve-") && !requestKeys.has(key)) settingsActionResults.delete(key);
      const removalKeys = new Set(Object.entries(message.settings?.skills ?? {}).flatMap(([cli, inventory]) => [
        ...(inventory.mcpServers ?? []).map((server) => `mcp-remove-${cli}-${server.name}`),
        ...(cli === "claude" ? (inventory.plugins ?? []).map((name) => `plugin-remove-${name}`) : []),
      ]));
      for (const key of settingsActionResults.keys()) if ((key.startsWith("mcp-remove-") || key.startsWith("plugin-remove-")) && !removalKeys.has(key)) settingsActionResults.delete(key);
      for (const [key, value] of clientPrefOverrides) {
        const actual = message.clientPrefs?.[key];
        if (JSON.stringify(actual) === JSON.stringify(value)) clientPrefOverrides.delete(key);
      }
      applyServerLooks();
      rebaseRunOutput(message);
      $("setBody").querySelectorAll("[data-setting]").forEach((button) => button.setAttribute("aria-checked", String(settingValue(button.dataset.setting))));
      addStateNotices(message);
      newApprovalRequests(previous, message);
      settleConfirmedActions(); cliLoginUi?.onState();
      settleFromState();
      // The state carries the step line too, so a page that connected mid-reply shows it.
      for (const { tab } of allTabs()) { if (tab.leaderActivity && tab.derived?.leaderTurnActive) stepByTab.set(tab.id, tab.leaderActivity); else stepByTab.delete(tab.id); }
      for (const tabId of [...flushArmed]) flushQueue(tabId);
      renderAll();
      return;
    }
    if (message.type === "leaderActivity") {
      if (typeof message.label === "string" && message.label) stepByTab.set(message.tabId, message.label); else stepByTab.delete(message.tabId);
      paintStep(message.tabId);
      return;
    }
    if (onChatEvent(message)) return;
    if (message.type === "saved") {
      chatInfo(message.tabId, message); savePending.delete(message.tabId); saveStates.delete(message.tabId);
      // A successful Save writes one entry to the leader's Past sessions (the server's history for seat <tab>.<leader slot>): list it again.
      { const saved = findTab(message.tabId), lead = leader(saved); if (saved && lead) requestHistory(saved, lead, true); }
      if (message.tabId === currentTab()?.id) renderStage();
      recordActivity("Saved the handover", "done", message.tabId);
      showToast("Saved"); renderAll(); return;
    }
    if (message.type === "output") {
      const chunk = String(message.chunk ?? "");
      updateRunOutput(message.runId, chunk, appendOutput(message.runId, chunk));
      return;
    }
    if (message.type === "rateLimit") {
      rateWindowsByRun.set(message.runId, message.windows);
      renderMeters();
      return;
    }
    if (message.type === "runStart") {
      const seat = findTab(message.tabId)?.crew?.find((item) => item.seatKey === message.seatKey);
      recordActivity(`${seat?.name ?? seatNameOfKey(message.seatKey)} started ${message.model ? formatModel(seat?.cli, message.model) : "a run"}${launchedByText(message.launchedBy)}`, "working",message.tabId ?? tabIdOfKey(message.seatKey)); renderSide();
      return;
    }
    if (["runFinish", "runFail", "runStop"].includes(message.type)) {
      const tab = findTab(message.tabId) ?? findTab(tabIdOfKey(message.seatKey));
      const seat = tab?.crew?.find((item) => item.seatKey === message.seatKey || (!message.seatKey && item.slot === message.slot));
      if (tab && seat) requestHistory(tab, seat, true);
      if (seat && message.type !== "runStop") {
        const verb = message.type === "runFinish" ? "finished" : "failed";
        const kind = seat.isLeader ? "leader-turn" : message.type === "runFinish" ? "worker-finish" : "worker-fail";
        notify(kind, `${seat.name} ${verb}`, runEndBody(tab, message));
      }
      recordActivity(`${seat?.name ?? seatNameOfKey(message.seatKey)} ${message.type === "runFinish" ? "finished" : message.type === "runFail" ? "failed" : "stopped a run"}`, message.type === "runFail" ? "failed" : message.type === "runStop" ? "stopped" : "done", tab?.id ?? tabIdOfKey(message.seatKey)); renderSide();
      return;
    }
    if (message.type === "runStalled") {
      const seat = (findTab(message.tabId) ?? findTab(tabIdOfKey(message.seatKey)))?.crew?.find((item) => item.seatKey === message.seatKey);
      // The server only leaves a stalled run for the owner; it never stops or restarts it by itself.
      if (seat) notify(seat.isLeader ? "leader-turn" : "worker-stall", `${seat.name} is stalled`, "Check the run before it can continue.");
      recordActivity(`${seat?.name ?? seatNameOfKey(message.seatKey)} stalled`, "waiting", message.tabId ?? tabIdOfKey(message.seatKey)); renderSide(); return;
    }
    if (message.type === "leaderLaunch") { noteNotice(message); renderAll(); return; }
    if (message.type === "historyList") {
      const key = message.seatKey;
      historyInFlight.delete(key); historyFailed.delete(key);
      historyBySeat.set(key, message.runs ?? []);
      if (historyRefreshAfterFlight.delete(key)) {
        historyRequested.delete(key);
        const owner = historyOwner(key);
        if (owner) requestHistory(owner.tab, owner.seat);
      }
      renderStage(); return;
    }
    if (message.type === "historyRun") {
      if (!Number.isSafeInteger(message.timestamp) || historyRunRequested.get(message.seatKey) !== message.timestamp) return;
      const detailKey = `${message.seatKey}:${message.timestamp}`;
      historyDetails.set(detailKey, { ...message, full: message.full === true });
      historyFullRequested.delete(detailKey);
      renderStage(); return;
    }
    if (message.type === "fixedRunRequested") {
      if (pendingRun && pendingRun.tabId === message.tabId && pendingRun.slot === message.slot) {
        const seat = seatFor(findTab(pendingRun.tabId), pendingRun.slot);
        pendingRun = null;
        if (runTarget?.tabId === message.tabId && runTarget?.slot === message.slot) closeLayerOf($("runModal"));
        showToast(`Work from ${seat?.name ?? "the position"} requested`);
      }
      renderAll(); return;
    }
    if (message.type === "runAccepted") {
      if (pendingRun && pendingRun.tabId === message.tabId) {
        const seat = seatFor(findTab(pendingRun.tabId), pendingRun.slot);
        pendingRun = null;
        closeLayerOf($("runModal"));
        showToast(`${seat?.name ?? "The seat"} started`);
      }
      renderAll(); return;
    }
    if (message.type === "folderBusy") {
      // The server held this message or run because another agent is working in the folder: nothing was sent, so the lock, the draft and the attachments are released untouched.
      const request = message.action === "chat" ? chatRequestsById.get(message.requestId) : null;
      // A queued message that was held back never goes out on its own afterwards: only the confirm below (or its button) sends it.
      const queued = request?.tabId === message.tabId ? request.queueItem : null;
      if (queued) queued.held = true;
      if (request?.tabId === message.tabId) settleChatRequest(request, false);
      if (message.action === "run" && pendingRun && pendingRun.tabId === message.tabId) { pendingRun = null; runDialogStatus("Another agent is working in this folder.", false); }
      if (message.tabId === currentTab()?.id) updateChatLoading(message.tabId);
      const lines = (Array.isArray(message.items) ? message.items : []).map(folderBusyLine);
      const body = `${lines.join(" ")} Working in the same files can overwrite each other's changes.`;
      // The selected tab is shared server state: if it moved while this warning was open, Continue would resend another tab's draft.
      const again = () => (message.tabId !== currentTab()?.id ? showToast(`${findTab(message.tabId)?.name ?? "That tab"} is no longer selected. Select it and send again.`) : message.action === "run" ? startRun(true) : queued ? goQueued(message.tabId, queued.id, true) : sendChat(true));
      if (message.tabId !== currentTab()?.id) showToast(`${findTab(message.tabId)?.name ?? "A background tab"}: another agent is working in this folder. Send again to choose.`);
      else confirmAction({ title: "Another agent is working in this folder", body, ok: "Continue anyway", cancel: "Cancel" }, again, message.action === "run" ? $("runStart") : $("ci"));
      renderAll(); return;
    }
    if (message.type === "projectRules") { showToast(message.message); return; } // what happened to the AGENTS.md of a ticked "Work on this project only"
    if (message.type === "steerRefused") {
      // The server did not push the message into the reply (an approval is waiting, Save runs, the leader is not up yet): it stays where it is in the queue.
      const request = chatRequestsById.get(message.requestId);
      if (request?.tabId === message.tabId) settleChatRequest(request, false);
      showToast(message.message ?? "That message could not be steered into the reply");
      renderAll(); return;
    }
    if (message.type === "killAccepted") {
      const asked = killOrder.indexOf(message.runId); if (asked >= 0) killOrder.splice(asked, 1);
      if (stopStates.get(message.runId) === "requested") stopStates.set(message.runId, "accepted");
      renderAll(); return;
    }
    if (message.type === "stopAllAccepted") {
      if (stopAllTrack && !stopAllTrack.accepted) {
        stopAllTrack.accepted = true;
        for (const id of stopAllTrack.runIds) if (stopStates.get(id) === "requested") stopStates.set(id, "accepted");
        const runs = stopAllTrack.runIds.size, tabs = stopAllTrack.tabIds.size;
        showToast(runs ? `Stop accepted; waiting for exits: ${runs} run${runs === 1 ? "" : "s"} in ${tabs} tab${tabs === 1 ? "" : "s"}` : `Stop sent to ${tabs} tab${tabs === 1 ? "" : "s"}. No runs were working`);
        for (const tabId of stopAllTrack.tabIds) recordActivity(runs ? "Stop all accepted: waiting for runs to exit" : "Stop all: stop sent", "stopped", tabId);
        if (!runs) stopAllTrack = null;
      }
      renderAll(); return;
    }
    if (message.type === "settingsRefreshed") {
      // Untagged: it may refresh the shown data, but only the reply carrying the running refresh's requestId ends that refresh (above).
      if (!$("setModal").hidden) renderSettings();
      return;
    }
    if (message.type === "error") {
      if (message.action === "selectTab" && typeof message.tabId === "string") transcriptRequests.delete(message.tabId);
      if (message.action === "historyList") for (const key of message.seatKey ? [message.seatKey] : [...historyInFlight]) { historyInFlight.delete(key); historyFailed.add(key); historyRequested.delete(key); }
      if (message.action === "save" && typeof message.tabId === "string") {
        savePending.delete(message.tabId);
        saveStates.set(message.tabId, { status: "failed", message: message.message ?? "Save failed" });
        if (message.tabId === currentTab()?.id) renderStage();
        recordActivity("Save failed", "failed", message.tabId);
        showToast(message.message ?? "Save failed"); renderAll(); return;
      }
      if ((message.action === "chat" || message.action === "steer") && typeof message.tabId === "string") {
        const request = chatRequestsById.get(message.requestId);
        // Busy: another reply began first (a Save, another window). A queued message goes back to the front, an unsent composer message joins the queue.
        if (request?.tabId === message.tabId && message.reason === "busy") {
          if (request.queueItem) { putFront(message.tabId, request.queueItem); flushArmed.add(message.tabId); }
          else queueFromRequest(request);
        }
        if (request?.tabId === message.tabId) settleChatRequest(request, false);
        if (findTab(message.tabId)?.pendingApprovals?.length) approvalChatErrors.set(message.tabId, message.message ?? "Answer the pending approval before sending a message.");
        if (message.tabId === currentTab()?.id) updateChatLoading(message.tabId);
      }
      if (message.action === "run" && pendingRun && (!message.tabId || message.tabId === pendingRun.tabId)) {
        pendingRun = null;
        runDialogStatus(`Not started: ${message.message ?? "the server refused the launch"}`, false);
      }
      if ((message.action === "addTab" || message.action === "addProject") && pendingCreate) {
        const statusId = pendingCreate.kind === "tab" ? "tStat" : "npStat";
        pendingCreate = null;
        $(statusId).textContent = `Not created: ${message.message ?? "the server refused it"}`; $(statusId).classList.add("bad");
        updateCreateButtons();
      }
      // A refused stop frees only its own run: the server answers killRun messages in order and the refusal names no run, so it is the oldest one unanswered.
      if (message.action === "killRun") { const refused = message.runId ?? killOrder.shift(); if (message.runId) killOrder = killOrder.filter((id) => id !== message.runId); if (stopStates.get(refused) === "requested") stopStates.delete(refused); }
      if (message.action === "refreshSettings" && refreshState?.status === "running" && refreshState.requestId === message.requestId) { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); }
      restoreRejectedActions(message);
      showToast(message.message ?? "The server refused that request");
      renderAll();
      return;
    }
    if (["launchBlockCleared", "launchNoticesAcked", "unconfirmedReleased"].includes(message.type)) {
      renderAll();
    }
  }

  function settleConfirmedActions() {
    for (const [id, item] of pendingActions) {
      if (item.type === "removeTab" && !findTab(item.tabId)) finishPending(id, true);
      else if (item.type === "removeProject" && !findProject(item.projectId)) finishPending(id, true);
    }
    // What is still waiting after the first state since a reconnect was never applied: send it again.
    let resend = false;
    for (const item of pendingActions.values()) if (item.lost) { item.lost = false; resend = true; item.readyToSend = true; }
    if (resend) sendNextHeldAction();
  }
  function finishPending(id, releaseRemoved = false) {
    const item = pendingActions.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pendingActions.delete(id);
    if (releaseRemoved) for (const tabId of item.releaseTabIds ?? []) releaseTabAttachments(tabId);
    renderUndo();
    if (heldActionInFlight === id) {
      heldActionInFlight = null;
      sendNextHeldAction();
    }
  }
  function restoreRejectedActions(error) {
    const sent = pendingActions.get(heldActionInFlight)?.message;
    if (!sent || error.action !== sent.type || error.tabId !== sent.tabId || error.projectId !== sent.projectId) return;
    const id = heldActionInFlight;
    heldActionInFlight = null;
    finishPending(id);
    sendNextHeldAction();
  }
  function scheduleHeld(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { item.readyToSend = true; sendNextHeldAction(); }, Math.max(0, item.dueAt - Date.now()));
  }
  function holdAction(message, label, hidden = {}) {
    const id = `held-${nextActionId++}`;
    const selectedTabId = serverState?.selectedTabId;
    const hidesSelection = (message.type === "removeTab" && message.tabId === selectedTabId)
      || (message.type === "removeProject" && findProject(message.projectId)?.tabs.some((tab) => tab.id === selectedTabId));
    const item = { id, message, label, ...hidden, previousSelectedTabId: hidesSelection ? selectedTabId : null, selectionVersion: userTabSelectionVersion, sent: false, readyToSend: false, timer: 0, dueAt: Date.now() + 10000 };
    pendingActions.set(id, item);
    if (item.previousSelectedTabId) item.fallbackSelectedTabId = activeEntry()?.tab.id ?? null;
    scheduleHeld(item);
    renderUndo(); renderAll(); ensureTicker();
    return id;
  }
