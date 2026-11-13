(() => {
  const { fail, check, waitFor, waitForServerReply, text, $, requireElement, toastVisible, waitToastVisible, installTenSecondClock, latestTab, clickTab, openTabMenu, clickMenuItem, showChat, openSeatCard, openProjectMenu, pickProject, pressEscape } = window.__ccHarness;
  const runReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "server state");
    const settle = () => new Promise((done) => setTimeout(done, 60));
    const sentSince = (start, type) => window.__sent.slice(start).filter((message) => message.type === type);
    const pickedFolder = new URLSearchParams(location.search).get("folder");
    // The shared model menu needs the CLIs the server found: ask for them once, before any picker opens.
    window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
    await waitFor(() => ["claude", "codex", "opencode"].every((cli) => window.__latestState.settings?.tools?.[cli]?.installed === true && window.__latestState.clis?.find((item) => item.id === cli)?.installed === true), "CLI probes");
    // A creation draft's pick: the position's chip opens the shared model menu, a model of the named CLI is chosen, and the menu is closed again.
    const draftPick = async (which, slot, cli) => {
      requireElement(`#${which === "tab" ? "tCrew" : "pCrew"} [data-fc-new-model="${CSS.escape(slot)}"]`).click();
      await waitFor(() => !$("pop").hidden && Boolean(document.querySelector(`#pop [data-model][data-cli="${cli}"]`)), `${slot} model menu`);
      const option = requireElement(`#pop [data-model][data-cli="${cli}"]`), pick = { cli, model: option.dataset.model };
      option.click(); pressEscape();
      await waitFor(() => $("pop").hidden && !$(which === "tab" ? "modal" : "projModal").hidden, `${slot} menu closed, creation dialog still open`);
      return pick;
    };
    const holdsPick = (preference, pick) => preference?.source === "user" && preference.assignment?.cli === pick.cli && preference.assignment?.model === pick.model;
    const targets = ["#ptabs", "#ptabs .ptab", "#tabs", "#tabs [role=tab]", "#crew", "#crew .seat", "#statusBtn", "#sline", "#view", "#composer", "#rail", "#stage", "#side", "#feed", "#usage", "#lowerBody"];
    const retiredMounts = ["#pipe", "#pipe .step", "#tplBox", "#kindBox", "#pKind", "#pTpl", "#setupPop"]; // the old step bar and the kind and template pickers no longer exist
    const missing = targets.filter((selector) => !document.querySelector(selector));
    const stillThere = retiredMounts.filter((selector) => document.querySelector(selector));
    const packC = ["#inboxBtn", "#inboxPop", "#permBtn", "#permPop", '[data-l="changes"]', '[data-l="notes"]'];
    const missingPackC = packC.filter((selector) => !document.querySelector(selector));
    check("Pack C shell controls render", missingPackC.length === 0, { found: packC.filter((selector) => document.querySelector(selector)), missing: missingPackC });
    const state = window.__latestState;
    const entry = state.projects.flatMap((project) => project.tabs.map((tab) => ({ project, tab }))).find(({ tab }) => tab.id === state.selectedTabId);
    const slots = (state.fixedCrewDefinitions ?? []).map((item) => item.slot);
    const preferenceSlots = Object.keys(entry?.tab.fixedCrew?.preferences ?? {});
    const assigned = preferenceSlots.filter((slot) => entry.tab.fixedCrew.preferences[slot].assignment);
    const crewMatches = Boolean(entry && document.querySelectorAll("#crew .seat").length === entry.tab.crew.length && entry.tab.crew.length === assigned.length && assigned.length > 0 && entry.tab.crew.every((seat) => seat.seatKey === `${entry.tab.id}.${seat.slot}`) && entry.tab.processState?.tabId === entry.tab.id);
    $("setBtn").click();
    await waitFor(() => !$("setModal").hidden && Boolean(document.querySelector(`#setBody section.fc[data-fc-tab="${CSS.escape(entry.tab.id)}"] [data-fc-row]`)), "fixed Settings positions of the open tab");
    const settingsRows = [...document.querySelectorAll(`#setBody section.fc[data-fc-tab="${CSS.escape(entry.tab.id)}"] [data-fc-row]`)].map((row) => row.dataset.fcRow);
    pressEscape(); await waitFor(() => $("setModal").hidden, "Settings closes");
    check("server state renders the shell, the open tab's own crew and all 18 fixed positions in Settings, and no retired mount", missing.length === 0 && stillThere.length === 0 && crewMatches && slots.length === 18 && new Set(slots).size === 18 && preferenceSlots.length === 18 && JSON.stringify([...settingsRows].sort()) === JSON.stringify([...slots].sort()), {
      found: targets.filter((selector) => document.querySelector(selector)), missing, stillThere, projects: state.projects.map((project) => project.name), tabs: entry?.project.tabs.map((tab) => tab.name), crew: document.querySelectorAll("#crew .seat").length, expectedCrew: entry?.tab.crew.length, assigned, slots: slots.length, preferenceSlots: preferenceSlots.length, settingsRows,
    });
    const otherTab = entry.project.tabs.find((tab) => tab.id !== entry.tab.id);
    if (otherTab) {
      const start = window.__received.length;
      const element = requireElement(`#tabs [data-tab-id="${CSS.escape(otherTab.id)}"]`); element.click();
      await waitForServerReply(start, "server tab switch response", () => window.__latestState?.selectedTabId === otherTab.id);
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
    const tabPick = await draftPick("tab", "coder", "codex");
    $("browse").click();
    await waitFor(() => document.querySelector("#tDir")?.textContent.includes(pickedFolder), "folder picker result");
    const addTabStart = window.__received.length, addTabSent = window.__sent.length;
    $("createTab").click();
    await waitForServerReply(addTabStart, "add-tab server response", () => window.__latestState.projects.flatMap((project) => project.tabs).some((tab) => tab.name === "Audit Tab Undo"));
    let added = window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.name === "Audit Tab Undo");
    const addTabRequests = sentSince(addTabSent, "addTab"), addTabRequest = addTabRequests[0];
    await waitFor(() => $("modal").hidden, "add-tab dialog settles closed");
    check("add-tab dialog creates through the fixed crew: one request with the name, folder, projectOnly, fixedCrewVersion, the picked crewChoices and autoAssign, no kind or template, and the server's tab holds the pick", Boolean(addTabRequests.length === 1 && addTabRequest.name === "Audit Tab Undo" && addTabRequest.folder === pickedFolder && addTabRequest.projectOnly === true && addTabRequest.fixedCrewVersion === 1 && addTabRequest.autoAssign === false && JSON.stringify(Object.keys(addTabRequest.crewChoices)) === '["coder"]' && addTabRequest.crewChoices.coder.cli === tabPick.cli && addTabRequest.crewChoices.coder.model === tabPick.model && !("kind" in addTabRequest) && !("template" in addTabRequest) && added && added.folder === pickedFolder && added.fixedCrew?.version === 1 && holdsPick(added.fixedCrew.preferences.coder, tabPick) && !added.fixedCrew.preferences.leader.assignment && $("modal").hidden), { pick: tabPick, count: addTabRequests.length, found: Boolean(added), id: added?.id ?? "missing", folder: added?.folder ?? "missing", coder: added?.fixedCrew?.preferences?.coder ?? "missing", request: addTabRequest, response: window.__received.slice(addTabStart).at(-1) });
    $("addProj").click();
    requireElement("#projModal[aria-hidden=false]");
    $("pName").value = "Audit Project B1";
    $("pName").dispatchEvent(new Event("input", { bubbles: true }));
    const projectPick = await draftPick("project", "leader", "claude");
    requireElement("#pCrew [data-fc-new-auto]").click();
    await waitFor(() => window.__received.some((message) => message.type === "crewAssignmentsPreview") && /Auto assign fills the empty positions/.test($("pCrew").textContent), "the Auto assign preview");
    $("pBrowse").click();
    await waitFor(() => document.querySelector("#pDir")?.textContent.includes(pickedFolder), "project folder picker result");
    const addProjectStart = window.__received.length, addProjectSent = window.__sent.length, previewSent = window.__sent.filter((message) => message.type === "previewCrewAssignments").at(-1);
    $("createProj").click();
    await waitForServerReply(addProjectStart, "new-project server response", () => window.__latestState.projects.some((project) => project.name === "Audit Project B1"));
    const addedProject = window.__latestState.projects.find((project) => project.name === "Audit Project B1");
    await waitFor(() => $("projModal").hidden, "new-project dialog settles closed");
    const projectRequests = sentSince(addProjectSent, "addProject"), projectRequest = projectRequests[0];
    check("new-project dialog creates through the fixed crew: one request with the name, folder, projectOnly, fixedCrewVersion, the picked crewChoices and autoAssign, no kind or template, and the server's first tab holds the pick", Boolean(projectRequests.length === 1 && projectRequest.name === "Audit Project B1" && projectRequest.folder === pickedFolder && projectRequest.tabFolder === pickedFolder && projectRequest.projectOnly === true && projectRequest.fixedCrewVersion === 1 && projectRequest.autoAssign === true && projectRequest.crewChoices.leader?.cli === projectPick.cli && projectRequest.crewChoices.leader.model === projectPick.model && !("kind" in projectRequest) && !("template" in projectRequest) && previewSent?.autoAssign === true && previewSent.choices.leader?.model === projectPick.model && addedProject && addedProject.folder === pickedFolder && addedProject.tabs[0].fixedCrew?.version === 1 && holdsPick(addedProject.tabs[0].fixedCrew.preferences.leader, projectPick) && $("projModal").hidden), { pick: projectPick, count: projectRequests.length, found: Boolean(addedProject), id: addedProject?.id ?? "missing", folder: addedProject?.folder ?? "missing", leader: addedProject?.tabs[0]?.fixedCrew?.preferences?.leader ?? "missing", request: projectRequest, preview: previewSent, response: window.__received.slice(addProjectStart).at(-1) });
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
      const seatOf = (slot) => latestTab("alpha-dev").crew.find((seat) => seat.slot === slot);
      const savedOf = (slot) => latestTab("alpha-dev").fixedCrew.preferences[slot];
      const assigned = (start) => sentSince(start, "setCrewAssignment");
      const answered = (start, request) => window.__received.slice(start).some((message) => message.requestId === request?.requestId && (message.type === "actionResult" || message.type === "error"));
      const closeLayers = async () => { for (let i = 0; i < 3 && (!$("pop").hidden || !$("setModal").hidden); i++) { pressEscape(); await settle(); } if (!$("pop").hidden || !$("setModal").hidden) fail("the model menu or Settings stayed open after Escape"); };
      // The model menu of one position, opened from its model button in Settings (the only place a position's model is chosen).
      const chipOf = (slot) => `#setBody section.fc[data-fc-tab="alpha-dev"] [data-fc-row="${CSS.escape(slot)}"] [data-fc-model]`;
      const openPicker = async (slot) => {
        if ($("setModal").hidden) $("setBtn").click();
        await waitFor(() => !$("setModal").hidden && Boolean(document.querySelector(chipOf(slot))), `Settings model button of ${slot}`);
        if (!$("pop").hidden) { pressEscape(); await waitFor(() => $("pop").hidden, "the open model menu closes"); }
        requireElement(chipOf(slot)).click();
        await waitFor(() => !$("pop").hidden && Boolean($("mq")), `${slot} model menu`);
        return $("pop");
      };
      await openPicker("coder");
      const current = seatOf("coder").model;
      const nextModel = [...document.querySelectorAll("#pop [data-model]")].map((button) => button.dataset.model).find((model) => model !== current);
      if (!nextModel) fail(`no alternate server model rendered; matched ${JSON.stringify([...document.querySelectorAll("#pop [data-model]")].map((button) => button.dataset.model))}`);
      const modelStart = window.__received.length, modelSent = window.__sent.length;
      requireElement(`#pop [data-model="${CSS.escape(nextModel)}"]`).click();
      check("picking a model shows no 'will use' toast before the server confirms", !/will use/.test($("toast")?.textContent ?? "") && !/will use/.test($("undo")?.textContent ?? ""), { toast: $("toast")?.textContent });
      const modelRequest = assigned(modelSent).at(-1);
      await waitForServerReply(modelStart, "server seat model response", () => answered(modelStart, modelRequest) && seatOf("coder").model === nextModel);
      check("seat model change reaches the server as one setCrewAssignment for that tab and position, and the saved assignment follows the server's answer", assigned(modelSent).length === 1 && modelRequest.tabId === "alpha-dev" && modelRequest.slot === "coder" && modelRequest.assignment.model === nextModel && savedOf("coder").assignment.model === nextModel && savedOf("coder").source === "user" && seatOf("coder").model === nextModel && window.__received.slice(modelStart).some((message) => message.type === "actionResult" && message.requestId === modelRequest.requestId), { slot: "coder", expected: nextModel, saved: savedOf("coder"), sent: modelRequest, response: window.__received.slice(modelStart).at(-1) });
      await openPicker("coder");
      const currentEffort = seatOf("coder").effort;
      const nextEffort = [...document.querySelectorAll("#pop [data-effort]")].map((button) => button.dataset.effort).find((effort) => effort !== currentEffort);
      if (!nextEffort) fail(`no alternate server effort rendered; matched ${JSON.stringify([...document.querySelectorAll("#pop [data-effort]")].map((button) => button.dataset.effort))}`);
      const effortStart = window.__received.length, effortSent = window.__sent.length;
      requireElement(`#pop [data-effort="${CSS.escape(nextEffort)}"]`).click();
      const effortRequest = assigned(effortSent).at(-1);
      await waitForServerReply(effortStart, "server seat effort response", () => answered(effortStart, effortRequest) && seatOf("coder").effort === nextEffort);
      check("seat effort change reaches the server as one setCrewAssignment that keeps the model, and the saved assignment follows the server's answer", assigned(effortSent).length === 1 && effortRequest.tabId === "alpha-dev" && effortRequest.slot === "coder" && effortRequest.assignment.effort === nextEffort && effortRequest.assignment.model === nextModel && savedOf("coder").assignment.effort === nextEffort && seatOf("coder").effort === nextEffort, { slot: "coder", expected: nextEffort, saved: savedOf("coder"), sent: effortRequest, response: window.__received.slice(effortStart).at(-1) });
      await closeLayers(); showChat();
      // A seat's picture opens its card for every seat; its name opens the work view (the leader's chat).
      showChat(); pressEscape();
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

      // The picker lists every installed CLI; a model of another CLI sends its cli with the whole assignment; the tick and the effort row follow the server.
      const origin = { ...seatOf("coder") };
      await openPicker("coder");
      const groupNames = [...document.querySelectorAll("#pop [data-grp]")].map((node) => node.dataset.grp);
      check("the picker groups models by installed CLI, the seat's own first", groupNames[0] === origin.cli && groupNames.includes("claude") && groupNames.includes("codex") && groupNames.includes("opencode"), { groupNames, own: origin.cli });
      const groups = () => [...document.querySelectorAll("#pop [data-grp]")].map((node) => node.dataset.grp);
      // Delivered and read in the same turn: a real broadcast (the server echoes every pref the page saves) can land during any wait and replace this state.
      const deliverTools = (patch) => {
        const next = structuredClone(window.__latestState);
        for (const [cli, installed] of Object.entries(patch)) { next.settings.tools[cli].installed = installed; next.clis.find((item) => item.id === cli).installed = installed; } // the picker reads the server's CLI list (state.clis)
        window.__ccDeliver({ ...next, type: "state" });
      };
      const [notChecked, missing] = ["claude", "codex", "opencode"].filter((cli) => cli !== origin.cli);
      deliverTools({ [notChecked]: null, [missing]: false });
      check("a CLI that was not checked (null) or is not installed is not offered, the seat's own always is", !groups().includes(notChecked) && !groups().includes(missing) && groups().includes(origin.cli), { groups: groups(), notChecked, missing });
      deliverTools({ [notChecked]: true, [missing]: true });
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
      // A refusal is the server's answer to ONE request: the next request the page makes is recorded but held back (never sent), and the refusal is delivered under that request's own id.
      const reason = "Finish the coder's current run first", strangerReason = "A refusal for some other request";
      const refusedPick = [...document.querySelectorAll("#pop [data-model]")].find((button) => button.dataset.cli === origin.cli && button.dataset.model !== origin.model);
      if (!refusedPick) fail("no second model of the coder's own CLI rendered to refuse");
      const refusalSent = window.__sent.length, realSocket = window.__socket;
      let held = null;
      realSocket.send = (raw) => { held = JSON.parse(raw); window.__sent.push(held); delete realSocket.send; };
      refusedPick.click();
      const heldRequest = held;
      if (!heldRequest || heldRequest.type !== "setCrewAssignment" || typeof heldRequest.requestId !== "string") fail(`the held request was not a setCrewAssignment with a request id: ${JSON.stringify(heldRequest)}`);
      window.__ccDeliver({ type: "error", action: "setCrewAssignment", tabId: "alpha-dev", requestId: "some-other-request", message: strangerReason }); await settle();
      const statusOf = () => text('[data-fc-model-status="coder"]', $("setBody"));
      const strangerLeftRowAlone = !statusOf().includes(strangerReason);
      window.__ccDeliver({ type: "error", action: "setCrewAssignment", tabId: "alpha-dev", requestId: heldRequest.requestId, message: reason }); await settle();
      check("a refused seat change shows the server's reason on its own position, matched by request id, and leaves the picker open", strangerLeftRowAlone && statusOf() === `Not saved: ${reason}` && /Finish the coder's current run first/.test($("toast")?.textContent ?? "") && !$("pop").hidden && assigned(refusalSent).length === 1 && savedOf("coder").assignment.model === origin.model && seatOf("coder").model === origin.model, { status: statusOf(), strangerLeftRowAlone, toast: $("toast")?.textContent, pickerOpen: !$("pop").hidden, held: heldRequest, saved: savedOf("coder") });
      check("the picker no longer claims the CLI comes with the crew", !/comes with the crew|stays on Claude Code/.test(document.body.innerText), { text: $("pop").innerText });
      const target = [...document.querySelectorAll("#pop [data-model]")].find((button) => button.dataset.cli !== origin.cli);
      if (!target) fail(`no model of another CLI rendered; groups ${JSON.stringify(groupNames)}`);
      const switchSent = window.__sent.length, switchRecv = window.__received.length;
      target.click();
      const targetNow = () => $("pop").querySelector(`[data-model="${CSS.escape(target.dataset.model)}"][data-cli="${CSS.escape(target.dataset.cli)}"]`);
      const tickEarly = targetNow()?.getAttribute("aria-pressed") === "true";
      const switchMessage = assigned(switchSent).at(-1);
      check("a model of another CLI sends setCrewAssignment with the whole assignment: cli, model and effort", assigned(switchSent).length === 1 && switchMessage?.slot === "coder" && switchMessage.tabId === "alpha-dev" && switchMessage.assignment.cli === target.dataset.cli && switchMessage.assignment.model === target.dataset.model && typeof switchMessage.assignment.effort === "string", { switchMessage, target: { cli: target.dataset.cli, model: target.dataset.model } });
      check("the tick does not move before the server confirms", Boolean(targetNow()) && !tickEarly && seatOf("coder").cli === origin.cli, { tickEarly, cli: seatOf("coder").cli });
      await waitForServerReply(switchRecv, "coder moved to the other CLI", () => answered(switchRecv, switchMessage) && seatOf("coder").cli === target.dataset.cli && seatOf("coder").model === target.dataset.model);
      const effortRow = [...document.querySelectorAll("#pop [data-effort]")];
      check("the picker stays open after a pick and shows the effort row for the chosen model", !$("pop").hidden && Boolean($("pop").querySelector("#mq")) && targetNow()?.getAttribute("aria-pressed") === "true" && effortRow.length > 0 && effortRow.some((button) => button.getAttribute("aria-checked") === "true" && button.dataset.effort === seatOf("coder").effort), { open: !$("pop").hidden, effortRow: effortRow.map((button) => button.dataset.effort), seat: seatOf("coder") });
      const otherEffort = effortRow.map((button) => button.dataset.effort).find((effort) => effort !== seatOf("coder").effort);
      const sameSent = window.__sent.length, sameRecv = window.__received.length;
      requireElement(`#pop [data-effort="${CSS.escape(otherEffort)}"]`).click();
      const sameRequest = assigned(sameSent).at(-1);
      await waitForServerReply(sameRecv, "same-visit effort response", () => answered(sameRecv, sameRequest) && seatOf("coder").effort === otherEffort);
      check("effort changes in the same visit as the model", sameRequest?.assignment.effort === otherEffort && sameRequest.assignment.model === target.dataset.model && seatOf("coder").effort === otherEffort, { sent: sameRequest, effort: seatOf("coder").effort });
      await openPicker("coder");
      const backSent = window.__sent.length, backRecv = window.__received.length;
      requireElement(`#pop [data-model="${CSS.escape(origin.model)}"][data-cli="${CSS.escape(origin.cli)}"]`).click();
      const backRequest = assigned(backSent).at(-1);
      await waitForServerReply(backRecv, "coder restored", () => answered(backRecv, backRequest) && seatOf("coder").cli === origin.cli && seatOf("coder").model === origin.model);
      check("going back sends the CLI too", backRequest?.assignment.cli === origin.cli && backRequest.assignment.model === origin.model, { sent: assigned(backSent) });
      if (seatOf("coder").effort !== origin.effort) { requireElement(`#pop [data-effort="${CSS.escape(origin.effort)}"]`).click(); await waitFor(() => seatOf("coder").effort === origin.effort, "coder effort restored"); }
      await closeLayers(); showChat();

      // The leader runs on any CLI. A saved Advisor is a read-only fact (the seat card, the Settings position line, the Usage panel), shown only for a CLI that can take one,
      // and always named for the leader's own position. It is changed nowhere on the page, so no Advisor button exists.
      const leaderOrigin = { ...seatOf("leader") };
      const advisor = "claude-fable-5-1";
      const advisorSurfaces = async () => {
        // A real broadcast can land between steps and replace the state: deliver the saved advisor right before each read.
        const withAdvisor = () => {
          const next = structuredClone(window.__latestState), tab = next.projects.flatMap((project) => project.tabs).find((item) => item.id === "alpha-dev");
          tab.crew.find((seat) => seat.slot === "leader").advisor = advisor;
          const preference = tab.fixedCrew.preferences.leader;
          if (preference.assignment?.cli === "claude") preference.assignment = { ...preference.assignment, advisor }; // the server keeps an advisor only on a CLI that can take one
          window.__ccDeliver({ ...next, type: "state" });
        };
        withAdvisor();
        const leaderName = seatOf("leader").name;
        const advisorRows = [...document.querySelectorAll("#usage .useRow")].map((row) => row.textContent.replace(/\s+/g, " ").trim()).filter((row) => /Advisor/.test(row));
        const forLeader = advisorRows.filter((row) => row.includes(`Advisor for ${leaderName}`));
        showChat(); pic("leader").click(); await settle(); withAdvisor();
        if ($("seatPop").hidden || $("seatPop").dataset.slot !== "leader") fail("the leader's card did not open for the advisor read");
        const cardRow = [...$("seatPop").querySelectorAll(".rowb")].find((row) => row.firstElementChild?.textContent === "Advisor");
        const card = cardRow ? cardRow.textContent.replace(/\s+/g, " ").trim() : null, cardControl = Boolean($("seatPop").querySelector("[data-seat-advisor]"));
        pressEscape(); await settle(); showChat();
        $("setBtn").click(); await settle(); withAdvisor();
        const settingsLine = text('#setBody section.fc[data-fc-tab="alpha-dev"] [data-fc-row="leader"] .fc-source');
        const settingsControl = Boolean(document.querySelector("#setModal [data-se-advisor], #setModal [data-seat-advisor]"));
        await closeLayers();
        return { leaderCli: seatOf("leader").cli, usageAll: advisorRows.length, usageForLeader: forLeader.length, card, cardControl, settingsLine, settingsAdvisor: /advisor/i.test(settingsLine), settingsControl };
      };
      pic("leader").click();
      check("a Claude leader's card shows the Advisor row", leaderOrigin.cli === "claude" && [...$("seatPop").querySelectorAll(".rowb")].some((row) => row.firstElementChild?.textContent === "Advisor"), { cli: leaderOrigin.cli });
      pressEscape(); showChat();
      const claudeSurfaces = await advisorSurfaces();
      check("a Claude leader: the card, the Settings position line and the Usage panel show the saved Advisor as read-only facts for the leader alone", claudeSurfaces.leaderCli === "claude" && Boolean(claudeSurfaces.card) && !/Off/.test(claudeSurfaces.card) && !claudeSurfaces.cardControl && claudeSurfaces.settingsAdvisor && !claudeSurfaces.settingsControl && claudeSurfaces.usageForLeader === 1 && claudeSurfaces.usageAll === 1, claudeSurfaces);
      const leaderPicker = async (cli) => {
        await openPicker("leader");
        const option = requireElement(`#pop [data-model][data-cli="${cli}"]`), start = window.__received.length, sent = window.__sent.length;
        option.click();
        const request = assigned(sent).at(-1);
        await waitForServerReply(start, "leader on the chosen CLI", () => answered(start, request) && seatOf("leader").cli === cli && seatOf("leader").model === option.dataset.model);
        return { option, request, sent };
      };
      const codexLeader = await leaderPicker("codex");
      check("the leader switches CLI with setCrewAssignment: cli, model and effort for the leader position", assigned(codexLeader.sent).length === 1 && codexLeader.request.slot === "leader" && codexLeader.request.tabId === "alpha-dev" && codexLeader.request.assignment.cli === "codex" && codexLeader.request.assignment.model === codexLeader.option.dataset.model && typeof codexLeader.request.assignment.effort === "string", { sent: assigned(codexLeader.sent) });
      check("a Codex leader gets its limit in plain words: it cannot be held read-only, and the choice is saved for this tab", /Codex cannot be held read-only/.test($("pop").innerText) && /Saved for this tab/.test($("pop").innerText), { text: $("pop").innerText });
      await closeLayers(); showChat();
      const codexSurfaces = await advisorSurfaces();
      check("a Codex leader: the card, the Settings position line and the Usage panel show no Advisor", codexSurfaces.leaderCli === "codex" && codexSurfaces.card === null && !codexSurfaces.settingsAdvisor && codexSurfaces.usageAll === 0, codexSurfaces);
      showChat(); pic("leader").click();
      check("a Codex leader's card has no Advisor row", ![...$("seatPop").querySelectorAll(".rowb")].some((row) => row.firstElementChild?.textContent === "Advisor") && !$("seatPop").hidden, { advisorRow: Boolean($("seatPop").querySelector("[data-seat-advisor]")) });
      pressEscape(); showChat();
      await leaderPicker("opencode");
      check("an OpenCode leader (read-only is enforced) gets no read-only warning, only the saved note", /Saved for this tab/.test($("pop").innerText) && !/cannot be held read-only/.test($("pop").innerText) && window.__latestState.clis.find((cap) => cap.id === "opencode")?.readOnlyEnforced === true, { text: $("pop").innerText });
      await closeLayers(); showChat();
      const openCodeSurfaces = await advisorSurfaces();
      check("an OpenCode leader: the card, the Settings position line and the Usage panel show no Advisor", openCodeSurfaces.leaderCli === "opencode" && openCodeSurfaces.card === null && !openCodeSurfaces.settingsAdvisor && openCodeSurfaces.usageAll === 0, openCodeSurfaces);
      await openPicker("leader");
      const leaderBackRecv = window.__received.length, leaderBackSent = window.__sent.length;
      requireElement(`#pop [data-model="${CSS.escape(leaderOrigin.model)}"][data-cli="claude"]`).click();
      const leaderBack = assigned(leaderBackSent).at(-1);
      await waitForServerReply(leaderBackRecv, "leader restored", () => answered(leaderBackRecv, leaderBack) && seatOf("leader").cli === "claude" && seatOf("leader").model === leaderOrigin.model);
      if (seatOf("leader").effort !== leaderOrigin.effort) { requireElement(`#pop [data-effort="${CSS.escape(leaderOrigin.effort)}"]`).click(); await waitFor(() => seatOf("leader").effort === leaderOrigin.effort, "leader effort restored"); }
      await closeLayers();
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
    await waitForServerReply(folderStart, "server folder response", () => latestTab("alpha-dev")?.folder === chosenFolder);
    check("folder picker updates the server tab folder", latestTab("alpha-dev")?.folder === chosenFolder && window.__sent.some((message) => message.type === "changeFolder" && message.tabId === "alpha-dev" && message.folder === chosenFolder), { folder: latestTab("alpha-dev")?.folder, chosen: chosenFolder, sent: window.__sent.filter((message) => message.type === "changeFolder"), response: window.__received.slice(folderStart).at(-1) });
    const projectTabsBeforeChange = window.__latestState.projects.find((project) => project.id === "alpha").tabs.map((tab) => ({ id: tab.id, folder: tab.folder }));
    const projectFolderStart = window.__received.length;
    const projectFolderSentStart = window.__sent.length;
    clickMenuItem(openProjectMenu("alpha"), "Change folder");
    await waitForServerReply(projectFolderStart, "project folder response", () => window.__latestState.projects.find((project) => project.id === "alpha")?.folder === chosenFolder);
    const alphaAfterProjectFolder = window.__latestState.projects.find((project) => project.id === "alpha");
    const projectTabsUnchanged = projectTabsBeforeChange.every((before) => latestTab(before.id)?.folder === before.folder);
    const projectFolderOnly = alphaAfterProjectFolder?.folder === chosenFolder && projectTabsUnchanged;
    const projectFolderRequests = window.__sent.slice(projectFolderSentStart).filter((message) => message.type === "changeProjectFolder" && message.projectId === "alpha" && message.folder === chosenFolder);
    check("project folder picker updates the default without changing existing tab folders", projectFolderOnly && projectFolderRequests.length === 1, { projectFolder: alphaAfterProjectFolder?.folder, projectTabsBeforeChange, tabFoldersAfter: projectTabsBeforeChange.map((tab) => ({ id: tab.id, folder: latestTab(tab.id)?.folder })), sent: window.__sent.slice(projectFolderSentStart), response: window.__received.slice(projectFolderStart).at(-1) });
    $("addtab").click();
    const newTabDefaultsToProject = $("tDir").textContent === chosenFolder && !$("createTab").disabled;
    check("new tab dialog defaults to the project folder", newTabDefaultsToProject, { displayedFolder: $("tDir").textContent, projectFolder: alphaAfterProjectFolder?.folder, createEnabled: !$("createTab").disabled });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  };
  Object.assign(window.__ccHarness, { runReal });
})();
