import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { loadFixed, source, connect } from "./round2-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { setEnv } from "./temp-root.ts";
import type { GitCommandResult } from "../server/fixed-crew/git-process.ts";
import { runLeaderTool } from "../server/leader-tools.ts";

async function fixture(t: any, prepare: (git: (...args: string[]) => string, work: string) => void = () => {}, paths = ["owned.txt"]) {
  const root = ownedTemp(t), work = join(root, "work"), remote = join(root, "remote.git");
  mkdirSync(work);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "gc.auto=0", "--literal-pathspecs", "-C", work, ...args],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  git("config", "core.hooksPath", join(root, "no-hooks")); git("config", "commit.gpgsign", "false");
  writeFileSync(join(work, "owned.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  git("init", "--bare", remote); git("remote", "add", "origin", remote); git("push", "-u", "origin", "main");
  prepare(git, work);
  const restoreEnv = setEnv({ CC_TEST_FAKE_CLI: "1" }); t.after(restoreEnv);
  const original = fixedDependencies.runGitCommand;
  const calls: string[][] = [];
  let intercept: ((args: string[], op: any) => Partial<GitCommandResult> | undefined) | undefined;
  fixedDependencies.runGitCommand = async (op, _folder, args) => {
    calls.push(args);
    const override = intercept?.(args, op);
    if (override) return { command: "success", treeEnded: true, stdout: "", stderr: "", reason: null, code: 0, signal: null, ...override };
    try { return { command: "success", treeEnded: true, stdout: git(...args), stderr: "", reason: null, code: 0, signal: null }; }
    catch (error: any) { return { command: "failure", treeEnded: true, stdout: error.stdout ?? "", stderr: error.stderr ?? "", reason: null, code: error.status, signal: null }; }
  };
  let server: any;
  try { server = await loadFixed({ skipHealth: true, testRoot: join(root, "data"),
    serverSource: source + "\nfixedTasks.p1Specs = fixedLeaderSpecs; fixedTasks.p1GitOperations = fixedGitOperations;" }); }
  finally { fixedDependencies.runGitCommand = original; }
  connect(server); server.createTabLeader("alpha-dev");
  t.after(() => server.stopLeaderSession("alpha-dev"));
  const tab = server.tabLocation("alpha-dev").tab; tab.folder = work;
  const seats = Object.fromEntries(Object.entries(tab.fixedCrew.preferences).map(([slot, pref]: any) => [slot, pref.assignment]));
  const store = server.fixedTasks; store.create(tab.id, testPlan(paths), seats, store.actor("planner"));
  let request = 0;
  const expected = () => { const task = store.get(tab.id); return { tabId: tab.id, taskId: task.id, planVersion: task.planVersion, recordRevision: task.recordRevision, requestId: `request-${++request}` }; };
  const apply = (event: any, actor = store.actor("leader", "test-leader")) => store.apply(expected(), event, actor);
  apply({ type: "approvePlan" }, store.actor("owner"));
  const action = (kind: string) => ({ kind, route: "normal", change: "none" });
  function reviewed() {
    for (const kind of ["build", "check", "review"]) {
      const sessionId = `worker-${kind}`;
      const executionId = apply({ type: "action", action: action(kind), sessionId, batch: [] }).executionId;
      apply({ type: "start", executionId });
      const task = store.get(tab.id), role = task.executions.at(-1).role;
      apply({ type: "result", executionId, taskId: task.id, planVersion: task.planVersion, role, success: true, processEnd: "confirmed", evidence: [paths[0]] }, store.actor(role, sessionId));
      apply({ type: "verify", executionId, checkName: kind === "check" ? "focused" : null, findings: [], resolved: [], baseFinal: null, unchanged: [] });
    }
  }
  return { git, work, calls, reviewed, server, intercept: (fn: typeof intercept) => { intercept = fn; },
    reconcile: (runId: string) => runLeaderTool(store.p1Specs(tab.id, server.leaderInstances.get(tab.id)),
      "reconcile_task_execution", { expected: expected(), runId, reason: "Abandon the ended execution" }),
    launch: (kind = "checkpoint") => server.launchFixedAction(server.currentActor(tab.id), expected(), action(kind), "Approved Git action"),
    journal: () => server.executionJournal(server.testRoot, tab.id) };
}

for (const kind of ["checkpoint", "commit"]) test(`P1 C-2 ${kind} failure restores only pack staging and retries in app`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  writeFileSync(join(f.work, "unrelated.txt"), "staged"); f.git("add", "unrelated.txt");
  const index = f.git("ls-files", "--stage", "unrelated.txt");
  writeFileSync(join(f.work, "unrelated.txt"), "unstaged unrelated edit");
  if (kind === "commit") f.reviewed();
  f.intercept(args => args[0] === "commit" ? { command: "failure", code: 1 } : undefined);
  await assert.rejects(f.launch(kind), /Git failed/);
  assert.equal(f.git("diff", "--cached", "--name-only", "--", "owned.txt"), "", "failed operation must remove its staging");
  assert.equal(f.git("ls-files", "--stage", "unrelated.txt"), index);
  assert.equal(readFileSync(join(f.work, "unrelated.txt"), "utf8"), "unstaged unrelated edit");
  assert.equal(readFileSync(join(f.work, "owned.txt"), "utf8"), "changed");
  f.intercept(undefined);
  await f.launch(kind);
  assert.equal(f.git("show", "HEAD:owned.txt"), "changed");
  assert.equal(f.git("ls-files", "--stage", "unrelated.txt"), index);
});

test("P1 C-2 failure after add restores partial staging", async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  f.intercept(args => { if (args[0] !== "add") return; f.git(...args); return { command: "failure", code: 1 }; });
  await assert.rejects(f.launch(), /Git failed/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  f.intercept(undefined); await f.launch();
});

test("P1 C-2 failed index restoration keeps the reconciliation brake", async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  f.intercept(args => ["commit", "reset"].includes(args[0]) ? { command: "failure", code: 1 } : undefined);
  await assert.rejects(f.launch(), /staging recovery is incomplete/);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "owned.txt");
  assert.ok(f.journal().activeExecutionId);
});

for (const mode of ["unknown tree", "unknown outcome", "completed commit", "unverified success"]) test(`P1 C-2 ${mode} holds staging for reconciliation`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  f.intercept((args, op) => {
    if (args[0] !== "commit") return;
    if (mode === "completed commit") f.git(...args);
    if (mode === "unknown tree") op.treesEnded = false;
    return { command: mode === "unknown outcome" ? "unknown" : mode === "unverified success" ? "success" : "failure", treeEnded: mode !== "unknown tree", code: 1 };
  });
  await assert.rejects(f.launch(), /Git failed|reconcil|verify|recovery/i);
  assert.equal(f.calls.some(args => args[0] === "reset"), false, "uncertain completion must never reset staging");
  assert.ok(f.journal().activeExecutionId, "uncertain commit must retain the durable reservation");
  await assert.rejects(f.launch(), /reconcil|reserv|interrupted/i);
  if (["completed commit", "unknown outcome"].includes(mode)) {
    const taskBefore = JSON.stringify(f.server.fixedTasks.get("alpha-dev"));
    const runId = f.journal().activeExecutionId;
    const recovered = await f.reconcile(runId);
    assert.equal(recovered.isError, false, recovered.text);
    assert.equal(JSON.stringify(f.server.fixedTasks.get("alpha-dev")), taskBefore, "only the journal brake changes");
    assert.equal(f.journal().activeExecutionId, null);
    assert.equal(f.journal().executions.at(-1).consumed, true);
  }
});

for (const kind of ["checkpoint", "push"]) test(`P1 R-3 done unconsumed ${kind} cannot be abandoned`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  if (kind === "push") { f.git("add", "."); f.git("commit", "-m", "owned"); f.reviewed(); }
  await f.launch(kind);
  const entry = f.journal().executions.at(-1);
  assert.equal(entry.status, "done"); assert.equal(entry.consumed, false);
  const before = JSON.stringify(f.journal()), taskBefore = JSON.stringify(f.server.fixedTasks.get("alpha-dev"));
  const result = await f.reconcile(entry.id);
  assert.equal(result.isError, true, result.text);
  assert.equal(JSON.stringify(f.journal()), before); assert.equal(JSON.stringify(f.server.fixedTasks.get("alpha-dev")), taskBefore);
});

for (const scenario of ["evil merge", "outgoing root"]) test(`P1 R-4 outgoing history refuses ${scenario}`, async t => {
  const f = await fixture(t, (git, work) => {
    const commit = (message: string) => { git("add", "-A"); git("commit", "-m", message); };
    if (scenario === "outgoing root") {
      git("checkout", "--orphan", "orphan");
      writeFileSync(join(work, "excluded.txt"), "root addition"); commit("orphan root");
      git("branch", "--set-upstream-to=origin/main");
    } else {
      git("checkout", "-b", "side"); writeFileSync(join(work, "owned.txt"), "side"); commit("side");
      git("checkout", "main"); git("commit", "--allow-empty", "-m", "main");
      git("merge", "--no-ff", "--no-commit", "side");
      writeFileSync(join(work, "excluded.txt"), "merge-only addition"); commit("evil merge");
    }
  });
  f.reviewed(); const upstream = f.git("rev-parse", "@{upstream}");
  await assert.rejects(f.launch("push"), /outgoing commits include files outside/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
  assert.equal(f.git("rev-parse", "@{upstream}"), upstream);
});

for (const scenario of ["add-delete", "rename", "merge", "revert", "owned"]) test(`P1 C-E1 checks every outgoing commit: ${scenario}`, async t => {
  const f = await fixture(t, (git, work) => {
    const commit = (message: string) => { git("add", "-A"); git("commit", "-m", message); };
    if (scenario === "owned") { writeFileSync(join(work, "owned.txt"), "approved"); commit("owned"); return; }
    if (scenario === "rename") { git("mv", "owned.txt", "excluded.txt"); commit("rename"); git("rm", "excluded.txt"); commit("delete renamed file"); return; }
    if (scenario === "merge") git("checkout", "-b", "side");
    writeFileSync(join(work, "excluded.txt"), "fake sensitive content"); commit("excluded addition");
    if (scenario === "revert") git("revert", "--no-edit", "HEAD");
    if (scenario === "add-delete") { git("rm", "excluded.txt"); commit("excluded deletion"); }
    if (scenario === "merge") {
      git("checkout", "main"); writeFileSync(join(work, "owned.txt"), "approved"); commit("owned");
      git("merge", "--no-ff", "side", "-m", "merge side");
      git("rm", "excluded.txt"); commit("delete merged file");
    }
  });
  f.reviewed(); const upstream = f.git("rev-parse", "@{upstream}");
  if (scenario === "owned") { await f.launch("push"); assert.equal(f.git("rev-parse", "@{upstream}"), f.git("rev-parse", "HEAD")); }
  else {
    await assert.rejects(f.launch("push"), /outgoing commits include files outside/);
    assert.equal(f.calls.some(args => args[0] === "push"), false);
    assert.equal(f.git("rev-parse", "@{upstream}"), upstream);
  }
});

for (const cut of ["list", "paths", "command failure"]) test(`P1 C-E1 incomplete history refuses push: ${cut}`, async t => {
  const f = await fixture(t, (git, work) => { writeFileSync(join(work, "owned.txt"), "approved"); git("add", "."); git("commit", "-m", "owned"); });
  f.reviewed();
  f.intercept(args => {
    if (cut === "list" && args[0] === "rev-list" && args[1] !== "--count") return { stdout: "" };
    if (cut === "paths" && args[0] === "diff-tree") return { stdout: "owned.tx" };
    if (cut === "command failure" && args[0] === "diff-tree") return { command: "failure", code: 1, reason: "Git output exceeded limit" };
  });
  await assert.rejects(f.launch("push"), /incomplete|exceeded/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
});


// F-1: the undo of our own `git add` must not depend on the cancelled or authority checks it is recovering from.
for (const trigger of ["stop", "authority change"]) test(`P1 F-1 ${trigger} after add still unstages the pack and retries`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  writeFileSync(join(f.work, "unrelated.txt"), "staged"); f.git("add", "unrelated.txt");
  const index = f.git("ls-files", "--stage", "unrelated.txt");
  const leader = f.server.leaders.get("alpha-dev"), original = leader.getPermissionMode;
  t.after(() => { leader.getPermissionMode = original; });
  f.intercept((args, op) => {
    if (args[0] !== "add") return;
    const stdout = f.git(...args);
    if (trigger === "stop") f.server.fixedTasks.p1GitOperations.cancel(op.id); else leader.getPermissionMode = () => "changed-after-add";
    return { stdout };
  });
  await assert.rejects(f.launch(), trigger === "stop" ? /cancelled/ : /permission|assignment|selection/);
  assert.equal(f.calls.some(args => args[0] === "commit"), false, "the commit must never start");
  assert.equal(f.git("diff", "--cached", "--name-only", "--", "owned.txt"), "", "owned files must be unstaged");
  assert.equal(f.git("ls-files", "--stage", "unrelated.txt"), index, "unrelated staged file must survive");
  assert.equal(f.journal().activeExecutionId, null, "the brake must be released");
  f.intercept(undefined); leader.getPermissionMode = original;
  await f.launch();
  assert.equal(f.git("show", "HEAD:owned.txt"), "changed");
  assert.equal(f.git("ls-files", "--stage", "unrelated.txt"), index);
});

for (const command of ["rev-parse", "reset"]) for (const outcome of ["failure", "unknown tree"]) test(`P1 R3-1 recovery ${command} ${outcome} retains the brake`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  let added = false;
  f.intercept((args, op) => {
    if (args[0] === "add") {
      const stdout = f.git(...args); added = true;
      f.server.fixedTasks.p1GitOperations.cancel(op.id);
      return { stdout };
    }
    if (added && args[0] === command) return { command: outcome === "failure" ? "failure" : "success",
      treeEnded: outcome !== "unknown tree", code: outcome === "failure" ? 1 : 0, stdout: f.git("rev-parse", "HEAD") };
  });
  await assert.rejects(f.launch(), /staging recovery is incomplete/);
  assert.equal(f.calls.some(args => args[0] === "commit"), false);
  assert.equal(f.calls.filter(args => args[0] === "reset").length, command === "reset" ? 1 : 0);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "owned.txt");
  const journal = f.journal(), entry = journal.executions.at(-1);
  assert.equal(journal.activeExecutionId, entry.id, "incomplete staging recovery must retain the reservation");
  assert.equal(entry.status, "interrupted");
  assert.equal(entry.processEnded, true, "index uncertainty retains the brake even with a confirmed-ended operation");
  await assert.rejects(f.launch(), /reconcil|reserv|interrupted/i);
});

for (const uncertainty of ["unknown tree", "pending cleanup"]) test(`P1 R3-1 ${uncertainty} after add refuses recovery`, async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  f.intercept((args, op) => {
    if (args[0] !== "add") return;
    const stdout = f.git(...args);
    if (uncertainty === "unknown tree") op.treesEnded = false;
    else op.cleanup.add(Promise.resolve());
    f.server.fixedTasks.p1GitOperations.cancel(op.id);
    return { stdout };
  });
  await assert.rejects(f.launch(), /staging recovery is incomplete/);
  assert.equal(f.calls.at(-1)?.[0], "add", "no recovery command may start with an unsettled add");
  assert.equal(f.calls.some(args => args[0] === "reset"), false);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "owned.txt");
  const journal = f.journal(), entry = journal.executions.at(-1);
  assert.equal(journal.activeExecutionId, entry.id);
  assert.equal(entry.status, "interrupted"); assert.equal(entry.processEnded, false);
  await assert.rejects(f.launch(), /reconcil|reserv|interrupted/i);
});

test("P1 R3-2 shutdown after add refuses recovery and retains the brake", async t => {
  const f = await fixture(t, (_git, work) => writeFileSync(join(work, "owned.txt"), "changed"));
  f.intercept(args => {
    if (args[0] !== "add") return;
    const stdout = f.git(...args);
    f.server.fixedTasks.p1GitOperations.close();
    return { stdout };
  });
  await assert.rejects(f.launch(), /staging recovery is incomplete:.*admission is closed for shutdown/);
  assert.equal(f.calls.at(-1)?.[0], "add", "shutdown must prevent every recovery command");
  assert.equal(f.calls.some(args => args[0] === "reset" || args[0] === "commit"), false);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "owned.txt");
  const journal = f.journal(), entry = journal.executions.at(-1);
  assert.equal(journal.activeExecutionId, entry.id);
  assert.equal(entry.status, "interrupted"); assert.equal(entry.processEnded, true);
  await assert.rejects(f.launch(), /reconcil|reserv|interrupted|closed/i);
});

// F-2: path ownership is whole-segment, never a plain prefix (`src` must not own `src2/`).
const lookalike = (git: (...args: string[]) => string, work: string, withSibling: boolean) => {
  mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "a.ts"), "owned"); git("add", "-A"); git("commit", "-m", "owned dir");
  if (withSibling) { mkdirSync(join(work, "src2")); writeFileSync(join(work, "src2", "b.ts"), "lookalike"); git("add", "-A"); git("commit", "-m", "sibling"); }
};
for (const sibling of [false, true]) test(`P1 F-2 directory pack path ${sibling ? "refuses a lookalike sibling" : "pushes its own files"}`, async t => {
  const f = await fixture(t, (git, work) => lookalike(git, work, sibling), ["src"]);
  f.reviewed(); const upstream = f.git("rev-parse", "@{upstream}");
  if (!sibling) { await f.launch("push"); assert.equal(f.git("rev-parse", "@{upstream}"), f.git("rev-parse", "HEAD")); return; }
  await assert.rejects(f.launch("push"), /outgoing commits include files outside/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
  assert.equal(f.git("rev-parse", "@{upstream}"), upstream);
});

test("P1 F-2 staged lookalike sibling does not block a directory checkpoint", async t => {
  const f = await fixture(t, (_git, work) => { mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "a.ts"), "owned"); }, ["src"]);
  mkdirSync(join(f.work, "src2")); writeFileSync(join(f.work, "src2", "b.ts"), "x"); f.git("add", "src2/b.ts");
  await assert.doesNotReject(f.launch(), "a staged file outside the pack must not block the checkpoint");
  assert.equal(f.git("show", "HEAD:src/a.ts"), "owned");
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "src2/b.ts");
});

test("P1 F-2 commit verification refuses a lookalike sibling in the new commit", async t => {
  const f = await fixture(t, (_git, work) => { mkdirSync(join(work, "src")); writeFileSync(join(work, "src", "a.ts"), "owned"); }, ["src"]);
  f.intercept(args => args[0] === "diff-tree" && !args.includes("--root") ? { stdout: "src2/b.ts\0" } : undefined);
  await assert.rejects(f.launch(), /did not verify a commit containing only pack-owned files/);
});

// F-2: each sub-clause of the incomplete-history guard is exercised alone (two outgoing commits).
for (const cut of ["invalid hash", "duplicate hash", "short list", "missing trailing LF"]) test(`P1 F-2 incomplete history list refuses push: ${cut}`, async t => {
  const f = await fixture(t, (git, work) => {
    for (const text of ["one", "two"]) { writeFileSync(join(work, "owned.txt"), text); git("add", "."); git("commit", "-m", text); }
  });
  f.reviewed();
  const [newest, older] = f.git("rev-list", "-2", "HEAD").trim().split(/\r?\n/);
  f.intercept(args => {
    if (args[0] !== "rev-list" || args[1] === "--count") return;
    const lines = { "invalid hash": ["not-a-hash", older], "duplicate hash": [newest, newest], "short list": [newest], "missing trailing LF": [newest, older] }[cut]!;
    return { stdout: lines.join("\n") + (cut === "missing trailing LF" ? "" : "\n") };
  });
  await assert.rejects(f.launch("push"), /Git history is incomplete/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
});

// F-3: a commit that lands after the history check must never be pushed uninspected.
test("P1 F-3 HEAD moving before push refuses the push", async t => {
  const f = await fixture(t, (git, work) => { writeFileSync(join(work, "owned.txt"), "approved"); git("add", "."); git("commit", "-m", "owned"); });
  f.reviewed(); let heads = 0;
  f.intercept(args => args[0] === "rev-parse" && args[1] === "HEAD" && args.length === 2 && ++heads === 2 ? { stdout: "a".repeat(40) + "\n" } : undefined);
  await assert.rejects(f.launch("push"), /HEAD changed during the Git action/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
});
