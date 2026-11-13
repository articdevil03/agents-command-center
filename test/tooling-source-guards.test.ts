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

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

test("no test file calls rmSync with recursive: false (it always throws on a folder and leaks it)", () => {
  const files = readdirSync(join(root, "test")).filter((name) => /\.(ts|mjs)$/.test(name));
  assert.ok(files.length > 10, "the scan found the test files");
  const bad = files.filter((name) => /rmSync\([^)]*recursive:\s*false/.test(readFileSync(join(root, "test", name), "utf8").replace(/^ *\/\/.*$/gm, "")));
  assert.deepEqual(bad, []);
});

 test("approval mutation catalogue contains all 80 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-approval-"));
  assert.equal(entries.length, 80);
  for (const [name, file, from] of entries) {
    if (process.env.CC_MUTATION_PROOF !== "1") assert.ok(readFileSync(join(root,file),"utf8").replaceAll("\r\n","\n").includes(from), name);
  }
});

 test("final2 mutation catalogue contains all 28 registered guards", () => {
  const entries = mutations.filter(([name]) => name.startsWith("guard-packc-final2-"));
  assert.equal(entries.length, 28);
  if (process.env.CC_MUTATION_PROOF !== "1") for (const [name, file, from] of entries) assert.equal(readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n").split(from).length - 1, 1, name + " targets exactly one guard");
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
