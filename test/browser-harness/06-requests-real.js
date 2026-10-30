(() => {
  const { fail, check, waitFor, $, requireElement, pickProject, openInbox, openRequests } = window.__ccHarness;
  const runRequestsReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "live request test state");
    const settingsRefreshStart = window.__received.length;
    window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
    await waitFor(() => window.__received.slice(settingsRefreshStart).some((item) => item.type === "settingsRefreshed"), "read-only settings refresh from the fake-runner server");
    const refreshedSettings = window.__latestState.settings;
    check("the real browser server probes Gemini and GitHub through its scripted fake runner", refreshedSettings.tools.gemini.installed === false && refreshedSettings.tools.gemini.signedIn === null && refreshedSettings.github.connected === false, { gemini: refreshedSettings.tools.gemini, github: refreshedSettings.github, acknowledgment: window.__received.slice(settingsRefreshStart).find((item) => item.type === "settingsRefreshed") });
    const tabById = (id) => window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === id);
    const beta = window.__latestState.projects.find((project) => project.id === "beta");
    const addedTab = { type: "addTab", projectId: "beta", name: "Temporary request target", kind: "dev", template: "duo", folder: beta.folder };
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
  Object.assign(window.__ccHarness, { runRequestsReal });
})();
