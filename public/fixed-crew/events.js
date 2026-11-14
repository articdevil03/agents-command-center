// Fixed crew (Pack 26, Block 2b): what the controls send and what the replies change. The page script calls
// window.CC_FIXED_CREW.init(page) once (public/app/11-settings-render.js); `page` is how this reaches the page's own helpers.
// Every message is the server's real contract from Block 2a; every reply is matched to its own requestId.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});

  FC.init = (page) => {
    // The classic page exposes this catalogue globally; older fixed-crew adapters omit it.
    page.modelOptions ??= window.modelOptions;
    const refresh = () => { if (!page.$("setModal").hidden) page.renderSettings(); };
    const store = FC.createState(page.connected, refresh);
    const view = FC.createView(page, store);

    // The effort a new pick starts with: the current one when the CLI stays the same, else medium, else the CLI's first.
    function chooseEffort(cli, current) {
      if (page.isAcpCli(cli)) return "default";
      const efforts = page.effortOptions(cli);
      if (current?.cli === cli && efforts.includes(current.effort)) return current.effort;
      return efforts.includes("medium") ? "medium" : efforts[0];
    }
    // A pick from the shared model menu ({ model, cli? } or { effort }) made into a whole assignment. An advisor stays only on its own CLI.
    function assignmentFrom(fields, current) {
      if (Object.hasOwn(fields, "advisor")) {
        if (!current || !page.cliCap(current.cli)?.advisor) return null;
        const next = { ...current };
        if (fields.advisor === "") delete next.advisor;
        else next.advisor = fields.advisor;
        return next;
      }
      if (fields.effort) return current ? { ...current, effort: fields.effort } : null;
      const cli = fields.cli ?? current?.cli;
      if (!cli || typeof fields.model !== "string") return null;
      const next = { cli, model: fields.model, effort: chooseEffort(cli, current) };
      if (current?.advisor && current.cli === cli) next.advisor = current.advisor;
      return next;
    }
    const seatOf = (def, assignment) => ({ slot: def.slot, name: view.label(def), cli: assignment?.cli ?? null, model: assignment?.model ?? "", effort: assignment?.effort ?? "", advisor: assignment?.advisor, isLeader: def.slot === "leader", canWrite: def.canWrite === true });
    function hints(seat) {
      const list = [];
      if (!seat.cli) list.push("No model assigned yet. Pick one above, or leave it for Auto assign.");
      else if (page.isAcpCli(seat.cli)) list.push(`${page.cliLabel(seat.cli)} runs with Full access only: it may edit files and run commands without asking.`);
      else if (!seat.canWrite && page.cliCap(seat.cli)?.readOnlyEnforced === false) list.push(`${page.cliLabel(seat.cli)} cannot be held read-only: it may edit files and run commands without asking.`);
      list.push("Saved for this tab.");
      return list;
    }
    const definition = (slot) => view.definitions().find((def) => def.slot === slot) ?? null;

    function sendRow(row, type, fields, key, kind) {
      if (row.busy) return;
      const requestId = page.newRequestId();
      store.begin(requestId, key, kind);
      if (!page.send({ type, requestId, tabId: row.tabId, ...fields })) store.notSent(requestId);
      refresh();
    }
    function settingsPicker(tabId, slot) {
      const tab = () => page.findTab(tabId);
      const current = () => tab()?.fixedCrew?.preferences?.[slot]?.assignment ?? null;
      const change = (type, fields) => { const live = tab(); if (live?.fixedCrew) { const row = view.row(live, slot); sendRow(row, type, { slot, ...fields }, row.modelKey, "crew"); } };
      return {
        tab, hints, locked: () => Boolean(tab()?.fixedCrew?.busy?.[slot]),
        seat: () => (tab()?.fixedCrew && definition(slot) ? seatOf(definition(slot), current()) : null),
        pick: (fields) => { const assignment = assignmentFrom(fields, current()); if (assignment) change("setCrewAssignment", { assignment }); },
        clear: () => change("clearCrewAssignment", {}),
      };
    }
    function openPicker(tab, slot, anchor) {
      const adapter = settingsPicker(tab.id, slot), seat = adapter.seat();
      if (seat) page.togglePopover(page.$("pop"), anchor, () => page.openModelPicker(tab, seat, anchor, adapter));
    }
    function openBulk(tab, button) {
      const bulkKey = `${store.keyOf(tab.id, "*")}|bulk`;
      if (store.pending(bulkKey) || button.disabled) return;
      const digest = tab.fixedCrew.assignmentsDigest;
      const live = () => page.findTab(tab.id);
      const locked = () => !page.connected() || page.state?.selectedTabId !== tab.id || page.$("setModal").hidden
        || !page.$("setModal").contains(button) || live()?.fixedCrew?.unavailable === true
        || !digest || live()?.fixedCrew?.assignmentsDigest !== digest;
      const adapter = {
        tab: live, modelOnly: true, seat: () => ({ name: "all positions", cli: null, model: "", canWrite: true }),
        locked: () => locked() || button.disabled || store.pending(bulkKey),
        hints: () => ["Working positions will be kept. Extra instructions will stay."], clear: () => {},
        pick(fields) {
          if (locked()) return;
          if (store.pending(bulkKey) || button.disabled) return;
          const cli = fields.cli, model = fields.model;
          if (!cli || typeof model !== "string") return;
          const replacesChoices = Object.entries(live().fixedCrew.preferences).some(([slot, pref]) => !live().fixedCrew.busy?.[slot]
            && pref.source === "user" && (!pref.assignment || pref.assignment.cli !== cli || pref.assignment.model !== model));
          const submit = () => {
            if (locked()) return;
            if (button.disabled || store.pending(bulkKey)) return;
            const requestId = page.newRequestId();
            const bulkMessage = { type: "setCrewModelForAll", requestId, tabId: tab.id, cli, model, expectedAssignmentsDigest: digest, confirmReplace: replacesChoices };
            store.begin(requestId, bulkKey, "crew");
            const sent = page.send(bulkMessage);
            if (!sent) store.notSent(requestId);
            page.setLayer(page.$("pop"), false);
            refresh();
          };
          if (replacesChoices) {
            page.confirmAction({ title: "Use one model for all positions?", body: "Replace the models you chose for this tab? Working positions will be kept. Extra instructions will stay.", ok: "Replace models" }, submit, button);
          } else submit();
        },
      };
      if (!locked()) page.togglePopover(page.$("pop"), button, () => page.openModelPicker(tab, adapter.seat(), button, adapter));
    }
    function autoAssign(tab) {
      const key = `${store.keyOf(tab.id, "*")}|model`;
      if (store.pending(key)) return;
      const requestId = page.newRequestId();
      store.begin(requestId, key, "crew");
      if (!page.send({ type: "autoAssignCrew", requestId, tabId: tab.id })) store.notSent(requestId);
      refresh();
    }
    function saveExtra(tab, slot, reset) {
      const row = view.row(tab, slot);
      if (row.saving) return;
      const text = store.extraText(row.key, tab.fixedCrew.roleExtras?.[slot] ?? "");
      sendRow(row, reset ? "resetCrewRoleExtra" : "setCrewRoleExtra", reset ? { slot } : { slot, text }, row.key, "extra");
    }
    // The built-in instructions are fetched when a position's Instructions first open (and again after a failure).
    function toggleInstructions(tab, slot) {
      const key = store.keyOf(tab.id, slot);
      if (store.expanded.has(key)) store.expanded.delete(key); else store.expanded.add(key);
      const prompt = store.prompts.get(slot), asked = [...store.promptRequests.values()].includes(slot);
      if (store.expanded.has(key) && (!prompt || prompt.error) && !asked) {
        const requestId = page.newRequestId();
        store.promptRequests.set(requestId, slot);
        if (!page.send({ type: "getCrewRolePrompt", requestId, slot })) { store.promptRequests.delete(requestId); store.prompts.set(slot, { error: "not connected" }); }
      }
      refresh();
    }

    FC.bindSection = (root) => {
      root.addEventListener("click", (event) => {
        const button = event.target.closest?.("button"), tab = page.findTab(root.dataset.fcTab);
        if (!button || !root.contains(button) || button.disabled || !tab?.fixedCrew) return;
        const data = button.dataset;
        if (data.fcModel) openPicker(tab, data.fcModel, button);
        else if (data.fcBulk !== undefined) openBulk(tab, button);
        else if (data.fcAuto !== undefined) autoAssign(tab);
        else if (data.fcToggle) toggleInstructions(tab, data.fcToggle);
        else if (data.fcSave) saveExtra(tab, data.fcSave, false);
        else if (data.fcReset) saveExtra(tab, data.fcReset, true);
      });
      root.addEventListener("change", (event) => {
        const control = event.target.closest?.("[data-fc-advisor]"), tab = page.findTab(root.dataset.fcTab);
        if (!control || !root.contains(control) || control.disabled || control.hidden || !tab?.fixedCrew || tab.fixedCrew.unavailable) return;
        const slot = control.dataset.fcAdvisor, current = view.preference(tab, slot).assignment, row = view.row(tab, slot);
        if (!current?.model || current.cli !== control.dataset.cli || !page.cliCap(current.cli)?.advisor || row.busy || row.saving || row.modelSaving) return;
        settingsPicker(tab.id, slot).pick({ advisor: control.value });
      });
      root.addEventListener("input", (event) => {
        const area = event.target.closest?.("[data-fc-extra]"), tab = page.findTab(root.dataset.fcTab);
        if (!area || !tab?.fixedCrew) return;
        const slot = area.dataset.fcExtra;
        store.typeExtra(store.keyOf(tab.id, slot), area.value, tab.fixedCrew.roleExtras?.[slot] ?? "");
        view.section(tab); // the buttons and the unsaved line follow the typing; the field itself is left alone
      });
    };

    const dialog = FC.createDialog(page, store, view, { assignmentFrom, seatOf, hints, definition });
    const tasks = FC.createTaskEvents(page, view);
    const openCrew = (event) => { const button = event.target.closest?.("#fcRailSettings,#fcWorkSettings"); if (button) page.openSettings(button, "crew"); };
    page.$("crew").addEventListener("click", openCrew);
    page.$("fixedView")?.addEventListener("click", openCrew);

    // true: a reply only this file understands, already applied; the page redraws Settings. false: the page's own handling goes on.
    function onMessage(message) {
      if (tasks.onMessage(message)) { page.renderStatus(); return true; }
      if (message.type === "state") {
        if ([...store.prompts.values()].some((prompt) => prompt.defaultsVersion !== undefined && prompt.defaultsVersion !== message.crewDefaultsVersion)) store.prompts.clear();
        store.resolveFromState(message);
        return false;
      }
      if (message.type === "crewRolePrompt") {
        const slot = store.promptRequests.get(message.requestId);
        if (!slot) return false;
        store.promptRequests.delete(message.requestId);
        store.prompts.set(slot, { core: String(message.core ?? ""), guidance: String(message.guidance ?? ""), defaultsVersion: message.defaultsVersion });
        return true;
      }
      if (message.type === "crewAssignmentsPreview") return dialog.onPreview(message);
      if (message.type !== "actionResult" && message.type !== "error") return false;
      if (typeof message.requestId !== "string") return false;
      const promptSlot = store.promptRequests.get(message.requestId);
      if (promptSlot && message.type === "error") { store.promptRequests.delete(message.requestId); store.prompts.set(promptSlot, { error: message.message ?? "refused" }); return true; }
      if (message.type === "error" && dialog.onPreviewError(message)) return true;
      store.settle(message.requestId, message.type === "actionResult", message.message, message);
      return false;
    }

    return {
      section: (tab) => view.section(tab), renderTab: (tab, box) => view.renderTab(tab, box), renderTask: tasks.render, taskStatus: tasks.status, onMessage,
      openCreation: (which) => dialog.open(which), creationReady: () => dialog.ready(), creationFields: (which) => dialog.fields(which),
    };
  };
})();
