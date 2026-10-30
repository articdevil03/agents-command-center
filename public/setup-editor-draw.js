// The crew editor, part 2 of 3: the markup. Every function returns HTML for the state in setup-editor.js; nothing here changes that state
// except the two that show a refusal, which mark it as announced. Top to bottom: the setup and its menus, who runs the process, the look
// switch, the one crew list (a seat opens its card in place), who does what (the server's steps), and the Save bar in the strip under Settings.
(() => {
  "use strict";
  const SE = window.CC_SETUP_EDITOR;
  const { MAX_SEATS, esc, plural, current, shownCrew, shapeOf, capOf, runReason, rolesOf, roleDef, hasAuto, leaderOf, plannerOf } = SE;
  // What each role does, in a line (the roles themselves, and their order, are the server's: state.roles).
  const ROLE_LINES = {
    Planner: "Plans the work and runs the process.",
    Coder: "Builds the work it is given.",
    "Design coder": "Builds the design work.",
    Fixer: "Fixes what the review finds.",
    Reviewer: "Reviews each round. Never edits.",
    "Final reviewer": "Reviews the finished work once.",
    Researcher: "Looks things up when a task needs it.",
    Helper: "Takes work handed to it by name.",
  };
  const CUSTOM_LINE = "Your own name for it. Works like a Helper.";
  const svg = (size, body, view = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" fill="none" aria-hidden="true">${body}</svg>`;
  const line = (d, width = 1.6) => `<path d="${d}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const I = {
    plus: svg(12, line("M6 1.5v9M1.5 6h9", 1.5), 12),
    x: svg(11, line("M3 3l8 8M11 3l-8 8"), 14),
    chev: svg(12, line("M3 4.5 6 7.5 9 4.5", 1.5), 12).replace("<svg", '<svg class="se-chev"'),
    lock: svg(14, '<rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.4"/>'),
  };
  // The picture the page shows for the seat in the crew rail (its own upload or preset); a new seat wears the plain one.
  function face(seat) {
    const pic = String(seat?.pic ?? "");
    let src = seat?.fresh ? "" : document.querySelector(`#crew [data-seat-pic="${CSS.escape(String(seat?.slot ?? ""))}"] img`)?.getAttribute("src") ?? "";
    if (!src) src = /^\/api\/avatar\/[\w.-]+$/.test(pic) ? pic : /^avatars\/[a-z]+\.svg$/.test(pic) ? `/${pic}` : "/avatars/ash.svg";
    return `<img src="${esc(src)}" data-fallback="/avatars/ash.svg" alt="">`;
  }
  const badge = (text, kind = "") => `<span class="se-badge${kind ? ` se-b-${kind}` : ""}">${text}</span>`;
  const errorLine = (s) => { const html = `<p class="se-err" data-se-error${s.errorNew ? ' role="alert"' : ""}>${esc(s.error)}</p>`; s.errorNew = false; return html; };

  function draw(tab, state, s, locked) {
    const crew = shownCrew(tab, s), dirty = Boolean(s.draft);
    const lock = locked ? `<p class="se-lock" data-se-locked>${I.lock}<span>Locked while this tab is working. You can change its crew when its runs and replies end.</span></p>` : "";
    return `${head(tab, state, s, crew)}${!dirty && s.error ? errorLine(s) : ""}${lock}${runsLine(crew)}${lookRow(s, tab, crew)}${crewList(tab, state, s, crew)}${note(s)}${whoDoesWhat(tab, s, crew)}`;
  }
  function head(tab, state, s, crew) {
    const menu = (name, label, controls) => `<button type="button" class="btn sm" data-se-menu="${name}" data-focus-key="se-menu-${name}" aria-expanded="${s.menu === name}" aria-controls="${controls}">${label}</button>`;
    return `<div class="se-head"><div class="se-title"><h4>${esc(tab.setupName || "Custom crew")}</h4><small>${plural(crew.length, "seat")}</small></div><div class="se-hacts">${menu("switch", "Switch to…", "se-switch")}${menu("saveAs", "Save as setup…", "se-saveas")}</div></div>${s.menu === "switch" ? switchPanel(tab, state, s) : ""}${s.menu === "saveAs" ? saveAsForm(tab, s) : ""}`;
  }
  function switchPanel(tab, state, s) {
    const ask = s.confirm;
    if (ask) {
      const blank = ask.kind === "template" && ask.id === "blank", dropped = s.draft ? ", and your unsaved changes are dropped" : "";
      const text = ask.kind === "remove" ? `Delete the saved setup ${ask.name}? Tabs that switched to it keep their own copy.`
        : blank ? `Start ${tab.name} blank? Every seat but the leader is removed${dropped}. The leader keeps its name, picture and model.`
        : `Switch this tab to ${ask.name}? Its crew is replaced${dropped}. A seat with the same id keeps its name, picture and model.`;
      const yes = ask.kind === "remove" ? "Delete" : blank ? "Start blank" : "Switch";
      return `<div class="se-menu" id="se-switch" role="group" aria-label="Switch to a setup"><p class="se-ask">${esc(text)}</p><div class="se-rowb"><button type="button" class="btn sm ${ask.kind === "remove" ? "danger" : "primary"}" data-se-confirm data-focus-key="se-confirm">${yes}</button><button type="button" class="btn sm" data-se-cancel="confirm" data-focus-key="se-confirm-cancel">Cancel</button></div></div>`;
    }
    const option = (kind, item, desc) => {
      const inUse = tab.setupName === item.name;
      return `<div class="se-opt"><button type="button" class="se-use" data-se-use="${kind}" data-id="${esc(item.id)}" data-focus-key="se-use-${kind}-${esc(item.id)}" aria-pressed="${inUse}"><span class="se-on"><b>${esc(item.name)}${inUse ? ` ${badge("In use")}` : ""}</b><small>${esc(desc)}</small></span></button>${kind === "saved" ? `<button type="button" class="se-x" data-se-forget="${esc(item.id)}" data-focus-key="se-forget-${esc(item.id)}" aria-label="Delete the saved setup ${esc(item.name)}" title="Delete">${I.x}</button>` : ""}</div>`;
    };
    const templates = state?.templates ?? [], blank = templates.find((item) => item.id === "blank"), saved = state?.savedSetups ?? [];
    const others = templates.filter((item) => item !== blank).map((item) => option("template", item, `${item.desc} ${plural(item.crew?.length ?? 0, "seat")}.`)).join("");
    const mine = saved.length ? saved.map((item) => option("saved", item, plural(item.crew?.length ?? 0, "seat"))).join("") : '<p class="se-none">None yet. Save as setup keeps this one.</p>';
    return `<div class="se-menu" id="se-switch" role="group" aria-label="Switch to a setup">${blank ? option("template", blank, blank.desc) : ""}<div class="se-mg">Templates</div>${others}<div class="se-mg">Saved setups</div>${mine}</div>`;
  }
  function saveAsForm(tab, s) {
    const dirty = Boolean(s.draft);
    return `<form class="se-menu se-form" id="se-saveas" data-se-saveas aria-label="Save as setup"><label class="lbl" for="se-saveas-name">Name of the setup</label><div class="se-rowb"><input class="settings-input" id="se-saveas-name" data-focus-key="se-saveas-name" maxlength="60" value="${esc(s.saveAsName)}" autocomplete="off" spellcheck="false"${dirty ? " disabled" : ""}><button type="submit" class="btn sm primary" data-focus-key="se-saveas-ok"${dirty ? " disabled" : ""}>Save setup</button><button type="button" class="btn sm" data-se-cancel="menu" data-focus-key="se-saveas-cancel">Cancel</button></div><small class="se-hint">${dirty ? "Save or discard your changes first: a saved setup copies what this tab has now." : `Keeps ${esc(tab.name)}'s crew for any tab. The same name replaces the old one.`}</small></form>`;
  }

  // ---- who runs the process, and the look switch ----
  function runsLine(crew) {
    const leader = leaderOf(crew), planner = plannerOf(crew), lead = `<b>${esc(leader?.name ?? "The leader")}</b>`;
    const text = planner?.orchestrates === true ? `<b>${esc(planner.name)}</b> runs the process. You talk with ${lead}.` : `${lead} runs the process.`;
    return `<p class="se-runs" data-se-runs-note>${text}</p>`;
  }
  function lookRow(s, tab, crew) {
    const on = current(tab, s).lookPause === true, steps = hasAuto(crew);
    const hint = steps ? "After the build, the work waits for you to check it before the review." : "Add a Coder, Reviewer, Fixer, Planner or Final reviewer to give this tab steps.";
    return `<div class="se-look" data-se-look><div class="se-lt"><span id="se-look-l">Pause for my look after build</span><small id="se-look-h">${hint}</small></div><button type="button" class="switch" role="switch" data-se-look-toggle data-focus-key="se-look" aria-checked="${on}" aria-labelledby="se-look-l" aria-describedby="se-look-h"${steps ? "" : " disabled"}></button></div>`;
  }

  // ---- the crew: one row per seat, its card opens in place ----
  function crewList(tab, state, s, crew) {
    const rows = crew.map((seat) => seatRow(tab, state, s, crew, seat)).join("");
    const full = current(tab, s).crew.length >= MAX_SEATS;
    return `<ul class="se-list" aria-label="Crew">${rows}<li class="se-addrow"><button type="button" class="se-add" data-se-add data-focus-key="se-add"${full ? " disabled" : ""}>${I.plus}<span>Add a seat</span></button>${full ? `<small class="se-hint">A crew has at most ${MAX_SEATS} seats.</small>` : ""}</li></ul>`;
  }
  function seatRow(tab, state, s, crew, seat) {
    const slot = esc(seat.slot), open = s.open === seat.slot, live = tab.crew.find((item) => item.slot === seat.slot);
    const role = seat.isLeader ? "Leader" : String(seat.role ?? "").trim();
    const changed = !seat.fresh && live && (["name", "role", "canWrite"].some((key) => String(seat[key]).trim() !== String(live[key]).trim()) || (seat.orchestrates === true) !== (live.orchestrates === true));
    const tags = `${seat.isLeader ? badge("Leader") : ""}${seat.orchestrates === true ? badge("Runs the process", "run") : ""}${seat.fresh ? badge("Not saved", "new") : changed ? badge("Changed", "new") : ""}`;
    const model = SE.ui.view.ctx.modelLine(seat.cli, seat.model, seat.effort), sub = `${role ? esc(role) : '<span class="se-ph">No role yet</span>'} · ${esc(model)}`;
    const typed = !seat.fresh || String(seat.typedName ?? "").trim() !== "";
    return `<li class="se-seat${open ? " open" : ""}" data-se-seat="${slot}"><button type="button" class="se-row" data-se-row="${slot}" data-focus-key="se-row-${slot}" aria-expanded="${open}" aria-controls="se-card-${slot}">${face(seat)}<span class="se-who"><b${typed ? "" : ' class="se-ph"'} title="${esc(seat.name)}">${esc(seat.name)}</b><small title="${esc(`${role || "No role yet"} · ${model}`)}">${sub}</small></span><span class="se-tags">${tags}</span>${I.chev}</button>${open ? card(tab, state, s, crew, seat) : ""}</li>`;
  }
  function card(tab, state, s, crew, seat) {
    const slot = esc(seat.slot), ctx = SE.ui.view.ctx, cap = capOf(seat.cli), cli = cap?.label ?? seat.cli, fresh = seat.fresh === true;
    const row = (title, body, hint = "") => `<div class="se-r"><span class="se-rl">${title}</span><div class="se-rv">${body}</div>${hint ? `<small class="se-hint se-rh">${esc(hint)}</small>` : ""}</div>`;
    const toggle = (attr, on, name, disabled) => `<button type="button" class="switch" role="switch" ${attr}="${slot}" data-focus-key="se-${attr.slice(8)}-${slot}" aria-checked="${on}" aria-label="${name}: ${esc(seat.name)}"${disabled ? " disabled" : ""}></button>`;
    const nameField = `<label class="se-field"><span class="lbl">Name</span><input class="settings-input" data-se-name="${slot}" data-focus-key="se-name-${slot}" value="${esc(seat.typedName ?? seat.name)}" placeholder="${esc(seat.name)}" maxlength="80" autocomplete="off" spellcheck="false"></label>`;
    const locked = !fresh && ctx.seatLocked(seat), model = ctx.modelLine(seat.cli, seat.model, seat.effort);
    const modelRow = row("Model", `<button type="button" class="chipb se-model" data-se-model="${slot}"${fresh ? "" : " data-se-live"} data-focus-key="se-model-${slot}" aria-haspopup="dialog" aria-label="Model for ${esc(seat.name)}: ${esc(cli)}, ${esc(model)}" title="${esc(`${cli} · ${model}`)}"${locked ? ' disabled aria-disabled="true"' : ""}><span class="se-cli">${esc(cli)}</span><span>${esc(model)}</span>${I.chev}</button>${locked ? '<small class="se-hint" data-model-locked>Locked while working</small>' : ""}`);
    const advisor = seat.advisor ? ctx.modelLine("claude", seat.advisor) : "Off";
    const advisorRow = cap?.advisor ? row("Advisor", `<button type="button" class="chipb se-adv" data-se-advisor="${slot}"${fresh ? "" : " data-se-live"} data-focus-key="se-advisor-${slot}" aria-haspopup="dialog" aria-label="Advisor for ${esc(seat.name)}: ${esc(advisor)}" title="${esc(advisor)}"><span>${esc(advisor)}</span>${I.chev}</button>`) : "";
    const writeHint = !seat.canWrite && cap?.readOnlyEnforced === false ? `${cli} cannot be held read-only: it may still edit files.` : "";
    const writeRow = seat.isLeader ? "" : row("Can write", `${toggle("data-se-canwrite", seat.canWrite === true, "Can write", false)}<span class="se-swl">${seat.canWrite ? "Edits files" : "Read-only"}</span>`, writeHint);
    const leader = leaderOf(crew)?.name ?? "the leader", why = runReason(seat);
    const runText = why || (seat.orchestrates === true ? `${seat.name} runs the process: plans, starts the other seats and moves the work on. You talk with ${leader}.` : `Off: ${leader} runs the process.`);
    const runRow = !seat.isLeader && String(seat.role ?? "").trim() === "Planner" ? row("Runs the process", `${toggle("data-se-runs", seat.orchestrates === true, "Runs the process", Boolean(why))}<span class="se-swl">${seat.orchestrates === true ? "Yes" : "No"}</span>`, runText) : "";
    const remove = seat.isLeader ? "" : `<button type="button" class="btn sm danger" data-se-remove="${slot}" data-focus-key="se-remove-${slot}">Remove from crew</button>`;
    const hint = fresh ? "New: it joins the crew when you save." : "Model and advisor change right away. The rest waits for Save.";
    return `<div class="se-card" id="se-card-${slot}" data-se-card="${slot}" role="group" aria-label="${esc(seat.name)}"><div class="se-fields">${nameField}${seat.isLeader ? leaderRole(crew) : roleField(state, s, crew, seat)}</div><div class="se-rows">${modelRow}${advisorRow}${writeRow}${runRow}</div><div class="se-cf"><small class="se-hint">${hint}</small>${remove}</div></div>`;
  }
  const leaderRole = (crew) => `<div class="se-field"><span class="lbl">Role</span><span class="se-static">Leader</span><small class="se-hint">${plannerOf(crew)?.orchestrates ? "Talks with you." : "Talks with you and runs the process."}</small></div>`;
  function roleField(state, s, crew, seat) {
    const slot = esc(seat.slot), role = String(seat.role ?? "").trim(), known = roleDef(state, role), custom = s.custom.has(seat.slot) || (role !== "" && !known), open = s.roleMenu === seat.slot;
    const label = known ? esc(known.name) : custom ? "Custom" : '<span class="se-ph">Choose a role</span>', shown = known ? known.name : custom ? "Custom" : "Choose a role";
    const hint = known ? ROLE_LINES[known.name] ?? "" : custom ? CUSTOM_LINE : "Left empty, it is saved as a Helper.";
    const text = custom ? `<input class="settings-input" data-se-rolename="${slot}" data-focus-key="se-rolename-${slot}" value="${esc(role)}" placeholder="Name the role" maxlength="60" autocomplete="off" aria-label="Role name for ${esc(seat.name)}">` : "";
    return `<div class="se-field se-rolef"><span class="lbl" id="se-role-l-${slot}">Role</span><div class="se-dd"><button type="button" class="settings-input se-rolebtn" data-se-role="${slot}" data-focus-key="se-role-${slot}" aria-haspopup="listbox" aria-expanded="${open}" aria-controls="se-roles-${slot}" aria-labelledby="se-role-l-${slot} se-role-v-${slot}"><span id="se-role-v-${slot}" title="${esc(shown)}">${label}</span>${I.chev}</button>${open ? roleMenu(state, crew, seat, custom) : ""}</div>${text}<small class="se-hint">${esc(hint)}</small></div>`;
  }
  // The role list: the server's roles in its order, then Custom. A crew has one Planner, so another seat's Planner option says why it is off.
  function roleMenu(state, crew, seat, custom) {
    const slot = esc(seat.slot), role = String(seat.role ?? "").trim(), planner = plannerOf(crew);
    const option = (attr, name, sub, access, selected, off, index) => `<button type="button" role="option" class="se-ropt" ${attr} data-focus-key="se-ropt-${slot}-${index}" aria-selected="${selected}"${off ? ' aria-disabled="true" disabled' : ""}><span class="se-rn"><b>${esc(name)}</b><span class="se-ra">${access}</span></span><small>${esc(sub)}</small></button>`;
    const roles = rolesOf(state).map((item, index) => {
      const taken = item.name === "Planner" && planner && planner.slot !== seat.slot;
      return option(`data-se-pick-role="${esc(item.name)}"`, item.name, taken ? `A crew has one Planner: ${planner.name}.` : ROLE_LINES[item.name] ?? "", item.canWrite ? "Can write" : "Read-only", item.name === role && !custom, taken, index);
    }).join("");
    return `<div class="se-rolemenu" role="listbox" id="se-roles-${slot}" aria-label="Role for ${esc(seat.name)}" data-se-rolemenu="${slot}">${roles}${option("data-se-custom-role", "Custom…", CUSTOM_LINE, "Read-only", custom, false, "custom")}</div>`;
  }

  // ---- after a save, and who does what ----
  // The note fades on a clock that keeps running across draws (a draw makes a new element, so its fade starts at the time already gone).
  const note = (s) => s.note ? `<p class="se-done" data-se-note style="animation-delay:-${Math.max(0, Date.now() - s.note.at)}ms">${esc(s.note.text)}</p>` : "";
  // The server's steps for this tab, derived from the saved roles, in plain words: "Plan: Sage", "Review: Vera, then Sol (fixes: Juno / Nova)".
  function whoDoesWhat(tab, s, crew) {
    const nameOf = (slot) => slot === "user" ? "You" : tab.crew.find((seat) => seat.slot === slot)?.name ?? slot;
    const distinct = (names) => [...new Set(names)];
    const items = (tab.steps ?? []).map((step) => {
      const label = step.label;
      if (step.type === "look") return { label };
      if (step.type === "rounds") {
        const reviewers = distinct(step.pairs.map((pair) => nameOf(pair.reviewer))), fixers = distinct(step.pairs.flatMap((pair) => pair.fixers.map(nameOf)));
        return { label, who: `${reviewers.join(", then ")}${fixers.length ? ` (fixes: ${fixers.join(" / ")})` : ""}` };
      }
      return { label, who: distinct((step.owners ?? []).map(nameOf)).join(" + ") };
    });
    const body = items.length ? `<ol class="se-flow" data-se-flow>${items.map(({ label, who }) => `<li>${who ? `<span class="se-wk">${esc(label)}:</span> ${esc(who)}` : `<span class="se-wk">${esc(label)}</span>`}</li>`).join("")}</ol>`
      : `<p class="se-none" data-se-flow-none>${esc(leaderOf(tab.crew)?.name ?? "The leader")} does everything. Add seats to share the work.</p>`;
    const stale = s.draft ? '<small class="se-hint" data-se-stale>Updates when you save.</small>' : "";
    return `<section class="se-wdw${s.draft ? " stale" : ""}" aria-labelledby="se-wdw-h" data-se-who><div class="se-wh"><h5 id="se-wdw-h">Who does what</h5>${stale}</div>${body}</section>`;
  }

  // The Save bar, in the strip under the Settings body: there while something waits for Save.
  function foot(tab, s, locked) {
    if (!s.draft && !s.saving) return "";
    const elsewhere = s.draft && s.draft.base !== shapeOf(tab);
    const status = s.saving ? "Saving…" : elsewhere ? "This crew changed elsewhere since you began. Save replaces it with yours." : "Unsaved crew changes";
    const off = s.saving || SE.switching(s) || locked ? ' aria-disabled="true"' : "";
    return `${s.error ? errorLine(s) : ""}<div class="se-bar" data-se-foot><p class="se-status">${esc(status)}</p><button type="button" class="btn sm" data-se-discard data-focus-key="se-discard"${off}>Discard</button><button type="button" class="btn sm primary" data-se-save data-focus-key="se-save"${off}>${s.saving ? "Saving…" : "Save"}</button></div>`;
  }

  Object.assign(SE, { draw, foot });
})();
