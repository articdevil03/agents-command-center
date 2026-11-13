import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixedServer, modules, assignment } from "./fixed-crew-execution-helpers.ts";
import * as oldRunner from "./round2-helpers.ts";
import * as runner from "./round2-runner-fixture.ts";
import { taskFixture, TASK_SEATS } from "./pack18-editor-task-fixture.ts";
import * as oldPage from "./pack18-editor-harness.ts";
import { scratchDir, stopOwnedChild } from "./temp-root.ts";
import { validateTask } from "../server/fixed-crew/task-types.ts";
import { bridgeCall } from "./pack18-orch-harness.ts";

// Outside sandbox only: CC_FCX_NATIVE_REPLAY=1 node --import ./test/crash-catcher-self.ts --test --test-concurrency=1 --test-name-pattern="native replay" test/fixed-crew-slice-fixture.test.ts
const nativeProcess = process.env.CC_FCX_NATIVE_REPLAY === "1";
test("fixture moves preserve old exports and every page task stage", () => {
  for (const name of ["loadRunnerHarness", "isolatedRunnerProc", "isolatedRunnerCapture", "isolatedRun", "startIsolatedRunner"] as const)
    assert.equal(oldRunner[name], runner[name], name);
  assert.equal(oldPage.taskFixture, taskFixture); assert.equal(oldPage.TASK_SEATS, TASK_SEATS);
  const root = scratchDir();
  for (const stage of ["planned", "approved", "inspected", "roughApproved", "staleRough", "staleReview", "fixOpen", "interrupted"] as const) {
    const task = taskFixture(root, "page", stage);
    assert.equal(task.tabId, "page"); assert.deepEqual(validateTask(task), task, stage);
  }
});

test("fixture native replay: valid fixed tabs, default APIs, real runner spawn and per-execution observation", { timeout: 90_000 }, async () => {
  const f = await fixedServer({ secondTab: true, nativeProcess });
  try {
    const tabs = JSON.parse(readFileSync(join(f.server.data, "config", "workspaces.json"), "utf8")).projects[0].tabs;
    assert.deepEqual(tabs.map((tab: any) => tab.id), ["fixed", "fixed-second"]);
    for (const tab of tabs) {
      assert.equal(modules.runtime.isFixedTab(tab), true); assert.doesNotThrow(() => modules.runtime.fixedCrewOf(tab));
      assert.deepEqual(tab.crew, []); assert.deepEqual(tab.steps, []); assert.ok(f.c.tab(tab.id));
      const result = await f.tool("get_fixed_task", {}, tab.id); assert.equal(result.ok, true); assert.equal(result.value.task, null);
    }
    await f.planning(); assert.equal(f.task().tabId, "fixed"); await f.approve();
    f.worker({}); const built = await f.action("build"); assert.equal(built.ok, true, built.text);
    await f.ended(built.value.runId); assert.equal((await f.verify(built.value.runId)).ok, true);
    await f.planning("fixed-second"); assert.equal(f.task("fixed-second").tabId, "fixed-second"); await f.approve("fixed-second");
    const run = f.journal("fixed-second").executions[0];
    const captured = f.spawnCapture(run.id, "fixed-second"), observed = f.observation(run.id, "fixed-second");
    assert.ok(captured, "actual runner spawn was captured"); assert.ok(observed, "owned worker input was captured");
    assert.match(captured.program, /codex\.cmd" exec --skip-git-repo-check --model gpt-6\.1-sol/);
    assert.match(captured.program, /--sandbox read-only/); assert.equal(captured.shell, true); assert.equal(captured.windowsHide, true);
    assert.equal(captured.briefPath, observed.briefPath); assert.match(observed.brief, /You are the Planner/);
    assert.equal(observed.bridge, null); assert.equal(observed.tokenPresent, false); assert.equal(observed.mcp, null);
    assert.equal(captured.tokenPresent, false); assert.equal(captured.crewUrlPresent, false); assert.equal(captured.mcpPresent, false);
    assert.equal(run.processEnded, true); assert.equal(f.journal("fixed-second").activeExecutionId, null);
    const child = f.children().find((entry: any) => entry.worker && entry.event === "start" && (nativeProcess || entry.pid === observed.pid));
    assert.ok(child); await f.c.wait(() => f.children().some((entry: any) => entry.pid === child.pid && entry.event === "close"), "owned child close");
    const env = await f.control("environment");
    assert.equal(env.CC_FCX_TREE_BOUNDARY, nativeProcess ? "0" : "1"); assert.equal(env.CC_DATA_DIR, f.server.data);
  } finally { await f.close(); }
});

test("fixture records worker input before missing report identity can fail", { timeout: 30_000 }, async () => {
  const f = await fixedServer(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const briefPath = join(f.server.temp, "missing-composition.txt"); writeFileSync(briefPath, "uncomposed worker input");
    child = spawn(process.execPath, [join(f.server.temp, "worker.cjs"), "codex"], {
      cwd: f.server.work, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", CC_BRIEF_PATH: briefPath }, stdio: ["ignore", "pipe", "pipe"],
    });
    let error = ""; child.stderr!.on("data", (data) => { error += data; });
    const [code] = await once(child, "close"); assert.equal(code, 2);
    const observed = JSON.parse(readFileSync(join(f.server.temp, "worker-observed.json"), "utf8"));
    assert.equal(observed.brief, "uncomposed worker input"); assert.equal(observed.briefPath, briefPath);
    assert.match(error, /Fixture report identity missing; worker input was recorded/); assert.doesNotMatch(error, /TypeError|ReferenceError/);
  } finally { if (child) await stopOwnedChild(child); await f.close(); }
});

test("fixture separates accepted stop from eventual owned worker close", { timeout: 30_000 }, async () => {
  const f = await fixedServer();
  try {
    writeFileSync(join(f.server.temp, "defer-worker-stop"), "1"); f.worker({ delay: 2500 });
    const start = await f.tool("begin_planning", { expected: null, brief: "Deferred stop characterization" }); assert.equal(start.ok, true, start.text);
    const runId = start.value.runId;
    const observed = await f.c.wait(() => f.observation(runId), "owned worker input");
    f.c.send({ type: "killRun", runId });
    await f.c.wait(() => f.stops().some((event: any) => event.pid === observed.pid && event.accepted), "stop accepted by injected boundary");
    assert.equal(f.children().some((event: any) => event.pid === observed.pid && event.event === "close"), false);
    assert.equal(f.journal().executions[0].processEnded, false, "acceptance does not confirm tree end");
    await f.ended(runId);
    await f.c.wait(() => f.children().some((event: any) => event.pid === observed.pid && event.event === "close"), "finite owned worker closed");
    assert.equal(f.journal().executions[0].processEnded, true);
  } finally { await f.close(); }
});

test("fixture exposes actual OpenCode leader bridge and explicit read-only assist through production launch", { timeout: 60_000 }, async () => {
  const f = await fixedServer({ assignments: { leader: { cli: "opencode", model: "opencode/mimo-v2.6-flash-free", effort: "max" } } });
  try {
    assert.equal((await f.tool("get_fixed_task")).ok, true);
    const bridge = await f.control("leader-bridge"); assert.ok(bridge.token); assert.match(bridge.url, /\/api\/leader-mcp\/fixed$/);
    assert.equal((await bridgeCall(bridge.url, bridge.token, "tools/list")).status, 200);
    for (const slot of ["researcher", "reviewer1"]) {
      f.worker({}); const result = await f.assist(slot); await f.ended(result.runId);
      assert.equal(f.journal().executions.find((entry: any) => entry.id === result.runId).role, slot);
      assert.deepEqual(result.assignment, assignment); assert.match(f.spawnCapture(result.runId).program, /--sandbox read-only/);
      assert.equal(f.observation(result.runId).tokenPresent, false);
    }
    await assert.rejects(f.assist("coder"), /Explicit read-only assist/);
    f.c.send({ type: "stopSeat", tabId: "fixed", slot: "leader" });
    await f.c.wait(() => f.c.tab("fixed").leaderStatus === "not-started", "leader stopped");
    assert.equal((await bridgeCall(bridge.url, bridge.token, "tools/list")).status, 401);
  } finally { await f.close(); }
});

