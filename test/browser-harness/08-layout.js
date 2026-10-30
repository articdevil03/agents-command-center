(() => {
  const { collectFailures, collectWaitTimeout, check, waitFor, $, requireElement, showChat, openSeatView, openSeatCard, pressEscape } = window.__ccHarness;
  const runLayout = async () => {
    await waitFor(() => window.__latestState?.type === "state", "layout state");
    pressEscape(); showChat();
    const selectedTab = window.__latestState.projects.flatMap((project) => project.tabs).find((tab) => tab.id === window.__latestState.selectedTabId);
    const leaderSeat = selectedTab.crew.find((seat) => seat.isLeader || seat.slot === "leader");
    const coderSeat = selectedTab.crew.find((seat) => seat.slot === "coder");
    const knownModels = { "gpt-6-luna": "Luna 6", "gpt-6-sol": "Sol 6", "gpt-6-astra": "Astra 6", "deepseek/deepseek-flash": "DeepSeek Flash", "deepseek/deepseek-pro": "DeepSeek Pro", "opencode/mimo-v2.6-flash-free": "MiMo Flash (free)", "opencode/muse-spark-1.3-contributor-free": "Muse Spark (free)", "opencode-go/gpt-5.6-luna": "GPT 5.6 Luna (Go)", "google/gemini-3-pro": "Gemini 3 Pro", "google/gemini-3-flash": "Gemini 3 Flash", "moonshot/kimi-k3": "Kimi K3", "qwen/qwen4-coder": "Qwen 4 Coder", "zai/glm-5": "GLM 5", "xai/grok-5": "Grok 5", "mistral/devstral-3": "Devstral 3", "openrouter/llama-5-405b": "Llama 5 405B" };
    const expectedModel = (seat) => seat.cli === "claude"
      ? (window.__latestState.claudeModels?.find((model) => model.value === seat.model)?.displayName ?? seat.model).replace(/\s*\([^)]*context[^)]*\)$/i, "").trim()
      : knownModels[seat.model] ?? seat.model;
    // Model and effort read where they are now shown: each seat's card.
    const leadCard = openSeatCard("leader");
    const leadParts = [requireElement("[data-seat-model] .model-label", leadCard), requireElement("[data-seat-model] .eff", leadCard)];
    const leadModel = leadParts[0].textContent.trim(), leadEffort = leadParts[1].textContent.trim();
    const leadFit = leadParts.map((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    pressEscape();
    const coderCard = openSeatCard("coder");
    const coderParts = [requireElement("[data-seat-model] .model-label", coderCard), requireElement("[data-seat-model] .eff", coderCard)];
    const coderModel = coderParts[0].textContent.trim(), coderEffort = coderParts[1].textContent.trim();
    const coderFit = coderParts.map((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    pressEscape();
    const modelPartsFit = [...leadFit, ...coderFit].every((part) => part.width > 0 && part.scrollWidth <= part.width);
    check(`B1 model labels and effort fit at ${innerWidth}px`, leadModel === expectedModel(leaderSeat) && leadEffort.includes(leaderSeat.effort) && coderModel === expectedModel(coderSeat) && coderEffort.includes(coderSeat.effort) && modelPartsFit, { leadModel, expectedLead: expectedModel(leaderSeat), leadEffort, expectedLeadEffort: leaderSeat.effort, coderModel, expectedCoder: expectedModel(coderSeat), coderEffort, expectedCoderEffort: coderSeat.effort, modelPartsFit, parts: [...leadFit, ...coderFit] });
    const long = "W".repeat(40), longState = structuredClone(window.__latestState);
    const longEntry = longState.projects.flatMap((project) => project.tabs.map((tab) => ({ project, tab }))).find(({ tab }) => tab.id === longState.selectedTabId);
    longEntry.project.name = long; longEntry.tab.name = long;
    for (const seat of longEntry.tab.crew) seat.name = long;
    window.__ccDeliver({ ...longState, type: "state" });
    const clipped = (element) => Boolean(element && getComputedStyle(element).overflow === "hidden" && getComputedStyle(element).textOverflow === "ellipsis");
    const projectName = document.getElementById("projName"), tabName = document.querySelector('#tabs [role=tab][aria-selected="true"] .tl');
    openSeatView("coder");
    const crewName = document.querySelector('#crew .name');
    const stageName = document.querySelector("#stagehead [data-seat-name]");
    const longLabelsFit = [projectName, tabName, crewName, stageName?.parentElement].every(clipped) && stageName?.title === long && document.documentElement.scrollWidth <= innerWidth;
    check("long server names truncate inside project, tab, crew and stage controls", longLabelsFit, { project: projectName?.textContent, tab: tabName?.textContent, crew: crewName?.textContent, stageTitle: stageName?.title, clipped: [projectName, tabName, crewName, stageName?.parentElement].map((element) => element ? `${element.tagName}.${element.className}:${element.isConnected}:${getComputedStyle(element).overflow}/${getComputedStyle(element).textOverflow}` : "missing"), scrollWidth: document.documentElement.scrollWidth, width: innerWidth });
    showChat();
    const controls = [...document.querySelectorAll("button,[role=button]")].filter((element) => {
      if (element.closest("[hidden],[inert]")) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const unnamedControls = controls.filter((element) => !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.title || element.textContent.trim()));
    check("every visible button has an accessible name", unnamedControls.length === 0, { checked: controls.length, unnamed: unnamedControls.map((element) => element.outerHTML.slice(0, 120)) });
    const stageTargets = ["#stage .shead", "#sline", "#view", "#composer", "#ci", "#sendBtn"];
    $("ci").value = "Layout audit draft"; $("ci").dispatchEvent(new Event("input", { bubbles: true }));
    const missingStageTargets = stageTargets.filter((selector) => !document.querySelector(selector));
    check("every audited stage target was found", missingStageTargets.length === 0, { found: stageTargets.filter((selector) => document.querySelector(selector)), missing: missingStageTargets });
    const stageParts = stageTargets.map((selector) => document.querySelector(selector));
    const stageVisible = stageParts.every((element) => element && !element.hidden && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    const stageInside = stageParts.every((element) => { if (!element) return false; const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; });
    const stageClickable = stageParts.every((element) => { if (!element) return false; const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return Boolean(hit && (element.contains(hit) || hit.contains(element)) && !element.disabled); });
    const stageOverlaps = [];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const a = stageParts[i]?.getBoundingClientRect(), b = stageParts[j]?.getBoundingClientRect(); if (a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) stageOverlaps.push(stageTargets[i] + " / " + stageTargets[j]); }
    check("stage header, steps, transcript and composer fit and remain clickable", stageVisible && stageInside && stageClickable && stageOverlaps.length === 0, { visible: stageVisible, inside: stageInside, clickable: stageClickable, overlaps: stageOverlaps, viewport: { width: innerWidth, height: innerHeight }, children: [...document.querySelector("#stage > .col").children].map((element) => { const rect = element.getBoundingClientRect(); return { id: element.id, className: element.className, hidden: element.hidden, top: rect.top, bottom: rect.bottom, height: rect.height }; }) });
    const top = document.getElementById("top");
    const topChildren = [...top.children].filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; });
    const headerOverlaps = [];
    for (let i = 0; i < topChildren.length; i++) for (let j = i + 1; j < topChildren.length; j++) { const a = topChildren[i].getBoundingClientRect(), b = topChildren[j].getBoundingClientRect(); if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) headerOverlaps.push(String(topChildren[i].id || topChildren[i].className) + " / " + String(topChildren[j].id || topChildren[j].className)); }
    const box = (element) => { const rect = element.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }; };
    const column = document.querySelector("#stage > .col");
    const noHorizontalScroll = () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth;
    // Details starts closed (the mockup's default); the crew rail and the chat column never overlap.
    const closedRects = { rail: box($("rail")), column: box(column), stage: box($("stage")) };
    const closedLayout = $("side").hidden && closedRects.rail.right <= closedRects.column.left + 1 && closedRects.column.right <= closedRects.stage.right + 1 && noHorizontalScroll();
    // Open, it sits beside the chat from 1280px up and floats over the chat's right edge below that, always inside the window.
    $("sideBtn").click();
    const floating = innerWidth < 1280;
    const openRects = { column: box(column), side: box($("side")) };
    const openLayout = !$("side").hidden && openRects.side.width >= 280 && openRects.side.right <= innerWidth && noHorizontalScroll()
      && (floating ? getComputedStyle($("side")).position === "absolute" : openRects.column.right <= openRects.side.left + 1);
    $("sideBtn").click();
    check("layout at " + innerWidth + "px has no horizontal scroll or panel overlap", closedLayout && openLayout && headerOverlaps.length === 0, { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, closedRects, openRects, floating, sidePosition: getComputedStyle($("side")).position, headerOverlaps });
    if (innerWidth === 1100) {
      // Open or closed is the server's client pref detailsOpen (a new window on a new port has no localStorage): only a click on Details sends it, never a resize.
      const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
      const sentFrom = window.__sent.length;
      const sideWrites = () => window.__sent.slice(sentFrom).filter((message) => message.type === "updateClientPref" && message.key === "detailsOpen").map((message) => String(message.value));
      const setWindowWidth = (width) => { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); window.dispatchEvent(new Event("resize")); };
      const sideShown = () => !$("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "true";
      setWindowWidth(1100);
      setWindowWidth(1400);
      const resizeNeverWrites = sideWrites().length === 0 && !sideShown();
      $("sideBtn").click();
      const userOpenPersists = sideShown() && sideWrites().join() === "true";
      setWindowWidth(1100);
      const narrowKeepsChoice = sideShown() && sideWrites().length === 1;
      setWindowWidth(1400);
      const wideKeepsChoice = sideShown() && sideWrites().length === 1;
      $("sideBtn").click();
      const userClosePersists = !sideShown() && sideWrites().join() === "true,false";
      if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor); else delete window.innerWidth;
      window.dispatchEvent(new Event("resize"));
      check("Details open or closed is saved only by the user and survives resizing", resizeNeverWrites && userOpenPersists && narrowKeepsChoice && wideKeepsChoice && userClosePersists && Boolean(widthDescriptor?.configurable), { resizeNeverWrites, userOpenPersists, narrowKeepsChoice, wideKeepsChoice, userClosePersists, sideWrites: sideWrites(), widthDescriptorConfigurable: widthDescriptor?.configurable ?? false });
    }
    // A new window (new port, empty localStorage) gets its layout from the server's prefs: a state that says the rail is closed and Details open shows exactly that.
    if (window.__ccSeed) {
      const prefsBefore = structuredClone(window.__ccSeed.clientPrefs ?? {});
      window.__ccSeed.clientPrefs = { ...prefsBefore, crewRailOpen: false, detailsOpen: true };
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      const shownLayout = () => ({ wide: $("stage").classList.contains("wide"), railExpanded: $("railBtn").getAttribute("aria-expanded"), sideHidden: $("side").hidden, sidePressed: $("sideBtn").getAttribute("aria-pressed") });
      const fromServerShown = shownLayout();
      const fromServer = !fromServerShown.wide && fromServerShown.railExpanded === "false" && !fromServerShown.sideHidden && fromServerShown.sidePressed === "true";
      window.__ccSeed.clientPrefs = { ...prefsBefore, crewRailOpen: true, detailsOpen: false };
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      const backFromServer = $("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "true" && $("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "false";
      window.__ccSeed.clientPrefs = prefsBefore;
      window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
      check("the crew rail and Details open or closed come from the server's client prefs, not localStorage", fromServer && backFromServer, { fromServer, backFromServer, fromServerShown, prefs: window.__latestState.clientPrefs, errors: window.__ccErrors.slice(-3) });
    }
    // The crew rail collapses to the mockup's 60px face strip and back to 224px; Details toggles open and shut.
    const railWidth = () => Math.round($("rail").getBoundingClientRect().width);
    $("railBtn").click();
    try { await waitFor(() => railWidth() === 60, "collapsed crew rail", collectWaitTimeout); } catch (error) { if (!collectFailures) throw error; }
    const railCollapsed = !$("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "false" && $("railBtn").getAttribute("aria-label") === "Show crew details", railStrip = railWidth();
    $("railBtn").click();
    try { await waitFor(() => railWidth() === 224, "expanded crew rail", collectWaitTimeout); } catch (error) { if (!collectFailures) throw error; }
    const railExpanded = $("stage").classList.contains("wide") && $("railBtn").getAttribute("aria-expanded") === "true" && $("railBtn").getAttribute("aria-label") === "Hide crew details" && railWidth() === 224;
    $("sideBtn").click(); const sideOpened = !$("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "true";
    $("sideBtn").click(); const sideClosed = $("side").hidden && $("sideBtn").getAttribute("aria-pressed") === "false";
    check("both panels collapse to the mockup strips and expand accessibly", railCollapsed && railStrip === 60 && railExpanded && sideOpened && sideClosed, { railCollapsed, railStrip, railExpanded, sideOpened, sideClosed });
    const railWrites = window.__sent.filter((message) => message.type === "updateClientPref" && message.key === "crewRailOpen").map((message) => message.value);
    check("the rail's open or closed choice is sent to the server as the crewRailOpen pref", railWrites.slice(-2).join() === "false,true", { railWrites });
  };
  Object.assign(window.__ccHarness, { runLayout });
})();
