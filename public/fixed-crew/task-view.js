// Fixed crew (Pack 26, Block 3c): a fixed tab's task panel above its chat. It shows the server's facts only: the Planner's decision
// (risk, planned reviews, final review and why), the plan to approve, the rough to look at and why work is paused. It never decides
// a review is clean and never starts work. Every task, plan, finding and evidence text is written with textContent. The panel is
// rebuilt only when what it shows changed, and then keeps the open decision, the keyboard focus and its own scroll position.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});
  const RISK = { small: "Small", standard: "Standard", high: "High", unknown: "Unknown" };
  const STAGE = { discussion: "Discussing", planned: "Planned", rough: "Rough in progress", inspected: "Rough ready", polish: "Polishing", checks: "Running checks", review: "In review", fix: "Fixing", final: "Final review", shipping: "Shipping", complete: "Complete", interrupted: "Interrupted" };
  const KIND = FC.TASK_KIND; // task-archive-view.js, loaded first
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  // archive: task-events.js's Finished tasks state; its view (task-archive-view.js) draws it in this same panel.
  FC.createTaskView = (page, taskState, crewView, archive) => {
    const archiveView = FC.createTaskArchiveView(page, crewView);
    let signature = "";
    // The one status region for the visible task panel: mounted (empty) outside the rebuilt subtree, so it is never replaced. Its text
    // changes only when the visible outcome does, and a tab's first draw never replays an old result.
    const announcer = document.getElementById("fctAnnouncer") ?? Object.assign(document.createElement("p"), { id: "fctAnnouncer", className: "fct-announcer" });
    announcer.setAttribute("role", "status"); announcer.setAttribute("aria-live", "polite"); announcer.setAttribute("aria-atomic", "true");
    if (!announcer.isConnected) document.body.append(announcer);
    let announced = { tabId: "", key: "" }, shown = null;
    function announce(tabId, outcome) {
      const key = outcome?.key ?? "";
      if (announced.tabId !== tabId) { announced = { tabId, key }; if (announcer.textContent) announcer.textContent = ""; return; }
      if (key === announced.key) return;
      announced.key = key;
      announcer.textContent = outcome?.text ?? "";
    }
    const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
    const button = (label, className, data) => { const el = node("button", className, label); el.type = "button"; Object.assign(el.dataset, data); return el; };
    const chips = (paths) => { const box = node("div", "fct-chips"); for (const path of paths) box.append(node("span", "fct-chip", path)); return box; };
    const labelOf = (slot) => { const def = crewView.definitions().find((item) => item.slot === slot); return def ? crewView.label(def) : slot; };
    const roleOf = (slot) => crewView.definitions().find((item) => item.slot === slot)?.label ?? slot;

    // What the server's record says, read the same way everywhere below.
    const revisionOf = (task) => task.revision?.digest ?? "";
    const realFindings = (task) => (task.findings ?? []).filter((finding) => finding.real);
    const resolved = (task, id) => (task.reviews ?? []).some((review) => review.resolved.includes(id));
    const openFixes = (task) => realFindings(task).filter((finding) => task.triage?.[finding.id]?.outcome === "FIX" && !resolved(task, finding.id));
    const untriaged = (task) => realFindings(task).filter((finding) => !task.triage?.[finding.id]);
    function reviewLine(task) {
      const waiting = untriaged(task).length, fixes = openFixes(task).length;
      if (waiting) return `${plural(waiting, "finding", "findings")} waiting for the Planner`;
      if (fixes) return `${plural(fixes, "fix", "fixes")} open · another review follows`;
      const reviews = (task.reviews ?? []).filter((review) => !review.final).length;
      return reviews > 1 ? `${reviews} reviews` : "One review";
    }
    // Files changed since the newest review or check: the server refreshes the record's revision on every change it saves.
    function reviewStale(task) {
      const last = [...(task.reviews ?? []), ...(task.checks ?? [])].at(-1);
      return Boolean(last) && last.revision !== revisionOf(task);
    }
    const roughStale = (task) => task.stage === "inspected" && Boolean(task.roughRevision) && task.roughRevision !== revisionOf(task);
    // A position the Planner selected (or the leader, always) that has no model now. The words are the server's own refusal.
    function neededSeats(tab, task) {
      const slots = new Set(["leader", ...Object.keys(task?.seats ?? {})]);
      return [...slots].filter((slot) => crewView.definitions().some((def) => def.slot === slot) && !tab.fixedCrew?.preferences?.[slot]?.assignment);
    }
    function sameModel(tab, task) {
      const slots = Object.keys(task?.seats ?? {}).filter((slot) => crewView.definitions().find((def) => def.slot === slot)?.reviews);
      return [...new Set(slots.map((slot) => tab.fixedCrew?.notices?.[slot]).filter((notice) => notice?.status === "same-model").map((notice) => notice.message))];
    }
    const runsOf = (task, kind) => (task.executions ?? []).filter((run) => run.kind === kind && run.planVersion === task.planVersion && run.verified && run.resultRevision === task.roughRevision);

    function facts(tab) {
      const summary = tab.fixedTask ?? null, detail = taskState.detailFor(tab);
      return { tab, summary, task: detail?.task ?? null, fresh: Boolean(detail?.fresh), requestId: detail?.requestId ?? "", connected: page.connected(), blocked: Boolean(summary?.blocked), error: taskState.detailError(tab) };
    }
    const current = (f, kind) => ({ tab: f.tab, kind, task: f.task, fresh: f.fresh, connected: f.connected, blocked: f.blocked });
    function enabled(f, kind) {
      const key = taskState.approvalKey(f.tab.id, f.task.id, f.task.planVersion, kind);
      return taskState.canApprove(current(f, kind)) && !taskState.pending.has(key);
    }
    function outcomeLine(f, kind, card) {
      const outcome = taskState.outcomeOf(f.tab.id, f.task, kind), line = node("p", "fct-status");
      line.dataset.fctStatus = kind;
      if (outcome?.status === "refused") { line.textContent = `Not approved: ${outcome.message}`; line.dataset.status = "failed"; }
      else if (outcome?.status === "done" && f.task.recordRevision < outcome.recordRevision) line.textContent = "The server recorded your answer. Reading the updated task…";
      else if (outcome && outcome.status !== "done") { line.textContent = outcome.message; line.dataset.status = outcome.status === "sending" ? "" : "failed"; }
      card.append(line);
      if (line.textContent) shown = { key: `${f.tab.id}|${f.task.id}|${kind}|${outcome?.status}|${line.textContent}`, text: line.textContent };
    }
    function approveButton(f, kind, label) {
      const sending = taskState.pending.has(taskState.approvalKey(f.tab.id, f.task.id, f.task.planVersion, kind));
      const el = button(sending ? "Approving…" : label, "btn primary", { fctApprove: kind, fctKey: `approve-${kind}` });
      el.disabled = !enabled(f, kind);
      return el;
    }
    function card(tone, title, key) {
      const el = node("section", `ask fct-card${tone ? ` ${tone}` : ""}`); el.dataset.fctCard = key; el.dataset.fctKey = `card-${key}`; el.tabIndex = -1;
      const head = node("h3", "h"); head.innerHTML = tone === "ok" ? page.icons.ok ?? "" : page.icons.warn ?? "";
      head.append(document.createTextNode(title)); el.append(head);
      return el;
    }

    function decision(f) {
      const { tab, task } = f, key = taskState.panelKey(tab.id, task.id, task.planVersion), open = taskState.expanded.has(key);
      const box = node("section", "card fct-decision"); box.dataset.fctDecision = "";
      const head = node("h3", "fct-dhead");
      const toggle = button("", "fct-toggle", { fctToggle: key, fctKey: "toggle" });
      toggle.id = `fct-toggle-${tab.id}`; toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-controls", `fct-more-${tab.id}`);
      toggle.append(node("span", "fct-dt", "Planner's decision"), node("span", "fc-chev"));
      toggle.lastChild.innerHTML = page.icons.chev ?? "";
      head.append(toggle);
      const line = node("p", "fct-line", `${RISK[task.plan.risk.level] ?? task.plan.risk.level} risk · ${reviewLine(task)} · ${task.reviewPolicy.finalRequired ? "Final review" : "No final review"}`);
      const reason = node("p", "fct-reason", `Reason: ${task.reviewPolicy.reason}`);
      line.dataset.fctLine = ""; reason.dataset.fctReason = "";
      box.append(head, line, reason);
      for (const message of sameModel(tab, task)) { const note = node("p", "fct-note warn", message); note.dataset.fctSameModel = ""; box.append(note); }
      if (!f.fresh) box.append(node("p", "fct-note", f.connected ? "Reading the latest record…" : "Shown as last read. Not connected."));
      const more = node("div", "fct-more"); more.id = `fct-more-${tab.id}`; more.hidden = !open; more.setAttribute("role", "region"); more.setAttribute("aria-labelledby", toggle.id);
      if (open) more.append(expandedDetails(f));
      box.append(more);
      return box;
    }
    function row(list, label, value) {
      const item = node("div", "fct-row"); item.dataset.fctRow = label;
      item.append(node("dt", "", label));
      const dd = node("dd"); if (typeof value === "string") dd.textContent = value; else dd.append(...[value].flat());
      item.append(dd); list.append(item);
    }
    function expandedDetails(f) {
      const { tab, task } = f, plan = task.plan, list = node("dl", "fct-dl");
      row(list, "Scope", plan.scope);
      const criteria = node("ul"); for (const item of plan.criteria) criteria.append(node("li", "", item));
      row(list, "Acceptance criteria", criteria);
      row(list, "Blocks", plan.blocks.map((block) => { const el = node("div", "fct-block"); el.append(node("b", "", block.id), node("span", "", block.scope), chips(block.paths)); return el; }));
      const also = [...plan.consumers, ...plan.sharedInputs];
      if (also.length) row(list, "Depends on", chips(also));
      const checks = node("ul"); for (const name of plan.checks) {
        const passed = (task.checks ?? []).some((check) => check.name === name && check.revision === revisionOf(task));
        checks.append(node("li", passed ? "ok" : "", `${name} · ${passed ? "passed on these files" : "not run on these files yet"}`));
      }
      row(list, "Required checks", checks);
      row(list, "Positions", Object.entries(task.seats ?? {}).map(([slot, seat]) => {
        const el = node("div", "fct-seat"); el.dataset.fctSeat = slot;
        el.append(node("b", "", labelOf(slot)), node("span", "", page.modelLine(seat.cli, seat.model, seat.effort, tab)));
        const notice = tab.fixedCrew?.notices?.[slot];
        if (notice?.status === "same-model") el.append(node("small", "fct-warn", notice.message));
        return el;
      }));
      const risk = node("div"); risk.append(node("p", "", plan.risk.reason));
      if (plan.risk.verification.length) { const ul = node("ul"); for (const item of plan.risk.verification) ul.append(node("li", "", item)); risk.append(ul); }
      row(list, "Why this risk", risk);
      row(list, "Why these reviews", plan.reviewReason);
      if (realFindings(task).length || (task.findings ?? []).length) row(list, "Findings", findingRows(task));
      return list;
    }
    function findingRows(task) {
      return (task.findings ?? []).map((finding) => {
        const el = node("div", "fct-finding"); el.dataset.fctFinding = finding.id;
        const decision = task.triage?.[finding.id];
        const badge = node("span", `fct-badge${decision?.outcome === "FIX" ? " fix" : ""}`, !finding.real ? "Not real" : decision?.outcome ?? "Waiting for the Planner");
        el.append(badge, node("p", "fct-ftext", finding.text));
        if (decision) el.append(node("small", "fct-why", `${decision.outcome === "FIX" && !resolved(task, finding.id) ? "Still open. " : ""}${decision.reason}`));
        const review = (task.reviews ?? []).find((item) => item.executionId === finding.executionId);
        if (review?.evidence?.length) el.append(chips(review.evidence));
        return el;
      });
    }

    function planCard(f) {
      const el = card("", "Plan ready for your approval", "plan");
      el.append(node("p", "fct-scope", f.task.plan.scope));
      const blocks = node("ul", "fct-blocks");
      for (const block of f.task.plan.blocks) { const li = node("li"); li.append(node("b", "", block.id), document.createTextNode(` · ${block.scope}`)); blocks.append(li); }
      el.append(blocks, node("p", "fct-faint", "Approving lets the leader start the first step. Nothing starts by itself."));
      const acts = node("div", "acts"); acts.append(approveButton(f, "plan", "Approve this plan")); el.append(acts);
      outcomeLine(f, "plan", el);
      return el;
    }
    function roughCard(f) {
      const { task } = f, el = card("", "Rough ready for your look.", "rough");
      const seen = new Set();
      const add = (label, paths) => { const unique = paths.filter((path) => { if (seen.has(path)) return false; seen.add(path); return true; }); if (!unique.length) return; const part = node("div", "fct-evidence"); part.append(node("span", "lbl", label), chips(unique)); el.append(part); };
      add("Checked", [...new Set(runsOf(task, "visualCheck").flatMap((run) => run.evidence))]);
      add("Leader inspection", [...new Set(runsOf(task, "inspect").flatMap((run) => run.evidence))]);
      add("Previews", [...new Set(runsOf(task, "rough").flatMap((run) => run.evidence))]);
      if (roughStale(task)) el.append(node("p", "fct-note warn", "Files changed since the leader inspected this rough. A new check is needed."));
      const acts = node("div", "acts");
      acts.append(approveButton(f, "rough", "Approve rough"), button("Ask for changes", "btn", { fctAsk: "", fctKey: "ask" }));
      el.append(acts);
      outcomeLine(f, "rough", el);
      return el;
    }
    // The one card that says what the task needs now, most urgent first.
    function actionCard(f) {
      const { task } = f;
      if (task.stage === "interrupted") {
        const el = card("stop", "This run was interrupted. Check what finished before continuing.", "interrupted");
        for (const run of (task.executions ?? []).filter((item) => item.status === "interrupted")) el.append(node("p", "fct-faint", `${labelOf(run.role)} · ${KIND[run.kind] ?? run.kind} · result unknown`));
        el.append(node("p", "fct-faint", "The leader can release this run once the app confirms its whole process tree ended. If that is unknown, the run stays held."));
        return el;
      }
      if (!taskState.scopeApproved(task)) return planCard(f);
      if (task.stage === "inspected" && !taskState.roughApproved(task)) return roughCard(f);
      if (openFixes(task).length) {
        const el = card("stop", "Fixes are still open", "fixes");
        el.append(node("p", "", `${plural(openFixes(task).length, "accepted fix is", "accepted fixes are")} not resolved yet. A fresh review checks the fixes before anything ships.`));
        const acts = node("div", "acts"); acts.append(button("Show findings", "btn", { fctToggle: taskState.panelKey(f.tab.id, task.id, task.planVersion), fctOpen: "", fctKey: "findings" })); el.append(acts);
        return el;
      }
      if (reviewStale(task)) return card("", "Files changed since this review. A new check is needed.", "stale");
      if (taskState.roughApproved(task)) {
        const el = card("ok", "Rough approved", "rough-approved");
        el.append(node("p", "", "Polish and review can start. The leader runs the next step."));
        outcomeLine(f, "rough", el);
        return el;
      }
      const el = card("ok", "Plan approved", "plan-approved");
      el.append(node("p", "", "Nothing starts by itself. The leader runs the next step."));
      return el;
    }
    function notes(f) {
      const out = [];
      if (!f.connected) out.push(node("p", "fct-banner", "Not connected. Approvals are paused, and an answer that was on its way is not confirmed."));
      if (f.error) out.push(node("p", "fct-banner", `Could not read this task: ${f.error}`));
      for (const slot of neededSeats(f.tab, f.task)) {
        const el = node("div", "fct-need"); el.dataset.fctNeed = slot;
        el.append(node("span", "", `${roleOf(slot)} has no model. Choose one in Settings before continuing.`), button(`Choose a model for ${labelOf(slot)}`, "btn sm", { fctPosition: slot, fctKey: `need-${slot}` }));
        out.push(el);
      }
      return out;
    }
    function body(f) {
      const { tab, summary } = f, out = [], browsing = archive.of(tab.id)?.mode ?? "current";
      const head = node("div", "fct-head");
      const title = tab.fixedCrew.unavailable ? "Fixed crew" : browsing !== "current" ? tab.name : f.task ? `Task · ${STAGE[f.task.stage] ?? f.task.stage}` : "Task";
      head.append(node("span", "fct-ttl", title));
      const models = button("Choose models in Settings", "btn sm", { fctKey: "settings" }); models.id = "fcWorkSettings";
      head.append(models); out.push(head);
      if (tab.fixedCrew.unavailable) {
        const el = card("stop", "This crew is unavailable.", "unavailable");
        el.append(node("p", "", tab.fixedCrew.notice ?? "Its saved data cannot be used by this version."), archiveView.unavailable());
        return [...out, el];
      }
      if (browsing !== "current") return [...out, archiveView.render(tab, archive.of(tab.id), f)];
      out.push(archiveView.entry(), ...notes(f));
      if (summary?.blocked) {
        const el = card("stop", "This task is blocked", "blocked");
        el.append(node("p", "fct-reason", String(summary.notice ?? "The server could not read this task.")), node("p", "fct-faint", "Nothing runs until it is fixed. Check the crew in Settings or ask the leader."));
        return [...out, el];
      }
      if (!summary) {
        const el = node("p", "fct-empty", tab.fixedCrew.preferences?.leader?.assignment ? "No plan yet. Tell the leader what you want; the Planner's plan shows here for your approval." : "No plan yet. Choose a model for Leader before starting a conversation.");
        return [...out, el];
      }
      if (!f.task) return [...out, node("p", "fct-empty", f.connected ? "Reading the task…" : "The task is read when Command Center reconnects.")];
      return [...out, actionCard(f), decision(f)]; // what needs the owner first, so an open decision never pushes it out of view
    }

    // A fixed tab's panel is drawn over its leader's chat; a legacy tab never shows it.
    function render(tab, show) {
      const view = page.$("fixedView"); if (!view) return;
      const fixed = Boolean(tab?.fixedCrew);
      view.hidden = !fixed || (!show && !tab.fixedCrew.unavailable);
      if (view.hidden) { signature = ""; announce("", null); return; }
      const f = facts(tab), task = f.task;
      const keys = task ? ["plan", "rough"].map((kind) => [taskState.outcomeOf(tab.id, task, kind), taskState.pending.has(taskState.approvalKey(tab.id, task.id, task.planVersion, kind))]) : [];
      const next = JSON.stringify([tab.id, f.summary, f.requestId, f.fresh, f.connected, f.error, keys, task ? taskState.expanded.has(taskState.panelKey(tab.id, task.id, task.planVersion)) : false,
        tab.fixedCrew.preferences, tab.fixedCrew.notices, tab.fixedCrew.unavailable, tab.fixedCrew.notice, crewView.definitions().length, tab.name, archive.signature(tab.id)]);
      if (next === signature && view.firstElementChild) return;
      signature = next;
      const scroll = page.$("view"), focused = document.activeElement?.closest?.("#fixedView") ? document.activeElement.dataset.fctKey : null, top = scroll.scrollTop;
      shown = null;
      const root = node("div", "fct"); root.dataset.fctTab = tab.id; root.append(...body(f));
      view.replaceChildren(root);
      const loadingNote = root.querySelector('[data-fct-arch-state="loading"]');
      if (!shown && loadingNote) shown = { key: `${tab.id}|archive|${loadingNote.textContent}`, text: loadingNote.textContent };
      announce(tab.id, shown);
      scroll.scrollTop = top;
      // Finished tasks navigation names where the keyboard goes next (its heading, the row it came from, or its entry) and the scroll.
      const wanted = archive.takeFocus(tab.id), moved = wanted && view.querySelector(`[data-fct-key="${CSS.escape(wanted.key)}"]`);
      if (moved) { moved.focus({ preventScroll: true }); if (wanted.scroll !== null) scroll.scrollTop = wanted.scroll; return; }
      // A control that is disabled now (an approval on its way) hands focus to its own card, never to the page body.
      // Show more waiting for its page hands focus to the Finished tasks heading.
      if (focused) { const target = view.querySelector(`[data-fct-key="${CSS.escape(focused)}"]`); (target?.disabled ? target.closest("[data-fct-card]") ?? view.querySelector('[data-fct-key="arch-heading"]') : target)?.focus({ preventScroll: true }); }
    }
    return { render, reviewLine, neededSeats };
  };
})();
