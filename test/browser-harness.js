(() => {
  const audit = { mode: "", viewport: 0, checks: [], errors: window.__ccErrors ?? [], matched: {} };
  const auditNode = document.getElementById("AUDIT");
  auditNode.hidden = true;
  const originalError = console.error.bind(console);
  window.__ccErrors = audit.errors;
  console.error = (...args) => { audit.errors.push(`console.error: ${args.map((value) => value instanceof Error ? value.stack ?? String(value) : String(value)).join(" ")}`); originalError(...args); };
  window.addEventListener("error", (event) => {
    const message = event.message || event.target?.src || event.target?.href || "browser error";
    audit.errors.push(String(message));
  });
  window.addEventListener("unhandledrejection", (event) => audit.errors.push(String(event.reason?.message ?? event.reason ?? "unhandled rejection")));

  const query = new URLSearchParams(location.search);
  audit.mode = query.get("mode") || "real";
  audit.viewport = innerWidth;
  const collectFailures = query.get("collect") === "1";
  const collectWaitTimeout = collectFailures ? 750 : 5000;
  const fail = (message) => { throw new Error(message); };
  const check = (name, condition, evidence) => {
    if (!condition) {
      if (!collectFailures) fail(`${name}: expected true; matched ${JSON.stringify(evidence)}`);
      (audit.failures ??= []).push({ name, matched: evidence ?? true });
      audit.checks.push({ name, passed: false, matched: evidence ?? true });
    } else audit.checks.push({ name, passed: true, matched: evidence ?? true });
    const report = document.getElementById("AUDIT");
    if (report) report.textContent = JSON.stringify(audit);
  };
  // The app waits its reconnect backoff before it reconnects; run that one timer at once so a drop costs no idle wait.
  const dropSocket = (socket) => {
    const nativeSetTimeout = window.setTimeout; let patched = false;
    window.setTimeout = (callback, delay, ...args) => { if (!patched && delay >= 1000) { patched = true; delay = 0; } return nativeSetTimeout(callback, delay, ...args); };
    try { socket.emit("close", {}); } finally { window.setTimeout = nativeSetTimeout; }
  };
  const waitFor = async (condition, label, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (condition()) return;
      await fetch("/__browser-barrier", { cache: "no-store" });
    }
    fail(`timeout waiting for ${label}`);
  };
  // Any state broadcast counts unless `settled` names the state this action must reach: an unrelated broadcast can arrive first under load.
  const waitForServerReply = (start, label, settled) => waitFor(
    () => window.__received.slice(start).some((message) => message.type === "error" || (message.type === "state" && (!settled || settled()))),
    label
  );
  const text = (selector, root = document) => root.querySelector(selector)?.textContent?.trim() ?? "";
  const $ = (id) => document.getElementById(id);
  const requireElement = (selector, root = document) => {
    const element = root.querySelector(selector);
    if (!element) fail(`target missing: ${selector}`);
    return element;
  };
  const toastVisible = (element = $("toast")) => Boolean(element && !element.hidden && !element.inert && element.getAttribute("aria-hidden") === "false" && element.classList.contains("on") && getComputedStyle(element).opacity === "1");
  const waitToastVisible = async (element = $("toast")) => {
    await waitFor(() => toastVisible(element), `visible toast ${element?.id ?? "unknown"}`);
    return true;
  };
  const installTenSecondClock = (maxDelay = 20000) => {
    const nativeSetTimeout = window.setTimeout.bind(window), nativeClearTimeout = window.clearTimeout.bind(window);
    // Real timer ids are positive integers, so a fake one is a negative number: clearing a real timer can never remove a fake one, and a fake id the page still holds after restore() is dropped here, never handed to the real clearTimeout.
    const timers = new Map(); let now = 0; let nextId = -1;
    const clearReal = (id) => { if (typeof id === "number" && id < 0) return; nativeClearTimeout(id); };
    window.setTimeout = (callback, delay, ...args) => {
      if (Number(delay) < 3000 || Number(delay) > maxDelay) return nativeSetTimeout(callback, delay, ...args);
      const id = nextId--; timers.set(id, { due: now + Number(delay), callback, args }); return id;
    };
    window.clearTimeout = (id) => { if (timers.delete(id)) return; clearReal(id); };
    return {
      async advance(ms) {
        now += ms;
        while (true) {
          const next = [...timers.entries()].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
          if (!next) return;
          timers.delete(next[0]); next[1].callback(...next[1].args); await Promise.resolve();
        }
      },
      snapshot() { return { now, pending: [...timers.values()].map((timer) => ({ due: timer.due, callback: String(timer.callback).slice(0, 140) })) }; },
      restore() { window.setTimeout = nativeSetTimeout; window.clearTimeout = clearReal; },
    };
  };
  const latestTab = (tabId, state = window.__latestState) => state?.projects?.flatMap((project) => project.tabs).find((tab) => tab.id === tabId);
  // The leader's name as the page shows it (these fixtures name the leader with markup on purpose, to prove it is shown as text).
  const leaderNameOf = (tabId, state = window.__latestState) => latestTab(tabId, state)?.crew?.find((seat) => seat.isLeader || seat.slot === "leader")?.name ?? "the leader";
  const clickTab = async (name) => {
    const tab = [...document.querySelectorAll("#tabs [role=tab]")].find((node) => text(".tl", node) === name);
    if (!tab) fail(`tab target missing: ${name}; matched ${JSON.stringify([...document.querySelectorAll("#tabs [role=tab] .tl")].map((node) => node.textContent))}`);
    tab.click();
    await waitFor(() => window.__latestState?.projects?.flatMap((project) => project.tabs).some((item) => item.id === window.__latestState.selectedTabId), "selected tab state");
    return tab;
  };
  const openTabMenu = (tabId) => {
    const more = requireElement(`#tabs .tmore[data-more-for="${CSS.escape(tabId)}"]`);
    more.click();
    return requireElement("#ctxPop");
  };
  const clickMenuItem = (menu, label) => {
    const button = [...menu.querySelectorAll("button.opt")].find((item) => item.textContent.includes(label));
    if (!button) fail(`menu item missing: ${label}; matched ${JSON.stringify([...menu.querySelectorAll("button.opt")].map((item) => item.textContent.trim()))}`);
    button.click();
  };
  // Any seat's picture opens its card; its name opens the work view (the leader's chat).
  const showChat = () => { const back = document.querySelector("#view [data-back-chat], #view [data-chat-live]"); if (back) back.click(); };
  const openSeatView = (slot) => { requireElement(`#crew [data-seat-id="${CSS.escape(slot)}"] [data-seat-open]`).click(); return requireElement("#stagehead"); };
  const openSeatCard = (slot) => {
    if (slot === "leader") { showChat(); if ($("seatPop").hidden || $("seatPop").dataset.slot !== slot) requireElement('#crew [data-seat-id="leader"] [data-seat-pic]').click(); }
    else { openSeatView(slot); if ($("seatPop").hidden || $("seatPop").dataset.slot !== slot) requireElement("#view [data-seat-more]").click(); }
    return requireElement('#seatPop[aria-hidden="false"]');
  };
  const openProjectMenu = (projectId) => { requireElement(`#ptabs [data-project-menu="${CSS.escape(projectId)}"]`).click(); return requireElement("#ctxPop"); };
  const pickProject = (projectId) => requireElement(`#ptabs [data-project-id="${CSS.escape(projectId)}"]`).click();
  const openInbox = () => { if ($("inboxPop").hidden) $("inboxBtn").click(); return requireElement('#inboxPop[aria-hidden="false"]'); };
  const openRequests = () => { const pop = openInbox(); if ($("reqForm").hidden) $("reqNew").click(); return pop; };
  const openChatMenu = () => { showChat(); if ($("ctxPop").hidden) $("chatMore").click(); return requireElement('#ctxPop[aria-hidden="false"]'); };
  const pressEscape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  // Confirmations are the app's own dialog now: answer it the way window.confirm used to be answered, and record what it asked.
  const confirmIfAsked = () => {
    if ($("confirmModal").hidden) return false;
    window.__ccConfirms.push(`${text("#confirmTitle")} ${text("#confirmBody")}`);
    if (window.__ccConfirmResult === false) $("confirmCancel").click();
    else { const phrase = $("confirmPhrase").dataset.phrase; if (phrase) $("confirmPhrase").value = phrase; $("confirmOk").click(); }
    return true;
  };
  const runReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "server state");
    const targets = ["#ptabs", "#ptabs .ptab", "#tabs", "#tabs [role=tab]", "#crew", "#crew .seat", "#statusBtn", "#pipe", "#pipe .step", "#sline", "#view", "#composer", "#rail", "#stage", "#side", "#feed", "#usage", "#lowerBody"];
    const missing = targets.filter((selector) => !document.querySelector(selector));
    const packC = ["#inboxBtn", "#inboxPop", "#permBtn", "#permPop", '[data-l="changes"]', '[data-l="notes"]'];
    const missingPackC = packC.filter((selector) => !document.querySelector(selector));
    check("Pack C shell controls render", missingPackC.length === 0, { found: packC.filter((selector) => document.querySelector(selector)), missing: missingPackC });
    const state = window.__latestState;
    const entry = state.projects.flatMap((project) => project.tabs.map((tab) => ({ project, tab }))).find(({ tab }) => tab.id === state.selectedTabId);
    const countsMatch = Boolean(entry && document.querySelectorAll("#crew .seat").length === entry.tab.crew.length && document.querySelectorAll("#pipe .step").length === entry.tab.derived.stepBar.length);
    check("server state renders every shell target, project, tab, crew and step", missing.length === 0 && countsMatch, {
      found: targets.filter((selector) => document.querySelector(selector)), missing, projects: state.projects.map((project) => project.name), tabs: entry?.project.tabs.map((tab) => tab.name), crew: document.querySelectorAll("#crew .seat").length, expectedCrew: entry?.tab.crew.length, steps: [...document.querySelectorAll("#pipe .step")].map((node) => node.textContent.trim()), expectedSteps: entry?.tab.derived.stepBar.length,
    });
    const otherTab = entry.project.tabs.find((tab) => tab.id !== entry.tab.id);
    if (otherTab) {
      const start = window.__received.length;
      const element = requireElement(`#tabs [data-tab-id="${CSS.escape(otherTab.id)}"]`); element.click();
      await waitForServerReply(start, "server tab switch response");
      await waitFor(() => window.__latestState?.selectedTabId === otherTab.id, "the server's state selects the other tab"); // any state ends the line above, and an unrelated broadcast can come first
      check("tab switch reaches the server", window.__latestState.selectedTabId === otherTab.id, { requested: otherTab.id, selectedTabId: window.__latestState.selectedTabId, sent: window.__sent.filter((item) => item.type === "selectTab").at(-1) });
    } else check("tab switch reaches the server", false, { projects: state.projects.map((project) => project.tabs.length) });

    await clickTab("Development");
    $("addtab").click();
    const modal = requireElement("#modal[aria-hidden=false]");
    const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter((item) => !item.hidden);
    const firstFocus = focusable[0]; const lastFocus = focusable.at(-1);
    if (!firstFocus || !lastFocus) fail(`modal focus targets missing; matched ${focusable.length}`);
    lastFocus.focus(); lastFocus.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    check("modal traps Tab focus at its final control", document.activeElement === firstFocus, { first: firstFocus.id, last: lastFocus.id, active: document.activeElement?.id });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("Escape closes the add-tab dialog and restores focus", $("modal").hidden && document.activeElement === $("addtab"), { hidden: $("modal").hidden, active: document.activeElement?.id });
    $("addtab").click();
    requireElement("#modal[aria-hidden=false]");
    $("tName").value = "Audit Tab Undo";
    requireElement('#kindBox [data-kind="mkt"]').click();
    requireElement('#tplBox [data-process="duo"]').click();
    $("browse").click();
    await waitFor(() => document.querySelector("#tDir")?.textContent.includes(new URLSearchParams(location.search).get("folder")), "folder picker result");
    const addTabStart = window.__received.length;
    $("createTab").click();
    await waitForServerReply(addTabStart, "add-tab server response");
    let added = window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.name === "Audit Tab Undo");
    check("add-tab dialog creates the selected kind and process on the server", Boolean(added && added.kind === "mkt" && added.process === "duo" && added.folder === new URLSearchParams(location.search).get("folder")), { found: Boolean(added), id: added?.id ?? "missing", kind: added?.kind ?? "missing", process: added?.process ?? "missing", folder: added?.folder ?? "missing", request: window.__sent.slice(addTabStart).at(-1), response: window.__received.slice(addTabStart).at(-1) });
    $("addProj").click();
    requireElement("#projModal[aria-hidden=false]");
    $("pName").value = "Audit Project B1";
    $("pName").dispatchEvent(new Event("input", { bubbles: true }));
    const projectKindDefault = requireElement('#pKind [aria-checked="true"]').dataset.kind;
    requireElement('#pKind [data-kind="design"]').click();
    requireElement('#pTpl [data-process="solo"]').click();
    $("pBrowse").click();
    await waitFor(() => document.querySelector("#pDir")?.textContent.includes(new URLSearchParams(location.search).get("folder")), "project folder picker result");
    const addProjectStart = window.__received.length;
    $("createProj").click();
    await waitForServerReply(addProjectStart, "new-project server response");
    const addedProject = window.__latestState.projects.find((project) => project.name === "Audit Project B1");
    const projectDialogClosed = $("projModal").hidden;
    check("new-project dialog creates the selected kind and process on the server", Boolean(projectKindDefault === "dev" && addedProject && addedProject.tabs[0].kind === "design" && addedProject.tabs[0].process === "solo" && addedProject.folder === new URLSearchParams(location.search).get("folder") && projectDialogClosed && window.__sent.some((message) => message.type === "addProject" && message.kind === "design" && message.process === "solo")), { found: Boolean(addedProject), id: addedProject?.id ?? "missing", folder: addedProject?.folder ?? "missing", tab: addedProject?.tabs[0] ?? "missing", projectDialogClosed, request: window.__sent.slice(addProjectStart).at(-1), response: window.__received.slice(addProjectStart).at(-1) });
    pickProject("alpha");
    await waitFor(() => window.__latestState?.projects?.find((project) => project.id === "alpha")?.tabs.some((tab) => tab.id === window.__latestState.selectedTabId), "return to Alpha after project creation");
    openTabMenu(added.id); clickMenuItem($("ctxPop"), "Remove tab");
    const firstUndoVisible = await waitToastVisible($("undo"));
    check("held remove offers Undo before sending", firstUndoVisible && Boolean($("undo").querySelector("[data-undo-held]") && latestTab(added.id)), { undoVisible: Boolean($("undo").querySelector("[data-undo-held]")), firstUndoVisible });
    $("undo").querySelector("[data-undo-held]").click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const undoTabVisible = Boolean(document.querySelector(`#tabs [data-tab-id="${CSS.escape(added.id)}"]`));
    const undoToastClosed = $("undo").hidden && $("undo").inert && $("undo").getAttribute("aria-hidden") === "true" && !$("undo").classList.contains("on");
    check("Undo cancels a held remove", undoTabVisible && undoToastClosed && !window.__sent.some((message) => message.type === "removeTab" && message.tabId === added.id), { tabVisible: undoTabVisible, undoToastClosed, removeSent: window.__sent.some((message) => message.type === "removeTab" && message.tabId === added.id) });

    const removeTarget = latestTab("alpha-design");
    if (removeTarget) {
      const project = window.__latestState.projects.find((item) => item.tabs.some((tab) => tab.id === removeTarget.id));
      const tabNode = requireElement(`#tabs [data-tab-id="${CSS.escape(removeTarget.id)}"]`); tabNode.click();
      await waitFor(() => window.__latestState.selectedTabId === removeTarget.id, "select remove target");
      const holdClock = installTenSecondClock();
      openTabMenu(removeTarget.id); clickMenuItem($("ctxPop"), "Remove tab");
      await waitFor(() => !document.querySelector(`#tabs [data-tab-id="${CSS.escape(removeTarget.id)}"]`), "optimistic remove view");
      const undoShown = await waitToastVisible($("undo")) && Boolean($("undo").querySelector("[data-undo-held]"));
      await holdClock.advance(9_999);
      const notSentBeforeWindow = !window.__sent.some((message) => message.type === "removeTab" && message.tabId === removeTarget.id);
      const undoStillAvailable = Boolean($("undo").querySelector("[data-undo-held]") && toastVisible($("undo")));
      await holdClock.advance(1);
      holdClock.restore();
      const removeSent = window.__sent.some((message) => message.type === "removeTab" && message.tabId === removeTarget.id);
      check("held remove sends after the Undo window", undoShown && notSentBeforeWindow && undoStillAvailable && removeSent, { project: project?.id, removedTabId: removeTarget.id, undoShown, notSentBeforeWindow, undoStillAvailable, removeSent, sent: window.__sent.filter((message) => message.type === "removeTab").map((message) => message.tabId) });
      await waitFor(() => !latestTab(removeTarget.id), "server removal after Undo window");
    } else check("held remove sends after the Undo window", false, { tabs: window.__latestState.projects.flatMap((project) => project.tabs).map((tab) => tab.id) });

    const dev = latestTab("alpha-dev");
    if (dev) {
      const devNode = requireElement('#tabs [data-tab-id="alpha-dev"]'); devNode.click();
      await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "return to Development");
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      const current = latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").model;
       const nextModel = [...document.querySelectorAll("#pop [data-model]")].map((button) => button.dataset.model).find((model) => model !== current);
      if (!nextModel) fail(`no alternate server model rendered; matched ${JSON.stringify([...document.querySelectorAll("#pop [data-model]")].map((button) => button.dataset.model))}`);
       const modelStart = window.__received.length;
       requireElement(`#pop [data-model="${CSS.escape(nextModel)}"]`).click();
       check("picking a model shows no 'will use' toast before the server confirms", !/will use/.test($("toast")?.textContent ?? "") && !/will use/.test($("undo")?.textContent ?? ""), { toast: $("toast")?.textContent });
       await waitForServerReply(modelStart, "server seat model response", () => latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").model === nextModel);
       check("seat model change reaches the server", latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").model === nextModel, { slot: "coder", model: latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").model, expected: nextModel, sent: window.__sent.filter((message) => message.type === "updateSeat").at(-1), response: window.__received.slice(modelStart).at(-1) });
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      const currentEffort = latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").effort;
      const nextEffort = [...document.querySelectorAll("#pop [data-effort]")].map((button) => button.dataset.effort).find((effort) => effort !== currentEffort);
      if (!nextEffort) fail(`no alternate server effort rendered; matched ${JSON.stringify([...document.querySelectorAll("#pop [data-effort]")].map((button) => button.dataset.effort))}`);
       const effortStart = window.__received.length;
       requireElement(`#pop [data-effort="${CSS.escape(nextEffort)}"]`).click();
       await waitForServerReply(effortStart, "server seat effort response", () => latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").effort === nextEffort);
       check("seat effort change reaches the server", latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").effort === nextEffort, { slot: "coder", effort: latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").effort, expected: nextEffort, sent: window.__sent.filter((message) => message.type === "updateSeat").at(-1), response: window.__received.slice(effortStart).at(-1) });
      // A seat's picture opens its card for every seat; its name opens the work view (the leader's chat).
      showChat(); pressEscape();
      const seatOf = (slot) => latestTab("alpha-dev").crew.find((seat) => seat.slot === slot);
      const pic = (slot) => requireElement(`#crew [data-seat-id="${CSS.escape(slot)}"] [data-seat-pic]`);
      const nameOf = (slot) => requireElement(`#crew [data-seat-id="${CSS.escape(slot)}"] [data-seat-open]`);
      const viewing = (slot) => nameOf(slot).hasAttribute("aria-current");
      pic("coder").click();
      check("a worker's picture opens its seat card without leaving the chat", !$("seatPop").hidden && $("seatPop").dataset.slot === "coder" && !viewing("coder") && pic("coder").getAttribute("aria-expanded") === "true", { hidden: $("seatPop").hidden, slot: $("seatPop").dataset.slot, viewing: viewing("coder") });
      requireElement("#seatPop [data-seat-watch]").click();
      check("the worker card's Watch opens that seat's work view", $("seatPop").hidden && viewing("coder") && Boolean(document.querySelector("#stagehead")), { hidden: $("seatPop").hidden, viewing: viewing("coder") });
      pic("leader").click();
      check("the leader's picture opens its card even while a worker's view is showing", !$("seatPop").hidden && $("seatPop").dataset.slot === "leader", { slot: $("seatPop").dataset.slot });
      pressEscape(); showChat();
      nameOf("coder").click();
      check("a worker's name opens its work view and no card", viewing("coder") && $("seatPop").hidden, { viewing: viewing("coder"), cardHidden: $("seatPop").hidden });
      showChat();
      const railWasWide = $("stage").classList.contains("wide");
      if (railWasWide) $("railBtn").click();
      pic("coder").click();
      const collapsedCard = !$("stage").classList.contains("wide") && !$("seatPop").hidden && $("seatPop").dataset.slot === "coder";
      requireElement("#seatPop [data-seat-watch]").click();
      check("collapsed rail: the picture opens the card and Watch opens the work view", collapsedCard && viewing("coder"), { collapsedCard, viewing: viewing("coder") });
      if (railWasWide) $("railBtn").click();
      showChat(); pressEscape();

      // The card follows the picture that opened it: Escape, the toggle and aria-expanded all point at the NEW opener.
      pic("coder").click(); pic("leader").click();
      check("the card switches to the leader's seat when its picture is clicked", !$("seatPop").hidden && $("seatPop").dataset.slot === "leader", { slot: $("seatPop").dataset.slot });
      check("only the open card's picture reads as expanded", pic("leader").getAttribute("aria-expanded") === "true" && pic("coder").getAttribute("aria-expanded") === "false", { leader: pic("leader").getAttribute("aria-expanded"), coder: pic("coder").getAttribute("aria-expanded") });
      const cardRole = text(".top small", $("seatPop"));
      check("the leader's card subtitle says leader once", !/leader.*leader/i.test(cardRole) && /leader/i.test(cardRole), { cardRole });
      pic("leader").click();
      check("clicking the picture that opened the card closes it", $("seatPop").hidden && pic("leader").getAttribute("aria-expanded") === "false", { hidden: $("seatPop").hidden, expanded: pic("leader").getAttribute("aria-expanded") });
      pic("coder").click(); pic("leader").click(); pressEscape();
      check("Escape hands focus back to the picture that opened the card, not the first one", $("seatPop").hidden && document.activeElement?.dataset?.seatPic === "leader", { active: document.activeElement?.dataset?.seatPic ?? document.activeElement?.id });
      check("closing the card leaves no picture marked expanded", [...document.querySelectorAll("#crew [data-seat-pic]")].every((button) => button.getAttribute("aria-expanded") === "false"), { expanded: [...document.querySelectorAll("#crew [data-seat-pic]")].map((button) => button.getAttribute("aria-expanded")) });
      // In the leader's chat its NAME also opens the card, so it says so; a worker's name opens the work view and says nothing.
      showChat();
      check("the leader's name button announces a card while the chat is showing", nameOf("leader").getAttribute("aria-haspopup") === "dialog" && nameOf("leader").getAttribute("aria-expanded") === "false" && !nameOf("coder").hasAttribute("aria-haspopup"), { leader: nameOf("leader").getAttribute("aria-haspopup"), expanded: nameOf("leader").getAttribute("aria-expanded"), coder: nameOf("coder").getAttribute("aria-haspopup") });
      nameOf("leader").click();
      check("the leader's name button reads as expanded while its card is open", !$("seatPop").hidden && nameOf("leader").getAttribute("aria-expanded") === "true", { hidden: $("seatPop").hidden, expanded: nameOf("leader").getAttribute("aria-expanded") });
      pressEscape(); showChat();

      // The picker lists every installed CLI; a model of another CLI sends cli with it; the tick and the effort row follow the server.
      window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
      await waitFor(() => ["claude", "codex", "opencode"].every((cli) => window.__latestState.settings?.tools?.[cli]?.installed === true), "CLI probes");
      const openPicker = (slot) => { pic(slot).click(); requireElement("[data-seat-model]", $("seatPop")).click(); return $("pop"); };
      const sentSince = (start) => window.__sent.slice(start).filter((message) => message.type === "updateSeat");
      const origin = { ...seatOf("coder") };
      openPicker("coder");
      const groupNames = [...document.querySelectorAll("#pop [data-grp]")].map((node) => node.dataset.grp);
      check("the picker groups models by installed CLI, the seat's own first", groupNames[0] === origin.cli && groupNames.includes("claude") && groupNames.includes("codex") && groupNames.includes("opencode"), { groupNames, own: origin.cli });
      const settle = () => new Promise((done) => setTimeout(done, 60));
      const groups = () => [...document.querySelectorAll("#pop [data-grp]")].map((node) => node.dataset.grp);
      const deliverTools = async (patch) => {
        const next = structuredClone(window.__latestState);
        for (const [cli, installed] of Object.entries(patch)) next.settings.tools[cli].installed = installed;
        window.__ccDeliver({ ...next, type: "state" }); await settle();
      };
      const [notChecked, missing] = ["claude", "codex", "opencode"].filter((cli) => cli !== origin.cli);
      await deliverTools({ [notChecked]: null, [missing]: false });
      check("a CLI that was not checked (null) or is not installed is not offered, the seat's own always is", !groups().includes(notChecked) && !groups().includes(missing) && groups().includes(origin.cli), { groups: groups(), notChecked, missing });
      await deliverTools({ [notChecked]: true, [missing]: true });
      check("the CLIs come back when the server finds them", groups().includes(notChecked) && groups().includes(missing), { groups: groups() });
      const effortStops = () => [...document.querySelectorAll("#pop .effort [role=radio]")].map((button) => ({ effort: button.dataset.effort, checked: button.getAttribute("aria-checked"), tab: button.tabIndex }));
      check("after a redraw only the checked effort is a tab stop", effortStops().length > 1 && effortStops().filter((item) => item.tab === 0).length === 1 && effortStops().find((item) => item.tab === 0).checked === "true", { stops: effortStops() });
      const typeSearch = (value) => { $("mq").value = value; $("mq").dispatchEvent(new Event("input", { bubbles: true })); };
      const optionCount = () => document.querySelectorAll("#pop [data-model]").length;
      const allModels = optionCount();
      typeSearch("sol");
      const filtered = [...document.querySelectorAll("#pop [data-model]")];
      check("searching narrows the list to models that match", filtered.length > 0 && filtered.length < allModels && filtered.every((button) => `${button.dataset.model} ${button.textContent}`.toLowerCase().includes("sol")), { all: allModels, shown: filtered.map((button) => button.dataset.model) });
      typeSearch("gpt-6-custom-id");
      check("a typed Codex id that is not listed can be used", Boolean(document.querySelector('#pop [data-model="gpt-6-custom-id"][data-cli="codex"]')) && !document.querySelector('#pop [data-model="gpt-6-custom-id"][data-cli="opencode"]'), { options: [...document.querySelectorAll("#pop [data-model]")].map((button) => `${button.dataset.cli}:${button.dataset.model}`) });
      typeSearch("someprovider/some-model");
      check("a typed provider/model id can be used for OpenCode only", Boolean(document.querySelector('#pop [data-model="someprovider/some-model"][data-cli="opencode"]')) && !document.querySelector('#pop [data-model="someprovider/some-model"][data-cli="codex"]'), { options: [...document.querySelectorAll("#pop [data-model]")].map((button) => `${button.dataset.cli}:${button.dataset.model}`) });
      typeSearch("");
      check("clearing the search brings the whole list back", optionCount() === allModels, { all: allModels, now: optionCount() });
      window.__ccDeliver({ type: "error", action: "updateSeat", tabId: "alpha-dev", message: "Finish or stop Atlas's current turn first" }); await settle();
      check("a refused seat change shows the server's reason and leaves the picker open", /Finish or stop Atlas's current turn first/.test($("toast")?.textContent ?? "") && !$("pop").hidden, { toast: $("toast")?.textContent, pickerOpen: !$("pop").hidden });
      check("the picker no longer claims the CLI comes with the crew", !/comes with the crew|stays on Claude Code/.test(document.body.innerText), { text: $("pop").innerText });
      const target = [...document.querySelectorAll("#pop [data-model]")].find((button) => button.dataset.cli !== origin.cli);
      if (!target) fail(`no model of another CLI rendered; groups ${JSON.stringify(groupNames)}`);
      const switchSent = window.__sent.length, switchRecv = window.__received.length;
      target.click();
      const tickEarly = target.getAttribute("aria-pressed") === "true";
      const switchMessage = sentSince(switchSent).at(-1);
      check("a model of another CLI sends updateSeat with cli and model", switchMessage?.slot === "coder" && switchMessage.cli === target.dataset.cli && switchMessage.model === target.dataset.model, { switchMessage, target: { cli: target.dataset.cli, model: target.dataset.model } });
      check("the tick does not move before the server confirms", !tickEarly && seatOf("coder").cli === origin.cli, { tickEarly, cli: seatOf("coder").cli });
      await waitForServerReply(switchRecv, "seat CLI switch response");
      await waitFor(() => seatOf("coder").cli === target.dataset.cli && seatOf("coder").model === target.dataset.model, "coder moved to the other CLI");
      const effortRow = [...document.querySelectorAll("#pop [data-effort]")];
      check("the picker stays open after a pick and shows the effort row for the chosen model", !$("pop").hidden && Boolean($("pop").querySelector("#mq")) && $("pop").querySelector(`[data-model="${CSS.escape(target.dataset.model)}"][data-cli="${CSS.escape(target.dataset.cli)}"]`)?.getAttribute("aria-pressed") === "true" && effortRow.length > 0 && effortRow.some((button) => button.getAttribute("aria-checked") === "true" && button.dataset.effort === seatOf("coder").effort), { open: !$("pop").hidden, effortRow: effortRow.map((button) => button.dataset.effort), seat: seatOf("coder") });
      const otherEffort = effortRow.map((button) => button.dataset.effort).find((effort) => effort !== seatOf("coder").effort);
      const effortSent = window.__sent.length, effortRecv = window.__received.length;
      requireElement(`#pop [data-effort="${CSS.escape(otherEffort)}"]`).click();
      await waitForServerReply(effortRecv, "same-visit effort response", () => seatOf("coder").effort === otherEffort);
      check("effort changes in the same visit as the model", sentSince(effortSent).at(-1)?.effort === otherEffort && seatOf("coder").effort === otherEffort, { sent: sentSince(effortSent), effort: seatOf("coder").effort });
      openPicker("coder");
      const backSent = window.__sent.length, backRecv = window.__received.length;
      requireElement(`#pop [data-model="${CSS.escape(origin.model)}"][data-cli="${CSS.escape(origin.cli)}"]`).click();
      await waitForServerReply(backRecv, "coder back to its own CLI");
      await waitFor(() => seatOf("coder").cli === origin.cli && seatOf("coder").model === origin.model, "coder restored");
      check("going back sends the CLI too", sentSince(backSent).at(-1)?.cli === origin.cli, { sent: sentSince(backSent) });
      if (seatOf("coder").effort !== origin.effort) requireElement(`#pop [data-effort="${CSS.escape(origin.effort)}"]`).click();
      pressEscape();

      // The leader runs on any CLI; the Advisor is Claude-only.
      const leaderOrigin = { ...seatOf("leader") };
      // Settings and the Usage panel, through the real app, with an advisor saved on the tab.
      const advisorSurfaces = async () => {
        // A real broadcast can land between steps and replace the state: deliver the advisor right before each read.
        const withAdvisor = () => {
          const next = structuredClone(window.__latestState);
          next.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").advisor = { model: "claude-fable-5-1" };
          window.__ccDeliver({ ...next, type: "state" });
        };
        withAdvisor();
        const usage = [...document.querySelectorAll("#usage .useRow")].some((row) => /Advisor/.test(row.textContent));
        $("setBtn").click(); await settle(); withAdvisor();
        const settingsSeen = Boolean(document.querySelector("#setModal [data-settings-model]"));
        const settings = Boolean(document.querySelector("#setModal [data-settings-advisor]"));
        pressEscape(); await settle();
        return { usage, settings, settingsSeen, leaderCli: latestTab("alpha-dev")?.crew.find((seat) => seat.slot === "leader")?.cli };
      };
      pic("leader").click();
      check("a Claude leader's card shows the Advisor row", leaderOrigin.cli === "claude" && Boolean($("seatPop").querySelector("[data-seat-advisor]")), { cli: leaderOrigin.cli });
      pressEscape(); showChat();
      const claudeSurfaces = await advisorSurfaces();
      check("a Claude leader: Settings and the Usage panel show the Advisor", claudeSurfaces.settingsSeen && claudeSurfaces.settings && claudeSurfaces.usage, claudeSurfaces);
      openSeatCard("leader");
      requireElement("[data-seat-model]", $("seatPop")).click();
      const codexModel = requireElement('#pop [data-model][data-cli="codex"]');
      const leaderRecv = window.__received.length, leaderSent = window.__sent.length;
      codexModel.click();
      check("the leader switches CLI with cli and model", sentSince(leaderSent).at(-1)?.cli === "codex" && sentSince(leaderSent).at(-1)?.slot === "leader", { sent: sentSince(leaderSent) });
      await waitForServerReply(leaderRecv, "leader CLI switch");
      await waitFor(() => seatOf("leader").cli === "codex", "leader on Codex");
      check("a Codex leader gets its limits in plain words", /Codex skips asking for commands it considers safe/.test($("pop").innerText) && /fresh session/.test($("pop").innerText), { text: $("pop").innerText });
      pressEscape(); showChat();
      const codexSurfaces = await advisorSurfaces();
      check("a Codex leader: Settings and the Usage panel show no Advisor", codexSurfaces.settingsSeen && !codexSurfaces.settings && !codexSurfaces.usage, codexSurfaces);
      showChat(); pic("leader").click();
      check("a Codex leader's card has no Advisor row", !$("seatPop").querySelector("[data-seat-advisor]") && !$("seatPop").hidden, { advisorRow: Boolean($("seatPop").querySelector("[data-seat-advisor]")) });
      requireElement("[data-seat-model]", $("seatPop")).click();
      const openCodeRecv = window.__received.length;
      requireElement('#pop [data-model][data-cli="opencode"]').click();
      await waitForServerReply(openCodeRecv, "leader to OpenCode");
      await waitFor(() => seatOf("leader").cli === "opencode", "leader on OpenCode");
      check("an OpenCode leader gets its limits in plain words", /Plan blocks edits, but a shell command can still write/.test($("pop").innerText) && /fresh session/.test($("pop").innerText), { text: $("pop").innerText });
      pressEscape(); showChat();
      const openCodeSurfaces = await advisorSurfaces();
      check("an OpenCode leader: Settings and the Usage panel show no Advisor", openCodeSurfaces.settingsSeen && !openCodeSurfaces.settings && !openCodeSurfaces.usage, openCodeSurfaces);
      showChat(); pic("leader").click();
      requireElement("[data-seat-model]", $("seatPop")).click();
      const leaderBackRecv = window.__received.length;
      requireElement(`#pop [data-model="${CSS.escape(leaderOrigin.model)}"][data-cli="claude"]`).click();
      await waitForServerReply(leaderBackRecv, "leader back to Claude");
      await waitFor(() => seatOf("leader").cli === "claude" && seatOf("leader").model === leaderOrigin.model, "leader restored");
      if (seatOf("leader").effort !== leaderOrigin.effort) requireElement(`#pop [data-effort="${CSS.escape(leaderOrigin.effort)}"]`).click();
      pressEscape();
      showChat();
    }
    // The first-project screen names the CLIs that can run the leader (Gemini cannot).
    const keepState = structuredClone(window.__latestState);
    window.__ccDeliver({ ...structuredClone(keepState), projects: [], type: "state" });
    const firstText = $("first").innerText;
    const firstShown = !$("first").hidden;
    window.__ccDeliver({ ...structuredClone(keepState), type: "state" }); await new Promise((done) => setTimeout(done, 60));
    check("the first-project screen says Claude, Codex or OpenCode can run the leader, not 'any one of these'", firstShown && /Claude, Codex or OpenCode can run the leader/.test(firstText) && !/Any one of these/.test(firstText), { firstShown, firstText });
    const folderStart = window.__received.length;
    $("folderBtn").click();
    const chosenFolder = new URLSearchParams(location.search).get("folder");
    await waitForServerReply(folderStart, "server folder response");
    check("folder picker updates the server tab folder", latestTab("alpha-dev")?.folder === chosenFolder && window.__sent.some((message) => message.type === "changeFolder" && message.tabId === "alpha-dev" && message.folder === chosenFolder), { folder: latestTab("alpha-dev")?.folder, chosen: chosenFolder, sent: window.__sent.filter((message) => message.type === "changeFolder"), response: window.__received.slice(folderStart).at(-1) });
    const projectTabsBeforeChange = window.__latestState.projects.find((project) => project.id === "alpha").tabs.map((tab) => ({ id: tab.id, folder: tab.folder }));
    const projectFolderStart = window.__received.length;
    const projectFolderSentStart = window.__sent.length;
    clickMenuItem(openProjectMenu("alpha"), "Change folder");
    await waitForServerReply(projectFolderStart, "project folder response");
    const alphaAfterProjectFolder = window.__latestState.projects.find((project) => project.id === "alpha");
    const projectTabsUnchanged = projectTabsBeforeChange.every((before) => latestTab(before.id)?.folder === before.folder);
    const projectFolderOnly = alphaAfterProjectFolder?.folder === chosenFolder && projectTabsUnchanged;
    const projectFolderRequests = window.__sent.slice(projectFolderSentStart).filter((message) => message.type === "changeProjectFolder" && message.projectId === "alpha" && message.folder === chosenFolder);
    check("project folder picker updates the default without changing existing tab folders", projectFolderOnly && projectFolderRequests.length === 1, { projectFolder: alphaAfterProjectFolder?.folder, projectTabsBeforeChange, tabFoldersAfter: projectTabsBeforeChange.map((tab) => ({ id: tab.id, folder: latestTab(tab.id)?.folder })), sent: window.__sent.slice(projectFolderSentStart), response: window.__received.slice(projectFolderStart).at(-1) });
    $("addtab").click();
    const newTabDefaultsToProject = $("tDir").textContent === chosenFolder && !$("createTab").disabled;
    check("new tab dialog defaults to the project folder", newTabDefaultsToProject, { displayedFolder: $("tDir").textContent, projectFolder: alphaAfterProjectFolder?.folder, createEnabled: !$("createTab").disabled });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const processMenu = openTabMenu("alpha-dev"); clickMenuItem(processMenu, "Kind and crew");
    requireElement('#setupPop [data-set-process="duo"]').click();
    const heldProcess = $("undo").querySelector("[data-undo-held]");
    const sentBeforeUndo = window.__sent.some((message) => message.type === "setProcess" && message.tabId === "alpha-dev");
    if (!heldProcess) fail("process change did not offer Undo");
    heldProcess.click();
    const undoRestored = latestTab("alpha-dev")?.process === "main" && !window.__sent.some((message) => message.type === "setProcess" && message.tabId === "alpha-dev");
    const processMenuAgain = openTabMenu("alpha-dev"); clickMenuItem(processMenuAgain, "Kind and crew");
    const processStart = window.__received.length;
    requireElement('#setupPop [data-set-process="duo"]').click();
    await new Promise((resolve) => setTimeout(resolve, 10_100));
    await waitForServerReply(processStart, "server process response");
    check("process change waits for Undo and then reaches the server", !sentBeforeUndo && undoRestored && latestTab("alpha-dev")?.process === "duo" && window.__sent.some((message) => message.type === "setProcess" && message.tabId === "alpha-dev" && message.process === "duo"), { sentBeforeUndo, undoRestored, process: latestTab("alpha-dev")?.process, sent: window.__sent.filter((message) => message.type === "setProcess"), response: window.__received.slice(processStart).at(-1) });
  };
  const runFake = async () => {
    await waitFor(() => window.__latestState?.type === "state", "fake server state");
    // The bar drags the window; its controls, tabs and popovers are not drag areas. Chrome exposes app-region in computed style, so each target's real value is read (a missing target fails).
    const regionTargets = [["#top", "drag"], ["#soundBtn", "no-drag"], ["#ptabs", "no-drag"], ['#ptabs [role="tab"]', "no-drag"], ["#inboxPop", "no-drag"], ["#setModal", "no-drag"], ["#toast", "no-drag"], ["#undo", "no-drag"], ["#conn", "no-drag"]];
    const regions = regionTargets.map(([selector, wanted]) => { const element = document.querySelector(selector); return { selector, wanted, found: Boolean(element), actual: element ? getComputedStyle(element).getPropertyValue("-webkit-app-region") : null }; });
    check("the top bar drags the window, and its controls, tabs and popovers are not drag areas", regions.every((item) => item.found && item.actual === item.wanted), { regions });
    // This page's window.cc has the folder picker but no window buttons, as in a plain browser: the bar ends at the avatar, as before.
    const topControls = [...$("top").children].filter((node) => node.checkVisibility());
    check("without the app window's bridge the top bar shows no window buttons", $("winBtns").hidden && !$("winBtns").checkVisibility() && topControls.at(-1) === $("meBtn"), { hidden: $("winBtns").hidden, last: topControls.at(-1)?.id });
    // An uploaded picture is shown through one short blob URL (not its data URL, which would be copied into every message): the bytes behind it must be the saved picture.
    if (window.__ccExpectMe) {
      const shownSrc = $("meImg").getAttribute("src") ?? "";
      // (the page's policy lets it load a blob: image but not fetch one, so the two pictures are compared by their decoded pixels)
      const pixelsOf = (url) => new Promise((resolve) => { const image = new Image(); image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); resolve(`${canvas.width}x${canvas.height}:${[...context.getImageData(0, 0, canvas.width, canvas.height).data].join(",")}`); }; image.onerror = () => resolve("did not load"); image.src = url; });
      const keptUpload = window.__ccExpectMe.startsWith("data:") ? shownSrc.startsWith("blob:") && await pixelsOf(shownSrc) === await pixelsOf(window.__ccExpectMe) && !(await pixelsOf(shownSrc)).startsWith("did not") : shownSrc === window.__ccExpectMe;
      check("a personal picture saved before the simple look falls back to Ash, and an uploaded one is kept", keptUpload, { saved: window.__ccOldMe, shown: shownSrc.slice(0, 60), expected: window.__ccExpectMe.slice(0, 60) });
    }
    // A picture whose file is missing swaps to its fallback once; a missing fallback is left alone, never retried.
    const probe = document.createElement("img"); let probeErrors = 0;
    probe.addEventListener("error", () => probeErrors++);
    probe.alt = ""; probe.dataset.fallback = "/avatars/missing-fallback-probe.svg"; probe.src = "/avatars/missing-picture-probe.svg";
    document.body.append(probe);
    await waitFor(() => probeErrors >= 2, "missing picture and its missing fallback both failed");
    for (let index = 0; index < 5; index++) await fetch("/__browser-barrier", { cache: "no-store" });
    check("a picture that fails to load falls back once and never loops", probeErrors === 2 && probe.getAttribute("src") === "/avatars/missing-fallback-probe.svg" && probe.dataset.fellBack === "1", { probeErrors, src: probe.getAttribute("src"), fellBack: probe.dataset.fellBack });
    probe.remove();
    const noUsageState = structuredClone(window.__latestState);
    for (const tab of noUsageState.projects.flatMap((project) => project.tabs)) {
      delete tab.leaderUsage;
      for (const run of tab.runs ?? []) delete run.usage;
    }
    window.__ccDeliver({ ...noUsageState, type: "state" });
    // Every seat has a row; only measured ones carry a number, the rest say Not reported (never a guess).
    const unmeasuredHonest = () => [...document.querySelectorAll("#usage .useRow.unmeasured")].every((row) => !row.querySelector(".v") && /^Not reported( separately)?$/.test(row.querySelector(".nr")?.textContent ?? ""));
    const usageStartsEmpty = text("#usage [data-usage-empty]") === "No usage reported yet." && !document.querySelector("#usage .useRow .v") && document.querySelectorAll("#usage .useRow.unmeasured").length >= window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").crew.length && unmeasuredHonest();
    const measuredUsageState = structuredClone(noUsageState);
    const measuredTab = measuredUsageState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    measuredTab.leaderUsage = { contextTokens: 3072, contextWindow: 10000, costUsd: 0.015, turns: 2 };
    measuredTab.runs.find((run) => run.runId === "audit-parallel-1").usage = { contextTokens: 1536, contextWindow: 8192, costUsd: 0.002, turns: 1 };
    window.__ccDeliver({ ...measuredUsageState, type: "state" });
    const usageRows = [...document.querySelectorAll("#usage .useRow:not(.unmeasured)")].map((row) => row.textContent.replace(/\s+/g, " ").trim());
    const exactUsage = [...document.querySelectorAll("#usage .useRow .v")].map((node) => node.textContent.trim());
    const expectedLeaderUsage = "3,072 / 10,000 ctx · $0.0150 · 2 turns";
    const expectedRunUsage = "1,536 / 8,192 ctx · $0.0020 · 1 turn";
    const exactUsageMatches = exactUsage.slice().sort().join("\n") === [expectedLeaderUsage, expectedRunUsage].sort().join("\n");
    const measuredEmptyGone = !document.querySelector("#usage [data-usage-empty]") && unmeasuredHonest();
    check("Usage shows only measured leader and running-seat snapshots", usageStartsEmpty && usageRows.length === 2 && exactUsageMatches && measuredEmptyGone, { usageStartsEmpty, usageRows, exactUsage, expectedLeaderUsage, expectedRunUsage, exactUsageMatches, measuredEmptyGone });
    const emptyMeters = $("meters").hidden && $("meters").children.length === 0;
    window.__socket.sendMessage({ type: "rateLimit", runId: "audit-parallel-1", windows: { fiveHour: { used: 640, limit: 1000 } } });
    const measuredMeter = [...document.querySelectorAll("#meters .meter .row b")].map((node) => node.textContent.trim());
    check("plan meters stay hidden without data and show the measured rateLimit", emptyMeters && !$("meters").hidden && measuredMeter.includes("64%"), { hiddenBeforeMeasurement: emptyMeters, visibleAfterMeasurement: !$("meters").hidden, measured: measuredMeter });

    const unsafeName = '<img src=x onerror="window.__ccXss()">';
    const renderedName = requireElement('#crew [data-seat-id="leader"] .name');
    check("server supplied seat text is rendered as text", renderedName.textContent === unsafeName && !renderedName.querySelector("img"), { text: renderedName.textContent, injectedImages: renderedName.querySelectorAll("img").length });

    const devTab = requireElement('#tabs [data-tab-id="alpha-dev"]');
    devTab.focus(); devTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await waitFor(() => window.__latestState?.selectedTabId === "alpha-design", "keyboard tab selection");
    check("tab arrow keys change server selection and retain focus", window.__latestState.selectedTabId === "alpha-design" && document.activeElement?.dataset.tabId === "alpha-design", { selectedTabId: window.__latestState.selectedTabId, focusedTabId: document.activeElement?.dataset.tabId, sent: window.__sent.filter((message) => message.type === "selectTab").at(-1) });
    await clickTab("Development");
    await waitFor(() => window.__received.some((message) => message.type === "chatHistory" && message.tabId === "alpha-dev"), "chatHistory server message");
    const transcript = document.querySelector('#view [data-message-id="1"]');
    check("chatHistory renders its server transcript", Boolean(transcript && transcript.textContent.includes("Saved transcript from the server")), { found: Boolean(transcript), messageId: transcript?.dataset.messageId ?? "missing", text: transcript?.textContent.trim() ?? "missing" });
    $("ci").value = "Send this through the chat protocol"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-dev" && message.text === "Send this through the chat protocol"), "chat protocol send");
    const sentChat = window.__sent.filter((message) => message.type === "chat").at(-1);
    check("chat sends the current tab and message through the protocol", sentChat?.tabId === "alpha-dev" && sentChat.text === "Send this through the chat protocol", { sent: sentChat });
    await waitFor(() => window.__received.some((message) => message.type === "chatMessage" && message.revision === 2 && message.role === "user"), "chatMessage server echo");
    const echoed = document.querySelector('#view [data-message-id="2"] .bubble p');
    check("chatMessage updates the visible transcript", echoed?.textContent === "Send this through the chat protocol", { text: echoed?.textContent ?? "missing" });
    await waitFor(() => window.__received.some((message) => message.type === "chatDelta" && message.text === "The lead is answering."), "chatDelta server message");
    const streaming = [...document.querySelectorAll("#view .thread .msg .body p")].find((node) => node.textContent === "The lead is answering.");
    check("chatDelta renders the live transcript", Boolean(streaming), { text: streaming?.textContent ?? "missing" });
    await waitFor(() => window.__received.some((message) => message.type === "chatDone"), "chatDone server message");
    const assistant = document.querySelector('#view [data-message-id="3"] .body p');
    check("chatDone clears streaming text and leaves the final message", Boolean(assistant) && assistant.textContent === "The lead replied." && $("chatStatus").hidden && ![...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent === "The lead is answering."), { text: assistant?.textContent ?? "missing", statusHidden: $("chatStatus").hidden });

    // The server sends no message id: a second turn in the same open tab must show both of its messages without reopening the tab.
    $("ci").value = "Second question in the same tab"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => [...document.querySelectorAll("#view .thread .msg .body p")].filter((node) => node.textContent === "The lead replied.").length === 2, "second turn reply without reopening the tab");
    const secondUser = [...document.querySelectorAll("#view .msg.mine .bubble p")].map((node) => node.textContent);
    check("a second chat turn shows both its message and the leader's reply without reopening the tab", secondUser.includes("Second question in the same tab") && secondUser.length === 2, { secondUser });

    // A finished message is rendered once (its first render replaces the text a few times: escape, then the formatting): later renders of the same server-shaped message (revision, no id) reuse the cached html.
    const cacheProbe = "cache probe marker 7731", realReplace = String.prototype.replace;
    let cacheProbeRenders = 0;
    String.prototype.replace = function (...args) { if (this.valueOf() === cacheProbe) cacheProbeRenders++; return realReplace.apply(this, args); };
    try {
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 40, role: "assistant", text: cacheProbe, at: Date.now() });
      const afterFirstRender = cacheProbeRenders;
      for (let again = 0; again < 3; again++) window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      check("a finished server-shaped message is rendered once and then served from the cache", afterFirstRender >= 1 && cacheProbeRenders === afterFirstRender && Boolean(document.querySelector('#view [data-message-id="40"]')), { afterFirstRender, cacheProbeRenders });
    } finally { String.prototype.replace = realReplace; }

    const view = $("view"); view.style.height = "220px"; view.style.flex = "none"; view.style.overflow = "auto";
    const longTranscript = Array.from({ length: 48 }, (_, index) => ({ id: `audit-scroll-${index}`, role: "assistant", text: `Earlier transcript line ${index}` }));
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-dev", messages: longTranscript });
    const maxBefore = view.scrollHeight - view.clientHeight;
    view.scrollTop = Math.max(0, maxBefore - 5);
    const readerPosition = view.scrollTop;
    window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: " Keep the reader's position." });
    await new Promise((resolve) => setTimeout(resolve, 150)); // deltas now paint once per frame
    const stayedAtReaderPosition = view.scrollTop === readerPosition;
    const maxAtEdge = view.scrollHeight - view.clientHeight;
    view.scrollTop = Math.max(0, maxAtEdge - 4);
    window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: " Follow the four-pixel edge." });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const maxAfterEdge = view.scrollHeight - view.clientHeight;
    const followedBottomAtThreshold = Math.abs(maxAfterEdge - view.scrollTop) <= 1;
    check("chat transcript keeps the reader position and sticks within four pixels", stayedAtReaderPosition && followedBottomAtThreshold && maxBefore > 0, { readerPosition, afterScrolledUpdate: stayedAtReaderPosition ? readerPosition : view.scrollTop, maxBefore, edgeDistance: 4, afterEdgeUpdate: view.scrollTop, maxAfterEdge, stayedAtReaderPosition, followedBottomAtThreshold });

    openSeatView("coder");
    const badge = text('#crew [data-seat-id="coder"] .cnt');
    const runTabs = [...document.querySelectorAll("#view [data-run-tab]")].map((node) => node.dataset.runTab);
    const runOutput = text('#view [data-output-run="audit-parallel-1"]');
    check("two parallel runs show the count badge and independent run tabs", badge === "2" && runTabs.length === 2 && runOutput.includes("real runner output 1"), { badge, runTabs, targetSeat: "coder", runOutput });
    const runFolderPath = latestTab("alpha-dev").runs.find((run) => run.runId === "audit-parallel-1").folderPath;
    check("Writes only inside shows the server's folderPath", text("#view .touched .file") === runFolderPath && Boolean(runFolderPath), { renderedFolder: text("#view .touched .file"), folderPath: runFolderPath });
    const first = requireElement('#view [data-stop-run]'); first.click();
    const stopRun = window.__sent.filter((message) => message.type === "killRun").at(-1);
    check("per-run stop sends only the selected run id", stopRun?.runId === first.dataset.stopRun, { requested: first.dataset.stopRun, sent: stopRun });
    // Stop seat comes before Stop all: once every live run of a seat is already stopping, its Stop seat button is disabled.
    requireElement("#stagehead [data-stop-seat]").click();
    const stopSeat = window.__sent.filter((message) => message.type === "stopSeat").at(-1);
    check("Stop seat sends the selected tab and seat", stopSeat?.tabId === "alpha-dev" && stopSeat.slot === "coder", { sent: stopSeat });
    $("stopAll").click();
    const stopAll = window.__sent.filter((message) => message.type === "stopAll").at(-1);
    check("Stop all sends the server action", Boolean(stopAll), { sent: stopAll });

    requireElement("#stagehead [data-run-seat]").click();
    $("runPrompt").value = "Audit the run request";
    $("runPrompt").dispatchEvent(new Event("input", { bubbles: true }));
    $("runStart").click();
    const runRequest = window.__sent.filter((message) => message.type === "run").at(-1);
    check("run sends the selected tab, seat and prompt", runRequest?.tabId === "alpha-dev" && runRequest.slot === "coder" && runRequest.prompt === "Audit the run request" && $("runModal").hidden, { sent: runRequest, closedOnRunAccepted: $("runModal").hidden });
    requireElement('#stagehead [data-run-view="history"]').click();
    const historyList = window.__sent.filter((message) => message.type === "historyList").at(-1);
    check("seat History requests its server log list", historyList?.seatKey === "alpha-dev.coder" && text("#view").includes("No runs yet"), { sent: historyList, view: text("#view").slice(0, 120) });
    const historyTimestamp = 1780000000000;
    const historyOutcome = { status: "failed", exitCode: 17 };
    window.__ccDeliver({ type: "historyList", seatKey: historyList.seatKey, runs: [{ timestamp: historyTimestamp, sizeBytes: 1536, outcome: historyOutcome }] });
    const historyRow = requireElement(`#view [data-history-timestamp="${historyTimestamp}"]`);
    const historyDate = new Date(historyTimestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const colorProbe = document.createElement("span"); colorProbe.style.color = "var(--failed)"; document.body.append(colorProbe);
    const failedColor = getComputedStyle(colorProbe).color; colorProbe.remove();
    const historyFields = historyRow.textContent.replace(/\s+/g, " ").trim();
    const historyDotMatchesOutcome = getComputedStyle(historyRow.querySelector(".rs")).backgroundColor === failedColor;
    const historyFieldsAreReal = historyFields.includes(historyDate) && historyFields.includes("failed") && historyFields.includes("exit 17") && historyFields.includes("1,536 B") && !historyFields.includes("Today") && !historyFields.includes("1m") && historyDotMatchesOutcome;
    historyRow.click();
    const historyRun = window.__sent.filter((message) => message.type === "historyRun").at(-1);
    window.__ccDeliver({ type: "historyRun", seatKey: historyList.seatKey, timestamp: historyTimestamp, output: "Persisted server run details", brief: "History browser check", totalBytes: 1536, outcome: historyOutcome });
    const historyOutput = text("#view .term pre");
    const historyDetail = text("#view .metarow");
    const detailHasActualFields = historyDetail.includes(historyDate) && historyDetail.includes("failed") && historyDetail.includes("exit 17") && historyDetail.includes("1,536 B") && !historyOutput.includes("[object Object]");
    check("historyRun requests and renders the selected server run", historyRun?.seatKey === historyList.seatKey && historyRun.timestamp === historyTimestamp && historyOutput.includes("Persisted server run details") && historyFieldsAreReal && detailHasActualFields, { requested: historyRun, output: historyOutput, historyFields, historyDate, historyDotMatchesOutcome, historyDetail, detailHasActualFields });
    requireElement('#stagehead [data-run-view="live"]').click();
    const requestCount = () => window.__sent.filter((message) => message.type === "historyList" && message.seatKey === historyList.seatKey).length;
    const beforeReopen = requestCount();
    requireElement('#stagehead [data-run-view="history"]').click();
    const reopenedHistory = requestCount() === beforeReopen + 1;
    const beforeFinish = requestCount();
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", seatKey: "alpha-dev.coder" });
    const refreshedOnFinish = requestCount() === beforeFinish + 1;
    const oldSocket = window.__socket; const beforeReconnect = requestCount();
    oldSocket.emit("close", {});
    await waitFor(() => window.__socket !== oldSocket && requestCount() > beforeReconnect, "History refresh after reconnect");
    const refreshedOnReconnect = requestCount() > beforeReconnect;
    check("History refreshes on reopen, run completion, and reconnect", reopenedHistory && refreshedOnFinish && refreshedOnReconnect, { reopenedHistory, refreshedOnFinish, refreshedOnReconnect, requests: requestCount(), beforeReconnect });

    // Theme and picture are the server's (a new window port is a new, empty localStorage): each choice is sent as a client pref and the server's echo is what the page then shows.
    const looksStart = window.__sent.length;
    $("setBtn").click(); requireElement('#setModal [data-theme="dark"]').click(); requireElement('#setModal [data-theme="light"]').click();
    $("meBtn").click(); requireElement('#avModal[aria-hidden="false"]');
    requireElement('#avgrid [data-avatar="pip"]').click();
    const looksSent = window.__sent.slice(looksStart).filter((message) => message.type === "updateClientPref" && ["theme", "avatar"].includes(message.key)).map((message) => message.key + "=" + message.value);
    await waitFor(() => window.__latestState.clientPrefs?.theme === "light" && window.__latestState.clientPrefs?.avatar === "pip.svg", "the server echoes the theme and picture");
    const appearanceWorks = document.body.classList.contains("light") && looksSent.includes("theme=dark") && looksSent.includes("theme=light");
    const avatarWorks = $("meImg").src.endsWith("/avatars/pip.svg") && looksSent.includes("avatar=pip.svg");
    pressEscape();
    check("theme and personal avatar choices stay usable", appearanceWorks && avatarWorks, { themeApplied: document.body.classList.contains("light"), looksSent, avatarApplied: $("meImg").src.endsWith("/avatars/pip.svg"), serverPrefs: { theme: window.__latestState.clientPrefs?.theme, avatar: window.__latestState.clientPrefs?.avatar }, storageBlocked: window.__ccStorageBlocked });

    const safetyState = structuredClone(window.__ccSeed);
    safetyState.launchSafety = { blocked: ["alpha-dev.coder", "alpha-dev.reviewer1"], uncertain: [{ seatId: "coder", seatKey: "alpha-dev.coder", runId: "audit-uncertain", pid: 4321 }], released: [], notices: [{ id: 41, pending: true, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "Audit launch notice" }] };
    window.__socket.sendMessage({ ...safetyState, type: "state" });
    openInbox();
    const reviewerSeat = latestTab("alpha-dev", safetyState).crew.find((seat) => seat.slot === "reviewer1");
    const warnings = [...document.querySelectorAll("#inboxList .safety-warning")].map((node) => node.textContent.trim());
    const warning = warnings.length === 1 && warnings[0].startsWith("Only Codex seats can be held read-only.") && warnings[0].includes(reviewerSeat.name) ? "Only Codex seats can be held read-only." : warnings.join(" | ");
    const releasePhrase = "release may leave a process running and editing files";
    const unblockInput = requireElement('[data-confirm-unblock="alpha-dev.coder"]');
    const releaseInput = requireElement('[data-confirm-release="audit-uncertain"]');
    const safetyStart = window.__sent.length;
    unblockInput.value = "allow this seat to launch again ";
    requireElement('[data-unblock="alpha-dev.coder"]').click();
    releaseInput.value = `${releasePhrase} `;
    requireElement('[data-release="audit-uncertain"]').click();
    const wrongPhrasesNotSent = !window.__sent.slice(safetyStart).some((message) => ["unblockSeat", "releaseUnconfirmed", "releaseUnconfirmedSeat"].includes(message.type));
    const wrongPhraseToastVisible = await waitToastVisible();
    unblockInput.value = "allow this seat to launch again";
    requireElement('[data-unblock="alpha-dev.coder"]').click();
    releaseInput.value = releasePhrase;
    requireElement('[data-release="audit-uncertain"]').click();
    requireElement('[data-retry-kill="audit-uncertain"]').click();
    requireElement('[data-ack-notice="41"]').click();
    const unblock = window.__sent.filter((message) => message.type === "unblockSeat").at(-1);
    const release = window.__sent.filter((message) => message.type === "releaseUnconfirmed").at(-1);
    const retryKill = window.__sent.filter((message) => message.type === "killRun").at(-1);
    const ack = window.__sent.filter((message) => message.type === "ackLaunchNotice").at(-1);
    check("wrong launch-safety phrases stay local and the exact typed phrases are sent", wrongPhrasesNotSent && wrongPhraseToastVisible && unblock?.confirm === unblockInput.value && release?.confirm === releaseInput.value && release.runId === "audit-uncertain" && retryKill?.runId === "audit-uncertain", { wrongPhrasesNotSent, wrongPhraseToastVisible, unblock, typedUnblockPhrase: unblockInput.value, release, typedReleasePhrase: releaseInput.value, retryKill });
    check("launch safety shows the Codex warning when a Claude seat is involved", warning === "Only Codex seats can be held read-only." && ack?.id === 41, { warning, ack, nonCodexSeat: "alpha-dev.reviewer1" });

    window.__ccDeliver({ type: "leaderLaunch", id: 9001, source: "Audit harness", seatName: "Coder", pending: true });
    window.__ccDeliver({ type: "runStalled", seatKey: "alpha-dev.coder" });
    window.__ccDeliver({ type: "runFinish", seatKey: "alpha-dev.coder" });
    const activityRows = [...document.querySelectorAll("#feed .ev")];
    const activityEntry = (textValue) => activityRows.find((row) => row.querySelector(".x")?.textContent === textValue);
    // A tab-scoped seat key now resolves to the seat's own name in the feed.
    const coderName = latestTab("alpha-dev").crew.find((seat) => seat.slot === "coder").name;
    const launchActivity = activityEntry("Audit harness requested Coder · outcome unconfirmed");
    const stallActivity = activityEntry(`${coderName} stalled`);
    const finishActivity = activityEntry(`${coderName} finished`);
    check("activity feed renders real launch, stall and completion events", Boolean(launchActivity && stallActivity && finishActivity) && launchActivity.querySelector(".d")?.classList.contains("waiting") && stallActivity.querySelector(".d")?.classList.contains("waiting") && finishActivity.querySelector(".d")?.classList.contains("done"), { rows: activityRows.map((row) => ({ text: row.querySelector(".x")?.textContent, type: row.querySelector(".d")?.className })) });

    const appBridge = window.cc;
    delete window.cc;
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    $("setBtn").click();
    requireElement('#setNav [data-settings-section="folders"]').click();
    const plainBrowserPickersHidden = $("folderBtn").hidden
      && !document.querySelector('#setBody [data-setting-action="folder-browse"]')
      && !document.querySelector('#setBody [data-setting-action="tab-folder-browse"]')
      && !document.querySelector('#setBody [data-setting-action="vault-browse"]');
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("plain browser hides Electron-only folder pickers", plainBrowserPickersHidden, { folderButtonHidden: $("folderBtn").hidden, defaultBrowse: Boolean(document.querySelector('#setBody [data-setting-action="folder-browse"]')), tabBrowse: Boolean(document.querySelector('#setBody [data-setting-action="tab-folder-browse"]')), vaultBrowse: Boolean(document.querySelector('#setBody [data-setting-action="vault-browse"]')) });
    window.cc = appBridge;
  };
  const runB2 = async () => {
    await waitFor(() => window.__latestState?.type === "state", "Pack B2 fake state");
    const holdClock = installTenSecondClock();
    const selectors = ["#setBtn", "#setModal", "#setNav", "#setBody", "#tabs", "#sline", "#statusBtn", "#pipe", "#view", "#composer", "#ci", "#attachBtn", "#attachInput", "#atts", "#sendBtn", "#avModal", "#avgrid", "#avUp", "#undo", "#toast", "#inboxBtn", "#inboxList"];
    const missing = selectors.filter((selector) => !document.querySelector(selector));
    check("Pack B2 target selector list finds every required control", missing.length === 0, { found: selectors.filter((selector) => document.querySelector(selector)), missing });
    const tabOf = (tabId, state = window.__latestState) => state.projects.flatMap((project) => project.tabs).find((tab) => tab.id === tabId);
    const entry = tabOf("alpha-dev");
    const fits = (element) => element.clientWidth > 0 && element.scrollWidth <= element.clientWidth;
    const leadCard = openSeatCard("leader");
    const leadModel = text("[data-seat-model] .model-label", leadCard);
    const leadEffort = text("[data-seat-model] .eff", leadCard);
    const leadChipFits = fits(requireElement("[data-seat-model] .model-label", leadCard)) && fits(requireElement("[data-seat-model] .eff", leadCard));
    pressEscape();
    const coderCard = openSeatCard("coder");
    const crewModel = text("[data-seat-model] .model-label", coderCard);
    const crewEffort = text("[data-seat-model] .eff", coderCard);
    const coderChipFits = fits(requireElement("[data-seat-model] .model-label", coderCard)) && fits(requireElement("[data-seat-model] .eff", coderCard));
    pressEscape();
    const roleOf = (slot) => entry.processState.seats.find((seat) => seat.slotId === slot)?.roleLabel;
    const leadRole = text('#crew [data-seat-id="leader"] .role');
    const subtitle = text("#stagehead .vwho small");
    const novaPortrait = requireElement('#crew [data-seat-id="fixer"] .av img').getAttribute("src");
    const chipLabelsFit = leadChipFits && coderChipFits;
    check("B1 labels, effort, role, CLI, and Nova portrait match the mockup", leadModel === "Opus 5.5" && leadEffort.includes("medium") && crewModel === "Luna 6" && crewEffort.includes("max") && leadRole === roleOf("leader") && leadRole === "Leader" && subtitle === `${roleOf("coder")} · Codex` && novaPortrait.endsWith("/avatars/nova.svg") && !document.querySelector("#stagehead .does") && chipLabelsFit, { leadModel, leadEffort, crewModel, crewEffort, leadRole, subtitle, novaPortrait, effortVisible: chipLabelsFit, stageHeadChips: document.querySelectorAll("#stagehead .does").length });
    // The leader badge repeats nothing: hidden on a picture that already wears a crown (Atlas's), shown on any other.
    const crownWith = (pic) => {
      const state = structuredClone(window.__ccSeed); const lead = tabOf("alpha-dev", state).crew.find((seat) => seat.isLeader);
      if (pic === undefined) delete lead.pic; else lead.pic = pic;
      window.__ccDeliver({ ...state, type: "state" });
      return { badge: Boolean(document.querySelector('#crew [data-seat-id="leader"] .crown')), picture: document.querySelector('#crew [data-seat-id="leader"] .av img')?.getAttribute("src") };
    };
    const crowns = { slotDefault: crownWith(undefined), atlas: crownWith("avatars/atlas.svg"), ash: crownWith("avatars/ash.svg"), uploaded: crownWith("/api/avatar/avatar-7e2e1c3a-0b1d-4c5e-8f00-123456789abc.png") };
    const workerCrowns = document.querySelectorAll('#crew .seat:not([data-seat-id="leader"]) .crown').length;
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    check("the leader crown badge shows only when the leader's picture has no crown of its own", !crowns.slotDefault.badge && crowns.slotDefault.picture === "/avatars/atlas.svg" && !crowns.atlas.badge && crowns.ash.badge && crowns.ash.picture === "/avatars/ash.svg" && crowns.uploaded.badge && workerCrowns === 0, { ...crowns, workerCrowns });
    // The open seat card re-renders from every state broadcast, so it shows each probed label.
    const probeCard = openSeatCard("coder");
    const probeLabel = (cli, model) => {
      const state = structuredClone(window.__latestState); const seat = tabOf("alpha-dev", state).crew.find((item) => item.slot === "coder");
      seat.cli = cli; seat.model = model;
      window.__ccDeliver({ ...state, type: "state" });
      return text("[data-seat-model] .model-label", probeCard);
    };
    const astraLabel = probeLabel("codex", "gpt-6-astra");
    const sonnetLabel = probeLabel("claude", "claude-sonnet-5");
    const deepseekLabel = probeLabel("opencode", "deepseek/deepseek-flash");
    const unknownLabel = probeLabel("opencode", "unknown/model-123");
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    pressEscape(); showChat();
    check("Codex and OpenCode model labels use the mockup names and unknown ids stay raw", astraLabel === "Astra 6" && sonnetLabel === "Sonnet 5" && deepseekLabel === "DeepSeek Flash" && unknownLabel === "unknown/model-123", { astraLabel, sonnetLabel, deepseekLabel, unknownLabel });

    const xssText = '<img src=x onerror="window.__ccXss()">';
    const xssState = structuredClone(window.__ccSeed);
    const xssProject = xssState.projects.find((project) => project.id === "alpha");
    const xssTab = tabOf("alpha-dev", xssState);
    xssProject.name = xssText; xssTab.name = xssText; xssTab.folder = `C:/${xssText}`;
    window.__ccDeliver({ ...xssState, type: "state" });
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 20, role: "user", text: xssText, at: Date.now() });
    const xssProjectNode = $("projName"), xssTabNode = requireElement('#tabs [data-tab-id="alpha-dev"] .tl');
    const xssFolderNode = $("folder"), xssMessageNode = requireElement('#view [data-message-id="20"] .bubble p');
    // The composer shows the folder's own name; its full path is the button's title.
    const literalShellText = xssProjectNode.textContent === xssText && xssTabNode.textContent === xssText && xssFolderNode.textContent === xssText && $("folderBtn").title.includes(`C:/${xssText}`) && xssMessageNode.textContent === xssText;
    const noShellInjection = xssProjectNode.childElementCount === 0 && xssTabNode.childElementCount === 0 && xssFolderNode.childElementCount === 0 && xssMessageNode.childElementCount === 0 && !window.__ccErrors.includes("escaped text ran as HTML");
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    check("XSS-shaped chat, tab, project, and folder strings stay visible literal text", literalShellText && noShellInjection, { literalShellText, noShellInjection, projectChildren: xssProjectNode.childElementCount, tabChildren: xssTabNode.childElementCount, folderChildren: xssFolderNode.childElementCount, messageChildren: xssMessageNode.childElementCount, xssErrors: window.__ccErrors.filter((error) => error.includes("escaped text")) });

    const openProjectRename = () => { clickMenuItem(openProjectMenu("alpha"), "Rename"); requireElement('#renameModal[aria-hidden="false"]'); return requireElement("#renameInput"); };
    const projectInput = openProjectRename();
    const typedBeforeBroadcast = "Typed while state arrives";
    projectInput.value = typedBeforeBroadcast;
    const incomingProjectState = structuredClone(window.__ccSeed); incomingProjectState.projects.find((project) => project.id === "alpha").name = "Incoming project state";
    window.__ccDeliver({ ...incomingProjectState, type: "state" });
    const sameNodeWhileEditing = $("renameInput") === projectInput && !$("renameModal").hidden && projectInput.value === typedBeforeBroadcast && document.activeElement === projectInput;
    projectInput.value = "Renamed project";
    projectInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const renameRequest = window.__sent.filter((message) => message.type === "renameProject").at(-1);
    const renamedState = structuredClone(incomingProjectState); renamedState.projects.find((project) => project.id === "alpha").name = "Renamed project";
    window.__ccDeliver({ ...renamedState, type: "state" });
    const sameNodeAfterEnter = $("renameModal").hidden && $("projName").textContent === "Renamed project";
    const renamesBeforeEscape = window.__sent.filter((message) => message.type === "renameProject").length;
    const cancelInput = openProjectRename(); cancelInput.value = "Discard this rename";
    cancelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const sameNodeAfterEscape = $("renameModal").hidden && $("projName").textContent === "Renamed project" && window.__sent.filter((message) => message.type === "renameProject").length === renamesBeforeEscape && document.activeElement?.matches('#ptabs [data-project-menu="alpha"]');
    check("project rename keeps typed text through incoming state, Enter sends it, and Escape discards it", sameNodeWhileEditing && sameNodeAfterEnter && sameNodeAfterEscape && renameRequest?.name === "Renamed project" && renameRequest?.projectId === "alpha" && Boolean(document.querySelector("#view .thread")), { sameNodeWhileEditing, sameNodeAfterEnter, sameNodeAfterEscape, renameRequest, stageStillRendered: Boolean(document.querySelector("#view .thread")), focused: document.activeElement?.outerHTML.slice(0, 120), runtimeErrors: window.__ccErrors });
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });

    const attachButton = requireElement("#attachBtn");
    const attachTools = [...attachButton.parentElement.children];
    const permissionButton = requireElement("#permBtn");
    const attachIcon = attachButton.querySelector("svg path")?.getAttribute("d");
    const permissionIndex = attachTools.indexOf(permissionButton);
    const attachIndex = attachTools.indexOf(attachButton);
    const inputIndex = attachTools.indexOf($("attachInput"));
    const spacerIndex = attachTools.findIndex((element) => element.classList.contains("spacer"));
    const attachBeforePermission = attachIndex === 0 && inputIndex === 1 && permissionIndex === 2 && attachIndex < permissionIndex && permissionIndex < spacerIndex;
    check("Attach precedes the permission pill and keeps its file input", attachBeforePermission && attachIcon === "M13.2 7.4 8 12.6a3.3 3.3 0 0 1-4.7-4.7l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1L6.5 11a1.1 1.1 0 0 1-1.6-1.6l4.7-4.7" && attachButton.textContent.trim() === "Attach" && $("attachInput").id === "attachInput" && permissionButton.classList.contains("perm") && Boolean(permissionButton.querySelector(".perm-dot,.perm-chevron")), { permissionIndex, attachIndex, inputIndex, spacerIndex, attachBeforePermission, attachIcon, buttonText: attachButton.textContent.trim(), inputId: $("attachInput").id, permissionContent: permissionButton.innerHTML });
    const safetyControls = () => document.querySelectorAll("#inboxList [data-unblock],#inboxList [data-release],#inboxList [data-retry-kill],#inboxList [data-ack-notice],#inboxList .safety-warning").length;
    const emptySafety = safetyControls() === 0 && $("inboxN").hidden;
    check("launch safety panel stays hidden when there is no safety action", emptySafety, { safetyControls: safetyControls(), inboxCount: $("inboxN").textContent, countHidden: $("inboxN").hidden });
    const nonCodexSafety = structuredClone(window.__latestState); nonCodexSafety.launchSafety = { blocked: ["alpha-dev.reviewer1"], uncertain: [], notices: [] };
    window.__ccDeliver({ ...nonCodexSafety, type: "state" });
    const nonCodexWarning = text("#inboxList .safety-warning");
    const reviewerName = tabOf("alpha-dev").crew.find((seat) => seat.slot === "reviewer1").name;
    const codexOnlySafety = structuredClone(window.__latestState); codexOnlySafety.launchSafety = { blocked: ["alpha-dev.coder"], uncertain: [], notices: [] };
    window.__ccDeliver({ ...codexOnlySafety, type: "state" });
    const codexOnlyWarning = text("#inboxList .safety-warning");
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    check("launch safety shows the Codex warning only when a non-Codex seat is involved", nonCodexWarning === `Only Codex seats can be held read-only. ${reviewerName} runs on Claude Code.` && !codexOnlyWarning, { nonCodexWarning, codexOnlyWarning, nonCodexSeatKey: "alpha-dev.reviewer1", codexSeatKey: "alpha-dev.coder" });

    const arrowTab = requireElement('#tabs [data-tab-id="alpha-dev"]');
    const selectCount = () => window.__sent.filter((message) => message.type === "selectTab").length;
    const selectStart = selectCount();
    arrowTab.focus(); arrowTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    try { await waitFor(() => window.__latestState?.selectedTabId === "alpha-design" && selectCount() > selectStart, "B2 keyboard tab selection", collectWaitTimeout); }
    catch (error) { if (!collectFailures) throw error; }
    const arrowSent = window.__sent.filter((message) => message.type === "selectTab").at(-1);
    const arrowSelected = selectCount() > selectStart && window.__latestState.selectedTabId === "alpha-design" && arrowSent?.tabId === "alpha-design";
    const arrowFocus = document.activeElement?.dataset.tabId === "alpha-design";
    check("tab arrows select the next tab and restore focus after re-render", arrowSelected && arrowFocus, { selectedTabId: window.__latestState.selectedTabId, focusedTabId: document.activeElement?.dataset.tabId, sent: arrowSent });
    await clickTab("Development");
    await waitFor(() => window.__latestState?.selectedTabId === "alpha-dev", "B2 return to Development tab");

    openSeatView("coder");
    let live = requireElement('#stagehead [data-run-view="live"]'); live.focus(); live.click();
    const liveFocus = document.activeElement?.dataset.runView === "live";
    const liveRunsShown = Boolean(document.querySelector('#view [data-run-tab="audit-parallel-1"]'));
    let history = requireElement('#stagehead [data-run-view="history"]'); history.focus(); history.click();
    const historyFocus = document.activeElement?.dataset.runView === "history";
    const historyRequest = window.__sent.filter((message) => message.type === "historyList").at(-1);
    const historyViewShown = text("#view .runs").includes("No runs yet.");
    requireElement('#stagehead [data-run-view="live"]').click();
    const runTab = requireElement('#view [data-run-tab="audit-parallel-2"]'); runTab.focus(); runTab.click();
    const runFocus = document.activeElement?.dataset.runTab === "audit-parallel-2";
    const selectedRunShown = requireElement('#view [data-run-tab="audit-parallel-2"]').getAttribute("aria-selected") === "true" && text('#view [data-output-run="audit-parallel-2"]') === "real runner output 2";
    const worker = entry.crew.find((seat) => seat.slot === "coder");
    const historyKey = worker.seatKey ?? "alpha-dev.coder";
    requireElement('#stagehead [data-run-view="history"]').click();
    window.__ccDeliver({ type: "historyList", seatKey: historyKey, runs: [{ timestamp: 1780000000123, label: "Focus history run", outcome: "done" }] });
    const historyRow = requireElement('#view [data-history-timestamp="1780000000123"]'); historyRow.focus(); historyRow.click();
    window.__ccDeliver({ type: "historyRun", seatKey: historyKey, timestamp: 1780000000123, output: "Focus history output", brief: "Focus test", outcome: "done" });
    const detailFocus = document.activeElement?.matches("[data-back-history]") === true;
    requireElement("#view [data-back-history]").focus(); requireElement("#view [data-back-history]").click();
    const returnFocus = document.activeElement?.matches('#stagehead [data-run-view="history"]') === true;
    check("worker Live, History, run, and history-return controls retain focus after re-render", liveFocus && historyFocus && runFocus && detailFocus && returnFocus && liveRunsShown && historyRequest?.seatKey === historyKey && historyViewShown && selectedRunShown, { liveFocus, historyFocus, runFocus, detailFocus, returnFocus, liveRunsShown, historyRequest, historyViewShown, selectedRunShown, selectedRunId: "audit-parallel-2", historyTimestamp: 1780000000123 });
    const firstRun = 1780000000201, secondRun = 1780000000202;
    window.__ccDeliver({ type: "historyList", seatKey: historyKey, runs: [{ timestamp: firstRun, outcome: "done" }, { timestamp: secondRun, outcome: "failed" }] });
    requireElement(`#view [data-history-timestamp="${firstRun}"]`).click();
    requireElement(`#view [data-history-timestamp="${secondRun}"]`).click();
    const rapidRequests = window.__sent.filter((message) => message.type === "historyRun").slice(-2).map((message) => message.timestamp);
    window.__ccDeliver({ type: "historyRun", seatKey: historyKey, timestamp: secondRun, output: "Second run output", brief: null, totalBytes: 22, outcome: { status: "failed", exitCode: 2 } });
    window.__ccDeliver({ type: "historyRun", seatKey: historyKey, timestamp: firstRun, output: "First run output", brief: null, totalBytes: 11, outcome: { status: "done", exitCode: 0 } });
    const rapidOutput = text("#view .term pre"), rapidMeta = text("#view .metarow");
    const secondDate = new Date(secondRun).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const staleIgnored = rapidOutput === "Second run output" && rapidMeta.includes("failed") && rapidMeta.includes("exit 2") && rapidMeta.includes("22 B") && rapidMeta.includes(secondDate);
    requireElement("#view [data-back-history]").click();
    requireElement(`#view [data-history-timestamp="${firstRun}"]`).click();
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    const staleNotCached = !document.querySelector("#view .term pre") && Boolean(document.querySelector(`#view [data-history-timestamp="${firstRun}"]`));
    window.__ccDeliver({ type: "historyRun", seatKey: historyKey, timestamp: firstRun, output: "First run output", brief: null, totalBytes: 11, outcome: { status: "done", exitCode: 0 } });
    const firstShownWhenCurrent = text("#view .term pre") === "First run output";
    check("History matches out-of-order historyRun replies by seat and timestamp and ignores stale ones", rapidRequests.join() === `${firstRun},${secondRun}` && staleIgnored && staleNotCached && firstShownWhenCurrent, { rapidRequests, rapidOutput, rapidMeta, expectedDate: secondDate, staleNotCached, firstShownWhenCurrent });
    requireElement("#view [data-back-history]").click();

    requireElement('#stagehead [data-run-view="live"]').click();
    const xssRunState = structuredClone(window.__ccSeed);
    tabOf("alpha-dev", xssRunState).runs.find((run) => run.runId === "audit-parallel-1").output = xssText;
    window.__ccDeliver({ ...xssRunState, type: "state" });
    requireElement('#view [data-run-tab="audit-parallel-1"]').click();
    const xssRunOutput = requireElement('#view [data-output-run="audit-parallel-1"]');
    const literalRunOutput = xssRunOutput.textContent === xssText && xssRunOutput.childElementCount === 0 && !window.__ccErrors.includes("escaped text ran as HTML");
    check("XSS-shaped run output stays visible literal text", literalRunOutput, { text: xssRunOutput.textContent, childCount: xssRunOutput.childElementCount, xssErrors: window.__ccErrors.filter((error) => error.includes("escaped text")) });
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });

    showChat();
    const approvalState = structuredClone(window.__latestState); const approvalTab = tabOf("alpha-dev", approvalState);
    approvalTab.processState.approval = { state: "pending" };
    approvalTab.processState.currentStepIndex = 0;
    approvalTab.derived.stepBar = [{ stepId: "look", state: "current", owners: ["user"], label: "Your look" }];
    approvalTab.crew.find((seat) => seat.isLeader).status = "waiting";
    window.__ccDeliver({ ...approvalState, type: "state" });
    const status = text("#statusBtn .pill");
    const approvalCard = text("#view .ask .h");
    const screenshotAction = document.querySelector('#view [data-open-screenshots]');
    requireElement("#view [data-ask-changes]").click();
    const changesFocused = document.activeElement === $("ci") && $("ci").value.startsWith("Please make these changes:");
    requireElement('#view [data-process-action="approveLook"]').click();
    const approveRequest = window.__sent.filter((message) => message.type === "approveLook").at(-1);
    check("approval card exposes the real approve action and prefilled changes", status === "Waiting on you: approve the look" && approvalCard.includes("approve the look") && !screenshotAction && changesFocused && approveRequest?.tabId === "alpha-dev", { status, approvalCard, screenshotsAvailable: Boolean(screenshotAction), changesFocused, approveRequest });

    $("setBtn").click(); requireElement('#setModal[aria-hidden="false"]');
    const navItems = [...document.querySelectorAll("#setNav [data-settings-section]")].map((button) => button.textContent.trim());
    requireElement('#setNav [data-settings-section="behaviour"]').click();
    const initialNotifications = requireElement('#setBody [data-setting="notificationsEnabled"]').getAttribute("aria-checked");
    const initialBell = requireElement('#setBody [data-setting="bellEnabled"]').getAttribute("aria-checked");
    const retrySwitchGone = !document.querySelector('#setBody [data-setting="autoRelaunch"]') && !/Retry stalled runs/.test($("setBody").textContent);
    const sectionsPresent = navItems.join("|") === "Crew and models|AI tools|ACP CLIs|GitHub|Notes vault|Folders|Skills and MCP|Appearance|Behaviour";
    requireElement('#setNav [data-settings-section="appearance"]').click();
    requireElement('#setModal [data-theme="light"]').click();
    await waitFor(() => window.__latestState.clientPrefs?.theme === "light", "the server keeps the light theme");
    const storedTheme = window.__latestState.clientPrefs?.theme;
    const themeApplied = document.body.classList.contains("light") && storedTheme === "light";
    requireElement('#setNav [data-settings-section="behaviour"]').click();
    const behaviourTargets = ["[data-setting=notificationsEnabled]", "[data-setting=bellEnabled]"].map((selector) => `#setBody ${selector}`);
    const missingBehaviour = behaviourTargets.filter((selector) => !document.querySelector(selector));
    check("Settings includes every mockup section and retains Behaviour defaults", sectionsPresent && initialNotifications === "true" && initialBell === "false" && retrySwitchGone && themeApplied && missingBehaviour.length === 0, { navItems, initialNotifications, initialBell, retrySwitchGone, themeApplied, serverTheme: storedTheme, storageBlocked: window.__ccStorageBlocked, found: behaviourTargets.filter((selector) => document.querySelector(selector)), missing: missingBehaviour });
    const prefBefore = window.__sent.length;
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const notificationsOff = window.__sent.slice(prefBefore).find((message) => message.type === "updateClientPref" && message.key === "notificationsEnabled" && message.value === false);
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const notificationsOn = window.__sent.slice(prefBefore).find((message) => message.type === "updateClientPref" && message.key === "notificationsEnabled" && message.value === true);
    requireElement('#setBody [data-setting="bellEnabled"]').click();
    const bellRequest = window.__sent.filter((message) => message.type === "updateClientPref" && message.key === "bellEnabled").at(-1);
    check("Behaviour switches send the selected values through the server protocol", notificationsOff?.tabId === undefined && notificationsOff?.value === false && notificationsOn?.value === true && bellRequest?.value === true && window.__latestState.clientPrefs.notificationsEnabled === true && window.__latestState.clientPrefs.bellEnabled === true, { notificationsOff, notificationsOn, bellRequest, serverPrefs: window.__latestState.clientPrefs });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("Settings closes and restores focus to its opener", $("setModal").hidden && document.activeElement === $("setBtn"), { closed: $("setModal").hidden, focused: document.activeElement?.id ?? "missing" });

    $("setBtn").click(); requireElement('#setModal[aria-hidden="false"]');
    requireElement('#setNav [data-settings-section="behaviour"]').click();
    const settingSocket = window.__socket;
    const serverNotifications = String(window.__latestState.clientPrefs?.notificationsEnabled ?? true);
    const notificationSwitch = () => requireElement('#setBody [data-setting="notificationsEnabled"]').getAttribute("aria-checked");
    const failedPrefStart = window.__sent.length;
    settingSocket.readyState = 3;
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const prefRolledBack = notificationSwitch() === serverNotifications && !window.__sent.slice(failedPrefStart).some((message) => message.type === "updateClientPref");
    const prefErrorVisible = await waitToastVisible();
    settingSocket.readyState = 1;
    const droppedInTransit = [];
    settingSocket.send = (raw) => { droppedInTransit.push(JSON.parse(raw)); };
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const optimisticShown = notificationSwitch() !== serverNotifications;
    delete settingSocket.send;
    const reconnectStart = window.__received.length;
    settingSocket.emit("open", {});
    await waitFor(() => window.__received.slice(reconnectStart).some((message) => message.type === "state"), "state after Settings reconnect");
    const afterReconnect = notificationSwitch();
    const bellAfterReconnect = requireElement('#setBody [data-setting="bellEnabled"]').getAttribute("aria-checked");
    const matchesServer = afterReconnect === serverNotifications && afterReconnect === String(window.__latestState.clientPrefs?.notificationsEnabled ?? true) && bellAfterReconnect === String(window.__latestState.clientPrefs?.bellEnabled ?? false);
    check("a failed Settings send rolls back with an error and reconnect shows the server's value", prefRolledBack && prefErrorVisible && optimisticShown && droppedInTransit[0]?.key === "notificationsEnabled" && matchesServer, { serverNotifications, prefRolledBack, prefErrorVisible, optimisticShown, droppedInTransit, afterReconnect, bellAfterReconnect, serverAfterReconnect: window.__latestState.clientPrefs });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    openSeatView("coder"); requireElement("#stagehead [data-run-seat]").click();
    const keptBrief = "Keep this brief when the send fails";
    $("runPrompt").value = keptBrief; $("runPrompt").dispatchEvent(new Event("input", { bubbles: true }));
    const runSocket = window.__socket; const runCount = () => window.__sent.filter((message) => message.type === "run").length;
    const runsBefore = runCount();
    runSocket.readyState = 3;
    $("runStart").click();
    const runKeptOpen = !$("runModal").hidden && $("runPrompt").value === keptBrief && runCount() === runsBefore;
    const runErrorVisible = await waitToastVisible();
    runSocket.readyState = 1;
    $("runStart").click();
    const retriedRun = window.__sent.filter((message) => message.type === "run").at(-1);
    const runClosedAfterSend = $("runModal").hidden && runCount() === runsBefore + 1 && retriedRun?.prompt === keptBrief && retriedRun.slot === "coder";
    check("Run dialog keeps the brief and shows an error when the send fails, then closes after a successful send", runKeptOpen && runErrorVisible && runClosedAfterSend, { runKeptOpen, runErrorVisible, runClosedAfterSend, retriedRun, prompt: $("runPrompt").value });
    showChat();

    const leader = entry.crew.find((seat) => seat.isLeader || seat.slot === "leader");
    const leaderKey = leader.seatKey ?? "alpha-dev.leader";
    requireElement('[data-session-action="history"]', openChatMenu()).click();
    const leaderHistory = window.__sent.filter((message) => message.type === "historyList").at(-1);
    const leaderHistoryView = document.querySelector("#view .runs") !== null;
    requireElement('#view [data-session-action="chat"]').click();
    check("leader History requests saved files for the leader seat and returns to chat", leaderHistory?.seatKey === leaderKey && leaderHistoryView && Boolean(document.querySelector("#view .thread")), { requested: leaderHistory, expectedSeatKey: leaderKey, historyView: leaderHistoryView, returnedToChat: Boolean(document.querySelector("#view .thread")) });

    // The context meter lives in the chat's ⋯ menu; each reading opens it fresh after the state arrives.
    const contextReading = () => { const value = text("[data-context-meter]", openChatMenu()); pressEscape(); return value; };
    const noContext = structuredClone(window.__latestState); delete tabOf("alpha-dev", noContext).leaderUsage;
    window.__ccDeliver({ ...noContext, type: "state" });
    const unmeasured = contextReading();
    const hiddenContext = unmeasured.endsWith("not reported yet") && !unmeasured.includes("%");
    const measuredContext = structuredClone(noContext); tabOf("alpha-dev", measuredContext).leaderUsage = { contextTokens: 250, contextWindow: 1000 };
    window.__ccDeliver({ ...measuredContext, type: "state" });
    const context25 = contextReading();
    const clampedContext = structuredClone(measuredContext); tabOf("alpha-dev", clampedContext).leaderUsage = { contextTokens: 2000, contextWindow: 1000 };
    window.__ccDeliver({ ...clampedContext, type: "state" });
    const context100 = contextReading();
    const invalidContext = structuredClone(measuredContext); tabOf("alpha-dev", invalidContext).leaderUsage = { contextTokens: null, contextWindow: null };
    window.__ccDeliver({ ...invalidContext, type: "state" });
    const invalidReading = contextReading();
    const invalidContextHidden = invalidReading.endsWith("not reported yet") && !invalidReading.includes("NaN") && !invalidReading.includes("%");
    const at = Date.now();
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-dev", messages: [{ id: "saved-state-message", role: "user", text: "Unsaved message", at, revision: 10 }], revision: 10, savedRevision: 8 });
    const savedState = text("#sline [data-saved-state]");
    check("session row hides unmeasured or invalid context and shows a clamped one-decimal meter and saved time", hiddenContext && context25.endsWith("25.0% of 1k (estimate from the last turn)") && context100.endsWith("100.0% of 1k (estimate from the last turn)") && invalidContextHidden && /^Not saved since \d{1,2}:\d{2}$/.test(savedState), { unmeasured, hiddenContext, context25, context100, invalidReading, invalidContextHidden, savedState, sourceAt: at });

    window.__ccSaveDeferred = true;
    requireElement('#sline [data-session-action="save"]').click();
    const saveRequest = window.__sent.filter((message) => message.type === "save").at(-1);
    const progressShown = requireElement('#sline [data-session-action="save"]').disabled && text("#sline [data-saved-state]") === "Saving…";
    window.__socket.sendMessage({ type: "saved", tabId: "alpha-dev", revision: 10, savedRevision: 10 });
    const saveSuccess = text('#sline [data-saved-state]') === "Saved" && !requireElement('#sline [data-session-action="save"]').disabled;
    window.__ccSaveDeferred = false; window.__ccSaveError = true;
    requireElement('#sline [data-session-action="save"]').click();
    const saveFailureVisible = await waitToastVisible();
    const saveFailure = $("toast").textContent === "Save failed in the harness" && saveFailureVisible && !requireElement('#sline [data-session-action="save"]').disabled && text("#sline [data-saved-state]") === "Save failed";
    check("Save sends the tab, shows progress, handles success, and reports the matching error", saveRequest?.tabId === "alpha-dev" && progressShown && saveSuccess && saveFailure, { saveRequest, progressShown, saveSuccess, saveFailure, saveFailureVisible, errorToast: $("toast").textContent, errorMetadataExpected: { action: "save", tabId: "alpha-dev" } });
    window.__ccSaveError = false;

    const sentBeforeClear = window.__sent.filter((message) => message.type === "clear").length;
    let confirmAnswer = false; const confirms = [];
    // Clear asks in its own menu: "Clear chat" there sends, "Cancel" sends nothing.
    const clearChat = () => {
      requireElement('[data-session-action="clear"]', openChatMenu()).click();
      const asked = requireElement('#ctxPop[aria-hidden="false"]');
      if (asked.querySelector("[data-clear-confirm]")) confirms.push(text(".hint", asked));
      requireElement(confirmAnswer ? "[data-clear-confirm]" : "[data-clear-cancel]", asked).click();
    };
    clearChat();
    const cancelledClear = window.__sent.filter((message) => message.type === "clear").length === sentBeforeClear;
    confirmAnswer = true;
    clearChat();
    const clearRequest = window.__sent.filter((message) => message.type === "clear").at(-1);
    const clearedTranscript = document.querySelector("#view .empty-chat") !== null;
    const clearUndoVisibleImmediately = await waitToastVisible($("undo")) && Boolean($("undo").querySelector("[data-undo-clear]"));
    await holdClock.advance(9_999);
    const clearUndoVisibleBeforeDeadline = Boolean($("undo").querySelector("[data-undo-clear]") && toastVisible($("undo")));
    requireElement("#undo [data-undo-clear]").click();
    const undoRequest = window.__sent.filter((message) => message.type === "undoClear").at(-1);
    const chatRestoredClearsToast = $("undo").hidden && $("undo").inert && $("undo").getAttribute("aria-hidden") === "true" && !$("undo").classList.contains("on");
    const restoredMessages = [...document.querySelectorAll('#view [data-message-id="3"]')];
    const restoredExactlyOnce = restoredMessages.length === 1 && restoredMessages[0].textContent.includes("Before Clear");
    clearChat();
    const expiredUndoVisible = await waitToastVisible($("undo")) && Boolean($("undo").querySelector("[data-undo-clear]"));
    const clearTimerBeforeAdvance = holdClock.snapshot();
    await holdClock.advance(9_999);
    const expiredUndoAvailableBeforeDeadline = Boolean($("undo").querySelector("[data-undo-clear]") && toastVisible($("undo")));
    const clearTimerBeforeDeadline = holdClock.snapshot();
    await holdClock.advance(1);
    const expiredUndoGoneAtDeadline = !$("undo").querySelector("[data-undo-clear]");
    const clearTimerAfterDeadline = holdClock.snapshot();
    window.__ccUndoReject = "expired";
    clearChat();
    requireElement("#undo [data-undo-clear]").click();
    const rejectedUndoVisible = await waitToastVisible();
    const rejectedUndo = $("toast").textContent === "Undo expired" && rejectedUndoVisible;
    window.__ccDeliver({ type: "chatUndoRejected", tabId: "alpha-dev", reason: "unavailable" });
    const unavailableUndoVisible = await waitToastVisible();
    const unavailableUndo = $("toast").textContent === "This cleared chat is no longer available" && unavailableUndoVisible;
    check("Clear always confirms, clears the transcript, restores once within 10 seconds, and reports rejected Undo", confirms.length === 4 && cancelledClear && clearRequest?.tabId === "alpha-dev" && clearedTranscript && undoRequest?.tabId === "alpha-dev" && clearUndoVisibleImmediately && clearUndoVisibleBeforeDeadline && chatRestoredClearsToast && restoredExactlyOnce && expiredUndoVisible && expiredUndoAvailableBeforeDeadline && expiredUndoGoneAtDeadline && rejectedUndo && unavailableUndo, { confirmCalls: confirms, cancelledClear, clearRequest, clearedTranscript, undoRequest, clearUndoVisibleImmediately, clearUndoVisibleBeforeDeadline, chatRestoredClearsToast, restoredMessageCount: restoredMessages.length, restoredExactlyOnce, expiredUndoVisible, expiredUndoAvailableBeforeDeadline, expiredUndoGoneAtDeadline, remainingClearUndoTabs: [...document.querySelectorAll("#undo [data-undo-clear]")].map((button) => button.dataset.undoClear), undoTextAtDeadline: $("undo").textContent, clearTimerBeforeAdvance, clearTimerBeforeDeadline, clearTimerAfterDeadline, rejectedUndo, rejectedUndoVisible, unavailableUndo, unavailableUndoVisible, rejectionToast: $("toast").textContent });
    window.__ccUndoReject = "busy";
    clearChat();
    requireElement("#undo [data-undo-clear]").click();
    const busyToastVisible = await waitToastVisible();
    await waitFor(() => /try again when it is done/.test($("toast").textContent), "busy Undo refusal shown");
    const busyButtonBack = Boolean($("undo").querySelector("[data-undo-clear]")) && !$("undo").textContent.includes("Restoring chat");
    const busyToastText = $("toast").textContent;
    const undoSentBeforeRetry = window.__sent.filter((message) => message.type === "undoClear").length;
    window.__ccUndoReject = "";
    requireElement("#undo [data-undo-clear]").click();
    const busyRetrySent = window.__sent.filter((message) => message.type === "undoClear").length === undoSentBeforeRetry + 1;
    check("A busy Undo refusal puts the Undo button back with the reason, and Undo can be pressed again", busyToastVisible && busyButtonBack && /try again when it is done/.test(busyToastText) && busyRetrySent, { busyToastVisible, busyButtonBack, busyToastText, busyRetrySent });
    window.__ccUndoReject = "";

    window.__notified = []; window.__tones = 0; window.__ccFocused = true;
    Object.defineProperty(Document.prototype, "hasFocus", { configurable: true, value: () => window.__ccFocused });
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: class {
      static permission = "granted";
      static requestPermission() { return Promise.resolve("granted"); }
      constructor(title, options) { window.__notified.push({ title, body: options?.body ?? "" }); }
    } });
    // Recording wrapper at the far boundary: every node is a REAL OfflineAudioContext node (so the bell can be rendered and measured), with the contexts built, tones started, each tone's peak gain and length, and resume() calls recorded on top.
    window.__contexts = 0; window.__resumes = 0; window.__toneLog = []; window.__ctxs = []; window.__gains = []; window.__limiters = [];
    class AuditAudioContext {
      constructor() { window.__contexts++; window.__ctxs.push(this); this.currentTime = 0; this.state = "running"; this.fresh(); }
      fresh() { this.off = new OfflineAudioContext(1, 44100 * 3, 44100); this.destination = this.off.destination; }
      resume() { window.__resumes++; this.state = "running"; return Promise.resolve(); }
      createOscillator() {
        const osc = this.off.createOscillator(); const tone = { peak: 0, start: 0, stop: 0, freq: 0 }; window.__toneLog.push(tone);
        const connect = osc.connect.bind(osc); const start = osc.start.bind(osc); const stop = osc.stop.bind(osc);
        osc.connect = (target) => { target.tone = tone; tone.peak = Math.max(tone.peak, target.max); return connect(target); };
        osc.start = (at) => { window.__tones++; tone.start = at ?? 0; tone.freq = osc.frequency.value; return start(at); };
        osc.stop = (at) => { tone.stop = at ?? 0; return stop(at); };
        return osc;
      }
      createGain() {
        const node = this.off.createGain(); Object.assign(node, { tone: null, max: 0, targets: [] }); window.__gains.push(node);
        const connect = node.connect.bind(node); node.connect = (target) => { node.targets.push(target); return connect(target); };
        for (const method of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime"]) {
          const original = node.gain[method].bind(node.gain);
          node.gain[method] = (value, at) => { node.max = Math.max(node.max, value); if (node.tone) node.tone.peak = Math.max(node.tone.peak, value); return original(value, at); };
        }
        return node;
      }
      createDynamicsCompressor() {
        const node = this.off.createDynamicsCompressor(); Object.assign(node, { targets: [], isLimiter: true }); window.__limiters.push(node);
        const connect = node.connect.bind(node); node.connect = (target) => { node.targets.push(target); return connect(target); };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    window.AudioContext = AuditAudioContext;
    const notifyState = structuredClone(window.__ccSeed); const notifyTab = tabOf("alpha-dev", notifyState);
    notifyTab.processState.approval = { state: "none" };
    window.__ccDeliver({ ...notifyState, type: "state" });
    const notifyWorker = notifyTab.crew.find((seat) => seat.slot === "coder");
    const notifySeatKey = notifyWorker.seatKey ?? "alpha-dev.coder";
    const beforeRoutine = window.__notified.length;
    window.__ccDeliver({ type: "leaderLaunch", source: "Routine activity", seatName: "Coder", pending: false });
    const routineSilent = window.__notified.length === beforeRoutine;
    const beforeStart = { notified: window.__notified.length, tones: window.__tones };
    window.__ccDeliver({ type: "runStart", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-start", model: notifyWorker.model });
    // Settings and the sound popover promise a bell only when a seat finishes, fails or needs you: starting a worker is none of those.
    const launchSilent = window.__notified.length === beforeStart.notified && window.__tones === beforeStart.tones;
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-finish" });
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-fail", message: "Run failed" });
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-stall" });
    const workerNotifications = window.__notified.length;
    const workerTones = window.__tones;
    // The server marks a stop it made itself (a stalled run it restarts) internal: true, and a stop the user asked for internal: false. Neither rings or notifies: the page has no stop signal at all, so both are sent.
    window.__ccDeliver({ type: "runStop", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-internal-stop", outcome: "stopped", internal: true });
    const internalStopSilent = window.__notified.length === workerNotifications && window.__tones === workerTones;
    window.__ccDeliver({ type: "runStop", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-user-stop", outcome: "stopped", internal: false });
    const userStopSilent = window.__notified.length === workerNotifications && window.__tones === workerTones;
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 10, savedRevision: 8 });
    const focusedLeaderSilent = window.__notified.length === workerNotifications;
    window.__ccFocused = false;
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 10, savedRevision: 8 });
    const blurredLeaderNotified = window.__notified.length === workerNotifications + 1;
    const pendingState = structuredClone(window.__latestState); tabOf("alpha-dev", pendingState).processState.approval = { state: "pending" };
    window.__ccDeliver({ ...pendingState, type: "state" });
    const needsUserNotified = window.__notified.length === workerNotifications + 2;
    const repeatedPending = structuredClone(window.__latestState);
    window.__ccDeliver({ ...repeatedPending, type: "state" });
    const noRepeatedApproval = window.__notified.length === workerNotifications + 2;
    const enabledPolicy = routineSilent && launchSilent && workerNotifications === 3 && workerTones === 24 && internalStopSilent && userStopSilent && focusedLeaderSilent && blurredLeaderNotified && needsUserNotified && noRepeatedApproval;
    check("notification policy covers worker finish, failure, stall (never launch), focus, approval, routine noise, and both kinds of stop (the server's own internal stop and the user's)", enabledPolicy, { routineSilent, launchSilent, workerNotifications, workerTones, internalStopSilent, userStopSilent, focusedLeaderSilent, blurredLeaderNotified, needsUserNotified, noRepeatedApproval, notifications: window.__notified, tones: window.__tones });

    const noPending = structuredClone(window.__latestState); tabOf("alpha-dev", noPending).processState.approval = { state: "none" };
    window.__ccDeliver({ ...noPending, type: "state" });
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click();
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const noNotifications = window.__notified.length; const noSound = window.__tones;
    window.__ccDeliver({ type: "runStart", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "off-start" });
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "off-fail" });
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 11, savedRevision: 8 });
    const offPending = structuredClone(window.__latestState); tabOf("alpha-dev", offPending).processState.approval = { state: "pending" };
    window.__ccDeliver({ ...offPending, type: "state" });
    // The completion sound is its own switch now: with Notifications off, no desktop notice shows, but the chime still plays on the same events (a failed run, a finished reply, a look to approve) while the sound is on; a worker start is none of them.
    const soundSwitch = () => requireElement('#setBody [data-setting="bellEnabled"]');
    const offTones = window.__tones - noSound;
    const disabledPolicy = window.__notified.length === noNotifications && offTones === 24 && window.__latestState.clientPrefs.notificationsEnabled === false && window.__latestState.clientPrefs.bellEnabled === true
      && $("soundBtn").dataset.muted === "false" && soundSwitch().getAttribute("aria-checked") === "true" && !soundSwitch().disabled;
    check("disabling notifications blocks every desktop notice while the sound button keeps the chime on the same events", disabledPolicy, { disabledPolicy, notificationsBefore: noNotifications, notificationsAfter: window.__notified.length, offTones, soundMuted: $("soundBtn").dataset.muted, soundSwitch: soundSwitch().getAttribute("aria-checked"), soundSwitchDisabled: soundSwitch().disabled, serverPrefs: window.__latestState.clientPrefs });
    // The top-bar speaker opens the sound popover under it (Settings closes: the speaker is outside that dialog). Focus goes to its first
    // control; Escape, a press outside and a second click on the speaker close it, and focus comes back to the speaker.
    const soundPop = $("soundPop");
    const soundPopOpen = () => !soundPop.hidden && soundPop.getAttribute("aria-hidden") === "false" && soundPop.classList.contains("on") && $("soundBtn").getAttribute("aria-expanded") === "true";
    const soundPopClosed = () => soundPop.hidden && soundPop.getAttribute("aria-hidden") === "true" && $("soundBtn").getAttribute("aria-expanded") === "false";
    const openSoundPop = () => { if (soundPop.hidden) $("soundBtn").click(); return requireElement('#soundPop[aria-hidden="false"]'); };
    const flipSound = () => { openSoundPop(); $("soundSwitch").click(); pressEscape(); };
    const press = (element) => { element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); };
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const settingsOpenBefore = !$("setModal").hidden;
    $("soundBtn").click();
    const opened = { open: soundPopOpen(), settingsClosed: $("setModal").hidden, focus: document.activeElement?.id, pop: box(soundPop), speaker: box($("soundBtn")) };
    pressEscape();
    const escaped = { closed: soundPopClosed(), focus: document.activeElement?.id };
    $("soundBtn").click(); const reopened = soundPopOpen();
    press($("soundSwitch")); press($("soundVol"));
    const insideKeepsOpen = soundPopOpen();
    $("soundBtn").click(); const toggledShut = soundPopClosed();
    $("soundBtn").click(); press(requireElement("#view"));
    const outsideClosed = soundPopClosed();
    const placed = opened.pop.top >= opened.speaker.bottom && opened.pop.top - opened.speaker.bottom <= 12 && opened.pop.left >= 0 && opened.pop.right <= innerWidth && opened.pop.bottom <= innerHeight && opened.pop.right >= opened.speaker.left && opened.pop.left <= opened.speaker.right;
    check("clicking the speaker opens the sound popover under it; Escape, a click outside and a second click close it", settingsOpenBefore && opened.open && opened.settingsClosed && opened.focus === "soundSwitch" && placed && escaped.closed && escaped.focus === "soundBtn" && reopened && insideKeepsOpen && toggledShut && outsideClosed, { settingsOpenBefore, opened, placed, escaped, reopened, insideKeepsOpen, toggledShut, outsideClosed });
    // The popover's switch is the sound switch: off silences every event, on plays a sample at the saved volume, and Settings shows the same value both ways.
    const soundIcons = () => [...document.querySelectorAll("#soundBtn svg")].filter((icon) => getComputedStyle(icon).display !== "none").map((icon) => icon.getAttribute("class"));
    // What Settings shows is read by opening it, as a person would (it draws from the pref when it opens).
    const settingsShows = () => { $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click(); const value = soundSwitch().getAttribute("aria-checked"); pressEscape(); return value; };
    const soundState = () => ({ muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), label: $("soundBtn").getAttribute("aria-label"), title: $("soundBtn").title, settings: settingsShows(), server: window.__latestState.clientPrefs.bellEnabled, icons: soundIcons() });
    const muteStart = window.__sent.length;
    flipSound();
    const muteRequest = window.__sent.slice(muteStart).find((message) => message.type === "updateClientPref" && message.key === "bellEnabled");
    const muted = soundState(); const mutedTones = window.__tones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "muted-fail" });
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 12, savedRevision: 8 });
    const mutedSilent = window.__tones === mutedTones;
    const unmuteStart = window.__sent.length;
    flipSound();
    const unmuteRequest = window.__sent.slice(unmuteStart).find((message) => message.type === "updateClientPref" && message.key === "bellEnabled");
    const unmuted = soundState(); const sampleTones = window.__tones - mutedTones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "unmuted-fail" });
    const unmutedRings = window.__tones - mutedTones === 16 && window.__notified.length === noNotifications;
    // Settings to the popover: the sound switched off in Settings shows off in the popover and on the speaker.
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click(); soundSwitch().click(); pressEscape();
    openSoundPop();
    const fromSettings = { popSwitch: $("soundSwitch").getAttribute("aria-checked"), muted: $("soundBtn").dataset.muted, server: window.__latestState.clientPrefs.bellEnabled };
    pressEscape();
    const soundSwitchWorks = muteRequest?.value === false && muted.muted === "true" && muted.popSwitch === "false" && muted.settings === "false" && muted.server === false && muted.title === "Completion sound: off" && mutedSilent && muted.icons.join() === "snd-off" && muted.label === "Completion sound" && unmuted.label === "Completion sound"
      && unmuteRequest?.value === true && unmuted.muted === "false" && unmuted.popSwitch === "true" && unmuted.settings === "true" && unmuted.server === true && unmuted.title === "Completion sound: on, 100%" && unmuted.icons.join() === "snd-on" && sampleTones === 8 && unmutedRings
      && fromSettings.popSwitch === "false" && fromSettings.muted === "true" && fromSettings.server === false;
    check("the sound popover's switch turns the completion chime off and on, in sync with Settings both ways", soundSwitchWorks, { muteRequest, muted, mutedSilent, unmuteRequest, unmuted, sampleTones, unmutedRings, fromSettings });
    // While the server's answer is still on its way the popover, the speaker and the Settings switch already agree, whichever was used.
    window.__ccHoldPrefEcho = true;
    const heldStart = window.__sent.length;
    openSoundPop(); $("soundSwitch").click();
    const heldPop = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked") };
    pressEscape();
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click();
    const heldSettingsOpened = soundSwitch().getAttribute("aria-checked");
    soundSwitch().click();
    const heldSettings = { settings: soundSwitch().getAttribute("aria-checked"), popSwitch: $("soundSwitch").getAttribute("aria-checked"), muted: $("soundBtn").dataset.muted };
    pressEscape();
    const heldSent = window.__sent.slice(heldStart).filter((message) => message.type === "updateClientPref" && message.key === "bellEnabled").map((message) => message.value);
    window.__ccHoldPrefEcho = false;
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const heldDone = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), settings: soundSwitch().getAttribute("aria-checked"), server: window.__latestState.clientPrefs.bellEnabled };
    // Another window changing the sound reaches the speaker and the popover through the server's state alone.
    window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, bellEnabled: true }, type: "state" });
    const fromState = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), settings: soundSwitch().getAttribute("aria-checked") };
    window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, bellEnabled: false }, type: "state" });
    const backFromState = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked") };
    check("the sound popover and the Settings switch agree before the server answers, from either one", heldPop.muted === "false" && heldPop.popSwitch === "true" && heldSettingsOpened === "true" && heldSettings.settings === "false" && heldSettings.popSwitch === "false" && heldSettings.muted === "true" && heldSent.join() === "true,false"
      && heldDone.muted === "true" && heldDone.popSwitch === "false" && heldDone.settings === "false" && heldDone.server === false && fromState.muted === "false" && fromState.popSwitch === "true" && fromState.settings === "true" && backFromState.muted === "true" && backFromState.popSwitch === "false",
      { heldPop, heldSettingsOpened, heldSettings, heldSent, heldDone, fromState, backFromState });
    // The beep must be audible: one shared audio context, a loud and long enough tone, resume() when the browser suspended it, silence when off.
    const beepStart = window.__toneLog.length; const beepTones = window.__tones; const gainsStart = window.__gains.length; const limitersStart = window.__limiters.length;
    flipSound(); // call site 1: turning the sound on plays the sample
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail" }); // call site 2: one notify() event
    const beeps = window.__toneLog.slice(beepStart);
    const resumesBefore = window.__resumes; window.__ctxs[0].state = "suspended";
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail-suspended" });
    await waitFor(() => window.__toneLog.length === beepStart + 24, "bell after resume");
    const resumedBell = window.__toneLog.slice(-8);
    flipSound(); // back off
    const offBeepTones = window.__tones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail-off" });
    // A bell is 2 strikes of 4 partials; per play: several distinct pitches, a ring of at least 1.2 s from the first strike's start, and master gain x summed first-strike partial levels >= 1.1 (the old sine blip was 0.2). The measured loudness is checked on the rendered audio below.
    const plays = [beeps.slice(0, 8), beeps.slice(8, 16), resumedBell];
    const masters = window.__gains.slice(gainsStart).filter((node) => node.targets.some((target) => target.isLimiter));
    const bellLimiters = window.__limiters.slice(limitersStart);
    const reachesDestination = (node, seen = new Set()) => !seen.has(node) && (seen.add(node), (node.targets ?? []).some((target) => target === window.__ctxs[0].destination || reachesDestination(target, seen)));
    const bellOk = plays.every((play, index) => {
      const master = masters[index];
      return play.length === 8 && new Set(play.map((tone) => tone.freq)).size >= 4 && Math.max(...play.map((tone) => tone.stop)) - play[0].start >= 1.2
        && master && master.gain.value * play.slice(0, 4).reduce((sum, tone) => sum + tone.peak, 0) >= 1.1;
    }) && masters.length === 3 && bellLimiters.length === 3 && bellLimiters.every((node) => reachesDestination(node));
    const beepOk = window.__tones - beepTones === 24 && beeps.length === 16 && window.__contexts === 1 && bellOk
      && window.__resumes - resumesBefore === 1 && window.__tones === offBeepTones;
    check("the completion bell reuses one audio context, rings several partials for over a second through a limiter at full level, resumes a suspended context, and is silent when off", beepOk, { contexts: window.__contexts, plays, masterLevels: masters.map((node) => node.gain.value), limiters: bellLimiters.length, resumes: window.__resumes - resumesBefore, tonesAfterOff: window.__tones - offBeepTones, tonesPlayed: window.__tones - beepTones });
    // Measured, not read: the real playCompletionSound renders offline through the real nodes, and the audio itself is measured (the planner's numbers: peak -1..-0.1 dBFS, RMS of the first 0.5 s >= -9 dBFS, two onsets 0.35-0.6 s apart each rising >= 9 dB, several spectral peaks with a bright one).
    const renderCtx = window.__ctxs[0]; renderCtx.fresh();
    flipSound(); // turning the sound on plays the sample into the fresh offline graph
    // Awaited through the network barrier (waitFor), never bare: the seed's working runs keep a 1 s ticker going, and a bare await lets headless
    // Chrome's virtual clock run through those ticks to its whole budget, which ends the audit early with no error.
    let renderedBuffer = null;
    renderCtx.off.startRendering().then((buffer) => { renderedBuffer = buffer; });
    await waitFor(() => renderedBuffer, "the offline render of the bell");
    const samples = renderedBuffer.getChannelData(0);
    flipSound(); // back off
    const rate = 44100; const toDb = (value) => 20 * Math.log10(Math.max(value, 1e-6));
    const rmsOf = (from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += samples[i] * samples[i]; return Math.sqrt(sum / (to - from)); };
    let peakValue = 0; for (const value of samples) peakValue = Math.max(peakValue, Math.abs(value));
    const envelope = []; for (let i = 0; i + 441 <= samples.length; i += 441) envelope.push(toDb(rmsOf(i, i + 441)));
    const onsets = [];
    for (let i = 2; i < envelope.length; i++) {
      const rise = envelope[i] - envelope[i - 2];
      if (envelope[i] > -40 && rise >= 9) { if (!onsets.length || i - onsets.at(-1).window > 6) onsets.push({ window: i, at: i * 0.01, rise }); else onsets.at(-1).rise = Math.max(onsets.at(-1).rise, rise); }
    }
    const from = Math.round(0.01 * rate); const length = Math.round(0.19 * rate);
    const magnitudes = []; // Hann-windowed Goertzel scan of the first strike, 500 Hz to 8 kHz in 25 Hz steps
    for (let freq = 500; freq <= 8000; freq += 25) {
      const coefficient = 2 * Math.cos(2 * Math.PI * freq / rate); let s1 = 0; let s2 = 0;
      for (let i = 0; i < length; i++) { const s0 = samples[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1))) + coefficient * s1 - s2; s2 = s1; s1 = s0; }
      magnitudes.push({ freq, level: Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2) });
    }
    const topLevel = Math.max(...magnitudes.map((entry) => entry.level));
    const spectralPeaks = magnitudes.filter((entry, i) => i > 0 && i < magnitudes.length - 1 && entry.level > magnitudes[i - 1].level && entry.level > magnitudes[i + 1].level && entry.level >= topLevel * 0.0178).map((entry) => ({ freq: entry.freq, db: toDb(entry.level / topLevel) }));
    const strongest = magnitudes.find((entry) => entry.level === topLevel).freq;
    const rendered = { peakDb: toDb(peakValue), rms500Db: toDb(rmsOf(0, rate / 2)), onsets, spectralPeaks, strongest };
    const renderedOk = rendered.peakDb >= -1 && rendered.peakDb <= -0.1 && rendered.rms500Db >= -9
      && onsets.length === 2 && onsets[1].at - onsets[0].at >= 0.35 && onsets[1].at - onsets[0].at <= 0.6 && onsets[1].rise >= 9
      && spectralPeaks.length >= 3 && strongest >= 1500 && strongest <= 2500 && spectralPeaks.some((entry) => entry.freq >= 3000);
    check("the rendered completion bell is loud (peak just under full scale, strong first half second), rings clearly twice with a fresh attack, and is a bell, not a single sine", renderedOk, rendered);
    // The volume slider (the sound is off here): the percent follows the thumb while it is dragged, a state redraw never pulls it back,
    // and the pref is sent once, when it is let go.
    renderCtx.fresh(); // a live graph again: the rendered one is finished
    const slider = $("soundVol");
    const volumeSent = (start) => window.__sent.slice(start).filter((message) => message.type === "updateClientPref" && message.key === "bellVolume").map((message) => message.value);
    const slide = (value, event = "input") => { slider.value = String(value); slider.dispatchEvent(new Event(event, { bubbles: true })); };
    openSoundPop();
    const slideStart = window.__sent.length;
    const atOpen = { value: slider.value, shown: text("#soundVolOut"), min: slider.min, max: slider.max, step: slider.step, label: slider.labels?.[0]?.textContent?.trim(), server: window.__latestState.clientPrefs.bellVolume };
    for (const value of [90, 70, 50, 30]) slide(value);
    const dragging = { shown: text("#soundVolOut"), fill: slider.style.getPropertyValue("--v"), sent: volumeSent(slideStart).length };
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" }); // a state redraw arrives mid-drag
    const afterRedraw = { value: slider.value, shown: text("#soundVolOut") };
    slider.dispatchEvent(new Event("change", { bubbles: true })); // let go
    const letGo = { sent: volumeSent(slideStart), server: window.__latestState.clientPrefs.bellVolume, value: slider.value, shown: text("#soundVolOut") };
    check("the volume slider shows its percent while dragged, keeps it through a state redraw, and sends the pref once when let go",
      atOpen.value === "100" && atOpen.shown === "100%" && atOpen.server === 100 && atOpen.min === "0" && atOpen.max === "100" && atOpen.step === "1" && atOpen.label === "Volume"
      && dragging.shown === "30%" && dragging.fill === "0.3" && dragging.sent === 0 && afterRedraw.value === "30" && afterRedraw.shown === "30%"
      && letGo.sent.join() === "30" && letGo.server === 30 && letGo.value === "30" && letGo.shown === "30%", { atOpen, dragging, afterRedraw, letGo });
    // Test plays one bell now at the slider's level, even before it is let go and while the sound is off, and saves nothing. The full level is measured
    // the same way (a Test at 100) rather than written down here. Gains are 32-bit floats, so ratios are compared to within 1e-6.
    const masterLevels = (start) => window.__gains.slice(start).filter((node) => node.targets.some((target) => target.isLimiter)).map((node) => node.gain.value);
    const testAt = (value) => { const gains = window.__gains.length, tones = window.__tones, sent = window.__sent.length; slide(value); $("soundTest").click(); return { tones: window.__tones - tones, masters: masterLevels(gains), sent: window.__sent.slice(sent).filter((message) => message.type === "updateClientPref") }; };
    const full = testAt(100);
    pressEscape(); openSoundPop();
    const reopenedAt = { value: slider.value, shown: text("#soundVolOut") }; // the 100 never let go of is dropped
    const tested = testAt(60);
    pressEscape();
    const testRatio = tested.masters[0] / full.masters[0];
    check("Test plays one bell at the slider's level, before it is let go and while the sound is off, and saves nothing",
      full.tones === 8 && full.masters.length === 1 && reopenedAt.value === "30" && reopenedAt.shown === "30%" && tested.tones === 8 && tested.masters.length === 1 && Math.abs(testRatio - 0.6) < 1e-6
      && full.sent.length === 0 && tested.sent.length === 0 && window.__latestState.clientPrefs.bellEnabled === false && window.__latestState.clientPrefs.bellVolume === 30,
      { full, reopenedAt, tested, testRatio, prefs: window.__latestState.clientPrefs });
    // Every bell follows the saved volume: a notify bell at 30% has 0.3 of the full master level, at 100% all of it, and 0% plays nothing.
    const notifyAt = (runId) => { const gains = window.__gains.length, tones = window.__tones; window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId }); return { tones: window.__tones - tones, masters: masterLevels(gains) }; };
    flipSound(); // on, at the saved 30%
    const at30 = notifyAt("volume-30");
    openSoundPop(); slide(100); slide(100, "change"); pressEscape();
    const at100 = notifyAt("volume-100");
    openSoundPop(); slide(0); slide(0, "change");
    const zeroLook = { muted: $("soundBtn").dataset.muted, title: $("soundBtn").title, icons: soundIcons(), server: window.__latestState.clientPrefs.bellVolume };
    const zeroTest = testAt(0);
    pressEscape();
    const at0 = notifyAt("volume-0");
    openSoundPop(); slide(100); slide(100, "change"); pressEscape(); flipSound(); // back to the full level, sound off
    const notifyRatio = at30.masters[0] / at100.masters[0];
    check("every bell follows the saved volume: 30% is 0.3 of the full master level, 0% plays nothing, and the speaker shows muted at 0%",
      at30.tones === 8 && at100.tones === 8 && Math.abs(notifyRatio - 0.3) < 1e-6 && Math.abs(at100.masters[0] / full.masters[0] - 1) < 1e-6
      && zeroLook.muted === "true" && zeroLook.title === "Completion sound: on, 0%" && zeroLook.icons.join() === "snd-off" && zeroLook.server === 0 && zeroTest.tones === 0 && at0.tones === 0
      && window.__latestState.clientPrefs.bellVolume === 100 && window.__latestState.clientPrefs.bellEnabled === false && $("soundBtn").dataset.muted === "true",
      { at30, at100, notifyRatio, zeroLook, zeroTest, at0, prefs: window.__latestState.clientPrefs });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    // Unread: a finished reply in a project that is not shown dots that project's tab and says "unread"; one in the shown project, or a user message, does not; opening the project clears it.
    const unreadDot = (projectId) => document.querySelector(`#ptabs [data-project-id="${projectId}"] .pdot.unread`);
    const shownTab = window.__latestState.selectedTabId;
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Reply in the shown project", revision: 40, at: Date.now() });
    const shownNoDot = shownTab === "alpha-dev" && !unreadDot("alpha");
    window.__ccDeliver({ type: "chatMessage", tabId: "beta-dev", role: "user", text: "A message sent from elsewhere", revision: 40, at: Date.now() });
    const userNoDot = !unreadDot("beta");
    window.__ccDeliver({ type: "chatMessage", tabId: "beta-dev", role: "assistant", text: "A reply in the background", revision: 41, at: Date.now() });
    const betaDot = unreadDot("beta"), betaRect = betaDot?.getBoundingClientRect();
    const colourOf = (variable) => { const probe = document.createElement("i"); probe.style.background = "var(" + variable + ")"; document.body.append(probe); const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour; };
    const unreadColour = betaDot ? getComputedStyle(betaDot).backgroundColor : "";
    const betaMarked = Boolean(betaDot && betaRect.width > 0 && betaRect.height > 0 && betaDot.getAttribute("role") === "img" && betaDot.getAttribute("aria-label") === "unread" && / · unread$/.test(requireElement('#ptabs [data-project-id="beta"]').title)
      && unreadColour === colourOf("--accent") && unreadColour !== colourOf("--waiting"));
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    const survivesState = Boolean(unreadDot("beta"));
    pickProject("beta");
    await waitFor(() => window.__latestState.selectedTabId === "beta-dev", "the background project opened");
    const clearedOnOpen = !unreadDot("beta") && !unreadDot("alpha");
    // The same revision again (a resync) is not a new reply: alpha's revision 40 was delivered above, while alpha was shown.
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Reply in the shown project", revision: 40, at: Date.now() });
    const repeatNoDot = !unreadDot("alpha");
    window.__ccDeliver({ type: "chatError", tabId: "alpha-dev", message: "The lead could not reply in the background" });
    const errorMarks = Boolean(unreadDot("alpha"));
    // A removed project takes its mark with it: when a project of that id returns, it comes back read.
    const fullState = structuredClone(window.__latestState), withoutAlpha = structuredClone(fullState);
    withoutAlpha.projects = withoutAlpha.projects.filter((project) => project.id !== "alpha");
    window.__ccDeliver({ ...withoutAlpha, type: "state" });
    const goneWhileRemoved = !unreadDot("alpha") && !document.querySelector('#ptabs [data-project-id="alpha"]');
    window.__ccDeliver({ ...fullState, type: "state" });
    const returnsRead = Boolean(document.querySelector('#ptabs [data-project-id="alpha"]')) && !unreadDot("alpha");
    pickProject("alpha");
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "the first project opened again");
    const clearedAgain = !unreadDot("alpha") && !unreadDot("beta");
    check("an unread reply in a project that is not shown dots its tab until that project is opened", shownNoDot && userNoDot && betaMarked && survivesState && clearedOnOpen && repeatNoDot && errorMarks && goneWhileRemoved && returnsRead && clearedAgain, { shownTab, shownNoDot, userNoDot, betaMarked, unreadColour, betaTitle: document.querySelector('#ptabs [data-project-id="beta"]')?.title, survivesState, clearedOnOpen, repeatNoDot, errorMarks, goneWhileRemoved, returnsRead, clearedAgain });

    // Theme, picture and dismissed runs are the server's: a state that carries them is what the page shows (the real different-port launch is the "looks-read" audit).
    const looksBase = structuredClone(window.__latestState);
    const withPrefs = (prefs) => ({ ...structuredClone(looksBase), clientPrefs: { ...looksBase.clientPrefs, ...prefs }, type: "state" });
    window.__ccDeliver(withPrefs({ theme: "dark", avatar: "sage.svg" }));
    const darkShown = !document.body.classList.contains("light") && requireElement('#themeTg [data-theme-toggle="dark"]').getAttribute("aria-checked") === "true" && $("meImg").getAttribute("src") === "/avatars/sage.svg";
    window.__ccDeliver(withPrefs({ theme: "light", avatar: "not-a-preset.svg" }));
    const lightShown = document.body.classList.contains("light") && $("meImg").getAttribute("src") === "/avatars/ash.svg";
    window.__ccDeliver(withPrefs({}));
    check("the page shows the theme and picture a state carries, and an unknown preset falls back to Ash", darkShown && lightShown, { darkShown, lightShown, shown: $("meImg").getAttribute("src"), light: document.body.classList.contains("light") });
    // Dismissing a failed run saves the list on the server; a state that lacks the dismissal shows the card again, one that has it hides it.
    const dismissBase = structuredClone(window.__latestState), failTab = tabOf("alpha-dev", dismissBase);
    const failedRun = (runId) => ({ runId, id: runId, status: "failed", seatIsLeader: false, crewGenerationId: failTab.processState?.crewGenerationId, seatName: "Coder", seatSlotId: "coder", seatKey: "alpha-dev.coder", label: "Build step", outcome: "failed", endedAt: Date.now() });
    failTab.runs = [...(failTab.runs ?? []), failedRun("dismiss-a"), failedRun("dismiss-b"), failedRun("dismiss-c")];
    const failState = (dismissedRuns) => ({ ...structuredClone(dismissBase), clientPrefs: { ...dismissBase.clientPrefs, dismissedRuns }, type: "state" });
    window.__ccDeliver(failState([]));
    const dismissCard = (runId) => document.querySelector('#inboxPop [data-dismiss-run="' + runId + '"]');
    openInbox();
    const bothShown = Boolean(dismissCard("dismiss-a") && dismissCard("dismiss-b"));
    const dismissStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-a"]').click();
    const dismissRequest = window.__sent.slice(dismissStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    await waitFor(() => (window.__latestState.clientPrefs?.dismissedRuns ?? []).includes("dismiss-a"), "the server keeps the dismissal");
    window.__ccDeliver(failState(dismissRequest.value)); // the fake server's echo carries no injected runs: this state is what a real server sends back
    const aGone = !dismissCard("dismiss-a") && Boolean(dismissCard("dismiss-b"));
    window.__ccDeliver(failState(["dismiss-b"]));
    const serverWins = Boolean(dismissCard("dismiss-a")) && !dismissCard("dismiss-b");
    // A dismissal for a run the server no longer lists can never come back as a card, so the next save drops it (and does not spend one of the 2000 on it).
    window.__ccDeliver(failState(Array.from({ length: 2000 }, (_, index) => "old-" + index)));
    const staleStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-c"]').click();
    const staleRequest = window.__sent.slice(staleStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    const prunedStale = JSON.stringify(staleRequest?.value) === JSON.stringify(["dismiss-c"]);
    // The saved list is capped at 2000 (the server refuses more; 50 finished runs a tab, so 40 tabs fit): with 2000 listed runs already dismissed, the 2001st drops the oldest.
    failTab.runs = [...failTab.runs, ...Array.from({ length: 2000 }, (_, index) => failedRun("cap-" + index))];
    window.__ccDeliver(failState(Array.from({ length: 2000 }, (_, index) => "cap-" + index)));
    const capStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-c"]').click();
    const capRequest = window.__sent.slice(capStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    const keptNewest = capRequest?.value.length === 2000 && capRequest.value.at(-1) === "dismiss-c" && capRequest.value[0] === "cap-1";
    window.__ccDeliver(withPrefs({}));
    pressEscape();
    check("Dismiss saves the run on the server, and the page hides exactly the runs the server lists", bothShown && Array.isArray(dismissRequest?.value) && dismissRequest.value.includes("dismiss-a") && aGone && serverWins && prunedStale && keptNewest, { bothShown, dismissRequest, aGone, serverWins, prunedStale, staleValue: staleRequest?.value, keptNewest, capLength: capRequest?.value.length, capFirst: capRequest?.value[0], capLast: capRequest?.value.at(-1) });

    $("meBtn").click();
    const personalChoices = document.querySelectorAll("#avgrid [data-avatar]").length;
    const personalUploadVisible = !$("avUpload").hidden;
    const avatarState = structuredClone(window.__latestState);
    window.__ccDeliver({ ...avatarState, type: "state" });
    requireElement('#avgrid [data-avatar="momo"]').click();
    pressEscape();
    const personalFocus = document.activeElement === $("meBtn");
    await waitFor(() => window.__latestState.clientPrefs?.avatar === "momo.svg", "the server keeps the chosen picture");
    const serverAvatar = window.__latestState.clientPrefs?.avatar;
    check("Your avatar has twenty presets, saves the choice to the server, and returns focus after a state re-render", personalChoices === 20 && personalUploadVisible && personalFocus && $("meImg").src.endsWith("/avatars/momo.svg") && serverAvatar === "momo.svg", { personalChoices, personalUploadVisible, personalFocus, avatar: $("meImg").src, serverAvatar });
    $("meBtn").click();
    // A picture over the server's 512 KiB cap is refused in plain words: nothing is sent and the old picture stays.
    const bigCanvas = document.createElement("canvas"); bigCanvas.width = bigCanvas.height = 400;
    const bigContext = bigCanvas.getContext("2d"), bigPixels = bigContext.createImageData(400, 400);
    for (let at = 0; at < bigPixels.data.length; at += 65536) crypto.getRandomValues(bigPixels.data.subarray(at, Math.min(at + 65536, bigPixels.data.length)));
    for (let at = 3; at < bigPixels.data.length; at += 4) bigPixels.data[at] = 255;
    bigContext.putImageData(bigPixels, 0, 0);
    const bigBlob = await new Promise((resolve) => bigCanvas.toBlob(resolve, "image/png"));
    const bigTransfer = new DataTransfer(); bigTransfer.items.add(new File([bigBlob], "huge.png", { type: "image/png" })); $("avUp").files = bigTransfer.files;
    const bigSentStart = window.__sent.length;
    $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /too large to keep/.test($("avatarStatus").textContent), "the oversized picture is refused");
    const bigRefused = window.__sent.slice(bigSentStart).every((message) => message.type !== "updateClientPref") && $("meImg").src.endsWith("/avatars/momo.svg") && $("avatarStatus").dataset.status === "failed" && /limit 512 KB/.test($("avatarStatus").textContent);
    check("a picture over 512 KB is refused in plain words, sends nothing and keeps the old picture", bigRefused && bigBlob.size > 400000, { blobBytes: bigBlob.size, status: $("avatarStatus").textContent, shown: $("meImg").src.slice(0, 40) });
    const uploadBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pHUAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    const avatarFile = new File([uploadBytes], "your-avatar.png", { type: "image/png" });
    const avatarTransfer = new DataTransfer(); avatarTransfer.items.add(avatarFile); $("avUp").files = avatarTransfer.files;
    $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => $("meImg").src.startsWith("blob:") && $("meImg").complete && $("meImg").naturalWidth === 1, "uploaded personal avatar shown");
    const uploadedAvatar = $("meImg").src.startsWith("blob:") && document.activeElement === $("meBtn");
    await waitFor(() => window.__latestState.clientPrefs?.avatar?.startsWith("data:image/png"), "the server keeps the uploaded picture");
    check("Your avatar upload stores the image data URL on the server and shows it through one short blob URL", uploadedAvatar && window.__latestState.clientPrefs.avatar.startsWith("data:image/png"), { shown: $("meImg").src.slice(0, 30), serverAvatar: window.__latestState.clientPrefs?.avatar?.slice(0, 22) });
    // The picture is referenced, not copied: a user message wears the same short blob URL, and no data URL is in the chat's or the top bar's HTML.
    window.__ccDeliver({ type: "chatMessage", tabId: window.__latestState.selectedTabId, role: "user", text: "picture check", revision: 9001, at: Date.now() });
    await waitFor(() => document.querySelector("#view .msg.mine .uav"), "a user message with the picture");
    const messagePic = document.querySelector("#view .msg.mine .uav").getAttribute("src");
    check("your uploaded picture is referenced once in each message, never copied into its HTML", messagePic === $("meImg").getAttribute("src") && messagePic.startsWith("blob:") && !$("view").innerHTML.includes("data:image") && !$("top").innerHTML.includes("data:image"), { messagePic: messagePic.slice(0, 40), meImg: $("meImg").getAttribute("src").slice(0, 40), dataUrlInChat: $("view").innerHTML.includes("data:image") });
    requireElement("[data-seat-picture]", openSeatCard("coder")).click(); requireElement('#avModal[aria-hidden="false"]');
    const seatChoices = document.querySelectorAll("#avgrid [data-avatar]").length; const seatUploadVisible = !$("avUpload").hidden;
    const seatAvatarStart = window.__sent.length;
    requireElement('#avgrid [data-avatar="ziggy"]').click();
    const seatAvatarRequest = window.__sent.slice(seatAvatarStart).find((message) => message.type === "updateSeat");
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    pressEscape();
    const seatAvatarFocus = document.activeElement?.matches('#view [data-seat-more="coder"]') === true;
    check("seat avatar presets and upload control render, send the selected picture and return focus after a state re-render", seatChoices === 20 && seatUploadVisible && seatAvatarRequest?.tabId === "alpha-dev" && seatAvatarRequest.slot === "coder" && seatAvatarRequest.pic === "avatars/ziggy.svg" && seatAvatarFocus, { seatChoices, seatUploadVisible, seatAvatarRequest, seatAvatarFocus, focusedSeat: document.activeElement?.getAttribute("aria-label") });

    showChat();
    const nativeArrayBuffer = Blob.prototype.arrayBuffer;
    const pendingReads = []; const imageBytes = new WeakMap(); const revokedUrls = [];
    const nativeFetch = window.fetch.bind(window); window.__ccImageUploads = [];
    window.fetch = (input, init) => {
      const request = nativeFetch(input, init);
      if (new URL(typeof input === "string" ? input : input.url, location.href).pathname === "/api/paste-image" && init?.method === "POST") {
        window.__ccImageUploads.push(request.then(async (response) => ({ status: response.status, path: (await response.clone().json()).path })).catch((error) => ({ error: String(error) })));
      }
      return request;
    };
    Blob.prototype.arrayBuffer = function () { return new Promise((resolve) => pendingReads.push({ file: this, resolve })); };
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revokedUrls.push(url); nativeRevoke(url); };
    const makeControlledImage = async (name) => {
      const file = new File([uploadBytes], name, { type: "image/png" });
      imageBytes.set(file, await nativeArrayBuffer.call(file));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => file }] } });
      $("ci").dispatchEvent(event);
      await waitFor(() => pendingReads.some((item) => item.file === file), `read start for ${name}`);
      return { file, read: pendingReads.find((item) => item.file === file), resolve() { const index = pendingReads.indexOf(this.read); if (index >= 0) pendingReads.splice(index, 1); this.read.resolve(imageBytes.get(file)); } };
    };
    const waitAttachmentReady = async (name) => {
      try {
        await waitFor(() => {
          const item = [...document.querySelectorAll("#atts .att")].find((node) => node.textContent.includes(name));
          return item && !item.querySelector("small");
        }, `uploaded attachment ${name}`, collectWaitTimeout);
        return true;
      } catch (error) {
        if (!collectFailures) throw error;
        return false;
      }
    };
    const waitImageUpload = async (index, name) => {
      try {
        await waitFor(() => window.__ccImageUploads.length > index, `image upload response for ${name}`, collectWaitTimeout);
        return await window.__ccImageUploads[index];
      } catch (error) {
        if (!collectFailures) throw error;
        return { error: String(error) };
      }
    };
    const attachmentNames = () => [...document.querySelectorAll("#atts .att")].map((node) => node.querySelector("span[title]")?.getAttribute("title"));
    const chatCountBeforeHeldTurn = window.__sent.filter((message) => message.type === "chat").length;
    window.__ccHoldChatDone = true;
    $("ci").value = "Hold this leader turn"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "held leader turn");
    const activeTurnImage = await makeControlledImage("active-turn.png");
    const activeTurnUploadIndex = window.__ccImageUploads.length;
    activeTurnImage.resolve();
    const activeTurnUpload = await waitImageUpload(activeTurnUploadIndex, "active-turn.png");
    await waitAttachmentReady("active-turn.png");
    $("ci").value = "Preserve this second draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const chatCountDuringHeldTurn = window.__sent.filter((message) => message.type === "chat").length;
    // Pack 12: while the leader replies Send queues the message (nothing is sent); the draft and its image move into the queue, the box is free again.
    const activeTurnButtonQueues = !$("sendBtn").disabled && $("sendBtn").getAttribute("aria-label") === "Queue message";
    $("sendBtn").click();
    await waitFor(() => document.querySelectorAll("#queue .qitem").length === 1, "the second draft is queued");
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondDraftAndImageQueued = $("ci").value === "" && attachmentNames().length === 0 && document.querySelectorAll("#queue .qitem").length === 1 && document.querySelector("#queue .qtext")?.textContent.includes("Preserve this second draft") && document.querySelector("#queue .qtext small")?.textContent === "active-turn.png";
    const activeTurnBlocked = chatCountDuringHeldTurn === chatCountBeforeHeldTurn + 1 && window.__sent.filter((message) => message.type === "chat").length === chatCountDuringHeldTurn && activeTurnButtonQueues && secondDraftAndImageQueued;
    check("active leader turn queues click and Enter without sending, and the next draft and image move into the queue", activeTurnBlocked, { chatCountBeforeHeldTurn, chatCountDuringHeldTurn, chatCountAfterRetry: window.__sent.filter((message) => message.type === "chat").length, activeTurnButtonQueues, draft: $("ci").value, attachments: attachmentNames(), queue: document.querySelector("#queue")?.textContent, upload: activeTurnUpload });
    [...document.querySelectorAll("#queue [data-queue-remove]")].forEach((button) => button.click()); // the queued message is not sent when the held turn ends
    window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));

    // (Returning to a tab reloads its history and drops its stream by design, so the background case holds that history back and reads the live stream first.)
    // A chatNotice that lands WHILE a reply is streaming (foreground tab, then a background tab) must leave the stream, the busy state, the draft and the attachment alone; only the real chatDone ends the turn.
    for (const where of ["foreground", "background"]) {
      const streamText = `Streaming through the ${where} notice`;
      const noticeText = `${where} old leader notice`;
      const streamShown = () => [...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent.includes(streamText));
      window.__ccHoldChatDone = true;
      $("ci").value = `Live reply, ${where} notice`; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
      await waitFor(() => typeof window.__ccPendingChatDone === "function", `held turn for the ${where} notice`);
      window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: streamText });
      const noticeImage = await makeControlledImage(`notice-${where}.png`);
      const noticeUploadIndex = window.__ccImageUploads.length;
      noticeImage.resolve();
      await waitImageUpload(noticeUploadIndex, `notice-${where}.png`);
      await waitAttachmentReady(`notice-${where}.png`);
      $("ci").value = `Draft kept through the ${where} notice`; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      const doneBeforeNotice = window.__received.filter((message) => message.type === "chatDone").length;
      if (where === "background") await clickTab("Design");
      window.__ccDeliver({ type: "chatNotice", tabId: "alpha-dev", message: noticeText });
      await waitFor(() => $("toast").textContent.includes(noticeText), `${where} notice toast`);
      if (where === "background") { window.__ccHoldHistory = true; await clickTab("Development"); }
      const survived = {
        stream: streamShown(), pending: typeof window.__ccPendingChatDone === "function",
        busy: !$("sendBtn").disabled && $("sendBtn").getAttribute("aria-label") === "Queue message", draft: $("ci").value, attachments: attachmentNames(),
        notEnded: window.__received.filter((message) => message.type === "chatDone").length === doneBeforeNotice,
      };
      const chatsBeforeRetry = window.__sent.filter((message) => message.type === "chat").length;
      $("sendBtn").click();
      $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Send during the live reply queues the message (nothing is sent); the queued one is removed again so the held turn's end sends nothing.
      survived.sendBlocked = window.__sent.filter((message) => message.type === "chat").length === chatsBeforeRetry && document.querySelectorAll("#queue .qitem").length === 1;
      [...document.querySelectorAll("#queue [data-queue-remove]")].forEach((button) => button.click());
      if (where === "background") {
        // Let the held history through, as a real return would.
        const held = window.__ccHeldHistory; window.__ccHoldHistory = false; window.__ccHeldHistory = null;
        if (held) window.__socket.sendMessage({ type: "chatHistory", ...held });
      }
      check(`a ${where} chatNotice during a live reply keeps the stream, the pending turn, the draft and the attachment`, survived.stream && survived.pending && survived.busy && survived.sendBlocked && survived.draft === `Draft kept through the ${where} notice` && survived.attachments.includes(`notice-${where}.png`) && survived.notEnded, survived);
      window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
      await waitFor(() => window.__received.filter((message) => message.type === "chatDone").length > doneBeforeNotice && !streamShown(), `${where} turn ends on its own chatDone`);
      [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
      $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    }

    window.__ccHoldChatDone = true;
    $("ci").value = "Complete this in the background"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "background leader turn");
    await clickTab("Design");
    const foregroundImage = await makeControlledImage("foreground-upload.png");
    const foregroundUploadIndex = window.__ccImageUploads.length;
    $("ci").value = "Foreground upload draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    const foregroundStatusBeforeCompletion = $("chatStatus").textContent;
    window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null;
    const foregroundStatusAfterCompletion = $("chatStatus").textContent;
    window.__ccDeliver({ type: "chatError", tabId: "alpha-dev", message: "background tab failed" });
    await waitToastVisible();
    const backgroundErrorNamesTab = $("toast").textContent.includes(latestTab("alpha-dev").name + ": background tab failed");
    const foregroundStatusAfterError = $("chatStatus").textContent;
    const backgroundStatusIsolated = foregroundStatusBeforeCompletion === "Loading file" && foregroundStatusAfterCompletion === "Loading file" && foregroundStatusAfterError === "Loading file" && !$("chatStatus").hidden && backgroundErrorNamesTab;
    check("background completion preserves foreground upload status and names background errors", backgroundStatusIsolated, { foregroundStatusBeforeCompletion, foregroundStatusAfterCompletion, foregroundStatusAfterError, backgroundErrorNamesTab, toast: $("toast").textContent, visibleTab: window.__latestState.selectedTabId });
    // A chat notice is about an old leader process: it shows its text and never ends, clears or fails the turn that is running.
    window.__ccDeliver({ type: "chatNotice", tabId: "alpha-dev", message: "old leader notice" });
    await waitFor(() => $("toast").textContent.includes(latestTab("alpha-dev").name + ": old leader notice"), "chat notice toast");
    check("a chat notice shows its text and leaves the foreground turn's status alone", $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden, { status: $("chatStatus").textContent, toast: $("toast").textContent });
    window.__ccHoldChatDone = false;
    foregroundImage.resolve();
    const foregroundUpload = await waitImageUpload(foregroundUploadIndex, "foreground-upload.png");
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-design" && message.text === "Foreground upload draft"), "foreground upload send");
    await waitFor(() => window.__received.some((message) => message.type === "chatDone" && message.tabId === "alpha-design"), "foreground upload chat completion");

    await clickTab("Development");
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const imageOnly = await makeControlledImage("image-only.png");
    const imageOnlyCount = window.__sent.filter((message) => message.type === "chat").length;
    const imageOnlyDisabledBeforeSend = $("sendBtn").disabled;
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const imageOnlyUploadIndex = window.__ccImageUploads.length;
    imageOnly.resolve();
    const imageOnlyUpload = await waitImageUpload(imageOnlyUploadIndex, "image-only.png");
    await waitFor(() => attachmentNames().includes("image-only.png") || window.__sent.filter((message) => message.type === "chat").length > imageOnlyCount, "image-only attachment stays queued or is sent unexpectedly");
    $("sendBtn").click();
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const imageOnlyRetained = window.__sent.filter((message) => message.type === "chat").length === imageOnlyCount && $("ci").value === "" && attachmentNames().includes("image-only.png") && $("sendBtn").disabled;
    check("image-only composer stays disabled and retains its image", imageOnlyRetained && imageOnlyDisabledBeforeSend, { imageOnlyRetained, disabledBeforeSend: imageOnlyDisabledBeforeSend, draft: $("ci").value, attachments: attachmentNames(), chatCountBefore: imageOnlyCount, chatCountAfter: window.__sent.filter((message) => message.type === "chat").length, upload: imageOnlyUpload });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());

    const initialSent = window.__sent.length;
    const permutationEvidence = [];
    const actionFor = (kind) => {
      if (kind === "tab") { clickMenuItem(openTabMenu("alpha-dev"), "Remove tab"); return { selector: "removeTab", tabId: "alpha-dev" }; }
      if (kind === "project") { clickMenuItem(openProjectMenu("alpha"), "Remove from Command Center"); return { selector: "removeProject", projectId: "alpha" }; }
      $("setupsBtn").click(); requireElement('#setupPop [data-set-process="solo"]').click(); return { selector: "setProcess", tabId: "alpha-dev" };
    };
    for (const kind of ["tab", "project", "process"]) for (const order of ["read-before-undo", "read-after-undo"]) {
      await clickTab("Development");
      const filename = `race-${kind}-${order}.png`;
      const controlled = await makeControlledImage(filename);
      const preview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes(filename))?.src ?? `pending:${filename}`;
      const actionStart = window.__sent.length;
      const held = actionFor(kind);
      const undoButton = requireElement("#undo [data-undo-held]");
      if (order === "read-before-undo") {
        const uploadIndex = window.__ccImageUploads.length;
        controlled.resolve();
        const result = await waitImageUpload(uploadIndex, filename);
        check(`attachment ${filename} upload completes before ${kind} Undo`, result.status === 200 && typeof result.path === "string", { kind, order, result });
      }
      if (order === "read-before-undo") check(`attachment preview stays live while ${kind} Undo is pending`, !revokedUrls.includes(preview), { kind, order, previewReleased: revokedUrls.includes(preview), filename });
      undoButton.click();
      if (order === "read-after-undo") {
        const uploadIndex = window.__ccImageUploads.length;
        controlled.resolve();
        const result = await waitImageUpload(uploadIndex, filename);
        check(`attachment ${filename} upload completes after ${kind} Undo`, result.status === 200 && typeof result.path === "string", { kind, order, result });
      }
      const correctTab = document.querySelector('#tabs [role="tab"][aria-selected="true"]')?.dataset.tabId === "alpha-dev";
      if (!correctTab) await clickTab("Development");
      const attachmentReady = await waitAttachmentReady(filename);
      const attached = [...document.querySelectorAll("#atts .att")].filter((node) => node.textContent.includes(filename));
      const actionSent = window.__sent.slice(actionStart).some((message) => message.type === held.selector && (held.tabId ? message.tabId === held.tabId : message.projectId === held.projectId));
      const nothingLostOrDuplicated = correctTab && attachmentReady && attached.length === 1 && !actionSent;
      permutationEvidence.push({ kind, order, correctTab, attachmentReady, attachmentCount: attached.length, actionSent, filename });
      check(`attachment ${filename} survives the ${kind} Undo in ${order}`, nothingLostOrDuplicated, permutationEvidence.at(-1));
      const url = attached[0]?.querySelector("img")?.src;
      const removeAttachment = document.querySelector("#atts [data-attachment] [data-remove-attachment]");
      if (removeAttachment) removeAttachment.click();
      else if (!collectFailures) requireElement("#atts [data-attachment] [data-remove-attachment]");
      const released = Boolean(url && revokedUrls.includes(url)) && document.querySelectorAll("#atts .att").length === 0;
      check(`removed completed attachment ${filename} releases its preview`, released, { url: url ?? "missing", released: Boolean(url && revokedUrls.includes(url)), remaining: document.querySelectorAll("#atts .att").length });
    }
    const xssFilename = '<img src=x onerror="window.__ccXss()">';
    const xssAttachment = await makeControlledImage(xssFilename);
    const xssUploadIndex = window.__ccImageUploads.length;
    xssAttachment.resolve();
    const xssUpload = await waitImageUpload(xssUploadIndex, "XSS-shaped attachment filename");
    await waitAttachmentReady(xssFilename);
    const xssFilenameNode = [...document.querySelectorAll("#atts .att > span[title]")].find((node) => node.getAttribute("title") === xssFilename);
    const xssFilenameLiteral = xssFilenameNode?.textContent === xssFilename && xssFilenameNode.childElementCount === 0 && !window.__ccErrors.includes("escaped text ran as HTML");
    check("XSS-shaped attachment filenames stay visible literal text", xssUpload.status === 200 && xssFilenameLiteral, { upload: xssUpload, renderedText: xssFilenameNode?.textContent ?? "missing", childCount: xssFilenameNode?.childElementCount ?? -1, xssErrors: window.__ccErrors.filter((error) => error.includes("escaped text")) });
    xssFilenameNode?.closest(".att")?.querySelector("[data-remove-attachment]")?.click();

    const releasedRead = await makeControlledImage("released-before-post.png");
    const uploadCountBeforeRelease = window.__ccImageUploads.length;
    const releasedAttachment = [...document.querySelectorAll("#atts .att")].find((node) => node.textContent.includes("released-before-post.png"));
    requireElement("[data-remove-attachment]", releasedAttachment).click();
    releasedRead.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("released attachments stop before POST when their file read finishes", window.__ccImageUploads.length === uploadCountBeforeRelease, { uploadsBefore: uploadCountBeforeRelease, uploadsAfter: window.__ccImageUploads.length, releasedPreview: revokedUrls.includes(releasedAttachment?.querySelector("img")?.src ?? "") });

    await clickTab("Development");
    showChat();
    const controlledSend = await makeControlledImage("sent-with-chat.png");
    const loadingShown = $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden;
    const chatCountBeforeFirstSend = window.__sent.filter((message) => message.type === "chat").length;
    const firstSendCompletionStart = window.__received.length;
    if (audit.mode === "fake") window.__ccChatMode = "hold";
    $("ci").value = "Send with an image"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const chatCountAfterClickAndEnter = window.__sent.filter((message) => message.type === "chat").length;
    const sendWaitsForImage = $("sendBtn").disabled && chatCountAfterClickAndEnter === chatCountBeforeFirstSend;
    check("chat waits for an in-flight image read before sending", sendWaitsForImage, { sendButtonDisabled: $("sendBtn").disabled, chatCountBeforeFirstSend, chatCountAfterClickAndEnter, loadingShown });
    const sendPreview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes("sent-with-chat.png"))?.src ?? "";
    const firstUploadIndex = window.__ccImageUploads.length;
    controlledSend.resolve();
    const sendUpload = await waitImageUpload(firstUploadIndex, "sent-with-chat.png");
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-dev" && message.text === "Send with an image"), "chat request with image");
    const imageChat = window.__sent.filter((message) => message.type === "chat" && message.text === "Send with an image").at(-1);
    const chatCountForFirstText = window.__sent.filter((message) => message.type === "chat" && message.text === "Send with an image").length;
    const imagePathSent = Array.isArray(imageChat?.images) && imageChat.images.length === 1 && imageChat.images[0] === sendUpload.path;
    const requestIdSafe = typeof imageChat?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(imageChat.requestId);
    const pendingComposerUnchanged = $("ci").value === "Send with an image" && $("ci").readOnly && $("attachBtn").disabled && $("sendBtn").disabled && Boolean(document.querySelector("#atts [data-remove-attachment]:disabled")) && Boolean(sendPreview && !revokedUrls.includes(sendPreview));
    check("client send guard covers click and Enter", sendWaitsForImage && chatCountAfterClickAndEnter === chatCountBeforeFirstSend && chatCountForFirstText === 1, { chatCountBeforeFirstSend, chatCountAfterClickAndEnter, chatCountForFirstText, sendButtonDisabled: $("sendBtn").disabled });
    check("pending send keeps text and attachments read-only until its request is answered", pendingComposerUnchanged && imagePathSent && requestIdSafe, { pendingComposerUnchanged, requestId: imageChat?.requestId, requestIdSafe, draft: $("ci").value, readOnly: $("ci").readOnly, attachDisabled: $("attachBtn").disabled, imageNames: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
    if (audit.mode === "fake") {
      window.__ccChatMode = null;
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 30, role: "user", text: "Send with an image", requestId: "other-window-request", images: imageChat?.images ?? [], at: Date.now() });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 31, role: "user", text: "Send with an image", images: imageChat?.images ?? [], at: Date.now() });
      const unrelatedEchoKeptPending = $("ci").value === "Send with an image" && $("ci").readOnly && $("sendBtn").disabled && attachmentNames().includes("sent-with-chat.png") && !revokedUrls.includes(sendPreview);
      check("chatMessage from another or legacy window cannot settle an identical draft", unrelatedEchoKeptPending, { unrelatedEchoKeptPending, draft: $("ci").value, readOnly: $("ci").readOnly, sendDisabled: $("sendBtn").disabled, attachments: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
      window.__ccDeliver({ type: "error", action: "chat", tabId: "alpha-dev", requestId: "another-send-id", message: "not this request" });
      const unrelatedErrorKeptPending = $("ci").value === "Send with an image" && $("ci").readOnly && $("sendBtn").disabled && attachmentNames().includes("sent-with-chat.png");
      check("chat error with another request id cannot settle this send", unrelatedErrorKeptPending, { unrelatedErrorKeptPending, draft: $("ci").value, readOnly: $("ci").readOnly, sendDisabled: $("sendBtn").disabled, attachments: attachmentNames() });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "user", text: "Send with an image", images: imageChat?.images ?? [], requestId: imageChat?.requestId, at: Date.now(), revision: 100 });
      const acceptedComposerCleared = $("ci").value === "" && !$("ci").readOnly && attachmentNames().length === 0 && Boolean(sendPreview && revokedUrls.includes(sendPreview));
      check("chatMessage with my request id accepts and consumes only that composer snapshot", acceptedComposerCleared, { acceptedComposerCleared, draft: $("ci").value, readOnly: $("ci").readOnly, attachments: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
      const activeCopy = structuredClone(window.__ccSeed);
      activeCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").derived.leaderTurnActive = true;
      window.__ccSeed = activeCopy; window.__ccDeliver({ ...activeCopy, type: "state" });
      window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: "The lead is answering." });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "The lead replied.", revision: 101, at: Date.now() });
      window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 101, savedRevision: 1 });
      const idleCopy = structuredClone(window.__ccSeed);
      idleCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").derived.leaderTurnActive = false;
      window.__ccSeed = idleCopy; window.__ccDeliver({ ...idleCopy, type: "state" });
    }
    check("chat sends the uploaded image path for the selected tab", imagePathSent && imageChat?.tabId === "alpha-dev", { imageChat, uploadedPath: sendUpload.path });
    if (!collectFailures || imagePathSent) {
      try { await waitFor(() => Boolean(document.querySelector('#view [data-message-id="100"] .files img.thumb')), "rendered transcript thumbnail", collectWaitTimeout); }
      catch (error) { if (!collectFailures) throw error; }
    }
    const userMessage = document.querySelector('#view [data-message-id="100"]');
    const thumbnail = userMessage?.querySelector(".files img.thumb");
    const imageFileChip = userMessage?.querySelector(".files .file");
    const expectedImageName = String(imageChat?.images?.[0] ?? "").split(/[\\/]/).at(-1) ?? "";
    const imageChipShowsName = Boolean(imageFileChip && expectedImageName && imageFileChip.textContent.trim() === expectedImageName);
    const thumbnailHasNoNewWindowLink = Boolean(thumbnail && !thumbnail.closest("a"));
    const imageResponse = thumbnail ? await fetch(thumbnail.src).then((response) => ({ status: response.status, type: response.headers.get("content-type") })) : { status: 0, type: "missing" };
    const userRight = Boolean(userMessage?.classList.contains("mine") && userMessage.querySelector(".uav"));
    check("chat image thumbnails include the sent filename as a file chip", imageChipShowsName && thumbnailHasNoNewWindowLink, { expectedImageName, renderedFileText: imageFileChip?.textContent.trim() ?? "missing", thumbnailHasNoNewWindowLink });
    const imageSentAndRendered = imagePathSent && Boolean(thumbnail) && thumbnail.src.includes(encodeURIComponent(imageChat.images[0])) && imageResponse.status === 200 && userRight && imageChipShowsName && thumbnailHasNoNewWindowLink;
    const previewReleasedAfterSend = Boolean(sendPreview && revokedUrls.includes(sendPreview));
    check("chat waits for image upload, sends its server path, renders the right-side thumbnail, and releases the preview", loadingShown && sendWaitsForImage && sendUpload.status === 200 && imageSentAndRendered && previewReleasedAfterSend, { loadingShown, sendWaitsForImage, sendUpload, imageChat, thumbnail: thumbnail?.src ?? "missing", imageResponse, userRight, previewReleasedAfterSend });
    await waitFor(() => window.__received.slice(firstSendCompletionStart).some((message) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first send completion");
    const completedSendStatusCleared = $("chatStatus").hidden && $("sendBtn").disabled && $("ci").value === "";
    check("completed leader turn clears progress and keeps the empty composer disabled", completedSendStatusCleared, { statusHidden: $("chatStatus").hidden, sendDisabled: $("sendBtn").disabled, draft: $("ci").value });
    const completedAssistantEvent = window.__received.find((message) => message.type === "chatMessage" && message.role === "assistant" && message.revision === 101);
    const assistantPortrait = document.querySelector('#view [data-message-id="101"] > img');
    const leaderPortrait = document.querySelector('#crew [data-seat-id="leader"] .av img');
    const assistantAvatar = Boolean(assistantPortrait && leaderPortrait && assistantPortrait.getAttribute("src") === leaderPortrait.getAttribute("src"));
    // The server stamps every message with `at` (epoch ms) and nothing else about time: the label is that clock time. 09:05 on a fixed day, so the digits are known.
    const stampedAt = new Date(2026, 0, 2, 9, 5, 0).getTime();
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Stamped by the server", at: stampedAt, revision: 12 });
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "user", text: "Stamped by me", at: stampedAt + 60_000, revision: 13 });
    const assistantTime = text('#view [data-message-id="12"] .meta');
    const userTime = text('#view [data-message-id="13"] .meta');
    const timeFromAt = /09:05$/.test(assistantTime) && /^09:06\s/.test(userTime);
    check("assistant messages use the lead portrait, and every message's time label is the clock time of its `at`", Boolean(completedAssistantEvent) && assistantAvatar && timeFromAt, { completedAssistantEvent, assistantAvatar, assistantPortrait: assistantPortrait?.getAttribute("src") ?? "missing", expectedLeaderPortrait: leaderPortrait?.getAttribute("src") ?? "missing", assistantTime, userTime, selectedTabId: window.__latestState.selectedTabId, viewTabId: $("view").dataset.tabId });
    const secondSendAttachment = await makeControlledImage("second-send-only.png");
    const secondUploadIndex = window.__ccImageUploads.length;
    secondSendAttachment.resolve();
    const secondUpload = await waitImageUpload(secondUploadIndex, "second send image");
    await waitAttachmentReady("second-send-only.png");
    const secondSendStart = window.__received.length;
    $("ci").value = "Send completed later attachment"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === "Send completed later attachment"), "second send consumes the remaining attachment");
    const secondChat = window.__sent.filter((message) => message.type === "chat" && message.text === "Send completed later attachment").at(-1);
    const consumesOnlyOwnAttachment = secondChat?.images?.length === 1 && secondChat.images[0] === secondUpload.path && document.querySelectorAll("#atts .att").length === 0;
    check("chat consumes only the attachments in its send snapshot", consumesOnlyOwnAttachment, { secondChat, expectedPath: secondUpload.path, remainingAttachments: document.querySelectorAll("#atts .att").length });
    await waitFor(() => window.__received.slice(secondSendStart).some((message) => message.type === "chatDone" && message.tabId === "alpha-dev"), "second send leader completion");

    const disconnectedRead = await makeControlledImage("disconnected-send.png");
    const disconnectedUploadIndex = window.__ccImageUploads.length;
    disconnectedRead.resolve();
    const disconnectedUpload = await waitImageUpload(disconnectedUploadIndex, "disconnected draft attachment");
    await waitAttachmentReady("disconnected-send.png");
    const chatCountBeforeDisconnect = window.__sent.filter((message) => message.type === "chat").length;
    const currentSocket = window.__socket; currentSocket.readyState = 3;
    $("ci").value = "Keep this draft while disconnected"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => !$('sendBtn').disabled, "disconnected send rejection");
    const disconnectedToastVisible = await waitToastVisible();
    const disconnectedRetained = $("ci").value === "Keep this draft while disconnected" && [...document.querySelectorAll("#atts .att")].some((node) => node.textContent.includes("disconnected-send.png")) && window.__sent.filter((message) => message.type === "chat").length === chatCountBeforeDisconnect && disconnectedUpload.status === 200;
    currentSocket.readyState = 1; currentSocket.emit("open", {});
    check("disconnected sends keep draft and attachments", disconnectedRetained && disconnectedToastVisible, { disconnectedRetained, disconnectedToastVisible, draft: $("ci").value, upload: disconnectedUpload, chatCountBeforeDisconnect, chatCountAfter: window.__sent.filter((message) => message.type === "chat").length });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    $("ci").value = "";


    const goTab = async (tabId) => {
      const button = document.querySelector(`#tabs [data-tab-id="${CSS.escape(tabId)}"]`);
      if (button) button.click();
      else pickProject(tabId.split("-")[0]);
      await waitFor(() => window.__latestState.selectedTabId === tabId && $("view").dataset.tabId === tabId, `switch to ${tabId}`);
    };
    for (const [name, awayTabId, comeBack] of [["tab switch", "alpha-design", false], ["project switch", "beta-dev", false], ["switch away and back", "alpha-design", true]]) {
      await goTab("alpha-dev");
      const filename = `abandon-${name.replace(/ /g, "-")}.png`;
      const pendingRead = await makeControlledImage(filename);
      const draft = `Abandoned on ${name}`, otherDraft = `Other tab draft for ${name}`;
      $("ci").value = draft; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      const chatsBefore = window.__sent.filter((message) => message.type === "chat").length;
      $("sendBtn").click();
      const waitingForRead = $("sendBtn").disabled && !$("chatStatus").hidden;
      await goTab(awayTabId);
      const otherComposerFree = $("sendBtn").disabled && $("ci").value === "";
      $("ci").value = otherDraft; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      if (comeBack) await goTab("alpha-dev");
      const uploadIndex = window.__ccImageUploads.length;
      pendingRead.resolve();
      const upload = await waitImageUpload(uploadIndex, filename);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const noChatSent = window.__sent.filter((message) => message.type === "chat").length === chatsBefore;
      if (!comeBack) await goTab("alpha-dev");
      await waitAttachmentReady(filename);
      const originalKept = $("ci").value === draft && attachmentNames().includes(filename) && !$("sendBtn").disabled && $("chatStatus").textContent !== "Sending";
      const originalEvidence = { draft: $("ci").value, attachments: attachmentNames(), sendDisabled: $("sendBtn").disabled, status: $("chatStatus").hidden ? "hidden" : $("chatStatus").textContent };
      await goTab(awayTabId);
      const otherUntouched = $("ci").value === otherDraft && !$("sendBtn").disabled && $("chatStatus").textContent !== "Sending";
      const otherEvidence = { draft: $("ci").value, sendDisabled: $("sendBtn").disabled, status: $("chatStatus").hidden ? "hidden" : $("chatStatus").textContent };
      $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      await goTab("alpha-dev");
      check(`a send waiting for an image is abandoned on ${name} and both drafts survive`, waitingForRead && otherComposerFree && upload.status === 200 && noChatSent && originalKept && otherUntouched, { waitingForRead, otherComposerFree, upload, noChatSent, chatsSent: window.__sent.filter((message) => message.type === "chat").length - chatsBefore, original: originalEvidence, other: otherEvidence });
      [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
      $("ci").value = "";
    }

    const cleanup = await makeControlledImage("release-after-confirmed-tab-removal.png");
    const cleanupUploadIndex = window.__ccImageUploads.length;
    cleanup.resolve();
    await waitFor(() => window.__ccImageUploads.length > cleanupUploadIndex, "confirmed removal image upload");
    const cleanupUpload = await window.__ccImageUploads[cleanupUploadIndex];
    await waitAttachmentReady("release-after-confirmed-tab-removal.png");
    const cleanupPreview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes("release-after-confirmed-tab-removal.png"))?.src ?? "";
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 0 : delay, ...args);
    const removalStart = window.__sent.length;
    actionFor("tab");
    window.setTimeout = nativeSetTimeout;
    await waitFor(() => window.__sent.slice(removalStart).some((message) => message.type === "removeTab" && message.tabId === "alpha-dev") && !window.__latestState.projects.flatMap((project) => project.tabs).some((tab) => tab.id === "alpha-dev"), "confirmed tab removal");
    const cleanupReleased = cleanupUpload.status === 200 && Boolean(cleanupPreview) && revokedUrls.includes(cleanupPreview) && document.querySelectorAll("#atts .att").length === 0;
    check("completed attachment resources release after a tab removal is confirmed", cleanupReleased, { upload: cleanupUpload, previewReleased: Boolean(cleanupPreview && revokedUrls.includes(cleanupPreview)), visibleAttachments: document.querySelectorAll("#atts .att").length, removedTab: !window.__latestState.projects.flatMap((project) => project.tabs).some((tab) => tab.id === "alpha-dev") });

    await goTab("beta-dev");
    const projectCleanup = await makeControlledImage("release-after-confirmed-project-removal.png");
    const projectCleanupIndex = window.__ccImageUploads.length;
    projectCleanup.resolve();
    const projectCleanupUpload = await waitImageUpload(projectCleanupIndex, "confirmed project removal image upload");
    await waitAttachmentReady("release-after-confirmed-project-removal.png");
    const projectCleanupPreview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes("release-after-confirmed-project-removal.png"))?.src ?? "";
    const projectHoldSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => projectHoldSetTimeout(callback, delay === 10000 ? 0 : delay, ...args);
    const projectRemovalStart = window.__sent.length;
    clickMenuItem(openProjectMenu("beta"), "Remove from Command Center");
    window.setTimeout = projectHoldSetTimeout;
    await waitFor(() => window.__sent.slice(projectRemovalStart).some((message) => message.type === "removeProject" && message.projectId === "beta") && !window.__latestState.projects.some((project) => project.id === "beta"), "confirmed project removal");
    const projectPreviewReleased = Boolean(projectCleanupPreview) && revokedUrls.includes(projectCleanupPreview);
    check("completed attachment resources release after a project removal is confirmed", projectCleanupUpload.status === 200 && projectPreviewReleased, { upload: projectCleanupUpload, preview: projectCleanupPreview || "missing", previewReleased: projectPreviewReleased, removedProject: !window.__latestState.projects.some((project) => project.id === "beta") });

    const fallbackState = structuredClone(window.__ccSeed);
    const alphaProject = fallbackState.projects.find((project) => project.id === "alpha");
    const fallbackTab = structuredClone(alphaProject.tabs[0]); fallbackTab.id = "alpha-fallback"; fallbackTab.name = "Fallback";
    alphaProject.tabs.push(fallbackTab); window.__ccSeed = fallbackState;
    window.__ccDeliver({ ...fallbackState, type: "state" });
    requireElement('#tabs [data-tab-id="alpha-fallback"]').click();
    await waitFor(() => window.__latestState.selectedTabId === "alpha-fallback" && text('#view [data-message-id="1"] .body > .md') === "Saved transcript for alpha-fallback", "load fallback tab transcript before the Undo race");
    requireElement('#tabs [data-tab-id="alpha-design"]').click();
    await waitFor(() => window.__latestState.selectedTabId === "alpha-design", "select design before testing the transcript fallback");
    const beforeFallbackRemoval = window.__sent.filter((message) => message.type === "removeTab").length;
    const fallbackSelectStart = window.__sent.filter((message) => message.type === "selectTab").length;
    window.__ccDelaySelect = true;
    clickMenuItem(openTabMenu("alpha-design"), "Remove tab");
    await waitFor(() => $("view").dataset.tabId === "alpha-fallback" && text('#view [data-message-id="1"] .body > .md') === "Saved transcript for alpha-fallback", "fallback tab's own transcript during the Undo hold");
    const fallbackTranscriptVisible = $("view").dataset.tabId === "alpha-fallback" && text('#view [data-message-id="1"] .body > .md') === "Saved transcript for alpha-fallback";
    const fallbackUndoVisible = await waitToastVisible($("undo")) && Boolean($("undo").querySelector("[data-undo-held]"));
    const removeNotSentDuringHold = window.__sent.filter((message) => message.type === "removeTab").length === beforeFallbackRemoval;
    const delayedFallbackSelection = window.__ccDelayedSelect === "alpha-fallback" && window.__latestState.selectedTabId === "alpha-design";
    const delayedFallbackEvidence = { delayFlag: window.__ccDelaySelect, delayedTabId: window.__ccDelayedSelect, selectedTabId: window.__latestState.selectedTabId, recentSelections: window.__sent.filter((message) => message.type === "selectTab").slice(-4) };
    requireElement("#undo [data-undo-held]").click();
    if (window.__ccDelayedSelect) {
      const delayed = window.__ccDelayedSelect; window.__ccDelayedSelect = null; window.__ccSeed.selectedTabId = delayed;
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    }
    const restoredSelection = window.__latestState.selectedTabId === "alpha-design" && $("view").dataset.tabId === "alpha-design" && window.__sent.slice().reverse().find((message) => message.type === "selectTab")?.tabId === "alpha-design";
    const fallbackHoldUndoWorked = Boolean(document.querySelector('#tabs [data-tab-id="alpha-design"]') && !$("undo").classList.contains("on") && restoredSelection);
    check("selected-tab Undo restores selection when fallback state is delayed", fallbackTranscriptVisible && fallbackUndoVisible && removeNotSentDuringHold && delayedFallbackSelection && fallbackHoldUndoWorked && window.__sent.filter((message) => message.type === "selectTab").length > fallbackSelectStart, { fallbackTranscriptVisible, fallbackUndoVisible, removeNotSentDuringHold, delayedFallbackSelection, delayedFallbackEvidence, restoredSelection, fallbackHoldUndoWorked, visibleTab: $("view").dataset.tabId, selectedTabId: window.__latestState.selectedTabId, transcript: text("#view .thread") });

    const queueState = structuredClone(window.__ccSeed);
    const queueProject = queueState.projects.find((project) => project.id === "alpha");
    const queueTemplate = structuredClone(queueProject.tabs.find((tab) => tab.id === "alpha-design"));
    const rejectedTab = { ...structuredClone(queueTemplate), id: "alpha-queued-rejected", name: "Queue rejected" };
    const acceptedTab = { ...structuredClone(queueTemplate), id: "alpha-queued-accepted", name: "Queue accepted" };
    queueProject.tabs.push(rejectedTab, acceptedTab); window.__ccSeed = queueState;
    window.__ccDeliver({ ...queueState, type: "state" });
    await clickTab("Queue accepted");
    const queuedCleanup = await makeControlledImage("release-after-queued-removal.png");
    const queuedCleanupIndex = window.__ccImageUploads.length;
    queuedCleanup.resolve();
    const queuedCleanupUpload = await waitImageUpload(queuedCleanupIndex, "queued removal image");
    await waitAttachmentReady("release-after-queued-removal.png");
    const queuedCleanupPreview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes("release-after-queued-removal.png"))?.src ?? "";
    await clickTab("Design");
    window.__ccRejectHeldAction = { type: "removeTab", tabId: "alpha-queued-rejected" };
    window.__ccHoldNextRemoveState = true;
    const queuedRemoveStart = window.__sent.filter((message) => message.type === "removeTab").length;
    clickMenuItem(openTabMenu("alpha-queued-rejected"), "Remove tab");
    clickMenuItem(openTabMenu("alpha-queued-accepted"), "Remove tab");
    await holdClock.advance(10_000);
    await waitFor(() => window.__sent.filter((message) => message.type === "removeTab").length === queuedRemoveStart + 2 && Boolean(window.__ccHeldRemoveState), "queued remove rejection and accepted state");
    const queuedRemoveOrder = window.__sent.filter((message) => message.type === "removeTab").slice(queuedRemoveStart).map((message) => message.tabId);
    const rejectedTabRestored = Boolean(document.querySelector('#tabs [data-tab-id="alpha-queued-rejected"]'));
    const acceptedTabStillPending = Boolean(latestTab("alpha-queued-accepted") && !document.querySelector('#tabs [data-tab-id="alpha-queued-accepted"]') && document.querySelectorAll("#undo .undo-item").length === 1);
    const queuedConfirmation = window.__ccHeldRemoveState; window.__ccHeldRemoveState = null;
    window.__ccDeliver(queuedConfirmation);
    await waitFor(() => !latestTab("alpha-queued-accepted"), "accepted queued remove confirmation");
    const rejectedRemovalScoped = queuedRemoveOrder.join(",") === "alpha-queued-rejected,alpha-queued-accepted" && rejectedTabRestored && acceptedTabStillPending && Boolean(latestTab("alpha-queued-rejected")) && !latestTab("alpha-queued-accepted");
    const queuedCleanupReleased = queuedCleanupUpload.status === 200 && Boolean(queuedCleanupPreview) && revokedUrls.includes(queuedCleanupPreview);
    check("one rejected held removal restores only itself; the next removal cleans up on confirmation", rejectedRemovalScoped && queuedCleanupReleased, { queuedRemoveOrder, rejectedTabRestored, acceptedTabStillPending, rejectedTabStillExists: Boolean(latestTab("alpha-queued-rejected")), acceptedTabRemoved: !latestTab("alpha-queued-accepted"), queuedCleanupUpload, queuedCleanupPreview, queuedCleanupReleased });

    requireElement('#tabs [data-tab-id="alpha-fallback"]').click();
    await waitFor(() => window.__latestState.selectedTabId === "alpha-fallback", "select first stacked removal target");
    clickMenuItem(openTabMenu("alpha-fallback"), "Remove tab");
    clickMenuItem(openTabMenu("alpha-design"), "Remove tab");
    const undoItems = [...document.querySelectorAll("#undo .undo-item")];
    const undoButtons = undoItems.flatMap((item) => [...item.querySelectorAll("[data-undo-held]")]);
    const stackedUndoVisible = await waitToastVisible($("undo")) && undoItems.length === 2
      && undoItems.every((item) => !item.hidden && getComputedStyle(item).display !== "none" && item.getBoundingClientRect().height > 0)
      && undoButtons.length === 2 && undoButtons.every((button) => !button.hidden && getComputedStyle(button).display !== "none" && button.getBoundingClientRect().height > 0);
    const pagehideStart = window.__sent.length;
    const disconnectingSocket = window.__socket; disconnectingSocket.readyState = 3;
    window.dispatchEvent(new Event("pagehide"));
    const disconnectedUndoButtons = [...document.querySelectorAll("#undo [data-undo-held]")];
    const disconnectedHeldRemainUndoable = !window.__sent.slice(pagehideStart).some((message) => ["removeTab", "removeProject"].includes(message.type)) && disconnectedUndoButtons.length === 2 && disconnectedUndoButtons.every((button) => !button.hidden && getComputedStyle(button).display !== "none" && button.getBoundingClientRect().height > 0);
    const pagehideErrorVisible = await waitToastVisible();
    check("multiple held actions each keep a visible Undo when pagehide sends fail", stackedUndoVisible && disconnectedHeldRemainUndoable && pagehideErrorVisible, { stackedUndoVisible, undoCountBeforePagehide: undoItems.length, visibleUndoButtons: undoButtons.length, disconnectedHeldRemainUndoable, pagehideErrorVisible, sentAfterFailedFlush: window.__sent.slice(pagehideStart) });
    disconnectingSocket.readyState = 1; disconnectingSocket.emit("open", {});
    await waitFor(() => window.__received.some((message) => message.type === "state"), "held actions reconnect");
    const retryAfterReconnect = document.querySelectorAll("#undo [data-undo-held]").length === 2;
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => !document.querySelectorAll("#undo [data-undo-held]").length && !window.__latestState.projects.flatMap((project) => project.tabs).some((tab) => ["alpha-fallback", "alpha-design"].includes(tab.id)), "pagehide flush of both held actions");
    const pagehideRemoveRequests = window.__sent.slice(pagehideStart).filter((message) => message.type === "removeTab").map((message) => message.tabId);
    const pagehideFlushedBoth = retryAfterReconnect && pagehideRemoveRequests.includes("alpha-fallback") && pagehideRemoveRequests.includes("alpha-design");
    check("pagehide flushes every held action after reconnect", pagehideFlushedBoth, { retryAfterReconnect, pagehideRemoveRequests, remainingUndoCount: document.querySelectorAll("#undo [data-undo-held]").length, remainingAlphaTabs: window.__latestState.projects.find((project) => project.id === "alpha")?.tabs.map((tab) => tab.id) });

    const pickState = structuredClone(window.__ccSeed);
    const pickAlpha = pickState.projects.find((project) => project.id === "alpha");
    const pickTemplate = structuredClone(pickAlpha.tabs[0]);
    pickTemplate.derived.busy = false; pickTemplate.derived.leaderTurnActive = false; pickTemplate.runs = (pickTemplate.runs ?? []).filter((run) => run.status !== "working");
    pickAlpha.tabs = [];
    for (const [id, name] of [["alpha-pick-a", "Pick A"], ["alpha-pick-b", "Pick B"], ["alpha-pick-c", "Pick C"]]) pickAlpha.tabs.push({ ...structuredClone(pickTemplate), id, name });
    window.__ccSeed = pickState; window.__ccDeliver({ ...structuredClone(pickState), type: "state" });
    const selectById = async (tabId) => {
      requireElement(`#tabs [data-tab-id="${CSS.escape(tabId)}"]`).click();
      await waitFor(() => window.__latestState.selectedTabId === tabId && $("view").dataset.tabId === tabId, `select ${tabId}`);
    };
    const removeWithUndoPending = async (tabId) => {
      clickMenuItem(openTabMenu(tabId), "Remove tab");
      await waitFor(() => window.__latestState.selectedTabId !== tabId && $("view").dataset.tabId !== tabId, `fallback selection after hiding ${tabId}`);
      return window.__latestState.selectedTabId;
    };
    await selectById("alpha-pick-a");
    const choseOtherFallback = await removeWithUndoPending("alpha-pick-a");
    await selectById("alpha-pick-c");
    const choseOtherUndoStart = window.__sent.length;
    requireElement("#undo [data-undo-held]").click();
    await waitFor(() => Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-a"]')), "Undo restores Pick A");
    const choseOtherSelections = window.__sent.slice(choseOtherUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId);
    const undoKeepsUserChoice = choseOtherSelections.length === 0 && window.__latestState.selectedTabId === "alpha-pick-c" && $("view").dataset.tabId === "alpha-pick-c";
    check("Undo after Remove tab keeps a tab the user chose during the hold", undoKeepsUserChoice, { choseOtherFallback, choseOtherSelections, selectedTabId: window.__latestState.selectedTabId, visibleTab: $("view").dataset.tabId });
    await selectById("alpha-pick-a");
    const untouchedFallback = await removeWithUndoPending("alpha-pick-a");
    const untouchedUndoStart = window.__sent.length;
    requireElement("#undo [data-undo-held]").click();
    await waitFor(() => window.__latestState.selectedTabId === "alpha-pick-a" && $("view").dataset.tabId === "alpha-pick-a", "Undo returns to Pick A");
    const untouchedSelections = window.__sent.slice(untouchedUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId);
    check("Undo after Remove tab returns to the removed tab when the user did not move", untouchedSelections.at(-1) === "alpha-pick-a", { untouchedFallback, untouchedSelections, selectedTabId: window.__latestState.selectedTabId });

    await selectById("alpha-pick-a");
    const clickedFallback = await removeWithUndoPending("alpha-pick-a");
    const fallbackUndoStart = window.__sent.length;
    await selectById("alpha-pick-b");
    const fallbackClickSelections = window.__sent.slice(fallbackUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId);
    const fallbackClickUndoStart = window.__sent.length;
    requireElement("#undo [data-undo-held]").click();
    await waitFor(() => Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-a"]')), "Undo restores Pick A after clicking fallback");
    const fallbackUndoSelections = window.__sent.slice(fallbackClickUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId);
    const undoKeepsFallbackChoice = clickedFallback === "alpha-pick-b" && fallbackClickSelections.at(-1) === "alpha-pick-b" && fallbackUndoSelections.length === 0 && window.__latestState.selectedTabId === "alpha-pick-b" && $("view").dataset.tabId === "alpha-pick-b";
    check("Undo after Remove tab keeps the fallback tab the user clicked", undoKeepsFallbackChoice, { clickedFallback, fallbackClickSelections, fallbackUndoSelections, selectedTabId: window.__latestState.selectedTabId, visibleTab: $("view").dataset.tabId });
    const tabKey = (tabId, key) => requireElement(`#tabs [data-tab-id="${CSS.escape(tabId)}"]`).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const fallbackPaths = [
      ["the arrow keys", () => tabKey("alpha-pick-c", "ArrowLeft")],
      ["Enter", () => tabKey("alpha-pick-b", "Enter")],
      ["Space", () => tabKey("alpha-pick-b", " ")],
      ["the waiting card", () => {
        const waitingState = structuredClone(window.__ccSeed);
        const waitingTab = waitingState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-pick-b");
        waitingTab.processState = { ...(waitingTab.processState ?? {}), approval: { ...(waitingTab.processState?.approval ?? {}), state: "pending" } };
        window.__ccDeliver({ ...waitingState, type: "state" });
        requireElement('[data-wait-tab="alpha-pick-b"]', openInbox()).click();
        window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      }],
      ["the project picker", () => pickProject("alpha")],
    ];
    for (const [path, pickFallback] of fallbackPaths) {
      await selectById("alpha-pick-a");
      const pathFallback = await removeWithUndoPending("alpha-pick-a");
      const pathStart = window.__sent.length;
      await pickFallback();
      await waitFor(() => window.__sent.slice(pathStart).some((message) => message.type === "selectTab" && message.tabId === pathFallback), `${path} selects ${pathFallback}`);
      const pathUndoStart = window.__sent.length;
      requireElement("#undo [data-undo-held]").click();
      await waitFor(() => Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-a"]')), `Undo restores Pick A after ${path}`);
      const pathUndoSelections = window.__sent.slice(pathUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId);
      const pathKept = pathFallback === "alpha-pick-b" && pathUndoSelections.length === 0 && window.__latestState.selectedTabId === "alpha-pick-b" && $("view").dataset.tabId === "alpha-pick-b";
      check(`Undo after Remove tab keeps the fallback tab picked with ${path}`, pathKept, { pathFallback, pathSelections: window.__sent.slice(pathStart, pathUndoStart).filter((message) => message.type === "selectTab").map((message) => message.tabId), pathUndoSelections, selectedTabId: window.__latestState.selectedTabId, visibleTab: $("view").dataset.tabId });
    }

    window.__ccHoldNextRemoveState = true;
    const scopedRemoveStart = window.__sent.length;
    clickMenuItem(openTabMenu("alpha-pick-b"), "Remove tab");
    await holdClock.advance(10_000);
    await waitFor(() => window.__sent.slice(scopedRemoveStart).some((message) => message.type === "removeTab" && message.tabId === "alpha-pick-b") && Boolean(window.__ccHeldRemoveState), "held Pick B removal in flight");
    window.__ccDeliver({ type: "error", action: "chat", tabId: "alpha-pick-a", message: "images must be a list of uploaded image paths" });
    window.__ccDeliver({ type: "error", message: "invalid seat key" });
    window.__ccDeliver({ type: "error", action: "removeTab", tabId: "alpha-pick-c", message: "cannot remove a busy tab" });
    const unrelatedLeftHeld = !document.querySelector('#tabs [data-tab-id="alpha-pick-b"]') && document.querySelectorAll("#undo .undo-item").length === 1 && !document.querySelector("#undo [data-undo-held]");
    check("unrelated errors never restore a held action", unrelatedLeftHeld, { pickBVisible: Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-b"]')), undoItems: [...document.querySelectorAll("#undo .undo-item")].map((node) => node.textContent) });
    window.__ccDeliver({ type: "error", action: "removeTab", tabId: "alpha-pick-b", message: "cannot remove a busy tab" });
    const namedRestored = Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-b"]')) && document.querySelectorAll("#undo .undo-item").length === 0;
    check("an error naming the held request restores only that action", namedRestored, { pickBVisible: Boolean(document.querySelector('#tabs [data-tab-id="alpha-pick-b"]')), undoItems: document.querySelectorAll("#undo .undo-item").length });
    window.__ccHeldRemoveState = null;
    window.__ccSeed = pickState; window.__ccDeliver({ ...structuredClone(pickState), type: "state" });

    await selectById("alpha-pick-c");
    const lockTab = "alpha-pick-c";
    const setDraft = (value) => { $("ci").value = value; $("ci").dispatchEvent(new Event("input", { bubbles: true })); };
    const canSendAgain = () => { setDraft("Try again"); const ok = !$("sendBtn").disabled && $("chatStatus").textContent !== "Sending" && $("sendBtn").getAttribute("aria-label") === "Send message"; setDraft(""); return ok; };
    const queuesNow = () => !$("sendBtn").disabled && $("sendBtn").getAttribute("aria-label") === "Queue message";
    const deliverLeaderTurn = (leaderTurnActive, workerRunning = false) => {
      const copy = structuredClone(window.__ccSeed);
      const tab = copy.projects.flatMap((project) => project.tabs).find((item) => item.id === lockTab);
      tab.derived.leaderTurnActive = leaderTurnActive;
      tab.derived.busy = leaderTurnActive || workerRunning;
      if (workerRunning) {
        const coder = tab.crew.find((seat) => seat.slot === "coder");
        if (coder) { coder.status = "working"; coder.task = "Working · parallel tasks"; }
        tab.derived.workingSeats = [...tab.derived.workingSeats.filter((seat) => seat.slotId !== "coder"), { slotId: "coder", name: coder?.name ?? "Coder", isLeader: false }];
      }
      window.__ccSeed = copy;
      window.__ccDeliver({ ...copy, type: "state" });
    };
    window.__ccChatMode = "refuse";
    const refusedStart = window.__received.length;
    setDraft("Refused by the server"); $("sendBtn").click();
    await waitFor(() => window.__received.slice(refusedStart).some((message) => message.type === "error" && message.action === "chat"), "refused chat error");
    const refusedChatRequest = window.__sent.filter((message) => message.type === "chat" && message.text === "Refused by the server").at(-1);
    const refusedChatError = window.__received.slice(refusedStart).find((message) => message.type === "error" && message.action === "chat");
    const refusalNamesMyRequest = Boolean(refusedChatRequest?.requestId) && refusedChatError?.requestId === refusedChatRequest.requestId;
    const refusedKeepsDraft = $("ci").value === "Refused by the server";
    check("chat error with my request id unlocks without changing the composer", refusalNamesMyRequest && refusedKeepsDraft && !$("ci").readOnly, { refusalNamesMyRequest, requestId: refusedChatRequest?.requestId, error: refusedChatError, draft: $("ci").value, readOnly: $("ci").readOnly });
    deliverLeaderTurn(false);
    const refusedCanSend = canSendAgain();
    check("a refused chat unlocks Send once the server answers", refusedCanSend, { status: $("chatStatus").textContent, disabled: $("sendBtn").disabled });

    window.__ccChatMode = "swallow";
    const disconnectAttachment = await makeControlledImage("disconnect-pending.png");
    const disconnectUploadIndex = window.__ccImageUploads.length;
    disconnectAttachment.resolve();
    const disconnectUpload = await waitImageUpload(disconnectUploadIndex, "disconnect pending image");
    await waitAttachmentReady("disconnect-pending.png");
    setDraft("Lost in a disconnect"); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === "Lost in a disconnect"), "swallowed chat sent");
    const disconnectRequest = window.__sent.filter((message) => message.type === "chat" && message.text === "Lost in a disconnect").at(-1);
    const lockedBeforeDisconnect = $("chatStatus").textContent === "Sending" && $("ci").readOnly && $("attachBtn").disabled;
    window.__ccHistoryOverride = { tabId: lockTab, messages: [] };
    window.__ccChatMode = null;
    const reconnectStates = window.__states.length; const reconnectMessages = window.__received.length;
    window.__socket.close();
    const idleDisconnectedKeepsDraft = $("ci").value === "Lost in a disconnect" && !$("ci").readOnly && !$("attachBtn").disabled && attachmentNames().includes("disconnect-pending.png");
    check("socket close releases pending lock but leaves composer text and attachments", lockedBeforeDisconnect && idleDisconnectedKeepsDraft && disconnectUpload.status === 200 && Boolean(disconnectRequest?.requestId), { lockedBeforeDisconnect, idleDisconnectedKeepsDraft, draft: $("ci").value, readOnly: $("ci").readOnly, attachDisabled: $("attachBtn").disabled, attachments: attachmentNames(), requestId: disconnectRequest?.requestId });
    await waitFor(() => window.__states.length > reconnectStates, "reconnect state");
    await waitFor(() => window.__received.slice(reconnectMessages).some((message) => message.type === "chatHistory" && message.tabId === lockTab), "reconnect transcript without accepted request");
    deliverLeaderTurn(false);
    const missingReplayKeepsDraft = $("ci").value === "Lost in a disconnect" && !$("ci").readOnly && attachmentNames().includes("disconnect-pending.png");
    check("reconnect history without my request id keeps composer untouched", missingReplayKeepsDraft, { missingReplayKeepsDraft, draft: $("ci").value, readOnly: $("ci").readOnly, attachments: attachmentNames() });
    const reconnectCanSend = canSendAgain();
    check("a disconnect mid-reply unlocks Send after reconnect with an idle server", lockedBeforeDisconnect && reconnectCanSend, { lockedBeforeDisconnect, reconnectCanSend, status: $("chatStatus").textContent });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    setDraft("");

    window.__ccChatMode = "swallow";
    setDraft("Accepted while disconnected"); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === "Accepted while disconnected"), "accepted but unconfirmed chat sent");
    const replayRequest = window.__sent.filter((message) => message.type === "chat" && message.text === "Accepted while disconnected").at(-1);
    const replayMessages = window.__received.length; const replayStates = window.__states.length;
    window.__ccHistoryOverride = { tabId: lockTab, messages: [{ id: "replayed-accepted", role: "user", text: "Accepted while disconnected", requestId: replayRequest.requestId, at: Date.now(), revision: 5 }] };
    window.__ccChatMode = null; window.__socket.close();
    await waitFor(() => window.__states.length > replayStates, "reconnect for accepted replay");
    await waitFor(() => window.__received.slice(replayMessages).some((message) => message.type === "chatHistory" && message.tabId === lockTab && message.messages?.some((item) => item.requestId === replayRequest.requestId)), "replayed accepted request id");
    const replayClearsAcceptedDraft = $("ci").value === "" && !$("ci").readOnly;
    check("reconnect history with my request id clears the accepted composer", replayClearsAcceptedDraft, { replayClearsAcceptedDraft, requestId: replayRequest.requestId, draft: $("ci").value, readOnly: $("ci").readOnly });

    window.__ccChatMode = "swallow";
    const overlapAttachment = await makeControlledImage("overlap-retry.png");
    const overlapUploadIndex = window.__ccImageUploads.length;
    overlapAttachment.resolve();
    const overlapUpload = await waitImageUpload(overlapUploadIndex, "overlap retry image");
    await waitAttachmentReady("overlap-retry.png");
    const overlapText = "Same composer across reconnect";
    setDraft(overlapText); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === overlapText), "first overlapping request");
    const overlapRequests = window.__sent.filter((message) => message.type === "chat" && message.text === overlapText);
    const earlierRequest = overlapRequests.at(-1);
    window.__ccHistoryOverride = { tabId: lockTab, messages: [{ id: "overlap-accepted", role: "user", text: overlapText, images: earlierRequest.images, requestId: earlierRequest.requestId, at: Date.now(), revision: 6 }] };
    window.__ccHoldHistory = true;
    const overlapReconnectStates = window.__states.length;
    window.__socket.close();
    await waitFor(() => window.__states.length > overlapReconnectStates && window.__ccHeldHistory?.tabId === lockTab, "held reconnect history");
    const retryWasAvailable = !$("sendBtn").disabled;
    $("sendBtn").click();
    await waitFor(() => window.__sent.filter((message) => message.type === "chat" && message.text === overlapText).length >= 2, "new request before old history arrives");
    const newerRequest = window.__sent.filter((message) => message.type === "chat" && message.text === overlapText).at(-1);
    const heldHistory = window.__ccHeldHistory;
    window.__ccHoldHistory = false; window.__ccHeldHistory = null;
    window.__socket.sendMessage({ type: "chatHistory", ...heldHistory });
    const newerComposerStillPending = $("ci").value === overlapText && $("ci").readOnly && $("sendBtn").disabled && attachmentNames().includes("overlap-retry.png");
    window.__ccDeliver({ type: "error", action: "chat", tabId: lockTab, requestId: newerRequest.requestId, message: "new request refused" });
    const newerRefusalPreservedComposer = $("ci").value === overlapText && !$("ci").readOnly && attachmentNames().includes("overlap-retry.png");
    check("older accepted request cannot change a newer pending composer", retryWasAvailable && overlapUpload.status === 200 && earlierRequest.requestId !== newerRequest.requestId && newerComposerStillPending && newerRefusalPreservedComposer, { retryWasAvailable, upload: overlapUpload, earlierRequestId: earlierRequest.requestId, newerRequestId: newerRequest.requestId, newerComposerStillPending, newerRefusalPreservedComposer, draft: $("ci").value, attachments: attachmentNames() });
    window.__ccChatMode = null;
    deliverLeaderTurn(false);
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    setDraft("");

    window.__ccHoldChatDone = true;
    setDraft("Server keeps answering"); $("sendBtn").click();
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "held acknowledged turn");
    deliverLeaderTurn(true);
    setDraft("Blocked while busy");
    const blockedWhileBusy = queuesNow();
    setDraft("");
    deliverLeaderTurn(false, true);
    const idleLeaderWorkerStillRunningUnlocks = canSendAgain();
    window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
    check("the send mode follows the leader turn: queues while active, plain Send with a worker still running and no chatDone", blockedWhileBusy && idleLeaderWorkerStillRunningUnlocks, { blockedWhileBusy, idleLeaderWorkerStillRunningUnlocks });

    deliverLeaderTurn(false);
    const freeBeforeRemoteTurn = canSendAgain();
    deliverLeaderTurn(true);
    setDraft("Another window is mid-turn");
    const remoteTurnLocks = queuesNow() && $("ci").value === "Another window is mid-turn";
    setDraft("");
    deliverLeaderTurn(false);
    const remoteTurnReleases = canSendAgain();
    check("a leader turn the server reports makes Send queue with no local send (second window or reconnect mid-turn)", freeBeforeRemoteTurn && remoteTurnLocks && remoteTurnReleases, { freeBeforeRemoteTurn, remoteTurnLocks, remoteTurnReleases });

    window.__ccChatMode = "swallow";
    const refusedImage = await makeControlledImage("refused-draft.png");
    refusedImage.resolve();
    await waitAttachmentReady("refused-draft.png");
    setDraft("Not yet accepted"); $("sendBtn").click();
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === "Not yet accepted"), "unaccepted chat sent");
    const pendingComposerKept = $("ci").value === "Not yet accepted" && attachmentNames().includes("refused-draft.png") && $("ci").readOnly && $("attachBtn").disabled;
    deliverLeaderTurn(false);
    const earlyStateKeepsLock = $("sendBtn").disabled && $("ci").value === "Not yet accepted" && $("ci").readOnly;
    check("a state before server acceptance keeps the pending send locked with its composer intact", pendingComposerKept && earlyStateKeepsLock, { pendingComposerKept, earlyStateKeepsLock, draft: $("ci").value, readOnly: $("ci").readOnly, attachments: attachmentNames() });
    window.__ccDeliver({ type: "chatMessage", tabId: lockTab, role: "user", text: "Not yet accepted", revision: 4, at: Date.now() });
    deliverLeaderTurn(true);
    const unacceptedRequest = window.__sent.filter((message) => message.type === "chat" && message.tabId === lockTab && message.text === "Not yet accepted").at(-1);
    window.__ccDeliver({ type: "error", action: "chat", tabId: lockTab, requestId: unacceptedRequest?.requestId, message: "leader is still answering the previous message" });
    const refusalKeepsRemoteLock = queuesNow();
    const refusalKeepsDraft = $("ci").value === "Not yet accepted" && !$("ci").readOnly && attachmentNames().includes("refused-draft.png") && /^blob:/.test(document.querySelector("#atts .att img.thumb")?.getAttribute("src") ?? "");
    check("a refusal during another window's turn leaves Send in queue mode", refusalKeepsRemoteLock, { refusalKeepsRemoteLock, status: $("chatStatus").textContent });
    check("a refused send leaves its original text and images in the composer", refusalKeepsDraft, { draft: $("ci").value, readOnly: $("ci").readOnly, attachments: attachmentNames(), thumb: document.querySelector("#atts .att img.thumb")?.getAttribute("src") });
    window.__ccChatMode = null;
    deliverLeaderTurn(false);
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    setDraft("");

    const awayTab = [...document.querySelectorAll("#tabs [data-tab-id]")].map((node) => node.dataset.tabId).find((tabId) => tabId !== lockTab);
    if (!awayTab) fail("no other tab to switch to from the pending send");
    const chatsWithText = (value) => window.__sent.filter((message) => message.type === "chat" && message.text === value);
    const settleMicrotasks = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
    window.__ccChatMode = "swallow";
    const switchedText = "Sent then switched away";
    setDraft(switchedText); $("sendBtn").click();
    await waitFor(() => chatsWithText(switchedText).length === 1, "sent chat before switching tabs");
    const switchedRequest = chatsWithText(switchedText).at(-1);
    await selectById(awayTab);
    window.__ccDeliver({ type: "chatMessage", tabId: lockTab, role: "user", text: switchedText, requestId: switchedRequest.requestId, revision: 7, at: Date.now() });
    window.__ccChatMode = null;
    await selectById(lockTab);
    const echoSettledAbandoned = $("ci").value === "" && !$("ci").readOnly && $("sendBtn").disabled;
    $("sendBtn").click(); $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settleMicrotasks();
    const echoNoDuplicate = chatsWithText(switchedText).length === 1;
    check("a sent chat abandoned by a tab switch is still settled by its later echo without a duplicate send", Boolean(switchedRequest?.requestId) && echoSettledAbandoned && echoNoDuplicate, { requestId: switchedRequest?.requestId, echoSettledAbandoned, echoNoDuplicate, draft: $("ci").value, sends: chatsWithText(switchedText).length });
    deliverLeaderTurn(false); setDraft("");

    window.__ccChatMode = "swallow";
    const historyText = "Sent then settled by history";
    setDraft(historyText); $("sendBtn").click();
    await waitFor(() => chatsWithText(historyText).length === 1, "sent chat before switching tabs for history");
    const abandonedHistoryRequest = chatsWithText(historyText).at(-1);
    await selectById(awayTab);
    window.__ccChatMode = null;
    window.__ccHistoryOverride = { tabId: lockTab, messages: [{ id: "abandoned-history", role: "user", text: historyText, requestId: abandonedHistoryRequest.requestId, at: Date.now(), revision: 8 }] };
    const historyReturnMessages = window.__received.length;
    await selectById(lockTab);
    await waitFor(() => window.__received.slice(historyReturnMessages).some((message) => message.type === "chatHistory" && message.tabId === lockTab && message.messages?.some((item) => item.requestId === abandonedHistoryRequest.requestId)), "history naming the abandoned request");
    const historySettledAbandoned = $("ci").value === "" && !$("ci").readOnly && $("sendBtn").disabled;
    $("sendBtn").click(); $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settleMicrotasks();
    const historyNoDuplicate = chatsWithText(historyText).length === 1;
    check("a sent chat abandoned by a tab switch is still settled by history on return without a duplicate send", Boolean(abandonedHistoryRequest?.requestId) && historySettledAbandoned && historyNoDuplicate, { requestId: abandonedHistoryRequest?.requestId, historySettledAbandoned, historyNoDuplicate, draft: $("ci").value, sends: chatsWithText(historyText).length });
    deliverLeaderTurn(false); setDraft("");

    window.__ccChatMode = "swallow";
    const originalText = "Original before disconnect", rewrittenText = "Rewritten after disconnect";
    setDraft(originalText); $("sendBtn").click();
    await waitFor(() => chatsWithText(originalText).length === 1, "sent chat before disconnect edit");
    const editedRequest = chatsWithText(originalText).at(-1);
    window.__ccHistoryOverride = { tabId: lockTab, messages: [{ id: "edited-accepted", role: "user", text: originalText, requestId: editedRequest.requestId, at: Date.now(), revision: 9 }] };
    window.__ccChatMode = null;
    const editStates = window.__states.length, editMessages = window.__received.length;
    window.__socket.close();
    setDraft(rewrittenText);
    await waitFor(() => window.__states.length > editStates, "reconnect after editing the disconnected draft");
    await waitFor(() => window.__received.slice(editMessages).some((message) => message.type === "chatHistory" && message.tabId === lockTab && message.messages?.some((item) => item.requestId === editedRequest.requestId)), "history accepting the pre-edit send");
    const editKept = $("ci").value === rewrittenText && !$("ci").readOnly;
    check("text edited after a disconnect survives reconnect history that accepts the older send", Boolean(editedRequest?.requestId) && editKept, { requestId: editedRequest?.requestId, editKept, draft: $("ci").value });
    deliverLeaderTurn(false); setDraft("");

    window.__ccChatMode = "swallow";
    const lateText = "Pending when a picked file arrives";
    setDraft(lateText); $("sendBtn").click();
    await waitFor(() => chatsWithText(lateText).length === 1, "pending send before a late file pick");
    const lateRequest = chatsWithText(lateText).at(-1);
    const latePick = new DataTransfer();
    latePick.items.add(new File([uploadBytes], "late-pick.png", { type: "image/png" }));
    $("attachInput").files = latePick.files;
    const latePickCount = $("attachInput").files.length;
    $("attachInput").dispatchEvent(new Event("change", { bubbles: true }));
    await settleMicrotasks();
    const lateRejected = attachmentNames().length === 0 && !pendingReads.some((item) => item.file?.name === "late-pick.png");
    window.__ccDeliver({ type: "error", action: "chat", tabId: lockTab, requestId: lateRequest?.requestId, message: "late pick refused" });
    check("a file picked while a send is pending is never attached to that composer", latePickCount === 1 && lateRejected, { latePickCount, lateRejected, attachments: attachmentNames(), pendingReads: pendingReads.map((item) => item.file?.name) });
    window.__ccChatMode = null;
    deliverLeaderTurn(false);
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    setDraft("");

    const capImages = [];
    for (let index = 0; index < 8; index++) capImages.push(await makeControlledImage(`cap-${index}.png`));
    const ninth = new File([uploadBytes], "cap-8.png", { type: "image/png" });
    const ninthPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ninthPaste, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => ninth }] } });
    $("ci").dispatchEvent(ninthPaste);
    const capNames = attachmentNames();
    const capHeld = capNames.length === 8 && !capNames.includes("cap-8.png") && /up to 8 images/.test($("toast").textContent);
    check("the composer caps attachments at the server's eight-image limit", capHeld, { capNames, toast: $("toast").textContent });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    for (const image of capImages) image.resolve();

    window.__ccDeliver({ type: "error", message: "Toast timer test" });
    const errorToastVisible = await waitToastVisible();
    await holdClock.advance(3_200);
    const errorToastHidden = $("toast").hidden && $("toast").inert && $("toast").getAttribute("aria-hidden") === "true" && !$("toast").classList.contains("on");
    check("error toast visibility and hidden state stay in sync", errorToastVisible && errorToastHidden, { errorToastVisible, errorToastHidden, hidden: $("toast").hidden, inert: $("toast").inert, ariaHidden: $("toast").getAttribute("aria-hidden"), classOn: $("toast").classList.contains("on") });
    holdClock.restore();
    Blob.prototype.arrayBuffer = nativeArrayBuffer;

    return { entry, tabOf };
  };
  const runPackC = async () => {
    const settleMicrotasks = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
    await waitFor(() => window.__latestState?.type === "state", "Pack C fake state");
    const targets = ["#inboxBtn", "#inboxN", "#inboxPop", "#inboxList", "#reqNew", "#reqN", "#reqList", "#reqForm", "#reqTo", "#reqTitle", "#reqBody", "#reqSend", "#reqStatus", "#permBtn", "#permPop", '[data-l="activity"]', '[data-l="changes"]', '[data-l="notes"]', '[data-l="usage"]', "#setBtn", "#setModal", "#setNav", "#setBody", "#avModal", "#avgrid", "#avUp", "#avatarStatus", "#viewer", "#viewerFiles"];
    const missingTargets = targets.filter((selector) => !document.querySelector(selector));
    check(`Pack C target selector list finds every required control at ${innerWidth}px`, missingTargets.length === 0, { found: targets.filter((selector) => document.querySelector(selector)), missing: missingTargets, width: innerWidth });
    const settingsSections = ["crew", "tools", "github", "vault", "folders", "skills", "appearance", "behaviour"];
    if ($("setModal").hidden) $("setBtn").click();
    const foundSettingsSections = [];
    for (const section of settingsSections) {
      const navTarget = `#setNav [data-settings-section="${section}"]`;
      if (!document.querySelector(navTarget)) continue;
      document.querySelector(navTarget).click();
      if (document.querySelector(`#setBody #s-${section}`)) foundSettingsSections.push(`#s-${section}`);
    }
    const missingSettingsSections = settingsSections.map((section) => `#s-${section}`).filter((selector) => !foundSettingsSections.includes(selector));
    check(`Settings section target list finds all eight sections at ${innerWidth}px`, missingSettingsSections.length === 0, { found: foundSettingsSections, missing: missingSettingsSections, navItems: [...document.querySelectorAll("#setNav [data-settings-section]")].map((item) => item.dataset.settingsSection) });
    const settingsBody = $("setBody");
    await new Promise((resolve) => setTimeout(resolve, 410));
    // The dialog opens with a short scale-in; measure positions once it has settled at full size.
    await waitFor(() => new DOMMatrixReadOnly(getComputedStyle($("setModal")).transform).a === 1, "Settings open animation settled");
    const scrollTarget = requireElement("#s-skills");
    const offsets = () => [...settingsBody.querySelectorAll(".settings-section")].map((section) => `${section.dataset.section}:${section.offsetTop}/${section.offsetHeight}`).join(" ");
    const scrollBefore = { scrollTop: settingsBody.scrollTop, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, offsets: offsets(), scrollHeight: settingsBody.scrollHeight };
    settingsBody.scrollTop += scrollTarget.getBoundingClientRect().top - settingsBody.getBoundingClientRect().top - 60;
    const scrollAfter = { scrollTop: settingsBody.scrollTop, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, offsets: offsets(), scrollHeight: settingsBody.scrollHeight };
    settingsBody.dispatchEvent(new Event("scroll"));
    const scrollTrackedSection = [...document.querySelectorAll("#setNav [data-settings-section]")].find((item) => item.getAttribute("aria-current") === "true")?.dataset.settingsSection;
    const sectionTops = [...settingsBody.querySelectorAll(".settings-section")].map((section) => `${section.dataset.section}:${Math.round((section.getBoundingClientRect().top - settingsBody.getBoundingClientRect().top) * 10) / 10}`);
    settingsBody.scrollTop = settingsBody.scrollHeight;
    settingsBody.dispatchEvent(new Event("scroll"));
    const bottomTrackedSection = [...document.querySelectorAll("#setNav [data-settings-section]")].find((item) => item.getAttribute("aria-current") === "true")?.dataset.settingsSection;
    check(`Settings scroll tracking marks the section and the final section at ${innerWidth}px`, scrollTrackedSection === "skills" && bottomTrackedSection === "behaviour", { scrollTop: settingsBody.scrollTop, scrollHeight: settingsBody.scrollHeight, clientHeight: settingsBody.clientHeight, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, scrollBefore, scrollAfter, sectionTops, activeSection: scrollTrackedSection, bottomActiveSection: bottomTrackedSection });

    const stateCopy = structuredClone(window.__ccSeed);
    stateCopy.selectedTabId = "alpha-dev";
    stateCopy.pendingRequestCounts = { "alpha-dev": 2, "alpha-design": 5, "beta-dev": 1 };
    stateCopy.requests = [];
    stateCopy.requestActions ??= {};
    stateCopy.settings ??= {};
    stateCopy.settings.tools = {
      claude: { installed: true, version: "2.1.0", signedIn: false },
      codex: { installed: true, version: "0.155.1", signedIn: false },
      opencode: { installed: true, version: "1.2.3", signedIn: false },
      gemini: { installed: false, version: null, signedIn: null },
    };
    stateCopy.settings.github = { connected: false, account: null };
    stateCopy.settings.vault = { path: null };
    stateCopy.settings.folders = { defaultProjectFolder: "" };
    stateCopy.settings.permissionModes = { "alpha-dev": "ask", "alpha-design": "plan", "beta-dev": "accept" };
    stateCopy.settings.permissionActions ??= {};
    stateCopy.settings.uploads ??= {};
    stateCopy.settings.skills = {
      claude: { instructionFiles: [], skills: [], mcpServers: [{ name: "claude_mcp" }], plugins: ["sample-plugin"] },
      codex: { instructionFiles: [], skills: [], mcpServers: [{ name: "codex_mcp" }], plugins: [] },
      opencode: { instructionFiles: [], skills: [], mcpServers: [{ name: "open_mcp" }], plugins: [] },
      gemini: { instructionFiles: [{ path: "~/.gemini/GEMINI.md", scope: "global" }, { path: "GEMINI.md", scope: "project" }], skills: [], mcpServers: [], plugins: [] },
    };
    const selected = stateCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    const design = stateCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-design");
    if (selected) { selected.permissionMode = "ask"; selected.changes = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] }; selected.notes = { path: null, content: "", truncated: false }; }
    if (design) { design.permissionMode = "plan"; design.changes = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] }; design.notes = { path: null, content: "", truncated: false }; }
    window.__ccSeed = structuredClone(stateCopy);
    window.__ccDeliver({ ...stateCopy, type: "state" });
    const deliver = (next, keepSeed = true) => { if (keepSeed) window.__ccSeed = structuredClone(next); window.__ccDeliver({ ...next, type: "state" }); };
    const deliverAction = (requestId, status, message) => {
      const next = structuredClone(window.__latestState);
      next.requestActions = { ...(next.requestActions ?? {}), [requestId]: { requestId, status, message } };
      deliver(next);
    };
    const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
    const seenRequestIds = new Set();
    const markUnique = (value) => { const unique = safeId(value) && !seenRequestIds.has(value); if (unique) seenRequestIds.add(value); return unique; };
    const openSettingsSection = (section) => {
      if ($("setModal").hidden) $("setBtn").click();
      requireElement(`#setNav [data-settings-section="${section}"]`).click();
      return requireElement(`#setBody #s-${section}`);
    };
    const settingsAction = async ({ name, section, selector, type, fields = {}, result = "failed", message = "Server refusal for this action" }) => {
      openSettingsSection(section);
      if (type === "mcpAdd") {
        const form = document.querySelector(`[data-mcp-form="${CSS.escape(fields.cli)}"]`);
        if (form?.hidden) requireElement(`[data-settings-add="mcp-${CSS.escape(fields.cli)}"]`).click();
      }
      if (type === "pluginInstall") {
        const form = requireElement("[data-plugin-form]");
        if (form.hidden) requireElement('[data-settings-add="plugins-claude"]').click();
      }
      const start = window.__sent.length;
      if (type === "setNotesVault") { requireElement("#vaultPath").value = fields.path ?? ""; requireElement("#vaultPath").dispatchEvent(new Event("input", { bubbles: true })); }
      if (type === "setDefaultProjectFolder") requireElement("#defaultProjectFolder").value = fields.folder ?? "";
      const button = requireElement(selector); const form = button.form;
      if (type === "mcpAdd" && form) { form.elements.name.value = fields.name; form.elements.commandOrUrl.value = fields.commandOrUrl; }
      if (type === "pluginInstall" && form) form.elements.name.value = fields.name;
      const buttonDisabledBeforeClick = button.disabled; const formValues = form ? { name: form.elements.name?.value, commandOrUrl: form.elements.commandOrUrl?.value, valid: form.checkValidity() } : null; button.focus(); button.click(); confirmIfAsked();
      await settleMicrotasks();
      const sent = window.__sent.slice(start).filter((item) => item.type === type).at(-1);
      const idGood = markUnique(sent?.requestId);
      const expectedFields = { type, ...fields };
      const exactMessage = Boolean(sent && idGood
        && Object.keys(sent).length === Object.keys(expectedFields).length + 1
        && Object.entries(expectedFields).every(([key, value]) => sent[key] === value)
        && Object.keys(sent).every((key) => key === "requestId" || Object.hasOwn(expectedFields, key)));
      const statusNode = sent?.requestId ? document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`) : null;
      const runningShown = statusNode?.dataset.status === "running";
      const pendingButton = requireElement(selector);
      const disabledWhileRunning = pendingButton.disabled;
      if (sent?.requestId && type === "setNotesVault" && result === "done") {
        const next = structuredClone(window.__latestState);
        next.settings.vault.path = fields.path ?? null;
        next.requestActions = { ...(next.requestActions ?? {}), [sent.requestId]: { requestId: sent.requestId, status: result, message } };
        deliver(next);
      } else if (sent?.requestId) deliverAction(sent.requestId, result, message);
      const finalStatus = sent?.requestId ? document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`) : null;
      const finalButton = requireElement(selector);
      const statusShown = finalStatus?.dataset.status === result && finalStatus.textContent.includes(message);
      const reenabled = !finalButton.disabled;
      const focusRestored = document.activeElement?.dataset.focusKey === button.dataset.focusKey;
      check(`${name} sends its exact request, shows that id's ${result} status, restores focus, and re-enables`, Boolean(sent) && exactMessage && runningShown && disabledWhileRunning && statusShown && reenabled && focusRestored, { sent: sent ?? null, expectedFields: { ...expectedFields, requestId: "<fresh unique request id>" }, exactMessage, buttonDisabledBeforeClick, buttonType: button.type, formValues, idGood, runningShown, disabledWhileRunning, finalStatus: finalStatus ? { id: finalStatus.dataset.statusFor, status: finalStatus.dataset.status, message: finalStatus.textContent } : null, statusShown, reenabled, focusRestored, activeFocusKey: document.activeElement?.dataset.focusKey });
      return sent;
    };

    const initialBadge = $("reqN").textContent;
    await clickTab("Design");
    const designBadge = $("reqN").textContent;
    await clickTab("Development");
    check(`request badge reads the selected tab at ${innerWidth}px`, initialBadge === "2" && designBadge === "5" && $("reqN").textContent === "2" && $("reqHeadLabel").textContent.includes("Development"), { initialTab: "alpha-dev", initialBadge, designTab: "alpha-design", designBadge, restoredBadge: $("reqN").textContent, heading: $("reqHeadLabel").textContent });

    const changesTab = requireElement('[data-l="changes"]'); changesTab.click();
    const changesHonest = text("#lowerBody").includes("Not a git repository") && !text("#lowerBody").includes("main");
    requireElement('[data-l="notes"]').click();
    const emptyNotes = text("#lowerBody").includes("Nothing saved yet") && !text("#lowerBody").includes("mockup");
    const noVaultButton = requireElement("#lowerBody [data-open-vault]");
    const noVaultHonest = noVaultButton.disabled && noVaultButton.textContent.includes("Open in Obsidian") && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    const openedBeforeNoVault = window.__ccOpenedObsidian.length;
    noVaultButton.click(); await settleMicrotasks();
    const noVaultNoop = window.__ccOpenedObsidian.length === openedBeforeNoVault;
    check(`Changes and Notes pills render server empty state and no-vault action at ${innerWidth}px`, changesHonest && emptyNotes && noVaultHonest && noVaultNoop, { changes: text("#lowerBody"), changesHonest, emptyNotes, noVaultHonest, noVaultNoop, openedObsidian: window.__ccOpenedObsidian.length });

    const lookState = structuredClone(window.__latestState);
    const lookTab = lookState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    lookTab.changes = { repo: true, branch: "redesign", ahead: 2, behind: 1, lastCommit: { hash: "a41bf2a", subject: "Pack C" }, uncommittedFiles: [{ status: "M", path: "public/app.js" }, { status: "A", path: "test/look.test.js" }, { status: "D", path: "public/old.css" }] };
    lookTab.notes = { path: "C:\\project\\.command-center\\RESUME.md", content: "# Where we left off\nCommand Center look pass\n- Settings follows the approved mockup\n- Request safety remains server-owned", truncated: false };
    deliver(lookState);
    requireElement('[data-l="changes"]').click();
    const changeTargets = ['#lowerBody [data-change-row="branch"]', '#lowerBody [data-change-row="commit"]', '#lowerBody [data-change-row="files"]', "#lowerBody [data-change-file-list]", "#lowerBody [data-change-file-list] .M", "#lowerBody [data-change-file-list] .A", "#lowerBody [data-change-file-list] .D"];
    const missingChangeTargets = changeTargets.filter((selector) => !document.querySelector(selector));
    const changeRows = [...document.querySelectorAll("#lowerBody [data-change-row]")].map((row) => row.textContent.trim());
    const changeFiles = [...document.querySelectorAll("#lowerBody [data-change-file-list] b")].map((node) => node.textContent.trim());
    check(`Pack C Changes target list finds every mockup row and status at ${innerWidth}px`, missingChangeTargets.length === 0, { found: changeTargets.filter((selector) => document.querySelector(selector)), missing: missingChangeTargets, width: innerWidth });
    check(`Pack C Changes rows match Branch, Last commit, Remote and Not committed at ${innerWidth}px`, changeRows[0]?.includes("Branch") && changeRows[0]?.includes("redesign") && changeRows[1]?.includes("Last commit") && changeRows[1]?.includes("a41bf2a") && changeRows[2]?.includes("Remote") && changeRows[2]?.includes("2 commits not pushed") && changeRows[2]?.includes("1 behind") && changeRows[3]?.includes("Not committed") && changeRows[3]?.includes("3 files") && changeFiles.join("") === "MAD", { matchedRows: changeRows, matchedStatuses: changeFiles, branch: text('#lowerBody [data-change-row="branch"] .mono'), commit: text('#lowerBody [data-change-row="commit"] .mono'), count: text('#lowerBody [data-change-row="files"] .mono') });
    requireElement('[data-l="notes"]').click();
    const noteTargets = ["#lowerBody .resume .lbl", "#lowerBody .note-rows", "#lowerBody [data-note-row]", "#lowerBody [data-open-vault]", "#lowerBody [data-vault-empty]"];
    const missingNoteTargets = noteTargets.filter((selector) => !document.querySelector(selector));
    check(`Pack C Notes target list finds the heading, rows and no-vault state at ${innerWidth}px`, missingNoteTargets.length === 0, { found: noteTargets.filter((selector) => document.querySelector(selector)), missing: missingNoteTargets, heading: text("#lowerBody .resume .lbl"), noteRows: [...document.querySelectorAll("#lowerBody [data-note-row]")].map((node) => node.textContent.trim()), vaultState: text("#lowerBody [data-vault-empty]") });

    const composerTargets = ["#ctools #attachBtn", "#ctools #attachInput", "#ctools #permBtn", "#ctools #permBtn .perm-dot", "#ctools #permBtn .perm-chevron"];
    const missingComposerTargets = composerTargets.filter((selector) => !document.querySelector(selector));
    const attach = requireElement("#ctools #attachBtn"), permissionPill = requireElement("#ctools #permBtn");
    const attachBeforePermission = Boolean(attach.compareDocumentPosition(permissionPill) & Node.DOCUMENT_POSITION_FOLLOWING);
    check(`Pack C composer target list finds Attach and the permission pill at ${innerWidth}px`, missingComposerTargets.length === 0, { found: composerTargets.filter((selector) => document.querySelector(selector)), missing: missingComposerTargets, width: innerWidth });
    check(`Pack C composer puts Attach before the permission pill at ${innerWidth}px`, attachBeforePermission && permissionPill.classList.contains("perm"), { order: [...document.querySelectorAll("#ctools > button")].map((button) => button.id), matchedAttach: attach.id, matchedPermission: permissionPill.id, permissionLabel: text("[data-permission-label]", permissionPill) });

    openSettingsSection("tools");
    const geminiInstall = requireElement('#s-tools [data-setting-action="install-cli"][data-cli="gemini"]');
    const geminiRow = geminiInstall.closest("[data-tool-row]");
    const geminiUnknown = text("[data-tool-subtitle]", geminiRow) === "Not installed." && !geminiRow.querySelector('[data-tool-status="connected"]');
    const installedHasNoInstall = !document.querySelector('#s-tools [data-setting-action="install-cli"][data-cli="claude"]');
    const toolTargets = ['#s-tools [data-tool-row][data-cli="gemini"]', '#s-tools [data-tool-row][data-cli="gemini"] .tool-row-action', '#s-tools [data-tool-row][data-cli="gemini"] [data-setting-action="install-cli"]', '#s-tools [data-tool-row][data-cli="gemini"] .cmd code', '#s-tools [data-tool-row][data-cli="gemini"] [data-copy]'];
    const missingToolTargets = toolTargets.filter((selector) => !document.querySelector(selector));
    const geminiToolRow = requireElement('#s-tools [data-tool-row][data-cli="gemini"]');
    const geminiAction = requireElement('#s-tools [data-tool-row][data-cli="gemini"] [data-setting-action="install-cli"]');
    const geminiCommand = text('#s-tools [data-tool-row][data-cli="gemini"] .cmd code');
    const geminiCopy = requireElement('#s-tools [data-tool-row][data-cli="gemini"] [data-copy]');
    const installRightColumn = geminiAction.closest("[data-tool-row-action]") === geminiToolRow.querySelector("[data-tool-row-action]") && geminiAction.classList.contains("primary");
    const geminiCommandExact = geminiCommand === "npm install -g @google/gemini-cli" && geminiCopy.dataset.copy === geminiCommand;
    check(`Pack C AI tool target list finds every right-column install detail at ${innerWidth}px`, missingToolTargets.length === 0, { found: toolTargets.filter((selector) => document.querySelector(selector)), missing: missingToolTargets, cli: "gemini" });
    check(`Pack C Gemini Install stays right-aligned with its real npm argv at ${innerWidth}px`, installRightColumn && geminiCommandExact && text("[data-tool-subtitle]", geminiToolRow) === "Not installed.", { matchedRow: geminiToolRow.dataset.cli, rightAction: installRightColumn, actionText: geminiAction.textContent.trim(), primary: geminiAction.classList.contains("primary"), command: geminiCommand, copyValue: geminiCopy.dataset.copy, subtitle: text("[data-tool-subtitle]", geminiToolRow) });
    window.__ccConfirmResult = false;
    let before = window.__sent.length; geminiInstall.click(); confirmIfAsked();
    const installDeniedSendsNothing = !window.__sent.slice(before).some((item) => item.type === "installCli") && window.__ccConfirms.at(-1)?.includes("Gemini");
    window.__ccConfirmResult = true;
    check(`Gemini stays install-only, unknown sign-in stays unknown, and unconfirmed Install sends nothing at ${innerWidth}px`, geminiUnknown && installedHasNoInstall && installDeniedSendsNothing && !document.querySelector('#s-tools [data-setting-action="login-cli"][data-cli="gemini"]'), { geminiUnknown, installedHasNoInstall, installDeniedSendsNothing, geminiInstructionText: "~/.gemini/GEMINI.md and project GEMINI.md" });
    const geminiInstallMessage = await settingsAction({ name: `Gemini Install at ${innerWidth}px`, section: "tools", selector: '#s-tools [data-setting-action="install-cli"][data-cli="gemini"]', type: "installCli", fields: { cli: "gemini", confirm: true } });
    const geminiMessageGood = geminiInstallMessage?.requestId && geminiInstallMessage.confirm === true;
    openSettingsSection("tools");
    const loginMessage = await settingsAction({ name: `CLI login at ${innerWidth}px`, section: "tools", selector: '#s-tools [data-setting-action="login-cli"][data-cli="claude"]', type: "cliLogin", fields: { cli: "claude" } });

    const githubMessage = await settingsAction({ name: `GitHub connect at ${innerWidth}px`, section: "github", selector: '#s-github [data-setting-action="github-login"]', type: "ghLogin", message: "GitHub login refused in fake state" });
    const vaultInput = requireElement("#vaultPath"); vaultInput.value = "C:\\vault with spaces";
    const vaultMessage = await settingsAction({ name: `Notes vault save at ${innerWidth}px`, section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: "C:\\vault with spaces" }, result: "done", message: "Done" });
    const folderBrowse = requireElement('#s-folders [data-setting-action="folder-browse"]'); folderBrowse.click(); await settleMicrotasks();
    const defaultFolderInput = requireElement("#defaultProjectFolder");
    const defaultBrowseGood = defaultFolderInput.value === window.__ccFolderChoice && window.__sent.filter((item) => item.type === "changeFolder").length === 0;
    const defaultFolderMessage = await settingsAction({ name: `Default project folder save at ${innerWidth}px`, section: "folders", selector: '#s-folders [data-setting-action="folder-save"]', type: "setDefaultProjectFolder", fields: { folder: window.__ccFolderChoice }, result: "done", message: "Done" });
    const tabBrowseStart = window.__sent.length;
    requireElement('#s-folders [data-setting-action="tab-folder-browse"][data-tab-id="alpha-design"]').click(); await settleMicrotasks();
    const tabBrowse = window.__sent.slice(tabBrowseStart).find((item) => item.type === "changeFolder");
    const tabBrowseGood = tabBrowse?.tabId === "alpha-design" && tabBrowse.folder === window.__ccFolderChoice && tabBrowse.requestId === undefined;
    check(`Folders keep each tab's Browse and the new-project default at ${innerWidth}px`, defaultBrowseGood && tabBrowseGood, { defaultBrowseGood, defaultFolder: defaultFolderInput.value, tabBrowse: tabBrowse ?? null, selectedTab: "alpha-design" });

    openSettingsSection("skills");
    const geminiCard = text('#s-skills [data-skill-cli="gemini"]');
    const geminiInstructions = geminiCard.includes("GEMINI.md") && geminiCard.includes("(global)") && geminiCard.includes("(project)");
    const geminiNoMcpControls = !document.querySelector('#s-skills [data-mcp-form="gemini"]') && !document.querySelector('#s-skills [data-setting-action="mcp-remove"][data-cli="gemini"]') && !document.querySelector('#s-skills [data-setting-action="login-cli"][data-cli="gemini"]');
    const opencodeNoRemove = !document.querySelector('#s-skills [data-setting-action="mcp-remove"][data-cli="opencode"]');
    const noPlaceholderCommands = [...document.querySelectorAll("#s-tools [data-cli] .cmd")].every((node) => /^npm install -g @[A-Za-z0-9/@._-]+$/.test(text("code", node)) && node.querySelector("[data-copy]")?.dataset.copy === text("code", node));
    let mcpForm = requireElement('#s-skills [data-mcp-form="claude"]');
    if (mcpForm.hidden) requireElement('#s-skills [data-settings-add="mcp-claude"]').click();
    mcpForm = requireElement('#s-skills [data-mcp-form="claude"]');
    mcpForm.querySelector('[name="name"]').value = "bad name"; mcpForm.querySelector('[name="commandOrUrl"]').value = "npx -y server";
    const mcpStart = window.__sent.length; mcpForm.requestSubmit();
    const invalidMcpBlocked = !window.__sent.slice(mcpStart).some((item) => item.type === "mcpAdd");
    mcpForm.querySelector('[name="name"]').value = "valid_mcp"; mcpForm.querySelector('[name="commandOrUrl"]').value = "http://example.com/mcp";
    const mcpHttpStart = window.__sent.length; mcpForm.requestSubmit();
    const nonHttpsMcpBlocked = !window.__sent.slice(mcpHttpStart).some((item) => item.type === "mcpAdd");
    mcpForm.querySelector('[name="commandOrUrl"]').value = "https://user:pass@example.com/mcp";
    const mcpCredentialStart = window.__sent.length; mcpForm.requestSubmit();
    const credentialMcpBlocked = !window.__sent.slice(mcpCredentialStart).some((item) => item.type === "mcpAdd");
    mcpForm.querySelector('[name="commandOrUrl"]').value = "npx -y server; whoami";
    const mcpShellStart = window.__sent.length; mcpForm.requestSubmit();
    const shellMetaMcpBlocked = !window.__sent.slice(mcpShellStart).some((item) => item.type === "mcpAdd");
    mcpForm.querySelector('[name="name"]').value = "valid_mcp"; mcpForm.querySelector('[name="commandOrUrl"]').value = "npx -y server";
    const mcpMessage = await settingsAction({ name: `MCP add at ${innerWidth}px`, section: "skills", selector: '#s-skills [data-mcp-form="codex"] button[type="submit"]', type: "mcpAdd", fields: { cli: "codex", name: "valid_mcp", commandOrUrl: "npx -y server" } });
    window.__ccConfirmResult = false; before = window.__sent.length;
    requireElement('#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]').click();
    const mcpRemoveDenied = confirmIfAsked() && !window.__sent.slice(before).some((item) => item.type === "mcpRemove");
    window.__ccConfirmResult = true;
    const mcpRemoveMessage = await settingsAction({ name: `MCP remove at ${innerWidth}px`, section: "skills", selector: '#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]', type: "mcpRemove", fields: { cli: "claude", name: "claude_mcp", confirm: true } });
    const pluginForm = requireElement('#s-skills [data-plugin-form]');
    if (pluginForm.hidden) requireElement('#s-skills [data-settings-add="plugins-claude"]').click();
    requireElement('#s-skills [data-plugin-form]').querySelector('[name="name"]').value = "sample-plugin";
    const pluginInstallMessage = await settingsAction({ name: `Plugin install at ${innerWidth}px`, section: "skills", selector: '#s-skills [data-plugin-form] button[type="submit"]', type: "pluginInstall", fields: { name: "sample-plugin" } });
    window.__ccConfirmResult = false; before = window.__sent.length;
    requireElement('#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]').click();
    const pluginRemoveDenied = confirmIfAsked() && !window.__sent.slice(before).some((item) => item.type === "pluginUninstall");
    window.__ccConfirmResult = true;
    const pluginRemoveMessage = await settingsAction({ name: `Plugin remove at ${innerWidth}px`, section: "skills", selector: '#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]', type: "pluginUninstall", fields: { name: "sample-plugin", confirm: true } });
    check(`Skills and MCP controls respect Gemini/OpenCode limits and validate names and endpoints at ${innerWidth}px`, geminiInstructions && geminiNoMcpControls && opencodeNoRemove && noPlaceholderCommands && invalidMcpBlocked && nonHttpsMcpBlocked && credentialMcpBlocked && shellMetaMcpBlocked && mcpRemoveDenied && pluginRemoveDenied && Boolean(geminiMessageGood && loginMessage?.requestId && githubMessage?.requestId && vaultMessage?.requestId && defaultFolderMessage?.requestId && mcpMessage?.requestId && mcpRemoveMessage?.confirm === true && pluginInstallMessage?.requestId && pluginRemoveMessage?.confirm === true), { geminiInstructions, geminiNoMcpControls, opencodeNoRemove, noPlaceholderCommands, invalidMcpBlocked, nonHttpsMcpBlocked, credentialMcpBlocked, shellMetaMcpBlocked, mcpRemoveDenied, pluginRemoveDenied, ids: [geminiInstallMessage?.requestId, loginMessage?.requestId, githubMessage?.requestId, vaultMessage?.requestId, defaultFolderMessage?.requestId, mcpMessage?.requestId, mcpRemoveMessage?.requestId, pluginInstallMessage?.requestId, pluginRemoveMessage?.requestId] });

    openSettingsSection("vault");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const vaultPathForOpen = "C:\\Vault & journal";
    const openState = structuredClone(window.__latestState); openState.settings.vault.path = vaultPathForOpen; deliver(openState);
    const openNow = requireElement('#lowerBody [data-open-vault]'); openNow.click(); await settleMicrotasks();
    const expectedObsidian = `obsidian://open?path=${encodeURIComponent(vaultPathForOpen)}`;
    const obsidianUrlGood = window.__ccOpenedObsidian.at(-1) === expectedObsidian;
    const notesPath = structuredClone(window.__latestState); notesPath.selectedTabId = "alpha-dev"; deliver(notesPath);
    requireElement('[data-l="notes"]').click();
    const lowerOpen = requireElement("#lowerBody [data-open-vault]"); lowerOpen.click(); await settleMicrotasks();
    const obsidianBothButtonsGood = window.__ccOpenedObsidian.length === 2 && window.__ccOpenedObsidian.every((url) => url === expectedObsidian);
    check(`Obsidian opens only the encoded server vault path at ${innerWidth}px`, obsidianUrlGood && obsidianBothButtonsGood, { expectedObsidian, opened: window.__ccOpenedObsidian.slice() });
    openSettingsSection("vault");
    const bridge = window.cc; delete window.cc;
    const noBridgeState = structuredClone(window.__latestState); deliver(noBridgeState);
    const hiddenPlainButtons = !document.querySelector('#lowerBody [data-open-vault]') && !document.querySelector('#setBody [data-setting-action="vault-browse"]') && !document.querySelector('#setBody [data-setting-action="folder-browse"]') && !document.querySelector('#setBody [data-setting-action="tab-folder-browse"]');
    window.cc = bridge; deliver(noBridgeState);
    check(`Obsidian and folder pickers hide without the Electron bridge at ${innerWidth}px`, hiddenPlainButtons, { hiddenPlainButtons });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    const requestOpener = $("inboxBtn");
    const requestFormStart = window.__sent.length;
    openRequests();
    const requestOptions = [...$("reqTo").options].map((option) => option.value);
    $("reqTo").value = "beta-dev"; $("reqTitle").value = "Check release notes"; $("reqBody").value = "Review the other project's server state.";
    $("reqForm").requestSubmit();
    const outgoing = window.__sent.slice(requestFormStart).find((item) => item.type === "sendRequest");
    const outgoingExact = outgoing?.fromTabId === "alpha-dev" && outgoing?.toTabId === "beta-dev" && outgoing?.title === "Check release notes" && outgoing?.body === "Review the other project's server state." && markUnique(outgoing?.requestId) && $("reqSend").disabled;
    if (outgoing?.requestId) deliverAction(outgoing.requestId, "failed", "Request destination refused this request");
    const outgoingFailedStatus = $("reqStatus").dataset.status === "failed" && $("reqStatus").textContent.includes("Request destination refused this request") && !$("reqSend").disabled;
    check(`Requests send fresh cross-project protocol ids and show refusal at ${innerWidth}px`, outgoingExact && outgoingFailedStatus && requestOptions.includes("beta-dev"), { outgoing: outgoing ?? null, requestOptions, outgoingExact, outgoingFailedStatus, status: $("reqStatus").textContent, reenabled: !$("reqSend").disabled });

    const requestOne = { id: "00000000-0000-4000-8000-000000000101", fromTabId: "beta-dev", toTabId: "alpha-dev", title: "Accept this", body: "Incoming request one", status: "pending", createdAt: Date.now() - 60_000 };
    const requestTwo = { id: "00000000-0000-4000-8000-000000000102", fromTabId: "alpha-design", toTabId: "alpha-dev", title: "Decline this", body: "Incoming request two", status: "pending", createdAt: Date.now() - 120_000 };
    const requestThree = { id: "00000000-0000-4000-8000-000000000103", fromTabId: "alpha-dev", toTabId: "missing-tab", title: "Target was removed", body: "Server retained this card", status: "destinationRemoved", createdAt: Date.now() - 180_000 };
    const requestFour = { id: "00000000-0000-4000-8000-000000000104", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Review deployment plan", body: "Check the target before the next run.", status: "pending", createdAt: Date.now() - 300_000 };
    const requestFive = { id: "00000000-0000-4000-8000-000000000105", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Older request", body: "This request was declined.", status: "declined", createdAt: Date.now() - 600_000 };
    const requestsState = structuredClone(window.__latestState); requestsState.selectedTabId = "alpha-dev"; requestsState.requests = [requestOne, requestTwo, requestThree, requestFour, requestFive]; requestsState.pendingRequestCounts = { "alpha-dev": 2, "alpha-design": 5, "beta-dev": 1 }; deliver(requestsState);
    const waitingHasRequest = [...document.querySelectorAll("#inboxList .ncard")].some((card) => card.textContent.includes("Accept this"));
    openInbox();
    // Pending incoming requests are cards in the Needs you list; answered incoming and sent ones sit in its Requests section.
    const drawerTargets = ['#reqList [data-request-section="incoming"]', '#reqList [data-request-section="sent"]', '#inboxList [data-request-id="00000000-0000-4000-8000-000000000101"] .route-arrow', '#inboxList [data-request-action="accept:00000000-0000-4000-8000-000000000101"]', '#inboxList [data-request-action="decline:00000000-0000-4000-8000-000000000101"]', '#reqList [data-request-id="00000000-0000-4000-8000-000000000104"] [data-request-status="pending"]', '#reqList [data-request-id="00000000-0000-4000-8000-000000000105"] [data-request-status="declined"]'];
    const missingDrawerTargets = drawerTargets.filter((selector) => !document.querySelector(selector));
    check(`Pack C Needs you request target list finds incoming and sent card parts at ${innerWidth}px`, missingDrawerTargets.length === 0, { found: drawerTargets.filter((selector) => document.querySelector(selector)), missing: missingDrawerTargets, width: innerWidth });
    const devLeader = leaderNameOf("alpha-dev", requestsState);
    const expectedHandoff = `Hand to Development's ${devLeader}`;
    const drawerStructure = text('#reqList [data-request-section="incoming"] h3') === "Incoming, answered" && text('#reqList [data-request-section="sent"] h3') === "Sent from Development" && text('#inboxList [data-request-id="00000000-0000-4000-8000-000000000101"] [data-request-action^="accept:"]') === expectedHandoff && !document.querySelector('#reqList [data-request-id="00000000-0000-4000-8000-000000000101"]');
    check(`Pack C Needs you separates pending, answered and sent requests with the handoff button at ${innerWidth}px`, drawerStructure && text('#reqList [data-request-id="00000000-0000-4000-8000-000000000104"] [data-request-status]') === "Pending" && text('#reqList [data-request-id="00000000-0000-4000-8000-000000000105"] [data-request-status]') === "Declined", { incomingHeading: text('#reqList [data-request-section="incoming"] h3'), sentHeading: text('#reqList [data-request-section="sent"] h3'), acceptLabel: text('#inboxList [data-request-id="00000000-0000-4000-8000-000000000101"] [data-request-action^="accept:"]'), expectedHandoff, pendingSent: text('#reqList [data-request-id="00000000-0000-4000-8000-000000000104"] [data-request-status]'), declinedSent: text('#reqList [data-request-id="00000000-0000-4000-8000-000000000105"] [data-request-status]') });
    const removedCard = requireElement('#reqList [data-request-id="00000000-0000-4000-8000-000000000103"]');
    const removedShown = removedCard.textContent.includes("Destination removed") && removedCard.textContent.includes("That tab was removed, so this request can no longer be answered.");
    const resolveStart = window.__sent.length;
    requireElement('[data-request-action="accept:00000000-0000-4000-8000-000000000101"]').click();
    const accepted = window.__sent.slice(resolveStart).find((item) => item.type === "resolveRequest");
    const acceptButtonLocked = requireElement('[data-request-action="accept:00000000-0000-4000-8000-000000000101"]').disabled;
    if (accepted?.requestId) deliverAction(accepted.requestId, "done", "Done");
    const acceptedStatus = accepted?.requestId ? document.querySelector(`[data-status-for="${CSS.escape(accepted.requestId)}"]`) : null;
    const acceptedGood = accepted?.id === requestOne.id && accepted.status === "accepted" && markUnique(accepted.requestId) && acceptedStatus?.dataset.status === "done" && !requireElement('[data-request-action="accept:00000000-0000-4000-8000-000000000101"]').disabled;
    const declineStart = window.__sent.length;
    requireElement('[data-request-action="decline:00000000-0000-4000-8000-000000000102"]').click();
    const declined = window.__sent.slice(declineStart).find((item) => item.type === "resolveRequest");
    if (declined?.requestId) deliverAction(declined.requestId, "failed", "Request is no longer pending");
    const declinedGood = declined?.id === requestTwo.id && declined.status === "declined" && markUnique(declined.requestId) && document.querySelector(`[data-status-for="${CSS.escape(declined.requestId)}"]`)?.textContent.includes("Request is no longer pending") && !requireElement('[data-request-action="decline:00000000-0000-4000-8000-000000000102"]').disabled;
    check(`Requests waiting, accept, decline, destination-removed and per-id refusal render at ${innerWidth}px`, waitingHasRequest && removedShown && acceptedGood && declinedGood && acceptButtonLocked, { waitingHasRequest, removedShown, accepted: accepted ?? null, acceptedStatus: acceptedStatus ? { status: acceptedStatus.dataset.status, message: acceptedStatus.textContent } : null, acceptedGood, acceptButtonLocked, declined: declined ?? null, declinedGood, badge: $("reqN").textContent });
    pressEscape();
    const requestsFocusRestored = document.activeElement === requestOpener && $("inboxPop").hidden;
    check(`Needs you returns focus to its opener at ${innerWidth}px`, requestsFocusRestored, { focused: document.activeElement?.id, opener: requestOpener.id, closed: $("inboxPop").hidden });

    const permissionStart = window.__sent.length;
    const permissionButton = $("permBtn"); permissionButton.focus(); permissionButton.click();
    const modeTargets = ["ask", "accept", "plan", "bypass"].map((mode) => `[data-permission-mode="${mode}"]`);
    const missingModes = modeTargets.filter((selector) => !document.querySelector(selector));
    const savedAsk = document.querySelector('[data-permission-mode="ask"]')?.getAttribute("aria-pressed") === "true";
    const modesShown = modeTargets.map((selector) => document.querySelector(selector)?.dataset.permissionMode);
    // The approved copy names this tab's leader, exactly as the mockup's picker does.
    const expectedPermissions = [["Ask before edits", `${devLeader} asks before changing any file or running a command`], ["Auto-accept edits", "Edits go through, commands still ask"], ["Plan only", "Reads and plans, changes nothing"], ["Bypass permissions", `${devLeader} runs everything without asking. Crew access does not change. Use with care.`]];
    const matchedPermissions = modeTargets.map((selector) => {
      const item = document.querySelector(selector);
      return { label: item?.querySelector(".nm")?.firstChild?.textContent?.trim() ?? "", description: item ? text(".nm small", item) : "" };
    });
    const permissionLook = text("#permPop .lbl") === "Permissions for this chat" && matchedPermissions.every((item, index) => item.label === expectedPermissions[index][0] && item.description === expectedPermissions[index][1]) && !text("#permPop").includes("Saved mode:");
    check(`Pack C permission picker target list finds all approved modes at ${innerWidth}px`, missingModes.length === 0, { found: modeTargets.filter((selector) => document.querySelector(selector)), missing: missingModes, width: innerWidth });
    check(`Pack C permission picker matches approved labels and descriptions at ${innerWidth}px`, permissionLook, { heading: text("#permPop .lbl"), matchedPermissions, removedSavedFooter: !text("#permPop").includes("Saved mode:") });
    window.__ccConfirmResult = false; before = window.__sent.length;
    requireElement('[data-permission-mode="bypass"]').click();
    const bypassDenied = confirmIfAsked() && !window.__sent.slice(before).some((item) => item.type === "setPermissionMode");
    window.__ccConfirmResult = true;
    $("permBtn").click(); requireElement('#permPop [data-permission-mode="plan"]').click();
    const permission = window.__sent.slice(permissionStart).find((item) => item.type === "setPermissionMode");
    const permissionRunning = $("permBtn").disabled && $("permBtn").textContent.includes("Applying");
    const permissionExact = permission?.tabId === "alpha-dev" && permission.mode === "plan" && markUnique(permission.requestId) && !permission.confirm;
    if (permission?.requestId) deliverAction(permission.requestId, "failed", "Permission change refused by the server");
    const permissionFailed = $("permBtn").textContent.includes("Not changed") && $("permBtn").title.includes("Permission change refused by the server") && !$("permBtn").disabled;
    const permissionFocusRestored = document.activeElement === $("permBtn");
    $("permBtn").click(); window.__ccConfirmResult = true;
    requireElement('[data-permission-mode="bypass"]').click(); confirmIfAsked();
    const bypass = window.__sent.slice(permissionStart).filter((item) => item.type === "setPermissionMode").at(-1);
    const bypassRunning = $("permBtn").disabled && $("permBtn").textContent.includes("Applying");
    const bypassExact = bypass?.tabId === "alpha-dev" && bypass.mode === "bypass" && bypass.confirm === true && markUnique(bypass.requestId);
    if (bypass?.requestId) {
      const bypassState = structuredClone(window.__latestState);
      bypassState.settings.permissionModes["alpha-dev"] = "bypass";
      bypassState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").permissionMode = "bypass";
      bypassState.requestActions = { ...(bypassState.requestActions ?? {}), [bypass.requestId]: { requestId: bypass.requestId, status: "done", message: "Permission mode saved" } };
      deliver(bypassState);
    }
    const bypassDone = $("permBtn").textContent.includes("Bypass permissions") && !$("permBtn").querySelector(".perm-state") && $("permBtn").title.includes("Permission mode saved") && !$("permBtn").disabled;
    const permissionFocusAfterDone = document.activeElement === $("permBtn");
    check(`Per-tab permission picker shows all modes, saved state, confirmation and status at ${innerWidth}px`, missingModes.length === 0 && modesShown.join(",") === "ask,accept,plan,bypass" && savedAsk && bypassDenied && permissionExact && permissionRunning && permissionFailed && permissionFocusRestored && bypassExact && bypassRunning && bypassDone && permissionFocusAfterDone, { found: modeTargets.filter((selector) => document.querySelector(selector)), missing: missingModes, modesShown, savedAsk, bypassDenied, permission: permission ?? null, permissionExact, permissionRunning, permissionFailed, permissionFocusRestored, bypass: bypass ?? null, bypassExact, bypassRunning, bypassDone, permissionFocusAfterDone });

    const uploadRequests = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      const promise = nativeFetch(input, init);
      if (init.method === "POST" && ["/api/avatar", "/api/paste-file", "/api/paste-image"].includes(url.pathname)) {
        const record = { path: url.pathname, method: init.method, requestId: headers.get("X-Request-Id"), fileName: headers.get("X-File-Name"), promise: promise.then(async (response) => ({ status: response.status, value: await response.clone().json() })) };
        uploadRequests.push(record);
      }
      return promise;
    };

    openSeatView("coder");
    const avatarOpener = requireElement("#view [data-seat-more]"); avatarOpener.focus(); avatarOpener.click();
    requireElement("#seatPop [data-seat-picture]").click();
    requireElement('#avModal[aria-hidden="false"]');
    const avatarFile = new File(["avatar bytes"], "seat-picture.png", { type: "image/png" });
    const avatarData = new DataTransfer(); avatarData.items.add(avatarFile); $("avUp").files = avatarData.files; $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    const avatarRunning = $("avatarStatus").dataset.status === "running" && $("avatarStatus").textContent === "Uploading";
    await waitFor(() => uploadRequests.some((request) => request.path === "/api/avatar"), "seat avatar POST");
    const avatarRequest = uploadRequests.find((request) => request.path === "/api/avatar");
    const avatarResult = await avatarRequest.promise;
    await waitFor(() => window.__sent.some((item) => item.type === "updateSeat" && item.slot === "coder"), "seat picture updateSeat");
    const avatarUpdate = window.__sent.filter((item) => item.type === "updateSeat" && item.slot === "coder").at(-1);
    const avatarFocusBack = document.activeElement?.matches('#view [data-seat-more="coder"]') === true;
    const avatarGood = safeId(avatarRequest.requestId) && avatarResult.status === 200 && avatarUpdate?.tabId === "alpha-dev" && avatarUpdate.pic === avatarResult.value.path && $("avModal").hidden && avatarFocusBack;
    check(`Seat picture uploads with an id, applies its server route and restores focus at ${innerWidth}px`, avatarRunning && avatarGood, { avatarRunning, upload: { path: avatarRequest.path, requestId: avatarRequest.requestId, status: avatarResult.status, value: avatarResult.value }, updateSeat: avatarUpdate ?? null, modalClosed: $("avModal").hidden, focusRestored: avatarFocusBack });

    showChat();
    const screenshotUploadId = "packc_screenshot";
    // This direct upload gives the key the way the app does: window.cc.appKey() (the same value the server was started with).
    const screenshotResponse = await nativeFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": "image/png", "X-Request-Id": screenshotUploadId, "X-App-Key": await window.cc.appKey() }, body: "screenshot bytes" });
    const screenshotUpload = await screenshotResponse.json();
    const screenshotState = structuredClone(window.__latestState);
    screenshotState.selectedTabId = "alpha-dev";
    const screenshotTab = screenshotState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    screenshotTab.processState.approval = { state: "pending" }; screenshotTab.processState.currentStepIndex = 0;
    screenshotTab.derived.stepBar = [{ stepId: "look", state: "current", owners: ["user"], label: "Your look" }];
    const designTab = screenshotState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-design");
    designTab.processState.approval = { state: "pending" }; designTab.processState.currentStepIndex = 0;
    designTab.derived.stepBar = [{ stepId: "look", state: "current", owners: ["user"], label: "Your look" }];
    window.__ccSeed = structuredClone(screenshotState); deliver(screenshotState);
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-dev", messages: [{ id: "packc-shot", role: "user", text: "Screenshot from this tab", images: [screenshotUpload.path], at: Date.now() }], revision: 1, savedRevision: 1 });
    const screenshotButton = requireElement('#view [data-open-screenshots="alpha-dev"]'); screenshotButton.click();
    const screenshotViewer = requireElement('#viewer[aria-hidden="false"]');
    const viewerImage = requireElement("#viewerFiles .viewer-file img");
    const screenshotPathExact = screenshotResponse.status === 200 && viewerImage.src.includes(encodeURIComponent(screenshotUpload.path));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await clickTab("Design");
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-design", messages: [{ id: "packc-no-shot", role: "assistant", text: "No image in this tab", at: Date.now() }], revision: 1, savedRevision: 1 });
    const noScreenshotButton = !document.querySelector('#view [data-open-screenshots="alpha-design"]');
    check(`Approval screenshots use only the selected tab transcript at ${innerWidth}px`, screenshotViewer && screenshotPathExact && noScreenshotButton, { screenshotResponse: screenshotResponse.status, screenshotPath: screenshotUpload.path, viewerImage: viewerImage.src, noScreenshotButton });

    await clickTab("Development");
    showChat();
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    const heldReads = [];
    const heldBytes = new WeakMap();
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.type === "text/plain" && this.name.startsWith("packc-undo-")) return new Promise((resolve) => heldReads.push({ file: this, resolve }));
      return originalArrayBuffer.call(this);
    };
    const uploadDone = async (index, name) => {
      await waitFor(() => uploadRequests.length > index, `file upload request for ${name}`);
      const record = uploadRequests[index];
      const result = await record.promise;
      return { record, result };
    };
    const controlledFile = async (name) => {
      const file = new File([`contents for ${name}`], name, { type: "text/plain" });
      heldBytes.set(file, await originalArrayBuffer.call(file));
      const transfer = new DataTransfer(); transfer.items.add(file); $("attachInput").files = transfer.files;
      $("attachInput").dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => heldReads.some((item) => item.file === file), `pending file read for ${name}`);
      const read = heldReads.find((item) => item.file === file);
      return { file, resolve() { const index = heldReads.indexOf(read); if (index >= 0) heldReads.splice(index, 1); read.resolve(heldBytes.get(file)); } };
    };
    const startHeldAction = async (kind) => {
      if (kind === "tab") clickMenuItem(openTabMenu("alpha-dev"), "Remove tab");
      else if (kind === "project") clickMenuItem(openProjectMenu("alpha"), "Remove from Command Center");
      else { $("setupsBtn").click(); requireElement('#setupPop [data-set-process="solo"]').click(); }
      await waitFor(() => document.querySelector("#undo [data-undo-held]"), `${kind} Undo action`);
    };
    const raceClock = installTenSecondClock();
    const fileRaceNames = [];
    for (const kind of ["tab", "project", "process"]) for (const order of ["read-before-undo", "read-after-undo"]) {
      if (!latestTab("alpha-dev")) fail(`file race target alpha-dev missing before ${kind} ${order}`);
      if (window.__latestState.selectedTabId !== "alpha-dev") await clickTab("Development");
      const name = `packc-undo-${kind}-${order}.md`; const controlled = await controlledFile(name);
      const uploadIndex = uploadRequests.length; const actionStart = window.__sent.length;
      await startHeldAction(kind);
      if (order === "read-before-undo") controlled.resolve();
      const undo = requireElement("#undo [data-undo-held]"); undo.click();
      await waitFor(() => latestTab("alpha-dev") && window.__latestState.selectedTabId === "alpha-dev", `${kind} Undo restores its source tab`);
      if (order === "read-after-undo") controlled.resolve();
      const { record, result } = await uploadDone(uploadIndex, name);
      await waitFor(() => [...document.querySelectorAll("#atts [data-attachment]")].some((item) => item.textContent.includes(name) && !item.textContent.includes("Loading file")), `file attachment ready after ${kind} Undo`);
      const attachments = [...document.querySelectorAll("#atts [data-attachment]")].filter((item) => item.textContent.includes(name));
      const actionSent = window.__sent.slice(actionStart).some((item) => ["removeTab", "removeProject", "setProcess"].includes(item.type));
      const correctFile = record.path === "/api/paste-file" && safeId(record.requestId) && result.status === 200 && result.value.requestId === record.requestId && result.value.name === name;
      const oneReadyChip = attachments.length === 1 && attachments[0].querySelector(".file-icon")?.textContent === "md" && !attachments[0].querySelector("img") && attachments[0].textContent.includes(name);
      check(`file attachment ${name} completes in ${order} around ${kind} Undo`, correctFile && oneReadyChip && !actionSent && heldReads.every((item) => item.file !== controlled.file), { kind, order, request: { path: record.path, requestId: record.requestId, fileName: record.fileName }, response: result, correctFile, attachmentCount: attachments.length, chipText: attachments[0]?.textContent, hasFileIcon: Boolean(attachments[0]?.querySelector(".file-icon")), noEmptyImage: !attachments[0]?.querySelector("img"), actionSent, pendingRead: heldReads.some((item) => item.file === controlled.file), tabId: window.__latestState.selectedTabId });
      fileRaceNames.push(name);
      const remove = requireElement("#atts [data-remove-attachment]"); remove.click();
      const released = !document.querySelector(`#atts [data-attachment]`) && uploadRequests.length === uploadIndex + 1;
      check(`completed file attachment ${name} releases and does not duplicate`, released, { name, remaining: document.querySelectorAll("#atts [data-attachment]").length, uploadCount: uploadRequests.length - uploadIndex });
    }
    raceClock.restore(); Blob.prototype.arrayBuffer = originalArrayBuffer;

    const fileName = "chat-note.md";
    const file = new File(["Here is the note"], fileName, { type: "text/markdown" });
    const fileBytes = await originalArrayBuffer.call(file);
    let resolveChatFileRead;
    const chatFileRead = new Promise((resolve) => { resolveChatFileRead = resolve; });
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.name === fileName) return chatFileRead;
      return originalArrayBuffer.call(this);
    };
    const transfer = new DataTransfer(); transfer.items.add(file); $("attachInput").files = transfer.files;
    $("attachInput").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => [...document.querySelectorAll("#atts [data-attachment]")].some((item) => item.textContent.includes(fileName) && item.textContent.includes("Loading file")), "loading chat file chip");
    const loadingFileShown = $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden;
    $("ci").value = "Review the attached note"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const chatStart = window.__sent.length;
    const chatCountBeforeFileRead = window.__sent.filter((item) => item.type === "chat").length;
    $("sendBtn").click();
    await waitFor(() => $("sendBtn").disabled && $("chatStatus").textContent === "Loading file", "send lock while chat file is loading");
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settleMicrotasks();
    const chatCountWhileFileRead = window.__sent.filter((item) => item.type === "chat").length;
    const fileSendWaits = loadingFileShown && chatCountWhileFileRead === chatCountBeforeFileRead && $("sendBtn").disabled;
    check(`chat waits for an in-flight non-image file read before sending at ${innerWidth}px`, fileSendWaits, { loadingFileShown, chatCountBeforeFileRead, chatCountWhileFileRead, sendDisabled: $("sendBtn").disabled, status: $("chatStatus").textContent });
    resolveChatFileRead(fileBytes);
    Blob.prototype.arrayBuffer = originalArrayBuffer;
    await waitFor(() => uploadRequests.some((item) => item.path === "/api/paste-file" && item.fileName === encodeURIComponent(fileName)), "chat file POST");
    const sentFileRequest = uploadRequests.find((item) => item.path === "/api/paste-file" && item.fileName === encodeURIComponent(fileName));
    const sentFileUpload = await sentFileRequest.promise;
    await waitFor(() => window.__sent.slice(chatStart).some((item) => item.type === "chat" && item.text === "Review the attached note"), "chat with file attachment");
    const fileChat = window.__sent.slice(chatStart).find((item) => item.type === "chat");
    await waitFor(() => document.querySelector('#view .file-chip'), "transcript file chip");
    const fileChatGood = sentFileUpload.status === 200 && safeId(sentFileRequest.requestId) && fileChat?.tabId === "alpha-dev" && Array.isArray(fileChat.files) && fileChat.files.length === 1 && fileChat.files[0] === sentFileUpload.value.path && safeId(fileChat.requestId) && document.querySelector('#view .file-chip')?.textContent.includes(".md");
    check(`non-image attachment uploads, waits, sends files and renders a transcript chip at ${innerWidth}px`, fileChatGood, { upload: { requestId: sentFileRequest.requestId, fileName: sentFileRequest.fileName, status: sentFileUpload.status, value: sentFileUpload.value }, chat: fileChat ?? null, fileChip: document.querySelector('#view .file-chip')?.textContent ?? null, raceFiles: fileRaceNames });

    window.fetch = nativeFetch;
    return { ids: [...seenRequestIds], uploads: uploadRequests.map((item) => ({ path: item.path, requestId: item.requestId, fileName: item.fileName })) };
  };

  const runRequestsReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "live request test state");
    const settingsRefreshStart = window.__received.length;
    window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
    await waitFor(() => window.__received.slice(settingsRefreshStart).some((item) => item.type === "settingsRefreshed"), "read-only settings refresh from the fake-runner server");
    const refreshedSettings = window.__latestState.settings;
    check("the real browser server probes Gemini and GitHub through its scripted fake runner", refreshedSettings.tools.gemini.installed === false && refreshedSettings.tools.gemini.signedIn === null && refreshedSettings.github.connected === false, { gemini: refreshedSettings.tools.gemini, github: refreshedSettings.github, acknowledgment: window.__received.slice(settingsRefreshStart).find((item) => item.type === "settingsRefreshed") });
    const tabById = (id) => window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === id);
    const beta = window.__latestState.projects.find((project) => project.id === "beta");
    const addedTab = { type: "addTab", projectId: "beta", name: "Temporary request target", kind: "dev", process: "duo", folder: beta.folder };
    const addStart = window.__received.length; window.__socket.send(JSON.stringify(addedTab));
    await waitFor(() => tabById("temporary-request-target") || window.__latestState.projects.find((project) => project.id === "beta")?.tabs.some((tab) => tab.name === "Temporary request target"), "temporary request destination tab");
    const destination = beta.tabs.find((tab) => tab.name === "Temporary request target")?.id ?? window.__latestState.projects.find((project) => project.id === "beta").tabs.find((tab) => tab.name === "Temporary request target").id;
    pickProject("alpha");
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "request source alpha-dev");
    openRequests(); $("reqTo").value = destination; $("reqTitle").value = "Review from the other tab"; $("reqBody").value = "Check this request path.";
    const sendStart = window.__sent.length; $("reqForm").requestSubmit();
    try { await waitFor(() => window.__sent.slice(sendStart).some((item) => item.type === "sendRequest"), "real sendRequest from alpha-dev"); }
    catch (error) { fail(`${error.message}; submit evidence ${JSON.stringify({ selectedTabId: window.__latestState.selectedTabId, reqFormValid: $("reqForm").checkValidity(), reqTo: $("reqTo").value, options: [...$("reqTo").options].map((option) => option.value), title: $("reqTitle").value, titleValid: $("reqTitle").checkValidity(), body: $("reqBody").value, bodyValid: $("reqBody").checkValidity(), sendDisabled: $("reqSend").disabled, inboxHidden: $("inboxPop").hidden, status: $("reqStatus").textContent, sent: window.__sent.slice(sendStart), received: window.__received.slice(-5) })}`); }
    const send = window.__sent.slice(sendStart).find((item) => item.type === "sendRequest");
    await waitFor(() => window.__latestState.requests?.some((item) => item.fromTabId === "alpha-dev" && item.toTabId === destination && item.title === "Review from the other tab"), "server-persisted cross-project request");
    const request = window.__latestState.requests.find((item) => item.fromTabId === "alpha-dev" && item.toTabId === destination && item.title === "Review from the other tab");
    pickProject("beta");
    await waitFor(() => window.__latestState.projects.find((project) => project.id === "beta")?.tabs.some((tab) => tab.id === window.__latestState.selectedTabId), "Beta destination project");
    requireElement(`#tabs [data-tab-id="${CSS.escape(destination)}"]`).click();
    await waitFor(() => window.__latestState.selectedTabId === destination, "temporary request destination tab");
    const badge = $("reqN").textContent;
    openInbox(); const waiting = [...document.querySelectorAll("#inboxList .ncard")].some((card) => card.textContent.includes("Review from the other tab"));
    const acceptStart = window.__sent.length; requireElement(`[data-request-action="accept:${request.id}"]`).click();
    await waitFor(() => window.__latestState.requests?.find((item) => item.id === request.id)?.status === "accepted", "server accepts the cross-tab request");
    const accept = window.__sent.slice(acceptStart).find((item) => item.type === "resolveRequest");
    const countDropped = Number(window.__latestState.pendingRequestCounts?.[destination] ?? -1) === 0 && $("reqN").hidden;
    const exactAccept = send?.fromTabId === "alpha-dev" && send?.toTabId === destination && Boolean(send.requestId) && accept?.id === request.id && accept.status === "accepted" && Boolean(accept.requestId) && accept.requestId !== send.requestId;

    pickProject("alpha");
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "return to request source after accept");
    openRequests(); $("reqTo").value = destination; $("reqTitle").value = "Decline from server"; $("reqBody").value = "Decline test";
    const declineSendStart = window.__sent.length; $("reqForm").requestSubmit();
    await waitFor(() => window.__latestState.requests?.some((item) => item.title === "Decline from server"), "second server request");
    const toDecline = window.__latestState.requests.find((item) => item.title === "Decline from server");
    // A project tab reopens the tab last shown in it, here the destination itself.
    pickProject("beta");
    await waitFor(() => window.__latestState.projects.find((project) => project.id === "beta")?.tabs.some((tab) => tab.id === window.__latestState.selectedTabId), "Beta destination before decline");
    requireElement(`#tabs [data-tab-id="${CSS.escape(destination)}"]`).click();
    await waitFor(() => window.__latestState.selectedTabId === destination, "request destination before decline");
    openInbox();
    const declineStart = window.__sent.length; requireElement(`[data-request-action="decline:${toDecline.id}"]`).click();
    await waitFor(() => window.__latestState.requests?.find((item) => item.id === toDecline.id)?.status === "declined", "server declines the request");
    const decline = window.__sent.slice(declineStart).find((item) => item.type === "resolveRequest");

    pickProject("alpha");
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "return to request source before destination removal");
    openRequests(); $("reqTo").value = destination; $("reqTitle").value = "Destination removal"; $("reqBody").value = "This tab will be removed.";
    const removedSendStart = window.__sent.length; $("reqForm").requestSubmit();
    await waitFor(() => window.__latestState.requests?.some((item) => item.title === "Destination removal"), "request to removable destination");
    const removedRequest = window.__latestState.requests.find((item) => item.title === "Destination removal");
    window.__socket.send(JSON.stringify({ type: "removeTab", tabId: destination }));
    await waitFor(() => window.__latestState.requests?.find((item) => item.id === removedRequest.id)?.status === "destinationRemoved", "server marks the request destination removed");
    openInbox();
    const removedCard = requireElement(`#reqList [data-request-id="${removedRequest.id}"]`);
    const removedShown = removedCard.textContent.includes("Destination removed") && removedCard.classList.contains("removed");
    check("requests run end to end on the fake-runner server: send, badge, accept/decline, and destination removed", exactAccept && waiting && badge === "1" && countDropped && decline?.id === toDecline.id && decline.status === "declined" && Boolean(decline.requestId) && removedShown, { addMessage: addedTab, addAck: window.__received.slice(addStart).find((item) => item.type === "state")?.type, destination, send: send ?? null, request: request ?? null, badge, waiting, accept: accept ?? null, countDropped, decline: decline ?? null, removedRequest: window.__latestState.requests.find((item) => item.id === removedRequest.id), removedCard: removedCard.textContent, removedShown });
  };

  const runPackCSettingsReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real Pack C settings state");
    window.__socket.send(JSON.stringify({ type: "selectTab", tabId: "alpha-dev" }));
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "real Settings source tab");
    const refreshStart = window.__received.length;
    window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
    await waitFor(() => window.__received.slice(refreshStart).some((item) => item.type === "settingsRefreshed"), "fake-runner Settings refresh");

    const sections = ["crew", "tools", "github", "vault", "folders", "skills", "appearance", "behaviour"];
    const openSettingsSection = (section) => {
      if ($("setModal").hidden) $("setBtn").click();
      requireElement(`#setNav [data-settings-section="${section}"]`).click();
      return requireElement(`#setBody #s-${section}`);
    };
    openSettingsSection("tools");
    const targets = ["#setBtn", "#setModal", "#setNav", "#setBody", "#vaultPath", "#defaultProjectFolder", "#permBtn", "#permPop"];
    const missingTargets = targets.filter((selector) => !document.querySelector(selector));
    check(`real fake-runner Settings and permission targets exist at ${innerWidth}px`, missingTargets.length === 0, { found: targets.filter((selector) => document.querySelector(selector)), missing: missingTargets });
    const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
    const requestIds = new Set();
    const uniqueId = (value) => { const unique = safeId(value) && !requestIds.has(value); if (unique) requestIds.add(value); return unique; };
    const sectionTargets = sections.map((section) => `#setNav [data-settings-section="${section}"]`);
    const missingSections = sectionTargets.filter((selector) => !document.querySelector(selector));
    check(`real Settings nav finds all eight sections at ${innerWidth}px`, missingSections.length === 0, { found: sectionTargets.filter((selector) => document.querySelector(selector)), missing: missingSections });

    const tabFor = (tabId) => window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === tabId);
    const actionState = (requestId) => window.__latestState?.requestActions?.[requestId] ?? null;
    const serverAction = async ({ name, section, selector, type, fields = {}, result = "failed", message }) => {
      openSettingsSection(section);
      if (type === "mcpAdd") {
        const form = document.querySelector(`[data-mcp-form="${CSS.escape(fields.cli)}"]`);
        if (form?.hidden) requireElement(`[data-settings-add="mcp-${CSS.escape(fields.cli)}"]`).click();
      }
      if (type === "pluginInstall") {
        const form = requireElement("[data-plugin-form]");
        if (form.hidden) requireElement('[data-settings-add="plugins-claude"]').click();
      }
      const start = window.__sent.length;
      if (type === "setNotesVault") { requireElement("#vaultPath").value = fields.path ?? ""; requireElement("#vaultPath").dispatchEvent(new Event("input", { bubbles: true })); }
      if (type === "setDefaultProjectFolder") requireElement("#defaultProjectFolder").value = fields.folder ?? "";
      const button = requireElement(selector); const form = button.form;
      if (type === "mcpAdd" && form) { form.elements.name.value = fields.name; form.elements.commandOrUrl.value = fields.commandOrUrl; }
      if (type === "pluginInstall" && form) form.elements.name.value = fields.name;
      button.focus(); button.click(); confirmIfAsked();
      const sent = window.__sent.slice(start).filter((item) => item.type === type).at(-1);
      const idGood = uniqueId(sent?.requestId);
      const expected = { type, ...fields };
      const exact = Boolean(sent && idGood
        && Object.keys(sent).length === Object.keys(expected).length + 1
        && Object.entries(expected).every(([key, value]) => sent[key] === value)
        && Object.keys(sent).every((key) => key === "requestId" || Object.hasOwn(expected, key)));
      const pendingButton = requireElement(selector);
      const disabledWhilePending = pendingButton.disabled;
      await waitFor(() => actionState(sent?.requestId)?.status === result, `${name} server action result`);
      const final = actionState(sent.requestId);
      const statusNode = document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`);
      const runningReceived = window.__received.some((item) => item.type === "state" && item.requestActions?.[sent.requestId]?.status === "running");
      const statusShown = statusNode?.dataset.status === result && statusNode.textContent.includes(message);
      const finalButton = requireElement(selector);
      const reenabled = !finalButton.disabled;
      const clearVaultFocusKey = type === "setNotesVault" && fields.path === null && finalButton.disabled
        ? (document.querySelector('#s-vault [data-setting-action="vault-browse"]') ? "vault-browse" : "vault-path")
        : button.dataset.focusKey;
      const focusRestored = document.activeElement?.dataset.focusKey === clearVaultFocusKey;
      check(`${name} shows real server status for its fresh id at ${innerWidth}px`, exact && runningReceived && disabledWhilePending && statusShown && (reenabled || clearVaultFocusKey !== button.dataset.focusKey) && focusRestored && final.message === message, { sent: sent ?? null, expected: { ...expected, requestId: "<fresh unique request id>" }, exact, runningReceived, disabledWhilePending, final, statusNode: statusNode ? { status: statusNode.dataset.status, message: statusNode.textContent } : null, statusShown, reenabled, focusRestored, expectedFocusKey: clearVaultFocusKey });
      return sent;
    };

    const settings = window.__latestState.settings;
    const gemini = settings.tools.gemini;
    const geminiFiles = settings.skills.gemini.instructionFiles.map((item) => item.path.replaceAll("\\", "/").split("/").slice(-2).join("/"));
    const geminiHasGlobalInstructions = settings.skills.gemini.instructionFiles.some((item) => item.scope === "global" && item.path.replaceAll("\\", "/").endsWith("/.gemini/GEMINI.md"));
    const geminiHasProjectInstructions = settings.skills.gemini.instructionFiles.some((item) => item.scope === "project" && item.path.replaceAll("\\", "/").endsWith("/GEMINI.md"));
    const geminiSafe = gemini.installed === false && gemini.signedIn === null
      && geminiHasGlobalInstructions && geminiHasProjectInstructions
      && settings.skills.gemini.skills.length === 0 && settings.skills.gemini.mcpServers.length === 0 && settings.skills.gemini.plugins.length === 0
      && !document.querySelector('#s-tools [data-setting-action="login-cli"][data-cli="gemini"]')
      && !document.querySelector('#s-skills [data-mcp-form="gemini"]');
    const installedHasNoInstall = !document.querySelector('#s-tools [data-setting-action="install-cli"][data-cli="claude"]');
    const geminiInstall = requireElement('#s-tools [data-setting-action="install-cli"][data-cli="gemini"]');
    window.__ccConfirmResult = false;
    let start = window.__sent.length; geminiInstall.click();
    const installDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "installCli");
    window.__ccConfirmResult = true;
    check(`real Gemini remains install-only with server instruction inventory at ${innerWidth}px`, geminiSafe && installedHasNoInstall && installDenied, { gemini: { installed: gemini.installed, signedIn: gemini.signedIn }, geminiFiles, instructionScopes: settings.skills.gemini.instructionFiles.map((item) => item.scope), geminiHasGlobalInstructions, geminiHasProjectInstructions, skills: settings.skills.gemini.skills, mcp: settings.skills.gemini.mcpServers, plugins: settings.skills.gemini.plugins, geminiSafe, installedHasNoInstall, installDenied });

    await serverAction({ name: "Gemini install", section: "tools", selector: '#s-tools [data-setting-action="install-cli"][data-cli="gemini"]', type: "installCli", fields: { cli: "gemini", confirm: true }, message: "CLI installation failed" });
    await serverAction({ name: "Claude sign-in", section: "tools", selector: '#s-tools [data-setting-action="login-cli"][data-cli="claude"]', type: "cliLogin", fields: { cli: "claude" }, message: "could not open the CLI login window" });
    await serverAction({ name: "GitHub connect", section: "github", selector: '#s-github [data-setting-action="github-login"]', type: "ghLogin", message: "could not open the GitHub login window" });

    const folder = window.__ccFolderChoice;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const noVaultButton = requireElement('#lowerBody [data-open-vault]');
    const noVaultNoop = noVaultButton.disabled && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    const openedBeforeNoVault = window.__ccOpenedObsidian.length; noVaultButton.click();
    const noVaultStillClosed = window.__ccOpenedObsidian.length === openedBeforeNoVault;
    await serverAction({ name: "Notes vault refusal", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: `${folder}\\missing-vault` }, message: "Notes vault folder does not exist" });
    await serverAction({ name: "Notes vault save", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: folder }, result: "done", message: "Done" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const expectedObsidian = `obsidian://open?path=${encodeURIComponent(folder)}`;
    const openVault = requireElement('#lowerBody [data-open-vault]'); openVault.click();
    await waitFor(() => window.__ccOpenedObsidian.at(-1) === expectedObsidian, "real Open in Obsidian route");
    const obsidianPathExact = window.__ccOpenedObsidian.at(-1) === expectedObsidian;
    check(`real Notes vault Open in Obsidian uses the encoded server path at ${innerWidth}px`, noVaultNoop && noVaultStillClosed && obsidianPathExact, { noVaultNoop, noVaultStillClosed, expectedObsidian, opened: window.__ccOpenedObsidian.slice() });

    const defaultFolder = requireElement("#defaultProjectFolder");
    defaultFolder.value = `${folder}\\missing-folder`;
    await serverAction({ name: "Default folder refusal", section: "folders", selector: '#s-folders [data-setting-action="folder-save"]', type: "setDefaultProjectFolder", fields: { folder: `${folder}\\missing-folder` }, message: "Default project folder folder does not exist" });
    defaultFolder.value = folder;
    await serverAction({ name: "Default folder save", section: "folders", selector: '#s-folders [data-setting-action="folder-save"]', type: "setDefaultProjectFolder", fields: { folder }, result: "done", message: "Done" });
    const browseStart = window.__sent.length;
    requireElement('#s-folders [data-setting-action="folder-browse"]').click();
    await waitFor(() => requireElement("#defaultProjectFolder").value === folder, "real default folder picker result");
    const defaultBrowseGood = requireElement("#defaultProjectFolder").value === folder && !window.__sent.slice(browseStart).some((item) => item.type === "changeFolder");
    const selectedProject = window.__latestState.projects.find((project) => project.tabs.some((tab) => tab.id === window.__latestState.selectedTabId));
    const browseTab = selectedProject?.tabs.find((tab) => tab.id !== window.__latestState.selectedTabId);
    if (!browseTab) throw new Error("real tab-folder Browse requires a non-selected tab in the current project");
    const tabBrowseStart = window.__sent.length;
    requireElement('#s-folders [data-setting-action="tab-folder-browse"][data-tab-id="' + CSS.escape(browseTab.id) + '"]').click();
    await waitFor(() => tabFor(browseTab.id)?.folder === folder, "real tab-folder Browse update");
    const tabBrowse = window.__sent.slice(tabBrowseStart).find((item) => item.type === "changeFolder");
    const tabBrowseGood = tabBrowse?.tabId === browseTab.id && tabBrowse.folder === folder && tabBrowse.requestId === undefined;
    check(`real folder pickers update the default and selected tab at ${innerWidth}px`, defaultBrowseGood && tabBrowseGood, { defaultBrowseGood, tabBrowse: tabBrowse ?? null, folder });

    openSettingsSection("skills");
    const mcpForm = requireElement('#s-skills [data-mcp-form="claude"]');
    const mcpRemove = requireElement('#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]');
    window.__ccConfirmResult = false; start = window.__sent.length; mcpRemove.click();
    const mcpRemoveDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "mcpRemove");
    window.__ccConfirmResult = true;
    const mcpAdd = await serverAction({ name: "MCP add", section: "skills", selector: '#s-skills [data-mcp-form="claude"] button[type="submit"]', type: "mcpAdd", fields: { cli: "claude", name: "valid_mcp", commandOrUrl: "npx -y server" }, message: "MCP add failed" });
    await serverAction({ name: "MCP remove", section: "skills", selector: '#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]', type: "mcpRemove", fields: { cli: "claude", name: "claude_mcp", confirm: true }, message: "MCP removal failed" });
    const pluginForm = requireElement('#s-skills [data-plugin-form]'); pluginForm.elements.name.value = "sample-plugin";
    await serverAction({ name: "Plugin install", section: "skills", selector: '#s-skills [data-plugin-form] button[type="submit"]', type: "pluginInstall", fields: { name: "sample-plugin" }, message: "plugin install failed" });
    const pluginRemove = requireElement('#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]');
    window.__ccConfirmResult = false; start = window.__sent.length; pluginRemove.click();
    const pluginRemoveDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "pluginUninstall");
    window.__ccConfirmResult = true;
    await serverAction({ name: "Plugin remove", section: "skills", selector: '#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]', type: "pluginUninstall", fields: { name: "sample-plugin", confirm: true }, message: "plugin uninstall failed" });
    check(`real MCP and plugin actions use server refusals and require confirmation at ${innerWidth}px`, mcpRemoveDenied && pluginRemoveDenied && Boolean(mcpAdd?.requestId), { mcpRemoveDenied, pluginRemoveDenied, mcpAdd: mcpAdd ?? null });

    const permissionStart = window.__sent.length;
    const permissionButton = $("permBtn"); permissionButton.focus(); permissionButton.click();
    const modes = ["ask", "accept", "plan", "bypass"];
    const missingModes = modes.filter((mode) => !document.querySelector(`[data-permission-mode="${mode}"]`));
    const savedAccept = document.querySelector('[data-permission-mode="accept"]')?.getAttribute("aria-pressed") === "true";
    window.__ccConfirmResult = false; start = window.__sent.length;
    requireElement('[data-permission-mode="bypass"]').click();
    const bypassDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "setPermissionMode");
    window.__ccConfirmResult = true;
    permissionButton.click(); requireElement('#permPop [data-permission-mode="plan"]').click();
    const plan = window.__sent.slice(permissionStart).find((item) => item.type === "setPermissionMode");
    const planIdGood = uniqueId(plan?.requestId) && plan?.tabId === "alpha-dev" && plan.mode === "plan";
    await waitFor(() => actionState(plan?.requestId)?.status === "done", "real plan permission result");
    const planShown = permissionButton.textContent.includes("Plan only") && !permissionButton.querySelector(".perm-state") && permissionButton.title.includes("Done") && !permissionButton.disabled;
    const permissionFocus = document.activeElement === permissionButton;
    permissionButton.click(); window.__ccConfirmResult = true;
    requireElement('[data-permission-mode="bypass"]').click(); confirmIfAsked();
    const bypass = window.__sent.slice(permissionStart).filter((item) => item.type === "setPermissionMode").at(-1);
    const bypassIdGood = uniqueId(bypass?.requestId) && bypass?.tabId === "alpha-dev" && bypass.mode === "bypass" && bypass.confirm === true;
    await waitFor(() => actionState(bypass?.requestId)?.status === "done", "real bypass permission result");
    const bypassShown = $("permBtn").textContent.includes("Bypass permissions") && !$("permBtn").querySelector(".perm-state") && !$("permBtn").disabled;
    const permissionFinal = window.__latestState.settings.permissionModes["alpha-dev"] === "bypass";
    permissionButton.click(); requireElement('[data-permission-mode="accept"]').click();
    const resetMode = window.__sent.slice(permissionStart).filter((item) => item.type === "setPermissionMode").at(-1);
    await waitFor(() => actionState(resetMode?.requestId)?.status === "done" && window.__latestState.settings.permissionModes["alpha-dev"] === "accept", "restore default permission mode");
    check(`real per-tab permission flow uses server state and confirmation at ${innerWidth}px`, missingModes.length === 0 && modes.join(",") === "ask,accept,plan,bypass" && savedAccept && bypassDenied && planIdGood && planShown && permissionFocus && bypassIdGood && bypassShown && permissionFinal, { missingModes, savedAccept, bypassDenied, plan: plan ?? null, planShown, permissionFocus, bypass: bypass ?? null, bypassShown, permissionFinal, resetMode: resetMode ?? null });

    await serverAction({ name: "Clear Notes vault", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: null }, result: "done", message: "Done" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const noVaultAfterClear = requireElement('#lowerBody [data-open-vault]').disabled && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    check(`real Notes vault clears back to its honest no-vault state at ${innerWidth}px`, noVaultAfterClear, { vaultPath: window.__latestState.settings.vault.path, openDisabled: requireElement('#lowerBody [data-open-vault]').disabled, vaultState: text("#lowerBody [data-vault-empty]") });
  };

  const runLayout = async () => {
    await waitFor(() => window.__latestState?.type === "state", "layout state");
    pressEscape(); showChat();
    const selectedTab = window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === window.__latestState.selectedTabId);
    const leaderSeat = selectedTab.crew.find((seat) => seat.isLeader || seat.slot === "leader");
    const coderSeat = selectedTab.crew.find((seat) => seat.slot === "coder");
    const knownModels = { "gpt-6-luna": "Luna 6", "gpt-6-sol": "Sol 6", "gpt-6-astra": "Astra 6", "deepseek/deepseek-flash": "DeepSeek Flash", "deepseek/deepseek-pro": "DeepSeek Pro", "opencode/mimo-v2.6-flash-free": "MiMo Flash (free)", "opencode/muse-spark-1.3-contributor-free": "Muse Spark (free)", "opencode-go/gpt-5.6-luna": "GPT 5.6 Luna (Go)", "google/gemini-3-pro": "Gemini 3 Pro", "google/gemini-3-flash": "Gemini 3 Flash", "moonshot/kimi-k3": "Kimi K3", "qwen/qwen4-coder": "Qwen 4 Coder", "zai/glm-5": "GLM 5", "xai/grok-5": "Grok 5", "mistral/devstral-3": "Devstral 3", "openrouter/llama-5-405b": "Llama 5 405B" };
    const expectedModel = (seat) => seat.cli === "claude"
      ? (window.__latestState.claudeModels?.find((model) => model.value === seat.model)?.displayName ?? seat.model).replace(/\s*\([^)]*context[^)]*\)$/i, "").trim()
      : knownModels[seat.model] ?? seat.model;
    // Model and effort read where they are now shown: each seat's card.
    const leadCard = openSeatCard("leader");
    const leadParts = [requireElement("[data-seat-model] .model-label", leadCard), requireElement("[data-seat-model] .eff", leadCard)];
    const leadModel = leadParts[0].textContent.trim(), leadEffort = leadParts[1].textContent.trim();
    const leadFit = leadParts.map((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    pressEscape();
    const coderCard = openSeatCard("coder");
    const coderParts = [requireElement("[data-seat-model] .model-label", coderCard), requireElement("[data-seat-model] .eff", coderCard)];
    const coderModel = coderParts[0].textContent.trim(), coderEffort = coderParts[1].textContent.trim();
    const coderFit = coderParts.map((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    pressEscape();
    const modelPartsFit = [...leadFit, ...coderFit].every((part) => part.width > 0 && part.scrollWidth <= part.width);
    check(`B1 model labels and effort fit at ${innerWidth}px`, leadModel === expectedModel(leaderSeat) && leadEffort.includes(leaderSeat.effort) && coderModel === expectedModel(coderSeat) && coderEffort.includes(coderSeat.effort) && modelPartsFit, { leadModel, expectedLead: expectedModel(leaderSeat), leadEffort, expectedLeadEffort: leaderSeat.effort, coderModel, expectedCoder: expectedModel(coderSeat), coderEffort, expectedCoderEffort: coderSeat.effort, modelPartsFit, parts: [...leadFit, ...coderFit] });
    const long = "W".repeat(40), longState = structuredClone(window.__latestState);
    const longEntry = longState.projects.flatMap((project) => project.tabs.map((tab) => ({ project, tab }))).find(({ tab }) => tab.id === longState.selectedTabId);
    longEntry.project.name = long; longEntry.tab.name = long;
    for (const seat of longEntry.tab.crew) seat.name = long;
    window.__ccDeliver({ ...longState, type: "state" });
    const clipped = (element) => Boolean(element && getComputedStyle(element).overflow === "hidden" && getComputedStyle(element).textOverflow === "ellipsis");
    const projectName = document.getElementById("projName"), tabName = document.querySelector('#tabs [role=tab][aria-selected="true"] .tl');
    openSeatView("coder");
    const crewName = document.querySelector('#crew .name');
    const stageName = document.querySelector("#stagehead [data-seat-name]");
    const longLabelsFit = [projectName, tabName, crewName, stageName?.parentElement].every(clipped) && stageName?.title === long && document.documentElement.scrollWidth <= innerWidth;
    check("long server names truncate inside project, tab, crew and stage controls", longLabelsFit, { project: projectName?.textContent, tab: tabName?.textContent, crew: crewName?.textContent, stageTitle: stageName?.title, clipped: [projectName, tabName, crewName, stageName?.parentElement].map((element) => element ? `${element.tagName}.${element.className}:${element.isConnected}:${getComputedStyle(element).overflow}/${getComputedStyle(element).textOverflow}` : "missing"), scrollWidth: document.documentElement.scrollWidth, width: innerWidth });
    showChat();
    const controls = [...document.querySelectorAll("button,[role=button]")].filter((element) => {
      if (element.closest("[hidden],[inert]")) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const unnamedControls = controls.filter((element) => !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.title || element.textContent.trim()));
    check("every visible button has an accessible name", unnamedControls.length === 0, { checked: controls.length, unnamed: unnamedControls.map((element) => element.outerHTML.slice(0, 120)) });
    const stageTargets = ["#stage .shead", "#sline", "#view", "#composer", "#ci", "#sendBtn"];
    $("ci").value = "Layout audit draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const missingStageTargets = stageTargets.filter((selector) => !document.querySelector(selector));
    check("every audited stage target was found", missingStageTargets.length === 0, { found: stageTargets.filter((selector) => document.querySelector(selector)), missing: missingStageTargets });
    const stageParts = stageTargets.map((selector) => document.querySelector(selector));
    const stageVisible = stageParts.every((element) => element && !element.hidden && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    const stageInside = stageParts.every((element) => { if (!element) return false; const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; });
    const stageClickable = stageParts.every((element) => { if (!element) return false; const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return Boolean(hit && (element.contains(hit) || hit.contains(element)) && !element.disabled); });
    const stageOverlaps = [];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const a = stageParts[i]?.getBoundingClientRect(), b = stageParts[j]?.getBoundingClientRect(); if (a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) stageOverlaps.push(stageTargets[i] + " / " + stageTargets[j]); }
    check("stage header, steps, transcript and composer fit and remain clickable", stageVisible && stageInside && stageClickable && stageOverlaps.length === 0, { visible: stageVisible, inside: stageInside, clickable: stageClickable, overlaps: stageOverlaps, viewport: { width: innerWidth, height: innerHeight }, children: [...document.querySelector("#stage > .col").children].map((element) => { const rect = element.getBoundingClientRect(); return { id: element.id, className: element.className, hidden: element.hidden, top: rect.top, bottom: rect.bottom, height: rect.height }; }) });
    const top = document.getElementById("top");
    const topChildren = [...top.children].filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; });
    const headerOverlaps = [];
    for (let i = 0; i < topChildren.length; i++) for (let j = i + 1; j < topChildren.length; j++) { const a = topChildren[i].getBoundingClientRect(), b = topChildren[j].getBoundingClientRect(); if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) headerOverlaps.push(String(topChildren[i].id || topChildren[i].className) + " / " + String(topChildren[j].id || topChildren[j].className)); }
    const box = (element) => { const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }; };
    const column = document.querySelector("#stage > .col");
    const noHorizontalScroll = () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth;
    // Details starts closed (the mockup's default); the crew rail and the chat column never overlap.
    const closedRects = { rail: box($("rail")), column: box(column), stage: box($("stage")) };
    const closedLayout = $("side").hidden && closedRects.rail.right <= closedRects.column.left + 1 && closedRects.column.right <= closedRects.stage.right + 1 && noHorizontalScroll();
    // Open, it sits beside the chat from 1280px up and floats over the chat's right edge below that, always inside the window.
    $("sideBtn").click();
    const floating = innerWidth < 1280;
    const openRects = { column: box(column), side: box($("side")) };
    const openLayout = !$("side").hidden && openRects.side.width >= 280 && openRects.side.right <= innerWidth && noHorizontalScroll()
      && (floating ? getComputedStyle($("side")).position === "absolute" : openRects.column.right <= openRects.side.left + 1);
    $("sideBtn").click();
    check("layout at " + innerWidth + "px has no horizontal scroll or panel overlap", closedLayout && openLayout && headerOverlaps.length === 0, { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, closedRects, openRects, floating, sidePosition: getComputedStyle($("side")).position, headerOverlaps });
    if (innerWidth === 1100) {
      // Open or closed is the server's client pref detailsOpen (a new window on a new port has no localStorage): only a click on Details sends it, never a resize.
      const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
      const sentFrom = window.__sent.length;
      const sideWrites = () => window.__sent.slice(sentFrom).filter((message) => message.type === "updateClientPref" && message.key === "detailsOpen").map((message) => String(message.value));
      const setWindowWidth = (width) => { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); window.dispatchEvent(new Event("resize")); };
      const sideShown = () => !$("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "true";
      setWindowWidth(1100);
      setWindowWidth(1400);
      const resizeNeverWrites = sideWrites().length === 0 && !sideShown();
      $("sideBtn").click();
      const userOpenPersists = sideShown() && sideWrites().join() === "true";
      setWindowWidth(1100);
      const narrowKeepsChoice = sideShown() && sideWrites().length === 1;
      setWindowWidth(1400);
      const wideKeepsChoice = sideShown() && sideWrites().length === 1;
      $("sideBtn").click();
      const userClosePersists = !sideShown() && sideWrites().join() === "true,false";
      if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor); else delete window.innerWidth;
      window.dispatchEvent(new Event("resize"));
      check("Details open or closed is saved only by the user and survives resizing", resizeNeverWrites && userOpenPersists && narrowKeepsChoice && wideKeepsChoice && userClosePersists && Boolean(widthDescriptor?.configurable), { resizeNeverWrites, userOpenPersists, narrowKeepsChoice, wideKeepsChoice, userClosePersists, sideWrites: sideWrites(), widthDescriptorConfigurable: widthDescriptor?.configurable ?? false });
    }
    // A new window (new port, empty localStorage) gets its layout from the server's prefs: a state that says the rail is closed and Details open shows exactly that.
    if (window.__ccSeed) {
      const prefsBefore = structuredClone(window.__ccSeed.clientPrefs ?? {});
      window.__ccSeed.clientPrefs = { ...prefsBefore, crewRailOpen: false, detailsOpen: true };
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      const shownLayout = () => ({ wide: $("stage").classList.contains("wide"), railExpanded: $("railBtn").getAttribute("aria-expanded"), sideHidden: $("side").hidden, sidePressed: $("sideBtn").getAttribute("aria-pressed") });
      const fromServerShown = shownLayout();
      const fromServer = !fromServerShown.wide && fromServerShown.railExpanded === "false" && !fromServerShown.sideHidden && fromServerShown.sidePressed === "true";
      window.__ccSeed.clientPrefs = { ...prefsBefore, crewRailOpen: true, detailsOpen: false };
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      const backFromServer = $("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "true" && $("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "false";
      window.__ccSeed.clientPrefs = prefsBefore;
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      check("the crew rail and Details open or closed come from the server's client prefs, not localStorage", fromServer && backFromServer, { fromServer, backFromServer, fromServerShown, prefs: window.__latestState.clientPrefs, errors: window.__ccErrors.slice(-3) });
    }
    // The crew rail collapses to the mockup's 60px face strip and back to 224px; Details toggles open and shut.
    const railWidth = () => Math.round($("rail").getBoundingClientRect().width);
    $("railBtn").click();
    try { await waitFor(() => railWidth() === 60, "collapsed crew rail", collectWaitTimeout); } catch (error) { if (!collectFailures) throw error; }
    const railCollapsed = !$("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "false" && $("railBtn").getAttribute("aria-label") === "Show crew details", railStrip = railWidth();
    $("railBtn").click();
    try { await waitFor(() => railWidth() === 224, "expanded crew rail", collectWaitTimeout); } catch (error) { if (!collectFailures) throw error; }
    const railExpanded = $("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "true" && $("railBtn").getAttribute("aria-label") === "Hide crew details" && railWidth() === 224;
    $("sideBtn").click(); const sideOpened = !$("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "true";
    $("sideBtn").click(); const sideClosed = $("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "false";
    check("both panels collapse to the mockup strips and expand accessibly", railCollapsed && railStrip === 60 && railExpanded && sideOpened && sideClosed, { railCollapsed, railStrip, railExpanded, sideOpened, sideClosed });
    const railWrites = window.__sent.filter((message) => message.type === "updateClientPref" && message.key === "crewRailOpen").map((message) => message.value);
    check("the rail's open or closed choice is sent to the server as the crewRailOpen pref", railWrites.slice(-2).join() === "false,true", { railWrites });
  };

  const pressApproval = (id) => { const button = $(id); button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); };
  const runToolApprovals = async () => {
    const tabId = window.__latestState.selectedTabId;
    const tab = latestTab(tabId, window.__ccSeed);
    const deliver = () => window.__ccDeliver({...structuredClone(window.__ccSeed),type:"state"});
    tab.derived.leaderTurnActive = false;
    tab.pendingApprovals = [{approvalId:"approval-3",tool:"PowerShell",summary:"Get-Date",createdAt:3},{approvalId:"approval-1",tool:"Write",summary:"C:/work/<literal>/file.ts\nsecond line of the summary\nthird line",createdAt:1},{approvalId:"approval-2",tool:"Bash",summary:"echo hello",createdAt:2}];
    $("ci").focus(); $("ci").value="typing a draft";
    deliver();
    const focusKept = document.activeElement === $("ci") && $("ci").value === "typing a draft";
    const waiting = text("#statusBtn .pill") === `Waiting on you: ${leaderNameOf(tabId)} wants to edit a file` && text('#crew [data-seat-id="leader"] .sl') === "Waiting on your answer";
    await waitFor(() => !$("approvalPanel").hidden, "approval panel");
    const rendered = text("#approvalTitle") === `${leaderNameOf(tabId)} wants to edit a file` && $("approvalSummary").textContent === "C:/work/<literal>/file.ts\nsecond line of the summary\nthird line" && text("#approvalCount") === "1 of 3";
    window.__ccDeliver({type:"saved",tabId,revision:3,savedRevision:3});
    $("ci").dispatchEvent(new Event("input",{bubbles:true}));
    check("pending approval keeps composer usable", !$("sendBtn").disabled && !$("ci").readOnly, {disabled:$("sendBtn").disabled,readOnly:$("ci").readOnly});
    $("sendBtn").click();
    await waitFor(() => text("#approvalError").includes("pending approval"), "chat refusal shown in panel");
    const start = window.__sent.length;
    document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); deliver();
    const persistent = !$("approvalPanel").hidden && tab.pendingApprovals.length === 3 && !window.__sent.slice(start).some(m=>m.type==="answerApproval");
    const otherTab = window.__ccSeed.projects.flatMap(p=>p.tabs).find(t=>t.id!==tabId);
    window.__ccSeed.selectedTabId=otherTab.id;deliver();
    await waitFor(() => $("approvalPanel").hidden, "selected tab without approval hides panel");
    requireElement('#inboxList [data-wait-approval="approval-1"]', openInbox()).click();
    await waitFor(() => !$("approvalPanel").hidden && window.__latestState.selectedTabId===tabId && document.activeElement === $("approvalPanel"), "Waiting card selects tab and focuses panel");
    const cardFocused = document.activeElement === $("approvalPanel");
    await waitFor(() => !$("approvalAllow").disabled, "approval settled");
    window.__ccApprovalReply="hold"; pressApproval("approvalAllow");
    const allow = window.__sent.slice(start).find(m=>m.type==="answerApproval");
    check("settled Allow sends its approval answer", Boolean(allow), { answers: window.__sent.slice(start).filter(m=>m.type==="answerApproval") });
    const disabled = $("approvalAllow").disabled && $("approvalDeny").disabled;
    window.__ccDeliver({type:"error",action:"answerApproval",requestId:allow.requestId,tabId,message:"Approval is no longer available"});
    const refusal = text("#approvalError").includes("no longer available") && !$("approvalAllow").disabled;
    window.__ccApprovalReply="ok"; pressApproval("approvalDeny");
    const deny = window.__sent.filter(m=>m.type==="answerApproval").at(-1);
    const next = text("#approvalTitle") === `${leaderNameOf(tabId)} wants to run a command` && text("#approvalSummary") === "echo hello";
    // The panel swapped to approval-2 in place; its buttons stay locked while it settles, then release.
    const settleLocked = $("approvalAllow").disabled && $("approvalDeny").disabled;
    await new Promise((resolve) => setTimeout(resolve, 450));
    const settleReleased = !$("approvalAllow").disabled && !$("approvalDeny").disabled;
    window.__ccApprovalReply="hold"; pressApproval("approvalAllow");
    const inFlight = $("approvalAllow").disabled;
    const oldSocket = window.__socket; const statesBeforeReconnect = window.__states.length; oldSocket.close();
    const disconnectFailed = text("#approvalError").includes("Disconnected") && !$("approvalAllow").disabled && !$("approvalDeny").disabled;
    check("an answer in flight when the socket drops fails with Disconnected and unlocks Allow and Deny", inFlight && disconnectFailed, {inFlight,disconnectFailed,error:text("#approvalError")});
    window.__ccApprovalReply="ok";
    // Wait for the NEW socket to be OPEN and a fresh state to arrive, not just for the old panel content to still be there.
    await waitFor(() => window.__socket !== oldSocket && window.__socket.readyState === 1 && window.__states.length > statesBeforeReconnect && !$("approvalPanel").hidden && text("#approvalSummary") === "echo hello", "reconnect retains pending approval", 10000);
    const reconnected = window.__socket !== oldSocket && window.__socket.readyState === 1 && window.__states.length > statesBeforeReconnect;
    check("tool approval panel, answers, focus, Waiting status and reconnect", rendered && persistent && focusKept && waiting && cardFocused && disabled && refusal && next && allow.tabId===tabId && allow.approvalId==="approval-1" && allow.allow===true && Boolean(allow.requestId) && deny.allow===false && deny.approvalId==="approval-1" && deny.requestId!==allow.requestId && settleLocked && settleReleased && reconnected, {title:text("#approvalTitle"),pill:text("#statusBtn .pill"),leader:leaderNameOf(tabId),rendered,persistent,focusKept,waiting,cardFocused,disabled,refusal,next,settleLocked,settleReleased,reconnected,allow,deny});
    latestTab(tabId,window.__ccSeed).pendingApprovals=[];deliver();
    await waitFor(() => $("approvalPanel").hidden, "panel clears");
    const stageState = document.querySelector("#statusBtn .pill"); const crewRoles = [...document.querySelectorAll("#crew .sl")];
    check("approval panel and Waiting status clear after answer", $("approvalPanel").hidden && Boolean(stageState) && !stageState.textContent.includes("wants to") && crewRoles.length > 0 && !crewRoles.some(e=>e.textContent === "Waiting on your answer"), {found:Boolean(stageState),roles:crewRoles.length,state:stageState?.textContent});
  };

  const runR6Fixes = async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabId = window.__latestState.selectedTabId;
    const seedTab = () => latestTab(tabId, window.__ccSeed);
    const deliver = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const answers = (from) => window.__sent.slice(from).filter((m) => m.type === "answerApproval").map((m) => `${m.approvalId}:${m.allow}`);
    const closeAll = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); };
    window.__ccApprovalReply = "ok";
    seedTab().derived.leaderTurnActive = false;

    // A double-click answers only the approval that was shown: two pending, click Allow, click again 30 ms later.
    await sleep(1700);
    seedTab().pendingApprovals = [{ approvalId: "dbl-1", tool: "Write", summary: "C:/seen/file.ts", createdAt: 1 }, { approvalId: "dbl-2", tool: "Bash", summary: "rm -rf C:/unseen", createdAt: 2 }];
    deliver(); await waitFor(() => text("#approvalSummary") === "C:/seen/file.ts", "first approval shown");
    await sleep(450);
    const dblStart = window.__sent.length;
    pressApproval("approvalAllow");
    await waitFor(() => text("#approvalSummary") === "rm -rf C:/unseen", "panel swapped to the next approval");
    const lockedAfterSwap = $("approvalAllow").disabled && $("approvalDeny").disabled;
    await sleep(30); pressApproval("approvalAllow"); pressApproval("approvalDeny"); await sleep(30);
    const secondIgnored = answers(dblStart).join() === "dbl-1:true";
    await sleep(450);
    const releasedAfterSettle = !$("approvalAllow").disabled; pressApproval("approvalDeny");
    const secondAnswered = answers(dblStart).join() === "dbl-1:true,dbl-2:false";
    check("a second click 30 ms after Allow cannot answer the next approval, and works after it settles", lockedAfterSwap && secondIgnored && releasedAfterSettle && secondAnswered, { lockedAfterSwap, answered: answers(dblStart), releasedAfterSettle });

    // A press that began on one approval cannot answer another, even after the settle time.
    await waitFor(() => $("approvalPanel").hidden, "panel hidden after the last answer");
    seedTab().pendingApprovals = [{ approvalId: "ptr-1", tool: "Write", summary: "C:/press/file.ts", createdAt: 1 }, { approvalId: "ptr-2", tool: "Bash", summary: "echo ptr-two", createdAt: 2 }];
    deliver(); await waitFor(() => text("#approvalSummary") === "C:/press/file.ts", "press approval shown");
    await sleep(450);
    const pressStart = window.__sent.length;
    $("approvalAllow").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    seedTab().pendingApprovals = seedTab().pendingApprovals.filter((item) => item.approvalId !== "ptr-1"); deliver();
    await waitFor(() => text("#approvalSummary") === "echo ptr-two", "press target replaced");
    await sleep(450);
    const releasedForPress = !$("approvalAllow").disabled;
    $("approvalAllow").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await sleep(30);
    const pressIgnored = answers(pressStart).length === 0;
    pressApproval("approvalAllow");
    check("a press that began on another approval is ignored and the next fresh press answers", releasedForPress && pressIgnored && answers(pressStart).join() === "ptr-2:true", { releasedForPress, pressIgnored, answered: answers(pressStart) });

    // A held Enter never repeats an answer.
    await waitFor(() => $("approvalPanel").hidden, "panel hidden after the press test");
    seedTab().pendingApprovals = [{ approvalId: "key-1", tool: "Write", summary: "C:/key/file.ts", createdAt: 1 }];
    deliver(); await waitFor(() => text("#approvalSummary") === "C:/key/file.ts", "key approval shown");
    const held = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }); $("approvalAllow").dispatchEvent(held);
    const first = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); $("approvalAllow").dispatchEvent(first);
    check("a held Enter key repeat is blocked on the approval buttons and a first press is not", held.defaultPrevented && !first.defaultPrevented, { held: held.defaultPrevented, first: first.defaultPrevented });
    seedTab().pendingApprovals = []; deliver(); await waitFor(() => $("approvalPanel").hidden, "panel hidden after the key test");

    // A new approval sends the desktop notification once.
    window.__approvalNotified = [];
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: class { static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } constructor(title, options) { window.__approvalNotified.push({ title, body: options?.body ?? "" }); } } });
    seedTab().pendingApprovals = [{ approvalId: "note-1", tool: "Write", summary: "C:/notify/file.ts", createdAt: 1 }];
    deliver(); const firstNotice = window.__approvalNotified.slice(); deliver();
    check("a new approval sends one desktop notification naming the tab and the change", firstNotice.length === 1 && firstNotice[0].title === `${leaderNameOf(tabId)} needs your answer` && firstNotice[0].body.includes("C:/notify/file.ts") && firstNotice[0].body.startsWith(latestTab(tabId).name) && window.__approvalNotified.length === 1, { firstNotice, total: window.__approvalNotified.length });
    seedTab().pendingApprovals = []; deliver(); await waitFor(() => $("approvalPanel").hidden, "panel hidden after the notify test");

    // Settings: every unsaved field survives a state broadcast until saved or the modal closes.
    closeAll(); $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    const folderChoice = window.__ccFolderChoice;
    requireElement('#s-folders [data-setting-action="folder-browse"]').click();
    await waitFor(() => requireElement("#defaultProjectFolder").value === folderChoice, "Browse fills the default folder");
    const openForm = (formSelector, addSelector) => { if (requireElement(formSelector).hidden) requireElement(addSelector).click(); return requireElement(formSelector); };
    openForm('#setBody [data-mcp-form="claude"]', '#setBody [data-settings-add="mcp-claude"]'); openForm("#setBody [data-plugin-form]", '#setBody [data-settings-add="plugins-claude"]');
    const mcpForm = () => requireElement('#setBody [data-mcp-form="claude"]'); const pluginForm = () => requireElement("#setBody [data-plugin-form]");
    const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    typeInto(mcpForm().elements.name, "my_server"); typeInto(mcpForm().elements.commandOrUrl, "npx -y my-server"); typeInto(pluginForm().elements.name, "my-plugin");
    requireElement('#setBody [data-theme="dark"]').focus();
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    const draftsKept = requireElement("#defaultProjectFolder").value === folderChoice && mcpForm().elements.name.value === "my_server" && mcpForm().elements.commandOrUrl.value === "npx -y my-server" && pluginForm().elements.name.value === "my-plugin";
    check("Settings keeps every unsaved field across a state broadcast", draftsKept, { folder: requireElement("#defaultProjectFolder").value, mcpName: mcpForm().elements.name.value, mcpCommand: mcpForm().elements.commandOrUrl.value, plugin: pluginForm().elements.name.value });
    // Saved: the server's own folder replaces the typed one, and a finished MCP add empties its form; the plugin draft stays.
    requireElement('#s-folders [data-setting-action="folder-save"]').click();
    const folderSave = window.__sent.filter((item) => item.type === "setDefaultProjectFolder").at(-1);
    mcpForm().requestSubmit(); confirmIfAsked();
    const mcpAdd = window.__sent.filter((item) => item.type === "mcpAdd").at(-1);
    const savedState = structuredClone(window.__latestState);
    savedState.requestActions = { ...(savedState.requestActions ?? {}), [folderSave.requestId]: { requestId: folderSave.requestId, status: "done", message: "Done" }, [mcpAdd.requestId]: { requestId: mcpAdd.requestId, status: "done", message: "Done" } };
    savedState.settings.folders = { defaultProjectFolder: "C:\\normalized\\folder" };
    window.__ccDeliver({ ...savedState, type: "state" });
    const savedGood = requireElement("#defaultProjectFolder").value === "C:\\normalized\\folder" && mcpForm().elements.name.value === "" && mcpForm().elements.commandOrUrl.value === "" && pluginForm().elements.name.value === "my-plugin";
    check("Settings drops a draft once its save is done and keeps the others", savedGood && Boolean(folderSave?.requestId) && Boolean(mcpAdd?.requestId), { folder: requireElement("#defaultProjectFolder").value, mcpName: mcpForm().elements.name.value, plugin: pluginForm().elements.name.value });
    closeAll(); $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    check("Settings opens with no leftover unsaved text after it was closed", pluginForm().elements.name.value === "" && mcpForm().elements.name.value === "" && requireElement("#defaultProjectFolder").value === "C:\\normalized\\folder", { plugin: pluginForm().elements.name.value, folder: requireElement("#defaultProjectFolder").value });
    closeAll();

    // Requests: a sent request empties the form so a second click cannot send a duplicate.
    openRequests();
    const requestStart = window.__sent.length;
    $("reqTo").value = "beta-dev"; $("reqTitle").value = "Duplicate check"; $("reqBody").value = "Send this once.";
    $("reqForm").requestSubmit();
    const sentRequest = window.__sent.slice(requestStart).find((item) => item.type === "sendRequest");
    const doneState = structuredClone(window.__latestState);
    doneState.requestActions = { ...(doneState.requestActions ?? {}), [sentRequest.requestId]: { requestId: sentRequest.requestId, status: "done", message: "Done" } };
    window.__ccDeliver({ ...doneState, type: "state" });
    const cleared = $("reqTitle").value === "" && $("reqBody").value === "" && $("reqStatus").textContent === "Done";
    $("reqForm").requestSubmit();
    const noDuplicate = window.__sent.slice(requestStart).filter((item) => item.type === "sendRequest").length === 1;
    $("reqTitle").value = "Second one"; window.__ccDeliver({ ...structuredClone(doneState), type: "state" });
    const typingKept = $("reqTitle").value === "Second one";
    check("a sent request empties the form once and a second click sends no duplicate", Boolean(sentRequest) && cleared && noDuplicate && typingKept, { cleared, noDuplicate, typingKept, status: $("reqStatus").textContent });
    closeAll();

    // Seat picture: a finished upload must not close another dialog the user opened meanwhile.
    const priorFetch = window.fetch; let releaseUpload;
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (init.method === "POST" && url.pathname === "/api/avatar") return new Promise((resolve) => { releaseUpload = () => resolve(new Response(JSON.stringify({ path: "/api/avatar/r6-seat.png" }), { status: 200, headers: { "Content-Type": "application/json" } })); });
      return priorFetch(input, init);
    };
    requireElement("[data-seat-picture]", openSeatCard("coder")).click(); requireElement('#avModal[aria-hidden="false"]');
    const avatarData = new DataTransfer(); avatarData.items.add(new File(["avatar bytes"], "seat-picture.png", { type: "image/png" })); $("avUp").files = avatarData.files; $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => typeof releaseUpload === "function", "seat upload in flight");
    closeAll(); $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    const updateStart = window.__sent.length;
    releaseUpload();
    await waitFor(() => window.__sent.slice(updateStart).some((item) => item.type === "updateSeat" && item.slot === "coder"), "seat picture still applied");
    await sleep(30);
    const applied = window.__sent.slice(updateStart).filter((item) => item.type === "updateSeat" && item.slot === "coder").at(-1);
    check("a seat-picture upload that finishes after its dialog was closed still applies and leaves the open Settings dialog alone", applied?.pic === "/api/avatar/r6-seat.png" && !$("setModal").hidden && $("avModal").hidden, { pic: applied?.pic, settingsOpen: !$("setModal").hidden, avatarClosed: $("avModal").hidden });
    window.fetch = priorFetch; closeAll();
  };

  const runR7Fixes = async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabId = "alpha-dev";
    const closeAll = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); };
    const seedTab = (id = tabId) => latestTab(id, window.__ccSeed);
    const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const done = (requestId) => ({ requestId, status: "done", message: "Done" });
    const running = (requestId) => ({ requestId, status: "running", message: "Working" });
    const payload = '<img src=x onerror="window.__ccXss()">';
    closeAll();
    window.__ccSeed.selectedTabId = tabId; window.__ccSeed.requests = [];
    seedTab().pendingApprovals = []; seedTab().derived.leaderTurnActive = false;
    deliverSeed(); await sleep(30);

    // An uploaded seat picture is shown in the crew row and the stage header; the dialog ticks no preset while it is active.
    const uploaded = "/api/avatar/avatar-7e2e1c3a-0b1d-4c5e-8f00-123456789abc.png";
    const coder = () => seedTab().crew.find((seat) => seat.slot === "coder");
    const crewImage = () => requireElement('#crew [data-seat-id="coder"] .av img').getAttribute("src");
    const ticked = async () => {
      requireElement("[data-seat-picture]", openSeatCard("coder")).click(); requireElement('#avModal[aria-hidden="false"]');
      const keys = [...document.querySelectorAll('#avgrid [aria-checked="true"]')].map((node) => node.dataset.avatar);
      closeAll(); await sleep(20); return keys;
    };
    coder().pic = "avatars/sonny.svg"; deliverSeed();
    const presetShown = crewImage(); const presetTicks = await ticked();
    coder().pic = uploaded; deliverSeed();
    openSeatView("coder");
    const uploadedCrew = crewImage(); const uploadedHead = requireElement("#stagehead .av.big img").getAttribute("src"); const uploadedTicks = await ticked();
    coder().pic = "/api/avatar/avatar-not-a-uuid.png"; deliverSeed();
    const oddShown = crewImage();
    coder().pic = "https://example.test/avatar.png"; deliverSeed();
    const remoteShown = crewImage();
    delete coder().pic; deliverSeed();
    check("an uploaded seat picture is displayed in the crew row and the stage header, and no preset is ticked while it is active", presetShown === "/avatars/sonny.svg" && presetTicks.join() === "sonny" && uploadedCrew === uploaded && uploadedHead === uploaded && uploadedTicks.length === 0 && !oddShown.includes("avatar-not-a-uuid") && !remoteShown.includes("example.test"), { presetShown, presetTicks, uploadedCrew, uploadedHead, uploadedTicks, oddShown, remoteShown });

    // The permission picker closes on a click outside it.
    $("permBtn").click(); const permOpened = !$("permPop").hidden;
    $("view").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await sleep(20);
    check("the permission picker closes when the user clicks outside it", permOpened && $("permPop").hidden, { permOpened, hiddenAfter: $("permPop").hidden });

    // Buttons never stay on "Working" once the server forgot the action (it keeps only its last 32).
    openRequests();
    check("Requests Send is not stuck on an earlier send the server already forgot", !$("reqSend").disabled && $("reqSend").textContent === "Send request", { disabled: $("reqSend").disabled, label: $("reqSend").textContent });
    const stuckStart = window.__sent.length;
    $("reqTo").value = "beta-dev"; $("reqTitle").value = "Stuck check"; $("reqBody").value = "Send this once.";
    $("reqForm").requestSubmit();
    const sendOne = window.__sent.slice(stuckStart).find((item) => item.type === "sendRequest");
    const sendingShown = $("reqSend").disabled && $("reqSend").textContent === "Sending…";
    // This result reaches the client without the server ever listing the action to it.
    window.__ccDeliver({ type: "actionResult", action: "sendRequest", requestId: sendOne.requestId, id: "stuck-request", status: "pending" });
    closeAll(); $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    check("Save folder is not stuck on an earlier action the server already forgot", !requireElement('#s-folders [data-setting-action="folder-save"]').disabled, { disabled: requireElement('#s-folders [data-setting-action="folder-save"]').disabled });
    requireElement('#s-folders [data-setting-action="folder-save"]').click();
    const folderSave = window.__sent.filter((item) => item.type === "setDefaultProjectFolder").at(-1);
    window.__ccSeed.requestActions = { [folderSave.requestId]: running(folderSave.requestId) }; deliverSeed();
    const folderButton = () => requireElement('#s-folders [data-setting-action="folder-save"]');
    const folderRunning = folderButton().disabled;
    // 33 later actions push both ids off the server's list of 32; the client never got a result for the folder Save.
    window.__ccSeed.requestActions = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`perm_stuck_${index}`, done(`perm_stuck_${index}`)]));
    deliverSeed(); await sleep(30);
    const folderStuck = folderButton().disabled || /Working/.test(requireElement("#s-folders").textContent);
    window.__ccDeliver({ type: "actionResult", action: "setDefaultProjectFolder", requestId: folderSave.requestId });
    for (let index = 0; index < 1001; index++) window.__ccDeliver({ type: "actionResult", action: "setPermissionMode", requestId: `long_history_${index}` });
    deliverSeed();
    check("completed folder Save stays Done after 1001 other completions", !folderButton().disabled && requireElement("#s-folders .action-status").textContent === "Done", { disabled: folderButton().disabled, status: requireElement("#s-folders .action-status").textContent });
    // A real Add control remains locked while its id is running, even after another action replaced the tool's latest slot.
    requireElement('[data-settings-add="mcp-claude"]').click();
    const mcpForm = () => requireElement('[data-mcp-form="claude"]');
    mcpForm().querySelector('[name="name"]').value = "held_mcp";
    mcpForm().querySelector('[name="commandOrUrl"]').value = "npx held";
    mcpForm().requestSubmit(); confirmIfAsked();
    const heldAdd = window.__sent.filter((item) => item.type === "mcpAdd").at(-1);
    window.__ccSeed.settings.skills.claude.action = done("other_mcp_finished");
    window.__ccSeed.requestActions[heldAdd.requestId] = running(heldAdd.requestId); deliverSeed();
    const heldButton = () => mcpForm().querySelector('[type="submit"]');
    let heldThroughout = true;
    for (let index = 0; index < 33; index++) {
      const requestId = `while_held_${index}`;
      window.__ccDeliver({ type: "actionResult", action: "setPermissionMode", requestId });
      window.__ccSeed.requestActions = Object.fromEntries(Array.from({ length: Math.min(index + 1, 32) }, (_, offset) => { const id = `while_held_${index - offset}`; return [id, done(id)]; }));
      window.__ccSeed.requestActions[heldAdd.requestId] = running(heldAdd.requestId); deliverSeed();
      heldThroughout &&= heldButton().disabled && mcpForm().querySelector(".action-status").textContent === "Working";
    }
    check("in-flight MCP Add button stays disabled and Working after another action and 33 completions", heldThroughout && heldButton().disabled && mcpForm().querySelector(".action-status").textContent === "Working", { disabled: heldButton().disabled, status: mcpForm().querySelector(".action-status").textContent });
    window.__ccDeliver({ type: "actionResult", action: "mcpAdd", requestId: heldAdd.requestId });
    delete window.__ccSeed.requestActions[heldAdd.requestId]; deliverSeed();
    check("MCP Add unlocks and shows Done only after its terminal result", !heldButton().disabled && mcpForm().querySelector(".action-status").textContent === "Done", { disabled: heldButton().disabled, status: mcpForm().querySelector(".action-status").textContent });
    closeAll(); openRequests();
    const requestsStuck = $("reqSend").disabled || $("reqSend").textContent === "Sending…" || $("reqStatus").textContent === "Working";
    check("a request send and a folder save are not stuck on Working after the server forgot them", Boolean(sendOne) && sendingShown && folderRunning && !folderStuck && !requestsStuck, { sendingShown, folderRunning, folderStuck, requestsStuck, status: $("reqStatus").textContent });
    // A socket drop loses the result, and the next snapshot does not list the send.
    $("reqTo").value = "beta-dev"; $("reqTitle").value = "Lost result"; $("reqBody").value = "The socket drops.";
    $("reqForm").requestSubmit();
    const lostSendShown = $("reqSend").disabled;
    const lostSocket = window.__socket; dropSocket(lostSocket);
    await waitFor(() => window.__socket !== lostSocket, "reconnect after a lost send");
    window.__ccSeed.requestActions = {}; deliverSeed(); await sleep(30);
    check("Requests Send is not stuck on Working after a socket drop lost its result", lostSendShown && !$("reqSend").disabled && $("reqStatus").textContent !== "Working", { lostSendShown, disabled: $("reqSend").disabled, status: $("reqStatus").textContent });

    // A resolved request card never says Working, listed or not.
    const incoming = (id, status) => ({ id, fromTabId: "beta-dev", toTabId: tabId, title: "Card " + id, body: "Body", status, createdAt: Date.now(), files: [] });
    window.__ccSeed.requestActions = {}; window.__ccSeed.requests = [incoming("card-1", "pending"), incoming("card-2", "pending")]; deliverSeed();
    requireElement('[data-request-action="accept:card-1"]').click(); requireElement('[data-request-action="accept:card-2"]').click();
    const accepts = window.__sent.filter((item) => item.type === "resolveRequest").slice(-2);
    window.__ccSeed.requestActions = { [accepts[0].requestId]: running(accepts[0].requestId) }; deliverSeed();
    const cardWorking = () => [...document.querySelectorAll('#inboxPop [data-request-id^="card-"] .action-status')].map((node) => node.textContent);
    const whilePending = cardWorking();
    window.__ccSeed.requests = [incoming("card-1", "accepted"), incoming("card-2", "accepted")]; window.__ccSeed.requestActions = {}; deliverSeed(); await sleep(30);
    const afterResolved = cardWorking();
    check("a resolved request card never shows Working, whether or not the server still lists its action", whilePending.every((label) => label === "Working") && whilePending.length === 2 && afterResolved.every((label) => label !== "Working"), { whilePending, afterResolved });
    window.__ccSeed.requests = []; deliverSeed();

    // The Requests send status belongs to the tab it was sent from.
    $("reqTo").value = "beta-dev"; $("reqTitle").value = "Per tab"; $("reqBody").value = "Only this tab.";
    const tabStart = window.__sent.length; $("reqForm").requestSubmit();
    const tabSend = window.__sent.slice(tabStart).find((item) => item.type === "sendRequest");
    window.__ccSeed.requestActions = { [tabSend.requestId]: running(tabSend.requestId) }; deliverSeed();
    const sendingHere = $("reqSend").disabled && $("reqStatus").textContent === "Working";
    window.__ccSeed.selectedTabId = "beta-dev"; deliverSeed(); closeAll(); openRequests(); await sleep(30);
    const otherTab = { disabled: $("reqSend").disabled, label: $("reqSend").textContent, status: $("reqStatus").textContent };
    window.__ccSeed.selectedTabId = tabId; deliverSeed(); closeAll(); openRequests(); await sleep(30);
    const backHere = $("reqSend").disabled && $("reqStatus").textContent === "Working";
    window.__ccSeed.requestActions = { [tabSend.requestId]: done(tabSend.requestId) }; deliverSeed();
    check("a Requests send in one tab does not show its status or lock Send in another tab", sendingHere && !otherTab.disabled && otherTab.label === "Send request" && otherTab.status === "" && backHere, { sendingHere, otherTab, backHere });
    window.__ccSeed.requestActions = {}; closeAll();

    // Text from the server or the model is shown as text, never as markup, on every new Pack C screen.
    const noMarkup = (node, label) => ({ label, text: node?.textContent === payload, image: Boolean(node?.querySelector("img")) });
    window.__ccSeed.requests = [{ id: "esc-1", fromTabId: "beta-dev", toTabId: tabId, title: payload, body: payload, status: "pending", createdAt: Date.now(), files: [] }];
    seedTab().pendingApprovals = [{ approvalId: "esc-approval", tool: "Write", summary: payload, createdAt: 1 }];
    seedTab().changes = { repo: true, branch: "main", ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [{ status: "M", path: payload }] };
    window.__ccSeed.settings.skills.claude.mcpServers = [{ name: payload }];
    deliverSeed();
    openInbox();
    const title = noMarkup(requireElement("#inboxPop .req-title"), "request title"); const body = noMarkup(requireElement("#inboxPop .req-body"), "request body");
    const waiting = noMarkup(requireElement("#inboxList .approval-path"), "approval summary");
    closeAll();
    requireElement('.pills [data-l="changes"]').click();
    const changed = noMarkup(requireElement("#lowerBody [data-change-file-list] span"), "changes path");
    requireElement('.pills [data-l="activity"]').click();
    $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    const mcp = noMarkup(requireElement('#setBody [data-skill-cli="claude"] .sitem > span'), "MCP name");
    await sleep(60);
    const shown = [title, body, waiting, changed, mcp];
    check("request title and body, the approval summary, a changed file path and an MCP server name are shown as text, never markup", shown.every((item) => item.text && !item.image) && !window.__ccErrors.some((item) => item.includes("escaped text ran as HTML")), shown);
    closeAll();
    window.__ccSeed.requests = []; seedTab().pendingApprovals = []; seedTab().changes = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] };
    window.__ccSeed.settings.skills.claude.mcpServers = [{ name: "claude_mcp" }];
    deliverSeed(); await sleep(30);

    // A launch approval reads "Atlas wants to launch <seat>" in the panel and on the Waiting card.
    seedTab().pendingApprovals = [{ approvalId: "launch-1", tool: "launch:Sonny", summary: "Sonny (Coder): Fix the login bug", createdAt: 1 }];
    deliverSeed(); await waitFor(() => text("#approvalSummary") === "Sonny (Coder): Fix the login bug", "launch approval shown");
    const launchTitles = { panel: text("#approvalTitle"), card: text("#inboxList .ncard.apx > b") };
    check("a seat launch approval reads <leader> wants to launch the seat", launchTitles.panel === `${leaderNameOf(window.__latestState.selectedTabId)} wants to launch Sonny` && launchTitles.card === launchTitles.panel, launchTitles);
    seedTab().pendingApprovals = []; deliverSeed(); await waitFor(() => $("approvalPanel").hidden, "launch approval cleared");

    // The tool version is escaped once: a version with & and < reads as typed.
    window.__ccSeed.settings.tools.claude.version = "1.0 & <2";
    deliverSeed(); $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    const subtitle = text('#setBody [data-tool-row][data-cli="claude"] [data-tool-subtitle]');
    check("a tool version with & and < is shown once-escaped, as typed", subtitle.includes("1.0 & <2") && !subtitle.includes("&amp;") && !subtitle.includes("&lt;"), { subtitle });
    window.__ccSeed.settings.tools.claude.version = "2.1.0"; deliverSeed(); closeAll();
  };

  // Round 1 fixes of the simple-look pack: each wait the app owns must end when the connection or the picker moves on.
  const runR1Fixes = async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabId = "alpha-dev";
    const closeAll = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); };
    const seedTab = (id = tabId) => latestTab(id, window.__ccSeed);
    const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const folderChoice = new URLSearchParams(location.search).get("folder");
    const dropAndReconnect = async (label) => {
      const old = window.__socket; const states = window.__states.length;
      dropSocket(old);
      await waitFor(() => window.__socket !== old && window.__socket.readyState === 1 && window.__states.length > states, label, 20000);
    };
    closeAll(); window.__ccSeed.selectedTabId = tabId; seedTab().pendingApprovals = []; seedTab().derived.leaderTurnActive = false; deliverSeed(); await sleep(30);

    // F01: a crew picker opened and closed on one tab must never act for that tab once another tab's picker is open.
    clickMenuItem(openTabMenu("alpha-dev"), "Kind and crew"); closeAll(); await sleep(20);
    clickMenuItem(openTabMenu("alpha-design"), "Kind and crew");
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 0 : delay, ...args);
    requireElement('#setupPop [data-kind="mkt"]').click();
    requireElement('#setupPop [data-set-process="duo"]').click();
    window.setTimeout = nativeSetTimeout;
    await waitFor(() => window.__sent.some((message) => message.type === "setProcess" && message.process === "duo" && message.kind === "mkt"), "crew change sent");
    const crewSent = window.__sent.filter((message) => message.type === "setProcess" && message.process === "duo" && message.kind === "mkt").at(-1);
    check("a crew picker closed on one tab cannot redraw or send for it after another tab's picker opens", crewSent?.tabId === "alpha-design", { crewSent });
    window.__ccDeliver({ type: "error", action: "setProcess", tabId: "alpha-design", message: "released by the harness" }); await sleep(30); closeAll(); await sleep(20);

    // F02: after a launch's outcome is unknown, editing the brief cannot re-enable Start or send a second run.
    openSeatView("coder"); requireElement("#stagehead [data-run-seat]").click();
    const launchSocket = window.__socket; const nativeSend = launchSocket.send.bind(launchSocket);
    launchSocket.send = (raw) => { const message = JSON.parse(raw); if (message.type === "run") { window.__sent.push(message); return; } nativeSend(raw); };
    $("runPrompt").value = "First brief"; $("runPrompt").dispatchEvent(new Event("input", { bubbles: true }));
    const runCount = () => window.__sent.filter((message) => message.type === "run").length; const runsBefore = runCount();
    $("runStart").click();
    const startedOnce = runCount() === runsBefore + 1 && $("runStart").textContent === "Starting…";
    await dropAndReconnect("reconnect after a launch with no answer");
    const unknownShown = $("runStart").textContent === "Outcome unknown" && $("runStart").disabled && !$("runModal").hidden;
    $("runPrompt").value = "First brief, edited"; $("runPrompt").dispatchEvent(new Event("input", { bubbles: true }));
    const stillLocked = $("runStart").disabled;
    $("runStart").click();
    check("an Outcome unknown launch stays locked when the brief is edited and sends no second run", startedOnce && unknownShown && stillLocked && runCount() === runsBefore + 1, { startedOnce, unknownShown, stillLocked, runs: runCount() - runsBefore, label: $("runStart").textContent });
    // R2-2: the guard inside startRun itself must hold when Start is force-enabled.
    $("runStart").disabled = false; $("runStart").click();
    check("a force-enabled Start after an Outcome unknown launch sends no second run", runCount() === runsBefore + 1, { runs: runCount() - runsBefore });
    closeAll(); await sleep(30);

    // F03: a Save that went unknown is confirmed only when the saved revision moved past the one it started from.
    const savedBefore = { chat: seedTab().chatRevision, saved: seedTab().savedRevision };
    seedTab().chatRevision = 5; seedTab().savedRevision = 5; deliverSeed(); await sleep(30);
    window.__ccSaveDeferred = true;
    $("saveBtn").click();
    await dropAndReconnect("reconnect after a Save with no answer");
    await sleep(30);
    const unmoved = { status: $("saveSt").textContent, button: $("saveBtn").textContent };
    check("a Save that went unknown is not confirmed when the saved revision had not moved", unmoved.status === "Save not confirmed" && unmoved.button.includes("Retry save"), unmoved);
    $("saveBtn").click(); await sleep(30);
    seedTab().savedRevision = 6; seedTab().chatRevision = 6;
    await dropAndReconnect("reconnect after a second Save with no answer"); await sleep(30);
    const moved = { status: $("saveSt").textContent, button: $("saveBtn").textContent };
    check("a Save that went unknown is confirmed when the saved revision moved past its start", moved.status !== "Save not confirmed" && !moved.button.includes("Retry save"), moved);
    window.__ccSaveDeferred = false; seedTab().chatRevision = savedBefore.chat; seedTab().savedRevision = savedBefore.saved; deliverSeed(); await sleep(30);

    // F04: a create whose reply was lost must not lock both Create buttons for good.
    $("addProj").click(); requireElement("#projModal[aria-hidden=false]");
    $("pName").value = "Lost Project"; $("pName").dispatchEvent(new Event("input", { bubbles: true }));
    $("pBrowse").click(); await waitFor(() => $("pDir").textContent.includes(folderChoice), "lost project folder");
    const projectsBefore = window.__latestState.projects.length;
    $("createProj").click();
    const projectLocked = $("createProj").disabled && $("createProj").textContent === "Creating…";
    await dropAndReconnect("reconnect after a lost project create"); await sleep(30);
    const projectFreed = { disabled: $("createProj").disabled, label: $("createProj").textContent, status: $("npStat").textContent, projects: window.__latestState.projects.length };
    check("a New project create lost with the connection frees Create and says it is not known", projectLocked && !projectFreed.disabled && projectFreed.label === "Create project" && /^Not sure it was created/.test(projectFreed.status) && projectFreed.projects === projectsBefore, { projectLocked, projectFreed });
    closeAll(); await sleep(30);
    $("addtab").click(); requireElement("#modal[aria-hidden=false]");
    $("tName").value = "Lost Tab"; await sleep(10);
    const tabsBefore = window.__latestState.projects.flatMap((project) => project.tabs).length;
    $("createTab").click();
    const tabLocked = $("createTab").disabled && $("createTab").textContent === "Creating…";
    await dropAndReconnect("reconnect after a lost tab create"); await sleep(30);
    const tabFreed = { disabled: $("createTab").disabled, label: $("createTab").textContent, status: $("tStat").textContent, tabs: window.__latestState.projects.flatMap((project) => project.tabs).length };
    check("an Add tab create lost with the connection frees Create and says it is not known", tabLocked && !tabFreed.disabled && tabFreed.label === "Create tab" && /^Not sure it was created/.test(tabFreed.status) && tabFreed.tabs === tabsBefore, { tabLocked, tabFreed });
    closeAll(); await sleep(30);

    // R2-1: a lost create that DID land frees the other dialog's Create button once the snapshot confirms it.
    $("addProj").click(); requireElement("#projModal[aria-hidden=false]");
    $("pName").value = "Landed Project"; $("pName").dispatchEvent(new Event("input", { bubbles: true }));
    $("pBrowse").click(); await waitFor(() => $("pDir").textContent.includes(folderChoice), "landed project folder");
    $("createProj").click();
    const landedProject = window.__sent.filter((message) => message.type === "addProject").at(-1);
    const seedProject = window.__ccSeed.projects.find((project) => project.tabs.some((tab) => tab.id === tabId));
    const newProject = structuredClone(seedProject); newProject.id = landedProject.id; newProject.name = "Landed Project";
    newProject.tabs.forEach((tab) => { tab.id = `${landedProject.id}-${tab.id}`; });
    window.__ccSeed.projects.push(newProject);
    closeAll(); await sleep(30);
    $("addtab").click(); requireElement("#modal[aria-hidden=false]");
    await dropAndReconnect("reconnect after a landed project create"); await sleep(30);
    const afterProject = { disabled: $("createTab").disabled, label: $("createTab").textContent };
    check("a project create that landed with its reply lost frees Create tab in the open Add tab dialog", !afterProject.disabled && afterProject.label === "Create tab", afterProject);
    closeAll(); await sleep(30);
    window.__ccSeed.projects = window.__ccSeed.projects.filter((project) => project.id !== newProject.id); window.__ccSeed.selectedTabId = tabId; deliverSeed(); await sleep(30);
    $("addtab").click(); requireElement("#modal[aria-hidden=false]");
    $("tName").value = "Landed Tab"; await sleep(10);
    $("createTab").click();
    const landedTab = window.__sent.filter((message) => message.type === "addTab").at(-1);
    const landedProjectRow = window.__ccSeed.projects.find((project) => project.id === landedTab.projectId);
    const newTab = structuredClone(landedProjectRow.tabs.find((tab) => tab.id === tabId) ?? landedProjectRow.tabs[0]); newTab.id = "landed-tab"; newTab.name = "Landed Tab";
    landedProjectRow.tabs.push(newTab);
    closeAll(); await sleep(30);
    $("addProj").click(); requireElement("#projModal[aria-hidden=false]");
    $("pName").value = "Second Project"; $("pName").dispatchEvent(new Event("input", { bubbles: true }));
    $("pBrowse").click(); await waitFor(() => $("pDir").textContent.includes(folderChoice), "second project folder");
    await dropAndReconnect("reconnect after a landed tab create"); await sleep(30);
    const afterTab = { disabled: $("createProj").disabled, label: $("createProj").textContent };
    check("a tab create that landed with its reply lost frees Create project in the open New project dialog", !afterTab.disabled && afterTab.label === "Create project", afterTab);
    closeAll(); await sleep(30);
    landedProjectRow.tabs = landedProjectRow.tabs.filter((tab) => tab.id !== "landed-tab"); window.__ccSeed.selectedTabId = tabId; deliverSeed(); await sleep(30);

    // F05: Check again must not stay disabled when the connection dropped before the answer.
    $("setBtn").click(); requireElement("#setModal[aria-hidden=false]");
    requireElement("#setBody [data-settings-refresh]").click();
    const refreshRunning = requireElement("#setBody [data-settings-refresh]").disabled;
    await dropAndReconnect("reconnect after a Check again with no answer"); await sleep(30);
    const refreshAfter = { disabled: requireElement("#setBody [data-settings-refresh]").disabled, label: requireElement("#setBody [data-settings-refresh]").textContent, help: text("#setBody .settings-help") };
    check("Check again is usable again after the connection dropped before its answer", refreshRunning && !refreshAfter.disabled && refreshAfter.label === "Check again" && refreshAfter.help.includes("Could not check just now"), { refreshRunning, refreshAfter });
    closeAll(); await sleep(30);

    // Two crew picks for one tab leave one notice and send only the last pick; picking the server's own crew cancels the waiting one.
    window.__ccSeed.selectedTabId = tabId; deliverSeed(); await sleep(30);
    const crewNotices = () => document.querySelectorAll("#undo [data-undo-held]").length;
    const setProcessSent = () => window.__sent.filter((message) => message.type === "setProcess" && message.tabId === tabId);
    const crewSentBefore = setProcessSent().length;
    const pickCrew = (id) => { clickMenuItem(openTabMenu(tabId), "Kind and crew"); requireElement(`#setupPop [data-set-process="${id}"]`).click(); };
    pickCrew("duo"); pickCrew("solo");
    const twoPicksOneNotice = crewNotices() === 1 && /Stand-alone/.test($("undo").textContent);
    pickCrew(seedTab().process);
    const sameCrewCancels = crewNotices() === 0;
    await sleep(100);
    const nothingSentOnCancel = setProcessSent().length === crewSentBefore;
    check("two crew picks for one tab leave exactly one notice; picking the current crew cancels the waiting change and sends nothing", twoPicksOneNotice && sameCrewCancels && nothingSentOnCancel, { twoPicksOneNotice, sameCrewCancels, nothingSentOnCancel, notices: crewNotices(), text: $("undo").textContent });
    document.querySelector("#undo [data-undo-held]")?.click(); await sleep(20);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 0 : delay, ...args);
    pickCrew("duo"); pickCrew("solo");
    window.setTimeout = nativeSetTimeout;
    await waitFor(() => setProcessSent().length > crewSentBefore, "the last crew pick is sent");
    await sleep(60);
    const crewSends = setProcessSent().slice(crewSentBefore);
    check("two quick crew picks send exactly one setProcess, the last pick", crewSends.length === 1 && crewSends[0].process === "solo", { crewSends });
    window.__ccDeliver({ type: "error", action: "setProcess", tabId, message: "released by the harness" }); await sleep(30); closeAll(); await sleep(20);

    // Three rapid clicks on the step button advance one step; a click after the pause works.
    const stepState = (index) => {
      const next = structuredClone(window.__ccSeed); const stepTab = latestTab(tabId, next);
      stepTab.derived.leaderTurnActive = false; stepTab.pendingApprovals = [];
      stepTab.processState.approval = { state: "approved" };
      stepTab.derived.stepBar = ["brief", "work", "done"].map((stepId, at) => ({ stepId, label: stepId[0].toUpperCase() + stepId.slice(1), owners: ["user"], state: at < index ? "done" : at === index ? "current" : "upcoming" }));
      return { ...next, type: "state" };
    };
    window.__ccDeliver(stepState(0)); await sleep(30);
    const advances = () => window.__sent.filter((message) => message.type === "advanceStep" && message.tabId === tabId).length;
    const advanceBefore = advances();
    const stepButton = () => document.querySelector('#stepActs [data-process-action="advanceStep"]');
    stepButton().click();
    window.__ccDeliver(stepState(1)); // the server answered: the next step's button now sits in the same spot
    stepButton()?.click(); stepButton()?.click();
    const oneStepOnly = advances() === advanceBefore + 1;
    await sleep(700);
    stepButton()?.click();
    check("three rapid clicks on the step button advance exactly one step, and a click after the pause works", oneStepOnly && advances() === advanceBefore + 2, { oneStepOnly, advances: advances() - advanceBefore });
    window.__ccDeliver(stepState(0)); await sleep(30);
    // An unrelated state clears the wait; the guard starts only when the step really changes, even 700 ms later.
    await sleep(700); // the step change just above started its own guard
    const lateBefore = advances();
    stepButton().click();
    window.__ccDeliver(stepState(0)); // unrelated: same step
    await sleep(700);
    window.__ccDeliver(stepState(1)); // the real step change, late
    stepButton()?.click();
    const lateBlocked = advances() === lateBefore + 1;
    await sleep(700);
    stepButton()?.click();
    check("a step change arriving after an unrelated state still blocks the immediate click, and a click after the pause works", lateBlocked && advances() === lateBefore + 2, { lateBlocked, advances: advances() - lateBefore });
    window.__ccDeliver(stepState(0)); await sleep(30);
    // Round transitions keep the step and the approval the same: only the phase and round change, and they start the pause too.
    const roundState = (phase, round) => {
      const next = stepState(1); const roundTab = latestTab(tabId, next);
      roundTab.derived.stepBar = ["brief", "review", "done"].map((stepId, at) => ({ stepId, label: stepId[0].toUpperCase() + stepId.slice(1), owners: ["user"], state: at < 1 ? "done" : at === 1 ? "current" : "upcoming" }));
      roundTab.processState.phase = phase; roundTab.processState.round = round;
      return next;
    };
    const roundSent = (type) => window.__sent.filter((message) => message.type === type && message.tabId === tabId).length;
    const roundButton = (action) => document.querySelector(`#stepActs [data-process-action="${action}"]`);
    await sleep(700);
    window.__ccDeliver(roundState("review", 1)); await sleep(700);
    const findingsBefore = roundSent("reviewFindings");
    roundButton("reviewFindings")?.click();
    window.__ccDeliver(roundState("fix", 1)); // review -> fix: same step, same approval
    roundButton("finishFix")?.click();
    const fixBlocked = roundSent("finishFix") === 0;
    await sleep(700);
    roundButton("finishFix")?.click();
    const fixAfterPause = roundSent("finishFix") === 1;
    window.__ccDeliver(roundState("review", 2)); // fix -> next round
    roundButton("reviewFindings")?.click();
    const nextRoundBlocked = roundSent("reviewFindings") === findingsBefore + 1;
    await sleep(700);
    roundButton("reviewFindings")?.click();
    check("a review round change (Found findings, Finish fixes) pauses the next step click for 600 ms, and a click after the pause works", roundSent("reviewFindings") === findingsBefore + 2 && fixBlocked && fixAfterPause && nextRoundBlocked, { fixBlocked, fixAfterPause, nextRoundBlocked, findings: roundSent("reviewFindings") - findingsBefore });
    // A tab missing from a state loses its sent mark, so a stale mark cannot guard a later unrelated change.
    const gone = structuredClone(window.__ccSeed); gone.projects.forEach((project) => { project.tabs = project.tabs.filter((tab) => tab.id !== tabId); });
    roundButton("reviewFindings")?.click();
    window.__ccDeliver({ ...gone, type: "state" }); await sleep(30);
    window.__ccDeliver(roundState("review", 1)); await sleep(30);
    document.querySelector(`#tabs [data-tab-id="${tabId}"]`)?.click(); await sleep(30);
    window.__ccDeliver(roundState("fix", 1)); await sleep(30);
    const staleBefore = roundSent("finishFix");
    roundButton("finishFix")?.click();
    check("a tab that left the state loses its sent mark: a later change starts no pause", roundSent("finishFix") === staleBefore + 1, { sent: roundSent("finishFix") - staleBefore });
    // A drop between the click and its state keeps the mark: the reconnect snapshot shows the change and still starts the pause.
    window.__ccDeliver(roundState("review", 1)); await sleep(700);
    const dropBefore = roundSent("reviewFindings"); const dropFixBefore = roundSent("finishFix");
    roundButton("reviewFindings")?.click();
    const droppedSocket = window.__socket; dropSocket(droppedSocket);
    await waitFor(() => window.__socket !== droppedSocket, "socket reconnect after the step click");
    window.__socket.readyState = 1; window.__socket.emit("open", {}); await sleep(100); // the reconnect handshake settles first
    window.__ccDeliver(roundState("fix", 1)); // the server applied the click while the socket was down
    roundButton("finishFix")?.click();
    const dropBlocked = roundSent("reviewFindings") === dropBefore + 1 && roundSent("finishFix") === dropFixBefore;
    await sleep(700);
    roundButton("finishFix")?.click();
    check("a connection drop between a step click and its state keeps the pause: the immediate click is ignored, a click after the pause works", dropBlocked && roundSent("finishFix") === dropFixBefore + 1, { dropBlocked, finishFix: roundSent("finishFix") - dropFixBefore });
    window.__ccDeliver(stepState(0)); await sleep(30);
  };

  // The app window opens on a new random port each launch: a page's localStorage is empty then. The same real server is opened from two
  // different proxy ports (two origins); what the first page chose must be what the second one shows.
  const runLooksWrite = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real server state");
    requireElement('#themeTg [data-theme-toggle="dark"]').click();
    $("meBtn").click(); requireElement('#avModal[aria-hidden="false"]');
    requireElement('#avgrid [data-avatar="momo"]').click();
    await waitFor(() => window.__latestState.clientPrefs?.theme === "dark" && window.__latestState.clientPrefs?.avatar === "momo.svg", "the real server keeps the theme and picture");
    check("a theme and picture chosen in one page load are kept by the real server", !document.body.classList.contains("light") && $("meImg").getAttribute("src") === "/avatars/momo.svg", { port: location.port, prefs: window.__latestState.clientPrefs });
    // The sound volume too: set in the speaker's popover, sent when the slider is let go.
    $("soundBtn").click(); requireElement('#soundPop[aria-hidden="false"]');
    const slider = $("soundVol"); slider.value = "35";
    slider.dispatchEvent(new Event("input", { bubbles: true })); slider.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => window.__latestState.clientPrefs?.bellVolume === 35, "the real server keeps the sound volume");
    pressEscape();
    check("a sound volume set in one page load is kept by the real server", window.__latestState.clientPrefs.bellVolume === 35 && $("soundVol").value === "35" && text("#soundVolOut") === "35%", { prefs: window.__latestState.clientPrefs, slider: $("soundVol").value });
    audit.matched.port = location.port;
  };
  const runLooksRead = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real server state");
    let storedTheme = "unreadable", storedMe = "unreadable";
    try { storedTheme = localStorage.getItem("cc-theme"); storedMe = localStorage.getItem("cc-me"); } catch {}
    await waitFor(() => !document.body.classList.contains("light"), "the saved dark theme is applied in a fresh page load on another port");
    await waitFor(() => $("meImg").getAttribute("src") === "/avatars/momo.svg", "the saved picture is applied in a fresh page load on another port");
    check("a fresh page load on a different port opens in the theme and picture chosen before", storedTheme === null && storedMe === null && requireElement('#themeTg [data-theme-toggle="dark"]').getAttribute("aria-checked") === "true", { port: location.port, storedTheme, storedMe, light: document.body.classList.contains("light"), picture: $("meImg").getAttribute("src"), prefs: window.__latestState.clientPrefs });
    $("soundBtn").click(); requireElement('#soundPop[aria-hidden="false"]');
    const volume = { slider: $("soundVol").value, shown: text("#soundVolOut"), fill: $("soundVol").style.getPropertyValue("--v"), server: window.__latestState.clientPrefs.bellVolume };
    pressEscape();
    check("a fresh page load on a different port opens the sound popover at the volume set before", volume.slider === "35" && volume.shown === "35%" && volume.fill === "0.35" && volume.server === 35, volume);
    audit.matched.port = location.port;
  };

  // The app window's own minimize, maximize/restore and close buttons. The proxy gives this page the window.cc bridge the Electron preload
  // gives the real one (window.__ccWin records each call); the window starts maximized, so the button must open as "Restore".
  const runWindowButtons = async () => {
    await waitFor(() => window.__latestState?.type === "state", "fake server state");
    const group = requireElement("#winBtns"), buttons = ["#winMin", "#winMax", "#winClose"].map((selector) => requireElement(selector)), [min, max, close] = buttons;
    const shown = (element) => element.checkVisibility();
    const region = (element) => getComputedStyle(element).getPropertyValue("-webkit-app-region");
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const maxState = () => ({ maximized: max.dataset.maximized, label: max.getAttribute("aria-label"), title: max.title, icons: [...max.querySelectorAll("svg")].filter(shown).map((svg) => svg.getAttribute("class")) });
    await waitFor(() => max.dataset.maximized === "true", "the window's starting maximized state reaches the button");
    const atLoad = maxState();

    const settings = box(requireElement("#setBtn")), settingsRadius = getComputedStyle(requireElement("#setBtn")).borderRadius;
    const bar = [...requireElement("#top").children];
    const looks = buttons.map((button) => ({ id: button.id, tag: button.tagName, type: button.type, label: button.getAttribute("aria-label"), tabIndex: button.tabIndex, shown: shown(button), region: region(button), ...box(button), radius: getComputedStyle(button).borderRadius }));
    const sameFamily = looks.every((item) => item.tag === "BUTTON" && item.type === "button" && item.label && item.tabIndex === 0 && item.shown && item.region === "no-drag"
      && Math.abs(item.width - settings.width) < 0.5 && Math.abs(item.height - settings.height) < 0.5 && item.radius === settingsRadius && Math.abs((item.top + item.bottom) / 2 - (settings.top + settings.bottom) / 2) < 1);
    check("with the app bridge the window buttons show after the avatar, as labelled buttons the size and shape of Settings, and none of them drags the window",
      shown(group) && region(group) === "no-drag" && region(requireElement("#top")) === "drag" && bar.indexOf(requireElement("#meBtn")) === bar.length - 2 && bar.at(-1) === group
      && looks.map((item) => item.label).join() === "Minimize,Restore,Close" && sameFamily,
      { group: { shown: shown(group), region: region(group) }, order: bar.map((node) => node.id || node.className), looks, settings: { ...settings, radius: settingsRadius } });

    min.click(); max.click(); close.click();
    const calls = [...window.__ccWin.calls];
    check("each window button sends its own call once per click: minimize, maximize or restore, close", JSON.stringify(calls) === JSON.stringify(["minimize", "toggleMaximize", "close"]), { calls });

    window.__ccWinEmit(false); const restored = maxState();
    window.__ccWinEmit(true); const maximizedAgain = maxState();
    const restoreLook = (state) => state.maximized === "true" && state.label === "Restore" && state.title === "Restore" && state.icons.join() === "wrestore";
    check("the maximize button opens as Restore on a maximized window and swaps icon, label and tooltip on every maximize and restore",
      restoreLook(atLoad) && restored.maximized === "false" && restored.label === "Maximize" && restored.title === "Maximize" && restored.icons.join() === "wmax" && restoreLook(maximizedAgain),
      { atLoad, restored, maximizedAgain });

    // The app's minimum window width: every control in the bar stays whole, inside the window, and clear of every other.
    const controls = [requireElement("#top .mark"), ...requireElement("#top").querySelectorAll("button,[role=tab]")].filter(shown).filter((element) => !element.closest("#ptabs") || element.matches("[role=tab]"));
    const ptabs = box(requireElement("#ptabs"));
    const rects = controls.map((element) => { const r = box(element); return { id: element.id || element.className?.baseVal || element.className, ...r, ...(element.matches("[role=tab]") ? { left: Math.max(r.left, ptabs.left), right: Math.min(r.right, ptabs.right) } : {}) }; }).filter((r) => r.right - r.left > 0.5);
    const clashes = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j], x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 0.5 && y > 0.5) clashes.push([a.id, b.id, x, y]);
    }
    const outside = rects.filter((r) => r.left < -0.5 || r.right > innerWidth + 0.5).map((r) => r.id);
    check("at the app's minimum width nothing in the top bar overlaps or leaves the window", innerWidth === 900 && rects.length >= 10 && clashes.length === 0 && outside.length === 0 && box(close).right <= innerWidth - 13,
      { innerWidth, controls: rects.length, clashes, outside, closeRight: box(close).right });

    // The sound popover at the same width: whole, inside the window, right under the speaker.
    $("soundBtn").click();
    const soundPop = box(requireElement('#soundPop[aria-hidden="false"]')), speaker = box(requireElement("#soundBtn"));
    check("at the app's minimum width the sound popover opens whole, inside the window, right under the speaker",
      soundPop.left >= 12 && soundPop.right <= innerWidth - 12 && soundPop.bottom <= innerHeight && soundPop.top >= speaker.bottom && soundPop.top - speaker.bottom <= 12 && soundPop.left <= speaker.right && soundPop.right >= speaker.left && soundPop.width >= 280,
      { soundPop, speaker, innerWidth, innerHeight });
    pressEscape();

    // Closing the app while a tab is working. window.__ccWinAskClose() plays electron/main.js asking this page; window.__ccWin.answers records
    // what the page told the window: "close" at once with nothing working, else "hold" with its warning up, then "keep" or "close".
    const answers = window.__ccWin.answers;
    const ask = () => { const before = answers.length; window.__ccWinAskClose(); return answers.slice(before); };
    const warning = () => ({ open: !$("confirmModal").hidden && $("confirmModal").classList.contains("on") && $("confirmModal").getAttribute("aria-hidden") === "false", title: text("#confirmTitle"), body: text("#confirmBody"), keep: text("#confirmCancel"), close: text("#confirmOk"), danger: $("confirmOk").classList.contains("danger"), role: $("confirmModal").getAttribute("role"), focused: $("confirmModal").contains(document.activeElement), modals: document.querySelectorAll(".modal.on").length, scrim: $("scrim").classList.contains("on") });
    // Which tabs work comes from each tab's activeWork (the server's own check), never from derived.busy: the two are set opposite here.
    const withWork = (ids) => {
      const state = structuredClone(window.__ccSeed), beta = state.projects.find((project) => project.id === "beta"), model = beta.tabs[0];
      if (ids.includes("beta-qa")) beta.tabs.push({ ...structuredClone(model), id: "beta-qa", name: "QA" }, { ...structuredClone(model), id: "beta-docs", name: "Docs" });
      for (const tab of state.projects.flatMap((project) => project.tabs)) { tab.activeWork = ids.includes(tab.id); tab.derived.busy = !tab.activeWork; }
      window.__ccDeliver({ ...state, type: "state" });
    };
    withWork([]);
    const idle = { answers: ask(), warning: warning() };
    check("a close request with nothing working is answered close at once, with no warning", idle.answers.join() === "close" && !idle.warning.open && !idle.warning.scrim, idle);

    withWork(["alpha-dev", "beta-dev"]);
    const first = { answers: ask(), warning: warning() };
    check("a close request while tabs are working holds the close and names them as Project · Tab in the app's own warning",
      first.answers.join() === "hold" && first.warning.open && first.warning.scrim && first.warning.role === "alertdialog" && first.warning.focused && first.warning.title === "Close Command Center?"
      && first.warning.body === "2 tabs are still working: Alpha\u00A0·\u00A0Development, Beta\u00A0·\u00A0Development. Closing stops them." && first.warning.keep === "Keep open" && first.warning.close === "Close anyway" && first.warning.danger, first);
    const again = { answers: ask(), warning: warning() };
    check("a second close request while the warning shows redraws the same warning, never a second one", again.answers.join() === "hold" && again.warning.open && again.warning.modals === 1 && again.warning.body === first.warning.body, again);

    $("confirmCancel").click(); const keepButton = { answers: answers.slice(-1), warning: warning() };
    const escapeAnswers = [...ask()]; pressEscape(); escapeAnswers.push(...answers.slice(-1)); const escapeWarning = warning();
    const scrimAnswers = [...ask()]; $("scrim").click(); scrimAnswers.push(...answers.slice(-1)); const scrimWarning = warning();
    check("Keep open, Escape and a click outside cancel the warning and tell the window to stay open",
      keepButton.answers.join() === "keep" && !keepButton.warning.open && !keepButton.warning.scrim && escapeAnswers.join() === "hold,keep" && !escapeWarning.open && scrimAnswers.join() === "hold,keep" && !scrimWarning.open,
      { keepButton, escapeAnswers, escapeWarning, scrimAnswers, scrimWarning });

    const closeStart = answers.length;
    ask(); $("confirmOk").click();
    const closeAnyway = { answers: answers.slice(closeStart), warning: warning() };
    check("Close anyway tells the window to close, and nothing after it says stay", closeAnyway.answers.join() === "hold,close" && !closeAnyway.warning.open, closeAnyway);

    withWork(["alpha-design"]);
    const oneAnswers = ask(), one = warning(); $("confirmCancel").click();
    withWork(["alpha-dev", "alpha-design", "beta-dev", "beta-qa", "beta-docs"]);
    const fiveAnswers = ask(), five = warning(); pressEscape();
    withWork([]);
    const idleAgain = ask();
    check("the warning names one working tab as it, and more than three as the first three and +N more",
      oneAnswers.join() === "hold" && one.body === "1 tab is still working: Alpha\u00A0·\u00A0Design. Closing stops it." && fiveAnswers.join() === "hold"
      && five.body === "5 tabs are still working: Alpha\u00A0·\u00A0Development, Alpha\u00A0·\u00A0Design, Beta\u00A0·\u00A0Development +2 more. Closing stops them." && idleAgain.join() === "close" && !warning().open,
      { oneAnswers, one: one.body, fiveAnswers, five: five.body, idleAgain });

    // The server's answer that a tab was created closes the Add tab dialog, never the close-app question that is open over it
    // (closing that one counts as Keep open).
    withWork([]);
    $("addtab").click();
    requireElement('#modal[aria-hidden="false"]');
    $("browse").click();
    await waitFor(() => !$("createTab").disabled, "the Add tab dialog has a folder");
    $("createTab").click();
    const createSent = window.__sent.filter((message) => message.type === "addTab").length === 1;
    withWork(["alpha-dev"]);
    const stackedAnswers = ask();
    const stacked = !$("modal").hidden && !$("confirmModal").hidden;
    const created = structuredClone(window.__ccSeed), alphaProject = created.projects.find((project) => project.id === "alpha");
    const newTab = structuredClone(alphaProject.tabs[0]); newTab.id = "alpha-new"; newTab.name = "New tab"; alphaProject.tabs.push(newTab);
    for (const tab of created.projects.flatMap((project) => project.tabs)) { tab.activeWork = tab.id === "alpha-dev"; tab.derived.busy = !tab.activeWork; }
    const answersBefore = answers.length;
    window.__ccDeliver({ ...created, type: "state" });
    const dialogClosed = $("modal").hidden;
    const questionKept = !$("confirmModal").hidden && !answers.slice(answersBefore).includes("keep");
    check("the server's answer that a tab was created closes the Add tab dialog, not the close question open over it",
      createSent && stackedAnswers.join() === "hold" && stacked && dialogClosed && questionKept, { createSent, stackedAnswers, stacked, dialogClosed, questionKept, answers: answers.slice(answersBefore) });
    $("confirmCancel").click();
  };

  // ---- fix pack 2, block 3: the page's behaviour fixes. Each check drives the real page through the same entry point a user or the server uses. ----
  const runPackTwo = async () => {
    await waitFor(() => window.__latestState?.type === "state", "pack 2 fake state");
    const holdClock = installTenSecondClock(40000);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const seedTab = (id = "alpha-dev") => latestTab(id, window.__ccSeed);
    const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const sentSince = (start, type) => window.__sent.slice(start).filter((message) => message.type === type);
    const reconnect = async () => {
      const old = window.__socket, states = window.__states.length;
      dropSocket(old);
      await waitFor(() => window.__socket !== old && window.__socket.readyState === 1 && window.__states.length > states, "reconnect and its first state", 10000);
    };

    // The page is unpainted only until the first state; the theme is then already the server's.
    const bootRule = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((rule) => rule.selectorText === "body.boot #app");
    check("while body.boot is set the app is hidden, so a dark launch never flashes the light look", bootRule?.style.visibility === "hidden" && !document.body.classList.contains("boot"), { rule: bootRule?.cssText, bodyClass: document.body.className });

    // C1: Needs you lists requests for every tab; Accept and Decline name the tab the request is addressed to, not the open one.
    window.__ccStrictRequests = true;
    const crossAccept = "00000000-0000-4000-8000-0000000002a1", crossDecline = "00000000-0000-4000-8000-0000000002a2";
    window.__ccSeed.requests = [
      { id: crossAccept, fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Cross tab accept", body: "For the other tab", status: "pending", createdAt: Date.now() },
      { id: crossDecline, fromTabId: "alpha-dev", toTabId: "alpha-design", title: "Cross tab decline", body: "For the design tab", status: "pending", createdAt: Date.now() - 1000 },
    ];
    window.__ccSeed.selectedTabId = "alpha-dev"; deliverSeed();
    openInbox();
    const acceptButton = requireElement(`#inboxList [data-request-action="accept:${crossAccept}"]`);
    const handoffLabel = acceptButton.textContent.trim();
    let from = window.__sent.length;
    acceptButton.click();
    const accepted = sentSince(from, "resolveRequest").at(-1);
    await waitFor(() => window.__latestState.requests?.find((request) => request.id === crossAccept)?.status === "accepted", "the other tab's request is accepted by the server");
    openInbox();
    from = window.__sent.length;
    requireElement(`#inboxList [data-request-action="decline:${crossDecline}"]`).click();
    const declined = sentSince(from, "resolveRequest").at(-1);
    await waitFor(() => window.__latestState.requests?.find((request) => request.id === crossDecline)?.status === "declined", "the design tab's request is declined by the server");
    check("Accept and Decline on a request for another tab name that tab, and the server takes both", accepted?.tabId === "beta-dev" && accepted.status === "accepted" && declined?.tabId === "alpha-design" && declined.status === "declined" && handoffLabel === `Hand to Development's ${leaderNameOf("beta-dev")}` && !window.__ccErrors.length, { accepted, declined, handoffLabel });
    window.__ccStrictRequests = false; window.__ccSeed.requests = []; deliverSeed(); pressEscape();

    // C14: a renamed leader is called by its new name in the approval panel, the Waiting status and the Needs you card, and in the hand-over button.
    const renamed = structuredClone(window.__ccSeed);
    latestTab("alpha-dev", renamed).crew.find((seat) => seat.isLeader).name = "Rowan";
    latestTab("beta-dev", renamed).crew.find((seat) => seat.isLeader).name = "Ines";
    latestTab("alpha-dev", renamed).pendingApprovals = [{ approvalId: "rename-1", tool: "Bash", summary: "echo renamed", createdAt: 1 }];
    renamed.requests = [{ id: "00000000-0000-4000-8000-0000000002a3", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "Rename check", body: "x", status: "pending", createdAt: Date.now() }];
    window.__ccDeliver({ ...renamed, type: "state" });
    openInbox();
    const renamedChecks = { panel: text("#approvalTitle"), pill: text("#statusBtn .pill"), card: text("#inboxList .ncard.apx > b"), handoff: text('#inboxList [data-request-action^="accept:"]') };
    check("a renamed leader is named in the approval title, the Waiting status, the Needs you card and the hand-over button", renamedChecks.panel === "Rowan wants to run a command" && renamedChecks.pill === "Waiting on you: Rowan wants to run a command" && renamedChecks.card === "Rowan wants to run a command" && renamedChecks.handoff === "Hand to Development's Ines", renamedChecks);
    pressEscape(); deliverSeed();

    // C2 + C13: a live run's log starts from the server's tail, only appends, and is kept to the server's 200 KiB.
    openSeatView("coder");
    const log = () => requireElement('#view [data-output-run="audit-parallel-1"]');
    const logBefore = log().textContent, logNode = log().firstChild;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: "\nsecond line" });
    const appendedInPlace = log().textContent === logBefore + "\nsecond line" && log().firstChild === logNode;
    const resync = structuredClone(window.__ccSeed);
    const resyncRun = latestTab("alpha-dev", resync).runs.find((run) => run.runId === "audit-parallel-1");
    resyncRun.output = "EARLIER LINE\nreal runner output 1\nsecond line\nMISSED WHILE CUT OFF";
    window.__ccDeliver({ ...resync, type: "state" });
    const rebased = log().textContent === resyncRun.output;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: "\nafter" });
    const appendsAfterRebase = log().textContent === `${resyncRun.output}\nafter`;
    window.__ccDeliver({ type: "output", tabId: "alpha-dev", runId: "audit-parallel-1", chunk: `${"x".repeat(300 * 1024)}THE END` });
    const capped = log().textContent.length === 200 * 1024 && log().textContent.endsWith("THE END");
    const afterCap = log().textContent.length;
    deliverSeed();
    check("a run's log starts from the server's tail, a chunk only appends, a resync fills what was missed, and the page keeps 200 KiB", appendedInPlace && rebased && appendsAfterRebase && capped && log().textContent === "real runner output 1", { appendedInPlace, rebased, appendsAfterRebase, capped, afterCap, restored: log().textContent });

    // C9: the stalled card and notice say what the server really does.
    const stallState = structuredClone(window.__ccSeed);
    for (const run of latestTab("alpha-dev", stallState).runs.filter((item) => item.status === "working")) run.stalled = true;
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", runId: "audit-parallel-1", seatKey: "alpha-dev.coder", action: "relaunch" });
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", runId: "audit-parallel-2", seatKey: "alpha-dev.coder", action: "escalate" });
    window.__ccDeliver({ ...stallState, type: "state" });
    openInbox();
    const stallCards = [...document.querySelectorAll("#inboxList .ncard.bad")].filter((card) => card.textContent.includes("run stalled")).map((card) => card.querySelector("p").textContent);
    const relaunchCard = stallCards.find((line) => line.startsWith("Parallel run 1")), escalateCard = stallCards.find((line) => line.startsWith("Parallel run 2"));
    check("a stalled run the server relaunches says so, and one it leaves for you says it was not relaunched", Boolean(relaunchCard?.includes("stopping it and starting it once more") && !relaunchCard.includes("not relaunched")) && Boolean(escalateCard?.includes("It was not relaunched by itself")), { stallCards });
    pressEscape(); deliverSeed();

    // C11: a launch notice is one line in Activity, however it arrives, updated in place when its outcome is confirmed.
    $("sideBtn").click();
    const noticeRows = () => [...document.querySelectorAll("#feed .ev .x")].map((node) => node.textContent).filter((line) => line.startsWith("Pack2 requested Coder"));
    const noticeState = (pending, extra = []) => { const next = structuredClone(window.__ccSeed); next.launchSafety = { ...(next.launchSafety ?? {}), notices: [{ type: "leaderLaunch", id: 7001, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Pack2", pending }, ...extra] }; return { ...next, type: "state" }; };
    window.__ccDeliver({ type: "leaderLaunch", id: 7001, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Pack2", pending: true });
    window.__ccDeliver(noticeState(true));
    window.__ccDeliver(noticeState(true));
    const onceShown = noticeRows().length === 1 && noticeRows()[0].endsWith("outcome unconfirmed");
    window.__ccDeliver(noticeState(false));
    const updatedInPlace = noticeRows().length === 1 && !noticeRows()[0].includes("unconfirmed");
    const manyNotices = Array.from({ length: 90 }, (_, index) => ({ type: "leaderLaunch", id: 8000 + index, seatId: "alpha-dev.coder", seatKey: "alpha-dev.coder", seatName: "Coder", brief: "x", source: "Flood", pending: false }));
    window.__ccDeliver(noticeState(false, manyNotices));
    const feedTexts = () => [...document.querySelectorAll("#feed .ev .x")].map((node) => node.textContent);
    const finished = (rows) => rows.filter((line) => line.endsWith(" finished")).length;
    const rowsA = feedTexts();
    window.__ccDeliver(noticeState(false, manyNotices)); window.__ccDeliver(noticeState(false, manyNotices));
    const rowsB = feedTexts();
    const stable = JSON.stringify(rowsA) === JSON.stringify(rowsB) && rowsA.length <= 80;
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", runId: "audit-parallel-1", seatKey: "alpha-dev.coder", outcome: "done", exitCode: 0 });
    window.__ccDeliver(noticeState(false, manyNotices));
    const rowsC = feedTexts();
    const noChurn = stable && rowsC[0].endsWith(" finished") && finished(rowsC) === finished(rowsA) + 1 && rowsC.length <= 80;
    check("a launch notice is one Activity line however it arrives, updated in place, and repeated states never push real events out", onceShown && updatedInPlace && noChurn, { onceShown, updatedInPlace, stable, rows: rowsA.length, top: rowsC[0], finishedBefore: finished(rowsA), finishedAfter: finished(rowsC) });
    $("sideBtn").click(); deliverSeed();

    // C10: what was sent and not answered before a drop is sent again (a held removal) or forgotten (a Stop), so nothing stays hidden or disabled.
    const lostTab = structuredClone(seedTab("alpha-design")); lostTab.id = "alpha-lost"; lostTab.name = "Lost"; window.__ccSeed.projects[0].tabs.push(lostTab); deliverSeed();
    window.__ccSwallowRemove = true;
    from = window.__sent.length;
    clickMenuItem(openTabMenu("alpha-lost"), "Remove tab");
    await holdClock.advance(10_000);
    const firstRemove = sentSince(from, "removeTab").filter((message) => message.tabId === "alpha-lost").length;
    const hiddenWhileWaiting = !document.querySelector('#tabs [data-tab-id="alpha-lost"]');
    await reconnect();
    try { await waitFor(() => !latestTab("alpha-lost") && !document.querySelector("#undo .undo-item"), "the lost removal is sent again and done"); }
    catch (error) { fail(`${error.message}; sent=${JSON.stringify(sentSince(from, "removeTab"))} undo=${$("undo").textContent} stateHasTab=${Boolean(latestTab("alpha-lost"))} errors=${JSON.stringify(window.__ccErrors)}`); }
    const removeSends = sentSince(from, "removeTab").filter((message) => message.tabId === "alpha-lost").length;
    check("a removal sent just before the connection dropped is sent again after the reconnect and completes", firstRemove === 1 && hiddenWhileWaiting && removeSends === 2 && !document.querySelector('#tabs [data-tab-id="alpha-lost"]'), { firstRemove, hiddenWhileWaiting, removeSends });

    openSeatView("coder");
    const stopButton = (runId) => requireElement(`#view [data-stop-run="${runId}"]`);
    window.__ccSwallowKill = 1;
    stopButton("audit-parallel-1").click();
    const stopAsked = stopButton("audit-parallel-1").disabled;
    await reconnect();
    openSeatView("coder");
    const stopFreed = !stopButton("audit-parallel-1").disabled;
    check("a Stop that never got its answer before the drop is forgotten, so its button works again", stopAsked && stopFreed && window.__ccSwallowKill === 0, { stopAsked, stopFreed });

    // One refused Stop frees only its own run (the refusal names none: the server answers in order).
    window.__ccSwallowKill = 2;
    stopButton("audit-parallel-1").click();
    requireElement('#view [data-run-tab="audit-parallel-2"]').click();
    stopButton("audit-parallel-2").click();
    window.__ccDeliver({ type: "error", action: "killRun", message: "the first stop was refused" });
    const secondStillAsked = stopButton("audit-parallel-2").disabled;
    requireElement('#view [data-run-tab="audit-parallel-1"]').click();
    const firstFreed = !stopButton("audit-parallel-1").disabled;
    check("a refused Stop frees only the run it was for", secondStillAsked && firstFreed, { secondStillAsked, firstFreed });
    await reconnect(); window.__ccSwallowKill = 0;

    // Settings "Check again": the server's answer, success or failure, ends "Checking…".
    $("setBtn").click();
    const settingsHelp = () => text("#s-tools .settings-help");
    window.__ccRefreshReply = "ok"; from = window.__sent.length;
    requireElement("#setBody [data-settings-refresh]").click();
    const refreshRequest = sentSince(from, "refreshSettings").at(-1);
    try { await waitFor(() => /^Checked/.test(settingsHelp()) && !requireElement("#setBody [data-settings-refresh]").disabled, "Check again finished"); }
    catch (error) { fail(`${error.message}; help=${settingsHelp()} disabled=${requireElement("#setBody [data-settings-refresh]").disabled} sent=${JSON.stringify(sentSince(from, "refreshSettings"))} received=${JSON.stringify(window.__received.slice(-3).map((m) => ({ type: m.type, action: m.action, requestId: m.requestId })))}`); }
    window.__ccRefreshReply = "error";
    requireElement("#setBody [data-settings-refresh]").click();
    await waitFor(() => settingsHelp().startsWith("Could not check just now") && !requireElement("#setBody [data-settings-refresh]").disabled, "Check again failed cleanly");
    window.__ccRefreshReply = "drop";
    requireElement("#setBody [data-settings-refresh]").click();
    const stillChecking = requireElement("#setBody [data-settings-refresh]").disabled;
    await holdClock.advance(30_000);
    const gaveUpChecking = settingsHelp().startsWith("Could not check just now") && !requireElement("#setBody [data-settings-refresh]").disabled;
    check("Check again sends a request id, ends on the server's success or failure answer, and never hangs when there is none", typeof refreshRequest?.requestId === "string" && refreshRequest.requestId.length >= 16 && stillChecking && gaveUpChecking, { refreshRequest, stillChecking, gaveUpChecking, help: settingsHelp() });
    pressEscape();

    // A message over the server's 2 MiB limit is refused here with a reason, never sent (the server would close the connection).
    showChat();
    $("ci").value = "x".repeat(2 * 1024 * 1024 + 10); $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    from = window.__sent.length;
    $("sendBtn").click();
    await sleep(80);
    const bigSent = sentSince(from, "chat").length;
    const bigToast = text("#toast");
    check("a chat over 2 MiB is not sent, says so, and keeps the connection and the draft", bigSent === 0 && /too large/i.test(bigToast) && window.__socket.readyState === 1 && $("ci").value.length > 2 * 1024 * 1024 && !$("ci").readOnly, { bigSent, bigToast, readyState: window.__socket.readyState, readOnly: $("ci").readOnly });
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));

    // Request details: the form's limit is bytes, not characters.
    openRequests();
    const bodyField = $("reqBody");
    $("reqTitle").value = "Bytes check";
    bodyField.value = "é".repeat(12289);
    from = window.__sent.length;
    $("reqSend").click();
    await sleep(40);
    const overRefused = sentSince(from, "sendRequest").length === 0 && /too long/i.test($("reqStatus").textContent);
    bodyField.value = "é".repeat(12288);
    $("reqSend").click();
    await sleep(40);
    const exactSent = sentSince(from, "sendRequest").at(-1);
    check("request details are measured in bytes: 24 KiB goes, one byte more is refused here with a reason", overRefused && Boolean(exactSent) && exactSent.body.length === 12288, { overRefused, status: $("reqStatus").textContent, exactSent: exactSent && { bodyChars: exactSent.body.length } });
    if (exactSent) window.__ccDeliver({ type: "actionResult", action: "sendRequest", requestId: exactSent.requestId });
    pressEscape();

    // Saved-run lists and runs that the server never answers stop spinning; a list can be asked for again.
    window.__ccDropHistory = true;
    openSeatView("reviewer1");
    requireElement('#view [data-run-view="history"]').click();
    const spinning = /Loading saved runs/.test(text("#view"));
    await holdClock.advance(15_000);
    const gaveUp = /Could not load the saved runs just now/.test(text("#view")) && !/Loading saved runs/.test(text("#view")) && Boolean(document.querySelector("#view [data-history-retry]"));
    if (!gaveUp) fail(`history never gave up: spinning=${spinning} view=${text("#view").slice(0, 300)} sent=${JSON.stringify(sentSince(from, "historyList"))}`);
    window.__ccDropHistory = false;
    window.__ccHistoryRuns = { "alpha-dev.reviewer1": [{ timestamp: 1780000000999, outcome: { status: "done", exitCode: 0 }, sizeBytes: 10 }] };
    requireElement("#view [data-history-retry]").click();
    await waitFor(() => document.querySelector("#view [data-history-timestamp]"), "the saved-runs list after Try again");
    const row = requireElement("#view [data-history-timestamp]");
    row.click();
    const reading = /Reading its saved files/.test(row.textContent);
    await holdClock.advance(15_000);
    const rowReset = !/Reading its saved files/.test(text("#view")) && /Could not read that saved run/.test(text("#toast"));
    check("a saved-runs list or saved run the server never answers stops spinning, and the list can be asked for again", spinning && gaveUp && reading && rowReset, { spinning, gaveUp, reading, rowReset });
    window.__ccHistoryRuns = null;
    requireElement('#view [data-back-chat]').click();

    // C8 (page side): a successful Save lists the new entry in the leader's Past sessions.
    from = window.__sent.length;
    $("saveBtn").click();
    await waitFor(() => sentSince(from, "historyList").some((message) => message.seatKey === "alpha-dev.leader"), "the leader's Past sessions are listed again after Save");
    check("a successful Save asks for the leader's saved sessions again", true, { listed: sentSince(from, "historyList").map((message) => message.seatKey) });

    // A refused selectTab is forgotten, so the tab's transcript is asked for again when the server does select it.
    window.__ccRefuseSelect = "alpha-design";
    requireElement('#tabs [data-tab-id="alpha-design"]').click();
    await waitFor(() => /cannot open alpha-design/.test(text("#toast")), "the refusal is shown");
    from = window.__sent.length;
    window.__ccSeed.selectedTabId = "alpha-design"; deliverSeed();
    const askedAgain = sentSince(from, "selectTab").some((message) => message.tabId === "alpha-design");
    check("a refused tab selection does not stop the page asking for that tab's transcript later", askedAgain, { sent: sentSince(from, "selectTab") });
    window.__ccSeed.selectedTabId = "alpha-dev"; deliverSeed();

    // The tab strips hold no button inside a tab.
    const nested = [...document.querySelectorAll("[role=tab]")].filter((tab) => tab.querySelector("button, a[href], input, select, textarea, [tabindex]")).map((tab) => tab.className);
    check("no tab in the project strip or the tab strip contains another button", nested.length === 0 && document.querySelectorAll("#ptabs [role=tab]").length > 0 && document.querySelectorAll("#tabs [role=tab]").length > 0, { nested });

    // An attachment that failed has an error ring in the theme's own colours, not a fixed light pink.
    window.__ccSeed.clientPrefs = { ...(window.__ccSeed.clientPrefs ?? {}), theme: "dark" }; deliverSeed();
    const probe = document.createElement("span"); probe.className = "att err"; $("atts").append(probe);
    const darkShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    window.__ccSeed.clientPrefs = { ...window.__ccSeed.clientPrefs, theme: "light" }; deliverSeed();
    check("a failed attachment's ring is not the fixed light pink in the dark theme", darkShadow !== "none" && !darkShadow.includes("244, 199, 195") && !darkShadow.includes("#f4c7c3"), { darkShadow });
    holdClock.restore();
  };

  // Fix pack 3, block 2: page behaviour that had no test at all. Each part builds its own state from the seed, drives the real page code and puts the seed back.
  // With ?collect=1 a part that throws is recorded as one failed check and the next part still runs (the mutation proof breaks every handler at once and reads the failures).
  const runPackThree = async () => {
    await waitFor(() => window.__latestState?.type === "state", "pack 3 fake state");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabId = "alpha-dev";
    const pristine = structuredClone(window.__ccSeed);
    const seedTab = (id = tabId) => latestTab(id, window.__ccSeed);
    const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const sentSince = (start, type) => window.__sent.slice(start).filter((message) => message.type === type);
    const closeAll = () => { for (let count = 0; count < 3; count++) pressEscape(); };
    const resetSeed = async () => { closeAll(); window.__ccSeed = structuredClone(pristine); deliverSeed(); showChat(); await sleep(20); };
    const part = async (label, body) => {
      try { await body(); }
      catch (error) { if (!collectFailures) throw error; check(`${label}: ran to its end`, false, { error: String(error?.message ?? error) }); }
      await resetSeed();
    };
    const STOP_CONFIRM = "release may leave a process running and editing files", UNBLOCK_CONFIRM = "allow this seat to launch again";
    const coderName = () => seedTab().crew.find((seat) => seat.slot === "coder").name;

    // The fake clock the Undo tests use hands out ids: they must never be ids a real timer has, or clearing a real timer would drop a fake one.
    await part("fake clock", async () => {
      const realCleared = []; const wrapped = window.clearTimeout;
      window.clearTimeout = (id) => { realCleared.push(id); return wrapped.call(window, id); }; // stands in for the page's own clearTimeout, which the clock captures
      const fired = [];
      let ids;
      try {
        const clock = installTenSecondClock();
        const fakeId = window.setTimeout(() => fired.push("fake"), 5000);
        const realId = window.setTimeout(() => fired.push("real"), 200);
        const fakeOther = window.setTimeout(() => fired.push("fakeOther"), 6000);
        window.clearTimeout(realId); // clearing the REAL timer must leave the fake ones alone
        window.clearTimeout(fakeOther); // and clearing a fake one must really remove it
        await clock.advance(7000);
        await sleep(300);
        const stale = window.setTimeout(() => fired.push("stale"), 6000);
        clock.restore();
        const before = realCleared.length;
        window.clearTimeout(stale); // a fake id the page still holds after restore
        const reachedReal = realCleared.slice(before);
        const control = window.setTimeout(() => {}, 1_000_000); // a real timer cleared after restore does reach the real clearTimeout
        window.clearTimeout(control);
        ids = { fakeId, realId, fakeOther, stale, control, reachedReal, afterControl: realCleared.slice(before), fired };
        check("the fake clock's ids are never the positive integers real timers use, clearing a real timer leaves a fake one alone, and a fake id never reaches the real clearTimeout after restore",
          Number.isInteger(realId) && realId > 0 && [fakeId, fakeOther, stale].every((id) => !(Number.isInteger(id) && id > 0)) && new Set([fakeId, fakeOther, stale]).size === 3
          && fired.join() === "fake" && reachedReal.length === 0 && ids.afterControl.length === 1 && ids.afterControl[0] === control, ids);
      } finally { window.clearTimeout = wrapped; }
    });

    // Needs you: several unconfirmed stops of one seat get a Release all button next to each one's own.
    await part("Release all", async () => {
      window.__ccSeed.launchSafety = { blocked: [], released: [], notices: [], uncertain: [
        { seatId: "coder", seatKey: "alpha-dev.coder", runId: "rel-1", pid: 5101 }, { seatId: "coder", seatKey: "alpha-dev.coder", runId: "rel-2", pid: 5102 }, { seatId: "reviewer1", seatKey: "alpha-dev.reviewer1", runId: "rel-3", pid: 5103 },
      ] };
      deliverSeed(); openInbox();
      const labels = [...document.querySelectorAll("#inboxList [data-release-all]")].map((button) => button.textContent.trim());
      const loneSeatHasNone = !document.querySelector('#inboxList [data-release-ref="rel-3"]');
      const from = window.__sent.length;
      requireElement('#inboxList [data-confirm-release="rel-1"]').value = "release it";
      requireElement('#inboxList [data-release-all][data-release-ref="rel-1"]').click();
      const wrongSent = sentSince(from, "releaseUnconfirmedSeat").length;
      const wrongToast = /to release them/.test($("toast").textContent);
      requireElement('#inboxList [data-confirm-release="rel-1"]').value = STOP_CONFIRM;
      requireElement('#inboxList [data-release-all][data-release-ref="rel-1"]').click();
      const sent = sentSince(from, "releaseUnconfirmedSeat");
      check("Needs you offers Release all N for a seat with several unconfirmed stops, refuses a wrong phrase, and sends one releaseUnconfirmedSeat with the typed phrase",
        labels.length === 2 && labels.every((label) => label === `Release all 2 for ${coderName()}`) && loneSeatHasNone && wrongSent === 0 && wrongToast && sent.length === 1 && sent[0].seatId === "alpha-dev.coder" && sent[0].confirm === STOP_CONFIRM, { labels, loneSeatHasNone, wrongSent, wrongToast, sent });
    });

    // A failed Save is a card in Needs you with its own Retry save.
    await part("Retry save", async () => {
      window.__ccDeliver({ type: "error", action: "save", tabId, message: "Save failed in the pack 3 test" });
      openInbox();
      const card = [...document.querySelectorAll("#inboxList .ncard.bad")].find((node) => text("b", node) === "Save failed");
      const button = card?.querySelector(`[data-save-tab="${tabId}"]`);
      const shown = { label: button?.textContent.trim(), reason: card?.querySelector("p")?.textContent };
      const from = window.__sent.length;
      button?.click();
      const save = sentSince(from, "save");
      const closed = $("inboxPop").hidden;
      openInbox();
      const gone = !document.querySelector("#inboxList [data-save-tab]");
      check("a failed Save shows a Retry save card in Needs you; its button closes Needs you and sends save for that tab, and the card is gone once the save lands",
        shown.label === "Retry save" && shown.reason === "Save failed in the pack 3 test" && save.length === 1 && save[0].tabId === tabId && closed && gone, { shown, save, closed, gone });
    });

    // A stalled run's card can stop that run.
    await part("stalled Stop", async () => {
      const stalled = structuredClone(window.__ccSeed);
      for (const run of latestTab(tabId, stalled).runs.filter((item) => item.status === "working")) run.stalled = true;
      window.__ccDeliver({ ...stalled, type: "state" });
      openInbox();
      const cards = [...document.querySelectorAll("#inboxList .ncard.bad")].filter((card) => card.textContent.includes("run stalled"));
      const from = window.__sent.length;
      requireElement('#inboxList [data-stop-run="audit-parallel-1"]').click();
      const kills = sentSince(from, "killRun");
      const otherStillLive = !requireElement('#inboxList [data-stop-run="audit-parallel-2"]').disabled;
      check("a stalled run's card has a Stop this run button that sends killRun for that run only", cards.length === 2 && kills.length === 1 && kills[0].runId === "audit-parallel-1" && otherStillLive, { cards: cards.length, kills, otherStillLive });
    });

    // The Advisor row of the leader's card.
    await part("Advisor picker", async () => {
      openSeatCard("leader");
      requireElement("[data-seat-advisor]", $("seatPop")).click();
      const options = [...document.querySelectorAll("#pop [data-advisor]")].map((button) => button.dataset.advisor);
      const model = options.find(Boolean);
      if (!model) fail(`the advisor picker lists no model; matched ${JSON.stringify(options)}`);
      let from = window.__sent.length;
      requireElement(`#pop [data-advisor="${CSS.escape(model)}"]`).click();
      const chosen = sentSince(from, "setAdvisor");
      const closed = $("pop").hidden;
      openSeatCard("leader");
      requireElement("[data-seat-advisor]", $("seatPop")).click();
      from = window.__sent.length;
      requireElement('#pop [data-advisor=""]').click();
      const off = sentSince(from, "setAdvisor");
      check("the Advisor picker sends setAdvisor with the chosen model, and null for Off", options[0] === "" && chosen.length === 1 && chosen[0].tabId === tabId && chosen[0].advisor?.model === model && closed && off.length === 1 && off[0].tabId === tabId && off[0].advisor === null, { options, chosen, off, closed });
    });

    // The pencil on a seat card.
    await part("seat rename", async () => {
      const name = coderName();
      openSeatCard("coder");
      requireElement("[data-seat-rename]", $("seatPop")).click();
      const opened = !$("renameModal").hidden && $("renameInput").value === name && $("renameTitle").textContent === `Rename ${name}`;
      let from = window.__sent.length;
      $("renameInput").value = "Renamed coder";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const renamed = sentSince(from, "updateSeat");
      const closed = $("renameModal").hidden;
      openSeatCard("coder");
      requireElement("[data-seat-rename]", $("seatPop")).click();
      from = window.__sent.length;
      $("renameInput").value = "Discarded name";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      const discarded = sentSince(from, "updateSeat").length === 0 && $("renameModal").hidden;
      check("the seat card's pencil renames the seat: Enter sends updateSeat with the new name, Escape sends nothing", opened && renamed.length === 1 && renamed[0].tabId === tabId && renamed[0].slot === "coder" && renamed[0].name === "Renamed coder" && closed && discarded, { opened, renamed, closed, discarded });
    });

    // Pack 7: a crew seat with a working run keeps its model, effort and CLI; the leader never locks.
    await part("model lock", async () => {
      const setWorking = (working) => {
        const tab = seedTab();
        tab.runs = (tab.runs ?? []).filter((run) => run.runId !== "lock-run" && !(run.seatSlotId === "coder" && run.status === "working"));
        if (working) tab.runs.push({ runId: "lock-run", id: "lock-run", status: "working", seatIsLeader: false, crewGenerationId: tab.processState?.crewGenerationId, seatName: coderName(), seatSlotId: "coder", seatKey: "alpha-dev.coder", label: "Locked build", startedAt: Date.now() });
        deliverSeed();
      };
      const pickerButtons = () => [...document.querySelectorAll("#pop [data-model], #pop [data-effort]")];
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      const idleOpen = pickerButtons().length > 0 && pickerButtons().every((button) => !button.disabled) && !document.querySelector("#pop [data-picker-locked]") && /Applies to the next run/.test($("pop").textContent);
      setWorking(true);
      const lockedButtons = pickerButtons();
      const pickerLocked = lockedButtons.length > 0 && lockedButtons.every((button) => button.disabled && button.getAttribute("aria-disabled") === "true") && /Locked while working./.test(text("[data-picker-locked]", $("pop")));
      let from = window.__sent.length;
      lockedButtons[0].click();
      const pickerSent = sentSince(from, "updateSeat").length;
      closeAll();
      const card = openSeatCard("coder"), row = requireElement("[data-seat-model]", card);
      const cardLocked = row.disabled && row.getAttribute("aria-disabled") === "true" && /Model, effort and tool can change when its runs finish./.test(row.title) && /Locked while working/.test(card.textContent);
      from = window.__sent.length; row.click();
      const rowOpened = !$("pop").hidden || sentSince(from, "updateSeat").length > 0;
      closeAll(); $("setBtn").click();
      const chip = requireElement(`[data-settings-model="coder"]`);
      const settingsLocked = chip.disabled && chip.getAttribute("aria-disabled") === "true" && /Locked while working/.test(chip.closest(".crow").textContent);
      closeAll();
      requireElement("[data-seat-model]", openSeatCard("leader"));
      const leaderFree = !requireElement("[data-seat-model]", $("seatPop")).disabled && !/Locked while working/.test($("seatPop").textContent);
      closeAll();
      setWorking(false);
      const open = openSeatCard("coder");
      const unlocked = !requireElement("[data-seat-model]", open).disabled && !/Locked while working/.test(open.textContent);
      closeAll();
      check("a working crew seat's Model row, open picker and Settings button lock with Locked while working, the leader never locks, and they unlock when the run ends", idleOpen && pickerLocked && pickerSent === 0 && cardLocked && !rowOpened && settingsLocked && leaderFree && unlocked, { idleOpen, pickerLocked, pickerSent, cardLocked, rowOpened, settingsLocked, leaderFree, unlocked });
      // Round 1: open surfaces follow the lock both ways without reopening, searching while locked keeps the models locked, and focus never falls to the page body.
      const surfaceOf = (el) => el?.closest?.("#pop, #seatPop, #setModal") ?? null;
      const focusOk = (root) => { const active = document.activeElement; return Boolean(active) && active !== document.body && root.contains(active) && !active.disabled; };
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      setWorking(true);
      const searchLocked = (() => { const first = pickerButtons().find((button) => button.matches("[data-model]")); if (!first) return false; $("mq").value = first.textContent.trim().slice(0, 2).toLowerCase(); $("mq").dispatchEvent(new Event("input", { bubbles: true })); const rows = [...document.querySelectorAll("#pop [data-model]")]; return rows.length > 0 && rows.every((button) => button.disabled && button.getAttribute("aria-disabled") === "true"); })();
      setWorking(false);
      const pickerUnlocked = pickerButtons().length > 0 && pickerButtons().every((button) => !button.disabled) && !document.querySelector("#pop [data-picker-locked]");
      closeAll();
      setWorking(false);
      const openCard = openSeatCard("coder");
      const cardWasFree = !requireElement("[data-seat-model]", openCard).disabled;
      setWorking(true);
      const cardLockedOpen = requireElement("[data-seat-model]", $("seatPop")).disabled;
      setWorking(false);
      const cardUnlockedOpen = !requireElement("[data-seat-model]", $("seatPop")).disabled && !/Locked while working/.test($("seatPop").textContent);
      closeAll();
      $("setBtn").click();
      const settingsWasFree = !requireElement(`[data-settings-model="coder"]`).disabled;
      setWorking(true);
      const settingsLockedOpen = requireElement(`[data-settings-model="coder"]`).disabled;
      setWorking(false);
      const settingsUnlockedOpen = !requireElement(`[data-settings-model="coder"]`).disabled && !/Locked while working/.test(requireElement(`[data-settings-model="coder"]`).closest(".crow").textContent);
      closeAll();
      // Focus on a model button / the Model row / the Settings chip when the run starts.
      setWorking(false);
      requireElement("[data-seat-model]", openSeatCard("coder")).click();
      pickerButtons().find((button) => button.matches("[data-model]")).focus();
      setWorking(true);
      const pickerFocus = focusOk($("pop")) && surfaceOf(document.activeElement) === $("pop");
      closeAll(); setWorking(false);
      openSeatCard("coder"); requireElement("[data-seat-model]", $("seatPop")).focus();
      setWorking(true);
      const cardFocus = focusOk($("seatPop"));
      closeAll(); setWorking(false);
      $("setBtn").click(); requireElement(`[data-settings-model="coder"]`).focus();
      setWorking(true);
      const settingsFocus = focusOk($("setModal"));
      closeAll(); setWorking(false);
      // An unconfirmed stop locks the seat on the page too; an old row that names no seat locks nothing.
      const safetyBefore = window.__ccSeed.launchSafety;
      const withRows = (uncertain) => { window.__ccSeed.launchSafety = { blocked: [], released: [], notices: [], uncertain }; deliverSeed(); };
      withRows([{ seatId: `${tabId}.coder`, seatKey: `${tabId}.coder`, runId: "lock-uncertain", pid: 4242 }]);
      const uncertainCard = openSeatCard("coder");
      const uncertainLocked = requireElement("[data-seat-model]", uncertainCard).disabled && /Locked while working/.test(uncertainCard.textContent);
      withRows([]);
      const uncertainReleased = !requireElement("[data-seat-model]", $("seatPop")).disabled;
      withRows([{ seatId: "coder", pid: 4343 }]);
      const legacyFree = !requireElement("[data-seat-model]", $("seatPop")).disabled;
      closeAll(); window.__ccSeed.launchSafety = safetyBefore; deliverSeed();
      check("an open picker, seat card and Settings unlock when the run ends, searching a locked picker keeps its models locked, focus stays inside the surface when its control locks, and an unconfirmed stop locks the seat until released", searchLocked && pickerUnlocked && cardWasFree && cardLockedOpen && cardUnlockedOpen && settingsWasFree && settingsLockedOpen && settingsUnlockedOpen && pickerFocus && cardFocus && settingsFocus && uncertainLocked && uncertainReleased && legacyFree, { searchLocked, pickerUnlocked, cardWasFree, cardLockedOpen, cardUnlockedOpen, settingsWasFree, settingsLockedOpen, settingsUnlockedOpen, pickerFocus, cardFocus, settingsFocus, uncertainLocked, uncertainReleased, legacyFree });
      // Final review: Settings > chip > picker opens > the run starts (the chip disables) > Escape must not drop focus on the body.
      setWorking(false); $("setBtn").click();
      requireElement(`[data-settings-model="coder"]`).click();
      const pickerOpened = !$("pop").hidden;
      setWorking(true);
      pressEscape();
      const escActive = document.activeElement;
      check("Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body", pickerOpened && $("pop").hidden && !$("setModal").hidden && Boolean(escActive) && escActive !== document.body && $("setModal").contains(escActive) && !escActive.matches(":disabled"), { pickerOpened, setHidden: $("setModal").hidden, popHidden: $("pop").hidden, active: escActive?.tagName, id: escActive?.id });
      closeAll(); setWorking(false);
    });

    // Settings > Folders > New tabs.
    await part("New tabs Browse", async () => {
      $("setBtn").click(); requireElement('#setNav [data-settings-section="folders"]').click();
      window.__ccFolderChoice = "C:/picked/for-new-tabs";
      const from = window.__sent.length;
      requireElement('#setBody [data-setting-action="project-folder-browse"]').click();
      await waitFor(() => sentSince(from, "changeProjectFolder").length === 1, "the picked folder is sent");
      const sent = sentSince(from, "changeProjectFolder")[0];
      const project = window.__latestState.projects.find((item) => item.tabs.some((tab) => tab.id === tabId));
      check("Settings New tabs Browse sends changeProjectFolder for the shown project with the picked folder", sent.projectId === project.id && sent.folder === "C:/picked/for-new-tabs", { sent, projectId: project.id });
    });

    // The marketing tab's Who fixes this round radio.
    await part("maker radio", async () => {
      const marketing = structuredClone(window.__ccSeed); const tab = latestTab(tabId, marketing);
      tab.kind = "mkt"; tab.process = "main";
      const coder = tab.crew.find((seat) => seat.slot === "coder"), coderState = tab.processState.seats.find((seat) => seat.slotId === "coder");
      for (const [slot, name] of [["socialMedia", "Social"], ["image", "Pixel"], ["videoAndMotion", "Motion"]]) {
        tab.crew.push({ ...structuredClone(coder), slot, name, seatKey: `${tabId}.${slot}`, status: "idle", runs: [] });
        tab.processState.seats.push({ ...structuredClone(coderState), slotId: slot, seatName: name, status: "idle" });
      }
      tab.derived.stepBar = [{ stepId: "review", label: "Review", owners: ["user"], state: "current" }];
      tab.processState.approval = { state: "approved" }; tab.processState.phase = "fix"; tab.processState.round = 1; tab.processState.selectedMakerSlotId = "socialMedia";
      tab.pendingApprovals = []; tab.derived.leaderTurnActive = false;
      window.__ccDeliver({ ...marketing, type: "state" }); await sleep(30);
      const radios = () => [...document.querySelectorAll("#stepActs [data-maker]")];
      const checkedSlot = () => radios().find((radio) => radio.getAttribute("aria-checked") === "true")?.dataset.maker;
      const initial = { slots: radios().map((radio) => radio.dataset.maker), checked: checkedSlot() };
      const from = window.__sent.length;
      requireElement('#stepActs [data-maker="image"]').click();
      requireElement('#stepActs [data-maker="videoAndMotion"]').click(); // the first pick is still waiting for the server
      const picks = sentSince(from, "selectMarketingMaker");
      tab.processState.selectedMakerSlotId = "image"; window.__ccDeliver({ ...marketing, type: "state" }); await sleep(30);
      const afterServer = { checked: checkedSlot(), disabled: radios().some((radio) => radio.disabled) };
      const again = window.__sent.length;
      requireElement('#stepActs [data-maker="image"]').click();
      const repeat = sentSince(again, "selectMarketingMaker").length;
      check("the marketing maker radios choose who fixes the round: a pick sends selectMarketingMaker once, the checked one follows the server, and picking the checked one sends nothing",
        initial.slots.join() === "socialMedia,image,videoAndMotion" && initial.checked === "socialMedia" && picks.length === 1 && picks[0].tabId === tabId && picks[0].slot === "image" && afterServer.checked === "image" && !afterServer.disabled && repeat === 0, { initial, picks, afterServer, repeat });
    });

    // The Details panel's width grip.
    await part("Details grip", async () => {
      if ($("side").hidden) $("sideBtn").click();
      const grip = $("sgrip"); grip.setPointerCapture = () => {}; // synthetic pointer ids cannot be captured
      const right = $("side").getBoundingClientRect().right;
      const width = () => Number(grip.getAttribute("aria-valuenow")), cssWidth = () => $("main").style.getPropertyValue("--sidew");
      const writes = (start) => sentSince(start, "updateClientPref").filter((message) => message.key === "rightPanelWidth").map((message) => message.value);
      const pointer = (type, x) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, clientX: x }));
      const from = window.__sent.length;
      pointer("pointerdown", right - 320); pointer("pointermove", right - 400);
      const dragged = { width: width(), css: cssWidth(), written: writes(from).length };
      pointer("pointermove", right - 100); const tooNarrow = width();
      pointer("pointermove", right - 900); const tooWide = width();
      pointer("pointermove", right - 450); pointer("pointerup", right - 450);
      const released = { width: width(), written: writes(from) };
      const arrows = window.__sent.length;
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      const wider = width();
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      check("the Details width grip drags the panel (clamped 280 to 560), saves the width once on release, and the arrow keys move it by 16",
        dragged.width === 400 && dragged.css === "400px" && dragged.written === 0 && tooNarrow === 280 && tooWide === 560 && released.width === 450 && released.written.join() === "450" && wider === 466 && width() === 450 && writes(arrows).join() === "466,450", { dragged, tooNarrow, tooWide, released, wider, final: width(), arrowWrites: writes(arrows) });
    });

    // Settings > Appearance > Match my PC.
    await part("Match my PC", async () => {
      const realMatchMedia = window.matchMedia; let pcIsLight = true;
      window.matchMedia = (query) => ({ matches: /prefers-color-scheme: light/.test(query) ? pcIsLight : false, media: query, addEventListener() {}, removeEventListener() {} });
      try {
        $("setBtn").click(); requireElement('#setNav [data-settings-section="appearance"]').click();
        const from = window.__sent.length;
        requireElement('#setBody [data-theme="system"]').click();
        const saved = sentSince(from, "updateClientPref").filter((message) => message.key === "theme").map((message) => message.value);
        await waitFor(() => window.__latestState.clientPrefs?.theme === "system", "the server keeps the theme system");
        const lightPc = { light: document.body.classList.contains("light"), radio: requireElement('#setBody [data-theme="system"]').getAttribute("aria-checked"), help: text("#s-appearance .settings-help") };
        pcIsLight = false; deliverSeedWithTheme("system");
        const darkPc = document.body.classList.contains("light");
        pcIsLight = true; deliverSeedWithTheme("system");
        const lightAgain = document.body.classList.contains("light");
        // The PC switches while nothing reaches the page from the server: only the registered media change listener can move the theme.
        const listeners = window.__ccMediaChange ?? [], broadcasts = window.__received.length;
        pcIsLight = false; listeners.forEach((listener) => listener(new Event("change")));
        const darkByListener = document.body.classList.contains("light");
        pcIsLight = true; listeners.forEach((listener) => listener(new Event("change")));
        const lightByListener = document.body.classList.contains("light");
        check("Match my PC follows the PC's light or dark setting, saves theme system, and keeps following it",
          saved.join() === "system" && lightPc.light && lightPc.radio === "true" && /^Following your PC/.test(lightPc.help) && darkPc === false && lightAgain === true, { saved, lightPc, darkPc, lightAgain });
        check("Match my PC: the page's own media change listener moves the theme with no state broadcast",
          listeners.length > 0 && darkByListener === false && lightByListener === true && window.__received.length === broadcasts, { listeners: listeners.length, darkByListener, lightByListener, broadcastsDuring: window.__received.length - broadcasts });
      } finally { window.matchMedia = realMatchMedia; }
      function deliverSeedWithTheme(theme) { window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, theme }, type: "state" }); }
    });

    // A capped saved run: Load the fuller log.
    await part("fuller log", async () => {
      openSeatView("coder");
      requireElement('#stagehead [data-run-view="history"]').click();
      const timestamp = 1780000000777, seatKey = `${tabId}.coder`;
      window.__ccDeliver({ type: "historyList", seatKey, runs: [{ timestamp, sizeBytes: 900000, outcome: { status: "done", exitCode: 0 } }] });
      requireElement(`#view [data-history-timestamp="${timestamp}"]`).click();
      window.__ccDeliver({ type: "historyRun", seatKey, timestamp, output: "tail of the log", brief: null, totalBytes: 900000, outcome: { status: "done", exitCode: 0 }, truncated: true });
      const button = requireElement("#view [data-full-log]");
      const offered = { label: button.textContent.trim(), meta: text("#view .metarow"), log: text("#view .term pre") };
      const from = window.__sent.length;
      button.click(); button.click();
      const asked = sentSince(from, "historyRun");
      const busy = { label: requireElement("#view [data-full-log]").textContent.trim(), disabled: requireElement("#view [data-full-log]").disabled };
      window.__ccDeliver({ type: "historyRun", seatKey, timestamp, output: "the fuller log, still capped", brief: null, totalBytes: 900000, outcome: { status: "done", exitCode: 0 }, truncated: true, full: true });
      const after = { button: Boolean(document.querySelector("#view [data-full-log]")), meta: text("#view .metarow"), log: text("#view .term pre") };
      check("a capped saved run offers Load the fuller log, asks for the full log once, and labels the fuller reply",
        offered.label === "Load the fuller log" && /capped, showing the end of the log/.test(offered.meta) && offered.log === "tail of the log" && asked.length === 1 && asked[0].seatKey === seatKey && asked[0].timestamp === timestamp && asked[0].full === true
        && busy.label === "Reading…" && busy.disabled && !after.button && /fuller log, still capped by the server/.test(after.meta) && after.log === "the fuller log, still capped", { offered, asked, busy, after });
    });

    // The Copy button beside an install command in Settings > AI tools.
    await part("Copy button", async () => {
      const missingGemini = structuredClone(window.__ccSeed);
      missingGemini.settings.tools = { ...missingGemini.settings.tools, gemini: { installed: false, version: null, signedIn: null } };
      window.__ccSeed = missingGemini; deliverSeed();
      $("setBtn").click(); requireElement('#setNav [data-settings-section="tools"]').click();
      const button = requireElement("#setBody [data-copy]"), command = button.dataset.copy;
      const written = []; let refuse = false, copied = true, execCalls = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { if (refuse) throw new Error("clipboard refused"); written.push(value); } } });
      document.execCommand = (name) => { execCalls++; return name === "copy" && copied; };
      try {
        button.click();
        await waitFor(() => $("toast").textContent === "Command copied" && written.length === 1, "the command is copied");
        const ok = { written: [...written], toast: $("toast").textContent };
        refuse = true; copied = true; $("toast").textContent = "";
        requireElement("#setBody [data-copy]").click();
        await waitFor(() => execCalls === 1, "the text-copy fallback runs");
        const fallback = { written: written.length, toast: $("toast").textContent, execCalls, leftover: document.querySelectorAll("body > textarea").length };
        copied = false; $("toast").textContent = "";
        requireElement("#setBody [data-copy]").click();
        await waitFor(() => execCalls === 2, "the fallback runs again");
        const failed = { toast: $("toast").textContent };
        check("the Copy button copies the install command and says so, and falls back to a hidden text copy when the clipboard refuses",
          /^npm install -g /.test(command) && ok.written[0] === command && ok.toast === "Command copied" && fallback.written === 1 && fallback.toast === "Command copied" && fallback.leftover === 0 && /^Could not copy/.test(failed.toast), { command, ok, fallback, failed });
      } finally { delete navigator.clipboard; delete document.execCommand; }
    });

    // Enter in the message box.
    await part("IME Enter", async () => {
      showChat();
      $("ci").value = "text typed with an input method"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      const from = window.__sent.length, receivedFrom = window.__received.length; // the two lists grow differently: each keeps its own start
      const press = (init) => { const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }); $("ci").dispatchEvent(event); return event.defaultPrevented; };
      const composing = press({ isComposing: true }), imeKey = press({ keyCode: 229 }), shifted = press({ shiftKey: true });
      await sleep(150); // sending is asynchronous: give a wrongly accepted Enter time to show up
      const heldBack = sentSince(from, "chat").length === 0;
      const plain = press({});
      await waitFor(() => sentSince(from, "chat").length > 0, "the plain Enter is sent");
      await sleep(100);
      const sent = sentSince(from, "chat");
      await waitFor(() => window.__received.slice(receivedFrom).some((message) => message.type === "chatDone" && message.tabId === sent[0].tabId), "the reply to the plain Enter");
      check("Enter sends the message, but not while an input method is composing or with Shift held",
        heldBack && !composing && !imeKey && !shifted && plain && sent.length === 1 && sent[0].text === "text typed with an input method", { composing, imeKey, shifted, plain, heldBack, sent });
    });

    // The empty chat's three suggestions.
    await part("suggestion chips", async () => {
      showChat();
      const chips = () => [...document.querySelectorAll("#view [data-suggest]")];
      let revision = 0;
      const emptyChat = () => window.__ccDeliver({ type: "chatCleared", tabId, messages: [], revision: ++revision, savedRevision: 0 });
      // While a reply runs the welcome (and its chips) is not drawn at all; while a Save is waiting for its answer the chips are drawn and cannot be pressed.
      window.__ccSaveDeferred = true; $("saveBtn").click(); emptyChat();
      const lockedWhileSaving = chips().length === 3 && chips().every((chip) => chip.disabled);
      window.__ccDeliver({ type: "saved", tabId, revision, savedRevision: revision }); window.__ccSaveDeferred = false; emptyChat();
      const labels = chips().map((chip) => chip.textContent);
      const idle = chips().every((chip) => !chip.disabled);
      const from = window.__sent.length, receivedFrom = window.__received.length; // the two lists grow differently: each keeps its own start
      chips()[1].click();
      await waitFor(() => sentSince(from, "chat").length > 0, "the chip is sent");
      await sleep(100);
      const sent = sentSince(from, "chat");
      await waitFor(() => window.__received.slice(receivedFrom).some((message) => message.type === "chatDone" && message.tabId === sent[0].tabId), "the reply to the chip");
      check("the empty chat's suggestion chips send their own text, and cannot be pressed while a Save is waiting for its answer",
        labels.join("|") === "Where did we leave off?|What is left?|What should we build next?" && idle && lockedWhileSaving && sent.length === 1 && sent[0].text === "What is left?" && sent[0].tabId === tabId, { labels, idle, lockedWhileSaving, sent });
    });

    // The Disconnected banner.
    await part("Retry now", async () => {
      const old = window.__socket; const states = window.__states.length;
      // The page's own reconnect timer (a second or more) must not be what reconnects: such timers are swallowed here, so only the button can.
      const nativeSetTimeout = window.setTimeout; window.setTimeout = (callback, delay, ...args) => (Number(delay) >= 500 ? 0 : nativeSetTimeout(callback, delay, ...args));
      let banner;
      try {
        old.emit("close", {});
        banner = { hidden: $("conn").hidden, off: $("conn").classList.contains("off"), text: $("conn").textContent };
        requireElement("#conn [data-reconnect]").click();
        await waitFor(() => window.__socket !== old && window.__socket.readyState === 1 && window.__states.length > states, "a new connection and its state");
      } finally { window.setTimeout = nativeSetTimeout; }
      check("Retry now on the Disconnected banner opens a new connection at once", !banner.hidden && banner.off && /Disconnected\. Reconnecting in/.test(banner.text) && $("conn").hidden, { banner, hiddenAfter: $("conn").hidden });
    });

    // The screenshot viewer's Prev, Next and Fit.
    await part("screenshot viewer", async () => {
      const shots = ["C:/shots/one.png", "C:/shots/two.png", "C:/shots/three.png"];
      window.__ccDeliver({ type: "chatHistory", tabId, messages: [{ id: "p3-shots", role: "user", text: "three pictures", images: shots, at: Date.now(), revision: 1 }], revision: 1, savedRevision: 1 });
      requireElement("#view [data-open-shot]").click();
      requireElement('#viewer[aria-hidden="false"]');
      const bar = () => ({ title: text("#viewerFiles .bar2 b"), count: text("#viewerFiles .bar2 span:not(.spacer)"), prev: requireElement('#viewerFiles [data-shot-step="-1"]').disabled, next: requireElement('#viewerFiles [data-shot-step="1"]').disabled, fit: requireElement("#viewerFiles [data-shot-fit]").textContent.trim(), pressed: requireElement("#viewerFiles [data-shot-fit]").getAttribute("aria-pressed"), actual: Boolean(document.querySelector("#viewerFiles figure.actual")) });
      const first = bar();
      requireElement('#viewerFiles [data-shot-step="1"]').click(); const second = bar();
      requireElement('#viewerFiles [data-shot-step="1"]').click(); const third = bar();
      requireElement('#viewerFiles [data-shot-step="-1"]').click(); const back = bar();
      requireElement("#viewerFiles [data-shot-fit]").click(); const actual = bar();
      requireElement("#viewerFiles [data-shot-fit]").click(); const fitted = bar();
      check("the screenshot viewer's Prev, Next and Fit buttons step through the pictures, disable at the ends and toggle the size",
        first.title === "one.png" && first.count === "1 of 3" && first.prev && !first.next && second.title === "two.png" && second.count === "2 of 3" && !second.prev && !second.next
        && third.title === "three.png" && third.count === "3 of 3" && !third.prev && third.next && back.title === "two.png" && back.count === "2 of 3"
        && first.fit === "Actual size" && first.pressed === "false" && !first.actual && actual.fit === "Fit to window" && actual.pressed === "true" && actual.actual && fitted.fit === "Actual size" && fitted.pressed === "false" && !fitted.actual, { first, second, third, back, actual, fitted });
    });

    // A run's live log.
    await part("live output", async () => {
      openSeatView("coder");
      const pre = () => requireElement('#view [data-output-run="audit-parallel-1"]'), jump = () => requireElement("#view [data-jump-log]");
      const lines = (from, to) => Array.from({ length: to - from }, (_, index) => `\nstreamed line ${from + index}`).join("");
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: lines(0, 150) });
      const nearEnd = () => pre().scrollHeight - pre().scrollTop - pre().clientHeight < 24;
      const followed = { scrolls: pre().scrollHeight > pre().clientHeight, atEnd: nearEnd(), jumpHidden: jump().hidden, endsWith: pre().textContent.endsWith("streamed line 149") };
      pre().scrollTop = 0; pre().dispatchEvent(new Event("scroll"));
      const readerUp = { jumpShown: !jump().hidden };
      const textBefore = pre().textContent.length;
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: lines(150, 160) });
      const stayed = { top: pre().scrollTop, grew: pre().textContent.length > textBefore, jumpShown: !jump().hidden, endsWith: pre().textContent.endsWith("streamed line 159") };
      jump().click();
      const jumped = { atEnd: nearEnd(), jumpHidden: jump().hidden };
      window.__ccDeliver({ type: "output", tabId, runId: "audit-parallel-1", chunk: "\nafter the jump" });
      const following = { atEnd: nearEnd(), endsWith: pre().textContent.endsWith("after the jump") };
      check("live output appends to the open run's log, follows the end, stays put when the reader scrolled up, and Jump to latest returns to the end",
        followed.scrolls && followed.atEnd && followed.jumpHidden && followed.endsWith && readerUp.jumpShown && stayed.top === 0 && stayed.grew && stayed.jumpShown && stayed.endsWith && jumped.atEnd && jumped.jumpHidden && following.atEnd && following.endsWith, { followed, readerUp, stayed, jumped, following });
    });

    // Watch on a run row of the seat card.
    await part("Watch a run", async () => {
      openSeatView("coder");
      requireElement("#view [data-seat-more]").click();
      const rows = [...document.querySelectorAll("#seatPop [data-watch-run]")].map((button) => button.dataset.watchRun);
      showChat();
      pressEscape();
      openSeatCard("coder");
      requireElement('#seatPop [data-watch-run="audit-parallel-2"]').click();
      const selected = document.querySelector('#view [data-run-tab][aria-selected="true"]')?.dataset.runTab;
      check("the seat card's Watch on a run opens that run in the work view", rows.join() === "audit-parallel-1,audit-parallel-2" && $("seatPop").hidden && Boolean(document.querySelector("#stagehead.wv")) && selected === "audit-parallel-2" && text('#view [data-output-run="audit-parallel-2"]') === "real runner output 2", { rows, selected, cardHidden: $("seatPop").hidden });
    });

    // Allow again inside the Run dialog.
    await part("Run dialog Allow again", async () => {
      window.__ccSeed.launchSafety = { blocked: [`${tabId}.coder`], uncertain: [], released: [], notices: [] }; deliverSeed();
      openSeatView("coder");
      requireElement("#stagehead [data-run-seat]").click();
      const shown = Boolean(document.querySelector("#runBlk [data-run-unblock]")) && /Allow .* again to start it/.test(text("#runBlk"));
      let from = window.__sent.length;
      window.__ccConfirmResult = false;
      requireElement("#runBlk [data-run-unblock]").click();
      const asked = !$("confirmModal").hidden && $("confirmPhrase").dataset.phrase === UNBLOCK_CONFIRM;
      confirmIfAsked();
      const cancelled = sentSince(from, "unblockSeat").length === 0;
      window.__ccConfirmResult = true;
      requireElement("#runBlk [data-run-unblock]").click();
      confirmIfAsked();
      const sent = sentSince(from, "unblockSeat");
      check("Allow again in the Run dialog asks for the typed phrase, then sends unblockSeat; cancelling sends nothing", shown && asked && cancelled && sent.length === 1 && sent[0].seatKey === `${tabId}.coder` && sent[0].confirm === UNBLOCK_CONFIRM, { shown, asked, cancelled, sent });
    });

    // The first-project screen.
    await part("first-project screen", async () => {
      const noProjects = { ...structuredClone(window.__ccSeed), projects: [], type: "state" };
      noProjects.settings.tools = { claude: { installed: true, version: "2.1.0", signedIn: false }, codex: { installed: true, version: "0.1.0", signedIn: true }, opencode: { installed: false, version: null, signedIn: null }, gemini: { installed: false, version: null, signedIn: null } };
      window.__ccDeliver(noProjects);
      const shown = !$("first").hidden;
      const setups = $("first").querySelectorAll("[data-first-setup]").length;
      requireElement("[data-first-project]", $("first")).click();
      const projectOpen = $("projModal").getAttribute("aria-hidden") === "false";
      pressEscape();
      requireElement("[data-first-setup]", $("first")).click();
      const settingsOpen = $("setModal").getAttribute("aria-hidden") === "false";
      const onTools = requireElement("#setNav [aria-current=true]").dataset.settingsSection;
      check("the first-project screen's New project opens the project dialog and each Set up opens Settings on AI tools", shown && setups === 3 && projectOpen && $("projModal").hidden && settingsOpen && onTools === "tools", { shown, setups, projectOpen, settingsOpen, onTools });
    });

    // The tab menu's Rename.
    await part("Rename tab", async () => {
      clickMenuItem(openTabMenu(tabId), "Rename");
      const opened = !$("renameModal").hidden && $("renameInput").value === seedTab().name;
      const from = window.__sent.length;
      $("renameInput").value = "Renamed tab";
      $("renameInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const sent = sentSince(from, "renameTab");
      check("Rename tab in the tab menu sends renameTab with the new name", opened && sent.length === 1 && sent[0].tabId === tabId && sent[0].name === "Renamed tab" && $("renameModal").hidden, { opened, sent });
    });

    // Launch records in Needs you.
    await part("Acknowledge all", async () => {
      window.__ccSeed.launchSafety = { blocked: [], uncertain: [], released: [], notices: [
        { id: 91, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "first record", pending: false },
        { id: 92, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "second record", pending: false },
        { id: 93, source: "Codex", seatName: "Coder", seatKey: "alpha-dev.coder", brief: "still unconfirmed", pending: true },
      ] };
      deliverSeed(); openInbox();
      const heading = text("#inboxRecords .grp.row span");
      const from = window.__sent.length;
      requireElement("#inboxRecords [data-ack-all]").click();
      const sent = sentSince(from, "ackLaunchNotices");
      check("Acknowledge all sends ackLaunchNotices for the finished launch records only", /^Launch records · 2$/.test(heading) && sent.length === 1 && sent[0].ids.join() === "91,92", { heading, sent });
    });
  };

  const selected = query.get("case") || "all";
  (async () => {
    if ((audit.mode === "real" || audit.mode === "fake") && (selected === "all" || selected === "render")) {
      if (audit.mode === "real") await runReal(); else await runFake();
    }
    if (audit.mode === "fake" && selected === "b2") await runB2();
    if (audit.mode === "fake" && selected === "pack2") await runPackTwo();
    if (audit.mode === "fake" && selected === "pack3") await runPackThree();
    if (audit.mode === "fake" && selected === "titlebar") await runWindowButtons();
    if (audit.mode === "fake" && selected === "c2") { await runPackC(); await runToolApprovals(); await runR6Fixes(); await runR7Fixes(); await runR1Fixes(); }
    if (audit.mode === "fake" && selected === "dialog-close") {
      await waitFor(() => window.__latestState?.type === "state", "dialog-close fake state");
      window.__ccDialogAuditReady = true;
      await new Promise((resolve) => { window.__ccDialogAuditContinue = resolve; });
    }
    if (audit.mode === "real" && selected === "looks-write") await runLooksWrite();
    if (audit.mode === "real" && selected === "looks-read") await runLooksRead();
    if (audit.mode === "real" && selected === "c2-settings") await runPackCSettingsReal();
    if (audit.mode === "real" && selected === "c2-requests") await runRequestsReal();
    if (selected === "all" || selected === "layout") await runLayout();
  })().then(() => {
    audit.finished = true; // the host test refuses a report without it: a virtual-time budget that ended the audit early leaves checks and no failure
    window.__auditReport = audit;
    auditNode.hidden = false;
    auditNode.textContent = JSON.stringify(audit);
    window.__auditDone = true;
    window.__ccAuditFinished = true;
    window.__socket?.close();
  }).catch((error) => {
    audit.failure = error?.stack ?? String(error);
    audit.matched.sent = (window.__sent ?? []).map((message) => { const size = JSON.stringify(message).length; return size > 2000 ? { type: message.type, key: message.key, truncatedFrom: size } : message; }); // a sent picture is megabytes of text
    audit.matched.stateCount = window.__states?.length ?? 0;
    audit.matched.errors = [...audit.errors];
    if (!audit.errors.some((item) => item.includes(error?.message ?? ""))) audit.errors.push(error?.message ?? String(error));
    window.__auditReport = audit;
    auditNode.hidden = false;
    auditNode.textContent = JSON.stringify(audit);
    window.__auditDone = true;
    window.__ccAuditFinished = true;
    window.__socket?.close();
  });
})();
