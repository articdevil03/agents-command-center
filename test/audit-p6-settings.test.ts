import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";

// Every created file is known. Cleanup refuses links and removes empty directories only.
const root = fs.mkdtempSync(join(tmpdir(), "cc-p6-settings-"));
const dirs: string[] = [];
const files: string[] = [];
function directory(name: string) { const path = join(root, name); fs.mkdirSync(path); dirs.push(path); return path; }
const importData = directory("module-data");
const previous = process.env.CC_DATA_DIR;
process.env.CC_DATA_DIR = importData;
const { SettingsService } = await import("../server/settings/service.ts");
if (previous === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previous;
after(() => {
  for (const path of files) if (fs.existsSync(path)) { assert.equal(fs.lstatSync(path).isSymbolicLink(), false); fs.unlinkSync(path); }
  for (const path of [...dirs].reverse().concat(root)) { assert.equal(fs.lstatSync(path).isSymbolicLink(), false); fs.rmdirSync(path); }
});
let sequence = 0;
function setup(saved = false) {
  const vault = directory(`vault-${++sequence}`), dataRoot = directory(`data-${sequence}`), home = directory(`home-${sequence}`);
  const settings = join(dataRoot, "settings.json"); files.push(settings);
  if (saved) fs.writeFileSync(settings, JSON.stringify({ notesVaultPath: vault, permissionModes: {} }));
  const calls: string[][] = [];
  const service = () => new SettingsService({ dataRoot, env: { HOME: home, USERPROFILE: home, PATH: "", CC_TEST_FAKE_CLI: "1" },
    credentialStore: new MemoryCredentialStore(), refreshPath: async () => {},
    runCli: async (bin, args) => { calls.push([bin, ...args]); return { code: 127, stdout: "", stderr: "", cleanupConfirmed: true }; } });
  return { vault, service, calls };
}
function close(service: InstanceType<typeof SettingsService>) { service.cliKeys.close(); service.login.close(); service.installer.close(); }

test("startup and every refresh leave the vault listing and probe call count unchanged", async (t) => {
  const h = setup(true), before = fs.readdirSync(h.vault), open = fs.openSync, unlink = fs.unlinkSync;
  let writes = 0, deletes = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (String(args[0]).includes("write-probe")) writes++; return open(...args); });
  t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => { if (String(path).includes("write-probe")) deletes++; return unlink(path); });
  syncBuiltinESMExports();
  const service = h.service();
  try {
    assert.deepEqual(fs.readdirSync(h.vault), before); assert.equal(writes, 0, "startup creates no probe"); assert.equal(deletes, 0);
    await service.refreshAll(null); await service.refreshAll(null);
    assert.deepEqual(fs.readdirSync(h.vault), before); assert.equal(writes, 0, "refresh creates no probe"); assert.equal(deletes, 0);
    assert.equal(service.state.vault.status, "connected");
  } finally { close(service); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("an unavailable vault never enters synchronous IO and a hanging async read is bounded", async (t) => {
  const h = setup(true), realpath = fs.realpathSync, stat = fs.statSync, asyncRealpath = promises.realpath;
  let syncCalls = 0, asyncCalls = 0;
  // A real unavailable share can hang here. Throw instead so a regression fails an assertion without hanging the runner.
  for (const [name, original] of [["realpathSync", realpath], ["statSync", stat]] as const) t.mock.method(fs, name, (...args: any[]) => {
    if (String(args[0]) === h.vault) { syncCalls++; throw new Error("would hang on offline share"); }
    return (original as any)(...args);
  });
  t.mock.method(promises, "realpath", (path: any, ...args: any[]) => {
    if (String(path) === h.vault) { asyncCalls++; return new Promise(() => {}); }
    return (asyncRealpath as any)(path, ...args);
  }); syncBuiltinESMExports();
  const service = h.service();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([service.refreshAll(null).then(() => "done"), new Promise((resolve) => { timer = setTimeout(() => resolve("gave up"), 3000); })]);
    assert.equal(outcome, "done", "refresh must finish on the bounded branch");
    assert.equal(syncCalls, 0, "startup and refresh never synchronously inspect the vault");
    assert.equal(asyncCalls, 1, "the async vault check was FOUND");
    assert.equal(service.state.vault.status, "missing");
  } finally { clearTimeout(timer); close(service); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("Connect writes and removes exactly its own unique probe, preserving foreign probes", async (t) => {
  const h = setup(), service = h.service(), foreign = join(h.vault, ".command-center-write-probe-foreign.tmp");
  fs.writeFileSync(foreign, "keep"); files.push(foreign);
  const open = fs.openSync, unlink = fs.unlinkSync, created: string[] = [], removed: string[] = [];
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (String(args[0]).includes("write-probe")) { assert.equal(args[1], "wx"); created.push(String(args[0])); } return open(...args); });
  t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => { if (String(path).includes("write-probe")) removed.push(String(path)); return unlink(path); }); syncBuiltinESMExports();
  try {
    await service.setNotesVault("connect", h.vault);
    assert.equal(created.length, 1); assert.deepEqual(removed, created); assert.notEqual(created[0], foreign);
    assert.deepEqual(fs.readdirSync(h.vault), [".command-center-write-probe-foreign.tmp"]);
    assert.equal(fs.readFileSync(foreign, "utf8"), "keep");
    await service.refreshAll(null); assert.equal(created.length, 1, "refresh does not repeat Connect's write test");
  } finally { close(service); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("OpenCode MCP Add and Remove are refused before any vendor call", async () => {
  const h = setup(), service = h.service();
  try {
    await assert.rejects(service.addMcp("opencode", "add", "demo", "https://example.com/mcp"), /OpenCode MCP changes are not available yet/);
    await assert.rejects(service.removeMcp("opencode", "remove", "demo", true), /OpenCode MCP changes are not available yet/);
    assert.deepEqual(h.calls, []);
  } finally { close(service); }
});

const publicFiles = ["public/app/11-settings-render.js", ...fs.readdirSync("public/first-run").map((name) => `public/first-run/${name}`)];
function source(path: string) { return fs.readFileSync(path, "utf8"); }
test("Settings renders OpenCode MCP controls disabled with an in-app explanation", () => {
  const context = { esc: (text: any) => String(text), logo: () => "", CLI_LABEL: { opencode: "OpenCode" }, settingsActionId: () => null, actionStatusMarkup: () => "", window: {} };
  const html = runInNewContext(`${source(publicFiles[0])}\nskillBlock('opencode', {mcpServers:[{name:'demo'}]})`, context);
  assert.match(html, /OpenCode MCP changes are not available yet/);
  assert.match(html, /<button[^>]*disabled[^>]*>\+ Add<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Remove<\/button>/);
  assert.doesNotMatch(html, /data-mcp-form="opencode"|data-setting-action="mcp-remove"|Remove it with OpenCode itself/);
});

function strings(text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text); ts.forEachChild(node, visit); };
  visit(ts.createSourceFile("page.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  assert.ok(found.length > 0, "the string scan FOUND no strings"); return found;
}
test("every public guidance string uses in-app recovery and no terminal or tier instructions", (t) => {
  assert.throws(() => strings("// no strings"), /FOUND no strings/, "empty scan control goes RED");
  const forbidden = /\bterminal\b|command[ -]line|Install by hand|Follow the maker's setup guide|Visit the official setup guide/i;
  assert.ok(strings('const guide = "Open a terminal";').some((text) => forbidden.test(text)), "planted terminal instruction is caught");
  // Remove only the approved recovery sentence, so mixed instructions still fail.
  const approvedPowerShell = /This tool needs Windows PowerShell, which was not found on this PC\. Restore it in Windows, then choose (?:Check again|Try again)\./;
  const badPowerShell = (text: string) => /powershell/i.test(text.replace(approvedPowerShell, ""));
  assert.ok(strings('const guide = "Open PowerShell";').some(badPowerShell), "planted PowerShell instruction is caught");
  const approved = "This tool needs Windows PowerShell, which was not found on this PC. Restore it in Windows, then choose Check again.";
  assert.ok(!strings(`const guide = ${JSON.stringify(approved)};`).some(badPowerShell), "the approved sentence is accepted");
  assert.ok(strings(`const guide = ${JSON.stringify(`Open Windows PowerShell and run it. ${approved}`)};`).some(badPowerShell), "mixed PowerShell instruction is caught");
  assert.ok(strings(`const guide = ${JSON.stringify(`${approved} Open Windows PowerShell and run it.`)};`).some(badPowerShell), "trailing PowerShell instruction is caught");
  for (const file of publicFiles) {
    const scanned = strings(source(file));
    t.diagnostic(`${file}: scanned ${scanned.length} string fragments; matches: ${JSON.stringify(scanned.filter((text) => forbidden.test(text)))}`);
    for (const text of scanned) { assert.doesNotMatch(text, forbidden, `${file}: ${text}`); assert.equal(badPowerShell(text), false, `${file}: ${text}`); if (file.startsWith("public/first-run/")) assert.doesNotMatch(text, /\bpaid\b|\bfree\b/i, `${file}: ${text}`); }
  }
  const window: any = {};
  runInNewContext(source("public/first-run/cli-help.js"), { window });
  assert.match(window.CC_FIRST_RUN_HELP.steps.join(" "), /Install.*Cancel.*(?:Retry|Try again).*Check again/);
  assert.match(window.CC_FIRST_RUN_HELP.tools.opencode.steps.join(" "), /Sign in.*Get my key/);
});

test("real page keeps setup in-app, disables OpenCode MCP changes and submits supported MCP through the real listener", async () => {
  const { withPage, click, J } = await import("./pack18-editor-harness.ts");
  const { showFirstRun } = await import("./pack29-onboarding-page.setup.ts");
  const { toToolStep } = await import("./pack29-onboarding-page-acp.setup.ts");
  await withPage(async ({ ev, seed }) => {
    await showFirstRun(ev, seed, { claude: [false, null], codex: [false, null], opencode: [false, null] });
    await toToolStep(ev, "C:\\work\\P6");
    await click(ev, '[data-frun-help="claude"]');
    const help = await ev("document.querySelector('#frunHelp-claude').innerText");
    assert.match(help, /Install.*Cancel.*Try again.*Check again/s);
    assert.doesNotMatch(help, /terminal|powershell|Install by hand|official setup guide/i);
    assert.equal(await ev("document.querySelectorAll('#frunHelp-claude .frun-url').length"), 0);
    await ev(`(()=>{const state=${J(seed)};state.firstRun={required:false};state.settings.skills.opencode.mcpServers=[{name:'demo'}];__ccDeliver({...state,type:'state'});openSettings(undefined,'skills');return true})()`);
    const controlState = await ev(`(()=>{const card=document.querySelector('[data-skill-cli="opencode"]');return {text:card.innerText,buttons:[...card.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled})),forms:card.querySelectorAll('form').length}})()`);
    assert.match(controlState.text, /OpenCode MCP changes are not available yet/);
    assert.deepEqual(controlState.buttons, [{ text: "+ Add", disabled: true }, { text: "Remove", disabled: true }]);
    assert.equal(controlState.forms, 0);
    for (const cli of ["claude", "codex"]) {
      await click(ev, `[data-settings-add="mcp-${cli}"]`);
      await ev(`(()=>{const form=document.querySelector('[data-mcp-form="${cli}"]');form.elements.name.value='demo';form.elements.commandOrUrl.value='https://user:synthetic@example.com/mcp';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
      assert.equal(await ev("document.querySelector('#confirmModal').hidden"), true, "unsafe URL is refused before confirmation");
      await ev(`(()=>{const form=document.querySelector('[data-mcp-form="${cli}"]');form.elements.commandOrUrl.value='https://example.com/mcp';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
      await click(ev, "#confirmOk");
      const sent = await ev(`window.__sent.filter(m=>m.type==='mcpAdd'&&m.cli==='${cli}')`);
      assert.equal(sent.length, 1); assert.equal(sent[0].commandOrUrl, "https://example.com/mcp");
    }
  }, { fixture: "fixed" });
});
test("server Windows prerequisite guidance names Windows PowerShell restoration and the in-app retry", async () => {
  const { INSTALL_MESSAGES } = await import("../server/settings/cli-installers.ts");
  assert.equal(INSTALL_MESSAGES.needsPowerShell, "This tool needs Windows PowerShell, which was not found on this PC. Restore it in Windows, then choose Try again.");
  assert.doesNotMatch(INSTALL_MESSAGES.needsPowerShell, /terminal|windows update/i);
});

test("readVaultStatus schedules exactly the 1500 ms default bound and finishes missing", async (t) => {
  const { readVaultStatus } = await import("../server/settings/vault.ts");
  const h = setup(true), schedule = globalThis.setTimeout, delays: number[] = [];
  let reads = 0;
  t.mock.method(promises, "realpath", (() => { reads++; return new Promise(() => {}); }) as any);
  syncBuiltinESMExports();
  t.mock.method(globalThis, "setTimeout", ((callback: any, delay: number) => { delays.push(delay); return schedule(callback, 1); }) as any);
  try {
    assert.equal(await readVaultStatus(h.vault), "missing", "the deadline branch finishes an unavailable read");
    assert.equal(reads, 1, "vault presence read FOUND");
    assert.deepEqual(delays, [1500], `exact vault deadline, observed ${delays.join(",")}`);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
