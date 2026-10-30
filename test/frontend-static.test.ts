import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { appSource as readAppSource, harnessSource, sourceText, styleSource } from "./source-text.ts";
import { publicDir, appSource, CLIS, pageHarness, plain } from "./frontend-helpers.ts";

const PRESETS = ["atlas", "sonny", "vera", "sol", "nova", "terra", "pip", "momo", "juno", "ziggy", "rumi", "kiki", "bo", "fig", "dune", "sage", "mel", "ollie", "taro", "ash"];

test("the twenty flat picture presets ship as safe, self-contained SVG files", () => {
  const shipped = readdirSync(join(publicDir, "avatars")).filter((name) => name.endsWith(".svg")).map((name) => name.slice(0, -4)).sort();
  assert.deepEqual(shipped, [...PRESETS].sort(), "public/avatars holds exactly the twenty presets");
  for (const name of PRESETS) {
    const path = join(publicDir, "avatars", `${name}.svg`);
    assert.ok(existsSync(path), `preset file exists: public/avatars/${name}.svg`);
    const svg = readFileSync(path, "utf8");
    assert.match(svg.trimStart(), /^(?:<\?xml[^>]*>\s*)?<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}.svg is an SVG document`);
    assert.match(svg.trimEnd(), /<\/svg>$/, `${name}.svg ends its svg element`);
    assert.doesNotMatch(svg, /<script/i, `${name}.svg has no script`);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${name}.svg has no on* event attribute`);
    assert.doesNotMatch(svg, /\b(?:xlink:)?href\s*=\s*["'](?!#)/i, `${name}.svg links nothing outside itself`);
    assert.doesNotMatch(svg, /url\(\s*["']?(?!#)/i, `${name}.svg loads no outside url()`);
    assert.doesNotMatch(svg, /<(?:foreignObject|iframe|object|embed|image)\b/i, `${name}.svg embeds nothing`);
  }
  // The picker offers exactly the presets that ship, in the approved order; it can never offer a missing file.
  const app = readAppSource();
  const listed = /const AVATAR_PRESETS = \[([^\]]+)\];/.exec(app)?.[1].match(/"([a-z]+)"/g)?.map((item) => item.slice(1, -1));
  assert.deepEqual(listed, PRESETS, "app.js AVATAR_PRESETS matches the shipped files and order");
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<script\b[^>]*\bsrc="\/logos\.js"/);
  assert.ok(readFileSync(join(publicDir, "logos.js"), "utf8").length > 0, "logos load from their public file");
  assert.match(index, /<link\b[^>]*\brel="icon"[^>]*\bhref="data:image\/svg\+xml,/, "the Orbit mark is the favicon");
});

test("real renderer contains no demo-only actions or seeded mock data", () => {
  const app = readAppSource();
  assert.doesNotMatch(app, /\b(?:demoAction|roundDemo|fakeFolder|demoMakerId|SAMPLE_LOGS|PROJECTS|REQUESTS)\b/);
  assert.match(app, /No runs yet/);
});

test("the front end never claims the leader is Claude-only (it runs on Claude, Codex or OpenCode)", () => {
  for (const file of ["app.js", "index.html"]) {
    const text = sourceText(`public/${file}`);
    assert.doesNotMatch(text, /comes with the crew|leader stays on Claude|needs Claude Code for the leader/i, `public/${file}`);
  }
  // The Advisor rows (Usage panel, Settings, the seat card) are checked in the real app, per leader CLI: test/browser-harness/*.js "a Codex leader: Settings and the Usage panel show no Advisor".
});

test("renderAll's focus layers cover every popover and modal in index.html", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const layers = [...index.matchAll(/<div\b[^>]*\brole="(?:alert)?dialog"[^>]*>/g)].map((m) => m[0]);
  assert.ok(layers.length >= 15, `found the dialog layers (${layers.length})`);
  const classes = (tag: string) => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
  for (const tag of layers) assert.ok(classes(tag).some((c) => c === "pop" || c === "modal"), `a dialog layer has the pop or modal class: ${tag.slice(0, 80)}`);
  const app = readAppSource();
  assert.match(app, /const LAYERS = "\.pop,\.modal", layerId/, "renderAll matches layers by the shared classes, so no popover or modal can be missed");
  for (const id of ["pop", "seatPop", "projPop", "ctxPop", "setupPop", "permPop", "soundPop", "inboxPop", "modal", "projModal", "renameModal", "avModal", "viewer", "setModal", "runModal", "confirmModal"]) {
    assert.ok(layers.some((tag) => tag.includes(`id="${id}"`)), `${id} is a dialog layer in index.html`);
  }
});
test("the page takes the app key from the Electron bridge or #key=, sends it on the WebSocket and as X-App-Key on every POST", async () => {
  const start = appSource.indexOf("let appKeyValue = ");
  const end = appSource.indexOf("  function connect() {");
  assert.ok(start > 0 && end > start, "the key helpers exist");
  const make = (context: Record<string, unknown>) => {
    const fetched: { url: string; options: any }[] = [];
    const store = new Map<string, string>(); const replaced: unknown[][] = [];
    const scope = { fetch: async (url: string, options: any) => { fetched.push({ url, options }); return { ok: true }; }, sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
      history: { replaceState: (...args: unknown[]) => { replaced.push(args); } }, location: { hash: "", pathname: "/", search: "" }, ...context };
    const api = runInNewContext(`${appSource.slice(start, end)}\n;({ getAppKey, keyedFetch })`, scope);
    return { ...api, fetched, replaced, store };
  };
  const key = "ab".repeat(32);
  const electron = make({ window: { cc: { appKey: async () => key } } });
  assert.equal(await electron.getAppKey(), key);
  await electron.keyedFetch("/api/paste-image", { method: "POST", headers: { "Content-Type": "image/png", "X-Request-Id": "r1" }, body: "x" });
  await electron.keyedFetch("/api/paste-file", { method: "POST", headers: {}, body: "x" });
  assert.deepEqual(electron.fetched.map((f) => f.options.headers["X-App-Key"]), [key, key], "every POST carries the key");
  assert.equal(electron.fetched[0].options.headers["Content-Type"], "image/png", "the caller's own headers stay");
  assert.equal(electron.store.size, 0, "the Electron key is never stored");

  const browser = make({ window: {}, location: { hash: `#key=${key}`, pathname: "/", search: "?x=1" } });
  assert.equal(await browser.getAppKey(), key, "a plain browser tab reads #key=");
  assert.deepEqual(browser.replaced, [[null, "", "/?x=1"]], "and removes it from the address bar");
  assert.equal(browser.store.get("cc-app-key"), key);
  const reloaded = make({ window: {}, location: { hash: "", pathname: "/", search: "" } });
  reloaded.store.set("cc-app-key", key);
  assert.equal(await reloaded.getAppKey(), key, "a reload of the same tab keeps working");

  const none = make({ window: {} });
  assert.equal(await none.getAppKey(), "", "no key anywhere: empty, so the server refuses and the Disconnected banner shows");
  const broken = make({ window: { cc: { appKey: async () => { throw new Error("no"); } } } });
  assert.equal(await broken.getAppKey(), "");

  // A restarted server hands out a new key: a 403 on a POST, or a socket that closes before it ever opened, must drop the cached key.
  let current = key;
  const stale = make({ window: { cc: { appKey: async () => current } }, fetch: async () => ({ status: 403 }) });
  assert.equal(await stale.getAppKey(), key);
  current = "cd".repeat(32);
  await stale.keyedFetch("/api/paste-image", { method: "POST", headers: {}, body: "x" });
  assert.equal(await stale.getAppKey(), current, "after a 403 the next attempt re-reads the key");
  // A key a plain browser tab stored must also leave sessionStorage on a 403, or the next reload re-reads the dead key.
  const kept = make({ window: {}, location: { hash: `#key=${key}`, pathname: "/", search: "" }, fetch: async () => ({ status: 403 }) });
  assert.equal(await kept.getAppKey(), key);
  assert.equal(kept.store.get("cc-app-key"), key, "the browser tab stored the key");
  await kept.keyedFetch("/api/paste-image", { method: "POST", headers: {}, body: "x" });
  assert.equal(kept.store.has("cc-app-key"), false, "a 403 removes the stored key from sessionStorage");
  assert.match(appSource, /next\.addEventListener\("close", \(\) => \{\n      if \(socket !== next\) return;\n      if \(!everOpened\) forgetAppKey\(\);/, "a socket that closed before it opened forgets the key");
  assert.match(appSource, /next\.addEventListener\("open", \(\) => \{\n      everOpened = true;/, "an opened socket keeps it");
  assert.match(appSource, /reconnectTimer = setTimeout\(connect, reconnectDelay\)/, "the reconnect backoff stays");

  assert.match(appSource, /new WebSocket\(`ws:\/\/\$\{location\.host\}\/\?key=\$\{encodeURIComponent\(key\)\}`\)/, "the socket connects with ?key=");
  assert.match(appSource, /getAppKey\(\)\.then\(\(key\) => \{ if \(ticket === connectTicket\) openSocket\(key\); \}\)/, "the socket is opened with the resolved key");
  const rawFetches = [...appSource.matchAll(/(?<![\w.])fetch\(/g)];
  assert.equal(rawFetches.length, 1, "the only plain fetch( is the one inside keyedFetch");
  for (const route of ["/api/paste-image", "/api/paste-file", "/api/avatar"]) assert.ok(appSource.includes(`await keyedFetch("${route}",`), `${route} goes through keyedFetch`);
});

test("no page copy promises a Codex sandbox boundary", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.doesNotMatch(appSource, /\(Codex sandbox\)|only Codex seats are sandboxed/);
  assert.doesNotMatch(index, /only Codex seats are held to it/);
  // Worded from the server's own CLI list (readOnlyEnforced), proven on the real page code: Codex says it can still write, Claude does not say it.
  const h = pageHarness();
  h.api.onMessage(h.state({}, { clis: CLIS }));
  const tab = h.state().projects[0].tabs[0];
  assert.match(h.api.real.accessText(tab, { slot: "reviewer1", cli: "codex", canWrite: false }), /asked not to write; Codex can still write through commands/);
  assert.doesNotMatch(h.api.real.accessText(tab, { slot: "reviewer1", cli: "claude", canWrite: false }), /can still write/);
});

test("the permission copy is honest per leader CLI: only Claude promises to ask first or to change nothing", () => {
  const source = /const PERMISSIONS = (\[[\s\S]*?\n  \]);/.exec(appSource)?.[1];
  assert.ok(source, "the PERMISSIONS table is in app.js");
  const modes = runInNewContext(`(${source})`) as [string, string, (name: string, cli: string) => string][];
  const copy = (id: string, cli: string) => modes.find(([mode]) => mode === id)![2]("Atlas", cli);
  assert.equal(copy("ask", "claude"), "Atlas asks before changing any file or running a command");
  assert.equal(copy("accept", "claude"), "Edits go through, commands still ask");
  assert.equal(copy("plan", "claude"), "Reads and plans, changes nothing");
  for (const cli of ["codex", "opencode"]) {
    assert.doesNotMatch(copy("ask", cli), /asks before changing any file/, `${cli} Ask`);
    assert.doesNotMatch(copy("plan", cli), /changes nothing/i, `${cli} Plan`);
    assert.match(copy("plan", cli), /can still write a file/, `${cli} Plan says a command can still write`);
  }
  assert.match(copy("ask", "codex"), /Some commands and file writes can still go through without asking/);
  assert.match(copy("ask", "opencode"), /Reading files and folders does not ask/);
  assert.match(copy("accept", "codex"), /Codex asks when it needs more access/);
  assert.match(appSource, /description\(name, cli\)/, "the picker passes the leader's CLI");
});

test("the approval box shows the whole summary, scrollable; the font files ship with the app; nothing loads from Google", () => {
  const css = styleSource();
  assert.match(/\.apv code\{[^}]*\}/.exec(css)![0], /white-space:pre-wrap[^}]*max-height:40vh;overflow:auto/);
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<code id="approvalSummary" tabindex="0">/, "a keyboard user can scroll it");
  for (const [file, text] of [["index.html", index], ["style.css", css], ["app.js", appSource]]) assert.doesNotMatch(text, /fonts\.(?:googleapis|gstatic)\.com/, `public/${file} loads no Google fonts`);
  const faces = [...css.matchAll(/@font-face\{font-family:"([^"]+)";[^}]*font-weight:(\d+);[^}]*url\("(\/fonts\/[^"]+)"\)/g)];
  assert.deepEqual(faces.map(([, family, weight]) => `${family} ${weight}`), ["Geist 400", "Geist 500", "Geist 600", "Geist 700", "Geist Mono 400", "Geist Mono 500"]);
  for (const [, , , url] of faces) assert.ok(existsSync(join(publicDir, url.slice(1))), `${url} ships`);
  assert.ok(existsSync(join(publicDir, "fonts", "LICENSE-Geist-OFL.txt")), "the font licence ships with the fonts");
});

test("a dropped file never opens in place of the app, and MCP and plugin Add ask first like the Settings text says", () => {
  assert.match(appSource, /for \(const type of \["dragover", "drop"\]\) document\.addEventListener\(type, \(event\) => \{ if \(!event\.target\.closest\?\.\("\[data-drop-zone\]"\)\) event\.preventDefault\(\); \}\);/);
  const mcp = /querySelectorAll\("\[data-mcp-form\]"\)[\s\S]*?\n    \}\)\);/.exec(appSource)![0];
  assert.match(mcp, /confirmAction\(\{ title: `Add \$\{name\} to \$\{CLI_LABEL\[cli\]\}\?`[\s\S]*?\(\) => \{ if \(sendSettingsAction\(key, \{ type: "mcpAdd"/, "MCP Add sits inside the confirm callback");
  assert.doesNotMatch(mcp.replace(/confirmAction[\s\S]*$/, ""), /sendSettingsAction/, "nothing is sent before the confirm");
  const plugin = /querySelector\("\[data-plugin-form\]"\)[\s\S]*?\n    \}\);/.exec(appSource)![0];
  assert.match(plugin, /confirmAction\([\s\S]*?\(\) => \{ if \(sendSettingsAction\("plugin-add"/);
  assert.doesNotMatch(plugin.replace(/confirmAction[\s\S]*$/, ""), /sendSettingsAction/);
});

test("the page keeps the crew rail, Details and the theme in the server's prefs and never in localStorage, and shows the app only once the theme is known", () => {
  assert.doesNotMatch(appSource, /\blocalStorage\.|\blocalStorage\)|\.localStorage\b|getStored|setStored/, "the page reads and writes no localStorage");
  const h = pageHarness();
  assert.equal(h.api.snap().railWide, true); assert.equal(h.api.snap().sideOpen, false);
  assert.equal(h.bodyClasses.has("boot"), true, "until the first state the app is unpainted");
  h.api.onMessage(h.state({}, { clientPrefs: { crewRailOpen: false, detailsOpen: true } }));
  assert.equal(h.api.snap().railWide, false, "the server's crewRailOpen decides the rail"); assert.equal(h.api.snap().sideOpen, true, "the server's detailsOpen decides Details");
  assert.equal(h.bodyClasses.has("boot"), false, "the first state ends the unpainted start");
  assert.match(appSource, /setTimeout\(showApp, 3000\)/, "a 3 s fallback is armed at start-up for a server that never answers");
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  assert.match(index, /<body class="light boot">/);
});

test("the page's Content-Security-Policy allows only its own scripts, styles, images, fonts and connections, and index.html carries no inline script or handler", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(index)?.[1] ?? "";
  assert.ok(policy, "the page declares a policy");
  const directives = new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
  assert.equal(directives.get("default-src"), "'none'");
  assert.equal(directives.get("script-src"), "'self'", "no inline script, no eval");
  assert.equal(directives.get("font-src"), "'self'");
  assert.equal(directives.get("img-src"), "'self' data: blob:", "pictures: the page's own, data URLs for the favicon, blob for the uploaded picture");
  assert.match(directives.get("connect-src") ?? "", /^'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*$/);
  assert.equal(directives.get("base-uri"), "'none'"); assert.equal(directives.get("form-action"), "'none'");
  assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline <script>");
  assert.doesNotMatch(index, /\son(?:click|load|error|submit|change|input)\s*=/i, "no inline event handler");
  assert.doesNotMatch(appSource, /\beval\(|new Function\(/);
  const css = styleSource();
  assert.doesNotMatch(css, /--ring/, "the unused --ring token is gone");
  assert.match(/\.att\.err\{[^}]*\}/.exec(css)![0], /var\(--danger-text\)/);
  assert.doesNotMatch(/\.att\.err\{[^}]*\}/.exec(css)![0], /#f4c7c3/, "no fixed light pink");
});


// The stylesheet and markup are read as the browser would match them: a rule applies to a selector in its list, so a selector dropped from the list is a rule lost.
function cssRules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: match[1].split(",").map((part) => part.trim()), body: match[2] }));
}
const stylesheet = styleSource();

test("pack 3: the stalled dot has the waiting colour, a crew picture is cropped to fill its box, and the open rail turns its arrow", () => {
  const rules = cssRules(stylesheet);
  const bodyOf = (selector: string, needle: RegExp) => rules.filter((rule) => rule.selectors.includes(selector) && needle.test(rule.body));
  assert.equal(bodyOf(".dot.stalled", /background:var\(--waiting\)/).length, 1, "a stalled seat's dot takes the waiting background");
  assert.equal(bodyOf(".dot.waiting", /background:var\(--waiting\)/).length, 1, "control: the waiting dot does too");
  assert.equal(bodyOf(".av img", /object-fit:cover/).length, 1, "a crew picture is fitted with cover");
  assert.equal(bodyOf("#stage.wide .rtg svg", /transform:rotate\(180deg\)/).length, 1, "the open rail's arrow is turned");
});

test("pack 3: the crew rail toggle draws its arrow as the page's own svg, not a text character", () => {
  const index = readFileSync(join(publicDir, "index.html"), "utf8");
  const button = /<button class="rtg" id="railBtn"[^>]*>([\s\S]*?)<\/button>/.exec(index)?.[1] ?? "";
  assert.match(button, /<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5\.2 3\.2 9 7l-3\.8 3\.8"/);
  assert.doesNotMatch(button, /&raquo;|&laquo;|[»«]/);
});
test("browser reply waits require the action's settled state, not an unrelated broadcast", () => {
  const source = harnessSource();
  const calls = source.split(/\r?\n/).filter((line) => line.includes("await waitForServerReply("));
  assert.ok(calls.length >= 10, `control: found ${calls.length} reply waits`);
  for (const call of calls) assert.match(call, /waitForServerReply\([^,]+, "[^"]+", \(\) => .+\);/, `reply wait must name its settled state: ${call}`);
  const start = source.indexOf("  const waitForServerReply ="), end = source.indexOf("  const text =", start);
  assert.ok(start >= 0 && end > start, "the real reply helper was found");
  const window = { __received: [{ type: "state" }] };
  const wait = new Function("window", "waitFor", `${source.slice(start, end)}; return waitForServerReply;`)(window, (ready: () => boolean) => ready());
  let settled = false;
  assert.equal(wait(0, "change", () => settled), false, "an unrelated state cannot finish the wait");
  settled = true;
  assert.equal(wait(0, "change", () => settled), true, "the expected state finishes it");
});
