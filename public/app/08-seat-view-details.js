// Command Center page script, part 8 of 12: a crew member's view, background jobs and details. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function renderChat(tab) {
    const messages = transcript(tab).map((message) => renderMessage(tab, message)).join("");
    const draft = streamingByTab.get(tab.id);
    const lead = leader(tab);
    const step = `<span class="act" data-activity${stepByTab.get(tab.id) ? "" : " hidden"}>${esc(stepByTab.get(tab.id) ?? "")}</span>`;
    const stream = draft ? `<div class="msg" data-stream>${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><div class="md">${mdHtml(draft)}</div></div></div>`
      : tab.derived?.leaderTurnActive && !tab.pendingApprovals?.length ? `<div class="msg">${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><span class="typing" role="img" aria-label="Replying"><i></i><i></i><i></i></span></div></div>` : "";
    const look = lookCard(tab);
    // The server could not read this tab's saved transcript (the file is kept as it is): say why the chat is empty.
    const problem = tab.chatProblem ? `<p class="action-status" data-status="failed" role="alert" data-chat-problem>This chat could not be read (${esc(tab.chatProblem)}). Clear the chat to start a new one; the damaged file is kept as a copy.</p>` : "";
    const view = $("view");
    const previousScrollTop = view.scrollTop;
    const stickToBottom = view.dataset.tabId !== tab.id || view.dataset.mode !== "chat" || view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
    if (!messages && !stream && !look) {
      const name = lead?.name ?? "The leader";
      view.innerHTML = `<div class="thread" aria-label="Chat with ${esc(name)}">${problem}<div class="empty empty-chat">${seatImg(lead)}<h2>${esc(name)} is ready</h2><p>Tell ${esc(name)} what you want. The crew picks it up from there, and anything that needs you shows up in Needs you at the top.</p><div class="chips">${["Where did we leave off?", "What is left?", "What should we build next?"].map((text) => `<button type="button" data-suggest>${esc(text)}</button>`).join("")}</div></div></div>`;
    } else view.innerHTML = `<div class="thread" aria-label="Chat with ${esc(lead?.name ?? "the leader")}">${problem}${messages}${stream}${look}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = "chat";
    view.querySelectorAll("[data-process-action]").forEach((button) => button.addEventListener("click", () => runProcessAction(tab, button.dataset.processAction)));
    view.querySelector("[data-ask-changes]")?.addEventListener("click", askForChanges);
    view.querySelectorAll("[data-open-screenshots]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(button.dataset.openScreenshots, null, button)));
    view.querySelectorAll("[data-open-shot]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(tab.id, button.dataset.openShot, button)));
    view.querySelectorAll("[data-suggest]").forEach((button) => {
      button.disabled = chatSendLocked(tab.id) || savePending.has(tab.id);
      button.addEventListener("click", () => { $("ci").value = button.textContent; draftsByTab.set(tab.id, $("ci").value); noteTextEdit(tab.id); updateChatLoading(tab.id); sendChat(); });
    });
    if (messages || stream) view.scrollTop = stickToBottom ? view.scrollHeight : previousScrollTop;
  }

  // ---------- a crew member's own view, past sessions and saved runs ----------
  function historyStatus(outcome) {
    return outcome && typeof outcome === "object" && typeof outcome.status === "string" ? outcome.status : "unknown";
  }
  function historyStatusColor(outcome) {
    const status = historyStatus(outcome);
    return status === "done" ? "var(--done)" : status === "failed" || status === "stopped" ? "var(--failed)" : "var(--idle)";
  }
  function historyDate(timestamp) {
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable";
  }
  function historyExitCode(outcome) {
    const code = outcome && typeof outcome === "object" ? outcome.exitCode : null;
    return Number.isInteger(code) ? String(code) : "unknown";
  }
  function historyBytes(bytes) {
    return Number.isFinite(Number(bytes)) && Number(bytes) >= 0 ? `${Number(bytes).toLocaleString()} B` : "unknown bytes";
  }
  function accessText(tab, seat) {
    if (seat?.isLeader) return "Leader · permission mode of this chat";
    // A CLI whose read-only is not enforced (Codex, an ACP one) can only be asked: it can still write, and can still reach outside the folder.
    const canWrite = seat?.canWrite, folder = folderName(tab.folder), label = cliLabel(seat?.cli);
    if (cliCap(seat?.cli)?.readOnlyEnforced === false) return canWrite === false ? `Read-only (asked not to write; ${label} can still write through commands)` : `Asked to stay inside ${folder} (${label} can still reach outside it)`;
    return `${canWrite === false ? "Told not to write" : `Can write, works in ${folder}`} · ${label} has no folder sandbox`;
  }
  function historyRows(entries) {
    return entries.map((run) => {
      const timestamp = Number(run.timestamp ?? run.startedAt ?? run.started ?? 0);
      const status = historyStatus(run.outcome);
      return `<button type="button" class="run" data-history-timestamp="${timestamp}"><span class="rs" style="background:${historyStatusColor(run.outcome)}"></span><span><b>${esc(historyDate(timestamp))}</b><small>${esc(status)} · exit ${esc(historyExitCode(run.outcome))}</small></span><span class="mono">exit ${esc(historyExitCode(run.outcome))}</span><span class="mono">${esc(historyBytes(run.sizeBytes))}</span></button>`;
    }).join("");
  }
  function retiredRows(tab, seat) {
    const runs = (tab.derived?.runViews?.retiredHistory ?? []).filter((run) => seat.isLeader || run.seatSlotId === seat.slot).slice().sort((a, b) => Number(b.endedAt ?? b.startedAt) - Number(a.endedAt ?? a.startedAt));
    if (!runs.length) return "";
    return `<h3>Runs from earlier crews</h3><p class="faint" style="margin:0;font-size:12.5px">Kept from crews this tab used before. Their saved logs open from that seat's History when the seat still exists.</p>${runs.map((run) => `<div class="run"><span class="rs" style="background:${run.status === "failed" || run.status === "stopped" ? "var(--failed)" : "var(--done)"}"></span><span><b title="${esc(`${run.seatName} · ${mdPlain(run.label)}`)}">${esc(run.seatName)} · ${plainMd(run.label)}</b><small>${esc(historyDate(Number(run.endedAt ?? run.startedAt)))} · ${esc(run.outcome ?? run.status)}</small></span><span class="mono">${esc(run.endedAt ? spanText(run.startedAt, run.endedAt) : "")}</span><span class="mono">${esc(formatModel(run.cli, run.model))}</span></div>`).join("")}`;
  }
  // One saved run, read from its files. The leader's Past sessions shows it on its own; a worker keeps its header above it.
  function historyDetailMarkup(seat, key, detail) {
    const back = seat.isLeader ? "Past sessions" : "All saved runs";
    const top = `<div class="wv runs"><button type="button" class="back" data-back-history>${ICONS.back}<span>${esc(back)}</span></button>`;
    const status = historyStatus(detail.outcome), cls = status === "done" ? "ok" : status === "failed" || status === "stopped" ? "bad" : "";
    const capped = detail.truncated ? (detail.full ? " · fuller log, still capped by the server" : " · capped, showing the end of the log") : "";
    const fuller = detail.truncated && !detail.full;
    const fullBusy = historyFullRequested.has(`${key}:${detail.timestamp}`);
    return `${top}<div class="wvhead"><div><b>${esc(historyDate(Number(detail.timestamp)))}</b><small>${esc(seat.name)} · read from its saved files, no AI is called</small></div></div><div class="metarow"><span>${esc(historyDate(Number(detail.timestamp)))}</span><span class="${cls}">${esc(status)}</span><span>exit ${esc(historyExitCode(detail.outcome))}</span><span>${esc(historyBytes(detail.totalBytes))}${esc(capped)}</span></div>${detail.brief ? `<h3>Brief</h3><pre class="plain">${esc(detail.brief)}</pre>` : ""}<h3>Log</h3><div class="term">${fuller ? `<div class="tb"><span class="mono">Showing the end of ${esc(historyBytes(detail.totalBytes))}</span><span class="spacer"></span><button type="button" class="tbtn jump" data-full-log data-full-timestamp="${esc(detail.timestamp)}"${fullBusy ? " disabled" : ""}>${fullBusy ? "Reading…" : "Load the fuller log"}</button></div>` : ""}<pre>${esc(detail.output || "No log saved.")}</pre></div></div>`;
  }
  // The saved-runs list the server never answered: say so, with a way to ask again. A list that did arrive (even an older one) is shown instead.
  function historyFailure(key, runs) {
    return historyFailed.has(key) && !Array.isArray(runs) ? '<p class="faint">Could not load the saved runs just now. <button type="button" class="btn sm" data-history-retry>Try again</button></p>' : "";
  }
  function bindHistoryView(view, tab, seat, key) {
    view.querySelector("[data-history-retry]")?.addEventListener("click", () => { requestHistory(tab, seat, true); renderStage(); });
    view.querySelector("[data-full-log]")?.addEventListener("click", (event) => {
      const timestamp = Number(event.currentTarget.dataset.fullTimestamp), detailKey = `${key}:${timestamp}`;
      if (historyFullRequested.has(detailKey)) return;
      // A failed send changes nothing; each fuller-log request has its own token so an older timer cannot clear a newer request.
      if (!send({ type: "historyRun", seatKey: key, timestamp, full: true })) return;
      const token = ++historyRunToken;
      historyFullRequested.set(detailKey, token); historyRunRequested.set(key, timestamp);
      setTimeout(() => { if (historyFullRequested.get(detailKey) === token) { historyFullRequested.delete(detailKey); renderStage(); } }, HISTORY_WAIT_MS);
      renderStage();
    });
    // The list stays until the saved run arrives; only the newest pick can open (a late reply for an older pick is ignored).
    view.querySelectorAll("[data-history-timestamp]").forEach((button) => button.addEventListener("click", () => {
      const timestamp = Number(button.dataset.historyTimestamp);
      // A failed send leaves an earlier request (and its timer) exactly as it was.
      if (!send({ type: "historyRun", seatKey: key, timestamp })) return;
      historyRunRequested.set(key, timestamp);
      const token = ++historyRunToken; historyRunTokens.set(key, token);
      // A saved run the server never answers (its error names no run) stops saying "Reading its saved files…" after a while.
      setTimeout(() => { if (historyRunTokens.get(key) === token && historyRunRequested.get(key) === timestamp && !historyDetails.has(`${key}:${timestamp}`)) { historyRunRequested.delete(key); showToast("Could not read that saved run. Try again"); renderStage(); } }, HISTORY_WAIT_MS);
      view.querySelectorAll("[data-history-timestamp][aria-busy]").forEach((item) => item.removeAttribute("aria-busy"));
      button.setAttribute("aria-busy", "true");
      const note = button.querySelector("small"); if (note) note.textContent = "Reading its saved files…";
    }));
    view.querySelector("[data-back-history]")?.addEventListener("click", () => { const requested = historyRunRequested.get(key); historyDetails.delete(`${key}:${requested}`); historyFullRequested.delete(`${key}:${requested}`); historyRunRequested.delete(key); renderStage(); });
    view.querySelectorAll("[data-chat-live]").forEach((button) => button.addEventListener("click", () => { selectedView = "live"; renderStage(); renderCrew(); }));
  }
  function renderLeaderHistory(tab, seat) {
    const view = $("view"), key = seatKeyOf(tab, seat), runs = historyBySeat.get(key);
    if (!historyRequested.has(key) && !historyFailed.has(key)) requestHistory(tab, seat);
    const requested = historyRunRequested.get(key);
    const detail = requested !== undefined ? historyDetails.get(`${key}:${requested}`) : null;
    if (detail) { view.innerHTML = historyDetailMarkup(seat, key, detail); view.dataset.tabId = tab.id; view.dataset.mode = "history"; bindHistoryView(view, tab, seat, key); return; }
    const entries = Array.isArray(runs) ? runs : [];
    const loading = !Array.isArray(runs) && historyInFlight.has(key);
    view.innerHTML = `<div class="wv runs"><button type="button" class="back" data-chat-live data-session-action="chat">${ICONS.back}<span>Back to the chat</span></button><div class="wvhead">${seatImg(seat)}<div><b>Past sessions</b><small>${esc(seat.name)} · opening one reads its saved files, no AI is called</small></div></div>${loading ? '<p class="faint"><span class="spin" aria-hidden="true" style="margin-right:8px"></span>Loading saved runs…</p>' : historyFailure(key, runs) || `<span class="lbl">${entries.length} saved run${entries.length === 1 ? "" : "s"}</span>${historyRows(entries) || '<p class="faint">No runs yet. Save writes one.</p>'}`}${retiredRows(tab, seat)}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = "history";
    bindHistoryView(view, tab, seat, key);
  }
  function seatFacts(tab, seat, current, last, line, blocked) {
    const fact = (label, value, attrs = "") => `<div><span>${label}</span><b${attrs}>${value}</b></div>`;
    const doing = current ? mdPlain(current.label) : seat.status === "working" || line.cls === "waiting" ? line.text : blocked ? "Nothing. Launch blocked" : "Nothing. Ready for a brief";
    if (current) {
      const tokens = usageTokens(current.usage);
      return `<div class="facts">${fact("Doing now", esc(doing), ` title="${esc(doing)}"`)}${fact("Model", `${esc(modelLine(current.cli, current.model, current.effort))} <span class="faint">· this run</span>`)}${fact("Running for", esc(spanText(current.startedAt)), ` data-run-time="${esc(current.runId)}"`)}${fact("Tokens", tokens !== null ? `${esc(fmtK(tokens))} <span class="faint">· this run</span>` : "Not reported")}</div>`;
    }
    return `<div class="facts">${fact("Doing now", esc(doing), ` title="${esc(doing)}"`)}${fact("Model", `${esc(modelLine(seat.cli, seat.model, seat.effort))} <span class="faint">· next run</span>`)}${fact("Last run", last ? `${esc(agoText(last.endedAt ?? last.startedAt))} · took ${esc(spanText(last.startedAt, last.endedAt ?? last.startedAt))}` : "None yet")}${fact("Access", esc(accessText(tab, seat)), ` title="${esc(accessText(tab, seat))}"`)}</div>`;
  }
  function lastResult(tab, seat, last, heading) {
    if (!last) return `<h3>${heading}</h3><p class="faint" style="margin:0">No finished run yet in this crew.</p>`;
    const bad = last.status === "failed" || last.status === "stopped", findings = last.outcome === "findings";
    return `<h3>${heading}</h3><div class="last${bad ? " bad" : findings ? " wait" : ""}"><div class="lh"><span class="rs"></span><b title="${plainMd(last.label)}">${plainMd(last.label)}</b><span class="metarow"><span${bad ? ' class="bad"' : findings ? "" : ' class="ok"'}>${esc(cap(last.outcome ?? last.status))}</span><span>${esc(agoText(last.endedAt ?? last.startedAt))}</span><span>took ${esc(spanText(last.startedAt, last.endedAt ?? last.startedAt))}</span><span>${esc(modelLine(last.cli, last.model, last.effort))}</span></span><span class="spacer"></span><button type="button" class="btn sm" data-run-view="history" data-last-history>Open History</button></div></div>`;
  }
  function renderRunView(tab, seat) {
    const view = $("view");
    const focused = document.activeElement?.dataset?.runTab ?? document.activeElement?.dataset?.historyTimestamp ?? (document.activeElement?.matches?.("[data-run-view]") ? `view:${document.activeElement.dataset.runView}` : document.activeElement?.matches?.("[data-back-history]") ? "back-history" : document.activeElement?.matches?.("[data-chat-live]") ? "chat-live" : "");
    const key = seatKeyOf(tab, seat);
    const active = liveRuns(tab, seat);
    const selected = active.find((run) => run.runId === selectedRunBySeat.get(seat.slot)) ?? active[0];
    if (selected) selectedRunBySeat.set(seat.slot, selected.runId);
    const line = seatLine(tab, seat), blocked = seatBlocked(tab, seat), dot = seatDot(tab, seat, line);
    const generation = tab.processState?.crewGenerationId;
    const finished = (tab.runs ?? []).filter((run) => run.seatSlotId === seat.slot && run.status !== "working" && run.crewGenerationId === generation).sort((a, b) => Number(b.endedAt ?? b.startedAt) - Number(a.endedAt ?? a.startedAt));
    const historyOpen = selectedView === "history";
    const requested = historyRunRequested.get(key);
    const stopping = active.length ? stopLabelFor(tab, active) : "";
    const head = `<div id="stagehead" class="wv"><button type="button" class="back" data-back-chat>${ICONS.back}<span>Back to the chat with ${esc(leaderName(tab))}</span></button><div class="vhead"><span class="av big">${seatImg(seat)}<i class="dot ${esc(dot)}"></i></span><div class="vwho"><b><span data-seat-name title="${esc(seat.name)}">${esc(seat.name)}</span></b><small title="${esc(seatRole(tab, seat))} · ${esc(cliLabel(seat.cli))}">${esc(seatRole(tab, seat))} · ${esc(cliLabel(seat.cli))}</small></div><span class="vstat ${esc(line.cls)}" role="status"><i></i><span class="vt" title="${esc(line.text)}">${esc(line.text)}</span></span><span class="spacer"></span><button type="button" class="btn primary sm" data-run-seat>${active.length ? "Run another" : "Run"}</button>${active.length || seat.status === "working" ? `<button type="button" class="btn danger sm" data-stop-seat title="Stops every run of ${esc(seat.name)} and blocks new launches until you allow it"${stopping ? " disabled" : ""}>${stopping ? esc(stopping) : `Stop seat (${active.length || 1})`}</button>` : ""}<button type="button" class="soft ico" data-seat-more="${esc(seat.slot)}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(seat.name)}: model, name, picture and launches" title="Model, name, picture and launches">${ICONS.dots}</button></div>${seatFacts(tab, seat, selected, finished[0], line, blocked)}${blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. ${esc(seat.name)} cannot start until you allow it.</span><button type="button" class="btn sm" data-seat-unblock>Allow again</button></div>` : ""}<div class="vbar"><div class="segs" role="tablist" aria-label="Run view"><button type="button" role="tab" data-run-view="live" aria-selected="${String(!historyOpen)}">Live</button><button type="button" role="tab" data-run-view="history" aria-selected="${String(historyOpen)}">History</button></div>${!historyOpen && active.length > 1 ? `<div class="runtabs" role="tablist" aria-label="Live runs">${active.map((run) => `<button type="button" role="tab" data-run-tab="${esc(run.runId)}" aria-selected="${String(run.runId === selected.runId)}" title="${plainMd(run.label)}"><span class="d"></span><span>${plainMd(run.label)}</span></button>`).join("")}</div>` : ""}</div></div>`;
    let body = "";
    const detail = requested !== undefined ? historyDetails.get(`${key}:${requested}`) : null;
    if (historyOpen && detail) body = historyDetailMarkup(seat, key, detail);
    else if (historyOpen) {
      const runs = historyBySeat.get(key);
      if (!historyRequested.has(key) && !historyFailed.has(key)) requestHistory(tab, seat);
      const entries = Array.isArray(runs) ? runs : [];
      const loading = !Array.isArray(runs) && historyInFlight.has(key);
      body = `<div class="wv runs">${loading ? '<p class="faint"><span class="spin" aria-hidden="true" style="margin-right:8px"></span>Loading saved runs…</p>' : historyFailure(key, runs) || `<span class="lbl">${entries.length} saved run${entries.length === 1 ? "" : "s"}</span>${historyRows(entries) || '<p class="faint">No runs yet.</p>'}`}</div>`;
    } else if (selected) {
      const output = outputByRun.get(selected.runId) ?? selected.output ?? "";
      const usage = formatUsage(selected.usage);
      const state = runStopState(tab, selected);
      body = `<div class="wv"><div class="term"><div class="tb"><span class="mono" title="${plainMd(selected.label)}">${plainMd(selected.label)}</span><span class="spacer"></span><span class="mono">${esc(cliLabel(selected.cli))} · ${esc(modelLine(selected.cli, selected.model, selected.effort))}${usage ? ` · ${esc(usage)}` : ""}</span><button type="button" class="tbtn jump" data-jump-log hidden>Jump to latest</button><button type="button" class="tbtn" data-stop-run="${esc(selected.runId)}" aria-label="Stop ${plainMd(selected.label)}" title="Stops only this run"${state ? " disabled" : ""}>${state ? esc(stopLabel(state)) : "Stop this run"}</button></div><pre data-output-run="${esc(selected.runId)}">${esc(output)}</pre></div><div class="files touched"><span class="lbl">${esc(accessText(tab, seat))} ·</span><span class="file" title="${esc(selected.folderPath)}">${esc(selected.folderPath)}</span></div>${lastResult(tab, seat, finished[0], "Last finished run")}</div>`;
    } else {
      body = `<div class="wv">${lastResult(tab, seat, finished[0], "Last result")}${blocked ? "" : `<p class="faint" style="margin:0;font-size:12.5px">${esc(seat.name)} starts when ${esc(leaderName(tab))} hands over a brief, or when you press Run.</p>`}</div>`;
    }
    const previousLog = view.querySelector("[data-output-run]");
    const logState = previousLog ? { id: previousLog.dataset.outputRun, top: previousLog.scrollTop, near: nearEnd(previousLog) } : null;
    const sameView = view.dataset.tabId === tab.id && view.dataset.mode === `worker:${seat.slot}`;
    const scrollTop = view.scrollTop;
    view.innerHTML = `<div class="wv" style="gap:18px">${head}${body}</div>`;
    view.dataset.tabId = tab.id; view.dataset.mode = `worker:${seat.slot}`;
    view.scrollTop = sameView ? scrollTop : 0;
    const log = view.querySelector("[data-output-run]");
    if (log) { if (logState && logState.id === log.dataset.outputRun && !logState.near) log.scrollTop = logState.top; else log.scrollTop = log.scrollHeight; jumpButton(log); }
    view.querySelector("[data-back-chat]").addEventListener("click", () => { selectedSeatByTab.set(tab.id, leader(tab)?.slot); selectedView = "live"; renderStage(); renderCrew(); });
    view.querySelector("[data-run-seat]")?.addEventListener("click", (event) => openRunDialog(tab, seat, event.currentTarget));
    view.querySelectorAll("[data-stop-seat]").forEach((button) => button.addEventListener("click", () => stopSeat(tab, seat)));
    view.querySelector("[data-seat-more]")?.addEventListener("click", (event) => togglePopover($("seatPop"), event.currentTarget, () => openSeatCard(tab, seat, event.currentTarget)));
    view.querySelector("[data-seat-unblock]")?.addEventListener("click", (event) => unblockWithConfirm(tab, seat, event.currentTarget));
    view.querySelectorAll("[data-run-view]").forEach((button) => button.addEventListener("click", () => {
      selectedView = button.dataset.runView;
      if (selectedView === "history") { historyRunRequested.delete(key); requestHistory(tab, seat); }
      renderStage(); renderCrew();
      if (button.hasAttribute("data-last-history")) $("view").querySelector('[data-run-view="history"]')?.focus({ preventScroll: true });
    }));
    view.querySelectorAll("[data-run-tab]").forEach((button) => button.addEventListener("click", () => { selectedRunBySeat.set(seat.slot, button.dataset.runTab); renderStage(); }));
    view.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    view.querySelector("[data-jump-log]")?.addEventListener("click", () => { const pre = view.querySelector("[data-output-run]"); if (pre) { pre.scrollTop = pre.scrollHeight; jumpButton(pre); } });
    view.querySelector("[data-output-run]")?.addEventListener("scroll", (event) => jumpButton(event.currentTarget));
    if (historyOpen) bindHistoryView(view, tab, seat, key);
    restoreRunViewFocus(view, focused, historyOpen ? "history" : "live");
  }
  function stopLabelFor(tab, runs) { const states = runs.map((run) => runStopState(tab, run)); return states.every(Boolean) ? stopLabel(states.find((item) => item === "unconfirmed") ?? states.find((item) => item === "accepted") ?? states[0]) : ""; }
  const nearEnd = (pre) => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  function jumpButton(pre) { const jump = pre.closest(".term")?.querySelector("[data-jump-log]"); if (jump) jump.hidden = nearEnd(pre); }
  function restoreRunViewFocus(view, focused, fallback) {
    let target = focused.startsWith("view:") ? view.querySelector(`#stagehead [data-run-view="${CSS.escape(fallback)}"]`) ?? view.querySelector(`[data-run-view="${CSS.escape(focused.slice(5))}"]`) : null;
    if (!target && focused === "back-history") target = view.querySelector("[data-back-history]") ?? view.querySelector('[data-run-view="history"]');
    if (!target && focused === "chat-live") target = view.querySelector("[data-chat-live]") ?? $("chatMore");
    if (!target && focused) target = view.querySelector(`[data-run-tab="${CSS.escape(focused)}"],[data-history-timestamp="${CSS.escape(focused)}"]`);
    if (!target && /^\d+$/.test(focused)) target = view.querySelector("[data-back-history]");
    target?.focus({ preventScroll: true });
  }
  // Extending the shown text costs the size of the chunk; only a log that hit its cap (its front was cut) is rewritten whole.
  function updateRunOutput(runId, chunk, trimmed) {
    const element = $("view").querySelector(`[data-output-run="${CSS.escape(runId)}"]`);
    if (!element) return;
    const follow = nearEnd(element), top = element.scrollTop;
    const node = element.firstChild;
    if (!trimmed && node?.nodeType === 3 && node === element.lastChild) node.appendData(chunk);
    else element.textContent = outputByRun.get(runId) ?? "";
    element.scrollTop = follow ? element.scrollHeight : top;
    jumpButton(element);
  }
  function requestHistory(tab, seat, refresh = false) {
    const key = seat.seatKey ?? `${tab.id}.${seat.slot}`;
    if (refresh) historyRequested.delete(key);
    if (historyInFlight.has(key)) { if (refresh) historyRefreshAfterFlight.add(key); return; }
    if (historyRequested.has(key)) return;
    historyRequested.add(key);
    historyInFlight.add(key);
    historyFailed.delete(key);
    if (!send({ type: "historyList", seatKey: key })) { historyRequested.delete(key); historyInFlight.delete(key); return; }
    // The server's history errors name no seat, so a list that never answers is given up on here instead of spinning until a reconnect.
    const ticket = (historyTickets.get(key) ?? 0) + 1; historyTickets.set(key, ticket);
    setTimeout(() => { if (historyTickets.get(key) === ticket && historyInFlight.delete(key)) { historyRequested.delete(key); historyFailed.add(key); renderStage(); } }, HISTORY_WAIT_MS);
  }
  function historyOwner(key) {
    for (const { tab } of allTabs()) {
      const seat = tab.crew.find((item) => (item.seatKey ?? `${tab.id}.${item.slot}`) === key);
      if (seat) return { tab, seat };
    }
    return null;
  }
  function showLeaderHistory(tab) {
    const lead = leader(tab); if (!lead) return;
    selectedSeatByTab.set(tab.id, lead.slot); selectedView = "history"; historyRunRequested.delete(seatKeyOf(tab, lead));
    renderStage(); renderCrew();
    $("view").querySelector("[data-chat-live]")?.focus({ preventScroll: true });
  }
  function openSeatView(tabId, slot) {
    const tab = findTab(tabId); if (!tab || !seatFor(tab, slot)) return;
    closePopovers();
    if (tab.id !== currentTab()?.id) selectTabFromUser(tab.id);
    selectedSeatByTab.set(tab.id, slot); selectedView = "live";
    renderStage(); renderCrew();
    $("view").querySelector('[data-run-view="live"]')?.focus({ preventScroll: true });
  }
  function renderStage() {
    const tab = currentTab(); const seat = selectedSeat(tab);
    renderPermissionButton(tab);
    const nextHistoryKey = selectedView === "history" && tab && seat ? seat.seatKey ?? `${tab.id}.${seat.slot}` : null;
    const openedHistory = nextHistoryKey && nextHistoryKey !== historyViewKey;
    historyViewKey = nextHistoryKey;
    if (openedHistory) requestHistory(tab, seat, true);
    if (tab) renderStatusLine(tab);
    if ((tab?.id ?? null) !== composerTabId) {
      if (composerTabId) {
        draftsByTab.set(composerTabId, $("ci").value);
        abandonChatOnTabSwitch(composerTabId);
      }
      composerTabId = tab?.id ?? null; composerGeneration++;
      $("ci").value = draftsByTab.get(composerTabId) ?? "";
      fitComposer();
    }
    const canChat = inChat(tab);
    const pending = Boolean(tab && pendingChatByTab.has(tab.id));
    $("ci").readOnly = pending;
    $("attachBtn").disabled = !canChat || pending;
    $("sendBtn").disabled = !tab || !canChat || !$("ci").value.trim() || chatSendLocked(tab.id) || savePending.has(tab.id);
    const lead = leader(tab);
    $("ci").placeholder = `Message ${lead?.name ?? "the leader"}...`;
    $("ci").setAttribute("aria-label", `Message ${lead?.name ?? "the leader"}`);
    renderFolderButton(tab);
    renderJobsLine(tab);
    syncComposerVisibility();
    if (!tab || !seat) { $("view").innerHTML = '<p class="muted empty-chat">Waiting for server state.</p>'; return; }
    renderAttachments();
    updateChatLoading(tab.id);
    if (!seat.isLeader) renderRunView(tab, seat);
    else if (selectedView === "history") renderLeaderHistory(tab, seat);
    else renderChat(tab);
  }
  function syncComposerVisibility() {
    const tab = currentTab();
    const chat = inChat(tab);
    $("cbox").hidden = !chat;
    $("composer").hidden = !chat && !tab?.pendingApprovals?.length;
  }
  // ---------- background jobs a Claude leader runs: the line by the message box and the rows under the crew ----------
  function jobAge(since) { const minutes = Math.floor(Math.max(0, Date.now() - since) / 60000); return minutes < 1 ? "under 1 min" : `${minutes} min`; }
  function jobsOf(tab) { return Array.isArray(tab?.leaderJobs) ? tab.leaderJobs.map((job) => ({ description: String(job.description ?? ""), startedAt: Number(job.startedAt) || Date.now() })) : []; }
  // Rebuilt only when the list changed, so the spinner is not restarted by every state message; the minutes tick on their own (see tick).
  function setJobsHtml(box, jobs, html) {
    const signature = JSON.stringify(jobs);
    box.hidden = !jobs.length;
    if (box.dataset.sig === signature) return;
    box.dataset.sig = signature; box.innerHTML = jobs.length ? html : "";
  }
  function renderJobsLine(tab) {
    const jobs = jobsOf(tab);
    const oldest = jobs.length ? Math.min(...jobs.map((job) => job.startedAt)) : 0;
    setJobsHtml($("jobsLine"), jobs, `<i class="spin" aria-hidden="true"></i><span>${jobs.length === 1 ? `1 background job still running: ${esc(jobs[0].description)}, ` : `${jobs.length} background jobs still running, longest `}<span data-job-since="${oldest}">${jobAge(oldest)}</span></span>`);
  }
  function renderCrewJobs(tab) {
    const jobs = jobsOf(tab);
    setJobsHtml($("crewJobs"), jobs, `<div class="jhead">Background jobs</div>${jobs.map((job) => `<div class="jrow" title="${esc(job.description)}"><i class="spin" aria-hidden="true"></i><span class="jt">${esc(job.description)}</span><span class="ja" data-job-since="${job.startedAt}">${jobAge(job.startedAt)}</span></div>`).join("")}`);
  }
  function renderFolderButton(tab) {
    const button = $("folderBtn");
    button.hidden = !tab || !window.cc || typeof window.cc.pickFolder !== "function";
    $("folder").textContent = tab ? folderName(tab.folder) : "";
    button.title = tab ? `Works in ${tab.folder}. Click to change the folder` : "";
    button.setAttribute("aria-label", tab ? `Home folder ${tab.folder}. Change folder` : "Change folder");
  }

  // ---------- details: activity, changes, notes and usage ----------
  function renderSide() {
    const tab = currentTab();
    $("side").hidden = !sideOpen; $("main").classList.toggle("side", sideOpen);
    $("sideBtn").setAttribute("aria-pressed", String(sideOpen));
    const rows = activity.filter((item) => !item.tabId || item.tabId === tab?.id);
    $("feed").innerHTML = rows.length ? rows.map((item) => `<div class="ev"><span class="d ${esc(item.type)}"></span><span class="x">${esc(item.text)}</span><time>${esc(item.at)}</time></div>`).join("") : '<span class="faint">Nothing yet in this tab.</span>';
    renderUsage(tab);
    renderLower();
  }
  function renderUsage(tab) {
    const usage = $("usage");
    if (!tab) { usage.innerHTML = '<span class="faint">No usage reported yet.</span>'; return; }
    $("usageTitle").textContent = `This session in ${tab.name}`;
    // Numbers only where the server measured them (the leader's last turn, each live run); every other seat says Not reported.
    const rows = [];
    const lead = leader(tab);
    for (const seat of tab.crew) {
      if (seat.isLeader) { rows.push({ seat, model: formatModel(seat.cli, seat.model, tab), value: formatUsage(tab.leaderUsage) }); continue; }
      const live = (tab.runs ?? []).filter((run) => run.seatSlotId === seat.slot && run.status === "working" && formatUsage(run.usage));
      if (live.length) for (const run of live) rows.push({ seat, model: formatModel(run.cli, run.model), value: formatUsage(run.usage) });
      else rows.push({ seat, model: formatModel(seat.cli, seat.model), value: null });
    }
    // An advisor is a per-seat setting now: every seat that has one shows its row, whichever seat it is.
    const advisors = tab.crew.filter((seat) => seat.advisor && cliCap(seat.cli)?.advisor);
    const row = (picture, name, model, value, note) => `<div class="useRow${value ? "" : " unmeasured"}">${picture}<span title="${esc(name)} · ${esc(model)}">${esc(name)} <span class="faint">· ${esc(model)}</span></span>${value ? `<span class="v">${esc(value)}</span>` : `<span class="nr">${esc(note)}</span>`}</div>`;
    usage.innerHTML = (rows.some((item) => item.value) ? "" : '<p class="faint" data-usage-empty>No usage reported yet.</p>')
      + rows.map((item) => row(seatImg(item.seat), item.seat.name, item.model, item.value, "Not reported")).join("")
      + advisors.map((seat) => row('<span class="advglyph" aria-hidden="true">✦</span>', `Advisor for ${seat.name}`, formatModel(seat.cli, seat.advisor), null, "Not reported separately")).join("");
    $("contextLine").textContent = lead ? `${lead.name}'s context: ${contextLine(tab)} · ${formatModel(lead.cli, lead.model, tab)}. Numbers cover the leader's last turn and live runs; a finished run's numbers stay in its own log.` : "";
  }
  function renderLower() {
    document.querySelectorAll(".pills [data-l]").forEach((button) => { const on = button.dataset.l === lowerSection; button.setAttribute("aria-selected", String(on)); button.tabIndex = on ? 0 : -1; });
    $("sideBody").setAttribute("aria-labelledby", `sp-${lowerSection}`);
    $("feed").hidden = lowerSection !== "activity";
    $("usagePanel").hidden = lowerSection !== "usage";
    $("lowerBody").hidden = !["changes", "notes"].includes(lowerSection);
    if (lowerSection === "changes") renderChanges();
    else if (lowerSection === "notes") renderNotes();
  }
  function renderChanges() {
    const tab = currentTab(); const changes = tab?.changes;
    if (!tab || !changes) { $("lowerBody").innerHTML = '<p class="faint" style="margin:0">Git status is unavailable right now. It is read again when a run finishes or you open this tab.</p>'; return; }
    if (!changes.repo) { $("lowerBody").innerHTML = `<div class="kv"><span>Folder</span><span class="path" title="${esc(tab.folder)}">${esc(tab.folder)}</span></div><p class="change-empty faint" data-change-not-repo style="margin:0">Not a git repository. This folder has no commits or uncommitted files to show.</p>`; return; }
    const files = Array.isArray(changes.uncommittedFiles) ? changes.uncommittedFiles : [];
    const ahead = Math.max(0, Number(changes.ahead) || 0), behind = Math.max(0, Number(changes.behind) || 0);
    const hash = changes.lastCommit?.hash ?? "No commit recorded";
    const remote = `${ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} not pushed` : "Up to date"}${behind ? ` · ${behind} behind` : ""}`;
    const rows = [
      `<div class="kv" data-change-row="branch"><span>Branch</span><span class="mono" title="${esc(changes.branch ?? "Unknown")}">${esc(changes.branch ?? "Unknown")}</span></div>`,
      `<div class="kv" data-change-row="commit"><span>Last commit</span><span class="mono" title="${esc(`${hash}${changes.lastCommit?.subject ? ` ${changes.lastCommit.subject}` : ""}`)}">${esc(hash)}</span></div>`,
      `<div class="kv" data-change-row="remote"><span>Remote</span><span style="color:${ahead ? "var(--warn-text)" : "var(--working-text)"}">${esc(remote)}</span></div>`,
      `<div class="kv" data-change-row="files"><span>Not committed</span><span class="mono change-count" style="color:${files.length ? "var(--warn-text)" : "var(--text-2)"}">${files.length} file${files.length === 1 ? "" : "s"}</span></div>`,
    ];
    const fileList = files.length ? `<div class="fl changes-files" data-change-file-list>${files.map((file) => {
      const status = file.status === "??" ? "A" : (String(file.status || "?").match(/[MAD]/)?.[0] ?? "M");
      return `<div><b class="${status}" aria-label="${status}">${status}</b><span title="${esc(file.path)}">${esc(file.path)}</span></div>`;
    }).join("")}</div>` : '<span class="faint">Working tree clean.</span>';
    $("lowerBody").innerHTML = `${rows.join("")}${fileList}`;
  }
  function openObsidianVault() {
    const vaultPath = serverState?.settings?.vault?.path;
    if (!vaultPath) return;
    if (!window.cc || typeof window.cc.openObsidian !== "function") return;
    const url = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
    Promise.resolve(window.cc.openObsidian(url)).then((result) => {
      if (result?.ok === false) showToast(result.message ?? "Could not open Obsidian");
    }).catch((error) => showToast(error?.message ?? "Could not open Obsidian"));
  }
