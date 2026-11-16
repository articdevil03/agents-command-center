import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { editorTestMs, J, withPage, skipped, click, deliverState, press } from "./pack18-editor-harness.ts";
import { answer, catalogChange, sentCount, sentSince, showFirstRun, stepOf, toolsChange, CATALOG_QUIET } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";
import { CLI_KEY_PROFILES, keyProfile } from "../server/settings/cli-key-profiles.ts";

const KEY = "ccTEST-KEY-" + randomUUID();
const NONE = { claude: [false, null], codex: [false, null], opencode: [false, null] } as const;
const fieldsFor = (cli: string) => Object.fromEntries(CLI_KEY_PROFILES[cli].map((field) => [field.id, field.kind === "secret" ? KEY : field.kind === "choice" ? field.choices![0].value : cli === "mimo" ? "model-1 " : "provider/model-1 "]));
const profiles = (saved: boolean) => catalogChange(Object.fromEntries(Object.keys(CLI_KEY_PROFILES).map((cli) => [cli, { installed: true, version: "1.0.0", signedIn: null, registered: false, keySaved: saved, keyProfile: keyProfile(cli) }])));

test("shared catalog key panel through real wizard and Settings listeners, clearing and action states", { timeout: editorTestMs(240_000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed, page }) => {
    const show = async (surface: string, saved = false) => {
      if (surface === "wizard") { await showFirstRun(ev, seed, NONE, profiles(saved)); if (await stepOf(ev) !== "tools") await toToolStep(ev, "C:\\work\\KeyFlow"); }
      else { await deliverState(ev, seed, `state.firstRun={required:false};${toolsChange(NONE)}${CATALOG_QUIET}${profiles(saved)}`); await ev("openSettings(undefined,'tools');true"); }
    };
    for (const surface of ["wizard", "settings"]) {
      await show(surface);
      const scope = surface === "wizard" ? "#frunTools" : "#s-tools";
      assert.equal(await ev(`document.querySelectorAll(${J(scope + ' [data-cli-key-slot="claude"] .cli-key-panel')}).length`), 0);
      if (surface === "settings") for (const cli of ["kimi", "grok", "copilot"]) assert.equal(await ev(`Boolean(document.querySelector('[data-setting-action="login-cli"][data-cli="${cli}"]'))`), !Boolean(await ev(`serverState.settings.catalogTools.${cli}.keySaved`)) && Boolean(await ev(`cliLoginUi.offered('${cli}')`)));
      for (const cli of Object.keys(CLI_KEY_PROFILES)) {
        const panel = `${scope} [data-cli-key-slot="${cli}"]`;
        await click(ev, panel + ' [data-key-act="add"]');
        const fields = fieldsFor(cli);
        assert.deepEqual(await ev(`[...document.querySelectorAll(${J(panel + ' [data-key-field]')})].map(i=>i.dataset.keyField)`), Object.keys(fields));
        assert.deepEqual(await ev(`(()=>{const i=document.querySelector(${J(panel + ' input[type="password"]')});return [i.autocomplete,i.spellcheck,i.name,i.value]})()`), ["off", false, "", ""]);
        for (const field of CLI_KEY_PROFILES[cli]) {
          if (field.kind === "choice") assert.deepEqual(await ev(`[...document.querySelector(${J(panel + ' select')}).options].map(o=>[o.textContent,o.value])`), field.choices!.map((choice) => [choice.label, choice.value]));
        }
        await ev(`(()=>{const p=document.querySelector(${J(panel)}),fields=${J(fields)};for(const i of p.querySelectorAll('[data-key-field]'))i.value=fields[i.dataset.keyField];window.__keyInputs=[...p.querySelectorAll('input,select')];return true})()`);
        if (surface === "settings") {
          assert.equal(await ev(`Boolean([...document.querySelectorAll(${J(panel + ' input, ' + panel + ' select, ' + panel + ' button')})].every(i=>i.dataset.focusKey))`), true);
          for (const id of ["key", ...(fields.model ? ["model"] : [])]) {
            const selector = panel + ` [data-key-field="${id}"]`;
            const focus = await ev(`(()=>{const i=document.querySelector(${J(selector)});i.focus();i.setSelectionRange(2,5,'backward');return i.dataset.focusKey})()`);
            if (id === "key") assert.equal(await ev("settingsFocusSnapshot(document.querySelector('#setBody')).value"), null);
            await ev("window.__ccDeliver({...structuredClone(serverState),type:'state'});true");
            assert.deepEqual(await ev(`(()=>{const i=document.activeElement;return [i.dataset.focusKey,i.selectionStart,i.selectionEnd,i.selectionDirection,i.value]})()`), [focus, 2, 5, "backward", fields[id]]);
            if (id === "key") assert.equal(await ev(`JSON.stringify([...settingsDraftSnapshot(document.querySelector('#setBody'))]).includes(${J(KEY)})`), false);
          }
        } else await ev("renderAll();true");
        assert.equal(await ev(`document.querySelector(${J(panel + ' input[type="password"]')}).value`), KEY, "typing survives a state redraw in its original DOM node, without a draft");
        // The wire fake is allowed to observe the key. All retained UI state must be empty before crossing it.
        await ev(`(()=>{window.__keySend=send;window.__keyBoundary=[];send=(m)=>{if(m.type==='submitCliKey')window.__keyBoundary.push(window.__keyInputs.map(i=>i.value));return window.__keySend(m)};return true})()`);
        const mark = await sentCount(ev);
        await click(ev, panel + ' [data-key-act="save"]');
        assert.deepEqual(await ev("window.__keyBoundary"), [Object.entries(fields).map(([id, value]) => id === "key" ? "" : value)]);
        assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="save"]')}).disabled`), true);
        await ev(`(()=>{document.querySelector(${J(panel + ' form')}).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
        const requests = await sentSince(ev, "submitCliKey", mark);
        assert.equal(requests.length, 1);
        // A pasted trailing space in a text field is trimmed before it is sent; secrets and choices are sent exactly.
        assert.deepEqual(requests[0], { type: "submitCliKey", requestId: requests[0].requestId, cli, fields: Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, id === "model" ? value.trim() : value])) });
        await ev("send=window.__keySend;true");
        assert.deepEqual(await ev(`(()=>{const needle=${J(KEY)},hits=[];if(document.documentElement.outerHTML.includes(needle))hits.push('markup');if([...document.querySelectorAll('input,select')].some(i=>i.value.includes(needle)))hits.push('value');for(const s of [localStorage,sessionStorage])for(let n=0;n<s.length;n++)if((s.key(n)+s.getItem(s.key(n))).includes(needle))hits.push('storage');for(const [name,v] of Object.entries({serverState,drafts:[...settingsDraftSnapshot(document.querySelector('#setBody'))],submits:[...settingsSubmits],pending:[...pendingSettingsActions],edits:[...settingsEdits],chatDrafts:[...draftsByTab]}))if(JSON.stringify(v).includes(needle))hits.push(name);return hits})()`), []);
        await answer(ev, requests[0], "Choose an allowed region.");
        assert.match(await ev(`document.querySelector(${J(panel)}).textContent`), /Choose an allowed region\./);
        assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="save"]')}).disabled`), false);
        assert.deepEqual(await ev(`Object.fromEntries([...document.querySelectorAll(${J(panel + ' [data-key-field]')})].map(i=>[i.dataset.keyField,i.value]))`), { ...fields, key: "" });
        await ev(`(()=>{const p=document.querySelector(${J(panel)}),fields=${J(fields)};for(const i of p.querySelectorAll('[data-key-field]'))i.value=fields[i.dataset.keyField];p.querySelector('input').focus();return true})()`);
        const retryMark = await sentCount(ev); await press(page, "Enter");
        const [retry] = await sentSince(ev, "submitCliKey", retryMark); await answer(ev, retry);
      }
      await show(surface, true);
      if (surface === "settings") {
        const gemini = (registered: boolean) => ev(`(()=>{const s=structuredClone(serverState);s.settings.catalogTools.gemini.registered=${registered};window.__ccDeliver({...s,type:'state'});return true})()`);
        await gemini(true);
        const subtitle = await ev(`document.querySelector('[data-tool-row][data-cli="gemini"] [data-tool-subtitle]').textContent`);
        await gemini(false);
        assert.match(subtitle, /^Installed · Key saved/); assert.doesNotMatch(subtitle, /Not signed in/);
      }
      if (surface === "wizard") {
        assert.equal(await ev(`document.querySelector('${scope} [data-cli-key-slot="kimi"] [data-key-field="model"]').placeholder`), "kimi-for-coding");
      }
      if (surface === "settings") for (const cli of ["kimi", "grok", "copilot"]) assert.equal(await ev(`Boolean(document.querySelector('[data-setting-action="login-cli"][data-cli="${cli}"]'))`), !Boolean(await ev(`serverState.settings.catalogTools.${cli}.keySaved`)) && Boolean(await ev(`cliLoginUi.offered('${cli}')`)));
      for (const cli of Object.keys(CLI_KEY_PROFILES)) {
        const panel = `${scope} [data-cli-key-slot="${cli}"]`;
        assert.match(await ev(`document.querySelector(${J(panel)}).textContent`), /Key saved\. Connection checked when you first chat\./);
        await click(ev, panel + ' [data-key-act="replace"]');
        assert.equal(await ev(`[...document.querySelectorAll(${J(panel + ' input, ' + panel + ' select')})].every(i=>i.value==='')`), true);
        await ev(`(()=>{const i=document.querySelector(${J(panel + ' input[type="password"]')});i.value=${J(KEY)};return true})()`);
        const cancelMark = await sentCount(ev);
        await click(ev, panel + ' [data-key-act="cancel"]');
        assert.equal(await ev(`document.querySelector(${J(panel + ' form')}).hidden`), true);
        assert.equal(await ev(`document.querySelector(${J(panel + ' input[type="password"]')}).value`), "");
        assert.deepEqual(await sentSince(ev, "submitCliKey", cancelMark), []);
        assert.deepEqual(await sentSince(ev, "removeCliKey", cancelMark), []);
        assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="replace"]')}).hidden`), false);
        await click(ev, panel + ' [data-key-act="replace"]');
        const mark = await sentCount(ev); await click(ev, panel + ' [data-key-act="remove"]');
        const [request] = await sentSince(ev, "removeCliKey", mark);
        assert.deepEqual(request, { type: "removeCliKey", requestId: request.requestId, cli }); await answer(ev, request);
      }
      // An installed saved key leaves the ACP Connect action available with signedIn false.
      const connect = surface === "wizard" ? '[data-frun-connect="qwen"]' : '[data-setting-action="connect-cli"][data-cli="qwen"]';
      assert.equal(await ev(`Boolean(document.querySelector(${J(scope + " " + connect)}))`), true);
      await ev(`(()=>{document.body.classList.add('light');return true})()`);
      await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      if (surface === "wizard") {
        await ev("(()=>{const s=document.querySelector('#frunSearch');s.value='qwen';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
        await click(ev, scope + ' [data-cli-key-slot="qwen"] [data-key-act="replace"]');
        await ev(`(()=>{document.querySelector('#frunTools [data-cli-key-slot="qwen"] select').selectedIndex=0;return true})()`);
      }
      await ev("document.querySelector('#toast').hidden=true;true");
      // Screenshots only when asked for, into a folder the caller names; a shipping test writes nothing into the repo.
      if (process.env.CC_PAGE_SHOTS) {
        const screenshot = await page("Page.captureScreenshot", { format: "png" });
        mkdirSync(process.env.CC_PAGE_SHOTS, { recursive: true }); writeFileSync(join(process.env.CC_PAGE_SHOTS, `${surface}.png`), Buffer.from(screenshot.result.data, "base64"));
      }
    }
  }, { fixture: "fixed" });
});
