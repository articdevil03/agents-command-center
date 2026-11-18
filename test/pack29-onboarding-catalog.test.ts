import test from "node:test";
import assert from "node:assert/strict";
import { editorTestMs, J, withPage, skipped, click } from "./pack18-editor-harness.ts";
import { AUDIT_JS } from "./overlap-audit-js.ts";
import { auditScrolled, catalogChange, footer, guide, showFirstRun } from "./pack29-onboarding-page.setup.ts";
import { acpChange, leaderChoices, toToolStep, typeInto, activeId } from "./pack29-onboarding-page-acp.setup.ts";

// Pack 29 B3: the whole catalog on the setup wizard's AI tool step, walked from the REAL list the real server publishes (state.cliCatalog).
// The ids below are the server catalog's (server/settings/cli-catalog.ts); a missing, extra or swapped entry goes RED with its id printed.
const FOLDER = "C:\\work\\My App";
const REAL_IDS = ["claude", "codex", "opencode", "grok", "gemini", "copilot", "qwen", "kimi", "mimo", "mistral", "minimax", "deepseek", "glm", "nemotron", "perplexity", "muse"];
const PROVIDERS = ["deepseek", "glm", "nemotron", "perplexity", "muse"];
const NONE_READY = { claude: [false, null], codex: [false, null], opencode: [false, null] } as const;
const CLAUDE_READY = { claude: [true, true], codex: [false, null], opencode: [false, null] } as const;
const MUSE = "No verified official installation or supported provider connection yet.";
const NOT_VERIFIED = "Installed. Leader connection not verified.";

type Ev = (expression: string) => Promise<any>;
// Every row on the step as a person sees it: where it is, its chip, its line, its buttons.
const catalogRows = (ev: Ev): Promise<Array<{ id: string; group: string; chip: string; line: string; buttons: string[]; shown: boolean }>> => ev(`[...document.querySelectorAll('#frunTools .frun-tool,#frunProviders .frun-provider')].map((r)=>({
  id:r.dataset.cli||r.dataset.provider,group:r.closest('#frunProviders')?'models':'lead',chip:r.querySelector('.frun-chip').textContent,line:r.querySelector('small').textContent,
  buttons:[...r.querySelectorAll('button')].filter((b)=>!b.closest('[hidden]')).map((b)=>b.textContent),shown:r.checkVisibility()}))`);
const everyMissing = (seed: any) => catalogChange(Object.fromEntries(seed.cliCatalog.filter((e: any) => e.installable && !["claude", "codex", "opencode"].includes(e.id)).map((e: any) => [e.id, { installed: false, registered: false, leaderEligible: false }])));

test("P29 B3 catalog: every real catalog entry has its row, in its group, with the right one action; models used through OpenCode never offer Install or a leader; installed is never ready to lead without the server's leaderEligible", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    const ids = (seed.cliCatalog ?? []).map((entry: any) => entry.id);
    assert.ok(ids.length > 0, "control: the real server published a catalog (an empty list must fail)");
    assert.deepEqual(ids, REAL_IDS, `the real catalog ids, in order (missing: ${J(REAL_IDS.filter((id) => !ids.includes(id)))}, extra: ${J(ids.filter((id: string) => !REAL_IDS.includes(id)))})`);
    assert.deepEqual(seed.cliCatalog.filter((e: any) => !e.installable).map((e: any) => e.id), PROVIDERS, "the provider-only entries");

    // Every tool not found: each installable entry offers Install (with its consent), each provider entry offers nothing.
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    const shown = await catalogRows(ev);
    let walked = 0;
    for (const entry of seed.cliCatalog) {
      const found = shown.filter((r) => r.id === entry.id);
      assert.equal(found.length, 1, `${entry.id}: exactly one row (found ${found.length})`);
      const [r] = found;
      if (entry.installable) {
        assert.deepEqual([r.group, r.chip, r.buttons], ["lead", "Not found", (entry.id === "copilot" ? ["Install"] : ["Install", entry.id === "opencode" ? "How to set up" : "How to set up"])], `${entry.id}: Install and the fallback (OpenCode installs in the app, so its fallback says How to set up)`);
        const consent = await ev(`document.getElementById('frunWhy-'+${J(entry.id)})?.textContent ?? ''`);
        assert.ok(consent.startsWith("Downloads and ") && consent.includes(`${entry.vendor}'s`) && consent.endsWith("on this PC.") || consent.includes("uv may also download Python.") || (entry.id === "opencode" && consent === "Downloads and checks OpenCode 1 from its official releases, then installs it for your Windows account.") || (entry.id === "copilot" && consent === "Downloads and checks GitHub Copilot CLI from its official releases, then installs it for your Windows account."), `${entry.id}: the consent names the maker (${consent})`);
      } else {
        assert.deepEqual([r.group, r.buttons], ["models", []], `${entry.id}: in the models group, with no button at all`);
        assert.equal(await ev(`Boolean(document.querySelector('[data-frun-install=${J(entry.id)}],[data-frun-connect=${J(entry.id)}],[data-frun-login=${J(entry.id)}]'))`), false, `${entry.id}: no Install, Connect or Sign in`);
      }
      walked += 1;
    }
    assert.equal(walked, REAL_IDS.length, "every catalog entry was walked");
    assert.equal(shown.find((r) => r.id === "muse")?.line, MUSE, "Muse says honestly that it has no verified installation");
    assert.deepEqual(shown.filter((r) => r.group === "lead").slice(0, 3).map((r) => r.id), ["claude", "codex", "opencode"], "the built-in three stay at the top");
    assert.deepEqual(await leaderChoices(ev), [], "nothing found: no leader choice at all, no provider is ever one");
    // Go to OpenCode brings the OpenCode row's action into focus.
    await click(ev, "[data-frun-to-opencode]");
    assert.equal(await activeId(ev), "frun-install-opencode", "Go to OpenCode focuses OpenCode's Install");

    // One ACP catalog tool through its states: unknown, installed but not saved, saved but not verified, verified (leaderEligible).
    const kimi = seed.cliCatalog.find((e: any) => e.id === "kimi");
    const kimiSaved = { id: kimi.leader.connectionId, name: "Command Center Kimi Code", program: "kimi", args: ["acp"], kind: `acp:${kimi.leader.connectionId}` };
    const states: Array<[string, Record<string, unknown>, unknown[], string, string, string[]]> = [
      ["unknown", { installed: null, registered: false, leaderEligible: false }, [], "Unknown", "Not checked yet. Press Check again.", ["Check again", "How to set up"]],
      ["installed, not saved", { installed: true, version: "1.0.0", signedIn: true, registered: false, leaderEligible: false }, [], "Installed", NOT_VERIFIED, ["Connect"]],
      // Kimi has no managed sign-in (Pack 29 W5): never a Sign in button, its unsupported line instead (pack29-cli-login-page.test.ts).
      ["installed, not signed in", { installed: true, version: "1.0.0", signedIn: false, registered: false, leaderEligible: false }, [], "Installed", NOT_VERIFIED, ["Connect"]],
      ["saved, not verified", { installed: true, version: "1.0.0", signedIn: true, registered: true, leaderEligible: false }, [{ ...kimiSaved, leaderEligible: false }], "Installed", NOT_VERIFIED, []],
      // May lead: never "Ready" or "ready to lead" until the server says it was tested.
      ["untested eligible", { installed: true, version: "1.0.0", signedIn: false, registered: true, leaderEligible: true, tested: false, leaderLabel: "Not tested yet", connection: "unknown" }, [{ ...kimiSaved, leaderEligible: true, tested: false, leaderLabel: "Not tested yet" }], "Not tested yet", "Not tested yet. Connection checked when you first chat.", []],
    ];
    for (const [label, facts, saved, chip, line, buttons] of states) {
      await showFirstRun(ev, seed, CLAUDE_READY, `${catalogChange({ kimi: facts })}${acpChange(saved as any)}`);
      const r = (await catalogRows(ev)).find((item) => item.id === "kimi")!;
      assert.deepEqual([r.chip, r.line, r.buttons], [chip, line, buttons], `kimi ${label}: chip, line, action`);
      assert.equal(await ev(`[...document.querySelectorAll('#frunAcpRows .frun-acp')].length`), 0, `kimi ${label}: never a second "Added" row`);
      const choices = (await leaderChoices(ev)).map(([value]) => value);
      assert.equal(choices.includes(kimiSaved.kind), label === "untested eligible", `kimi ${label}: a leader choice only once the server says it may lead (${J(choices)})`);
    }
    // The verified tool leads only with the Full access tick, like any ACP tool.
    await click(ev, `#frunLeader input[value="${kimiSaved.kind}"]`);
    assert.deepEqual([(await footer(ev)).nextDisabled, (await footer(ev)).why], [true, "Tick the Full access box to use Command Center Kimi Code."]);
    // Gemini: no documented sign-in command, so no Sign in button; it can still be connected.
    await showFirstRun(ev, seed, CLAUDE_READY, catalogChange({ gemini: { installed: true, version: "1.0.0", signedIn: false, registered: false, leaderEligible: false } }) + `state.settings.tools.gemini={installed:true,version:'1.0.0',signedIn:false};`);
    assert.deepEqual((await catalogRows(ev)).find((item) => item.id === "gemini")!.buttons, ["Connect"], "gemini: Connect, never an invented sign-in");
  }, { fixture: "fixed" });
});

test("P29 B3 catalog: search filters both groups, says when nothing matches, never hides a running installation, and the search text, open guides and focus survive broadcasts", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed }) => {
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    const visible = async () => (await catalogRows(ev)).filter((r) => r.shown).map((r) => r.id);
    const boxes = () => ev(`[document.querySelector('#frunLeadBox').hidden,document.querySelector('#frunModelBox').hidden,document.querySelector('#frunNoMatch').textContent]`);
    assert.equal((await visible()).length, REAL_IDS.length, "control: every row shows with no search");
    await typeInto(ev, "frunSearch", "KIMI");
    assert.deepEqual([await visible(), await boxes()], [["kimi"], [false, true, ""]], "kimi: one row; the empty models group hides");
    await typeInto(ev, "frunSearch", "nvidia");
    assert.deepEqual([await visible(), await boxes()], [["nemotron"], [true, false, ""]], "a maker's name finds its model");
    await typeInto(ev, "frunSearch", "zzz");
    assert.deepEqual([await visible(), await boxes()], [[], [true, true, "No tool or model matches “zzz”."]], "nothing matches: it says so");
    // The search field keeps its text, caret and focus through a broadcast; an open guide stays open.
    await typeInto(ev, "frunSearch", "grok");
    await click(ev, '[data-frun-help="grok"]');
    await ev(`(()=>{const s=document.querySelector('#frunSearch');window.__search=s;s.focus();s.setSelectionRange(1,3);return true})()`);
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed));
    assert.deepEqual(await ev(`[document.activeElement===window.__search,window.__search.value,window.__search.selectionStart,window.__search.selectionEnd]`), [true, "grok", 1, 3], "the search field keeps text, selection and focus");
    assert.deepEqual([await visible(), (await guide(ev, "grok")).shown], [["grok"], true], "the filter and the open guide survive");
    // Focus on a row's button survives a broadcast that redraws the rows.
    await ev(`(()=>{document.querySelector('[data-frun-install="grok"]').focus();return true})()`);
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed) + catalogChange({ grok: { version: "x" } }));
    assert.equal(await activeId(ev), "frun-install-grok", "focus stays on Grok's Install through a redraw");
    // A running installation is never filtered away: its Cancel stays reachable.
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed) + catalogChange({ claude: { action: { requestId: "r1", kind: "install", status: "running", phase: "installing", reason: null } } }));
    assert.deepEqual(await visible(), ["claude", "grok"], "searching grok still shows the installing Claude Code row");
    assert.equal(await ev(`Boolean(document.querySelector('[data-frun-cancel="claude"]')?.checkVisibility())`), true, "its Cancel is on screen");
  }, { fixture: "fixed" });
});

test("P29 B3 catalog layout: no overlap or clipping at 900x600 and 1296x1030, light and dark, with the longest guides open, a running and a failed row; the footer stays in view", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, waitFor, seed, page }) => {
    const busy = catalogChange({ codex: { action: { requestId: "r1", kind: "install", status: "running", phase: "installing", reason: null } },
      grok: { action: { requestId: "r0", kind: "install", status: "failed", phase: null, reason: "notFoundAfterInstall" } }, copilot: { action: { requestId: "r2", kind: "install", status: "failed", phase: null, reason: "installFailed" } } });
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed));
    await waitFor(`Boolean(document.querySelector('#first .frun'))`, "setup wizard FOUND");
    await toToolStep(ev, FOLDER);
    // The two longest guides: OpenCode (its note) and Mistral (its two-step command), opened before the installation holds the step.
    for (const id of ["opencode", "mistral"]) await click(ev, `[data-frun-help="${id}"]`);
    await showFirstRun(ev, seed, NONE_READY, everyMissing(seed) + busy);
    assert.deepEqual([(await guide(ev, "opencode")).shown, (await guide(ev, "mistral")).shown, await ev(`Boolean(document.querySelector('[data-cli="codex"] .frun-bar'))`)], [true, true, true], "control: both guides open, Codex installing");
    await ev(`${AUDIT_JS};true`);
    for (const [width, height] of [[900, 600], [1296, 1030]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      for (const theme of ["light", "dark"]) {
        await ev(`(()=>{document.body.classList.toggle('light',${J(theme === "light")});return true})()`);
        await auditScrolled(ev, `catalog ${width}x${height} ${theme}`, 2);
      }
    }
  }, { fixture: "fixed" });
});


test("all eight catalog ACP choices are selectable as Not tested yet without automatic selection", { timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  const { CLI_CATALOG } = await import("../server/settings/cli-catalog.ts");
  const { catalogProfile } = await import("../server/settings/catalog-acp.ts");
  await withPage(async ({ ev, seed }) => {
    const entries = CLI_CATALOG.filter((entry) => entry.leader.kind === "acp");
    assert.equal(entries.length, 8, "all eight real profiles FOUND");
    const saved = entries.map((entry) => ({ ...catalogProfile(entry), kind: `acp:${catalogProfile(entry).id}`, leaderEligible: true, tested: false, leaderLabel: "Not tested yet" }));
    const facts = Object.fromEntries(entries.map((entry) => [entry.id, { installed: true, version: "1.2.3", signedIn: null, registered: true, leaderEligible: true, tested: false, leaderLabel: "Not tested yet", connection: "unknown" }]));
    await showFirstRun(ev, seed, NONE_READY, catalogChange(facts) + acpChange(saved) + `state.settings.tools.gemini={installed:true,version:'1.2.3',signedIn:null};`);
    await toToolStep(ev, FOLDER);
    assert.deepEqual(await leaderChoices(ev), saved.map((cli) => [cli.kind, false]), "none automatically chosen");
    for (const cli of saved) {
      assert.equal(await ev(`document.querySelector('#frunLeader input[value="${cli.kind}"]').closest('label').querySelector('.frun-untested').textContent`), "Not tested yet", cli.id);
      await click(ev, `#frunLeader input[value="${cli.kind}"]`);
      assert.equal(await ev("document.querySelector('#frunConsent').checked"), false, "changing leader clears consent");
      assert.equal(await ev("document.querySelector('#frunUntested').textContent"), "Not tested yet. Connection checked when you first chat.");
      assert.equal(await ev("document.querySelector('#frunNext').disabled"), true);
      await click(ev, "#frunConsent");
      assert.equal(await ev("document.querySelector('#frunNext').disabled"), false);
    }
  }, { fixture: "fixed" });
});
