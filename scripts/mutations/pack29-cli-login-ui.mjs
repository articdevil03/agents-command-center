// Pack 29 W5 sign-in guards on the page and the ACP availability rule. One guard per row; every row names its catching test file.
const login = "public/first-run/login.js";
const acp = "server/settings/catalog-acp.ts";
const rows = [];
export const pack29CliLoginUiCatchMap = {};
function row(name, file, from, to, test) {
  const id = `p29-cli-login-${name}`;
  rows.push([id, file, from, to]);
  pack29CliLoginUiCatchMap[id] = `test/${test}.test.ts`;
}
const page = "pack29-cli-login-page", leader = "pack29-catalog-leader", settings = "pack29-onboarding-install-page";

// A pasted code is cleared at once and sent once; the capability and address never reach the DOM as markup; the message shapes are the frozen contract.
row("ui-secret-cleared", login, 'clearInputs(cli);\n      if (!code) return false;\n      input.value = ""; input.disabled = true;', 'if (!code) return false;\n      input.disabled = true;', page);
row("ui-code-once", login, 'event.phase !== "waitingCode" || mine.codeSent >= event.revision) return false;', 'event.phase !== "waitingCode") return false;', page);
row("ui-code-sent-setter", login, "if (sent) mine.codeSent = event.revision;", "", page);
row("ui-capability-not-in-dom", login, "root.dataset.state = view.state;", 'root.dataset.state = view.state; root.dataset.cap = own.get(cli)?.loginId ?? "";', page);
row("ui-address-text-node", login, 'setText(parts.addr, url ?? "");', 'parts.addr.innerHTML = url ?? "";', page);
row("ui-code-text-node", login, 'setText(parts.big, code ?? "");', 'parts.big.innerHTML = code ?? "";', page);
row("ui-address-https-only", login, 'url.protocol === "https:" && !url.username', "!url.username", page);
row("ui-message-login", login, '{ type: "cliLogin", cli });', '{ type: "cliLogin", cli, command: "evil" });', page);
row("ui-message-open", login, 'type: "openCliLogin", requestId: page.newRequestId(), cli, loginId: mine.loginId }', 'type: "openCliLogin", requestId: page.newRequestId(), cli, loginId: mine.loginId, url: view.event?.verificationUrl }', page);
row("ui-message-submit", login, "loginId: mine.loginId, code });", "loginId: mine.loginId, code, again: code });", page);
row("ui-unmanaged-no-signin", login, "const offered = (cli) => managed(cli) && facts(cli).installed === true", "const offered = (cli) => facts(cli).installed === true", page);
// The wizard: an eligible catalog tool is "Not tested yet" and never chosen by itself.
row("ui-untested-label", "public/first-run/tools.js", 'return tool.tested === true ? "tested" : "untested";', 'return "tested";', page);
row("ui-no-auto-select", "public/first-run/tools.js", 'draft.leader : readyClis()[0] ?? "");', 'draft.leader : choices()[0] ?? "");', page);
// Settings keeps the maker's command collapsed under Install by hand.
row("settings-by-hand-collapsed", "public/app/11-settings-render.js", '<details class="settings-install-by-hand">', '<details class="settings-install-by-hand" open>', settings);
// ACP availability: matching saved profile, installed === true and a detected version; an uninstalled or unknown tool is neither offered nor launchable.
row("acp-profile", acp, "return sameProfile(cli, catalogProfile(entry)) && status?.installed === true", "return status?.installed === true", leader);
row("acp-installed", acp, "&& status?.installed === true", "&& status?.installed !== false", leader);
row("acp-version", acp, "&& !!status.version;", "&& true;", leader);
row("acp-offer-filter", acp, "return clis.filter((cli) => catalogLeaderEligible(cli, state.catalogTools));", "return clis;", leader);
row("acp-first-chat-check", "server/main/leader-session.ts", "assertCatalogLeaderEligible(acp, settingsService.state);", "/* availability check omitted */", leader);
// The launch gate (assertCatalogLeaderEligible) blocks only a known missing tool or a mismatched saved connection; unknown does not block.
row("acp-launch-known-missing", acp, "&& facts[entry.id]?.installed !== false;", ";", leader);
row("acp-launch-profile", acp, "return sameProfile(cli, catalogProfile(entry)) && facts[entry.id]?.installed !== false;", "return facts[entry.id]?.installed !== false;", leader);
row("acp-tested-flag", acp, "const tested = entry.leader.qualified === true;", "const tested = true;", leader);
row("acp-leader-label", acp, 'leaderLabel: tested ? "Tested" as const : "Not tested yet" as const', 'leaderLabel: "Tested" as const', leader);
row("acp-facts-tested", acp, 'tested: entry.leader.qualified === true, leaderLabel: entry.leader.qualified === true ? "Tested" : "Not tested yet",', 'tested: true, leaderLabel: "Tested",', leader);
// Settings offers Connect for an installed ACP catalog tool that is not saved yet, and sends the wizard's own consented message.
row("settings-connect-unregistered", "public/app/11-settings-render.js", "&& tool.registered !== true;", ";", "pack29-settings-connect-page");
row("settings-connect-confirm", "public/app/11-settings-render.js", 'payload = { type: "registerCatalogCli", cli, confirm: true };', 'payload = { type: "registerCatalogCli", cli, confirm: false };', "pack29-settings-connect-page");
row("settings-connected-badge-needs-connect", "public/app/11-settings-render.js", "tool?.signedIn === true && !unsupportedVersion && !needsConnect ?", "tool?.signedIn === true && !unsupportedVersion ?", "pack29-settings-connect-page");
// The sign-in re-read (the GitHub connect's watcher): it asks again every interval and stops once signed in.
row("watch-signin-once", "server/settings/service.ts", "          step();", "          void 0;", "settings-cli-actions");
row("watch-signin-never-stops", "server/settings/service.ts", "if (signedIn === true || Date.now() >= deadline ||", "if (Date.now() >= deadline ||", "settings-cli-actions");
row("r1-guide-shell", "public/first-run/cli-help.js", "Visit the official setup guide at the address below.", "Open PowerShell and paste the install command.", "pack29-onboarding-install-guide");
row("r1-settings-shell", "public/app/11-settings-render.js", "Visit the official setup guide, then return here and press Check again.", "Open PowerShell and paste the install command.", "pack29-onboarding-install-page");
export const pack29CliLoginUiMutations = rows;
