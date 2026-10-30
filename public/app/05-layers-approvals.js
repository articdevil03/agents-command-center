// Command Center page script, part 5 of 12: layers, tool approvals and the top bar. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function sendHeld(id, flushing = false) {
    const item = pendingActions.get(id);
    if (!item || item.sent) return false;
    item.readyToSend = true;
    if (heldActionInFlight && heldActionInFlight !== id && !flushing) return false;
    clearTimeout(item.timer);
    item.timer = 0;
    item.sent = true;
    if (!heldActionInFlight) heldActionInFlight = id;
    if (!send(item.message)) {
      item.sent = false;
      if (heldActionInFlight === id) heldActionInFlight = null;
      renderUndo(); renderAll(); return false;
    }
    renderUndo(); renderAll();
    return true;
  }
  let heldActionInFlight = null;
  function sendNextHeldAction() {
    if (heldActionInFlight) return;
    const item = [...pendingActions.values()].find((candidate) => candidate.readyToSend && !candidate.sent);
    if (item) sendHeld(item.id);
  }
  function undoHeld(id) {
    const item = pendingActions.get(id);
    if (!item || item.sent) return;
    finishPending(id); renderAll();
    const stillOnFallback = (tabId) => tabId === item.previousSelectedTabId || tabId === item.fallbackSelectedTabId;
    if (item.previousSelectedTabId && item.fallbackSelectedTabId && item.selectionVersion === userTabSelectionVersion && stillOnFallback(serverState?.selectedTabId) && stillOnFallback(lastSelectRequest ?? item.previousSelectedTabId)) {
      send({ type: "selectTab", tabId: item.previousSelectedTabId });
    }
    showToast("Undone");
  }
  function undoSeconds(dueAt) { return `${Math.max(0, Math.ceil((dueAt - Date.now()) / 1000))} s`; }
  function renderUndo() {
    const toast = $("undo");
    const held = [...pendingActions.values()];
    const clears = [...clearUndos.entries()];
    if (!held.length && !clears.length) { toast.replaceChildren(); toast.classList.remove("on", "act"); toast.hidden = true; toast.inert = true; toast.setAttribute("aria-hidden", "true"); return; }
    const focused = document.activeElement?.closest?.("#undo") ? document.activeElement.dataset.undoHeld ?? `clear:${document.activeElement.dataset.undoClear}` : null;
    toast.innerHTML = `${held.map((item) => `<div class="undo-item"><span title="${esc(item.label)}">${esc(item.sent ? `${item.label}…` : item.label)}</span>${item.sent ? "" : `<small data-undo-due="${item.dueAt}">${undoSeconds(item.dueAt)}</small><button type="button" data-undo-held="${esc(item.id)}">Undo</button>`}</div>`).join("")}${clears.map(([tabId, item]) => `<div class="undo-item"><span>${item.sent ? "Restoring chat…" : `Chat cleared${findTab(tabId) ? ` in ${esc(findTab(tabId).name)}` : ""}`}</span>${item.sent ? "" : `<small data-undo-due="${item.dueAt ?? Date.now()}">${undoSeconds(item.dueAt ?? Date.now())}</small><button type="button" data-undo-clear="${esc(tabId)}">Undo</button>`}</div>`).join("")}`;
    toast.hidden = false; toast.inert = false; toast.setAttribute("aria-hidden", "false");
    toast.classList.add("on");
    toast.classList.toggle("act", held.some((item) => !item.sent) || clears.some(([, item]) => !item.sent));
    toast.querySelectorAll("[data-undo-held]").forEach((button) => button.addEventListener("click", () => undoHeld(button.dataset.undoHeld)));
    toast.querySelectorAll("[data-undo-clear]").forEach((button) => button.addEventListener("click", () => {
      const tabId = button.dataset.undoClear;
      const item = clearUndos.get(tabId);
      if (!item) return;
      if (item.sent || !send({ type: "undoClear", tabId })) return;
      item.sent = true; renderUndo();
    }));
    if (focused) (toast.querySelector(`[data-undo-held="${CSS.escape(focused)}"]`) ?? toast.querySelector(`[data-undo-clear="${CSS.escape(focused.replace(/^clear:/, ""))}"]`))?.focus({ preventScroll: true });
    ensureTicker();
  }

  // ---------- layers: a modal (Settings, a dialog) may carry one popover or one confirm dialog on top; closing hands focus back ----------
  const FOCUS_ATTRS = ["data-seat-id", "data-seat-pic", "data-seat-open", "data-tab-id", "data-project-id", "data-project-menu", "data-seat-more", "data-run-view", "data-run-tab", "data-history-timestamp", "data-session-action", "data-settings-model", "data-settings-advisor", "data-setting-action", "data-focus-key", "data-l", "data-theme-toggle", "data-wait-approval", "data-wait-tab", "data-request-action", "data-process-action", "data-avatar", "data-model", "data-effort", "data-kind", "data-template", "data-use-template", "data-use-saved", "data-fixer", "data-permission-mode", "data-back-history", "data-chat-live", "data-run-seat", "data-stop-seat", "data-stop-run", "data-seat-model", "data-seat-advisor", "data-seat-watch", "data-seat-chat", "data-seat-history", "data-seat-rename", "data-seat-picture", "data-seat-unblock", "data-open-screenshots", "data-confirm-unblock", "data-confirm-release", "data-unblock", "data-release", "data-retry-kill", "data-ack-notice", "data-dismiss-run", "data-open-seat"];
  function focusKeyOf(el) {
    if (!el || el === document.body || !el.getAttribute) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const name of FOCUS_ATTRS) if (el.hasAttribute(name)) { const value = el.getAttribute(name); return value ? `[${name}="${CSS.escape(value)}"]` : `[${name}]`; }
    return null;
  }
  const shown = (el) => Boolean(el?.isConnected && el.getClientRects().length && !el.closest("[hidden],[inert]"));
  // A disabled control (or one in a disabled fieldset) cannot take focus: .focus() on it does nothing, so it is never a target.
  const focusable = (el) => shown(el) && !el.matches(":disabled");
  function focusEquivalent(el, key) {
    if (focusable(el)) { el.focus({ preventScroll: true }); return true; }
    const found = key ? $$(key).find(focusable) : null;
    if (found) { found.focus({ preventScroll: true }); return true; }
    return false;
  }
  function isOpen(layer) { return layerStack.some((entry) => entry.el === layer); }
  function setLayer(layer, open, opener = null, modal = false) {
    if (open) {
      if (isOpen(layer)) return;
      // A modal replaces the others (the confirm dialog stacks on top); a popover replaces other popovers and keeps the modal under it.
      const popOver = layerStack.find((entry) => !entry.modal && opener && entry.el.contains(opener));
      // A popover opened from outside an open dialog (not one of its own controls) closes that dialog too.
      for (const entry of [...layerStack].reverse()) if (modal ? !(layer.id === "confirmModal" && entry.modal) : !entry.modal || !opener || !entry.el.contains(opener) && !popOver) setLayer(entry.el, false, null, entry.modal, false);
      // A dialog opened from inside a popover returns focus to whatever opened that popover.
      const returnTo = popOver ? popOver.opener : opener ?? document.activeElement;
      const entry = { el: layer, opener: returnTo, key: focusKeyOf(returnTo), modal };
      layerStack.push(entry); currentLayer = layer;
      layer.hidden = false; layer.inert = false; layer.setAttribute("aria-hidden", "false");
      void layer.offsetWidth; layer.classList.add("on");
      if (returnTo?.hasAttribute?.("aria-expanded") && !modal) returnTo.setAttribute("aria-expanded", "true");
      if (modal) { $("scrim").hidden = false; $("scrim").setAttribute("aria-hidden", "false"); $("scrim").classList.add("on"); }
      const first = layer.querySelector('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]');
      if (modal) layer.focus({ preventScroll: true });
      else first?.focus();
      fixRadios(layer);
    } else {
      const restore = arguments.length < 5 || arguments[4] !== false;
      const index = layerStack.findIndex((entry) => entry.el === layer);
      if (index < 0) return;
      const [entry] = layerStack.splice(index, 1);
      currentLayer = layerStack.at(-1)?.el ?? null;
      layer.classList.remove("on"); layer.hidden = true; layer.inert = true; layer.setAttribute("aria-hidden", "true");
      if (entry.opener?.hasAttribute?.("aria-expanded") && !entry.modal) entry.opener.setAttribute("aria-expanded", "false");
      // The crew's pictures may have been redrawn while the card was open: make every rail button follow the closed card IN PLACE.
      // Redrawing here would replace the button a pointer is pressing (the card closes on pointerdown), and the click would never fire.
      if (layer.id === "seatPop") {
        const tab = currentTab(), viewing = tab ? viewedSeat(tab) : "";
        for (const row of $$("#crew .seat")) {
          row.classList.toggle("on", row.dataset.seatId === viewing);
          for (const button of $$("[aria-expanded]", row)) button.setAttribute("aria-expanded", "false");
        }
      }
      if (!layerStack.some((item) => item.modal)) { const scrim = $("scrim"); scrim.classList.remove("on"); scrim.hidden = true; scrim.setAttribute("aria-hidden", "true"); }
      if (layer.id === "avModal") avatarTarget = null;
      if (layer.id === "setModal") settingsSubmits.clear();
      if (layer.id === "confirmModal") { const cancelled = confirmCancelled; confirmCallback = null; confirmCancelled = null; cancelled?.(); }
      if (layer.id === "renameModal") renameCallback = null;
      if (layer.id === "runModal" && !pendingRun) runTarget = null;
      if (restore && !focusEquivalent(entry.opener, entry.key)) {
        const top = layerStack.at(-1)?.el;
        if (top) top.focus({ preventScroll: true });
      }
      markCrewSwitcher();
    }
  }
  function closeLayer(restore = true) {
    const layer = currentLayer;
    if (!layer) return;
    const entry = layerStack.at(-1);
    setLayer(layer, false, null, entry?.modal ?? false, restore);
  }
  // Closes exactly this dialog, whatever else is on top (a confirm dialog opened over it stays); focus goes back to its opener only if it was the top layer.
  function closeLayerOf(layer) {
    const entry = layerStack.find((item) => item.el === layer);
    if (entry) setLayer(layer, false, null, entry.modal, layerStack.at(-1) === entry);
  }
  function openModal(id, opener) { setLayer($(id), true, opener, true); }
  // A redraw (the crew after a card opens) replaces the button a popover hangs from: find its live twin by focus key.
  function liveAnchor(anchor) {
    if (!anchor || anchor.isConnected) return anchor;
    const key = focusKeyOf(anchor);
    return (key ? $$(key).find(shown) : null) ?? anchor;
  }
  function openPopover(pop, anchorArg, right = false) {
    const anchor = liveAnchor(anchorArg);
    const opener = anchor?.isConnected ? anchor : null;
    // Already open on another picture (the seat card switching seats): Escape and the toggle follow the NEW opener.
    const open = layerStack.find((entry) => entry.el === pop);
    if (open && opener && open.opener !== opener) { open.opener = opener; open.key = focusKeyOf(opener); }
    setLayer(pop, true, opener, false);
    pop.classList.toggle("right", right);
    pop.dataset.anchorKey = focusKeyOf(anchor) ?? "";
    pop._anchor = anchor; pop._right = right;
    // Opened from a control in Settings: closeScrolledMenus closes it once Settings scrolls away from here.
    pop._settingsTop = anchor?.closest?.("#setBody") ? $("setBody").scrollTop : null;
    placePopover(pop);
    markCrewSwitcher();
  }
  // A menu hangs from its control: when Settings scrolls (by hand or to another section) it closes instead of staying behind, cut off from
  // the seat it was for. A redraw that puts the scroll back where it was moves nothing, so it keeps the menu.
  function closeScrolledMenus() {
    const top = $("setBody").scrollTop;
    for (const entry of [...layerStack]) if (!entry.modal && entry.el._settingsTop != null && Math.abs(top - entry.el._settingsTop) > 2) setLayer(entry.el, false);
  }
  // Below the anchor (above it when there is no room), or beside it for the crew rail.
  function placePopover(pop) {
    let anchor = pop._anchor;
    if (!anchor?.isConnected && pop.dataset.anchorKey) anchor = $$(pop.dataset.anchorKey).find(shown) ?? anchor;
    if (!anchor?.isConnected) return;
    pop._anchor = anchor;
    pop.style.maxHeight = "";
    const rect = anchor.getBoundingClientRect(), width = pop.offsetWidth || 340, height = pop.offsetHeight || 260;
    if (pop._right) {
      pop.style.left = `${Math.max(12, Math.min(rect.right + 14, innerWidth - width - 12))}px`;
      pop.style.top = `${Math.max(12, Math.min(rect.top - 10, innerHeight - height - 12))}px`;
      return;
    }
    const left = Math.max(12, Math.min(rect.right - width > 12 && rect.left + width > innerWidth - 12 ? rect.right - width : rect.left, innerWidth - width - 12));
    pop.style.left = `${left}px`;
    const below = innerHeight - 12 - rect.bottom - 8, above = rect.top - 8 - 12;
    if (height <= below || height <= above) { pop.style.top = `${height <= below ? rect.bottom + 8 : rect.top - height - 8}px`; return; }
    // It fits on neither side (a short window, a large zoom): it takes the roomier side, shortened to fit, and still touches its control.
    pop.style.maxHeight = `${Math.max(below, above)}px`;
    pop.style.top = `${below >= above ? rect.bottom + 8 : 12}px`;
  }
  function closePopovers() {
    for (const id of ["pop", "projPop", "ctxPop", "setupPop", "inboxPop", "seatPop", "permPop", "soundPop"]) {
      const pop = $(id); if (!pop.hidden) setLayer(pop, false);
    }
  }
  function togglePopover(pop, anchor, open) {
    const entry = layerStack.find((item) => item.el === pop);
    if (entry && (entry.opener === anchor || entry.key === focusKeyOf(anchor))) { setLayer(pop, false); return; }
    open();
  }
  // Roving tabindex: Tab enters a radio group on its checked choice and the arrow keys move inside it.
  function fixRadios(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[role="radiogroup"]').forEach((group) => {
      const items = [...group.querySelectorAll('[role="radio"]')];
      const on = items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0];
      items.forEach((item) => { item.tabIndex = item === on ? 0 : -1; });
    });
  }
  function makeMenu(pop, anchor, items, label = "Options") {
    pop.setAttribute("aria-label", label);
    pop.innerHTML = items.map((item, index) => item.hr ? '<div class="hr"></div>' : item.hint
      ? `<div class="hint"${item.attrs ? ` ${item.attrs}` : ""}>${esc(item.hint)}</div>`
      : `<button type="button" class="opt" data-menu-index="${index}"${item.attrs ? ` ${item.attrs}` : ""}${item.pressed !== undefined ? ` aria-pressed="${String(item.pressed)}"` : ""} ${item.disabled ? "disabled" : ""}><span class="nm"><span${item.danger ? ' class="danger"' : ""} title="${esc(item.label)}">${esc(item.label)}</span>${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</span>${item.pressed !== undefined ? ICONS.tick : ""}</button>`).join("");
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-menu-index]").forEach((button) => button.addEventListener("click", () => {
      const item = items[Number(button.dataset.menuIndex)];
      if (!item || item.disabled) return;
      setLayer(pop, false, null, false, !item.keepFocusAway); item.run?.();
    }));
  }
  // onCancel runs when the dialog closes any way but OK: Cancel, Escape, the scrim, or another dialog taking its place.
  function confirmAction({ title, body, ok = "OK", cancel = "Cancel", danger = false, phrase = "" }, callback, opener = document.activeElement, onCancel = null) {
    $("confirmTitle").textContent = title; $("confirmBody").textContent = body;
    $("confirmPhraseField").hidden = !phrase; $("confirmPhrase").value = ""; $("confirmPhrase").dataset.phrase = phrase;
    $("confirmPhraseLabel").innerHTML = phrase ? `Type <b>${esc(phrase)}</b> to confirm` : "";
    $("confirmErr").textContent = "";
    $("confirmOk").textContent = ok; $("confirmOk").className = `btn ${danger ? "danger" : "primary"}`;
    $("confirmCancel").textContent = cancel;
    openModal("confirmModal", opener);
    confirmCallback = callback; confirmCancelled = onCancel;
    if (phrase) $("confirmPhrase").focus();
  }
  function confirmAccepted() {
    const input = $("confirmPhrase"), phrase = input.dataset.phrase;
    if (phrase && input.value.trim() !== phrase) { $("confirmErr").textContent = "Type the words exactly as shown"; input.focus(); return; }
    const callback = confirmCallback, typed = input.value.trim();
    confirmCallback = null; confirmCancelled = null;
    setLayer($("confirmModal"), false, null, true);
    callback?.(typed);
  }
  function renameDialog(title, value, save, opener) {
    $("renameTitle").textContent = title; $("renameInput").value = value;
    $("renameModal").setAttribute("aria-label", title);
    openModal("renameModal", opener);
    renameCallback = save;
    $("renameInput").focus(); $("renameInput").select();
  }
  function renameAccepted() {
    const next = $("renameInput").value.trim(), callback = renameCallback;
    renameCallback = null;
    setLayer($("renameModal"), false, null, true);
    if (next) callback?.(next);
  }

  // ---------- tool approvals ----------
  const approvalAnswers = new Map();
  const approvalChatErrors = new Map();
  let approvalFocusTabId = null;
  // A click answers only the approval that was SHOWN when the press started: after the panel swaps to another
  // approval its buttons ignore input for APPROVAL_SETTLE_MS, and a press that began on a different one is dropped.
  const APPROVAL_SETTLE_MS = 400;
  let lastApproval = { id: "", at: 0 };
  let approvalSettleUntil = 0;
  let approvalSettleTimer = 0;
  let approvalPressId = null;
  let approvalKeyPressId = null;
  const heldApprovalKeys = new Set();
  const heldApprovalPointers = new Set();
  let approvalClickNote = "";
  // The leader's current name, so a renamed leader is never called by its old one.
  // The one who asks is the approval's own askedBy (the leader, or a seat such as the planner); an approval without one is the leader's.
  function approvalTitle(tool, tab, asker = null) {
    const who = cap(asker?.name ?? leaderName(tab));
    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return `${who} wants to edit a file`;
    if (["Bash", "PowerShell"].includes(tool)) return `${who} wants to run a command`;
    if (tool.startsWith("launch:")) return `${who} wants to launch ${tool.slice(7)}`;
    return `${who} wants to use ${tool}`;
  }
  function renderToolApproval() {
    const tab = currentTab();
    const items = [...(tab?.pendingApprovals ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    const item = items[0]; const panel = $("approvalPanel");
    if (item && item.approvalId !== lastApproval.id) {
      approvalSettleUntil = performance.now() + APPROVAL_SETTLE_MS;
      clearTimeout(approvalSettleTimer); approvalSettleTimer = setTimeout(renderToolApproval, APPROVAL_SETTLE_MS + 20);
    }
    lastApproval = { id: item?.approvalId ?? "", at: performance.now() };
    panel.hidden = !item;
    panel.dataset.approvalId = item?.approvalId ?? "";
    syncComposerVisibility();
    if (!item) { if (tab) approvalChatErrors.delete(tab.id); return; }
    if (approvalFocusTabId === tab.id) {
      approvalFocusTabId = null; panel.scrollIntoView({ block: "nearest" }); panel.focus({ preventScroll: true });
    }
    $("approvalTitle").textContent = approvalTitle(item.tool, tab, item.askedBy); $("approvalTitle").title = approvalTitle(item.tool, tab, item.askedBy);
    $("approvalSummary").textContent = item.summary;
    $("approvalCount").textContent = `1 of ${items.length}`;
    const answer = approvalAnswers.get(item.approvalId);
    const state = actionStateFor(answer?.requestId);
    if (answer && state && state.status !== "running") { answer.status = state.status; answer.message = state.message; }
    const busy = answer?.status === "running";
    const settling = performance.now() < approvalSettleUntil;
    $("approvalAllow").disabled = busy || settling; $("approvalDeny").disabled = busy || settling;
    $("approvalError").textContent = answer?.status === "failed" ? answer.message : busy ? "Sending your answer..." : approvalChatErrors.get(tab.id) ?? (approvalClickNote === item.approvalId ? "Click once to answer." : "");
  }
  function answerToolApproval(allow, event) {
    if (event.detail !== 0 && approvalPressId?.pointerId !== (event.pointerId ?? 0)) return;
    const tab = currentTab(), approvalId = $("approvalPanel").dataset.approvalId;
    // A click with no key or pointer press before it (screen reader, voice control) answers the shown, settled approval.
    const pressed = (event.detail === 0 ? approvalKeyPressId ?? approvalPressId ?? { id: approvalId } : approvalPressId)?.id;
    if (event.detail === 0 && !approvalKeyPressId && !approvalPressId && (heldApprovalKeys.size || heldApprovalPointers.size)) return;
    if (!tab || !approvalId || approvalAnswers.get(approvalId)?.status === "running" || performance.now() < approvalSettleUntil || pressed !== approvalId) return;
    if (event.detail > 1) { approvalClickNote = approvalId; renderToolApproval(); return; }
    approvalPressId = null; approvalKeyPressId = null;
    approvalClickNote = "";
    const requestId = newRequestId();
    approvalAnswers.set(approvalId, { requestId, status: "running", message: "" });
    if (!send({ type: "answerApproval", requestId, tabId: tab.id, approvalId, allow })) approvalAnswers.set(approvalId, { requestId, status: "failed", message: "Disconnected. Reconnect before answering." });
    renderToolApproval();
  }

  // ---------- top bar ----------
  function renderHeader() {
    const entry = activeEntry();
    const project = entry?.project;
    const tab = entry?.tab;
    if (project && tab) projectLastTab.set(project.id, tab.id);
    // Opening a project reads it; a removed project takes its mark with it.
    if (project) unreadProjects.delete(project.id);
    for (const id of unreadProjects) if (!findProject(id)) unreadProjects.delete(id);
    const box = $("ptabs");
    const focusedProject = document.activeElement?.closest?.("#ptabs .ptab")?.dataset.projectId;
    const focusedMenu = document.activeElement?.closest?.("#ptabs [data-project-menu]")?.dataset.projectMenu;
    box.innerHTML = visibleProjects().map((item) => {
      const on = item.id === project?.id, marker = attentionMark(attentionFor(item.tabs.filter((candidate) => !hiddenTab(candidate.id)))), unread = unreadProjects.has(item.id);
      // The options button is the tab's neighbour, not its child: a tab (role=tab) holds no other control.
      return `<div class="ptabw${on ? " sel" : ""}"><div class="ptab" role="tab" data-project-id="${esc(item.id)}" aria-controls="stage" tabindex="${on ? 0 : -1}" aria-selected="${String(on)}" title="${esc(item.name)}${marker ? ` · ${esc(marker.label)}` : ""}${unread ? " · unread" : ""}"><span class="pn"${on ? ' id="projName"' : ""} title="${esc(item.name)}">${esc(item.name)}</span>${marker ? `<i class="pdot${marker.bad ? " bad" : ""}" role="img" aria-label="${esc(marker.label)}"></i>` : ""}${unread ? '<i class="pdot unread" role="img" aria-label="unread"></i>' : ""}</div><button type="button" class="dots" data-project-menu="${esc(item.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Options for ${esc(item.name)}" title="Project options"${on ? "" : ' tabindex="-1"'}>${ICONS.dots}</button></div>`;
    }).join("");
    box.querySelectorAll(".ptab").forEach((node) => {
      node.addEventListener("click", () => selectProject(node.dataset.projectId));
      node.addEventListener("keydown", (event) => tabKeys(event, node, box, ".ptab", (next) => selectProject(next.dataset.projectId)));
    });
    box.querySelectorAll("[data-project-menu]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); const item = findProject(button.dataset.projectMenu); if (item) togglePopover($("ctxPop"), button, () => projectMenu(item, button)); }));
    if (focusedMenu) box.querySelector(`[data-project-menu="${CSS.escape(focusedMenu)}"]`)?.focus({ preventScroll: true });
    else if (focusedProject) box.querySelector(`[data-project-id="${CSS.escape(focusedProject)}"]`)?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const more = $("pmore"); more.hidden = box.scrollWidth <= box.clientWidth + 1;
      const selected = box.querySelector(".ptabw.sel");
      if (selected && !more.hidden) { const r = selected.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left < b.left ? r.left - b.left - 14 : r.right - b.right + 14; }
    });
    renderInboxButton();
    renderSoundButton();
    const meImage = $("meImg");
    const wanted = mePic();
    if (meImage.getAttribute("src") !== wanted) { meImage.dataset.fellBack = ""; meImage.src = wanted; }
    meImage.dataset.fallback = `/avatars/${ME_DEFAULT}`;
    applyTheme(activeTheme);
  }
  // Tabs, project tabs and Details pills: arrows, Home and End move and select; Enter and Space select.
  function tabKeys(event, node, box, selector, choose) {
    if (event.target !== node) return;
    const choices = $$(selector, box); const index = choices.indexOf(node);
    let next = null;
    if (event.key === "ArrowRight") next = choices[(index + 1) % choices.length];
    if (event.key === "ArrowLeft") next = choices[(index + choices.length - 1) % choices.length];
    if (event.key === "Home") next = choices[0];
    if (event.key === "End") next = choices.at(-1);
    if (next) { event.preventDefault(); next.focus(); choose(next); }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(node); }
  }
  // A finished reply (or a failed one) in a project that is not shown marks that project's tab until it is opened.
  function markUnread(tabId) {
    const project = allTabs().find(({ tab }) => tab.id === tabId)?.project;
    if (!project || project.id === currentProject()?.id || unreadProjects.has(project.id)) return;
    unreadProjects.add(project.id); renderHeader();
  }
  // The completion sound's speaker opens a popover: its switch is the same bellEnabled pref as Settings > Behaviour, its slider the bellVolume pref.
  // The speaker shows muted when the sound is off or at 0%.
  let soundSliding = false; // the slider moved and was not let go yet: a state redraw must not pull it back
  function renderSoundButton() {
    const on = Boolean(pref("bellEnabled", false)), volume = bellVolume(), button = $("soundBtn");
    button.dataset.muted = String(!on || volume === 0);
    button.title = on ? `Completion sound: on, ${volume}%` : "Completion sound: off";
    $("soundPop").dataset.on = String(on);
    $("soundSwitch").setAttribute("aria-checked", String(on));
    if (!soundSliding) $("soundVol").value = String(volume);
    showSoundLevel();
  }
