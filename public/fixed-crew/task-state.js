// Fixed crew (Pack 26, Block 3c): what the page keeps about a fixed tab's task besides the server's state. The task is only ever the
// server's: the compact summary in each state message (tab.fixedTask) and the whole record fetched with getFixedTask. Kept here: the
// detail request each tab waits on, the last detail that answered it, the approval each task and plan waits on, and which Planner's
// decision panels are open. Nothing is approved, resent or concluded here without a server reply naming the request.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});

  FC.createTaskState = () => {
    const details = new Map(); // tabId -> { requestId, taskId, planVersion, recordRevision, task, stale }
    const detailRequests = new Map(); // tabId -> { requestId, taskId, planVersion, detailRevision, lost, failed }
    const pending = new Map(); // approval key -> { requestId, tabId, taskId, planVersion, recordRevision, roughRevision, kind, lost }
    const outcomes = new Map(); // approval key -> { status, message, requestId, recordRevision }
    const expanded = new Set(); // panel keys of the open Planner's decisions

    const approvalKey = (tabId, taskId, planVersion, kind) => `${tabId}|${taskId}|${planVersion}|${kind}`;
    const panelKey = (tabId, taskId, planVersion) => `${tabId}|${taskId}|${planVersion}`;
    const summaryOf = (tab) => (tab?.fixedTask && typeof tab.fixedTask.taskId === "string" ? tab.fixedTask : null);
    const scopeApproved = (task) => task?.ownerScopeApproval?.planVersion === task?.planVersion && task?.ownerScopeApproval?.digest === task?.planDigest;
    const roughApproved = (task) => Boolean(task?.roughRevision) && task.ownerRoughApproval?.revision === task.roughRevision;

    // The detail shown for a tab: the last one the server sent for the summary's own task and plan. Fresh = also the summary's revision.
    function detailFor(tab) {
      const summary = summaryOf(tab), detail = details.get(tab?.id);
      if (!summary || !detail || detail.taskId !== summary.taskId || detail.planVersion !== summary.planVersion) return null;
      return { task: detail.task, requestId: detail.requestId, fresh: !detail.stale && detail.recordRevision === summary.detailRevision };
    }
    // Asked once per task, plan and revision; again after a dropped connection, never again after a refusal of the same one.
    function wantDetail(tab) {
      const summary = summaryOf(tab);
      if (!summary || detailFor(tab)?.fresh) return false;
      const asked = detailRequests.get(tab.id);
      return !asked || asked.lost || asked.taskId !== summary.taskId || asked.planVersion !== summary.planVersion || asked.detailRevision !== summary.detailRevision;
    }
    function detailSent(tab, requestId) {
      const summary = summaryOf(tab);
      detailRequests.set(tab.id, { requestId, taskId: summary.taskId, planVersion: summary.planVersion, detailRevision: summary.detailRevision, lost: false, failed: "" });
    }
    function detailNotSent(tabId, requestId) { if (detailRequests.get(tabId)?.requestId === requestId) detailRequests.delete(tabId); }
    const detailError = (tab) => detailRequests.get(tab?.id)?.failed || "";
    // Only the newest request of this tab, answered for the task and plan it asked about, is taken. A late reply to an older request,
    // a reply for another tab or a reply about another plan is dropped.
    function acceptDetail(message) {
      const current = detailRequests.get(message.tabId);
      if (!current) return false;
      if (message.taskId !== current.taskId || message.planVersion !== current.planVersion || message.requestId !== current.requestId) return false;
      detailRequests.delete(message.tabId);
      details.set(message.tabId, { requestId: message.requestId, taskId: message.taskId, planVersion: message.planVersion, recordRevision: message.task.recordRevision, task: message.task, stale: false });
      resolveLost(message.tabId, message.task);
      return true;
    }
    function detailFailed(message) {
      const current = detailRequests.get(message.tabId);
      if (!current || current.requestId !== message.requestId) return false;
      current.failed = String(message.message || "The server refused it");
      return true;
    }

    // An approval waits on its own requestId, for exactly the task, plan and record revision it was sent about.
    function begin(request) {
      const key = approvalKey(request.tabId, request.taskId, request.planVersion, request.kind);
      pending.set(key, request);
      outcomes.set(key, { status: "sending", message: "Sending…", requestId: request.requestId });
      return key;
    }
    function notSent(key, requestId) {
      if (pending.get(key)?.requestId !== requestId) return;
      pending.delete(key);
      outcomes.set(key, { status: "failed", message: "Not sent: Command Center is not connected.", requestId });
    }
    // A reply settles only the request it names, for the tab (and, on success, the task) that request was about.
    function settle(message) {
      for (const [key, request] of pending) {
        if (request.requestId !== message.requestId || request.tabId !== message.tabId) continue;
        if (message.type === "fixedTaskResult" && message.taskId !== request.taskId) return false;
        pending.delete(key);
        outcomes.set(key, message.type === "fixedTaskResult"
          ? { status: "done", message: "", requestId: request.requestId, recordRevision: Number(message.recordRevision) || 0 }
          : { status: "refused", message: String(message.message || "The server refused it"), requestId: request.requestId });
        return true;
      }
      return false;
    }
    // A dropped connection: every waiting approval becomes unknown (never refused, never done), and every detail is read again.
    function disconnected() {
      for (const [key, request] of pending) {
        if (request.lost) continue;
        request.lost = true;
        outcomes.set(key, { status: "unknown", message: "Not confirmed: the connection dropped. Nothing is sent again; the task is read again when Command Center reconnects.", requestId: request.requestId });
      }
      for (const detail of details.values()) detail.stale = true;
      for (const asked of detailRequests.values()) asked.lost = true;
    }
    // After a reconnect the task's own request list says whether a lost approval reached the server.
    function resolveLost(tabId, task) {
      for (const [key, request] of pending) {
        if (!request.lost || request.tabId !== tabId) continue;
        pending.delete(key);
        const saved = request.taskId === task?.id && (task.requests ?? []).find((item) => item.id === request.requestId);
        outcomes.set(key, saved ? { status: "done", message: "", requestId: request.requestId, recordRevision: Number(saved.result?.recordRevision) || 0 }
          : { status: "unknown", message: "Not confirmed: the server has no record of this answer, so nothing changed. Answer again if it still needs you.", requestId: request.requestId });
      }
    }
    const outcomeOf = (tabId, task, kind) => outcomes.get(approvalKey(tabId, task?.id, task?.planVersion, kind)) ?? null;
    // Whether an approval may be sent now: connected, the detail is the server's latest, nothing blocks the task, and the server's
    // own record still waits for this answer. Checked on drawing and again inside the click listener.
    function canApprove(current) {
      const { task, kind, tab } = current;
      if (!current.connected || !current.fresh || !task || current.blocked || task.stage === "interrupted") return false;
      const done = outcomeOf(tab.id, task, kind);
      if (done?.status === "done" && task.recordRevision < done.recordRevision) return false;
      if (kind === "plan") return !scopeApproved(task);
      return kind === "rough" && task.stage === "inspected" && scopeApproved(task) && Boolean(task.roughRevision)
        && task.roughRevision === task.revision?.digest && !roughApproved(task);
    }
    function toggle(key) { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); }

    return {
      approvalKey, panelKey, summaryOf, scopeApproved, roughApproved, detailFor, wantDetail, detailSent, detailNotSent, detailError, acceptDetail,
      detailFailed, begin, notSent, settle, disconnected, outcomeOf, canApprove, toggle, pending, expanded,
    };
  };
})();
