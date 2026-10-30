// Command Center page script, part 10 of 12: creating tabs, the seat card, pictures, running a seat, screenshots. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function renderAll() {
    const active = document.activeElement, key = active && active !== document.body ? focusKeyOf(active) : null;
    // The same control can exist in the work view and in an open card: focus comes back inside the layer it was in.
    const LAYERS = ".pop,.modal", layerId = key ? active.closest(LAYERS)?.id : null;
    const selection = active && "selectionStart" in active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    requestVisibleTabTranscript();
    const none = Boolean(serverState) && !visibleProjects().length;
    $("first").hidden = !none; $("stage").hidden = none;
    if (none) { sideOpen && ($("side").hidden = true); renderFirst(); }
    renderHeader(); renderTabs(); renderCrew(); renderStage(); renderSide(); renderUndo(); renderInbox();
    if (!$('setModal').hidden) renderSettings();
    renderAvatarStatus();
    renderToolApproval();
    applySideWidth();
    refreshPopovers();
    if (key && !active.isConnected && (document.activeElement === document.body || !document.activeElement)) { const next = $$(key).find((el) => shown(el) && (layerId ? el.closest(LAYERS)?.id === layerId : !el.closest(LAYERS))); if (next) { next.focus({ preventScroll: true }); if (selection && next.setSelectionRange) try { next.setSelectionRange(selection[0], selection[1]); } catch { /* not a text field */ } } }
    ensureTicker();
  }
  function refreshPopovers() {
    const seatPop = $("seatPop");
    if (!seatPop.hidden) {
      const tab = findTab(seatPop.dataset.tabId), seat = seatFor(tab, seatPop.dataset.slot);
      if (!tab || !seat || tab.id !== currentTab()?.id) setLayer(seatPop, false, null, false, false);
      else renderSeatCard(tab, seat);
    }
    refreshModelPicker();
    for (const id of ["seatPop", "pop", "projPop", "ctxPop", "setupPop", "permPop", "inboxPop", "soundPop"]) { const pop = $(id); if (!pop.hidden) placePopover(pop); }
  }
  function renderFirst() {
    const tools = serverState?.settings?.tools ?? {};
    const status = (cli) => { const tool = tools[cli]; return tool?.installed === false ? "Not installed" : tool?.installed === true ? (tool.signedIn === true ? "Signed in" : tool.signedIn === false ? "Installed, not signed in" : "Installed, sign-in status unknown") : "Install status unknown"; };
    $("first").innerHTML = `<div class="fcard"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M42.2 46.6A19 19 0 1 1 42.2 17.4" fill="none" stroke="url(#orbitMark)" stroke-width="12" stroke-linecap="round"/><circle cx="50.5" cy="32" r="6.5" fill="#ffc94d"/></svg><h2>Add your first project</h2><p>A project is a folder on your PC. It starts with one Development tab and Our process; you can add Design or Marketing tabs and switch the crew later.</p><button type="button" class="btn primary" data-first-project>New project</button><div class="card checks">${["claude", "codex", "opencode", "gemini"].map((cli) => `<div class="crow"><span class="logo">${logo(cli, 16, 0)}</span><div class="d"><b>${esc(cliLabel(cli))}</b><small>${esc(status(cli))}</small></div>${tools[cli]?.signedIn === true ? '<span class="tool-connected"><i></i>Ready</span>' : `<button type="button" class="btn sm" data-first-setup>Set up</button>`}</div>`).join("")}</div><p class="faint" style="font-size:12.5px">Claude, Codex or OpenCode can run the leader, and so can any ACP CLI you add in Settings. You only need the ones your crew uses.</p></div>`;
    $("first").querySelector("[data-first-project]")?.addEventListener("click", (event) => openProjectDialog(event.currentTarget));
    $("first").querySelectorAll("[data-first-setup]").forEach((button) => button.addEventListener("click", (event) => openSettings(event.currentTarget, "tools")));
  }
  function ensureTicker() {
    if (tickerTimer) return;
    if (!needsTicker()) return;
    tickerTimer = setInterval(tick, 1000);
  }
  function needsTicker() { return Boolean(document.querySelector("[data-run-time],[data-undo-due],[data-job-since]") || connState === "off"); }
  function tick() {
    document.querySelectorAll("[data-job-since]").forEach((element) => { element.textContent = jobAge(Number(element.dataset.jobSince)); });
    document.querySelectorAll("[data-run-time]").forEach((element) => {
      const run = allTabs().flatMap(({ tab }) => tab.runs ?? []).find((item) => item.runId === element.dataset.runTime);
      if (run?.status === "working") element.textContent = spanText(run.startedAt);
    });
    document.querySelectorAll("[data-undo-due]").forEach((element) => { element.textContent = undoSeconds(Number(element.dataset.undoDue)); });
    const retry = $("retryS"); if (retry) retry.textContent = `${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))} s`;
    if (!needsTicker()) { clearInterval(tickerTimer); tickerTimer = 0; }
  }

  // ---------- creating tabs and projects, switching the crew ----------
  function availableKindOptions(selected) {
    return KINDS.map((kind) => `<button type="button" role="radio" aria-checked="${String(kind.id === selected)}" data-kind="${kind.id}"><b>${esc(kind.name)}</b><small>${esc(kind.desc)}</small></button>`).join("");
  }
  function kindSegments(selected) { return KINDS.map((kind) => `<button type="button" role="radio" data-kind="${kind.id}" aria-checked="${String(kind.id === selected)}">${esc(kind.name)}</button>`).join(""); }
  // The setups the server offers: templates (in code) and the user's saved setups. A tab keeps its own copy of whichever it was switched to.
  const templates = () => Array.isArray(serverState?.templates) ? serverState.templates : [];
  const savedSetups = () => Array.isArray(serverState?.savedSetups) ? serverState.savedSetups : [];
  const seatCount = (crew) => `${crew?.length ?? 0} seat${crew?.length === 1 ? "" : "s"}`;
  // A new Development tab starts with Our process; any other kind starts with its own first template.
  function defaultTemplate(kind) { const list = templates(); return (kind === "dev" ? list.find((item) => item.id === "our-process") : null) ?? list.find((item) => item.kind === kind) ?? list[0] ?? null; }
  function templateOptions(selected) {
    return templates().map((item) => `<button type="button" role="radio" aria-checked="${String(item.id === selected)}" data-template="${esc(item.id)}"><b>${esc(item.name)}</b><small>${esc(item.desc)} · ${seatCount(item.crew)}</small></button>`).join("");
  }
  function bindRadios(box, selector, callback) {
    box.addEventListener("click", (event) => {
      const button = event.target.closest(selector); if (!button || !box.contains(button)) return;
      box.querySelectorAll(selector).forEach((item) => item.setAttribute("aria-checked", String(item === button)));
      fixRadios(box.parentElement ?? box);
      callback(button);
    });
    box.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = $$(selector, box).filter((item) => !item.disabled); const index = items.indexOf(document.activeElement); if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + items.length) % items.length;
      items[next].focus(); items[next].click();
    });
  }
  function openAddTab(opener) {
    const project = currentProject(); if (!project) return;
    tabKind = "dev"; tabTemplate = defaultTemplate(tabKind)?.id ?? "";
    $("mProj").textContent = project.name; $("tName").value = "";
    $("tStat").textContent = ""; $("tStat").classList.remove("bad"); $("tOnly").checked = true;
    updateFolderDisplay("tab", project.folder);
    $("kindBox").innerHTML = availableKindOptions(tabKind); $("tplBox").innerHTML = templateOptions(tabTemplate);
    openModal("modal", opener);
  }
  function openProjectDialog(opener) {
    projectKind = "dev"; projectTemplate = defaultTemplate(projectKind)?.id ?? "";
    const defaultFolder = serverState?.settings?.folders?.defaultProjectFolder ?? "";
    $("pName").value = ""; $("pOnly").checked = true; updateFolderDisplay("project", defaultFolder);
    $("pFolderHelp").textContent = defaultFolder ? `Starts in your default folder, ${defaultFolder}. Browse to pick another.` : "No default folder is set. Browse to pick one, or set it in Settings, Folders.";
    $("pKind").innerHTML = kindSegments(projectKind); $("pTpl").innerHTML = templateOptions(projectTemplate);
    $("npStat").classList.remove("bad");
    updateProjectSubmit();
    openModal("projModal", opener);
  }
  let selectedTabFolder = "";
  let selectedProjectFolder = "";
  function updateFolderDisplay(which, folder) {
    const path = String(folder ?? "");
    if (which === "tab") { selectedTabFolder = path; $("tDir").textContent = path || "No folder chosen"; $("tDir").title = path || "No folder chosen"; $("tFolderWarn").hidden = Boolean(path); $("createTab").disabled = !path || Boolean(pendingCreate); }
    else { selectedProjectFolder = path; $("pDir").textContent = path || "No folder chosen"; $("pDir").title = path || "No folder chosen"; $("pFolderWarn").hidden = Boolean(path); updateProjectSubmit(); }
  }
  function updateProjectSubmit() {
    const ready = Boolean(selectedProjectFolder && $("pName").value.trim());
    $("createProj").disabled = !ready || Boolean(pendingCreate);
    if (!pendingCreate && !$("npStat").classList.contains("bad")) $("npStat").textContent = ready ? "" : !selectedProjectFolder ? "Choose a folder to create it." : "Give it a name to create it.";
  }
  function updateCreateButtons() {
    $("createTab").disabled = !selectedTabFolder || Boolean(pendingCreate); $("createTab").textContent = pendingCreate?.kind === "tab" ? "Creating…" : "Create tab";
    $("createProj").textContent = pendingCreate?.kind === "project" ? "Creating…" : "Create project"; updateProjectSubmit();
  }
  async function pickFolder(callback) {
    if (!window.cc || typeof window.cc.pickFolder !== "function") { showToast("Open the Command Center app to choose a folder"); return; }
    try { const folder = await window.cc.pickFolder(); if (folder) callback(folder); }
    catch (error) { showToast(error?.message ?? "Could not choose a folder"); }
  }
  // The faces a setup brings, from its own seats, so the menu shows who comes with each choice before switching.
  function setupFaces(crew) { return (crew ?? []).map((seat) => `<img src="/avatars/${avatarKeyFor(seat)}.svg" alt="">`).join(""); }
  function processMenu(tab, anchor) {
    const pop = $("setupPop");
    const busy = activeTabBusy(tab);
    const option = (attr, id, name, desc, crew) => {
      const inUse = tab.setupName === name;
      return `<button type="button" class="opt su" ${attr}="${esc(id)}" aria-pressed="${String(inUse)}"><span class="nm"><span>${esc(name)}</span><small>${esc(desc)} · ${seatCount(crew)}${inUse ? " · in use" : ""}</small></span><span class="faces">${setupFaces(crew)}</span>${ICONS.tick}</button>`;
    };
    const saved = savedSetups();
    pop.innerHTML = `<div class="grp">Crew for ${esc(tab.name)}</div><div class="process-options">${templates().map((item) => option("data-use-template", item.id, item.name, item.desc, item.crew)).join("")}</div>${saved.length ? `<div class="grp">Saved setups</div><div class="process-options">${saved.map((item) => option("data-use-saved", item.id, item.name, `${kindLabel(item.kind)} · ${(item.steps ?? []).length} steps`, item.crew)).join("")}</div>` : ""}<div class="hint">${busy ? "The crew can change only while nothing runs in this tab: the server refuses a busy tab, and the change comes back. Stop its work first." : "Seats and steps come with the setup. A seat with the same id keeps its model, effort, name and picture. You can still change each seat afterwards."}</div>`;
    fixRadios(pop);
    pop.querySelectorAll("[data-use-template],[data-use-saved]").forEach((button) => button.addEventListener("click", () => {
      const templateId = button.dataset.useTemplate, setupId = button.dataset.useSaved;
      const item = templateId ? templates().find((other) => other.id === templateId) : savedSetups().find((other) => other.id === setupId);
      if (!item) return;
      // one waiting switch per tab: a new pick replaces the unsent one; picking the setup the tab already has cancels it
      for (const held of [...pendingActions.values()]) if (!held.sent && held.message.type === "useSetup" && held.message.tabId === tab.id) finishPending(held.id);
      if (item.name === tab.setupName && item.crew.length === tab.crew.length && item.crew.every((seat, at) => seat.slot === tab.crew[at].slot && seat.role === tab.crew[at].role && seat.canWrite === tab.crew[at].canWrite && (seat.orchestrates === true) === (tab.crew[at].orchestrates === true)) && (item.lookPause === true) === (tab.lookPause === true)) { setLayer(pop, false); renderAll(); return; }
      setLayer(pop, false);
      const message = { type: "useSetup", tabId: tab.id, ...(templateId ? { templateId } : { setupId }) };
      holdAction(message, `${tab.name} will use ${item.name}`, { type: "useSetup", tabId: tab.id, message, setupName: item.name, crewGenerationId: tab.processState?.crewGenerationId });
    }));
    openPopover(pop, anchor, anchor === $("setupsBtn") && !railWide);
    markCrewSwitcher();
  }
  function createTab() {
    const project = currentProject(); if (!project || !selectedTabFolder || pendingCreate) return;
    const name = $("tName").value.trim() || kindLabel(tabKind);
    if (!send({ type: "addTab", projectId: project.id, name, kind: tabKind, ...(tabTemplate ? { template: tabTemplate } : {}), folder: selectedTabFolder, projectOnly: $("tOnly").checked })) return;
    pendingCreate = { kind: "tab", projectId: project.id, knownTabIds: new Set(project.tabs.map((tab) => tab.id)) };
    $("tStat").textContent = "Creating…"; $("tStat").classList.remove("bad");
    updateCreateButtons();
  }
  function createProject() {
    const name = $("pName").value.trim(); if (!name || !selectedProjectFolder || pendingCreate) return;
    const id = `project-${slug(name)}-${Date.now().toString(36)}`;
    if (!send({ type: "addProject", id, name, folder: selectedProjectFolder, tabFolder: selectedProjectFolder, kind: projectKind, ...(projectTemplate ? { template: projectTemplate } : {}), projectOnly: $("pOnly").checked })) return;
    pendingCreate = { kind: "project", id };
    $("npStat").textContent = "Creating…"; $("npStat").classList.remove("bad");
    updateCreateButtons();
  }
  function slug(value) { return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"; }

  // ---------- seat card and pickers ----------
  function seatUsageText(tab, seat) {
    if (seat.isLeader) return formatUsage(tab.leaderUsage) ?? "Not reported";
    const runs = liveRuns(tab, seat).filter((run) => run.usage);
    const total = runs.reduce((sum, run) => sum + (usageTokens(run.usage) ?? 0), 0);
    return runs.length ? `${fmtK(total)} tokens in live runs` : "Not reported";
  }
  function renderSeatCard(tab, seat) {
    const pop = $("seatPop");
    const focusKey = document.activeElement?.closest?.("#seatPop") ? focusKeyOf(document.activeElement) : null;
    const runs = liveRuns(tab, seat), line = seatLine(tab, seat), blocked = !seat.isLeader && seatBlocked(tab, seat), locked = seatLocked(tab, seat);
    const now = seat.isLeader && seat.status === "idle" && !tab.derived?.leaderTurnActive && line.cls !== "waiting" ? (tab.leaderStatus === "ready" ? "Ready for your next message" : "Ready. The session starts with your first message") : !seat.isLeader && (seat.status === "idle" || !seat.status) && !blocked ? `Ready. Starts when ${leaderName(tab)} hands over a brief, or when you press Run` : line.text;
    const alive = seat.isLeader && (tab.leaderStatus === "ready" || tab.derived?.leaderTurnActive || seat.status === "working" || seat.status === "waiting");
    // The Advisor row is for any seat whose CLI can take one (CliCap.advisor); the advisor is that seat's own setting.
    const advisorRow = cliCap(seat.cli)?.advisor ? `<button type="button" class="rowb" data-seat-advisor><span>Advisor</span><span class="v" style="color:var(--adv)"><span>✦ ${esc(seat.advisor ? formatModel(seat.cli, seat.advisor) : "Off")}</span></span>${ICONS.rchev}</button>` : "";
    pop.dataset.tabId = tab.id; pop.dataset.slot = seat.slot;
    pop.setAttribute("aria-label", `Seat ${seat.name}`);
    pop.innerHTML = `<div class="sc"><div class="top">${seatImg(seat)}<div style="min-width:0;flex:1"><b><span title="${esc(seat.name)}">${esc(seat.name)}</span><button type="button" class="pen" data-seat-rename aria-label="Rename ${esc(seat.name)}" title="Rename">${ICONS.pencil}</button></b><small title="${esc(seatRole(tab, seat))}">${esc(seatRole(tab, seat))}${seat.isLeader && seatRole(tab, seat).toLowerCase() !== "leader" ? " · leader" : ""}</small></div><button type="button" class="dots" data-seat-picture aria-haspopup="dialog" aria-label="Change picture for ${esc(seat.name)}" title="Change picture">${ICONS.picture}</button></div><div class="now ${esc(line.cls)}"><i></i><span>${esc(now)}</span></div>${blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. ${esc(seat.name)} cannot start until you allow it.</span><button type="button" class="btn sm" data-seat-unblock>Allow again</button></div>` : ""}${runs.length ? `<div class="rows">${runs.map((run) => { const state = runStopState(tab, run); return `<div class="sr"><span class="d"></span><button type="button" class="srl" data-watch-run="${esc(run.runId)}" title="Watch ${plainMd(run.label)}">${plainMd(run.label)}</button><span class="tm" data-run-time="${esc(run.runId)}">${esc(spanText(run.startedAt))}</span><button type="button" class="x" data-stop-run="${esc(run.runId)}" aria-label="Stop ${plainMd(run.label)}" title="Stop only this run"${state ? " disabled" : ""}>${state ? esc(stopLabel(state)) : ICONS.stop}</button></div>`; }).join("")}</div>` : ""}<div class="rows"><button type="button" class="rowb" data-seat-model${locked ? ` disabled aria-disabled="true" title="${LOCK_TIP}"` : ""}><span>Model</span><span class="v">${logo(seat.cli, 13, 0)}<span><span class="model-label">${esc(formatModel(seat.cli, seat.model, tab))}</span>${modelSupportsEffort(seat.cli, seat.model) ? ` <span class="faint eff">· ${esc(seat.effort)}</span>` : ""}</span></span>${ICONS.rchev}</button>${locked ? `<div class="hint" data-model-locked>Locked while working</div>` : ""}${advisorRow}${seat.isLeader ? `<div class="rowb"><span>Context</span><span class="v" data-context-meter title="${esc(contextLine(tab))}"><span>${esc(cap(contextLine(tab)))}</span></span><span></span></div>` : `<div class="rowb"><span>Access</span><span class="v" title="${esc(accessText(tab, seat))}"><span>${esc(accessText(tab, seat))}</span></span><span></span></div>`}<div class="rowb"><span>Usage</span><span class="v" title="${esc(seatUsageText(tab, seat))}"><span>${esc(seatUsageText(tab, seat))}</span></span><span></span></div></div>${seat.isLeader ? `<div class="acts"><button type="button" class="btn" data-seat-chat>Chat</button><button type="button" class="btn" data-seat-history>Past sessions</button></div>` : `<div class="acts"><button type="button" class="btn" data-seat-watch>Watch</button></div>`}<div class="acts">${seat.isLeader ? (alive ? `<button type="button" class="btn danger" data-stop-seat title="Stops ${esc(seat.name)}'s session and denies anything it is waiting on. Your next message starts a fresh one.">Stop ${esc(seat.name)}</button>` : "") : `<button type="button" class="btn primary" data-run-seat>${runs.length ? "Run another" : "Run"}</button><button type="button" class="btn danger" data-stop-seat title="${runs.length ? `Stops every run of ${esc(seat.name)} and blocks new launches` : `Blocks ${esc(seat.name)} from launching until you allow it again`}">${runs.length ? "Stop seat" : "Block launches"}</button>`}</div></div>`;
    const anchor = () => pop._anchor;
    pop.querySelector("[data-seat-rename]").addEventListener("click", () => renameDialog(`Rename ${seat.name}`, seat.name, (name) => send({ type: "updateSeat", tabId: tab.id, slot: seat.slot, name }), anchor()));
    pop.querySelector("[data-seat-picture]").addEventListener("click", () => openSeatAvatar(tab, seat, anchor()));
    pop.querySelector("[data-seat-unblock]")?.addEventListener("click", () => unblockWithConfirm(tab, seat, anchor()));
    pop.querySelectorAll("[data-watch-run]").forEach((button) => button.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedRunBySeat.set(seat.slot, button.dataset.watchRun); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); }));
    pop.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
    pop.querySelector("[data-seat-model]").addEventListener("click", () => openModelPicker(tab, seat, anchor(), true));
    pop.querySelector("[data-seat-advisor]")?.addEventListener("click", () => openAdvisor(tab, seat, anchor(), true));
    pop.querySelector("[data-seat-chat]")?.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); $("ci").focus(); });
    pop.querySelector("[data-seat-watch]")?.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedView = "live"; historyRunRequested.delete(seatKeyOf(tab, seat)); closePopovers(); renderStage(); renderCrew(); });
    pop.querySelector("[data-seat-history]")?.addEventListener("click", () => { closePopovers(); showLeaderHistory(tab); });
    pop.querySelector("[data-run-seat]")?.addEventListener("click", () => openRunDialog(tab, seat, anchor()));
    pop.querySelector("[data-stop-seat]")?.addEventListener("click", () => stopSeat(tab, seat));
    // A control that just locked cannot hold focus: keep it on the first enabled one so it does not fall to the page.
    const focusTarget = focusKey ? pop.querySelector(focusKey) : null;
    if (focusTarget) (focusTarget.disabled ? pop.querySelector("button:not(:disabled)") : focusTarget)?.focus({ preventScroll: true });
  }
  function openSeatCard(tab, seat, anchor) {
    renderSeatCard(tab, seat);
    openPopover($("seatPop"), anchor, Boolean(anchor?.closest?.("#crew")));
    renderCrew();
  }
  function reopenSeatCard(tab, seat, anchor) {
    const live = findTab(tab.id), current = seatFor(live, seat.slot);
    if (live && current) openSeatCard(live, current, anchor);
  }
  // The model and advisor menus live in public/model-picker.js (loaded before this file). The page reaches them through these names, and
  // they reach the page through this object; what a test or a later line may replace (send, confirmAction, openPopover) is looked up per call.
  const { pickerClis, modelRows, pickerHints, drawModelPicker, openModelPicker, openAdvisor, refreshModelPicker } = window.CC_PICKER?.({
    $, esc, logo, cliCaps, cliCap, cliLabel, isAcpCli, acpShownModel, formatModel, modelOptions, customModelPattern, modelSupportsEffort, effortOptions,
    seatLocked, fixRadios, focusKeyOf, placePopover, setLayer, reopenSeatCard, findTab, seatFor, icons: ICONS, lockTip: LOCK_TIP,
    get state() { return serverState; },
    send: (message) => send(message), confirmAction: (...args) => confirmAction(...args), openPopover: (...args) => openPopover(...args),
  }) ?? {};

  // ---------- pictures ----------
  function openSeatAvatar(tab, seat, anchor) { avatarTarget = { tabId: tab.id, slot: seat.slot }; drawAvatars(false, anchor); }
  function openMeAvatar(anchor) { avatarTarget = null; drawAvatars(true, anchor); }
  function drawAvatars(isMe, opener) {
    avatarUploadRequestId = null;
    const seat = isMe ? null : seatFor(findTab(avatarTarget.tabId), avatarTarget.slot);
    $("avTitle").textContent = isMe ? "Your picture" : `Picture for ${seat?.name ?? "this seat"}`;
    $("avatarStatus").textContent = isMe ? "Any PNG, JPEG or WebP picture. It stays on this PC." : "PNG, JPEG or WebP, up to 12 MiB.";
    $("avatarStatus").dataset.status = "";
    const choices = isMe ? AVATAR_PRESETS.map((file) => ({ key: file, src: `/avatars/${file}.svg`, selected: me.av === `${file}.svg` }))
      : AVATAR_PRESETS.map((file) => {
        const tab = findTab(avatarTarget.tabId);
        const seat = seatFor(tab, avatarTarget.slot);
        return { key: file, src: `/avatars/${file}.svg`, selected: !UPLOADED_PIC.test(String(seat?.pic ?? "")) && avatarKeyFor(seat) === file };
      });
    $("avgrid").innerHTML = `${choices.map((choice) => `<button type="button" role="radio" aria-checked="${String(choice.selected)}" data-avatar="${esc(choice.key)}" aria-label="${esc(cap(choice.key))}" title="${esc(cap(choice.key))}"><img src="${esc(choice.src)}" alt=""></button>`).join("")}<button type="button" class="up" id="avUpload" aria-label="Upload a picture">Upload</button>`;
    $("avgrid").querySelectorAll("[data-avatar]").forEach((button) => button.addEventListener("click", () => {
      if (isMe) { me = { av: `${button.dataset.avatar}.svg` }; saveMe(); $("meImg").dataset.fellBack = ""; $("meImg").src = mePic(); renderStage(); }
      else {
        const pic = `avatars/${button.dataset.avatar}.svg`;
        if (!send({ type: "updateSeat", tabId: avatarTarget.tabId, slot: avatarTarget.slot, pic })) return;
        avatarPending = { tabId: avatarTarget.tabId, slot: avatarTarget.slot, pic };
        $("avatarStatus").textContent = "Saving…"; $("avatarStatus").dataset.status = "running";
      }
      $("avgrid").querySelectorAll("[data-avatar]").forEach((item) => item.setAttribute("aria-checked", String(item === button)));
      fixRadios($("avModal"));
    }));
    $("avUpload").addEventListener("click", () => $("avUp").click());
    openModal("avModal", opener);
    fixRadios($("avModal"));
  }
  // A picture must decode before it replaces the old one: broken bytes keep the old picture, and the picker says why.
  function decodes(src) { return new Promise((resolve) => { const probe = new Image(); probe.onload = () => resolve(probe.naturalWidth > 0); probe.onerror = () => resolve(false); probe.src = src; }); }
  async function uploadMe(file) {
    if (!file || !file.type.startsWith("image/")) { showToast("Choose an image file"); return; }
    if (avatarTarget) {
      if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) { showToast("Seat pictures must be PNG, JPEG or WebP"); return; }
      if (file.size > 12 * 1024 * 1024) { showToast("Pictures must be 12 MiB or smaller"); return; }
      const target = { ...avatarTarget };
      const requestId = newRequestId(); avatarUploadRequestId = requestId;
      $("avatarStatus").textContent = "Uploading"; $("avatarStatus").dataset.status = "running"; $("avUpload").disabled = true;
      try {
        const bytes = await file.arrayBuffer();
        if (avatarUploadRequestId !== requestId) return;
        const response = await keyedFetch("/api/avatar", { method: "POST", headers: { "Content-Type": file.type, "X-Request-Id": requestId }, body: bytes });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Picture upload failed (${response.status})`);
        if (avatarUploadRequestId !== requestId || !findTab(target.tabId) || !seatFor(findTab(target.tabId), target.slot)) return;
        if (!send({ type: "updateSeat", tabId: target.tabId, slot: target.slot, pic: result.path })) throw new Error("Seat picture could not be applied");
        $("avatarStatus").textContent = "Done"; $("avatarStatus").dataset.status = "done";
        // He chose the picture, so it is applied either way; only close the dialog if it is still the open layer.
        closeLayerOf($("avModal"));
      } catch (error) {
        avatarUploadRequestId = null;
        $("avatarStatus").textContent = error?.message ?? "Picture upload failed"; $("avatarStatus").dataset.status = "failed";
        if ($("avUpload")) $("avUpload").disabled = false;
      }
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") return;
      if (!(await decodes(reader.result))) { $("avatarStatus").textContent = "That file did not decode as a picture, so the old one stays"; $("avatarStatus").dataset.status = "failed"; return; }
      if (reader.result.length > AVATAR_MAX_CHARS) { $("avatarStatus").textContent = "That picture is too large to keep (limit " + AVATAR_MAX_CHARS / 1024 + " KB), so the old one stays"; $("avatarStatus").dataset.status = "failed"; return; }
      me = { av: reader.result }; saveMe(); $("meImg").dataset.fellBack = ""; $("meImg").src = mePic(); renderStage(); closeLayerOf($("avModal"));
    };
    reader.onerror = () => showToast("Could not load that picture");
    reader.readAsDataURL(file);
  }
  function renderAvatarStatus() {
    if (!avatarUploadRequestId || $("avModal").hidden) return;
    const status = serverState?.settings?.uploads?.[avatarUploadRequestId];
    if (!status || status.requestId !== avatarUploadRequestId) return;
    $("avatarStatus").textContent = status.message ?? status.status;
    $("avatarStatus").dataset.status = status.status;
    if ($("avUpload")) $("avUpload").disabled = status.status === "running";
  }

  // ---------- running a seat ----------
  function runDialogStatus(text, unknown) {
    const status = $("runStat"); if (!status) return;
    status.textContent = text; status.classList.toggle("bad", true);
    $("runStart").textContent = unknown ? "Outcome unknown" : "Start run";
    $("runStart").disabled = unknown || runUnknown || !$("runPrompt").value.trim();
    if (unknown) { pendingRun = null; runUnknown = true; }
  }
  function openRunDialog(tab, seat, opener) {
    runTarget = { tabId: tab.id, slot: seat.slot, name: seat.name }; runUnknown = false;
    const running = liveRuns(tab, seat).length, blocked = seatBlocked(tab, seat);
    $("runModal").setAttribute("aria-label", `Run ${seat.name}`);
    $("runTitle").textContent = `Run ${seat.name}`; $("runPrompt").value = ""; $("runStart").disabled = true; $("runStart").textContent = "Start run";
    $("runSub").innerHTML = `${esc(seatRole(tab, seat))} · ${logo(seat.cli, 12, 0)} ${esc(modelLine(seat.cli, seat.model, seat.effort))}${running ? ` · ${running} already running, this one runs alongside` : ""}`;
    $("runBlk").innerHTML = blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. Allow ${esc(seat.name)} again to start it.</span><button type="button" class="btn sm" data-run-unblock>Allow again</button></div>` : "";
    $("runBlk").querySelector("[data-run-unblock]")?.addEventListener("click", (event) => unblockWithConfirm(tab, seat, event.currentTarget));
    $("runFolder").textContent = tab.folder; $("runFolder").title = tab.folder;
    $("runAccess").textContent = `${accessText(tab, seat)}.`;
    $("runStat").textContent = ""; $("runStat").classList.remove("bad");
    openModal("runModal", opener);
  }
  function folderBusyAgo(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0)), m = Math.round(s / 60);
    return s < 60 ? `${s} second${s === 1 ? "" : "s"} ago` : `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  function folderBusyLine(item) {
    const writer = item?.writer;
    if (writer) return `${writer.seatName} (${writer.roleLabel}) in your ${writer.tabName} tab is writing code in this folder right now.`;
    const tool = typeof item?.tool === "string" ? item.tool : "";
    return tool ? `${"AEIOU".includes(tool[0]) ? "An" : "A"} ${tool} session outside Command Center was active here ${folderBusyAgo(item.agoSeconds)}.` : `Something outside Command Center changed files here ${folderBusyAgo(item?.agoSeconds)}.`;
  }
  function startRun(confirmBusy) {
    const prompt = $("runPrompt").value.trim(); if (!runTarget || !prompt || pendingRun || runUnknown) return;
    const target = runTarget;
    $("runStart").disabled = true; $("runStart").textContent = "Starting…";
    $("runStat").textContent = `Asking the server to launch ${target.name}…`; $("runStat").classList.remove("bad");
    // Waiting before sending: the server's answer can arrive inside send itself.
    pendingRun = { tabId: target.tabId, slot: target.slot };
    if (!send({ type: "run", tabId: target.tabId, slot: target.slot, prompt, ...(confirmBusy === true ? { confirmBusy: true } : {}) })) {
      pendingRun = null;
      $("runStart").disabled = false; $("runStart").textContent = "Start run";
      $("runStat").textContent = "Nothing was started."; $("runStat").classList.add("bad");
    }
  }

  // ---------- screenshots ----------
  function openScreenshotViewer(tabId, path = null, opener = null) {
    const tab = findTab(tabId); if (!tab) return;
    const paths = screenshotPaths(tab);
    if (!paths.length) return;
    viewerState = { tabId, index: path ? Math.max(0, paths.indexOf(path)) : -1, actual: false };
    if (path && !paths.includes(path)) viewerState.index = -1;
    $("viewerTitle").textContent = `Screenshots · ${tabLabel(tabId)}`;
    drawViewer();
    openModal("viewer", opener ?? document.querySelector(`[data-open-screenshots="${CSS.escape(tabId)}"]`));
  }
  function drawViewer() {
    const tab = findTab(viewerState?.tabId); if (!tab) return;
    const paths = screenshotPaths(tab), index = viewerState.index, path = paths[index];
    const bad = '<span class="bad">This picture could not be shown: the file did not decode as an image.</span>';
    const box = $("viewerFiles");
    if (path) {
      const name = String(path).split(/[\\/]/).at(-1) || "Screenshot";
      box.className = "bigshot";
      box.innerHTML = `<div class="bar2"><button type="button" class="btn sm" data-shot-grid>${ICONS.back}All screenshots</button><b title="${esc(name)}">${esc(name)}</b><span>${index + 1} of ${paths.length}</span><span class="spacer"></span><button type="button" class="btn sm" data-shot-fit aria-pressed="${String(viewerState.actual)}">${viewerState.actual ? "Fit to window" : "Actual size"}</button><button type="button" class="btn sm" data-shot-step="-1"${index > 0 ? "" : " disabled"}>Prev</button><button type="button" class="btn sm" data-shot-step="1"${index < paths.length - 1 ? "" : " disabled"}>Next</button></div><figure class="frame viewer-file${viewerState.actual ? " actual" : ""}"><img src="${esc(transcriptImageUrl(path))}" alt="${esc(name)}">${bad}</figure>`;
    } else {
      box.className = "";
      box.innerHTML = `<div class="viewer-files">${paths.map((item, position) => { const name = String(item).split(/[\\/]/).at(-1) || "Screenshot"; return `<figure class="viewer-file"><button type="button" data-shot-open="${position}" aria-label="Open ${esc(name)} at full size"><img src="${esc(transcriptImageUrl(item))}" alt="">${bad}</button><span title="${esc(name)}">${esc(name)}</span></figure>`; }).join("")}</div><p class="faint" style="font-size:12.5px;margin:0">Click a screenshot to check it at full size.</p>`;
    }
    box.querySelectorAll("img").forEach((image) => {
      const broken = () => image.closest("figure")?.classList.add("broken");
      image.addEventListener("error", broken, { once: true });
      image.addEventListener("load", () => { if (!image.naturalWidth) broken(); }, { once: true });
    });
    box.querySelectorAll("[data-shot-open]").forEach((button) => button.addEventListener("click", () => { viewerState.index = Number(button.dataset.shotOpen); viewerState.actual = false; drawViewer(); box.querySelector("[data-shot-grid]")?.focus(); }));
    box.querySelector("[data-shot-grid]")?.addEventListener("click", () => { const from = viewerState.index; viewerState.index = -1; drawViewer(); box.querySelector(`[data-shot-open="${from}"]`)?.focus(); });
    box.querySelector("[data-shot-fit]")?.addEventListener("click", () => { viewerState.actual = !viewerState.actual; drawViewer(); box.querySelector("[data-shot-fit]")?.focus(); });
    box.querySelectorAll("[data-shot-step]").forEach((button) => button.addEventListener("click", () => { viewerState.index = Math.max(0, Math.min(paths.length - 1, viewerState.index + Number(button.dataset.shotStep))); drawViewer(); (box.querySelector(`[data-shot-step="${button.dataset.shotStep}"]:not([disabled])`) ?? box.querySelector("[data-shot-grid]"))?.focus(); }));
  }

  // ---------- settings ----------
  function openSettings(anchor, section = currentTab() ? "crew" : "tools") {
    settingsSection = section;
    settingsFocusKey = null;
    renderSettings(true);
    openModal("setModal", anchor ?? $("setBtn"));
    requestAnimationFrame(() => { const body = $("setBody"), target = body.querySelector(`#s-${CSS.escape(section)}`); if (target) body.scrollTop = target.offsetTop - 20; markSettingsNav(); });
  }
