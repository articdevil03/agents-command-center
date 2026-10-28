import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handoverPath, readGitChanges, readTabNotes } from "../server/changes.ts";
import { runCli, type RunCli } from "../server/settings.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "cc-changes-test-")); }

test("git summary runs only local status and last-commit commands with the exact argv", async () => {
  const calls: Array<{ bin: string; args: string[]; timeoutMs: number }> = [];
  const runner: RunCli = async (bin, args, options) => {
    calls.push({ bin, args: [...args], timeoutMs: options.timeoutMs });
    return calls.length === 1
      ? { code: 0, stdout: "## feature/changes...origin/feature/changes [ahead 2, behind 3]\0 M src/main.ts\0?? notes.txt\0", stderr: "" }
      : { code: 0, stdout: "abc123\0add the settings panel\n", stderr: "" };
  };
  const folder = "C:/temporary/project";
  const changes = await readGitChanges(folder, runner);
  assert.deepEqual(calls, [
    { bin: "git", args: ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "--no-optional-locks", "-C", folder, "status", "--porcelain=v1", "-z", "-b", "--no-renames"], timeoutMs: 5000 },
    { bin: "git", args: ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-C", folder, "log", "-1", "--format=%h%x00%s"], timeoutMs: 5000 },
  ]);
  assert.equal(calls.some((call) => call.args.includes("fetch")), false);
  assert.deepEqual(changes, {
    repo: true,
    branch: "feature/changes",
    ahead: 2,
    behind: 3,
    lastCommit: { hash: "abc123", subject: "add the settings panel" },
    uncommittedFiles: [{ status: "M", path: "src/main.ts" }, { status: "??", path: "notes.txt" }],
  });
});

test("git changes reports a non-repository when status fails and never asks for a log", async () => {
  const calls: string[][] = [];
  const result = await readGitChanges("C:/temporary/not-a-repo", async (_bin, args) => {
    calls.push([...args]);
    return { code: 128, stdout: "", stderr: "not a repository" };
  });
  assert.deepEqual(calls, [["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "--no-optional-locks", "-C", "C:/temporary/not-a-repo", "status", "--porcelain=v1", "-z", "-b", "--no-renames"]]);
  assert.deepEqual(result, { repo: false, branch: null, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] });
});

test("Where we left off reads only a contained RESUME.md and caps the returned content", async () => {
  const root = tempDir();
  try {
    const directory = join(root, ".command-center");
    mkdirSync(directory);
    const notePath = join(directory, "RESUME.md");
    writeFileSync(notePath, "Last checkpoint\nNext step: wire state.\n");
    assert.deepEqual(await readTabNotes(root, "alpha-tab"), {
      path: notePath, content: "Last checkpoint\nNext step: wire state.\n", truncated: false,
    });
    writeFileSync(notePath, "x".repeat(65 * 1024));
    const capped = await readTabNotes(root, "alpha-tab");
    assert.equal(capped.content.length, 64 * 1024);
    assert.equal(capped.truncated, true);
    assert.deepEqual(await readTabNotes(join(root, "missing"), "alpha-tab"), { path: null, content: "", truncated: false });
    assert.deepEqual(await readTabNotes("", "alpha-tab"), { path: null, content: "", truncated: false });
  } finally { removeWithRetry(root); }
});

test("each tab reads its own handover; until it has saved one, the folder's older shared file is read and never written", async () => {
  const root = tempDir();
  try {
    const directory = join(root, ".command-center");
    mkdirSync(join(directory, "alpha-tab"), { recursive: true });
    const shared = join(directory, "RESUME.md"), own = join(directory, "alpha-tab", "RESUME.md");
    assert.equal(own, handoverPath(root, "alpha-tab"), "the path every Save, read and panel uses");
    assert.throws(() => handoverPath(root, "../escape"), /unsafe tab id/);
    writeFileSync(shared, "Shared, older\n");
    assert.equal((await readTabNotes(root, "alpha-tab")).path, shared, "no handover of its own yet: the older shared one is read");
    assert.equal((await readTabNotes(root, "beta-tab")).path, shared, "a tab that never saved reads it too");
    writeFileSync(own, "Alpha's own\n");
    assert.deepEqual(await readTabNotes(root, "alpha-tab"), { path: own, content: "Alpha's own\n", truncated: false });
    assert.equal((await readTabNotes(root, "beta-tab")).path, shared, "another tab never sees alpha's file");
    assert.equal(readFileSync(shared, "utf8"), "Shared, older\n", "the shared file was not touched");
    assert.deepEqual(await readTabNotes(root, "../escape"), { path: null, content: "", truncated: false });
  } finally { removeWithRetry(root); }
});

test("Where we left off refuses a RESUME.md reached through a directory junction", async () => {
  const root = tempDir();
  try {
    const outside = join(root, "outside");
    const folder = join(root, "project");
    mkdirSync(outside);
    mkdirSync(folder);
    writeFileSync(join(outside, "RESUME.md"), "outside notes");
    symlinkSync(outside, join(folder, ".command-center"), "junction");
    assert.deepEqual(await readTabNotes(folder, "alpha-tab"), { path: null, content: "", truncated: false });
  } finally { removeWithRetry(root); }
});

test("git summary reads machine output: names with spaces, quotes and accents come back exactly, a rename is a delete plus an add", async () => {
  const runner: RunCli = async (_bin, args) => args.includes("status")
    ? { code: 0, stdout: ["## main", " M my file.txt", "?? " + 'say "hi".txt', "?? café/über.txt", "D  old name.txt", "A  new name.txt", ""].join("\0"), stderr: "" }
    : { code: 0, stdout: "", stderr: "" };
  const changes = await readGitChanges("C:/temporary/project", runner);
  assert.deepEqual(changes.uncommittedFiles, [
    { status: "M", path: "my file.txt" }, { status: "??", path: 'say "hi".txt' }, { status: "??", path: "café/über.txt" },
    { status: "D", path: "old name.txt" }, { status: "A", path: "new name.txt" },
  ]);
  assert.equal(changes.branch, "main");
});

test("git summary against a real repository: unusual file names, a configured signature check and a rename do not confuse it", { skip: spawnSync("git", ["--version"]).status !== 0 }, async () => {
  const root = tempDir();
  const git = (...args: string[]) => { const result = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  try {
    git("init", "-q");
    git("config", "log.showSignature", "true");
    git("config", "color.ui", "always");
    writeFileSync(join(root, "renamed from.txt"), "a");
    writeFileSync(join(root, "tracked.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "first commit");
    git("mv", "renamed from.txt", "renamed to.txt");
    writeFileSync(join(root, "café über.txt"), "x");
    writeFileSync(join(root, "tracked.txt"), "changed");
    const changes = await readGitChanges(root, runCli);
    assert.equal(changes.repo, true);
    assert.equal(changes.lastCommit?.subject, "first commit");
    assert.match(changes.lastCommit?.hash ?? "", /^[0-9a-f]{7,}$/, "no signature text in front of the hash");
    const paths = changes.uncommittedFiles.map((file) => `${file.status} ${file.path}`).sort();
    assert.deepEqual(paths, ["?? café über.txt", "A renamed to.txt", "D renamed from.txt", "M tracked.txt"].sort());
  } finally { removeWithRetry(root); }
});
