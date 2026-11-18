// Command Center, signing in to an AI tool without a terminal (Pack 29 W5 U1): one controller and one sign-in panel per tool, shared by
// the setup wizard's tool rows (tools.js) and the Settings tool rows (public/app/11-settings-render.js). Classic script, loaded before
// tools.js. The server owns the hidden sign-in process. Command flows send ids and a one-shot code; OpenCode sends ids and a one-shot
// API key through submitCliLoginKey. Explicit replacement alone adds confirm:true. No message carries a URL or command.
// Private: the sign-in capability (loginId) lives only in this file's memory (never storage, the DOM, a data attribute or a log); the
// address and device code are shown as text nodes only; a pasted code is read from its box, sent once, and the box is cleared at once.
"use strict";
(() => {
  // The server's static words per reason (the frozen contract). Anything unknown reads as an unfinished sign-in.
  const REASON = Object.freeze({
    githubMissing: "GitHub CLI is not installed on this PC.",
    unsupportedVersion: "OpenCode 1 is needed.",
    existingCredentials: "A credential is already saved.",
    environmentCredentials: "OpenCode is using credentials set outside Command Center. Remove that setting in Windows Settings before adding a key here.",
    credentialUnknown: "Could not check saved credentials.", invalidKey: "Enter an OpenCode Go API key.",
    keyFailed: "Could not save the key. Try again.", possiblySaved: "The key may have been saved. Check again.",
    unsupported: "This tool has no verified sign-in flow in Command Center yet.",
    notInstalled: "Install the tool first.",
    installationUnknown: "Could not confirm the installation.",
    busy: "Another installation or sign-in is running.",
    launchFailed: "Could not start sign-in.",
    unsafeOutput: "The tool returned unsupported sign-in information.",
    outputLimit: "The tool returned unsupported sign-in information.",
    browserUnavailable: "Could not open the browser. Copy the address below.",
    cancelled: "Sign-in stopped.",
    timeout: "Sign-in expired. Try again.",
    cleanupUnconfirmed: "Could not confirm sign-in stopped.",
    statusUnknown: "Sign-in command finished. Connection will be checked when you first chat.",
    notSignedIn: "Sign-in did not finish. Try again.",
    loginFailed: "Sign-in did not finish. Try again.",
  });
  const TEXT = Object.freeze({
    starting: "Starting sign-in…",
    browser: "Finish signing in in your browser.",
    verifying: "Checking that you are signed in…",
    orphan: "Sign-in is already running. Cancel to start again.",
    stopping: "Stopping sign-in…",
    badCode: "That is not a sign-in code. Paste the code from the website.",
  });
  const reasonText = (reason) => REASON[Object.hasOwn(REASON, reason) ? reason : "loginFailed"];
  // Only markup without any value from the server: every address, code and name is put in afterwards as text.
  const SKELETON = `<p class="cli-login-status" aria-live="polite"></p><span class="cli-login-bar" role="progressbar" aria-label="Signing in"><i></i></span>
    <div class="cli-login-browser"><div class="cli-login-btns"><button type="button" class="btn sm primary" data-login-act="open">Open sign-in page</button><button type="button" class="btn sm" data-login-act="copy-url">Copy address</button></div>
      <div class="cli-login-url"><span class="cli-login-l">Sign-in address</span><code class="cli-login-addr"></code></div></div>
    <div class="cli-login-code"><span class="cli-login-l">Enter this code on the page:</span> <b class="cli-login-big"></b><button type="button" class="btn sm" data-login-act="copy-code">Copy code</button></div>
    <div class="cli-login-paste"><label class="cli-login-l">Paste the code from the website</label><div class="cli-login-pasterow"><input type="password" autocomplete="off" spellcheck="false" autocapitalize="off" data-secret="true"><button type="button" class="btn sm primary" data-login-act="send">Send</button></div><small class="cli-login-hint" aria-live="polite"></small></div>
    <div class="cli-login-replace" hidden><p>This replaces the OpenCode Go key saved on this PC.</p><button type="button" class="btn sm" data-login-act="replace">Use a different key</button></div>
    <div class="cli-login-acts"><button type="button" class="btn sm" data-login-act="stop">Stop again</button><button type="button" class="btn sm" data-login-act="cancel">Cancel</button></div>`;

  // Shown only when it is an https address without a user name or password; anything else is not shown at all.
  function safeUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048) return null;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : null; } catch { return null; }
  }
  const safeCode = (value) => (typeof value === "string" && value.trim() && value.length <= 64 ? value.trim() : null);
  const printable = (code) => code.length >= 1 && code.length <= 2048 && /^[\x20-\x7e]+$/.test(code);

  // page: send, newRequestId, sendSettingsAction, settingsActionId, actionStateFor, showToast, socket() (the live connection), state.
  function create(page) {
    const own = new Map(); // cli -> this page's own sign-in: { requestId, loginId, event, codeSent, socket }
    const panels = new Map(); // `${surface}:${cli}` -> { root, parts }
    const catalog = () => (Array.isArray(page.state?.cliCatalog) ? page.state.cliCatalog : []);
    const entry = (cli) => catalog().find((item) => item?.id === cli) ?? null;
    const nameOf = (cli) => cli === "github" ? "GitHub" : entry(cli)?.displayName ?? cli;
    function facts(id) {
      if (id === "github") return { installed: true, signedIn: page.state?.settings?.github?.connected === true };
      const legacy = page.state?.settings?.tools?.[id], more = page.state?.settings?.catalogTools?.[id] ?? null;
      if (id === "opencode") return more ?? {};
      return { installed: legacy?.installed ?? more?.installed ?? null, signedIn: legacy?.signedIn ?? more?.signedIn ?? null };
    }
    const managed = (cli) => cli === "github" || entry(cli)?.signIn?.managed === true;
    // The tool's own words when it has no managed sign-in; null for a managed tool.
    function unsupportedMessage(cli) {
      if (managed(cli)) return null;
      const text = entry(cli)?.signIn?.unsupportedMessage;
      return typeof text === "string" && text.trim() ? text.trim() : REASON.unsupported;
    }
    function shared(id) {
      const action = id === "github" ? page.state?.settings?.github?.action : page.state?.settings?.catalogTools?.[id]?.action;
      return action && typeof action === "object" && action.kind === "login" && typeof action.requestId === "string" ? action : null;
    }
    const key = (cli) => `login-${cli}`, cancelKey = (cli) => `login-cancel-${cli}`;
    function local(id) { const requestId = page.settingsActionId(id); return requestId ? page.actionStateFor(requestId) ?? { requestId, status: "running" } : null; }
    const stopFor = new Map(); // cli -> the sign-in a Cancel was sent for, so an unanswered Cancel never marks a later sign-in as stopping

    // What one tool's sign-in is doing: idle, running (phase), orphan (running, started before a reload: only Cancel), stuck (cleanup not
    // confirmed: Stop again), failed (reason), refused (the server said no before it started: message), done (reason, e.g. statusUnknown).
    function viewOf(cli) {
      const mine = own.get(cli), server = shared(cli), sent = local(key(cli)), view = settle(mine, server, sent);
      if (cli === "opencode" && view.state === "refused" && !Object.values(REASON).includes(view.text)) view.text = REASON.keyFailed;
      if (view.requestId) view.stopping = local(cancelKey(cli))?.status === "running" && stopFor.get(cli) === view.requestId;
      return view;
    }
    function settle(mine, server, sent) {
      const fresh = sent?.status === "running" && server?.requestId !== sent.requestId; // sent, the server has not published it yet
      let now = null, requestId = "";
      if (fresh) { requestId = sent.requestId; now = mine?.requestId === requestId && mine.event ? mine.event : { status: "running", phase: "starting" }; }
      else if (server) { requestId = server.requestId; now = server.status === "running" && mine?.requestId === requestId && mine.event ? mine.event : server; }
      else if (sent && sent.status !== "done") return { state: "refused", text: sent.status === "unknown" ? "The connection dropped before the server answered. Try again." : String(sent.message ?? "") };
      else return { state: "idle" };
      const mineNow = mine?.requestId === requestId;
      if (now.status === "running") return { state: mineNow ? "running" : "orphan", phase: now.phase ?? "starting", reason: now.reason ?? null, requestId, event: mineNow ? mine.event : null };
      if (now.status === "failed") return { state: now.cleanupPending === true || now.reason === "cleanupUnconfirmed" ? "stuck" : "failed", reason: now.reason ?? "loginFailed", cleanupPending: now.cleanupPending, requestId };
      return { state: "done", reason: now.reason ?? null, requestId };
    }
    const active = (cli) => ["running", "orphan", "stuck"].includes(viewOf(cli).state);
    const busyId = () => catalog().map((item) => item?.id).find((cli) => typeof cli === "string" && active(cli)) ?? [...own.keys()].find(active) ?? "";
    const installBusy = () => Object.values(page.state?.settings?.catalogTools ?? {}).some((tool) => tool?.action?.kind === "install" && (tool.action.status === "running" || (tool.action.status === "failed" && tool.action.reason === "cleanupUnconfirmed")));
    // Sign in is offered only for a managed tool that is installed and not signed in; it can start only while nothing else runs (a sign-in
    // sent but not yet published counts as running, so a double click never starts two).
    const keySupported = (cli) => cli !== "opencode" || facts(cli).supportedVersion === true;
    const replaceOffered = (cli) => cli === "opencode" && managed(cli) && facts(cli).installed === true && keySupported(cli) && facts(cli).credentialSource === "stored";
    const offered = (cli) => cli === "github" ? facts(cli).signedIn !== true : managed(cli) && facts(cli).installed === true && facts(cli).signedIn !== true && keySupported(cli) && !replaceOffered(cli);
    const canStart = (cli) => offered(cli) && !busyId() && !installBusy();

    function start(cli, replace = false) {
      if (replace ? !replaceOffered(cli) || busyId() || installBusy() : !canStart(cli)) return null;
      clearInputs(cli);
      const requestId = page.sendSettingsAction(key(cli), replace ? { type: "replaceCliLogin", cli, confirm: true } : { type: "cliLogin", cli });
      if (requestId) own.set(cli, { requestId, loginId: null, event: null, codeSent: -Infinity, socket: page.socket?.() });
      return requestId;
    }
    function cancel(cli) {
      clearInputs(cli);
      const view = viewOf(cli);
      if (!["running", "orphan", "stuck"].includes(view.state) || view.stopping) return null;
      const sent = page.sendSettingsAction(cancelKey(cli), { type: "cancelCliLogin", cli, loginRequestId: view.requestId });
      if (sent) stopFor.set(cli, view.requestId);
      return sent;
    }
    function openPage(cli) {
      const mine = own.get(cli), view = viewOf(cli);
      if (view.state !== "running" || !mine?.loginId || view.stopping || (cli === "opencode" && (view.phase !== "waitingKey" || mine.codeSent >= mine.event.revision))) return false;
      return page.send({ type: "openCliLogin", requestId: page.newRequestId(), cli, loginId: mine.loginId });
    }
    // The box is emptied and switched off before anything else, also when the send fails; the code is never kept.
    function submit(cli, parts) {
      const input = parts.input, code = input.value.trim();
      clearInputs(cli);
      if (!code) { if (cli === "opencode") { parts.hint.textContent = REASON.invalidKey; input.disabled = false; } return false; }
      input.value = ""; input.disabled = true;
      const mine = own.get(cli), event = mine?.event;
      if (cli === "opencode") {
        if (new TextEncoder().encode(code).length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(code)) { parts.hint.textContent = REASON.invalidKey; input.disabled = false; return false; }
        if (!mine?.loginId || viewOf(cli).state !== "running" || viewOf(cli).stopping || event?.status !== "running" || event.phase !== "waitingKey" || mine.codeSent >= event.revision) return false;
        mine.codeSent = event.revision; // Consume before send, including reentrant or failed sends. Never retain the key for retry.
        parts.hint.textContent = "";
        try { return page.send({ type: "submitCliLoginKey", requestId: page.newRequestId(), cli, loginId: mine.loginId, apiKey: code }); }
        catch { parts.hint.textContent = REASON.keyFailed; return false; }
      }
      if (!printable(code)) { parts.hint.textContent = TEXT.badCode; input.disabled = false; return false; }
      if (!mine?.loginId || event?.status !== "running" || event.phase !== "waitingCode" || mine.codeSent >= event.revision) return false;
      parts.hint.textContent = "";
      const sent = page.send({ type: "submitCliLoginCode", requestId: page.newRequestId(), cli, loginId: mine.loginId, code });
      if (sent) mine.codeSent = event.revision;
      return sent;
    }

    // The private event, only ever sent to this page: kept only for this page's own sign-in, newest revision only.
    function onEvent(message) {
      if (message?.type !== "cliLoginState" || typeof message.cli !== "string") return false;
      const mine = own.get(message.cli);
      if (!mine || message.loginRequestId !== mine.requestId) return true;
      if (typeof message.loginId === "string" && message.loginId) { if (mine.loginId && mine.loginId !== message.loginId) return true; mine.loginId = message.loginId; }
      const revision = Number.isFinite(message.revision) ? message.revision : (mine.event?.revision ?? 0) + 1;
      if (mine.event && revision <= mine.event.revision) return true;
      const running = message.status === "running";
      mine.event = { status: message.status, phase: message.phase ?? null, reason: message.reason ?? null, cleanupPending: message.cleanupPending === true, revision, pasteRequired: running && message.pasteRequired === true,
        verificationUrl: running ? message.cli === "github" ? message.verificationUrl === "https://github.com/login/device" ? message.verificationUrl : null : safeUrl(message.verificationUrl) : null, deviceCode: running ? message.cli === "github" ? /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(message.deviceCode) ? message.deviceCode : null : safeCode(message.deviceCode) : null };
      if (!running || (message.cli === "opencode" && message.phase !== "waitingKey")) clearInputs(message.cli);
      if (!running) mine.loginId = null; // the capability ends with the sign-in
      return true;
    }
    // Every state: a finished sign-in drops its private details; a new connection asks for the running one's details again.
    function onState() {
      for (const [cli, mine] of own) {
        const server = shared(cli);
        if (server?.requestId === mine.requestId && server.status !== "running") { clearInputs(cli); mine.loginId = null; if (mine.event) Object.assign(mine.event, { verificationUrl: null, deviceCode: null, pasteRequired: false }); }
        const socket = page.socket?.();
        if (mine.loginId && socket && mine.socket !== socket) {
          clearInputs(cli);
          mine.socket = socket;
          page.send({ type: "getCliLoginState", requestId: page.newRequestId(), cli, loginId: mine.loginId });
        }
      }
    }

    async function copy(text, what) {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); page.showToast(`${what} copied`); }
      catch {
        const box = document.createElement("textarea"); box.value = text; box.setAttribute("readonly", ""); box.style.position = "fixed"; box.style.opacity = "0"; document.body.append(box); box.select();
        const copied = document.execCommand("copy"); box.remove(); page.showToast(copied ? `${what} copied` : `Could not copy. Select the ${what.toLowerCase()} and copy it by hand`);
      }
    }
    function build(surface, cli) {
      const root = document.createElement("div");
      root.className = "cli-login"; root.hidden = true; root.setAttribute("role", "group"); root.setAttribute("aria-label", `Sign in to ${nameOf(cli)}`);
      root.innerHTML = SKELETON;
      const find = (selector) => root.querySelector(selector);
      const parts = { status: find(".cli-login-status"), bar: find(".cli-login-bar"), browser: find(".cli-login-browser"), url: find(".cli-login-url"), addr: find(".cli-login-addr"),
        code: find(".cli-login-code"), big: find(".cli-login-big"), paste: find(".cli-login-paste"), label: find(".cli-login-paste label"), input: find(".cli-login-paste input"),
        hint: find(".cli-login-hint"), replacement: find(".cli-login-replace"), acts: find(".cli-login-acts") };
      const inputId = `cliLoginCode-${surface}-${cli}`.replace(/[^A-Za-z0-9_-]/g, "-");
      parts.input.id = inputId; parts.label.htmlFor = inputId;
      parts.input.dataset.focusKey = `cli-login-code-${cli}`;
      if (cli === "opencode") { parts.label.textContent = "OpenCode Go API key"; parts.input.maxLength = 4096; }
      for (const button of root.querySelectorAll("[data-login-act]")) { parts[button.dataset.loginAct] = button; button.dataset.focusKey = `cli-login-${button.dataset.loginAct}-${cli}`; }
      root.addEventListener("click", (event) => {
        const button = event.target.closest("[data-login-act]");
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        const act = button.dataset.loginAct, view = viewOf(cli);
        if (act === "replace") { start(cli, true); paintAll(); return; }
        if (act === "copy-url") { copy(view.event?.verificationUrl, "Address"); return; }
        if (act === "copy-code") { copy(view.event?.deviceCode, "Code"); return; }
        if (act === "open") openPage(cli);
        else if (act === "send") submit(cli, parts);
        else cancel(cli); // cancel and stop: the same message, naming the sign-in's public request id
        paintAll();
      });
      parts.input.addEventListener("keydown", (event) => { if (event.key !== "Enter") return; event.preventDefault(); event.stopPropagation(); submit(cli, parts); paintAll(); });
      return { root, parts, cli };
    }
    const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    function paint(panel) {
      const { root, parts, cli } = panel, view = viewOf(cli), event = view.event;
      const focused = root.contains(document.activeElement) ? document.activeElement : null;
      const live = view.state === "running" || view.state === "orphan";
      const isKey = cli === "opencode", replacing = replaceOffered(cli) && !live && view.state !== "stuck";
      const asking = view.state === "running" && ["waitingBrowser", "waitingCode", "waitingKey"].includes(view.phase);
      const shown = (cli === "github" && view.state === "refused") || replacing || live || view.state === "stuck" || view.state === "failed" || (view.state === "done" && (isKey || Boolean(view.reason)));
      show(root, shown);
      let text = "";
      if (view.stopping && view.state !== "failed") text = TEXT.stopping;
      else if (view.state === "orphan") text = TEXT.orphan;
      else if (view.state === "running") text = view.reason === "browserUnavailable" ? REASON.browserUnavailable : isKey ? view.phase === "waitingKey" ? "Sign in with your OpenCode Go key" : "Saving your key…" : view.phase === "verifying" ? TEXT.verifying : asking ? TEXT.browser : TEXT.starting;
      else if (view.state === "stuck" || view.state === "failed" || view.state === "done") text = view.reason ? reasonText(view.reason) : "";
      if (view.state === "stuck" && view.reason === "possiblySaved") text += " Could not confirm sign-in stopped. Choose Stop again.";
      if (view.state === "failed" && view.reason === "possiblySaved" && view.cleanupPending === false) text = "Sign-in stopped. " + text;
      if (isKey && view.state === "done" && !view.reason) text = "Key saved. OpenCode will check it when you first chat.";
      if (cli === "github") {
        if (view.state === "running" && asking && !view.stopping) text = "Waiting for you to finish in your browser";
        else if (view.state === "refused") text = view.text || "Could not connect. Try again.";
        else if (view.state === "failed" && view.reason !== "cancelled") text = view.reason === "githubMissing" ? REASON.githubMissing : "Could not connect. Try again.";
        else if (view.state === "stuck") text = "Could not confirm sign-in stopped";
      }
      setText(parts.status, text);
      root.dataset.state = view.state; parts.status.classList.toggle("bad", view.state === "failed" || view.state === "stuck" || view.reason === "browserUnavailable");
      show(parts.bar, live);
      const url = asking ? event?.verificationUrl ?? null : null, code = asking && !isKey ? event?.deviceCode ?? null : null;
      show(parts.browser, Boolean(url)); setText(parts.addr, url ?? "");
      show(parts.url, !isKey); show(parts["copy-url"], !isKey);
      setText(parts.open, isKey ? "Get my key" : cli === "github" ? "Open GitHub" : "Open sign-in page");
      show(parts.code, Boolean(code)); setText(parts.big, code ?? "");
      const paste = !view.stopping && view.state === "running" && (isKey ? view.phase === "waitingKey" : view.phase === "waitingCode" && event?.pasteRequired === true);
      show(parts.paste, paste);
      if (!paste && parts.input.value) parts.input.value = "";
      const mine = own.get(cli);
      parts.input.disabled = !paste || !mine?.loginId || (mine.codeSent >= (event?.revision ?? 0));
      parts.send.disabled = parts.input.disabled;
      setText(parts.send, isKey ? "Save key" : "Send");
      if (isKey) parts.open.disabled = parts.input.disabled;
      show(parts.replacement, replacing);
      parts.replace.disabled = Boolean(busyId() || installBusy());
      if (!paste) setText(parts.hint, "");
      show(parts.acts, live || view.state === "stuck");
      show(parts.cancel, live); show(parts.stop, view.state === "stuck");
      for (const button of [parts.cancel, parts.stop]) { button.setAttribute("aria-disabled", String(Boolean(view.stopping))); }
      setText(parts.cancel, view.stopping ? "Stopping…" : "Cancel"); setText(parts.stop, view.stopping ? "Stopping…" : "Stop again");
      parts.cancel.setAttribute("aria-label", view.stopping ? "Stopping sign-in" : `Cancel signing in to ${nameOf(cli)}`);
      // Focus that sat on a control that just went away moves to the next live one in the panel, never to the page.
      if (focused && (!focused.checkVisibility?.() || focused.disabled)) [parts.send, parts.cancel, parts.stop, parts.open].find((el) => el.checkVisibility?.() && !el.disabled)?.focus({ preventScroll: true });
    }
    function panelFor(surface, cli) {
      const id = `${surface}:${cli}`;
      if (!panels.has(id)) panels.set(id, build(surface, cli));
      return panels.get(id);
    }
    function clearInputs(cli) { for (const panel of panels.values()) if (panel.cli === cli) panel.parts.input.value = ""; }
    function clearHiddenKeys() { for (const panel of panels.values()) if (panel.cli === "opencode" && (!panel.root.isConnected || !panel.parts.input.checkVisibility())) panel.parts.input.value = ""; }
    // Surface closure and filtering may detach a retained panel without a state event. Observe the final DOM after each draw.
    new MutationObserver(clearHiddenKeys).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    window.addEventListener("pagehide", () => clearInputs("opencode"));
    function paintAll() { for (const panel of panels.values()) if (panel.root.isConnected) paint(panel); clearHiddenKeys(); }
    // After a surface drew its rows: each row's slot gets that tool's one panel (the same element every time, so a typed code and the
    // controls survive any redraw), then it is brought up to date. The surface puts keyboard focus back (data-focus-key on every control).
    function mount(container, surface) {
      if (!container) return;
      for (const slot of container.querySelectorAll("[data-cli-login-slot]")) {
        const panel = panelFor(surface, slot.dataset.cliLoginSlot);
        if (panel.root.parentNode !== slot) slot.append(panel.root);
        paint(panel);
      }
    }
    return { managed, unsupportedMessage, offered, canStart, start, cancel, viewOf, busyId, busy: () => Boolean(busyId()), onEvent, onState, mount, paintAll, reasonText };
  }
  window.CC_CLI_LOGIN = Object.freeze({ create, REASON, TEXT, reasonText });
})();
