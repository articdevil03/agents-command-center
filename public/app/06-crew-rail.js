// Command Center page script, part 6 of 12: inner tabs, crew rail and the status line. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function showSoundLevel() {
    const slider = $("soundVol");
    $("soundVolOut").textContent = `${slider.value}%`;
    slider.style.setProperty("--v", String(Number(slider.value) / 100));
  }
  function openSoundPop(anchor) { soundSliding = false; renderSoundButton(); openPopover($("soundPop"), anchor); }
  // Settings cannot be open under the popover (opening it closes Settings), and Settings reads the pref when it opens.
  function toggleSound() {
    const next = !pref("bellEnabled", false);
    if (send({ type: "updateClientPref", key: "bellEnabled", value: next })) { clientPrefOverrides.set("bellEnabled", next); if (next) playCompletionSound(); }
    renderSoundButton();
  }
  // Saved once, when the slider is let go (or per arrow key), never on every pixel of a drag.
  function saveSoundVolume() {
    soundSliding = false;
    saveClientPref("bellVolume", Number($("soundVol").value));
    renderSoundButton();
  }
  // The app window has no native title bar: the top bar ends in our own minimize, maximize/restore and close buttons. A plain browser has no bridge for them, so they stay hidden.
  function bindWindowButtons() {
    const cc = window.cc;
    if (typeof cc?.closeWindow !== "function") return;
    $("winBtns").hidden = false;
    $("winMin").addEventListener("click", () => cc.minimizeWindow());
    $("winMax").addEventListener("click", () => cc.toggleMaximizeWindow());
    $("winClose").addEventListener("click", () => cc.closeWindow());
    cc.onWindowMaximized(renderMaximized);
    Promise.resolve(cc.isWindowMaximized()).then(renderMaximized).catch(() => {});
    cc.onCloseRequested(answerCloseRequest);
  }
  function renderMaximized(maximized) {
    const button = $("winMax"), label = maximized === true ? "Restore" : "Maximize";
    button.dataset.maximized = String(maximized === true);
    button.setAttribute("aria-label", label); button.title = label;
  }
  // Every way of closing the app (our Close, Alt+F4, the taskbar, File > Quit) asks this page first (electron/main.js). With nothing working it
  // closes at once; otherwise it waits on this dialog. A second ask while it shows redraws the same dialog, never a second one.
  function answerCloseRequest() {
    // Work that belongs to no tab (a Settings action, an upload) is named too, and alone it also holds the close.
    const cc = window.cc, working = allTabs().filter(({ tab }) => tab.activeWork), other = serverState?.globalWork ?? [];
    if (!working.length && !other.length) { cc.answerClose("close"); return; }
    cc.answerClose("hold");
    const names = working.map(({ project, tab }) => `${project.name}\u00A0·\u00A0${tab.name}`), one = working.length === 1;
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3} more` : names.join(", ");
    confirmAction({ title: "Close Command Center?", body: [working.length ? `${working.length} ${one ? "tab is" : "tabs are"} still working: ${list}.` : "", other.length ? `${working.length ? "Also" : "Still working"}: ${other.join(", ")}.` : "", `Closing stops ${working.length + other.length === 1 ? "it" : "them"}.`].filter(Boolean).join(" "), ok: "Close anyway", cancel: "Keep open", danger: true },
      () => cc.answerClose("close"), document.activeElement, () => cc.answerClose("keep"));
  }
  function selectProject(projectId) {
    const project = findProject(projectId); if (!project) return;
    const remembered = projectLastTab.get(projectId);
    const visible = project.tabs.filter((tab) => !hiddenTab(tab.id));
    const next = visible.find((tab) => tab.id === remembered) ?? visible[0];
    closePopovers();
    // Picking a project is a user choice even when it lands on the tab already shown: a held removal's Undo then leaves it alone.
    if (next) selectTabFromUser(next.id);
  }
  function renderInboxButton() {
    const items = allAttention(), count = items.length, bad = items.some((item) => item.bad), button = $("inboxBtn");
    button.classList.toggle("has", count > 0 && !bad); button.classList.toggle("bad", bad);
    $("inboxN").textContent = String(count); $("inboxN").hidden = !count;
    button.setAttribute("aria-label", count ? `Needs you, ${count} waiting` : "Needs you, nothing waiting");
    button.title = count ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you` : "Nothing needs you right now";
  }

  // ---------- inner tabs ----------
  function renderTabs() {
    const entry = activeEntry(), project = entry?.project, tab = entry?.tab;
    const tabsBox = $("tabs");
    tabsBox.setAttribute("aria-label", project ? `Tabs in ${project.name}` : "Tabs in this project");
    const focusedTabId = document.activeElement?.closest?.("#tabs .tab")?.dataset.tabId;
    const focusedMore = document.activeElement?.matches?.("#tabs .tmore") ? document.activeElement.dataset.moreFor : null;
    $$(".tabw", tabsBox).forEach((node) => node.remove());
    if (project) for (const item of project.tabs.filter((candidate) => !hiddenTab(candidate.id))) {
      const selected = item.id === tab?.id, marker = attentionMark(attention(item));
      const wrap = document.createElement("div"); wrap.className = `tabw${selected ? " sel" : ""}`;
      const el = document.createElement("div");
      el.className = "tab"; el.dataset.tabId = item.id; el.title = `${item.name} · ${kindLabel(item.kind)} · ${setupLabel(item)}${marker ? ` · ${marker.label}` : ""}`;
      el.setAttribute("role", "tab"); el.setAttribute("aria-controls", "stage"); el.setAttribute("aria-selected", String(selected)); el.tabIndex = selected ? 0 : -1;
      el.innerHTML = `<span class="tl" title="${esc(item.name)}">${esc(item.name)}</span>${marker ? `<i class="pdot${marker.bad ? " bad" : ""}" role="img" aria-label="${esc(marker.label)}"></i>` : ""}`;
      // Every tab keeps its ⋯ (shown on hover for the others), so a background tab can be renamed or removed without opening it. It is the tab's neighbour, not its child.
      const more = document.createElement("button");
      more.type = "button"; more.className = "dots tmore"; more.dataset.moreFor = item.id; more.setAttribute("aria-haspopup", "dialog"); more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-label", `Options for the ${item.name} tab`); more.title = "Tab options"; if (!selected) more.tabIndex = -1; more.innerHTML = ICONS.dots;
      el.addEventListener("click", () => selectTabFromUser(item.id));
      more.addEventListener("click", (event) => { event.stopPropagation(); togglePopover($("ctxPop"), more, () => tabMenu(item, more)); });
      el.addEventListener("keydown", (event) => tabKeys(event, el, tabsBox, ".tab", (next) => selectTabFromUser(next.dataset.tabId)));
      wrap.append(el, more);
      tabsBox.append(wrap);
    }
    if (focusedMore) tabsBox.querySelector(`.tmore[data-more-for="${CSS.escape(focusedMore)}"]`)?.focus({ preventScroll: true });
    else if (focusedTabId) tabsBox.querySelector(`[data-tab-id="${CSS.escape(focusedTabId)}"]`)?.focus({ preventScroll: true });
    $("addtab").disabled = !project;
    const selected = tabsBox.querySelector(".tabw.sel");
    if (selected) requestAnimationFrame(() => { const r = selected.getBoundingClientRect(), b = tabsBox.getBoundingClientRect(); if (r.left < b.left || r.right > b.right) tabsBox.scrollLeft += r.left < b.left ? r.left - b.left - 4 : r.right - b.right + 4; });
  }
  function tabMenu(tab, anchor) {
    const project = findProjectForTab(tab.id);
    const tabBusy = activeTabBusy(tab);
    const items = [
      { label: "Rename", run: () => renameDialog("Rename tab", tab.name, (name) => send({ type: "renameTab", tabId: tab.id, name }), anchor) },
      { label: "Change folder", sub: tab.folder, run: () => pickFolder((folder) => send({ type: "changeFolder", tabId: tab.id, folder })) },
      { label: "Kind and crew", sub: `${kindLabel(tab.kind)} · ${setupLabel(tab)}`, keepFocusAway: true, run: () => processMenu(tab, $("tabs").querySelector(`[data-tab-id="${CSS.escape(tab.id)}"]`) ?? anchor) },
      { hr: true },
      ...(project?.tabs.length > 1 ? [{ label: "Remove tab", sub: tabBusy ? "The server may refuse while work is active" : "Files in its folder are not touched", danger: true, run: () => holdAction({ type: "removeTab", tabId: tab.id }, `${tab.name} tab will be removed`, { type: "removeTab", tabId: tab.id, hideTabId: tab.id, releaseTabIds: [tab.id] }) }] : [{ hint: "A project needs at least one tab." }]),
    ];
    makeMenu($("ctxPop"), anchor, items, "Tab options");
  }
  function findProjectForTab(tabId) { return projects().find((project) => project.tabs.some((tab) => tab.id === tabId)) ?? null; }
  function projectMenu(project, anchor) {
    const busy = project.tabs.some(activeTabBusy);
    const items = [
      { label: "Rename", run: () => renameDialog("Rename project", project.name, (name) => send({ type: "renameProject", projectId: project.id, name }), anchor) },
      { label: "Change folder", sub: `New tabs start in ${project.folder}`, run: () => pickFolder((folder) => {
        send({ type: "changeProjectFolder", projectId: project.id, folder });
      }) },
      { hr: true },
      ...(projects().length > 1 ? [{ label: "Remove from Command Center", sub: busy ? "The server may refuse while work is active" : "Its files and folders stay on disk", danger: true, run: () => holdAction({ type: "removeProject", projectId: project.id }, `${project.name} will be removed`, { type: "removeProject", projectId: project.id, hideProjectId: project.id, releaseTabIds: project.tabs.map((tab) => tab.id) }) }] : [{ hint: "Command Center needs at least one project." }]),
    ];
    makeMenu($("ctxPop"), anchor, items, "Project options");
  }
  function renderProjectPopover(anchor) {
    const pop = $("projPop"), current = currentProject();
    const items = visibleProjects().map((project) => {
      const tabs = project.tabs.filter((tab) => !hiddenTab(tab.id)).length, marker = attentionMark(attentionFor(project.tabs));
      return `<button type="button" class="opt" data-project="${esc(project.id)}" aria-pressed="${String(project.id === current?.id)}"><span class="nm"><span title="${esc(project.name)}">${esc(project.name)}</span><small>${tabs} tab${tabs === 1 ? "" : "s"}${marker ? ` · ${esc(marker.label)}` : ""}</small></span>${ICONS.tick}</button>`;
    }).join("");
    pop.innerHTML = `<div class="grp">All projects</div>${items || '<div class="nores">No projects.</div>'}<div class="hr"></div><button type="button" class="opt" data-new-project><span class="nm"><span>New project</span></span></button>`;
    openPopover(pop, anchor);
    pop.querySelectorAll("[data-project]").forEach((button) => button.addEventListener("click", () => { setLayer(pop, false); selectProject(button.dataset.project); }));
    pop.querySelector("[data-new-project]")?.addEventListener("click", () => { setLayer(pop, false, null, false, false); openProjectDialog($("addProj")); });
  }

  // ---------- crew rail ----------
  // The seat that asked shows the wait: the leader for an approval without an asker, a seat such as the planner for its own.
  function toolApprovalWaiting(tab, seat) { return Boolean(seat && (tab?.pendingApprovals ?? []).some((item) => (item.askedBy?.slot ?? leader(tab)?.slot) === seat.slot)); }
  function lookPending(tab) { return tab?.processState?.approval?.state === "pending"; }
  function seatBlocked(tab, seat) { const key = seatKeyOf(tab, seat); return (serverState?.launchSafety?.blocked ?? []).some((row) => (typeof row === "string" ? row : row?.seatKey ?? row?.seatId) === key); }
  function stopLabel(state) { return state === "unconfirmed" ? "Stop not confirmed" : state === "requested" ? "Stop requested…" : "Stopping…"; }
  function runStopState(tab, run) {
    if (uncertainRun(run.runId)) return "unconfirmed";
    const local = stopStates.get(run.runId);
    if (local) return local;
    return engineSeat(tab, run.seatSlotId)?.status === "stopped" ? "accepted" : null;
  }
  function reviewActor(tab) {
    const step = (tab?.derived?.stepBar ?? []).find((item) => item.state === "current");
    if (!step || step.type !== "rounds" || tab.processState?.approval?.state !== "approved" || tab.processState?.phase === "clean") return null;
    return { step, seat: seatFor(tab, step.owners?.[0]), phase: tab.processState.phase, round: tab.processState.round ?? 1 };
  }
  function seatLine(tab, seat) {
    if (toolApprovalWaiting(tab, seat)) return { cls: "waiting", text: "Waiting on your answer" };
    const live = liveRuns(tab, seat);
    const closing = live.map((run) => runStopState(tab, run)).filter(Boolean);
    if (closing.length) { const state = closing.find((item) => item === "unconfirmed") ?? closing.find((item) => item === "accepted") ?? closing[0]; return { cls: state === "requested" ? "working" : "stopped", text: stopLabel(state) }; }
    if (seat.isLeader && savePending.has(tab.id)) return { cls: "working", text: "Saving the handover" };
    if (seat.isLeader && tab.derived?.leaderTurnActive) return { cls: "working", text: "Replying" };
    if (seat.isLeader && lookPending(tab)) return { cls: "waiting", text: "Waiting on your look" };
    const actor = reviewActor(tab);
    if (seat.isLeader && actor?.seat && !actor.seat.isLeader && ["failed", "stopped"].includes(actor.seat.status)) return { cls: "waiting", text: `Round ${actor.round} paused` };
    if (actor?.seat?.slot === seat.slot && seat.status === "failed") return { cls: "failed", text: `Failed · round ${actor.round}` };
    if (seat.status === "stalled") return { cls: "stalled", text: "Stalled: no output" };
    if (live.length > 1) return { cls: "working", text: `Working on ${live.length} runs` };
    const task = mdPlain(seat.isLeader ? engineSeat(tab, seat.slot)?.task : seat.task);
    if (seat.status === "working" || seat.status === "waiting") return { cls: seat.status, text: task || titleCase(seat.status) };
    if (seatBlocked(tab, seat) && !seat.isLeader) return { cls: "stopped", text: "Launch blocked" };
    if (seat.status === "stopped") return { cls: "stopped", text: task && /round/.test(task) ? task : "Stopped by you" };
    return { cls: seat.status || "idle", text: seat.status === "done" ? "Finished" : seat.status === "failed" ? "Failed" : "Ready" };
  }
  function seatDot(tab, seat, line) {
    if (toolApprovalWaiting(tab, seat) || (seat.isLeader && line.cls === "waiting")) return "waiting";
    if (line.cls === "stopped" && seat.status !== "stopped") return "stopped";
    if (line.cls === "failed" || line.cls === "stalled") return line.cls;
    return seat.status === "idle" || !seat.status ? "idle" : seat.status;
  }
  function needsYou(tab, seat) { return toolApprovalWaiting(tab, seat) || Boolean(seat.isLeader && (lookPending(tab) || (serverState?.requests ?? []).some((request) => request.status === "pending" && request.toTabId === tab.id))); }
  // A working seat's activity line takes a colour picked for its picture (close to the picture, not read from it); uploads use the working green.
  function seatHue(seat) { return { atlas: "#7d8bff", sonny: "#3bbf9a", vera: "#b58cff", sol: "#f2b630", nova: "#ff8fb8", terra: "#ef7d57", pip: "#5fb6ff", momo: "#ffb27a", juno: "#9b7a5c", ziggy: "#7ed957", rumi: "#7a6cff", kiki: "#ff6b6b", bo: "#5aa0ff", fig: "#d36bb4", dune: "#c7a27a", sage: "#a77bff", mel: "#b58a8a", ollie: "#4fd1c5", taro: "#ffa94d", ash: "#8f9bb3" }[UPLOADED_PIC.test(String(seat?.pic ?? "")) ? "" : avatarKeyFor(seat)] ?? "var(--working)"; }
  function renderCrew() {
    const tab = currentTab();
    const box = $("crew");
    const focusedPart = document.activeElement?.closest?.("#crew [data-seat-pic], #crew [data-seat-open]"), focusedKey = focusedPart ? focusKeyOf(focusedPart) : null;
    box.replaceChildren();
    $("stage").classList.toggle("wide", railWide);
    renderCrewJobs(tab);
    const toggle = $("railBtn"), toggleLabel = railWide ? "Hide crew details" : "Show crew details";
    toggle.setAttribute("aria-expanded", String(railWide)); toggle.setAttribute("aria-label", toggleLabel); toggle.title = toggleLabel;
    if (!tab) { $("crewLbl").textContent = "Crew"; $("setupsLbl").textContent = ""; return; }
    const flag = tab.derived?.roundFlag;
    $("crewLbl").innerHTML = `Crew${flag ? `<span class="rflag" title="The review passed two rounds">${esc(flag)}</span>` : ""}`;
    const switcher = $("setupsBtn"), crewName = setupLabel(tab);
    $("setupsLbl").textContent = crewName;
    switcher.setAttribute("aria-label", `Crew: ${crewName}, ${kindLabel(tab.kind)}. Change the crew`);
    switcher.dataset.tip = `Crew: ${crewName}${flag ? ` · ${flag}` : ""}\nClick to change the crew`;
    switcher.title = railWide ? `Crew: ${crewName}, ${kindLabel(tab.kind)}` : "";
    const viewSeat = viewedSeat(tab), cardSlot = !$("seatPop").hidden ? $("seatPop").dataset.slot : null;
    tab.crew.forEach((seat, index) => {
      if (index === 1) { const line = document.createElement("span"); line.className = "csep"; line.setAttribute("aria-hidden", "true"); box.append(line); }
      const live = liveRuns(tab, seat), line = seatLine(tab, seat), dot = seatDot(tab, seat, line), role = seatRole(tab, seat);
      const act = needsYou(tab, seat) ? "need" : line.cls === "working" ? "work" : "";
      const row = document.createElement("div");
      row.className = `seat${cardSlot === seat.slot || viewSeat === seat.slot ? " on" : ""}${act ? ` ${act}` : ""}`;
      row.dataset.seatId = seat.slot;
      if (act === "work") row.style.setProperty("--c", seatHue(seat));
      const tip = `${seat.name} · ${role}
${line.text}`;
      row.dataset.tip = tip;
      if (railWide) row.title = tip;
      row.innerHTML = `<button type="button" class="av" data-seat-pic="${esc(seat.slot)}" aria-haspopup="dialog" aria-expanded="${String(cardSlot === seat.slot)}" aria-label="Open ${esc(seat.name)}'s card${railWide ? "" : `: ${esc(role)}, ${esc(line.text)}`}">${seatImg(seat)}<i class="dot ${esc(dot)}"></i>${live.length > 1 ? `<b class="cnt" title="${live.length} runs in parallel">${live.length}</b>` : ""}${seat.isLeader && !picHasCrown(seat) ? `<span class="crown" title="Leader">${ICONS.crown}</span>` : ""}</button><button type="button" class="fx" data-seat-open="${esc(seat.slot)}" aria-label="View ${esc(seat.name)}'s work: ${esc(role)}, ${esc(line.text)}"${seat.isLeader && inChat(tab) ? ` aria-haspopup="dialog" aria-expanded="${String(cardSlot === seat.slot)}"` : ""}${viewSeat === seat.slot ? ' aria-current="true"' : ""}><span class="fn name" title="${esc(seat.name)}">${esc(seat.name)}</span><span class="fr role" title="${esc(role)}">${esc(role)}</span><span class="sl ${esc(line.cls)}" title="${esc(line.text)}">${esc(line.text)}</span></button>${act ? '<i class="pl" aria-hidden="true"></i>' : ""}`;
      const pic = row.querySelector("[data-seat-pic]");
      pic.addEventListener("click", () => togglePopover($("seatPop"), pic, () => openSeatCard(tab, seat, pic)));
      row.querySelector("[data-seat-open]").addEventListener("click", (event) => seatClicked(tab, seat, event.currentTarget));
      box.append(row);
    });
    if (focusedKey) box.querySelector(focusedKey)?.focus({ preventScroll: true });
    const anyBusy = allTabs().some(({ tab: item }) => activeTabBusy(item));
    const stop = $("stopAll"); stop.disabled = !anyBusy;
    $("stopAllLbl").textContent = railWide ? "Stop all tabs" : "Stop all";
    stop.title = anyBusy ? "Stop every running seat and leader in every tab" : "Nothing is running in any tab";
    stop.setAttribute("aria-label", stop.title);
    stop.dataset.tip = stop.title;
  }
  function viewedSeat(tab) { const seat = selectedSeat(tab); return seat && !seat.isLeader ? seat.slot : ""; }
  function inChat(tab) { const seat = selectedSeat(tab); return Boolean(tab && seat?.isLeader && selectedView !== "history"); }
  function seatClicked(tab, seat, button) {
    if (seat.isLeader) {
      if (!inChat(tab)) { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); return; }
      togglePopover($("seatPop"), button, () => openSeatCard(tab, seat, button));
      return;
    }
    const same = selectedSeatByTab.get(tab.id) === seat.slot && selectedView === "live";
    selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live";
    if (!same) historyRunRequested.delete(seatKeyOf(tab, seat));
    closePopovers(); renderStage(); renderCrew();
  }
  function markCrewSwitcher() {
    const entry = layerStack.find((item) => item.el === $("setupPop"));
    $("setupsBtn")?.setAttribute("aria-expanded", String(Boolean(entry && entry.opener === $("setupsBtn"))));
  }

  // ---------- status line, steps and save ----------
  function workerPhrases(tab) {
    return tab.crew.filter((seat) => !seat.isLeader && seat.status === "working").map((seat) => {
      const live = liveRuns(tab, seat).length, task = mdPlain(seat.task);
      if (live > 1) return `${seat.name} is working on ${live} runs`;
      if (/ · round \d+$/.test(task)) return `${seat.name} is ${task.replace(" · ", " ").toLowerCase()}`;
      if (task === "Waiting to review") return `${seat.name} is waiting to review`;
      return `${seat.name} is working on ${task || "a task"}`;
    });
  }
  function unseenFailedRuns(tab) {
    const generation = tab.processState?.crewGenerationId;
    return (tab.runs ?? []).filter((run) => run.status === "failed" && !run.seatIsLeader && run.crewGenerationId === generation && !dismissedRuns.has(run.runId));
  }
  function tabUncertain(tab) { return uncertainRows().filter((row) => tabIdOfKey(row.seatKey ?? row.seatId) === tab.id); }
  function statusOf(tab) {
    const lead = leader(tab), phrases = workerPhrases(tab);
    const meanwhile = phrases.length ? `Meanwhile ${joinNames(phrases)}` : "";
    if (connState === "off") return { tone: "off", text: "Not connected", sub: "Reconnecting. What you change now is not sent" };
    const also = tab.pendingApprovals?.length ? "Also waiting on your answer" : lookPending(tab) ? "Also waiting on your look" : meanwhile;
    const uncertain = tabUncertain(tab);
    if (uncertain.length) return { tone: "bad", text: `${seatNameOfKey(uncertain[0].seatKey ?? uncertain[0].seatId)} may still be running: the stop was not confirmed`, sub: "Needs you has Try again and Release" };
    const failed = unseenFailedRuns(tab)[0];
    if (failed) return { tone: "bad", text: `${failed.seatName}'s run failed: ${mdPlain(failed.label)}`, sub: also };
    const stalled = (tab.runs ?? []).find((run) => run.status === "working" && run.stalled);
    if (stalled) return { tone: "bad", text: `${stalled.seatName}'s run stalled: ${mdPlain(stalled.label)}`, sub: stallActions.get(stalled.runId) === "relaunch" ? `No output for ${STALL_MINUTES} minutes. It is being stopped and started once more` : `No output for ${STALL_MINUTES} minutes` };
    const approvals = [...(tab.pendingApprovals ?? [])].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    if (approvals.length) return { tone: "wait", text: `Waiting on you: ${approvalTitle(approvals[0].tool, tab, approvals[0].askedBy)}`, sub: approvals.length > 1 ? `and ${approvals.length - 1} more` : meanwhile };
    if (lookPending(tab)) return { tone: "wait", text: "Waiting on you: approve the look", sub: meanwhile };
    const save = saveStates.get(tab.id);
    if (save?.status === "failed") return { tone: "bad", text: "Save failed", sub: save.message };
    if (save?.status === "unknown") return { tone: save.checking ? "work" : "bad", text: "Save not confirmed yet", sub: save.message };
    const closing = (tab.runs ?? []).filter((run) => run.status === "working" && runStopState(tab, run));
    if (closing.length) { const names = joinNames([...new Set(closing.map((run) => run.seatName))]); return closing.every((run) => runStopState(tab, run) === "requested") ? { tone: "work", text: `Stop requested for ${names}`, sub: "Nothing changes until the server accepts it" } : { tone: "work", text: `Stopping ${names}…`, sub: "Accepted. Waiting for the process to close" }; }
    const requests = (serverState?.requests ?? []).filter((request) => request.status === "pending" && request.toTabId === tab.id);
    if (requests.length) return { tone: "wait", text: `Waiting on you: a request from ${tabLabel(requests[0].fromTabId) || "another tab"}`, sub: meanwhile };
    const actor = reviewActor(tab);
    if (actor) {
      const line = String(tab.derived?.approvedCardLine ?? "").replace(/\.$/, "");
      if (actor.seat?.status === "stopped") return { tone: "bad", text: `Round ${actor.round} is paused. ${actor.seat.name} was stopped`, sub: `${seatBlocked(tab, actor.seat) ? `Allow ${actor.seat.name} again and run it` : `Run ${actor.seat.name} again`} to continue` };
      if (actor.seat?.status === "failed") return { tone: "bad", text: `Round ${actor.round} is paused. ${actor.seat.name}'s run failed`, sub: `Open ${actor.seat.name} and run it again to continue` };
      const others = phrases.filter((phrase) => !actor.seat || !phrase.startsWith(`${actor.seat.name} `));
      return { tone: "work", text: line || `Round ${actor.round}`, sub: others.length && !/^Waiting for/.test(line) ? `Also ${joinNames(others)}` : "" };
    }
    if (savePending.has(tab.id)) return { tone: "work", text: "Saving the handover…", sub: meanwhile };
    if (tab.derived?.leaderTurnActive) return { tone: "work", text: `${lead?.name ?? "The leader"} is replying`, sub: meanwhile };
    if (tab.processState?.approval?.state === "approved" && !phrases.length) return { tone: lead?.status === "working" ? "work" : "idle", text: String(tab.derived?.approvedCardLine ?? (tab.steps?.some((step) => step.type === "look") ? "Approved" : "The process continues")).replace(/\.$/, ""), sub: "" };
    if (phrases.length) return { tone: "work", text: cap(phrases[0]), sub: phrases.length > 1 ? `Also ${joinNames(phrases.slice(1))}` : "" };
    const stopped = tab.crew.filter((seat) => seat.status === "stopped");
    if (stopped.length) return { tone: "idle", text: `Stopped by you: ${joinNames(stopped.map((seat) => seat.name))}`, sub: (serverState?.launchSafety?.blocked ?? []).some((key) => tabIdOfKey(typeof key === "string" ? key : key?.seatKey ?? key?.seatId) === tab.id) ? "Blocked seats need Allow again before they launch" : "" };
    const jobs = jobsOf(tab).length;
    return { tone: "idle", text: "Ready", sub: jobs ? `${lead?.name ?? "The leader"} is free, ${jobs} background job${jobs === 1 ? "" : "s"} running` : `${lead?.name ?? "The leader"} is ready when you are` };
  }
  function renderStatusLine(tab) {
    const button = $("statusBtn");
    if (!tab) { button.innerHTML = ""; return; }
    const status = statusOf(tab), steps = tab.derived?.stepBar ?? [], index = Math.max(0, steps.findIndex((step) => step.state === "current"));
    const current = steps[index];
    button.innerHTML = `<span class="pill ${esc(status.tone)}" data-tone="${esc(status.tone)}"><i></i><span class="pt">${esc(status.text)}</span></span>${status.sub ? `<span class="sub">${esc(status.sub)}</span>` : ""}${steps.length ? `<span class="stepn">Step ${index + 1} of ${steps.length}<span class="sl"><span aria-hidden="true"> · </span>${esc(String(current?.label ?? "").split(" · ")[0])}</span>${ICONS.chev}</span>` : ""}`;
    button.title = `${status.text}${status.sub ? `. ${status.sub}` : ""}. Click to show every step and what comes next`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(stepsOpen));
    $("stepsWrap").classList.toggle("on", stepsOpen); $("stepsWrap").inert = !stepsOpen;
    renderPipe(tab);
    renderSaveArea(tab);
  }
  function stepOwners(tab, step) {
    return (step.owners ?? []).map((owner) => owner === "user" ? { user: true } : { seat: seatFor(tab, owner) }).filter((item) => item.user || item.seat);
  }
  function renderPipe(tab) {
    const pipe = $("pipe");
    const steps = tab.derived?.stepBar ?? [];
    const currentIndex = steps.findIndex((step) => step.state === "current");
    const actor = reviewActor(tab);
    pipe.innerHTML = steps.map((step, index) => {
      const active = index === currentIndex;
      const stop = active && actor && ["stopped", "failed"].includes(actor.seat?.status);
      const owners = active ? stepOwners(tab, step).map((item) => item.user
        ? `<span class="you" title="You">${esc(meName()[0])}</span>`
        : seatImg(item.seat, ` title="${esc(item.seat.name)}"`)).join("") : "";
      const label = stop ? `${step.label.split(" · ")[0]} · round ${actor.round} · ${actor.seat.name} ${actor.seat.status}` : step.label;
      const cls = step.state === "done" ? "done" : active ? `now${stop ? " stop" : lookPending(tab) ? "" : " go"}${(tab.processState?.round ?? 1) > 2 && step.type === "rounds" ? " hot" : ""}` : "";
      return `${index ? '<span class="link" aria-hidden="true"></span>' : ""}<span class="step ${cls}" data-step="${index}" data-step-id="${esc(step.stepId)}"${active ? ' aria-current="step"' : ""} title="${esc(label)}"><span class="n">${step.state === "done" ? "✓" : index + 1}</span><span class="sx">${esc(label)}</span>${active && owners ? `<span class="who">${owners}</span>` : ""}</span>`;
    }).join("");
    pipe.setAttribute("aria-label", `${kindLabel(tab.kind)} · ${setupLabel(tab)} process`);
    const acts = $("stepActs"), focused = document.activeElement?.closest?.("#stepActs") ? focusKeyOf(document.activeElement) : null;
    acts.innerHTML = stepActions(tab);
    acts.querySelectorAll("[data-process-action]").forEach((button) => button.addEventListener("click", () => runProcessAction(tab, button.dataset.processAction)));
    acts.querySelectorAll("[data-fixer]").forEach((button) => button.addEventListener("click", () => { if (button.getAttribute("aria-checked") !== "true") runProcessAction(tab, "selectFixer", { slot: button.dataset.fixer }); }));
    acts.querySelector("[data-ask-changes]")?.addEventListener("click", askForChanges);
    acts.querySelectorAll("[data-open-screenshots]").forEach((button) => button.addEventListener("click", () => openScreenshotViewer(button.dataset.openScreenshots, null, button)));
    acts.querySelectorAll("[data-open-seat]").forEach((button) => button.addEventListener("click", () => openSeatView(tab.id, button.dataset.openSeat)));
    fixRadios(acts);
    if (focused) acts.querySelector(focused)?.focus({ preventScroll: true });
    const history = tab.processState?.roundHistory ?? [];
    $("rounds").innerHTML = history.map((round) => `<span>Round ${esc(round.round)} · ${esc(round.reviewerName)} · ${round.outcome === "clean" ? "clean" : `findings, ${esc(round.fixerName ?? "the fixer")} ${round.round === tab.processState.round && actor?.phase === "fix" ? "fixing" : "fixed"}`}</span>`).join("");
    const rounds = steps.some((step) => step.type === "rounds");
    $("stepnote").textContent = lookPending(tab) ? (rounds ? "Review round 1 waits for running work to finish once you approve. Nothing is reviewed until then." : "This setup has no review rounds: approving finishes the work.") : rounds ? "Review rounds repeat until a round comes back clean." : "This setup has no review rounds.";
  }
  // Round n uses pair (n - 1) % pairs.length of the rounds step; its fixers are the seats the user can choose between (the server keeps the choice).
  function currentPairFixers(tab, round) {
    const pairs = (tab?.steps ?? []).find((step) => step.type === "rounds")?.pairs ?? [];
    const pair = pairs.length ? pairs[(Math.max(1, Number(round) || 1) - 1) % pairs.length] : null;
    return (pair?.fixers ?? []).map((slot) => seatFor(tab, slot)).filter(Boolean);
  }
  // The chosen fixer counts only when it is in this pair's list, otherwise the pair's first one fixes (the same rule as the server).
  function chosenFixer(tab, fixers) { const picked = tab.processState?.selectedFixer; return fixers.some((item) => item.slot === picked) ? picked : fixers[0]?.slot; }
  function stepActions(tab) {
    const steps = tab.derived?.stepBar ?? [], index = steps.findIndex((step) => step.state === "current"), step = steps[index];
    if (!step) return "";
    const pending = processPending.get(tab.id);
    const button = (action, label, primary = false, extra = "") => `<button type="button" class="btn sm${primary ? " primary" : ""}" data-process-action="${action}"${extra}${pending ? " disabled" : ""}>${pending === action ? "Sending…" : esc(label)}</button>`;
    if (step.type === "look" && lookPending(tab)) {
      const shots = screenshotPaths(tab).length;
      return `<span class="lbl">Your turn:</span>${button("approveLook", "Approve the look", true)}<button type="button" class="btn sm" data-ask-changes>Ask for changes</button>${shots ? `<button type="button" class="btn sm" data-open-screenshots="${esc(tab.id)}">Open screenshots (${shots})</button>` : ""}`;
    }
    const actor = reviewActor(tab);
    if (actor) {
      const seat = actor.seat, name = seat?.name ?? "The assigned seat";
      const waiting = /^Waiting for /.test(String(tab.derived?.approvedCardLine ?? ""));
      if (waiting) return `<span class="faint">${tab.steps?.some((step) => step.type === "look") ? "Approved. " : ""}${esc(String(tab.derived.approvedCardLine).replace(/^Waiting for /, "Review round " + actor.round + " starts when ").replace(/ to finish\.$/, " finish."))}</span>`;
      if (seat && ["stopped", "failed"].includes(seat.status)) return `<span class="faint">Round ${esc(actor.round)} is paused because ${esc(name)}${seat.status === "failed" ? "'s run failed. Open it and run it again to continue." : ` was stopped. ${seatBlocked(tab, seat) ? "Allow it again and run it" : "Run it again"} to continue.`}</span><button type="button" class="btn sm" data-open-seat="${esc(seat.slot)}">Open ${esc(name)}</button>`;
      const running = seat && liveRuns(tab, seat).length > 0;
      if (actor.phase === "review") {
        if (running) return `<span class="faint">${esc(name)}'s review run is still going. Its result buttons appear when it ends.</span>`;
        return `<span class="lbl">When ${esc(name)}'s review is in:</span>${button("reviewFindings", "Found findings")}${button("reviewClean", "Review is clean", true)}`;
      }
      const fixers = currentPairFixers(tab, actor.round);
      const makerBox = fixers.length > 1 ? `<span class="makers" role="radiogroup" aria-label="Who fixes this round">${fixers.map((item) => `<button type="button" role="radio" data-fixer="${esc(item.slot)}" aria-checked="${String(chosenFixer(tab, fixers) === item.slot)}"${pending ? " disabled" : ""}>${esc(item.name)}</button>`).join("")}</span>` : "";
      if (running) return `<span class="faint">${esc(name)}'s fix run is still going. Finish fixes unlocks when it ends.</span>${makerBox}<button type="button" class="btn sm primary" data-process-action="finishFix" disabled>Finish fixes</button>`;
      return `<span class="lbl">${esc(name)} is fixing round ${esc(actor.round)}.</span>${makerBox}${button("finishFix", "Finish fixes", true)}`;
    }
    if (step.type !== "look" && step.type !== "rounds" && index < steps.length - 1) return button("advanceStep", `Continue to ${String(steps[index + 1]?.label ?? "the next step").split(" · ")[0]}`, true);
    if (index === steps.length - 1) return `<span class="faint">Last step. ${esc(leaderName(tab))} finishes up here.</span>`;
    return "";
  }
