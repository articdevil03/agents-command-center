(() => {
  const { check, dropSocket, waitFor, text, $, requireElement, latestTab, leaderNameOf, openSeatView, openSeatCard, openInbox, openRequests, confirmIfAsked } = window.__ccHarness;
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
  Object.assign(window.__ccHarness, { runR7Fixes });
})();
