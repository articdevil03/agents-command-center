import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, flowFixture } from "./pack29-catalog-flow.setup.ts";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { catalogProfile, assertCatalogLeaderEligible } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { refreshCatalog } from "../server/settings/cli-auth.ts";
import { runInstallRecipe } from "../server/settings/cli-installers.ts";
import { listProcesses } from "../server/leader-common/process-tree.ts";
import { editorTestMs, J, withPage, skipped, click } from "./pack18-editor-harness.ts";
import { showFirstRun, sentCount, sentSince, answer } from "./pack29-onboarding-page.setup.ts";
import { fakeAcp } from "./pack29-fake-acp.setup.ts";
import { firstRunPath } from "../server/first-run/state.ts";
import { initializeWorkspaceRecovery } from "../server/fixed-crew/recovery.ts";
import { stopLeaderSession } from "../server/main/leader-session.ts";
import { leaderChoices, toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

const NONE = { claude: [false, null], codex: [false, null], opencode: [false, null] } as const;
test("Vibe cannot run before uv installation and refreshed prerequisite detection", async () => {
  const fx = flowFixture("qwen"), calls: string[] = [];
  try {
    let refreshed = false;
    const result = await runInstallRecipe(catalogTool("mistral").recipe!, async (_bin, args) => {
      assert.ok(args.includes("-WindowStyle"), "the first executed recipe must install uv with PowerShell");
      calls.push("install uv"); return { code: 0, stdout: "", stderr: "", cleanupConfirmed: true };
    }, fx.env, new AbortController().signal, async () => { refreshed = true; calls.push("discover uv"); })
      .then(() => null, (error) => error);
    assert.ok(result instanceof Error, "uv is absent even after the harmless first recipe, Vibe must not start");
    assert.match(result.message, /Installation failed/);
    assert.equal(refreshed, true, "uv discovery follows successful installation");
    assert.deepEqual(calls, ["install uv", "discover uv"]);
  } finally { await fx.close(); }
});
test("Kimi-only and Qwen-only: real Install click, handler, service, native fake installer, detection, registration and consent and fake first-chat connection", { skip: process.platform !== "win32", timeout: editorTestMs(180_000) }, async (t) => {
  if (skipped(t)) return;
  assert.ok(CLI_CATALOG.length > 0);
  assert.ok(CLI_CATALOG.every((entry) => entry.leader.qualified === false), "no vendor has been qualified by fake installation");
  await withPage(async ({ ev, waitFor, seed }) => {
    await showFirstRun(ev, seed, NONE);
    await toToolStep(ev, "C:\\work\\Flow");
    for (const id of ["kimi", "qwen"] as const) {
      const fx = flowFixture(id);
      const publish = async () => {
        const state = api.broadcast.stateMessage() as any;
        await showFirstRun(ev, seed, NONE, `state.settings=${J(state.settings)};state.cliCatalog=${J(state.cliCatalog)};state.acpClis=${J(state.acpClis)};state.clis=${J(state.clis)};`);
        return state;
      };
      try {
        await refreshCatalog(fx.service.state, fx.native);
        for (const builtin of ["claude", "codex", "opencode"] as const) assert.equal(fx.service.state.tools[builtin].installed, false, `${id}-only: ${builtin} absent`);
        await publish();
        let mark = await sentCount(ev);
        await click(ev, `[data-frun-install="${id}"]`);
        const [message] = await sentSince(ev, "installCli", mark);
        assert.ok(message, `${id}: actual Install click produced a request`);
        assert.deepEqual({ ...message, requestId: "id" }, { type: "installCli", cli: id, confirm: true, requestId: "id" });
        const reply = await fx.dispatch(message);
        assert.equal(reply.type, "actionResult", J(reply)); await answer(ev, message);
        assert.deepEqual(fx.errors, []);
        assert.equal(fx.exists(), true, "local PowerShell script created the CLI");
        assert.deepEqual(fx.refreshes, ["before installer", "after installer"]);
        for (const phase of ["checking", "installing", "verifying"]) assert.ok(fx.phases.includes(phase), `${id}: ${phase} published (${fx.phases})`);
        assert.equal(fx.service.state.catalogTools[id].installed, true);
        assert.equal(fx.service.state.catalogTools[id].signedIn, null);
        assert.equal(fx.service.state.catalogTools[id].action?.status, "done");
        await publish(); mark = await sentCount(ev);
        await click(ev, `[data-frun-connect="${id}"]`);
        const [connect] = await sentSince(ev, "registerCatalogCli", mark);
        assert.ok(connect, `${id}: Connect click names the catalog tool`);
        assert.equal((await fx.dispatch(connect)).type, "actionResult"); await answer(ev, connect);
        const expected = catalogProfile(catalogTool(id));
        assert.deepEqual(api.config.readAcpClis(), [expected], "registration survives a fresh disk read");
        assert.deepEqual(api.state.acpClis, [expected], "registration published in memory");
        const state = await publish(), facts = state.settings.catalogTools[id];
        assert.deepEqual([facts.installed, facts.registered, facts.leaderEligible], [true, true, true]);
        assert.deepEqual([facts.tested, facts.leaderLabel, facts.connection], [false, "Not tested yet", "unknown"]);
        assert.ok((await leaderChoices(ev)).some(([kind, checked]) => kind === `acp:${expected.id}` && !checked), "untested choice is never automatic");
        await waitFor(`document.querySelector('[data-cli="${id}"] .frun-detail').textContent==='Not tested yet. Connection checked when you first chat.'`, `${id}: honest untested status`);
        const kind = `acp:${expected.id}`;
        assert.ok(api.fixedCatalogue().clis.some((cli) => cli.id === kind));
        assert.ok(state.clis.some((cli: any) => cli.id === kind));
        assert.doesNotThrow(() => assertCatalogLeaderEligible(expected, fx.service.state));
        await click(ev, `#frunLeader input[value="${kind}"]`);
        assert.equal(await ev("document.querySelector('#frunNext').disabled"), true, "Full access consent still required");
        await click(ev, "#frunConsent");
        assert.equal(await ev("document.querySelector('#frunNext').disabled"), false);
        // Execute setup through its registered handler, then connect only to an in-memory ACP peer.
        writeFileSync(firstRunPath, JSON.stringify({ version: 1, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" }));
        initializeWorkspaceRecovery(api.config.defaultWorkspaces);
        api.state.setBlockedSeatKeys(new Set());
        api.state.setCliRunner(async () => ({ code: 1, stdout: "", stderr: "not a git repo" }));
        const peer = fakeAcp(); api.state.setAcpSpawn(peer.spawn);
        api.state.setFolderActivity({ watchFolders() {}, noteSession() {} } as any);
        const completed = await fx.dispatch({ type: "completeFirstRun", requestId: `setup-${id}`, name: `Flow ${id}`, folder: fx.data, cli: kind, acpConsent: true });
        assert.equal(completed.type, "actionResult", J(completed));
        assert.equal(peer.launches.length, 0, "installation, registration and setup start no ACP session");
        const tab = api.state.workspaces.projects.at(-1)!.tabs[0];
        try { const leader = api.createTabLeader(tab.id); leader.send("harmless fake first chat"); await peer.connected(); }
        finally { stopLeaderSession(tab.id); api.state.setAcpSpawn(undefined); }
        assert.equal(peer.launches.length, 1);
        // Existing custom manual ACP registration and leader availability still work with no host CLI.
        writeFileSync(join(fx.bin, "custom.cmd"), "@echo off\r\necho 1.2.3\r\n");
        const manual = await fx.dispatch({ type: "addAcpCli", requestId: `manual-${id}`, name: "Manual Flow", command: "custom --acp" });
        assert.equal(manual.type, "actionResult", J(manual));
        assert.equal(manual.id, "manual-flow", "manual registration reply returns the saved id");
        const manualKind = `acp:${manual.id}`;
        assert.ok(api.config.readAcpClis().some((cli) => cli.id === "manual-flow"));
        assert.ok(api.fixedCatalogue().clis.some((cli) => cli.id === manualKind));
        assert.ok(fx.pids.length > 0, `${id}: owned installer PIDs were tracked`);
        const deadline = Date.now() + 30_000;
        for (;;) {
          const alive = await listProcesses(); assert.ok(alive, `${id}: process enumeration must succeed`);
          const remaining = fx.pids.filter((pid) => alive.some((row) => row.pid === pid));
          if (!remaining.length) { console.log(`FLOW ${id}: owned PID wait branch=ended (${fx.pids.join(", ")})`); break; }
          assert.ok(Date.now() < deadline, `${id}: owned PID wait branch=timeout; still alive: ${remaining.join(", ")}`);
          await new Promise((done) => setTimeout(done, 100));
        }
        console.log(`FLOW ${id}: click -> phases -> fake CLI -> PATH refresh -> detected -> persisted/published registration -> untested, consent, fake ACP connected; custom ACP retained`);
      } finally { await fx.close(); }
    }
  }, { fixture: "fixed" });
});
