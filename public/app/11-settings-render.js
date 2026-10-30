// Command Center page script, part 11 of 12: the Settings screen. Ordered classic scripts (index.html loads public/app/*.js in name order) share one scope.
  "use strict";
  function settingSwitch(key, label, description, value, disabled = false, extra = "") {
    return `<div class="crow" style="grid-template-columns:minmax(0,1fr) auto"><div class="d"><b>${esc(label)}</b><small class="wrap">${esc(description)}</small>${extra}</div><button type="button" class="switch" role="switch" aria-checked="${String(value)}" aria-label="${esc(label)}" data-setting="${esc(key)}" data-focus-key="setting-${esc(key)}"${disabled ? " disabled" : ""}></button></div>`;
  }
  function settingValue(key) {
    return pref(key, key === "notificationsEnabled");
  }
  function settingsActionRunning(key) {
    const requestId = settingsActionId(key);
    if (!requestId) return false;
    const state = actionStateFor(requestId);
    return !state || state.status === "running";
  }
  function settingsFocusSnapshot(body) {
    const active = document.activeElement?.closest("#setModal") ? document.activeElement : null;
    if (active?.dataset.focusKey) settingsFocusKey = active.dataset.focusKey;
    // Focus that moved somewhere else on purpose (a picker over Settings) is left there; only lost focus comes back.
    const lost = !document.activeElement || document.activeElement === document.body;
    return { key: active?.dataset.focusKey ?? (active || lost ? settingsFocusKey : null), value: active && "value" in active ? active.value : null, scrollTop: body.scrollTop };
  }
  // Text the user typed or browsed into a Settings field survives a re-render (every state broadcast) until it is saved or the modal closes. A field never edited always shows the server value.
  function settingsDraftSnapshot(body) {
    for (const [action, keys] of Object.entries(savedBy)) {
      const requestId = settingsActionId(action);
      if (requestId && actionStateFor(requestId)?.status === "done" && settingsSubmits.get(action)?.requestId === requestId) {
        const submitted = settingsSubmits.get(action).fields;
        keys.forEach((key) => { if (body.querySelector(`[data-focus-key="${key}"]`)?.value === submitted.get(key)) settingsEdits.delete(key); });
        settingsSubmits.delete(action); }
    }
    const drafts = new Map();
    for (const input of body.querySelectorAll("input[data-focus-key]")) {
      const key = input.dataset.focusKey;
      if (settingsEdits.has(key)) drafts.set(key, input.value);
    }
    return drafts;
  }
  function restoreSettingsDrafts(body, drafts) {
    for (const [key, value] of drafts) { const input = [...body.querySelectorAll("input[data-focus-key]")].find((item) => item.dataset.focusKey === key); if (input) input.value = value; }
  }
  function restoreSettingsFocus(body, snapshot) {
    body.scrollTop = snapshot.scrollTop;
    if (snapshot.key) {
      let target = [...$("setModal").querySelectorAll("[data-focus-key]")].find((item) => item.dataset.focusKey === snapshot.key);
      const vaultActionId = settingsActionId("vault-save");
      const vaultActionDone = actionStateFor(vaultActionId)?.status === "done";
      if (snapshot.key === "vault-toggle" && target?.disabled && vaultActionDone) {
        target = $("setModal").querySelector('[data-setting-action="vault-browse"]') ?? $("vaultPath");
      }
      if (target && !target.disabled && target.type !== "hidden") {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) settingsFocusKey = target.dataset.focusKey;
      }
    }
  }
  function markSettingsNav() {
    $("setNav").querySelectorAll("[data-settings-section]").forEach((button) => button.setAttribute("aria-current", String(button.dataset.settingsSection === settingsSection)));
  }
  let settingsScrollLock = 0;
  const openSettingsForms = new Set();
  function trackSettingsScroll() {
    const body = $("setBody"); const sections = [...body.querySelectorAll(".settings-section")];
    if (!sections.length || Date.now() - settingsScrollLock < 400) return;
    const top = body.getBoundingClientRect().top;
    let current = sections[0];
    // Rounded: the header above Settings can sit on a fractional pixel, and a section scrolled to 60px must still count.
    for (const section of sections) if (Math.round(section.getBoundingClientRect().top - top) <= 60) current = section;
    if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = sections[sections.length - 1];
    settingsSection = current.dataset.section;
    markSettingsNav();
  }
  function settingsToolRow(cli, tool) {
    const key = `install-${cli}`;
    const packageNames = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai", gemini: "@google/gemini-cli" };
    const version = tool?.version ? ` · ${tool.version}` : "";
    const subtitle = tool?.installed === false ? "Not installed." : tool?.installed === true
      ? `${tool.signedIn === true ? "Signed in" : tool.signedIn === false ? "Installed · Not signed in" : cli === "gemini" ? "Installed · Gemini checks its own sign-in" : "Installed · Sign-in status unknown"}${version}`
      : `Install status unknown${version}`;
    const install = tool?.installed === false ? `<button type="button" class="btn primary sm" data-setting-action="install-cli" data-cli="${cli}" data-focus-key="${key}" ${settingsActionRunning(key) ? "disabled" : ""}>Install</button>` : "";
    const loginKey = `login-${cli}`;
    const login = tool?.installed === true && tool.signedIn !== true && cli !== "gemini" ? `<button type="button" class="btn sm" data-setting-action="login-cli" data-cli="${cli}" data-focus-key="${loginKey}" ${settingsActionRunning(loginKey) ? "disabled" : ""}>Sign in</button>` : "";
    const connected = tool?.signedIn === true ? '<span class="tool-connected" data-tool-status="connected"><i></i>Connected</span>' : "";
    const command = tool?.installed === false ? `npm install -g ${packageNames[cli]}` : "";
    const copy = command ? `<div class="cmd"><code title="${esc(command)}">${esc(command)}</code><button type="button" data-copy="${esc(command)}">Copy</button></div>` : "";
    return `<div class="crow tool-row" data-tool-row data-cli="${cli}"><span class="logo">${logo(cli, 18, 0)}</span><div class="d"><b>${esc(CLI_LABEL[cli] ?? cli)}</b><small data-tool-subtitle title="${esc(subtitle)}">${esc(subtitle)}</small>${copy}</div><div class="tool-row-action" data-tool-row-action>${connected}${install}${login}${actionStatusMarkup(key)}${actionStatusMarkup(loginKey)}</div></div>`;
  }
  function skillBlock(cli, inventory = {}) {
    const skillCount = Array.isArray(inventory.skills) ? inventory.skills.length : 0;
    const mcpItems = Array.isArray(inventory.mcpServers) ? inventory.mcpServers : [];
    const pluginItems = Array.isArray(inventory.plugins) ? inventory.plugins : [];
    const instructionItems = Array.isArray(inventory.instructionFiles) ? inventory.instructionFiles : [];
    const fileLabel = (path) => String(path ?? "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || String(path ?? "");
    const instructions = instructionItems.map((item) => `<div class="sitem instruction-row"><span title="${esc(item.path)}">${esc(fileLabel(item.path))} <small>(${esc(item.scope)})</small></span></div>`).join("") || '<span class="sempty">None found</span>';
    const counts = cli === "gemini" ? "Instruction files only. Gemini's MCP is not managed here" : `${skillCount} skills · ${mcpItems.length} MCP servers${cli === "claude" ? ` · ${pluginItems.length} plugins` : ""}`;
    const header = `<div class="skill-head"><span class="logo">${logo(cli, 18, 0)}</span><div class="d"><b>${esc(CLI_LABEL[cli] ?? cli)}</b><small>${esc(counts)}</small></div></div>`;
    const instructionsBlock = `<div class="sblock"><div class="sh"><span>Instruction files</span></div>${instructions}</div>`;
    if (cli === "gemini") return `<section class="card skill-card" data-skill-cli="${cli}">${header}${instructionsBlock}</section>`;

    const canRemoveMcp = cli === "claude" || cli === "codex";
    const mcpRows = mcpItems.map((server) => {
      const key = `mcp-remove-${cli}-${server.name}`;
      return `<div class="sitem"><span>${esc(server.name)}</span>${canRemoveMcp ? `<span class="skill-row-actions"><button type="button" class="btn sm" data-setting-action="mcp-remove" data-cli="${cli}" data-name="${esc(server.name)}" data-focus-key="${esc(key)}" ${settingsActionRunning(key) ? "disabled" : ""}>Remove</button>${actionStatusMarkup(key)}</span>` : '<small>Remove it with OpenCode itself</small>'}</div>`;
    });
    const mcpFormKey = `mcp-${cli}`;
    const mcpForm = `<form class="settings-form" data-mcp-form="${cli}" ${openSettingsForms.has(mcpFormKey) ? "" : "hidden"}><input class="settings-input" name="name" maxlength="64" data-focus-key="mcp-name-${cli}" placeholder="Name, like github" aria-label="MCP name" required><input class="settings-input" name="commandOrUrl" data-focus-key="mcp-command-${cli}" placeholder="https://example.com/mcp or npx -y server" aria-label="HTTPS URL or command" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="mcp-submit-${cli}" ${settingsActionRunning(`mcp-add-${cli}`) ? "disabled" : ""}>Add MCP</button>${actionStatusMarkup(`mcp-add-${cli}`)}</div></form>`;
    const mcp = `<div class="sblock"><div class="sh"><span>MCP servers</span><button type="button" class="btn sm" data-settings-add="${mcpFormKey}" data-focus-key="${mcpFormKey}-toggle" aria-expanded="${String(openSettingsForms.has(mcpFormKey))}">+ Add</button></div>${inventory.inventoryError ? `<p class="settings-help">${esc(inventory.inventoryError)}</p>` : ""}${mcpRows.join("") || '<span class="sempty">None installed</span>'}${mcpForm}</div>`;
    const skillsRows = (inventory.skills ?? []).map((name) => `<div class="sitem"><span title="${esc(name)}">${esc(name)}</span></div>`).join("") || '<span class="sempty">None installed</span>';
    const skills = `<div class="sblock"><div class="sh"><span>Skills</span></div>${skillsRows}</div>`;
    const plugins = cli === "claude" ? `<div class="sblock"><div class="sh"><span>Plugins</span><button type="button" class="btn sm" data-settings-add="plugins-claude" data-focus-key="plugins-claude-toggle" aria-expanded="${String(openSettingsForms.has("plugins-claude"))}">+ Add</button></div>${pluginItems.map((name) => {
      const key = `plugin-remove-${name}`;
      return `<div class="sitem"><span title="${esc(name)}">${esc(name)}</span><span class="skill-row-actions"><button type="button" class="btn sm" data-setting-action="plugin-remove" data-name="${esc(name)}" data-focus-key="${esc(key)}" ${settingsActionRunning(key) ? "disabled" : ""}>Remove</button>${actionStatusMarkup(key)}</span></div>`;
    }).join("") || '<span class="sempty">None installed</span>'}<form class="settings-form" data-plugin-form ${openSettingsForms.has("plugins-claude") ? "" : "hidden"}><input class="settings-input" name="name" maxlength="128" data-focus-key="plugin-name" placeholder="Claude Code plugin identifier" aria-label="Plugin name" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="plugin-submit" ${settingsActionRunning("plugin-add") ? "disabled" : ""}>Install plugin</button>${actionStatusMarkup("plugin-add")}</div></form></div>` : "";
    return `<section class="card skill-card" data-skill-cli="${cli}">${header}${instructionsBlock}${skills}${mcp}${plugins}</section>`;
  }
  function mcpInputValid(name, commandOrUrl) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return "MCP name must use 1-64 letters, numbers, underscores, or hyphens.";
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(commandOrUrl) && !/^https:\/\//i.test(commandOrUrl)) return "MCP URLs must be credential-free HTTPS URLs.";
    if (/^https:\/\//i.test(commandOrUrl)) {
      try { const url = new URL(commandOrUrl); if (url.protocol === "https:" && !url.username && !url.password) return ""; }
      catch { /* the CLI will not receive a malformed URL */ }
      return "MCP URLs must be credential-free HTTPS URLs.";
    }
    if (!commandOrUrl.trim() || /[;&|<>`$(){}\[\]*?~%!^\r\n]/.test(commandOrUrl)) return "MCP commands must be non-empty and contain no shell metacharacters.";
    return "";
  }
  function updateVaultControls() {
    const body = $("setBody"), project = currentProject();
    const input = $("vaultPath"); const selected = input.value.trim(); const saved = String(serverState?.settings?.vault?.path ?? "");
    const changed = selected !== saved;
    const display = $("vaultPathDisplay");
    if (display) { display.textContent = selected || "Choose a folder"; display.title = selected || "Choose a folder"; }
    const status = $("vaultConnectionStatus");
    if (status) {
      status.textContent = changed ? (selected ? "Selected, not connected" : "Not connected") : saved ? `${project?.name ?? "Project"} reads its notes here` : "Not connected";
      status.classList.toggle("connected", Boolean(saved && !changed));
    }
    const toggle = body.querySelector('[data-setting-action="vault-toggle"]');
    if (toggle) {
      toggle.textContent = saved && (!selected || !changed) ? "Disconnect" : "Connect";
      toggle.disabled = settingsActionRunning("vault-save") || (!selected && !saved);
    }
  }
  // The crew is the setup editor's (public/setup-editor*.js): one list of seats, drawn into this mount by renderSettings.
  function settingsCrewSection() {
    const tab = currentTab(); if (!tab) return "";
    return `<section class="settings-section" id="s-crew" data-section="crew"><h3>Crew and models · ${esc(tabLabel(tab.id))}</h3><div data-setup-editor></div></section>`;
  }
  // CLIs added by their start command (Agent Client Protocol). Each can take any seat from the model menu, in Full access only.
  function settingsAcpSection() {
    const rows = (serverState?.acpClis ?? []).map((cli) => `<div class="crow" data-acp-row="${esc(cli.id)}"><span class="logo">${logo(cli.kind, 18, 0)}</span><div class="d"><b title="${esc(cli.name)}">${esc(cli.name)}</b><small title="${esc([cli.program, ...cli.args].join(" "))}">${esc([cli.program, ...cli.args].join(" "))}</small></div><div class="tool-row-action"><button type="button" class="btn sm danger" data-setting-action="acp-remove" data-id="${esc(cli.id)}" data-name="${esc(cli.name)}" data-focus-key="acp-remove-${esc(cli.id)}">Remove</button>${actionStatusMarkup(`acp-remove-${cli.id}`)}</div></div>`).join("") || '<div class="crow note"><span class="muted">No ACP CLIs added yet.</span></div>';
    return `<section class="settings-section" id="s-acp" data-section="acp"><h3>ACP CLIs</h3><p class="settings-help" style="margin:-4px 2px 10px">Any CLI that speaks the Agent Client Protocol can take any seat. Type the command that starts it, like gemini --acp, then pick it from a seat's model menu. It runs with Full access: it may edit files and run commands without asking, and Command Center cannot make it ask yet.</p><div class="card">${rows}</div><form class="settings-form" data-acp-form><input class="settings-input" name="name" maxlength="40" data-focus-key="acp-name" placeholder="Name, like Gemini" aria-label="CLI name" required><input class="settings-input" name="command" maxlength="300" data-focus-key="acp-command" placeholder="Start command, like gemini --acp" aria-label="Start command" required><div class="settings-actions"><button class="btn sm primary" type="submit" data-focus-key="acp-submit"${settingsActionRunning("acp-add") ? " disabled" : ""}>Add CLI</button>${actionStatusMarkup("acp-add")}</div></form></section>`;
  }
  // The crew editor (public/setup-editor*.js) draws the crew into its mount and its Save bar into #setFoot, the strip under the Settings body.
  function renderCrewEditor(body) {
    const tab = currentTab(), mount = body.querySelector("[data-setup-editor]");
    if (!tab || !mount || !window.CC_SETUP_EDITOR) { $("setFoot").replaceChildren(); return; }
    window.CC_SETUP_EDITOR.render(mount, {
      tab, state: serverState, send, dock: $("setFoot"),
      openModel: (seat, anchor, draft) => togglePopover($("pop"), anchor, () => openModelPicker(tab, seat, anchor, false, draft)),
      openAdvisor: (seat, anchor, draft) => togglePopover($("pop"), anchor, () => openAdvisor(tab, seat, anchor, false, draft)),
      modelLine: (cli, model, effort) => modelLine(cli, model, effort, tab), seatLocked: (seat) => seatLocked(tab, seat),
    });
  }
  function renderSettings(fresh = false) {
    const nav = $("setNav"); const body = $("setBody");
    const snapshot = settingsFocusSnapshot(body);
    if (fresh) settingsEdits.clear();
    const drafts = fresh ? new Map() : settingsDraftSnapshot(body);
    const sections = [...(currentTab() ? [["crew", "Crew and models"]] : []), ["tools", "AI tools"], ["acp", "ACP CLIs"], ["github", "GitHub"], ["vault", "Notes vault"], ["folders", "Folders"], ["skills", "Skills and MCP"], ["appearance", "Appearance"], ["behaviour", "Behaviour"]];
    if (!sections.some(([id]) => id === settingsSection)) settingsSection = sections[0][0];
    const settings = serverState?.settings ?? {};
    nav.innerHTML = `<h2>Settings</h2>${sections.map(([id, label]) => `<button type="button" data-settings-section="${id}" data-focus-key="settings-nav-${id}" aria-current="${String(settingsSection === id)}">${label}</button>`).join("")}`;
    const themes = [["light", "Light", "#f0f0f0", "#ffffff"], ["dark", "Dark", "#0f0f11", "#19191c"], ["system", "Match my PC", "linear-gradient(90deg,#0f0f11 50%,#f0f0f0 50%)", "transparent"]];
    const toolRows = ["claude", "codex", "opencode", "gemini"].map((cli) => settingsToolRow(cli, settings.tools?.[cli])).join("");
    const github = settings.github ?? {};
    const githubSubtitle = github.connected === true ? "Signed in through the GitHub CLI. Pushing still depends on each folder having its own repository and remote." : github.connected === false ? "Not connected" : "Connection status unknown";
    const githubTitle = github.account ?? "GitHub CLI";
    const savedVaultPath = settings.vault?.path ?? ""; const vaultPath = savedVaultPath; const defaultFolder = settings.folders?.defaultProjectFolder ?? "";
    const canBrowse = Boolean(window.cc && typeof window.cc.pickFolder === "function");
    const project = currentProject();
    const projectTabs = project?.tabs ?? [];
    const tabFolders = projectTabs.map((tab) => `<div class="crow folder-row"><b title="${esc(tab.name)}">${esc(tab.name)}</b><span class="path folder-path" title="${esc(tab.folder ?? "No folder set")}">${esc(tab.folder ?? "No folder set")}</span><div class="ra folder-browse">${canBrowse ? `<button type="button" class="btn sm" data-setting-action="tab-folder-browse" data-tab-id="${esc(tab.id)}" data-focus-key="tab-folder-${esc(tab.id)}">Browse</button>` : ""}</div></div>`).join("");
    const projectFolderRow = project ? `<div class="crow folder-row"><b>New tabs</b><span class="path" title="${esc(project.folder)}">${esc(project.folder)}</span><div class="ra">${canBrowse ? `<button type="button" class="btn sm" data-setting-action="project-folder-browse" data-focus-key="project-folder">Browse</button>` : ""}</div></div>` : "";
    const vaultStatus = savedVaultPath ? `${project ? esc(project.name) + " reads its notes here" : "Connected"}` : "Not connected";
    const vaultPathControl = canBrowse
      ? `<span class="vault-path-display" id="vaultPathDisplay" title="${esc(vaultPath || "Choose a folder")}">${esc(vaultPath || "Choose a folder")}</span><input id="vaultPath" type="hidden" value="${esc(vaultPath)}" data-focus-key="vault-path">`
      : `<input class="settings-input vault-inline-path" id="vaultPath" value="${esc(vaultPath)}" data-focus-key="vault-path" placeholder="Paste the vault folder path" aria-label="Vault folder">`;
    const vaultToggleText = savedVaultPath && (!vaultPath || vaultPath === savedVaultPath) ? "Disconnect" : "Connect";
    const vaultConnectedClass = savedVaultPath ? "connected" : "";
    const refreshing = refreshState?.status === "running";
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    const notificationsOn = Boolean(settingValue("notificationsEnabled"));
    const content = `${settingsCrewSection()}
      <section class="settings-section" id="s-tools" data-section="tools"><h3>AI tools<button type="button" class="btn sm" data-settings-refresh data-focus-key="settings-refresh"${refreshing ? " disabled" : ""}>${refreshing ? "Checking…" : "Check again"}</button></h3><div class="card tool-card">${toolRows}</div><p class="settings-help">${refreshing ? "Checking every CLI…" : refreshState?.status === "done" ? `Checked ${esc(agoText(refreshState.at))}. ` : refreshState?.status === "failed" ? "Could not check just now. Try again. " : ""}Installed and signed in are checked separately; Install runs npm in the background and asks first.</p></section>
      ${settingsAcpSection()}
      <section class="settings-section" id="s-github" data-section="github"><h3>GitHub</h3><div class="card"><div class="crow github-row"><span class="logo">${logo("github", 18, 0)}</span><div class="d"><b title="${esc(githubTitle)}">${esc(githubTitle)}</b><small class="wrap">${esc(githubSubtitle)}</small></div><div class="ra"><button type="button" class="btn sm" data-setting-action="github-login" data-focus-key="github-login" ${settingsActionRunning("github-login") ? "disabled" : ""}>${github.connected === true ? "Reconnect" : "Connect"}</button>${actionStatusMarkup("github-login")}</div></div></div></section>
      <section class="settings-section" id="s-vault" data-section="vault"><h3>Notes vault</h3><div class="card"><div class="crow vault-row" data-vault-row><span class="logo">${logo("obsidian", 18, 0)}</span><div class="d"><b>Obsidian vault</b><small><span class="vault-path-wrap">${vaultPathControl}</span><span class="vault-separator"> · </span><span id="vaultConnectionStatus" class="${vaultConnectedClass}">${vaultStatus}</span></small></div><div class="ra settings-actions">${canBrowse ? '<button type="button" class="btn sm" data-setting-action="vault-browse" data-focus-key="vault-browse">Browse</button>' : ""}<button type="button" class="btn sm" data-setting-action="vault-toggle" data-focus-key="vault-toggle" ${settingsActionRunning("vault-save") || (!vaultPath.trim() && !savedVaultPath) ? "disabled" : ""}>${vaultToggleText}</button>${actionStatusMarkup("vault-save")}</div></div></div><p class="settings-help vault-help">Optional. Save always writes the tab's own <code>.command-center/&lt;tab&gt;/RESUME.md</code>; the vault is what Open in Obsidian opens.</p></section>
      <section class="settings-section" id="s-folders" data-section="folders"><h3>Folders${project ? ` · ${esc(project.name)}` : ""}</h3><div class="card folder-card">${projectFolderRow}${tabFolders || '<div class="crow"><span class="muted">No tabs are available.</span></div>'}</div><p class="settings-help folder-help">Each tab's crew works in its own folder (no CLI is held to it by a sandbox). A folder can change only while that tab is idle; new tabs start in the project folder.</p><div class="card folder-default" style="margin-top:12px"><div class="settings-row"><label class="field"><span class="lbl">Default folder for new projects</span><input class="settings-input" id="defaultProjectFolder" value="${esc(defaultFolder)}" data-focus-key="default-folder" placeholder="Choose a folder"></label><div class="settings-actions">${canBrowse ? '<button type="button" class="btn sm" data-setting-action="folder-browse" data-focus-key="folder-browse">Browse</button>' : ""}<button type="button" class="btn sm primary" data-setting-action="folder-save" data-focus-key="folder-save" ${settingsActionRunning("folder-save") ? "disabled" : ""}>Save folder</button>${actionStatusMarkup("folder-save")}</div></div></div></section>
      <section class="settings-section" id="s-skills" data-section="skills"><h3>Skills and MCP</h3><p class="settings-help sintro" style="margin:-4px 2px 10px">Tools available to your agents, and the instruction files each CLI found. MCP and plugin Add and Remove run the CLI's own command and ask first.</p><div class="skills-grid">${["claude", "codex", "opencode", "gemini"].map((cli) => skillBlock(cli, settings.skills?.[cli])).join("")}</div></section>
      <section class="settings-section" id="s-appearance" data-section="appearance"><h3>Appearance</h3><div class="theme" role="radiogroup" aria-label="Appearance">${themes.map(([value, label, background, side]) => `<button type="button" role="radio" data-theme="${value}" aria-checked="${String(activeTheme === value)}" data-focus-key="theme-${value}"><span class="sw" style="background:${background}"><i style="background:${side}"></i><i></i></span>${label}</button>`).join("")}</div><p class="settings-help">${activeTheme === "system" ? "Following your PC: it switches by itself when Windows does." : "Remembered on this PC."}</p></section>
      <section class="settings-section" id="s-behaviour" data-section="behaviour"><h3>Behaviour</h3><div class="card">${settingSwitch("notificationsEnabled", "Notifications", "A desktop notice when a seat finishes, fails or needs you", settingValue("notificationsEnabled"), false, notificationsOn && permission === "denied" ? '<small class="wrap" style="color:var(--danger-text)">Blocked by the browser for this page. Allow notifications in the site settings, or nothing will show.</small>' : notificationsOn && permission === "unsupported" ? '<small class="wrap">This window cannot show desktop notices.</small>' : "")}${settingSwitch("bellEnabled", "Completion sound", "A short chime when a seat finishes, fails or needs you, with Notifications on or off. The speaker in the top bar switches it too and sets its volume", settingValue("bellEnabled"))}</div></section>`;
    body.innerHTML = `<div class="set">${content}</div>`;
    // The crew editor draws before the scroll position is put back: until then Settings is shorter, and the old position would be cut to fit.
    renderCrewEditor(body);
    restoreSettingsDrafts(body, drafts);
    updateVaultControls();
    restoreSettingsFocus(body, snapshot);
    fixRadios(body);
    nav.querySelectorAll("[data-settings-section]").forEach((button) => button.addEventListener("click", () => {
      closePopovers(); // a menu over Settings belongs to the section it was opened in
      settingsSection = button.dataset.settingsSection; settingsScrollLock = Date.now(); markSettingsNav(); const target = body.querySelector(`#s-${CSS.escape(settingsSection)}`); if (target) body.scrollTop = target.offsetTop - 20; button.focus({ preventScroll: true });
    }));
    body.onscroll = () => { trackSettingsScroll(); closeScrolledMenus(); };
    body.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
      setTheme(button.dataset.theme); renderSettings();
      body.querySelector(`[data-theme="${CSS.escape(activeTheme)}"]`)?.focus({ preventScroll: true });
    }));
    $("vaultPath").addEventListener("input", updateVaultControls);
    body.querySelector("[data-settings-refresh]")?.addEventListener("click", () => {
      const requestId = newRequestId(), previous = refreshState;
      refreshState = { status: "running", at: Date.now(), requestId }; // before the send: a local server's answer can arrive inside it
      if (!send({ type: "refreshSettings", requestId })) { refreshState = previous; return; }
      renderSettings();
      // The server answers success and failure alike; if it never answers at all, "Checking…" does not stay on forever.
      setTimeout(() => { if (refreshState?.status === "running" && refreshState.requestId === requestId) { refreshState = { status: "failed", at: Date.now() }; if (!$("setModal").hidden) renderSettings(); } }, REFRESH_WAIT_MS);
    });
    body.querySelectorAll("[data-settings-add]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.settingsAdd;
      if (openSettingsForms.has(key)) openSettingsForms.delete(key); else openSettingsForms.add(key);
      renderSettings();
    }));
    body.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
      const command = button.dataset.copy;
      try { await navigator.clipboard.writeText(command); showToast("Command copied"); }
      catch {
        const input = document.createElement("textarea"); input.value = command; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select();
        const copied = document.execCommand("copy"); input.remove(); showToast(copied ? "Command copied" : "Could not copy. Select it and copy by hand");
      }
    }));
    body.querySelectorAll("[data-setting]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.setting; const next = button.getAttribute("aria-checked") !== "true";
      if (send({ type: "updateClientPref", key, value: next })) {
        clientPrefOverrides.set(key, next);
        if (key === "bellEnabled") renderSoundButton();
        if (key === "notificationsEnabled" && next && "Notification" in window && Notification.permission === "default") Promise.resolve(Notification.requestPermission()).then(() => { if (!$("setModal").hidden) renderSettings(); }).catch(() => {});
      }
      renderSettings(); body.querySelector(`[data-setting="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }));
    body.querySelectorAll("[data-setting-action]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.settingAction; const cli = button.dataset.cli; const name = button.dataset.name;
      if (action === "vault-browse") { pickFolder((folder) => { if ($("setModal").hidden) return; $("vaultPath").value = folder; settingsEdits.add("vault-path"); updateVaultControls(); }); return; }
      if (action === "folder-browse") { pickFolder((folder) => { $("defaultProjectFolder").value = folder; settingsEdits.add("default-folder"); }); return; }
      if (action === "tab-folder-browse") { const tabId = button.dataset.tabId; pickFolder((folder) => send({ type: "changeFolder", tabId, folder })); return; }
      if (action === "project-folder-browse") { const projectId = currentProject()?.id; if (projectId) pickFolder((folder) => send({ type: "changeProjectFolder", projectId, folder })); return; }
      let payload = null; let key = ""; let confirmation = null;
      if (action === "install-cli") { key = `install-${cli}`; payload = { type: "installCli", cli, confirm: true }; confirmation = { title: `Install ${CLI_LABEL[cli]}?`, body: `Runs npm install -g with ${CLI_LABEL[cli]}'s own fixed package in the background. Signing in comes after.`, ok: "Install" }; }
      if (action === "login-cli") { key = `login-${cli}`; payload = { type: "cliLogin", cli }; }
      if (action === "github-login") { key = "github-login"; payload = { type: "ghLogin" }; }
      if (action === "vault-toggle") {
        key = "vault-save";
        const selected = $("vaultPath").value.trim(); const saved = String(settings.vault?.path ?? "");
        payload = { type: "setNotesVault", path: saved && selected === saved ? null : selected || null };
      }
      if (action === "folder-save") { key = "folder-save"; payload = { type: "setDefaultProjectFolder", folder: $("defaultProjectFolder").value.trim() }; }
      if (action === "mcp-remove") { key = `mcp-remove-${cli}-${name}`; payload = { type: "mcpRemove", cli, name, confirm: true }; confirmation = { title: `Remove ${name} from ${CLI_LABEL[cli]}?`, body: `Runs ${CLI_LABEL[cli]}'s own remove command. Agents lose this tool from their next session.`, ok: "Remove", danger: true }; }
      if (action === "acp-remove") { key = `acp-remove-${button.dataset.id}`; payload = { type: "removeAcpCli", id: button.dataset.id }; confirmation = { title: `Remove ${name}?`, body: `${name} leaves the ACP CLI list. A tab that leads with it must pick another CLI first.`, ok: "Remove", danger: true }; }
      if (action === "plugin-remove") { key = `plugin-remove-${name}`; payload = { type: "pluginUninstall", name, confirm: true }; confirmation = { title: `Remove the ${name} plugin?`, body: "Runs Claude Code's own uninstall command.", ok: "Remove", danger: true }; }
      if (!payload) return;
      const run = () => { const sentId = sendSettingsAction(key, payload); if (sentId) renderSettings(); };
      if (confirmation) confirmAction(confirmation, run, button); else run();
    }));
    body.querySelectorAll("[data-mcp-form]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault(); const cli = form.dataset.mcpForm; const name = form.elements.name.value.trim(); const commandOrUrl = form.elements.commandOrUrl.value.trim();
      const error = mcpInputValid(name, commandOrUrl);
      if (error) { showToast(error); return; }
      const key = `mcp-add-${cli}`;
      // The Settings text promises "Add and Remove ... ask first": an MCP tool is a program that runs on this PC.
      confirmAction({ title: `Add ${name} to ${CLI_LABEL[cli]}?`, body: `Runs ${CLI_LABEL[cli]}'s own add command for ${commandOrUrl}. Agents get this tool from their next session and it runs on this PC, so only add one you trust.`, ok: "Add" },
        () => { if (sendSettingsAction(key, { type: "mcpAdd", cli, name, commandOrUrl })) renderSettings(); }, event.submitter ?? document.activeElement);
    }));
    body.querySelector("[data-acp-form]")?.addEventListener("submit", (event) => {
      event.preventDefault(); const name = event.currentTarget.elements.name.value.trim(); const command = event.currentTarget.elements.command.value.trim();
      if (!name || !command) return;
      confirmAction({ title: `Add ${name}?`, body: `Command Center will start ${command} from your PC when you pick ${name} as a leader. It runs with Full access, so only add a CLI you trust.`, ok: "Add" },
        () => { if (sendSettingsAction("acp-add", { type: "addAcpCli", name, command })) renderSettings(); }, event.submitter ?? document.activeElement);
    });
    body.querySelector("[data-plugin-form]")?.addEventListener("submit", (event) => {
      event.preventDefault(); const name = event.currentTarget.elements.name.value.trim(); if (!name) return;
      confirmAction({ title: `Install the ${name} plugin?`, body: "Runs Claude Code's own plugin install command. A plugin can run code on this PC, so only install one you trust.", ok: "Install" },
        () => { if (sendSettingsAction("plugin-add", { type: "pluginInstall", name })) renderSettings(); }, event.submitter ?? document.activeElement);
    });
  }

