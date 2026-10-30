(() => {
  const { check, waitFor, text, $, requireElement, latestTab, leaderNameOf, openSeatCard, openRequests, confirmIfAsked, pressApproval } = window.__ccHarness;
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
  Object.assign(window.__ccHarness, { runR6Fixes });
})();
