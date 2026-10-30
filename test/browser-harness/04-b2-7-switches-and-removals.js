(() => {
  const { check, waitFor, text, $, requireElement, waitToastVisible, latestTab, clickTab, openTabMenu, clickMenuItem, openProjectMenu, pickProject, openInbox } = window.__ccHarness;
  // Abandoned sends on switches, confirmed tab and project removal cleanup, fallback Undo, queued removals, stacked Undo, pagehide, Pick A/B/C fallbacks, unrelated errors.
  const b2SwitchesAndRemovals = async (ctx) => {
    const { revokedUrls, makeControlledImage, waitAttachmentReady, waitImageUpload, attachmentNames, actionFor, holdClock } = ctx;
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
    Object.assign(ctx, { selectById });
  };
  Object.assign(window.__ccHarness, { b2SwitchesAndRemovals });
})();
