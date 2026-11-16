// Command Center setup wizard and Settings (Pack 29 B3): the words the page shows for the server's tool catalog (state.cliCatalog) and
// for an installation's progress and outcome (state.settings.catalogTools[id].action). Classic script, loaded after cli-help.js and
// before other-tool.js, tools.js and the Settings script. Every text here is fixed: the page never shows installer output, and the
// install command shown is display text from the server, never sent back. The server chooses what runs; the page only names the tool.
"use strict";
(() => {
  // Ids the wizard lists first, in this order; they lead through the built-in adapters. One list: cli-help.js's order.
  const BUILT_IN = Object.freeze([...(window.CC_FIRST_RUN_HELP?.order ?? [])]);

  // The provider-only entries' own words. The server's guidance strings are planning notes, so the page says it plainly here; an id the
  // page does not know falls back to the server's guidance text.
  const PROVIDER_TEXT = Object.freeze({
    deepseek: { line: "Use DeepSeek models through OpenCode, or through Claude Code set up for DeepSeek.", chip: "Through OpenCode" },
    glm: { line: "Use GLM models through OpenCode with the Z.ai provider.", chip: "Through OpenCode" },
    nemotron: { line: "Use Nemotron models through OpenCode with the NVIDIA provider.", chip: "Through OpenCode" },
    perplexity: { line: "Perplexity's own command line tool is for search, not coding. Using its models through OpenCode is not checked yet.", chip: "Not checked yet" },
    muse: { line: "No verified official installation or supported provider connection yet.", chip: "Not available yet" },
  });

  // Installation progress, one line per phase the server publishes.
  function phaseText(phase, name, message) {
    if (name === "OpenCode" && phase === "installing" && ["Downloading OpenCode 1…", "Checking the download…", "Checking OpenCode 1…", "Trying another install method…"].includes(message)) return message;
    if (name === "OpenCode") return ({ checking: "Checking OpenCode 1…", installing: "Downloading OpenCode 1…", verifying: "Checking OpenCode 1…", downloading: "Downloading OpenCode 1…", extracting: "Checking the download…", fallback: "Trying another install method…", cancelling: "Stopping installation…" })[phase] ?? "Checking OpenCode 1…";
    if (phase === "installing") return `Downloading and installing ${name}…`;
    if (phase === "verifying") return `Looking for ${name}…`;
    if (phase === "cancelling") return "Stopping installation…";
    return `Checking ${name}…`;
  }
  // What a failed or stopped installation says. Prerequisites name the maker's own graphical setup; nothing asks for a terminal.
  const PREREQ = Object.freeze({
    needsNode: (name) => `${name} needs Node.js, which includes npm. Install it from nodejs.org, then press Check again.`,
    needsGit: (name) => `${name} needs Git for Windows. Install it from git-scm.com, then press Check again.`,
    needsWinget: (name) => `${name} needs App Installer. Get App Installer from the Microsoft Store, then press Check again.`,
    needsPowerShell: (name) => `${name} needs a newer PowerShell. Get PowerShell from the Microsoft Store, then press Check again.`,
  });
  const FAILURE = Object.freeze({
    downloadFailed: "Could not download the installer. Check your internet connection, then try again.",
    blockedByWindows: "Windows or an administrator blocked the installation.",
    notFoundAfterInstall: "The installer finished, but Command Center could not find the tool. Press Check again.",
    cancelled: "Installation stopped. Changes already made may remain.",
    cleanupUnconfirmed: "Could not confirm the installer stopped.",
    timeout: "The installation took too long and was stopped. Check your internet connection, then try again.",
    installFailed: "The installation did not finish. Try again, or use Install by hand.",
  });
  const isPrereq = (reason) => Object.hasOwn(PREREQ, reason);
  function reasonText(reason, name, id) {
    if (id === "copilot" && (reason === "installFailed" || !Object.hasOwn(FAILURE, reason))) return "The installation did not finish. Try again.";
    if (isPrereq(reason)) return PREREQ[reason](name);
    return FAILURE[Object.hasOwn(FAILURE, reason) ? reason : "installFailed"];
  }
  // Reasons whose next step is Check again rather than another Install.
  const recheckAfter = (reason) => isPrereq(reason) || reason === "notFoundAfterInstall";

  const possessive = (vendor) => `${String(vendor ?? "The maker").trim()}'s`;
  // The consent shown next to Install, before it is pressed. Pressing Install is the consent; the page sends only the tool's id.
  function consentText(entry) {
    if (entry?.id === "opencode") return "Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account.";
    if (entry?.id === "copilot") return "Downloads and checks GitHub Copilot CLI from its official releases, then installs it for your Windows account.";
    const command = String(entry?.command ?? ""), owner = possessive(entry?.vendor);
    const urls = command.match(/https:\/\/[^\s"'|,]+/g) ?? [];
    const npm = /^npm install -g (\S+)$/.exec(command);
    if (npm) return `Downloads and installs ${owner} package ${npm[1]} from https://registry.npmjs.org on this PC.`;
    const winget = /^winget install (\S+)$/.exec(command);
    if (winget) return `Downloads and runs ${owner} installer (${winget[1]}) through Windows Package Manager on this PC.`;
    const uv = /then uv tool install (\S+)$/.exec(command);
    if (uv && urls.length) return `Downloads and runs the uv installer from ${urls[0]}, then installs ${owner} ${uv[1]} with uv on this PC. uv may also download Python.`;
    if (urls.length) return `Downloads and runs ${owner} installer from ${urls[0]} on this PC.`;
    return `Downloads and runs ${owner} installer on this PC.`;
  }

  function create(page) {
    const list = () => (Array.isArray(page.state?.cliCatalog) ? page.state.cliCatalog : []).filter((entry) => entry && typeof entry.id === "string" && typeof entry.displayName === "string");
    const entry = (id) => list().find((item) => item.id === id) ?? null;
    // Built-ins first in their fixed order (a built-in the catalog does not list still gets its row), then every other installable entry.
    const leadIds = () => [...BUILT_IN, ...list().filter((item) => item.installable === true && !BUILT_IN.includes(item.id)).map((item) => item.id)];
    const providerIds = () => list().filter((item) => item.installable !== true).map((item) => item.id);
    // The saved ACP entries the catalog owns (Connect adds them): their own catalog row speaks for them, never a second "Added" row.
    const ownedConnections = () => new Set(list().map((item) => item.leader?.connectionId).filter(Boolean));
    const nameOf = (id) => entry(id)?.displayName ?? page.cliLabel(id);
    function providerText(id) {
      const own = PROVIDER_TEXT[id], item = entry(id);
      return { line: own?.line ?? String(item?.guidance ?? ""), chip: own?.chip ?? "Through OpenCode" };
    }
    // The fallback guide for a catalog tool without a built-in guide: the maker's command (display text only) and the maker's page.
    function guideInfo(id) {
      const item = entry(id);
      if (id === "copilot") return null;
      if (!item?.sources?.[0]) return null;
      return { about: `${item.displayName} is ${possessive(item.vendor)} AI coding tool.`, page: item.sources[0] };
    }
    // Search: a row matches on its name, maker or id, ignoring case.
    function matches(id, query) {
      const words = String(query ?? "").trim().toLowerCase();
      if (!words) return true;
      const item = entry(id);
      return [id, item?.displayName, item?.vendor, page.cliLabel(id)].some((text) => String(text ?? "").toLowerCase().includes(words));
    }
    return { list, entry, leadIds, providerIds, ownedConnections, nameOf, providerText, guideInfo, matches };
  }
  window.CC_FIRST_RUN_CATALOG = Object.freeze({ BUILT_IN, create, consentText, phaseText, reasonText, recheckAfter, isPrereq });
})();
