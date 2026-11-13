(() => {
  const { check, dropSocket, waitFor, text, $, requireElement, latestTab, openSeatView } = window.__ccHarness;
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

    // F01: a fixed Settings picker opened and closed on one tab must never act for that tab once another tab's picker is open, and an old reply settles only its own request.
    const settingsChip = (id, slot) => requireElement(`#setBody section.fc[data-fc-tab="${id}"] [data-fc-row="${slot}"] [data-fc-model]`);
    const assignSends = () => window.__sent.filter((message) => message.type === "setCrewAssignment");
    // Each tab picks on a position it has a model for: alpha-dev's coder (Codex, which takes a typed id) and alpha-design's designCoder (Claude, which takes a listed model).
    const typeModel = async (model) => { $("mq").value = model; $("mq").dispatchEvent(new Event("input", { bubbles: true })); await sleep(10); requireElement(`#pop [data-model="${model}"]`).click(); await sleep(30); };
    const listedModel = async () => { const option = [...document.querySelectorAll("#pop [data-model]")].find((button) => button.getAttribute("aria-pressed") === "false" && button.dataset.cli === "claude"); if (!option) throw new Error(`no other listed Claude model; matched ${JSON.stringify([...document.querySelectorAll("#pop [data-model]")].map((button) => [button.dataset.cli, button.dataset.model]))}`); option.click(); await sleep(30); };
    const closeLayers = async () => { closeAll(); await sleep(20); closeAll(); await sleep(20); };
    const assignBefore = assignSends().length;
    $("setBtn").click(); await sleep(30);
    settingsChip("alpha-dev", "coder").click(); await sleep(30);
    const firstOpen = !$("pop").hidden;
    await typeModel("gpt-6-picker-one");
    const firstSend = assignSends().at(-1);
    await closeLayers();
    window.__ccSeed.selectedTabId = "alpha-design"; deliverSeed(); await sleep(30);
    $("setBtn").click(); await sleep(30);
    settingsChip("alpha-design", "designCoder").click(); await sleep(30);
    const secondOpen = !$("pop").hidden && /Choose model and effort/.test($("pop").getAttribute("aria-label"));
    const statusBefore = text('[data-fc-model-status="designCoder"]', $("setBody"));
    window.__ccDeliver({ type: "actionResult", action: "setCrewAssignment", tabId: "alpha-dev", requestId: firstSend?.requestId }); await sleep(30);
    const stillOpen = !$("pop").hidden && assignSends().length === assignBefore + 1 && text('[data-fc-model-status="designCoder"]', $("setBody")) === statusBefore;
    await listedModel();
    const secondSend = assignSends().at(-1);
    check("a fixed Settings picker closed on one tab cannot redraw or send for it after another tab's picker opens, and an old reply leaves the open picker's request alone", firstOpen && secondOpen && stillOpen && assignSends().length === assignBefore + 2 && firstSend?.tabId === "alpha-dev" && secondSend?.tabId === "alpha-design" && secondSend.slot === "designCoder" && typeof secondSend.requestId === "string" && secondSend.requestId !== firstSend.requestId && text('[data-fc-model-status="designCoder"]', $("setBody")) === "Saving…", { firstOpen, secondOpen, stillOpen, firstSend, secondSend, status: text('[data-fc-model-status="designCoder"]', $("setBody")) });
    window.__ccDeliver({ type: "error", action: "setCrewAssignment", tabId: "alpha-design", requestId: secondSend?.requestId, message: "released by the harness" }); await sleep(30);
    await closeLayers();
    window.__ccSeed.selectedTabId = tabId; deliverSeed(); await sleep(30);

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
    // A landed snapshot carries a complete fixed clone (tab id, seat keys, process state), made by the fixed helper with its own publish held back until the reconnect.
    const quiet = (run) => { const live = window.__ccDeliver; window.__ccDeliver = () => {}; try { return run(); } finally { window.__ccDeliver = live; } };
    const landedCopy = quiet(() => window.__ccHarness.fixed.cloneIdleTab(tabId, `${landedProject.id}-${tabId}`, "Landed Tab"));
    seedProject.tabs = seedProject.tabs.filter((tab) => tab.id !== landedCopy.id);
    const newProject = { ...structuredClone({ ...seedProject, tabs: [] }), id: landedProject.id, name: "Landed Project", tabs: [landedCopy] };
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
    const newTab = quiet(() => window.__ccHarness.fixed.cloneIdleTab(tabId, "landed-tab", "Landed Tab"));
    if (!landedProjectRow.tabs.includes(newTab)) throw new Error("the landed tab clone is not in the project the create named");
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
    const refreshAfter = { disabled: requireElement("#setBody [data-settings-refresh]").disabled, label: requireElement("#setBody [data-settings-refresh]").textContent, help: text("#setBody #s-tools .settings-help") };
    check("Check again is usable again after the connection dropped before its answer", refreshRunning && !refreshAfter.disabled && refreshAfter.label === "Check again" && refreshAfter.help.includes("Could not check just now"), { refreshRunning, refreshAfter });
    closeAll(); await sleep(30);
  };
  Object.assign(window.__ccHarness, { runR1Fixes });
})();
