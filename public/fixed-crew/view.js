// Fixed crew (Pack 26, Block 2b): the drawing. Settings gets one live section per tab, built once and then updated in place, so
// typing, the caret, focus, open Instructions and the scroll position survive every state broadcast. User and server text is
// only ever written with textContent or a field's value, never through HTML.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});
  const GROUPS = [["Planning", "Leads the work and plans it"], ["Making", "Builds what the plan asks for"], ["Checking", "Reviews and fixes the work"]];
  const SAME_LABEL = { 1: "odd rounds", 2: "even rounds" };

  FC.createView = (page, store) => {
    const roots = new Map(); // tabId -> its live Settings section
    const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const definitions = () => (Array.isArray(page.state?.fixedCrewDefinitions) ? page.state.fixedCrewDefinitions : []);
    // Two positions the server names alike (its two reviewers and two fixers) are told apart by their round.
    function label(def) {
      const twins = definitions().filter((other) => other.label === def.label).length > 1;
      const round = SAME_LABEL[def.slot.slice(-1)];
      return twins && round ? `${def.label} · ${round}` : def.label;
    }
    const preference = (tab, slot) => tab?.fixedCrew?.preferences?.[slot] ?? { assignment: null, source: "auto" };
    function modelText(assignment, tab) { return assignment ? page.modelLine(assignment.cli, assignment.model, assignment.effort, tab) : "Choose a model"; }
    function sourceText(pref) {
      const assignment = pref.assignment;
      if (!assignment) return pref.source === "user" ? "No model assigned · you cleared it" : "No model assigned";
      const advisor = assignment.advisor ? ` · advisor ${page.formatModel(assignment.cli, assignment.advisor)}` : "";
      return `${pref.source === "user" ? "Your choice" : "Automatic"} · ${page.cliLabel(assignment.cli)}${advisor}`;
    }
    // An automatic pick on a CLI whose access Command Center cannot confirm (OpenCode models, ACP defaults) asks the user to check it.
    function needsCheck(pref) {
      const cli = pref.assignment?.cli;
      return pref.source === "auto" && Boolean(cli) && (cli === "opencode" || page.isAcpCli(cli));
    }
    function row(tab, slot) {
      const key = store.keyOf(tab.id, slot);
      return { tabId: tab.id, slot, key, modelKey: `${key}|model`, busy: Boolean(tab.fixedCrew?.busy?.[slot]), saving: store.pending(key), modelSaving: store.pending(`${key}|model`) };
    }
    function statusText(outcome, dirty) {
      if (outcome?.status === "saving" || outcome?.status === "refused" || outcome?.status === "unknown" || outcome?.status === "failed") return outcome.status === "refused" ? `Not saved: ${outcome.message}` : outcome.message;
      if (dirty) return "Not saved yet";
      return outcome?.status === "saved" ? "Saved" : "";
    }

    function buildRow(tabId, def) {
      const el = node("div", "fc-row"); el.dataset.fcRow = def.slot;
      const main = node("div", "fc-main"), info = node("div", "d");
      info.append(node("b", "fc-label"), node("small", "fc-source"));
      const chip = node("button", "chipb fc-model"); chip.type = "button"; chip.dataset.fcModel = def.slot; chip.dataset.focusKey = `fc-model-${def.slot}`; chip.setAttribute("aria-haspopup", "dialog");
      chip.append(node("span", "fc-logo"), node("span", "fc-model-text"));
      main.append(info, chip);
      const notice = node("p", "fc-note fc-notice"), check = node("p", "fc-note fc-check", "Check that you can use this model."), busy = node("p", "fc-note fc-busy", "Working now. Its model and instructions can change when it finishes.");
      const status = node("p", "fc-status"); status.setAttribute("role", "status"); status.dataset.fcModelStatus = def.slot;
      const toggle = node("button", "fc-more"); toggle.type = "button"; toggle.dataset.fcToggle = def.slot; toggle.dataset.focusKey = `fc-toggle-${def.slot}`;
      toggle.id = `fc-toggle-${tabId}-${def.slot}`; toggle.setAttribute("aria-controls", `fc-panel-${tabId}-${def.slot}`); toggle.append(node("span", "", "Instructions"), node("span", "fc-chev"));
      toggle.lastChild.innerHTML = page.icons.chev ?? "";
      const panel = node("div", "fc-panel"); panel.id = `fc-panel-${tabId}-${def.slot}`; panel.hidden = true; panel.setAttribute("role", "region"); panel.setAttribute("aria-labelledby", toggle.id);
      const core = node("div", "fc-core"); core.append(node("span", "lbl", "Built in, read-only"), node("p", "fc-core-text"), node("p", "fc-guidance"));
      const field = `fc-extra-${tabId}-${def.slot}`;
      const name = node("label", "lbl", "Your extra instructions"); name.htmlFor = field;
      const textarea = node("textarea", "inp fc-extra"); textarea.id = field; textarea.rows = 3; textarea.dataset.fcExtra = def.slot; textarea.dataset.focusKey = `fc-extra-${def.slot}`; textarea.spellcheck = true;
      textarea.placeholder = "Anything this position should always keep in mind";
      const acts = node("div", "fc-acts"), extraStatus = node("span", "action-status fc-extra-status"); extraStatus.setAttribute("aria-live", "polite"); extraStatus.dataset.fcExtraStatus = def.slot;
      const reset = node("button", "btn sm", "Reset"); reset.type = "button"; reset.dataset.fcReset = def.slot; reset.dataset.focusKey = `fc-reset-${def.slot}`;
      const save = node("button", "btn sm primary", "Save"); save.type = "button"; save.dataset.fcSave = def.slot; save.dataset.focusKey = `fc-save-${def.slot}`;
      acts.append(extraStatus, reset, save);
      panel.append(core, name, textarea, acts);
      el.append(main, notice, check, busy, status, toggle, panel);
      return el;
    }
    function buildRoot(tab) {
      const root = node("section", "settings-section fc"); root.id = "s-crew"; root.dataset.section = "crew"; root.dataset.fcTab = tab.id;
      const head = node("h3"); head.append(node("span", "fc-title"));
      const auto = node("button", "btn sm", "Auto assign"); auto.type = "button"; auto.dataset.fcAuto = ""; auto.dataset.focusKey = "fc-auto"; head.append(auto);
      const bulk = node("button", "btn sm", "Use one model for all positions"); bulk.type = "button"; bulk.dataset.fcBulk = ""; bulk.dataset.focusKey = "fc-bulk"; bulk.setAttribute("aria-haspopup", "dialog"); head.insertBefore(bulk, auto);
      const intro = node("p", "settings-help fc-intro", "Every position is ready, and the leader calls the ones a task needs. Choose a model for each, or let Auto assign pick from the AI tools you have. Auto assign keeps the models you chose.");
      const autoStatus = node("p", "fc-status fc-auto-status"); autoStatus.setAttribute("role", "status");
      const bulkStatus = node("p", "fc-status fc-bulk-status"); bulkStatus.setAttribute("role", "status");
      const notice = node("p", "fc-recovery"); notice.hidden = true;
      root.append(head, intro, autoStatus, bulkStatus, notice);
      for (const [group, about] of GROUPS) {
        const box = node("div", "fc-group"); box.dataset.fcGroup = group;
        const title = node("div", "fc-ghead"); title.append(node("h4", "", group), node("small", "", about));
        const list = node("div", "card fc-list");
        for (const def of definitions().filter((item) => item.group === group)) list.append(buildRow(tab.id, def));
        box.append(title, list); root.append(box);
      }
      return root;
    }

    function updateRow(el, tab, def) {
      const pref = preference(tab, def.slot), state = row(tab, def.slot), assignment = pref.assignment;
      el.querySelector(".fc-label").textContent = label(def);
      el.querySelector(".fc-source").textContent = sourceText(pref);
      el.classList.toggle("unassigned", !assignment);
      const chip = el.querySelector(".fc-model");
      chip.querySelector(".fc-logo").innerHTML = assignment ? page.logo(assignment.cli, 13, 0) : "";
      chip.querySelector(".fc-model-text").textContent = modelText(assignment, tab);
      chip.disabled = state.busy || tab.fixedCrew.unavailable === true;
      if (chip.disabled && document.activeElement === chip) el.querySelector(".fc-more").focus({ preventScroll: true });
      chip.setAttribute("aria-label", `${label(def)}: ${assignment ? modelText(assignment, tab) : "No model assigned"}. ${assignment ? "Change" : "Choose a model"}`);
      const independence = def.reviews ? tab.fixedCrew.notices?.[def.slot] : null;
      const notice = el.querySelector(".fc-notice");
      notice.hidden = !independence?.message; notice.textContent = independence?.message ?? ""; notice.dataset.status = independence?.status ?? "";
      el.querySelector(".fc-check").hidden = !needsCheck(pref);
      el.querySelector(".fc-busy").hidden = !state.busy;
      el.querySelector(".fc-status").textContent = statusText(store.outcomes.get(state.modelKey), false);
      const open = store.expanded.has(state.key), toggle = el.querySelector(".fc-more"), panel = el.querySelector(".fc-panel");
      toggle.setAttribute("aria-expanded", String(open)); panel.hidden = !open;
      const prompt = store.prompts.get(def.slot);
      el.querySelector(".fc-core-text").textContent = prompt?.error ? `Could not load the built-in instructions: ${prompt.error}` : prompt?.core ?? "Loading…";
      el.querySelector(".fc-guidance").textContent = prompt?.guidance ?? "";
      const saved = tab.fixedCrew.roleExtras?.[def.slot] ?? "", textarea = el.querySelector(".fc-extra");
      const extraText = store.extraText(state.key, saved);
      if (textarea.value !== extraText) {
        textarea.value = extraText;
      }
      const dirty = store.isDirty(state.key);
      el.querySelector("[data-fc-save]").disabled = !dirty || state.saving || state.busy;
      el.querySelector("[data-fc-reset]").disabled = (!saved && !dirty) || state.saving || state.busy;
      const extraStatus = el.querySelector(".fc-extra-status"), outcome = store.outcomes.get(state.key);
      extraStatus.textContent = statusText(outcome, dirty); extraStatus.dataset.status = outcome?.status === "refused" || outcome?.status === "failed" ? "failed" : outcome?.status === "saved" && !dirty ? "done" : "";
    }
    function update(root, tab) {
      root.querySelector(".fc-title").textContent = `Crew and models · ${page.tabLabel(tab.id) || tab.name}`;
      const unavailable = tab.fixedCrew.unavailable === true, recovery = root.querySelector(".fc-recovery");
      recovery.hidden = !(unavailable || tab.fixedCrew.notice); recovery.textContent = unavailable ? tab.fixedCrew.notice ?? "This crew is unavailable" : tab.fixedCrew.notice ?? "";
      const auto = root.querySelector("[data-fc-auto]"), autoKey = `${store.keyOf(tab.id, "*")}|model`;
      auto.disabled = unavailable || store.pending(autoKey);
      root.querySelector(".fc-auto-status").textContent = statusText(store.outcomes.get(autoKey), false);
      const bulkKey = `${store.keyOf(tab.id, "*")}|bulk`, bulk = root.querySelector("[data-fc-bulk]");
      bulk.disabled = unavailable || !page.connected() || !tab.fixedCrew.assignmentsDigest || store.pending(bulkKey);
      const outcome = store.outcomes.get(bulkKey);
      root.querySelector(".fc-bulk-status").textContent = outcome?.status === "saved" ? outcome.message : statusText(outcome, false);
      for (const group of root.querySelectorAll(".fc-group")) group.hidden = unavailable;
      if (unavailable) return;
      for (const def of definitions()) { const el = root.querySelector(`[data-fc-row="${CSS.escape(def.slot)}"]`); if (el) updateRow(el, tab, def); }
    }
    // The live section for a tab, updated to the latest state. A tab that left the state takes its section with it.
    function section(tab) {
      const ids = new Set((page.state?.projects ?? []).flatMap((project) => project.tabs.map((item) => item.id)));
      for (const id of roots.keys()) if (!ids.has(id)) roots.delete(id);
      let root = roots.get(tab.id);
      const slots = definitions().map((def) => def.slot).join(",");
      if (!root || root.dataset.slots !== slots) { root = buildRoot(tab); root.dataset.slots = slots; roots.set(tab.id, root); FC.bindSection?.(root); }
      update(root, tab);
      return root;
    }
    const rootOf = (tabId) => roots.get(tabId) ?? null;

    // A fixed tab's rail: how many positions have a model, and the way to choose them. Its chat, runs and task panel (task-view.js)
    // are the page's own; only a crew whose saved data this version cannot use hides the chat (crew.css, .fixed-unavailable).
    function renderTab(tab, box) {
      const fixed = Boolean(tab?.fixedCrew), stage = page.$("stage");
      stage?.classList.toggle("fixed-crew", fixed);
      stage?.classList.toggle("fixed-unavailable", fixed && tab.fixedCrew.unavailable === true);
      if (!fixed) return false;
      const defs = definitions(), assigned = defs.filter((def) => preference(tab, def.slot).assignment).length;
      const rail = node("div", "fc-rail");
      rail.append(node("b", "", `${defs.length} positions`), node("small", "", `${assigned} of ${defs.length} positions have a model`));
      const open = node("button", "btn sm", "Choose models"); open.type = "button"; open.id = "fcRailSettings";
      rail.append(open); box.append(rail);
      return true;
    }

    return { section, rootOf, renderTab, label, preference, modelText, sourceText, needsCheck, row, definitions, groups: GROUPS, statusText };
  };
})();
