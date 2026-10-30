// The model and advisor menus (the #pop popover), moved out of the page script (public/app/*.js). That script loads after this file and builds them once with
// window.CC_PICKER(page): `page` is how they reach the rest of the page (its state, its socket, its popover layers). Used by a seat's card in
// the crew rail and by the crew editor in Settings.
// A seat the server already has takes a pick at once (updateSeat). A new seat in the crew editor is not on the server yet, so the editor
// opens the menus with a draft ({ seat, pick }): the menu shows draft.seat() and hands each pick to draft.pick; Save sends it all later.
(() => {
  "use strict";
  window.CC_PICKER = (page) => {
    const { $, esc } = page;
    let open = null; // { tabId, slot, fromCard, draft } of the open model menu, so a state message can draw it again (refresh)

    // The seat's own CLI first, then every other usable one from the server's list (state.clis): any seat can take any CLI, an ACP one included.
    function pickerClis(seat) {
      const usable = (cap) => cap.id === seat.cli || cap.installed === true; // null is "not checked yet": not offered
      const ids = page.cliCaps().filter((cap) => usable(cap)).map((cap) => cap.id);
      if (!ids.includes(seat.cli)) ids.push(seat.cli);
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
    function pickerHints(seat, locked) {
      const hints = [];
      if (seat.isLeader) {
        hints.push("Switching to another CLI starts a fresh session. The chat stays.");
        if (seat.cli === "codex") hints.push("Codex skips asking for commands it considers safe.");
        if (seat.cli === "opencode") hints.push("Plan blocks edits, but a shell command can still write.");
        if (page.isAcpCli(seat.cli)) hints.push(`${page.cliLabel(seat.cli)} runs with Full access only: it may edit files and run commands without asking.`);
        hints.push(seat.cli === "claude" ? "A model change applies right away, or after the current answer if one is running." : "A model change applies from the next turn.");
      } else if (!locked) hints.push("Applies to the next run.");
      if (!seat.isLeader && page.cliCap(seat.cli)?.readOnlyEnforced === false) hints.push(`${page.cliLabel(seat.cli)} cannot be held read-only: it may edit files and run commands without asking.`);
      return hints.map((text) => `<div class="hint">${esc(text)}</div>`).join("");
    }
    // A pick goes to the server for a seat it has, to the draft for a new one.
    const chooser = (tab, seat, draft) => (fields) => draft ? draft.pick(fields) : page.send({ type: "updateSeat", tabId: tab.id, slot: seat.slot, ...fields });
    // Drawn again on every state broadcast while open, so the tick and the effort row follow the server and never a local guess.
    function drawModelPicker(tab, seat, anchor, fromCard, refresh = false, draft = null) {
      const pop = $("pop"), locked = page.seatLocked(tab, seat), choose = chooser(tab, seat, draft);
      const keep = refresh ? { query: $("mq")?.value ?? "", scroll: $("mrows")?.scrollTop ?? 0, key: pop.contains(document.activeElement) ? page.focusKeyOf(document.activeElement) : null, caret: document.activeElement?.id === "mq" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null } : null;
      pop.setAttribute("aria-label", `Choose model and effort for ${seat.name}`);
      const efforts = page.effortOptions(seat.cli), hasEffort = page.modelSupportsEffort(seat.cli, seat.model) && efforts.length > 0;
      pop.innerHTML = `${fromCard ? `<button type="button" class="back" data-pop-back style="margin:4px">${page.icons.back}<span>${esc(seat.name)}</span></button>` : ""}<div class="msearch"><input class="inp" id="mq" type="search" aria-label="Search models" placeholder="Search models" autocomplete="off"></div><div class="mscroll" id="mrows">${modelRows(seat, keep?.query ?? "", tab)}</div>${hasEffort ? `<div class="grp">Effort</div><div class="effort" role="radiogroup" aria-label="Effort">${efforts.map((effort) => `<button type="button" role="radio" aria-checked="${String(seat.effort === effort)}" data-effort="${esc(effort)}">${esc(effort)}</button>`).join("")}</div>` : `<div class="hint">${esc(page.formatModel(seat.cli, seat.model, tab))} has no effort setting.</div>`}${pickerHints(seat, locked)}`;
      const lockPicker = () => { if (!locked) return; pop.querySelectorAll("[data-model],[data-effort]").forEach((button) => { button.disabled = true; button.setAttribute("aria-disabled", "true"); }); };
      if (locked) pop.insertAdjacentHTML("afterbegin", `<div class="hint" data-picker-locked>Locked while working. ${page.lockTip}</div>`);
      lockPicker();
      page.fixRadios(pop);
      // A draft pick changes no server state, so nothing would draw the menu again: it is drawn here, from the draft.
      const redrawDraft = () => { if (draft && open?.draft === draft && draft.seat()) drawModelPicker(tab, draft.seat(), anchor, fromCard, true, draft); };
      const bindModels = () => pop.querySelectorAll("[data-model]").forEach((button) => button.addEventListener("click", () => {
        const fields = { model: button.dataset.model };
        if (button.dataset.cli !== seat.cli) fields.cli = button.dataset.cli;
        if (fields.cli && page.isAcpCli(fields.cli)) {
          // An ACP CLI can be picked only knowing it runs with Full access.
          const label = page.cliLabel(fields.cli);
          page.confirmAction({ title: `Use ${label} as ${seat.name}'s CLI?`, body: seat.isLeader ? `${label} may edit files and run commands without asking. Command Center cannot make it ask yet, so Ask, Accept and Plan are not available with it. You can switch back to another CLI at any time.` : `${label} may edit files and run commands without asking, and Command Center cannot hold it read-only. You can switch back to another CLI at any time.`, ok: "Use with Full access", danger: true }, () => { choose({ ...fields, confirm: true }); redrawDraft(); }, button);
          return;
        }
        choose(fields);
        redrawDraft();
      }));
      bindModels();
      $("mq").addEventListener("input", () => { $("mrows").innerHTML = modelRows(seat, $("mq").value, tab); bindModels(); lockPicker(); });
      pop.querySelectorAll("[data-effort]").forEach((button) => button.addEventListener("click", () => { choose({ effort: button.dataset.effort }); page.setLayer(pop, false); }));
      pop.querySelector("[data-pop-back]")?.addEventListener("click", () => { page.setLayer(pop, false, null, false, false); page.reopenSeatCard(tab, seat, anchor); });
      if (!keep) return;
      $("mq").value = keep.query; $("mrows").scrollTop = keep.scroll;
      let target = keep.key ? pop.querySelector(keep.key) : null;
      if (target?.disabled) target = $("mq");
      if (target) { target.focus({ preventScroll: true }); if (keep.caret && target.setSelectionRange) try { target.setSelectionRange(keep.caret[0], keep.caret[1]); } catch { /* not a text field */ } }
      page.placePopover(pop);
    }
    function openModelPicker(tab, seat, anchor, fromCard = false, draft = null) {
      open = { tabId: tab.id, slot: seat.slot, fromCard, draft };
      drawModelPicker(tab, seat, anchor, fromCard, false, draft);
      page.openPopover($("pop"), anchor, Boolean(anchor?.closest?.("#crew")));
      $("mq").focus({ preventScroll: true });
      $("mrows").querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
    }
    // After a state message: the open model menu follows its seat (from the server, or from the draft), and closes if the seat is gone.
    function refreshModelPicker() {
      const pop = $("pop");
      if (pop.hidden || !open || !pop.querySelector("#mq")) return;
      const tab = page.findTab(open.tabId), seat = open.draft ? open.draft.seat() : page.seatFor(tab, open.slot);
      if (!tab || !seat) page.setLayer(pop, false, null, false, false);
      else drawModelPicker(tab, seat, pop._anchor, open.fromCard, true, open.draft);
    }
    function openAdvisor(tab, seat, anchor, fromCard = false, draft = null) {
      const pop = $("pop"), models = page.state?.claudeModels ?? page.modelOptions(seat.cli), choose = chooser(tab, seat, draft);
      const choices = models.map((item) => typeof item === "string" ? { value: item, label: page.formatModel(seat.cli, item) } : { value: item.value, label: item.displayName ?? item.value }).filter((item) => item.value);
      const current = seat.advisor ?? "";
      open = null;
      pop.setAttribute("aria-label", `Choose advisor for ${seat.name}`);
      pop.innerHTML = `${fromCard ? `<button type="button" class="back" data-pop-back style="margin:4px">${page.icons.back}<span>${esc(seat.name)}</span></button>` : ""}<div class="grp">Advisor for ${esc(seat.name)}</div><button type="button" class="opt" data-advisor="" aria-pressed="${String(!current)}"><span class="nm"><span>Off</span><small>No advisor calls</small></span>${page.icons.tick}</button>${choices.map((item) => `<button type="button" class="opt" data-advisor="${esc(item.value)}" aria-pressed="${String(item.value === current)}">${page.logo(seat.cli, 12, 3)}<span class="nm"><span>${esc(item.label)}</span><small>${esc(item.value)}</small></span>${page.icons.tick}</button>`).join("")}<div class="hint">No effort setting. Asked before a plan, when an error repeats, and before calling work done.</div>`;
      page.openPopover(pop, anchor, Boolean(anchor?.closest?.("#crew")));
      pop.querySelectorAll("[data-advisor]").forEach((button) => button.addEventListener("click", () => { choose({ advisor: button.dataset.advisor || null }); page.setLayer(pop, false); }));
      pop.querySelector("[data-pop-back]")?.addEventListener("click", () => { page.setLayer(pop, false, null, false, false); page.reopenSeatCard(tab, seat, anchor); });
    }

    return { pickerClis, modelRows, pickerHints, drawModelPicker, openModelPicker, openAdvisor, refreshModelPicker };
  };
})();
