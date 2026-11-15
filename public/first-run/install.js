// Command Center setup wizard, installing a tool (Pack 29 B3): what an installation is doing right now, and the only three messages the
// page may send about it. Classic script, loaded after catalog.js and before tools.js. The server owns what runs: the page sends a tool's
// id and the consent (the Install click), never a command, address, package or path. The canonical state is the server's
// (state.settings.catalogTools[id].action), so a reloaded page shows an installation that is still running; a request the server has
// not published yet counts as running too, so a double click never starts two.
"use strict";
(() => {
  // action, running: the wizard's action tracking (sendSettingsAction keys); catalog: CC_FIRST_RUN_CATALOG.create(page).
  function create(page, { action, running, catalog }) {
    const facts = (id) => page.state?.settings?.catalogTools?.[id] ?? null;
    // Only an installation's own record counts (kind "install"); anything else in that slot is not about installing.
    function serverAction(id) {
      const item = facts(id)?.action;
      return item && typeof item === "object" && item.kind === "install" && typeof item.requestId === "string" ? item : null;
    }
    let last = "";
    // One of: null (nothing to say), running (phase, stopping), stuck (the installer may still run), failed (reason), refused (the
    // server said no before starting, message), done. requestId is the installation's own id, the one Cancel names.
    function installOf(id) {
      const server = serverAction(id), local = action(`install-${id}`), stopping = running(`cancel-${id}`);
      const own = Boolean(server && local && server.requestId === local.requestId);
      if (server?.status === "running") return { state: "running", requestId: server.requestId, phase: stopping ? "cancelling" : server.phase ?? "checking", message: server.message, stopping: stopping || server.phase === "cancelling" };
      if (server?.status === "failed" && server.reason === "cleanupUnconfirmed") return { state: "stuck", requestId: server.requestId, stopping };
      if (local?.status === "running" && !own) return { state: "running", requestId: local.requestId, phase: stopping ? "cancelling" : "checking", stopping };
      if (local && (local.status === "failed" || local.status === "unknown") && !own) {
        const message = local.status === "unknown" ? "Connection lost. The installation may still be running. Press Check again." : local.message;
        return { state: "refused", requestId: local.requestId, message };
      }
      if (server?.status === "failed") return { state: "failed", requestId: server.requestId, reason: server.reason ?? "installFailed" };
      if (server?.status === "done") return { state: "done", requestId: server.requestId };
      return null;
    }
    const busyState = (id) => ["running", "stuck"].includes(installOf(id)?.state);
    // The tool whose installation holds the step (at most one runs at a time), or "".
    const lockedId = () => catalog.leadIds().find(busyState) ?? "";
    const locked = () => Boolean(lockedId());

    // Install: only an installable catalog tool the server reports as not found, and never while another installation runs.
    function install(id) {
      const entry = catalog.entry(id), tool = facts(id), legacy = page.state?.settings?.tools?.[id];
      const installed = id === "opencode" ? tool?.installed : legacy ? legacy.installed ?? tool?.installed : tool?.installed;
      const unsupported = id === "opencode" && tool?.installed === true && tool.supportedVersion !== true;
      if (!entry || entry.installable !== true || (installed !== false && !unsupported) || locked() || page.cliLogin?.busy()) return null;
      const sent = page.sendSettingsAction(`install-${id}`, { type: "installCli", cli: id, confirm: true });
      if (sent) last = id;
      return sent;
    }
    // Cancel names the installation it stops; a second press while a stop is on its way sends nothing.
    function cancel(id) {
      const current = installOf(id);
      if (!current || !["running", "stuck"].includes(current.state) || running(`cancel-${id}`)) return null;
      last = id;
      return page.sendSettingsAction(`cancel-${id}`, { type: "cancelCliInstall", cli: id, installRequestId: current.requestId });
    }
    // Connect saves an installed catalog tool's own start command on the server. It never installs, signs in or grants Full access.
    function connect(id) {
      const entry = catalog.entry(id), tool = facts(id);
      if (!entry || entry.installable !== true || entry.leader?.kind !== "acp" || tool?.installed !== true || tool.registered === true || running(`connect-${id}`)) return null;
      return page.sendSettingsAction(`connect-${id}`, { type: "registerCatalogCli", cli: id, confirm: true });
    }
    return { installOf, locked, lockedId, install, cancel, connect, lastId: () => last };
  }
  window.CC_FIRST_RUN_INSTALL = Object.freeze({ create });
})();
