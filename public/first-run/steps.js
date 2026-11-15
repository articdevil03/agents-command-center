// Command Center setup wizard, the markup (Pack 29): the four steps (Welcome, Project folder, AI tool, Ready) and the footer that is
// always visible. Classic script, loaded before view.js, which owns the behaviour. Every step stays in the page and only the current
// one is shown, so a state broadcast or a step change never loses what was typed.
"use strict";
(() => {
  const MARK = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M42.2 46.6A19 19 0 1 1 42.2 17.4" fill="none" stroke="url(#orbitMark)" stroke-width="12" stroke-linecap="round"/><circle cx="50.5" cy="32" r="6.5" fill="#ffc94d"/></svg>';
  // The order here is the order of the steps; title is what the progress line and the screen reader announcement say.
  const STEPS = Object.freeze([
    Object.freeze({ id: "welcome", title: "Welcome" }),
    Object.freeze({ id: "folder", title: "Project folder" }),
    Object.freeze({ id: "tools", title: "AI tool" }),
    Object.freeze({ id: "ready", title: "Ready" }),
  ]);
  const PARTS = [["Pick a folder", "The folder your project lives in."], ["Check your AI tool", "Command Center looks for one on this computer."], ["Start", "Your project opens, ready to chat with the leader."]];

  const OTHER = window.CC_FIRST_RUN_OTHER;
  const heading = (id, text) => `<h2 id="frunH-${id}" tabindex="-1">${text}</h2>`;
  const section = (id, body) => `<section class="frun-step" data-step="${id}" aria-labelledby="frunH-${id}" hidden>${body}</section>`;

  function welcome() {
    const parts = PARTS.map(([title, note], index) => `<li><span class="frun-pn" aria-hidden="true">${index + 1}</span><b>${title}</b><small>${note}</small></li>`).join("");
    return section("welcome", `<div class="frun-hero">${MARK}${heading("welcome", "Welcome to Command Center")}<p class="frun-lede">Run a crew of AI coding agents from one window. A leader plans, the crew builds and reviews, and you choose how much it may do without asking.</p></div>
      <p class="frun-note">Setup takes about a minute and has three parts:</p><ol class="frun-parts">${parts}</ol>`);
  }
  function folder(canBrowse) {
    const pick = canBrowse
      ? '<div class="field"><span class="lbl" id="frunPathLbl">Folder</span><div class="frun-pathrow"><span class="path" id="frunPath" data-none="true">No folder chosen</span><button type="button" class="btn" id="frunBrowse" aria-describedby="frunPathLbl frunPath">Browse</button></div></div>'
      : '<div class="field"><label class="lbl" for="frunFolder">Folder path</label><input id="frunFolder" spellcheck="false" autocomplete="off" placeholder="C:\\Users\\you\\Documents\\My project"></div>';
    return section("folder", `${heading("folder", "Choose your project folder")}<p class="frun-note">Command Center works inside this folder. Nothing is written there until you press Start.</p>${pick}
      <div class="field"><label class="lbl" for="frunName">Project name</label><input id="frunName" maxlength="100" autocomplete="off" placeholder="e.g. My project"></div>
      <label class="onlybox" for="frunOnly"><input type="checkbox" id="frunOnly" checked><span>Work on this project only</span><small>Adds an AGENTS.md to the folder so the leader stays on this project.</small></label>`);
  }
  // The AI tool step: the tools-versus-models note, one search field, the tools that can lead (built-ins first, then the catalog, then the
  // tools added by their start command), the models used through OpenCode, the leader choice, then the Full access acknowledgement and
  // the "Use a different AI tool" form (other-tool.js). Only the row lists and the choice are ever redrawn; the search field never is.
  const SEARCH = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  function tools(help, esc) {
    return section("tools", `<div class="frun-h">${heading("tools", "AI tools on this computer")}<button type="button" class="btn sm" id="frunCheck">Check again</button></div>
      ${OTHER.introHtml(help, esc)}<div class="frun-search">${SEARCH}<label class="frun-sr" for="frunSearch">Search AI tools and models</label><input type="search" id="frunSearch" autocomplete="off" spellcheck="false" placeholder="Search tools and models" aria-describedby="frunNoMatch"></div>
      <p class="frun-nomatch" id="frunNoMatch" aria-live="polite"></p>
      <div class="frun-group-box" id="frunLeadBox"><h3 class="frun-gh3" id="frunLeadH">Tools Command Center can lead with</h3><div class="card frun-list" role="group" aria-labelledby="frunLeadH"><div class="frun-tools" id="frunTools"></div><div class="frun-tools" id="frunAcpRows"></div></div></div>
      <div class="frun-group-box" id="frunModelBox"><h3 class="frun-gh3" id="frunModelH">Models used through OpenCode</h3><div class="card frun-list" role="group" aria-labelledby="frunModelH"><div class="frun-tools" id="frunProviders"></div></div></div>
      <p class="frun-sr" id="frunLive" aria-live="polite"></p>
      <p class="frun-sum" id="frunSum" aria-live="polite"></p><div id="frunLeader"></div>${OTHER.consentHtml()}${OTHER.formHtml()}`);
  }
  function ready() {
    return section("ready", `${heading("ready", "Ready to start")}<p class="frun-note">Check your choices. You can change any of them before you start.</p>
      <div id="frunReview"></div><p class="frun-status" id="frunStatus" aria-live="polite"></p>`);
  }
  function footer() {
    const marks = STEPS.map((step) => `<li data-mark="${step.id}"><span class="bar" role="img" aria-label="${step.title}"></span></li>`).join("");
    return `<footer class="frun-foot"><button type="button" class="frun-link" id="frunSkip">Skip setup</button>
      <div class="frun-progress"><ol class="frun-marks" aria-label="Setup steps">${marks}</ol><p class="frun-count" id="frunCount" aria-live="polite"></p></div>
      <p class="frun-why" id="frunWhy" aria-live="polite"></p>
      <button type="button" class="btn" id="frunBack">Back</button>
      <button type="button" class="btn primary" id="frunNext" aria-describedby="frunWhy">Next</button>
      <button type="button" class="btn primary" id="frunStart" aria-describedby="frunStatus" hidden>Start Command Center</button></footer>`;
  }
  const skeleton = (canBrowse, help, esc) => `<div class="frun"><div class="frun-stage">${welcome()}${folder(canBrowse)}${tools(help, esc)}${ready()}</div>${footer()}</div>`;

  // The Ready step's summary: what Start will send, each group with a Change link back to its step. An added tool says Full access.
  function reviewHtml(page, { folder: path, name, projectOnly, leader, fullAccess }) {
    const change = (step, what) => `<button type="button" class="frun-link" data-frun-goto="${step}" data-focus-key="frun-goto-${step}" aria-label="Change ${what}">Change</button>`;
    const row = (term, value, cls = "") => `<div><dt>${term}</dt><dd${cls ? ` class="${cls}"` : ""}>${value}</dd></div>`;
    const lead = leader ? `<span class="frun-lead">${fullAccess ? page.logo(leader, 14, 3) : page.logo(leader, 18, 0)}<b>${page.esc(page.cliLabel(leader))}</b>${fullAccess ? '<span class="frun-full">(Full access)</span>' : ""}</span>` : '<span class="frun-none">No AI tool is ready</span>';
    return `<div class="card frun-review"><div class="frun-group"><div class="frun-gh"><span class="lbl">Project</span>${change("folder", "project")}</div><dl class="frun-dl">
      ${row("Folder", page.esc(path) || "Not chosen", "path")}${row("Name", page.esc(name.trim()) || "Not set")}${row("Work on this project only", projectOnly ? "Yes" : "No")}</dl></div>
      <div class="frun-group"><div class="frun-gh"><span class="lbl">Leader</span>${change("tools", "leader")}</div>${lead}</div></div>`;
  }
  window.CC_FIRST_RUN_STEPS = Object.freeze({ STEPS, skeleton, reviewHtml });
})();
