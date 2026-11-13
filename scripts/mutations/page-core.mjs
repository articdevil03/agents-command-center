export const pageCoreMutations = [
  ["p26r5-archive-reply-binding", "public/fixed-crew/task-events.js", "const a = archives.get(message.tabId), read = a?.pending;\n      if (!read || read.requestId !== message.requestId || read.tabId !== message.tabId) return true;", "const a = archives.get(last?.tabId), read = a?.pending;\n      if (!read) return true;"],
  ["p26r5-archive-detail-binding", "public/fixed-crew/task-events.js", "if (!same) { read.unreadable = true; return false; }", "void same;"],
  ["p26r5-archive-first-page-error", "public/fixed-crew/task-events.js", "if (op === \"first\") a.list = { status: \"error\", error: reason };", "if (op === \"first\") a.list = { status: \"ready\", error: \"\" };"],
  ["p26r5-archive-text-data", "public/fixed-crew/task-archive-view.js", "if (text !== undefined) el.textContent = String(text);", "if (text !== undefined) el.innerHTML = String(text);"],
  ["p26r5-archive-held-notice", "public/fixed-crew/task-archive-view.js", ": listView(tab, a, f));", ": listView(tab, a, {...f, blocked:false}));"],
  ["p26r5-archive-more-cursor", "public/fixed-crew/task-events.js", "a.more = { status: \"loading\", error: \"\" }; changed(a);\n      readArchive(tab, a, \"page\", { cursor: a.nextCursor });", "a.more = { status: \"loading\", error: \"\" }; changed(a);\n      readArchive(tab, a, \"page\", { cursor: null });"],
  ["p26r5-archive-row-contract", "public/fixed-crew/task-events.js", "!validItems(message.items) ||", "false ||"],
  ["p26r1-fixed-run-ack","public/app/04-messages.js","if (message.type === \"fixedRunRequested\") {","if (message.type === \"missingRunRequested\") {"],
  ["p26r1-fixed-run-identity","public/app/04-messages.js","pendingRun && pendingRun.tabId === message.tabId && pendingRun.slot === message.slot","pendingRun"],
  ["p26r1-fixed-run-pending","public/app/04-messages.js","pendingRun = null;\n        if (runTarget?.tabId","void pendingRun;\n        if (runTarget?.tabId"],
  ["p26r1-leader-fallback","public/app/02-selectors-format.js","?? (tab?.fixedCrew ? null : tab?.crew?.[0])","?? tab?.crew?.[0]"],
  ["p26r1-no-leader-view","public/app/08-seat-view-details.js","if (tab?.fixedCrew && !seat && selectedView !== \"history\") { renderChat(tab); return; }","if (false) { renderChat(tab); return; }"],
  ["fcbui-status-blocked","public/fixed-crew/task-events.js","if (summary?.blocked) return { tone: \"bad\", text: \"Task blocked\", sub: summary.notice ?? \"Check the task notice\" };","if (false) return null;"],
  ["fcbui-task-panel-retained","public/app/08-seat-view-details.js","if (child !== taskPanel) child.remove();","child.remove();"],
  ["fcbui-lost-lock","public/fixed-crew/state.js","(!request.lost || key.endsWith(\"|bulk\"))","!request.lost"],
  ["fcbui-send","public/fixed-crew/events.js","page.send(bulkMessage);","void bulkMessage;"],
  ["fcbui-pending","public/fixed-crew/events.js","store.begin(requestId, bulkKey, \"crew\");","void requestId;"],
  ["fcbui-disabled","public/fixed-crew/events.js","if (button.disabled || store.pending(bulkKey)) return;","if (false) return;"],
  ["fcbui-confirm","public/fixed-crew/events.js","if (replacesChoices) {","if (false) {"],
  ["fcbui-result-identity","public/fixed-crew/state.js","if (bulk && (result?.action !== \"setCrewModelForAll\" || (ok ? result.tabId !== tabId : result.tabId !== undefined && result.tabId !== tabId))) return false;","if (false) return false;"],
  ["fcbui-status-selection","public/app/06a-tab-status.js","if (fixed) return fixed;","void fixed;"],
  ["fcbui-status-fresh","public/fixed-crew/task-events.js","if (!detail?.fresh) return { tone: \"work\", text: \"Reading the current task\", sub: \"Approval status is not confirmed yet\" };","if (!detail?.fresh) return null;"],
  ["fcbui-status-rough","public/fixed-crew/task-events.js","if (task.stage === \"inspected\" && !taskState.roughApproved(task)) return { tone: \"wait\", text: \"Waiting on you: look at the rough\", sub: \"Approve rough or ask for changes below\" };","if (false) return null;"],
  ["fcui-draft-setter","public/fixed-crew/state.js","drafts.set(key, text);","void text;"],
  ["fcui-preserve-dirty","public/fixed-crew/state.js","if (drafts.has(key)) return drafts.get(key);","if (false) return drafts.get(key);"],
  ["fcui-newer-text","public/fixed-crew/state.js","if (drafts.get(key) === submitted.text) drafts.delete(key);","drafts.delete(key);"],
  ["fcui-preview-identity","public/fixed-crew/state.js","if (message.draftId !== currentDraft.id || message.requestId !== currentDraft.previewRequestId) return;","if (false) return;"],
  ["fcui-extra-text","public/fixed-crew/view.js","textarea.value = extraText;","textarea.innerHTML = extraText;"],
  ["fcui-busy-send","public/fixed-crew/events.js","if (row.busy) return;","if (false) return;"],
  ["fctui-details-identity","public/fixed-crew/task-state.js","if (message.taskId !== current.taskId || message.planVersion !== current.planVersion || message.requestId !== current.requestId) return false;","if (false) return false;"],
  ["fctui-pending-setter","public/fixed-crew/task-state.js","pending.set(key, request);","void request;"],
  ["fctui-approval-call","public/fixed-crew/task-events.js","page.send(approvalMessage);","void approvalMessage;"],
  ["fctui-disabled-listener","public/fixed-crew/task-events.js","if (!canApprove(current) || pending.has(key)) return;","if (false) return;"],
  ["fctui-text-literal","public/fixed-crew/task-view.js","const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };","const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.innerHTML = String(text); return el; };"],
  ["fctui-reconnect-reread","public/fixed-crew/task-state.js","for (const detail of details.values()) detail.stale = true;",""],
  ["fctui-panel-hook","public/app/08-seat-view-details.js","    fixedCrewUi?.renderTask(tab, seat?.isLeader !== false && selectedView !== \"history\"); // a fixed tab's task panel over the leader's chat (public/fixed-crew/task-view.js)\n",""],
  ["guard-approval-settings-close-submits","public/app/05-layers-approvals.js","      if (layer.id === \"setModal\") settingsSubmits.clear();\n",""],
  ["guard-approval-settings-edit-listener","public/app/12-events-queue-init.js","    $(\"setBody\").addEventListener(\"input\", (event) => { const key = event.target.dataset?.focusKey; if (key) settingsEdits.add(key); });\n",""],
  ["guard-approval-key-release-identity","public/app/12-events-queue-init.js","      if (press?.key !== (event.code || event.key)) return;\n",""],
  ["guard-approval-rejected-press-retained","public/app/05-layers-approvals.js","    if (!tab || !approvalId || approvalAnswers.get(approvalId)?.status === \"running\"","    approvalPressId = null; approvalKeyPressId = null;\n    if (!tab || !approvalId || approvalAnswers.get(approvalId)?.status === \"running\""],
  ["guard-approval-held-key-setter","public/app/12-events-queue-init.js","document.addEventListener(\"keydown\", (event) => heldApprovalKeys.add(event.code || event.key), true);","document.addEventListener(\"keydown\", () => {}, true);"],
  ["guard-approval-held-pointer-setter","public/app/12-events-queue-init.js","document.addEventListener(\"pointerdown\", (event) => heldApprovalPointers.add(event.pointerId ?? 0), true);","document.addEventListener(\"pointerdown\", () => {}, true);"],
  ["guard-approval-settings-submit-setter","public/app/07-chat.js","    if (savedBy[key]) settingsSubmits.set(key, { requestId, fields: new Map((savedBy[key] ?? []).map((field) => [field, $(\"setBody\").querySelector(`[data-focus-key=\"${field}\"]`)?.value])) });\n",""],
  ["guard-approval-settings-submitted-comparison","public/app/11-settings-render.js","if (body.querySelector(`[data-focus-key=\"${key}\"]`)?.value === submitted.get(key)) settingsEdits.delete(key);","if (true) settingsEdits.delete(key);"],
  ["guard-approval-vault-submit-setter","public/app/07-chat.js","\"vault-save\": [\"vault-path\"], ",""],
  ["guard-approval-vault-submitted-comparison","public/app/11-settings-render.js","if (body.querySelector(`[data-focus-key=\"${key}\"]`)?.value === submitted.get(key)) settingsEdits.delete(key);","if (key === \"vault-path\" || body.querySelector(`[data-focus-key=\"${key}\"]`)?.value === submitted.get(key)) settingsEdits.delete(key);"],
  ["guard-approval-vault-forget-id","public/app/11-settings-render.js","        settingsSubmits.delete(action); }","        if (action !== \"vault-save\") settingsSubmits.delete(action); }"],
  ["guard-approval-pointer-identity","public/app/05-layers-approvals.js","    if (event.detail !== 0 && approvalPressId?.pointerId !== (event.pointerId ?? 0)) return;",""],
  ["guard-approval-pointer-up-identity","public/app/12-events-queue-init.js","if (press?.pointerId !== (event.pointerId ?? 0)) return;",""],
  ["guard-approval-pointer-setter","public/app/12-events-queue-init.js",", pointerId: event.pointerId ?? 0",""],
  ["guard-approval-vault-unchanged-input","public/app/11-settings-render.js","for (const input of body.querySelectorAll(\"input[data-focus-key]\"))","for (const input of body.querySelectorAll(\"input[data-focus-key]:not([type=hidden])\"))"],
  ["guard-approval-pointer-cleanup","public/app/12-events-queue-init.js","if (approvalPressId === press) approvalPressId = null;","approvalPressId = null;"],
  ["guard-approval-key-cleanup","public/app/12-events-queue-init.js","if (approvalKeyPressId === press) approvalKeyPressId = null;","approvalKeyPressId = null;"],
  ["guard-approval-key-activation","public/app/05-layers-approvals.js","const pressed = (event.detail === 0 ? approvalKeyPressId ?? approvalPressId ?? { id: approvalId } : approvalPressId)?.id;","const pressed = (event.detail === 0 ? { id: approvalId } : approvalPressId)?.id;"],
  ["guard-approval-first-settle","public/app/05-layers-approvals.js","if (item && item.approvalId !== lastApproval.id)","if (item && lastApproval.id && item.approvalId !== lastApproval.id && performance.now() - lastApproval.at < 1500)"],
  ["guard-approval-pointer-settled","public/app/12-events-queue-init.js","const settledApprovalId = () => performance.now() >= approvalSettleUntil ? $(\"approvalPanel\").dataset.approvalId : \"\";","const settledApprovalId = () => $(\"approvalPanel\").dataset.approvalId;"],
  ["guard-approval-key-id","public/app/12-events-queue-init.js","if (!event.repeat) approvalKeyPressId = { id: settledApprovalId(), key: event.code || event.key };","if (!event.repeat) approvalKeyPressId = null;"],
  ["guard-approval-double-click","public/app/05-layers-approvals.js","    if (event.detail > 1) { approvalClickNote = approvalId; renderToolApproval(); return; }\n","    approvalClickNote = \"\";\n"],
  ["guard-approval-focus-values","public/app/11-settings-render.js","      if (target && !target.disabled && target.type !== \"hidden\") {","      if (target && snapshot.value !== null && \"value\" in target) target.value = snapshot.value;\n      if (target && !target.disabled && target.type !== \"hidden\") {"],
  ["guard-approval-vault-render-draft","public/app/11-settings-render.js","  function updateVaultControls() {","  function updateVaultControls() {\n    settingsEdits.add(\"vault-path\");"],
  ["guard-approval-vault-close-draft","public/app/11-settings-render.js","const drafts = fresh ? new Map() : settingsDraftSnapshot(body);","const drafts = fresh ? new Map([[\"vault-path\", $(\"vaultPath\")?.value ?? \"\"]]) : settingsDraftSnapshot(body);"],
  ["guard-approval-panel-render", "public/app/05-layers-approvals.js", "panel.hidden = !item;", "panel.hidden = true;"],
  ["guard-approval-waiting-status","public/app/06-crew-rail.js","Boolean(seat && (tab?.pendingApprovals ?? []).some((item) => (item.askedBy?.slot ?? leader(tab)?.slot) === seat.slot))","false"],
  ["guard-approval-settle-start", "public/app/05-layers-approvals.js", "      approvalSettleUntil = performance.now() + APPROVAL_SETTLE_MS;\n", "      approvalSettleUntil = 0;\n"],
  ["guard-approval-settle-disabled", "public/app/05-layers-approvals.js", "const settling = performance.now() < approvalSettleUntil;", "const settling = false;"],
  ["guard-approval-press-id", "public/app/05-layers-approvals.js", "performance.now() < approvalSettleUntil || pressed !== approvalId) return;", "performance.now() < approvalSettleUntil) return;"],
  ["guard-approval-repeat-key", "public/app/12-events-queue-init.js", "if (event.repeat && (event.key === \"Enter\" || event.key === \" \")) event.preventDefault();", ""],
  ["guard-approval-sort-oldest", "public/app/05-layers-approvals.js", ".sort((a, b) => a.createdAt - b.createdAt)", ""],
  ["guard-approval-disconnect-fails-answer", "public/app/02-selectors-format.js", "      for (const answer of approvalAnswers.values()) if (answer.status === \"running\") { answer.status = \"failed\"; answer.message = \"Disconnected. Reconnect before answering.\"; }\n", ""],
  ["guard-approval-notify","public/app/02-selectors-format.js","if (!oldIds.has(item.approvalId)) notify(\"needs-user\", `${item.askedBy?.name ?? leaderName(tab)} needs your answer`,`${tab.name}: ${String(item.summary).split(\"\\n\")[0].slice(0, 200)}`);","void item;"],
  ["guard-approval-reconnect-hello","public/app/02-selectors-format.js","      send({ type: \"hello\" });\n      // A held action whose send was lost with the connection waits for the first state: it is dropped there if the server did apply it, resent if not.","      // A held action whose send was lost with the connection waits for the first state: it is dropped there if the server did apply it, resent if not."],
  ["guard-approval-status-target-found", "public/app/06a-tab-status.js", "<span class=\"pill ${esc(status.tone)}\" data-tone=\"${esc(status.tone)}\">", "<span class=\"${esc(status.tone)}\" data-tone=\"${esc(status.tone)}\">"],
  ["guard-approval-settings-drafts", "public/app/11-settings-render.js", "const drafts = fresh ? new Map() : settingsDraftSnapshot(body);", "const drafts = new Map();"],
  ["guard-approval-settings-fresh-open", "public/app/10-dialogs-seat-card.js", "    renderSettings(true);\n    openModal(\"setModal\"", "    renderSettings();\n    openModal(\"setModal\""],
  ["guard-approval-request-form-clear", "public/app/09-needs-you-stopping.js", "$(\"reqTitle\").value = \"\"; $(\"reqBody\").value = \"\";", ""],
  ["guard-approval-vault-browse-draft","public/app/11-settings-render.js","$(\"vaultPath\").value = folder; settingsEdits.add(\"vault-path\"); updateVaultControls();","$(\"vaultPath\").value = folder; updateVaultControls();"],
  ["guard-approval-vault-typed-draft","public/app/12-events-queue-init.js","    $(\"setBody\").addEventListener(\"input\", (event) => { const key = event.target.dataset?.focusKey; if (key) settingsEdits.add(key); });\n","    $(\"setBody\").addEventListener(\"input\", (event) => { const key = event.target.dataset?.focusKey; if (key && key !== \"vault-path\") settingsEdits.add(key); });\n"],
  ["guard-approval-vault-controls-after-focus","public/app/11-settings-render.js","    updateVaultControls();\n    restoreSettingsFocus(body, snapshot);","    restoreSettingsFocus(body, snapshot);\n    updateVaultControls();"],
  ["guard-approval-vault-browse-refresh","public/app/11-settings-render.js","settingsEdits.add(\"vault-path\"); updateVaultControls(); }); return; }","settingsEdits.add(\"vault-path\"); }); return; }"],
  ["guard-approval-settings-all-drafts","public/app/11-settings-render.js","if (settingsEdits.has(key))","if (true)"],
  ["guard-approval-keydown-repeat-guard", "public/app/12-events-queue-init.js", "if (!event.repeat) approvalKeyPressId = ", "approvalKeyPressId = "],
  ["guard-approval-reader-activation", "public/app/05-layers-approvals.js", "approvalKeyPressId ?? approvalPressId ?? { id: approvalId }", "approvalKeyPressId"],
  ["guard-approval-reader-pointer-press", "public/app/05-layers-approvals.js", "approvalKeyPressId ?? approvalPressId ?? { id: approvalId }", "approvalKeyPressId ?? { id: approvalId }"],
  ["guard-approval-monotonic-clock", "public/app/05-layers-approvals.js", "const APPROVAL_SETTLE_MS = 400;", "const APPROVAL_SETTLE_MS = 400; const performance = { now: () => Date.now() };"],
  ["guard-approval-vault-return-saved-edit","public/app/12-events-queue-init.js","    $(\"setBody\").addEventListener(\"input\", (event) => { const key = event.target.dataset?.focusKey; if (key) settingsEdits.add(key); });\n","    $(\"setBody\").addEventListener(\"input\", (event) => { const key = event.target.dataset?.focusKey; if (key) { if (key === \"vault-path\" && event.target.value === (serverState?.settings?.vault?.path ?? \"\")) settingsEdits.delete(key); else settingsEdits.add(key); } });\n"],
  ["guard-approval-vault-browse-current-state","public/app/11-settings-render.js","if (action === \"vault-browse\") { pickFolder((folder) => { if ($(\"setModal\").hidden) return; $(\"vaultPath\").value = folder; settingsEdits.add(\"vault-path\"); updateVaultControls(); }); return; }","if (action === \"vault-browse\") { const openedPath = serverState?.settings?.vault?.path ?? \"\"; pickFolder((folder) => { if ($(\"setModal\").hidden) return; $(\"vaultPath\").value = folder; if (folder !== openedPath) settingsEdits.add(\"vault-path\"); updateVaultControls(); }); return; }"],
  ["guard-approval-settings-browse-edit","public/app/11-settings-render.js","$(\"defaultProjectFolder\").value = folder; settingsEdits.add(\"default-folder\");","$(\"defaultProjectFolder\").value = folder;"],
  ["guard-approval-settings-fresh-edits","public/app/11-settings-render.js","    if (fresh) settingsEdits.clear();\n",""],
  ["guard-approval-settings-saved-edit-clear","public/app/11-settings-render.js","=== submitted.get(key)) settingsEdits.delete(key); });","=== submitted.get(key)) {} });"],
  ["guard-approval-settings-submits-forget","public/app/11-settings-render.js","        settingsSubmits.delete(action); }","        }"],
  ["guard-approval-pointercancel-handler","public/app/12-events-queue-init.js","      heldApprovalPointers.delete(event.pointerId ?? 0);\n      if (approvalPressId?.pointerId === (event.pointerId ?? 0)) approvalPressId = null;\n    }, true);","    }, true);"],
  ["guard-approval-pointercancel-held","public/app/12-events-queue-init.js","document.addEventListener(\"pointercancel\", (event) => {\n      heldApprovalPointers.delete(event.pointerId ?? 0);\n","document.addEventListener(\"pointercancel\", (event) => {\n"],
  ["guard-approval-pointercancel-press","public/app/12-events-queue-init.js","      if (approvalPressId?.pointerId === (event.pointerId ?? 0)) approvalPressId = null;\n    }, true);","    }, true);"],
  ["guard-approval-blur-keys","public/app/12-events-queue-init.js","      heldApprovalKeys.clear(); heldApprovalPointers.clear();\n      approvalPressId","      heldApprovalPointers.clear();\n      approvalPressId"],
  ["guard-approval-blur-pointers","public/app/12-events-queue-init.js","      heldApprovalKeys.clear(); heldApprovalPointers.clear();\n      approvalPressId","      heldApprovalKeys.clear();\n      approvalPressId"],
  ["guard-approval-blur-pointer-press","public/app/12-events-queue-init.js","      approvalPressId = null; approvalKeyPressId = null;\n    });","      approvalKeyPressId = null;\n    });"],
  ["guard-approval-blur-key-press","public/app/12-events-queue-init.js","      approvalPressId = null; approvalKeyPressId = null;\n    });","      approvalPressId = null;\n    });"],
  ["client-project-id", "public/app/12-events-queue-init.js", "const payload = { type: \"chat\", tabId, text, requestId,", "const payload = { type: \"chat\", text, requestId,"],
  ["client-project-recheck", "public/app/12-events-queue-init.js", "if (composerGeneration !== generation || pendingChatByTab.get(tabId) !== requestId) return;", "if (false) return;"],
  ["project-selector-setter", "public/app/08-seat-view-details.js", "        abandonChatOnTabSwitch(composerTabId);\n      }\n      composerTabId = tab?.id ?? null; composerGeneration++;", "      }\n      composerTabId = tab?.id ?? null;"],
  ["send-guard", "public/app/12-events-queue-init.js", "if (!tab || !inChat(tab) || savePending.has(tab.id) || chatSendLocked(tab.id)) return;", "if (!tab || !inChat(tab) || savePending.has(tab.id)) return;"],
  ["send-guard-setter", "public/app/12-events-queue-init.js", "    pendingChatByTab.set(tabId, requestId);\n    renderAttachments();\n    updateChatLoading(tabId);\n    try {", "    renderAttachments();\n    updateChatLoading(tabId);\n    try {"],
  ["attachment-consumption", "public/app/07-chat.js", "const remaining = list.filter((item) => !request.items.includes(item));", "const remaining = list;"],
  ["upload-await", "public/app/12-events-queue-init.js", "      await Promise.all(queued.map((item) => item.promise).filter(Boolean));\n", ""],
  ["upload-setter", "public/app/07-chat.js", "previewUrl: URL.createObjectURL(file), path: \"\", status: \"loading\", promise: null, released: false };\n    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);\n    item.promise = (async () => {", "previewUrl: URL.createObjectURL(file), path: \"\", status: \"loading\", promise: null, released: false };\n    const list = attachmentList(tabId); list.push(item); attachmentsByTab.set(tabId, list);\n    void (async () => {"],
  ["disconnected-send-result", "public/app/12-events-queue-init.js", "if (!send(payload)) { request.sent = false; settleChatRequest(request, false); return; }", "send(payload);"],
  ["send-open-check", "public/app/01-markdown-state.js", "if (!socket || socket.readyState !== WebSocket.OPEN) {", "if (false) {"],
  ["draft-preservation", "public/app/07-chat.js", "if ((textVersionByTab.get(request.tabId) ?? 0) === request.textVersion) {", "if (true) {"],
  ["guard-bottom-threshold", "public/app/08-seat-view-details.js", "view.scrollHeight - view.scrollTop - view.clientHeight <= 4;", "view.scrollHeight - view.scrollTop - view.clientHeight <= 299;"],
  ["guard-bottom-boundary", "public/app/07-chat.js", "live.scrollHeight - live.scrollTop - live.clientHeight <= 4;", "live.scrollHeight - live.scrollTop - live.clientHeight < 4;"],
  ["guard-sidebar-expand-write", "public/app/12-events-queue-init.js", "saveClientPref(\"crewRailOpen\", !collapsed)", "saveClientPref(\"crewRailOpen\", false)"],
  ["guard-sidebar-collapse-write", "public/app/12-events-queue-init.js", "saveClientPref(\"crewRailOpen\", !collapsed)", "saveClientPref(\"crewRailOpen\", true)"],
  ["guard-storage-read-call", "public/app/01-markdown-state.js", "railWide = pref(\"crewRailOpen\", true) !== false;", "railWide = true;"],
  ["guard-storage-write-call", "public/app/12-events-queue-init.js", "    if (!saveClientPref(\"crewRailOpen\", !collapsed)) return;\n", ""],
  ["guard-appendChatMessage-decision", "public/app/08-seat-view-details.js", "const stickToBottom = view.dataset.tabId !== tab.id || view.dataset.mode !== \"chat\" || view.scrollHeight - view.scrollTop - view.clientHeight <= 4;", "const stickToBottom = true;"],
  ["guard-appendChatMessage-assignment", "public/app/08-seat-view-details.js", "if (messages || stream) view.scrollTop = stickToBottom ? view.scrollHeight : previousScrollTop;", "if (messages || stream) view.scrollTop = view.scrollHeight;"],
  ["guard-usage-percent-clamp", "public/app/07-chat.js", "Math.max(0, Math.min(100, context / window * 100))", "Math.max(0, context / window * 100)"],
  // ---- notifications (server/stall.ts's sibling feature 1): the policy is
  // pure (test/frontend-*.test.ts), and the real event path (test/frontend-*.test.ts's
  // call-site regex, the only technique available for app.js -- no jsdom) ----
  ["guard-notify-enabled-gate", "public/app/02-selectors-format.js", "if (pref(\"notificationsEnabled\", true) && \"Notification\" in window", "if (\"Notification\" in window"],
  ["guard-notify-seat-completion", "public/app/02-selectors-format.js", "return [\"worker-finish\", \"worker-fail\", \"worker-stall\", \"needs-user\"].includes(kind);", "return [\"worker-fail\", \"worker-stall\", \"needs-user\"].includes(kind);"],
  ["guard-notify-leader-focus-gate", "public/app/02-selectors-format.js", "if (kind === \"leader-turn\") return !document.hasFocus();", "if (kind === \"leader-turn\") return true;"],
  ["guard-notify-callsite-seatstatus", "public/app/04-messages.js", "        notify(kind, `${seat.name} ${verb}`, runEndBody(tab, message));\n", ""],
  ["guard-notify-callsite-chatdone", "public/app/04-messages.js", "      notify(\"leader-turn\", \"The lead finished\", \"Your reply is ready.\");\n", ""],
  ["guard-notify-callsite-stalled", "public/app/04-messages.js", "      if (seat) notify(seat.isLeader ? \"leader-turn\" : \"worker-stall\", `${seat.name} is stalled`, \"Check the run before it can continue.\");\n", ""],
  ["guard-notifications-default-on", "public/app/02-selectors-format.js", "if (pref(\"notificationsEnabled\", true) && \"Notification\" in window", "if (pref(\"notificationsEnabled\", false) && \"Notification\" in window"],
  // ---- bell: the old icon toggles, the Notifications clamp and the click guard are gone (the top-bar WINDOW TOP BAR pack); the completion sound
  // is now its own switch, guarded by the guard-topbar-* entries at the end of this list. ----
  ["guard-notif-toggle-aria-pressed", "public/app/04-messages.js", "      $(\"setBody\").querySelectorAll(\"[data-setting]\").forEach((button) => button.setAttribute(\"aria-checked\", String(settingValue(button.dataset.setting))));\n", ""],


  // ---- P2 fix 1: the 5H countdown must stay honest without depending on
  // state traffic -- ticked independently, and stopped the moment the strip
  // is actually hidden rather than leaking a timer nobody can see. ----

  // ---- icon toggles: solid gold-on-active + CSS tooltip pack (call-site
  // wiring proven the same way as the rest of this block: source regex
  // against the real markup/CSS/app.js, the only technique for a no-jsdom
  // suite) ----
  // A later rule for the SAME selector, appended right after the real one,
  // wins the cascade by source order alone (equal specificity) -- the
  // line-start-anchored test above only proves the real rule exists, not
  // that it's the one that wins. Only the "exactly one block" count catches this.
  ["guard-notify-internal-lifecycle-gate", "public/app/04-messages.js", "if (seat && message.type !== \"runStop\") {", "if (seat) {"],
  // Guard 9 (UI): a seat's tab badge must be absent, never a fake zero, while unmeasured.
  ["guard-app-usagebadge-null", "public/app/02-selectors-format.js", "if (!usage || typeof usage !== \"object\") return null;\n    const pieces = [];", "if (!usage || typeof usage !== \"object\") return \"0 ctx\";\n    const pieces = [];"],

  // ---- final-review fixes on the live per-agent usage pack ----
  // Finding 2: three call sites the pure helpers can't see going missing --
  // proven through the real "state" message path in test/round2-*.test.ts,
  // never by calling usageBadgeText/planLimitsLabel directly.
  ["guard-planlimits-message-wiring", "public/app/04-messages.js", "      rateWindowsByRun.set(message.runId, message.windows);\n", ""],
  // ---- crew portraits: call sites, not just buildAvatarEl in isolation ----
  ["guard-avatar-portrait-decision", "public/app/02-selectors-format.js", "if (UPLOADED_PIC.test(value)) return value;", "if (value) return value;"],
  ["guard-avatar-error-fallback-wiring", "public/app/12-events-queue-init.js", "      if (image.getAttribute(\"src\") === image.dataset.fallback) { image.dataset.fellBack = \"1\"; return; }\n      image.dataset.fellBack = \"1\"; image.src = image.dataset.fallback;", "      image.dataset.fellBack = \"1\";"],
  ["guard-avatar-src", "public/app/02-selectors-format.js", "return `/avatars/${avatarKeyFor(seat)}.svg`;", "return `/avatars/${avatarKeyFor(seat)}.png`;"],
  ["guard-avatar-renderseats-call-site", "public/app/06-crew-rail.js", "aria-label=\"Open ${esc(seat.name)}'s card${railWide ? \"\" : `: ${esc(role)}, ${esc(line.text)}`}\">${seatImg(seat)}", "aria-label=\"Open ${esc(seat.name)}'s card${railWide ? \"\" : `: ${esc(role)}, ${esc(line.text)}`}\">"],
  ["guard-avatar-workerheader-call-site", "public/app/08-seat-view-details.js", "<span class=\"av big\">${seatImg(seat)}<i class=\"dot ${esc(dot)}\"></i></span><div class=\"vwho\">", "<span class=\"av big\"><i class=\"dot ${esc(dot)}\"></i></span><div class=\"vwho\">"],
  // Portrait lookup must key off the agent's own raw id, never the
  // "underground-"-prefixed seatId (see the brief: X's real portrait must be
  // reused, and the prefixed id never has a matching file on disk).
  // No "guard-avatar-underground-rail-call-site" entry: swapping this call
  // site's `buildAvatarEl(undergroundAvatarSeat(agent))` for the bare
  // `buildAvatarEl(agent)` is behaviorally equivalent, not just hard to
  // distinguish. buildAvatarEl only ever reads seat.id/seat.name/seat.color,
  // and an Underground agent object already carries its own unprefixed id,
  // name and color at the top level (see undergroundWithStatus's own
  // server-side shape) -- the exact same three values the shim recomputes.
  // There is no mutation of THIS call site that any test could ever turn
  // red. The shim's actual contract (map .id off the agent's raw id, never
  // the "underground-"-prefixed seatId) is what guard-avatar-underground-
  // shim-uses-real-id above already covers, at the one place it can fail.

  // ---- right panel: phone preview + always-open usage strip ----
  // The usage strip: leader-only context (never an aggregate), and the
  // 5-hour/7-day plan windows with a real reset duration on the 5-hour one.
  ["guard-usagestrip-ctx-dash", "public/app/07-chat.js", "return \"not reported yet\";", "return \"0.0%\";"],
  // A reset already in the past is stale, not a real countdown -- the window
  // just hasn't refreshed yet. Removing this check would let it render a
  // negative/zero duration as though it were real.
  // Hours/minutes split -- mutating the divisor would print the wrong unit
  // entirely (e.g. minutes where the label says hours).

  // Item 1: the leader has no worker tab, so it's the one seat that would
  // otherwise never get the badge every worker's tab shows -- the call site
  // that routes it there, and the function that builds it, both need a live guard.

  // renderUsagePanel rebuilds this strip's content on every state broadcast
  // (a longer/shorter reset string can change the rendered height), so it
  // must recompute the preview's scale itself rather than relying only on
  // the resize handle's own drag/keyboard/load call sites.
  // Guard 3: a blank/junk preview URL must never reach the iframe.
  //
  // No "guard-preview-url-blank-check" entry: removing the `value.trim() === ""`
  // half of the type/blank check is behaviorally equivalent to the code as
  // written, not just hard to distinguish. new URL("") and new URL("   ")
  // both throw on their own (verified directly against Node's real URL
  // parser), caught by the surrounding try/catch below, so the explicit
  // blank check can never be the deciding line for any input -- there is no
  // mutation of it that this sweep, or any other, could ever turn red. The
  // URL parser strips ASCII whitespace, but not non-breaking spaces. The
  // trim inside new URL is behaviorally significant and guarded below.
  ["guard-client-pref-reconciliation-call", "public/app/04-messages.js", "      applyServerLooks();\n      rebaseRunOutput(message);", "      rebaseRunOutput(message);"],
  ["guard-client-pref-send-call", "public/app/01-markdown-state.js", "const sent = send({ type: \"updateClientPref\", key, value });", "const sent = true;"],
  // Guard 4: right panel collapse persistence, same shape as the sidebar's.
  ["guard-rightpanel-collapsed-write", "public/app/09-needs-you-stopping.js", "if (!saveClientPref(\"detailsOpen\", open)) return;", "if (!saveClientPref(\"detailsOpen\", true)) return;"],

  // ---- right panel fills its height (no dead space under a collapsed usage
  // row), and a draggable, clamped, persisted width ----

  // Guard 4 (scale-to-fit preview, never cropped): the iframe keeps a fixed
  // logical phone size and gets transform-scaled to fit, rather than a
  // responsive width that lets a real app reflow/crop at whatever narrow
  // width the panel happens to be. See computePreviewScale/updatePreviewScale.

  // Pure: picking the LARGER ratio (instead of the smaller) is exactly the
  // crop this whole pack exists to fix -- one axis would overflow to fill
  // the other.
  // Never upscale past 1:1 -- a panel bigger than the phone must not blur a
  // small phone to fill a huge one.
  // A wrap that hasn't been laid out yet (zero/negative size) must fall back
  // to 1, not Infinity/NaN, which would produce a broken CSS transform.
  // The recompute must actually write the transform, not just compute a
  // number nobody applies.
  // Dropping just the centering half (scale alone survives) moves the
  // preview off-centre and clips it -- the exact defect the whole-transform
  // assertion in round2-*.test.ts's transformScale exists to catch.
  // Call-site guards: resize/drag/keyboard/load all route through
  // applyRightPanelWidth, the right panel's own collapse/expand transition
  // settles through its transitionend listener, and the usage strip's own
  // resize handle routes through applyUsageStripHeight.
  // Guard 5 (usage strip): the new handle's own apply function must recompute
  // the preview scale through the same path applyRightPanelWidth uses, not a
  // second definition of its own.
  ["guard-rightpanel-width-write", "public/app/09-needs-you-stopping.js", "    if (send({ type: \"updateClientPref\", key: \"rightPanelWidth\", value })) clientPrefOverrides.set(\"rightPanelWidth\", value);\n", ""],
  // Guard (call site): every caller of applyRightPanelWidth must route
  // through clampRightPanelWidth -- deleting this line is the one edit that
  // would let a stored or dragged 99999 reach the DOM unclamped.
  ["guard-rightpanel-width-load-callsite", "public/app/09-needs-you-stopping.js", "Number(pref(\"rightPanelWidth\", 320)) ?? 320))); }", "320))); }"],

  // Guard 4 (usage strip): a stored or dragged 99999/-1/NaN must never reach
  // the DOM unclamped, on load exactly as much as on drag.
  // Every caller (load, drag, keyboard, client-prefs sync) routes through
  // applyUsageStripHeight, which must itself route through the clamp -- the
  // one edit that would let a stored or dragged junk value reach the DOM.
  // client-prefs sync must also route through the same apply function, not
  // assign the raw synced value directly.
  ["guard-launch-notice-client-replay", "public/app/04-messages.js", "      addStateNotices(message);\n", ""],
  ["guard-release-crew-control", "public/app/09-needs-you-stopping.js", "    root.querySelectorAll(\"[data-release]\").forEach((button) => button.addEventListener(\"click\", () => {", "    root.querySelectorAll(\"[data-release-disabled]\").forEach((button) => button.addEventListener(\"click\", () => {"],
  ["guard-packc-settings-request-id", "public/app/07-chat.js", 'if (!send({ ...payload, requestId })) return null;', 'if (!send({ ...payload })) return null;'],
  ["guard-packc-install-confirm", "public/app/11-settings-render.js", 'payload = { type: "installCli", cli, confirm: true };', 'payload = { type: "installCli", cli };'],
  ["guard-packc-permission-tab", "public/app/09-needs-you-stopping.js", 'tabId: tab.id, mode: next, requestId, ...(next === "bypass" ? { confirm: true } : {})', 'tabId: serverState?.projects?.flatMap((project) => project.tabs).find((candidate) => candidate.id !== tab.id)?.id ?? tab.id, mode: next, requestId, ...(next === "bypass" ? { confirm: true } : {})'],
  ["guard-packc-request-badge-tab", "public/app/09-needs-you-stopping.js", 'const tab = currentTab(); const count = tab ? Number(serverState?.pendingRequestCounts?.[tab.id] ?? tab.pendingRequestCount ?? 0) : 0;', 'const tab = currentTab(); const wrongTabId = tab && allTabs().find(({ tab: candidate }) => candidate.id !== tab.id)?.tab.id; const count = tab ? Number(serverState?.pendingRequestCounts?.[wrongTabId] ?? 0) : 0;'],
  ["guard-packc-look-permission-order", "public/app/08-seat-view-details.js", '    renderPermissionButton(tab);\n    const nextHistoryKey =', '    renderPermissionButton(tab);\n    if (tab?.changes?.repo) $("ctools").prepend($("permBtn"));\n    const nextHistoryKey ='],
  ["guard-packc-look-tool-action-column", "public/app/11-settings-render.js", '${copy}</div><div class="tool-row-action" data-tool-row-action>${connected}${install}', '${copy}${install}</div><div class="tool-row-action" data-tool-row-action>${connected}'],
  ["guard-packc-look-changes-rows", "public/app/08a-sidebar-details.js", 'if (lowerSection === "changes") renderChanges();', 'if (lowerSection === "changes") { if (currentTab()?.changes?.repo) renderNotes(); else renderChanges(); }'],
  ["guard-dialog-close-focus", "public/app/05-layers-approvals.js", 'if (modal) layer.focus({ preventScroll: true });\n      else first?.focus();', 'first?.focus();'],
  ["guard-dialog-close-inset", "public/styles/01-base-bar-rail.css", '--dialog-close-inset:20px;', '--dialog-close-inset:0px;'],
  ["guard-overlap-close-centre", "public/styles/03-popovers-settings.css", '.setm>.dialog-close{grid-column:2;grid-row:1;justify-self:end;margin:8px var(--dialog-close-inset) 16px 0}', '.setm>.dialog-close{grid-column:2;grid-row:1;justify-self:end;margin:var(--dialog-close-inset) var(--dialog-close-inset) 16px 0}'],
  ["guard-overlap-settings-x-header", "public/styles/03-popovers-settings.css", '.setm>.dialog-close{grid-column:2;grid-row:1;justify-self:end;margin:8px var(--dialog-close-inset) 16px 0}', '.setm>.dialog-close{position:absolute;top:var(--dialog-close-inset);right:var(--dialog-close-inset);z-index:3}'],
  ["guard-overlap-field-track", "public/styles/03-popovers-settings.css", '.field{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0}', '.field{display:grid;gap:6px;min-width:0}'],
  // The simple-look rail has no header grid track: each rail line clips its own long text (removing the .fx track and min-width stays green), so the guard sits on the seat name's clip.
  ["guard-overlap-railhead-track", "public/styles/01-base-bar-rail.css", '.fx .fn{font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}', '.fx .fn{font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;text-overflow:ellipsis}'],
  ["guard-overlap-safety-ellipsis", "public/styles/03-popovers-settings.css", '.ncard>small{color:var(--text-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}', '.ncard>small{color:var(--text-3);font-size:12px;white-space:nowrap;overflow:hidden}'],
  ["guard-packc-r7-uploaded-seat-picture", "public/app/02-selectors-format.js", '    if (UPLOADED_PIC.test(value)) return value;\n', ''],
  ["guard-packc-r7-permission-picker-outside-click", "public/app/05-layers-approvals.js", "\"seatPop\", \"permPop\", \"soundPop\"]", "\"seatPop\", \"soundPop\"]"],
  ["guard-packc-r7-terminal-results-win", "public/app/07-chat.js", '    if (finished) return finished;\n', ''],
  ["guard-packc-r7-terminal-message", "public/app/04-messages.js", '      retireAction({ requestId: message.requestId,', '      (() => {})({ requestId: message.requestId,'],
  ["guard-packc-r7-terminal-snapshot", "public/app/04-messages.js", '      for (const item of listedActions()) retireAction(item);\n', ''],
  ["guard-packc-r7-terminal-setter", "public/app/01-markdown-state.js", '        results.set(key, result);', ''],
  ["guard-packc-r7-resolved-card-not-working", "public/app/09-needs-you-stopping.js", 'const action = request.status !== "pending" && trackedAction?.status === "running" ? null : trackedAction;', 'const action = trackedAction;'],
  ["guard-packc-r7-request-send-per-tab", "public/app/09-needs-you-stopping.js", 'const pendingRequestAction = pendingRequestActions.get(tab?.id) ?? requestActionResults.get(tab?.id)?.requestId;\n    const sendAction', 'const pendingRequestAction = [...pendingRequestActions.values()].at(-1);\n    const sendAction'],
  ["guard-packc-r7-escape-request-title", "public/app/09-needs-you-stopping.js", '<b class="req-title">${plainMd(request.title)}</b>', '<b class="req-title">${request.title}</b>'],
  ["guard-packc-r7-escape-request-body", "public/app/09-needs-you-stopping.js", '<div class="req-body md">${mdHtml(request.body)}</div>', '<div class="req-body md">${request.body}</div>'],
  ["guard-packc-r7-escape-approval-summary", "public/app/09-needs-you-stopping.js", '<span class="approval-path">${esc(item.approval.summary)}</span>', '<span class="approval-path">${item.approval.summary}</span>'],
  ["guard-packc-r7-escape-changes-path", "public/app/08a-sidebar-details.js", '<span title="${esc(file.path)}">${esc(file.path)}</span>', '<span title="${esc(file.path)}">${file.path}</span>'],
  ["guard-packc-r7-escape-mcp-name", "public/app/11-settings-render.js", '<div class="sitem"><span>${esc(server.name)}</span>${canRemoveMcp', '<div class="sitem"><span>${server.name}</span>${canRemoveMcp'],
  ["guard-packc-r7-tool-version-escaped-once", "public/app/11-settings-render.js", 'const version = tool?.version ? ` · ${tool.version}` : "";', 'const version = tool?.version ? ` · ${esc(tool.version)}` : "";'],
  ["guard-packc-r7-launch-approval-title","public/app/05-layers-approvals.js","    if (tool === \"fixed-action\") return `${who} wants to start fixed work`;\n",""],
  ["guard-packc-final2-terminal-only", "public/app/01-markdown-state.js", "if (!result || ![\"done\", \"failed\", \"unknown\"].includes(result.status)) return;", "if (!result) return;"],
  ["guard-packc-final2-terminal-same-id", "public/app/01-markdown-state.js", "if (id === result.requestId) {", "if (true) {"],
  ["guard-packc-final2-removed-controls-pruned", "public/app/04-messages.js", "&& !removalKeys.has(key)) settingsActionResults.delete(key);", "&& false) settingsActionResults.delete(key);"],
  ["guard-packc-final2-removed-request-pruned", "public/app/04-messages.js", "if (key.startsWith(\"request-resolve-\") && !requestKeys.has(key)) settingsActionResults.delete(key);", "if (false) settingsActionResults.delete(key);"],
  ["guard-packc-final2-pending-retired", "public/app/01-markdown-state.js", "        pending.delete(key);", ""],
  ["guard-packc-final2-terminal-control-result", "public/app/01-markdown-state.js", "return pendingSettingsActions.get(key) ?? settingsActionResults.get(key)?.requestId;", "return pendingSettingsActions.get(key);"],
  ["guard-packc-final2-cleared-id-setter", "public/app/09-needs-you-stopping.js", "requestFormCleared.set(tab.id, pendingRequestAction);", ""],
  ["guard-packc-final2-cleared-id-bounded", "public/app/09-needs-you-stopping.js", "requestFormCleared.set(tab.id, pendingRequestAction);", "requestFormCleared.set(tab.id, pendingRequestAction); requestFormCleared.set(pendingRequestAction, pendingRequestAction);"],
  ["guard-packc-final2-cleared-tab-pruned", "public/app/04-messages.js", "if (!tabIds.has(id)) map.delete(id);", "if (false) map.delete(id);"],
  ["guard-packc-final2-seen-listed-retired", "public/app/04-messages.js", "seenListedActions.has(id) || lostActions.has(id)", "lostActions.has(id)"],
  ["guard-packc-final2-seen-listed-setter", "public/app/04-messages.js", "if (listedIds.has(id)) seenListedActions.add(id);", "if (listedIds.has(id)) {}"],
  ["guard-packc-final2-seen-listed-pruned", "public/app/04-messages.js", "if (!stillPending.has(id)) seenListedActions.delete(id);", "if (false) seenListedActions.delete(id);"],
  ["guard-packc-final2-lost-at-close", "public/app/02-selectors-format.js", "lostActions = pendingActionIds();", "lostActions = new Set();"],
  ["guard-packc-final2-unknown-terminal", "public/app/01-markdown-state.js", "[\"done\", \"failed\", \"unknown\"].includes(result.status)", "[\"done\", \"failed\"].includes(result.status)"],
  ["guard-packc-final2-late-result-replaces-unknown", "public/app/01-markdown-state.js", "old.requestId === result.requestId && old.status === \"unknown\"", "old.requestId === result.requestId && false"],
];
