// Conversation history, streaming and clear/restore events. Shares the ordered page scope.
  "use strict";
  function onChatEvent(message) {
    if (message.type === "chatHistory") {
      transcriptRequests.delete(message.tabId);
      const messages = Array.isArray(message.messages) ? message.messages : [];
      const requestIds = new Set(messages.filter((item) => item?.role === "user").map((item) => item.requestId).filter((id) => typeof id === "string"));
      for (const request of [...chatRequestsById.values()]) {
        if (request.tabId !== message.tabId || !request.sent || !["disconnected", "abandoned"].includes(request.status)) continue;
        settleChatRequest(request, requestIds.has(request.requestId));
      }
      for (const item of [...queueFor(message.tabId)]) if (item.state === "unknown") {
        if (requestIds.has(item.requestId)) removeQueued(message.tabId, item); else { item.state = "waiting"; item.requestId = null; }
      }
      transcripts.set(message.tabId, messages);
      reconcileInterruptedReplies(message.tabId, messages);
      completeTranscripts.add(message.tabId);
      chatInfo(message.tabId, message);
      renderStage();
      for (const tabId of [...flushArmed]) flushQueue(tabId);
      return true;
    }
    if (message.type === "chatMessage") {
      const list = transcripts.get(message.tabId) ?? [];
      // The server sends no id: a tab's revision is the unique, increasing key. No numeric revision = never dropped.
      const fresh = !Number.isFinite(message.revision) || !list.some((item) => item.revision === message.revision);
      if (!Number.isFinite(message.revision)) list.push(message);
      else if (fresh) {
        const at = list.findIndex((item) => item.revision > message.revision);
        if (at < 0) list.push(message); else list.splice(at, 0, message);
      }
      transcripts.set(message.tabId, list);
      chatInfo(message.tabId, message);
      // The reply so far was written down because a message was steered into it: the draft on screen is now that message, and the rest streams below the steer.
      if (fresh && (message.role === "assistant" || message.split)) streamingByTab.delete(message.tabId);
      if (message.role === "assistant") reconcileInterruptedReplies(message.tabId, [message]);
      if (message.role === "user") {
        const request = chatRequestsById.get(message.requestId);
        if (request?.tabId === message.tabId) settleChatRequest(request, true);
      }
      if (message.tabId === currentTab()?.id) renderStage();
      if (fresh && message.role === "assistant") markUnread(message.tabId);
      if (message.role !== "notice") recordActivity(message.role === "user" || message.type === "user" ? "You sent a message" : `${leaderName(findTab(message.tabId))} replied`, "", message.tabId);
      renderSide();
      return true;
    }
    if (message.type === "chatDelta") {
      const draft = streamingByTab.get(message.tabId) ?? "";
      streamingByTab.set(message.tabId, draft + String(message.text ?? ""));
      if (message.tabId === currentTab()?.id) streamDraftUpdate(message.tabId);
      return true;
    }
    if (message.type === "chatDone") {
      replyEnds.set(message.tabId, { kind: "done" });
      streamingByTab.delete(message.tabId); stepByTab.delete(message.tabId);
      chatInfo(message.tabId, message);
      if (message.tabId === currentTab()?.id) { updateChatLoading(message.tabId); renderStage(); }
      if (queueFor(message.tabId).length) { flushArmed.add(message.tabId); flushQueue(message.tabId); }
      notify("leader-turn", "The lead finished", "Your reply is ready.");
      recordActivity(`${leaderName(findTab(message.tabId))} finished a reply`, "done", message.tabId); renderSide();
      return true;
    }
    if (message.type === "chatNotice") {
      // A note about an old leader process: it never ends, clears or fails the turn that is running now.
      const noticeTab = findTab(message.tabId)?.name;
      showToast(message.tabId === currentTab()?.id ? String(message.message ?? "") : (noticeTab ? noticeTab + ": " : "A background tab: ") + String(message.message ?? ""));
      return true;
    }
    if (message.type === "chatError") {
      const text = streamingByTab.get(message.tabId);
      if (text) {
        const replies = interruptedReplies.get(message.tabId) ?? [];
        replies.push({ role: "assistant", text, at: Date.now(), afterRevision: Math.max(0, ...(transcripts.get(message.tabId) ?? []).map((item) => Number(item.revision) || 0)) });
        interruptedReplies.set(message.tabId, replies);
      }
      streamingByTab.delete(message.tabId); stepByTab.delete(message.tabId);
      // A stopped or failed reply: nothing queued goes out on its own now; each message waits for its own Send click.
      holdQueue(message.tabId);
      chatInfo(message.tabId, message);
      if (message.tabId === currentTab()?.id) { updateChatLoading(message.tabId); renderStage(); }
      const errorText = message.message ?? "The lead could not reply";
      const tabName = findTab(message.tabId)?.name;
      markUnread(message.tabId);
      notify("leader-turn", "The lead could not reply", errorText);
      showToast(message.tabId === currentTab()?.id ? errorText : (tabName ? tabName + ": " : "A background tab: ") + errorText);
      return true;
    }
    if (message.type === "chatCleared" || message.type === "chatRestored") {
      completeTranscripts.delete(message.tabId);
      streamingByTab.delete(message.tabId);
      interruptedReplies.delete(message.tabId);
      if (message.type === "chatCleared") { clearQueue(message.tabId); replyEnds.set(message.tabId, { kind: "cleared" }); stepByTab.delete(message.tabId); }
      transcripts.set(message.tabId, message.messages ?? []);
      chatInfo(message.tabId, message);
      if (message.type === "chatCleared" && message.noUndo) {
        const previous = clearUndos.get(message.tabId); if (previous) clearTimeout(previous.timer);
        clearUndos.delete(message.tabId);
        recordActivity("Chat cleared", "", message.tabId);
      } else if (message.type === "chatCleared") {
        const previous = clearUndos.get(message.tabId); if (previous) clearTimeout(previous.timer);
        const undo = { sent: false, timer: 0, dueAt: Date.now() + 10000 };
        undo.timer = setTimeout(() => { clearUndos.delete(message.tabId); renderUndo(); }, 10000);
        clearUndos.set(message.tabId, undo);
        recordActivity("Chat cleared", "", message.tabId);
      } else {
        const undo = clearUndos.get(message.tabId); if (undo) clearTimeout(undo.timer);
        clearUndos.delete(message.tabId);
        showToast("Chat restored");
      }
      if (message.tabId === currentTab()?.id) renderStage();
      renderUndo();
      return true;
    }
    if (message.type === "chatUndoRejected") {
      if (message.reason === "busy") {
        const held = clearUndos.get(message.tabId); if (held) held.sent = false; renderUndo();
        showToast("Undo is not possible while the leader is answering or saving; try again when it is done.");
        return true;
      }
      const undo = clearUndos.get(message.tabId); if (undo) clearTimeout(undo.timer);
      clearUndos.delete(message.tabId); renderUndo();
      showToast(message.reason === "expired" ? "Undo expired" : "This cleared chat is no longer available");
      return true;
    }
    return false;
  }
  function reconcileInterruptedReplies(tabId, messages) {
    const remaining = (interruptedReplies.get(tabId) ?? []).filter((draft) => !messages.some((message) => message.role === "assistant" && message.revision > draft.afterRevision && String(message.text ?? "").startsWith(draft.text)));
    if (remaining.length) interruptedReplies.set(tabId, remaining); else interruptedReplies.delete(tabId);
  }
