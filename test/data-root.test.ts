import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDir, setEnv, tempRoot } from "./temp-root.ts";
import { ignoresDataRootUnderTestRunner, resolveDataRoot } from "../server/data-root.ts";

// ---- resolveDataRoot: pure (packaged-or-not, via the env var) -------------

test("resolveDataRoot: a packaged env var wins over the repo root", () => {
  assert.equal(resolveDataRoot({ CC_DATA_DIR: "C:\\Users\\x\\AppData\\Roaming\\Command Center" }, "C:\\repo"), "C:\\Users\\x\\AppData\\Roaming\\Command Center");
});

test("resolveDataRoot: falls back to the repo root when unset (source run)", () => {
  assert.equal(resolveDataRoot({}, "C:\\repo"), "C:\\repo");
});

test("resolveDataRoot: falls back to the repo root on an empty string, not an absurd path", () => {
  assert.equal(resolveDataRoot({ CC_DATA_DIR: "" }, "C:\\repo"), "C:\\repo");
});

// ---- guard 5: a relative or whitespace-only CC_DATA_DIR must never break
// history/logs -- history.ts compares an absolute path, so a relative or
// blank one would silently reject every valid run. --------------------------

test("resolveDataRoot: whitespace-only CC_DATA_DIR falls back to the repo root, not a blank path", () => {
  assert.equal(resolveDataRoot({ CC_DATA_DIR: "   " }, "C:\\repo"), "C:\\repo");
});

test("resolveDataRoot: a relative CC_DATA_DIR is resolved to an absolute path, never passed through relative", () => {
  const result = resolveDataRoot({ CC_DATA_DIR: "relative\\data" }, "C:\\repo");
  assert.equal(result, resolve("relative\\data"));
  assert.equal(resolve(result), result, "must already be absolute");
});

test("resolveDataRoot: surrounding whitespace on a real path is trimmed before use", () => {
  assert.equal(resolveDataRoot({ CC_DATA_DIR: "  C:\\Users\\x\\AppData  " }, "C:\\repo"), "C:\\Users\\x\\AppData");
});

// ---- guard 1 (P1): the test runner must never honour CC_DATA_DIR, whatever
// it's set to -- an agent running `npm test` from inside the packaged app
// inherits the real CC_DATA_DIR (see runner.ts's runSeat), and without this
// the suite would write straight into the user's real %APPDATA%\command-center. -

test("resolveDataRoot: NODE_TEST_CONTEXT wins over CC_DATA_DIR, unless CC_TEST_FORCE_PACKAGED is set (that override has its own test below)", () => {
  assert.equal(
    resolveDataRoot({ NODE_TEST_CONTEXT: "1", CC_DATA_DIR: "C:\\Users\\example\\AppData\\Roaming\\command-center" }, "C:\\repo"),
    "C:\\repo"
  );
});

// `node --test` sets NODE_TEST_CONTEXT on this very process (verified: it
// prints "child-v8"), so every call-site test below that wants to prove real
// packaging behaviour has to suppress it for the duration of the import --
// otherwise it would silently exercise the same "ignored" path guard 1 above
// already proves, and assert nothing new. Each test file runs as its own
// child process under node --test, so this never leaks to another file.
async function importAsPackaged(modulePath: string): Promise<any> {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await import(pathToFileURL(modulePath).href);
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

// Loads a copied server module with CC_DATA_DIR set (and optionally the packaged override), then puts the environment back exactly as it was.
async function withDataDir<T>(dir: string, load: () => Promise<T>, force = false): Promise<T> {
  const restore = setEnv({ CC_DATA_DIR: dir, ...(force ? { CC_TEST_FORCE_PACKAGED: "1" } : {}) });
  try { return await load(); } finally { restore(); }
}

// ---- call-site guard: config.ts's configDir must actually route through
// resolveDataRoot -- a mutation reverting it to join(repoRoot, "config")
// must turn this red, not just the pure resolveDataRoot tests above. -------

const packagedCopy = tempRoot(["server", "config"]);
const packagedUserDir = scratchDir();
// The control: a projects.json bundled next to the app. None of it may reach a new user.
writeFileSync(join(packagedCopy, "config", "projects.json"), JSON.stringify([{ id: "bundled", name: "Bundled", dir: "C:\\bundled" }]), "utf8");
const configPackaged = await withDataDir(packagedUserDir, () => importAsPackaged(join(packagedCopy, "server/config.ts")));

test("config.ts: a packaged data root actually drives workspace and legacy config paths", () => {
  const expectedDir = join(packagedUserDir, "config");
  assert.equal(dirname(configPackaged.workspacesPath), expectedDir);
  assert.equal(dirname(configPackaged.projectsPath), expectedDir);
});

test("config.ts: first packaged launch starts a new user on one empty example project, never the bundled projects, and seeds no legacy file", () => {
  const workspaces = JSON.parse(readFileSync(configPackaged.workspacesPath, "utf8"));
  assert.equal(existsSync(join(packagedCopy, "config/projects.json")), true, "control: a projects.json is bundled");
  assert.equal(existsSync(join(packagedUserDir, "config/projects.json")), false, "the bundled projects.json is not copied");
  assert.equal(existsSync(join(packagedUserDir, "config/seats.json")), false, "no legacy seats.json is seeded");
  assert.deepEqual(workspaces.projects.map((project: any) => project.id), ["example"]);
  assert.ok(workspaces.projects.every((project: any) => project.tabs.length === 1 && project.tabs[0].kind === "dev" && project.tabs[0].process === "main"));
  const folder = workspaces.projects[0].folder;
  assert.equal(dirname(folder), packagedUserDir, "the example folder is inside the user's own data root");
  assert.deepEqual(readdirSync(folder), [], "the example folder starts empty");
});

// ---- guard 1's real point: under the ACTUAL test runner (NODE_TEST_CONTEXT
// left exactly as node --test set it -- nothing suppressed here), a set
// CC_DATA_DIR must be ignored at this exact call site, not just proven on the
// pure function above. This is the P1: an agent's `npm test` run must land in
// the repo/temp copy, never the real packaged directory it inherited. -------

const underTestCopy = tempRoot(["server", "config"]);
const underTestDecoyDir = scratchDir();
const configUnderTest = await withDataDir(underTestDecoyDir, () => import(pathToFileURL(join(underTestCopy, "server/config.ts")).href));

test("config.ts: P1 -- under the real test runner, a set CC_DATA_DIR is ignored; workspacesPath stays under the repo/temp copy, never the decoy", () => {
  assert.equal(dirname(configUnderTest.workspacesPath), join(underTestCopy, "config"));
  assert.notEqual(dirname(configUnderTest.workspacesPath), join(underTestDecoyDir, "config"));
});

const sourceCopy = tempRoot(["server", "config"]);
const configSource = await import(pathToFileURL(join(sourceCopy, "server/config.ts")).href);

test("config.ts: running from source (no CC_DATA_DIR) keeps using the repo's own config dir", () => {
  assert.equal(dirname(configSource.workspacesPath), join(sourceCopy, "config"));
});

// ---- guard 3 (P1): an existing user config must never be overwritten, and
// the write itself is exclusive-create, so there is no check-then-write gap
// left for a second first-launch process to race into. ----------------------

const preSeededUserDir = scratchDir();
mkdirSync(join(preSeededUserDir, "config"), { recursive: true });
const customProjects = JSON.stringify([{ id: "custom", name: "Custom", dir: "C:\\custom" }]);
writeFileSync(join(preSeededUserDir, "config", "projects.json"), customProjects, "utf8");
const preSeededCopy = tempRoot(["server", "config"]);
const configPreSeeded = await withDataDir(preSeededUserDir, () => importAsPackaged(join(preSeededCopy, "server/config.ts")));

test("config.ts: an existing projects.json is never overwritten and drives the initial migration", () => {
  assert.equal(existsSync(join(preSeededUserDir, "config/seats.json")), false, "no legacy seats.json is seeded");
  assert.equal(readFileSync(configPreSeeded.projectsPath, "utf8"), customProjects);
  assert.equal(JSON.parse(readFileSync(configPreSeeded.workspacesPath, "utf8")).projects[0].id, "custom");
});

// An interrupted package seed completes the workspace migration on the next
// launch while leaving a user's existing legacy files untouched.

const partialUserDir = scratchDir();
mkdirSync(join(partialUserDir, "config"), { recursive: true });
const customSeats = JSON.stringify([{ id: "custom-seat", name: "Custom", role: "r", kind: "codex", color: "#fff", model: "gpt-6-astra", effort: "low" }]);
writeFileSync(join(partialUserDir, "config", "seats.json"), customSeats, "utf8");
const customUnderground = '[{"custom":"legacy file stays byte exact"}]\n';
writeFileSync(join(partialUserDir, "config", "underground.json"), customUnderground, "utf8");
const partialCopy = tempRoot(["server", "config"]);
const configPartial = await withDataDir(partialUserDir, () => importAsPackaged(join(partialCopy, "server/config.ts")));

test("config.ts: a partial package seed completes the workspaces (example project) without rewriting legacy files or copying bundled projects", () => {
  assert.equal(existsSync(configPartial.projectsPath), false, "the bundled projects.json is not copied");
  const workspaces = JSON.parse(readFileSync(configPartial.workspacesPath, "utf8"));
  assert.deepEqual(workspaces.projects.map((project: any) => project.id), ["example"]);
  assert.equal(readFileSync(join(partialUserDir, "config/seats.json"), "utf8"), customSeats);
  assert.equal(readFileSync(join(partialUserDir, "config/underground.json"), "utf8"), customUnderground);
});

// ---- call-site guard: runner.ts's logsDir must route through the SAME
// resolveDataRoot, not a second, independent mechanism ----------------------

const runnerPackagedCopy = tempRoot(["server", "config"]);
const runnerPackagedUserDir = scratchDir();
const runnerPackaged = await withDataDir(runnerPackagedUserDir, () => importAsPackaged(join(runnerPackagedCopy, "server/runner.ts")));

test("runner.ts: a packaged data root actually drives logsDir", () => {
  assert.equal(runnerPackaged.logsDir, join(runnerPackagedUserDir, "logs"));
});

const runnerUnderTestCopy = tempRoot(["server", "config"]);
const runnerUnderTestDecoyDir = scratchDir();
const runnerUnderTest = await withDataDir(runnerUnderTestDecoyDir, () => import(pathToFileURL(join(runnerUnderTestCopy, "server/runner.ts")).href));

test("runner.ts: P1 -- under the real test runner, a set CC_DATA_DIR is ignored; logsDir stays under the repo/temp copy, never the decoy", () => {
  assert.equal(runnerUnderTest.logsDir, join(runnerUnderTestCopy, "logs"));
  assert.notEqual(runnerUnderTest.logsDir, join(runnerUnderTestDecoyDir, "logs"));
});

const runnerSourceCopy = tempRoot(["server", "config"]);
const runnerSource = await import(pathToFileURL(join(runnerSourceCopy, "server/runner.ts")).href);

test("runner.ts: running from source (no CC_DATA_DIR) keeps logs under the repo copy, unchanged", () => {
  assert.equal(runnerSource.logsDir, join(runnerSourceCopy, "logs"));
});

// Both decisions are pure. In particular, testing the false result performs no IO.
test("data-root test-context decision is filesystem-free", () => {
  assert.equal(ignoresDataRootUnderTestRunner({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(ignoresDataRootUnderTestRunner({}), false);
  assert.equal(ignoresDataRootUnderTestRunner({ NODE_TEST_CONTEXT: "" }), false);
});

// CC_TEST_FORCE_PACKAGED is the narrow override http.test.ts uses to prove
// the real packaged-data-root path through a spawned server child without
// stripping NODE_TEST_CONTEXT.
test("data-root test-context decision: CC_TEST_FORCE_PACKAGED overrides NODE_TEST_CONTEXT, deliberately and only when set", () => {
  assert.equal(ignoresDataRootUnderTestRunner({ NODE_TEST_CONTEXT: "child-v8", CC_TEST_FORCE_PACKAGED: "1" }), false);
  assert.equal(ignoresDataRootUnderTestRunner({ NODE_TEST_CONTEXT: "child-v8", CC_TEST_FORCE_PACKAGED: "" }), true);
});

// Decisions only: these fake paths are never opened.
test("packaged override is inert outside node --test in both data-root directions", () => {
  for (const context of [undefined, ""]) {
    for (const override of [undefined, "", "0", "1", " "]) {
      const env = { NODE_TEST_CONTEXT: context, CC_TEST_FORCE_PACKAGED: override };
      assert.equal(ignoresDataRootUnderTestRunner(env), false);
      assert.equal(resolveDataRoot(env, "C:\\fake\\repo"), "C:\\fake\\repo");
      assert.equal(resolveDataRoot({ ...env, CC_DATA_DIR: "C:\\fake\\data" }, "C:\\fake\\repo"), "C:\\fake\\data");
    }
  }
  for (const override of ["0", "1", " "]) {
    assert.equal(ignoresDataRootUnderTestRunner({ NODE_TEST_CONTEXT: "child-v8", CC_TEST_FORCE_PACKAGED: override }), false);
  }
});

// ---- a workspaces file that is empty or unparsable starts the app on the example project, and the bad file is
// kept beside it as workspaces.json.bad-<timestamp> (never overwritten without that copy). -----------------------

for (const [label, content] of [["empty", ""], ["unparsable", '{"projects": [ {"id": "torn'], ["whitespace only", "  \n"]] as const) {
  test(`config.ts: an ${label} workspaces.json starts on the example project and keeps a .bad copy`, async () => {
    const userDir = scratchDir();
    mkdirSync(join(userDir, "config"), { recursive: true });
    writeFileSync(join(userDir, "config", "workspaces.json"), content, "utf8");
    const copy = tempRoot(["server", "config"]);
    const loaded = await withDataDir(userDir, () => importAsPackaged(join(copy, "server/config.ts")));
    const bad = readdirSync(join(userDir, "config")).filter((name) => /^workspaces\.json\.bad-\d+/.test(name));
    assert.equal(bad.length, 1, `exactly one kept copy: ${JSON.stringify(readdirSync(join(userDir, "config")))}`);
    assert.equal(readFileSync(join(userDir, "config", bad[0]), "utf8"), content, "the kept copy is the bad file, byte for byte");
    assert.deepEqual(JSON.parse(readFileSync(loaded.workspacesPath, "utf8")).projects.map((project: any) => project.id), ["example"]);
  });
}

// ---- under the test runner with no CC_DATA_DIR the data root is the repo, so the writers must refuse their default
// (live) path; an explicit path (a test override) still works. ---------------------------------------------------

test("config.ts: under a test with no CC_DATA_DIR the writers refuse the live files, an explicit path still writes", async () => {
  // A CC_DATA_DIR or CC_TEST_FORCE_PACKAGED already set in the shell is this test's premise undone: both are cleared for it and put back after.
  const restoreEnv = setEnv({ CC_DATA_DIR: undefined, CC_TEST_FORCE_PACKAGED: undefined });
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, "this runs under node --test");
    assert.equal(process.env.CC_DATA_DIR, undefined);
    const copy = tempRoot(["server", "config"]);
    const config = await import(pathToFileURL(join(copy, "server/config.ts")).href);
    // The repo's own workspaces.json is untracked (a fresh clone has none), so this test writes its own into the temp copy.
    writeFileSync(config.workspacesPath, JSON.stringify({ projects: [] }, null, 2) + "\n", "utf8");
    const before = readFileSync(config.workspacesPath, "utf8");
    assert.throws(() => config.writeWorkspaces(JSON.parse(before)), /refusing to write the live config file/);
    assert.throws(() => config.writeClientPrefs({ ...config.DEFAULT_CLIENT_PREFS }), /refusing to write the live config file/);
    assert.throws(() => config.writeLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [] }), /refusing to write the live config file/);
    assert.equal(readFileSync(config.workspacesPath, "utf8"), before, "the live file is untouched");
    assert.equal(existsSync(config.clientPrefsPath) && readFileSync(config.clientPrefsPath, "utf8") === JSON.stringify(config.DEFAULT_CLIENT_PREFS, null, 2) + "\n", false, "no default prefs were written into the live path");
    const elsewhere = join(scratchDir(), "prefs.json");
    assert.equal(config.writeClientPrefs({ ...config.DEFAULT_CLIENT_PREFS }, elsewhere), true);
    assert.ok(existsSync(elsewhere));
  } finally { restoreEnv(); }
});

test("config.ts: a CC_DATA_DIR the resolver ignores (no CC_TEST_FORCE_PACKAGED) still leaves the repo's live files protected", async () => {
  const userDir = scratchDir();
  const copy = tempRoot(["server", "config"]);
  const config = await withDataDir(userDir, () => import(pathToFileURL(join(copy, "server/config.ts")).href + "?ignored-data-dir"));
  const restore = setEnv({ CC_DATA_DIR: userDir });
  try { assert.throws(() => config.writeClientPrefs({ ...config.DEFAULT_CLIENT_PREFS }), /refusing to write the live config file/); } finally { restore(); }
  assert.equal(existsSync(join(userDir, "config", "client-prefs.json")), false);
});

test("config.ts: with CC_DATA_DIR set (a server child under a test) the default path is allowed", async () => {
  const userDir = scratchDir();
  const copy = tempRoot(["server", "config"]);
  const config = await withDataDir(userDir, () => import(pathToFileURL(join(copy, "server/config.ts")).href), true);
  const restore = setEnv({ CC_DATA_DIR: userDir });
  try { assert.equal(config.writeClientPrefs({ ...config.DEFAULT_CLIENT_PREFS }), true); } finally { restore(); }
  assert.ok(existsSync(join(userDir, "config", "client-prefs.json")));
});
