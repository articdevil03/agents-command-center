import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTemp, testPlan } from "./pack26-review1-run2-helpers.ts";
import { processFixture } from "./pack26-review1-run2-process-helpers.ts";
import { loadFixed, source, connect } from "./round2-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { setEnv } from "./temp-root.ts";
import { runGitCommand } from "../server/fixed-crew/git-process.ts";
import { safeGitText } from "../server/fixed-crew/git-log.ts";

const hash = "a".repeat(40), nextHash = "b".repeat(40);
type Model = { head: string | null; upstream: string | null; branch: string | null; remotes: string[];
  staged: string[]; committed: string[]; dirty: boolean; subject: string };
const failed = (code: number, stderr = "") => ({ command: "failure" as const, code, stderr });

async function fixture(t: any, native = false) {
  const root = ownedTemp(t), work = join(root, "work"), remote = join(root, "remote.git"); mkdirSync(work);
  t.after(setEnv({ CC_TEST_FAKE_CLI: "1" }));
  const model: Model = { head: null, upstream: null, branch: "main", remotes: ["origin"], staged: ["other.txt"],
    committed: ["owned.txt"], dirty: true, subject: "" };
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "no-global"), GIT_CONFIG_SYSTEM: join(root, "no-system"),
    GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "user.useConfigOnly=true", "-c", "gc.auto=0",
    "--literal-pathspecs", "-C", work, ...args], { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (native) {
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    git("config", "core.hooksPath", join(root, "no-hooks")); git("config", "commit.gpgsign", "false");
    git("init", "--bare", remote); git("remote", "add", "origin", remote);
  }
  writeFileSync(join(work, "owned.txt"), "approved"); writeFileSync(join(work, "other.txt"), "unrelated staged");
  if (native) git("add", "other.txt");
  const calls: string[][] = [];
  let intercept: ((args: string[], op: any) => any) | undefined;
  const original = fixedDependencies.runGitCommand;
  fixedDependencies.runGitCommand = async (op, _folder, args) => {
    calls.push(Array.from(args));
    let result = intercept?.(args, op);
    if (!result && native) {
      try { result = { stdout: git(...args) }; }
      catch (error: any) { result = { ...failed(error.status, error.stderr), stdout: error.stdout }; }
    }
    if (!result) {
      const [command, arg] = args;
      let stdout = "";
      if (command === "rev-parse") {
        if (arg === "--is-inside-work-tree") stdout = "true";
        else { const value = arg === "HEAD" ? model.head : model.upstream; result = value ? { stdout: value } : failed(128); }
      } else if (command === "symbolic-ref") result = model.branch ? { stdout: args.includes("--short") ? model.branch : `refs/heads/${model.branch}` } : failed(1);
      else if (command === "show-ref") result = model.head ? { stdout: model.head } : failed(1);
      else if (command === "remote") stdout = arg === "get-url" ? "https://user:password@example.com/repo?token=hidden" : model.remotes.join("\n");
      else if (command === "for-each-ref" && arg?.includes("remotename")) stdout = "origin\0refs/heads/main\n";
      else if (command === "diff") stdout = model.staged.join("\0") + (model.staged.length ? "\0" : "");
      else if (command === "status") stdout = model.dirty ? "?? owned.txt\0" : "";
      else if (command === "add") model.staged.push("owned.txt");
      else if (command === "rm" || command === "reset") model.staged = model.staged.filter(p => p !== "owned.txt");
      else if (command === "commit") {
        model.head = nextHash; model.dirty = false; model.staged = model.staged.filter(p => p !== "owned.txt");
        model.subject = args[args.indexOf("-m") + 1];
      } else if (command === "diff-tree") stdout = model.head === nextHash && !args.includes("--root") ? "" : model.committed.join("\0") + "\0";
      else if (command === "log") stdout = model.subject;
      else if (command === "rev-list") stdout = arg === "--count" ? "1\n" : model.head + "\n";
      else if (command === "push") model.upstream = model.head;
      else if (command === "branch") { /* SHA push tracking is installed explicitly. */ }
      else if (command !== "for-each-ref") assert.fail(`Unexpected fake Git command: ${args.join(" ")}`);
      result ??= { stdout };
    }
    return { command: "success", treeEnded: true, stdout: "", stderr: "", reason: null, code: 0, signal: null, ...result };
  };
  let server: any;
  try { server = await loadFixed({ skipHealth: true, testRoot: join(root, "data"), serverSource: source }); }
  finally { fixedDependencies.runGitCommand = original; }
  connect(server); server.createTabLeader("alpha-dev"); t.after(() => server.stopLeaderSession("alpha-dev"));
  const tab = server.tabLocation("alpha-dev").tab; tab.folder = work;
  const store = server.fixedTasks;
  store.create(tab.id, testPlan(), Object.fromEntries(Object.entries(tab.fixedCrew.preferences).map(([slot, pref]: any) => [slot, pref.assignment])), store.actor("planner"));
  let request = 0;
  const expected = () => { const task = store.get(tab.id); return { tabId: tab.id, taskId: task.id, planVersion: task.planVersion,
    recordRevision: task.recordRevision, requestId: `request-${++request}` }; };
  const apply = (event: any, actor = store.actor("leader", "test-leader")) => store.apply(expected(), event, actor);
  apply({ type: "approvePlan" }, store.actor("owner"));
  const action = (kind: string) => ({ kind, route: "normal", change: "none" });
  function reviewed() {
    for (const kind of ["build", "check", "review"]) {
      const sessionId = `worker-${kind}`, executionId = apply({ type: "action", action: action(kind), sessionId, batch: [] }).executionId;
      apply({ type: "start", executionId }); const task = store.get(tab.id), role = task.executions.at(-1).role;
      apply({ type: "result", executionId, taskId: task.id, planVersion: task.planVersion, role, success: true, processEnd: "confirmed", evidence: ["owned.txt"] }, store.actor(role, sessionId));
      apply({ type: "verify", executionId, checkName: kind === "check" ? "focused" : null, findings: [], resolved: [], baseFinal: null, unchanged: [] });
    }
  }
  return { root, server, work, git, model, calls, reviewed, intercept: (fn: typeof intercept) => { intercept = fn; },
    launch: (kind = "checkpoint") => server.launchFixedAction(server.currentActor(tab.id), expected(), action(kind), "Approved Git action") };
}

for (const kind of ["checkpoint", "commit"]) test(`P5 unborn HEAD ${kind} verifies root and excludes unrelated staging`, async t => {
  const f = await fixture(t); if (kind === "commit") f.reviewed();
  await assert.doesNotReject(f.launch(kind));
  assert.equal(f.model.head, nextHash); assert.deepEqual(f.model.staged, ["other.txt"]);
  assert.ok(f.calls.some(args => args[0] === "diff-tree" && args.includes("--root")));
});

test("P5 unborn failed commit restores only pack staging and retries", async t => {
  const f = await fixture(t); f.intercept(args => args[0] === "commit" ? failed(1) : undefined);
  await assert.rejects(f.launch(), /Git failed/);
  assert.equal(f.model.head, null); assert.deepEqual(f.model.staged, ["other.txt"]);
  assert.ok(f.calls.some(args => args[0] === "rm" && args.includes("--cached") && args.includes("-f") && args.includes("-r") && args.includes("--ignore-unmatch")));
  assert.equal(readFileSync(join(f.work, "owned.txt"), "utf8"), "approved");
  f.intercept(undefined); await assert.doesNotReject(f.launch()); assert.equal(f.model.head, nextHash);
});

test("P5 failed commit abandons saved pack changes after staging recovery", async t => {
  const f = await fixture(t);
  f.intercept(args => {
    if (args[0] === "commit") { writeFileSync(join(f.work, "owned.txt"), "saved after add"); return failed(1); }
  });
  await assert.rejects(f.launch(), /Git failed/);
  assert.equal(readFileSync(join(f.work, "owned.txt"), "utf8"), "saved after add");
  assert.deepEqual(f.model.staged, ["other.txt"]);
  const journal = f.server.executionJournal(join(f.root, "data"), "alpha-dev");
  assert.equal(journal.activeExecutionId, null, readFileSync(journal.executions.at(-1).logPath, "utf8"));
  const failedRun = f.server.fixedTasks.get("alpha-dev").executions.at(-1);
  assert.equal(failedRun.status, "failed"); assert.equal(failedRun.verified, false);
  assert.equal(failedRun.processEnd, "confirmed"); assert.equal(failedRun.resultRevision, null);
  assert.deepEqual(Array.from(failedRun.evidence), []);
});

test("P5 unborn commit refuses out-of-pack root contents", async t => {
  const f = await fixture(t); f.model.committed = ["owned.txt", "other.txt"];
  await assert.rejects(f.launch(), /only pack-owned files/);
});

test("P5 first push sets upstream and inspects every reachable commit", async t => {
  const f = await fixture(t); f.model.head = hash; f.model.dirty = false; f.reviewed();
  await assert.doesNotReject(f.launch("push"));
  assert.deepEqual(f.calls.find(args => args[0] === "push"), ["push", "--no-follow-tags", "-u", "--", "origin", `${hash}:refs/heads/main`]);
  assert.equal(f.model.upstream, hash);
  assert.deepEqual(f.calls.filter(args => args[0] === "rev-list"), [["rev-list", "--count", hash, "--not", "--remotes=origin"], ["rev-list", hash, "--not", "--remotes=origin"]]);
  assert.ok(f.calls.some(args => args[0] === "diff-tree" && args.includes("--root") && args.at(-1) === hash));
});

test("P5 first push refuses out-of-pack contents in the first commit", async t => {
  const f = await fixture(t); Object.assign(f.model, { head: hash, dirty: false, committed: ["other.txt"] }); f.reviewed();
  await assert.rejects(f.launch("push"), /outgoing commits include files outside.*Commit [a-f0-9]+, file other.txt/);
  assert.equal(f.model.upstream, null); assert.equal(f.calls.some(args => args[0] === "push"), false);
  assert.deepEqual(f.calls.find(args => args[0] === "rev-list" && args[1] !== "--count"), ["rev-list", hash, "--not", "--remotes=origin"]);
});

for (const scenario of ["no remote", "two remotes", "detached HEAD", "non-fast-forward", "broken upstream"]) test(`P5 ${scenario} gives an in-app next step without changing Git`, async t => {
  const f = await fixture(t); f.model.head = hash; f.model.dirty = false;
  if (scenario === "no remote") f.model.remotes = [];
  if (scenario === "two remotes") f.model.remotes = ["origin", "other"];
  if (scenario === "detached HEAD") f.model.branch = null;
  if (scenario === "non-fast-forward") f.intercept(args => args[0] === "push" ? failed(1, "[rejected] main -> main (fetch first)") : undefined);
  if (scenario === "broken upstream") f.intercept(args => args[0] === "for-each-ref" ? { stdout: "refs/remotes/origin/main\n" } : undefined);
  f.reviewed(); const before = JSON.stringify(f.model);
  const expected = { "no remote": /No Git remote.*Leader in this app/, "two remotes": /Several Git remotes.*Leader in this app/,
    "detached HEAD": /without a branch.*Leader in this app/, "non-fast-forward": /remote has newer commits.*Leader in this app/,
    "broken upstream": /saved remote branch is unavailable.*Leader in this app/ }[scenario]!;
  if (scenario === "non-fast-forward") await assert.rejects(f.launch("push"), { message: "Push to origin: The remote has newer commits. Ask the Leader in this app to bring in those changes and resolve any conflicts, then review and try pushing again." });
  else await assert.rejects(f.launch("push"), expected); assert.equal(JSON.stringify(f.model), before);
  if (scenario === "non-fast-forward") {
    const failedRun = f.server.executionJournal(join(f.root, "data"), "alpha-dev").executions.at(-1);
    assert.ok(readFileSync(failedRun.logPath, "utf8").includes("Push to origin: The remote has newer commits."));
  }
  assert.equal(f.calls.some(args => args.includes("--force") || args[0] === "config"), false);
});

for (const missing of ["name", "email"]) test(`P5 missing Git ${missing} gives in-app recovery and restores unborn staging`, async t => {
  const f = await fixture(t);
  f.intercept(args => args[0] === "commit" ? failed(128, `fatal: no ${missing} was given and auto-detection is disabled`) : undefined);
  await assert.rejects(f.launch(), /Your Git name or email is missing.*Leader in this app.*cannot invent/);
  assert.equal(f.model.head, null); assert.deepEqual(f.model.staged, ["other.txt"]);
  assert.equal(f.calls.some(args => args[0] === "config"), false);
});

for (const [command, budget] of [["status", 30_000], ["commit", 300_000], ["push", 600_000]] as const) {
  test(`P5 ${command} actual deadline and unknown-result message`, async t => {
    const f = processFixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = runGitCommand(f.op, f.folder, [command]);
    t.mock.timers.tick(budget - 1); assert.equal(f.sweepCalls(), 0);
    t.mock.timers.tick(1); assert.equal(f.sweepCalls(), 1, "the deadline must start cleanup before awaiting completion");
    const result = await pending;
    assert.match(result.reason!, new RegExp(`${budget.toLocaleString("en-US")} ms`));
    assert.match(result.reason!, /result is unknown.*in the app/);
    assert.equal(f.killCalls(), 1); assert.equal(result.treeEnded, true);
  });
}

test("P5 slow commit survives 30 seconds and refuses guessed identity", async t => {
  const f = processFixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runGitCommand(f.op, f.folder, ["commit"]);
  t.mock.timers.tick(30_001); assert.equal(f.sweepCalls(), 0); f.exit();
  assert.equal((await pending).command, "success");
  assert.ok(f.spawns[0].args.includes("user.useConfigOnly=true"));
});

for (const stop of ["Stop", "shutdown"]) test(`P5 ${stop} kills a long commit promptly`, async t => {
  const f = processFixture(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runGitCommand(f.op, f.folder, ["commit"]);
  t.mock.timers.tick(30_001); assert.equal(f.sweepCalls(), 0);
  if (stop === "Stop") f.registry.cancel(f.op.id); else f.registry.close();
  const result = await pending; assert.match(result.reason!, /cancelled/); assert.equal(f.killCalls(), 1);
  f.op.terminal = true; f.op.finalized = true; f.registry.complete(f.op);
  assert.equal(await f.registry.drain(), true);
});

const native = process.env.CC_P26_RUN2_NATIVE === "1";
if (!native) console.log("NOT RUN: P5 real Git bootstrap acceptance requires CC_P26_RUN2_NATIVE=1.");
for (const kind of ["checkpoint", "commit"]) test(`P5 native unborn ${kind} and failed staging recovery`, { skip: !native }, async t => {
  const f = await fixture(t, true); const index = f.git("ls-files", "--stage", "other.txt");
  if (kind === "commit") f.reviewed();
  f.intercept(args => args[0] === "commit" ? failed(1) : undefined);
  await assert.rejects(f.launch(kind), /Git failed/);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "other.txt");
  assert.equal(f.git("ls-files", "--stage", "other.txt"), index);
  f.intercept(undefined); await assert.doesNotReject(f.launch(kind));
  assert.equal(f.git("show", "HEAD:owned.txt"), "approved");
  assert.equal(f.git("ls-tree", "-r", "--name-only", "HEAD").trim(), "owned.txt");
  assert.equal(f.git("ls-files", "--stage", "other.txt"), index);
});

test("P5 native first push establishes upstream and refuses unowned root history", { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("rm", "--cached", "other.txt"); f.git("add", "owned.txt"); f.git("commit", "-m", "owned root"); f.reviewed();
  await assert.doesNotReject(f.launch("push")); assert.equal(f.git("rev-parse", "@{upstream}"), f.git("rev-parse", "HEAD"));
  const g = await fixture(t, true); g.git("add", "owned.txt"); g.git("commit", "-m", "unowned root"); g.reviewed();
  await assert.rejects(g.launch("push"), /outgoing commits include files outside.*Commit [a-f0-9]+, file other.txt/);
  assert.equal(g.calls.some(args => args[0] === "push"), false);
});

for (const missing of ["name", "email"]) test(`P5 native missing ${missing} never invents identity`, { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("config", "--unset", `user.${missing}`);
  await assert.rejects(f.launch(), /Your Git name or email is missing.*Leader in this app/);
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "other.txt");
  assert.throws(() => f.git("rev-parse", "--verify", "HEAD"));
});

test("P5 unborn push is refused before any publication", async t => {
  const f = await fixture(t); f.reviewed();
  await assert.rejects(f.launch("push"), /Create a checkpoint or commit in this app before pushing/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
});

test("P5 unsafe remote and credential-bearing output are never exposed", async t => {
  const f = await fixture(t); Object.assign(f.model, { head: hash, dirty: false }); f.reviewed();
  f.model.remotes = ["-unsafe"];
  await assert.rejects(f.launch("push"), /safe remote branch/);
  assert.equal(f.calls.some(args => args[0] === "push"), false);
  f.model.remotes = ["origin"]; assert.equal((await f.launch("push")).message, "Push to origin succeeded.");
  const journal = f.server.executionJournal(join(f.root, "data"), "alpha-dev");
  const log = readFileSync(journal.executions.at(-1).logPath, "utf8");
  assert.match(log, /Push destination: origin \(https:\/\/example.com\/repo\)/);
  assert.match(log, /Push to origin succeeded/);
  assert.doesNotMatch(log, /user:password|token=hidden/);
  assert.equal(safeGitText("failed https://user:password@example.com/repo?token=hidden"), "failed https://example.com/repo");
});

test("P5 production push argv disables tag following and submodule recursion", async t => {
  const app = await fixture(t); Object.assign(app.model, { head: hash, dirty: false }); app.reviewed();
  await app.launch("push");
  assert.deepEqual(app.calls.find(args => args[0] === "push"), ["push", "--no-follow-tags", "-u", "--", "origin", `${hash}:refs/heads/main`]);
  const f = processFixture(t), pending = runGitCommand(f.op, f.folder, ["push", "--no-follow-tags", "--", "origin", `${hash}:refs/heads/main`]);
  f.exit(); assert.equal((await pending).command, "success");
  assert.ok(f.spawns[0].args.includes("push.followTags=false"));
  assert.ok(f.spawns[0].args.includes("push.recurseSubmodules=no"));
});

test("P5 native recovery preserves a save after add and unstages only pack files", { skip: !native }, async t => {
  const f = await fixture(t, true), index = f.git("ls-files", "--stage", "other.txt");
  f.intercept(args => {
    if (args[0] === "commit") { writeFileSync(join(f.work, "owned.txt"), "saved after add"); return failed(1); }
  });
  await assert.rejects(f.launch(), /Git failed/);
  assert.equal(readFileSync(join(f.work, "owned.txt"), "utf8"), "saved after add");
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "other.txt");
  assert.equal(f.git("ls-files", "--stage", "other.txt"), index);
  const journal = f.server.executionJournal(join(f.root, "data"), "alpha-dev");
  assert.equal(journal.activeExecutionId, null, readFileSync(journal.executions.at(-1).logPath, "utf8"));
  const failedRun = f.server.fixedTasks.get("alpha-dev").executions.at(-1);
  assert.equal(failedRun.status, "failed"); assert.equal(failedRun.verified, false);
  assert.equal(failedRun.processEnd, "confirmed"); assert.equal(failedRun.resultRevision, null);
  assert.deepEqual(Array.from(failedRun.evidence), []);
});

for (const existing of [false, true]) test(`P5 native ${existing ? "existing upstream" : "first push"} publishes only inspected SHA and destination`, { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("rm", "--cached", "other.txt");
  f.git("add", "owned.txt"); f.git("commit", "-m", "root");
  if (existing) f.git("push", "-u", "origin", "HEAD:refs/heads/destination");
  f.git("branch", "extra"); f.git("tag", "-a", "private-tag", "-m", "private");
  writeFileSync(join(f.work, "owned.txt"), "new approved"); f.git("add", "owned.txt"); f.git("commit", "-m", "pack");
  const inspected = f.git("rev-parse", "HEAD").trim();
  f.git("config", "push.default", "matching"); f.git("config", "remote.origin.push", "refs/heads/*");
  f.git("config", "push.followTags", "true"); f.git("config", "push.recurseSubmodules", "on-demand");
  f.reviewed();
  f.intercept(args => {
    if (args[0] !== "push") return;
    // Advance HEAD after the final recheck, as a concurrent writer or hook could.
    writeFileSync(join(f.work, "other.txt"), "never publish"); f.git("add", "other.txt"); f.git("commit", "-m", "uninspected");
    assert.ok(args.includes(`${inspected}:refs/heads/${existing ? "destination" : "main"}`));
  });
  await assert.doesNotReject(f.launch("push"));
  const refs = f.git("ls-remote", "--refs", "origin").trim().split(/\r?\n/);
  assert.deepEqual(refs, [`${inspected}\trefs/heads/${existing ? "destination" : "main"}`]);
  assert.notEqual(f.git("rev-parse", "HEAD").trim(), inspected);
});

for (const bad of [false, true]) test(`P5 native new branch skips remote history and ${bad ? "refuses new outside files" : "publishes only new commits"}`, { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("add", "other.txt"); f.git("commit", "-m", "old outside history");
  f.git("push", "origin", "main"); f.git("checkout", "-b", "pack");
  f.git("add", "owned.txt"); f.git("commit", "-m", "pack"); const pack = f.git("rev-parse", "HEAD").trim();
  if (bad) {
    writeFileSync(join(f.work, "other.txt"), "new outside");
    f.git("add", "other.txt"); f.git("commit", "-m", "outside");
  }
  const before = f.git("rev-parse", "HEAD").trim(); f.reviewed();
  if (bad) {
    await assert.rejects(f.launch("push"), new RegExp(`Commit ${before}, file other.txt`));
    assert.equal(f.calls.some(args => args[0] === "push"), false);
    assert.equal(f.git("ls-remote", "--heads", "origin", "pack"), "");
  } else {
    await assert.doesNotReject(f.launch("push"));
    assert.equal(f.git("rev-parse", "@{upstream}").trim(), pack);
    assert.deepEqual(f.calls.filter(args => args[0] === "diff-tree").map(args => args.at(-1)), [pack]);
  }
});

test("P5 native mirror configuration fails closed without publishing extra refs", { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("rm", "--cached", "other.txt"); f.git("add", "owned.txt"); f.git("commit", "-m", "root");
  f.git("branch", "extra"); f.git("tag", "private-tag"); f.git("config", "remote.origin.mirror", "true"); f.reviewed();
  await assert.rejects(f.launch("push"), /Push to origin: Git failed/);
  assert.equal(f.git("ls-remote", "--refs", "origin"), "");
});


test("P5 duplicate outgoing commits refuse before pushing", async t => {
  const f = await fixture(t); Object.assign(f.model, { head: hash, dirty: false }); f.reviewed();
  f.intercept(args => args[0] === "rev-list" ? { stdout: args[1] === "--count" ? "2\n" : `${hash}\n${hash}\n` } : undefined);
  await assert.rejects(f.launch("push"), { message: "Push to origin: Git history is incomplete. Push was refused." });
  assert.equal(f.calls.some(args => args[0] === "push"), false);
});

test("P5 native same-named branch and tag push to the exact branch", { skip: !native }, async t => {
  const f = await fixture(t, true); f.git("rm", "--cached", "other.txt");
  f.git("add", "owned.txt"); f.git("commit", "-m", "root"); f.git("tag", "main"); f.reviewed();
  await assert.doesNotReject(f.launch("push"));
  const head = f.git("rev-parse", "HEAD").trim();
  assert.equal(f.git("ls-remote", "--refs", "origin").trim(), `${head}\trefs/heads/main`);
  assert.deepEqual(f.calls.find(args => args[0] === "symbolic-ref"), ["symbolic-ref", "--quiet", "HEAD"]);
  assert.equal(f.git("rev-parse", "@{upstream}").trim(), head);
});
