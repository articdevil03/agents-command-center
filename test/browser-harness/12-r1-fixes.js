(() => {
  const { check, dropSocket, waitFor, text, $, requireElement, latestTab, openTabMenu, clickMenuItem, openSeatView } = window.__ccHarness;
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
    requireElement('#setupPop [data-use-template="duo"]').click();
    window.setTimeout = nativeSetTimeout;
    await waitFor(() => window.__sent.some((message) => message.type === "useSetup" && message.templateId === "duo"), "crew change sent");
    const crewSent = window.__sent.filter((message) => message.type === "useSetup" && message.templateId === "duo").at(-1);
    check("a crew picker closed on one tab cannot redraw or send for it after another tab's picker opens", crewSent?.tabId === "alpha-design", { crewSent });
    window.__ccDeliver({ type: "error", action: "useSetup", tabId: "alpha-design", message: "released by the harness" }); await sleep(30); closeAll(); await sleep(20);

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
    // The tab is given a listed setup of its own first (a migrated old crew is not a menu choice), so picking "the current crew" is a real button.
    const templateName = (id) => (window.__latestState.templates ?? []).find((item) => item.id === id)?.name;
    const crewBeforePicks = structuredClone(seedTab().crew);
    const currentTemplate = window.__latestState.templates.find((item) => item.id === "our-process");
    seedTab().crew = currentTemplate.crew.map((seat) => ({ ...crewBeforePicks.find((old) => old.slot === seat.slot), ...seat, seatKey: `${tabId}.${seat.slot}` }));
    seedTab().setupName = currentTemplate.name; deliverSeed(); await sleep(30);
    const setProcessSent = () => window.__sent.filter((message) => message.type === "useSetup" && message.tabId === tabId);
    const crewSentBefore = setProcessSent().length;
    const pickCrew = (id) => { clickMenuItem(openTabMenu(tabId), "Kind and crew"); requireElement(`#setupPop [data-use-template="${id}"]`).click(); };
    pickCrew("duo"); pickCrew("blank");
    const twoPicksOneNotice = crewNotices() === 1 && $("undo").textContent.includes(templateName("blank"));
    pickCrew("our-process");
    const sameCrewCancels = crewNotices() === 0;
    await sleep(100);
    const nothingSentOnCancel = setProcessSent().length === crewSentBefore;
    check("two crew picks for one tab leave exactly one notice; picking the current crew cancels the waiting change and sends nothing", twoPicksOneNotice && sameCrewCancels && nothingSentOnCancel, { twoPicksOneNotice, sameCrewCancels, nothingSentOnCancel, notices: crewNotices(), text: $("undo").textContent });
    document.querySelector("#undo [data-undo-held]")?.click(); await sleep(20);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 10000 ? 0 : delay, ...args);
    pickCrew("duo"); pickCrew("blank");
    window.setTimeout = nativeSetTimeout;
    await waitFor(() => setProcessSent().length > crewSentBefore, "the last crew pick is sent");
    await sleep(60);
    const crewSends = setProcessSent().slice(crewSentBefore);
    check("two quick crew picks send exactly one useSetup, the last pick", crewSends.length === 1 && crewSends[0].templateId === "blank", { crewSends });
    window.__ccDeliver({ type: "error", action: "useSetup", tabId, message: "released by the harness" }); await sleep(30); closeAll(); await sleep(20);
    seedTab().crew = crewBeforePicks; deliverSeed(); await sleep(30);

    // Three rapid clicks on the step button advance one step; a click after the pause works.
    const stepState = (index) => {
      const next = structuredClone(window.__ccSeed); const stepTab = latestTab(tabId, next);
      stepTab.derived.leaderTurnActive = false; stepTab.pendingApprovals = [];
      stepTab.processState.approval = { state: "approved" };
      stepTab.derived.stepBar = ["brief", "work", "done"].map((stepId, at) => ({ stepId, type: stepId === "done" ? "finish" : "work", label: stepId[0].toUpperCase() + stepId.slice(1), owners: ["user"], state: at < index ? "done" : at === index ? "current" : "upcoming" }));
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
      roundTab.derived.stepBar = ["brief", "review", "done"].map((stepId, at) => ({ stepId, type: stepId === "review" ? "rounds" : stepId === "done" ? "finish" : "work", label: stepId[0].toUpperCase() + stepId.slice(1), owners: ["user"], state: at < 1 ? "done" : at === 1 ? "current" : "upcoming" }));
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
  Object.assign(window.__ccHarness, { runR1Fixes });
})();
