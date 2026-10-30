(() => {
  const { check, waitFor, text, $, requireElement, clickTab, settleMicrotasks, deliver } = window.__ccHarness;
  const checkSettingsTargetsAndScroll = async () => {
    const targets = ["#inboxBtn", "#inboxN", "#inboxPop", "#inboxList", "#reqNew", "#reqN", "#reqList", "#reqForm", "#reqTo", "#reqTitle", "#reqBody", "#reqSend", "#reqStatus", "#permBtn", "#permPop", '[data-l="activity"]', '[data-l="changes"]', '[data-l="notes"]', '[data-l="usage"]', "#setBtn", "#setModal", "#setNav", "#setBody", "#avModal", "#avgrid", "#avUp", "#avatarStatus", "#viewer", "#viewerFiles"];
    const missingTargets = targets.filter((selector) => !document.querySelector(selector));
    check(`Pack C target selector list finds every required control at ${innerWidth}px`, missingTargets.length === 0, { found: targets.filter((selector) => document.querySelector(selector)), missing: missingTargets, width: innerWidth });
    const settingsSections = ["crew", "tools", "github", "vault", "folders", "skills", "appearance", "behaviour"];
    if ($("setModal").hidden) $("setBtn").click();
    const foundSettingsSections = [];
    for (const section of settingsSections) {
      const navTarget = `#setNav [data-settings-section="${section}"]`;
      if (!document.querySelector(navTarget)) continue;
      document.querySelector(navTarget).click();
      if (document.querySelector(`#setBody #s-${section}`)) foundSettingsSections.push(`#s-${section}`);
    }
    const missingSettingsSections = settingsSections.map((section) => `#s-${section}`).filter((selector) => !foundSettingsSections.includes(selector));
    check(`Settings section target list finds all eight sections at ${innerWidth}px`, missingSettingsSections.length === 0, { found: foundSettingsSections, missing: missingSettingsSections, navItems: [...document.querySelectorAll("#setNav [data-settings-section]")].map((item) => item.dataset.settingsSection) });
    const settingsBody = $("setBody");
    await new Promise((resolve) => setTimeout(resolve, 410));
    // The dialog opens with a short scale-in; measure positions once it has settled at full size.
    await waitFor(() => new DOMMatrixReadOnly(getComputedStyle($("setModal")).transform).a === 1, "Settings open animation settled");
    const scrollTarget = requireElement("#s-skills");
    const offsets = () => [...settingsBody.querySelectorAll(".settings-section")].map((section) => `${section.dataset.section}:${section.offsetTop}/${section.offsetHeight}`).join(" ");
    const scrollBefore = { scrollTop: settingsBody.scrollTop, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, offsets: offsets(), scrollHeight: settingsBody.scrollHeight };
    settingsBody.scrollTop += scrollTarget.getBoundingClientRect().top - settingsBody.getBoundingClientRect().top - 60;
    const scrollAfter = { scrollTop: settingsBody.scrollTop, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, offsets: offsets(), scrollHeight: settingsBody.scrollHeight };
    settingsBody.dispatchEvent(new Event("scroll"));
    const scrollTrackedSection = [...document.querySelectorAll("#setNav [data-settings-section]")].find((item) => item.getAttribute("aria-current") === "true")?.dataset.settingsSection;
    const sectionTops = [...settingsBody.querySelectorAll(".settings-section")].map((section) => `${section.dataset.section}:${Math.round((section.getBoundingClientRect().top - settingsBody.getBoundingClientRect().top) * 10) / 10}`);
    settingsBody.scrollTop = settingsBody.scrollHeight;
    settingsBody.dispatchEvent(new Event("scroll"));
    const bottomTrackedSection = [...document.querySelectorAll("#setNav [data-settings-section]")].find((item) => item.getAttribute("aria-current") === "true")?.dataset.settingsSection;
    check(`Settings scroll tracking marks the section and the final section at ${innerWidth}px`, scrollTrackedSection === "skills" && bottomTrackedSection === "behaviour", { scrollTop: settingsBody.scrollTop, scrollHeight: settingsBody.scrollHeight, clientHeight: settingsBody.clientHeight, targetTop: scrollTarget.getBoundingClientRect().top, bodyTop: settingsBody.getBoundingClientRect().top, scrollBefore, scrollAfter, sectionTops, activeSection: scrollTrackedSection, bottomActiveSection: bottomTrackedSection });
  };
  const seedSettingsState = () => {
    const stateCopy = structuredClone(window.__ccSeed);
    stateCopy.selectedTabId = "alpha-dev";
    stateCopy.pendingRequestCounts = { "alpha-dev": 2, "alpha-design": 5, "beta-dev": 1 };
    stateCopy.requests = [];
    stateCopy.requestActions ??= {};
    stateCopy.settings ??= {};
    stateCopy.settings.tools = {
      claude: { installed: true, version: "2.1.0", signedIn: false },
      codex: { installed: true, version: "0.155.1", signedIn: false },
      opencode: { installed: true, version: "1.2.3", signedIn: false },
      gemini: { installed: false, version: null, signedIn: null },
    };
    stateCopy.settings.github = { connected: false, account: null };
    stateCopy.settings.vault = { path: null };
    stateCopy.settings.folders = { defaultProjectFolder: "" };
    stateCopy.settings.permissionModes = { "alpha-dev": "ask", "alpha-design": "plan", "beta-dev": "accept" };
    stateCopy.settings.permissionActions ??= {};
    stateCopy.settings.uploads ??= {};
    stateCopy.settings.skills = {
      claude: { instructionFiles: [], skills: [], mcpServers: [{ name: "claude_mcp" }], plugins: ["sample-plugin"] },
      codex: { instructionFiles: [], skills: [], mcpServers: [{ name: "codex_mcp" }], plugins: [] },
      opencode: { instructionFiles: [], skills: [], mcpServers: [{ name: "open_mcp" }], plugins: [] },
      gemini: { instructionFiles: [{ path: "~/.gemini/GEMINI.md", scope: "global" }, { path: "GEMINI.md", scope: "project" }], skills: [], mcpServers: [], plugins: [] },
    };
    const selected = stateCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    const design = stateCopy.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-design");
    if (selected) { selected.permissionMode = "ask"; selected.changes = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] }; selected.notes = { path: null, content: "", truncated: false }; }
    if (design) { design.permissionMode = "plan"; design.changes = { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] }; design.notes = { path: null, content: "", truncated: false }; }
    window.__ccSeed = structuredClone(stateCopy);
    window.__ccDeliver({ ...stateCopy, type: "state" });
  };
  const checkRequestBadgeAndLowerPanes = async () => {
    const initialBadge = $("reqN").textContent;
    await clickTab("Design");
    const designBadge = $("reqN").textContent;
    await clickTab("Development");
    check(`request badge reads the selected tab at ${innerWidth}px`, initialBadge === "2" && designBadge === "5" && $("reqN").textContent === "2" && $("reqHeadLabel").textContent.includes("Development"), { initialTab: "alpha-dev", initialBadge, designTab: "alpha-design", designBadge, restoredBadge: $("reqN").textContent, heading: $("reqHeadLabel").textContent });

    const changesTab = requireElement('[data-l="changes"]'); changesTab.click();
    const changesHonest = text("#lowerBody").includes("Not a git repository") && !text("#lowerBody").includes("main");
    requireElement('[data-l="notes"]').click();
    const emptyNotes = text("#lowerBody").includes("Nothing saved yet") && !text("#lowerBody").includes("mockup");
    const noVaultButton = requireElement("#lowerBody [data-open-vault]");
    const noVaultHonest = noVaultButton.disabled && noVaultButton.textContent.includes("Open in Obsidian") && text("#lowerBody [data-vault-empty]") === "No vault is connected";
    const openedBeforeNoVault = window.__ccOpenedObsidian.length;
    noVaultButton.click(); await settleMicrotasks();
    const noVaultNoop = window.__ccOpenedObsidian.length === openedBeforeNoVault;
    check(`Changes and Notes pills render server empty state and no-vault action at ${innerWidth}px`, changesHonest && emptyNotes && noVaultHonest && noVaultNoop, { changes: text("#lowerBody"), changesHonest, emptyNotes, noVaultHonest, noVaultNoop, openedObsidian: window.__ccOpenedObsidian.length });

    const lookState = structuredClone(window.__latestState);
    const lookTab = lookState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === "alpha-dev");
    lookTab.changes = { repo: true, branch: "redesign", ahead: 2, behind: 1, lastCommit: { hash: "a41bf2a", subject: "Pack C" }, uncommittedFiles: [{ status: "M", path: "public/app.js" }, { status: "A", path: "test/look.test.js" }, { status: "D", path: "public/old.css" }] };
    lookTab.notes = { path: "C:\\project\\.command-center\\RESUME.md", content: "# Where we left off\nCommand Center look pass\n- Settings follows the approved mockup\n- Request safety remains server-owned", truncated: false };
    deliver(lookState);
    requireElement('[data-l="changes"]').click();
    const changeTargets = ['#lowerBody [data-change-row="branch"]', '#lowerBody [data-change-row="commit"]', '#lowerBody [data-change-row="files"]', "#lowerBody [data-change-file-list]", "#lowerBody [data-change-file-list] .M", "#lowerBody [data-change-file-list] .A", "#lowerBody [data-change-file-list] .D"];
    const missingChangeTargets = changeTargets.filter((selector) => !document.querySelector(selector));
    const changeRows = [...document.querySelectorAll("#lowerBody [data-change-row]")].map((row) => row.textContent.trim());
    const changeFiles = [...document.querySelectorAll("#lowerBody [data-change-file-list] b")].map((node) => node.textContent.trim());
    check(`Pack C Changes target list finds every mockup row and status at ${innerWidth}px`, missingChangeTargets.length === 0, { found: changeTargets.filter((selector) => document.querySelector(selector)), missing: missingChangeTargets, width: innerWidth });
    check(`Pack C Changes rows match Branch, Last commit, Remote and Not committed at ${innerWidth}px`, changeRows[0]?.includes("Branch") && changeRows[0]?.includes("redesign") && changeRows[1]?.includes("Last commit") && changeRows[1]?.includes("a41bf2a") && changeRows[2]?.includes("Remote") && changeRows[2]?.includes("2 commits not pushed") && changeRows[2]?.includes("1 behind") && changeRows[3]?.includes("Not committed") && changeRows[3]?.includes("3 files") && changeFiles.join("") === "MAD", { matchedRows: changeRows, matchedStatuses: changeFiles, branch: text('#lowerBody [data-change-row="branch"] .mono'), commit: text('#lowerBody [data-change-row="commit"] .mono'), count: text('#lowerBody [data-change-row="files"] .mono') });
    requireElement('[data-l="notes"]').click();
    const noteTargets = ["#lowerBody .resume .lbl", "#lowerBody .note-rows", "#lowerBody [data-note-row]", "#lowerBody [data-open-vault]", "#lowerBody [data-vault-empty]"];
    const missingNoteTargets = noteTargets.filter((selector) => !document.querySelector(selector));
    check(`Pack C Notes target list finds the heading, rows and no-vault state at ${innerWidth}px`, missingNoteTargets.length === 0, { found: noteTargets.filter((selector) => document.querySelector(selector)), missing: missingNoteTargets, heading: text("#lowerBody .resume .lbl"), noteRows: [...document.querySelectorAll("#lowerBody [data-note-row]")].map((node) => node.textContent.trim()), vaultState: text("#lowerBody [data-vault-empty]") });

    const composerTargets = ["#ctools #attachBtn", "#ctools #attachInput", "#ctools #permBtn", "#ctools #permBtn .perm-dot", "#ctools #permBtn .perm-chevron"];
    const missingComposerTargets = composerTargets.filter((selector) => !document.querySelector(selector));
    const attach = requireElement("#ctools #attachBtn"), permissionPill = requireElement("#ctools #permBtn");
    const attachBeforePermission = Boolean(attach.compareDocumentPosition(permissionPill) & Node.DOCUMENT_POSITION_FOLLOWING);
    check(`Pack C composer target list finds Attach and the permission pill at ${innerWidth}px`, missingComposerTargets.length === 0, { found: composerTargets.filter((selector) => document.querySelector(selector)), missing: missingComposerTargets, width: innerWidth });
    check(`Pack C composer puts Attach before the permission pill at ${innerWidth}px`, attachBeforePermission && permissionPill.classList.contains("perm"), { order: [...document.querySelectorAll("#ctools > button")].map((button) => button.id), matchedAttach: attach.id, matchedPermission: permissionPill.id, permissionLabel: text("[data-permission-label]", permissionPill) });
  };
  Object.assign(window.__ccHarness, { checkSettingsTargetsAndScroll, seedSettingsState, checkRequestBadgeAndLowerPanes });
})();
