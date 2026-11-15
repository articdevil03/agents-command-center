import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, press } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { answer, backTo, footer, rows, sentCount, sentSince, startState, stepOf } from "./pack29-onboarding-page.setup.ts";
import { acpRows, acpTool, activeId, broadcastAgain, form, leaderChoices, openForm, showWith, toToolStep, typeInto } from "./pack29-onboarding-page-acp.setup.ts";

// Pack 29 W2: the wizard's "other AI tools" parts on the real page (real scripts and CSS, a state from a real server, then states by hand).
// The server re-checks every Add and every completeFirstRun; these tests prove what the page shows and exactly what it sends.
const FOLDER = "C:\\work\\My App";
const CLAUDE_ONLY = { claude: [true, true], codex: [true, false], opencode: [false, null] } as const;
const NONE_READY = { claude: [true, false], codex: [false, null], opencode: [false, null] } as const;
const GEMINI = acpTool("Gemini CLI");
const ROW_LINE = "Added. Connection checked when you first chat.";
const NEVER = /\bready\b|signed in|connected/i;

test("P29 W2 tool step: tools versus models, the provider guide, Added rows that never claim a connection, and the Add form (send once, refusal kept, typing survives broadcasts, Enter adds and stays)", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    await showWith(ev, seed, CLAUDE_ONLY, []);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    // No saved tools: the note, the guide as copyable text, the three built-in rows, the form closed.
    const intro = await ev(`(()=>{const s=document.querySelector('[data-step="tools"]');return {note:s.querySelector('.frun-note').textContent,url:s.querySelector('.frun-guide code').textContent,links:document.querySelectorAll('#first a[href]').length}})()`);
    assert.equal(intro.note, "A tool is the program on this computer. The model is the AI it uses. Install one tool below and sign in. Models that have no tool of their own run through OpenCode: they are listed under Models used through OpenCode.");
    assert.deepEqual([intro.url, intro.links], ["https://opencode.ai/docs/providers/", 0], "the provider guide is text to copy; nothing navigates");
    assert.deepEqual((await rows(ev)).map((row) => [row.cli, row.chip]), [["claude", "Ready"], ["codex", "Sign in needed"], ["opencode", "Not found"]], "the built-in rows are unchanged");
    assert.deepEqual(await acpRows(ev), [], "no saved tools: no extra rows");
    const closed = await form(ev);
    assert.deepEqual([closed.open, closed.expanded], [false, "false"], "the form starts closed");
    assert.equal((await footer(ev)).nextDisabled, false, "a Ready built-in still leads by default");

    // The form: an empty Add says what is missing and sends nothing; Enter inside the form never moves the wizard on.
    await openForm(ev);
    assert.equal((await form(ev)).expanded, "true");
    let mark = await sentCount(ev);
    await ev(`(()=>{document.querySelector('#frunAcpName').focus();return true})()`);
    await press(page, "Enter");
    assert.deepEqual([await stepOf(ev), (await form(ev)).message, await sentSince(ev, "addAcpCli", mark)], ["tools", "Type a name and the start command first.", []], "an empty Enter stays and sends nothing");

    // A real Add: exactly the existing addAcpCli message, sent once; a second press while it runs is ignored.
    await typeInto(ev, "frunAcpName", "Not Real");
    await typeInto(ev, "frunAcpCmd", "notarealcli --acp");
    assert.equal((await form(ev)).message, "", "typing clears the old note");
    mark = await sentCount(ev);
    await press(page, "Enter");
    assert.equal(await stepOf(ev), "tools", "Enter in the start command field adds the tool and stays on the tool step");
    await click(ev, "#frunAcpAdd", true);
    const sent = await sentSince(ev, "addAcpCli", mark);
    assert.equal(sent.length, 1, "a second press while the Add runs sends nothing");
    assert.deepEqual(sent[0], { type: "addAcpCli", name: "Not Real", command: "notarealcli --acp", requestId: sent[0].requestId }, "the name and the single command string");
    assert.deepEqual([(await form(ev)).button, (await form(ev)).busy, await activeId(ev)], ["Adding…", "true", "frunAcpAdd"], "busy, and keyboard focus stays on the button");

    // The server's refusal shows in plain words under the form; the typed values stay; editing clears it.
    await answer(ev, sent[0], "notarealcli was not found. Install it first, or check the name.");
    const refused = await form(ev);
    assert.deepEqual([refused.message, refused.bad, refused.name, refused.command, refused.button], ["Not added: notarealcli was not found. Install it first, or check the name.", true, "Not Real", "notarealcli --acp", "Add tool"]);
    assert.deepEqual(await acpRows(ev), [], "a refusal adds no row");

    // Typed text and focus survive state broadcasts (the rows are redrawn around the form, never the form itself).
    await typeInto(ev, "frunAcpName", "Gemini CLI");
    await typeInto(ev, "frunAcpCmd", "gemini --ac");
    await ev(`(()=>{window.__field=document.querySelector('#frunAcpCmd');window.__field.setSelectionRange(3,6);return true})()`);
    await broadcastAgain(ev, seed, { ...CLAUDE_ONLY, codex: [true, true] }, []);
    await broadcastAgain(ev, seed, CLAUDE_ONLY, []);
    assert.deepEqual(await ev(`[document.activeElement===window.__field,window.__field.isConnected,window.__field.value,window.__field.selectionStart,window.__field.selectionEnd,document.querySelector('#frunAcpName').value]`),
      [true, true, "gemini --ac", 3, 6, "Gemini CLI"], "the same field keeps focus, text and selection through two broadcasts");
    assert.equal((await form(ev)).message, "", "the old refusal was about other values");

    // Success: the server saves and broadcasts, then answers. The row appears, the form clears, focus goes to the new tool's choice.
    await typeInto(ev, "frunAcpCmd", "gemini --acp");
    mark = await sentCount(ev);
    await click(ev, "#frunAcpAdd");
    const [ok] = await sentSince(ev, "addAcpCli", mark);
    assert.deepEqual([ok.name, ok.command], ["Gemini CLI", "gemini --acp"]);
    await broadcastAgain(ev, seed, CLAUDE_ONLY, [GEMINI]);
    await answer(ev, ok);
    const added = await form(ev);
    assert.deepEqual([added.name, added.command, added.message, added.bad, added.open], ["", "", "Gemini CLI added.", false, true], "the form clears and says so");
    const [row] = await acpRows(ev);
    assert.deepEqual([row.kind, row.name, row.chip, row.line], [GEMINI.kind, "Gemini CLI", "Added", ROW_LINE]);
    assert.equal(await activeId(ev), `frun-leader-${GEMINI.kind}`, "focus moves to the new tool's choice");
    assert.deepEqual(await leaderChoices(ev), [["claude", true], [GEMINI.kind, false]], "an added tool never silently becomes the leader");
    // No added tool says Ready, signed in or connected: not its row, not its choice.
    const words = await ev(`[...document.querySelectorAll('#frunAcpRows .frun-acp')].map((r)=>r.textContent).concat([...document.querySelectorAll('#frunLeader label')].filter((l)=>l.querySelector('input').value.startsWith('acp:')).map((l)=>l.textContent))`);
    assert.ok(words.length >= 2, `control: the added tool's row and choice were read (${J(words)})`);
    for (const text of words) assert.doesNotMatch(text, NEVER, `an added tool never claims a connection: ${text}`);
    assert.deepEqual(await rows(ev).then((list) => list.length), 3, "the built-in rows stay three");
  }, { fixture: "fixed" });
});

test("P29 W2 leader: an added tool needs the Full access tick, only then Start sends acpConsent; built-ins never send it; no preselection without a Ready built-in; Skip says added tools stay", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    await showWith(ev, seed, CLAUDE_ONLY, [GEMINI]);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    assert.deepEqual(await leaderChoices(ev), [["claude", true], [GEMINI.kind, false]], "the first Ready built-in is the default; the added tool is a choice");
    assert.equal((await form(ev)).consentShown, false, "no Full access tick for a built-in leader");

    // Choosing the added tool asks for the tick; Next stays off (and a forced Next stays put) until it is ticked.
    await click(ev, `#frunLeader input[value="${GEMINI.kind}"]`);
    assert.deepEqual([(await form(ev)).consentShown, (await form(ev)).consent], [true, false]);
    assert.deepEqual([(await footer(ev)).nextDisabled, (await footer(ev)).why], [true, "Tick the Full access box to use Gemini CLI."]);
    await ev(`(()=>{const b=document.querySelector('#frunNext');b.disabled=false;b.click();return true})()`);
    assert.equal(await stepOf(ev), "tools", "a forced Next without the tick stays on the tool step");
    await click(ev, "#frunConsent");
    assert.deepEqual([(await form(ev)).consent, (await footer(ev)).nextDisabled], [true, false], "the tick opens Next");
    await click(ev, "#frunNext");
    assert.equal(await stepOf(ev), "ready");
    assert.deepEqual(await ev(`[document.querySelector('#frunReview .frun-lead b').textContent,document.querySelector('#frunReview .frun-full').textContent]`), ["Gemini CLI", "(Full access)"], "Ready: Leader Gemini CLI (Full access)");
    assert.deepEqual(await startState(ev), { disabled: false, label: "Start Command Center", status: "Opens My App with Gemini CLI as the leader, with Full access.", bad: false });
    let mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const [acpStart] = await sentSince(ev, "completeFirstRun", mark);
    assert.deepEqual(acpStart, { type: "completeFirstRun", name: "My App", folder: FOLDER, cli: GEMINI.kind, projectOnly: true, acpConsent: true, requestId: acpStart.requestId }, "the chosen tool and the consent");
    await answer(ev, acpStart, `Choose Full access to use Gemini CLI: it can edit files and run commands without asking.`);
    assert.equal((await startState(ev)).status, "Not started: Choose Full access to use Gemini CLI: it can edit files and run commands without asking.", "a server refusal shows in plain words");

    // Back to a built-in clears the tick: going back to the added tool asks again, and a built-in Start sends no acpConsent.
    await backTo(ev, "tools");
    await click(ev, '#frunLeader input[value="claude"]');
    assert.equal((await form(ev)).consentShown, false, "a built-in leader hides the tick");
    await click(ev, `#frunLeader input[value="${GEMINI.kind}"]`);
    assert.deepEqual([(await form(ev)).consent, (await footer(ev)).nextDisabled], [false, true], "switching back cleared the tick");
    // A Start forced on through the page without the tick sends nothing.
    mark = await sentCount(ev);
    await ev(`(()=>{for(const id of ['frunNext','frunStart']){const b=document.querySelector('#'+id);b.hidden=false;b.disabled=false;b.click();}return true})()`);
    assert.deepEqual([await stepOf(ev), await sentSince(ev, "completeFirstRun", mark)], ["tools", []], "no step change and no Start without the tick");
    await click(ev, '#frunLeader input[value="claude"]');
    await click(ev, "#frunNext");
    mark = await sentCount(ev);
    await click(ev, "#frunStart");
    const [builtIn] = await sentSince(ev, "completeFirstRun", mark);
    assert.deepEqual(builtIn, { type: "completeFirstRun", name: "My App", folder: FOLDER, cli: "claude", projectOnly: true, requestId: builtIn.requestId }, "a built-in leader sends no acpConsent");
    await answer(ev, builtIn, "fixture refusal");

    // No Ready built-in and exactly one added tool: nothing is preselected; the person must choose it.
    await showWith(ev, seed, NONE_READY, [GEMINI]);
    await backTo(ev, "tools");
    assert.deepEqual(await leaderChoices(ev), [[GEMINI.kind, false]], "nothing preselected");
    assert.deepEqual([(await footer(ev)).nextDisabled, (await footer(ev)).why], [true, "Choose which tool leads."]);
    assert.equal(await ev(`document.querySelector('#frunSum').textContent`), "No built-in tool is ready yet. You can choose a tool you added.");

    // Skip: no "Tools you added stay saved." until a tool was added in this session.
    await click(ev, "#frunSkip"); await waitFor(`!document.querySelector('#confirmModal').hidden`, "skip confirmation open");
    assert.doesNotMatch(await ev(`document.querySelector('#confirmBody').textContent`), /Tools you added stay saved/, "nothing added yet in this session");
    await click(ev, "#confirmCancel");
    await openForm(ev);
    await typeInto(ev, "frunAcpName", "Other Tool"); await typeInto(ev, "frunAcpCmd", "othertool acp");
    mark = await sentCount(ev);
    await click(ev, "#frunAcpAdd");
    const [add] = await sentSince(ev, "addAcpCli", mark);
    await broadcastAgain(ev, seed, NONE_READY, [GEMINI, acpTool("Other Tool", "othertool", ["acp"])]);
    await answer(ev, add);
    await click(ev, "#frunSkip"); await waitFor(`!document.querySelector('#confirmModal').hidden`, "skip confirmation open again");
    assert.match(await ev(`document.querySelector('#confirmBody').textContent`), /example project stays.* Tools you added stay saved\.$/);
    await click(ev, "#confirmCancel");
  }, { fixture: "fixed" });
});

test("P29 W2 tool step at 900x600: no overlap with the form open, a refusal, 4+ added tools and the Full access tick, light and dark; tab order; the footer always in view", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    await page("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    await showWith(ev, seed, CLAUDE_ONLY, []);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    await ev(`${AUDIT_JS};true`);
    // The step body scrolls on its own; every scroll position is audited (top, middle, bottom), the screen itself never scrolls. The middle
    // of the catalog list can hold only rows without an action, so each position needs at least 2 controls (the footer's) to count as read.
    async function audit(label: string, minControls: number): Promise<void> {
      const height = await ev(`(()=>{const s=document.querySelector('#first .frun-stage');return s.scrollHeight-s.clientHeight})()`);
      for (const at of [0, 0.5, 1]) {
        await ev(`(()=>{const s=document.querySelector('#first .frun-stage');s.scrollTop=${Math.round(height * at)};return true})()`);
        const result = await ev(`window.__ov(${J(`${label} @${at}`)},"#first")`);
        assert.ok(result.found && result.texts >= 6 && result.controls >= minControls, `${label} @${at}: the audit read the screen (${result.texts} texts, ${result.controls} controls)`);
        assert.deepEqual(result.violations, [], `${label} @${at}: no overlap or clipped text`);
        const fit = await ev(`(()=>{const f=document.querySelector('#first'),s=f.querySelector('.frun-stage'),foot=f.querySelector('.frun-foot').getBoundingClientRect(),box=f.getBoundingClientRect();
          return {sideways:f.scrollWidth>f.clientWidth||s.scrollWidth>s.clientWidth,firstScrolls:f.scrollHeight>f.clientHeight,footerInView:foot.top>=box.top&&foot.bottom<=box.bottom+0.5&&foot.bottom<=innerHeight}})()`);
        assert.deepEqual(fit, { sideways: false, firstScrolls: false, footerInView: true }, `${label} @${at}: no sideways scroll, only the step body scrolls, the footer is in view`);
      }
      console.log(`${label}: step body overflow ${height}px`);
      await ev(`(()=>{document.querySelector('#first .frun-stage').scrollTop=0;return true})()`);
    }
    await audit("tools, form closed", 2);
    await openForm(ev);
    await audit("tools, form open", 2);
    await typeInto(ev, "frunAcpName", "A tool with a long name here");
    await typeInto(ev, "frunAcpCmd", "averylongprogramname --acp --model=some-provider/some-very-long-model-name-that-wraps");
    let mark = await sentCount(ev);
    await click(ev, "#frunAcpAdd");
    const [request] = await sentSince(ev, "addAcpCli", mark);
    await answer(ev, request, "averylongprogramname was not found. Install it first, or check the name. This sentence is long so that it wraps onto a second line.");
    assert.equal((await form(ev)).bad, true, "control: the refusal shows");
    await audit("tools, form open, refusal", 2);

    // Four added tools (seven rows), one chosen with the tick showing.
    const four = [acpTool("Gemini CLI"), acpTool("Qwen Code", "qwen", ["--acp"]), acpTool("Goose", "goose", ["acp"]), acpTool("A very long tool name for wrapping", "longtool", ["acp"])];
    await broadcastAgain(ev, seed, CLAUDE_ONLY, four);
    assert.equal((await acpRows(ev)).length, 4, "control: four added rows");
    await click(ev, `#frunLeader input[value="${four[3].kind}"]`);
    await click(ev, "#frunConsent");
    assert.deepEqual([(await form(ev)).consentShown, (await form(ev)).consent], [true, true], "control: the tick shows, ticked");
    await audit("tools, 4 added, tick, light", 2);
    await ev(`(()=>{document.body.classList.remove('light');return true})()`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('.frun-consent')).backgroundColor!==getComputedStyle(document.body).backgroundColor`), true, "control: dark styles apply");
    await audit("tools, 4 added, tick, dark", 2);
    await ev(`(()=>{document.body.classList.add('light');return true})()`);

    // Tab order from the heading: the guide, the chosen leader, the tick, the form, the footer.
    await ev(`(()=>{document.querySelector('#frunH-tools').focus();return true})()`);
    const order: string[] = [];
    const expected = ["frunCheck", "frunGuideCopy", "frunSearch", "frun-login-codex", "frun-install-opencode", "frun-help-opencode", "frun-to-opencode", `frun-leader-${four[3].kind}`, "frunConsent", "frunOtherToggle", "frunAcpName", "frunAcpCmd", "frunAcpAdd", "frunSkip", "frunBack", "frunNext"];
    for (let i = 0; i < expected.length; i++) { await press(page, "Tab"); order.push(await activeId(ev)); }
    assert.deepEqual(order, expected, "tab order");
    const unnamed = await ev(`[...document.querySelectorAll('[data-step="tools"] button,[data-step="tools"] input')].filter((el)=>el.checkVisibility()).filter((el)=>el.tagName==='BUTTON'?!el.textContent.trim()&&!el.getAttribute('aria-label'):!(el.labels&&el.labels.length&&el.labels[0].textContent.trim())).map((el)=>el.outerHTML.slice(0,80))`);
    assert.deepEqual(unnamed, [], "every control on the tool step has a name");
    assert.deepEqual(await ev(`['frunAcpMsg','frunSum'].map((id)=>document.getElementById(id).getAttribute('aria-live'))`), ["polite", "polite"], "the form message and the summary are live");
    mark = await sentCount(ev);
    assert.deepEqual(await sentSince(ev, "completeFirstRun", 0), [], "nothing was started on the way");
  }, { fixture: "fixed" });
});
