// The crew editor, part 3 of 3: the page's events, turned into the actions of setup-editor.js. One set of listeners per mount (the crew
// mount is new whenever the page script (public/app/*.js) draws Settings; the Save bar's strip stays); every handler reads the editor's state at the time of the event.
(() => {
  "use strict";
  const SE = window.CC_SETUP_EDITOR;
  const { ui, selOf, cur, isLocked, seatOf, runReason, redraw, redrawSoon, edit, closeOne, sendAs } = SE;

  function wire(box) {
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onChange);
    box.addEventListener("keydown", onKey);
    box.addEventListener("submit", onSubmit);
    box.addEventListener("focusin", (event) => { const key = event.target.dataset?.focusKey; ui.lastFocus = key ? { key, sel: selOf(event.target) } : null; });
    box.addEventListener("focusout", (event) => { const next = event.relatedTarget; if (event.target.isConnected && next?.isConnected && !next.closest("[data-setup-editor],[data-setup-editor-foot]")) ui.lastFocus = null; });
    const caret = (event) => { if (ui.lastFocus && event.target.dataset?.focusKey === ui.lastFocus.key) ui.lastFocus.sel = selOf(event.target); };
    box.addEventListener("keyup", caret); box.addEventListener("mouseup", caret);
  }
  function onClick(event) {
    const hit = (attr) => event.target.closest?.(`[${attr}]`);
    const { tab, state, s, ctx } = cur();
    let el;
    // A seat's card opens even while the tab works (to look at it); everything in it that changes something is locked.
    if ((el = hit("data-se-row"))) { const slot = el.dataset.seRow; s.open = s.open === slot ? null : slot; s.roleMenu = null; return redraw(); }
    if ((el = hit("data-se-live"))) return openMenu(tab, s, ctx, el);
    if (isLocked(tab)) return;
    if ((el = hit("data-se-pick-role"))) return SE.pickRole(el.closest("[data-se-rolemenu]").dataset.seRolemenu, el.dataset.sePickRole);
    if ((el = hit("data-se-custom-role"))) return SE.pickRole(el.closest("[data-se-rolemenu]").dataset.seRolemenu, null);
    if ((el = hit("data-se-role"))) return toggleRoleMenu(s, el.dataset.seRole);
    if ((el = hit("data-se-look-toggle"))) return edit((draft) => { draft.lookPause = !draft.lookPause; });
    if ((el = hit("data-se-canwrite"))) { const seat = seatOf(tab, s, el.dataset.seCanwrite); return seat && SE.setSeat(seat.slot, { canWrite: !seat.canWrite }); }
    if ((el = hit("data-se-runs"))) { const seat = seatOf(tab, s, el.dataset.seRuns); return seat && !runReason(seat) && SE.setSeat(seat.slot, { orchestrates: seat.orchestrates !== true }); }
    if ((el = hit("data-se-model")) || (el = hit("data-se-advisor"))) return openMenu(tab, s, ctx, el);
    if ((el = hit("data-se-add"))) return SE.addSeat();
    if ((el = hit("data-se-remove"))) return SE.removeSeat(el.dataset.seRemove);
    if ((el = hit("data-se-cancel"))) { closeOne(s, el.dataset.seCancel); return redraw(); }
    if ((el = hit("data-se-menu"))) { const menu = el.dataset.seMenu; s.menu = s.menu === menu ? null : menu; s.confirm = null; if (s.menu === "saveAs") ui.wantFocus = "se-saveas-name"; return redraw(); }
    if ((el = hit("data-se-use"))) {
      const kind = el.dataset.seUse, id = el.dataset.id, item = (kind === "template" ? state?.templates : state?.savedSetups)?.find((other) => other.id === id);
      if (!item) return;
      s.confirm = { kind, id, name: item.name }; ui.wantFocus = "se-confirm";
      return redraw();
    }
    if ((el = hit("data-se-forget"))) { const item = state?.savedSetups?.find((other) => other.id === el.dataset.seForget); if (item) { s.confirm = { kind: "remove", id: item.id, name: item.name }; ui.wantFocus = "se-confirm"; } return redraw(); }
    if ((el = hit("data-se-confirm"))) return confirmChoice(tab, s);
    if ((el = hit("data-se-save"))) return SE.save();
    if ((el = hit("data-se-discard"))) {
      if (!s.draft || s.saving || SE.switching(s)) return;
      s.draft = null; s.error = ""; s.custom.clear(); s.roleMenu = null;
      return redraw();
    }
  }
  // A seat the server has changes its model and advisor at once (the page's menus send updateSeat); a new one keeps them in the draft.
  function openMenu(tab, s, ctx, el) {
    const slot = el.dataset.seModel ?? el.dataset.seAdvisor, seat = seatOf(tab, s, slot);
    if (!seat) return;
    const live = tab.crew.find((item) => item.slot === slot), draft = seat.fresh ? SE.draftFor(slot) : undefined;
    const open = el.dataset.seModel !== undefined ? ctx.openModel : ctx.openAdvisor;
    open(draft ? draft.seat() : live, el, draft);
  }
  function toggleRoleMenu(s, slot) {
    s.roleMenu = s.roleMenu === slot ? null : slot;
    redraw();
    if (!s.roleMenu) return;
    const menu = ui.view.root.querySelector(`[data-se-rolemenu="${CSS.escape(slot)}"]`);
    (menu?.querySelector('[aria-selected="true"]:not(:disabled)') ?? menu?.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }
  // The confirm step of Switch to (useSetup) and of deleting a saved setup (removeSetup).
  function confirmChoice(tab, s) {
    const ask = s.confirm;
    if (!ask) return;
    if (ask.kind === "remove") { if (sendAs({ type: "removeSetup", tabId: tab.id, setupId: ask.id }, { id: ask.id, note: `Deleted ${ask.name}` })) s.confirm = null; }
    else if (sendAs({ type: "useSetup", tabId: tab.id, ...(ask.kind === "template" ? { templateId: ask.id } : { setupId: ask.id }) }, { name: ask.name, note: `Switched to ${ask.name}` })) {
      s.confirm = null; s.menu = null; // the unsaved crew stays until the server confirms the switch (settle), so a refusal keeps it
    }
    ui.wantFocus = "se-menu-switch";
    redraw();
  }
  function onInput(event) {
    const el = event.target, { s } = cur();
    if (ui.lastFocus && el.dataset?.focusKey === ui.lastFocus.key) ui.lastFocus.sel = selOf(el);
    if (el.dataset.seName !== undefined) return SE.typeInto(el.dataset.seName, "name", el.value);
    if (el.dataset.seRolename !== undefined) return SE.typeInto(el.dataset.seRolename, "role", el.value);
    if (el.id === "se-saveas-name") s.saveAsName = el.value;
  }
  // A typed name shows in the crew list once the field is left (a change fires before the next control takes focus).
  function onChange(event) {
    const el = event.target;
    if (el.dataset.seName !== undefined || el.dataset.seRolename !== undefined) redrawSoon();
  }
  function onKey(event) {
    const el = event.target;
    if (event.key === "Enter" && (el.dataset?.seName !== undefined || el.dataset?.seRolename !== undefined)) { event.preventDefault(); redraw(); return; }
    if (el.closest?.("[data-se-rolemenu]") && moveInMenu(event, el.closest("[data-se-rolemenu]"))) return;
    if (event.key === "ArrowDown" && el.dataset?.seRole !== undefined && cur().s.roleMenu !== el.dataset.seRole) { event.preventDefault(); toggleRoleMenu(cur().s, el.dataset.seRole); return; }
    if (event.key !== "Escape") return;
    const { s } = cur();
    if (!closeOne(s)) return;
    event.preventDefault(); event.stopPropagation();
    redraw();
  }
  // Up and Down, Home and End move through the roles that can be picked (Enter and Space pick, as on any button).
  function moveInMenu(event, menu) {
    const options = [...menu.querySelectorAll("button:not(:disabled)")], at = options.indexOf(event.target);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: options.length - 1 }[event.key];
    if (next === undefined || !options.length) return false;
    event.preventDefault();
    options[(next + options.length) % options.length].focus({ preventScroll: true });
    return true;
  }
  function onSubmit(event) {
    if (!event.target.matches?.("[data-se-saveas]")) return;
    event.preventDefault();
    const { tab, s } = cur(), name = s.saveAsName.trim();
    if (!name || s.draft) return;
    if (sendAs({ type: "saveSetup", tabId: tab.id, name }, { name, note: `Saved as ${name}` })) { s.menu = null; ui.wantFocus = "se-menu-saveAs"; redraw(); }
  }

  SE.wire = wire;
})();
