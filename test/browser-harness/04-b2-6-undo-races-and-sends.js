(() => {
  const { audit, collectFailures, collectWaitTimeout, check, waitFor, text, $, requireElement, waitToastVisible, clickTab, openTabMenu, clickMenuItem, showChat, openProjectMenu } = window.__ccHarness;
  // Undo races per kind and order, XSS filename, released read, send with image, echoes, second send, disconnected send.
  const b2UndoRacesAndSends = async (ctx) => {
    const { revokedUrls, makeControlledImage, waitAttachmentReady, waitImageUpload, attachmentNames } = ctx;
    const initialSent = window.__sent.length;
    const permutationEvidence = [];
    const actionFor = (kind) => {
      if (kind === "tab") { clickMenuItem(openTabMenu("alpha-dev"), "Remove tab"); return { selector: "removeTab", tabId: "alpha-dev" }; }
      if (kind === "project") { clickMenuItem(openProjectMenu("alpha"), "Remove from Command Center"); return { selector: "removeProject", projectId: "alpha" }; }
      $("setupsBtn").click(); requireElement('#setupPop [data-use-template="blank"]').click(); return { selector: "useSetup", tabId: "alpha-dev" };
    };
    for (const kind of ["tab", "project", "process"]) for (const order of ["read-before-undo", "read-after-undo"]) {
      await clickTab("Development");
      const filename = `race-${kind}-${order}.png`;
      const controlled = await makeControlledImage(filename);
      const preview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes(filename))?.src ?? `pending:${filename}`;
      const actionStart = window.__sent.length;
      const held = actionFor(kind);
      const undoButton = requireElement("#undo [data-undo-held]");
      if (order === "read-before-undo") {
        const uploadIndex = window.__ccImageUploads.length;
        controlled.resolve();
        const result = await waitImageUpload(uploadIndex, filename);
        check(`attachment ${filename} upload completes before ${kind} Undo`, result.status === 200 && typeof result.path === "string", { kind, order, result });
      }
      if (order === "read-before-undo") check(`attachment preview stays live while ${kind} Undo is pending`, !revokedUrls.includes(preview), { kind, order, previewReleased: revokedUrls.includes(preview), filename });
      undoButton.click();
      if (order === "read-after-undo") {
        const uploadIndex = window.__ccImageUploads.length;
        controlled.resolve();
        const result = await waitImageUpload(uploadIndex, filename);
        check(`attachment ${filename} upload completes after ${kind} Undo`, result.status === 200 && typeof result.path === "string", { kind, order, result });
      }
      const correctTab = document.querySelector('#tabs [role="tab"][aria-selected="true"]')?.dataset.tabId === "alpha-dev";
      if (!correctTab) await clickTab("Development");
      const attachmentReady = await waitAttachmentReady(filename);
      const attached = [...document.querySelectorAll("#atts .att")].filter((node) => node.textContent.includes(filename));
      const actionSent = window.__sent.slice(actionStart).some((message) => message.type === held.selector && (held.tabId ? message.tabId === held.tabId : message.projectId === held.projectId));
      const nothingLostOrDuplicated = correctTab && attachmentReady && attached.length === 1 && !actionSent;
      permutationEvidence.push({ kind, order, correctTab, attachmentReady, attachmentCount: attached.length, actionSent, filename });
      check(`attachment ${filename} survives the ${kind} Undo in ${order}`, nothingLostOrDuplicated, permutationEvidence.at(-1));
      const url = attached[0]?.querySelector("img")?.src;
      const removeAttachment = document.querySelector("#atts [data-attachment] [data-remove-attachment]");
      if (removeAttachment) removeAttachment.click();
      else if (!collectFailures) requireElement("#atts [data-attachment] [data-remove-attachment]");
      const released = Boolean(url && revokedUrls.includes(url)) && document.querySelectorAll("#atts .att").length === 0;
      check(`removed completed attachment ${filename} releases its preview`, released, { url: url ?? "missing", released: Boolean(url && revokedUrls.includes(url)), remaining: document.querySelectorAll("#atts .att").length });
    }
    const xssFilename = '<img src=x onerror="window.__ccXss()">';
    const xssAttachment = await makeControlledImage(xssFilename);
    const xssUploadIndex = window.__ccImageUploads.length;
    xssAttachment.resolve();
    const xssUpload = await waitImageUpload(xssUploadIndex, "XSS-shaped attachment filename");
    await waitAttachmentReady(xssFilename);
    const xssFilenameNode = [...document.querySelectorAll("#atts .att > span[title]")].find((node) => node.getAttribute("title") === xssFilename);
    const xssFilenameLiteral = xssFilenameNode?.textContent === xssFilename && xssFilenameNode.childElementCount === 0 && !window.__ccErrors.includes("escaped text ran as HTML");
    check("XSS-shaped attachment filenames stay visible literal text", xssUpload.status === 200 && xssFilenameLiteral, { upload: xssUpload, renderedText: xssFilenameNode?.textContent ?? "missing", childCount: xssFilenameNode?.childElementCount ?? -1, xssErrors: window.__ccErrors.filter((error) => error.includes("escaped text")) });
    xssFilenameNode?.closest(".att")?.querySelector("[data-remove-attachment]")?.click();

    const releasedRead = await makeControlledImage("released-before-post.png");
    const uploadCountBeforeRelease = window.__ccImageUploads.length;
    const releasedAttachment = [...document.querySelectorAll("#atts .att")].find((node) => node.textContent.includes("released-before-post.png"));
    requireElement("[data-remove-attachment]", releasedAttachment).click();
    releasedRead.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("released attachments stop before POST when their file read finishes", window.__ccImageUploads.length === uploadCountBeforeRelease, { uploadsBefore: uploadCountBeforeRelease, uploadsAfter: window.__ccImageUploads.length, releasedPreview: revokedUrls.includes(releasedAttachment?.querySelector("img")?.src ?? "") });

    await clickTab("Development");
    showChat();
    const controlledSend = await makeControlledImage("sent-with-chat.png");
    const loadingShown = $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden;
    const chatCountBeforeFirstSend = window.__sent.filter((message) => message.type === "chat").length;
    const firstSendCompletionStart = window.__received.length;
    if (audit.mode === "fake") window.__ccChatMode = "hold";
    $("ci").value = "Send with an image"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const chatCountAfterClickAndEnter = window.__sent.filter((message) => message.type === "chat").length;
    const sendWaitsForImage = $("sendBtn").disabled && chatCountAfterClickAndEnter === chatCountBeforeFirstSend;
    check("chat waits for an in-flight image read before sending", sendWaitsForImage, { sendButtonDisabled: $("sendBtn").disabled, chatCountBeforeFirstSend, chatCountAfterClickAndEnter, loadingShown });
    const sendPreview = [...document.querySelectorAll("#atts .att img")].find((image) => image.closest(".att")?.textContent.includes("sent-with-chat.png"))?.src ?? "";
    const firstUploadIndex = window.__ccImageUploads.length;
    controlledSend.resolve();
    const sendUpload = await waitImageUpload(firstUploadIndex, "sent-with-chat.png");
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-dev" && message.text === "Send with an image"), "chat request with image");
    const imageChat = window.__sent.filter((message) => message.type === "chat" && message.text === "Send with an image").at(-1);
    const chatCountForFirstText = window.__sent.filter((message) => message.type === "chat" && message.text === "Send with an image").length;
    const imagePathSent = Array.isArray(imageChat?.images) && imageChat.images.length === 1 && imageChat.images[0] === sendUpload.path;
    const requestIdSafe = typeof imageChat?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(imageChat.requestId);
    const pendingComposerUnchanged = $("ci").value === "Send with an image" && $("ci").readOnly && $("attachBtn").disabled && $("sendBtn").disabled && Boolean(document.querySelector("#atts [data-remove-attachment]:disabled")) && Boolean(sendPreview && !revokedUrls.includes(sendPreview));
    check("client send guard covers click and Enter", sendWaitsForImage && chatCountAfterClickAndEnter === chatCountBeforeFirstSend && chatCountForFirstText === 1, { chatCountBeforeFirstSend, chatCountAfterClickAndEnter, chatCountForFirstText, sendButtonDisabled: $("sendBtn").disabled });
    check("pending send keeps text and attachments read-only until its request is answered", pendingComposerUnchanged && imagePathSent && requestIdSafe, { pendingComposerUnchanged, requestId: imageChat?.requestId, requestIdSafe, draft: $("ci").value, readOnly: $("ci").readOnly, attachDisabled: $("attachBtn").disabled, imageNames: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
    if (audit.mode === "fake") {
      window.__ccChatMode = null;
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 30, role: "user", text: "Send with an image", requestId: "other-window-request", images: imageChat?.images ?? [], at: Date.now() });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", revision: 31, role: "user", text: "Send with an image", images: imageChat?.images ?? [], at: Date.now() });
      const unrelatedEchoKeptPending = $("ci").value === "Send with an image" && $("ci").readOnly && $("sendBtn").disabled && attachmentNames().includes("sent-with-chat.png") && !revokedUrls.includes(sendPreview);
      check("chatMessage from another or legacy window cannot settle an identical draft", unrelatedEchoKeptPending, { unrelatedEchoKeptPending, draft: $("ci").value, readOnly: $("ci").readOnly, sendDisabled: $("sendBtn").disabled, attachments: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
      window.__ccDeliver({ type: "error", action: "chat", tabId: "alpha-dev", requestId: "another-send-id", message: "not this request" });
      const unrelatedErrorKeptPending = $("ci").value === "Send with an image" && $("ci").readOnly && $("sendBtn").disabled && attachmentNames().includes("sent-with-chat.png");
      check("chat error with another request id cannot settle this send", unrelatedErrorKeptPending, { unrelatedErrorKeptPending, draft: $("ci").value, readOnly: $("ci").readOnly, sendDisabled: $("sendBtn").disabled, attachments: attachmentNames() });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "user", text: "Send with an image", images: imageChat?.images ?? [], requestId: imageChat?.requestId, at: Date.now(), revision: 100 });
      const acceptedComposerCleared = $("ci").value === "" && !$("ci").readOnly && attachmentNames().length === 0 && Boolean(sendPreview && revokedUrls.includes(sendPreview));
      check("chatMessage with my request id accepts and consumes only that composer snapshot", acceptedComposerCleared, { acceptedComposerCleared, draft: $("ci").value, readOnly: $("ci").readOnly, attachments: attachmentNames(), previewReleased: revokedUrls.includes(sendPreview) });
      const activeCopy = structuredClone(window.__ccSeed);
      activeCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").derived.leaderTurnActive = true;
      window.__ccSeed = activeCopy; window.__ccDeliver({ ...activeCopy, type: "state" });
      window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: "The lead is answering." });
      window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "The lead replied.", revision: 101, at: Date.now() });
      window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 101, savedRevision: 1 });
      const idleCopy = structuredClone(window.__ccSeed);
      idleCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev").derived.leaderTurnActive = false;
      window.__ccSeed = idleCopy; window.__ccDeliver({ ...idleCopy, type: "state" });
    }
    check("chat sends the uploaded image path for the selected tab", imagePathSent && imageChat?.tabId === "alpha-dev", { imageChat, uploadedPath: sendUpload.path });
    if (!collectFailures || imagePathSent) {
      try { await waitFor(() => Boolean(document.querySelector('#view [data-message-id="100"] .files img.thumb')), "rendered transcript thumbnail", collectWaitTimeout); }
      catch (error) { if (!collectFailures) throw error; }
    }
    const userMessage = document.querySelector('#view [data-message-id="100"]');
    const thumbnail = userMessage?.querySelector(".files img.thumb");
    const imageFileChip = userMessage?.querySelector(".files .file");
    const expectedImageName = String(imageChat?.images?.[0] ?? "").split(/[\\/]/).at(-1) ?? "";
    const imageChipShowsName = Boolean(imageFileChip && expectedImageName && imageFileChip.textContent.trim() === expectedImageName);
    const thumbnailHasNoNewWindowLink = Boolean(thumbnail && !thumbnail.closest("a"));
    const imageResponse = thumbnail ? await fetch(thumbnail.src).then((response) => ({ status: response.status, type: response.headers.get("content-type") })) : { status: 0, type: "missing" };
    const userRight = Boolean(userMessage?.classList.contains("mine") && userMessage.querySelector(".uav"));
    check("chat image thumbnails include the sent filename as a file chip", imageChipShowsName && thumbnailHasNoNewWindowLink, { expectedImageName, renderedFileText: imageFileChip?.textContent.trim() ?? "missing", thumbnailHasNoNewWindowLink });
    const imageSentAndRendered = imagePathSent && Boolean(thumbnail) && thumbnail.src.includes(encodeURIComponent(imageChat.images[0])) && imageResponse.status === 200 && userRight && imageChipShowsName && thumbnailHasNoNewWindowLink;
    const previewReleasedAfterSend = Boolean(sendPreview && revokedUrls.includes(sendPreview));
    check("chat waits for image upload, sends its server path, renders the right-side thumbnail, and releases the preview", loadingShown && sendWaitsForImage && sendUpload.status === 200 && imageSentAndRendered && previewReleasedAfterSend, { loadingShown, sendWaitsForImage, sendUpload, imageChat, thumbnail: thumbnail?.src ?? "missing", imageResponse, userRight, previewReleasedAfterSend });
    await waitFor(() => window.__received.slice(firstSendCompletionStart).some((message) => message.type === "chatDone" && message.tabId === "alpha-dev"), "first send completion");
    const completedSendStatusCleared = $("chatStatus").hidden && $("sendBtn").disabled && $("ci").value === "";
    check("completed leader turn clears progress and keeps the empty composer disabled", completedSendStatusCleared, { statusHidden: $("chatStatus").hidden, sendDisabled: $("sendBtn").disabled, draft: $("ci").value });
    const completedAssistantEvent = window.__received.find((message) => message.type === "chatMessage" && message.role === "assistant" && message.revision === 101);
    const assistantPortrait = document.querySelector('#view [data-message-id="101"] > img');
    const leaderPortrait = document.querySelector('#crew [data-seat-id="leader"] .av img');
    const assistantAvatar = Boolean(assistantPortrait && leaderPortrait && assistantPortrait.getAttribute("src") === leaderPortrait.getAttribute("src"));
    // The server stamps every message with `at` (epoch ms) and nothing else about time: the label is that clock time. 09:05 on a fixed day, so the digits are known.
    const stampedAt = new Date(2026, 0, 2, 9, 5, 0).getTime();
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "assistant", text: "Stamped by the server", at: stampedAt, revision: 12 });
    window.__ccDeliver({ type: "chatMessage", tabId: "alpha-dev", role: "user", text: "Stamped by me", at: stampedAt + 60_000, revision: 13 });
    const assistantTime = text('#view [data-message-id="12"] .meta');
    const userTime = text('#view [data-message-id="13"] .meta');
    const timeFromAt = /09:05$/.test(assistantTime) && /^09:06\s/.test(userTime);
    check("assistant messages use the lead portrait, and every message's time label is the clock time of its `at`", Boolean(completedAssistantEvent) && assistantAvatar && timeFromAt, { completedAssistantEvent, assistantAvatar, assistantPortrait: assistantPortrait?.getAttribute("src") ?? "missing", expectedLeaderPortrait: leaderPortrait?.getAttribute("src") ?? "missing", assistantTime, userTime, selectedTabId: window.__latestState.selectedTabId, viewTabId: $("view").dataset.tabId });
    const secondSendAttachment = await makeControlledImage("second-send-only.png");
    const secondUploadIndex = window.__ccImageUploads.length;
    secondSendAttachment.resolve();
    const secondUpload = await waitImageUpload(secondUploadIndex, "second send image");
    await waitAttachmentReady("second-send-only.png");
    const secondSendStart = window.__received.length;
    $("ci").value = "Send completed later attachment"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.text === "Send completed later attachment"), "second send consumes the remaining attachment");
    const secondChat = window.__sent.filter((message) => message.type === "chat" && message.text === "Send completed later attachment").at(-1);
    const consumesOnlyOwnAttachment = secondChat?.images?.length === 1 && secondChat.images[0] === secondUpload.path && document.querySelectorAll("#atts .att").length === 0;
    check("chat consumes only the attachments in its send snapshot", consumesOnlyOwnAttachment, { secondChat, expectedPath: secondUpload.path, remainingAttachments: document.querySelectorAll("#atts .att").length });
    await waitFor(() => window.__received.slice(secondSendStart).some((message) => message.type === "chatDone" && message.tabId === "alpha-dev"), "second send leader completion");

    const disconnectedRead = await makeControlledImage("disconnected-send.png");
    const disconnectedUploadIndex = window.__ccImageUploads.length;
    disconnectedRead.resolve();
    const disconnectedUpload = await waitImageUpload(disconnectedUploadIndex, "disconnected draft attachment");
    await waitAttachmentReady("disconnected-send.png");
    const chatCountBeforeDisconnect = window.__sent.filter((message) => message.type === "chat").length;
    const currentSocket = window.__socket; currentSocket.readyState = 3;
    $("ci").value = "Keep this draft while disconnected"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => !$('sendBtn').disabled, "disconnected send rejection");
    const disconnectedToastVisible = await waitToastVisible();
    const disconnectedRetained = $("ci").value === "Keep this draft while disconnected" && [...document.querySelectorAll("#atts .att")].some((node) => node.textContent.includes("disconnected-send.png")) && window.__sent.filter((message) => message.type === "chat").length === chatCountBeforeDisconnect && disconnectedUpload.status === 200;
    currentSocket.readyState = 1; currentSocket.emit("open", {});
    check("disconnected sends keep draft and attachments", disconnectedRetained && disconnectedToastVisible, { disconnectedRetained, disconnectedToastVisible, draft: $("ci").value, upload: disconnectedUpload, chatCountBeforeDisconnect, chatCountAfter: window.__sent.filter((message) => message.type === "chat").length });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    $("ci").value = "";
    Object.assign(ctx, { actionFor });
  };
  Object.assign(window.__ccHarness, { b2UndoRacesAndSends });
})();
