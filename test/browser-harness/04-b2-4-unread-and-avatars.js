(() => {
  const { check, waitFor, $, requireElement, openSeatCard, pickProject, openInbox, pressEscape } = window.__ccHarness;
  // Unread dot, looks, Dismiss, your avatar, seat avatar.
  const b2UnreadAndAvatars = async (ctx) => {
    const { tabOf } = ctx;
    // Unread: a finished reply in a project that is not shown dots that project's tab and says "unread"; one in the shown project, or a user message, does not; opening the project clears it.
    const unreadDot = (projectId) => document.querySelector(`#ptabs [data-project-id="${projectId}"] .pdot.unread`);
    const shownTab = window.__latestState.selectedTabId;
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Reply in the shown project", revision: 40, at: Date.now() });
    const shownNoDot = shownTab === "alpha-dev" && !unreadDot("alpha");
    window.__ccDeliver({ type: "chatMessage", tabId: "beta-dev", role: "user", text: "A message sent from elsewhere", revision: 40, at: Date.now() });
    const userNoDot = !unreadDot("beta");
    window.__ccDeliver({ type: "chatMessage", tabId: "beta-dev", role: "assistant", text: "A reply in the background", revision: 41, at: Date.now() });
    const betaDot = unreadDot("beta"), betaRect = betaDot?.getBoundingClientRect();
    const colourOf = (variable) => { const probe = document.createElement("i"); probe.style.background = "var(" + variable + ")"; document.body.append(probe); const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour; };
    const unreadColour = betaDot ? getComputedStyle(betaDot).backgroundColor : "";
    const betaMarked = Boolean(betaDot && betaRect.width > 0 && betaRect.height > 0 && betaDot.getAttribute("role") === "img" && betaDot.getAttribute("aria-label") === "unread" && / · unread$/.test(requireElement('#ptabs [data-project-id="beta"]').title)
      && unreadColour === colourOf("--accent") && unreadColour !== colourOf("--waiting"));
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    const survivesState = Boolean(unreadDot("beta"));
    pickProject("beta");
    await waitFor(() => window.__latestState.selectedTabId === "beta-dev", "the background project opened");
    const clearedOnOpen = !unreadDot("beta") && !unreadDot("alpha");
    // The same revision again (a resync) is not a new reply: alpha's revision 40 was delivered above, while alpha was shown.
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Reply in the shown project", revision: 40, at: Date.now() });
    const repeatNoDot = !unreadDot("alpha");
    window.__ccDeliver({ type: "chatError", tabId: "alpha-dev", message: "The lead could not reply in the background" });
    const errorMarks = Boolean(unreadDot("alpha"));
    // A removed project takes its mark with it: when a project of that id returns, it comes back read.
    const fullState = structuredClone(window.__latestState), withoutAlpha = structuredClone(fullState);
    withoutAlpha.projects = withoutAlpha.projects.filter((project) => project.id !== "alpha");
    window.__ccDeliver({ ...withoutAlpha, type: "state" });
    const goneWhileRemoved = !unreadDot("alpha") && !document.querySelector('#ptabs [data-project-id="alpha"]');
    window.__ccDeliver({ ...fullState, type: "state" });
    const returnsRead = Boolean(document.querySelector('#ptabs [data-project-id="alpha"]')) && !unreadDot("alpha");
    pickProject("alpha");
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "the first project opened again");
    const clearedAgain = !unreadDot("alpha") && !unreadDot("beta");
    check("an unread reply in a project that is not shown dots its tab until that project is opened", shownNoDot && userNoDot && betaMarked && survivesState && clearedOnOpen && repeatNoDot && errorMarks && goneWhileRemoved && returnsRead && clearedAgain, { shownTab, shownNoDot, userNoDot, betaMarked, unreadColour, betaTitle: document.querySelector('#ptabs [data-project-id="beta"]')?.title, survivesState, clearedOnOpen, repeatNoDot, errorMarks, goneWhileRemoved, returnsRead, clearedAgain });

    // Theme, picture and dismissed runs are the server's: a state that carries them is what the page shows (the real different-port launch is the "looks-read" audit).
    const looksBase = structuredClone(window.__latestState);
    const withPrefs = (prefs) => ({ ...structuredClone(looksBase), clientPrefs: { ...looksBase.clientPrefs, ...prefs }, type: "state" });
    window.__ccDeliver(withPrefs({ theme: "dark", avatar: "sage.svg" }));
    const darkShown = !document.body.classList.contains("light") && requireElement('#themeTg [data-theme-toggle="dark"]').getAttribute("aria-checked") === "true" && $("meImg").getAttribute("src") === "/avatars/sage.svg";
    window.__ccDeliver(withPrefs({ theme: "light", avatar: "not-a-preset.svg" }));
    const lightShown = document.body.classList.contains("light") && $("meImg").getAttribute("src") === "/avatars/ash.svg";
    window.__ccDeliver(withPrefs({}));
    check("the page shows the theme and picture a state carries, and an unknown preset falls back to Ash", darkShown && lightShown, { darkShown, lightShown, shown: $("meImg").getAttribute("src"), light: document.body.classList.contains("light") });
    // Dismissing a failed run saves the list on the server; a state that lacks the dismissal shows the card again, one that has it hides it.
    const dismissBase = structuredClone(window.__latestState), failTab = tabOf("alpha-dev", dismissBase);
    const failedRun = (runId) => ({ runId, id: runId, status: "failed", seatIsLeader: false, crewGenerationId: failTab.processState?.crewGenerationId, seatName: "Coder", seatSlotId: "coder", seatKey: "alpha-dev.coder", label: "Build step", outcome: "failed", endedAt: Date.now() });
    failTab.runs = [...(failTab.runs ?? []), failedRun("dismiss-a"), failedRun("dismiss-b"), failedRun("dismiss-c")];
    const failState = (dismissedRuns) => ({ ...structuredClone(dismissBase), clientPrefs: { ...dismissBase.clientPrefs, dismissedRuns }, type: "state" });
    window.__ccDeliver(failState([]));
    const dismissCard = (runId) => document.querySelector('#inboxPop [data-dismiss-run="' + runId + '"]');
    openInbox();
    const bothShown = Boolean(dismissCard("dismiss-a") && dismissCard("dismiss-b"));
    const dismissStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-a"]').click();
    const dismissRequest = window.__sent.slice(dismissStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    await waitFor(() => (window.__latestState.clientPrefs?.dismissedRuns ?? []).includes("dismiss-a"), "the server keeps the dismissal");
    window.__ccDeliver(failState(dismissRequest.value)); // the fake server's echo carries no injected runs: this state is what a real server sends back
    const aGone = !dismissCard("dismiss-a") && Boolean(dismissCard("dismiss-b"));
    window.__ccDeliver(failState(["dismiss-b"]));
    const serverWins = Boolean(dismissCard("dismiss-a")) && !dismissCard("dismiss-b");
    // A dismissal for a run the server no longer lists can never come back as a card, so the next save drops it (and does not spend one of the 2000 on it).
    window.__ccDeliver(failState(Array.from({ length: 2000 }, (_, index) => "old-" + index)));
    const staleStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-c"]').click();
    const staleRequest = window.__sent.slice(staleStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    const prunedStale = JSON.stringify(staleRequest?.value) === JSON.stringify(["dismiss-c"]);
    // The saved list is capped at 2000 (the server refuses more; 50 finished runs a tab, so 40 tabs fit): with 2000 listed runs already dismissed, the 2001st drops the oldest.
    failTab.runs = [...failTab.runs, ...Array.from({ length: 2000 }, (_, index) => failedRun("cap-" + index))];
    window.__ccDeliver(failState(Array.from({ length: 2000 }, (_, index) => "cap-" + index)));
    const capStart = window.__sent.length;
    requireElement('#inboxPop [data-dismiss-run="dismiss-c"]').click();
    const capRequest = window.__sent.slice(capStart).find((message) => message.type === "updateClientPref" && message.key === "dismissedRuns");
    const keptNewest = capRequest?.value.length === 2000 && capRequest.value.at(-1) === "dismiss-c" && capRequest.value[0] === "cap-1";
    window.__ccDeliver(withPrefs({}));
    pressEscape();
    check("Dismiss saves the run on the server, and the page hides exactly the runs the server lists", bothShown && Array.isArray(dismissRequest?.value) && dismissRequest.value.includes("dismiss-a") && aGone && serverWins && prunedStale && keptNewest, { bothShown, dismissRequest, aGone, serverWins, prunedStale, staleValue: staleRequest?.value, keptNewest, capLength: capRequest?.value.length, capFirst: capRequest?.value[0], capLast: capRequest?.value.at(-1) });

    $("meBtn").click();
    const personalChoices = document.querySelectorAll("#avgrid [data-avatar]").length;
    const personalUploadVisible = !$("avUpload").hidden;
    const avatarState = structuredClone(window.__latestState);
    window.__ccDeliver({ ...avatarState, type: "state" });
    requireElement('#avgrid [data-avatar="momo"]').click();
    pressEscape();
    const personalFocus = document.activeElement === $("meBtn");
    await waitFor(() => window.__latestState.clientPrefs?.avatar === "momo.svg", "the server keeps the chosen picture");
    const serverAvatar = window.__latestState.clientPrefs?.avatar;
    check("Your avatar has twenty presets, saves the choice to the server, and returns focus after a state re-render", personalChoices === 20 && personalUploadVisible && personalFocus && $("meImg").src.endsWith("/avatars/momo.svg") && serverAvatar === "momo.svg", { personalChoices, personalUploadVisible, personalFocus, avatar: $("meImg").src, serverAvatar });
    $("meBtn").click();
    // A picture over the server's 512 KiB cap is refused in plain words: nothing is sent and the old picture stays.
    const bigCanvas = document.createElement("canvas"); bigCanvas.width = bigCanvas.height = 400;
    const bigContext = bigCanvas.getContext("2d"), bigPixels = bigContext.createImageData(400, 400);
    for (let at = 0; at < bigPixels.data.length; at += 65536) crypto.getRandomValues(bigPixels.data.subarray(at, Math.min(at + 65536, bigPixels.data.length)));
    for (let at = 3; at < bigPixels.data.length; at += 4) bigPixels.data[at] = 255;
    bigContext.putImageData(bigPixels, 0, 0);
    const bigBlob = await new Promise((resolve) => bigCanvas.toBlob(resolve, "image/png"));
    const bigTransfer = new DataTransfer(); bigTransfer.items.add(new File([bigBlob], "huge.png", { type: "image/png" })); $("avUp").files = bigTransfer.files;
    const bigSentStart = window.__sent.length;
    $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /too large to keep/.test($("avatarStatus").textContent), "the oversized picture is refused");
    const bigRefused = window.__sent.slice(bigSentStart).every((message) => message.type !== "updateClientPref") && $("meImg").src.endsWith("/avatars/momo.svg") && $("avatarStatus").dataset.status === "failed" && /limit 512 KB/.test($("avatarStatus").textContent);
    check("a picture over 512 KB is refused in plain words, sends nothing and keeps the old picture", bigRefused && bigBlob.size > 400000, { blobBytes: bigBlob.size, status: $("avatarStatus").textContent, shown: $("meImg").src.slice(0, 40) });
    const uploadBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pHUAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    const avatarFile = new File([uploadBytes], "your-avatar.png", { type: "image/png" });
    const avatarTransfer = new DataTransfer(); avatarTransfer.items.add(avatarFile); $("avUp").files = avatarTransfer.files;
    $("avUp").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => $("meImg").src.startsWith("blob:") && $("meImg").complete && $("meImg").naturalWidth === 1, "uploaded personal avatar shown");
    const uploadedAvatar = $("meImg").src.startsWith("blob:") && document.activeElement === $("meBtn");
    await waitFor(() => window.__latestState.clientPrefs?.avatar?.startsWith("data:image/png"), "the server keeps the uploaded picture");
    check("Your avatar upload stores the image data URL on the server and shows it through one short blob URL", uploadedAvatar && window.__latestState.clientPrefs.avatar.startsWith("data:image/png"), { shown: $("meImg").src.slice(0, 30), serverAvatar: window.__latestState.clientPrefs?.avatar?.slice(0, 22) });
    // The picture is referenced, not copied: a user message wears the same short blob URL, and no data URL is in the chat's or the top bar's HTML.
    window.__ccDeliver({ type: "chatMessage", tabId: window.__latestState.selectedTabId, role: "user", text: "picture check", revision: 9001, at: Date.now() });
    await waitFor(() => document.querySelector("#view .msg.mine .uav"), "a user message with the picture");
    const messagePic = document.querySelector("#view .msg.mine .uav").getAttribute("src");
    check("your uploaded picture is referenced once in each message, never copied into its HTML", messagePic === $("meImg").getAttribute("src") && messagePic.startsWith("blob:") && !$("view").innerHTML.includes("data:image") && !$("top").innerHTML.includes("data:image"), { messagePic: messagePic.slice(0, 40), meImg: $("meImg").getAttribute("src").slice(0, 40), dataUrlInChat: $("view").innerHTML.includes("data:image") });
    requireElement("[data-seat-picture]", openSeatCard("coder")).click(); requireElement('#avModal[aria-hidden="false"]');
    const seatChoices = document.querySelectorAll("#avgrid [data-avatar]").length; const seatUploadVisible = !$("avUpload").hidden;
    const seatAvatarStart = window.__sent.length;
    requireElement('#avgrid [data-avatar="ziggy"]').click();
    const seatAvatarRequest = window.__sent.slice(seatAvatarStart).find((message) => message.type === "updateSeat");
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" });
    pressEscape();
    const seatAvatarFocus = document.activeElement?.matches('#view [data-seat-more="coder"]') === true;
    check("seat avatar presets and upload control render, send the selected picture and return focus after a state re-render", seatChoices === 20 && seatUploadVisible && seatAvatarRequest?.tabId === "alpha-dev" && seatAvatarRequest.slot === "coder" && seatAvatarRequest.pic === "avatars/ziggy.svg" && seatAvatarFocus, { seatChoices, seatUploadVisible, seatAvatarRequest, seatAvatarFocus, focusedSeat: document.activeElement?.getAttribute("aria-label") });
    Object.assign(ctx, { uploadBytes });
  };
  Object.assign(window.__ccHarness, { b2UnreadAndAvatars });
})();
