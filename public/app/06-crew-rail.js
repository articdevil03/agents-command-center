// Command Center page script, part 6 of 12: inner tabs and crew rail. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
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
      el.className = "tab"; el.dataset.tabId = item.id; el.title = `${item.name}${marker ? ` · ${marker.label}` : ""}`;
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
      { label: "Crew", sub: tab.id === currentTab()?.id ? "Choose its models in Settings" : "Open the tab to choose its models", run: () => (tab.id === currentTab()?.id ? openSettings(anchor, "crew") : selectTabFromUser(tab.id)) },
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
  function seatBlocked(tab, seat) { const key = seatKeyOf(tab, seat); return (serverState?.launchSafety?.blocked ?? []).some((row) => (typeof row === "string" ? row : row?.seatKey ?? row?.seatId) === key); }
  function stopLabel(state) { return state === "unconfirmed" ? "Stop not confirmed" : state === "requested" ? "Stop requested…" : "Stopping…"; }
  function runStopState(tab, run) {
    if (uncertainRun(run.runId)) return "unconfirmed";
    const local = stopStates.get(run.runId);
    if (local) return local;
    return engineSeat(tab, run.seatSlotId)?.status === "stopped" ? "accepted" : null;
  }
  function seatLine(tab, seat) {
    if (toolApprovalWaiting(tab, seat)) return { cls: "waiting", text: "Waiting on your answer" };
    const live = liveRuns(tab, seat);
    const closing = live.map((run) => runStopState(tab, run)).filter(Boolean);
    if (closing.length) { const state = closing.find((item) => item === "unconfirmed") ?? closing.find((item) => item === "accepted") ?? closing[0]; return { cls: state === "requested" ? "working" : "stopped", text: stopLabel(state) }; }
    if (seat.isLeader && savePending.has(tab.id)) return { cls: "working", text: "Saving the handover" };
    if (seat.isLeader && tab.derived?.leaderTurnActive) return { cls: "working", text: "Replying" };
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
  function needsYou(tab, seat) { return toolApprovalWaiting(tab, seat) || Boolean(seat.isLeader && (serverState?.requests ?? []).some((request) => request.status === "pending" && request.toTabId === tab.id)); }
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
    fixedCrewUi?.renderTab(tab, box); // a fixed crew tab draws its own setup-only rail and work view (public/fixed-crew/view.js)
    if (!tab) { $("crewLbl").textContent = "Crew"; $("setupsLbl").textContent = ""; return; }
    $("crewLbl").textContent = "Crew";
    const switcher = $("setupsBtn"), crewName = "Fixed crew";
    $("setupsLbl").textContent = crewName;
    switcher.setAttribute("aria-label", `${crewName}. Choose its models in Settings`);
    switcher.dataset.tip = `${crewName}\nClick to choose its models`;
    switcher.title = railWide ? `${crewName}. Choose its models in Settings` : "";
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
