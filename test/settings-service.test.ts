import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import realFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { parseMcpCommand, permissionModeForSdk, pruneAvatars, SettingsService, type PermissionMode } from "../server/settings.ts";
import { NO_PATH, harness, persistedPermissionMode } from "./settings-helpers.ts";

test("MCP add/remove and Claude plugin install/uninstall use exact argv and reject unsafe values", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.addMcp("codex", "mcp_codex_url", "safe-name", "https://mcp.example/v1");
    await service.addMcp("codex", "mcp_codex_command", "codex-tool", "npx -y codex-server");
    await service.addMcp("claude", "mcp_claude_command", "tool_1", "npx -y @scope/server");
    await service.addMcp("claude", "mcp_claude_url", "claude-tool", "https://claude.example/mcp");
    await service.addMcp("opencode", "mcp_opencode_url", "open-tool", "https://open.example/mcp");
    await service.addMcp("opencode", "mcp_opencode_command", "open-command", "npx -y open-server");
    await service.removeMcp("codex", "mcp_remove_codex", "safe-name", true);
    await service.removeMcp("claude", "mcp_remove_claude", "tool_1", true);
    await service.installPlugin("plugin_install", "helper@official");
    await service.uninstallPlugin("plugin_remove", "helper@official", true);
    const args = h.calls.filter((call) => ["claude", "codex", "opencode"].includes(call.bin)).map((call) => [call.bin, ...call.args]);
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "add", "safe-name", "--url", "https://mcp.example/v1"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "add", "codex-tool", "--", "npx", "-y", "codex-server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "add", "-s", "user", "tool_1", "--", "npx", "-y", "@scope/server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "add", "-s", "user", "--transport", "http", "claude-tool", "https://claude.example/mcp"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["opencode", "mcp", "add", "open-tool", "--url", "https://open.example/mcp"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["opencode", "mcp", "add", "open-command", "--", "npx", "-y", "open-server"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["codex", "mcp", "remove", "safe-name"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "mcp", "remove", "-s", "user", "tool_1"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "plugin", "install", "helper@official"])));
    assert.ok(args.some((row) => JSON.stringify(row) === JSON.stringify(["claude", "plugin", "uninstall", "helper@official"])));
    assert.equal(h.calls.filter((call) => call.args.join(" ") === "mcp list").length, 10, "every MCP and Claude plugin action refreshes inventory");
    assert.equal(h.calls.filter((call) => call.args.join(" ") === "plugin list").length, 5, "every Claude inventory change refreshes plugin inventory too");
    const before = h.calls.length;
    await assert.rejects(service.addMcp("codex", "mcp_bad_name", "../bad", "npx server"), /invalid MCP name/);
    for (const leading of ["-s", "--transport", "_x", ".x"]) {
      await assert.rejects(service.addMcp("claude", "mcp_dash_add", leading, "https://mcp.example/v1"), /invalid MCP name/);
      await assert.rejects(service.removeMcp("claude", "mcp_dash_remove", leading, true), /invalid MCP name/);
    }
    for (const leading of ["-g", "--scope", "@x/y", ".x", "/x"]) {
      await assert.rejects(service.installPlugin("plugin_dash_add", leading), /invalid plugin name/);
      await assert.rejects(service.uninstallPlugin("plugin_dash_remove", leading, true), /invalid plugin name/);
    }
    await assert.rejects(service.addMcp("codex", "mcp_bad_shell", "safe", "npx server && whoami"), /shell metacharacters/);
    await assert.rejects(service.addMcp("claude", "mcp_url_password", "safe", "https://user:secret@mcp.example/v1"), /without credentials/);
    await assert.rejects(service.addMcp("codex", "mcp_url_user", "safe", "https://token@mcp.example/v1"), /without credentials/);
    assert.throws(() => parseMcpCommand("https://user:secret@mcp.example"), /without credentials/);
    assert.throws(() => parseMcpCommand("https://token@mcp.example"), /without credentials/);
    assert.equal(h.calls.slice(before).some((call) => call.args.some((arg) => arg.includes("secret") || arg.includes("token@"))), false, "a URL with credentials never reaches a CLI");
    await assert.rejects(service.removeMcp("opencode", "mcp_no_remove", "safe", true), /unavailable/);
    await assert.rejects(service.removeMcp("claude", "mcp_no_confirm", "safe", false), /confirmation is required/);
    await assert.rejects(service.uninstallPlugin("plugin_no_confirm", "helper", false), /confirmation is required/);
    assert.equal(h.calls.slice(before).some((call) => call.args.includes("../bad") || call.args.includes("whoami")), false);
  } finally { h.close(); }
});

test("notes vault and default folder require real absolute directories and survive reload", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.setNotesVault("vault_set", h.vault);
    await service.setDefaultProjectFolder("folder_set", h.project);
    assert.equal(service.state.vault.path, h.vault);
    assert.equal(service.state.folders.defaultProjectFolder, h.project);
    await assert.rejects(service.setNotesVault("vault_traversal", "../outside"), /without traversal/);
    await assert.rejects(service.setDefaultProjectFolder("folder_traversal", `${h.project}\\..\\outside`), /without traversal/);
    await assert.rejects(service.setDefaultProjectFolder("folder_file", service.path), /must be a directory/);
    assert.equal(service.state.preferenceAction?.requestId, "folder_file");
    assert.equal(service.state.preferenceAction?.status, "failed");
    const restarted = h.service();
    assert.equal(restarted.state.vault.path, h.vault);
    assert.equal(restarted.state.folders.defaultProjectFolder, h.project);
    await restarted.setNotesVault("vault_clear", null);
    assert.equal(restarted.state.vault.path, null);
  } finally { h.close(); }
});

test("permission mode maps to SDK values, applies live before saving, and persists per tab", async () => {
  const h = harness();
  try {
    const service = h.service();
    const calls: string[] = [];
    const shouldNotStop = () => false;
    assert.deepEqual(["ask", "accept", "plan", "bypass"].map((mode) => permissionModeForSdk(mode as any)), ["default", "acceptEdits", "plan", "bypassPermissions"]);
    assert.equal(service.permissionMode("alpha-development"), "accept");
    await assert.rejects(service.setPermissionMode("alpha-development", "perm_no_confirm", "bypass", false, async () => true, shouldNotStop), /confirmation is required/);
    assert.deepEqual(calls, []);
    await service.setPermissionMode("alpha-development", "perm_plan", "plan", false, async (mode) => {
      calls.push(mode);
      assert.equal(service.permissionMode("alpha-development"), "accept", "state remains saved until the live change succeeds");
      assert.equal(persistedPermissionMode(service.path, "alpha-development"), "accept", "disk remains saved until the live change succeeds");
      return true;
    }, shouldNotStop);
    assert.deepEqual(calls, ["plan"]);
    await service.setPermissionMode("beta-development", "perm_bypass", "bypass", true, async (mode) => {
      calls.push(mode);
      assert.equal(service.permissionMode("beta-development"), "accept");
      assert.equal(persistedPermissionMode(service.path, "beta-development"), "accept");
      return true;
    }, shouldNotStop);
    assert.deepEqual(calls, ["plan", "bypass"]);
    const restarted = h.service();
    assert.equal(restarted.permissionMode("alpha-development"), "plan");
    assert.equal(restarted.permissionMode("beta-development"), "bypass");
  } finally { h.close(); }
});

test("removing workspace tabs deletes their persisted permission modes and actions", async () => {
  const h = harness();
  try {
    const service = h.service();
    await service.setPermissionMode("alpha-development", "perm_remove_tab", "plan", false, async () => true, () => false);
    assert.equal(service.permissionMode("alpha-development"), "plan");
    assert.equal(service.state.permissionActions["alpha-development"].status, "done");

    service.removePermissionModes(["alpha-development"]);

    assert.equal(Object.hasOwn(service.state.permissionModes, "alpha-development"), false);
    assert.equal(Object.hasOwn(service.state.permissionActions, "alpha-development"), false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(service.path, "utf8")).permissionModes, "alpha-development"), false);
    assert.equal(h.service().permissionMode("alpha-development"), "accept", "a restarted service uses the default mode");
  } finally { h.close(); }
});

test("permission mode interleavings keep saved state aligned or stop the chat", async (t) => {
  const scenarios = ["success", "false", "throw", "hang", "late resolve after timeout", "save failure", "three queued A->B->C"] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const h = harness();
      try {
        const timeout = scenario === "hang" || scenario === "late resolve after timeout" ? 25 : undefined;
        const service = h.service(undefined, timeout);
        const tabId = "alpha-development";
        let sessionRunning = true;
        let liveMode: PermissionMode | undefined = "accept";
        let stops = 0;
        const calls: PermissionMode[] = [];
        const stopLiveSession = () => {
          stops++;
          const wasRunning = sessionRunning;
          sessionRunning = false;
          liveMode = undefined;
          return wasRunning;
        };
        const change = (requestId: string, mode: PermissionMode, applyLive: (mode: PermissionMode) => Promise<boolean>) =>
          service.setPermissionMode(tabId, requestId, mode, mode === "bypass", applyLive, stopLiveSession);
        const assertStopped = (expectedSaved: PermissionMode = "accept") => {
          assert.equal(sessionRunning, false, `${scenario}: the chat session must be stopped`);
          assert.equal(stops, 1, `${scenario}: stop the session exactly once`);
          assert.equal(liveMode, undefined, `${scenario}: a stopped session has no live mode`);
          assert.equal(service.permissionMode(tabId), expectedSaved, `${scenario}: saved state stays in the prior mode`);
          assert.equal(persistedPermissionMode(service.path, tabId), expectedSaved, `${scenario}: disk stays in the prior mode`);
        };
        const assertChatStoppedError = async (operation: Promise<PermissionMode>, expected: RegExp) => {
          await assert.rejects(operation, (error: Error) => {
            assert.match(error.message, expected, `${scenario}: includes the failure reason`);
            assert.match(error.message, /the chat was stopped/i, `${scenario}: tells the user the chat stopped`);
            assert.match(error.message, /next message starts a fresh session in saved mode accept/i, `${scenario}: says the next message starts fresh in saved mode`);
            assert.match(error.message, /conversation context is lost/i, `${scenario}: says the conversation context is lost`);
            return true;
          });
        };

        if (scenario === "success") {
          const result = await change("perm_success", "plan", async (mode) => { calls.push(mode); liveMode = mode; return true; });
          assert.equal(result, "plan");
          assert.equal(sessionRunning, true);
          assert.equal(stops, 0);
          assert.equal(liveMode, "plan");
          assert.equal(service.permissionMode(tabId), "plan");
          assert.equal(persistedPermissionMode(service.path, tabId), "plan");
        } else if (scenario === "false") {
          await assertChatStoppedError(change("perm_false", "plan", async (mode) => { calls.push(mode); return false; }), /failed/i);
          assertStopped();
        } else if (scenario === "throw") {
          await assertChatStoppedError(change("perm_throw", "plan", async (mode) => { calls.push(mode); throw new Error("sdk failure"); }), /failed/i);
          assertStopped();
        } else if (scenario === "hang") {
          await assertChatStoppedError(change("perm_hang", "plan", async (mode) => { calls.push(mode); return new Promise<boolean>(() => {}); }), /timed out/i);
          assertStopped();
        } else if (scenario === "late resolve after timeout") {
          let resolveLate!: (ok: boolean) => void;
          let signalStarted!: () => void;
          const started = new Promise<void>((resolve) => { signalStarted = resolve; });
          const applyLive = (mode: PermissionMode): Promise<boolean> => {
            calls.push(mode);
            if (mode === "plan") {
              signalStarted();
              return new Promise<boolean>((resolve) => {
                resolveLate = (ok) => { if (sessionRunning && ok) liveMode = mode; resolve(ok); };
              });
            }
            if (!sessionRunning) return Promise.resolve(true);
            liveMode = mode;
            return Promise.resolve(true);
          };
          const timedOut = change("perm_late", "plan", applyLive);
          await started;
          const next = change("perm_after_timeout", "ask", applyLive);
          const [firstResult, nextResult] = await Promise.allSettled([timedOut, next]);
          assert.equal(firstResult.status, "rejected", `${scenario}: timed out request must fail`);
          assert.equal(nextResult.status, "fulfilled", `${scenario}: later request must drain the queue`);
          const error = firstResult.status === "rejected" ? firstResult.reason as Error : new Error("expected timeout");
          assert.match(error.message, /timed out/);
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          const modeBeforeLateResolve = liveMode;
          resolveLate(true);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(liveMode, modeBeforeLateResolve, `${scenario}: late resolution on a stopped handle changes nothing`);
          assert.equal(sessionRunning, false, `${scenario}: the timed out handle was stopped`);
          assert.equal(stops, 1, `${scenario}: the timed out handle was stopped once`);
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          assert.match(error.message, /the chat was stopped/i);
          assert.match(error.message, /next message starts a fresh session in saved mode accept/i);
          assert.match(error.message, /conversation context is lost/i);
        } else if (scenario === "save failure") {
          mkdirSync(service.path);
          await assertChatStoppedError(change("perm_save_fail", "plan", async (mode) => { calls.push(mode); liveMode = mode; return true; }), /could not be saved/i);
          assert.equal(sessionRunning, false, `${scenario}: a successful live apply with a failed save stops the session`);
          assert.equal(stops, 1);
          assert.equal(liveMode, undefined);
          assert.equal(service.permissionMode(tabId), "accept", `${scenario}: state is not advanced before save succeeds`);
          removeWithRetry(service.path);
          assert.equal(persistedPermissionMode(service.path, tabId), "accept", `${scenario}: reloading cannot see the unsaved mode`);
        } else {
          let finishA!: (ok: boolean) => void;
          let signalAStarted!: () => void;
          const aStarted = new Promise<void>((resolve) => { signalAStarted = resolve; });
          const gateA = new Promise<boolean>((resolve) => { finishA = resolve; });
          const applyLive = (mode: PermissionMode): Promise<boolean> => {
            calls.push(mode);
            if (mode === "plan") {
              signalAStarted();
              return gateA.then((ok) => { if (ok && sessionRunning) liveMode = mode; return ok; });
            }
            if (!sessionRunning) return Promise.resolve(true);
            liveMode = mode;
            return Promise.resolve(true);
          };
          const a = change("perm_a", "plan", applyLive);
          await aStarted;
          const b = change("perm_b", "bypass", applyLive);
          const c = change("perm_c", "ask", applyLive);
          const results = Promise.allSettled([a, b, c]);
          finishA(true);
          const [ra, rb, rc] = await results;
          assert.deepEqual(calls, ["plan", "ask"], `${scenario}: the unstarted middle request is skipped`);
          assert.equal(ra.status, "fulfilled");
          assert.equal(rb.status, "rejected");
          if (rb.status === "rejected") assert.match(rb.reason.message, /superseded/);
          assert.deepEqual(rc, { status: "fulfilled", value: "ask" });
          assert.equal(sessionRunning, true);
          assert.equal(stops, 0);
          assert.equal(liveMode, "ask");
          assert.equal(service.permissionMode(tabId), "ask");
          assert.equal(persistedPermissionMode(service.path, tabId), "ask");
          assert.deepEqual(service.state.permissionActions[tabId], { requestId: "perm_c", status: "done", message: "Done" });
        }
      } finally { h.close(); }
    });
  }
});

test("uploads status stays at 32 entries whether they start or finish, so finishing alone cannot grow state", () => {
  const h = harness();
  try {
    const service = h.service();
    for (let index = 0; index < 40; index++) service.finishUpload(`finish_only_${index}`, false, "refused");
    const kept = Object.keys(service.state.uploads);
    assert.equal(kept.length, 32);
    assert.equal(kept[0], "finish_only_8");
    for (let index = 0; index < 40; index++) service.beginUpload(`begin_${index}`);
    assert.equal(Object.keys(service.state.uploads).length, 32);
  } finally { h.close(); }
});

// ---- a settings.json that cannot be used starts the app on defaults and is kept as settings.json.bad-<timestamp> ----

for (const [label, content] of [["empty", ""], ["unparsable", '{"notesVaultPath": "C:/vau'], ["malformed", '{"permissionModes": []}'], ["an invalid mode", '{"permissionModes": {"alpha-dev": "yolo"}}']] as const) {
  test(`SettingsService: a ${label} settings.json starts on defaults and keeps a .bad copy`, () => {
    const root = mkdtempSync(join(tmpdir(), "cc-settings-bad-"));
    const original = console.error;
    console.error = () => {};
    try {
      writeFileSync(join(root, "settings.json"), content);
      const service = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
      assert.equal(service.state.vault.path, null);
      assert.deepEqual(service.state.permissionModes, {});
      const kept = readdirSync(root).filter((name) => /^settings\.json\.bad-\d+/.test(name));
      assert.equal(kept.length, 1, `one kept copy: ${JSON.stringify(readdirSync(root))}`);
      assert.equal(readFileSync(join(root, kept[0]), "utf8"), content, "the kept copy is the bad file, byte for byte");
    } finally { console.error = original; removeWithRetry(root); }
  });
}

test("SettingsService: a good settings.json is read as before and no .bad copy is made", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-good-"));
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ notesVaultPath: null, defaultProjectFolder: "C:/work", permissionModes: { "alpha-dev": "plan" } }));
    const service = new SettingsService({ dataRoot: root, env: NO_PATH });
    assert.equal(service.permissionMode("alpha-dev"), "plan");
    assert.deepEqual(readdirSync(root), ["settings.json"]);
  } finally { removeWithRetry(root); }
});

test("SettingsService: after a damaged settings.json every tab without a saved mode asks, through a save and a restart; a fresh install still accepts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-settings-recover-")), fresh = mkdtempSync(join(tmpdir(), "cc-settings-fresh-"));
  const original = console.error;
  console.error = () => {};
  try {
    writeFileSync(join(root, "settings.json"), '{"permissionModes": {"alpha-dev": "pla');
    const first = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
    assert.equal(first.permissionMode("alpha-dev"), "ask", "the tab that was Plan no longer auto-accepts");
    assert.match(first.takeRecoveryNotice() ?? "", /damaged/);
    assert.equal(first.takeRecoveryNotice(), null, "the owner is told once");
    await first.setNotesVault("recover_vault", root);
    await first.setPermissionMode("beta-dev", "recover_pick", "accept", false, async () => true, () => false);
    const second = new SettingsService({ dataRoot: root, env: NO_PATH, runCli: async () => ({ code: 127, stdout: "", stderr: "" }) });
    assert.equal(second.permissionMode("alpha-dev"), "ask", "still Ask after a save and a restart");
    assert.equal(second.permissionMode("beta-dev"), "accept", "a mode the owner picked sticks");
    assert.equal(second.takeRecoveryNotice(), null, "a good file is not a recovery");
    assert.equal(new SettingsService({ dataRoot: fresh, env: NO_PATH }).permissionMode("alpha-dev"), "accept", "control: no file at all is a fresh install");
  } finally { console.error = original; removeWithRetry(root); removeWithRetry(fresh); }
});

test("SettingsService: a save is flushed to disk (fsync) before the atomic rename", async () => {
  // Real fs calls, recorded in order: node:fs's named exports are re-synced after the recorders are installed and again after they are removed.
  const events: string[] = [];
  const real = { fsyncSync: realFs.fsyncSync, renameSync: realFs.renameSync };
  const h = harness();
  try {
    realFs.fsyncSync = ((fd: number) => { events.push("fsync"); return real.fsyncSync(fd); }) as typeof realFs.fsyncSync;
    realFs.renameSync = ((from: string, to: string) => { events.push(`rename ${basename(to)}`); return real.renameSync(from, to); }) as typeof realFs.renameSync;
    syncBuiltinESMExports();
    await h.service().setNotesVault("vault_fsync", h.vault);
  } finally { realFs.fsyncSync = real.fsyncSync; realFs.renameSync = real.renameSync; syncBuiltinESMExports(); h.close(); }
  const rename = events.findIndex((e) => e === "rename settings.json");
  assert.ok(rename > 0, `the save renamed settings.json into place: ${JSON.stringify(events)}`);
  assert.ok(events.slice(0, rename).includes("fsync"), `an fsync ran before the rename: ${JSON.stringify(events)}`);
});

// ---- avatars no longer referenced are deleted when a new one is saved ----

test("pruneAvatars: deletes unreferenced uploaded pictures, keeps the new one and every picture a seat still uses, nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-avatars-"));
  try {
    const id = (n: number) => `avatar-${String(n).repeat(8)}-1111-2222-3333-${String(n).repeat(12)}.png`;
    const [oldOne, used, fresh] = [id(1), id(2), id(3)];
    for (const name of [oldOne, used, fresh, "notes.txt", "avatar-not-a-uuid.png"]) writeFileSync(join(dir, name), "x");
    const young = id(4);
    writeFileSync(join(dir, young), "x");
    const longAgo = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(dir, oldOne), longAgo, longAgo);
    const removed = pruneAvatars(dir, [`/api/avatar/${used}`, "avatars/ash.svg", undefined as any], fresh);
    assert.deepEqual(removed, [oldOne], "only the unreferenced file older than 10 minutes goes");
    assert.deepEqual(readdirSync(dir).sort(), [fresh, used, young, "avatar-not-a-uuid.png", "notes.txt"].sort(), "an unreferenced file younger than 10 minutes stays");
    assert.deepEqual(pruneAvatars(join(dir, "missing"), [], fresh), [], "a missing folder is not an error");
  } finally { removeWithRetry(dir); }
});
