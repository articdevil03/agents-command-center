(() => {
  const { check, waitFor, text, $, requireElement, pressEscape } = window.__ccHarness;
  // Notification policy, sound popover, bell, rendered bell, volume slider, Test, volume follow.
  const b2NotificationsAndBell = async (ctx) => {
    const { tabOf } = ctx;
    window.__notified = []; window.__tones = 0; window.__ccFocused = true;
    Object.defineProperty(Document.prototype, "hasFocus", { configurable: true, value: () => window.__ccFocused });
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: class {
      static permission = "granted";
      static requestPermission() { return Promise.resolve("granted"); }
      constructor(title, options) { window.__notified.push({ title, body: options?.body ?? "" }); }
    } });
    // Recording wrapper at the far boundary: every node is a REAL OfflineAudioContext node (so the bell can be rendered and measured), with the contexts built, tones started, each tone's peak gain and length, and resume() calls recorded on top.
    window.__contexts = 0; window.__resumes = 0; window.__toneLog = []; window.__ctxs = []; window.__gains = []; window.__limiters = [];
    class AuditAudioContext {
      constructor() { window.__contexts++; window.__ctxs.push(this); this.currentTime = 0; this.state = "running"; this.fresh(); }
      fresh() { this.off = new OfflineAudioContext(1, 44100 * 3, 44100); this.destination = this.off.destination; }
      resume() { window.__resumes++; this.state = "running"; return Promise.resolve(); }
      createOscillator() {
        const osc = this.off.createOscillator(); const tone = { peak: 0, start: 0, stop: 0, freq: 0 }; window.__toneLog.push(tone);
        const connect = osc.connect.bind(osc); const start = osc.start.bind(osc); const stop = osc.stop.bind(osc);
        osc.connect = (target) => { target.tone = tone; tone.peak = Math.max(tone.peak, target.max); return connect(target); };
        osc.start = (at) => { window.__tones++; tone.start = at ?? 0; tone.freq = osc.frequency.value; return start(at); };
        osc.stop = (at) => { tone.stop = at ?? 0; return stop(at); };
        return osc;
      }
      createGain() {
        const node = this.off.createGain(); Object.assign(node, { tone: null, max: 0, targets: [] }); window.__gains.push(node);
        const connect = node.connect.bind(node); node.connect = (target) => { node.targets.push(target); return connect(target); };
        for (const method of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime"]) {
          const original = node.gain[method].bind(node.gain);
          node.gain[method] = (value, at) => { node.max = Math.max(node.max, value); if (node.tone) node.tone.peak = Math.max(node.tone.peak, value); return original(value, at); };
        }
        return node;
      }
      createDynamicsCompressor() {
        const node = this.off.createDynamicsCompressor(); Object.assign(node, { targets: [], isLimiter: true }); window.__limiters.push(node);
        const connect = node.connect.bind(node); node.connect = (target) => { node.targets.push(target); return connect(target); };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    window.AudioContext = AuditAudioContext;
    const notifyState = structuredClone(window.__ccSeed); const notifyTab = tabOf("alpha-dev", notifyState);
    notifyTab.processState.approval = { state: "none" };
    window.__ccDeliver({ ...notifyState, type: "state" });
    const notifyWorker = notifyTab.crew.find((seat) => seat.slot === "coder");
    const notifySeatKey = notifyWorker.seatKey ?? "alpha-dev.coder";
    const beforeRoutine = window.__notified.length;
    window.__ccDeliver({ type: "leaderLaunch", source: "Routine activity", seatName: "Coder", pending: false });
    const routineSilent = window.__notified.length === beforeRoutine;
    const beforeStart = { notified: window.__notified.length, tones: window.__tones };
    window.__ccDeliver({ type: "runStart", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-start", model: notifyWorker.model });
    // Settings and the sound popover promise a bell only when a seat finishes, fails or needs you: starting a worker is none of those.
    const launchSilent = window.__notified.length === beforeStart.notified && window.__tones === beforeStart.tones;
    window.__ccDeliver({ type: "runFinish", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-finish" });
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-fail", message: "Run failed" });
    window.__ccDeliver({ type: "runStalled", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-stall" });
    const workerNotifications = window.__notified.length;
    const workerTones = window.__tones;
    // The server marks a stop it made itself (a stalled run it restarts) internal: true, and a stop the user asked for internal: false. Neither rings or notifies: the page has no stop signal at all, so both are sent.
    window.__ccDeliver({ type: "runStop", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-internal-stop", outcome: "stopped", internal: true });
    const internalStopSilent = window.__notified.length === workerNotifications && window.__tones === workerTones;
    window.__ccDeliver({ type: "runStop", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "notice-user-stop", outcome: "stopped", internal: false });
    const userStopSilent = window.__notified.length === workerNotifications && window.__tones === workerTones;
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 10, savedRevision: 8 });
    const focusedLeaderSilent = window.__notified.length === workerNotifications;
    window.__ccFocused = false;
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 10, savedRevision: 8 });
    const blurredLeaderNotified = window.__notified.length === workerNotifications + 1;
    const pendingState = structuredClone(window.__latestState); tabOf("alpha-dev", pendingState).processState.approval = { state: "pending" };
    window.__ccDeliver({ ...pendingState, type: "state" });
    const needsUserNotified = window.__notified.length === workerNotifications + 2;
    const repeatedPending = structuredClone(window.__latestState);
    window.__ccDeliver({ ...repeatedPending, type: "state" });
    const noRepeatedApproval = window.__notified.length === workerNotifications + 2;
    const enabledPolicy = routineSilent && launchSilent && workerNotifications === 3 && workerTones === 24 && internalStopSilent && userStopSilent && focusedLeaderSilent && blurredLeaderNotified && needsUserNotified && noRepeatedApproval;
    check("notification policy covers worker finish, failure, stall (never launch), focus, approval, routine noise, and both kinds of stop (the server's own internal stop and the user's)", enabledPolicy, { routineSilent, launchSilent, workerNotifications, workerTones, internalStopSilent, userStopSilent, focusedLeaderSilent, blurredLeaderNotified, needsUserNotified, noRepeatedApproval, notifications: window.__notified, tones: window.__tones });

    const noPending = structuredClone(window.__latestState); tabOf("alpha-dev", noPending).processState.approval = { state: "none" };
    window.__ccDeliver({ ...noPending, type: "state" });
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click();
    requireElement('#setBody [data-setting="notificationsEnabled"]').click();
    const noNotifications = window.__notified.length; const noSound = window.__tones;
    window.__ccDeliver({ type: "runStart", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "off-start" });
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "off-fail" });
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 11, savedRevision: 8 });
    const offPending = structuredClone(window.__latestState); tabOf("alpha-dev", offPending).processState.approval = { state: "pending" };
    window.__ccDeliver({ ...offPending, type: "state" });
    // The completion sound is its own switch now: with Notifications off, no desktop notice shows, but the chime still plays on the same events (a failed run, a finished reply, a look to approve) while the sound is on; a worker start is none of them.
    const soundSwitch = () => requireElement('#setBody [data-setting="bellEnabled"]');
    const offTones = window.__tones - noSound;
    const disabledPolicy = window.__notified.length === noNotifications && offTones === 24 && window.__latestState.clientPrefs.notificationsEnabled === false && window.__latestState.clientPrefs.bellEnabled === true
      && $("soundBtn").dataset.muted === "false" && soundSwitch().getAttribute("aria-checked") === "true" && !soundSwitch().disabled;
    check("disabling notifications blocks every desktop notice while the sound button keeps the chime on the same events", disabledPolicy, { disabledPolicy, notificationsBefore: noNotifications, notificationsAfter: window.__notified.length, offTones, soundMuted: $("soundBtn").dataset.muted, soundSwitch: soundSwitch().getAttribute("aria-checked"), soundSwitchDisabled: soundSwitch().disabled, serverPrefs: window.__latestState.clientPrefs });
    // The top-bar speaker opens the sound popover under it (Settings closes: the speaker is outside that dialog). Focus goes to its first
    // control; Escape, a press outside and a second click on the speaker close it, and focus comes back to the speaker.
    const soundPop = $("soundPop");
    const soundPopOpen = () => !soundPop.hidden && soundPop.getAttribute("aria-hidden") === "false" && soundPop.classList.contains("on") && $("soundBtn").getAttribute("aria-expanded") === "true";
    const soundPopClosed = () => soundPop.hidden && soundPop.getAttribute("aria-hidden") === "true" && $("soundBtn").getAttribute("aria-expanded") === "false";
    const openSoundPop = () => { if (soundPop.hidden) $("soundBtn").click(); return requireElement('#soundPop[aria-hidden="false"]'); };
    const flipSound = () => { openSoundPop(); $("soundSwitch").click(); pressEscape(); };
    const press = (element) => { element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); };
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const settingsOpenBefore = !$("setModal").hidden;
    $("soundBtn").click();
    const opened = { open: soundPopOpen(), settingsClosed: $("setModal").hidden, focus: document.activeElement?.id, pop: box(soundPop), speaker: box($("soundBtn")) };
    pressEscape();
    const escaped = { closed: soundPopClosed(), focus: document.activeElement?.id };
    $("soundBtn").click(); const reopened = soundPopOpen();
    press($("soundSwitch")); press($("soundVol"));
    const insideKeepsOpen = soundPopOpen();
    $("soundBtn").click(); const toggledShut = soundPopClosed();
    $("soundBtn").click(); press(requireElement("#view"));
    const outsideClosed = soundPopClosed();
    const placed = opened.pop.top >= opened.speaker.bottom && opened.pop.top - opened.speaker.bottom <= 12 && opened.pop.left >= 0 && opened.pop.right <= innerWidth && opened.pop.bottom <= innerHeight && opened.pop.right >= opened.speaker.left && opened.pop.left <= opened.speaker.right;
    check("clicking the speaker opens the sound popover under it; Escape, a click outside and a second click close it", settingsOpenBefore && opened.open && opened.settingsClosed && opened.focus === "soundSwitch" && placed && escaped.closed && escaped.focus === "soundBtn" && reopened && insideKeepsOpen && toggledShut && outsideClosed, { settingsOpenBefore, opened, placed, escaped, reopened, insideKeepsOpen, toggledShut, outsideClosed });
    // The popover's switch is the sound switch: off silences every event, on plays a sample at the saved volume, and Settings shows the same value both ways.
    const soundIcons = () => [...document.querySelectorAll("#soundBtn svg")].filter((icon) => getComputedStyle(icon).display !== "none").map((icon) => icon.getAttribute("class"));
    // What Settings shows is read by opening it, as a person would (it draws from the pref when it opens).
    const settingsShows = () => { $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click(); const value = soundSwitch().getAttribute("aria-checked"); pressEscape(); return value; };
    const soundState = () => ({ muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), label: $("soundBtn").getAttribute("aria-label"), title: $("soundBtn").title, settings: settingsShows(), server: window.__latestState.clientPrefs.bellEnabled, icons: soundIcons() });
    const muteStart = window.__sent.length;
    flipSound();
    const muteRequest = window.__sent.slice(muteStart).find((message) => message.type === "updateClientPref" && message.key === "bellEnabled");
    const muted = soundState(); const mutedTones = window.__tones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "muted-fail" });
    window.__ccDeliver({ type: "chatDone", tabId: "alpha-dev", revision: 12, savedRevision: 8 });
    const mutedSilent = window.__tones === mutedTones;
    const unmuteStart = window.__sent.length;
    flipSound();
    const unmuteRequest = window.__sent.slice(unmuteStart).find((message) => message.type === "updateClientPref" && message.key === "bellEnabled");
    const unmuted = soundState(); const sampleTones = window.__tones - mutedTones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "unmuted-fail" });
    const unmutedRings = window.__tones - mutedTones === 16 && window.__notified.length === noNotifications;
    // Settings to the popover: the sound switched off in Settings shows off in the popover and on the speaker.
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click(); soundSwitch().click(); pressEscape();
    openSoundPop();
    const fromSettings = { popSwitch: $("soundSwitch").getAttribute("aria-checked"), muted: $("soundBtn").dataset.muted, server: window.__latestState.clientPrefs.bellEnabled };
    pressEscape();
    const soundSwitchWorks = muteRequest?.value === false && muted.muted === "true" && muted.popSwitch === "false" && muted.settings === "false" && muted.server === false && muted.title === "Completion sound: off" && mutedSilent && muted.icons.join() === "snd-off" && muted.label === "Completion sound" && unmuted.label === "Completion sound"
      && unmuteRequest?.value === true && unmuted.muted === "false" && unmuted.popSwitch === "true" && unmuted.settings === "true" && unmuted.server === true && unmuted.title === "Completion sound: on, 100%" && unmuted.icons.join() === "snd-on" && sampleTones === 8 && unmutedRings
      && fromSettings.popSwitch === "false" && fromSettings.muted === "true" && fromSettings.server === false;
    check("the sound popover's switch turns the completion chime off and on, in sync with Settings both ways", soundSwitchWorks, { muteRequest, muted, mutedSilent, unmuteRequest, unmuted, sampleTones, unmutedRings, fromSettings });
    // While the server's answer is still on its way the popover, the speaker and the Settings switch already agree, whichever was used.
    window.__ccHoldPrefEcho = true;
    const heldStart = window.__sent.length;
    openSoundPop(); $("soundSwitch").click();
    const heldPop = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked") };
    pressEscape();
    $("setBtn").click(); requireElement('#setNav [data-settings-section="behaviour"]').click();
    const heldSettingsOpened = soundSwitch().getAttribute("aria-checked");
    soundSwitch().click();
    const heldSettings = { settings: soundSwitch().getAttribute("aria-checked"), popSwitch: $("soundSwitch").getAttribute("aria-checked"), muted: $("soundBtn").dataset.muted };
    pressEscape();
    const heldSent = window.__sent.slice(heldStart).filter((message) => message.type === "updateClientPref" && message.key === "bellEnabled").map((message) => message.value);
    window.__ccHoldPrefEcho = false;
    window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
    const heldDone = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), settings: soundSwitch().getAttribute("aria-checked"), server: window.__latestState.clientPrefs.bellEnabled };
    // Another window changing the sound reaches the speaker and the popover through the server's state alone.
    window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, bellEnabled: true }, type: "state" });
    const fromState = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked"), settings: soundSwitch().getAttribute("aria-checked") };
    window.__ccDeliver({ ...structuredClone(window.__latestState), clientPrefs: { ...window.__latestState.clientPrefs, bellEnabled: false }, type: "state" });
    const backFromState = { muted: $("soundBtn").dataset.muted, popSwitch: $("soundSwitch").getAttribute("aria-checked") };
    check("the sound popover and the Settings switch agree before the server answers, from either one", heldPop.muted === "false" && heldPop.popSwitch === "true" && heldSettingsOpened === "true" && heldSettings.settings === "false" && heldSettings.popSwitch === "false" && heldSettings.muted === "true" && heldSent.join() === "true,false"
      && heldDone.muted === "true" && heldDone.popSwitch === "false" && heldDone.settings === "false" && heldDone.server === false && fromState.muted === "false" && fromState.popSwitch === "true" && fromState.settings === "true" && backFromState.muted === "true" && backFromState.popSwitch === "false",
      { heldPop, heldSettingsOpened, heldSettings, heldSent, heldDone, fromState, backFromState });
    // The beep must be audible: one shared audio context, a loud and long enough tone, resume() when the browser suspended it, silence when off.
    const beepStart = window.__toneLog.length; const beepTones = window.__tones; const gainsStart = window.__gains.length; const limitersStart = window.__limiters.length;
    flipSound(); // call site 1: turning the sound on plays the sample
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail" }); // call site 2: one notify() event
    const beeps = window.__toneLog.slice(beepStart);
    const resumesBefore = window.__resumes; window.__ctxs[0].state = "suspended";
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail-suspended" });
    await waitFor(() => window.__toneLog.length === beepStart + 24, "bell after resume");
    const resumedBell = window.__toneLog.slice(-8);
    flipSound(); // back off
    const offBeepTones = window.__tones;
    window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId: "beep-fail-off" });
    // A bell is 2 strikes of 4 partials; per play: several distinct pitches, a ring of at least 1.2 s from the first strike's start, and master gain x summed first-strike partial levels >= 1.1 (the old sine blip was 0.2). The measured loudness is checked on the rendered audio below.
    const plays = [beeps.slice(0, 8), beeps.slice(8, 16), resumedBell];
    const masters = window.__gains.slice(gainsStart).filter((node) => node.targets.some((target) => target.isLimiter));
    const bellLimiters = window.__limiters.slice(limitersStart);
    const reachesDestination = (node, seen = new Set()) => !seen.has(node) && (seen.add(node), (node.targets ?? []).some((target) => target === window.__ctxs[0].destination || reachesDestination(target, seen)));
    const bellOk = plays.every((play, index) => {
      const master = masters[index];
      return play.length === 8 && new Set(play.map((tone) => tone.freq)).size >= 4 && Math.max(...play.map((tone) => tone.stop)) - play[0].start >= 1.2
        && master && master.gain.value * play.slice(0, 4).reduce((sum, tone) => sum + tone.peak, 0) >= 1.1;
    }) && masters.length === 3 && bellLimiters.length === 3 && bellLimiters.every((node) => reachesDestination(node));
    const beepOk = window.__tones - beepTones === 24 && beeps.length === 16 && window.__contexts === 1 && bellOk
      && window.__resumes - resumesBefore === 1 && window.__tones === offBeepTones;
    check("the completion bell reuses one audio context, rings several partials for over a second through a limiter at full level, resumes a suspended context, and is silent when off", beepOk, { contexts: window.__contexts, plays, masterLevels: masters.map((node) => node.gain.value), limiters: bellLimiters.length, resumes: window.__resumes - resumesBefore, tonesAfterOff: window.__tones - offBeepTones, tonesPlayed: window.__tones - beepTones });
    // Measured, not read: the real playCompletionSound renders offline through the real nodes, and the audio itself is measured (the planner's numbers: peak -1..-0.1 dBFS, RMS of the first 0.5 s >= -9 dBFS, two onsets 0.35-0.6 s apart each rising >= 9 dB, several spectral peaks with a bright one).
    const renderCtx = window.__ctxs[0]; renderCtx.fresh();
    flipSound(); // turning the sound on plays the sample into the fresh offline graph
    // Awaited through the network barrier (waitFor), never bare: the seed's working runs keep a 1 s ticker going, and a bare await lets headless
    // Chrome's virtual clock run through those ticks to its whole budget, which ends the audit early with no error.
    let renderedBuffer = null;
    renderCtx.off.startRendering().then((buffer) => { renderedBuffer = buffer; });
    await waitFor(() => renderedBuffer, "the offline render of the bell");
    const samples = renderedBuffer.getChannelData(0);
    flipSound(); // back off
    const rate = 44100; const toDb = (value) => 20 * Math.log10(Math.max(value, 1e-6));
    const rmsOf = (from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += samples[i] * samples[i]; return Math.sqrt(sum / (to - from)); };
    let peakValue = 0; for (const value of samples) peakValue = Math.max(peakValue, Math.abs(value));
    const envelope = []; for (let i = 0; i + 441 <= samples.length; i += 441) envelope.push(toDb(rmsOf(i, i + 441)));
    const onsets = [];
    for (let i = 2; i < envelope.length; i++) {
      const rise = envelope[i] - envelope[i - 2];
      if (envelope[i] > -40 && rise >= 9) { if (!onsets.length || i - onsets.at(-1).window > 6) onsets.push({ window: i, at: i * 0.01, rise }); else onsets.at(-1).rise = Math.max(onsets.at(-1).rise, rise); }
    }
    const from = Math.round(0.01 * rate); const length = Math.round(0.19 * rate);
    const magnitudes = []; // Hann-windowed Goertzel scan of the first strike, 500 Hz to 8 kHz in 25 Hz steps
    for (let freq = 500; freq <= 8000; freq += 25) {
      const coefficient = 2 * Math.cos(2 * Math.PI * freq / rate); let s1 = 0; let s2 = 0;
      for (let i = 0; i < length; i++) { const s0 = samples[from + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1))) + coefficient * s1 - s2; s2 = s1; s1 = s0; }
      magnitudes.push({ freq, level: Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2) });
    }
    const topLevel = Math.max(...magnitudes.map((entry) => entry.level));
    const spectralPeaks = magnitudes.filter((entry, i) => i > 0 && i < magnitudes.length - 1 && entry.level > magnitudes[i - 1].level && entry.level > magnitudes[i + 1].level && entry.level >= topLevel * 0.0178).map((entry) => ({ freq: entry.freq, db: toDb(entry.level / topLevel) }));
    const strongest = magnitudes.find((entry) => entry.level === topLevel).freq;
    const rendered = { peakDb: toDb(peakValue), rms500Db: toDb(rmsOf(0, rate / 2)), onsets, spectralPeaks, strongest };
    const renderedOk = rendered.peakDb >= -1 && rendered.peakDb <= -0.1 && rendered.rms500Db >= -9
      && onsets.length === 2 && onsets[1].at - onsets[0].at >= 0.35 && onsets[1].at - onsets[0].at <= 0.6 && onsets[1].rise >= 9
      && spectralPeaks.length >= 3 && strongest >= 1500 && strongest <= 2500 && spectralPeaks.some((entry) => entry.freq >= 3000);
    check("the rendered completion bell is loud (peak just under full scale, strong first half second), rings clearly twice with a fresh attack, and is a bell, not a single sine", renderedOk, rendered);
    // The volume slider (the sound is off here): the percent follows the thumb while it is dragged, a state redraw never pulls it back,
    // and the pref is sent once, when it is let go.
    renderCtx.fresh(); // a live graph again: the rendered one is finished
    const slider = $("soundVol");
    const volumeSent = (start) => window.__sent.slice(start).filter((message) => message.type === "updateClientPref" && message.key === "bellVolume").map((message) => message.value);
    const slide = (value, event = "input") => { slider.value = String(value); slider.dispatchEvent(new Event(event, { bubbles: true })); };
    openSoundPop();
    const slideStart = window.__sent.length;
    const atOpen = { value: slider.value, shown: text("#soundVolOut"), min: slider.min, max: slider.max, step: slider.step, label: slider.labels?.[0]?.textContent?.trim(), server: window.__latestState.clientPrefs.bellVolume };
    for (const value of [90, 70, 50, 30]) slide(value);
    const dragging = { shown: text("#soundVolOut"), fill: slider.style.getPropertyValue("--v"), sent: volumeSent(slideStart).length };
    window.__ccDeliver({ ...structuredClone(window.__latestState), type: "state" }); // a state redraw arrives mid-drag
    const afterRedraw = { value: slider.value, shown: text("#soundVolOut") };
    slider.dispatchEvent(new Event("change", { bubbles: true })); // let go
    const letGo = { sent: volumeSent(slideStart), server: window.__latestState.clientPrefs.bellVolume, value: slider.value, shown: text("#soundVolOut") };
    check("the volume slider shows its percent while dragged, keeps it through a state redraw, and sends the pref once when let go",
      atOpen.value === "100" && atOpen.shown === "100%" && atOpen.server === 100 && atOpen.min === "0" && atOpen.max === "100" && atOpen.step === "1" && atOpen.label === "Volume"
      && dragging.shown === "30%" && dragging.fill === "0.3" && dragging.sent === 0 && afterRedraw.value === "30" && afterRedraw.shown === "30%"
      && letGo.sent.join() === "30" && letGo.server === 30 && letGo.value === "30" && letGo.shown === "30%", { atOpen, dragging, afterRedraw, letGo });
    // Test plays one bell now at the slider's level, even before it is let go and while the sound is off, and saves nothing. The full level is measured
    // the same way (a Test at 100) rather than written down here. Gains are 32-bit floats, so ratios are compared to within 1e-6.
    const masterLevels = (start) => window.__gains.slice(start).filter((node) => node.targets.some((target) => target.isLimiter)).map((node) => node.gain.value);
    const testAt = (value) => { const gains = window.__gains.length, tones = window.__tones, sent = window.__sent.length; slide(value); $("soundTest").click(); return { tones: window.__tones - tones, masters: masterLevels(gains), sent: window.__sent.slice(sent).filter((message) => message.type === "updateClientPref") }; };
    const full = testAt(100);
    pressEscape(); openSoundPop();
    const reopenedAt = { value: slider.value, shown: text("#soundVolOut") }; // the 100 never let go of is dropped
    const tested = testAt(60);
    pressEscape();
    const testRatio = tested.masters[0] / full.masters[0];
    check("Test plays one bell at the slider's level, before it is let go and while the sound is off, and saves nothing",
      full.tones === 8 && full.masters.length === 1 && reopenedAt.value === "30" && reopenedAt.shown === "30%" && tested.tones === 8 && tested.masters.length === 1 && Math.abs(testRatio - 0.6) < 1e-6
      && full.sent.length === 0 && tested.sent.length === 0 && window.__latestState.clientPrefs.bellEnabled === false && window.__latestState.clientPrefs.bellVolume === 30,
      { full, reopenedAt, tested, testRatio, prefs: window.__latestState.clientPrefs });
    // Every bell follows the saved volume: a notify bell at 30% has 0.3 of the full master level, at 100% all of it, and 0% plays nothing.
    const notifyAt = (runId) => { const gains = window.__gains.length, tones = window.__tones; window.__ccDeliver({ type: "runFail", tabId: "alpha-dev", seatKey: notifySeatKey, runId }); return { tones: window.__tones - tones, masters: masterLevels(gains) }; };
    flipSound(); // on, at the saved 30%
    const at30 = notifyAt("volume-30");
    openSoundPop(); slide(100); slide(100, "change"); pressEscape();
    const at100 = notifyAt("volume-100");
    openSoundPop(); slide(0); slide(0, "change");
    const zeroLook = { muted: $("soundBtn").dataset.muted, title: $("soundBtn").title, icons: soundIcons(), server: window.__latestState.clientPrefs.bellVolume };
    const zeroTest = testAt(0);
    pressEscape();
    const at0 = notifyAt("volume-0");
    openSoundPop(); slide(100); slide(100, "change"); pressEscape(); flipSound(); // back to the full level, sound off
    const notifyRatio = at30.masters[0] / at100.masters[0];
    check("every bell follows the saved volume: 30% is 0.3 of the full master level, 0% plays nothing, and the speaker shows muted at 0%",
      at30.tones === 8 && at100.tones === 8 && Math.abs(notifyRatio - 0.3) < 1e-6 && Math.abs(at100.masters[0] / full.masters[0] - 1) < 1e-6
      && zeroLook.muted === "true" && zeroLook.title === "Completion sound: on, 0%" && zeroLook.icons.join() === "snd-off" && zeroLook.server === 0 && zeroTest.tones === 0 && at0.tones === 0
      && window.__latestState.clientPrefs.bellVolume === 100 && window.__latestState.clientPrefs.bellEnabled === false && $("soundBtn").dataset.muted === "true",
      { at30, at100, notifyRatio, zeroLook, zeroTest, at0, prefs: window.__latestState.clientPrefs });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  };
  Object.assign(window.__ccHarness, { b2NotificationsAndBell });
})();
