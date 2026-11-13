// Fixed crew (Pack 26, Block 2b): what the page keeps for the fixed crew besides the server's state. Assignments and their
// sources are never kept or guessed here: they are read from each state message. What is kept is the user's own unsaved typing
// (extra instructions per tab and position), which request each Save, Reset or model change is waiting on, and the creation
// dialog's draft (its choices, its Auto assign intent and the preview that belongs to it).
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});

  FC.createState = (connected, onChange) => {
    const drafts = new Map(); // `${tabId}|${slot}` -> text typed and not saved yet
    const requests = new Map(); // requestId -> { key, kind: "extra" | "crew", text, lost }
    const outcomes = new Map(); // key -> { status, message, requestId } of the latest request for that key
    const prompts = new Map(); // slot -> { core, guidance, defaultsVersion } fetched from the server, or { error }
    const promptRequests = new Map(); // requestId -> slot
    const expanded = new Set(); // keys whose Instructions are open
    let currentDraft = null; // the open creation dialog's draft
    let watch = 0;

    const keyOf = (tabId, slot) => `${tabId}|${slot}`;
    function extraText(key, saved) {
      if (drafts.has(key)) return drafts.get(key);
      return saved ?? "";
    }
    // Typing back to exactly the saved text is no edit at all; anything else is kept until a save of that same text succeeds.
    function typeExtra(key, text, saved) {
      if (text === (saved ?? "")) { drafts.delete(key); return; }
      drafts.set(key, text);
    }
    const isDirty = (key) => drafts.has(key);

    // A request waits on its own id. A dropped connection makes every waiting request unknown, never failed and never done.
    function watchConnection() {
      if (watch) return;
      watch = setInterval(() => {
        if (!requests.size) { clearInterval(watch); watch = 0; return; }
        if (connected()) return;
        let changed = false;
        for (const [requestId, request] of requests) {
          if (request.lost) continue;
          request.lost = true; changed = true;
          if (outcomes.get(request.key)?.requestId === requestId) outcomes.set(request.key, { status: "unknown", message: "Not confirmed: the connection dropped. Check the value after it reconnects.", requestId });
        }
        if (changed) onChange();
      }, 300);
    }
    function begin(requestId, key, kind) {
      requests.set(requestId, { key, kind, text: kind === "extra" ? drafts.get(key) : undefined, lost: false });
      outcomes.set(key, { status: "saving", message: "Saving…", requestId });
      watchConnection();
    }
    // Nothing reached the server: the typing stays and the row says so.
    function notSent(requestId) {
      const request = requests.get(requestId); if (!request) return;
      requests.delete(requestId);
      if (outcomes.get(request.key)?.requestId === requestId) outcomes.set(request.key, { status: "failed", message: "Not sent: Command Center is not connected.", requestId });
    }
    function settle(requestId, ok, message, result) {
      const submitted = requests.get(requestId);
      if (!submitted) return false;
      const bulk = submitted.key.endsWith("|bulk"), tabId = submitted.key.split("|")[0];
      if (bulk && (result?.action !== "setCrewModelForAll" || (ok ? result.tabId !== tabId : result.tabId !== undefined && result.tabId !== tabId))) return false;
      requests.delete(requestId);
      const key = submitted.key;
      // Only the text that was sent is retired: newer typing after the click stays as an unsaved draft.
      if (ok && submitted.kind === "extra") {
        if (drafts.get(key) === submitted.text) drafts.delete(key);
      }
      if (outcomes.get(key)?.requestId === requestId) outcomes.set(key, ok ? { status: "saved", message: "Saved", requestId } : { status: "refused", message: message || "The server refused it", requestId });
      if (bulk && ok) {
        const changed = result.changed, skipped = result.skipped;
        const detail = Array.isArray(changed) && Array.isArray(skipped)
          ? `${result.notice}${changed.length ? ` Updated ${changed.length} position${changed.length === 1 ? "" : "s"}.` : ""}${skipped.length ? ` Kept ${skipped.length} working position${skipped.length === 1 ? "" : "s"}: ${skipped.map((item) => item.label).join(", ")}.` : ""}`
          : "The server confirmed this request completed. Check the current models. Changed and kept details were not available after reconnecting.";
        outcomes.set(key, { status: "saved", message: detail, requestId });
      }
      return true;
    }
    const pending = (key) => [...requests.values()].some((request) => request.key === key && (!request.lost || key.endsWith("|bulk")));

    // After a reconnect the server's finished-request list answers what the lost replies would have said.
    function resolveFromState(state) {
      let changed = false;
      for (const requestId of [...requests.keys()]) {
        const known = state?.requestActions?.[requestId];
        const request = requests.get(requestId), bulk = request.key.endsWith("|bulk");
        if (bulk && !request.lost) continue; // live replies contain the changed/skipped result; state only records completion
        if (known?.status === "done" || known?.status === "failed") changed = settle(requestId, known.status === "done", known.message,
          bulk ? { action: "setCrewModelForAll", tabId: request.key.split("|")[0] } : undefined) || changed;
      }
      return changed;
    }

    function startDraft(kind) {
      currentDraft = { id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind, choices: {}, autoAssign: false, previewRequestId: null, preview: null, previewError: "" };
      return currentDraft;
    }
    const draft = () => currentDraft;
    function endDraft() { currentDraft = null; }
    function previewSent(requestId) { currentDraft.previewRequestId = requestId; currentDraft.preview = null; currentDraft.previewError = ""; }
    // A preview belongs to one dialog and one request: a reply for an earlier pick or an earlier dialog is ignored.
    function acceptPreview(message) {
      if (!currentDraft) return;
      if (message.draftId !== currentDraft.id || message.requestId !== currentDraft.previewRequestId) return;
      currentDraft.preview = message.fixedCrew ?? null;
      currentDraft.previewError = "";
      return true;
    }
    function previewFailed(message) {
      if (!currentDraft || message.requestId !== currentDraft.previewRequestId) return false;
      currentDraft.preview = null;
      currentDraft.previewError = message.message || "The server could not check these choices";
      return true;
    }

    return {
      keyOf, extraText, typeExtra, isDirty, begin, notSent, settle, pending, resolveFromState, outcomes, prompts, promptRequests, expanded,
      startDraft, draft, endDraft, previewSent, acceptPreview, previewFailed,
    };
  };
})();
