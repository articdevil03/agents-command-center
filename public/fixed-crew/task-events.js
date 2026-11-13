// Fixed crew (Pack 26, Block 3c): what the task panel sends and what its replies change. Created once by events.js's init; `page` is the
// page's own helpers. Approvals carry exactly the task, plan, record and rough revisions the server sent and wait for their own reply:
// nothing is shown as approved before the server says so, nothing is sent again after a dropped connection, and no work starts here.
// Ask for changes goes through the leader's normal chat. The generic held-action queue (public/app/04-messages.js) never sees these.
// S-F3 Finished tasks: per tab, which view the panel shows (current, list, task), the listed IDs, the one read on its way and the task
// it opened. Only the two archive read messages are sent; a reply settles only its own request, tab and task. Kept in memory only.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});
  const ARCHIVE_PAGE = 50, ARCHIVE_FIRST_ROWS = 3, ARCHIVE_WAIT_MS = 20_000;
  const NOT_READABLE = "The reply could not be read.";

  FC.createTaskEvents = (page, crewView) => {
    const taskState = FC.createTaskState();
    const archives = new Map(); // tabId -> Finished tasks state (blankArchive)
    const archive = { of: (tabId) => archives.get(tabId) ?? null, signature: (tabId) => archives.get(tabId)?.version ?? 0, takeFocus };
    const view = FC.createTaskView(page, taskState, crewView, archive);
    const { pending } = taskState;
    let last = null; // the tab and visibility the page drew last

    const canApprove = (current) => taskState.canApprove(current);
    function currentFor(tab, kind) {
      const detail = taskState.detailFor(tab);
      return detail ? { tab, kind, task: detail.task, fresh: detail.fresh, connected: page.connected(), blocked: Boolean(tab.fixedTask?.blocked) } : null;
    }
    function fetchDetail(tab) {
      const requestId = page.newRequestId();
      taskState.detailSent(tab, requestId);
      if (!page.send({ type: "getFixedTask", requestId, tabId: tab.id })) taskState.detailNotSent(tab.id, requestId);
    }
    // Called by the page on every stage draw (public/app/08-seat-view-details.js renderStage), so a dropped connection is seen at once.
    function render(tab, show) {
      last = { tabId: tab?.id ?? null, show };
      pruneArchives();
      if (!page.connected()) { taskState.disconnected(); archivesDisconnected(); }
      else if (tab?.fixedCrew && !tab.fixedCrew.unavailable && taskState.wantDetail(tab)) fetchDetail(tab);
      view.render(tab, show);
    }
    const rerender = () => { if (last) render(page.findTab(last.tabId), last.show); };

    function approve(tab, kind) {
      const current = currentFor(tab, kind);
      if (!current) return;
      const key = taskState.approvalKey(tab.id, current.task.id, current.task.planVersion, kind);
      if (!canApprove(current) || pending.has(key)) return;
      const requestId = page.newRequestId(), task = current.task;
      const approvalMessage = { type: kind === "rough" ? "approveFixedRough" : "approveFixedPlan", requestId, tabId: tab.id, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, ...(kind === "rough" ? { roughRevision: task.roughRevision } : {}) };
      taskState.begin({ requestId, tabId: tab.id, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, roughRevision: kind === "rough" ? task.roughRevision : null, kind, lost: false });
      const sent = page.send(approvalMessage);
      if (!sent) taskState.notSent(key, requestId);
      rerender();
    }
    // Opens Settings at one position and puts the keyboard on its model control.
    function openPosition(tab, slot, opener) {
      page.openSettings(opener, "crew");
      requestAnimationFrame(() => {
        const body = page.$("setBody"), chip = crewView.rootOf(tab.id)?.querySelector(`[data-fc-model="${CSS.escape(slot)}"]`);
        if (!chip || !body) return;
        body.scrollTop += chip.getBoundingClientRect().top - body.getBoundingClientRect().top - 80;
        chip.focus({ preventScroll: true });
      });
    }
    function toggle(key, open) {
      if (!open || !taskState.expanded.has(key)) taskState.toggle(key); // Show findings only ever opens
      rerender();
      if (open) page.$("fixedView").querySelector('[data-fct-row="Findings"]')?.scrollIntoView({ block: "nearest" });
    }

    // ---- Finished tasks ----
    function blankArchive() {
      return { mode: "current", items: [], visible: 0, nextCursor: null, list: { status: "idle", error: "" }, more: { status: "idle", error: "" }, selected: null, detail: null,
        detailStatus: "idle", detailError: "", pending: null, stale: false, open: new Set(), version: 0, focus: null, scroll: null, currentScroll: 0, listScroll: 0, row: null };
    }
    const archiveFor = (tabId) => { if (!archives.has(tabId)) archives.set(tabId, blankArchive()); return archives.get(tabId); };
    const changed = (a) => { a.version++; };
    const scrollTop = () => page.$("view")?.scrollTop ?? 0;
    // What the next draw of this tab focuses and scrolls to, once. Only the tab it was set for ever takes it.
    function takeFocus(tabId) { const a = archives.get(tabId); if (!a?.focus) return null; const wanted = { key: a.focus, scroll: a.scroll }; a.focus = null; a.scroll = null; return wanted; }
    function pruneArchives() {
      const ids = new Set((page.state?.projects ?? []).flatMap((project) => project.tabs.map((tab) => tab.id)));
      for (const [tabId, a] of archives) if (!ids.has(tabId)) { clearTimeout(a.pending?.timer); archives.delete(tabId); }
    }
    function failArchive(a, op, reason) {
      if (op === "first") a.list = { status: "error", error: reason };
      else if (op === "page") a.more = { status: "error", error: reason };
      else { a.detailStatus = "error"; a.detailError = reason; }
      changed(a);
    }
    // A newer read, Back or a reopen retires the read on its way: its late reply then matches nothing.
    function dropRead(a) {
      if (!a.pending) return;
      clearTimeout(a.pending.timer);
      if (a.pending.op === "page" && a.more.status === "loading") a.more = { status: "idle", error: "" };
      if (a.pending.op === "detail" && a.detailStatus === "loading") a.detailStatus = "idle";
      a.pending = null;
    }
    function readArchive(tab, a, op, fields) {
      dropRead(a);
      const requestId = page.newRequestId();
      const message = op === "detail" ? { type: "getFixedTaskArchive", requestId, tabId: tab.id, taskId: fields.taskId }
        : { type: "listFixedTaskArchives", requestId, tabId: tab.id, cursor: fields.cursor, limit: ARCHIVE_PAGE };
      const read = { requestId, tabId: tab.id, op, ...fields, timer: 0 };
      if (!page.send(message)) { failArchive(a, op, "Not connected."); return; }
      a.pending = read;
      read.timer = setTimeout(() => {
        if (a.pending !== read) return;
        a.pending = null; failArchive(a, op, read.unreadable ? NOT_READABLE : "Command Center did not answer in time."); rerender();
      }, ARCHIVE_WAIT_MS);
    }
    // A dropped connection: the read on its way is never answered here and never resent; what is shown stays, marked as last read.
    function archivesDisconnected() {
      for (const a of archives.values()) {
        if (a.pending) { const op = a.pending.op; dropRead(a); failArchive(a, op, "Not connected."); }
        if (!a.stale && (a.items.length || a.detail)) { a.stale = true; changed(a); }
      }
    }
    function openArchive(tab) {
      const a = archiveFor(tab.id);
      dropRead(a);
      Object.assign(a, { mode: "list", items: [], visible: 0, nextCursor: null, list: { status: "loading", error: "" }, more: { status: "idle", error: "" }, stale: false,
        currentScroll: a.mode === "current" ? scrollTop() : a.currentScroll, focus: "arch-heading", scroll: 0 });
      changed(a);
      readArchive(tab, a, "first", { cursor: null });
    }
    function archiveNavigate(tab, target, id) {
      const a = archiveFor(tab.id);
      if (target === "current") { dropRead(a); Object.assign(a, { mode: "current", focus: "arch-entry", scroll: a.currentScroll }); }
      else if (target === "list") { dropRead(a); Object.assign(a, { mode: "list", focus: a.row ? `arch-row-${a.row}` : "arch-heading", scroll: a.listScroll }); }
      else if (target === "row" && a.items.some((item) => item.id === id)) {
        Object.assign(a, { listScroll: scrollTop(), row: id, mode: "task", selected: id, detail: null, detailStatus: "loading", detailError: "", focus: "arch-heading", scroll: 0 });
        readArchive(tab, a, "detail", { taskId: id });
      } else return;
      changed(a);
    }
    function showMore(tab) {
      const a = archiveFor(tab.id);
      if (a.pending || a.list.status !== "ready" || a.more.status === "loading") return; // one read at a time, also against a forced click
      if (a.visible < a.items.length) { const first = a.items[a.visible]; a.visible = a.items.length; if (!a.nextCursor) a.focus = `arch-row-${first.id}`; changed(a); return; }
      if (!a.nextCursor) return;
      a.more = { status: "loading", error: "" }; changed(a);
      readArchive(tab, a, "page", { cursor: a.nextCursor });
    }
    function retryArchive(tab) {
      const a = archiveFor(tab.id);
      if (a.pending) return;
      if (a.mode === "task") { a.detailStatus = "loading"; a.detailError = ""; changed(a); readArchive(tab, a, "detail", { taskId: a.selected }); }
      else if (a.list.status !== "ready") openArchive(tab);
      else if (a.more.status === "error") { a.focus = "arch-heading"; a.more = { status: "loading", error: "" }; changed(a); readArchive(tab, a, "page", { cursor: a.nextCursor }); }
    }
    function onArchiveClick(tab, data) {
      if (tab.fixedCrew.unavailable) return;
      if (data.fctArch === "open") openArchive(tab);
      else if (data.fctArch === "more") showMore(tab);
      else if (data.fctArch === "retry") retryArchive(tab);
      else archiveNavigate(tab, data.fctArch, data.fctArchId);
      rerender();
    }
    const boundedText = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
    const validItems = (items) => Array.isArray(items) && items.every((item) => item && typeof item.id === "string" && item.id && item.kind === "task" && boundedText(item.scope, 8192) && boundedText(item.completedAt, 64));
    function acceptList(a, read, message) {
      if (!validItems(message.items) || !(message.nextCursor === null || (typeof message.nextCursor === "string" && message.nextCursor))) { failArchive(a, read.op, NOT_READABLE); return; }
      const showing = last?.tabId === read.tabId;
      if (read.op === "first") Object.assign(a, { items: message.items, visible: Math.min(ARCHIVE_FIRST_ROWS, message.items.length), list: { status: "ready", error: "" } });
      else {
        const known = new Set(a.items.map((item) => item.id)), added = message.items.filter((item) => !known.has(item.id));
        a.items = [...a.items, ...added]; a.visible = a.items.length; a.more = { status: "idle", error: "" };
        const focusKey = page.$("fixedView")?.contains(document.activeElement) ? document.activeElement?.dataset?.fctKey : null;
        if (showing && ["arch-heading", "arch-more"].includes(focusKey) && added.length) a.focus = `arch-row-${added[0].id}`;
      }
      a.nextCursor = message.nextCursor; a.stale = false; changed(a);
    }
    // The task, its manifest and their tab must all be the one asked about; the server has already verified the archive's bytes.
    function acceptDetail(a, read, message) {
      const { task, manifest, executions } = message;
      const same = task && manifest && task.id === read.taskId && task.tabId === read.tabId && manifest.taskId === read.taskId && manifest.tabId === read.tabId;
      if (!same) { read.unreadable = true; return false; }
      const complete = task.stage === "complete" && manifest.planVersion === task.planVersion && manifest.recordRevision === task.recordRevision;
      if (!complete) { read.unreadable = true; return false; }
      if (!task.plan || typeof task.plan.scope !== "string" || !Array.isArray(executions) || typeof manifest.reason !== "string") failArchive(a, "detail", NOT_READABLE);
      else Object.assign(a, { detail: { taskId: read.taskId, task, manifest, executions }, detailStatus: "ready", detailError: "", stale: false });
      changed(a);
      return true;
    }
    // true: an archive reply, applied or dropped. Errors are matched through the pending read, since they carry no taskId.
    function onArchiveMessage(message) {
      const isReply = message.type === "fixedTaskArchives" || message.type === "fixedTaskArchive";
      const isError = message.type === "error" && (message.action === "listFixedTaskArchives" || message.action === "getFixedTaskArchive");
      if (!isReply && !isError) return false;
      const a = archives.get(message.tabId), read = a?.pending;
      if (!read || read.requestId !== message.requestId || read.tabId !== message.tabId) return true;
      if (isError) { if ((read.op === "detail") !== (message.action === "getFixedTaskArchive")) return true; failArchive(a, read.op, String(message.message || "The server refused it.")); }
      else if (message.type === "fixedTaskArchives") { if (read.op === "detail") return true; acceptList(a, read, message); }
      else if (read.op !== "detail" || message.taskId !== read.taskId || !acceptDetail(a, read, message)) return true;
      clearTimeout(read.timer); a.pending = null;
      rerender();
      return true;
    }
    // Disclosures are opened by the browser; their state is kept so a redraw draws them as the owner left them.
    page.$("fixedView")?.addEventListener("toggle", (event) => {
      const details = event.target, a = archives.get(last?.tabId);
      if (!a || !details?.dataset?.fctDisc) return;
      if (details.open) a.open.add(details.dataset.fctDisc); else a.open.delete(details.dataset.fctDisc);
    }, true);

    page.$("fixedView")?.addEventListener("click", (event) => {
      const button = event.target.closest?.("button"), tab = page.findTab(last?.tabId);
      if (!button || button.disabled || !tab?.fixedCrew || !page.$("fixedView").contains(button)) return;
      const data = button.dataset;
      if (data.fctArch) onArchiveClick(tab, data);
      else if (data.fctApprove) approve(tab, data.fctApprove);
      else if (data.fctToggle) toggle(data.fctToggle, data.fctOpen !== undefined);
      else if (data.fctAsk !== undefined) page.askForChanges();
      else if (data.fctPosition) openPosition(tab, data.fctPosition, button);
    });

    // true: a task reply, already applied (the panel is drawn again). false: the page's own handling goes on.
    function onMessage(message) {
      if (onArchiveMessage(message)) return true;
      if (message.type === "fixedTask") {
        const task = message.task && typeof message.task === "object" ? message.task : null;
        if (taskState.acceptDetail({ requestId: message.requestId, tabId: message.tabId, taskId: task?.id ?? null, planVersion: task?.planVersion ?? null, task })) rerender();
        return true;
      }
      if (message.type === "fixedTaskResult") { if (taskState.settle(message)) rerender(); return true; }
      if (message.type === "error" && typeof message.requestId === "string" && (taskState.settle(message) || taskState.detailFailed(message))) { rerender(); return true; }
      return false;
    }
    function status(tab) {
      const summary = tab.fixedTask;
      if (summary?.blocked) return { tone: "bad", text: "Task blocked", sub: summary.notice ?? "Check the task notice" };
      if (!taskState.summaryOf(tab)) return null;
      const detail = taskState.detailFor(tab);
      if (!detail?.fresh) return { tone: "work", text: "Reading the current task", sub: "Approval status is not confirmed yet" };
      const task = detail.task;
      if (!taskState.scopeApproved(task)) return { tone: "wait", text: "Waiting on you: approve this plan", sub: "Read the Planner's decision below" };
      if (task.stage === "inspected" && !taskState.roughApproved(task)) return { tone: "wait", text: "Waiting on you: look at the rough", sub: "Approve rough or ask for changes below" };
      return { tone: task.stage === "interrupted" ? "bad" : "idle", text: task.stage === "interrupted" ? "Task interrupted" : task.stage === "complete" ? "Task complete" : "Waiting for the leader's next step", sub: "See the current task below" };
    }
    return { render, onMessage, status };
  };
})();
