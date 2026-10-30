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
  window.__ccHarness = { audit, auditNode, query, collectFailures, collectWaitTimeout, fail, check, dropSocket, waitFor, waitForServerReply, text, $, requireElement, toastVisible, waitToastVisible, installTenSecondClock, latestTab, leaderNameOf, clickTab, openTabMenu, clickMenuItem, showChat, openSeatView, openSeatCard, openProjectMenu, pickProject, openInbox, openRequests, openChatMenu, pressEscape, confirmIfAsked };
})();
