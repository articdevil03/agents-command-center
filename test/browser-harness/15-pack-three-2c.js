(() => {
  const { check, waitFor, text, $, requireElement, latestTab, openSeatView, sleep, tabId, deliverSeed, sentSince } = window.__ccHarness;
  const runPackThreeC = async (part) => {
    // Settings > Folders > New tabs.
    await part("New tabs Browse", async () => {
      $("setBtn").click(); requireElement('#setNav [data-settings-section="folders"]').click();
      window.__ccFolderChoice = "C:/picked/for-new-tabs";
      const from = window.__sent.length;
      requireElement('#setBody [data-setting-action="project-folder-browse"]').click();
      await waitFor(() => sentSince(from, "changeProjectFolder").length === 1, "the picked folder is sent");
      const sent = sentSince(from, "changeProjectFolder")[0];
      const project = window.__latestState.projects.find((item) => item.tabs.some((tab) => tab.id === tabId));
      check("Settings New tabs Browse sends changeProjectFolder for the shown project with the picked folder", sent.projectId === project.id && sent.folder === "C:/picked/for-new-tabs", { sent, projectId: project.id });
    });

    // The Who fixes this round radio: shown for any round pair with two or more fixers, whatever the step is called.
    await part("fixer radio", async () => {
      const marketing = structuredClone(window.__ccSeed); const tab = latestTab(tabId, marketing);
      const coder = tab.crew.find((seat) => seat.slot === "coder"), coderState = tab.processState.seats.find((seat) => seat.slotId === "coder");
      for (const [slot, name] of [["socialMedia", "Social"], ["image", "Pixel"], ["videoAndMotion", "Motion"]]) {
        tab.crew.push({ ...structuredClone(coder), slot, name, seatKey: `${tabId}.${slot}`, status: "idle", runs: [] });
        tab.processState.seats.push({ ...structuredClone(coderState), slotId: slot, seatName: name, status: "idle" });
      }
      tab.steps = [{ id: "qa", label: "QA", type: "rounds", pairs: [{ reviewer: "reviewer1", fixers: ["socialMedia", "image", "videoAndMotion"] }] }];
      tab.derived.stepBar = [{ stepId: "qa", type: "rounds", label: "QA", owners: ["reviewer1"], state: "current" }];
      tab.processState.approval = { state: "approved" }; tab.processState.phase = "fix"; tab.processState.round = 1; tab.processState.selectedFixer = "socialMedia";
      tab.pendingApprovals = []; tab.derived.leaderTurnActive = false;
      window.__ccDeliver({ ...marketing, type: "state" }); await sleep(30);
      const radios = () => [...document.querySelectorAll("#stepActs [data-fixer]")];
      const checkedSlot = () => radios().find((radio) => radio.getAttribute("aria-checked") === "true")?.dataset.fixer;
      const initial = { slots: radios().map((radio) => radio.dataset.fixer), checked: checkedSlot() };
      const from = window.__sent.length;
      requireElement('#stepActs [data-fixer="image"]').click();
      requireElement('#stepActs [data-fixer="videoAndMotion"]').click(); // the first pick is still waiting for the server
      const picks = sentSince(from, "selectFixer");
      tab.processState.selectedFixer = "image"; window.__ccDeliver({ ...marketing, type: "state" }); await sleep(30);
      const afterServer = { checked: checkedSlot(), disabled: radios().some((radio) => radio.disabled) };
      const again = window.__sent.length;
      requireElement('#stepActs [data-fixer="image"]').click();
      const repeat = sentSince(again, "selectFixer").length;
      check("the fixer radios choose who fixes the round: a pick sends selectFixer once, the checked one follows the server, and picking the checked one sends nothing",
        initial.slots.join() === "socialMedia,image,videoAndMotion" && initial.checked === "socialMedia" && picks.length === 1 && picks[0].tabId === tabId && picks[0].slot === "image" && afterServer.checked === "image" && !afterServer.disabled && repeat === 0, { initial, picks, afterServer, repeat });
    });

    // The Details panel's width grip.
    await part("Details grip", async () => {
      if ($("side").hidden) $("sideBtn").click();
      const grip = $("sgrip"); grip.setPointerCapture = () => {}; // synthetic pointer ids cannot be captured
      const right = $("side").getBoundingClientRect().right;
      const width = () => Number(grip.getAttribute("aria-valuenow")), cssWidth = () => $("main").style.getPropertyValue("--sidew");
      const writes = (start) => sentSince(start, "updateClientPref").filter((message) => message.key === "rightPanelWidth").map((message) => message.value);
      const pointer = (type, x) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, clientX: x }));
      const from = window.__sent.length;
      pointer("pointerdown", right - 320); pointer("pointermove", right - 400);
      const dragged = { width: width(), css: cssWidth(), written: writes(from).length };
      pointer("pointermove", right - 100); const tooNarrow = width();
      pointer("pointermove", right - 900); const tooWide = width();
      pointer("pointermove", right - 450); pointer("pointerup", right - 450);
      const released = { width: width(), written: writes(from) };
      const arrows = window.__sent.length;
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      const wider = width();
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      check("the Details width grip drags the panel (clamped 280 to 560), saves the width once on release, and the arrow keys move it by 16",
        dragged.width === 400 && dragged.css === "400px" && dragged.written === 0 && tooNarrow === 280 && tooWide === 560 && released.width === 450 && released.written.join() === "450" && wider === 466 && width() === 450 && writes(arrows).join() === "466,450", { dragged, tooNarrow, tooWide, released, wider, final: width(), arrowWrites: writes(arrows) });
    });

    // Settings > Appearance > Match my PC.
    await part("Match my PC", async () => {
      const realMatchMedia = window.matchMedia; let pcIsLight = true;
      window.matchMedia = (query) => ({ matches: /prefers-color-scheme: light/.test(query) ? pcIsLight : false, media: query, addEventListener() {}, removeEventListener() {} });
      try {
        $("setBtn").click(); requireElement('#setNav [data-settings-section="appearance"]').click();
        const from = window.__sent.length;
        requireElement('#setBody [data-theme="system"]').click();
        const saved = sentSince(from, "updateClientPref").filter((message) => message.key === "theme").map((message) => message.value);
        await waitFor(() => window.__latestState.clientPrefs?.theme === "system", "the server keeps the theme system");
        const lightPc = { light: document.body.classList.contains("light"), radio: requireElement('#setBody [data-theme="system"]').getAttribute("aria-checked"), help: text("#s-appearance .settings-help") };
        pcIsLight = false; deliverSeedWithTheme("system");
        const darkPc = document.body.classList.contains("light");
        pcIsLight = true; deliverSeedWithTheme("system");
        const lightAgain = document.body.classList.contains("light");
        // The PC switches while nothing reaches the page from the server: only the registered media change listener can move the theme.
        const listeners = window.__ccMediaChange ?? [], broadcasts = window.__received.length;
        pcIsLight = false; listeners.forEach((listener) => listener(new Event("change")));
        const darkByListener = document.body.classList.contains("light");
        pcIsLight = true; listeners.forEach((listener) => listener(new Event("change")));
        const lightByListener = document.body.classList.contains("light");
        check("Match my PC follows the PC's light or dark setting, saves theme system, and keeps following it",
          saved.join() === "system" && lightPc.light && lightPc.radio === "true" && /^Following your PC/.test(lightPc.help) && darkPc === false && lightAgain === true, { saved, lightPc, darkPc, lightAgain });
        check("Match my PC: the page's own media change listener moves the theme with no state broadcast",
          listeners.length > 0 && darkByListener === false && lightByListener === true && window.__received.length === broadcasts, { listeners: listeners.length, darkByListener, lightByListener, broadcastsDuring: window.__received.length - broadcasts });
      } finally { window.matchMedia = realMatchMedia; }
      function deliverSeedWithTheme(theme) { window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, theme }, type: "state" }); }
    });

    // A capped saved run: Load the fuller log.
    await part("fuller log", async () => {
      openSeatView("coder");
      requireElement('#stagehead [data-run-view="history"]').click();
      const timestamp = 1780000000777, seatKey = `${tabId}.coder`;
      window.__ccDeliver({ type: "historyList", seatKey, runs: [{ timestamp, sizeBytes: 900000, outcome: { status: "done", exitCode: 0 } }] });
      requireElement(`#view [data-history-timestamp="${timestamp}"]`).click();
      window.__ccDeliver({ type: "historyRun", seatKey, timestamp, output: "tail of the log", brief: null, totalBytes: 900000, outcome: { status: "done", exitCode: 0 }, truncated: true });
      const button = requireElement("#view [data-full-log]");
      const offered = { label: button.textContent.trim(), meta: text("#view .metarow"), log: text("#view .term pre") };
      const from = window.__sent.length;
      button.click(); button.click();
      const asked = sentSince(from, "historyRun");
      const busy = { label: requireElement("#view [data-full-log]").textContent.trim(), disabled: requireElement("#view [data-full-log]").disabled };
      window.__ccDeliver({ type: "historyRun", seatKey, timestamp, output: "the fuller log, still capped", brief: null, totalBytes: 900000, outcome: { status: "done", exitCode: 0 }, truncated: true, full: true });
      const after = { button: Boolean(document.querySelector("#view [data-full-log]")), meta: text("#view .metarow"), log: text("#view .term pre") };
      check("a capped saved run offers Load the fuller log, asks for the full log once, and labels the fuller reply",
        offered.label === "Load the fuller log" && /capped, showing the end of the log/.test(offered.meta) && offered.log === "tail of the log" && asked.length === 1 && asked[0].seatKey === seatKey && asked[0].timestamp === timestamp && asked[0].full === true
        && busy.label === "Reading…" && busy.disabled && !after.button && /fuller log, still capped by the server/.test(after.meta) && after.log === "the fuller log, still capped", { offered, asked, busy, after });
    });

    // The Copy button beside an install command in Settings > AI tools.
    await part("Copy button", async () => {
      const missingGemini = structuredClone(window.__ccSeed);
      missingGemini.settings.tools = { ...missingGemini.settings.tools, gemini: { installed: false, version: null, signedIn: null } };
      window.__ccSeed = missingGemini; deliverSeed();
      $("setBtn").click(); requireElement('#setNav [data-settings-section="tools"]').click();
      const button = requireElement("#setBody [data-copy]"), command = button.dataset.copy;
      const written = []; let refuse = false, copied = true, execCalls = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { if (refuse) throw new Error("clipboard refused"); written.push(value); } } });
      document.execCommand = (name) => { execCalls++; return name === "copy" && copied; };
      try {
        button.click();
        await waitFor(() => $("toast").textContent === "Command copied" && written.length === 1, "the command is copied");
        const ok = { written: [...written], toast: $("toast").textContent };
        refuse = true; copied = true; $("toast").textContent = "";
        requireElement("#setBody [data-copy]").click();
        await waitFor(() => execCalls === 1, "the text-copy fallback runs");
        const fallback = { written: written.length, toast: $("toast").textContent, execCalls, leftover: document.querySelectorAll("body > textarea").length };
        copied = false; $("toast").textContent = "";
        requireElement("#setBody [data-copy]").click();
        await waitFor(() => execCalls === 2, "the fallback runs again");
        const failed = { toast: $("toast").textContent };
        check("the Copy button copies the install command and says so, and falls back to a hidden text copy when the clipboard refuses",
          /^npm install -g /.test(command) && ok.written[0] === command && ok.toast === "Command copied" && fallback.written === 1 && fallback.toast === "Command copied" && fallback.leftover === 0 && /^Could not copy/.test(failed.toast), { command, ok, fallback, failed });
      } finally { delete navigator.clipboard; delete document.execCommand; }
    });
  };
  Object.assign(window.__ccHarness, { runPackThreeC });
})();
