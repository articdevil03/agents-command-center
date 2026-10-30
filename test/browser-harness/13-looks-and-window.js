(() => {
  const { audit, check, waitFor, text, $, requireElement, pressEscape } = window.__ccHarness;
  // The app window opens on a new random port each launch: a page's localStorage is empty then. The same real server is opened from two
  // different proxy ports (two origins); what the first page chose must be what the second one shows.
  const runLooksWrite = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real server state");
    requireElement('#themeTg [data-theme-toggle="dark"]').click();
    $("meBtn").click(); requireElement('#avModal[aria-hidden="false"]');
    requireElement('#avgrid [data-avatar="momo"]').click();
    await waitFor(() => window.__latestState.clientPrefs?.theme === "dark" && window.__latestState.clientPrefs?.avatar === "momo.svg", "the real server keeps the theme and picture");
    check("a theme and picture chosen in one page load are kept by the real server", !document.body.classList.contains("light") && $("meImg").getAttribute("src") === "/avatars/momo.svg", { port: location.port, prefs: window.__latestState.clientPrefs });
    // The sound volume too: set in the speaker's popover, sent when the slider is let go.
    $("soundBtn").click(); requireElement('#soundPop[aria-hidden="false"]');
    const slider = $("soundVol"); slider.value = "35";
    slider.dispatchEvent(new Event("input", { bubbles: true })); slider.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => window.__latestState.clientPrefs?.bellVolume === 35, "the real server keeps the sound volume");
    pressEscape();
    check("a sound volume set in one page load is kept by the real server", window.__latestState.clientPrefs.bellVolume === 35 && $("soundVol").value === "35" && text("#soundVolOut") === "35%", { prefs: window.__latestState.clientPrefs, slider: $("soundVol").value });
    audit.matched.port = location.port;
  };
  const runLooksRead = async () => {
    await waitFor(() => window.__latestState?.type === "state", "real server state");
    let storedTheme = "unreadable", storedMe = "unreadable";
    try { storedTheme = localStorage.getItem("cc-theme"); storedMe = localStorage.getItem("cc-me"); } catch {}
    await waitFor(() => !document.body.classList.contains("light"), "the saved dark theme is applied in a fresh page load on another port");
    await waitFor(() => $("meImg").getAttribute("src") === "/avatars/momo.svg", "the saved picture is applied in a fresh page load on another port");
    check("a fresh page load on a different port opens in the theme and picture chosen before", storedTheme === null && storedMe === null && requireElement('#themeTg [data-theme-toggle="dark"]').getAttribute("aria-checked") === "true", { port: location.port, storedTheme, storedMe, light: document.body.classList.contains("light"), picture: $("meImg").getAttribute("src"), prefs: window.__latestState.clientPrefs });
    $("soundBtn").click(); requireElement('#soundPop[aria-hidden="false"]');
    const volume = { slider: $("soundVol").value, shown: text("#soundVolOut"), fill: $("soundVol").style.getPropertyValue("--v"), server: window.__latestState.clientPrefs.bellVolume };
    pressEscape();
    check("a fresh page load on a different port opens the sound popover at the volume set before", volume.slider === "35" && volume.shown === "35%" && volume.fill === "0.35" && volume.server === 35, volume);
    audit.matched.port = location.port;
  };

  // The app window's own minimize, maximize/restore and close buttons. The proxy gives this page the window.cc bridge the Electron preload
  // gives the real one (window.__ccWin records each call); the window starts maximized, so the button must open as "Restore".
  const runWindowButtons = async () => {
    await waitFor(() => window.__latestState?.type === "state", "fake server state");
    const group = requireElement("#winBtns"), buttons = ["#winMin", "#winMax", "#winClose"].map((selector) => requireElement(selector)), [min, max, close] = buttons;
    const shown = (element) => element.checkVisibility();
    const region = (element) => getComputedStyle(element).getPropertyValue("-webkit-app-region");
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const maxState = () => ({ maximized: max.dataset.maximized, label: max.getAttribute("aria-label"), title: max.title, icons: [...max.querySelectorAll("svg")].filter(shown).map((svg) => svg.getAttribute("class")) });
    await waitFor(() => max.dataset.maximized === "true", "the window's starting maximized state reaches the button");
    const atLoad = maxState();

    const settings = box(requireElement("#setBtn")), settingsRadius = getComputedStyle(requireElement("#setBtn")).borderRadius;
    const bar = [...requireElement("#top").children];
    const looks = buttons.map((button) => ({ id: button.id, tag: button.tagName, type: button.type, label: button.getAttribute("aria-label"), tabIndex: button.tabIndex, shown: shown(button), region: region(button), ...box(button), radius: getComputedStyle(button).borderRadius }));
    const sameFamily = looks.every((item) => item.tag === "BUTTON" && item.type === "button" && item.label && item.tabIndex === 0 && item.shown && item.region === "no-drag"
      && Math.abs(item.width - settings.width) < 0.5 && Math.abs(item.height - settings.height) < 0.5 && item.radius === settingsRadius && Math.abs((item.top + item.bottom) / 2 - (settings.top + settings.bottom) / 2) < 1);
    check("with the app bridge the window buttons show after the avatar, as labelled buttons the size and shape of Settings, and none of them drags the window",
      shown(group) && region(group) === "no-drag" && region(requireElement("#top")) === "drag" && bar.indexOf(requireElement("#meBtn")) === bar.length - 2 && bar.at(-1) === group
      && looks.map((item) => item.label).join() === "Minimize,Restore,Close" && sameFamily,
      { group: { shown: shown(group), region: region(group) }, order: bar.map((node) => node.id || node.className), looks, settings: { ...settings, radius: settingsRadius } });

    min.click(); max.click(); close.click();
    const calls = [...window.__ccWin.calls];
    check("each window button sends its own call once per click: minimize, maximize or restore, close", JSON.stringify(calls) === JSON.stringify(["minimize", "toggleMaximize", "close"]), { calls });

    window.__ccWinEmit(false); const restored = maxState();
    window.__ccWinEmit(true); const maximizedAgain = maxState();
    const restoreLook = (state) => state.maximized === "true" && state.label === "Restore" && state.title === "Restore" && state.icons.join() === "wrestore";
    check("the maximize button opens as Restore on a maximized window and swaps icon, label and tooltip on every maximize and restore",
      restoreLook(atLoad) && restored.maximized === "false" && restored.label === "Maximize" && restored.title === "Maximize" && restored.icons.join() === "wmax" && restoreLook(maximizedAgain),
      { atLoad, restored, maximizedAgain });

    // The app's minimum window width: every control in the bar stays whole, inside the window, and clear of every other.
    const controls = [requireElement("#top .mark"), ...requireElement("#top").querySelectorAll("button,[role=tab]")].filter(shown).filter((element) => !element.closest("#ptabs") || element.matches("[role=tab]"));
    const ptabs = box(requireElement("#ptabs"));
    const rects = controls.map((element) => { const r = box(element); return { id: element.id || element.className?.baseVal || element.className, ...r, ...(element.matches("[role=tab]") ? { left: Math.max(r.left, ptabs.left), right: Math.min(r.right, ptabs.right) } : {}) }; }).filter((r) => r.right - r.left > 0.5);
    const clashes = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j], x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 0.5 && y > 0.5) clashes.push([a.id, b.id, x, y]);
    }
    const outside = rects.filter((r) => r.left < -0.5 || r.right > innerWidth + 0.5).map((r) => r.id);
    check("at the app's minimum width nothing in the top bar overlaps or leaves the window", innerWidth === 900 && rects.length >= 10 && clashes.length === 0 && outside.length === 0 && box(close).right <= innerWidth - 13,
      { innerWidth, controls: rects.length, clashes, outside, closeRight: box(close).right });

    // The sound popover at the same width: whole, inside the window, right under the speaker.
    $("soundBtn").click();
    const soundPop = box(requireElement('#soundPop[aria-hidden="false"]')), speaker = box(requireElement("#soundBtn"));
    check("at the app's minimum width the sound popover opens whole, inside the window, right under the speaker",
      soundPop.left >= 12 && soundPop.right <= innerWidth - 12 && soundPop.bottom <= innerHeight && soundPop.top >= speaker.bottom && soundPop.top - speaker.bottom <= 12 && soundPop.left <= speaker.right && soundPop.right >= speaker.left && soundPop.width >= 280,
      { soundPop, speaker, innerWidth, innerHeight });
    pressEscape();

    // Closing the app while a tab is working. window.__ccWinAskClose() plays electron/main.js asking this page; window.__ccWin.answers records
    // what the page told the window: "close" at once with nothing working, else "hold" with its warning up, then "keep" or "close".
    const answers = window.__ccWin.answers;
    const ask = () => { const before = answers.length; window.__ccWinAskClose(); return answers.slice(before); };
    const warning = () => ({ open: !$("confirmModal").hidden && $("confirmModal").classList.contains("on") && $("confirmModal").getAttribute("aria-hidden") === "false", title: text("#confirmTitle"), body: text("#confirmBody"), keep: text("#confirmCancel"), close: text("#confirmOk"), danger: $("confirmOk").classList.contains("danger"), role: $("confirmModal").getAttribute("role"), focused: $("confirmModal").contains(document.activeElement), modals: document.querySelectorAll(".modal.on").length, scrim: $("scrim").classList.contains("on") });
    // Which tabs work comes from each tab's activeWork (the server's own check), never from derived.busy: the two are set opposite here.
    const withWork = (ids) => {
      const state = structuredClone(window.__ccSeed), beta = state.projects.find((project) => project.id === "beta"), model = beta.tabs[0];
      if (ids.includes("beta-qa")) beta.tabs.push({ ...structuredClone(model), id: "beta-qa", name: "QA" }, { ...structuredClone(model), id: "beta-docs", name: "Docs" });
      for (const tab of state.projects.flatMap((project) => project.tabs)) { tab.activeWork = ids.includes(tab.id); tab.derived.busy = !tab.activeWork; }
      window.__ccDeliver({ ...state, type: "state" });
    };
    withWork([]);
    const idle = { answers: ask(), warning: warning() };
    check("a close request with nothing working is answered close at once, with no warning", idle.answers.join() === "close" && !idle.warning.open && !idle.warning.scrim, idle);

    withWork(["alpha-dev", "beta-dev"]);
    const first = { answers: ask(), warning: warning() };
    check("a close request while tabs are working holds the close and names them as Project · Tab in the app's own warning",
      first.answers.join() === "hold" && first.warning.open && first.warning.scrim && first.warning.role === "alertdialog" && first.warning.focused && first.warning.title === "Close Command Center?"
      && first.warning.body === "2 tabs are still working: Alpha\u00A0·\u00A0Development, Beta\u00A0·\u00A0Development. Closing stops them." && first.warning.keep === "Keep open" && first.warning.close === "Close anyway" && first.warning.danger, first);
    const again = { answers: ask(), warning: warning() };
    check("a second close request while the warning shows redraws the same warning, never a second one", again.answers.join() === "hold" && again.warning.open && again.warning.modals === 1 && again.warning.body === first.warning.body, again);

    $("confirmCancel").click(); const keepButton = { answers: answers.slice(-1), warning: warning() };
    const escapeAnswers = [...ask()]; pressEscape(); escapeAnswers.push(...answers.slice(-1)); const escapeWarning = warning();
    const scrimAnswers = [...ask()]; $("scrim").click(); scrimAnswers.push(...answers.slice(-1)); const scrimWarning = warning();
    check("Keep open, Escape and a click outside cancel the warning and tell the window to stay open",
      keepButton.answers.join() === "keep" && !keepButton.warning.open && !keepButton.warning.scrim && escapeAnswers.join() === "hold,keep" && !escapeWarning.open && scrimAnswers.join() === "hold,keep" && !scrimWarning.open,
      { keepButton, escapeAnswers, escapeWarning, scrimAnswers, scrimWarning });

    const closeStart = answers.length;
    ask(); $("confirmOk").click();
    const closeAnyway = { answers: answers.slice(closeStart), warning: warning() };
    check("Close anyway tells the window to close, and nothing after it says stay", closeAnyway.answers.join() === "hold,close" && !closeAnyway.warning.open, closeAnyway);

    withWork(["alpha-design"]);
    const oneAnswers = ask(), one = warning(); $("confirmCancel").click();
    withWork(["alpha-dev", "alpha-design", "beta-dev", "beta-qa", "beta-docs"]);
    const fiveAnswers = ask(), five = warning(); pressEscape();
    withWork([]);
    const idleAgain = ask();
    check("the warning names one working tab as it, and more than three as the first three and +N more",
      oneAnswers.join() === "hold" && one.body === "1 tab is still working: Alpha\u00A0·\u00A0Design. Closing stops it." && fiveAnswers.join() === "hold"
      && five.body === "5 tabs are still working: Alpha\u00A0·\u00A0Development, Alpha\u00A0·\u00A0Design, Beta\u00A0·\u00A0Development +2 more. Closing stops them." && idleAgain.join() === "close" && !warning().open,
      { oneAnswers, one: one.body, fiveAnswers, five: five.body, idleAgain });

    // The server's answer that a tab was created closes the Add tab dialog, never the close-app question that is open over it
    // (closing that one counts as Keep open).
    withWork([]);
    $("addtab").click();
    requireElement('#modal[aria-hidden="false"]');
    $("browse").click();
    await waitFor(() => !$("createTab").disabled, "the Add tab dialog has a folder");
    $("createTab").click();
    const createSent = window.__sent.filter((message) => message.type === "addTab").length === 1;
    withWork(["alpha-dev"]);
    const stackedAnswers = ask();
    const stacked = !$("modal").hidden && !$("confirmModal").hidden;
    const created = structuredClone(window.__ccSeed), alphaProject = created.projects.find((project) => project.id === "alpha");
    const newTab = structuredClone(alphaProject.tabs[0]); newTab.id = "alpha-new"; newTab.name = "New tab"; alphaProject.tabs.push(newTab);
    for (const tab of created.projects.flatMap((project) => project.tabs)) { tab.activeWork = tab.id === "alpha-dev"; tab.derived.busy = !tab.activeWork; }
    const answersBefore = answers.length;
    window.__ccDeliver({ ...created, type: "state" });
    const dialogClosed = $("modal").hidden;
    const questionKept = !$("confirmModal").hidden && !answers.slice(answersBefore).includes("keep");
    check("the server's answer that a tab was created closes the Add tab dialog, not the close question open over it",
      createSent && stackedAnswers.join() === "hold" && stacked && dialogClosed && questionKept, { createSent, stackedAnswers, stacked, dialogClosed, questionKept, answers: answers.slice(answersBefore) });
    $("confirmCancel").click();
  };
  Object.assign(window.__ccHarness, { runLooksWrite, runLooksRead, runWindowButtons });
})();
