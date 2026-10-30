(() => {
  const { check, text, $, requireElement, leaderNameOf, openInbox, openRequests, pressEscape, confirmIfAsked, deliver, deliverAction } = window.__ccHarness;
  const checkRequestsDrawer = (markUnique) => {
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
    return devLeader;
  };
  const checkPermissionPicker = (markUnique, devLeader) => {
    let before;
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
  };
  Object.assign(window.__ccHarness, { checkRequestsDrawer, checkPermissionPicker });
})();
