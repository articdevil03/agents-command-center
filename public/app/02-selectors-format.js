// Command Center page script, part 2 of 12: selectors, formatting and the connection. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function selectTabFromUser(tabId) {
    userTabSelectionVersion++;
    return send({ type: "selectTab", tabId });
  }
  // This run's secret for the server. The Electron app hands it over through its preload (window.cc.appKey); a plain browser tab opened
  // from `npm start` carries it as #key=... in the address, which is read once, removed from the address bar and kept for reloads of this tab only.
  let appKeyValue = "", connectTicket = 0;
  async function getAppKey() {
    if (appKeyValue) return appKeyValue;
    try {
      if (window.cc && typeof window.cc.appKey === "function") appKeyValue = String(await window.cc.appKey() ?? "");
      else {
        appKeyValue = /(?:^|[#&])key=([0-9a-fA-F]+)/.exec(location.hash)?.[1] ?? sessionStorage.getItem("cc-app-key") ?? "";
        if (appKeyValue) sessionStorage.setItem("cc-app-key", appKeyValue);
        if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      }
    } catch { /* no key: the server refuses the connection and the Disconnected banner shows */ }
    return appKeyValue;
  }
  // A stale key (the server restarted with a new one) must not be kept for the page's life: forget it so the next attempt re-reads it.
  function forgetAppKey() { appKeyValue = ""; try { sessionStorage.removeItem("cc-app-key"); } catch { /* storage unavailable */ } }
  // Every POST carries the key (a wrong or missing one is a 403 the callers already show as a failed upload).
  async function keyedFetch(url, options) {
    const res = await fetch(url, { ...options, headers: { ...options.headers, "X-App-Key": await getAppKey() } });
    if (res.status === 403) forgetAppKey();
    return res;
  }
  function connect() {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    connState = "connecting"; renderConn();
    const ticket = ++connectTicket;
    getAppKey().then((key) => { if (ticket === connectTicket) openSocket(key); });
  }
  function openSocket(key) {
    const next = new WebSocket(`ws://${location.host}/?key=${encodeURIComponent(key)}`);
    socket = next;
    let everOpened = false;
    next.addEventListener("open", () => {
      everOpened = true;
      connState = "on"; renderConn();
      reconnectDelay = 1000;
      historyRequested.clear(); historyInFlight.clear(); historyRefreshAfterFlight.clear(); historyFailed.clear(); transcriptRequests.clear();
      clientPrefOverrides.clear();
      send({ type: "hello" });
      // A held action whose send was lost with the connection waits for the first state: it is dropped there if the server did apply it, resent if not.
      for (const item of pendingActions.values()) {
        if (item.sent || item.lost) continue;
        if (item.dueAt <= Date.now()) sendHeld(item.id);
        else scheduleHeld(item);
      }
      const tab = currentTab(); const seat = selectedSeat(tab);
      if (selectedView === "history" && tab && seat) requestHistory(tab, seat, true);
    });
    next.addEventListener("message", (event) => {
      try { onMessage(JSON.parse(event.data)); }
      catch (error) { console.error("Invalid Command Center message", error); }
    });
    next.addEventListener("close", () => {
      if (socket !== next) return;
      if (!everOpened) forgetAppKey();
      historyInFlight.clear(); transcriptRequests.clear();
      // What was sent and not answered before the drop may never have arrived: a held action goes back to waiting (see the next state), and
      // a stop request nobody confirmed is forgotten, so neither a tab stays hidden nor a Stop button stays disabled until a reload.
      heldActionInFlight = null;
      for (const item of pendingActions.values()) if (item.sent) { item.sent = false; item.lost = true; item.readyToSend = false; }
      for (const [runId, state] of stopStates) if (state === "requested") stopStates.delete(runId);
      killOrder = [];
      if (stopAllTrack && !stopAllTrack.accepted) stopAllTrack = null;
      for (const answer of approvalAnswers.values()) if (answer.status === "running") { answer.status = "failed"; answer.message = "Disconnected. Reconnect before answering."; }
      renderToolApproval();
      for (const [tabId, requestId] of [...pendingChatByTab]) {
        pendingChatByTab.delete(tabId);
        const request = chatRequestsById.get(requestId);
        if (!request) continue;
        if (request.sent) request.status = "disconnected";
        else chatRequestsById.delete(requestId);
      }
      // A queued message sent and not answered before the drop may or may not have arrived: the chat history after the reconnect decides.
      for (const list of queueByTab.values()) for (const item of list) if (item.state === "sending") { item.state = "unknown"; chatRequestsById.delete(item.requestId); }
      streamingByTab.clear();
      lostActions = pendingActionIds();
      // A Save in flight is neither saved nor failed: the server's revisions settle it after the reconnect.
      for (const tabId of savePending) saveStates.set(tabId, { status: "unknown", message: "The connection dropped while saving. Whether the handover was written is checked when Command Center reconnects", startRevision: findTab(tabId)?.chatRevision ?? null, startSavedRevision: findTab(tabId)?.savedRevision ?? 0, checking: true });
      savePending.clear();
      if (pendingRun) runDialogStatus("The connection dropped before the server answered. Check the seat before starting it again.", true);
      if (pendingCreate) pendingCreate.dropped = true; // the reconnect snapshot decides whether it was created
      if (refreshState?.status === "running") { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); }
      connState = "off"; retryAt = Date.now() + reconnectDelay;
      renderStage(); renderConn(); ensureTicker();
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
    next.addEventListener("error", () => next.close());
  }
  function renderConn() {
    const box = $("conn"); if (!box) return;
    box.hidden = connState === "on";
    box.classList.toggle("off", connState === "off");
    box.innerHTML = connState === "connecting" ? '<span class="spin" aria-hidden="true"></span>Connecting to Command Center…'
      : `<span>Disconnected. Reconnecting in <b id="retryS">${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))} s</b></span><button type="button" data-reconnect>Retry now</button>`;
    box.querySelector("[data-reconnect]")?.addEventListener("click", () => connect());
  }

  function projects() { return serverState?.projects ?? []; }
  function allTabs() { return projects().flatMap((project) => project.tabs.map((tab) => ({ project, tab }))); }
  function findTab(tabId) { return allTabs().find(({ tab }) => tab.id === tabId)?.tab ?? null; }
  function findProject(projectId) { return projects().find((project) => project.id === projectId) ?? null; }
  function hiddenProject(projectId) { return [...pendingActions.values()].some((item) => item.hideProjectId === projectId); }
  function hiddenTab(tabId) { return [...pendingActions.values()].some((item) => item.hideTabId === tabId); }
  function visibleProjects() { return projects().filter((project) => !hiddenProject(project.id)); }
  function activeEntry() {
    const wanted = serverState?.selectedTabId;
    const visible = allTabs().filter(({ project, tab }) => !hiddenProject(project.id) && !hiddenTab(tab.id));
    return visible.find(({ tab }) => tab.id === wanted) ?? visible[0] ?? null;
  }
  function currentTab() { return activeEntry()?.tab ?? null; }
  function currentProject() { return activeEntry()?.project ?? null; }
  function engineSeat(tab, slot) { return tab?.processState?.seats?.find((item) => item.slotId === slot) ?? null; }
  function seatRole(tab, seat) { return seat?.role || (seat?.isLeader ? "Leader" : cliLabel(seat?.cli)); }
  function leader(tab) { return tab?.crew?.find((seat) => seat.isLeader) ?? tab?.crew?.find((seat) => seat.slot === "leader") ?? tab?.crew?.[0] ?? null; }
  function leaderName(tab) { return leader(tab)?.name ?? "the leader"; }
  function seatFor(tab, slot) { return tab?.crew?.find((seat) => seat.slot === slot) ?? null; }
  function selectedSeat(tab) {
    if (!tab) return null;
    const key = selectedSeatByTab.get(tab.id);
    return tab.crew.find((seat) => seat.slot === key) ?? leader(tab);
  }
  function seatKeyOf(tab, seat) { return seat?.seatKey ?? `${tab.id}.${seat?.slot}`; }
  function liveRuns(tab, seat) { return (tab?.runs ?? []).filter((run) => run.seatSlotId === seat?.slot && run.status === "working"); }
  // A crew seat with working runs keeps its model, effort and CLI until they end (the server refuses too); the leader never locks.
  // An unconfirmed stop (launchSafety.uncertain) may still be running, so it locks the seat too; the server counts it the same way.
  function seatLocked(tab, seat) { return Boolean(seat) && !seat.isLeader && (liveRuns(tab, seat).length > 0 || uncertainRows().some((row) => (row.seatKey ?? row.seatId) === seatKeyOf(tab, seat))); }
  const LOCK_TIP = "Model, effort and tool can change when its runs finish.";
  function activeTabBusy(tab) { return Boolean(tab?.derived?.busy || (tab?.runs ?? []).some((run) => run.status === "working")); }
  // The name of the setup (template or saved setup) the tab was last switched to; the crew and steps themselves are the tab's own copy.
  function setupLabel(tab) { return tab?.setupName || "Custom setup"; }
  function kindLabel(id) { return KINDS.find((item) => item.id === id)?.name ?? id; }
  function tabLabel(tabId) { for (const { project, tab } of allTabs()) if (tab.id === tabId) return `${project.name} / ${tab.name}`; return ""; }
  function folderName(value) { return String(value ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? String(value ?? ""); }
  // Which preset a seat wears: its own saved preset, else the default for its slot.
  function avatarKeyFor(seat) {
    const key = String(seat?.pic ?? "").match(/^\/?avatars\/([a-z]+)\.svg$/)?.[1];
    if (key && AVATAR_PRESETS.includes(key)) return key;
    return SLOT_PRESET[seat?.slot] ?? NAME_PRESET[String(seat?.name ?? "").toLowerCase()] ?? "ash";
  }
  // An uploaded seat picture is exactly the route the server hands back from POST /api/avatar, nothing else.
  const UPLOADED_PIC = /^\/api\/avatar\/avatar-[0-9a-f-]{36}\.(?:png|jpg|webp)$/i;
  function seatPic(seat) {
    const value = String(seat?.pic ?? "");
    if (UPLOADED_PIC.test(value)) return value;
    return `/avatars/${avatarKeyFor(seat)}.svg`;
  }
  function picHasCrown(seat) { return !UPLOADED_PIC.test(String(seat?.pic ?? "")) && CROWNED_PRESETS.has(avatarKeyFor(seat)); }
  // An uploaded picture is a data URL of up to 512 KB: copied into every user message it would be rebuilt with each state message. It is
  // turned into one short blob URL instead, kept for as long as the picture is the same. No escaping here: img() and .src take it as is.
  let mePicCache = { av: "", url: "" };
  function mePic() {
    if (!/^data:image\//.test(me.av)) return `/avatars/${me.av}`;
    if (mePicCache.av !== me.av) {
      try {
        const bytes = Uint8Array.from(atob(me.av.slice(me.av.indexOf(",") + 1)), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: me.av.slice(5, me.av.indexOf(";")) }));
        if (mePicCache.url) URL.revokeObjectURL(mePicCache.url);
        mePicCache = { av: me.av, url };
      } catch { return me.av; }
    }
    return mePicCache.url;
  }
  // A picture that fails to load falls back exactly once: the fallback never retries itself.
  function img(src, fallback, attrs = "") { return `<img src="${esc(src)}" data-fallback="${esc(fallback)}" alt=""${attrs}>`; }
  function seatImg(seat, attrs = "") { return img(seatPic(seat), `/avatars/${SLOT_PRESET[seat?.slot] ?? "ash"}.svg`, attrs); }
  function logo(cli, size = 12, pad = 3) {
    const brand = MODEL_BRAND[cli];
    const path = window.CC_LOGOS?.[brand?.[0]];
    if (!brand || !path) return `<span class="lg" aria-hidden="true" style="width:${size + pad * 2}px;height:${size + pad * 2}px">${esc((isAcpCli(cli) ? cliLabel(cli) : cli)?.[0]?.toUpperCase() ?? "?")}</span>`;
    return `<span class="lg" aria-hidden="true" style="width:${size + pad * 2}px;height:${size + pad * 2}px"><svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${brand[1]}" d="${esc(path)}"/></svg></span>`;
  }
  function formatModel(cli, model, tab = null) {
    if (isAcpCli(cli)) return acpShownModel(cli, tab) ?? "CLI default";
    const info = cli === "claude" ? serverState?.claudeModels?.find((item) => (typeof item === "string" ? item : item.value) === model) : null;
    if (MODEL_LABEL[model]) return MODEL_LABEL[model];
    const discovered = typeof info === "object" && info?.displayName ? info.displayName.replace(/\s*\([^)]*context[^)]*\)\s*$/i, "") : "";
    // The two 1M seats of the house crew keep their short names; every other id is named from its parts, so no two ids read alike.
    const seatNames = { "claude-opus-5-5[1m]": "Opus 5.5", "claude-sonnet-5-5[1m]": "Sonnet 5.5" };
    const family = /^claude-(opus|sonnet|haiku|fable)((?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/.exec(model ?? "");
    const parsed = family ? `${titleCase(family[1])}${family[2] ? ` ${family[2].slice(1).replaceAll("-", ".")}` : ""}${family[3] ? " · 1M context" : ""}` : "";
    return seatNames[model] ?? (parsed || discovered || cleanModelId(model) || cli || "Unknown model");
  }
  // An id nothing above can name: no provider prefix, no brackets or dashes, a 1M flag spelled out. Never blank for a real id.
  function cleanModelId(model) {
    const id = String(model ?? "").trim();
    const words = id.split("/").at(-1).replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "").split(/[-_\s]+/).filter(Boolean);
    return words.length ? `${words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ")}${/\[1m\]$/i.test(id) ? " · 1M context" : ""}` : "";
  }
  // A CLI added in Settings by its start command (Agent Client Protocol) is "acp:<id>"; it can sit on any seat, in Full access only.
  const isAcpCli = (cli) => typeof cli === "string" && cli.startsWith("acp:");
  const acpCli = (cli) => (serverState?.acpClis ?? []).find((item) => item.kind === cli) ?? null;
  // The one CLI list is the server's (state.clis, a CliCap per CLI): its label, models, efforts, advisor and read-only facts.
  const cliCaps = () => Array.isArray(serverState?.clis) ? serverState.clis : [];
  const cliCap = (cli) => cliCaps().find((item) => item.id === cli) ?? null;
  function cliLabel(cli) { return cliCap(cli)?.label ?? (isAcpCli(cli) ? acpCli(cli)?.name ?? titleCase(cli.slice(4)) : CLI_LABEL[cli] ?? titleCase(cli || "Unknown CLI")); }
  // The shape an unlisted model id must have for this CLI (a RegExp source from the server), or null when none is accepted.
  function customModelPattern(cli) { const source = cliCap(cli)?.customModel; if (!source) return null; try { return new RegExp(source); } catch { return null; } }
  // The model an ACP CLI shows: the one reported by THIS tab's leader (null until its session has started), else the one that CLI reported last time it ran anywhere (config lastModel).
  const acpShownModel = (cli, tab) => tab?.acpLeader?.model ?? acpCli(cli)?.lastModel ?? null;
  function pref(key, fallback = false) {
    if (clientPrefOverrides.has(key)) return clientPrefOverrides.get(key);
    return serverState?.clientPrefs?.[key] ?? fallback;
  }
  function formatUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const pieces = [];
    const context = usage.contextTokens;
    const window = usage.contextWindow;
    if (context !== null && context !== undefined && Number.isFinite(Number(context))) {
      const value = Number(context).toLocaleString();
      pieces.push(window !== null && window !== undefined && Number(window) > 0 ? `${value} / ${Number(window).toLocaleString()} ctx` : `${value} ctx`);
    }
    const tokens = usage.totalTokens ?? usage.total_tokens ?? ((Number(usage.inputTokens ?? usage.input_tokens) || 0) + (Number(usage.outputTokens ?? usage.output_tokens) || 0));
    if (Number.isFinite(Number(tokens)) && Number(tokens) > 0) pieces.push(`${Number(tokens).toLocaleString()} tokens`);
    if (usage.costUsd !== null && usage.costUsd !== undefined && Number.isFinite(Number(usage.costUsd)) && Number(usage.costUsd) >= 0) pieces.push(`$${Number(usage.costUsd).toFixed(4)}`);
    if (Number.isFinite(Number(usage.turns)) && Number(usage.turns) > 0) pieces.push(`${Number(usage.turns)} ${Number(usage.turns) === 1 ? "turn" : "turns"}`);
    return pieces.length ? pieces.join(" · ") : null;
  }
  function usageTokens(usage) {
    if (!usage || typeof usage !== "object") return null;
    const total = usage.totalTokens ?? usage.total_tokens;
    if (Number.isFinite(Number(total)) && total !== null && total !== undefined) return Number(total);
    const input = usage.inputTokens ?? usage.input_tokens, output = usage.outputTokens ?? usage.output_tokens;
    if (input === undefined && output === undefined) return Number.isFinite(Number(usage.contextTokens)) && usage.contextTokens !== null && usage.contextTokens !== undefined ? Number(usage.contextTokens) : null;
    return (Number(input) || 0) + (Number(output) || 0);
  }
  const fmtK = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  function titleCase(value) { return String(value ?? "").replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase()); }
  const cap = (value) => value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
  const joinNames = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function agoText(ms) {
    const seconds = Math.max(0, Date.now() - Number(ms)) / 1000;
    return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
  }
  function spanText(start, end) {
    const total = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }
  // The server's list for the CLI (its CliCap.models) first; a null list means the models are discovered live (claudeModels, opencodeModels).
  function modelOptions(cli) {
    if (isAcpCli(cli)) return ["default"];
    const listed = cliCap(cli)?.models;
    if (Array.isArray(listed)) return [...new Set(listed.filter((item) => typeof item === "string"))];
    let values = serverState?.modelOptions?.[cli];
    if (Array.isArray(values)) return [...new Set(values.filter((item) => typeof item === "string"))];
    if (cli === "claude" && Array.isArray(serverState?.claudeModels)) return serverState.claudeModels.map((item) => typeof item === "string" ? item : item.value).filter(Boolean);
    if (cli === "opencode" && Array.isArray(serverState?.opencodeModels)) return [...new Set(serverState.opencodeModels.filter((item) => typeof item === "string"))];
    return [];
  }
  function effortOptions(cli) { return cliCap(cli)?.efforts ?? (Array.isArray(serverState?.effortOptions?.[cli]) ? serverState.effortOptions[cli] : []); }
  // No effort setting when the CLI lists no efforts or is an ACP one; a Claude model can opt out on its own (claudeModels says which).
  function modelSupportsEffort(cli, model) {
    if (isAcpCli(cli)) return false;
    const cap = cliCap(cli);
    if (cap && !cap.efforts.length) return false;
    if (cli !== "claude") return true;
    const info = serverState?.claudeModels?.find((item) => typeof item === "object" && item.value === model);
    return info?.supportsEffort !== false;
  }
  function modelLine(cli, model, effort, tab = null) { return `${formatModel(cli, model, tab)}${modelSupportsEffort(cli, model) && effort ? ` · ${effort}` : ""}`; }
  function recordActivity(text, type = "", tabId = null) {
    activity.unshift({ id: `${Date.now()}-${Math.random()}`, text, type, tabId, at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    activity = activity.slice(0, 80);
  }
  // The server keeps every launch notice until it is acknowledged, and each launch also arrives as its own leaderLaunch message: the Activity
  // feed shows a notice once, when its id is first seen (however many notices pile up or fall off the feed's 80), and updates that line in
  // place if the outcome later gets confirmed.
  // Who launched a run: the leader or a seat that runs the process (the planner); null is the user's own Run, which needs no line.
  function launchedByText(launchedBy) { return launchedBy?.name ? ` · launched by ${launchedBy.name}` : ""; }
  function noticeText(notice) { return `${notice.source ?? "Command Center"} requested ${notice.seatName ?? notice.seatId}${notice.headsUp ? ` · heads up: ${notice.headsUp}` : ""}${notice.pending ? " · outcome unconfirmed" : ""}`; }
  function noteNotice(notice) {
    if (!notice?.id) return;
    const text = noticeText(notice), known = seenNotices.get(notice.id);
    if (known === text) return;
    seenNotices.set(notice.id, text);
    if (known === undefined) {
      recordActivity(text, notice.pending ? "waiting" : "working", tabIdOfKey(notice.seatKey ?? notice.seatId));
      activity[0].noticeId = notice.id;
    } else {
      const entry = activity.find((item) => item.noticeId === notice.id);
      if (entry) { entry.text = text; entry.type = notice.pending ? "waiting" : "working"; }
    }
  }
  function addStateNotices(state) {
    const notices = state?.launchSafety?.notices ?? [];
    for (const notice of notices) noteNotice(notice);
    const ids = new Set(notices.map((notice) => notice.id));
    for (const id of seenNotices.keys()) if (!ids.has(id)) seenNotices.delete(id);
  }
  function tabIdOfKey(key) { const value = String(key ?? ""); const dot = value.lastIndexOf("."); return dot > 0 ? value.slice(0, dot) : null; }
  // A tab-scoped seat key names its tab and slot; an old bare seat ID belongs to no tab.
  function seatOfKey(key) {
    const value = String(key ?? ""); const dot = value.lastIndexOf(".");
    if (dot > 0) { const tab = findTab(value.slice(0, dot)); return { tab, seat: seatFor(tab, value.slice(dot + 1)), slot: value.slice(dot + 1), key: value, legacy: false }; }
    return { tab: null, seat: null, slot: value, key: value, legacy: true };
  }
  function seatNameOfKey(key) { return seatOfKey(key).seat?.name ?? String(key ?? "A seat"); }
  // The events worth a signal. The desktop notice follows Notifications; the chime follows the sound button, on its own.
  function notableEvent(kind) {
    if (["routine", "internal-stop"].includes(kind)) return false;
    if (kind === "leader-turn") return !document.hasFocus();
    return ["worker-finish", "worker-fail", "worker-stall", "needs-user"].includes(kind);
  }
  // The bell's volume, a whole percent the server keeps and validates (server/config.ts isBellVolume): 100 is the full bell.
  function bellVolume() { return pref("bellVolume", 100); }
  // One audio context for the whole session: a fresh one per beep spends the whole short tone starting up, so nothing is heard.
  let bellAudioCtx = null;
  // Every bell follows the sound switch and the saved volume. Test passes the slider's own level instead, and plays even while the sound is off.
  function playCompletionSound(testVolume = null) {
    if (testVolume === null && !pref("bellEnabled", false)) return;
    const level = (testVolume ?? bellVolume()) / 100;
    if (!(level > 0)) return; // 0% plays nothing at all
    try {
      const Audio = window.AudioContext ?? window.webkitAudioContext;
      if (!Audio) return;
      const context = bellAudioCtx ??= new Audio();
      // A struck bell, twice: a 2 kHz strike, then a lower 1.78 kHz strike 0.45 s later (ding-dong). Inharmonic partials (ratio, level, ring seconds) reach 5.5 kHz, where the ear is most sensitive.
      // Partial levels are divided by their sum and scaled by a gain measured offline (browser test) so the rendered peak sits just under full scale at 100%; the volume scales that gain, and the limiter is only a catch near 0 dBFS, not a squash.
      // The first strike is damped over its last 50 ms so the second one has a fresh, sharp attack.
      const tone = () => {
        const now = context.currentTime;
        const partials = [[1, 1, 1.2], [1.51, 0.5, 1], [2, 0.4, 0.85], [2.76, 0.3, 0.6]];
        const total = partials.reduce((sum, [, level]) => sum + level, 0);
        const master = context.createGain(); master.gain.value = 1.2 / total * level;
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
        master.connect(limiter); limiter.connect(context.destination);
        for (const [strike, pitch] of [[0, 2000], [0.45, 1780]]) {
          for (const [ratio, level, ring] of partials) {
            const at = now + strike; const oscillator = context.createOscillator(); const gain = context.createGain();
            const end = strike === 0 ? 0.45 : ring;
            oscillator.type = "sine"; oscillator.frequency.value = pitch * ratio;
            gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(level, at + 0.004);
            gain.gain.exponentialRampToValueAtTime(level * 0.75, at + 0.4); gain.gain.exponentialRampToValueAtTime(0.0001, at + end);
            oscillator.connect(gain); gain.connect(master); oscillator.start(at); oscillator.stop(at + end);
          }
        }
      };
      if (context.state === "suspended") context.resume().then(tone).catch(() => {}); else tone();
    } catch { /* audio can be unavailable until the browser grants playback */ }
  }
  function notify(kind, title, body) {
    if (!notableEvent(kind)) return false;
    try {
      if (pref("notificationsEnabled", true) && "Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    } catch { /* desktop notifications are optional */ }
    playCompletionSound();
    return true;
  }
  // `previous` is the state before this one: the first state after a page load has none, and what is already waiting then is not new.
  function newApprovalRequests(previous, next) {
    if (!previous) return;
    const oldTabs = new Map((previous.projects ?? []).flatMap((project) => project.tabs).map((tab) => [tab.id, tab]));
    for (const tab of (next?.projects ?? []).flatMap((project) => project.tabs)) {
      const oldIds = new Set((oldTabs.get(tab.id)?.pendingApprovals ?? []).map((item) => item.approvalId));
      for (const item of tab.pendingApprovals ?? []) if (!oldIds.has(item.approvalId)) notify("needs-user", `${item.askedBy?.name ?? leaderName(tab)} needs your answer`,`${tab.name}: ${String(item.summary).split("\n")[0].slice(0, 200)}`);
      if (tab.processState?.approval?.state === "pending" && oldTabs.get(tab.id)?.processState?.approval?.state !== "pending") {
        notify("needs-user", "Your look is needed", `${tab.name} is waiting for your approval.`);
      }
    }
  }
  function chatInfo(tabId, message) {
    const old = chatMeta.get(tabId) ?? {};
    const next = { ...old };
    if (Number.isSafeInteger(message.revision)) next.revision = message.revision;
    if (Number.isSafeInteger(message.savedRevision)) next.savedRevision = message.savedRevision;
    if (Number.isFinite(message.at)) next.lastAt = message.at;
    if (Array.isArray(message.messages)) {
      const latest = message.messages.at(-1);
      if (Number.isFinite(latest?.at)) next.lastAt = latest.at;
    }
    chatMeta.set(tabId, next);
  }
