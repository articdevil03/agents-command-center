import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { scratchDir, setEnv } from "./temp-root.ts";
import { api, dataDir, put, setup, startup } from "./pack29-first-run.setup.ts";

const entry = { id: "fake-basic", name: "Fake basic", program: "fake-acp", args: ["--scenario=basic"] };
const kind = api.config.acpKindOf(entry);
function fixture() {
  const ctx = setup(), bin = scratchDir();
  writeFileSync(join(bin, "fake-acp.cmd"), "@echo off\r\n");
  const restore = setEnv({ PATH: bin });
  api.state.setAcpClis([structuredClone(entry)]);
  return { ...ctx, bin, restore, start: (fields = {}) => ctx.dispatch({ cli: kind, acpConsent: true, ...fields }) };
}
async function refused(ctx: ReturnType<typeof fixture>, fields: any, pattern: RegExp) {
  put(ctx.work, "keep.txt", "owner bytes");
  const before = ctx.bytes(), files = readdirSync(ctx.work).map((name) => [name, readFileSync(join(ctx.work, name), "utf8")]);
  const reply = await ctx.start({ projectOnly: true, ...fields });
  assert.equal(reply?.type, "error", JSON.stringify(fields));
  assert.match(reply.message, pattern);
  assert.deepEqual(ctx.bytes(), before, "refusal preserves workspace and marker bytes");
  assert.deepEqual(readdirSync(ctx.work).map((name) => [name, readFileSync(join(ctx.work, name), "utf8")]), files, "refusal preserves project files");
  assert.equal(ctx.calls(), 0);
}

test("p29 ACP saves the chosen default leader once, completes and survives restart", async () => {
  for (const keepExample of [false, true]) {
    const ctx = fixture();
    try {
      if (keepExample) api.state.chatStore.appendMessage("example-development", "user", "keep history");
      api.config.writeAcpClis([entry]);
      assert.equal((await ctx.start())?.type, "actionResult");
      assert.equal(ctx.calls(), 1, "ONE workspace publication");
      const saved = api.config.readWorkspaces(), project = saved.projects.at(-1)!;
      assert.deepEqual(saved.projects.map((p) => p.id), keepExample ? ["example", "my-project"] : ["my-project"]);
      assert.deepEqual(project.tabs[0].fixedCrew?.preferences.leader.assignment, { cli: kind, model: "default", effort: "default" });
      assert.equal(api.first.firstRunMarker()?.status, "complete");
      assert.equal(api.broadcast.stateMessage().firstRun.required, false);
      const restarted = startup(dataDir);
      assert.equal(restarted.required, false); assert.deepEqual(restarted.workspace, saved);
    } finally { ctx.restore(); }
  }
});

test("p29 ACP consent is required by the real handler", async () => {
  for (const acpConsent of [undefined, false, "true", null, 1]) {
    const ctx = fixture();
    try { await refused(ctx, { acpConsent }, typeof acpConsent === "boolean" || acpConsent === undefined
      ? /^Choose Full access to use Fake basic: it can edit files and run commands without asking\.$/ : /acpConsent must be true or false/); }
    finally { ctx.restore(); }
  }
});

test("p29 ACP unknown, removed and malformed kinds refuse without writes", async () => {
  for (const cli of ["acp:unknown", "acp:", "acp:Fake", "acp:fake/basic", kind]) {
    const ctx = fixture();
    try {
      if (cli === kind) {
        api.messages.handleMessage([...api.state.clients][0], JSON.stringify({ type: "removeAcpCli", requestId: "remove", id: entry.id }));
        await new Promise((done) => setImmediate(done));
        assert.deepEqual(api.state.acpClis, []);
      }
      await refused(ctx, { cli }, /unknown leader CLI/);
    } finally { ctx.restore(); }
  }
});

test("p29 ACP revalidates corrupt saved commands", async () => {
  for (const corrupt of [{ program: "../bad" }, { args: ["bad&arg"] }, { args: [3] }]) {
    const ctx = fixture();
    try {
      api.state.setAcpClis([{ ...entry, ...corrupt } as any]);
      await refused(ctx, {}, /plain command name|arguments must be plain words/);
    } finally { ctx.restore(); }
  }
});

test("p29 ACP missing and project-contained programs refuse without writes", async () => {
  for (const inside of [false, true]) {
    const ctx = fixture();
    try {
      unlinkSync(join(ctx.bin, "fake-acp.cmd"));
      if (inside) { writeFileSync(join(ctx.work, "fake-acp.cmd"), "@echo off\r\n"); process.env.PATH = ctx.work; }
      await refused(ctx, {}, inside ? /Choose a project folder/ : /was not found on PATH/);
    } finally { ctx.restore(); }
  }
});

test("p29 ACP pending, recovery, name and folder rules remain enforced", async () => {
  for (const scenario of ["complete", "blocked", "name", "folder"]) {
    const ctx = fixture();
    try {
      if (scenario === "complete") api.first.finishFirstRun();
      if (scenario === "blocked") api.recovery.blockWorkspaceRecovery();
      await refused(ctx, scenario === "name" ? { name: " " } : scenario === "folder" ? { folder: "relative" } : {},
        scenario === "complete" ? /setup is already finished/ : scenario === "blocked" ? /Workspace unavailable/ : scenario === "name" ? /project name/ : /folder/);
    } finally { ctx.restore(); }
  }
});

test("p29 built-in consent accepts only booleans and otherwise leaves readiness unchanged", async () => {
  for (const acpConsent of [undefined, true, false, "yes", null]) {
    const ctx = fixture();
    try {
      if (acpConsent !== undefined && typeof acpConsent !== "boolean") await refused(ctx, { cli: "codex", acpConsent }, /acpConsent must be true or false/);
      else assert.equal((await ctx.start({ cli: "codex", acpConsent }))?.type, "actionResult");
    } finally { ctx.restore(); }
  }
  for (const cli of [undefined, "unknown", "claude"]) {
    const ctx = fixture();
    try { await refused(ctx, { cli }, cli === "claude" ? /not signed in/ : /unknown leader CLI/); }
    finally { ctx.restore(); }
  }
});

// R-6: admission refuses a folder that holds the program, so the guard in complete.ts is reached through the app's own working folder, which admission does not look at.
test("p29 ACP program found only inside the app's working folder is refused by the program guard, not by folder admission", async () => {
  const ctx = fixture(), previous = process.cwd(), working = scratchDir();
  try {
    unlinkSync(join(ctx.bin, "fake-acp.cmd"));
    writeFileSync(join(working, "fake-acp.cmd"), "@echo off\r\n"); process.env.PATH = working;
    process.chdir(working);
    await refused(ctx, {}, /found only inside a project folder/);
  } finally { process.chdir(previous); ctx.restore(); }
});
