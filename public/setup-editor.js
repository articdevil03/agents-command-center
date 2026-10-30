// The crew editor (pack 18), part 1 of 3: what the editor knows and does. setup-editor-draw.js draws it and setup-editor-events.js wires
// the page's events to the actions here; all three share window.CC_SETUP_EDITOR, whose render() is the one entry point the page script (public/app/*.js) calls. That script
// draws Settings again on every state message and calls render() each time, so what the person is in the middle of (an unsaved crew, an open
// card or menu, typed text, focus) is kept here per tab.
// The crew is a draft until Save sends setSetup: which seats there are, each one's name, role, Can write and Runs the process, and the look
// switch. A saved seat's model and advisor apply right away (updateSeat, through the page's menus); a new seat's wait for Save with the rest.
// The steps come from the server, derived from the roles: the editor only shows who does what.
(() => {
  "use strict";
  const SE = (window.CC_SETUP_EDITOR = window.CC_SETUP_EDITOR || {});
  const ANSWER_MS = 15_000; // a request the server neither applied nor refused by then is reported as unanswered
  const NOTE_MS = 5_000; // how long a "... added to the crew" note stays (it fades out at the end, setup-editor.css)
  const MAX_SEATS = 16; // server/setup.ts validateSetup
  const NEW_NAME = "New seat", NO_ROLE = "Helper"; // what Save sends for a new seat left without a name or a role
  const AUTO_ROLES = ["Planner", "Coder", "Design coder", "Reviewer", "Fixer", "Final reviewer"]; // the roles that give a tab its steps (deriveSteps)
  const OWN_ACTIONS = new Set(["setSetup", "saveSetup", "useSetup", "removeSetup"]);
  const SEAT_FIELDS = ["slot", "name", "role", "cli", "model", "effort", "canWrite", "isLeader", "advisor", "orchestrates", "pic"];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const joinNames = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const isAcp = (cli) => typeof cli === "string" && cli.startsWith("acp:");

  const byTab = new Map(); // tabId -> what the person is doing in that tab's editor (see ed)
  // view: { root, ctx } of the last render. wantFocus: a control to focus after the next draw. lastFocus: { key, sel } of the editor control
  // that had focus, until focus leaves the editor on purpose. reveal: the slot of a just-added seat, scrolled into view once.
  const ui = { view: null, wantFocus: null, lastFocus: null, reveal: null };

  // The page owns the one socket and shows a refusal only as a toast. To put the server's answer to the editor's own request
  // next to it, the editor listens on that socket too: every socket the page opens also reports here (this file loads first).
  const PageSocket = window.WebSocket;
  if (typeof PageSocket === "function") {
    window.WebSocket = class extends PageSocket {
      constructor(...args) { super(...args); this.addEventListener("message", (event) => heard(event.data)); }
    };
  }
  function heard(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message?.type === "setupSaved") {
      const s = byTab.get(message.tabId);
      if (s?.waiting?.action === "saveSetup" && s.waiting.requestId === message.requestId) { const wait = s.waiting; s.waiting = null; showNote(s, wait.note); redraw(); }
      return;
    }
    if (message?.type !== "error" || !OWN_ACTIONS.has(message.action)) return;
    const s = byTab.get(message.tabId);
    if (!s?.waiting || s.waiting.action !== message.action || Date.now() - s.waiting.at > ANSWER_MS) return;
    s.waiting = null; s.saving = false;
    s.error = String(message.message || "The server refused that change."); s.errorNew = true;
  }

  function ed(tabId) {
    let s = byTab.get(tabId);
    // open: the seat whose card is open. roleMenu: the seat whose role list is open. custom: seats whose role is being typed (Custom...).
    if (!s) byTab.set(tabId, s = { draft: null, open: null, roleMenu: null, custom: new Set(), menu: null, confirm: null, saveAsName: "", waiting: null, saving: false, error: "", errorNew: false, note: null });
    return s;
  }
  const cur = () => ({ tab: ui.view.ctx.tab, state: ui.view.ctx.state, s: ed(ui.view.ctx.tab.id), ctx: ui.view.ctx });
  // The server refuses setSetup and useSetup while the tab has work going (tabHasActiveWork), so the editor locks with it.
  const isLocked = (tab) => Boolean(tab?.derived?.busy || tab?.activeWork);
  const rolesOf = (state) => Array.isArray(state?.roles) ? state.roles : [];
  const roleDef = (state, name) => rolesOf(state).find((role) => role.name === String(name ?? "").trim()) ?? null;
  const hasAuto = (crew) => crew.some((seat) => !seat.isLeader && AUTO_ROLES.includes(String(seat.role ?? "").trim()));

  // ---- the crew as validateSetup takes it, key order fixed so two equal crews compare equal ----
  function canonSeat(seat) {
    const out = {};
    for (const key of SEAT_FIELDS) {
      const value = seat?.[key];
      if (value === undefined || value === null || (key === "orchestrates" && value !== true)) continue;
      out[key] = (key === "name" || key === "role") && typeof value === "string" ? value.trim() : value;
    }
    return out;
  }
  const liveSetup = (tab) => ({ crew: tab.crew.map(canonSeat), lookPause: tab.lookPause === true });
  // What the draft can change of the saved crew; a change anywhere else (a model) is not "changed elsewhere".
  const shapeOf = (tab) => JSON.stringify({ crew: tab.crew.map(({ slot, name, role, canWrite, orchestrates }) => [slot, name, role, canWrite, orchestrates === true]), lookPause: tab.lookPause === true });
  // The draft keeps { slot, ...what changed } for a seat the tab already has (its model and advisor stay live) and the whole seat for a new
  // one (fresh: true) until Save.
  const current = (tab, s) => s.draft ?? { crew: tab.crew.map((seat) => ({ slot: seat.slot })), lookPause: tab.lookPause === true };
  function seatOf(tab, s, slot) {
    const own = current(tab, s).crew.find((seat) => seat.slot === slot);
    if (own?.fresh) return { ...own, typedName: own.name };
    const live = tab.crew.find((seat) => seat.slot === slot);
    if (!live) return null;
    // A saved seat whose name is cleared keeps (and saves) its saved name; the field shows what was typed.
    const typedName = own?.name ?? live.name;
    return { ...live, ...own, name: String(typedName).trim() ? typedName : live.name, typedName };
  }
  const crewOf = (tab, s) => current(tab, s).crew.map((entry) => seatOf(tab, s, entry.slot)).filter(Boolean);
  // A new seat left without a name is saved as "New seat" ("New seat 2" when that is taken); without a role, as a Helper.
  function filledNames(crew) {
    const taken = new Set(crew.map((seat) => String(seat.name ?? "").trim()).filter(Boolean));
    return crew.map((seat) => {
      if (String(seat.name ?? "").trim()) return seat;
      let name = NEW_NAME;
      for (let n = 2; taken.has(name); n++) name = `${NEW_NAME} ${n}`;
      taken.add(name);
      return { ...seat, name };
    });
  }
  const shownCrew = (tab, s) => filledNames(crewOf(tab, s));
  function outgoing(tab, s) {
    const crew = shownCrew(tab, s).map((seat) => ({ ...canonSeat({ ...seat, role: String(seat.role ?? "").trim() || NO_ROLE }), ...(seat.orchestrates === false && tab.crew.find((live) => live.slot === seat.slot)?.orchestrates ? { orchestrates: false } : {}) }));
    return { crew, lookPause: current(tab, s).lookPause === true };
  }
  const unsaved = (tab, s) => Boolean(s.draft) && JSON.stringify(outgoing(tab, s)) !== JSON.stringify(liveSetup(tab));
  const leaderOf = (crew) => crew.find((seat) => seat.isLeader) ?? crew[0];
  const plannerOf = (crew) => crew.find((seat) => !seat.isLeader && String(seat.role ?? "").trim() === "Planner") ?? null;

  // ---- what the page knows about each CLI (state.clis) ----
  const capOf = (cli) => (ui.view?.ctx.state?.clis ?? []).find((cap) => cap.id === cli) ?? null;
  // Why a Planner seat cannot run the process ("" when it can): the server refuses the same (validateSetup).
  function runReason(seat, cap = capOf(seat.cli)) {
    if (cap?.crewTools === false) return `${cap.label} cannot reach the crew tools.`;
    if (isAcp(seat.cli) && !seat.canWrite) return `A read-only ${cap?.label ?? "ACP"} seat refuses every permission request, so it cannot use the crew tools.`;
    return "";
  }
  function freeId(taken, base) {
    if (!taken.includes(base)) return base;
    for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
  }

  // ---- drawing (the markup itself is setup-editor-draw.js) ----
  function render(root, ctx) {
    if (!root || !ctx?.tab) return;
    ui.view = { root, ctx };
    const { tab, state } = ctx, s = ed(tab.id), locked = isLocked(tab), dock = ctx.dock ?? null;
    settle(tab, state, s);
    root.classList.add("se");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Crew");
    root.innerHTML = SE.draw(tab, state, s, locked);
    if (dock) dock.innerHTML = SE.foot(tab, s, locked);
    for (const box of [root, dock]) {
      if (!box) continue;
      // A seat row still opens its card, and a saved seat's model and advisor still change (updateSeat: the server takes those while the tab
      // works, except on a seat with a run of its own, which its button already shows); everything that waits for Save is locked.
      if (locked) for (const el of box.querySelectorAll("button,input,select")) if (!el.matches("[data-se-row],[data-se-live]")) el.disabled = true;
      if (!box.seWired) { box.seWired = true; SE.wire(box); }
    }
    refocus(root, dock);
    placeRoleMenu(root);
    if (ui.reveal) { root.querySelector(`[data-se-card="${CSS.escape(ui.reveal)}"]`)?.scrollIntoView({ block: "nearest" }); ui.reveal = null; }
  }
  function redraw() { if (ui.view?.root?.isConnected) render(ui.view.root, ui.view.ctx); }
  // An open role list goes up when it would run past the bottom of Settings and there is more room above its field.
  function placeRoleMenu(root) {
    const menu = root.querySelector("[data-se-rolemenu]"), port = root.closest(".sbody");
    if (!menu || !port) return;
    const room = port.getBoundingClientRect(), field = menu.parentElement.getBoundingClientRect();
    if (menu.getBoundingClientRect().bottom > room.bottom && field.top - room.top > room.bottom - field.bottom) menu.classList.add("up");
  }
  // While a name is typed only the Save bar is drawn again: the field keeps its caret.
  function paintFoot() {
    const { tab, s, ctx } = cur();
    if (ctx.dock) ctx.dock.innerHTML = SE.foot(tab, s, isLocked(tab));
  }
  // The one live region (#setLive, outside everything that is drawn again): a note is announced once, when it is new.
  function announce(text) {
    const live = document.getElementById("setLive");
    if (!live) return;
    live.textContent = "";
    requestAnimationFrame(() => { live.textContent = text; });
  }
  function showNote(s, text) {
    const note = { text, at: Date.now() };
    s.note = note;
    announce(text);
    setTimeout(() => { if (s.note === note) { s.note = null; redraw(); } }, NOTE_MS);
  }

  // What came back from the server since the last draw: a draft that now matches the tab is done, an answer settles its request.
  function settle(tab, state, s) {
    const now = Date.now();
    if (s.draft && !unsaved(tab, s)) s.draft = null;
    const wait = s.waiting;
    if (wait) {
      const done = wait.action === "setSetup" ? !s.draft
        : wait.action === "saveSetup" ? false
        : wait.action === "useSetup" ? tab.processState?.crewGenerationId !== wait.crewGenerationId
        : wait.action === "removeSetup" ? !(state?.savedSetups ?? []).some((item) => item.id === wait.id) : false;
      if (done) {
        s.waiting = null; s.saving = false;
        // A save closes the card that was open; the first seat it added takes focus, so the note below the list is read next to it.
        if (wait.action === "setSetup") { const back = wait.added[0]?.slot ?? s.open; ui.wantFocus = back ? `se-row-${back}` : "se-add"; s.open = null; s.roleMenu = null; s.custom.clear(); }
        // The switch replaced the crew: only now is the unsaved one given up (a refusal or no answer keeps it).
        if (wait.action === "useSetup") { s.draft = null; s.open = null; s.roleMenu = null; s.custom.clear(); }
        showNote(s, wait.note);
      } else if (now - wait.at > ANSWER_MS) { s.waiting = null; s.saving = false; if (!s.error) { s.error = "The server has not answered that change. Check the connection and try again."; s.errorNew = true; } }
    }
    const crew = current(tab, s).crew;
    if (s.open && !crew.some((seat) => seat.slot === s.open)) s.open = null;
    if (s.roleMenu && s.roleMenu !== s.open) s.roleMenu = null;
  }

  // ---- focus: every draw replaces the editor, so the control that had focus (and its caret) is found again by its key ----
  const selOf = (el) => typeof el?.selectionStart === "number" ? [el.selectionStart, el.selectionEnd] : null;
  function refocus(root, dock) {
    const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    const key = ui.wantFocus ?? (lost ? ui.lastFocus?.key : null), sel = ui.wantFocus ? null : ui.lastFocus?.sel;
    ui.wantFocus = null;
    if (!key) return;
    const find = (box) => box ? [...box.querySelectorAll("[data-focus-key]")].find((item) => item.dataset.focusKey === key) ?? null : null;
    let el = find(root) ?? find(dock);
    // A control that just locked cannot hold focus: the next one on in its card, else the seat's own row (a row never locks).
    if (el?.disabled) el = el.closest(".se-card, .se-head")?.querySelector("button:not(:disabled),input:not(:disabled)") ?? el.closest(".se-seat")?.querySelector("[data-se-row]") ?? root.querySelector("[data-se-row]");
    if (!el) return;
    el.focus({ preventScroll: true });
    if (sel && el.setSelectionRange && document.activeElement === el) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
    // The focus above told focusin the new field's own caret (its start); the next draw must put back the one just restored.
    if (document.activeElement === el) ui.lastFocus = { key, sel: selOf(el) };
  }
  // A draw owed while a pointer is down waits for its release: replacing the editor between press and release would swallow the click.
  let pressed = false, owed = false;
  document.addEventListener("pointerdown", (event) => {
    pressed = true;
    if (!event.target.closest?.("[data-setup-editor],[data-setup-editor-foot]")) ui.lastFocus = null;
    const s = ui.view && ed(ui.view.ctx.tab.id);
    if (s?.roleMenu && !event.target.closest?.("[data-se-rolemenu],[data-se-role]")) { s.roleMenu = null; owed = true; }
  }, true);
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => { pressed = false; if (owed) { owed = false; setTimeout(redraw); } }, true);
  function redrawSoon() { if (pressed) owed = true; else setTimeout(redraw); }

  // ---- editing ----
  function edit(fn) {
    const { tab, s } = cur();
    if (isLocked(tab)) return;
    if (!s.draft) s.draft = { ...copy(current(tab, s)), base: shapeOf(tab) };
    fn(s.draft, tab, s);
    s.error = "";
    if (!unsaved(tab, s)) s.draft = null;
    redraw();
  }
  function editQuiet(fn) {
    const { tab, s } = cur();
    if (isLocked(tab)) return;
    if (!s.draft) s.draft = { ...copy(current(tab, s)), base: shapeOf(tab) };
    fn(s.draft);
    if (!unsaved(tab, s)) s.draft = null;
    paintFoot();
  }
  // Typing a name (or a custom role) goes into the draft without drawing the editor again.
  const typeInto = (slot, field, value) => editQuiet((draft) => { const own = draft.crew.find((seat) => seat.slot === slot); if (own) own[field] = value; });
  // The draft's own entry for a seat (an override for a saved seat, the whole seat for a new one), with the live seat it stands on.
  function entryOf(draft, tab, slot) {
    const own = draft.crew.find((seat) => seat.slot === slot);
    return own ? { own, seat: own.fresh ? own : { ...tab.crew.find((live) => live.slot === slot), ...own } } : null;
  }
  // Every change a seat takes from the draft: a Planner that cannot run the process (by its CLI or its access) stops running it.
  function setSeat(slot, fields) {
    edit((draft, tab) => {
      const found = entryOf(draft, tab, slot);
      if (!found) return;
      Object.assign(found.own, fields);
      const merged = { ...found.seat, ...fields };
      if (merged.orchestrates && runReason(merged)) found.own.orchestrates = false;
    });
  }
  // A role programs the seat: its Can write default (the user can still flip it), and a Planner runs the process.
  function pickRole(slot, name) {
    const { state, s } = cur(), def = roleDef(state, name);
    s.roleMenu = null; ui.wantFocus = `se-role-${slot}`;
    if (name === null) { s.custom.add(slot); ui.wantFocus = `se-rolename-${slot}`; return setSeat(slot, { role: "", canWrite: false, orchestrates: false }); }
    s.custom.delete(slot);
    setSeat(slot, { role: name, canWrite: def ? def.canWrite : false, orchestrates: def?.runsProcess === true });
  }
  function addSeat() {
    const { tab, s } = cur();
    edit((draft) => {
      if (draft.crew.length >= MAX_SEATS) return;
      const slot = freeId(draft.crew.map((seat) => seat.slot), "seat");
      // Starts on a model the tab already runs, so it is valid before anyone picks one.
      const base = tab.crew.find((seat) => !seat.isLeader && !isAcp(seat.cli)) ?? tab.crew.find((seat) => !isAcp(seat.cli)) ?? tab.crew[0];
      draft.crew.push({ slot, name: "", role: "", cli: base.cli, model: base.model, effort: base.effort, canWrite: false, isLeader: false, fresh: true });
      s.open = slot; s.roleMenu = null; ui.wantFocus = `se-name-${slot}`; ui.reveal = slot;
    });
  }
  function removeSeat(slot) {
    const { s } = cur();
    s.open = null; s.custom.delete(slot); ui.wantFocus = "se-add";
    edit((draft) => { draft.crew = draft.crew.filter((seat) => seat.slot !== slot); });
  }
  // A new seat's model, effort and advisor (the page's menus in draft mode): an ACP CLI runs its own default; another keeps an effort it has.
  function pickModel(slot, fields) {
    const { tab, s } = cur(), entry = current(tab, s).crew.find((seat) => seat.slot === slot);
    if (!entry?.fresh) return;
    const next = { ...entry };
    if (fields.cli) { next.cli = fields.cli; if (!capOf(fields.cli)?.advisor) delete next.advisor; }
    if (fields.model) next.model = fields.model;
    if (fields.effort) next.effort = fields.effort;
    if ("advisor" in fields) { if (fields.advisor) next.advisor = fields.advisor; else delete next.advisor; }
    const efforts = capOf(next.cli)?.efforts ?? [];
    if (isAcp(next.cli)) { next.model = "default"; next.effort = "default"; }
    else if (efforts.length && !efforts.includes(next.effort)) next.effort = efforts.includes("medium") ? "medium" : efforts[0];
    edit((draft) => {
      const at = draft.crew.findIndex((seat) => seat.slot === slot);
      if (at < 0) return;
      draft.crew[at] = next;
      if (next.orchestrates && runReason(next)) next.orchestrates = false;
    });
  }
  // The menus get the seat as the draft has it now, every time they draw.
  const draftFor = (slot) => ({ seat: () => { const { tab, s } = cur(); return shownCrew(tab, s).find((seat) => seat.slot === slot && seat.fresh) ?? null; }, pick: (fields) => pickModel(slot, fields) });
  function sendAs(message, waiting) {
    const { tab, s, ctx } = cur();
    if (message.type === "saveSetup") message.requestId = crypto.randomUUID();
    if (isLocked(tab) || !ctx.send(message)) return false;
    s.error = "";
    s.waiting = { at: Date.now(), action: message.type, crewGenerationId: tab.processState?.crewGenerationId, requestId: message.requestId, ...waiting };
    setTimeout(redraw, ANSWER_MS + 100);
    return true;
  }
  // A switch waits for its answer with the draft still kept: Save must not send that draft over it.
  const switching = (s) => s.waiting?.action === "useSetup";
  function save() {
    const { tab, s } = cur();
    if (s.saving || switching(s) || !unsaved(tab, s)) return;
    const body = outgoing(tab, s);
    const added = shownCrew(tab, s).filter((seat) => seat.fresh);
    const note = added.length ? `${joinNames(added.map((seat) => seat.name))} added to the crew` : "Crew saved";
    if (!sendAs({ type: "setSetup", tabId: tab.id, crew: body.crew, lookPause: body.lookPause }, { added, note })) return;
    s.saving = true;
    redraw();
  }
  // Closes one open thing (a Cancel names which; Escape takes the innermost) and puts focus back on what opened it.
  function closeOne(s, only = null) {
    const is = (name) => only === null || only === name;
    if (is("roleMenu") && s.roleMenu) { ui.wantFocus = `se-role-${s.roleMenu}`; s.roleMenu = null; return true; }
    if (is("confirm") && s.confirm) { s.confirm = null; ui.wantFocus = "se-menu-switch"; return true; }
    if (is("menu") && s.menu) { ui.wantFocus = `se-menu-${s.menu}`; s.menu = null; return true; }
    if (is("open") && s.open) { ui.wantFocus = `se-row-${s.open}`; s.open = null; return true; }
    return false;
  }

  Object.assign(SE, {
    MAX_SEATS, NEW_NAME, ui, esc, plural, isAcp, selOf, ed, cur, isLocked, rolesOf, roleDef, hasAuto, current, seatOf, crewOf, shownCrew, liveSetup, shapeOf,
    unsaved, leaderOf, plannerOf, capOf, runReason, render, redraw, redrawSoon, edit, typeInto, setSeat, pickRole, addSeat, removeSeat, draftFor, sendAs, save,
    closeOne, showNote, switching,
  });
})();
