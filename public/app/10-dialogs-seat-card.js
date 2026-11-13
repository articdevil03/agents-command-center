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
    for (const id of ["seatPop", "pop", "projPop", "ctxPop", "permPop", "inboxPop", "soundPop"]) { const pop = $(id); if (!pop.hidden) placePopover(pop); }
  }
  function renderFirst() {
    const tools = serverState?.settings?.tools ?? {};
    const status = (cli) => { const tool = tools[cli]; return tool?.installed === false ? "Not installed" : tool?.installed === true ? (tool.signedIn === true ? "Signed in" : tool.signedIn === false ? "Installed, not signed in" : "Installed, sign-in status unknown") : "Install status unknown"; };
    $("first").innerHTML = `<div class="fcard"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M42.2 46.6A19 19 0 1 1 42.2 17.4" fill="none" stroke="url(#orbitMark)" stroke-width="12" stroke-linecap="round"/><circle cx="50.5" cy="32" r="6.5" fill="#ffc94d"/></svg><h2>Add your first project</h2><p>A project is a folder on your PC. It starts with one Development tab and a fixed crew of 18 positions; you choose which AI model each position uses in Settings.</p><button type="button" class="btn primary" data-first-project>New project</button><div class="card checks">${["claude", "codex", "opencode", "gemini"].map((cli) => `<div class="crow"><span class="logo">${logo(cli, 16, 0)}</span><div class="d"><b>${esc(cliLabel(cli))}</b><small>${esc(status(cli))}</small></div>${tools[cli]?.signedIn === true ? '<span class="tool-connected"><i></i>Ready</span>' : `<button type="button" class="btn sm" data-first-setup>Set up</button>`}</div>`).join("")}</div><p class="faint" style="font-size:12.5px">Claude, Codex or OpenCode can run the leader, and so can any ACP CLI you add in Settings. You only need the ones your crew uses.</p></div>`;
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

  // ---------- creating tabs and projects ----------
  function openAddTab(opener) {
    const project = currentProject(); if (!project) return;
    $("mProj").textContent = project.name; $("tName").value = "";
    $("tStat").textContent = ""; $("tStat").classList.remove("bad"); $("tOnly").checked = true;
    updateFolderDisplay("tab", project.folder);
    openCreationCrew("tab");
    openModal("modal", opener);
  }
  function openProjectDialog(opener) {
    const defaultFolder = serverState?.settings?.folders?.defaultProjectFolder ?? "";
    $("pName").value = ""; $("pOnly").checked = true; updateFolderDisplay("project", defaultFolder);
    $("pFolderHelp").textContent = defaultFolder ? `Starts in your default folder, ${defaultFolder}. Browse to pick another.` : "No default folder is set. Browse to pick one, or set it in Settings, Folders.";
    $("npStat").classList.remove("bad");
    openCreationCrew("project");
    updateProjectSubmit();
    openModal("projModal", opener);
  }
  // Creation is fixed-crew only: the dialogs open on the 18 positions, or say plainly that they are unavailable. There is no kind or template fallback.
  const creationReady = () => Boolean(fixedCrewUi?.creationReady());
  function openCreationCrew(which) {
    if (fixedCrewUi) { fixedCrewUi.openCreation(which); return; }
    const box = $(which === "tab" ? "tCrew" : "pCrew"); box.hidden = false; box.textContent = "The crew positions are not available, so nothing can be created. Close this window and open it again.";
  }
  function creationUnavailable(statusId) { $(statusId).textContent = "Not created: the crew positions are not available."; $(statusId).classList.add("bad"); }
  let selectedTabFolder = "";
  let selectedProjectFolder = "";
  function updateFolderDisplay(which, folder) {
    const path = String(folder ?? "");
    if (which === "tab") { selectedTabFolder = path; $("tDir").textContent = path || "No folder chosen"; $("tDir").title = path || "No folder chosen"; $("tFolderWarn").hidden = Boolean(path); $("createTab").disabled = !path || !creationReady() || Boolean(pendingCreate); }
    else { selectedProjectFolder = path; $("pDir").textContent = path || "No folder chosen"; $("pDir").title = path || "No folder chosen"; $("pFolderWarn").hidden = Boolean(path); updateProjectSubmit(); }
  }
  function updateProjectSubmit() {
    const ready = Boolean(selectedProjectFolder && $("pName").value.trim());
    $("createProj").disabled = !ready || !creationReady() || Boolean(pendingCreate);
    if (!pendingCreate && !$("npStat").classList.contains("bad")) $("npStat").textContent = ready ? "" : !selectedProjectFolder ? "Choose a folder to create it." : "Give it a name to create it.";
  }
  function updateCreateButtons() {
    $("createTab").disabled = !selectedTabFolder || !creationReady() || Boolean(pendingCreate); $("createTab").textContent = pendingCreate?.kind === "tab" ? "Creating…" : "Create tab";
    $("createProj").textContent = pendingCreate?.kind === "project" ? "Creating…" : "Create project"; updateProjectSubmit();
  }
  async function pickFolder(callback) {
    if (!window.cc || typeof window.cc.pickFolder !== "function") { showToast("Open the Command Center app to choose a folder"); return; }
    try { const folder = await window.cc.pickFolder(); if (folder) callback(folder); }
    catch (error) { showToast(error?.message ?? "Could not choose a folder"); }
  }
  function createTab() {
    const project = currentProject(); if (!project || !selectedTabFolder || pendingCreate) return;
    const fixed = fixedCrewUi?.creationFields("tab");
    if (!fixed) { creationUnavailable("tStat"); return; }
    const name = $("tName").value.trim() || "Development";
    if (!send({ type: "addTab", projectId: project.id, name, ...fixed, folder: selectedTabFolder, projectOnly: $("tOnly").checked })) return;
    pendingCreate = { kind: "tab", projectId: project.id, knownTabIds: new Set(project.tabs.map((tab) => tab.id)) };
    $("tStat").textContent = "Creating…"; $("tStat").classList.remove("bad");
    updateCreateButtons();
  }
  function createProject() {
    const name = $("pName").value.trim(); if (!name || !selectedProjectFolder || pendingCreate) return;
    const fixed = fixedCrewUi?.creationFields("project");
    if (!fixed) { creationUnavailable("npStat"); return; }
    const id = `project-${slug(name)}-${Date.now().toString(36)}`;
    if (!send({ type: "addProject", id, name, folder: selectedProjectFolder, tabFolder: selectedProjectFolder, ...fixed, projectOnly: $("pOnly").checked })) return;
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
    const runs = liveRuns(tab, seat), line = seatLine(tab, seat), blocked = !seat.isLeader && seatBlocked(tab, seat);
    const now = seat.isLeader && seat.status === "idle" && !tab.derived?.leaderTurnActive && line.cls !== "waiting" ? (tab.leaderStatus === "ready" ? "Ready for your next message" : "Ready. The session starts with your first message") : !seat.isLeader && (seat.status === "idle" || !seat.status) && !blocked ? `Ready. Starts when ${leaderName(tab)} hands over a brief, or when you press Run` : line.text;
    const alive = seat.isLeader && (tab.leaderStatus === "ready" || tab.derived?.leaderTurnActive || seat.status === "working" || seat.status === "waiting");
    // The Advisor fact is for any seat whose CLI can take one (CliCap.advisor); it shows the seat's saved advisor, and this card has no control to change it.
    const advisorRow = cliCap(seat.cli)?.advisor ? `<div class="rowb"><span>Advisor</span><span class="v" style="color:var(--adv)"><span>✦ ${esc(seat.advisor ? formatModel(seat.cli, seat.advisor) : "Off")}</span></span><span></span></div>` : "";
    pop.dataset.tabId = tab.id; pop.dataset.slot = seat.slot;
    pop.setAttribute("aria-label", `Seat ${seat.name}`);
    pop.innerHTML = `<div class="sc"><div class="top">${seatImg(seat)}<div style="min-width:0;flex:1"><b><span title="${esc(seat.name)}">${esc(seat.name)}</span></b><small title="${esc(seatRole(tab, seat))}">${esc(seatRole(tab, seat))}${seat.isLeader && seatRole(tab, seat).toLowerCase() !== "leader" ? " · leader" : ""}</small></div></div><div class="now ${esc(line.cls)}"><i></i><span>${esc(now)}</span></div>${blocked ? `<div class="blk">${ICONS.warn}<span>Launch blocked after a stop. ${esc(seat.name)} cannot start until you allow it.</span><button type="button" class="btn sm" data-seat-unblock>Allow again</button></div>` : ""}${runs.length ? `<div class="rows">${runs.map((run) => { const state = runStopState(tab, run); return `<div class="sr"><span class="d"></span><button type="button" class="srl" data-watch-run="${esc(run.runId)}" title="Watch ${plainMd(run.label)}">${plainMd(run.label)}</button><span class="tm" data-run-time="${esc(run.runId)}">${esc(spanText(run.startedAt))}</span><button type="button" class="x" data-stop-run="${esc(run.runId)}" aria-label="Stop ${plainMd(run.label)}" title="Stop only this run"${state ? " disabled" : ""}>${state ? esc(stopLabel(state)) : ICONS.stop}</button></div>`; }).join("")}</div>` : ""}<div class="rows"><div class="rowb"><span>Model</span><span class="v">${logo(seat.cli, 13, 0)}<span><span class="model-label">${esc(formatModel(seat.cli, seat.model, tab))}</span>${modelSupportsEffort(seat.cli, seat.model) ? ` <span class="faint eff">· ${esc(seat.effort)}</span>` : ""}</span></span><span></span></div>${advisorRow}${seat.isLeader ? `<div class="rowb"><span>Context</span><span class="v" data-context-meter title="${esc(contextLine(tab))}"><span>${esc(cap(contextLine(tab)))}</span></span><span></span></div>` : `<div class="rowb"><span>Access</span><span class="v" title="${esc(accessText(tab, seat))}"><span>${esc(accessText(tab, seat))}</span></span><span></span></div>`}<div class="rowb"><span>Usage</span><span class="v" title="${esc(seatUsageText(tab, seat))}"><span>${esc(seatUsageText(tab, seat))}</span></span><span></span></div></div>${seat.isLeader ? `<div class="acts"><button type="button" class="btn" data-seat-chat>Chat</button><button type="button" class="btn" data-seat-history>Past sessions</button></div>` : `<div class="acts"><button type="button" class="btn" data-seat-watch>Watch</button></div>`}<div class="acts">${seat.isLeader ? (alive ? `<button type="button" class="btn danger" data-stop-seat title="Stops ${esc(seat.name)}'s session and denies anything it is waiting on. Your next message starts a fresh one.">Stop ${esc(seat.name)}</button>` : "") : `<button type="button" class="btn primary" data-run-seat>${runs.length ? "Run another" : "Run"}</button><button type="button" class="btn danger" data-stop-seat title="${runs.length ? `Stops every run of ${esc(seat.name)} and blocks new launches` : `Blocks ${esc(seat.name)} from launching until you allow it again`}">${runs.length ? "Stop seat" : "Block launches"}</button>`}</div></div>`;
    const anchor = () => pop._anchor;
    pop.querySelector("[data-seat-unblock]")?.addEventListener("click", () => unblockWithConfirm(tab, seat, anchor()));
    pop.querySelectorAll("[data-watch-run]").forEach((button) => button.addEventListener("click", () => { selectedSeatByTab.set(tab.id, seat.slot); selectedRunBySeat.set(seat.slot, button.dataset.watchRun); selectedView = "live"; closePopovers(); renderStage(); renderCrew(); }));
    pop.querySelectorAll("[data-stop-run]").forEach((button) => button.addEventListener("click", () => killRun(button.dataset.stopRun)));
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
  // The model menu lives in public/model-picker.js (loaded before this file) and only the fixed crew opens it. The page reaches it through these
  // names, and it reaches the page through this object; what a test or a later line may replace (confirmAction, openPopover) is looked up per call.
  const { pickerClis, modelRows, openModelPicker, refreshModelPicker } = window.CC_PICKER?.({
    $, esc, logo, cliCaps, cliLabel, isAcpCli, acpShownModel, formatModel, modelOptions, customModelPattern, modelSupportsEffort, effortOptions,
    fixRadios, focusKeyOf, placePopover, setLayer, icons: ICONS, lockTip: LOCK_TIP,
    confirmAction: (...args) => confirmAction(...args), openPopover: (...args) => openPopover(...args),
  }) ?? {};

  // ---------- pictures ----------
  function openMeAvatar(opener) {
    $("avTitle").textContent = "Your picture";
    $("avatarStatus").textContent = "Any PNG, JPEG or WebP picture. It stays on this PC.";
    $("avatarStatus").dataset.status = "";
    const choices = AVATAR_PRESETS.map((file) => ({ key: file, src: `/avatars/${file}.svg`, selected: me.av === `${file}.svg` }));
    $("avgrid").innerHTML = `${choices.map((choice) => `<button type="button" role="radio" aria-checked="${String(choice.selected)}" data-avatar="${esc(choice.key)}" aria-label="${esc(cap(choice.key))}" title="${esc(cap(choice.key))}"><img src="${esc(choice.src)}" alt=""></button>`).join("")}<button type="button" class="up" id="avUpload" aria-label="Upload a picture">Upload</button>`;
    $("avgrid").querySelectorAll("[data-avatar]").forEach((button) => button.addEventListener("click", () => {
      me = { av: `${button.dataset.avatar}.svg` }; saveMe(); $("meImg").dataset.fellBack = ""; $("meImg").src = mePic(); renderStage();
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
