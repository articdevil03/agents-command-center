// Command Center setup wizard, the AI tool step (Pack 29): what the app FOUND on this PC for every tool in the server's catalog, each
// row's one action (Install, Check again, Sign in, Connect or Cancel), its sign-in panel (login.js), the models used through OpenCode and
// the leader choice. Classic script, loaded after catalog.js, other-tool.js, install.js and login.js, before view.js. Unknown (null) is
// never ready: only a confirmed install and sign-in count for a built-in. Any other tool may lead only when the server's leaderEligible says
// so, and is then "Not tested yet" (never Ready) until the server says it was tested; the server checks again at Start.
"use strict";
(() => {
  const CAT = window.CC_FIRST_RUN_CATALOG;
  const CHIP = { ready: "Ready", signin: "Sign in needed", nosignin: "Not signed in", missing: "Not found", checking: "Checking", unknown: "Unknown", installing: "Installing", installed: "Installed", stuck: "Not confirmed", signingin: "Signing in", untested: "Not tested yet", tested: "Tested" };
  const UNTESTED = "Not tested yet. Connection checked when you first chat.";
  const LEADER_NOTE = "The leader is the AI you chat with. It plans and hands work to the rest of the crew. Command Center uses one tool at a time; you can add more later in Settings.";
  const NOT_VERIFIED = "Installed. Leader connection not verified.";
  const sentence = (text) => { const value = String(text ?? "").trim() || "the server refused it"; return /[.!?]$/.test(value) ? value : `${value}.`; };
  const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Install by hand (the fallback): three plain steps, the maker's command in a box under step 2 with its own Copy button, what to do if
  // it still says Not found, and the maker's page as text to copy. It only shows text; nothing here runs it.
  function guideHtml(page, help, slug, label, info) {
    const esc = page.esc;
    const steps = (info.steps ?? help.steps).map((step) => `<li>${esc(step)}</li>`).join("");
    const address = info.page ? `<div class="frun-url"><span class="frun-url-l">More details</span><code>${esc(info.page)}</code><button type="button" class="btn sm" data-frun-copy="${slug}" data-focus-key="frun-copy-${slug}">Copy address</button></div>` : "";
    return `<p>${esc(info.about)}</p><ol class="frun-howto">${steps}</ol><p class="frun-hint">${esc(help.stillMissing)}</p>${address}`;
  }

  // page: the helpers the page hands over; ctx: the wizard's shared pieces (help texts, action tracking, open guides, the draft, other
  // tools, the catalog and the installation tracking).
  function create(page, { help, action, running, refreshKey, openHelp, draft, other, catalog, install, login }) {
    const esc = page.esc, builtIn = (id) => CAT.BUILT_IN.includes(id);
    const nameOf = (id) => (builtIn(id) ? page.cliLabel(id) : catalog.nameOf(id));
    // Install, version and sign-in: settings.tools where the server reports a tool there (the built-ins, Gemini), else catalogTools.
    function toolOf(id) {
      const legacy = page.state?.settings?.tools?.[id], facts = page.state?.settings?.catalogTools?.[id] ?? null;
      if (id === "opencode") return facts;
      if (!legacy) return facts;
      return { ...(facts ?? {}), installed: legacy.installed ?? facts?.installed ?? null, signedIn: legacy.signedIn ?? facts?.signedIn ?? null, version: legacy.version ?? facts?.version ?? null };
    }
    function statusOf(id) {
      const tool = toolOf(id);
      if (tool?.installed === false) return "missing";
      if (tool?.installed !== true) return "unknown";
      if (id === "opencode" && tool.supportedVersion !== true) return "unsupported";
      if (id === "opencode" && tool.signedIn !== true) return "nosignin";
      // "Sign in needed" promises an action: only a tool Command Center can sign in says it; any other says plainly it is not signed in.
      if (builtIn(id)) return tool.signedIn === true ? "ready" : tool.signedIn === false ? (login.managed(id) ? "signin" : "nosignin") : "unknown";
      // Any other tool may lead only when the server says so (installed alone is never enough), and stays untested until the server says.
      if (tool.leaderEligible === true) return tool.tested === true ? "tested" : "untested";
      return tool.signedIn === false && login.managed(id) ? "signin" : "installed";
    }
    const readyClis = () => help.order.filter((cli) => statusOf(cli) === "ready");
    // Who may lead: the Ready built-in tools, then the saved ACP tools the server allows. The default is the first Ready built-in.
    const choices = () => [...readyClis(), ...other.kinds()];
    const leader = () => (choices().includes(draft.leader) ? draft.leader : readyClis()[0] ?? "");

    function summary() {
      if (running(refreshKey)) return "Looking for AI tools on this computer…";
      if (action(refreshKey)?.status === "failed") return "Could not check just now. Press Check again.";
      const ready = readyClis().map((cli) => page.cliLabel(cli));
      if (!ready.length) return other.kinds().length ? "No built-in tool is ready yet. You can choose a tool you added." : "No AI tool is ready yet. Install one, sign in, then press Check again.";
      return `Found and ready: ${new Intl.ListFormat("en").format(ready)}.`;
    }
    // The line under a tool's name: { text, bad }.
    function detailOf(id, status, current) {
      const tool = toolOf(id), name = nameOf(id), sign = login.viewOf(id), link = action(`connect-${id}`);
      if (current?.state === "running") return { text: CAT.phaseText(current.phase, name, current.message) };
      if (current?.state === "stuck") return { text: CAT.reasonText("cleanupUnconfirmed", name, id), bad: true };
      if (tool?.installed !== true && current?.state === "failed") return { text: CAT.reasonText(current.reason, name, id), bad: current.reason !== "cancelled" };
      if (tool?.installed !== true && current?.state === "refused") return { text: `Not installed: ${sentence(current.message)}`, bad: true };
      if (sign.state === "running" || sign.state === "orphan") return { text: "Signing in…" };
      if (sign.state === "refused") return { text: sentence(sign.text || "Could not start sign-in"), bad: true };
      if (link?.status === "running") return { text: `Adding ${name}'s connection…` };
      if (link?.status === "failed" || link?.status === "unknown") return { text: sentence(link.status === "unknown" ? "The connection dropped before the server answered. Try again" : link.message), bad: true };
      if (status === "unsupported") return { text: "OpenCode 1 is needed" };
      if (id === "opencode" && tool?.credentialSource === "environment") return { text: "A key is set outside Command Center. Its connection is not checked." };
      if (status === "ready") return { text: `Found on this computer, signed in${tool?.version ? ` · ${tool.version}` : ""}` };
      if (status === "untested") return { text: UNTESTED };
      if (status === "tested") return { text: `Found on this computer, tested${tool?.version ? ` · ${tool.version}` : ""}` };
      if (status === "signin" || status === "nosignin") return { text: "Found, but not signed in." };
      if (status === "installed") return { text: NOT_VERIFIED };
      if (status === "missing") return { text: "Not found on this computer." };
      return { text: tool?.installed === true ? "Found, but could not check the sign-in." : "Not checked yet. Press Check again." };
    }
    // The row's one action, and the consent line Install carries.
    function actionOf(id, status, current) {
      const entry = catalog.entry(id), tool = toolOf(id), name = esc(nameOf(id)), locked = install.locked() || login.busy();
      if (current?.state === "running" || current?.state === "stuck") {
        const label = current.state === "stuck" ? (current.stopping ? "Stopping…" : "Stop again") : current.stopping ? "Stopping…" : "Cancel";
        return { button: `<button type="button" class="btn sm" data-frun-cancel="${id}" data-focus-key="frun-cancel-${id}" aria-disabled="${current.stopping}" aria-label="${label === "Cancel" ? `Cancel installing ${name}` : label}">${label}</button>` };
      }
      const recheck = `<button type="button" class="btn sm" data-frun-recheck="${id}" data-focus-key="frun-recheck-${id}" aria-disabled="${running(refreshKey)}">${running(refreshKey) ? "Checking…" : "Check again"}</button>`;
      if (status === "unsupported") return { button: `<button type="button" class="btn primary sm" data-frun-install="opencode" data-focus-key="frun-install-opencode"${locked ? " disabled" : ""}>Install OpenCode 1</button>`, line: CAT.consentText(entry) };
      if (status === "ready") return { button: "" };
      if (tool?.installed === true) {
        // Sign in only for a tool with a managed sign-in (login.js); the panel under the row holds its steps and Cancel.
        const signingIn = ["running", "orphan", "stuck"].includes(login.viewOf(id).state);
        if (login.offered(id) && !tool.keySaved) return { button: `<button type="button" class="btn sm" data-frun-login="${id}" data-focus-key="frun-login-${id}"${signingIn || locked ? " disabled" : ""}>${signingIn ? "Signing in…" : "Sign in"}</button>` };
        if (entry?.leader?.kind === "acp" && tool.registered !== true) {
          const busy = running(`connect-${id}`);
          return { button: `<button type="button" class="btn sm" data-frun-connect="${id}" data-focus-key="frun-connect-${id}" aria-describedby="frunWhy-${id}" aria-disabled="${busy}">${busy ? "Connecting…" : "Connect"}</button>`,
            line: `Connect saves ${nameOf(id)}'s start command in Command Center. It installs nothing.` };
        }
        return { button: "" };
      }
      if (current?.state === "failed" && CAT.recheckAfter(current.reason)) return { button: recheck };
      if (tool?.installed === false && entry?.installable === true) {
        return { button: `<button type="button" class="btn primary sm" data-frun-install="${id}" data-focus-key="frun-install-${id}" aria-describedby="frunWhy-${id}"${locked ? " disabled" : ""}>${id === "copilot" && current?.state === "failed" ? "Try again" : "Install"}</button>`, line: CAT.consentText(entry) };
      }
      return { button: tool?.installed === false ? "" : recheck };
    }
    function rowHtml(id) {
      const current = install.installOf(id), status = statusOf(id), tool = toolOf(id), busy = ["running", "stuck"].includes(current?.state), sign = login.viewOf(id).state;
      // Only a row not known yet says Checking; a known row keeps its chip while the check runs, so nothing flickers.
      const shown = current?.state === "stuck" || sign === "stuck" ? "stuck" : busy ? "installing" : sign === "running" || sign === "orphan" ? "signingin" : running(refreshKey) && status === "unknown" ? "checking" : status;
      const detail = detailOf(id, status, current), act = actionOf(id, status, current), name = nameOf(id);
      const spin = ["checking", "installing", "signingin"].includes(shown) ? '<i class="spin" aria-hidden="true"></i>' : "";
      const chip = `<span class="frun-chip" data-state="${shown}">${spin}${shown === "unsupported" ? "OpenCode 1 is needed" : CHIP[shown]}</span>`;
      const bar = busy && current.state === "running" ? `<span class="frun-bar" role="progressbar" aria-label="${esc(detail.text)}"><i></i></span>` : "";
      const line = act.line ? `<small class="wrap frun-consent-line" id="frunWhy-${id}">${esc(act.line)}</small>` : "";
      // An installed tool without a managed sign-in says so in its own words and has no Sign in button; the slot holds login.js's panel.
      const unsupported = tool?.installed === true && tool.signedIn !== true && !tool.keyProfile && !busy ? login.unsupportedMessage(id) : null;
      const note = unsupported ? `<small class="wrap frun-signin-note">${esc(unsupported)}</small>` : "";
      const slot = tool?.installed === true ? `<div class="cli-login-slot" data-cli-login-slot="${id}"></div><div data-cli-key-slot="${id}"></div>` : "";
      // The fallback guide: only for a tool not found yet, and not while an installation runs.
      const info = builtIn(id) ? help.tools[id] : catalog.guideInfo(id), byHand = Boolean(info) && tool?.installed !== true && !busy, open = byHand && openHelp.has(id);
      const more = byHand ? `<button type="button" class="frun-more frun-byhand" data-frun-help="${id}" data-focus-key="frun-help-${id}" aria-expanded="${open}" aria-controls="frunHelp-${id}">${CHEVRON}<span>${id === "opencode" ? "How to set up" : "Install by hand"}</span></button>` : "";
      const panel = byHand ? `<div class="frun-help" id="frunHelp-${id}"${open ? "" : " hidden"}>${guideHtml(page, help, id, name, info)}</div>` : "";
      return `<div class="crow frun-tool" data-cli="${id}" data-status="${shown}"><span class="logo">${page.logo(id, 18, 0)}</span><div class="d"><b>${esc(name)}</b><small class="wrap frun-detail${detail.bad ? " bad" : ""}">${esc(detail.text)}</small>${note}${line}${bar}</div><div class="tool-row-action">${chip}${act.button}</div>${more}${panel}${slot}</div>`;
    }
    // A row with an installation running or stuck always stays in the list, so its Cancel is never filtered away.
    const leadRows = (query) => catalog.leadIds().filter((id) => catalog.matches(id, query) || ["running", "stuck"].includes(install.installOf(id)?.state));
    function providersHtml(query) {
      const ids = catalog.providerIds().filter((id) => catalog.matches(id, query));
      if (!ids.length) return "";
      const rows = ids.map((id) => {
        const text = catalog.providerText(id), state = id === "muse" ? "unavailable" : "provider";
        return `<div class="crow frun-tool frun-provider" data-provider="${id}"><span class="logo">${page.logo(id, 18, 0)}</span><div class="d"><b>${esc(catalog.nameOf(id))}</b><small class="wrap">${esc(text.line)}</small></div><div class="tool-row-action"><span class="frun-chip" data-state="${state}">${esc(text.chip)}</span></div></div>`;
      }).join("");
      const opencodeReady = statusOf("opencode") === "ready";
      const foot = `<div class="frun-pfoot"><p>${opencodeReady ? "OpenCode is ready. Pick one of these models later in Settings, under Crew and models." : "These models have no tool of their own to install. Install OpenCode, then pick a model later in Settings, under Crew and models."}</p>${opencodeReady ? "" : '<button type="button" class="btn sm" data-frun-to-opencode data-focus-key="frun-to-opencode">Go to OpenCode</button>'}</div>`;
      return rows + foot;
    }
    // What the live line announces about the installation in focus: its progress, then its outcome.
    function liveText() {
      const id = install.lockedId() || install.lastId();
      if (!id) return "";
      const current = install.installOf(id);
      if (current?.state === "done") return `${nameOf(id)} is installed.`;
      return current ? detailOf(id, statusOf(id), current).text : "";
    }
    // A catalog tool chosen to lead is "Not tested yet" until the server says it was tested (its saved entry's tested flag).
    const untested = (kind) => { const item = other.find(kind); return Boolean(item) && catalog.ownedConnections().has(item.id) && item.tested !== true; };
    const leaderKey = () => JSON.stringify([choices().map((kind) => [kind, page.cliLabel(kind), untested(kind)]), leader()]);
    function leaderHtml() {
      const ready = readyClis(), all = choices(), chosen = leader();
      if (!other.kinds().length && ready.length < 2) return ready.length ? `<p class="frun-note">${esc(page.cliLabel(chosen))} will be your leader. ${LEADER_NOTE}</p>` : `<p class="frun-note">${LEADER_NOTE}</p>`;
      // An added tool says Full access on its choice, before the acknowledgement asks for it.
      const options = all.map((kind) => `<label class="frun-opt"><input type="radio" name="frunLeader" value="${esc(kind)}" data-focus-key="frun-leader-${esc(kind)}"${kind === chosen ? " checked" : ""}>${other.find(kind) ? page.logo(kind, 12, 3) : page.logo(kind, 14, 0)}<span>${esc(page.cliLabel(kind))}</span>${other.find(kind) ? '<small class="frun-tag">Full access</small>' : ""}${untested(kind) ? '<small class="frun-tag frun-untested">Not tested yet</small>' : ""}</label>`).join("");
      // Shown for the chosen tool only; a radio click changes no markup here (view.js shows or hides it), so focus stays on the radio.
      const note = all.some(untested) ? `<small class="frun-untested-note" id="frunUntested"${untested(chosen) ? "" : " hidden"}>${UNTESTED}</small>` : "";
      return `<fieldset class="frun-leader"><legend class="lbl">Which tool leads?</legend><div class="frun-opts">${options}</div>${note}<small>${LEADER_NOTE}</small></fieldset>`;
    }
    return { statusOf, readyClis, leader, summary, rowsHtml: (query) => leadRows(query).map(rowHtml).join(""), providersHtml, liveText, leaderKey, leaderHtml, untested, guideInfo: (id) => (builtIn(id) ? help.tools[id] : catalog.guideInfo(id)) };
  }
  window.CC_FIRST_RUN_TOOLS = Object.freeze({ create, sentence });
})();
