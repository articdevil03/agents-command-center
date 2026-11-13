// The current tab status and save line, loaded after the crew rail.
  "use strict";
  // ---------- status line and save ----------
  function workerPhrases(tab) {
    return tab.crew.filter((seat) => !seat.isLeader && seat.status === "working").map((seat) => {
      const live = liveRuns(tab, seat).length, task = mdPlain(seat.task);
      if (live > 1) return `${seat.name} is working on ${live} runs`;
      if (/ · round \d+$/.test(task)) return `${seat.name} is ${task.replace(" · ", " ").toLowerCase()}`;
      if (task === "Waiting to review") return `${seat.name} is waiting to review`;
      return `${seat.name} is working on ${task || "a task"}`;
    });
  }
  function unseenFailedRuns(tab) {
    const generation = tab.processState?.crewGenerationId;
    return (tab.runs ?? []).filter((run) => run.status === "failed" && !run.seatIsLeader && run.crewGenerationId === generation && !dismissedRuns.has(run.runId));
  }
  function tabUncertain(tab) { return uncertainRows().filter((row) => tabIdOfKey(row.seatKey ?? row.seatId) === tab.id); }
  function statusOf(tab) {
    const lead = leader(tab), phrases = workerPhrases(tab);
    const meanwhile = phrases.length ? `Meanwhile ${joinNames(phrases)}` : "";
    if (connState === "off") return { tone: "off", text: "Not connected", sub: "Reconnecting. What you change now is not sent" };
    const also = tab.pendingApprovals?.length ? "Also waiting on your answer" : meanwhile;
    const uncertain = tabUncertain(tab);
    if (uncertain.length) return { tone: "bad", text: `${seatNameOfKey(uncertain[0].seatKey ?? uncertain[0].seatId)} may still be running: the stop was not confirmed`, sub: "Needs you has Try again and Release" };
    const failed = unseenFailedRuns(tab)[0];
    if (failed) return { tone: "bad", text: `${failed.seatName}'s run failed: ${mdPlain(failed.label)}`, sub: also };
    const stalled = (tab.runs ?? []).find((run) => run.status === "working" && run.stalled);
    if (stalled) return { tone: "bad", text: `${stalled.seatName}'s run stalled: ${mdPlain(stalled.label)}`, sub: `No output for ${STALL_MINUTES} minutes` };
    const approvals = [...(tab.pendingApprovals ?? [])].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    if (approvals.length) return { tone: "wait", text: `Waiting on you: ${approvalTitle(approvals[0].tool, tab, approvals[0].askedBy)}`, sub: approvals.length > 1 ? `and ${approvals.length - 1} more` : meanwhile };
    const save = saveStates.get(tab.id);
    if (save?.status === "failed") return { tone: "bad", text: "Save failed", sub: save.message };
    if (save?.status === "unknown") return { tone: save.checking ? "work" : "bad", text: "Save not confirmed yet", sub: save.message };
    const closing = (tab.runs ?? []).filter((run) => run.status === "working" && runStopState(tab, run));
    if (closing.length) { const names = joinNames([...new Set(closing.map((run) => run.seatName))]); return closing.every((run) => runStopState(tab, run) === "requested") ? { tone: "work", text: `Stop requested for ${names}`, sub: "Nothing changes until the server accepts it" } : { tone: "work", text: `Stopping ${names}…`, sub: "Accepted. Waiting for the process to close" }; }
    const requests = (serverState?.requests ?? []).filter((request) => request.status === "pending" && request.toTabId === tab.id);
    if (requests.length) return { tone: "wait", text: `Waiting on you: a request from ${tabLabel(requests[0].fromTabId) || "another tab"}`, sub: meanwhile };
    if (savePending.has(tab.id)) return { tone: "work", text: "Saving the handover…", sub: meanwhile };
    if (tab.derived?.leaderTurnActive) return { tone: "work", text: `${lead?.name ?? "The leader"} is replying`, sub: meanwhile };
    if (phrases.length) return { tone: "work", text: cap(phrases[0]), sub: phrases.length > 1 ? `Also ${joinNames(phrases.slice(1))}` : "" };
    const fixed = tab.fixedCrew ? fixedCrewUi?.taskStatus(tab) : null;
    if (fixed) return fixed;
    // No Leader assignment and nothing more urgent above: say so, never "Ready" (the chat below says the same thing).
    if (tab.fixedCrew && !tab.fixedCrew.unavailable && !tab.fixedCrew.preferences?.leader?.assignment) return { tone: "wait", text: "Leader has no model", sub: "Choose a model for the Leader in Settings" };
    const stopped = tab.crew.filter((seat) => seat.status === "stopped");
    if (stopped.length) return { tone: "idle", text: `Stopped by you: ${joinNames(stopped.map((seat) => seat.name))}`, sub: (serverState?.launchSafety?.blocked ?? []).some((key) => tabIdOfKey(typeof key === "string" ? key : key?.seatKey ?? key?.seatId) === tab.id) ? "Blocked seats need Allow again before they launch" : "" };
    const jobs = jobsOf(tab).length;
    return { tone: "idle", text: "Ready", sub: jobs ? `${lead?.name ?? "The leader"} is free, ${jobs} background job${jobs === 1 ? "" : "s"} running` : `${lead?.name ?? "The leader"} is ready when you are` };
  }
  function renderStatusLine(tab) {
    const button = $("statusBtn");
    if (!tab) { button.innerHTML = ""; return; }
    const status = statusOf(tab);
    button.innerHTML = `<span class="pill ${esc(status.tone)}" data-tone="${esc(status.tone)}"><i></i><span class="pt">${esc(status.text)}</span></span>${status.sub ? `<span class="sub">${esc(status.sub)}</span>` : ""}`;
    button.title = `${status.text}${status.sub ? `. ${status.sub}` : ""}`;
    button.setAttribute("aria-label", button.title);
    renderSaveArea(tab);
  }
