import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click, deliver, deliverState, press } from "./pack18-editor-harness.ts";
import { answer, catalogChange, footer, sentCount, sentSince, showFirstRun as rawShowFirstRun, stepOf, toolsChange, CATALOG_QUIET, stubClipboard } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

// Pack 29 B3: Install in the setup wizard and in Settings, on the real page (real scripts and CSS, a state from a real server, then states
// and answers delivered by hand through the page's stub socket). The server owns what runs (its tests: test/pack29-cli-install*.test.ts);
// these prove what the page shows and EXACTLY what it sends: only a tool id and the consent, never a command, address or package.
// Match O1's authoritative catalog facts when older tool fixtures set built-in status.
const showFirstRun: typeof rawShowFirstRun = (ev, seed, tools, extra = "") => rawShowFirstRun(ev, seed, tools,
  (tools.opencode ? catalogChange({ opencode: { installed: tools.opencode[0], signedIn: tools.opencode[1] } }) : "") + extra);
const FOLDER = "C:\\work\\My App";
const CLAUDE_MISSING = { claude: [false, null], codex: [true, true], opencode: [false, null] } as const;
const active = `(()=>{const a=document.activeElement;return a.id||a.dataset.focusKey||a.tagName})()`;

test("every Settings fallback is a collapsed official guide, with address copy, Check again and no install commands", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const entries = seed.cliCatalog.filter((entry: any) => entry.installable);
    assert.equal(entries.length, 11);
    await showFirstRun(ev, seed, { claude: [false, null], codex: [false, null], opencode: [false, null] },
      catalogChange(Object.fromEntries(entries.map((e: any) => [e.id, { installed: false }]))) + "state.firstRun={required:false};");
    await ev("openSettings(undefined,'tools');true"); await stubClipboard(ev);
    for (const entry of entries) {
      const selector = `#s-tools [data-tool-row][data-cli="${entry.id}"]`;
      if (entry.id === "copilot") {
        assert.equal(await ev(`Boolean(document.querySelector(${J(selector + " details")}))`), false, "Copilot has no manual guide");
        assert.equal(await ev(`document.querySelector(${J(selector + ' [data-setting-action="install-cli"]')}).checkVisibility()`), true);
        continue;
      }
      assert.equal(await ev(`document.querySelector(${J(selector + " details")}).open`), false);
      await click(ev, selector + " summary");
      const text = await ev(`document.querySelector(${J(selector + " details")}).innerText`);
      assert.doesNotMatch(text, /powershell|terminal|paste (?:the )?(?:install )?command|\bpaid\b|\bfree\b|\u2014/i);
      assert.match(text, /Check again/);
      const address = entry.id === "opencode" ? "https://opencode.ai/v1/docs/" : entry.id === "codex" ? "https://developers.openai.com/codex/cli" : entry.sources[0];
      await ev("window.__copied=[]"); await click(ev, selector + " [data-copy-address]");
      assert.deepEqual(await ev("window.__copied"), [address]);
      assert.equal(await ev(`document.querySelectorAll(${J(selector + " [data-copy]")}).length`), 0);
      assert.equal(await ev(`document.querySelector(${J(selector + ' [data-setting-action="install-cli"]')}).checkVisibility()`), true);
    }
    const mark = await sentCount(ev); await click(ev, "#s-tools [data-settings-refresh]");
    assert.equal((await sentSince(ev, "refreshSettings", mark)).length, 1);
  });
});
// The consent each tool shows before Install is pressed, written out by hand from the makers' published commands (independent of the page).
const CONSENT = {
  claude: "Downloads and runs Anthropic's installer from https://claude.ai/install.ps1 on this PC.",
  codex: "Downloads and runs OpenAI's installer from https://chatgpt.com/codex/install.ps1 on this PC.",
  opencode: "Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account.",
  copilot: "Downloads and checks GitHub Copilot CLI from its official releases, then installs it for your Windows account.",
  mistral: "Downloads and runs the uv installer from https://astral.sh/uv/install.ps1, then installs Mistral AI's mistral-vibe with uv on this PC. uv may also download Python.",
} as const;
// Every failure reason the server may publish, and the page's fixed words for Claude Code. [text, the row's one action]
const REASONS: Record<string, [string, string]> = {
  needsNode: ["Claude Code needs Node.js, which includes npm. Install it from nodejs.org, then press Check again.", "Check again"],
  needsGit: ["Claude Code needs Git for Windows. Install it from git-scm.com, then press Check again.", "Check again"],
  needsWinget: ["Claude Code needs App Installer. Get App Installer from the Microsoft Store, then press Check again.", "Check again"],
  needsPowerShell: ["Claude Code needs a newer PowerShell. Get PowerShell from the Microsoft Store, then press Check again.", "Check again"],
  downloadFailed: ["Could not download the installer. Check your internet connection, then try again.", "Install"],
  blockedByWindows: ["Windows or an administrator blocked the installation.", "Install"],
  notFoundAfterInstall: ["The installer finished, but Command Center could not find the tool. Press Check again.", "Check again"],
  cancelled: ["Installation stopped. Changes already made may remain.", "Install"],
  timeout: ["The installation took too long and was stopped. Check your internet connection, then try again.", "Install"],
  installFailed: ["The installation did not finish. Try again, or use Install by hand.", "Install"],
};
const NEVER_SAY = /\bpaid\b|\bfree\b|free tier|subscription|pricing|open (a )?powershell|press the windows key/i;

type Ev = (expression: string) => Promise<any>;
const row = (ev: Ev, cli: string): Promise<{ chip: string; detail: string; bad: boolean; buttons: string[]; bar: boolean; barValue: string | null }> => ev(`(()=>{const r=document.querySelector('#frunTools [data-cli=${J(cli)}]');
  const bar=r.querySelector('.frun-bar');return {chip:r.querySelector('.frun-chip').textContent,detail:r.querySelector('.frun-detail').textContent,bad:r.querySelector('.frun-detail').classList.contains('bad'),
  buttons:[...r.querySelector('.tool-row-action').querySelectorAll('button')].map((b)=>b.textContent),bar:Boolean(bar),barValue:bar?bar.getAttribute('aria-valuenow'):null}})()`);
// The server's install record for a tool, delivered with the rest of the state (catalogTools[id].action, the frozen contract).
const installState = (requestId: string, status: string, phase: string | null, reason: string | null = null) => ({ action: { requestId, kind: "install", status, phase, reason } });
const lockFacts = (ev: Ev) => ev(`(()=>({next:document.querySelector('#frunNext').disabled,back:document.querySelector('#frunBack').disabled,skip:document.querySelector('#frunSkip').disabled,why:document.querySelector('#frunWhy').textContent}))()`);
const visibleText = (ev: Ev): Promise<string> => ev(`document.querySelector('#first').innerText`);

test("P29 B4 forced Install clicks reject unknown and installed tools, and admit only a confirmed missing tool", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    await showFirstRun(ev, seed, CLAUDE_MISSING);
    await toToolStep(ev, FOLDER);
    for (const installed of [null, true, false]) {
      await showFirstRun(ev, seed, { ...CLAUDE_MISSING, claude: [installed, null] }, catalogChange({ claude: { installed } }));
      assert.equal(await ev(`Boolean(document.querySelector('[data-frun-install="claude"]'))`), installed === false,
        `installed=${installed}: Install exists only for confirmed absence`);
      const mark = await sentCount(ev);
      // A stale/forged DOM button must still go through the real delegated click handler's guard.
      await ev(`(()=>{const b=document.createElement('button');b.dataset.frunInstall='claude';document.querySelector('#frunTools').appendChild(b);b.click();b.remove();return true})()`);
      const sent = await sentSince(ev, "installCli", mark);
      assert.equal(sent.length, installed === false ? 1 : 0, `installed=${installed}: forced click checks current facts`);
      if (installed === false) {
        assert.deepEqual([sent[0].cli, sent[0].confirm], ["claude", true], "positive control: missing tool sends consent");
        await answer(ev, sent[0], "fixture finished");
      }
    }
  }, { fixture: "fixed" });
});

test("P29 B3 Install: consent shown before the click, the click sends exactly {type, requestId, cli, confirm:true}, progress, Cancel, every failure text, the step is held, focus checks wait", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const missing = Object.fromEntries(["copilot", "mistral"].map((id) => [id, { installed: false, registered: false }]));
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange(missing));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    // The consent sits next to Install before it is pressed, and Install is described by it.
    for (const [cli, text] of Object.entries(CONSENT)) {
      if (cli === "codex") continue; // Codex is Ready here; its consent is checked below with it missing
      assert.deepEqual(await ev(`(()=>{const b=document.querySelector('[data-frun-install=${J(cli)}]'),w=document.getElementById('frunWhy-'+${J(cli)});return [b?.textContent,b?.getAttribute('aria-describedby'),w?.textContent,w?.checkVisibility()]})()`),
        ["Install", `frunWhy-${cli}`, text, true], `${cli}: Install with its consent beside it`);
    }
    await showFirstRun(ev, seed, { ...CLAUDE_MISSING, codex: [false, null] }, catalogChange(missing));
    assert.equal(await ev(`document.getElementById('frunWhy-codex').textContent`), CONSENT.codex, "codex: its consent");
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange(missing));
    assert.doesNotMatch(await visibleText(ev), NEVER_SAY, "no paid-plan, free-tier or open-PowerShell words on the step");

    // The click IS the consent: one message, exactly these four fields, no second dialog.
    let mark = await sentCount(ev);
    await click(ev, '[data-frun-install="claude"]');
    const sent = await sentSince(ev, "installCli", mark);
    assert.equal(sent.length, 1, "one installCli");
    assert.deepEqual(Object.keys(sent[0]).sort(), ["cli", "confirm", "requestId", "type"], "exactly the four fields: no command, address, package or path");
    assert.deepEqual([sent[0].type, sent[0].cli, sent[0].confirm, typeof sent[0].requestId], ["installCli", "claude", true, "string"], "the row's own id and confirm:true");
    assert.equal(await ev(`document.querySelector('#confirmModal').hidden`), true, "no second confirmation");
    const id = sent[0].requestId;

    // Sent, not yet published: Installing, Checking, Cancel focused; the step is held; no second install; a focus check waits.
    assert.deepEqual(await row(ev, "claude"), { chip: "Installing", detail: "Checking Claude Code…", bad: false, buttons: ["Cancel"], bar: true, barValue: null });
    assert.equal(await ev(active), "frun-cancel-claude", "keyboard focus moves to Cancel");
    assert.deepEqual(await lockFacts(ev), { next: true, back: true, skip: true, why: "Wait for the installation to finish, or press Cancel." }, "Next, Back and Skip wait");
    assert.equal(await ev(`document.querySelector('[data-frun-install="opencode"]').disabled`), true, "no second Install while one runs");
    mark = await sentCount(ev);
    await ev(`(()=>{for(const s of ['#frunNext','#frunBack','[data-frun-install="opencode"]']){const b=document.querySelector(s);b.disabled=false;b.click();}window.dispatchEvent(new Event('focus'));return true})()`);
    assert.deepEqual([await stepOf(ev), await sentSince(ev, "installCli", mark), await sentSince(ev, "refreshSettings", mark)], ["tools", [], []], "forced Next/Back/Install do nothing; a window focus starts no check");
    const live = `document.querySelector('#frunLive')`;
    await ev(`(()=>{window.__live=${live};return true})()`);
    assert.deepEqual(await ev(`[${live}.textContent,${live}.getAttribute('aria-live')]`), ["Checking Claude Code…", "polite"], "the live line says it");

    // The server's phases, from its published state.
    for (const [phase, text] of [["checking", "Checking Claude Code…"], ["installing", "Downloading and installing Claude Code…"], ["verifying", "Looking for Claude Code…"]]) {
      await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "running", phase) }));
      assert.deepEqual(await row(ev, "claude"), { chip: "Installing", detail: text, bad: false, buttons: ["Cancel"], bar: true, barValue: null }, `${phase}: its words, an indeterminate bar, Cancel`);
      assert.deepEqual(await ev(`[window.__live===${live},${live}.textContent]`), [true, text], `${phase}: the same live line announces it`);
    }
    assert.equal(await ev(active), "frun-cancel-claude", "focus stays on Cancel through the broadcasts");

    // Cancel names the installation; a second press while stopping sends nothing.
    mark = await sentCount(ev);
    await click(ev, '[data-frun-cancel="claude"]');
    await click(ev, '[data-frun-cancel="claude"]');
    const stop = await sentSince(ev, "cancelCliInstall", mark);
    assert.equal(stop.length, 1, "one cancelCliInstall");
    assert.deepEqual(Object.keys(stop[0]).sort(), ["cli", "installRequestId", "requestId", "type"]);
    assert.deepEqual([stop[0].cli, stop[0].installRequestId], ["claude", id], "it names the running installation");
    assert.deepEqual([(await row(ev, "claude")).detail, (await row(ev, "claude")).buttons, await ev(`document.querySelector('[data-frun-cancel="claude"]').getAttribute('aria-disabled')`)], ["Stopping installation…", ["Stopping…"], "true"]);
    await answer(ev, stop[0]);
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "failed", null, "cancelled") }));
    await answer(ev, sent[0], "Installation stopped");
    assert.deepEqual(await row(ev, "claude"), { chip: "Not found", detail: REASONS.cancelled[0], bad: false, buttons: ["Install"], bar: false, barValue: null }, "stopped: its words, Install is back");
    assert.deepEqual(await lockFacts(ev), { next: false, back: false, skip: false, why: "" }, "the step is free again");

    // Every reason the server may publish: the page's own words, the right next step, never raw output.
    for (const [reason, [text, button]] of Object.entries(REASONS)) {
      await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "failed", null, reason) }));
      const shown = await row(ev, "claude");
      assert.deepEqual([shown.detail, shown.buttons], [text, [button]], `${reason}: words and action`);
      assert.doesNotMatch(shown.detail, NEVER_SAY, `${reason}: never asks for a terminal`);
    }
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "failed", null, null) }));
    assert.equal((await row(ev, "claude")).detail, REASONS.installFailed[0], "no reason: the plain failure");
    // Check again after a missing prerequisite sends a refresh.
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "failed", null, "needsNode") }));
    mark = await sentCount(ev);
    await click(ev, '[data-frun-recheck="claude"]');
    const check = await sentSince(ev, "refreshSettings", mark);
    assert.deepEqual(check.map((m) => Object.keys(m).sort()), [["requestId", "type"]], "Check again sends one refreshSettings"); await answer(ev, check[0]);

    // Cleanup not confirmed: the step stays held, Stop again names the same installation.
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ ...missing, claude: installState(id, "failed", null, "cleanupUnconfirmed") }));
    assert.deepEqual(await row(ev, "claude"), { chip: "Not confirmed", detail: "Could not confirm the installer stopped.", bad: true, buttons: ["Stop again"], bar: false, barValue: null });
    assert.equal(await ev(`Boolean(document.querySelector('[data-cli="claude"] .frun-chip .spin'))`), false, "unconfirmed cleanup never spins");
    assert.deepEqual(await lockFacts(ev), { next: true, back: true, skip: true, why: "Stop the installation before you go on." });
    mark = await sentCount(ev);
    await click(ev, '[data-frun-cancel="claude"]');
    assert.deepEqual((await sentSince(ev, "cancelCliInstall", mark)).map((m) => [m.cli, m.installRequestId]), [["claude", id]], "Stop again names it");
    assert.equal((await row(ev, "claude")).chip, "Not confirmed", "Stop again keeps the honest chip while cancellation is pending");

    // Done: the tool's real status takes over. A refusal before anything ran (the server's error) shows in plain words.
    await showFirstRun(ev, seed, { ...CLAUDE_MISSING, claude: [true, false] }, catalogChange({ ...missing, claude: installState(id, "done", null) }));
    assert.deepEqual((await row(ev, "claude")).buttons, ["Sign in"], "installed: Sign in comes next, never started by itself");
    assert.equal(await ev(`${live}.textContent`), "Claude Code is installed.");
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange(missing));
    mark = await sentCount(ev);
    await click(ev, '[data-frun-install="opencode"]');
    const [oc] = await sentSince(ev, "installCli", mark);
    await answer(ev, oc, "OpenCode is already installed");
    assert.deepEqual([(await row(ev, "opencode")).detail, (await row(ev, "opencode")).bad], ["Not installed: OpenCode is already installed.", true]);
    assert.deepEqual(await sentSince(ev, "cliLogin", 0), [], "installing never starts a sign-in");
    assert.doesNotMatch(await visibleText(ev), NEVER_SAY, "no paid-plan or free-tier words");
  }, { fixture: "fixed" });
});

test("P29 B3 Install: a reloaded page shows a running installation from the server's state, on the AI tool step, held, and Cancel names the server's installation", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, reload, page }) => {
    await reload();
    const running = catalogChange({ claude: installState("server-install-1", "running", "installing") });
    await showFirstRun(ev, seed, CLAUDE_MISSING, running);
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    assert.equal(await stepOf(ev), "tools", "the wizard opens on the AI tool step, not Welcome");
    assert.deepEqual(await row(ev, "claude"), { chip: "Installing", detail: "Downloading and installing Claude Code…", bad: false, buttons: ["Cancel"], bar: true, barValue: null });
    assert.deepEqual(await lockFacts(ev), { next: true, back: true, skip: true, why: "Wait for the installation to finish, or press Cancel." });
    // Tab from the heading reaches Cancel; the rows that have no action add no stops.
    await ev(`(()=>{document.querySelector('#frunH-tools').focus();return true})()`);
    const order: string[] = [];
    for (let i = 0; i < 5; i++) { await press(page, "Tab"); order.push(await ev(active)); }
    assert.deepEqual(order, ["frunCheck", "frunGuideCopy", "frunSearch", "frun-cancel-claude", "frun-help-opencode"], "Cancel is in the tab order right after the search; the held Install is skipped");
    assert.equal(await ev(`document.querySelector('[data-frun-install="opencode"]').disabled`), true, "another Install is off while the server runs one");
    const mark = await sentCount(ev);
    await ev(`(()=>{const b=document.querySelector('[data-frun-install="opencode"]');b.disabled=false;b.click();return true})()`);
    assert.deepEqual(await sentSince(ev, "installCli", mark), [], "a forced Install sends nothing while the server runs one");
    await click(ev, '[data-frun-cancel="claude"]');
    assert.deepEqual((await sentSince(ev, "cancelCliInstall", mark)).map((m) => [m.cli, m.installRequestId]), [["claude", "server-install-1"]], "Cancel names the server's installation");
  }, { fixture: "fixed" });
});

test("P29 B3 Connect and Settings: Connect sends exactly {type, requestId, cli, confirm:true} and installs nothing; Settings keeps the official guide collapsed under Install by hand and asks consent", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    await showFirstRun(ev, seed, CLAUDE_MISSING, catalogChange({ kimi: { installed: true, version: "1.0.0", signedIn: true, registered: false, leaderEligible: false } }));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    assert.deepEqual(await row(ev, "kimi"), { chip: "Installed", detail: "Installed. Leader connection not verified.", bad: false, buttons: ["Connect"], bar: false, barValue: null });
    let mark = await sentCount(ev);
    await click(ev, '[data-frun-connect="kimi"]');
    await click(ev, '[data-frun-connect="kimi"]');
    const link = await sentSince(ev, "registerCatalogCli", mark);
    assert.equal(link.length, 1, "one registerCatalogCli; a second press while it runs sends nothing");
    assert.deepEqual(Object.keys(link[0]).sort(), ["cli", "confirm", "requestId", "type"]);
    assert.deepEqual([link[0].cli, link[0].confirm, await sentSince(ev, "installCli", mark)], ["kimi", true, []], "Connect names the tool and installs nothing");
    await answer(ev, link[0], "Installed. Connection could not be added. Conflicting saved connection; preserved");
    assert.deepEqual([(await row(ev, "kimi")).detail, (await row(ev, "kimi")).bad], ["Installed. Connection could not be added. Conflicting saved connection; preserved.", true]);
    assert.equal(await ev(`document.querySelector('#frunLeader input[value^="acp:"]')`), null, "an unverified tool is never a leader choice");

    // Settings, outside setup: the row shows the maker's command from the catalog, and Install's confirmation says what it downloads.
    const claude = seed.cliCatalog.find((entry: any) => entry.id === "claude");
    await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(CLAUDE_MISSING)}${CATALOG_QUIET}`);
    await click(ev, "#setBtn");
    await waitFor(`Boolean(document.querySelector('#s-tools [data-tool-row][data-cli="claude"]'))`, "Settings tool rows");
    const rowText = await ev(`(()=>{const r=document.querySelector('#s-tools [data-tool-row][data-cli="claude"]');return {cmd:r.querySelector('.cmd code')?.textContent,copy:r.querySelector('[data-copy-address]')?.dataset.copyAddress,help:document.querySelector('#s-tools .settings-help').textContent}})()`);
    assert.deepEqual([rowText.cmd, rowText.copy], [claude.sources[0], claude.sources[0]], "the maker's command from the catalog, never npm for Claude");
    assert.doesNotMatch(rowText.help, /npm/, "the help line no longer says npm");
    assert.deepEqual(await ev(`(()=>{const r=document.querySelector('#s-tools [data-cli="claude"]');return [r.querySelector('summary').textContent,r.querySelector('details').open,r.querySelector('.cmd code').checkVisibility(),r.querySelector('[data-setting-action="install-cli"]').checkVisibility()]})()`), ["Install by hand", false, false, true]);
    mark = await sentCount(ev);
    await click(ev, '#s-tools [data-setting-action="install-cli"][data-cli="claude"]');
    await waitFor(`!document.querySelector('#confirmModal').hidden`, "Install confirmation");
    assert.equal(await ev(`document.querySelector('#confirmBody').textContent`), `${CONSENT.claude} Signing in comes after.`);
    await click(ev, "#confirmOk");
    const fromSettings = await sentSince(ev, "installCli", mark);
    assert.deepEqual(fromSettings.map((m) => [Object.keys(m).sort(), m.cli, m.confirm]), [[["cli", "confirm", "requestId", "type"], "claude", true]], "Settings' Install: the same four fields");
    await deliver(ev, { type: "actionResult", action: "installCli", requestId: fromSettings[0].requestId });
  }, { fixture: "fixed" });
});
