import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir, setEnv } from "./temp-root.ts";
import { catalogProfile, registerCatalogConnection } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";

function fixture() {
  const ctx = setup(), bin = scratchDir();
  writeFileSync(join(bin, "gemini.cmd"), "@echo off\r\n");
  api.config.writeAcpClis([]);
  const restore = setEnv({ PATH: bin });
  const dispatch = async (fields: any = {}) => {
    const requestId = `register-${ctx.replies.length}`;
    api.messages.handleMessage([...api.state.clients][0], JSON.stringify({ type: "registerCatalogCli", requestId, cli: "gemini", confirm: true, ...fields }));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const reply = ctx.replies.find((r) => r.requestId === requestId && ["error", "actionResult"].includes(r.type));
      if (reply) return reply;
      assert.ok(Date.now() < deadline, `catalog request did not settle: ${requestId}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  return { ...ctx, bin, dispatch, restore, bytes: () => readFileSync(api.config.acpClisPath, "utf8") };
}
test("real catalog handler refuses ids, extra fields and missing/false confirmation without writes", async () => {
  for (const fields of [
    ...["unknown", "__proto__", "constructor", "toString", "deepseek", "glm", "nemotron", "perplexity", "muse", {}, []].map((cli) => ({ cli })),
    ...["command", "url", "script", "package", "args", "cwd", "env", "pid", "timeout", "other"].map((key) => ({ [key]: "bad" })),
    ...[undefined, false, "true", 1, null].map((confirm) => ({ confirm })),
  ]) {
    const ctx = fixture();
    try {
      const before = ctx.bytes(), reply = await ctx.dispatch(fields);
      assert.equal(reply?.type, "error", JSON.stringify(fields));
      assert.deepEqual(api.state.acpClis, [], JSON.stringify(fields)); assert.equal(ctx.bytes(), before);
    } finally { ctx.restore(); }
  }
});
test("real catalog handler writes and publishes once, survives restart, idempotent, grants no access", async () => {
  const ctx = fixture();
  try {
    const modes = structuredClone(api.state.settingsService.state.permissionModes);
    const expected = catalogProfile(catalogTool("gemini"));
    assert.equal((await ctx.dispatch())?.type, "actionResult");
    assert.deepEqual(api.config.readAcpClis(), [expected]); assert.deepEqual(api.state.acpClis, [expected]);
    const before = ctx.bytes();
    assert.equal((await ctx.dispatch())?.type, "actionResult"); assert.equal(ctx.bytes(), before);
    assert.equal(api.state.acpClis.length, 1);
    assert.deepEqual(api.state.settingsService.state.permissionModes, modes);
    assert.equal(api.first.firstRunMarker()?.status, "pending"); assert.equal(api.state.leaders.size, 0);
    Object.assign(api.state.settingsService.state.catalogTools.gemini, { version: "1.0.0" });
    const state = api.broadcast.stateMessage() as any;
    assert.equal(state.settings.catalogTools.gemini.registered, true);
    assert.equal(state.settings.catalogTools.gemini.installed, true);
    assert.equal(state.settings.catalogTools.gemini.signedIn, null);
    assert.equal(state.settings.catalogTools.gemini.leaderEligible, true);
    assert.equal(state.acpClis[0].leaderEligible, true);
    api.state.settingsService.state.catalogTools.gemini.version = null;
    assert.equal((api.broadcast.stateMessage() as any).acpClis[0].leaderEligible, false, "registration alone never supplies a detected version");
  } finally { ctx.restore(); }
});
test("real handler preserves conflicts and capacity and reports installed connection failure", async () => {
  for (const capacity of [false, true]) {
    const ctx = fixture();
    try {
      const saved = capacity ? Array.from({ length: 12 }, (_, i) => ({ id: `custom-${i}`, name: `Custom ${i}`, program: "custom", args: [] }))
        : [{ ...catalogProfile(catalogTool("gemini")), program: "custom" }];
      api.config.writeAcpClis(saved); api.state.setAcpClis(saved);
      const bytes = ctx.bytes(), reply = await ctx.dispatch();
      assert.equal(reply?.type, "error"); assert.match(reply.message, /^Installed\. Connection could not be added\./);
      assert.match(reply.message, capacity ? /capacity/ : /Conflicting/);
      assert.equal(ctx.bytes(), bytes); assert.deepEqual(api.state.acpClis, saved);
    } finally { ctx.restore(); }
  }
});
test("real handler rejects missing or project-local programs without modifying registrations", async () => {
  for (const path of ["", "project"]) {
    const ctx = fixture();
    try {
      process.env.PATH = path ? ctx.work : "";
      if (path) { writeFileSync(join(ctx.work, "gemini.cmd"), "@echo off\r\n"); api.state.workspaces.projects[0].folder = ctx.work; }
      const reply = await ctx.dispatch();
      assert.equal(reply?.type, "error"); assert.match(reply.message, /Connection could not be added/);
      assert.deepEqual(api.state.acpClis, []);
    } finally { ctx.restore(); }
  }
});
test("registration service validates again and failed persistence never publishes", () => {
  let publishes = 0;
  const deps = { clis: () => [], resolve: () => "C:/external/gemini.cmd", write: () => { throw new Error("disk failure"); }, publish: () => { publishes++; } };
  const message = { type: "registerCatalogCli", requestId: "service", cli: "gemini", confirm: true };
  assert.throws(() => registerCatalogConnection({ ...message, args: [] }, deps), /Unexpected/);
  assert.throws(() => registerCatalogConnection(message, deps), /disk failure/); assert.equal(publishes, 0);
  let writes = 0;
  const existing = catalogProfile(catalogTool("gemini"));
  assert.deepEqual(registerCatalogConnection(message, { ...deps, clis: () => [existing], write: () => { writes++; } }), { id: existing.id });
  assert.equal(writes, 0); assert.equal(publishes, 0);
});
