import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mutations, COPIED_PATHS, hasDesignFolder, isRealRed, removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";
import { harnessSource } from "./source-text.ts";
import { spawn, spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

test("no test file calls rmSync with recursive: false (it always throws on a folder and leaks it)", () => {
  const files = readdirSync(join(root, "test")).filter((name) => /\.(ts|mjs)$/.test(name));
  assert.ok(files.length > 10, "the scan found the test files");
  const bad = files.filter((name) => /rmSync\([^)]*recursive:\s*false/.test(readFileSync(join(root, "test", name), "utf8").replace(/^ *\/\/.*$/gm, "")));
  assert.deepEqual(bad, []);
});

 test("approval mutation catalogue contains all 81 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-approval-"));
  assert.equal(entries.length, 81);
  for (const [name, file, from] of entries) {
    if (process.env.CC_MUTATION_PROOF !== "1") assert.ok(readFileSync(join(root,file),"utf8").replaceAll("\r\n","\n").includes(from), name);
  }
});

 test("final2 mutation catalogue contains all 28 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-packc-final2-"));
  assert.equal(entries.length, 28);
  if (process.env.CC_MUTATION_PROOF !== "1") for (const [name, file, from] of entries) assert.equal(readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n").split(from).length - 1, 1, name + " targets exactly one guard");
});

// The approval runner is a script that runs two whole test files per entry, so it is checked at its call sites, as text.
test("the approval mutation runner strips the data-root variables, verifies its write, keeps no junction and counts only a real assertion as RED", () => {
  const source = readFileSync(join(root, "test/approval-mutation-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  assert.match(source, /const \{ CC_DATA_DIR: _ccDataDir, CC_TEST_FORCE_PACKAGED: _ccTestForcePackaged, \.\.\.childEnv \} = process\.env;/);
  assert.match(source, /env: \{ \.\.\.childEnv, TEMP: privateTmp, TMP: privateTmp, CC_MUTATION_PROOF: red \? "1" : "" \}/, "children get a private TEMP/TMP");
  assert.match(source, /if \(result\.error\) stopOwned\(\);\s+assert\.ifError\(result\.error\);/, "a timed-out run stops its own descendants before the error is raised");
  assert.match(source, /CommandLine\.Contains\('\$\{a\}'\) -or \$_\.CommandLine\.Contains\('\$\{b\}'\)/, "only processes whose command line holds this run's folders");
  assert.match(source, /removeWithRetry\(privateTmp\);/);
  assert.match(source, /writeVerified\(target, source\.replace\(from, \(\) => to\)\)/);
  assert.match(source, /assert\.ok\(isRealRed\(result\.status, result\.output\)/);
  assert.doesNotMatch(source, /symlinkSync|junction/, "the scratch copy sits inside the repo, so there is no link to remove");
  assert.match(source, /mkdtempSync\(join\(root, "\.cc-test-approval-"\)\)/);
  assert.match(source, /removeWithRetry\(scratch\);/);
});

test("the Electron process proof starts its disposable copy on the first-run seed, never on a bundled or personal projects file", () => {
  const proof = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8");
  // config/ is not in the copy list at all, so no bundled or personal workspace can reach the disposable copy.
  assert.match(proof, /for \(const name of \["electron", "server", "public", "package\.json"\]\) \{\s*cpSync\(join\(root, name\), join\(dir, name\), \{ recursive: true \}\);/);
  assert.doesNotMatch(proof, /writeFileSync\(join\(dir, "config\/projects\.json"\)/);
});

// Source-text guards for pack 3 review round 1 (the browser tests are too slow to run per mutation, and these fixes are about where a call sits).
test("browser tests remove their temp folder even when stopServer rejects, and the harness reply waits start from the received count", () => {
  const browser = ["browser-real.test.ts", "browser-approval.test.ts"].map((name) => readFileSync(join(root, "test", name), "utf8")).join("\n").replaceAll("\r\n", "\n");
  const guarded = browser.match(/try \{ await stopServer\(child\); \}[^\n]*\n\s*finally \{ rmSync\(temp, /g) ?? [];
  assert.equal(guarded.length, 2, "both browser tests that spawn a server clean their folder in a finally that follows the stop");
  assert.equal((browser.match(/await stopServer\(child\)/g) ?? []).length, 2, "and there are no other stop calls that skip it");
  const harness = harnessSource();
  assert.doesNotMatch(harness, /window\.__received\.slice\(from\)/, "no reply wait slices what the page received with an index taken from what it sent");
  assert.equal((harness.match(/window\.__received\.slice\(receivedFrom\)\.some\(\(message\) => message\.type === "chatDone" && message\.tabId === sent\[0\]\.tabId\)/g) ?? []).length, 2, "both waits count received messages from their own start and match their own tab");
});

// scripts/live-null-check.mjs runs a copy of itself against a stand-in server/index.ts that accepts the socket and never answers: with the script's
// 10 s limit cut to 1.5 s in the copy, the limit must end the waits, so the script exits non-zero, stops the server and removes its data folder.
test("live-null-check: a server that stops answering ends the script at its time limit, with the server stopped and the data folder removed", { timeout: 60_000 }, () => {
  const dir = tempRoot();
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "server"));
  const original = readFileSync(join(root, "scripts/live-null-check.mjs"), "utf8");
  assert.ok(original.includes("}, 10000);"), "the script's time limit is where this test expects it");
  writeFileSync(join(dir, "scripts/live-null-check.mjs"), original.replace("}, 10000);", "}, 1500);"));
  writeFileSync(join(dir, "server/index.ts"), [
    'import http from "node:http";', 'import { writeFileSync } from "node:fs";', 'import { WebSocketServer } from "ws";',
    'const server = http.createServer((request, response) => { response.writeHead(200); response.end("Command Center"); });',
    'new WebSocketServer({ server }).on("connection", () => { /* never answers */ });',
    'server.listen(0, "127.0.0.1", () => { writeFileSync("server.pid", String(process.pid)); console.log(`Command Center running at http://127.0.0.1:${server.address().port}`); });',
    // Ends itself if the script never stopped it, so this test needs no kill by a bare pid.
    'setTimeout(() => process.exit(0), 20000);',
  ].join("\n"));
  // The script gets its own TEMP/TMP, so the only cc-live-null-* folders in it are this invocation's.
  const privateTmp = join(dir, "tmp"); mkdirSync(privateTmp);
  const folders = () => readdirSync(privateTmp).filter((name) => name.startsWith("cc-live-null-"));
  const run = spawnSync(process.execPath, ["scripts/live-null-check.mjs"], { cwd: dir, encoding: "utf8", timeout: 20_000, windowsHide: true, env: { ...process.env, TEMP: privateTmp, TMP: privateTmp } });
  const pidFile = join(dir, "server.pid");
  const serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stoppedByScript = serverPid > 0 && !alive(serverPid);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.error, undefined, `the script did not hang past 20 s: ${run.error?.message}\n${output}`);
  assert.notEqual(run.status, 0, `the script fails when the server stops answering\n${output}`);
  assert.match(output, /timed out/);
  assert.ok(serverPid > 0, "the stand-in server started");
  assert.equal(stoppedByScript, true, "the script stopped the server itself");
  assert.deepEqual(folders(), [], "the script's data folder was removed");
});

// design/simple/mutate.py counts a mutation as caught only by a finished run with a real failed check; --check-parser runs those rules with no browser.
test("design/simple/mutate.py: a run that ran out of time, a crash-only run and a wrong check count are not counted as caught", { skip: !hasDesignFolder(root) && "design/ is not part of this checkout" }, () => {
  assert.ok(COPIED_PATHS.includes("design/simple/mutate.py"), "the mutation sweep's copy holds mutate.py, so this check runs there too");
  const run = spawnSync("python", ["-I", join(root, "design/simple/mutate.py"), "--check-parser"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") return; // no python on this machine: the rules cannot be run here
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /result rules OK/);
});

// The design/ paths are dropped from the sweep's copy only when the design FOLDER is absent at the repo root, never because one file in it is missing.
test("mutation-proof: design/ counts as part of the checkout exactly when the design folder exists", () => {
  const base = mkdtempSync(join(tmpdir(), "cc-design-folder-"));
  try {
    assert.equal(hasDesignFolder(base), false, "no design folder: not part of the checkout");
    mkdirSync(join(base, "design"));
    assert.equal(hasDesignFolder(base), true, "an empty design folder still counts, so a missing file inside it fails loudly");
  } finally { removeWithRetry(base); }
  assert.equal(COPIED_PATHS.includes("design/simple/mutate.py"), hasDesignFolder(root), "the copy list follows the design folder");
});

// scripts/electron-process-proof.mjs opens a real window, so it is never run here; its tracking helpers are run from the real source text.
test("electron-process-proof: a tracked process is told from one that got its pid later, children of a reused pid are not adopted, and cleanup never uses /T", () => {
  const source = readFileSync(join(root, "scripts/electron-process-proof.mjs"), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("// Tracked only while the process is in"), end = source.indexOf("function alive(");
  assert.ok(start > 0 && end > start, "the tracking helpers were found");
  const load = () => runInNewContext(`const tracked = new Map(); ${source.slice(start, end)}; ({ track, isTracked, adoptDescendants, isThisRunsWorker, tracked })`, {});
  const proc = (ProcessId: number, ParentProcessId: number, Name: string, Created: number, CommandLine: string | null = null) => ({ ProcessId, ParentProcessId, Name, Created, CommandLine });
  const list = [proc(10, 1, "electron.exe", 1000, "electron main"), proc(11, 10, "node.exe", 1100, "node server"), proc(12, 11, "cmd.exe", 1200), proc(13, 11, "node.exe", 900, "older than its parent"), proc(99, 1, "node.exe", 1000, "unrelated")];
  const api = load();
  api.track(10, "electron.exe", list);
  api.track(777, "node.exe", list); // not in the list: nothing to verify it against
  api.adoptDescendants(list);
  assert.equal(JSON.stringify([...api.tracked.keys()].sort()), JSON.stringify([10, 11, 12]), "the root and its younger descendants are tracked; a child older than its parent, an unrelated process and an unseen pid are not");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 1100, "node server")), true, "the same process");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 5000, "node server")), false, "same pid and name, another creation time: another program that got the pid");
  assert.equal(api.isTracked(proc(11, 10, "node.exe", 1100, "node another-script.js")), false, "same pid, name and time, another command line");
  assert.equal(api.isTracked(proc(11, 10, "cmd.exe", 1100, "node server")), false, "another name");
  // The root's pid now belongs to something else: its children are not this run's.
  const reused = [proc(10, 1, "electron.exe", 9000, "somebody else's"), proc(50, 10, "node.exe", 9100, "their child")];
  api.adoptDescendants(reused);
  assert.equal(api.tracked.has(50), false, "a child of a reused pid is not adopted");
  assert.doesNotMatch(source, /"\/T"/, "no process is ended together with its whole tree");
  // The worker's own report of its pid is checked against the live list before it is tracked.
  const workerPath = "C:\proof\.cc-test-electron-proof-AAA\worker.cjs";
  const chain = [proc(10, 1, "electron.exe", 1000, "electron main"), proc(11, 10, "node.exe", 1100, "node server"), proc(12, 11, "cmd.exe", 1200, "cmd /c claude.cmd"), proc(20, 12, "node.exe", 1300, `"C:\node.exe" "${workerPath}"`)];
  const claim = { pid: 20, ppid: 12 };
  assert.equal(api.isThisRunsWorker(chain, claim, workerPath, 10), true, "control: the real worker passes");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 20 ? proc(20, 12, "node.exe", 1300, "node somebody-elses-script.js") : p), claim, workerPath, 10), false, "a stale pid now held by another program is not this run's worker");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 20 ? proc(20, 12, "node.exe", 1300, `"C:\node.exe" "C:\proof\.cc-test-electron-proof-BBB\worker.cjs"`) : p), claim, workerPath, 10), false, "another run's worker.cjs is not this run's");
  assert.equal(api.isThisRunsWorker(chain.filter((p) => p.ProcessId !== 20), claim, workerPath, 10), false, "a pid that is no longer in the list");
  assert.equal(api.isThisRunsWorker(chain.map((p) => p.ProcessId === 11 ? proc(11, 99, "node.exe", 1100, "node server") : p), claim, workerPath, 10), false, "a parent chain that does not reach the process this run started");
  assert.equal(api.isThisRunsWorker(chain, { pid: 20, ppid: 11 }, workerPath, 10), false, "a parent other than the reported one");
  const order = [source.indexOf('assert.ok(isThisRunsWorker(before, worker, join(dir, "worker.cjs"), desktop.pid)'), source.indexOf('track(worker.pid, "node.exe", before)')];
  assert.ok(order[0] > 0 && order[1] > order[0], "the worker is verified before it is tracked");
});
