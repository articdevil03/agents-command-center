// Fixed crew (Pack 26, Block 2b): New project and Add a tab ask which AI each position uses. The dialogs keep their name, folder and
// "Work on this project only" fields; there are no kind or template choices. Picks stay in the dialog's draft until Create sends
// them (crewChoices) with the Auto assign intent (autoAssign): the server decides every automatic pick. A preview shows what Auto
// assign would choose and saves nothing. Cancel sends nothing. Without usable position definitions from the server the dialog says so and
// creates nothing: there is no other way to create a project or tab.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});
  const DIALOGS = { tab: { modal: "modal", box: "tCrew" }, project: { modal: "projModal", box: "pCrew" } };
  const UNAVAILABLE = "The crew positions are not available right now, so nothing can be created. Check the connection, then close this window and open it again.";
  const DRAFT_TAB = { id: "fc-new", fixedCrew: null };

  FC.createDialog = (page, store, view, { assignmentFrom, seatOf, hints, definition }) => {
    let open = null; // "tab" | "project" while a fixed creation dialog is open
    const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const box = () => (open ? page.$(DIALOGS[open].box) : null);

    // What a position will get: the user's own choice, else what the latest matching preview says Auto assign picks, else nothing.
    function shown(slot) {
      const draft = store.draft();
      if (Object.hasOwn(draft.choices, slot)) return { assignment: draft.choices[slot], source: "user" };
      const auto = draft.autoAssign ? draft.preview?.preferences?.[slot] : null;
      return auto && auto.source === "auto" ? { assignment: auto.assignment ?? null, source: "auto" } : { assignment: null, source: "auto" };
    }
    // The server's own definitions are the only list of positions. Usable: a non-empty list whose entries each have a slot, a label and a known group, with no slot twice.
    function usable(def, slots) {
      if (!def || typeof def.slot !== "string" || !def.slot || typeof def.label !== "string" || !def.label || !view.groups.some(([group]) => group === def.group) || slots.has(def.slot)) return false;
      slots.add(def.slot); return true;
    }
    function ready() {
      const defs = view.definitions(), slots = new Set();
      return defs.length > 0 && defs.every((def) => usable(def, slots));
    }
    function requestPreview() {
      if (!ready()) return;
      const draft = store.draft(), requestId = page.newRequestId();
      store.previewSent(requestId);
      if (!page.send({ type: "previewCrewAssignments", requestId, draftId: draft.id, choices: { ...draft.choices }, autoAssign: draft.autoAssign })) draft.previewError = "Not connected, so Auto assign cannot be checked yet.";
    }
    function changed() { if (store.draft()?.autoAssign) requestPreview(); render(); }
    function pickerFor(slot) {
      const current = () => (store.draft() ? shown(slot).assignment : null);
      return {
        tab: () => DRAFT_TAB, hints, locked: () => false,
        seat: () => (store.draft() && definition(slot) ? seatOf(definition(slot), current()) : null),
        pick: (fields) => { const assignment = assignmentFrom(fields, current()); if (!assignment || !store.draft()) return; store.draft().choices[slot] = assignment; changed(); },
        clear: () => { if (!store.draft()) return; store.draft().choices[slot] = null; changed(); },
      };
    }

    function buildHead() {
      const head = node("div", "fc-chead");
      const title = node("div", "d"), status = node("small", "fc-cstatus"); title.append(node("span", "lbl", "Crew"), status);
      const auto = node("button", "btn sm", "Auto assign"); auto.type = "button"; auto.dataset.fcNewAuto = ""; auto.dataset.focusKey = "fc-new-auto";
      head.append(title, auto);
      return { head, auto, status };
    }
    // One handler for every state of the box; it re-checks the draft and the data at click time, so a disabled button forced on sends nothing.
    function onBoxClick(event) {
      const button = event.target.closest?.("button");
      if (!button || button.disabled || !store.draft() || !ready()) return;
      if (button.dataset.fcNewAuto !== undefined) { store.draft().autoAssign = !store.draft().autoAssign; if (store.draft().autoAssign) requestPreview(); else store.draft().preview = null; render(); return; }
      const slot = button.dataset.fcNewModel;
      if (slot) { const adapter = pickerFor(slot), seat = adapter.seat(); if (seat) page.togglePopover(page.$("pop"), button, () => page.openModelPicker(DRAFT_TAB, seat, button, adapter)); }
    }
    function showUnavailable(target) {
      const { head, auto, status } = buildHead();
      auto.disabled = true; status.textContent = UNAVAILABLE; status.dataset.fcNewUnavailable = "";
      target.replaceChildren(head); target.dataset.slots = "unavailable"; target.onclick = onBoxClick; target.hidden = false;
    }
    function build(target) {
      const { head } = buildHead();
      const list = node("div", "card fc-list fc-clist");
      for (const [group] of view.groups) {
        const defs = view.definitions().filter((def) => def.group === group);
        if (!defs.length) continue;
        list.append(node("div", "fc-cgroup", group));
        for (const def of defs) {
          const row = node("div", "fc-crow"); row.dataset.fcNewRow = def.slot;
          const info = node("div", "d"); info.append(node("b", "fc-label", view.label(def)), node("small", "fc-source"));
          const chip = node("button", "chipb fc-model"); chip.type = "button"; chip.dataset.fcNewModel = def.slot; chip.dataset.focusKey = `fc-new-model-${def.slot}`; chip.setAttribute("aria-haspopup", "dialog");
          chip.append(node("span", "fc-logo"), node("span", "fc-model-text"));
          row.append(info, chip, node("p", "fc-note fc-check", "Check that you can use this model."));
          list.append(row);
        }
      }
      target.replaceChildren(head, list);
      target.dataset.slots = view.definitions().map((def) => def.slot).join(",");
      target.onclick = onBoxClick;
    }
    function render() {
      const target = box(), draft = store.draft();
      if (!target || !draft) return;
      if (!ready()) { open = null; store.endDraft(); showUnavailable(target); return; }
      if (target.dataset.slots !== view.definitions().map((def) => def.slot).join(",")) build(target);
      const auto = target.querySelector("[data-fc-new-auto]");
      auto.setAttribute("aria-pressed", String(draft.autoAssign));
      target.querySelector(".fc-cstatus").textContent = draft.previewError ? `Auto assign could not be checked: ${draft.previewError}`
        : draft.autoAssign ? draft.preview ? "Auto assign fills the empty positions from the AI tools you have. Your own picks stay." : "Checking which AI tools you have…"
          : "Choose a model for any position, or click Auto assign. A position can stay empty for now.";
      for (const row of target.querySelectorAll("[data-fc-new-row]")) {
        const slot = row.dataset.fcNewRow, pref = shown(slot), assignment = pref.assignment, waiting = draft.autoAssign && !draft.preview && pref.source === "auto";
        row.querySelector(".fc-source").textContent = waiting ? "Checking…" : view.sourceText(pref);
        row.querySelector(".fc-logo").innerHTML = assignment ? page.logo(assignment.cli, 13, 0) : "";
        row.querySelector(".fc-model-text").textContent = view.modelText(assignment, DRAFT_TAB);
        row.querySelector("[data-fc-new-model]").toggleAttribute("data-empty", !assignment);
        row.querySelector(".fc-check").hidden = !view.needsCheck(pref);
        row.querySelector("[data-fc-new-model]").setAttribute("aria-label", `${row.querySelector(".fc-label").textContent}: ${assignment ? view.modelText(assignment, DRAFT_TAB) : "No model assigned"}. Choose a model`);
      }
    }
    // Opening a dialog starts a fresh draft, or says the positions are unavailable and keeps no draft.
    function openDialog(which) {
      const config = DIALOGS[which], fixed = ready();
      page.$(config.box).hidden = false;
      page.$(config.modal).classList.toggle("fc-wide", fixed);
      if (!fixed) { open = null; store.endDraft(); showUnavailable(page.$(config.box)); return; }
      open = which;
      store.startDraft(which);
      render();
    }
    // The creation fields for the open dialog, or null when it is not open, has no draft, or the positions are unavailable.
    function fields(which) {
      const draft = store.draft();
      if (!ready() || open !== which || !draft || draft.kind !== which) return null;
      return { requestId: page.newRequestId(), fixedCrewVersion: 1, crewChoices: { ...draft.choices }, autoAssign: draft.autoAssign };
    }
    function onPreview(message) { if (!store.acceptPreview(message)) return false; render(); return true; }
    function onPreviewError(message) { if (message.action !== "previewCrewAssignments" || !store.previewFailed(message)) return false; render(); return true; }

    return { open: openDialog, ready, fields, onPreview, onPreviewError, render };
  };
})();
