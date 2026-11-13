(() => {
  const { fail, check, waitFor, text, $, requireElement, installTenSecondClock, latestTab, clickTab, openTabMenu, clickMenuItem, showChat, openProjectMenu, settleMicrotasks, deliver, safeId } = window.__ccHarness;
  const checkUploadsAndScreenshots = async () => {
    const uploadRequests = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      const promise = nativeFetch(input, init);
      if (init.method === "POST" && ["/api/paste-file", "/api/paste-image"].includes(url.pathname)) {
        const record = { path: url.pathname, method: init.method, requestId: headers.get("X-Request-Id"), fileName: headers.get("X-File-Name"), promise: promise.then(async (response) => ({ status: response.status, value: await response.clone().json() })) };
        uploadRequests.push(record);
      }
      return promise;
    };

    showChat();
    const screenshotUploadId = "packc_screenshot";
    // This direct upload gives the key the way the app does: window.cc.appKey() (the same value the server was started with).
    const screenshotResponse = await nativeFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": "image/png", "X-Request-Id": screenshotUploadId, "X-App-Key": await window.cc.appKey() }, body: "screenshot bytes" });
    const screenshotUpload = await screenshotResponse.json();
    const screenshotState = structuredClone(window.__latestState);
    screenshotState.selectedTabId = "alpha-dev";
    window.__ccSeed = structuredClone(screenshotState); deliver(screenshotState);
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-dev", messages: [{ id: "packc-shot", role: "user", text: "Screenshot from this tab", images: [screenshotUpload.path], at: Date.now() }], revision: 1, savedRevision: 1 });
    const shotButton = requireElement("#view [data-open-shot]");
    const returnedPathExact = screenshotResponse.status === 200 && Boolean(screenshotUpload.path) && shotButton.dataset.openShot === screenshotUpload.path;
    shotButton.click();
    const screenshotViewer = requireElement('#viewer[aria-hidden="false"]');
    const viewerImage = requireElement("#viewerFiles .viewer-file img");
    const viewerPathExact = viewerImage.src.includes(encodeURIComponent(screenshotUpload.path));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const viewerClosed = $("viewer").hidden && $("viewer").getAttribute("aria-hidden") === "true";
    await clickTab("Design");
    window.__ccDeliver({ type: "chatHistory", tabId: "alpha-design", messages: [{ id: "packc-no-shot", role: "assistant", text: "No image in this tab", at: Date.now() }], revision: 1, savedRevision: 1 });
    const noShotInOtherTab = !document.querySelector("#view [data-open-shot]");
    check(`Transcript images open in the viewer with their exact returned path, close, and stay with their own tab at ${innerWidth}px`, Boolean(screenshotViewer) && returnedPathExact && viewerPathExact && viewerClosed && noShotInOtherTab, { screenshotResponse: screenshotResponse.status, screenshotPath: screenshotUpload.path, buttonPath: shotButton.dataset.openShot, viewerImage: viewerImage.src, returnedPathExact, viewerPathExact, viewerClosed, noShotInOtherTab });
    return { uploadRequests, nativeFetch };
  };
  const checkFileAttachments = async (uploadRequests) => {
    await clickTab("Development");
    showChat();
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    const heldReads = [];
    const heldBytes = new WeakMap();
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.type === "text/plain" && this.name.startsWith("packc-undo-")) return new Promise((resolve) => heldReads.push({ file: this, resolve }));
      return originalArrayBuffer.call(this);
    };
    const uploadDone = async (index, name) => {
      await waitFor(() => uploadRequests.length > index, `file upload request for ${name}`);
      const record = uploadRequests[index];
      const result = await record.promise;
      return { record, result };
    };
    const controlledFile = async (name) => {
      const file = new File([`contents for ${name}`], name, { type: "text/plain" });
      heldBytes.set(file, await originalArrayBuffer.call(file));
      const transfer = new DataTransfer(); transfer.items.add(file); $("attachInput").files = transfer.files;
      $("attachInput").dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => heldReads.some((item) => item.file === file), `pending file read for ${name}`);
      const read = heldReads.find((item) => item.file === file);
      return { file, resolve() { const index = heldReads.indexOf(read); if (index >= 0) heldReads.splice(index, 1); read.resolve(heldBytes.get(file)); } };
    };
    const startHeldAction = async (kind) => {
      if (kind === "tab") clickMenuItem(openTabMenu("alpha-dev"), "Remove tab");
      else if (kind === "project") clickMenuItem(openProjectMenu("alpha"), "Remove from Command Center");
      else fail(`unknown held action kind ${kind}`);
      await waitFor(() => document.querySelector("#undo [data-undo-held]"), `${kind} Undo action`);
    };
    const raceClock = installTenSecondClock();
    const fileRaceNames = [];
    for (const kind of ["tab", "project"]) for (const order of ["read-before-undo", "read-after-undo"]) {
      if (!latestTab("alpha-dev")) fail(`file race target alpha-dev missing before ${kind} ${order}`);
      if (window.__latestState.selectedTabId !== "alpha-dev") await clickTab("Development");
      const name = `packc-undo-${kind}-${order}.md`; const controlled = await controlledFile(name);
      const uploadIndex = uploadRequests.length; const actionStart = window.__sent.length;
      await startHeldAction(kind);
      if (order === "read-before-undo") controlled.resolve();
      const undo = requireElement("#undo [data-undo-held]"); undo.click();
      await waitFor(() => latestTab("alpha-dev") && window.__latestState.selectedTabId === "alpha-dev", `${kind} Undo restores its source tab`);
      if (order === "read-after-undo") controlled.resolve();
      const { record, result } = await uploadDone(uploadIndex, name);
      await waitFor(() => [...document.querySelectorAll("#atts [data-attachment]")].some((item) => item.textContent.includes(name) && !item.textContent.includes("Loading file")), `file attachment ready after ${kind} Undo`);
      const attachments = [...document.querySelectorAll("#atts [data-attachment]")].filter((item) => item.textContent.includes(name));
      const actionSent = window.__sent.slice(actionStart).some((item) => ["removeTab", "removeProject"].includes(item.type));
      const correctFile = record.path === "/api/paste-file" && safeId(record.requestId) && result.status === 200 && result.value.requestId === record.requestId && result.value.name === name;
      const oneReadyChip = attachments.length === 1 && attachments[0].querySelector(".file-icon")?.textContent === "md" && !attachments[0].querySelector("img") && attachments[0].textContent.includes(name);
      check(`file attachment ${name} completes in ${order} around ${kind} Undo`, correctFile && oneReadyChip && !actionSent && heldReads.every((item) => item.file !== controlled.file), { kind, order, request: { path: record.path, requestId: record.requestId, fileName: record.fileName }, response: result, correctFile, attachmentCount: attachments.length, chipText: attachments[0]?.textContent, hasFileIcon: Boolean(attachments[0]?.querySelector(".file-icon")), noEmptyImage: !attachments[0]?.querySelector("img"), actionSent, pendingRead: heldReads.some((item) => item.file === controlled.file), tabId: window.__latestState.selectedTabId });
      fileRaceNames.push(name);
      const remove = requireElement("#atts [data-remove-attachment]"); remove.click();
      const released = !document.querySelector(`#atts [data-attachment]`) && uploadRequests.length === uploadIndex + 1;
      check(`completed file attachment ${name} releases and does not duplicate`, released, { name, remaining: document.querySelectorAll("#atts [data-attachment]").length, uploadCount: uploadRequests.length - uploadIndex });
    }
    raceClock.restore(); Blob.prototype.arrayBuffer = originalArrayBuffer;

    const fileName = "chat-note.md";
    const file = new File(["Here is the note"], fileName, { type: "text/markdown" });
    const fileBytes = await originalArrayBuffer.call(file);
    let resolveChatFileRead;
    const chatFileRead = new Promise((resolve) => { resolveChatFileRead = resolve; });
    Blob.prototype.arrayBuffer = function () {
      if (this instanceof File && this.name === fileName) return chatFileRead;
      return originalArrayBuffer.call(this);
    };
    const transfer = new DataTransfer(); transfer.items.add(file); $("attachInput").files = transfer.files;
    $("attachInput").dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => [...document.querySelectorAll("#atts [data-attachment]")].some((item) => item.textContent.includes(fileName) && item.textContent.includes("Loading file")), "loading chat file chip");
    const loadingFileShown = $("chatStatus").textContent === "Loading file" && !$("chatStatus").hidden;
    $("ci").value = "Review the attached note"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const chatStart = window.__sent.length;
    const chatCountBeforeFileRead = window.__sent.filter((item) => item.type === "chat").length;
    $("sendBtn").click();
    await waitFor(() => $("sendBtn").disabled && $("chatStatus").textContent === "Loading file", "send lock while chat file is loading");
    $("ci").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settleMicrotasks();
    const chatCountWhileFileRead = window.__sent.filter((item) => item.type === "chat").length;
    const fileSendWaits = loadingFileShown && chatCountWhileFileRead === chatCountBeforeFileRead && $("sendBtn").disabled;
    check(`chat waits for an in-flight non-image file read before sending at ${innerWidth}px`, fileSendWaits, { loadingFileShown, chatCountBeforeFileRead, chatCountWhileFileRead, sendDisabled: $("sendBtn").disabled, status: $("chatStatus").textContent });
    resolveChatFileRead(fileBytes);
    Blob.prototype.arrayBuffer = originalArrayBuffer;
    await waitFor(() => uploadRequests.some((item) => item.path === "/api/paste-file" && item.fileName === encodeURIComponent(fileName)), "chat file POST");
    const sentFileRequest = uploadRequests.find((item) => item.path === "/api/paste-file" && item.fileName === encodeURIComponent(fileName));
    const sentFileUpload = await sentFileRequest.promise;
    await waitFor(() => window.__sent.slice(chatStart).some((item) => item.type === "chat" && item.text === "Review the attached note"), "chat with file attachment");
    const fileChat = window.__sent.slice(chatStart).find((item) => item.type === "chat");
    await waitFor(() => document.querySelector('#view .file-chip'), "transcript file chip");
    const fileChatGood = sentFileUpload.status === 200 && safeId(sentFileRequest.requestId) && fileChat?.tabId === "alpha-dev" && Array.isArray(fileChat.files) && fileChat.files.length === 1 && fileChat.files[0] === sentFileUpload.value.path && safeId(fileChat.requestId) && document.querySelector('#view .file-chip')?.textContent.includes(".md");
    check(`non-image attachment uploads, waits, sends files and renders a transcript chip at ${innerWidth}px`, fileChatGood, { upload: { requestId: sentFileRequest.requestId, fileName: sentFileRequest.fileName, status: sentFileUpload.status, value: sentFileUpload.value }, chat: fileChat ?? null, fileChip: document.querySelector('#view .file-chip')?.textContent ?? null, raceFiles: fileRaceNames });
  };
  Object.assign(window.__ccHarness, { checkUploadsAndScreenshots, checkFileAttachments });
})();
