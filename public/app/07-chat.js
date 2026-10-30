// Command Center page script, part 7 of 12: the chat. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function runProcessAction(tab, action, extra = {}) {
    if (processPending.has(tab.id) || Date.now() < (stepClickGuard.get(tab.id) ?? 0)) return;
    if (!send({ type: action, tabId: tab.id, ...extra })) return;
    const since = Date.now();
    processPending.set(tab.id, action); processPendingSince.set(tab.id, since);
    // With no further state the button would stay "Sending…" for ever: free it after PROCESS_PENDING_MS unless the answer (or a newer click) got there first.
    setTimeout(() => {
      if (processPending.get(tab.id) !== action || processPendingSince.get(tab.id) !== since) return;
      processPending.delete(tab.id); processPendingSince.delete(tab.id);
      renderStatusLine(findTab(tab.id) ?? tab); renderChatIfShown();
    }, PROCESS_PENDING_MS);
    if (action !== "selectFixer") stepActionSent.add(tab.id);
    renderStatusLine(tab); renderChatIfShown();
  }
  function renderChatIfShown() { const tab = currentTab(); if (tab && inChat(tab)) renderChat(tab); }
  function meName() { return "You"; }
  function contextLine(tab) {
    const context = Number(tab?.leaderUsage?.contextTokens);
    const window = Number(tab?.leaderUsage?.contextWindow);
    if (tab?.leaderUsage?.contextTokens === null || tab?.leaderUsage?.contextTokens === undefined || !Number.isFinite(context) || !Number.isFinite(window) || window <= 0) return "not reported yet";
    return `${Math.max(0, Math.min(100, context / window * 100)).toFixed(1)}% of ${fmtK(window)} (estimate from the last turn)`;
  }
  function savedLabel(tab) {
    const meta = chatMeta.get(tab.id) ?? {};
    const revision = Number.isSafeInteger(meta.revision) ? meta.revision : tab.chatRevision;
    const savedRevision = Number.isSafeInteger(meta.savedRevision) ? meta.savedRevision : tab.savedRevision;
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(savedRevision)) return "";
    if (revision === savedRevision) return revision === 0 ? "Nothing to save yet" : "Saved";
    const at = meta.lastAt ?? transcript(tab).at(-1)?.at;
    if (Number.isFinite(at) && at > 0) return `Not saved since ${clockTime(at)}`;
    return "Not saved yet";
  }
  function renderSaveArea(tab) {
    const status = $("saveSt"), button = $("saveBtn"), save = saveStates.get(tab.id), saving = savePending.has(tab.id);
    const label = savedLabel(tab), dirty = /^Not saved/.test(label);
    const word = saving ? "Saving…" : save?.status === "failed" ? "Save failed" : save?.status === "unknown" ? "Save not confirmed" : label;
    status.className = `savest${save?.status === "failed" ? " bad" : (dirty && !saving) || save?.status === "unknown" ? " warn" : ""}`;
    const split = word.match(/^(Not saved)( since .+)$/);
    status.innerHTML = `${saving ? '<span class="spin" aria-hidden="true"></span>' : ""}${split ? `${esc(split[1])}<span class="sw2">${esc(split[2])}</span>` : esc(word)}`;
    status.title = `${word}${save?.message ? `. ${save.message}` : ""}`;
    button.disabled = saving;
    button.innerHTML = `${ICONS.save}${save ? "Retry save" : "Save"}${dirty && !saving ? '<span class="udot" aria-hidden="true"></span>' : ""}`;
    button.title = `${save?.message ? `${save.message}. ` : ""}Saves the handover to ${tab.folder}${tab.folder?.includes("/") ? "/" : "\\"}.command-center${tab.folder?.includes("/") ? "/" : "\\"}${tab.id}${tab.folder?.includes("/") ? "/" : "\\"}RESUME.md`;
    button.setAttribute("aria-label", `${save ? "Retry save" : "Save"}. ${word}`);
  }
  function startSave(tab) {
    if (!tab || savePending.has(tab.id)) return;
    savePending.add(tab.id); saveStates.delete(tab.id); renderStage();
    if (!send({ type: "save", tabId: tab.id })) { savePending.delete(tab.id); renderStage(); }
  }
  function chatMenu(anchor) {
    const tab = currentTab(); if (!tab) return;
    const name = leaderName(tab);
    makeMenu($("ctxPop"), anchor, [
      { label: "Past sessions", sub: `Saved sessions with ${name}, and runs from earlier crews`, attrs: 'data-session-action="history"', run: () => showLeaderHistory(tab) },
      { label: "Clear chat", danger: true, sub: `Asks first. Stops ${name} and starts fresh`, keepFocusAway: true, attrs: 'data-session-action="clear"', run: () => clearConfirmMenu(anchor) },
      { hr: true },
      { hint: `${name}'s context: ${contextLine(tab)}`, attrs: `data-context-meter title="${esc(contextLine(tab))}"` },
    ], "Chat options");
  }
  function clearConfirmMenu(anchor) {
    const tab = currentTab(); if (!tab) return;
    const name = leaderName(tab), label = savedLabel(tab), dirty = /^Not saved/.test(label), saved = Number(tab.savedRevision) > 0;
    makeMenu($("ctxPop"), anchor?.isConnected ? anchor : $("chatMore"), [
      { hint: tab.chatProblem
        ? "Clear moves the damaged chat file aside as a copy and starts a fresh chat. This cannot be undone."
        : `${dirty ? `${label}. ` : ""}Clear stops ${name} and starts a fresh chat. ${saved ? `${name} reads the saved handover first.` : "Nothing is saved yet, so the fresh chat has no handover."} You can undo for 10 seconds.` },
      ...(dirty ? [{ label: "Save first", sub: "Then clear it yourself", run: () => startSave(tab) }] : []),
      { label: "Clear chat", danger: true, attrs: "data-clear-confirm", run: () => send({ type: "clear", tabId: tab.id }) },
      { label: "Cancel", attrs: "data-clear-cancel", run: () => {} },
    ], "Clear chat?");
  }

  // ---------- chat ----------
  function transcript(tab) { return transcripts.get(tab.id) ?? []; }
  function messageRole(message) { return message.role ?? message.kind ?? message.type ?? "assistant"; }
  function messageText(message) { return message.text ?? message.content ?? message.message ?? ""; }
  function attachmentList(tabId) { return attachmentsByTab.get(tabId) ?? []; }
  function noteTextEdit(tabId) { textVersionByTab.set(tabId, (textVersionByTab.get(tabId) ?? 0) + 1); }
  // Only a send still on its way locks the composer: while the leader replies a message is queued instead (see queueComposer).
  function chatSendLocked(tabId) { return pendingChatByTab.has(tabId); }
  function newChatRequestId() {
    let requestId;
    do { requestId = crypto.randomUUID().replaceAll("-", ""); } while (chatRequestsById.has(requestId));
    return requestId;
  }
  function newRequestId() { return crypto.randomUUID().replaceAll("-", ""); }
  function listedActions() {
    const settings = serverState?.settings ?? {};
    return [
      ...Object.values(settings.tools ?? {}).map((item) => item?.action),
      settings.github?.action, settings.preferenceAction,
      ...Object.values(settings.skills ?? {}).map((item) => item?.action),
      ...Object.values(settings.permissionActions ?? {}),
      ...Object.values(settings.uploads ?? {}),
      ...Object.values(serverState.requestActions ?? {}),
      ...allTabs().map(({ tab }) => tab.permissionAction),
    ];
  }
  function actionStateFor(requestId) {
    if (!requestId || !serverState) return null;
    const finished = [...settingsActionResults.values(), ...permissionActionResults.values(), ...requestActionResults.values()].find((item) => item.requestId === requestId);
    if (finished) return finished;
    const listed = listedActions().find((item) => item?.requestId === requestId);
    if (listed) return listed;
    return null;
  }
  function actionStatusMarkup(key) {
    const requestId = settingsActionId(key);
    if (!requestId) return '<span class="action-status" aria-live="polite"></span>';
    const state = actionStateFor(requestId);
    const status = state?.status ?? "running";
    return `<span class="action-status" data-status="${esc(status)}" data-status-for="${esc(requestId)}" aria-live="polite">${esc(state?.message ?? (status === "running" ? "Working" : ""))}</span>`;
  }
  const settingsSubmits = new Map();
  const settingsEdits = new Set();
  const savedBy = { "vault-save": ["vault-path"], "folder-save": ["default-folder"], "plugin-add": ["plugin-name"], "acp-add": ["acp-name", "acp-command"], ...Object.fromEntries(["claude", "codex", "opencode", "gemini"].map((cli) => [`mcp-add-${cli}`, [`mcp-name-${cli}`, `mcp-command-${cli}`]])) };
  function sendSettingsAction(key, payload) {
    const requestId = newRequestId();
    if (!send({ ...payload, requestId })) return null;
    if (savedBy[key]) settingsSubmits.set(key, { requestId, fields: new Map((savedBy[key] ?? []).map((field) => [field, $("setBody").querySelector(`[data-focus-key="${field}"]`)?.value])) });
    pendingSettingsActions.set(key, requestId);
    return requestId;
  }
  function abandonChatOnTabSwitch(tabId) {
    const requestId = pendingChatByTab.get(tabId);
    if (!requestId) return;
    pendingChatByTab.delete(tabId);
    const request = chatRequestsById.get(requestId);
    if (!request) return;
    if (request.sent) request.status = "abandoned";
    else chatRequestsById.delete(requestId);
  }
  function settleChatRequest(request, accepted) {
    if (chatRequestsById.get(request.requestId) !== request) return;
    // A queued message that was sent or steered: it leaves the queue when the server took it, otherwise it waits where it was.
    if (request.queueItem) {
      chatRequestsById.delete(request.requestId);
      request.queueItem.state = "waiting"; request.queueItem.requestId = null;
      if (accepted) removeQueued(request.tabId, request.queueItem);
      if (currentTab()?.id === request.tabId) { renderQueue(); updateChatLoading(request.tabId); }
      return;
    }
    const anotherRequestIsPending = pendingChatByTab.get(request.tabId) !== undefined
      && pendingChatByTab.get(request.tabId) !== request.requestId;
    chatRequestsById.delete(request.requestId);
    if (pendingChatByTab.get(request.tabId) === request.requestId) pendingChatByTab.delete(request.tabId);
    if (accepted && !anotherRequestIsPending) {
      if ((textVersionByTab.get(request.tabId) ?? 0) === request.textVersion) {
        draftsByTab.set(request.tabId, "");
        if (composerTabId === request.tabId) { $("ci").value = ""; fitComposer(); }
      }
      const list = attachmentList(request.tabId);
      const remaining = list.filter((item) => !request.items.includes(item));
      for (const item of request.items) if (list.includes(item)) releaseAttachment(item);
      if (remaining.length) attachmentsByTab.set(request.tabId, remaining);
      else attachmentsByTab.delete(request.tabId);
    }
    if (currentTab()?.id === request.tabId) { renderAttachments(); updateChatLoading(request.tabId); }
  }
  function releaseAttachment(item) {
    if (!item || item.released) return;
    item.released = true;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = ""; item.file = null; item.promise = null;
  }
  // Correlation keeps accepted sends tied to their original composer snapshot.
  function releaseTabAttachments(tabId) {
    pendingChatByTab.delete(tabId);
    for (const [requestId, request] of chatRequestsById) if (request.tabId === tabId) chatRequestsById.delete(requestId);
    for (const item of attachmentList(tabId)) releaseAttachment(item);
    clearQueue(tabId);
    attachmentsByTab.delete(tabId); draftsByTab.delete(tabId); textVersionByTab.delete(tabId);
    if (currentTab()?.id === tabId) renderAttachments();
  }
  function renderAttachments() {
    const tab = currentTab(); const box = $("atts");
    const rows = tab ? attachmentList(tab.id) : [];
    const locked = Boolean(tab && pendingChatByTab.has(tab.id));
    box.innerHTML = rows.map((item) => `<span class="att${item.kind === "file" ? " att-file" : " img"}${item.status === "error" ? " err" : ""}" data-attachment="${esc(item.id)}">${item.kind === "file" ? `<span class="file-icon" aria-hidden="true">${esc(item.extension.slice(1) || "file")}</span>` : `<img class="thumb" src="${esc(item.previewUrl)}" alt="">`}<span title="${esc(item.name)}">${esc(item.name)}</span>${item.status === "loading" ? "<small>Loading file</small>" : item.status === "error" ? `<small>${esc(item.error ?? "Could not load")}</small>` : ""}<button type="button" data-remove-attachment="${esc(item.id)}" aria-label="Remove attachment ${esc(item.name)}" title="Remove attachment">${ICONS.x}</button></span>`).join("");
    if (locked) box.querySelectorAll("[data-remove-attachment]").forEach((button) => { button.disabled = true; });
    box.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => {
      if (pendingChatByTab.has(tab?.id)) return;
      const current = attachmentList(tab?.id); const index = current.findIndex((item) => item.id === button.dataset.removeAttachment);
      if (index < 0) return;
      releaseAttachment(current[index]); current.splice(index, 1); if (!current.length) attachmentsByTab.delete(tab.id);
      renderAttachments(); updateChatLoading(tab.id);
    }));
    box.hidden = rows.length === 0;
  }
  function updateChatLoading(tabId) {
    if (currentTab()?.id === tabId) {
      const loadingAttachment = attachmentList(tabId).some((item) => item.status === "loading");
      const pending = pendingChatByTab.has(tabId);
      const activeTurn = findTab(tabId)?.derived?.leaderTurnActive === true;
      const canChat = inChat(currentTab());
      const status = pending ? loadingAttachment ? "Loading file" : "Sending" : loadingAttachment ? "Loading file" : "";
      $("chatStatus").textContent = status;
      $("chatStatus").hidden = !status;
      $("ci").readOnly = pending;
      $("attachBtn").disabled = !canChat || pending;
      $("sendBtn").disabled = !canChat || !$("ci").value.trim() || pending || savePending.has(tabId);
      // Mid-reply the button queues the message (it goes out when the reply ends, or when its Steer is clicked).
      const label = activeTurn ? "Queue message" : "Send message";
      $("sendBtn").setAttribute("aria-label", label); $("sendBtn").title = label;
    }
    renderQueue();
  }
  function addImageAttachment(file, tabId = currentTab()?.id) {
    if (!tabId || !findTab(tabId)) return;
    if (pendingChatByTab.has(tabId)) return;
    if (!/^image\/(?:png|jpeg|webp)$/.test(file?.type ?? "")) { showToast("Only PNG, JPEG and WebP images can be attached"); return; }
    if (file.size > 12 * 1024 * 1024) { showToast("Images must be 12 MiB or smaller"); return; }
    if (attachmentList(tabId).filter((item) => item.kind === "image").length >= MAX_IMAGES) { showToast(`Attach up to ${MAX_IMAGES} images per message`); return; }
    const item = { id: `attachment-${Date.now()}-${Math.random()}`, kind: "image", name: file.name || "Image", extension: "image", file, previewUrl: URL.createObjectURL(file), path: "", status: "loading", promise: null, released: false };
    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);
    item.promise = (async () => {
      const bytes = await file.arrayBuffer();
      if (item.released) return null;
      const requestId = newRequestId(); item.requestId = requestId;
      const response = await keyedFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": file.type, "X-Request-Id": requestId }, body: bytes });
      if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
      const result = await response.json();
      if (typeof result.path !== "string") throw new Error("Image upload returned no path");
      if (item.released) return null;
      item.path = result.path; item.file = null; item.status = "ready";
      return result.path;
    })().catch((error) => {
      if (!item.released) { item.status = "error"; item.file = null; showToast(error?.message ?? "Could not load that image"); }
      return null;
    }).finally(() => {
      updateChatLoading(tabId);
      if (currentTab()?.id === tabId) renderAttachments();
    });
    renderAttachments(); updateChatLoading(tabId);
  }
  function fileExtension(name) { return String(name ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""; }
  function addFileAttachment(file, tabId = currentTab()?.id) {
    if (!tabId || !findTab(tabId) || pendingChatByTab.has(tabId)) return;
    const extension = fileExtension(file?.name);
    if (!FILE_EXTENSIONS.has(extension)) { showToast("That file type is not supported"); return; }
    if (file.size > 20 * 1024 * 1024) { showToast("Files must be 20 MiB or smaller"); return; }
    if (attachmentList(tabId).filter((item) => item.kind === "file").length >= MAX_FILES) { showToast(`Attach up to ${MAX_FILES} files per message`); return; }
    const item = { id: `attachment-${Date.now()}-${Math.random()}`, kind: "file", name: file.name, extension, file, previewUrl: "", path: "", status: "loading", promise: null, released: false };
    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);
    item.promise = (async () => {
      const bytes = await file.arrayBuffer();
      if (item.released) return null;
      const requestId = newRequestId(); item.requestId = requestId;
      const response = await keyedFetch("/api/paste-file", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Request-Id": requestId, "X-File-Name": encodeURIComponent(file.name) }, body: bytes });
      if (!response.ok) throw new Error(`File upload failed (${response.status})`);
      const result = await response.json();
      if (typeof result.path !== "string") throw new Error("File upload returned no path");
      if (item.released) return null;
      item.path = result.path; item.name = result.name || item.name; item.file = null; item.status = "ready";
      return result.path;
    })().catch((error) => {
      if (!item.released) { item.status = "error"; item.error = error?.message ?? "Could not load that file"; item.file = null; showToast(item.error); }
      return null;
    }).finally(() => {
      updateChatLoading(tabId);
      if (currentTab()?.id === tabId) renderAttachments();
    });
    renderAttachments(); updateChatLoading(tabId);
  }
  function transcriptImageUrl(path) { return `/api/paste-image?path=${encodeURIComponent(path)}`; }
  function messageImages(message) {
    const images = Array.isArray(message.images) ? message.images : [];
    if (!images.length) return "";
    return images.map((path) => {
      const name = String(path).split(/[\\/]/).at(-1) || "Image";
      return `<button type="button" class="file img" data-open-shot="${esc(path)}" title="${esc(name)}"><img class="thumb" src="${esc(transcriptImageUrl(path))}" alt="">${esc(name)}</button>`;
    }).join("");
  }
  function messageFiles(message) {
    const files = Array.isArray(message.files) ? message.files : [];
    return files.map((path) => {
      const name = String(path).split(/[\\/]/).at(-1) || "File";
      return `<span class="file file-chip" title="${esc(name)}"><span class="file-icon" aria-hidden="true">${esc(fileExtension(name).slice(1) || "file")}</span>${esc(name)}</span>`;
    }).join("");
  }
  function messageTime(message) {
    if (typeof message.createdAt === "string") return message.createdAt;
    const timestamp = Number(message.at ?? message.time);
    return Number.isFinite(timestamp) && timestamp > 0 ? clockTime(timestamp) : "";
  }
  function screenshotPaths(tab) {
    const paths = transcript(tab).flatMap((message) => Array.isArray(message.images) ? message.images.filter((path) => typeof path === "string") : []);
    return [...new Set(paths)];
  }
  // A finished message is rendered once: the html is kept per tab + revision (the server sends no id) and reused until anything it shows changes.
  // ponytail: cleared past 3000 entries, a smarter eviction if a long session ever shows the refill cost.
  const messageHtmlCache = new Map();
  function renderMessage(tab, message) {
    const speaker = leader(tab);
    const sig = [messageRole(message), message.revision, messageText(message), messageTime(message), speaker?.name, seatPic(speaker), speaker?.slot, JSON.stringify(message.images ?? null), JSON.stringify(message.files ?? null)].join("\u0001");
    const key = Number.isFinite(message.revision) ? `${tab.id}\u0001${message.revision}` : null;
    // The html holds the picture's blob URL, which a later upload revokes: the URL itself is part of what the html depends on.
    const pic = mePic();
    const cached = key && messageHtmlCache.get(key);
    if (cached && cached.sig === sig && cached.pic === pic) return cached.html;
    const html = renderMessageHtml(tab, message);
    if (key) { if (messageHtmlCache.size > 3000) messageHtmlCache.clear(); messageHtmlCache.set(key, { sig, pic, html }); }
    return html;
  }
  function renderMessageHtml(tab, message) {
    // A heads-up from Command Center itself: a quiet line, not the leader speaking and not you.
    if (messageRole(message) === "notice") return `<div class="msg note" data-message-id="${esc(message.id ?? message.revision ?? "")}"><p>${esc(messageText(message))}</p></div>`;
    const user =["user", "human"].includes(messageRole(message));
    const speaker = leader(tab);
    const text = esc(messageText(message));
    const when = messageTime(message);
    const chips = messageImages(message) + messageFiles(message);
    const files = chips ? `<div class="files">${chips}</div>` : "";
    return user
      ? `<div class="msg mine" data-message-id="${esc(message.id ?? message.revision ?? "")}"><div class="body"><span class="meta">${esc(when)} <b>${esc(meName())}</b></span><div class="bubble"><p>${text}</p></div>${files}</div>${img(mePic(), `/avatars/${ME_DEFAULT}`, ' class="uav" alt="Your avatar"').replace(' alt=""', "")}</div>`
      : `<div class="msg" data-message-id="${esc(message.id ?? message.revision ?? "")}">${seatImg(speaker)}<div class="body"><span class="meta"><b>${esc(speaker?.name ?? "Lead")}</b>${esc(when)}</span><div class="md">${mdHtml(messageText(message))}</div>${files}</div></div>`;
  }
  function lookCard(tab) {
    const shots = screenshotPaths(tab).length, pending = processPending.get(tab.id);
    if (lookPending(tab)) {
      const rounds = (tab.derived?.stepBar ?? []).some((step) => step.type === "rounds");
      return `<div class="msg"><span></span><div class="ask" id="lookCard"><div class="h">${ICONS.warn}Your turn: approve the look</div><p>${rounds ? "Review round 1 starts after you approve and any running work finishes. Nothing is reviewed until then." : "This setup has no review rounds: approving finishes this work."}</p><div class="acts"><button type="button" class="btn primary" data-process-action="approveLook"${pending ? " disabled" : ""}>${pending === "approveLook" ? "Approving…" : "Approve the look"}</button><button type="button" class="btn" data-ask-changes>Ask for changes</button>${shots ? `<button type="button" class="btn" data-open-screenshots="${esc(tab.id)}">Open screenshots <span class="faint">${shots}</span></button>` : ""}</div></div></div>`;
    }
    if (tab.processState?.approval?.state === "approved") {
      const actor = reviewActor(tab), paused = actor?.seat && ["stopped", "failed"].includes(actor.seat.status);
      const line = paused ? `Round ${actor.round} is paused. ${actor.seat.name}${actor.seat.status === "failed" ? "'s run failed." : " was stopped."}` : tab.derived?.approvedCardLine ?? "The process continues.";
      return `<div class="msg"><span></span><div class="ask ${paused ? "stop" : "ok"}"><div class="h">${paused ? ICONS.warn : ICONS.ok}${tab.steps?.some((step) => step.type === "look") ? "Look approved" : "Review rounds"}</div><p>${esc(line)}</p>${shots ? `<div class="acts"><button type="button" class="btn" data-open-screenshots="${esc(tab.id)}">Open screenshots <span class="faint">${shots}</span></button></div>` : ""}</div></div>`;
    }
    return "";
  }
  function askForChanges() {
    const tab = currentTab(); if (!tab) return;
    selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live";
    renderStage();
    const input = $("ci");
    if (!input.value.trim()) { input.value = "Please make these changes: "; draftsByTab.set(tab.id, input.value); noteTextEdit(tab.id); }
    fitComposer(); updateChatLoading(tab.id);
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  // A streamed delta only rewrites the text of the bubble already on screen, at most once per frame; anything else renders the stage as before.
  let streamFrame = 0;
  function streamDraftUpdate(tabId) {
    const view = $("view");
    const bubble = view.dataset.tabId === tabId && view.dataset.mode === "chat" ? view.querySelector("[data-stream] .md") : null;
    if (!bubble || !streamingByTab.get(tabId) || selectedSeat(currentTab())?.isLeader === false || selectedView === "history") { renderStage(); return; }
    if (streamFrame) return;
    // The timer is the fallback for a window that is not painting (hidden, minimized), where frames never come.
    let timer = 0;
    streamFrame = requestAnimationFrame(() => { clearTimeout(timer); paint(); });
    timer = setTimeout(() => { cancelAnimationFrame(streamFrame); paint(); }, 50);
    function paint() {
      streamFrame = 0;
      // The one scheduled paint serves whichever chat is shown now: a delta for it may have returned early while this frame was held for another tab.
      const shown = currentTab()?.id, live = $("view"), p = live.dataset.tabId === shown && live.dataset.mode === "chat" ? live.querySelector("[data-stream] .md") : null, draft = streamingByTab.get(shown);
      if (!p || !draft) { if (shown === tabId) renderStage(); return; }
      const stick = live.scrollHeight - live.scrollTop - live.clientHeight <= 4;
      p.innerHTML = mdHtml(draft);
      if (stick) live.scrollTop = live.scrollHeight;
    }
  }
  // The step line sits in the Replying bubble's header; a change repaints just that span.
  function paintStep(tabId) {
    const view = $("view");
    if (tabId !== currentTab()?.id || view.dataset.tabId !== tabId || view.dataset.mode !== "chat") return;
    const label = stepByTab.get(tabId) ?? "";
    for (const element of view.querySelectorAll("[data-activity]")) { element.textContent = label; element.hidden = !label; }
  }
