import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as security from "../server/security.ts";
import { config, runner, leader, FakeProc, makeRun, captureCallbacks, spawnReturning, configFolder, runArtifact, startRunnerRun } from "./runner-helpers.ts";

test("guard 2: failed CLI discovery keeps the fallback Fable and Codex Luna models", async () => {
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-fable-5-1[1m]"));
  assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-6-luna"));
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-fable-5-1[1m]"));
  assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-6-luna"));
});

test("guard 4: discovered Claude effort support stays attached to its own model", async () => {
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: false }), async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-custom", displayName: "Custom", supportsEffort: false }] }));
  assert.equal(config.CLAUDE_MODEL_INFO.find((model) => model.value === "claude-custom")?.supportsEffort, false);
});

test("isAllowedHost: only the exact localhost and IPv4 loopback host entries pass", () => {
  security.setAllowedPort(4317);
  assert.equal(security.isAllowedHost("127.0.0.1:4317"), true);
  assert.equal(security.isAllowedHost("localhost:4317"), true);
  assert.equal(security.isAllowedHost("127.0.0.1.evil:4317"), false);
  assert.equal(security.isAllowedHost("localhost:80"), false);
});

test("isAllowedOrigin: foreign origins fail while loopback and absent Origin pass", () => {
  security.setAllowedPort(4317);
  assert.equal(security.isAllowedOrigin("https://attacker.invalid"), false);
  assert.equal(security.isAllowedOrigin("http://127.0.0.1:4317"), true);
  assert.equal(security.isAllowedOrigin(undefined), true);
});

test("isSafeSeatId: a safe historical key remains valid outside today's roster", () => {
  assert.equal(config.isSafeSeatId("retired-tab.reviewer"), true);
  assert.equal(config.isSafeSeatId("../outside"), false);
});

test("isSwitchableSeatKind: workspace crew CLIs are only Claude, Codex, or OpenCode", () => {
  assert.equal(config.isValidModel("claude", "claude-opus-5-5[1m]"), true);
  assert.equal(config.isValidModel("codex", "gpt-6-sol"), true);
  assert.equal(config.isValidModel("opencode", "provider/model-v1"), true);
  assert.equal(config.isValidModel("leader" as any, "claude-opus-5"), false);
});

test("isWithinDir: a sibling with the same path prefix is outside the uploaded scratch directory", () => {
  const dir = path.resolve("C:/temp/scratch"), inside = path.resolve(dir, "img.png"), sibling = path.resolve("C:/temp/scratch-evil/img.png");
  assert.equal(security.isWithinDir(inside, dir), true);
  assert.equal(security.isWithinDir(sibling, dir), false);
});

test("killSeat: an unconfirmed process stays owned and has no exit marker until real close", () => {
  const proc = new FakeProc(), killer = new FakeProc(), capture = captureCallbacks();
  const run = makeRun({ runId: "unconfirmed-marker" }), timestamp = startRunnerRun(run, "x", capture.callbacks, spawnReturning(proc));
  runner.killRun("unconfirmed-marker", ((command: string) => command === "taskkill" ? killer : proc) as any);
  killer.emit("error", new Error("taskkill failed"));
  assert.equal(runner.isRunning("unconfirmed-marker"), true);
  assert.equal(capture.unconfirmed.length, 1);
  proc.emit("close", null);
  const log = readFileSync(runArtifact(run, timestamp, "log"), "utf8");
  assert.equal((log.match(/\[exit\]/g) ?? []).length, 1);
});

test("killSeat: taskkill spawn failure keeps the run tracked so another Kill can be attempted", async () => {
  const proc = new FakeProc(), capture = captureCallbacks();
  runner.runSeat(makeRun({ runId: "kill-retry" }), "x", capture.callbacks, spawnReturning(proc));
  assert.equal(runner.killRun("kill-retry", (() => { const killer = new FakeProc(); queueMicrotask(() => killer.emit("error", new Error("no taskkill"))); return killer; }) as any), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.isRunning("kill-retry"), true);
  assert.equal(runner.unconfirmedPid("kill-retry"), proc.pid);
  proc.emit("close", 1);
});

test("killSeat: unknown and already-closed run IDs are not accepted", () => {
  assert.equal(runner.killRun("not-running", (() => new FakeProc()) as any), false);
});

test("migrateSeatsForward: a malformed legacy project file remains byte-for-byte intact", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  const original = "{ broken legacy data"; writeFileSync(projects, original);
  assert.throws(() => config.migrateWorkspaces(projects, destination), /valid JSON/);
  assert.equal(readFileSync(projects, "utf8"), original);
  assert.equal(existsSync(destination), false);
});

test("migrateSeatsForward: legacy projects upcast to a default Development tab with validated crew", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "legacy", name: "Legacy", dir: "C:/legacy" }]));
  assert.equal(config.migrateWorkspaces(projects, destination), true);
  const migrated = config.readWorkspaces(destination).projects[0];
  assert.equal(migrated.tabs[0].kind, "dev");
  const template = config.templateCopy("our-process");
  assert.equal(migrated.tabs[0].crew.length, template.crew.length, "a legacy project starts on Our process");
  assert.equal(migrated.tabs[0].steps.length, template.steps.length);
});

test("migrateSeatsForward: a second migration leaves the existing workspace bytes untouched", () => {
  const { dir } = configFolder(), projects = path.join(dir, "old-projects.json"), destination = path.join(dir, "new-workspaces.json");
  writeFileSync(projects, JSON.stringify([{ id: "legacy", name: "Legacy", dir: "C:/legacy" }]));
  config.migrateWorkspaces(projects, destination); const original = readFileSync(destination, "utf8");
  assert.equal(config.migrateWorkspaces(projects, destination), false);
  assert.equal(readFileSync(destination, "utf8"), original);
});

test("opencodeExtraEnv: a writable OpenCode slot and other CLIs receive no deny override", () => {
  const codex = new FakeProc(); let env: any;
  const spawn = ((_: string, options: any) => { env = options.env; return codex; }) as any;
  runner.runSeat(makeRun({ runId: "open-write-env", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: true }), "x", captureCallbacks().callbacks, spawn);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined); codex.emit("close", 0);
  const claude = new FakeProc(); let claudeEnv: any;
  runner.runSeat(makeRun({ runId: "claude-env", cli: "claude", model: "claude-opus-5-5[1m]" }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { claudeEnv = options.env; return claude; }) as any);
  assert.equal(claudeEnv.OPENCODE_CONFIG_CONTENT, undefined); claude.emit("close", 0);
});

test("opencodeExtraEnv: a read-only OpenCode slot denies edit and bash at the process boundary", () => {
  const proc = new FakeProc(); let env: any;
  runner.runSeat(makeRun({ runId: "open-read-env", cli: "opencode", model: "provider/model-v1", effort: "max", canWrite: false }), "x", captureCallbacks().callbacks, ((_: string, options: any) => { env = options.env; return proc; }) as any);
  assert.match(env.OPENCODE_CONFIG_CONTENT, /"edit":"deny"/); assert.match(env.OPENCODE_CONFIG_CONTENT, /"bash":"deny"/);
  proc.emit("close", 0);
});

test("refreshDiscovery: failed discoverers preserve fallback flags and safe fallback choices", async () => {
  await config.refreshDiscovery(async () => ({ values: [], fallback: true }), async () => ({ values: [], fallback: true }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  assert.equal(config.discoveryInfo.claudeEffort.fallback, true);
  assert.equal(config.discoveryInfo.opencodeModels.fallback, true);
  assert.ok(config.MODEL_OPTIONS.claude?.includes("claude-opus-5-5[1m]"));
});

test("refreshDiscovery: successful values replace effort and OpenCode suggestions and clear fallback markers", async () => {
  await config.refreshDiscovery(async () => ({ values: ["low", "max"], fallback: false }), async () => ({ values: ["vendor/model-a"], fallback: false }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
  // Was deepEqual(["low", "max"]). A saved seat effort stays in the list through a refresh (round 8), so discovered values lead and saved ones follow.
  assert.deepEqual(config.EFFORT_OPTIONS.claude.slice(0, 2), ["low", "max"]);
  assert.deepEqual(config.OPENCODE_MODEL_SUGGESTIONS, ["vendor/model-a"]);
  assert.equal(config.discoveryInfo.claudeEffort.fallback, false);
  assert.equal(config.discoveryInfo.opencodeModels.fallback, false);
});

test("refreshDiscovery: Claude model labels come from the injected model discovery result", async () => {
  await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-review-model", displayName: "Review label", supportsEffort: true }] }));
  assert.deepEqual(config.CLAUDE_MODEL_INFO.find((item) => item.value === "claude-review-model"), { value: "claude-review-model", displayName: "Review label", supportsEffort: true });
});

test("refreshDiscovery: discovered OpenCode gpt models are added to Codex IDs without their provider prefix", async () => {
  const before = [...config.MODEL_OPTIONS.codex!];
  try {
    await config.refreshDiscovery(async (fallback) => ({ values: [...fallback], fallback: true }), async () => ({ values: ["opencode/gpt-6-future", "other/model"], fallback: false }), async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }));
    assert.ok(config.MODEL_OPTIONS.codex!.includes("gpt-6-future"));
    assert.equal(config.MODEL_OPTIONS.codex!.includes("opencode/gpt-6-future"), false);
  } finally { config.MODEL_OPTIONS.codex!.splice(0, config.MODEL_OPTIONS.codex!.length, ...before); }
});

test("refreshDiscovery: a configured workspace Codex model survives a successful catalog refresh", async () => {
  const original = readFileSync(config.workspacesPath);
  const configuredModel = "gpt-6-workspace-custom";
  try {
    const workspaces = config.readWorkspaces();
    const codexSeat = workspaces.projects.flatMap((project) => project.tabs.flatMap((tab) => tab.crew)).find((seat) => seat.cli === "codex");
    assert.ok(codexSeat, "test workspace must contain a Codex slot");
    codexSeat.model = configuredModel;
    config.writeWorkspaces(workspaces, config.workspacesPath);
    await config.refreshDiscovery(
      async (fallback) => ({ values: [...fallback], fallback: true }),
      async () => ({ values: ["vendor/model-current"], fallback: false }),
      async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }),
    );
    assert.ok(config.MODEL_OPTIONS.codex?.includes(configuredModel));
    assert.equal(config.isValidModel("codex", configuredModel), true);
  } finally {
    writeFileSync(config.workspacesPath, original);
  }
});

test("refreshDiscovery: a saved OpenCode model that discovery omits is offered until its last use is removed", async () => {
  const original = readFileSync(config.workspacesPath);
  const saved = "vendor/custom.v1/nested";
  const refresh = () => config.refreshDiscovery(
    async (fallback) => ({ values: [...fallback], fallback: true }),
    async () => ({ values: ["vendor/model-current"], fallback: false }),
    async (fallback) => ({ values: [...fallback].map((item) => ({ ...item })), fallback: true }),
  );
  try {
    const workspaces = config.readWorkspaces();
    const seat = workspaces.projects.flatMap((project) => project.tabs.flatMap((tab) => tab.crew)).find((member) => !member.isLeader && !member.advisor);
    assert.ok(seat, "test workspace must contain a seat without an advisor");
    seat.cli = "opencode"; seat.model = saved; seat.effort = "max"; config.writeWorkspaces(workspaces, config.workspacesPath);
    await refresh();
    assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes(saved)); assert.ok(config.OPENCODE_MODEL_SUGGESTIONS.includes("vendor/model-current"));
    writeFileSync(config.workspacesPath, original);
    await refresh();
    assert.equal(config.OPENCODE_MODEL_SUGGESTIONS.includes(saved), false);
  } finally {
    writeFileSync(config.workspacesPath, original);
    await refresh(); config.adoptSavedValues(config.readWorkspaces());
  }
});

test("refreshDiscovery: effort, OpenCode, and Claude discovery start concurrently", async () => {
  let started = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = config.refreshDiscovery(
    async (fallback) => { started++; await gate; return { values: [...fallback], fallback: true }; },
    async (fallback) => { started++; await gate; return { values: [...fallback], fallback: true }; },
    async (fallback) => { started++; await gate; return { values: [...fallback].map((item) => ({ ...item })), fallback: true }; },
  );
  await Promise.resolve(); assert.equal(started, 3); release(); await pending;
});
