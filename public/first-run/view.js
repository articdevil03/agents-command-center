// Command Center setup wizard (Pack 29): shown only while the server says setup is not finished (state.firstRun.required === true).
// Four steps, one at a time: Welcome, the project folder, a ready AI tool (the leader CLI), Ready. Start sends completeFirstRun and the
// server re-checks the folder, the name and that the CLI is installed and signed in, so this page never decides readiness alone.
// A tool added by its start command (ACP, other-tool.js) can lead too: only when the person picks it and ticks the Full access box, and
// only then does Start send acpConsent. Install (install.js) runs on the server; while it runs or is stopping the step cannot be left.
// This file is the controller; the markup is in steps.js, the tool rows in tools.js and other-tool.js. Classic script: the page hands its helpers over
// through init (public/app/10-dialogs-seat-card.js), the same way the fixed crew UI gets them.
"use strict";
(() => {
  const HELP = window.CC_FIRST_RUN_HELP, UI = window.CC_FIRST_RUN_STEPS, TOOLS = window.CC_FIRST_RUN_TOOLS, OTHER = window.CC_FIRST_RUN_OTHER;
  const CATALOG = window.CC_FIRST_RUN_CATALOG, INSTALL = window.CC_FIRST_RUN_INSTALL;
  // Action keys in the page's shared action tracking (sendSettingsAction): the server's actionResult or error for the request id lands there.
  const KEY = { complete: "first-run-complete", skip: "first-run-skip", refresh: "first-run-refresh" };

  // The project id the server derives from the name (server/first-run/complete.ts): a name without a letter or digit gets none.
  const projectSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const folderName = (folder) => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const isAbsolute = (folder) => /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(folder);

  function init(page) {
    // login: the page's one sign-in controller (public/first-run/login.js), shared with Settings.
    const login = page.cliLogin;
    if (!HELP || !UI || !TOOLS || !OTHER || !CATALOG || !INSTALL || !login) return null;
    const { STEPS } = UI, LAST = STEPS.length - 1, stepIndex = (id) => STEPS.findIndex((step) => step.id === id);
    // The draft lives in memory only while the screen is open; nothing is saved until Start.
    const draft = { step: 0, folder: "", name: "", nameEdited: false, projectOnly: true, leader: "", attempt: "", last: "", acpName: "", acpCmd: "", otherOpen: false, consentFor: "", search: "" };
    const openHelp = new Set();
    let root = null, autoChecked = false, wasBusy = false;
    const drawn = { rows: "", acp: "", providers: "", leader: "", review: "" };
    const canBrowse = () => Boolean(window.cc && typeof window.cc.pickFolder === "function");
    const isShown = () => Boolean(root?.isConnected && !root.hidden && root.querySelector(".frun") && page.state?.firstRun?.required === true);
    const q = (id) => root.querySelector(`#${id}`);
    function action(key) { const id = page.settingsActionId(key); return id ? page.actionStateFor(id) ?? { requestId: id, status: "running" } : null; }
    const running = (key) => action(key)?.status === "running";
    const other = OTHER.create(page, { action, running, draft, sentence: TOOLS.sentence, leader: () => tools.leader() });
    const catalog = CATALOG.create(page), install = INSTALL.create(page, { action, running, catalog });
    const tools = TOOLS.create(page, { help: HELP, action, running, refreshKey: KEY.refresh, openHelp, draft, other, catalog, install, login });
    // An installation or a sign-in that runs (or may still run) holds the step.
    const held = () => install.locked() || login.busy();
    // An added tool leads only with the Full access box ticked for that very tool (a change of leader clears the tick).
    const addedLeader = () => other.find(tools.leader());
    const consented = () => Boolean(addedLeader()) && draft.consentFor === tools.leader();
    const attemptKey = () => JSON.stringify([draft.folder, draft.name.trim(), tools.leader(), draft.projectOnly, consented()]);
    const busy = () => running(KEY.complete) || running(KEY.skip);
    // A window that comes back to the front checks the tools once: the user may have just installed or signed in to one. Never while
    // an installation runs or is stopping: the server is already checking that tool, and a check must not race its result.
    window.addEventListener("focus", () => { if (isShown() && !held()) checkAgain(); });
    // While an installation or a sign-in runs or may still run, the step is held: no Next, Back, Change or Skip until it ends.
    function lockBlocker() {
      if (install.locked()) return install.installOf(install.lockedId())?.state === "stuck" ? "Stop the installation before you go on." : "Wait for the installation to finish, or press Cancel.";
      const signing = login.busyId();
      return !signing ? "" : login.viewOf(signing).state === "stuck" ? "Stop the sign-in before you go on." : "Wait for sign-in to finish, or press Cancel.";
    }

    function folderBlocker() {
      if (!draft.folder) return canBrowse() ? "Choose a folder to go on." : "Type the folder's path to go on.";
      if (!isAbsolute(draft.folder)) return "Type the full folder path, starting with the drive, like C:\\.";
      if (!draft.name.trim()) return "Give the project a name.";
      if (!projectSlug(draft.name.trim())) return "Use at least one letter (a to z) or number in the name.";
      return "";
    }
    // A running check never blocks a Ready tool: a click back into the window starts one, and must not swallow the click behind it.
    function toolBlocker() {
      const tool = addedLeader();
      if (tool) return consented() ? "" : `Tick the Full access box to use ${tool.name}.`;
      if (tools.leader()) return "";
      if (other.kinds().length) return "Choose which tool leads.";
      return running(KEY.refresh) ? "Looking for AI tools…" : "Install and sign in to one AI tool, then press Check again.";
    }
    const blocker = () => folderBlocker() || toolBlocker();
    const stepBlocker = (index) => lockBlocker() || [() => "", folderBlocker, toolBlocker, blocker][index]();

    function statusLine() {
      if (running(KEY.complete)) return { text: "Setting up your project…" };
      if (running(KEY.skip)) return { text: "Skipping setup…" };
      const result = action(draft.last === "skip" ? KEY.skip : KEY.complete);
      const current = draft.attempt === attemptKey(); // an input changed since: the old refusal is about something else
      if (result && current && result.status === "failed") return { text: `${draft.last === "skip" ? "Not skipped" : "Not started"}: ${TOOLS.sentence(result.message)}`, bad: true };
      if (result && current && result.status === "unknown") return { text: "The connection dropped before the server answered. Try again.", bad: true };
      const why = blocker();
      return why ? { text: why } : { text: `Opens ${draft.name.trim()} with ${page.cliLabel(tools.leader())} as the leader${addedLeader() ? ", with Full access" : ""}.` };
    }

    function mount() {
      root.innerHTML = UI.skeleton(canBrowse(), HELP, page.esc); drawn.rows = drawn.acp = drawn.providers = drawn.leader = drawn.review = "";
      q("frunBrowse")?.addEventListener("click", () => page.pickFolder((folder) => { setFolder(folder); update(); q("frunBrowse")?.focus({ preventScroll: true }); }));
      q("frunFolder")?.addEventListener("input", (event) => { setFolder(event.target.value.trim()); update(); });
      q("frunName").addEventListener("input", (event) => { draft.name = event.target.value; draft.nameEdited = Boolean(draft.name.trim()); update(); });
      q("frunOnly").addEventListener("change", (event) => { draft.projectOnly = event.target.checked; update(); });
      q("frunCheck").addEventListener("click", () => checkAgain());
      q("frunNext").addEventListener("click", next);
      q("frunBack").addEventListener("click", () => goTo(draft.step - 1));
      q("frunStart").addEventListener("click", start);
      q("frunSkip").addEventListener("click", (event) => skip(event.currentTarget));
      q("frunTools").addEventListener("click", onToolClick);
      q("frunProviders").addEventListener("click", onToolClick);
      q("frunSearch").addEventListener("input", (event) => { draft.search = event.target.value; update(); });
      q("frunReview").addEventListener("click", (event) => { const id = event.target.closest("[data-frun-goto]")?.dataset.frunGoto; if (id) goTo(stepIndex(id)); });
      q("frunLeader").addEventListener("change", (event) => { if (event.target.name !== "frunLeader") return; if (draft.leader !== event.target.value) draft.consentFor = ""; draft.leader = event.target.value; drawn.leader = tools.leaderKey(); update(); });
      q("frunGuideCopy").addEventListener("click", () => copyText(HELP.providers.page));
      other.bind(q, update);
      // Enter in a text field moves on when the step is complete, like a form; inside the Add form it adds the tool instead.
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.defaultPrevented || event.target.closest?.(".cli-login,.cli-key-panel") || other.onEnter(event, update)) return;
        if (event.target.matches?.("input:not([type=checkbox]):not([type=radio])")) { event.preventDefault(); next(); }
      });
      if (q("frunFolder")) q("frunFolder").value = draft.folder;
      q("frunName").value = draft.name; q("frunOnly").checked = draft.projectOnly; q("frunSearch").value = draft.search; q("frunAcpName").value = draft.acpName; q("frunAcpCmd").value = draft.acpCmd;
    }
    function setFolder(folder) {
      draft.folder = folder;
      if (!draft.nameEdited) { draft.name = folderName(folder); q("frunName").value = draft.name; }
    }

    function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
    function drawIfChanged(slot, el, html) { if (drawn[slot] !== html) { el.innerHTML = html; drawn[slot] = html; } }
    function updateFooter(step, working, status) {
      root.querySelectorAll("[data-mark]").forEach((mark, index) => {
        if (index === step) mark.setAttribute("aria-current", "step"); else mark.removeAttribute("aria-current");
        mark.dataset.done = String(index < step);
      });
      // Changes only when the step changes, so the step is announced once and not on every redraw.
      setText(q("frunCount"), `Step ${step + 1} of ${STEPS.length}: ${STEPS[step].title}`);
      const locked = held();
      q("frunBack").hidden = step === 0; q("frunBack").disabled = working || locked;
      q("frunNext").hidden = step === LAST; q("frunStart").hidden = step !== LAST;
      setText(q("frunNext"), step === 0 ? "Get started" : "Next");
      // Skip works from any step: its progress and a refusal show beside the buttons (the Ready step shows them in its own status line).
      const skipNote = step < LAST && draft.last === "skip" && (running(KEY.skip) || status.bad) ? status.text : "";
      const why = step < LAST ? stepBlocker(step) : "";
      q("frunNext").disabled = working || Boolean(why); setText(q("frunWhy"), skipNote || why);
      q("frunWhy").classList.toggle("bad", Boolean(skipNote && status.bad));
      q("frunSkip").disabled = working || locked;
    }
    function update() {
      const step = draft.step;
      root.querySelectorAll("[data-step]").forEach((section) => { section.hidden = section.dataset.step !== STEPS[step].id; });
      const path = q("frunPath");
      if (path) { setText(path, draft.folder || "No folder chosen"); path.title = draft.folder || "No folder chosen"; path.dataset.none = String(!draft.folder); }
      keepFocus(() => {
        drawIfChanged("rows", q("frunTools"), tools.rowsHtml(draft.search));
        drawIfChanged("acp", q("frunAcpRows"), other.rowsHtml(draft.search));
        drawIfChanged("providers", q("frunProviders"), tools.providersHtml(draft.search));
        login.mount(q("frunTools"), "wizard"); // each row's sign-in panel: the same element every time, brought up to date
        page.cliKeys?.mount(q("frunTools"), "wizard");
      });
      q("frunLeadBox").hidden = !drawn.rows && !drawn.acp; q("frunModelBox").hidden = !drawn.providers;
      setText(q("frunNoMatch"), q("frunLeadBox").hidden && q("frunModelBox").hidden && draft.search.trim() ? `No tool or model matches “${draft.search.trim()}”.` : "");
      setText(q("frunLive"), tools.liveText());
      if (tools.leaderKey() !== drawn.leader) { q("frunLeader").innerHTML = tools.leaderHtml(); drawn.leader = tools.leaderKey(); }
      if (q("frunUntested")) q("frunUntested").hidden = !tools.untested(tools.leader());
      const added = other.settle();
      other.sync(q, setText);
      // A tool just added: focus moves to its choice, but only from inside the form (or from nowhere), never away from elsewhere.
      const from = document.activeElement;
      if (added && (!from || from === document.body || from.closest?.("#frunOther"))) root.querySelector(`[data-focus-key="frun-leader-${CSS.escape(added)}"]`)?.focus({ preventScroll: false });
      drawIfChanged("review", q("frunReview"), UI.reviewHtml(page, { folder: draft.folder, name: draft.name, projectOnly: draft.projectOnly, leader: tools.leader(), fullAccess: Boolean(addedLeader()) }));
      setText(q("frunSum"), tools.summary());
      const working = busy(), status = statusLine(), startButton = q("frunStart");
      setText(q("frunStatus"), status.text); q("frunStatus").classList.toggle("bad", Boolean(status.bad));
      startButton.disabled = working || Boolean(blocker());
      setText(startButton, running(KEY.complete) ? "Starting…" : "Start Command Center");
      q("frunCheck").disabled = running(KEY.refresh); setText(q("frunCheck"), running(KEY.refresh) ? "Checking…" : "Check again");
      root.querySelector('[data-step="ready"]').setAttribute("aria-busy", String(working));
      updateFooter(step, working, status);
      // A refusal re-enables Start: give it focus back when it was lost with the busy state.
      if (wasBusy && !working && !startButton.disabled && (!document.activeElement || document.activeElement === document.body)) startButton.focus({ preventScroll: true });
      wasBusy = working;
    }
    // A redraw of the row lists keeps keyboard focus: on the same control when it is still there, else on that row's first live button.
    function keepFocus(draw) {
      const from = document.activeElement, inRows = from?.closest?.("#frunTools,#frunProviders,#frunAcpRows") ? from : null;
      const key = inRows?.dataset.focusKey ?? "", row = inRows?.closest("[data-cli]")?.dataset.cli ?? "";
      draw();
      if (!inRows) return;
      // A control that was moved with its row (a sign-in panel) is the same element: it only gets focus back.
      if (inRows.isConnected) { if (document.activeElement !== inRows && inRows.checkVisibility() && !inRows.disabled) inRows.focus({ preventScroll: true }); return; }
      const usable = (el) => el && !el.disabled && el.checkVisibility();
      const same = key ? root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : null;
      const sibling = row ? [...root.querySelectorAll(`[data-cli="${CSS.escape(row)}"] button`)].find(usable) : null;
      [same, sibling, q("frunSearch")].find(usable)?.focus({ preventScroll: true });
    }
    function goTo(index) {
      if (index < 0 || index > LAST || index === draft.step || busy() || held()) return;
      draft.step = index; update();
      root.querySelector(".frun-stage").scrollTop = 0;
      q(`frunH-${STEPS[index].id}`).focus({ preventScroll: true });
    }
    function next() {
      if (draft.step === LAST) { start(); return; }
      if (!stepBlocker(draft.step)) goTo(draft.step + 1);
    }
    function render(el) {
      root = el;
      if (!root.querySelector(".frun")) mount();
      // A page opened while an installation runs (a reload) shows that installation: the AI tool step, held until it ends.
      if (!autoChecked && held()) draft.step = stepIndex("tools");
      update();
      if (!autoChecked) { autoChecked = true; if (HELP.order.some((cli) => typeof page.state?.settings?.tools?.[cli]?.installed !== "boolean")) checkAgain(); }
    }
    function redraw(focusKey) {
      update();
      const target = root.querySelector(`[data-focus-key="${focusKey}"]`);
      (target && !target.disabled ? target : q("frunCheck"))?.focus({ preventScroll: true });
    }

    function checkAgain() {
      if (running(KEY.refresh) || !page.connected()) return;
      const id = page.sendSettingsAction(KEY.refresh, { type: "refreshSettings" });
      if (!id) return;
      // The server answers success and failure alike; if it never answers, "Checking" does not stay on forever.
      setTimeout(() => { if (page.settingsActionId(KEY.refresh) === id && running(KEY.refresh)) { page.retireAction({ requestId: id, status: "failed", message: "No answer" }); if (isShown()) update(); } }, page.refreshWaitMs);
      if (root?.querySelector(".frun")) update();
    }
    function onToolClick(event) {
      const button = event.target.closest("button"); if (!button || button.disabled || button.closest(".cli-login")) return; // the panel has its own clicks
      const { frunLogin: signIn, frunHelp: help, frunCopy: copy, frunInstall: add, frunCancel: stop, frunRecheck: recheck, frunConnect: link } = button.dataset;
      const off = button.getAttribute("aria-disabled") === "true";
      // Install, Cancel and Connect send only the tool's id (install.js); Install is the consent, so it asks nothing more.
      if (add) { if (install.install(add)) redraw(`frun-cancel-${add}`); return; }
      if (stop) { if (!off && install.cancel(stop)) redraw(`frun-cancel-${stop}`); return; }
      if (recheck) { if (!off) checkAgain(); return; }
      if (link) { if (!off && install.connect(link)) redraw(`frun-connect-${link}`); return; }
      if (button.hasAttribute("data-frun-to-opencode")) { toOpenCode(); return; }
      // Sign in sends only the tool's id (login.js), and only for a managed tool that is installed, not signed in, with nothing else running.
      if (signIn) { if (login.start(signIn)) redraw(`frun-login-${signIn}`); return; }
      if (help) {
        if (openHelp.has(help)) openHelp.delete(help); else openHelp.add(help);
        redraw(`frun-help-${help}`);
        // An opened guide comes into view with its row, so the steps are seen and the button keeps its place at the top.
        if (openHelp.has(help)) q(`frunHelp-${CSS.escape(help)}`)?.closest(".frun-tool")?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (copy) copyText(tools.guideInfo(copy)?.page ?? "");
    }
    // "Go to OpenCode" under the models: brings the OpenCode row into view (clearing a search that hides it) and focuses its action.
    function toOpenCode() {
      if (!catalog.matches("opencode", draft.search)) { draft.search = ""; q("frunSearch").value = ""; update(); }
      const row = q("frunTools").querySelector('[data-cli="opencode"]');
      row?.scrollIntoView({ block: "nearest" });
      ([...(row?.querySelectorAll("button") ?? [])].find((el) => !el.disabled) ?? q("frunSearch")).focus({ preventScroll: true });
    }
    // Copy the official guide address.
    async function copyText(text, what = "address") {
      const done = `${what[0].toUpperCase()}${what.slice(1)} copied`;
      try { await navigator.clipboard.writeText(text); page.showToast(done); }
      catch {
        const input = document.createElement("textarea"); input.value = text; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select();
        const copied = document.execCommand("copy"); input.remove(); page.showToast(copied ? done : `Could not copy. Select the ${what} and copy it by hand`);
      }
    }
    function start() {
      // Read again from the current state: a button forced on through the page still sends nothing that is not ready here.
      if (busy() || blocker() || held() || draft.step !== LAST) return;
      const payload = { type: "completeFirstRun", name: draft.name.trim(), folder: draft.folder, cli: tools.leader(), projectOnly: draft.projectOnly };
      if (consented()) payload.acpConsent = true; // only for an added tool the person ticked the Full access box for; never for a built-in
      const sent = page.sendSettingsAction(KEY.complete, payload);
      if (sent) { draft.attempt = attemptKey(); draft.last = "complete"; }
      update();
    }
    function skip(opener) {
      if (busy() || held()) return;
      const kept = other.addedCount() ? " Tools you added stay saved." : "";
      page.confirmAction({ title: "Skip setup?", body: `The example project stays, and you can add your own project any time with the + button at the top.${kept}`, ok: "Skip setup", cancel: "Back to setup" }, () => {
        if (page.sendSettingsAction(KEY.skip, { type: "skipFirstRun" })) { draft.attempt = attemptKey(); draft.last = "skip"; }
        if (isShown()) update();
      }, opener);
    }
    return { render };
  }
  window.CC_FIRST_RUN = Object.freeze({ init });
})();
