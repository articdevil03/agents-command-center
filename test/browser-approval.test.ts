import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { harnessSource } from "./source-text.ts";
import { APP_KEY, REPO, phase, assertAuditFinished, C2_APPROVAL_CHECKS } from "./browser-constants.ts";
import { workspaces, waitServer, stopServer, getServerState, fakeParallelState, proxyServer, shutProxy, listen, chromeAudit } from "./browser-helpers.ts";
import { chromeDialogAudit } from "./browser-dialog-audit.ts";

// The mutation runner selects this test. It exercises the same Pack C harness at all three widths,
// plus native Chrome input, without repeating unrelated Pack A/B browser audits per mutation.
test("approval browser guards and Settings lifecycle", async (t) => {
  if (!phase("approvals")) { t.skip("CC_BROWSER_PHASES leaves this part out"); return; }
  const temp = mkdtempSync(join(tmpdir(), "cc-approval-browser-"));
  const home = join(temp, "home"), data = join(temp, "data"), folder = join(temp, "picker");
  mkdirSync(home); mkdirSync(join(data, "config"), { recursive: true }); mkdirSync(folder);
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(workspaces(temp)));
  const fake = join(temp, "cli.json"); writeFileSync(fake, JSON.stringify({ responses: {} }));
  const child = spawn(process.execPath, [join(REPO, "server/index.ts")], { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: fake } });
  attachCrashCatcher(child.pid, "browser");
  let proxy: ReturnType<typeof proxyServer> | null = null;
  try {
    const port = await waitServer(child); // CC_PORT=0: the OS picks it at the server's own listen, so no other test can take it first
    assert.notEqual(port, 4317, "the test server must never use the real app's port");
    const seed = fakeParallelState(await getServerState(port));
    const script = harnessSource();
    for (const width of [1600, 1280, 1024]) {
      proxy = proxyServer(port, { folder, mode: "fake", seed, storageBlocked: width === 1024 }, script);
      const auditPort = await listen(proxy.proxy);
      const audit = await chromeAudit({ port: auditPort, folder, mode: "fake", width, profile: join(temp, "c2-" + width), caseName: "c2", virtualMs: 60000 });
      assert.equal(audit.failure, undefined, "approval browser audit completed: " + audit.failure);
      assertAuditFinished(audit, "audit");
      assert.deepEqual(audit.errors, [], "approval browser runtime errors");
      assert.ok(audit.checks.length > 0, "approval harness found checks");
      const auditNames = audit.checks.map((item: any) => item.name);
      for (const name of C2_APPROVAL_CHECKS) assert.ok(auditNames.includes(name), `missing approval-test check ${name} at ${width}px; matched ${JSON.stringify(auditNames)}`);
      assert.deepEqual(audit.failures ?? [], [], "approval browser call-site failures: " + JSON.stringify(audit.failures));
      console.log("Approval harness " + width + "px: " + audit.checks.length + " checks GREEN");
      if (width === 1600) await chromeDialogAudit({ port: auditPort, folder, width, profile: join(temp, "native"), approvals: true });
      if (width === 1600) await chromeDialogAudit({ port: auditPort, folder, width, profile: join(temp, "native-seat"), seatPointer: true });
      shutProxy(proxy); proxy = null;
    }
  } finally {
    if (proxy) { proxy.wss.close(); proxy.proxy.close(); }
    try { await stopServer(child); } // a stop that rejects or times out still surfaces, after the temp folder is gone
    finally { rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 }); }
  }
});
