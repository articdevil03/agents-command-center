// Command Center page script, part 12 of 12: events, the message queue and start-up. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  // ---------- events ----------
  function bindEvents() {
    new ResizeObserver(() => { if ($("toast").classList.contains("on")) placeToast(); }).observe($("composer"));
    // A file dropped on the window must never open in place of the app. Nothing here takes a drop today; a future drop zone marks itself data-drop-zone.
    for (const type of ["dragover", "drop"]) document.addEventListener(type, (event) => { if (!event.target.closest?.("[data-drop-zone]")) event.preventDefault(); });
    $("pmore").addEventListener("click", (event) => togglePopover($("projPop"), event.currentTarget, () => renderProjectPopover(event.currentTarget)));
    $("addProj").addEventListener("click", (event) => openProjectDialog(event.currentTarget));
    $("addtab").addEventListener("click", (event) => openAddTab(event.currentTarget));
    $("setBtn").addEventListener("click", (event) => openSettings(event.currentTarget));
    $("inboxBtn").addEventListener("click", (event) => togglePopover($("inboxPop"), event.currentTarget, () => openInbox(event.currentTarget)));
    $("reqNew").addEventListener("click", () => {
      const open = $("reqForm").hidden;
      $("reqForm").hidden = !open; $("reqNew").setAttribute("aria-expanded", String(open)); $("reqNew").textContent = open ? "Close form" : "New request";
      placePopover($("inboxPop"));
      if (open) $("reqTitle").focus();
    });
    $("soundBtn").addEventListener("click", (event) => togglePopover($("soundPop"), event.currentTarget, () => openSoundPop(event.currentTarget)));
    $("soundSwitch").addEventListener("click", toggleSound);
    $("soundVol").addEventListener("input", () => { soundSliding = true; showSoundLevel(); });
    $("soundVol").addEventListener("change", saveSoundVolume);
    $("soundTest").addEventListener("click", () => playCompletionSound(Number($("soundVol").value)));
    $$("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => { setTheme(button.dataset.themeToggle); if (!$("setModal").hidden) renderSettings(); }));
    $("themeTg").addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = resolvedTheme() === "light" ? "dark" : "light";
      setTheme(event.key === "Home" ? "light" : event.key === "End" ? "dark" : next);
      $("themeTg").querySelector('[aria-checked="true"]')?.focus();
    });
    $("permBtn").addEventListener("click", (event) => togglePopover($("permPop"), event.currentTarget, () => openPermissionPicker(currentTab(), event.currentTarget)));
    $("meBtn").addEventListener("click", (event) => openMeAvatar(event.currentTarget));
    bindWindowButtons();
    $("folderBtn").addEventListener("click", () => { const tab = currentTab(); if (tab) pickFolder((folder) => send({ type: "changeFolder", tabId: tab.id, folder })); });
    $("stopAll").addEventListener("click", stopAll);
    $("setupsBtn").addEventListener("click", (event) => { const tab = currentTab(); if (tab) togglePopover($("setupPop"), event.currentTarget, () => processMenu(tab, event.currentTarget)); });
    $("railBtn").addEventListener("click", () => setRailCollapsed(railWide));
    $("sideBtn").addEventListener("click", () => { setSideOpen(!sideOpen); if (sideOpen && innerWidth < 1280) $("sideClose").focus(); });
    $("sideClose").addEventListener("click", () => { setSideOpen(false); $("sideBtn").focus(); });
    $("statusBtn").addEventListener("click", () => { stepsOpen = !stepsOpen; const tab = currentTab(); if (tab) renderStatusLine(tab); });
    $("saveBtn").addEventListener("click", () => startSave(currentTab()));
    $("chatMore").addEventListener("click", (event) => togglePopover($("ctxPop"), event.currentTarget, () => chatMenu(event.currentTarget)));
    $("scrim").addEventListener("click", () => closeLayer());
    $("browse").addEventListener("click", () => pickFolder((folder) => updateFolderDisplay("tab", folder)));
    $("pBrowse").addEventListener("click", () => pickFolder((folder) => updateFolderDisplay("project", folder)));
    $("createTab").addEventListener("click", createTab);
    $("createProj").addEventListener("click", createProject);
    $("tName").addEventListener("input", () => { if (!$("tName").value.trim()) $("tFolderWarn").hidden = Boolean(selectedTabFolder); });
    $("pName").addEventListener("input", () => { $("npStat").classList.remove("bad"); updateProjectSubmit(); });
    $("runPrompt").addEventListener("input", () => { if (!pendingRun && !runUnknown) $("runStart").disabled = !$("runPrompt").value.trim(); });
    $("runStart").addEventListener("click", startRun);
    $("confirmOk").addEventListener("click", confirmAccepted);
    $("confirmCancel").addEventListener("click", () => setLayer($("confirmModal"), false, null, true));
    $("confirmPhrase").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); confirmAccepted(); } });
    $("renameSave").addEventListener("click", renameAccepted);
    $("renameInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); renameAccepted(); } });
    $("sendBtn").addEventListener("click", sendChat);
    $("ci").addEventListener("input", () => {
      const tabId = currentTab()?.id;
      if (tabId) { draftsByTab.set(tabId, $("ci").value); noteTextEdit(tabId); }
      fitComposer();
      updateChatLoading(tabId);
    });
    // Enter sends, Shift+Enter is a new line, and Enter while an IME is composing a character never sends.
    $("ci").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendChat(); } });
    $("attachBtn").addEventListener("click", () => { attachmentTargetTab = currentTab()?.id ?? null; $("attachInput").click(); });
    $("attachInput").addEventListener("change", (event) => {
      const tabId = attachmentTargetTab ?? currentTab()?.id; attachmentTargetTab = null;
      for (const file of event.target.files ?? []) {
        if (/^image\/(?:png|jpeg|webp)$/.test(file.type)) addImageAttachment(file, tabId);
        else addFileAttachment(file, tabId);
      }
      event.target.value = "";
    });
    $("ci").addEventListener("paste", (event) => {
      if (pendingChatByTab.has(currentTab()?.id)) { event.preventDefault(); return; }
      const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      const accepted = files.filter((file) => /^image\/(?:png|jpeg|webp)$/.test(file.type) || FILE_EXTENSIONS.has(fileExtension(file.name)));
      if (accepted.length) {
        event.preventDefault();
        for (const file of accepted) {
          if (/^image\/(?:png|jpeg|webp)$/.test(file.type)) addImageAttachment(file);
          else addFileAttachment(file);
        }
      }
    });
    $("avUp").addEventListener("change", (event) => { const file = event.target.files?.[0]; event.target.value = ""; uploadMe(file); });
    $("reqForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const tab = currentTab(); const toTabId = $("reqTo").value;
      const title = $("reqTitle").value.trim(); const body = $("reqBody").value.trim();
      // The server's limit is 24 KiB in bytes; the form's length limit counts characters, so a long non-English text must be measured here.
      if (new TextEncoder().encode($("reqBody").value).length > REQUEST_BODY_BYTES) { $("reqStatus").textContent = "The details are too long (24 KiB at most)"; $("reqStatus").dataset.status = "failed"; return; }
      const pendingRequestAction = pendingRequestActions.get(tab?.id) ?? requestActionResults.get(tab?.id)?.requestId;
      const priorAction = pendingRequestAction ? actionStateFor(pendingRequestAction) : null;
      if (!tab || !toTabId || !title || !body || (pendingRequestAction && (!priorAction || priorAction.status === "running"))) {
        if (tab && (!title || !body)) { $("reqStatus").textContent = !title ? "Give it a title" : "Add the details"; $("reqStatus").dataset.status = "failed"; }
        return;
      }
      const requestId = newRequestId();
      if (!send({ type: "sendRequest", requestId, fromTabId: tab.id, toTabId, title, body })) return;
      pendingRequestActions.set(tab.id, requestId);
      renderRequests();
    });
    // Picking a kind starts the template that kind begins with; picking a template also sets the kind it belongs to, so the two never disagree.
    bindRadios($("kindBox"), "[data-kind]", (button) => { tabKind = button.dataset.kind; tabTemplate = defaultTemplate(tabKind)?.id ?? ""; $("tplBox").innerHTML = templateOptions(tabTemplate); fixRadios($("modal")); });
    bindRadios($("tplBox"), "[data-template]", (button) => {
      tabTemplate = button.dataset.template;
      const kind = templates().find((item) => item.id === tabTemplate)?.kind;
      if (kind && kind !== tabKind) { tabKind = kind; $("kindBox").innerHTML = availableKindOptions(tabKind); fixRadios($("modal")); }
    });
    bindRadios($("pKind"), "[data-kind]", (button) => { projectKind = button.dataset.kind; projectTemplate = defaultTemplate(projectKind)?.id ?? ""; $("pTpl").innerHTML = templateOptions(projectTemplate); fixRadios($("projModal")); });
    bindRadios($("pTpl"), "[data-template]", (button) => {
      projectTemplate = button.dataset.template;
      const kind = templates().find((item) => item.id === projectTemplate)?.kind;
      if (kind && kind !== projectKind) { projectKind = kind; $("pKind").innerHTML = kindSegments(projectKind); fixRadios($("projModal")); }
    });
    $$('[data-close]').forEach((button) => button.addEventListener("click", () => { const layer = button.closest(".modal"); if (layer) setLayer(layer, false, null, true); else closeLayer(); }));
    document.addEventListener("keydown", (event) => heldApprovalKeys.add(event.code || event.key), true);
    document.addEventListener("keyup", (event) => {
      heldApprovalKeys.delete(event.code || event.key);
      const press = approvalKeyPressId;
      if (press?.key !== (event.code || event.key)) return;
      setTimeout(() => { if (approvalKeyPressId === press) approvalKeyPressId = null; }, 0);
    }, true);
    document.addEventListener("pointerdown", (event) => heldApprovalPointers.add(event.pointerId ?? 0), true);
    document.addEventListener("pointerup", (event) => heldApprovalPointers.delete(event.pointerId ?? 0), true);
    document.addEventListener("pointercancel", (event) => {
      heldApprovalPointers.delete(event.pointerId ?? 0);
      if (approvalPressId?.pointerId === (event.pointerId ?? 0)) approvalPressId = null;
    }, true);
    $("setBody").addEventListener("input", (event) => { const key = event.target.dataset?.focusKey; if (key) settingsEdits.add(key); });
    window.addEventListener("blur", () => {
      heldApprovalKeys.clear(); heldApprovalPointers.clear();
      approvalPressId = null; approvalKeyPressId = null;
    });
    const settledApprovalId = () => performance.now() >= approvalSettleUntil ? $("approvalPanel").dataset.approvalId : "";
    for (const id of ["approvalAllow", "approvalDeny"]) $(id).addEventListener("pointerdown", (event) => { approvalPressId = { id: settledApprovalId(), pointerId: event.pointerId ?? 0 }; });
    document.addEventListener("pointerup", (event) => { const press = approvalPressId; if (press?.pointerId !== (event.pointerId ?? 0)) return; setTimeout(() => { if (approvalPressId === press) approvalPressId = null; }, 0); }, true);
    $("approvalPanel").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      if (!event.repeat) approvalKeyPressId = { id: settledApprovalId(), key: event.code || event.key };
    });
    $("approvalAllow").addEventListener("click", (event) => answerToolApproval(true, event));
    $("approvalDeny").addEventListener("click", (event) => answerToolApproval(false, event));
    const pills = document.querySelector(".pills");
    document.querySelectorAll(".pills [data-l]").forEach((button) => {
      button.addEventListener("click", () => { lowerSection = button.dataset.l; renderLower(); button.focus({ preventScroll: true }); });
      button.addEventListener("keydown", (event) => tabKeys(event, button, pills, "[data-l]", (next) => { lowerSection = next.dataset.l; renderLower(); next.focus({ preventScroll: true }); }));
    });
    const grip = $("sgrip");
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const right = $("side").getBoundingClientRect().right;
      grip.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => { sideWidthDraft = Math.max(280, Math.min(560, right - moveEvent.clientX)); applySideWidth(); };
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); saveSideWidth(sideWidth()); };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); saveSideWidth(sideWidth() + (event.key === "ArrowLeft" ? 16 : -16)); });
    document.addEventListener("pointerdown", (event) => {
      if (!currentLayer || currentLayer.classList.contains("modal")) return;
      if (!event.target.closest(".pop,[aria-haspopup]")) closePopovers();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (currentLayer) { event.preventDefault(); closeLayer(); return; }
        if (sideOpen && innerWidth < 1280 && $("side").contains(document.activeElement)) { event.preventDefault(); setSideOpen(false); $("sideBtn").focus(); return; }
      }
      if (event.key !== "Tab" || !currentLayer) return;
      // A modal keeps Tab inside it; a popover opened from inside a modal is the active scope until it closes.
      const top = currentLayer;
      const trapped = top.classList.contains("modal") || layerStack.some((entry) => entry.modal);
      if (!trapped) return;
      const focusable = $$('button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]', top).filter((item) => !item.hidden && item.tabIndex >= 0 && item.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!top.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    });
    // A picture that fails to load swaps to its fallback once; the flag stops a missing fallback from looping.
    document.addEventListener("error", (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.dataset.fallback || image.dataset.fellBack === "1") return;
      if (image.getAttribute("src") === image.dataset.fallback) { image.dataset.fellBack = "1"; return; }
      image.dataset.fellBack = "1"; image.src = image.dataset.fallback;
    }, true);
    const tip = $("tip");
    const tipTarget = (event) => event.target.closest?.("#stage:not(.wide) .seat[data-tip],#stage:not(.wide) #setupsBtn,#stage:not(.wide) #stopAll");
    const showTip = (target) => { const rect = target.getBoundingClientRect(); tip.textContent = target.dataset.tip; tip.style.left = `${rect.right + 12}px`; tip.style.top = `${rect.top + rect.height / 2}px`; tip.classList.add("on"); };
    document.addEventListener("mouseover", (event) => { const target = tipTarget(event); if (target && !target.classList.contains("on")) showTip(target); else tip.classList.remove("on"); });
    document.addEventListener("focusin", (event) => { const target = tipTarget(event); if (target && event.target.matches(":focus-visible")) showTip(target); else tip.classList.remove("on"); });
    $("crew").addEventListener("scroll", () => tip.classList.remove("on"));
    $("ptabs").addEventListener("wheel", (event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { $("ptabs").scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });
    $("stage").addEventListener("transitionend", (event) => { if (event.target.id === "stage") refreshPopovers(); });
    window.addEventListener("resize", () => { refreshPopovers(); renderHeader(); });
    window.addEventListener("pagehide", () => {
      for (const id of pendingActions.keys()) sendHeld(id, true);
      for (const list of attachmentsByTab.values()) for (const item of list) releaseAttachment(item);
      for (const list of queueByTab.values()) for (const queued of list) for (const item of queued.items) releaseAttachment(item);
    });
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => { if (activeTheme === "system") { applyTheme(); if (!$("setModal").hidden) renderSettings(); } });
  }
  // ---------- queued messages: typed while the leader replies ----------
  function queueFor(tabId) { return queueByTab.get(tabId) ?? []; }
  function replyActive(tabId) { return findTab(tabId)?.derived?.leaderTurnActive === true; }
  function removeQueued(tabId, item) {
    const rest = queueFor(tabId).filter((other) => other !== item);
    if (rest.length) queueByTab.set(tabId, rest); else queueByTab.delete(tabId);
    for (const attachment of item.items) releaseAttachment(attachment);
    if (currentTab()?.id === tabId) renderQueue();
  }
  function clearQueue(tabId) { for (const item of [...queueFor(tabId)]) removeQueued(tabId, item); flushArmed.delete(tabId); }
  // The owner stopped this tab's leader, or its reply failed: nothing queued goes out on its own, and a flush waiting for the state is cancelled. This also covers a reply the server
  // had just finished (its chatDone still on the way), where Stop finds no turn and so no chatError ever comes.
  function holdQueue(tabId) {
    flushArmed.delete(tabId);
    for (const item of queueFor(tabId)) item.held = true;
    replyEnds.set(tabId, { kind: "stopped" });
    if (currentTab()?.id === tabId) renderQueue();
  }
  function putFront(tabId, item) { queueByTab.set(tabId, [item, ...queueFor(tabId).filter((other) => other !== item)]); }
  // The composer's message becomes a queued one; its attachments go with it (they are not released, the item owns them now).
  function queueFromRequest(request) {
    const rest = attachmentList(request.tabId).filter((item) => !request.items.includes(item));
    if (rest.length) attachmentsByTab.set(request.tabId, rest); else attachmentsByTab.delete(request.tabId);
    queueByTab.set(request.tabId, [...queueFor(request.tabId), { id: newRequestId(), text: request.text, items: request.items, held: false, state: "waiting", requestId: null }]);
    settleChatRequest(request, true); // empties the composer as an accepted send does
  }
  async function queueComposer(tabId) {
    if (queuingTabs.has(tabId)) return;
    const text = $("ci").value.trim(), items = [...attachmentList(tabId)], generation = composerGeneration;
    if (!text) return;
    queuingTabs.add(tabId);
    const endAtStart = replyEnds.get(tabId);
    try {
      await Promise.all(items.map((item) => item.promise).filter(Boolean));
      if (composerGeneration !== generation || $("ci").value.trim() !== text) return; // the tab changed or the text was edited while a file loaded
      const kept = items.filter((item) => attachmentList(tabId).includes(item) && !item.released);
      if (kept.some((item) => item.status !== "ready" || !item.path)) { showToast("Remove or retry the attachment that could not be loaded"); return; }
      // How did the reply end while the file loaded? A Clear leaves the message in the box; a Stop or failure queues it held; a normal end queues it behind the earlier ones and it goes out in order.
      const ended = replyEnds.get(tabId) !== endAtStart ? replyEnds.get(tabId).kind : replyActive(tabId) ? null : "done";
      if (ended === "cleared") return;
      const rest = attachmentList(tabId).filter((item) => !kept.includes(item));
      if (rest.length) attachmentsByTab.set(tabId, rest); else attachmentsByTab.delete(tabId);
      queueByTab.set(tabId, [...queueFor(tabId), { id: newRequestId(), text, items: kept, held: ended === "stopped", state: "waiting", requestId: null }]);
      draftsByTab.set(tabId, ""); noteTextEdit(tabId);
      if (composerTabId === tabId) { $("ci").value = ""; fitComposer(); }
      renderAttachments();
      if (ended === "done") { flushArmed.add(tabId); flushQueue(tabId); }
    } finally {
      queuingTabs.delete(tabId);
      if (currentTab()?.id === tabId) updateChatLoading(tabId);
    }
  }
  // Steer (a reply is running: pushed into it) or Send (it is not: a normal message). Both carry the item's own attachments and the folder-busy check.
  function goQueued(tabId, id, confirmBusy) {
    const item = queueFor(tabId).find((other) => other.id === id);
    const tab = findTab(tabId);
    if (!item || !tab || item.state !== "waiting") return;
    const steer = replyActive(tabId);
    if (steer && (tab.pendingApprovals?.length || savePending.has(tabId))) return;
    if (item.items.some((attachment) => attachment.released || attachment.status !== "ready" || !attachment.path)) { showToast("Remove or retry the attachment that could not be loaded"); return; }
    const requestId = newChatRequestId();
    const images = item.items.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.path);
    const files = item.items.filter((attachment) => attachment.kind === "file").map((attachment) => attachment.path);
    chatRequestsById.set(requestId, { requestId, tabId, text: item.text, items: item.items, sent: true, status: "pending", queueItem: item, steer });
    item.state = "sending"; item.requestId = requestId;
    const payload = { type: steer ? "steer" : "chat", tabId, text: item.text, requestId, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(confirmBusy === true ? { confirmBusy: true } : {}) };
    if (!send(payload)) { chatRequestsById.delete(requestId); item.state = "waiting"; item.requestId = null; }
    renderQueue();
  }
  // The reply ended normally and the state says the leader is idle: the first waiting message goes out as a normal send, the rest wait for that reply.
  function flushQueue(tabId) {
    if (!flushArmed.has(tabId)) return;
    if (!findTab(tabId) || replyActive(tabId) || !socket || socket.readyState !== WebSocket.OPEN) return;
    const list = queueFor(tabId);
    if (list.some((item) => item.state !== "waiting")) return;
    const next = list.find((item) => !item.held);
    flushArmed.delete(tabId);
    if (next) goQueued(tabId, next.id);
  }
  function renderQueue() {
    const box = $("queue"); if (!box) return;
    const tab = currentTab();
    const list = tab && inChat(tab) ? queueFor(tab.id) : [];
    const active = Boolean(tab && replyActive(tab.id));
    const why = !tab ? "" : tab.pendingApprovals?.length ? "Answer the approval first" : savePending.has(tab.id) ? "Save is running" : "";
    const html = list.map((item) => {
      const sending = item.state !== "waiting", blocked = active && why;
      const names = item.items.map((attachment) => esc(attachment.name)).join(", ");
      return `<div class="qitem" data-queue="${esc(item.id)}"><span class="qtext" title="${esc(item.text)}">${esc(item.text)}${names ? `<small>${names}</small>` : ""}</span>${blocked ? `<small class="qwhy">${esc(why)}</small>` : ""}<button type="button" class="btn sm" data-queue-go="${esc(item.id)}"${sending || blocked ? " disabled" : ""}>${active ? "Steer" : "Send"}</button><button type="button" class="qx" data-queue-remove="${esc(item.id)}" aria-label="Remove queued message" title="Remove"${sending ? " disabled" : ""}>${ICONS.x}</button></div>`;
    }).join("");
    box.hidden = !list.length;
    if (box.dataset.html === html) return;
    box.dataset.html = html; box.innerHTML = html;
    box.querySelectorAll("[data-queue-go]").forEach((button) => button.addEventListener("click", () => goQueued(tab.id, button.dataset.queueGo)));
    box.querySelectorAll("[data-queue-remove]").forEach((button) => button.addEventListener("click", () => {
      const item = queueFor(tab.id).find((other) => other.id === button.dataset.queueRemove);
      if (item && item.state === "waiting") removeQueued(tab.id, item);
    }));
  }
  function fitComposer() { const input = $("ci"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight || 24, 160)}px`; }
  async function sendChat(confirmBusy) {
    const tab = currentTab();
    if (!tab || !inChat(tab) || savePending.has(tab.id) || chatSendLocked(tab.id)) return;
    if (replyActive(tab.id)) { void queueComposer(tab.id); return; }
    if (queuingTabs.has(tab.id)) return; // the composer's message is already on its way to the queue, waiting for its upload
    const tabId = tab.id; const composerValue = $("ci").value; const text = composerValue.trim(); const queued = [...attachmentList(tabId)]; const generation = composerGeneration;
    if (!text) return;
    const requestId = newChatRequestId();
    const request = { requestId, tabId, text, composerValue, textVersion: textVersionByTab.get(tabId) ?? 0, items: queued, sent: false, status: "pending" };
    chatRequestsById.set(requestId, request);
    pendingChatByTab.set(tabId, requestId);
    renderAttachments();
    updateChatLoading(tabId);
    try {
      await Promise.all(queued.map((item) => item.promise).filter(Boolean));
      if (composerGeneration !== generation || pendingChatByTab.get(tabId) !== requestId) return; // tab switch abandons an upload still being read
      const stillAttached = queued.filter((item) => attachmentList(tabId).includes(item) && !item.released);
      if (stillAttached.some((item) => item.status !== "ready" || !item.path)) {
        showToast("Remove or retry the attachment that could not be loaded");
        settleChatRequest(request, false);
        return;
      }
      request.items = stillAttached;
      request.sent = true;
      const images = stillAttached.filter((item) => item.kind === "image").map((item) => item.path);
      const files = stillAttached.filter((item) => item.kind === "file").map((item) => item.path);
      const payload = { type: "chat", tabId, text, requestId, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(confirmBusy === true ? { confirmBusy: true } : {}) };
      if (!send(payload)) { request.sent = false; settleChatRequest(request, false); return; }
    } catch (error) {
      if (pendingChatByTab.get(tabId) === requestId) settleChatRequest(request, false);
      showToast(error?.message ?? "The message could not be sent");
    } finally {
      if (currentTab()?.id === tabId) updateChatLoading(tabId);
    }
  }
  function setRailCollapsed(collapsed) {
    if (!saveClientPref("crewRailOpen", !collapsed)) return;
    railWide = !collapsed;
    $("tip").classList.remove("on");
    if (!$("setupPop").hidden) setLayer($("setupPop"), false, null, false, false);
    renderCrew();
  }

  bindEvents();
  applyTheme();
  setTimeout(showApp, 3000);
  renderCrew();
  renderSide();
  renderConn();
  connect();
