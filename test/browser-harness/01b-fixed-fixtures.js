(() => {
  const { fail, check, waitFor, text, $, requireElement, pressEscape, pickProject } = window.__ccHarness;
  // Fixed-crew fixture operations for the fake page (window.__ccSeed is the server's state the fake socket hands out). Each one fails when what it
  // names is missing, so a renamed tab or position can never pass silently. No fallbacks: an operation never invents a tab, a position or a task.
  const SLOTS_PER_TAB = 18;
  const tabsOf = (state) => state?.projects?.flatMap((project) => project.tabs) ?? [];
  const seedTab = (tabId) => tabsOf(window.__ccSeed).find((tab) => tab.id === tabId) ?? fail(`fixed tab missing from the seed: ${tabId}; matched ${JSON.stringify(tabsOf(window.__ccSeed).map((tab) => tab.id))}`);
  const publish = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });

  // A named fixed tab and position in a state (the latest one by default): the saved preference, the live seat when one is assigned, the definition.
  const findSlot = (tabId, slot, state = window.__latestState) => {
    const tab = tabsOf(state).find((item) => item.id === tabId) ?? fail(`fixed tab missing: ${tabId}; matched ${JSON.stringify(tabsOf(state).map((item) => item.id))}`);
    if (!tab.fixedCrew?.preferences) fail(`tab ${tabId} is not a valid fixed crew tab`);
    if (!(slot in tab.fixedCrew.preferences)) fail(`fixed position missing: ${tabId}.${slot}; matched ${JSON.stringify(Object.keys(tab.fixedCrew.preferences))}`);
    const definition = (state.fixedCrewDefinitions ?? []).find((item) => item.slot === slot) ?? fail(`no definition for fixed position ${slot}`);
    return { tab, preference: tab.fixedCrew.preferences[slot], seat: tab.crew.find((item) => item.slot === slot) ?? null, definition };
  };

  // Every string that names the old tab (its id, or a seat key "<id>.<slot>") now names the new one.
  const rekey = (value, from, to) => {
    if (typeof value === "string") return value === from ? to : value.startsWith(`${from}.`) ? `${to}.${value.slice(from.length + 1)}` : value;
    if (Array.isArray(value)) return value.map((item) => rekey(item, from, to));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rekey(item, from, to)]));
    return value;
  };
  // A whole second fixed tab beside an idle one: its own preferences, roleExtras, crew, process state, seat keys and an empty task; never shared.
  const cloneIdleTab = (fromId, newId, name) => {
    const source = seedTab(fromId);
    if (tabsOf(window.__ccSeed).some((tab) => tab.id === newId)) fail(`fixed tab already exists: ${newId}`);
    if (!source.fixedCrew?.preferences || source.runs.length || source.processState.runs.length || Object.values(source.fixedCrew.busy ?? {}).some(Boolean) || source.pendingApprovals?.length) fail(`${fromId} is not an idle fixed tab`);
    const copy = rekey(structuredClone(source), fromId, newId);
    Object.assign(copy, { id: newId, name, fixedTask: null, chatRevision: 0, savedRevision: 0 });
    const project = window.__ccSeed.projects.find((item) => item.tabs.some((tab) => tab.id === fromId));
    project.tabs.push(copy);
    publish();
    return copy;
  };

  // One saved assignment changed together with every runtime fact the server derives from it (the live seat, its process seat and its run records).
  const changeAssignment = (tabId, slot, assignment) => {
    const { tab, definition } = findSlot(tabId, slot, window.__ccSeed);
    tab.fixedCrew.preferences[slot] = { assignment, source: "user" };
    const facts = assignment ? { cli: assignment.cli, model: assignment.model, effort: assignment.effort, ...(assignment.advisor ? { advisor: assignment.advisor } : {}) } : null;
    const live = tab.crew.find((seat) => seat.slot === slot);
    if (!facts) {
      tab.crew = tab.crew.filter((seat) => seat.slot !== slot);
      tab.processState.seats = tab.processState.seats.filter((seat) => seat.slotId !== slot);
    } else if (live) {
      Object.assign(live, facts);
      Object.assign(tab.processState.seats.find((seat) => seat.slotId === slot) ?? {}, facts);
    } else {
      tab.crew.push({ slot, name: definition.label, role: definition.label, canWrite: definition.canWrite, isLeader: slot === "leader", ...facts, seatKey: `${tabId}.${slot}`, status: "idle", task: "Ready", runs: [] });
      tab.processState.seats.push({ slotId: slot, name: definition.label, roleLabel: definition.label, isLeader: slot === "leader", canWrite: definition.canWrite, ...facts, status: "idle", task: "Ready" });
    }
    if (facts) for (const run of [...tab.runs, ...tab.processState.runs]) if (run.seatSlotId === slot) Object.assign(run, facts);
    return tab;
  };

  // The server's busy observation for one position, set on purpose; the tab's overall busy follows it. It starts and ends no run.
  const setBusy = (tabId, slot, busy) => {
    const { tab } = findSlot(tabId, slot, window.__ccSeed);
    tab.fixedCrew.busy[slot] = Boolean(busy);
    tab.derived.busy = Object.values(tab.fixedCrew.busy).some(Boolean);
    publish();
    return tab;
  };

  // A task's whole record as getFixedTask answers it, and the compact summary every state message carries for it: one record, one summary.
  const setFixedTask = (tabId, task) => {
    const tab = seedTab(tabId);
    if (!task?.id || !Number.isInteger(task.planVersion) || !Number.isInteger(task.recordRevision)) fail(`the task for ${tabId} lacks an id, plan version or record revision`);
    window.__ccFixedTasks[tabId] = task;
    tab.fixedTask = { taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage };
    publish();
    return task;
  };

  // The smoke: what every browser entry proves about the seed before any later conversion trusts it. Real mode sends no chat; fake mode round-trips one.
  const runFixedSmoke = async () => {
    const mode = window.__ccHarness.audit.mode;
    await waitFor(() => window.__latestState?.type === "state", "server state");
    const expected = ["alpha-dev", "alpha-design", "beta-dev"];
    const tabs = tabsOf(window.__latestState);
    const ids = tabs.map((tab) => tab.id).sort();
    check(`fixed smoke (${mode}): all three fixed tab ids survived server startup, each a valid fixed crew tab`, JSON.stringify(ids) === JSON.stringify([...expected].sort()) && tabs.every((tab) => tab.fixedCrew && !tab.fixedCrew.unavailable && tab.fixedCrew.version === 1 && tab.setupName === "Fixed crew"), { ids, setups: tabs.map((tab) => tab.setupName) });
    const keys = tabs.flatMap((tab) => tab.crew.map((seat) => seat.seatKey));
    const owned = tabs.every((tab) => tab.processState?.tabId === tab.id && tab.crew.every((seat) => seat.seatKey === `${tab.id}.${seat.slot}`) && JSON.stringify(tab.processState.seats.map((seat) => seat.slotId).sort()) === JSON.stringify(tab.crew.map((seat) => seat.slot).sort()) && tab.runs.length === 0);
    check(`fixed smoke (${mode}): each tab owns its process state and seat keys, and no seat key is shared`, owned && new Set(keys).size === keys.length && keys.length > 0, { keys, owners: tabs.map((tab) => [tab.id, tab.processState?.tabId]) });
    const selected = window.__latestState.selectedTabId;
    if (selected !== "alpha-dev") {
      pickProject("alpha");
      requireElement('#tabs [data-tab-id="alpha-dev"]').click();
      await waitFor(() => window.__latestState?.selectedTabId === "alpha-dev", "alpha-dev selected");
    }
    await waitFor(() => Boolean(document.querySelector("#fixedView:not([hidden]) #fcWorkSettings")), "the fixed work view");
    if ($("setModal").hidden) $("setBtn").click();
    await waitFor(() => !$("setModal").hidden && Boolean(document.querySelector("#setBody section.fc[data-fc-tab] [data-fc-row]")), "fixed Settings sections");
    const sections = [...document.querySelectorAll("#setBody section.fc[data-fc-tab]")];
    const rows = sections.map((section) => ({ tab: section.dataset.fcTab, slots: [...section.querySelectorAll("[data-fc-row]")].map((row) => row.dataset.fcRow) }));
    const defined = window.__latestState.fixedCrewDefinitions.map((item) => item.slot);
    check(`fixed smoke (${mode}): fixed Settings shows ${SLOTS_PER_TAB} unique positions for the open tab, the server's own list`, defined.length === SLOTS_PER_TAB && new Set(defined).size === SLOTS_PER_TAB && rows.some((row) => row.tab === "alpha-dev") && rows.every((row) => row.slots.length === SLOTS_PER_TAB && new Set(row.slots).size === SLOTS_PER_TAB && JSON.stringify([...row.slots].sort()) === JSON.stringify([...defined].sort())), { defined, rows });
    pressEscape();
    await waitFor(() => $("setModal").hidden, "Settings closes");
    const ci = requireElement("#ci"), send = requireElement("#sendBtn");
    check(`fixed smoke (${mode}): the leader's chat composer and transcript area render on a fixed tab`, Boolean(ci && send && $("view") && text("#view").length > 0), { view: text("#view").slice(0, 80) });
    if (mode === "fake") {
      await waitFor(() => [...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent === "Saved transcript from the server"), "the saved transcript renders");
      ci.value = "Fixed smoke message"; ci.dispatchEvent(new Event("input", { bubbles: true })); send.click();
      await waitFor(() => [...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent === "The lead replied."), "the reply renders");
      const sent = window.__sent.filter((message) => message.type === "chat");
      check("fixed smoke (fake): one chat is sent for the open fixed tab with its own request id, and the transcript shows the message and the reply", sent.length === 1 && sent[0].tabId === "alpha-dev" && typeof sent[0].requestId === "string" && [...document.querySelectorAll("#view .msg.mine .bubble p")].some((node) => node.textContent === "Fixed smoke message") && !document.querySelector('img[src="x"]'), { sent });
    }
    check(`fixed smoke (${mode}): the page logged no errors`, window.__ccErrors.length === 0, { errors: window.__ccErrors });
  };
  window.__ccHarness.fixed = { findSlot, cloneIdleTab, changeAssignment, setBusy, setFixedTask };
  Object.assign(window.__ccHarness, { runFixedSmoke });
})();
