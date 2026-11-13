  "use strict";
  // ---------- details: activity, changes, notes and usage ----------
  function renderSide() {
    const tab = currentTab();
    $("side").hidden = !sideOpen; $("main").classList.toggle("side", sideOpen);
    $("sideBtn").setAttribute("aria-pressed", String(sideOpen));
    const rows = activity.filter((item) => !item.tabId || item.tabId === tab?.id);
    $("feed").innerHTML = rows.length ? rows.map((item) => `<div class="ev"><span class="d ${esc(item.type)}"></span><span class="x">${esc(item.text)}</span><time>${esc(item.at)}</time></div>`).join("") : '<span class="faint">Nothing yet in this tab.</span>';
    renderUsage(tab);
    renderLower();
  }
  function renderUsage(tab) {
    const usage = $("usage");
    if (!tab) { usage.innerHTML = '<span class="faint">No usage reported yet.</span>'; return; }
    $("usageTitle").textContent = `This session in ${tab.name}`;
    // Numbers only where the server measured them (the leader's last turn, each live run); every other seat says Not reported.
    const rows = [];
    const lead = leader(tab);
    for (const seat of tab.crew) {
      if (seat.isLeader) { rows.push({ seat, model: formatModel(seat.cli, seat.model, tab), value: formatUsage(tab.leaderUsage) }); continue; }
      const live = (tab.runs ?? []).filter((run) => run.seatSlotId === seat.slot && run.status === "working" && formatUsage(run.usage));
      if (live.length) for (const run of live) rows.push({ seat, model: formatModel(run.cli, run.model), value: formatUsage(run.usage) });
      else rows.push({ seat, model: formatModel(seat.cli, seat.model), value: null });
    }
    // An advisor is a per-seat setting now: every seat that has one shows its row, whichever seat it is.
    const advisors = tab.crew.filter((seat) => seat.advisor && cliCap(seat.cli)?.advisor);
    const row = (picture, name, model, value, note) => `<div class="useRow${value ? "" : " unmeasured"}">${picture}<span title="${esc(name)} · ${esc(model)}">${esc(name)} <span class="faint">· ${esc(model)}</span></span>${value ? `<span class="v">${esc(value)}</span>` : `<span class="nr">${esc(note)}</span>`}</div>`;
    usage.innerHTML = (rows.some((item) => item.value) ? "" : '<p class="faint" data-usage-empty>No usage reported yet.</p>')
      + rows.map((item) => row(seatImg(item.seat), item.seat.name, item.model, item.value, "Not reported")).join("")
      + advisors.map((seat) => row('<span class="advglyph" aria-hidden="true">✦</span>', `Advisor for ${seat.name}`, formatModel(seat.cli, seat.advisor), null, "Not reported separately")).join("");
    $("contextLine").textContent = lead ? `${lead.name}'s context: ${contextLine(tab)} · ${formatModel(lead.cli, lead.model, tab)}. Numbers cover the leader's last turn and live runs; a finished run's numbers stay in its own log.` : "";
  }
  function renderLower() {
    document.querySelectorAll(".pills [data-l]").forEach((button) => { const on = button.dataset.l === lowerSection; button.setAttribute("aria-selected", String(on)); button.tabIndex = on ? 0 : -1; });
    $("sideBody").setAttribute("aria-labelledby", `sp-${lowerSection}`);
    $("feed").hidden = lowerSection !== "activity";
    $("usagePanel").hidden = lowerSection !== "usage";
    $("lowerBody").hidden = !["changes", "notes"].includes(lowerSection);
    if (lowerSection === "changes") renderChanges();
    else if (lowerSection === "notes") renderNotes();
  }
  function renderChanges() {
    const tab = currentTab(); const changes = tab?.changes;
    if (!tab || !changes) { $("lowerBody").innerHTML = '<p class="faint" style="margin:0">Git status is unavailable right now. It is read again when a run finishes or you open this tab.</p>'; return; }
    if (!changes.repo) { $("lowerBody").innerHTML = `<div class="kv"><span>Folder</span><span class="path" title="${esc(tab.folder)}">${esc(tab.folder)}</span></div><p class="change-empty faint" data-change-not-repo style="margin:0">Not a git repository. This folder has no commits or uncommitted files to show.</p>`; return; }
    const files = Array.isArray(changes.uncommittedFiles) ? changes.uncommittedFiles : [];
    const ahead = Math.max(0, Number(changes.ahead) || 0), behind = Math.max(0, Number(changes.behind) || 0);
    const hash = changes.lastCommit?.hash ?? "No commit recorded";
    const remote = `${ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} not pushed` : "Up to date"}${behind ? ` · ${behind} behind` : ""}`;
    const rows = [
      `<div class="kv" data-change-row="branch"><span>Branch</span><span class="mono" title="${esc(changes.branch ?? "Unknown")}">${esc(changes.branch ?? "Unknown")}</span></div>`,
      `<div class="kv" data-change-row="commit"><span>Last commit</span><span class="mono" title="${esc(`${hash}${changes.lastCommit?.subject ? ` ${changes.lastCommit.subject}` : ""}`)}">${esc(hash)}</span></div>`,
      `<div class="kv" data-change-row="remote"><span>Remote</span><span style="color:${ahead ? "var(--warn-text)" : "var(--working-text)"}">${esc(remote)}</span></div>`,
      `<div class="kv" data-change-row="files"><span>Not committed</span><span class="mono change-count" style="color:${files.length ? "var(--warn-text)" : "var(--text-2)"}">${files.length} file${files.length === 1 ? "" : "s"}</span></div>`,
    ];
    const fileList = files.length ? `<div class="fl changes-files" data-change-file-list>${files.map((file) => {
      const status = file.status === "??" ? "A" : (String(file.status || "?").match(/[MAD]/)?.[0] ?? "M");
      return `<div><b class="${status}" aria-label="${status}">${status}</b><span title="${esc(file.path)}">${esc(file.path)}</span></div>`;
    }).join("")}</div>` : '<span class="faint">Working tree clean.</span>';
    $("lowerBody").innerHTML = `${rows.join("")}${fileList}`;
  }
  function openObsidianVault() {
    const vaultPath = serverState?.settings?.vault?.path;
    if (!vaultPath) return;
    if (!window.cc || typeof window.cc.openObsidian !== "function") return;
    const url = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
    Promise.resolve(window.cc.openObsidian(url)).then((result) => {
      if (result?.ok === false) showToast(result.message ?? "Could not open Obsidian");
    }).catch((error) => showToast(error?.message ?? "Could not open Obsidian"));
  }
