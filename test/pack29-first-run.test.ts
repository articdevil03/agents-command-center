import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./temp-root.ts";
import { api, dataDir, markerBytes, put, setup, startup } from "./pack29-first-run.setup.ts";

test("p29 first-run fixture matrix: empty and Chromium scaffolding roots are pending", () => {
  for (const scaffold of [false, true]) {
    const root = scratchDir();
    if (scaffold) {
      put(root, "Local State", "{}");
      for (const dir of ["Cache", "GPUCache", "logs", "scratch"]) mkdirSync(join(root, dir));
    }
    const result = startup(root);
    assert.equal(result.required, true, `scaffolding=${scaffold}`);
    assert.equal(result.marker?.status, "pending");
    assert.equal(result.recovery.recovered, false);
    assert.equal(result.workspace.projects[0].id, "example");
    const original = readFileSync(join(root, "config/first-run.json"), "utf8");
    assert.equal(startup(root).required, true, "pending resumes after a real module reload");
    assert.equal(readFileSync(join(root, "config/first-run.json"), "utf8"), original);
  }
});
test("p29 existing example and real projects never get onboarding", () => {
  for (const id of ["example", "existing"]) {
    const root = scratchDir(), saved = api.config.defaultWorkspaces(root);
    saved.projects[0].id = id;
    put(root, "config/workspaces.json", JSON.stringify(saved));
    const result = startup(root);
    assert.equal(result.required, false); assert.equal(result.marker, null);
    assert.equal(existsSync(join(root, "config/first-run.json")), false);
  }
});

test("p29 empty logs stay pending but one log entry triggers prior-data recovery", () => {
  for (const hasEntry of [false, true]) {
    const root = scratchDir(); mkdirSync(join(root, "logs"));
    if (hasEntry) put(root, "logs/history.log", "old log");
    const result = startup(root);
    assert.equal(result.recovery.blocked, false);
    assert.equal(result.recovery.recovered, hasEntry, `log entry=${hasEntry}`);
    assert.equal(result.required, !hasEntry);
    if (hasEntry) {
      assert.equal(result.marker, null);
      assert.match(result.workspace.projects[0].id, /^fresh-/);
      assert.equal(readFileSync(join(root, "logs/history.log"), "utf8"), "old log");
    } else {
      assert.equal(result.marker?.status, "pending");
      assert.equal(result.workspace.projects[0].id, "example");
    }
  }
});
test("p29 prior app inventory and legacy/damaged/blocked recovery never onboard", () => {
  const paths = ["config/projects.json", "config/setups.json", "config/launch-safety.json", "requests.json",
    "config/client-prefs.json", "config/own-sessions.json", "config/acp-clis.json", "settings.json",
    "chats/history.jsonl", "logs/history.log", "tasks/history.json", "executions/history.json", "avatars/a.png",
    "backups/prior.json", "example-project/file.txt", "config/workspaces.json", "config/fixed-crew-recovery.json"];
  for (const path of paths) {
    const root = scratchDir(); put(root, path, "old bytes");
    const result = startup(root);
    assert.equal(result.required, false, path); assert.equal(result.marker, null, path);
    assert.equal(existsSync(join(root, "config/first-run.json")), false, path);
    if (["config/projects.json", "config/setups.json"].includes(path)) assert.match(result.workspace.projects[0].id, /^fresh-/);
    if (path === "config/fixed-crew-recovery.json") assert.equal(result.recovery.blocked, true);
  }
});
test("p29 corrupt and future markers are not pending and are never rewritten", () => {
  for (const bytes of ["{", JSON.stringify({ version: 99, status: "pending", createdAt: "2026-01-01" })]) {
    const root = scratchDir(); put(root, "config/first-run.json", bytes);
    const result = startup(root);
    assert.equal(result.required, false); assert.equal(result.marker, null);
    assert.equal(readFileSync(join(root, "config/first-run.json"), "utf8"), bytes);
  }
});
test("p29 interrupted workspace save completes on restart with no duplicate", () => {
  const root = scratchDir(), saved = api.config.defaultWorkspaces(root);
  saved.projects[0].id = "mine"; saved.projects[0].tabs[0].id = "mine-development";
  put(root, "config/first-run.json", markerBytes); put(root, "config/workspaces.json", JSON.stringify(saved));
  const before = readFileSync(join(root, "config/workspaces.json"), "utf8"), result = startup(root);
  assert.equal(result.required, false); assert.equal(result.marker?.status, "complete");
  assert.equal(result.workspace.projects.length, 1);
  assert.equal(readFileSync(join(root, "config/workspaces.json"), "utf8"), before);
  assert.equal(startup(root).marker.status, "complete");
});
test("p29 real registered completion saves once, chosen ready leader, preserves folders and restarts", async () => {
  const ctx = setup();
  assert.deepEqual(api.broadcast.stateMessage().firstRun, { required: true });
  put(ctx.work, "AGENTS.md", "owner instructions");
  assert.equal((await ctx.dispatch({ projectOnly: true }))?.type, "actionResult");
  assert.equal(ctx.calls(), 1, "exactly one real writeWorkspaces call");
  const saved = api.config.readWorkspaces();
  assert.deepEqual(saved.projects.map((p) => p.id), ["my-project"]);
  assert.equal(saved.projects[0].tabs[0].name, "Development");
  assert.equal(saved.projects[0].tabs[0].fixedCrew?.preferences.leader.assignment?.cli, "codex");
  assert.equal(api.state.selectedTabId, saved.projects[0].tabs[0].id);
  assert.equal(existsSync(join(dataDir, "example-project")), true, "physical example folder remains");
  assert.equal(readFileSync(join(ctx.work, "AGENTS.md"), "utf8"), "owner instructions");
  assert.deepEqual(readdirSync(ctx.work), ["AGENTS.md"]);
  assert.equal(api.first.firstRunMarker()?.status, "complete");
  assert.deepEqual(api.broadcast.stateMessage().firstRun, { required: false });
  assert.ok(ctx.replies.some((r) => r.type === "state" && r.firstRun.required === false));
  const restart = startup(dataDir);
  assert.equal(restart.required, false); assert.deepEqual(restart.workspace, saved);
});
test("p29 real handler refusals keep marker and workspace byte identical and folder unchanged", async () => {
  const ctx = setup(), tool = api.state.settingsService.state.tools.codex;
  for (const [installed, signedIn, pattern] of [
    [false, true, /not installed/], [true, false, /not signed in/], [null, true, /installation status unknown/],
    [true, null, /sign-in status unknown/], [null, null, /unknown/],
  ] as const) {
    Object.assign(tool, { installed, signedIn });
    const before = ctx.bytes(), reply = await ctx.dispatch({ projectOnly: true });
    assert.equal(reply?.type, "error"); assert.match(reply.message, pattern);
    assert.deepEqual(ctx.bytes(), before, `${installed}/${signedIn}`);
    assert.deepEqual(readdirSync(ctx.work), []);
  }
  Object.assign(tool, { installed: true, signedIn: true });
  put(ctx.work, "file", "untouched");
  const invalid = [
    { cli: "gemini" }, { cli: "unknown" }, { cli: null }, { folder: "relative" }, { folder: join(ctx.work, "missing") },
    { folder: join(ctx.work, "file") }, { folder: `${ctx.work}/../traversal` }, { name: " " }, { name: "!!!" },
    { name: "a".repeat(101) }, { name: "bad\nname" }, { id: "forged" },
    { signedIn: true }, { installed: true }, { crewChoices: {} }, { projectOnly: "true" }, { requestId: undefined },
  ];
  for (const fields of invalid) {
    const before = ctx.bytes(), reply = await ctx.dispatch({ projectOnly: true, ...fields });
    // A missing request id cannot be correlated, but still must produce an error.
    assert.equal(reply?.type ?? ctx.replies.at(-1)?.type, "error", JSON.stringify(fields));
    assert.deepEqual(ctx.bytes(), before, JSON.stringify(fields));
    assert.deepEqual(readdirSync(ctx.work), ["file"]);
  }
  api.first.finishFirstRun();
  const before = ctx.bytes();
  assert.match((await ctx.dispatch())?.message, /setup is already finished/);
  assert.deepEqual(ctx.bytes(), before); assert.equal(ctx.calls(), 0);
});
test("p29 failed workspace publication leaves setup pending and writes no project rules", async () => {
  const ctx = setup(), before = ctx.bytes(); ctx.failWrite();
  const reply = await ctx.dispatch({ projectOnly: true });
  assert.equal(reply?.type, "error"); assert.match(reply.message, /forced workspace write failure/);
  assert.equal(ctx.calls(), 1); assert.deepEqual(ctx.bytes(), before);
  assert.deepEqual(api.state.workspaces.projects.map((p) => p.id), ["example"]);
  assert.deepEqual(readdirSync(ctx.work), []); assert.equal(api.first.firstRunMarker()?.status, "pending");
});

test("p29 CLI validation refuses unknown, inherited and non-string ids without saving", async () => {
  const ctx = setup();
  for (const cli of ["acp:custom", "missing", "toString", "__proto__", "x".repeat(100), null, 3, {}]) {
    const before = ctx.bytes(), reply = await ctx.dispatch({ cli });
    assert.equal(reply?.type, "error");
    assert.equal(reply.message, `unknown leader CLI: ${String(cli).slice(0, 40)}`);
    assert.deepEqual(ctx.bytes(), before); assert.equal(ctx.calls(), 0);
  }
});

test("p29 an Example name gets a unique id and removes only the untouched example reference", async () => {
  const ctx = setup(), folder = join(dataDir, "example-project"), before = readdirSync(folder);
  assert.equal((await ctx.dispatch({ name: "Example" }))?.type, "actionResult");
  const projects = api.config.readWorkspaces().projects;
  assert.deepEqual(projects.map((p) => [p.id, p.name]), [["example-2", "Example"]]);
  assert.equal(existsSync(folder), true); assert.deepEqual(readdirSync(folder), before);
});

test("p29 saved real projects refuse repeated setup without creating duplicates", async () => {
  for (const occupiedSuffix of [false, true]) {
    const ctx = setup(), folder = join(dataDir, "example-project"), before = readdirSync(folder);
    const existing = structuredClone(api.state.workspaces.projects[0]);
    existing.id = "my-project"; existing.tabs[0].id = "existing-development";
    api.state.workspaces.projects.push(existing);
    if (occupiedSuffix) {
      const second = structuredClone(existing); second.id = "my-project-2"; second.tabs[0].id = "second-development";
      api.state.workspaces.projects.push(second);
    }
    const reply = await ctx.dispatch();
    assert.equal(reply?.type, "error");
    assert.match(reply.message, /setup is already finished/);
    const projects = api.state.workspaces.projects;
    assert.equal(ctx.calls(), 0);
    assert.equal(projects.length, occupiedSuffix ? 3 : 2);
    assert.ok(projects.some((p) => p.id === "my-project"));
    assert.ok(projects.some((p) => p.id === "example"));
    assert.equal(existsSync(folder), true); assert.deepEqual(readdirSync(folder), before);
  }
});
test("p29 keeps example references with chat history, active work or folder contents", async () => {
  for (const reason of ["history", "active", "files", "tasks", "executions", "empty-chat"]) {
    const ctx = setup();
    if (reason === "tasks" || reason === "executions") put(dataDir, `${reason}/example-development.json`, "{}");
    if (reason === "empty-chat") put(api.state.chatStore.directory, "example-development.jsonl", "");
    if (reason === "history") api.state.chatStore.appendMessage("example-development", "user", "keep this chat");
    if (reason === "active") api.state.activeLeaderTurns.add("example-development");
    if (reason === "files") put(dataDir, "example-project/keep.txt", "keep me");
    try {
      assert.equal((await ctx.dispatch())?.type, "actionResult", reason);
      assert.deepEqual(api.config.readWorkspaces().projects.map((p) => p.id), ["example", "my-project"], reason);
      if (reason === "files") assert.equal(readFileSync(join(dataDir, "example-project/keep.txt"), "utf8"), "keep me");
    } finally { if (reason === "files") unlinkSync(join(dataDir, "example-project/keep.txt"));
      if (reason === "tasks" || reason === "executions") unlinkSync(join(dataDir, reason, "example-development.json")); }
  }
});
test("p29 optional rules are written only after success and only on request", async () => {
  for (const projectOnly of [false, true]) {
    const ctx = setup();
    assert.equal((await ctx.dispatch({ projectOnly }))?.type, "actionResult");
    assert.equal(existsSync(join(ctx.work, "AGENTS.md")), projectOnly);
    assert.equal(api.first.firstRunMarker()?.status, "complete");
  }
});
test("p29 every supported signed-in leader can complete setup", async () => {
  for (const cli of ["claude", "codex", "opencode"] as const) {
    const ctx = setup();
    api.config.applyOpenCodeModels([{ value: "opencode-go/glm-5.2", providerID: "opencode-go", modelID: "glm-5.2", displayName: "Fixture model", variants: ["max", "high"] }], {});
    assert.equal(api.config.isValidEffort("opencode", "max", "opencode-go/glm-5.2"), true);
    assert.equal(api.config.isValidEffort("opencode", "xhigh", "opencode-go/glm-5.2"), false);
    for (const kind of ["claude", "codex", "opencode"] as const) api.state.settingsService.state.tools[kind].signedIn = kind === cli;
    api.state.settingsService.state.catalogTools.opencode.signedIn = cli === "opencode";
    assert.equal((await ctx.dispatch({ cli }))?.type, "actionResult", cli);
    assert.equal(api.config.readWorkspaces().projects[0].tabs[0].fixedCrew?.preferences.leader.assignment?.cli, cli);
  }
});
test("p29 unsupported OpenCode 2 is not a qualifying leader and changes no setup data", async () => {
  const ctx = setup(), before = ctx.bytes();
  api.config.applyOpenCodeModels([{ value: "opencode-go/glm-5.2", providerID: "opencode-go", modelID: "glm-5.2", displayName: "Fixture model", variants: ["max", "high"] }], {});
  for (const kind of ["claude", "codex"] as const) api.state.settingsService.state.tools[kind].signedIn = false;
  for (const facts of [api.state.settingsService.state.tools.opencode, api.state.settingsService.state.catalogTools.opencode]) {
    Object.assign(facts, { installed: true, version: "2.0.0", supportedVersion: false, signedIn: true });
  }
  const reply = await ctx.dispatch({ cli: "opencode" });
  assert.equal(reply?.type, "error");
  assert.equal(reply.message, "opencode is not ready: no supported leader model");
  assert.deepEqual(ctx.bytes(), before); assert.equal(ctx.calls(), 0);
  assert.deepEqual(readdirSync(ctx.work), []);
});

test("p29 skip is registered, strict, pending-only and leaves example workspace unchanged", async () => {
  const ctx = setup(), before = ctx.bytes()[0];
  const skip = async (extra = {}) => {
    const start = ctx.replies.length;
    api.messages.handleMessage({ send(raw: string) { ctx.replies.push(JSON.parse(raw)); } } as any,
      JSON.stringify({ type: "skipFirstRun", requestId: "skip", ...extra }));
    return ctx.replies.slice(start).find((r) => r.type === "error" || r.type === "actionResult");
  };
  assert.equal((await skip({ extra: true }))?.type, "error");
  assert.equal(api.first.firstRunMarker()?.status, "pending");
  assert.equal((await skip())?.type, "actionResult");
  assert.equal(api.first.firstRunMarker()?.status, "complete");
  assert.ok(ctx.replies.some((reply) => reply.type === "state" && reply.firstRun.required === false), "skip broadcasts completed state");
  assert.equal(ctx.bytes()[0], before); assert.equal(ctx.calls(), 0);
  assert.equal((await skip())?.type, "error");
});
test("p29 recovery gate rejects both first-run messages and suppresses required state", async () => {
  const ctx = setup(), before = ctx.bytes();
  api.recovery.blockWorkspaceRecovery();
  assert.deepEqual(api.broadcast.stateMessage().firstRun, { required: false });
  for (const type of ["completeFirstRun", "skipFirstRun"]) {
    // Test the real registry gate as well as the handler's own guard.
    const { assertFixedCrewMessageAllowed } = await import("../server/main/fixed-crew.ts");
    assert.throws(() => assertFixedCrewMessageAllowed({ type }), /Workspace unavailable/);
    const reply = type === "completeFirstRun" ? await ctx.dispatch() : await ctx.dispatch({ type, name: undefined, cli: undefined, folder: undefined });
    assert.equal(reply?.type, "error"); assert.match(reply.message, /Workspace unavailable/);
    assert.deepEqual(ctx.bytes(), before);
  }
});


test("p29 marker failure after saving keeps creation usable and heals on restart", async () => {
  const ctx = setup(); ctx.failFinish();
  assert.equal((await ctx.dispatch({ projectOnly: true }))?.type, "actionResult");
  const saved = api.config.readWorkspaces();
  assert.deepEqual(saved.projects.map((p) => p.id), ["my-project"]);
  assert.equal(api.state.selectedTabId, saved.projects[0].tabs[0].id);
  assert.ok(ctx.replies.some((r) => r.type === "error" && /setup could not be saved as finished.*next time the app starts/.test(r.message)));
  assert.ok(ctx.replies.some((r) => r.type === "state" && r.firstRun.required === false));
  assert.ok(ctx.replies.some((r) => r.type === "projectRules"));
  assert.equal(existsSync(join(ctx.work, "AGENTS.md")), true);
  assert.equal(api.first.firstRunMarker()?.status, "pending");
  assert.deepEqual(api.broadcast.stateMessage().firstRun, { required: false });
  assert.match((await ctx.dispatch())?.message, /setup is already finished/);
  assert.equal(ctx.calls(), 1);
  assert.deepEqual(api.config.readWorkspaces(), saved);
  assert.equal(startup(dataDir).marker.status, "complete");
});

test("p29 example lookalikes are real projects, kept and healed rather than re-onboarded", async () => {
  for (const change of ["folder", "tabs"]) {
    const ctx = setup(), project = api.state.workspaces.projects[0];
    if (change === "folder") project.folder = ctx.work;
    else project.tabs.push({ ...structuredClone(project.tabs[0]), id: "example-second" });
    assert.equal(api.first.isSeededExample(project), false, change);
    assert.equal(api.first.workspaceHasRealProject(api.state.workspaces), true, change);
    assert.deepEqual(api.broadcast.stateMessage().firstRun, { required: false });
    assert.match((await ctx.dispatch())?.message, /setup is already finished/);
    assert.equal(ctx.calls(), 0); assert.equal(api.state.workspaces.projects[0], project);
    put(dataDir, "config/workspaces.json", JSON.stringify(api.state.workspaces));
    const result = startup(dataDir);
    assert.equal(result.required, false); assert.equal(result.marker.status, "complete");
    assert.deepEqual(result.workspace.projects, [project]);
  }
});
