// Command Center page script, part 9 of 12: Needs you, stopping and the composer extras. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function renderNotes() {
    const tab = currentTab(); const notes = tab?.notes;
    if (!tab || !notes) { $("lowerBody").innerHTML = '<span class="faint">Waiting for server state.</span>'; return; }
    const content = typeof notes.content === "string" ? notes.content : "";
    const vault = serverState?.settings?.vault?.path ?? null;
    // A fenced block (one with its closing ```) shows as typed, as code; the fence lines themselves are dropped.
    const raw = content.split(/\r?\n/), closes = fenceCloses(raw), lines = [];
    for (let i = 0, fenced = false; i < raw.length; i += 1) {
      const line = raw[i].trim();
      if (!fenced && /^```/.test(line) && /^```\s*[\w+#.-]*$/.test(line) && closes[i] > i) { fenced = true; continue; }
      if (fenced ? /^```\s*$/.test(line) : /^```/.test(line)) { fenced = false; continue; }
      if (line) lines.push({ line, code: fenced });
    }
    const first = lines.shift();
    const noteHtml = (item, bare) => item.code ? `<code>${esc(item.line)}</code>` : mdInline(bare ? item.line.replace(/^[-*+]\s+/, "").replace(/^#+\s*/, "") : item.line.replace(/^#+\s*/, ""));
    const summary = first ? noteHtml(first) : mdInline("Nothing saved yet. Save writes where you left off.");
    const noteRows = lines.map((item) => `<li data-note-row>${noteHtml(item, true)}</li>`).join("");
    const separator = tab.folder?.includes("/") ? "/" : "\\";
    // The server reads this tab's own handover, or the folder's older shared one until the tab has saved its own.
    const shared = Boolean(notes.path) && !notes.path.replace(/\\/g, "/").endsWith(`/${tab.id}/RESUME.md`);
    const openButton = window.cc && typeof window.cc.openObsidian === "function"
      ? `<div class="note-open-row"><button type="button" class="btn" data-open-vault ${vault ? "" : "disabled"}>${logo("obsidian", 13, 2)}Open in Obsidian</button>${vault ? "" : '<span class="faint" data-vault-empty style="font-size:12.5px">No vault is connected</span>'}</div>` : "";
    $("lowerBody").innerHTML = `${notes.truncated ? `<div class="blk soft2">${ICONS.warn}<span>The handover is longer than 64 KiB, so only its first 64 KiB shows here.</span></div>` : ""}<div class="resume"><span class="lbl">Where we left off</span><p>${summary}${notes.truncated ? " …" : ""}</p></div>${noteRows ? `<ul class="note-rows">${noteRows}</ul>` : '<ul class="note-rows"><li class="faint" style="list-style:none;margin-left:-18px">No note details yet.</li></ul>'}<div class="kv"><span>File</span><span class="path" title="${esc(`${tab.folder}${separator}.command-center${separator}${shared ? "" : `${tab.id}${separator}`}RESUME.md`)}">.command-center${separator}${shared ? "" : `${tab.id}${separator}`}RESUME.md${shared ? " (shared, older: this tab's Save writes its own)" : ""}</span></div>${openButton}`;
    $("lowerBody").querySelector("[data-open-vault]")?.addEventListener("click", openObsidianVault);
  }
  function renderMeters() {
    const meters = $("meters");
    const rows = [];
    for (const [runId, windows] of rateWindowsByRun) {
      const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === runId);
      if (!run || !windows || typeof windows !== "object") continue;
      for (const [key, value] of Object.entries(windows)) {
        if (!value || typeof value !== "object") continue;
        let percent = null;
        for (const field of ["utilization", "usedPercent", "percentage", "percent"]) {
          const candidate = value[field]; if (typeof candidate === "number" && Number.isFinite(candidate)) { percent = candidate <= 1 ? candidate * 100 : candidate; break; }
          if (typeof candidate === "string" && /^\d+(?:\.\d+)?%$/.test(candidate)) { percent = Number.parseFloat(candidate); break; }
        }
        if (percent === null && Number(value.limit) > 0 && Number.isFinite(Number(value.used))) percent = Number(value.used) / Number(value.limit) * 100;
        if (percent === null || !Number.isFinite(percent)) continue;
        percent = Math.max(0, Math.min(percent, 100));
        const pct = `${percent.toFixed(0)}%`;
        rows.push(`<div class="meter"><div class="row"><span>${esc(cliLabel(run.cli))} · ${esc(titleCase(key))}</span><b>${pct}</b></div><div class="bar"><i style="width:${pct}"></i></div><span class="faint" style="font-size:12px">Reported by ${esc(run.seatName ?? "a run")}'s run</span></div>`);
      }
    }
    meters.innerHTML = rows.join(""); meters.hidden = !rows.length;
    $("metersNote").textContent = rows.length ? "Other CLIs: not reported. Limits show up only while a run reports them." : "Not reported. Limits show up only while a run reports them.";
  }
  // Open or closed is the server's client pref (detailsOpen): a new window on a new port keeps it. Nothing changes when it could not be sent.
  function setSideOpen(open) {
    if (!saveClientPref("detailsOpen", open)) return;
    sideOpen = open;
    renderSide();
  }
  function sideWidth() { return Math.max(280, Math.min(560, Math.round(sideWidthDraft ?? Number(pref("rightPanelWidth", 320)) ?? 320))); }
  function applySideWidth() {
    const width = sideWidth();
    $("main").style.setProperty("--sidew", `${width}px`);
    $("sgrip").setAttribute("aria-valuenow", String(width));
  }
  function saveSideWidth(width) {
    const value = Math.max(280, Math.min(560, Math.round(width)));
    sideWidthDraft = null;
    if (value === Number(pref("rightPanelWidth", 320))) { applySideWidth(); return; }
    if (send({ type: "updateClientPref", key: "rightPanelWidth", value })) clientPrefOverrides.set("rightPanelWidth", value);
    applySideWidth();
  }

  // ---------- Needs you ----------
  function attention(tab) {
    const items = [];
    for (const approval of tab.pendingApprovals ?? []) items.push({ type: "toolApproval", tab, approval });
    if (lookPending(tab)) items.push({ type: "look", tab });
    for (const request of serverState?.requests ?? []) if (request.status === "pending" && request.toTabId === tab.id) items.push({ type: "request", tab, request });
    for (const run of unseenFailedRuns(tab)) items.push({ type: "failed", tab, run, bad: true });
    for (const run of (tab.runs ?? []).filter((item) => item.status === "working" && item.stalled)) items.push({ type: "stalled", tab, run, bad: true });
    const safety = serverState?.launchSafety ?? {};
    for (const row of safety.uncertain ?? []) if (tabIdOfKey(row.seatKey ?? row.seatId) === tab.id) items.push({ type: "uncertain", tab, row, bad: true });
    for (const row of safety.blocked ?? []) { const key = typeof row === "string" ? row : row?.seatKey ?? row?.seatId; if (tabIdOfKey(key) === tab.id) items.push({ type: "blocked", tab, key }); }
    for (const row of safety.notices ?? []) if (row.pending && tabIdOfKey(row.seatKey ?? row.seatId) === tab.id) items.push({ type: "notice", tab, row });
    const save = saveStates.get(tab.id);
    if (save?.status === "failed" || (save?.status === "unknown" && !save.checking)) items.push({ type: "save", tab, save, bad: true });
    return items;
  }
  function attentionFor(tabs) { return tabs.flatMap(attention); }
  // Safety records that belong to no current tab (old bare seat IDs, or a removed tab) still need you: they are listed on their own, never dropped.
  function orphanAttention() {
    const safety = serverState?.launchSafety ?? {}, known = (key) => Boolean(findTab(tabIdOfKey(key)));
    return [
      ...(safety.uncertain ?? []).filter((row) => !known(row.seatKey ?? row.seatId)).map((row) => ({ type: "uncertain", tab: null, row, bad: true })),
      ...(safety.blocked ?? []).map((row) => typeof row === "string" ? row : row?.seatKey ?? row?.seatId).filter((key) => key && !known(key)).map((key) => ({ type: "blocked", tab: null, key })),
      ...(safety.notices ?? []).filter((row) => row.pending && !known(row.seatKey ?? row.seatId)).map((row) => ({ type: "notice", tab: null, row })),
    ];
  }
  function allAttention() { return [...allTabs().filter(({ project, tab }) => !hiddenProject(project.id) && !hiddenTab(tab.id)).flatMap(({ tab }) => attention(tab)), ...orphanAttention()]; }
  function attentionMark(items) { return items.length ? { bad: items.some((item) => item.bad), label: `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you` } : null; }
  function whereLine(item, key) {
    if (item.tab) return `<small title="${esc(tabLabel(item.tab.id))}">${esc(tabLabel(item.tab.id))}</small>`;
    const value = String(key ?? "");
    const label = value.includes(".") ? `Removed tab · seat ${value}` : `Old seat ID ${value}`;
    return `<small title="${esc(label)}">${esc(label)}</small>`;
  }
  // Said for a seat whose CLI cannot enforce read-only (Codex, an ACP CLI): it is only asked not to write, so a stop that was not confirmed may still be writing.
  function readOnlyWarning(seat) { return seat && cliCap(seat.cli)?.readOnlyEnforced === false ? `<p class="safety-warning">${esc(seat.name)} runs on ${esc(cliLabel(seat.cli))}, which cannot be held read-only. It can still write.</p>` : ""; }
  function phraseInput(attr, key, label, placeholder) { const draftKey = `${attr}:${key}`; return `<input class="inp phrase" ${attr}="${esc(key)}" data-phrase-key="${esc(draftKey)}" value="${esc(phraseDrafts.get(draftKey) ?? "")}" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" autocomplete="off">`; }
  function requestCard(request, incoming) {
    const actionKey = `request-resolve-${request.id}`;
    const localRequestId = settingsActionId(actionKey);
    const trackedAction = localRequestId ? actionStateFor(localRequestId) ?? { requestId: localRequestId, status: "running", message: "Working" } : null;
    // A card that already resolved is never "Working".
    const action = request.status !== "pending" && trackedAction?.status === "running" ? null : trackedAction;
    const source = requestTabLabel(request.fromTabId); const destination = requestTabLabel(request.toTabId);
    const status = requestStatusLabel(request.status);
    const leaderNameText = destination.tab ? leaderName(destination.tab) : "the leader";
    const stateClass = request.status === "accepted" ? "ok" : request.status === "pending" ? "wait" : request.status === "destinationRemoved" ? "bad" : "";
    const controls = request.status === "pending" && incoming && destination.tab
      ? `<div class="acts req-actions"><button type="button" class="btn sm primary" data-request-action="accept:${esc(request.id)}" ${action?.status === "running" ? "disabled" : ""}><span class="bl" title="${esc(`Hand to ${destination.name}'s ${leaderNameText}`)}">Hand to ${esc(destination.name)}'s ${esc(leaderNameText)}</span></button><button type="button" class="btn sm" data-request-action="decline:${esc(request.id)}" ${action?.status === "running" ? "disabled" : ""}>Decline</button></div>`
      : `<div class="acts"><span class="state req-sent-state ${stateClass}" data-request-status="${esc(request.status)}">${esc(status)}</span>${request.status === "destinationRemoved" ? '<span class="st">That tab was removed, so this request can no longer be answered.</span>' : ""}</div>`;
    return `<article class="ncard req${request.status === "destinationRemoved" ? " removed" : request.status !== "pending" ? " resolved" : ""}${incoming ? " incoming" : " sent"}" data-request-id="${esc(request.id)}"><div class="route"><span class="tg${source.tab ? "" : " gone"}" title="${esc(source.label)}">${esc(source.label)}</span><span class="route-arrow" aria-label="to">&#8594;</span><span class="tg${destination.tab ? "" : " gone"}" title="${esc(destination.label)}">${esc(destination.label)}</span><span class="spacer"></span><time class="req-time">${esc(requestTimeAgo(request.createdAt))}</time></div><b class="req-title">${plainMd(request.title)}</b><div class="req-body md">${mdHtml(request.body)}</div>${action ? `<span class="action-status" data-status="${esc(action.status)}" data-status-for="${esc(localRequestId)}">${esc(action.message)}</span>` : ""}${controls}</article>`;
  }
  function attentionCard(item) {
    const tab = item.tab;
    if (item.type === "toolApproval") return `<div class="ncard apx">${whereLine(item)}<b>${esc(approvalTitle(item.approval.tool, tab, item.approval.askedBy))}</b><code class="approval-code"><span class="approval-path">${esc(item.approval.summary)}</span></code><div class="acts"><button type="button" class="btn sm primary" data-wait-approval="${esc(item.approval.approvalId)}" data-approval-tab="${esc(tab.id)}">Open it</button><span class="st">Answer it above ${esc(tab.name)}'s composer</span></div></div>`;
    if (item.type === "look") { const shots = screenshotPaths(tab).length; return `<div class="ncard look">${whereLine(item)}<b>Approve the look</b><p>${esc(leaderName(tab))}${shots ? ` has ${shots} screenshot${shots === 1 ? "" : "s"} ready for you.` : " is waiting for your look."}</p><div class="acts"><button type="button" class="btn sm primary" data-wait-tab="${esc(tab.id)}">Open it</button></div></div>`; }
    if (item.type === "request") return requestCard(item.request, true);
    if (item.type === "failed") return `<div class="ncard bad">${whereLine(item)}<b>${esc(item.run.seatName)}'s run failed</b><p>${plainMd(item.run.label)} · ${esc(item.run.outcome ?? "failed")}${item.run.endedAt ? ` · ${esc(agoText(item.run.endedAt))}` : ""}</p><div class="acts"><button type="button" class="btn sm primary" data-open-seat="${esc(item.run.seatSlotId)}" data-open-tab="${esc(tab.id)}">Open ${esc(item.run.seatName)}</button><button type="button" class="btn sm" data-dismiss-run="${esc(item.run.runId)}">Dismiss</button></div></div>`;
    if (item.type === "stalled") return `<div class="ncard bad">${whereLine(item)}<b>${esc(item.run.seatName)}'s run stalled</b><p>${plainMd(item.run.label)}: no output for ${STALL_MINUTES} minutes. ${stallActions.get(item.run.runId) === "relaunch" ? "Command Center is stopping it and starting it once more." : "It was not relaunched by itself."}</p><div class="acts"><button type="button" class="btn sm primary" data-open-seat="${esc(item.run.seatSlotId)}" data-open-tab="${esc(tab.id)}">Watch it</button><button type="button" class="btn sm danger" data-stop-run="${esc(item.run.runId)}">Stop this run</button></div></div>`;
    if (item.type === "uncertain") {
      const key = item.row.seatKey ?? item.row.seatId ?? "unknown seat", runId = item.row.runId, owner = seatOfKey(key);
      const run = owner.tab?.runs?.find((candidate) => candidate.runId === runId);
      const sameSeat = uncertainRows().filter((row) => (row.seatKey ?? row.seatId) === key).length;
      return `<div class="ncard bad">${whereLine(item, key)}<b>Stop not confirmed · ${esc(owner.seat?.name ?? owner.slot)}</b><p>PID ${esc(item.row.pid ?? "unknown")}${run ? ` (${plainMd(run.label)})` : ""} may still be running and editing files. Try to stop it again, or release it if you are sure.</p>${readOnlyWarning(owner.seat)}${runId ? `<div class="acts"><button type="button" class="btn sm" data-retry-kill="${esc(runId)}">Try to stop again</button></div>` : ""}<div class="acts">${phraseInput("data-confirm-release", runId ?? key, `Confirm release for ${key}`, STOP_CONFIRM)}<button type="button" class="btn sm danger" data-release="${esc(runId ?? "")}" data-release-seat="${esc(key)}">Release</button>${sameSeat > 1 && runId ? `<button type="button" class="btn sm danger" data-release-all="${esc(key)}" data-release-ref="${esc(runId)}">Release all ${sameSeat} for ${esc(owner.seat?.name ?? "this seat")}</button>` : ""}</div></div>`;
    }
    if (item.type === "blocked") {
      const owner = seatOfKey(item.key);
      return `<div class="ncard">${whereLine(item, item.key)}<b>Launch blocked · ${esc(owner.seat?.name ?? owner.slot)}</b><p>${esc(owner.seat?.name ?? "This seat")} was stopped and cannot start again, by you or by ${esc(owner.tab ? leaderName(owner.tab) : "a leader")}, until you allow it.</p>${readOnlyWarning(owner.seat)}<div class="acts">${phraseInput("data-confirm-unblock", item.key, `Confirm unblock for ${item.key}`, UNBLOCK_CONFIRM)}<button type="button" class="btn sm" data-unblock="${esc(item.key)}">Allow again</button></div></div>`;
    }
    if (item.type === "notice") return `<div class="ncard">${whereLine(item, item.row.seatKey ?? item.row.seatId)}<b>Launch outcome unconfirmed · ${esc(item.row.seatName ?? item.row.seatId)}</b><p>${esc(item.row.source ?? "Command Center")} started ${plainMd(item.row.brief ?? "a run")}. The server could not confirm whether it launched; check ${esc(item.row.seatName ?? "the seat")} before running it again.</p><div class="acts"><button type="button" class="btn sm" data-ack-notice="${esc(item.row.id)}">Acknowledge</button></div></div>`;
    if (item.type === "save") return `<div class="ncard bad">${whereLine(item)}<b>${item.save.status === "failed" ? "Save failed" : "Save not confirmed"}</b><p>${esc(item.save.message)}</p><div class="acts"><button type="button" class="btn sm primary" data-save-tab="${esc(tab.id)}">Retry save</button></div></div>`;
    return "";
  }
  // A typed phrase is kept until the server has taken it: once its seat is no longer blocked (or its run no longer unconfirmed) the phrase goes.
  function prunePhraseDrafts() {
    const safety = serverState?.launchSafety ?? {}, live = new Set();
    for (const row of safety.blocked ?? []) live.add(`data-confirm-unblock:${typeof row === "string" ? row : row?.seatKey ?? row?.seatId}`);
    for (const row of safety.uncertain ?? []) live.add(`data-confirm-release:${row.runId ?? row.seatKey ?? row.seatId ?? "unknown seat"}`);
    for (const key of [...phraseDrafts.keys()]) if (!live.has(key)) phraseDrafts.delete(key);
  }
  function renderInbox() {
    prunePhraseDrafts();
    const items = allAttention();
    const list = $("inboxList"), records = $("inboxRecords");
    if (!list) return;
    const focusKey = document.activeElement?.closest?.("#inboxPop") && !document.activeElement.closest("#reqForm") ? focusKeyOf(document.activeElement) : null;
    const selection = document.activeElement?.matches?.(".phrase") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    $("inboxHead").textContent = `Needs you${items.length ? ` · ${items.length}` : ""}`;
    list.innerHTML = items.length ? items.map(attentionCard).join("") : '<div class="allclear"><b>Nothing needs you right now</b><span>Approvals, looks, requests and stopped or failed work show up here.</span></div>';
    const safety = serverState?.launchSafety ?? {};
    const released = safety.released ?? [], recordNotices = (safety.notices ?? []).filter((row) => !row.pending);
    records.innerHTML = `${released.length ? `<div class="grp">Released without a confirmed exit · ${released.length}</div>${released.map((row) => { const owner = seatOfKey(row.seatId); return `<div class="ncard sent"><div class="route"><span class="tg">PID ${esc(row.pid)}</span><span class="tg" title="${esc(owner.seat?.name ?? row.seatId)}">${esc(owner.seat?.name ?? row.seatId)}</span></div><p>${esc(owner.tab ? tabLabel(owner.tab.id) : owner.legacy ? `Old seat ID ${row.seatId}` : "Removed tab")}. Released by you; it may still be running. The seat stays blocked until you allow it.</p></div>`; }).join("")}` : ""}${recordNotices.length ? `<div class="grp row"><span>Launch records · ${recordNotices.length}</span><button type="button" class="btn sm" data-ack-all>Acknowledge all</button></div>${recordNotices.map((row) => { const owner = seatOfKey(row.seatKey ?? row.seatId); return `<div class="ncard sent"><div class="route"><span class="tg" title="${esc(row.source ?? "Command Center")}">${esc(row.source === "Local client" ? "You" : row.source ?? "Command Center")}</span><span class="route-arrow" aria-label="to">&#8594;</span><span class="tg" title="${esc(row.seatName ?? row.seatId)}">${esc(row.seatName ?? row.seatId)}</span><span class="spacer"></span><span class="faint" title="${esc(owner.tab ? tabLabel(owner.tab.id) : "Removed tab")}">${esc(owner.tab ? tabLabel(owner.tab.id) : "Removed tab")}</span></div><p>Launched: ${plainMd(row.brief ?? "")}</p><div class="acts"><button type="button" class="btn sm" data-ack-notice="${esc(row.id)}">Acknowledge</button></div></div>`; }).join("")}` : ""}`;
    bindInbox($("inboxPop"));
    renderRequests();
    if (focusKey && !document.activeElement?.isConnected) { const next = $$(focusKey).find(shown); if (next) { next.focus({ preventScroll: true }); if (selection && next.setSelectionRange) try { next.setSelectionRange(selection[0], selection[1]); } catch { /* not a text field */ } } }
    if (!$("inboxPop").hidden) placePopover($("inboxPop"));
  }
  function bindInbox(root) {
    root.querySelectorAll("[data-wait-tab]").forEach((button) => button.addEventListener("click", () => {
      const tabId = button.dataset.waitTab; closePopovers();
      const tab = findTab(tabId); if (tab) { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; }
      selectTabFromUser(tabId); renderStage();
      requestAnimationFrame(() => $("lookCard")?.querySelector("button")?.focus({ preventScroll: true }));
    }));
    root.querySelectorAll("[data-wait-approval]").forEach((button) => button.addEventListener("click", () => {
      approvalFocusTabId = button.dataset.approvalTab;
      const tab = findTab(approvalFocusTabId); if (tab) { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; }
      setLayer($("inboxPop"), false, null, false, false);
      selectTabFromUser(button.dataset.approvalTab); renderToolApproval();
    }));
    root.querySelectorAll("[data-open-seat]").forEach((button) => button.addEventListener("click", () => openSeatView(button.dataset.openTab ?? currentTab()?.id, button.dataset.openSeat)));
    root.querySelectorAll("[data-dismiss-run]").forEach((button) => button.addEventListener("click", () => { dismissedRuns.add(button.dataset.dismissRun); saveDismissed(); renderAll(); }));
    root.querySelectorAll("[data-save-tab]").forEach((button) => button.addEventListener("click", () => { const tab = findTab(button.dataset.saveTab); if (!tab) return; closePopovers(); if (tab.id !== currentTab()?.id) selectTabFromUser(tab.id); startSave(tab); }));
    root.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    root.querySelectorAll("[data-phrase-key]").forEach((input) => input.addEventListener("input", () => phraseDrafts.set(input.dataset.phraseKey, input.value)));
    root.querySelectorAll("[data-unblock]").forEach((button) => button.addEventListener("click", () => {
      const seatKey = button.dataset.unblock; const confirm = root.querySelector(`[data-confirm-unblock="${CSS.escape(seatKey)}"]`)?.value ?? "";
      if (confirm !== UNBLOCK_CONFIRM) { showToast(`Type ${UNBLOCK_CONFIRM} to unblock this seat`); return; }
      send({ type: "unblockSeat", seatKey, confirm }); // the phrase stays until the server takes it (prunePhraseDrafts)
    }));
    root.querySelectorAll("[data-release]").forEach((button) => button.addEventListener("click", () => {
      const ref = button.dataset.release || button.dataset.releaseSeat; const confirm = root.querySelector(`[data-confirm-release="${CSS.escape(ref)}"]`)?.value ?? "";
      if (confirm !== STOP_CONFIRM) { showToast(`Type ${STOP_CONFIRM} to release this process`); return; }
      send(button.dataset.release ? { type: "releaseUnconfirmed", runId: button.dataset.release, confirm } : { type: "releaseUnconfirmedSeat", seatId: button.dataset.releaseSeat, confirm });
    }));
    root.querySelectorAll("[data-release-all]").forEach((button) => button.addEventListener("click", () => {
      const confirm = root.querySelector(`[data-confirm-release="${CSS.escape(button.dataset.releaseRef)}"]`)?.value ?? "";
      if (confirm !== STOP_CONFIRM) { showToast(`Type ${STOP_CONFIRM} to release them`); return; }
      send({ type: "releaseUnconfirmedSeat", seatId: button.dataset.releaseAll, confirm });
    }));
    root.querySelectorAll("[data-retry-kill]").forEach((button) => button.addEventListener("click", () => sendKill(button.dataset.retryKill)));
    root.querySelectorAll("[data-ack-notice]").forEach((button) => button.addEventListener("click", () => send({ type: "ackLaunchNotice", id: Number(button.dataset.ackNotice) })));
    root.querySelector("[data-ack-all]")?.addEventListener("click", () => { const ids = (serverState?.launchSafety?.notices ?? []).filter((row) => !row.pending).map((row) => row.id); if (ids.length) send({ type: "ackLaunchNotices", ids }); });
    root.querySelectorAll("[data-request-action]").forEach((button) => button.addEventListener("click", () => { if (resolveRequestFrom(button)) renderInbox(); }));
  }
  // Accept or Decline names the tab the request is addressed to, not the tab that happens to be open: Needs you lists requests for every tab.
  function resolveRequestFrom(button) {
    const [status, id] = button.dataset.requestAction.split(":");
    const request = (serverState?.requests ?? []).find((item) => item.id === id);
    if (!request) { showToast("That request is not on the list any more"); return false; }
    const requestId = newRequestId();
    if (!send({ type: "resolveRequest", id, status: status === "accept" ? "accepted" : "declined", requestId, tabId: request.toTabId })) return false;
    pendingSettingsActions.set(`request-resolve-${id}`, requestId);
    return true;
  }
  function renderRequestBadge() {
    const tab = currentTab(); const count = tab ? Number(serverState?.pendingRequestCounts?.[tab.id] ?? tab.pendingRequestCount ?? 0) : 0;
    const badge = $("reqN"); badge.textContent = String(count); badge.hidden = count < 1;
    $("reqHeadLabel").textContent = tab ? `Requests · ${tabLabel(tab.id)}` : "Requests";
    $("reqHeadLabel").title = $("reqHeadLabel").textContent;
    $("reqHead").title = count ? `${count} pending for ${tab?.name ?? "this tab"}` : `Requests for ${tab?.name ?? "this tab"}`;
  }
  function requestTabLabel(tabId) {
    for (const { project, tab } of allTabs()) if (tab.id === tabId) return { name: tab.name, project: project.name, label: `${project.name} / ${tab.name}`, tab };
    return { name: "Destination removed", project: "Removed", label: "Removed tab", tab: null };
  }
  function requestTimeAgo(value) {
    const age = Math.max(0, Date.now() - Number(value || Date.now()));
    if (age < 60_000) return "Just now";
    if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
    if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
    return `${Math.floor(age / 86_400_000)}d ago`;
  }
  function requestStatusLabel(status) {
    return status === "accepted" ? "Handed over" : status === "pending" ? "Pending" : status === "declined" ? "Declined" : status === "destinationRemoved" ? "Destination removed" : titleCase(status);
  }
  function openInbox(anchor = $("inboxBtn")) {
    renderInbox();
    openPopover($("inboxPop"), anchor);
    // Needs you can open on any of a dozen cards: the panel takes focus itself, and Tab enters its first control.
    $("inboxPop").focus({ preventScroll: true });
  }
  function renderRequests() {
    const tab = currentTab();
    const active = document.activeElement;
    const focusedAction = active?.dataset?.requestAction;
    const focusedField = ["reqTo", "reqTitle", "reqBody", "reqSend"].includes(active?.id) ? active.id : null;
    const requests = Array.isArray(serverState?.requests) ? serverState.requests : [];
    const incomingRequests = requests.filter((request) => request.toTabId === tab?.id && request.status !== "pending").sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const sentRequests = requests.filter((request) => request.fromTabId === tab?.id).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const incomingCards = incomingRequests.map((request) => requestCard(request, true)).join("");
    const sentCards = sentRequests.map((request) => requestCard(request, false)).join("");
    $("reqList").innerHTML = `<section class="req-section" data-request-section="incoming"><h3 class="grp">Incoming, answered</h3>${incomingCards || '<p class="hint request-empty">No answered incoming requests.</p>'}</section><section class="req-section" data-request-section="sent"><h3 class="grp">Sent from ${esc(tab?.name ?? "this tab")}</h3>${sentCards || '<p class="hint request-empty">Nothing sent from this tab yet.</p>'}</section>`;
    $("reqFrom").textContent = tab ? `From ${tabLabel(tab.id)}` : "From this tab";
    const options = allTabs().filter(({ tab: item }) => item.id !== tab?.id).map(({ project, tab: item }) => `<option value="${esc(item.id)}">${esc(project.name)} / ${esc(item.name)}</option>`).join("");
    const selected = $("reqTo").value;
    $("reqTo").innerHTML = options || '<option value="">No other tabs</option>';
    if (selected && [...$("reqTo").options].some((option) => option.value === selected)) $("reqTo").value = selected;
    $("reqTo").disabled = !options;
    const pendingRequestAction = pendingRequestActions.get(tab?.id) ?? requestActionResults.get(tab?.id)?.requestId;
    const sendAction = pendingRequestAction ? actionStateFor(pendingRequestAction) : null;
    // A sent request empties the form once, so a second click cannot send a duplicate.
    if (sendAction?.status === "done" && requestFormCleared.get(tab.id) !== pendingRequestAction) { requestFormCleared.set(tab.id, pendingRequestAction); $("reqTitle").value = ""; $("reqBody").value = ""; }
    const sending = Boolean(pendingRequestAction && (!sendAction || sendAction.status === "running"));
    const canSend = Boolean(tab && options && !sending);
    $("reqSend").disabled = !canSend;
    $("reqStatus").textContent = sendAction?.message ?? (pendingRequestAction ? "Working" : "");
    $("reqStatus").dataset.status = sendAction?.status ?? (pendingRequestAction ? "running" : "");
    $("reqSend").textContent = sending ? "Sending…" : "Send request";
    $("reqList").querySelectorAll("[data-request-action]").forEach((button) => button.addEventListener("click", () => { if (resolveRequestFrom(button)) renderRequests(); }));
    renderRequestBadge();
    if (focusedAction) $("reqList").querySelector(`[data-request-action="${CSS.escape(focusedAction)}"]`)?.focus({ preventScroll: true });
    else if (focusedField) $(focusedField)?.focus({ preventScroll: true });
  }

  // ---------- stopping ----------
  // The server answers each killRun with killAccepted or an error that names no run, in the order it got them: killOrder remembers that order.
  function sendKill(runId) {
    if (!send({ type: "killRun", runId })) return false;
    killOrder.push(runId);
    return true;
  }
  function killRun(runId) {
    const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === runId);
    if (!run || run.status !== "working") { sendKill(runId); return; }
    if (stopStates.has(runId) && !uncertainRun(runId)) return;
    if (sendKill(runId)) stopStates.set(runId, "requested");
    renderAll();
  }
  function stopSeat(tab, seat) {
    const runs = liveRuns(tab, seat);
    if (!send({ type: "stopSeat", tabId: tab.id, slot: seat.slot })) return;
    for (const run of runs) if (!stopStates.has(run.runId)) stopStates.set(run.runId, "requested");
    if (seat.isLeader) holdQueue(tab.id);
    if (seat.isLeader) showToast(`Asked the server to stop ${seat.name}'s session. Your next message starts a fresh one.`);
    else showToast(runs.length ? `Asking the server to stop ${seat.name}…` : `${seat.name} will be blocked from launching until you allow it again`);
    renderAll();
  }
  function stopAll() {
    const tabs = allTabs().map(({ tab }) => tab).filter(activeTabBusy);
    const runIds = new Set(tabs.flatMap((tab) => (tab.runs ?? []).filter((run) => run.status === "working").map((run) => run.runId)));
    if (!send({ type: "stopAll" })) return;
    stopAllTrack = { runIds, tabIds: new Set(tabs.map((tab) => tab.id)), accepted: false };
    for (const id of runIds) if (!stopStates.has(id)) stopStates.set(id, "requested");
    for (const { tab } of allTabs()) holdQueue(tab.id);
    showToast("Asking the server to stop everything in every tab…");
    renderAll();
  }
  function unblockWithConfirm(tab, seat, opener) {
    const key = seatKeyOf(tab, seat);
    confirmAction({ title: `Allow ${seat.name} to launch again?`, body: `${seat.name} was stopped. Once allowed, you or ${leaderName(tab)} can start it again.`, ok: "Allow again", phrase: UNBLOCK_CONFIRM }, (typed) => {
      send({ type: "unblockSeat", seatKey: key, confirm: typed });
    }, opener);
  }

  // ---------- composer extras ----------
  const PERMISSIONS = [
    // Each CLI enforces a mode its own way (PROTOCOL.md, Limits): only Claude's wording is a promise; Codex and OpenCode say what really happens.
    ["ask", "Ask before edits", (name, cli) => cli === "codex" ? `${name} asks for commands Codex judges unsafe. Some commands and file writes can still go through without asking`
      : cli === "opencode" ? `${name} asks before edits and commands. Reading files and folders does not ask`
      : `${name} asks before changing any file or running a command`],
    ["accept", "Auto-accept edits", (_name, cli) => cli === "codex" ? "Edits and commands inside the folder go through. Codex asks when it needs more access" : "Edits go through, commands still ask"],
    ["plan", "Plan only", (_name, cli) => cli === "codex" ? "Codex's read-only mode. It is not a lock: a command can still write a file"
      : cli === "opencode" ? "Edits are denied. Commands still ask, and a command you allow can still write a file"
      : "Reads and plans, changes nothing"],
    ["bypass", "Bypass permissions", (name) => `${name} runs everything without asking. Crew access does not change. Use with care.`],
  ];
  let permissionRefocus = false;
  const acpWarning = (tab) => `${tab.acpLeader?.name ?? leaderName(tab)} may edit files and run commands without asking. Command Center cannot make it ask yet.`;
  function permissionActionFor(tab) {
    const requestId = pendingPermissionAction.get(tab?.id) ?? permissionActionResults.get(tab?.id)?.requestId;
    return (requestId && (actionStateFor(requestId) ?? { requestId, status: "running", message: "Working" })) || tab?.permissionAction || null;
  }
  function renderPermissionButton(tab) {
    const button = $("permBtn");
    if (!tab) { button.disabled = true; button.textContent = "Permission"; button.dataset.p = "ask"; $("acpNote").hidden = true; return; }
    const mode = tab.permissionMode ?? serverState?.settings?.permissionModes?.[tab.id] ?? "accept";
    $("acpNote").hidden = !tab.acpLeader; $("acpNote").textContent = tab.acpLeader ? acpWarning(tab) : "";
    const action = permissionActionFor(tab);
    const label = PERMISSIONS.find(([id]) => id === mode)?.[1] ?? "Unknown";
    // The browser drops focus from a button that becomes disabled; hand it back once the change settles.
    if (action?.status === "running" && document.activeElement === button) permissionRefocus = true;
    button.disabled = action?.status === "running";
    if (!button.disabled && permissionRefocus) {
      permissionRefocus = false;
      if (!document.activeElement || document.activeElement === document.body) button.focus({ preventScroll: true });
    }
    button.dataset.p = mode;
    const state = action?.status === "running" ? '<span class="perm-state">· Applying</span>' : action?.status === "failed" ? '<span class="perm-state bad">· Not changed</span>' : "";
    button.innerHTML = `<i class="perm-dot" aria-hidden="true"></i><span data-permission-label>${esc(label)}</span>${state}<svg class="perm-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    button.title = action?.message ? `${label}: ${action.message}` : `Permission mode: ${label}`;
    button.setAttribute("aria-label", `Permission mode: ${label}${action?.status === "running" ? ", applying" : action?.status === "failed" ? ", not changed" : ""}`);
  }
  function openPermissionPicker(tab, anchor) {
    if (!tab) return;
    const mode = tab.permissionMode ?? serverState?.settings?.permissionModes?.[tab.id] ?? "accept";
    const action = permissionActionFor(tab);
    const name = leaderName(tab), cli = leader(tab)?.cli;
    const pop = $("permPop");
    if (tab.acpLeader) {
      // An ACP CLI decides by itself whether it asks (it can edit without ever asking): Full access is the only mode it has, so Ask, Accept and Plan are not offered.
      pop.innerHTML = `<div class="grp lbl">Permissions for this chat</div><button type="button" class="opt perm" aria-pressed="true" disabled><span class="nm">Bypass permissions<small>${esc(acpWarning(tab))}</small></span>${ICONS.tick}</button><div class="hint">Ask, Accept and Plan come back for a CLI only after we have tested that it really asks.</div>`;
      openPopover(pop, anchor);
      return;
    }
    pop.innerHTML = `<div class="grp lbl">Permissions for this chat</div>${PERMISSIONS.map(([id, label, description]) => `<button type="button" class="opt perm" data-permission-mode="${id}" aria-pressed="${String(mode === id)}" ${action?.status === "running" ? "disabled" : ""}><span class="nm">${esc(label)}<small>${esc(description(name, cli))}</small></span>${ICONS.tick}</button>`).join("")}${action?.status === "failed" ? `<p class="hint" data-permission-status style="color:var(--danger-text)">${esc(action.message)}</p>` : ""}<div class="hint">A tool that still needs you shows up above the message box, and in Needs you.</div>`;
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-permission-mode]").forEach((button) => button.addEventListener("click", () => {
      const next = button.dataset.permissionMode;
      if (next === mode) { setLayer(pop, false); return; }
      const apply = () => {
        const requestId = newRequestId();
        if (!send({ type: "setPermissionMode", tabId: tab.id, mode: next, requestId, ...(next === "bypass" ? { confirm: true } : {}) })) return;
        pendingPermissionAction.set(tab.id, requestId);
        renderPermissionButton(tab);
      };
      setLayer(pop, false);
      if (next === "bypass") confirmAction({ title: `Bypass permissions in ${tab.name}?`, body: `${name} will edit files and run commands in ${tab.folder} without asking you first, and launch writable seats without asking. This changes ${name} only: each crew seat keeps the access its crew gives it. You can switch back at any time.`, ok: "Allow bypass", danger: true }, apply, $("permBtn"));
      else apply();
    }));
  }

  // ---------- full render ----------
  function requestVisibleTabTranscript() {
    const entry = activeEntry();
    if (!entry) return;
    if (serverState?.selectedTabId === entry.tab.id && transcripts.has(entry.tab.id)) return;
    if (transcriptRequests.has(entry.tab.id)) return;
    send({ type: "selectTab", tabId: entry.tab.id });
  }
