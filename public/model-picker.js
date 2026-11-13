// The model menu (the #pop popover), moved out of the page script (public/app/*.js). That script loads after this file and builds it once with
// window.CC_PICKER(page): `page` is how it reaches the rest of the page (its popover layers and look-ups). Only the fixed crew opens it: a Settings
// position (public/fixed-crew/events.js) or a creation draft (public/fixed-crew/project-dialog.js), each through an adapter
// { tab, seat, locked, pick, clear, hints }. The menu shows adapter.seat(), asks adapter.locked() every time an action runs, and hands the pick to
// adapter.pick or adapter.clear. Settings sends the assignment; a creation draft keeps it local until Create. Nothing here talks to the server.
(() => {
  "use strict";
  window.CC_PICKER = (page) => {
    const { $, esc } = page;
    let open = null; // { adapter } of the open model menu, so a state message can draw it again (refresh)

    // The seat's own CLI first, then every other usable one from the server's list (state.clis): any seat can take any CLI, an ACP one included.
    function pickerClis(seat) {
      const usable = (cap) => cap.id === seat.cli || cap.installed === true; // null is "not checked yet": not offered
      const ids = page.cliCaps().filter((cap) => usable(cap)).map((cap) => cap.id);
      if (seat.cli && !ids.includes(seat.cli)) ids.push(seat.cli); // a fixed crew position with no model has no CLI of its own
      return ids.sort((a, b) => Number(b === seat.cli) - Number(a === seat.cli));
    }
    function modelRows(seat, query, tab = null) {
      const q = query.trim().toLowerCase(), typed = query.trim();
      let total = 0;
      const html = pickerClis(seat).map((cli) => {
        const values = page.modelOptions(cli); if (cli === seat.cli && seat.model && !values.includes(seat.model)) values.unshift(seat.model);
        total += values.length;
        const listed = values.filter((model) => !q || model.toLowerCase().includes(q) || page.formatModel(cli, model, cli === seat.cli ? tab : null).toLowerCase().includes(q));
        const custom = typed && page.customModelPattern(cli)?.test(typed) && !values.includes(typed);
        if (!listed.length && !custom) return "";
        return `<div class="grp" data-grp="${esc(cli)}">${page.logo(cli, 12, 0)} ${esc(page.cliLabel(cli))}${cli === seat.cli ? " · this seat" : ""}</div>${listed.map((model) => `<button type="button" class="opt" data-model="${esc(model)}" data-cli="${esc(cli)}" title="${esc(model)}" aria-pressed="${String(cli === seat.cli && model === seat.model)}">${page.logo(cli, 12, 3)}<span class="nm"><span>${esc(page.isAcpCli(cli) ? "CLI default" : page.formatModel(cli, model))}</span>${page.isAcpCli(cli) ? `<small>${esc(`CLI default · ${page.acpShownModel(cli, cli === seat.cli ? tab : null) ?? "model shown after first use"}`)}</small>` : page.modelSupportsEffort(cli, model) ? "" : "<small>No effort setting</small>"}</span>${page.icons.tick}</button>`).join("")}${custom ? `<button type="button" class="opt" data-model="${esc(typed)}" data-cli="${esc(cli)}"><span class="nm"><span>Use ${esc(typed)}</span><small>Not in the list. The server checks it when you save.</small></span></button>` : ""}`;
      }).join("");
      return html || `<div class="nores">${total ? "No match. Type a full id like gpt-6-sol or provider/model to use it." : "No models are available from the server."}</div>`;
    }
    const ADAPTER_FUNCTIONS = ["tab", "seat", "locked", "pick", "clear", "hints"];
    const usableAdapter = (adapter) => Boolean(adapter) && ADAPTER_FUNCTIONS.every((name) => typeof adapter[name] === "function");
    // The one place a pick leaves the menu. It reads the adapter's CURRENT lock when the action runs, so a menu, a listener or a confirmation kept
    // open from before the position got busy does nothing.
    const chooser = (adapter) => {
      const act = (run) => { if (!adapter.locked()) run(); };
      return { pick: (fields) => act(() => adapter.pick(fields)), clear: () => act(() => adapter.clear()) };
    };
    // Drawn again on every state broadcast while open, so the tick and the effort row follow the server and never a local guess.
    function drawModelPicker(tab, seat, anchor, adapter, refresh = false) {
      // A seat with no CLI yet has no effort to show.
      const pop = $("pop"), locked = adapter.locked(), choose = chooser(adapter);
      const keep = refresh ? { query: $("mq")?.value ?? "", scroll: $("mrows")?.scrollTop ?? 0, key: pop.contains(document.activeElement) ? page.focusKeyOf(document.activeElement) : null, caret: document.activeElement?.id === "mq" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null } : null;
      pop.setAttribute("aria-label", `Choose model and effort for ${seat.name}`);
      const efforts = page.effortOptions(seat.cli), hasEffort = Boolean(seat.cli) && page.modelSupportsEffort(seat.cli, seat.model) && efforts.length > 0;
      const noEffort = seat.cli ? `<div class="hint">${esc(page.formatModel(seat.cli, seat.model, tab))} has no effort setting.</div>` : "";
      const clear = adapter.modelOnly ? "" : `<button type="button" class="opt" data-clear-model aria-pressed="${String(!seat.cli)}"><span class="nm"><span>No model</span><small>Leave this position without a model</small></span>${page.icons.tick}</button>`;
      const hints = adapter.hints(seat).map((text) => `<div class="hint">${esc(text)}</div>`).join("");
      pop.innerHTML = `<div class="msearch"><input class="inp" id="mq" type="search" aria-label="Search models" placeholder="Search models" autocomplete="off"></div>${clear}<div class="mscroll" id="mrows">${modelRows(seat, keep?.query ?? "", tab)}</div>${hasEffort ? `<div class="grp">Effort</div><div class="effort" role="radiogroup" aria-label="Effort">${efforts.map((effort) => `<button type="button" role="radio" aria-checked="${String(seat.effort === effort)}" data-effort="${esc(effort)}">${esc(effort)}</button>`).join("")}</div>` : noEffort}${hints}`;
      const lockPicker = () => { if (!locked) return; pop.querySelectorAll("[data-model],[data-effort],[data-clear-model]").forEach((button) => { button.disabled = true; button.setAttribute("aria-disabled", "true"); }); };
      if (locked) pop.insertAdjacentHTML("afterbegin", `<div class="hint" data-picker-locked>Locked while working. ${page.lockTip}</div>`);
      lockPicker();
      page.fixRadios(pop);
      // A creation pick changes no server state, so nothing would draw the menu again: it is drawn here, from the adapter.
      const redraw = () => { const live = open?.adapter === adapter ? adapter.seat() : null; if (live) drawModelPicker(adapter.tab() ?? tab, live, anchor, adapter, true); };
      const bindModels = () => pop.querySelectorAll("[data-model]").forEach((button) => button.addEventListener("click", () => {
        const fields = { model: button.dataset.model };
        if (button.dataset.cli !== seat.cli) fields.cli = button.dataset.cli;
        if (fields.cli && page.isAcpCli(fields.cli)) {
          // An ACP CLI can be picked only knowing it runs with Full access.
          const label = page.cliLabel(fields.cli);
          page.confirmAction({ title: `Use ${label} as ${seat.name}'s CLI?`, body: seat.isLeader ? `${label} may edit files and run commands without asking. Command Center cannot make it ask yet, so Ask, Accept and Plan are not available with it. You can switch back to another CLI at any time.` : `${label} may edit files and run commands without asking, and Command Center cannot hold it read-only. You can switch back to another CLI at any time.`, ok: "Use with Full access", danger: true }, () => { choose.pick(fields); redraw(); }, button);
          return;
        }
        choose.pick(fields);
        redraw();
      }));
      bindModels();
      $("mq").addEventListener("input", () => { $("mrows").innerHTML = modelRows(seat, $("mq").value, tab); bindModels(); lockPicker(); });
      pop.querySelectorAll("[data-effort]").forEach((button) => button.addEventListener("click", () => { choose.pick({ effort: button.dataset.effort }); page.setLayer(pop, false); }));
      pop.querySelector("[data-clear-model]")?.addEventListener("click", () => { choose.clear(); page.setLayer(pop, false); });
      if (!keep) return;
      $("mq").value = keep.query; $("mrows").scrollTop = keep.scroll;
      let target = keep.key ? pop.querySelector(keep.key) : null;
      if (target?.disabled) target = $("mq");
      if (target) { target.focus({ preventScroll: true }); if (keep.caret && target.setSelectionRange) try { target.setSelectionRange(keep.caret[0], keep.caret[1]); } catch { /* not a text field */ } }
      page.placePopover(pop);
    }
    // Only a complete fixed adapter opens the menu: without one nothing is drawn, opened or sent.
    function openModelPicker(tab, seat, anchor, adapter) {
      if (!usableAdapter(adapter)) return;
      open = { adapter };
      drawModelPicker(tab, seat, anchor, adapter);
      page.openPopover($("pop"), anchor, Boolean(anchor?.closest?.("#crew")));
      $("mq").focus({ preventScroll: true });
      $("mrows").querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
    }
    // After a state message: the open model menu follows its position (from the server, or from the creation draft), and closes if it is gone.
    function refreshModelPicker() {
      const pop = $("pop");
      if (pop.hidden || !open || !pop.querySelector("#mq")) return;
      const tab = open.adapter.tab(), seat = tab ? open.adapter.seat() : null;
      if (!tab || !seat) page.setLayer(pop, false, null, false, false);
      else drawModelPicker(tab, seat, pop._anchor, open.adapter, true);
    }

    return { pickerClis, modelRows, openModelPicker, refreshModelPicker };
  };
})();
