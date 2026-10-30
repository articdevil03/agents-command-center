(() => {
  const { collectFailures, collectWaitTimeout, check, waitFor, $, waitToastVisible, latestTab, clickTab, showChat } = window.__ccHarness;
  // Attachment kit hooks, held leader turn, chatNotice during a live reply, background completion, image-only send.
  const b2AttachmentsAndReplies = async (ctx) => {
    const { uploadBytes } = ctx;
    showChat();
    const nativeArrayBuffer = Blob.prototype.arrayBuffer;
    const pendingReads = []; const imageBytes = new WeakMap(); const revokedUrls = [];
    const nativeFetch = window.fetch.bind(window); window.__ccImageUploads = [];
    window.fetch = (input, init) => {
      const request = nativeFetch(input, init);
      if (new URL(typeof input === "string" ? input : input.url, location.href).pathname === "/api/paste-image" && init?.method === "POST") {
        window.__ccImageUploads.push(request.then(async (response) => ({ status: response.status, path: (await response.clone().json()).path })).catch((error) => ({ error: String(error) })));
      }
      return request;
    };
    Blob.prototype.arrayBuffer = function () { return new Promise((resolve) => pendingReads.push({ file: this, resolve })); };
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revokedUrls.push(url); nativeRevoke(url); };
    const makeControlledImage = async (name) => {
      const file = new File([uploadBytes], name, { type: "image/png" });
      imageBytes.set(file, await nativeArrayBuffer.call(file));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => file }] } });
      $("ci").dispatchEvent(event);
      await waitFor(() => pendingReads.some((item) => item.file === file), `read start for ${name}`);
      return { file, read: pendingReads.find((item) => item.file === file), resolve() { const index = pendingReads.indexOf(this.read); if (index >= 0) pendingReads.splice(index, 1); this.read.resolve(imageBytes.get(file)); } };
    };
    const waitAttachmentReady = async (name) => {
      try {
        await waitFor(() => {
          const item = [...document.querySelectorAll("#atts .att")].find((node) => node.textContent.includes(name));
          return item && !item.querySelector("small");
        }, `uploaded attachment ${name}`, collectWaitTimeout);
        return true;
      } catch (error) {
        if (!collectFailures) throw error;
        return false;
      }
    };
    const waitImageUpload = async (index, name) => {
      try {
        await waitFor(() => window.__ccImageUploads.length > index, `image upload response for ${name}`, collectWaitTimeout);
        return await window.__ccImageUploads[index];
      } catch (error) {
        if (!collectFailures) throw error;
        return { error: String(error) };
      }
    };
    const attachmentNames = () => [...document.querySelectorAll("#atts .att")].map((node) => node.querySelector("span[title]")?.getAttribute("title"));
    const chatCountBeforeHeldTurn = window.__sent.filter((message) => message.type === "chat").length;
    window.__ccHoldChatDone = true;
    $("ci").value = "Hold this leader turn"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "held leader turn");
    const activeTurnImage = await makeControlledImage("active-turn.png");
    const activeTurnUploadIndex = window.__ccImageUploads.length;
    activeTurnImage.resolve();
    const activeTurnUpload = await waitImageUpload(activeTurnUploadIndex, "active-turn.png");
    await waitAttachmentReady("active-turn.png");
    $("ci").value = "Preserve this second draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const chatCountDuringHeldTurn = window.__sent.filter((message) => message.type === "chat").length;
    // Pack 12: while the leader replies Send queues the message (nothing is sent); the draft and its image move into the queue, the box is free again.
    const activeTurnButtonQueues = !$("sendBtn").disabled && $("sendBtn").getAttribute("aria-label") === "Queue message";
    $("sendBtn").click();
    await waitFor(() => document.querySelectorAll("#queue .qitem").length === 1, "the second draft is queued");
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const secondDraftAndImageQueued = $("ci").value === "" && attachmentNames().length === 0 && document.querySelectorAll("#queue .qitem").length === 1 && document.querySelector("#queue .qtext")?.textContent.includes("Preserve this second draft") && document.querySelector("#queue .qtext small")?.textContent === "active-turn.png";
    const activeTurnBlocked = chatCountDuringHeldTurn === chatCountBeforeHeldTurn + 1 && window.__sent.filter((message) => message.type === "chat").length === chatCountDuringHeldTurn && activeTurnButtonQueues && secondDraftAndImageQueued;
    check("active leader turn queues click and Enter without sending, and the next draft and image move into the queue", activeTurnBlocked, { chatCountBeforeHeldTurn, chatCountDuringHeldTurn, chatCountAfterRetry: window.__sent.filter((message) => message.type === "chat").length, activeTurnButtonQueues, draft: $("ci").value, attachments: attachmentNames(), queue: document.querySelector("#queue")?.textContent, upload: activeTurnUpload });
    [...document.querySelectorAll("#queue [data-queue-remove]")].forEach((button) => button.click()); // the queued message is not sent when the held turn ends
    window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));

    // (Returning to a tab reloads its history and drops its stream by design, so the background case holds that history back and reads the live stream first.)
    // A chatNotice that lands WHILE a reply is streaming (foreground tab, then a background tab) must leave the stream, the busy state, the draft and the attachment alone; only the real chatDone ends the turn.
    for (const where of ["foreground", "background"]) {
      const streamText = `Streaming through the ${where} notice`;
      const noticeText = `${where} old leader notice`;
      const streamShown = () => [...document.querySelectorAll("#view .thread .msg .body p")].some((node) => node.textContent.includes(streamText));
      window.__ccHoldChatDone = true;
      $("ci").value = `Live reply, ${where} notice`; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
      await waitFor(() => typeof window.__ccPendingChatDone === "function", `held turn for the ${where} notice`);
      window.__ccDeliver({ type: "chatDelta", tabId: "alpha-dev", text: streamText });
      const noticeImage = await makeControlledImage(`notice-${where}.png`);
      const noticeUploadIndex = window.__ccImageUploads.length;
      noticeImage.resolve();
      await waitImageUpload(noticeUploadIndex, `notice-${where}.png`);
      await waitAttachmentReady(`notice-${where}.png`);
      $("ci").value = `Draft kept through the ${where} notice`; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
      const doneBeforeNotice = window.__received.filter((message) => message.type === "chatDone").length;
      if (where === "background") await clickTab("Design");
      window.__ccDeliver({ type: "chatNotice", tabId: "alpha-dev", message: noticeText });
      await waitFor(() => $("toast").textContent.includes(noticeText), `${where} notice toast`);
      if (where === "background") { window.__ccHoldHistory = true; await clickTab("Development"); }
      const survived = {
        stream: streamShown(), pending: typeof window.__ccPendingChatDone === "function",
        busy: !$("sendBtn").disabled && $("sendBtn").getAttribute("aria-label") === "Queue message", draft: $("ci").value, attachments: attachmentNames(),
        notEnded: window.__received.filter((message) => message.type === "chatDone").length === doneBeforeNotice,
      };
      const chatsBeforeRetry = window.__sent.filter((message) => message.type === "chat").length;
      $("sendBtn").click();
      $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Send during the live reply queues the message (nothing is sent); the queued one is removed again so the held turn's end sends nothing.
      survived.sendBlocked = window.__sent.filter((message) => message.type === "chat").length === chatsBeforeRetry && document.querySelectorAll("#queue .qitem").length === 1;
      [...document.querySelectorAll("#queue [data-queue-remove]")].forEach((button) => button.click());
      if (where === "background") {
        // Let the held history through, as a real return would.
        const held = window.__ccHeldHistory; window.__ccHoldHistory = false; window.__ccHeldHistory = null;
        if (held) window.__socket.sendMessage({ type: "chatHistory", ...held });
      }
      check(`a ${where} chatNotice during a live reply keeps the stream, the pending turn, the draft and the attachment`, survived.stream && survived.pending && survived.busy && survived.sendBlocked && survived.draft === `Draft kept through the ${where} notice` && survived.attachments.includes(`notice-${where}.png`) && survived.notEnded, survived);
      window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null; window.__ccHoldChatDone = false;
      await waitFor(() => window.__received.filter((message) => message.type === "chatDone").length > doneBeforeNotice && !streamShown(), `${where} turn ends on its own chatDone`);
      [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
      $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    }

    window.__ccHoldChatDone = true;
    $("ci").value = "Complete this in the background"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    await waitFor(() => typeof window.__ccPendingChatDone === "function", "background leader turn");
    await clickTab("Design");
    const foregroundImage = await makeControlledImage("foreground-upload.png");
    const foregroundUploadIndex = window.__ccImageUploads.length;
    $("ci").value = "Foreground upload draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true })); $("sendBtn").click();
    const foregroundStatusBeforeCompletion = $("chatStatus").textContent;
    window.__ccPendingChatDone?.(); window.__ccPendingChatDone = null;
    const foregroundStatusAfterCompletion = $("chatStatus").textContent;
    window.__ccDeliver({ type: "chatError", tabId: "alpha-dev", message: "background tab failed" });
    await waitToastVisible();
    const backgroundErrorNamesTab = $("toast").textContent.includes(latestTab("alpha-dev").name + ": background tab failed");
    const foregroundStatusAfterError = $("chatStatus").textContent;
    const backgroundStatusIsolated = foregroundStatusBeforeCompletion === "Loading file" && foregroundStatusAfterCompletion === "Loading file" && foregroundStatusAfterError === "Loading file" && !$("chatStatus").hidden && backgroundErrorNamesTab;
    check("background completion preserves foreground upload status and names background errors", backgroundStatusIsolated, { foregroundStatusBeforeCompletion, foregroundStatusAfterCompletion, foregroundStatusAfterError, backgroundErrorNamesTab, toast: $("toast").textContent, visibleTab: window.__latestState.selectedTabId });
    // A chat notice is about an old leader process: it shows its text and never ends, clears or fails the turn that is running.
    window.__ccDeliver({ type: "chatNotice", tabId: "alpha-dev", message: "old leader notice" });
    await waitFor(() => $("toast").textContent.includes(latestTab("alpha-dev").name + ": old leader notice"), "chat notice toast");
    check("a chat notice shows its text and leaves the foreground turn's status alone", $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden, { status: $("chatStatus").textContent, toast: $("toast").textContent });
    window.__ccHoldChatDone = false;
    foregroundImage.resolve();
    const foregroundUpload = await waitImageUpload(foregroundUploadIndex, "foreground-upload.png");
    await waitFor(() => window.__sent.some((message) => message.type === "chat" && message.tabId === "alpha-design" && message.text === "Foreground upload draft"), "foreground upload send");
    await waitFor(() => window.__received.some((message) => message.type === "chatDone" && message.tabId === "alpha-design"), "foreground upload chat completion");

    await clickTab("Development");
    $("ci").value = ""; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const imageOnly = await makeControlledImage("image-only.png");
    const imageOnlyCount = window.__sent.filter((message) => message.type === "chat").length;
    const imageOnlyDisabledBeforeSend = $("sendBtn").disabled;
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const imageOnlyUploadIndex = window.__ccImageUploads.length;
    imageOnly.resolve();
    const imageOnlyUpload = await waitImageUpload(imageOnlyUploadIndex, "image-only.png");
    await waitFor(() => attachmentNames().includes("image-only.png") || window.__sent.filter((message) => message.type === "chat").length > imageOnlyCount, "image-only attachment stays queued or is sent unexpectedly");
    $("sendBtn").click();
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const imageOnlyRetained = window.__sent.filter((message) => message.type === "chat").length === imageOnlyCount && $("ci").value === "" && attachmentNames().includes("image-only.png") && $("sendBtn").disabled;
    check("image-only composer stays disabled and retains its image", imageOnlyRetained && imageOnlyDisabledBeforeSend, { imageOnlyRetained, disabledBeforeSend: imageOnlyDisabledBeforeSend, draft: $("ci").value, attachments: attachmentNames(), chatCountBefore: imageOnlyCount, chatCountAfter: window.__sent.filter((message) => message.type === "chat").length, upload: imageOnlyUpload });
    [...document.querySelectorAll("#atts [data-remove-attachment]")].forEach((button) => button.click());
    Object.assign(ctx, { revokedUrls, makeControlledImage, waitAttachmentReady, waitImageUpload, attachmentNames, nativeArrayBuffer, pendingReads });
  };
  Object.assign(window.__ccHarness, { b2AttachmentsAndReplies });
})();
