import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { CLI_KEY_PROFILES } from "../server/settings/cli-key-profiles.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";

test("each saved-key profile connects through the real Settings handler and completes wizard Start without signedIn", async () => {
  for (const cli of Object.keys(CLI_KEY_PROFILES)) {
    const ctx = setup(), bin = scratchDir(), store = new MemoryCredentialStore();
    const profile = catalogProfile(catalogTool(cli));
    for (const program of new Set([profile.program, catalogTool(cli).detection!.program])) writeFileSync(join(bin, program + ".cmd"), "@echo off\r\n");
    const restore = setEnv({ PATH: bin });
    const service = new api.SettingsService({ dataRoot: scratchDir(), credentialStore: store, runCli: async () => { assert.fail("No vendor may run"); } });
    api.state.setSettingsService(service); api.config.writeAcpClis([]);
    const fields = Object.fromEntries(CLI_KEY_PROFILES[cli].map((f) => [f.id, f.kind === "secret" ? "ccTEST-KEY-" + randomUUID() : f.kind === "choice" ? f.choices![0].value : "model-1"]));
    try {
      Object.assign(service.state.catalogTools[cli], { installed: true, version: "1.0.0", signedIn: false });
      await service.cliKey({ type: "submitCliKey", requestId: randomUUID(), cli, fields }, {});
      assert.equal(service.state.catalogTools[cli].keySaved, true);
      const requestId = randomUUID();
      api.messages.handleMessage([...api.state.clients][0], JSON.stringify({ type: "registerCatalogCli", requestId, cli, confirm: true }));
      for (let i = 0; i < 100 && !ctx.replies.some((r) => r.requestId === requestId); i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(ctx.replies.find((r) => r.requestId === requestId)?.type, "actionResult", cli + " Settings Connect");
      const state = api.broadcast.stateMessage() as any;
      assert.equal(state.settings.catalogTools[cli].signedIn, null, "a saved key leaves sign-in unknown, and Connect and Start still work");
      assert.equal(state.acpClis.find((item: any) => item.id === profile.id)?.leaderEligible, true, cli + " picker accepts saved key");
      assert.equal((await ctx.dispatch({ cli: api.config.acpKindOf(profile), acpConsent: true }))?.type, "actionResult", cli + " wizard Start");
      assert.equal(api.first.firstRunMarker()?.status, "complete");
    } finally { service.cliKeys.close(); restore(); }
  }
});
