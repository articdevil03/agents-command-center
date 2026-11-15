// Command Center setup wizard, other AI tools (Pack 29): the tools-versus-models note, the rows for tools added by their start command
// (ACP, the list Settings shows), the Full access acknowledgement and the "Use a different AI tool" form. Classic script, loaded after
// cli-help.js and before tools.js. The form only sends the existing addAcpCli message: the server checks the command, finds the program
// and saves it. Nothing here runs, installs or tests the typed command; the app starts the tool the first time the person chats.
// An added tool has no sign-in to check, so it is never called Ready, signed in or connected: it is "Added".
"use strict";
(() => {
  // A wizard-only action key: Settings' own "acp-add" key also carries Settings form bookkeeping (public/app/07-chat.js).
  const KEY = "first-run-acp-add";
  const ROW_NOTE = "Added. Connection checked when you first chat.";
  const CONSENT = "I understand this tool runs with Full access: it may edit files and run commands without asking, and I trust it.";
  const TRUST = "Command Center saves this command now and starts it only when you first chat. Only add a tool you trust.";
  const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Markup that is drawn once with the wizard and never replaced by a state broadcast, so typed text, ticks and focus survive.
  const introHtml = (help, esc) => `<p class="frun-note">${esc(help.models)}</p>
      <div class="frun-guide"><span class="frun-guide-l">${esc(help.providers.label)}</span><code>${esc(help.providers.page)}</code><button type="button" class="btn sm" id="frunGuideCopy">Copy address</button></div>`;
  const consentHtml = () => `<label class="frun-consent" id="frunConsentBox" hidden><input type="checkbox" id="frunConsent"><span>${CONSENT}</span></label>`;
  const formHtml = () => `<div class="frun-other"><button type="button" class="frun-more" id="frunOtherToggle" aria-expanded="false" aria-controls="frunOther">${CHEVRON}<span>Use a different AI tool</span></button>
      <div class="frun-otherbody" id="frunOther" role="group" aria-labelledby="frunOtherToggle" hidden>
        <p class="frun-note">Any AI coding tool that supports ACP (Agent Client Protocol) can lead, like Gemini CLI. Install it first, then add it here.</p>
        <div class="frun-addrow"><div class="field"><label class="lbl" for="frunAcpName">Name</label><input id="frunAcpName" maxlength="40" autocomplete="off" spellcheck="false" placeholder="Gemini CLI"></div>
          <div class="field"><label class="lbl" for="frunAcpCmd">Start command</label><input id="frunAcpCmd" maxlength="300" autocomplete="off" spellcheck="false" placeholder="gemini --acp" aria-describedby="frunAcpHint"></div>
          <button type="button" class="btn" id="frunAcpAdd" aria-describedby="frunAcpMsg">Add tool</button></div>
        <p class="frun-hint" id="frunAcpHint">The command shown is only an example. Follow your tool's own guide for its exact start command.</p>
        <p class="frun-hint">${TRUST}</p><p class="frun-addmsg" id="frunAcpMsg" aria-live="polite"></p></div></div>`;

  // page: the helpers the page hands over; ctx: the wizard's action tracking, the draft and the current leader.
  function create(page, { action, running, draft, sentence, leader }) {
    const list = () => (Array.isArray(page.state?.acpClis) ? page.state.acpClis : []).filter((item) => typeof item?.kind === "string" && typeof item?.name === "string");
    const find = (kind) => list().find((item) => item.kind === kind) ?? null;
    // A saved tool the server marks not leader-eligible (a catalog tool whose connection is not verified) is never a leader choice.
    const kinds = () => list().filter((item) => item.leaderEligible !== false).map((item) => item.kind);
    // Saved entries the catalog owns (its Connect adds them) are shown by their own catalog row, never as a second "Added" row.
    const owned = () => new Set((Array.isArray(page.state?.cliCatalog) ? page.state.cliCatalog : []).map((entry) => entry?.leader?.connectionId).filter(Boolean));
    const typed = () => JSON.stringify([draft.acpName.trim(), draft.acpCmd.trim()]);
    let pending = null, note = null, added = 0;

    // query: the step's search text; a saved tool matches on its name.
    function rowsHtml(query = "") {
      const skip = owned(), words = String(query).trim().toLowerCase();
      return list().filter((item) => !skip.has(item.id) && (!words || item.name.toLowerCase().includes(words))).map((item) => `<div class="crow frun-tool frun-acp" data-acp="${page.esc(item.kind)}" data-status="added"><span class="logo">${page.logo(item.kind, 18, 0)}</span><div class="d"><b title="${page.esc(item.name)}">${page.esc(item.name)}</b><small class="wrap" title="${page.esc([item.program, ...(item.args ?? [])].join(" "))}">${ROW_NOTE}</small></div><div class="tool-row-action"><span class="frun-chip" data-state="added">Added</span></div></div>`).join("");
    }
    function submit() {
      if (running(KEY)) return; // a second press while the first is still out is ignored
      const name = draft.acpName.trim(), command = draft.acpCmd.trim();
      if (!name || !command) { note = { text: name ? "Type the command that starts the tool first." : command ? "Type a name for the tool first." : "Type a name and the start command first.", bad: true, typed: typed() }; return; }
      const id = page.sendSettingsAction(KEY, { type: "addAcpCli", name, command });
      if (!id) { note = { text: "Not connected to Command Center. Try again in a moment.", bad: true, typed: typed() }; return; }
      pending = { id, name, typed: typed(), before: new Set(kinds()) }; note = null;
    }
    // After the rows and the leader choice are drawn: the answer to an Add. Returns the kind of a tool just added (focus goes to its choice).
    function settle() {
      const result = pending ? action(KEY) : null;
      if (!result || result.requestId !== pending.id || result.status === "running") return "";
      const done = pending; pending = null;
      if (result.status !== "done") { note = { text: result.status === "unknown" ? "The connection dropped before the server answered. Try again." : `Not added: ${sentence(result.message)}`, bad: true, typed: done.typed }; return ""; }
      const fresh = list().find((item) => !done.before.has(item.kind)) ?? list().find((item) => item.name === done.name) ?? null;
      added += 1; draft.acpName = draft.acpCmd = "";
      note = { text: `${fresh?.name ?? done.name} added.`, bad: false, typed: typed() };
      return fresh?.kind ?? "";
    }
    // The form message: a refusal or "added" shows only while the fields still hold what it was about.
    function message() {
      if (running(KEY)) return { text: `Adding ${pending?.name ?? "the tool"}…`, bad: false };
      return note && note.typed === typed() ? note : { text: "", bad: false };
    }
    function sync(q, setText) {
      const busy = running(KEY), tool = find(leader());
      q("frunOtherToggle").setAttribute("aria-expanded", String(draft.otherOpen)); q("frunOther").hidden = !draft.otherOpen;
      // Not disabled while it runs, so keyboard focus stays on it; a press then is ignored by submit().
      const add = q("frunAcpAdd"); add.setAttribute("aria-disabled", String(busy)); setText(add, busy ? "Adding…" : "Add tool");
      if (q("frunAcpName").value !== draft.acpName) q("frunAcpName").value = draft.acpName;
      if (q("frunAcpCmd").value !== draft.acpCmd) q("frunAcpCmd").value = draft.acpCmd;
      const shown = message(); setText(q("frunAcpMsg"), shown.text); q("frunAcpMsg").classList.toggle("bad", Boolean(shown.bad));
      q("frunConsentBox").hidden = !tool; q("frunConsent").checked = Boolean(tool) && draft.consentFor === tool.kind;
    }
    function bind(q, update) {
      q("frunOtherToggle").addEventListener("click", () => { draft.otherOpen = !draft.otherOpen; update(); if (draft.otherOpen) q("frunOther").scrollIntoView({ block: "nearest" }); });
      q("frunAcpName").addEventListener("input", (event) => { draft.acpName = event.target.value; update(); });
      q("frunAcpCmd").addEventListener("input", (event) => { draft.acpCmd = event.target.value; update(); });
      q("frunAcpAdd").addEventListener("click", () => { submit(); update(); });
      q("frunConsent").addEventListener("change", (event) => { draft.consentFor = event.target.checked ? leader() : ""; update(); });
    }
    // Enter inside the form adds the tool and never moves the wizard on. Returns true when the key belongs to the form.
    function onEnter(event, update) {
      if (!event.target.closest?.("#frunOther")) return false;
      if (event.target.matches("input")) { event.preventDefault(); submit(); update(); }
      return true;
    }
    return { list, find, kinds, rowsHtml, settle, sync, bind, onEnter, addedCount: () => added };
  }
  window.CC_FIRST_RUN_OTHER = Object.freeze({ create, introHtml, consentHtml, formHtml });
})();
