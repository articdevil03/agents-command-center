import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsService } from "../server/settings/service.ts";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { INSTALL_MESSAGES } from "../server/settings/cli-installers.ts";
import { fixture } from "./pack29-cli-install.setup.ts";
import { setEnv } from "./temp-root.ts";
import { api, setup } from "./pack29-first-run.setup.ts";

// No injected runner or launcher: the same injected-env boundary as loadFixed.
// The throwing spawn spy remains in place even during guard mutations.
for (const flagSource of ["injected", "host"] as const) {
  test(`${flagSource} test flag: real Settings handlers never spawn vendor programs`, async (t) => {
    const spy = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN vendor spawn"); });
    syncBuiltinESMExports();
    const managed = CLI_CATALOG.filter((entry) => entry.signIn.managed);
    const installable = CLI_CATALOG.filter((entry) => entry.recipe);
    assert.ok(managed.length > 0, "managed catalog must be FOUND");
    assert.ok(installable.length > 0, "installable catalog must be FOUND");
    try {
      for (const action of ["github", "login", "install"] as const) {
        const entries = action === "github" ? [{ id: "github" }] : action === "login" ? managed : installable;
        for (const entry of entries) {
          const ctx = setup();
          const fx = fixture(), record = join(fx.root, "calls.jsonl"), script = join(fx.root, "fake.json");
          const responses: Record<string, any> = {};
          const respond = (bin: string, args: string[], stdout: string) => { responses[JSON.stringify([bin, ...args])] = { code: 0, stdout, stderr: "" }; };
          for (const tool of CLI_CATALOG.filter((tool) => tool.detection)) {
            fx.write(`${tool.detection!.program}.exe`);
            if (action === "login") respond(tool.detection!.program, tool.detection!.args, "1.2.3");
            if (tool.id === "opencode") respond("opencode", ["auth", "list"], "0 credentials");
          }
          const node = fx.write("node.exe"), npmDir = join(fx.bin, "node_modules", "npm", "bin");
          mkdirSync(npmDir, { recursive: true });
          const npm = join(npmDir, "npm-cli.js"); writeFileSync(npm, ""); fx.write("npm.cmd");
          respond(node, ["--version"], "v24.1.0"); respond(node, [npm, "--version"], "11.0.0");
          const bash = fx.write("bash.exe"); respond(bash, ["--version"], "GNU bash 5.2");
          fx.write("uv.exe"); fx.write("winget.exe");
          const pwsh = fx.write("pwsh.exe");
          respond(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], "7");
          writeFileSync(script, JSON.stringify({ responses }));
          const flags = { CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: record };
          const restore = setEnv(flagSource === "host" ? flags : { CC_TEST_FAKE_CLI: "", CC_TEST_FAKE_CLI_SCRIPT: "", CC_TEST_FAKE_CLI_RECORD: "" });
          const env = { ...fx.env, KIMI_CODE_GIT_BASH_PATH: bash, ...(flagSource === "injected" ? flags : {}) };
          const phases: string[] = [];
          const service = new SettingsService({ dataRoot: fx.data, env, refreshPath: async () => {},
            onChange: () => { if (action === "install") phases.push(service.state.catalogTools[entry.id].action?.phase ?? ""); } });
          if (entry.id === "opencode" && action === "login") Object.assign(service.state.catalogTools.opencode, { installed: true, supportedVersion: true, credentialSource: "none" });
          const label = `${flagSource}/${action}/${entry.id}`;
          api.state.setSettingsService(service);
          const socket = [...api.state.clients][0];
          const refuse = async (type: string, expected: string) => {
            const requestId = `safe-${entry.id}`;
            api.messages.handleMessage(socket, JSON.stringify({ type, requestId, ...(type === "ghLogin" ? {} : { cli: entry.id }), ...(type === "installCli" ? { confirm: true } : {}) }));
            const deadline = Date.now() + 2000;
            if (type === "cliLogin" && entry.id === "opencode") {
              while (!ctx.replies.some((reply) => reply.type === "cliLoginState" && reply.phase === "waitingKey")) {
                assert.ok(Date.now() < deadline, label + ": key panel did not open"); await new Promise((done) => setImmediate(done));
              }
              const loginId = ctx.replies.find((reply) => reply.type === "cliLoginState" && reply.loginId).loginId;
              api.messages.handleMessage(socket, JSON.stringify({ type: "submitCliLoginKey", requestId: "safe-save", cli: "opencode", loginId, apiKey: "synthetic-safe-key" }));
            }
            while (!ctx.replies.some((reply) => ["error", "actionResult"].includes(reply.type) && reply.requestId === requestId)) {
              assert.ok(Date.now() < deadline, `${label}: handler did not finish`);
              await new Promise((done) => setImmediate(done));
            }
            const result = ctx.replies.find((reply) => ["error", "actionResult"].includes(reply.type) && reply.requestId === requestId);
            assert.equal(result.type, "error", label); assert.equal(result.message, expected, label);
            assert.equal(api.state.requestActions[requestId].status, "failed", label);
          };
          try {
            if (action === "github") {
              await refuse("ghLogin", "could not open the GitHub login window");
              assert.equal(service.state.github.action?.status, "failed", label);
            } else if (action === "login") {
              await refuse("cliLogin", "Could not start sign-in.");
              const events = ctx.replies.filter((reply) => reply.type === "cliLoginState");
              assert.equal(events.at(-1)?.reason, "launchFailed", label);
              assert.equal(events.at(-1)?.pasteRequired, false, label);
              assert.equal(service.state.catalogTools[entry.id].action?.message, "Could not start sign-in.", label);
              assert.equal(service.login.busy, false, label);
            } else {
              const reason = entry.id === "copilot" ? "blockedByWindows" : "installFailed";
              await refuse("installCli", INSTALL_MESSAGES[reason]);
              assert.equal(service.state.catalogTools[entry.id].action?.status, "failed", label);
              assert.equal(service.state.catalogTools[entry.id].action?.message, INSTALL_MESSAGES[reason], label);
              assert.equal(service.installer.busy, false, label);
              const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
              if (entry.id === "copilot") assert.ok(calls.some((call) => call[0] === pwsh), `${label}: preflight reached`);
              else {
                assert.ok(phases.includes("installing"), `${label}: recipe must be reached, not a busy refusal`);
              }
            }
            assert.equal(spy.mock.callCount(), 0, `${label}: zero spawns`);
            console.log(`SAFE ${label}: failed with static text; spawn=0`);
          } finally {
            await service.login.drain(); await service.installer.drain(); restore(); fx.close();
          }
        }
      }
    } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  });
}
