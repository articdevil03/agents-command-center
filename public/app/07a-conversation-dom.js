// Conversation DOM rendering. Unchanged text nodes stay connected so browser selections survive.
  "use strict";
  function renderChat(tab) {
    const messages = transcript(tab).map((message) => renderMessage(tab, message)).join("") + (interruptedReplies.get(tab.id) ?? []).map((message) => `<div data-interrupted-reply>${renderMessage(tab, message)}<p class="faint">Interrupted reply, kept on this page.</p></div>`).join("");
    const draft = streamingByTab.get(tab.id);
    const lead = leader(tab);
    const step = `<span class="act" data-activity${stepByTab.get(tab.id) ? "" : " hidden"}>${esc(stepByTab.get(tab.id) ?? "")}</span>`;
    const stream = draft ? `<div class="msg" data-stream>${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><div class="md">${mdHtml(draft)}</div></div></div>`
      : tab.derived?.leaderTurnActive && !tab.pendingApprovals?.length ? `<div class="msg">${seatImg(lead)}<div class="body"><span class="meta"><b>${esc(lead?.name ?? "Lead")}</b>Replying${step}</span><span class="typing" role="img" aria-label="Replying"><i></i><i></i><i></i></span></div></div>` : "";
    // The server could not read this tab's saved transcript (the file is kept as it is): say why the chat is empty.
    const problem = tab.chatProblem ? `<p class="action-status" data-status="failed" role="alert" data-chat-problem>This chat could not be read (${esc(tab.chatProblem)}). Clear the chat to start a new one; the damaged file is kept as a copy.</p>` : "";
    const view = $("view");
    const taskPanel = $("fixedView"), markup = document.createElement("template");
    const previousScrollTop = view.scrollTop;
    const stickToBottom = view.dataset.tabId !== tab.id || view.dataset.mode !== "chat" || view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
    if (!lead && tab.fixedCrew) {
      markup.innerHTML = `<div class="thread" aria-label="Saved leader chat">${problem}${messages}${stream}<p class="empty-chat">Leader has no model. Choose a model for Leader in the task panel to continue.</p></div>`;
    } else if (!messages && !stream) {
      const name = lead?.name ?? "The leader";
      markup.innerHTML = `<div class="thread" aria-label="Chat with ${esc(name)}">${problem}<div class="empty empty-chat">${seatImg(lead)}<h2>${esc(name)} is ready</h2><p>Tell ${esc(name)} what you want. The crew picks it up from there, and anything that needs you shows up in Needs you at the top.</p><div class="chips">${["Where did we leave off?", "What is left?", "What should we build next?"].map((text) => `<button type="button" data-suggest>${esc(text)}</button>`).join("")}</div></div></div>`;
    } else markup.innerHTML = `<div class="thread" aria-label="Chat with ${esc(lead?.name ?? "the leader")}">${problem}${messages}${stream}</div>`;
    const thread = view.querySelector(".thread");
    if (thread && view.dataset.tabId === tab.id && view.dataset.mode === "chat") patchConversationNode(thread, markup.content.firstElementChild);
    else {
      for (const child of [...view.children]) if (child !== taskPanel) child.remove();
      view.append(markup.content);
    }
    if (!view.contains(taskPanel)) view.prepend(taskPanel);
    view.dataset.tabId = tab.id; view.dataset.mode = "chat";
    view.querySelectorAll("[data-open-shot]").forEach((button) => bindConversationEvent(button, "click", () => openScreenshotViewer(tab.id, button.dataset.openShot, button)));
    view.querySelectorAll("[data-suggest]").forEach((button) => {
      button.disabled = chatSendLocked(tab.id) || savePending.has(tab.id);
      bindConversationEvent(button, "click", () => { $("ci").value = button.textContent; draftsByTab.set(tab.id, $("ci").value); noteTextEdit(tab.id); updateChatLoading(tab.id); sendChat(); });
    });
    if (messages || stream) view.scrollTop = stickToBottom ? view.scrollHeight : previousScrollTop;
  }

  // Only the conversation subtree is patched. Keys prevent a different message/run inheriting an old node.
  function patchConversationNode(current, next) {
    if (current.isEqualNode(next)) return;
    const key = (node) => node.nodeType === 1 ? ["data-message-id", "data-output-run", "data-stream"].map((name) => node.getAttribute(name)).join("|") : "";
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || key(current) !== key(next)) { current.replaceWith(next); return; }
    if (current.nodeType !== 1) { current.nodeValue = next.nodeValue; return; }
    for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    const after = [...next.childNodes];
    for (let index = 0; index < after.length; index++) {
      const target = after[index], targetKey = key(target);
      let existing = current.childNodes[index];
      if (targetKey && targetKey !== "||" && key(existing ?? {}) !== targetKey) {
        const retained = [...current.childNodes].slice(index).find((node) => key(node) === targetKey);
        current.insertBefore(retained ?? target, existing ?? null);
        existing = current.childNodes[index];
      }
      if (!existing) current.append(target);
      else patchConversationNode(existing, target);
    }
    while (current.childNodes.length > after.length) current.lastChild.remove();
  }
  // A retained control gets the latest state closure and exactly one handler of each kind.
  function bindConversationEvent(node, type, handler) {
    if (!node) return;
    const handlers = node.conversationHandlers ??= new Map();
    if (handlers.has(type)) node.removeEventListener(type, handlers.get(type));
    handlers.set(type, handler); node.addEventListener(type, handler);
  }
  function paintRunView(view, html, sameView) {
    if (!sameView) { view.innerHTML = html; return; }
    const markup = document.createElement("template"); markup.innerHTML = html;
    const current = [...view.children].find((node) => node.id !== "fixedView");
    if (current) patchConversationNode(current, markup.content.firstElementChild);
    else view.append(markup.content);
  }

