(() => {
  const { check, waitFor, text, $, requireElement, confirmIfAsked } = window.__ccHarness;
  const runPackCSettingsReal = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real Pack C settings state");
    window.__socket.send(JSON.stringify({ type: "selectTab", tabId: "alpha-dev" }));
    await waitFor(() => window.__latestState.selectedTabId === "alpha-dev", "real Settings source tab");
    const refreshStart = window.__received.length;
    window.__socket.send(JSON.stringify({ type: "refreshSettings" }));
    await waitFor(() => window.__received.slice(refreshStart).some((item) => item.type === "settingsRefreshed"), "fake-runner Settings refresh");

    const sections = ["crew", "tools", "github", "vault", "folders", "skills", "appearance", "behaviour"];
    const openSettingsSection = (section) => {
      if ($("setModal").hidden) $("setBtn").click();
      requireElement(`#setNav [data-settings-section="${section}"]`).click();
      return requireElement(`#setBody #s-${section}`);
    };
    openSettingsSection("tools");
    const targets = ["#setBtn", "#setModal", "#setNav", "#setBody", "#vaultPath", "#defaultProjectFolder", "#permBtn", "#permPop"];
    const missingTargets = targets.filter((selector) => !document.querySelector(selector));
    check(`real fake-runner Settings and permission targets exist at ${innerWidth}px`, missingTargets.length === 0, { found: targets.filter((selector) => document.querySelector(selector)), missing: missingTargets });
    const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
    const requestIds = new Set();
    const uniqueId = (value) => { const unique = safeId(value) && !requestIds.has(value); if (unique) requestIds.add(value); return unique; };
    const sectionTargets = sections.map((section) => `#setNav [data-settings-section="${section}"]`);
    const missingSections = sectionTargets.filter((selector) => !document.querySelector(selector));
    check(`real Settings nav finds all eight sections at ${innerWidth}px`, missingSections.length === 0, { found: sectionTargets.filter((selector) => document.querySelector(selector)), missing: missingSections });

    const tabFor = (tabId) => window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === tabId);
    const actionState = (requestId) => window.__latestState?.requestActions?.[requestId] ?? null;
    const serverAction = async ({ name, section, selector, type, fields = {}, result = "failed", message }) => {
      openSettingsSection(section);
      if (type === "mcpAdd") {
        const form = document.querySelector(`[data-mcp-form="${CSS.escape(fields.cli)}"]`);
        if (form?.hidden) requireElement(`[data-settings-add="mcp-${CSS.escape(fields.cli)}"]`).click();
      }
      if (type === "pluginInstall") {
        const form = requireElement("[data-plugin-form]");
        if (form.hidden) requireElement('[data-settings-add="plugins-claude"]').click();
      }
      const start = window.__sent.length;
      if (type === "setNotesVault") { requireElement("#vaultPath").value = fields.path ?? ""; requireElement("#vaultPath").dispatchEvent(new Event("input", { bubbles: true })); }
      if (type === "setDefaultProjectFolder") requireElement("#defaultProjectFolder").value = fields.folder ?? "";
      const button = requireElement(selector); const form = button.form;
      if (type === "mcpAdd" && form) { form.elements.name.value = fields.name; form.elements.commandOrUrl.value = fields.commandOrUrl; }
      if (type === "pluginInstall" && form) form.elements.name.value = fields.name;
      button.focus(); button.click(); confirmIfAsked();
      const sent = window.__sent.slice(start).filter((item) => item.type === type).at(-1);
      const idGood = uniqueId(sent?.requestId);
      const expected = { type, ...fields };
      const exact = Boolean(sent && idGood
        && Object.keys(sent).length === Object.keys(expected).length + 1
        && Object.entries(expected).every(([key, value]) => sent[key] === value)
        && Object.keys(sent).every((key) => key === "requestId" || Object.hasOwn(expected, key)));
      const pendingButton = requireElement(selector);
      const disabledWhilePending = pendingButton.disabled;
      await waitFor(() => actionState(sent?.requestId)?.status === result, `${name} server action result`);
      const final = actionState(sent.requestId);
      const statusNode = document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`);
      const runningReceived = window.__received.some((item) => item.type === "state" && item.requestActions?.[sent.requestId]?.status === "running");
      const statusShown = statusNode?.dataset.status === result && statusNode.textContent.includes(message);
      const finalButton = requireElement(selector);
      const reenabled = !finalButton.disabled;
      const clearVaultFocusKey = type === "setNotesVault" && fields.path === null && finalButton.disabled
        ? (document.querySelector('#s-vault [data-setting-action="vault-browse"]') ? "vault-browse" : "vault-path")
        : button.dataset.focusKey;
      const focusRestored = document.activeElement?.dataset.focusKey === clearVaultFocusKey;
      check(`${name} shows real server status for its fresh id at ${innerWidth}px`, exact && runningReceived && disabledWhilePending && statusShown && (reenabled || clearVaultFocusKey !== button.dataset.focusKey) && focusRestored && final.message === message, { sent: sent ?? null, expected: { ...expected, requestId: "<fresh unique request id>" }, exact, runningReceived, disabledWhilePending, final, statusNode: statusNode ? { status: statusNode.dataset.status, message: statusNode.textContent } : null, statusShown, reenabled, focusRestored, expectedFocusKey: clearVaultFocusKey });
      return sent;
    };

    const settings = window.__latestState.settings;
    const gemini = settings.tools.gemini;
    const geminiFiles = settings.skills.gemini.instructionFiles.map((item) => item.path.replaceAll("\\", "/").split("/").slice(-2).join("/"));
    const geminiHasGlobalInstructions = settings.skills.gemini.instructionFiles.some((item) => item.scope === "global" && item.path.replaceAll("\\", "/").endsWith("/.gemini/GEMINI.md"));
    const geminiHasProjectInstructions = settings.skills.gemini.instructionFiles.some((item) => item.scope === "project" && item.path.replaceAll("\\", "/").endsWith("/GEMINI.md"));
    const geminiSafe = gemini.installed === false && gemini.signedIn === null
      && geminiHasGlobalInstructions && geminiHasProjectInstructions
      && settings.skills.gemini.skills.length === 0 && settings.skills.gemini.mcpServers.length === 0 && settings.skills.gemini.plugins.length === 0
      && !document.querySelector('#s-tools [data-setting-action="login-cli"][data-cli="gemini"]')
      && !document.querySelector('#s-skills [data-mcp-form="gemini"]');
    const installedHasNoInstall = !document.querySelector('#s-tools [data-setting-action="install-cli"][data-cli="claude"]');
    const geminiInstall = requireElement('#s-tools [data-setting-action="install-cli"][data-cli="gemini"]');
    window.__ccConfirmResult = false;
    let start = window.__sent.length; geminiInstall.click();
    const installDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "installCli");
    window.__ccConfirmResult = true;
    check(`real Gemini remains install-only with server instruction inventory at ${innerWidth}px`, geminiSafe && installedHasNoInstall && installDenied, { gemini: { installed: gemini.installed, signedIn: gemini.signedIn }, geminiFiles, instructionScopes: settings.skills.gemini.instructionFiles.map((item) => item.scope), geminiHasGlobalInstructions, geminiHasProjectInstructions, skills: settings.skills.gemini.skills, mcp: settings.skills.gemini.mcpServers, plugins: settings.skills.gemini.plugins, geminiSafe, installedHasNoInstall, installDenied });

    await serverAction({ name: "Gemini install", section: "tools", selector: '#s-tools [data-setting-action="install-cli"][data-cli="gemini"]', type: "installCli", fields: { cli: "gemini", confirm: true }, message: "CLI installation failed" });
    await serverAction({ name: "Claude sign-in", section: "tools", selector: '#s-tools [data-setting-action="login-cli"][data-cli="claude"]', type: "cliLogin", fields: { cli: "claude" }, message: "could not open the CLI login window" });
    await serverAction({ name: "GitHub connect", section: "github", selector: '#s-github [data-setting-action="github-login"]', type: "ghLogin", message: "could not open the GitHub login window" });

    const folder = window.__ccFolderChoice;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const noVaultButton = requireElement('#lowerBody [data-open-vault]');
    const noVaultNoop = noVaultButton.disabled && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    const openedBeforeNoVault = window.__ccOpenedObsidian.length; noVaultButton.click();
    const noVaultStillClosed = window.__ccOpenedObsidian.length === openedBeforeNoVault;
    await serverAction({ name: "Notes vault refusal", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: `${folder}\\missing-vault` }, message: "Notes vault folder does not exist" });
    await serverAction({ name: "Notes vault save", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: folder }, result: "done", message: "Done" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const expectedObsidian = `obsidian://open?path=${encodeURIComponent(folder)}`;
    const openVault = requireElement('#lowerBody [data-open-vault]'); openVault.click();
    await waitFor(() => window.__ccOpenedObsidian.at(-1) === expectedObsidian, "real Open in Obsidian route");
    const obsidianPathExact = window.__ccOpenedObsidian.at(-1) === expectedObsidian;
    check(`real Notes vault Open in Obsidian uses the encoded server path at ${innerWidth}px`, noVaultNoop && noVaultStillClosed && obsidianPathExact, { noVaultNoop, noVaultStillClosed, expectedObsidian, opened: window.__ccOpenedObsidian.slice() });

    const defaultFolder = requireElement("#defaultProjectFolder");
    defaultFolder.value = `${folder}\\missing-folder`;
    await serverAction({ name: "Default folder refusal", section: "folders", selector: '#s-folders [data-setting-action="folder-save"]', type: "setDefaultProjectFolder", fields: { folder: `${folder}\\missing-folder` }, message: "Default project folder folder does not exist" });
    defaultFolder.value = folder;
    await serverAction({ name: "Default folder save", section: "folders", selector: '#s-folders [data-setting-action="folder-save"]', type: "setDefaultProjectFolder", fields: { folder }, result: "done", message: "Done" });
    const browseStart = window.__sent.length;
    requireElement('#s-folders [data-setting-action="folder-browse"]').click();
    await waitFor(() => requireElement("#defaultProjectFolder").value === folder, "real default folder picker result");
    const defaultBrowseGood = requireElement("#defaultProjectFolder").value === folder && !window.__sent.slice(browseStart).some((item) => item.type === "changeFolder");
    const selectedProject = window.__latestState.projects.find((project) => project.tabs.some((tab) => tab.id === window.__latestState.selectedTabId));
    const browseTab = selectedProject?.tabs.find((tab) => tab.id !== window.__latestState.selectedTabId);
    if (!browseTab) throw new Error("real tab-folder Browse requires a non-selected tab in the current project");
    const tabBrowseStart = window.__sent.length;
    requireElement('#s-folders [data-setting-action="tab-folder-browse"][data-tab-id="' + CSS.escape(browseTab.id) + '"]').click();
    await waitFor(() => tabFor(browseTab.id)?.folder === folder, "real tab-folder Browse update");
    const tabBrowse = window.__sent.slice(tabBrowseStart).find((item) => item.type === "changeFolder");
    const tabBrowseGood = tabBrowse?.tabId === browseTab.id && tabBrowse.folder === folder && tabBrowse.requestId === undefined;
    check(`real folder pickers update the default and selected tab at ${innerWidth}px`, defaultBrowseGood && tabBrowseGood, { defaultBrowseGood, tabBrowse: tabBrowse ?? null, folder });

    openSettingsSection("skills");
    const mcpForm = requireElement('#s-skills [data-mcp-form="claude"]');
    const mcpRemove = requireElement('#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]');
    window.__ccConfirmResult = false; start = window.__sent.length; mcpRemove.click();
    const mcpRemoveDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "mcpRemove");
    window.__ccConfirmResult = true;
    const mcpAdd = await serverAction({ name: "MCP add", section: "skills", selector: '#s-skills [data-mcp-form="claude"] button[type="submit"]', type: "mcpAdd", fields: { cli: "claude", name: "valid_mcp", commandOrUrl: "npx -y server" }, message: "MCP add failed" });
    await serverAction({ name: "MCP remove", section: "skills", selector: '#s-skills [data-setting-action="mcp-remove"][data-cli="claude"][data-name="claude_mcp"]', type: "mcpRemove", fields: { cli: "claude", name: "claude_mcp", confirm: true }, message: "MCP removal failed" });
    const pluginForm = requireElement('#s-skills [data-plugin-form]'); pluginForm.elements.name.value = "sample-plugin";
    await serverAction({ name: "Plugin install", section: "skills", selector: '#s-skills [data-plugin-form] button[type="submit"]', type: "pluginInstall", fields: { name: "sample-plugin" }, message: "plugin install failed" });
    const pluginRemove = requireElement('#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]');
    window.__ccConfirmResult = false; start = window.__sent.length; pluginRemove.click();
    const pluginRemoveDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "pluginUninstall");
    window.__ccConfirmResult = true;
    await serverAction({ name: "Plugin remove", section: "skills", selector: '#s-skills [data-setting-action="plugin-remove"][data-name="sample-plugin"]', type: "pluginUninstall", fields: { name: "sample-plugin", confirm: true }, message: "plugin uninstall failed" });
    check(`real MCP and plugin actions use server refusals and require confirmation at ${innerWidth}px`, mcpRemoveDenied && pluginRemoveDenied && Boolean(mcpAdd?.requestId), { mcpRemoveDenied, pluginRemoveDenied, mcpAdd: mcpAdd ?? null });

    const permissionStart = window.__sent.length;
    const permissionButton = $("permBtn"); permissionButton.focus(); permissionButton.click();
    const modes = ["ask", "accept", "plan", "bypass"];
    const missingModes = modes.filter((mode) => !document.querySelector(`[data-permission-mode="${mode}"]`));
    const savedAccept = document.querySelector('[data-permission-mode="accept"]')?.getAttribute("aria-pressed") === "true";
    window.__ccConfirmResult = false; start = window.__sent.length;
    requireElement('[data-permission-mode="bypass"]').click();
    const bypassDenied = confirmIfAsked() && !window.__sent.slice(start).some((item) => item.type === "setPermissionMode");
    window.__ccConfirmResult = true;
    permissionButton.click(); requireElement('#permPop [data-permission-mode="plan"]').click();
    const plan = window.__sent.slice(permissionStart).find((item) => item.type === "setPermissionMode");
    const planIdGood = uniqueId(plan?.requestId) && plan?.tabId === "alpha-dev" && plan.mode === "plan";
    await waitFor(() => actionState(plan?.requestId)?.status === "done", "real plan permission result");
    const planShown = permissionButton.textContent.includes("Plan only") && !permissionButton.querySelector(".perm-state") && permissionButton.title.includes("Done") && !permissionButton.disabled;
    const permissionFocus = document.activeElement === permissionButton;
    permissionButton.click(); window.__ccConfirmResult = true;
    requireElement('[data-permission-mode="bypass"]').click(); confirmIfAsked();
    const bypass = window.__sent.slice(permissionStart).filter((item) => item.type === "setPermissionMode").at(-1);
    const bypassIdGood = uniqueId(bypass?.requestId) && bypass?.tabId === "alpha-dev" && bypass.mode === "bypass" && bypass.confirm === true;
    await waitFor(() => actionState(bypass?.requestId)?.status === "done", "real bypass permission result");
    const bypassShown = $("permBtn").textContent.includes("Bypass permissions") && !$("permBtn").querySelector(".perm-state") && !$("permBtn").disabled;
    const permissionFinal = window.__latestState.settings.permissionModes["alpha-dev"] === "bypass";
    permissionButton.click(); requireElement('[data-permission-mode="accept"]').click();
    const resetMode = window.__sent.slice(permissionStart).filter((item) => item.type === "setPermissionMode").at(-1);
    await waitFor(() => actionState(resetMode?.requestId)?.status === "done" && window.__latestState.settings.permissionModes["alpha-dev"] === "accept", "restore default permission mode");
    check(`real per-tab permission flow uses server state and confirmation at ${innerWidth}px`, missingModes.length === 0 && modes.join(",") === "ask,accept,plan,bypass" && savedAccept && bypassDenied && planIdGood && planShown && permissionFocus && bypassIdGood && bypassShown && permissionFinal, { missingModes, savedAccept, bypassDenied, plan: plan ?? null, planShown, permissionFocus, bypass: bypass ?? null, bypassShown, permissionFinal, resetMode: resetMode ?? null });

    await serverAction({ name: "Clear Notes vault", section: "vault", selector: '#s-vault [data-setting-action="vault-toggle"]', type: "setNotesVault", fields: { path: null }, result: "done", message: "Done" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    requireElement('[data-l="notes"]').click();
    const noVaultAfterClear = requireElement('#lowerBody [data-open-vault]').disabled && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    check(`real Notes vault clears back to its honest no-vault state at ${innerWidth}px`, noVaultAfterClear, { vaultPath: window.__latestState.settings.vault.path, openDisabled: requireElement('#lowerBody [data-open-vault]').disabled, vaultState: text("#lowerBody [data-vault-empty]") });
  };
  Object.assign(window.__ccHarness, { runPackCSettingsReal });
})();
