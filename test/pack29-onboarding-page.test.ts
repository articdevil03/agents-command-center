import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliverState, setValue, press } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { answer, backTo, expectRows, footer, pickFolderAs, rows, screen, sentCount, sentSince, settleChecks, showFirstRun, startState, stepOf, toolsChange } from "./pack29-onboarding-page.setup.ts";

// Pack 29 Block 2c: the setup wizard on the real page (real scripts, real CSS, a state from a real server, then states delivered by hand).
// The server re-checks every completeFirstRun (test/pack29-first-run.test.ts); these tests prove what the page shows and exactly what it sends.
const ALL_READY = { claude: [true, true], codex: [true, true], opencode: [true, true] } as const;
const FOLDER = "C:\\work\\My App";
const active = `(()=>{const a=document.activeElement;return a.id||a.dataset.focusKey||a.tagName})()`;

test("P29 setup wizard: shown only when the server says required, opens on Welcome, and the work surface steps aside", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    assert.equal(seed.firstRun?.required, false, "control: a seeded (not pristine) data root is not a first install");
    assert.deepEqual(await screen(ev), { first: false, frun: false, stage: true, side: false, bodyClass: false, welcome: false, strip: true }, "an existing user sees the normal app");
    // Details open in the saved prefs: the wizard must still hide it.
    await showFirstRun(ev, seed, ALL_READY, "state.clientPrefs={...state.clientPrefs,detailsOpen:true}");
    await waitFor(`Boolean(document.querySelector('#first:not([hidden]) .frun'))`, "setup wizard FOUND");
    assert.deepEqual(await screen(ev), { first: true, frun: true, stage: false, side: false, bodyClass: true, welcome: false, strip: false }, "required: the wizard shows, the work surface and Details are hidden");
    assert.equal(await stepOf(ev), "welcome", "the wizard opens on Welcome");
    assert.equal(await ev(`document.querySelector('#frunH-welcome').textContent`), "Welcome to Command Center");
    assert.deepEqual(await footer(ev), { count: "Step 1 of 4: Welcome", current: ["welcome:step"], why: "", buttons: ["Skip setup", "Get started"], nextDisabled: false }, "Welcome: one Skip, no Back, Get started");
    assert.equal(await ev(`document.querySelector('#stage').closest('[hidden]')!==null`), true, "the hidden work surface is out of the tab order");
    for (const [label, change] of [["required false", "state.firstRun={required:false}"], ["no firstRun field", "delete state.firstRun"]] as const) {
      await deliverState(ev, seed, `${change};state.clientPrefs={...state.clientPrefs,detailsOpen:true}`);
      assert.deepEqual(await screen(ev), { first: false, frun: true, stage: true, side: true, bodyClass: false, welcome: false, strip: true }, `${label}: exactly today's app (with Details as saved)`);
    }
    // No projects and not a first install: today's welcome, unchanged. No projects and a first install: the wizard wins.
    await deliverState(ev, seed, "state.projects=[];state.firstRun={required:false}");
    assert.deepEqual(await screen(ev), { first: true, frun: false, stage: false, side: false, bodyClass: false, welcome: true, strip: true }, "no projects, not first run: the existing welcome");
    await showFirstRun(ev, seed, ALL_READY, "state.projects=[]");
    assert.deepEqual(await screen(ev), { first: true, frun: true, stage: false, side: false, bodyClass: true, welcome: false, strip: false }, "no projects, first run: the wizard");
  }, { fixture: "fixed" });
});

test("P29 setup wizard: steps, Back keeps values, Next gated with a reason, found/not found wording, and exactly what Start, Sign in, Check again and focus send", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    // An unchecked tool on first show: one automatic check, every row not known yet says Checking until it is answered.
    const from = await sentCount(ev);
    await showFirstRun(ev, seed, { claude: [null, null], codex: [true, false], opencode: [false, null] });
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    const auto = await sentSince(ev, "refreshSettings", from);
    assert.equal(auto.length, 1, "one automatic tool check when a status is unknown");
    assert.deepEqual(Object.keys(auto[0]).sort(), ["requestId", "type"]);
    assert.deepEqual((await rows(ev)).map((row) => row.chip), ["Checking", "Sign in needed", "Not found"], "Checking shows on the row not known yet; known rows keep their chip");
    await settleChecks(ev, from);

    // Welcome -> folder: focus lands on the step heading; the progress line names the step.
    await click(ev, "#frunNext");
    assert.equal(await stepOf(ev), "folder");
    assert.equal(await ev(active), "frunH-folder", "focus moves to the new step's heading");
    assert.deepEqual(await footer(ev), { count: "Step 2 of 4: Project folder", current: ["folder:step"], why: "Choose a folder to go on.", buttons: ["Skip setup", "Back", "Next"], nextDisabled: true });
    // A forced Next on an incomplete step stays put.
    await ev(`(()=>{const b=document.querySelector('#frunNext');b.disabled=false;b.click();return true})()`);
    assert.equal(await stepOf(ev), "folder", "a forced Next does not leave an incomplete step");
    await pickFolderAs(ev, FOLDER); await click(ev, "#frunBrowse");
    await waitFor(`document.querySelector('#frunPath').textContent===${J(FOLDER)}`, "the chosen folder is shown");
    assert.equal(await ev(`document.querySelector('#frunName').value`), "My App", "the name is prefilled from the folder");
    for (const [name, why] of [["   ", "Give the project a name."], ["!!!", "Use at least one letter or number in the name."], ["東京", ""], ["x".repeat(101), "Use at most 100 characters without control or invisible formatting characters in the name."], ["My App", ""]]) {
      await setValue(ev, "#frunName", name);
      const foot = await footer(ev);
      assert.deepEqual([foot.why, foot.nextDisabled], [why, Boolean(why)], `name ${J(name)}: Next ${why ? "off" : "on"}`);
    }
    // Enter in the name field moves on when the step is complete (a real key press).
    await ev(`(()=>{document.querySelector('#frunName').focus();return true})()`);
    await press(page, "Enter");
    assert.equal(await stepOf(ev), "tools", "Enter moves to the AI tool step");

    // The tool step: found / not found / not signed in wording; Next never opens for unknown, signed-out or missing tools.
    expectRows(await rows(ev), { claude: ["Unknown", ["Check again", "How to set up"]], codex: ["Sign in needed", ["Sign in"]], opencode: ["Not found", ["Install", "How to set up"]] });
    assert.deepEqual(await ev(`['claude','codex','opencode'].map((c)=>document.querySelector('#frunTools [data-cli="'+c+'"] .frun-detail').textContent)`), ["Not checked yet. Press Check again.", "Found, but not signed in.", "Not found on this computer."]);
    const notReady: Array<[boolean | null, boolean | null]> = [[null, null], [true, null], [true, false], [false, null], [false, false]];
    for (const pair of notReady) {
      await showFirstRun(ev, seed, { claude: pair, codex: pair, opencode: pair });
      const foot = await footer(ev);
      assert.deepEqual([foot.nextDisabled, foot.why], [true, "Install and sign in to one AI tool, then press Check again."], `tools ${J(pair)}: Next stays off`);
      const before = await sentCount(ev);
      await ev(`(()=>{for(const id of ['frunNext','frunStart']){const b=document.querySelector('#'+id);b.hidden=false;b.disabled=false;b.click();}return true})()`);
      assert.equal(await stepOf(ev), "tools", `tools ${J(pair)}: a forced Next stays on the tool step`);
      assert.deepEqual(await sentSince(ev, "completeFirstRun", before), [], `tools ${J(pair)}: a forced Start sends nothing`);
    }

    // Sign in sends cliLogin for that CLI; Check again sends refreshSettings; a regained window focus checks once.
    await showFirstRun(ev, seed, { claude: [true, true], codex: [true, false], opencode: [false, null] });
    expectRows(await rows(ev), { claude: ["Ready", []], codex: ["Sign in needed", ["Sign in"]], opencode: ["Not found", ["Install", "How to set up"]] });
    assert.match(await ev(`document.querySelector('[data-cli="claude"] small').textContent`), /^Found on this computer, signed in/);
    assert.equal(await ev(`document.querySelector('#frunSum').textContent`), "Found and ready: Claude Code.");
    let mark = await sentCount(ev);
    await click(ev, '[data-frun-login="codex"]');
    const login = await sentSince(ev, "cliLogin", mark);
    assert.equal(login.length, 1); assert.deepEqual({ ...login[0], requestId: "id" }, { type: "cliLogin", cli: "codex", requestId: "id" }, "Sign in names the row's CLI");
    assert.equal(await ev(`document.querySelector('[data-frun-login="codex"]').disabled`), true, "Sign in waits while it runs");
    await answer(ev, login[0]);
    mark = await sentCount(ev);
    await click(ev, "#frunCheck");
    const check = await sentSince(ev, "refreshSettings", mark);
    assert.equal(check.length, 1, "Check again sends one refreshSettings"); await answer(ev, check[0]);
    mark = await sentCount(ev);
    await ev(`(()=>{window.dispatchEvent(new Event('focus'));return true})()`);
    const focused = await sentSince(ev, "refreshSettings", mark);
    assert.equal(focused.length, 1, "a regained window focus checks once"); await answer(ev, focused[0]);
    // How to set up shows in-app steps; nothing navigates.
    await click(ev, '[data-frun-help="opencode"]');
    const help = await ev(`(()=>{const b=document.querySelector('[data-frun-help="opencode"]'),p=document.getElementById(b.getAttribute('aria-controls'));return {expanded:b.getAttribute('aria-expanded'),shown:!p.hidden,steps:[...p.querySelectorAll('.frun-howto li')].map(li=>li.textContent),urls:p.querySelectorAll('.frun-url,[data-frun-copy]').length,links:document.querySelectorAll('#first a[href]').length,focus:document.activeElement===b}})()`);
    assert.deepEqual(help, { expanded: "true", shown: true, steps: ["Press Install to install OpenCode 1.", "Press Sign in, then Get my key. Paste your OpenCode Go API key and press Save key.", "Key saved. OpenCode will check it when you first chat."], urls: 0, links: 0, focus: true });

    // Leader: the first Ready CLI by default; the chosen one is what the Ready step shows and Start sends.
    await showFirstRun(ev, seed, { claude: [true, false], codex: [true, true], opencode: [true, true] });
    assert.deepEqual(await ev(`[...document.querySelectorAll('#frunLeader input[name=frunLeader]')].map((r)=>[r.value,r.checked])`), [["codex", true], ["opencode", false]], "default leader is the first Ready in order");
    await click(ev, '#frunLeader input[value="opencode"]');
    await click(ev, "#frunNext");
    assert.equal(await stepOf(ev), "ready");
    assert.deepEqual(await footer(ev), { count: "Step 4 of 4: Ready", current: ["ready:step"], why: "", buttons: ["Skip setup", "Back", "Start Command Center"], nextDisabled: null }, "on the last step the primary button is Start");
    const review = `[...document.querySelectorAll('#frunReview dd')].map((d)=>d.textContent).concat(document.querySelector('#frunReview .frun-lead').textContent)`;
    assert.deepEqual(await ev(review), [FOLDER, "My App", "Yes", "OpenCode"], "the summary shows folder, name, project only and the leader");
    // Back keeps every value; Change jumps to the right step.
    await backTo(ev, "folder");
    assert.deepEqual(await ev(`[document.querySelector('#frunPath').textContent,document.querySelector('#frunName').value,document.querySelector('#frunOnly').checked]`), [FOLDER, "My App", true], "Back keeps the folder step's values");
    await click(ev, "#frunNext");
    assert.equal(await ev(`document.querySelector('#frunLeader input:checked').value`), "opencode", "Back and Next keep the chosen leader");
    await click(ev, "#frunNext");
    await click(ev, '[data-frun-goto="tools"]');
    assert.deepEqual([await stepOf(ev), await ev(active)], ["tools", "frunH-tools"], "Change leader opens the tool step, focus on its heading");
    await click(ev, "#frunNext");
    // A state broadcast never resets the step or the typed values.
    await showFirstRun(ev, seed, { claude: [true, false], codex: [true, true], opencode: [true, true] });
    assert.equal(await stepOf(ev), "ready", "a state broadcast keeps the step");

    // Start: exactly the fields the server re-checks, then busy.
    assert.deepEqual(await startState(ev), { disabled: false, label: "Start Command Center", status: "Opens My App with OpenCode as the leader.", bad: false });
    mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const sent = await sentSince(ev, "completeFirstRun", mark);
    assert.equal(sent.length, 1, "Start sends one completeFirstRun");
    assert.deepEqual(sent[0], { type: "completeFirstRun", name: "My App", folder: FOLDER, cli: "opencode", projectOnly: true, requestId: sent[0].requestId }, "exactly the fields the server re-checks");
    assert.deepEqual(await startState(ev), { disabled: true, label: "Starting…", status: "Setting up your project…", bad: false }, "busy while the server works");
    assert.equal(await ev(`document.querySelector('#frunBack').disabled`), true, "Back waits while the server works");

    // A refusal: the message shows on this step, the step and inputs stay, Start comes back; an edited input clears the old refusal.
    const line = `window.__frunStatus`;
    await ev(`(()=>{${line}=document.querySelector('#frunStatus');return true})()`);
    await answer(ev, sent[0], "project folder must exist");
    assert.deepEqual(await startState(ev), { disabled: false, label: "Start Command Center", status: "Not started: project folder must exist.", bad: true });
    assert.deepEqual(await ev(`[${line}===document.querySelector('#frunStatus'),${line}.getAttribute('aria-live'),document.querySelector('#frunName').value,document.querySelector('#frunPath').textContent,document.querySelector('#frunOnly').checked]`),
      [true, "polite", "My App", FOLDER, true], "the live line is the same element; every input is kept");
    assert.equal(await stepOf(ev), "ready", "a refusal keeps the Ready step");
    await click(ev, '[data-frun-goto="folder"]');
    await setValue(ev, "#frunName", "My App 2");
    await click(ev, "#frunNext"); await click(ev, "#frunNext");
    assert.deepEqual(await startState(ev), { disabled: false, label: "Start Command Center", status: "Opens My App 2 with OpenCode as the leader.", bad: false }, "an edited input clears the old refusal");
    mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const retry = await sentSince(ev, "completeFirstRun", mark);
    assert.equal(retry.length, 1); assert.notEqual(retry[0].requestId, sent[0].requestId, "a retry is a new request");
    // Tools that stop being ready while on the Ready step turn Start off, and a forced Start sends nothing.
    await answer(ev, retry[0], "fixture refusal");
    for (const pair of notReady) {
      await showFirstRun(ev, seed, { claude: pair, codex: pair, opencode: pair });
      const before = await sentCount(ev), start = await startState(ev);
      assert.deepEqual([start.disabled, start.status], [true, "Install and sign in to one AI tool, then press Check again."], `Ready step, tools ${J(pair)}: Start off`);
      await ev(`(()=>{const b=document.querySelector('#frunStart');b.disabled=false;b.click();return true})()`);
      assert.deepEqual(await sentSince(ev, "completeFirstRun", before), [], `Ready step, tools ${J(pair)}: a forced Start sends nothing`);
    }
    // Success: the server's state turns firstRun off and the normal app takes over.
    await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(ALL_READY)}`);
    assert.deepEqual(await screen(ev), { first: false, frun: true, stage: true, side: false, bodyClass: false, welcome: false, strip: true }, "success: the normal app shows");
  }, { fixture: "fixed" });
});

test("P29 setup wizard: keyboard order, labels, one live step announcement, aria-current, visible focus, no overlap at 900x600 on every step, Skip and the plain-browser folder field", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    await page("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    await showFirstRun(ev, seed, { claude: [true, true], codex: [true, true], opencode: [false, null] });
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await ev(`${AUDIT_JS};true`);
    // The step announcement changes once per step change, never on a redraw.
    await ev(`(()=>{window.__announce=[];new MutationObserver(()=>window.__announce.push(document.querySelector('#frunCount').textContent)).observe(document.querySelector('#frunCount'),{childList:true,characterData:true,subtree:true});return true})()`);
    const look = `((el)=>{const s=getComputedStyle(el);return s.outlineStyle==='none'?'none / '+s.boxShadow:s.outlineStyle+' '+s.outlineWidth+' / '+s.boxShadow})`;
    // Real Tab presses from the step heading; each stop's focus look is compared with the same control at rest.
    async function tabOrder(label: string, expected: string[]): Promise<void> {
      const order: string[] = [], focused: string[] = [];
      for (let i = 0; i < expected.length; i++) { await press(page, "Tab"); order.push(await ev(active)); focused.push(await ev(`${look}(document.activeElement)`)); }
      assert.deepEqual(order, expected, `${label}: tab order`);
      await ev(`(()=>{document.activeElement.blur();return true})()`);
      for (const [index, key] of order.entries()) {
        const resting = await ev(`${look}(document.querySelector(${J(`#${key},[data-focus-key="${key}"]`)}))`);
        assert.notEqual(focused[index], resting, `${label}: ${key} looks different when keyboard-focused (${focused[index]} vs ${resting})`);
      }
    }
    async function checkStep(label: string, id: string, index: number, min: { texts: number; controls: number }, fits = true): Promise<void> {
      assert.equal(await stepOf(ev), id, `${label}: the ${id} step shows`);
      const facts = await ev(`(()=>{const marks=[...document.querySelectorAll('#first .frun-marks li')];return {list:document.querySelector('#first .frun-marks').tagName,items:marks.length,current:marks.findIndex((m)=>m.getAttribute('aria-current')==='step'),currents:marks.filter((m)=>m.hasAttribute('aria-current')).length,
        live:document.querySelector('#frunCount').getAttribute('aria-live'),heading:document.querySelector('#frunH-${id}').getAttribute('tabindex'),labelled:document.querySelector('[data-step="${id}"]').getAttribute('aria-labelledby')}})()`);
      assert.deepEqual(facts, { list: "OL", items: 4, current: index, currents: 1, live: "polite", heading: "-1", labelled: `frunH-${id}` }, `${label}: progress list, aria-current, live line, focusable heading`);
      const unlabelled = await ev(`[...document.querySelectorAll('#first button,#first input')].filter((el)=>el.checkVisibility()).filter((el)=>{
        if (el.tagName==='BUTTON') return !el.textContent.trim()&&!el.getAttribute('aria-label');
        return !(el.labels&&el.labels.length&&el.labels[0].textContent.trim())&&!el.getAttribute('aria-label');}).map((el)=>el.outerHTML.slice(0,80))`);
      assert.deepEqual(unlabelled, [], `${label}: every control has a name`);
      const result = await ev(`window.__ov(${J(label)},"#first")`);
      assert.ok(result.found && result.texts >= min.texts && result.controls >= min.controls, `${label}: the audit read the screen (${result.texts} texts, ${result.controls} controls)`);
      assert.deepEqual(result.violations, [], `${label}: no overlap or clipped text`);
      const fit = await ev(`(()=>{const f=document.querySelector('#first'),s=f.querySelector('.frun-stage'),foot=f.querySelector('.frun-foot').getBoundingClientRect(),box=f.getBoundingClientRect();
        return {sideways:f.scrollWidth>f.clientWidth||s.scrollWidth>s.clientWidth,firstScrolls:f.scrollHeight>f.clientHeight,footerInView:foot.top>=box.top&&foot.bottom<=box.bottom+0.5&&foot.bottom<=innerHeight,stageOverflow:s.scrollHeight-s.clientHeight}})()`);
      console.log(`${label}: step body overflow ${fit.stageOverflow}px`);
      assert.deepEqual([fit.sideways, fit.firstScrolls, fit.footerInView], [false, false, true], `${label}: no sideways scroll, the screen itself never scrolls, the footer is in view`);
      if (fits) assert.ok(fit.stageOverflow <= 0, `${label}: the step fits without scrolling (${fit.stageOverflow}px over)`);
    }

    // Welcome
    await checkStep("Welcome 900x600", "welcome", 0, { texts: 8, controls: 2 });
    await ev(`(()=>{document.querySelector('#frunH-welcome').focus();return true})()`);
    await tabOrder("Welcome", ["frunSkip", "frunNext"]);
    // Folder
    await click(ev, "#frunNext");
    await pickFolderAs(ev, FOLDER); await click(ev, "#frunBrowse");
    const rowHeight = `document.querySelector('.frun-pathrow').getBoundingClientRect().height`;
    assert.ok((await ev(rowHeight)) <= 56, `the chosen folder row is one line high at 900px (${await ev(rowHeight)}px)`);
    await checkStep("Folder 900x600", "folder", 1, { texts: 8, controls: 5 });
    await ev(`(()=>{document.querySelector('#frunH-folder').focus();return true})()`);
    await tabOrder("Folder", ["frunBrowse", "frunName", "frunOnly", "frunSkip", "frunBack", "frunNext"]);
    // AI tool, with the install help open
    await click(ev, "#frunNext");
    // The AI tool step carries the tools-versus-models note and the "Use a different AI tool" form: at 900x600 its own body scrolls.
    await checkStep("AI tool 900x600", "tools", 2, { texts: 10, controls: 5 }, false);
    await click(ev, '[data-frun-help="opencode"]');
    await checkStep("AI tool 900x600, help open", "tools", 2, { texts: 10, controls: 5 }, false);
    // With the help open the step may be taller than the window: only its own body scrolls, and the bottom is clean too.
    await ev(`(()=>{const s=document.querySelector('#first .frun-stage');s.scrollTop=s.scrollHeight;return true})()`);
    await checkStep("AI tool 900x600, help open, scrolled to the bottom", "tools", 2, { texts: 8, controls: 5 }, false);
    await ev(`(()=>{document.querySelector('#first .frun-stage').scrollTop=0;return true})()`);
    await ev(`(()=>{document.querySelector('#frunH-tools').focus();return true})()`);
    await tabOrder("AI tool", ["frunCheck", "frunGuideCopy", "frunSearch", "frun-install-opencode", "frun-help-opencode", "frun-to-opencode", "frun-leader-claude", "frunOtherToggle", "frunSkip", "frunBack", "frunNext"]);
    // Ready, then with a long refusal showing
    await click(ev, "#frunNext");
    await checkStep("Ready 900x600", "ready", 3, { texts: 10, controls: 5 });
    assert.equal(await ev(`document.querySelector('#frunStart').getAttribute('aria-describedby')`), "frunStatus", "Start is described by why it is on or off");
    await ev(`(()=>{document.querySelector('#frunH-ready').focus();return true})()`);
    await tabOrder("Ready", ["frun-goto-folder", "frun-goto-tools", "frunSkip", "frunBack", "frunStart"]);
    assert.deepEqual(await ev("window.__announce"), ["Step 2 of 4: Project folder", "Step 3 of 4: AI tool", "Step 4 of 4: Ready"], "one announcement per step change, none on redraws");
    // A tool check that is still running (the window got focus) must not block Start.
    await ev(`(()=>{window.dispatchEvent(new Event('focus'));return true})()`);
    assert.equal(await ev(`document.querySelector('#frunCheck').textContent`), "Checking…", "control: a check is running");
    await click(ev, "#frunStart");
    const [request] = await sentSince(ev, "completeFirstRun", 0);
    assert.ok(request, "Start sends while a tool check is still running");
    await answer(ev, request, "invalid or duplicate project id: my-app, a long refusal that has to wrap onto a second line inside the status area");
    await checkStep("Ready 900x600, refusal showing", "ready", 3, { texts: 10, controls: 5 });

    // Skip asks once, says the example project stays, and sends only skipFirstRun when confirmed; a refusal shows beside the buttons.
    await backTo(ev, "folder");
    let mark = await sentCount(ev);
    await click(ev, "#frunSkip");
    await waitFor(`!document.querySelector('#confirmModal').hidden`, "skip confirmation open");
    assert.match(await ev(`document.querySelector('#confirmBody').textContent`), /example project stays/);
    await click(ev, "#confirmCancel");
    assert.deepEqual(await sentSince(ev, "skipFirstRun", mark), [], "Cancel sends nothing");
    await click(ev, "#frunSkip"); await waitFor(`!document.querySelector('#confirmModal').hidden`, "skip confirmation open again");
    await click(ev, "#confirmOk");
    const skip = await sentSince(ev, "skipFirstRun", mark);
    assert.equal(skip.length, 1); assert.deepEqual(skip[0], { type: "skipFirstRun", requestId: skip[0].requestId });
    await answer(ev, skip[0], "fixture refusal");
    assert.deepEqual([(await footer(ev)).why, await ev(`document.querySelector('#frunWhy').classList.contains('bad')`)], ["Not skipped: fixture refusal.", true], "a refused skip says so beside the buttons");

    // Without the app's folder picker (a plain browser tab) the folder is typed, and must be a full path.
    await ev(`(()=>{delete window.cc.pickFolder;document.querySelector('#first').innerHTML='';return true})()`);
    await showFirstRun(ev, seed, ALL_READY);
    assert.equal(await stepOf(ev), "folder", "a fresh mount keeps the step");
    assert.equal(await ev(`Boolean(document.querySelector('#frunFolder'))&&!document.querySelector('#frunBrowse')`), true, "a text field replaces Browse");
    await setValue(ev, "#frunName", "");
    await setValue(ev, "#frunFolder", "work\\Alpha");
    assert.equal((await footer(ev)).why, "Type the full folder path, starting with the drive, like C:\\.");
    await setValue(ev, "#frunFolder", "D:\\work\\Alpha");
    assert.deepEqual(await ev(`document.querySelector('#frunName').value`), "Alpha", "the typed folder names the project");
    await checkStep("Folder typed 900x600", "folder", 1, { texts: 6, controls: 5 });
    await click(ev, "#frunNext"); await click(ev, "#frunNext");
    mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const typed = await sentSince(ev, "completeFirstRun", mark);
    assert.deepEqual(typed.map((m) => [m.folder, m.name, m.cli]), [["D:\\work\\Alpha", "Alpha", "claude"]], "the typed folder is what is sent; the first Ready CLI leads");
  }, { fixture: "fixed" });
});
