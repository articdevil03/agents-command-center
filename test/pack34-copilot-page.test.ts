import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { catalogMetadata } from "../server/settings/cli-catalog-validation.ts";

test("wizard and Settings render Copilot Install, progress, cancel, Installed, Try again and retained Stop again", () => {
  const messages: any[] = [], actions = new Map(), entry = catalogMetadata().find((e) => e.id === "copilot")!;
  const facts: any = { installed: false, signedIn: null, registered: false };
  const state = { cliCatalog: [entry], settings: { tools: {}, catalogTools: { copilot: facts } } };
  const login = { busy: () => false, viewOf: () => ({ state: "idle" }), managed: () => true, offered: () => false, unsupportedMessage: () => null };
  const page = { state, cliLabel: () => entry.displayName, esc: (s: unknown) => String(s ?? ""), logo: () => "", cliLogin: login,
    sendSettingsAction: (id: string, payload: any) => { messages.push(JSON.parse(JSON.stringify(payload))); return id; } };
  const context = createContext({ window: {}, serverState: state, CLI_LABEL: {}, esc: page.esc, logo: page.logo, cliLoginUi: login,
    settingsActionId: () => null, settingsActionRunning: () => false, actionStatusMarkup: () => "" });
  for (const f of ["catalog.js", "install.js", "tools.js"]) runInContext(readFileSync(new URL(`../public/first-run/${f}`, import.meta.url), "utf8"), context);
  runInContext(readFileSync(new URL("../public/app/11-settings-render.js", import.meta.url), "utf8"), context);
  const catalog = context.window.CC_FIRST_RUN_CATALOG.create(page);
  const install = context.window.CC_FIRST_RUN_INSTALL.create(page, { action: (id: string) => actions.get(id), running: () => false, catalog });
  const tools = context.window.CC_FIRST_RUN_TOOLS.create(page, { help: { order: [], tools: {}, steps: [], stillMissing: "Check again" },
    action: () => null, running: () => false, refreshKey: "refresh", openHelp: new Set(), draft: {}, other: {}, catalog, install, login });
  const html = () => [tools.rowsHtml("copilot"), runInContext('settingsToolRow("copilot", serverState.settings.catalogTools.copilot)', context)];
  for (const markup of html()) {
    assert.match(markup, />Install<\/button>/); assert.doesNotMatch(markup, /winget|powershell|terminal|\u2014/i);
  }
  assert.match(context.window.CC_FIRST_RUN_CATALOG.consentText(entry), /checks GitHub Copilot CLI from its official releases/);
  // The Copilot failure text follows the catalog id, never the display name.
  assert.equal(context.window.CC_FIRST_RUN_CATALOG.reasonText("installFailed", "Renamed label", "copilot"), "The installation did not finish. Try again.");
  assert.match(context.window.CC_FIRST_RUN_CATALOG.reasonText("installFailed", entry.displayName, "claude"), /Install by hand/);
  install.install("copilot"); assert.deepEqual(messages, [{ type: "installCli", cli: "copilot", confirm: true }]);
  facts.action = { requestId: "owned", kind: "install", status: "running", phase: "installing" };
  for (const markup of html()) { assert.match(markup, />Cancel<\/button>/); assert.match(markup, /Downloading and installing/); }
  install.cancel("copilot"); assert.deepEqual(messages.at(-1), { type: "cancelCliInstall", cli: "copilot", installRequestId: "owned" });
  facts.action = { requestId: "owned", kind: "install", status: "failed", reason: "installFailed" };
  for (const markup of html()) { assert.match(markup, />Try again<\/button>/); assert.match(markup, /did not finish/); assert.doesNotMatch(markup, /Install by hand|github\.com|data-frun-help|data-copy-address/); }
  facts.action.reason = "cleanupUnconfirmed";
  for (const markup of html()) { assert.match(markup, />Stop again<\/button>/); assert.doesNotMatch(markup, />Try again<\/button>/); }
  facts.installed = true; facts.version = "1.0.112"; facts.action = { requestId: "owned", kind: "install", status: "done" };
  for (const markup of html()) { assert.match(markup, /Installed/); assert.doesNotMatch(markup, />Install<\/button>|>Try again<\/button>/); }
});

test("Settings Cancel and Stop again send only the current server-owned installation ID", () => {
  const source = readFileSync(new URL("../public/app/11-settings-render.js", import.meta.url), "utf8");
  const start = source.indexOf('      const action = button.dataset.settingAction;');
  const end = source.indexOf('\n    }));', start);
  assert.ok(start > 0 && end > start, "the actual Settings click handler must be found");
  for (const status of ["running", "failed", "done"]) {
    const messages: any[] = [];
    const context = createContext({ button: { dataset: { settingAction: "cancel-cli-install", cli: "copilot" } },
      serverState: { settings: { catalogTools: { copilot: { action: { requestId: "server-owned", kind: "install", status,
        reason: status === "failed" ? "cleanupUnconfirmed" : null } } } } },
      settingsActionRunning: () => false, renderSettings() {},
      sendSettingsAction: (_id: string, payload: any) => messages.push(JSON.parse(JSON.stringify(payload))),
    });
    runInContext(`(() => { ${source.slice(start, end)} })()`, context);
    assert.deepEqual(messages, status === "done" ? [] : [{ type: "cancelCliInstall", cli: "copilot", installRequestId: "server-owned" }]);
  }
});
