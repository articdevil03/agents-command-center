import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../public/app/11-settings-render.js", import.meta.url), "utf8");
test("Settings offers Remove only for installed managed OpenCode and Copilot, with running and failure states", () => {
  const facts: any = { installed: true, managedInstall: true, supportedVersion: true, registered: true };
  const state = { cliCatalog: [], settings: { catalogTools: { opencode: facts, copilot: facts, claude: facts }, tools: {} } };
  const context = createContext({ window: {}, serverState: state, CLI_LABEL: {}, esc: (s: any) => String(s ?? ""), logo: () => "",
    cliLoginUi: { busy: () => false, viewOf: () => ({ state: "idle" }), offered: () => false, unsupportedMessage: () => null },
    settingsActionId: () => null, actionStatusMarkup: () => "" });
  runInContext(source, context);
  const row = (cli: string) => runInContext(`settingsToolRow(${JSON.stringify(cli)},serverState.settings.catalogTools[${JSON.stringify(cli)}])`, context);
  for (const cli of ["opencode", "copilot"]) {
    assert.match(row(cli), /data-setting-action="remove-cli-install"/);
    for (const managed of [false, undefined]) { facts.managedInstall = managed; assert.doesNotMatch(row(cli), /remove-cli-install/); }
    facts.managedInstall = true; facts.installed = false; assert.doesNotMatch(row(cli), /remove-cli-install/);
    facts.installed = true; facts.action = { kind: "remove", status: "running", requestId: "removal" };
    assert.match(row(cli), /Removing\.\.\./);
    assert.match(row(cli), /data-setting-action="remove-cli-install"[^>]+disabled/);
    facts.action = { kind: "remove", status: "failed", message: "Some files could not be removed." };
    assert.match(row(cli), /Some files could not be removed\./);
    facts.installed = false; facts.managedInstall = false; facts.action.message = "Some files could not be removed. Close programs that use them and try again.";
    assert.match(row(cli), /data-setting-action="remove-cli-install"/, "partial cleanup offers retry");
    facts.installed = true; facts.managedInstall = true; delete facts.action;
  }
  assert.doesNotMatch(row("claude"), /remove-cli-install/);
});

test("Settings actual Remove listener asks once, cancel sends nothing, confirmed action sends fixed IDs only", () => {
  const start = source.indexOf('      const action = button.dataset.settingAction;'), end = source.indexOf('\n    }));', start);
  assert.ok(start > 0 && end > start, "actual Settings listener FOUND");
  for (const [cli, retry] of [["opencode", false], ["copilot", false], ["copilot", true], ["claude", false]] as const) {
    const messages: any[] = [], confirmations: any[] = []; let confirm: (() => void) | undefined;
    const context = createContext({ button: { dataset: { settingAction: "remove-cli-install", cli } },
      settingsToolFacts: () => ({ installed: !retry, managedInstall: !retry, ...(retry ? { action: { kind: "remove", status: "failed", message: "Some files could not be removed. Close programs that use them and try again." } } : {}) }), settingsActionRunning: () => false,
      toolName: () => cli === "copilot" ? "GitHub Copilot" : "OpenCode", renderSettings() {},
      confirmAction: (options: any, run: () => void) => { confirmations.push(JSON.parse(JSON.stringify(options))); confirm = run; },
      sendSettingsAction: (key: string, payload: any) => { messages.push({ key, payload: JSON.parse(JSON.stringify(payload)) }); return "sent"; },
    });
    runInContext(`(() => { ${source.slice(start, end)} })()`, context);
    assert.deepEqual(messages, [], "cancel leaves everything alone");
    if (cli === "claude") { assert.deepEqual(confirmations, []); continue; }
    assert.deepEqual(confirmations, [{ title: `Remove ${cli === "copilot" ? "GitHub Copilot" : "OpenCode"} from this PC?`,
      body: "Command Center installed it for your Windows account. This removes that copy only. Your sign-in and settings stay.", ok: "Remove", danger: true }]);
    assert.equal(typeof confirm, "function"); confirm!();
    assert.deepEqual(messages, [{ key: `remove-install-${cli}`, payload: { type: "removeCliInstall", cli, confirm: true } }]);
  }
});
