import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { scratchDir, setEnv } from "./temp-root.ts";

// A stale capability snapshot isolates the real setup assertion from the capability filter.
const signature = "export function fixedCatalogue(): AssignmentCatalogue {";
let found = 0;
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/server/main/fixed-crew.ts")) return result;
  const source = String(result.source); assert.equal(source.split(signature).length, 2); found++;
  return { ...result, source: source.replace(signature, signature + "\nif ((globalThis as any).__waStaleCatalogue) return (globalThis as any).__waStaleCatalogue;") };
} });
const { api, setup } = await import("./pack29-first-run.setup.ts");
const { catalogProfile } = await import("../server/settings/catalog-acp.ts");
const { catalogTool } = await import("../server/settings/cli-catalog-validation.ts");
const { fixedCatalogue } = await import("../server/main/fixed-crew.ts");
hook.deregister();

test("real setup rechecks catalog availability even with a stale eligible capability snapshot", async () => {
  assert.equal(found, 1, "stale snapshot seam FOUND once");
  const ctx = setup(), bin = scratchDir(), profile = catalogProfile(catalogTool("qwen"));
  writeFileSync(join(bin, "qwen.cmd"), "@echo off\r\n");
  const restore = setEnv({ PATH: bin }); let spawns = 0;
  api.state.setAcpSpawn((() => { spawns++; throw new Error("no premature spawn"); }) as any);
  api.state.setAcpClis([profile]);
  Object.assign(api.state.settingsService.state.catalogTools.qwen, { installed: true, version: "1.2.3" });
  const kind = api.config.acpKindOf(profile), snapshot = fixedCatalogue();
  assert.ok(snapshot.clis.some((cli) => cli.id === kind), "control: eligible capability FOUND");
  (globalThis as any).__waStaleCatalogue = snapshot;
  api.state.settingsService.state.catalogTools.qwen.installed = false;
  const before = ctx.bytes();
  try {
    const reply = await ctx.dispatch({ cli: kind, acpConsent: true });
    assert.equal(reply?.type, "error", "stale capabilities cannot complete unavailable selection");
    assert.deepEqual(ctx.bytes(), before, "workspace and pending marker remain byte identical");
    assert.equal(ctx.calls(), 0); assert.equal(spawns, 0);
  } finally { delete (globalThis as any).__waStaleCatalogue; api.state.setAcpSpawn(undefined); restore(); }
});
