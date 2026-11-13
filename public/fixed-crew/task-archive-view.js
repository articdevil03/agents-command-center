// Fixed crew (Pack 26, S-F3): the Finished tasks view inside a fixed tab's task panel. It draws what task-events.js keeps for the tab:
// the verified names, finish dates and task IDs the server listed, and one finished task read from its archive. It is read only: nothing here
// restores, re-runs, deletes or approves. Every archive text (IDs, scope, reasons, evidence, roles, errors) is data written with
// textContent; no archive string reaches innerHTML. It never concludes a review is clean: it shows what the record says.
(() => {
  "use strict";
  const FC = (window.CC_FIXED_CREW = window.CC_FIXED_CREW ?? {});
  FC.TASK_KIND = { assist: "Assist", rough: "Rough", build: "Build", polish: "Polish", check: "Check", visualCheck: "Visual check", inspect: "Leader inspection", review: "Review", checkpoint: "Checkpoint", fix: "Fix", final: "Final review", commit: "Commit", push: "Push", publish: "Publish", planning: "Planning", triage: "Triage" };
  const SHIPPING = { commit: "Local commit", push: "Push", publish: "Publish" };
  // A task's own run records say success; the execution journal says done. Each keeps its own meaning.
  const TASK_RUN = { success: "Recorded as done", failed: "Failed", interrupted: "Result unknown", reserved: "Not finished", running: "Not finished" };
  const JOURNAL_RUN = { done: "Done", failed: "Failed" };
  const RISK = { small: "Small", standard: "Standard", high: "High", unknown: "Unknown" };

  FC.createTaskArchiveView = (page, crewView) => {
    const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
    const button = (label, className, data) => { const el = node("button", className, label); el.type = "button"; Object.assign(el.dataset, data); return el; };
    const chips = (paths) => { const box = node("div", "fct-chips"); for (const path of paths ?? []) box.append(node("span", "fct-chip", path)); return box; };
    const list = (items) => { const ul = node("ul"); for (const item of items ?? []) ul.append(node("li", "", item)); return ul; };
    const kind = (value) => FC.TASK_KIND[value] ?? String(value);
    const roleOf = (slot) => { const def = crewView.definitions().find((item) => item.slot === slot); return def ? crewView.label(def) : String(slot); };
    function when(value) {
      const at = new Date(value);
      return typeof value === "string" && !Number.isNaN(at.getTime()) ? at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : String(value ?? "Not recorded");
    }
    function row(dl, label, value) {
      const item = node("div", "fct-row"); item.dataset.fctRow = label;
      const dd = node("dd"); if (typeof value === "string") dd.textContent = value; else dd.append(...[value].flat());
      item.append(node("dt", "", label), dd); dl.append(item);
    }
    function item(title, badge, ...parts) {
      const el = node("div", "fct-aitem"), head = node("div", "fct-aihead");
      head.append(node("b", "", title)); if (badge) head.append(node("span", `fct-badge${badge.fix ? " fix" : ""}`, badge.text));
      el.append(head, ...parts.filter(Boolean));
      return el;
    }
    const empty = (text) => node("p", "fct-faint", text);

    // The quiet way in, drawn under the panel's header whatever the current task is.
    const entry = () => button("Finished tasks", "fct-entry", { fctArch: "open", fctKey: "arch-entry" });
    const unavailable = () => { const el = node("p", "fct-faint", "Finished tasks aren't available on this tab."); el.dataset.fctArchUnavailable = ""; return el; };
    function back(label, target, key) {
      const el = button("", "back", { fctArch: target, fctKey: key });
      el.innerHTML = page.icons.back ?? ""; // the page's own static icon, never archive text
      el.append(node("span", "", label));
      return el;
    }
    // Spoken through task-view.js's persistent announcer: a status line born inside the rebuilt panel is often not announced at all.
    function loading(text) { const el = node("p", "fct-astatus", text); el.dataset.fctArchState = "loading"; return el; }
    function failure(title, reason, state) {
      const box = node("div", "fct-afail"); box.setAttribute("role", "alert"); box.dataset.fctArchState = state;
      box.append(node("p", "fct-aerr", title), node("p", "fct-faint", reason));
      const acts = node("div", "acts"); acts.append(button("Try again", "btn sm", { fctArch: "retry", fctKey: `arch-retry-${state}` })); box.append(acts);
      return box;
    }
    // A held rollover keeps its notice in view while the owner browses, so an empty list never reads as "nothing finished".
    function held(summary) {
      const el = node("div", "fct-banner fct-aheld"); el.dataset.fctArchHeld = "";
      el.append(node("b", "", "A task is held"), node("p", "", String(summary.notice ?? "The server could not read this task.")));
      return el;
    }
    function region(tab, title, backButton, f, stale) {
      const box = node("section", "fct-arch"), id = `fct-arch-h-${tab.id}`;
      box.setAttribute("role", "region"); box.setAttribute("aria-labelledby", id); box.dataset.fctArch = "";
      const heading = node("h3", "fct-ah", title); heading.id = id; heading.tabIndex = -1; heading.dataset.fctKey = "arch-heading";
      box.append(backButton, heading);
      if (f.blocked) box.append(held(f.summary));
      if (!f.connected) { const off = node("p", "fct-banner", "Not connected."); off.dataset.fctArchState = "offline"; box.append(off); }
      if (stale) box.append(node("p", "fct-note", "Shown as last read."));
      return box;
    }

    function listView(tab, a, f) {
      const box = region(tab, "Finished tasks", back("Back to current task", "current", "arch-back-current"), f, a.stale && a.items.length > 0);
      box.append(node("p", "fct-faint", "Read only. Listed by task ID."));
      if (a.list.status === "loading") box.append(loading("Loading finished tasks..."));
      else if (a.list.status === "error") box.append(failure("Could not load finished tasks.", a.list.error, "list-error"));
      else if (a.list.status === "ready" && !a.items.length) {
        const none = node("p", "fct-empty", f.blocked ? "No finished tasks are listed. A task is held, so this list may not be complete." : "No finished tasks yet.");
        none.dataset.fctArchState = "empty"; box.append(none);
      }
      if (a.items.length) {
        const ul = node("ul", "fct-alist"); ul.setAttribute("aria-label", "Finished tasks");
        for (const archive of a.items.slice(0, a.visible)) {
          const li = node("li"), open = button("", "run fct-arow", { fctArch: "row", fctArchId: archive.id, fctKey: `arch-row-${archive.id}` });
          const label = node("span", "fct-alabel");
          label.append(node("b", "fct-ascope", archive.scope), node("small", "fct-adate", when(archive.completedAt)), node("small", "fct-aid", archive.id));
          open.append(label, node("span", "fct-aopen", "Open"));
          li.append(open); ul.append(li);
        }
        box.append(ul);
      }
      if (a.more.status === "error") box.append(failure("More finished tasks could not be loaded.", a.more.error, "more-error"));
      if (a.list.status === "ready" && (a.visible < a.items.length || a.nextCursor) && a.more.status !== "error") {
        const waiting = a.more.status === "loading", more = button(waiting ? "Loading more..." : "Show more", "btn sm fct-amore", { fctArch: "more", fctKey: "arch-more" });
        more.disabled = waiting || Boolean(a.pending);
        box.append(more);
      }
      return box;
    }

    function disclosure(a, key, title, content) {
      const el = node("details", "fct-disc"); el.dataset.fctDisc = key; el.open = a.open.has(key);
      const summary = node("summary", "", title); summary.dataset.fctKey = `disc-${key}`;
      const body = node("div", "fct-dbody"); body.append(...[content].flat());
      el.append(summary, body);
      return el;
    }
    function planPart(task) {
      const plan = task.plan, dl = node("dl", "fct-dl");
      row(dl, "Acceptance criteria", list(plan.criteria));
      row(dl, "Blocks", (plan.blocks ?? []).map((block) => { const el = node("div", "fct-block"); el.append(node("b", "", block.id), node("span", "", block.scope), chips(block.paths)); return el; }));
      row(dl, "Files", chips(plan.paths));
      const also = [...(plan.consumers ?? []), ...(plan.sharedInputs ?? [])];
      if (also.length) row(dl, "Depends on", chips(also));
      const risk = node("div"); risk.append(node("p", "", `${RISK[plan.risk?.level] ?? plan.risk?.level} risk. ${plan.risk?.reason ?? ""}`));
      if (plan.risk?.verification?.length) risk.append(list(plan.risk.verification));
      row(dl, "Risk", risk);
      row(dl, "Reviews planned", [node("p", "", `${task.reviewPolicy?.finalRequired ? "Final review required" : "No final review required"}. ${task.reviewPolicy?.reason ?? ""}`), node("p", "", plan.reviewReason ?? "")]);
      row(dl, "Required checks", list(plan.checks));
      // The plan's shipping is what was planned, never proof it happened: What shipped below reads the recorded runs.
      row(dl, "Planned shipping", (plan.shipping ?? []).length ? `${plan.shipping.map((step) => SHIPPING[step] ?? step).join(", ")} (planned, not a result)` : "None planned");
      return dl;
    }
    function checksPart(task) {
      const checks = task.checks ?? [];
      if (!checks.length) return empty("No checks were recorded.");
      return checks.map((check) => item(check.name, null, node("small", "fct-why", `Run ${check.executionId}`), chips(check.evidence)));
    }
    function reviewsPart(task) {
      const reviews = task.reviews ?? [];
      if (!reviews.length) return empty("No reviews were recorded.");
      return reviews.map((review) => item(review.final ? "Final review" : "Review", null,
        node("small", "fct-why", `Run ${review.executionId} · ${review.findings.length} found · ${review.resolved.length} marked resolved`),
        review.resolved.length ? chips(review.resolved) : null, chips(review.evidence)));
    }
    function findingsPart(task) {
      const findings = task.findings ?? [];
      if (!findings.length) return empty("No findings were recorded.");
      const resolvedBy = (id) => (task.reviews ?? []).find((review) => review.resolved.includes(id));
      return findings.map((finding) => {
        const decision = task.triage?.[finding.id], by = resolvedBy(finding.id);
        const badge = { text: !finding.real ? "Not real" : decision?.outcome ?? "Not triaged", fix: decision?.outcome === "FIX" };
        const el = item(finding.id, badge, node("p", "fct-ftext", finding.text), decision ? node("small", "fct-why", decision.reason) : null,
          node("small", "fct-why", by ? `Marked resolved by ${by.final ? "final review" : "review"} ${by.executionId}` : "Not marked resolved in the record"));
        el.dataset.fctArchFinding = finding.id;
        return el;
      });
    }
    function shippedPart(task) {
      const runs = (task.executions ?? []).filter((run) => SHIPPING[run.kind]);
      if (!runs.length) return empty("No commit, push or publish was recorded for this task.");
      return runs.map((run) => {
        const result = `${TASK_RUN[run.status] ?? run.status}${run.status === "success" && !run.verified ? ", not verified" : ""}`;
        const el = item(SHIPPING[run.kind], { text: result }, node("small", "fct-why", `${roleOf(run.role)} · run ${run.id}`), chips(run.evidence));
        el.dataset.fctArchShip = run.kind;
        return el;
      });
    }
    function runsPart(executions) {
      if (!executions.length) return empty("No runs were returned.");
      return executions.map((run) => {
        const model = run.assignment ? `${page.cliLabel(run.assignment.cli)} · ${run.assignment.model} · ${run.assignment.effort}` : "Model not recorded";
        const el = item(`${roleOf(run.role)} · ${kind(run.kind)}`, { text: JOURNAL_RUN[run.status] ?? String(run.status), fix: run.status === "failed" },
          node("small", "fct-why", run.taskId === null ? `${model} · before this task was created` : model),
          run.selectionReason ? node("p", "fct-ftext", run.selectionReason) : null, run.logPath ? chips([run.logPath]) : null);
        el.dataset.fctArchRun = run.id;
        return el;
      });
    }
    function taskView(tab, a, f) {
      const detail = a.detail?.taskId === a.selected ? a.detail : null;
      const box = region(tab, "Finished task", back("Back to finished tasks", "list", "arch-back-list"), f, a.stale && Boolean(detail));
      box.append(node("p", "fct-aid", a.selected));
      if (a.detailStatus === "loading") { box.append(loading("Opening task...")); return box; }
      if (a.detailStatus === "error") { box.append(failure("Could not open this task.", a.detailError, "task-error")); return box; }
      if (!detail) return box;
      const { task, manifest, executions } = detail, top = node("dl", "fct-dl fct-atop");
      row(top, "Scope", task.plan.scope);
      row(top, "Finished", when(manifest.completedAt));
      row(top, "Reason", manifest.reason);
      const key = (part) => `${task.id}|${part}`;
      box.append(top,
        disclosure(a, key("plan"), "Plan", planPart(task)),
        disclosure(a, key("checks"), `Checks · ${(task.checks ?? []).length}`, checksPart(task)),
        disclosure(a, key("reviews"), `Reviews · ${(task.reviews ?? []).length}`, reviewsPart(task)),
        disclosure(a, key("findings"), `Findings · ${(task.findings ?? []).length}`, findingsPart(task)),
        disclosure(a, key("shipped"), "What shipped", shippedPart(task)),
        disclosure(a, key("runs"), `Runs · ${executions.length}`, runsPart(executions)));
      return box;
    }

    // The archive part of the panel for the tab's current Finished tasks state (a: task-events.js archive state, f: the panel's facts).
    const render = (tab, a, f) => (a.mode === "task" ? taskView(tab, a, f) : listView(tab, a, f));
    return { entry, unavailable, render };
  };
})();
