import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { tempRoot } from "./temp-root.ts";
import { spawnSync } from "node:child_process";
import { assertMatchingBuildArtifacts, isOutsideRepo, runPackagedSmoke } from "../scripts/packaged-smoke.mjs";
import { bareImportsOf, undeclaredImports, realShippedFiles } from "./tooling-imports-helpers.ts";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

test("common static imports in shipped code are declared dependencies", () => {
  const declared = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies));
  const files = realShippedFiles();
  assert.ok(files.length > 0, "found no shipped source files to check");
  const undeclared = undeclaredImports(files, declared);
  assert.deepEqual(
    undeclared,
    [],
    `these resolve in the repo but NOT in the packaged app (electron-builder ships only declared dependencies):\n  ${undeclared.join("\n  ")}`
  );
});

// Guard: the check above is only worth anything if removing a real
// dependency actually trips it. Drives the REAL shipped files through
// undeclaredImports -- the exact function the test above calls -- with only
// the declared set faked in memory, never a broken manifest written to disk.
test("guard: a package shipped code imports but package.json doesn't declare fails, naming the file", () => {
  const declared = new Set(
    Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies).filter((p) => p !== "zod")
  );
  const undeclared = undeclaredImports(realShippedFiles(), declared);
  assert.ok(
    undeclared.some((line) => line === `${join("server", "leader-tools.ts")} imports "zod"`),
    `removing zod from the declared set must flag server/leader-tools.ts; got ${JSON.stringify(undeclared)}`
  );
});

// Guard: the electron exemption is per-directory, not global. electron/main.js
// runs inside Electron and may import it; a server file runs under plain node
// (startServer in electron/server-process.js) and must not get the same pass.
test("guard: the real shipped-file wiring exempts electron only inside electron/", () => {
  const probeFile = join("server", "__packaging_probe__.ts");
  const files = realShippedFiles('import { app } from "electron";');
  const probe = files.find((entry) => entry.file === probeFile);
  assert.ok(probe, `realShippedFiles did not include its server probe: ${JSON.stringify(files.map(({ file }) => file))}`);
  const declared = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies));
  const undeclared = undeclaredImports(files, declared);
  assert.ok(
    undeclared.includes(`${probeFile} imports "electron"`),
    `the server-side electron probe must survive the exemption wiring; matches: ${JSON.stringify(undeclared)}`
  );
});

test("packed smoke sees a D-drive temp path as outside a C-drive repo", () => {
  assert.equal(isOutsideRepo("C:\\repo", "D:\\temp\\cc-smoke\\app", win32), true);
  assert.equal(isOutsideRepo("C:\\repo", "C:\\repo\\app", win32), false);
  assert.equal(isOutsideRepo("C:\\repo", "C:\\repo-sibling", win32), true);
});

test("standalone packaged checks require app and exe from the same explicit build output", async () => {
  await assert.rejects(runPackagedSmoke({ root }), /supply the app path from the same electron-builder output/);

  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "cc-matching-artifacts-"));
  try {
    const app = join(fixture, "win-unpacked", "resources", "app");
    const exe = join(fixture, "Command Center.exe");
    const otherExe = join(fixture, "other-output", "Command Center.exe");
    mkdirSync(app, { recursive: true });
    mkdirSync(dirname(otherExe), { recursive: true });
    writeFileSync(exe, "matching exe");
    writeFileSync(otherExe, "unmatched exe");
    assert.equal(assertMatchingBuildArtifacts(app, exe).buildOutput, realpathSync(fixture));
    assert.throws(() => assertMatchingBuildArtifacts(app, otherExe), /same electron-builder output directory/);
    assert.throws(() => assertMatchingBuildArtifacts(app, exe, path, fixture), /published dist\/ folder.*fresh electron-builder output folder/);
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// The real call path, copied into a simulated repo root, so runPackagedSmoke's
// artifact guard rejects its default <root>/dist publish folder.
test("runPackagedSmoke rejects the default <root>/dist publish folder", async () => {
  const simRoot = mkdtempSync(join(realpathSync(tmpdir()), "cc-sim-repo-"));
  try {
    mkdirSync(join(simRoot, "scripts"));
    for (const name of ["packaged-smoke.mjs", "packaged-smoke-permissions.mjs"]) {
      writeFileSync(join(simRoot, "scripts", name), readFileSync(join(root, "scripts", name)));
    }
    const app = join(simRoot, "dist", "win-unpacked", "resources", "app");
    const exe = join(simRoot, "dist", "Command Center.exe");
    mkdirSync(app, { recursive: true });
    writeFileSync(exe, "published exe");
    const sim = await import(pathToFileURL(join(simRoot, "scripts", "packaged-smoke.mjs")).href);
    await assert.rejects(sim.runPackagedSmoke({
      root: simRoot,
      source: app,
      exe,
      spawnProcess: () => { throw new Error("published dist guard did not reject before exe launch"); },
      logger: { log() {} },
      runIsolated: false,
    }), /published dist\/ folder.*fresh electron-builder output folder/);
  } finally {
    rmSync(simRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("packed smoke removes its temp workspace when copying the app fails", async () => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "cc-smoke-copy-fixture-"));
  try {
    const packedApp = join(fixture, "win-unpacked", "resources", "app");
    const portableExe = join(fixture, "Command Center.exe");
    mkdirSync(packedApp, { recursive: true });
    writeFileSync(portableExe, "fixture");
    const outsideRoot = mkdtempSync(join(realpathSync(tmpdir()), "cc-smoke-copy-failure-"));
    await assert.rejects(runPackagedSmoke({
      root,
      source: packedApp,
      exe: portableExe,
      createTempDir: () => outsideRoot,
      copyTree: () => { throw new Error("simulated copy failure"); },
      logger: { log() {} },
      runIsolated: false,
    }), /simulated copy failure/);
    assert.equal(existsSync(outsideRoot), false, "failed copying must not leak the smoke temp workspace");
  } finally {
    removeWithRetry(fixture);
  }
});

// The guard above is only worth anything if it actually reads imports the way
// shipped code actually writes them. Every row here is a real shape either
// found in this codebase or that broke an earlier version of this scan.
test("the shipped-import scan really reads import statements", () => {
  assert.deepEqual(bareImportsOf('import { z } from "zod";'), ["zod"]);
  assert.deepEqual(bareImportsOf('import x from "@scope/pkg/deep/path";'), ["@scope/pkg"]);
  assert.deepEqual(bareImportsOf('export { a } from "ws";'), ["ws"]);
  assert.deepEqual(bareImportsOf('export * from "missing-pkg";'), ["missing-pkg"]);
  assert.deepEqual(bareImportsOf('const ws = require("ws");'), ["ws"]);
  assert.deepEqual(bareImportsOf('const m = await import("ws");'), ["ws"]);
  // relative, absolute and builtin specifiers are not packages
  assert.deepEqual(bareImportsOf('import a from "./x.ts";import b from "node:fs";'), []);
  // >>> THE TWO REAL COMMENT LINES THAT FOOLED THE FIRST VERSION OF THIS SCAN. <<<
  // Both are verbatim from the shipped source. A `from "..."` inside prose is
  // not an import, and reading it as one failed the build on a sentence.
  assert.deepEqual(bareImportsOf('// moved from "medium" to "low" in this same pack; an install that already'), []);
  assert.deepEqual(bareImportsOf("// asked), so it can't distinguish \"the app's own UI\" from \"the preview"), []);
  assert.deepEqual(bareImportsOf('/* a block comment that says from "nope" */'), []);
  // a URL keeps its "//" and must not be mistaken for a comment
  assert.deepEqual(bareImportsOf('const u = "https://example.com"; import a from "ws";'), ["ws"]);
  // a real comment following a URL-bearing string must not resurrect a fake
  // "package" out of its own prose
  assert.deepEqual(bareImportsOf('const url="https://example.com"; // require("not-a-package")'), []);
  // a string containing "//" must not swallow the real import that follows it
  assert.deepEqual(bareImportsOf('const s="//"; import x from "missing-pkg";'), ["missing-pkg"]);
  // a template literal's contents are never re-read as code
  assert.deepEqual(bareImportsOf('const s = `require("x")`;'), []);
  // a multi-line import
  assert.deepEqual(bareImportsOf('import {\n  a\n} from "pkg";'), ["pkg"]);
  // a side-effect import has no "from" at all
  assert.deepEqual(bareImportsOf('import "pkg";'), ["pkg"]);
  // import() with a template literal that has no interpolation
  assert.deepEqual(bareImportsOf('import(`pkg`);'), ["pkg"]);
  // an escaped quote inside a specifier must not truncate it
  assert.throws(() => bareImportsOf('import x from "some\\"thing";'), /escape sequence in specifier/);
  // and it must genuinely see the file that broke the exe
  assert.ok(bareImportsOf(readFileSync(join(root, "server/leader-tools.ts"), "utf8")).includes("zod"));
});

// Guard: a genuinely dynamic specifier can't be resolved by a static scan --
// silently finding nothing there would silently stop checking it. There are
// none in the shipped code today (the real test above proves that by not
// throwing), so this only fires the moment one is ever added.
test("a dynamic import() with a non-literal specifier cannot be checked, so it fails loudly naming the file", () => {
  assert.throws(
    () => bareImportsOf("const p = pkg;\nimport(p);", "server/fake.ts"),
    /server\/fake\.ts:2: dynamic import\(\)/
  );
  assert.throws(
    () => bareImportsOf("import(`${base}/x`);", "server/fake.ts"),
    /server\/fake\.ts:1: dynamic import\(\)/
  );
});

// Mutate disposable REAL files and launch the REAL dependency test. A helper
// result is not the guard. Each failing child is followed by a restored pass.
test("shipped dependency call site rejects round-2 constructs and undeclared real-file imports", () => {
  const dir = tempRoot(["server", "electron", "test", "scripts"]);
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  writeFileSync(join(dir, "package.json"), manifest);
  const probe = join(dir, "server", "round2-import-probe.ts");
  const run = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.CC_DATA_DIR;
    delete env.CC_TEST_FORCE_PACKAGED;
    return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^common static imports in shipped code are declared dependencies$", "test/tooling-shipped-imports.test.ts"], {
      cwd: dir, env, encoding: "utf8", timeout: 20000,
    });
  };
  const cases: [string, string, RegExp][] = [
    ["regex ambiguity", 'const a = {} / 2; import "missing-round2";', /regex-vs-division ambiguity/],
    ["regex quote", '/"/.test(s); import "missing-round2";', /imports "missing-round2"/],
    ["template interpolation", 'const s = `${import("missing-round2")}`;', /template interpolation containing import\/require/],
    ["nested template with quoted brace", 'const s = `${"}" + `x` + import("missing-round2")}`;', /template interpolation/],
    ["nested template with commented import", 'const s = `${"}" + `x` + import /* comment */ ("missing-round2")}`;', /template interpolation/],
    ["template require", 'const s = `${require("missing-round2")}`;', /template interpolation/],
    ["composed dynamic import", 'import("ws" + suffix);', /non-literal or composed/],
    ["long import", `import { ${Array.from({ length: 41 }, (_, i) => `a${i}`).join(", ")} } from "missing-round2";`, /imports "missing-round2"/],
    ["escaped specifier", String.raw`import "\x7aod";`, /escape sequence in specifier/],
    ["continued specifier", 'import "zo\\\nd";', /escape sequence in specifier/],
    ["unterminated string", 'const s = "oops', /unterminated string/],
    ["unterminated template", 'const s = `oops', /unterminated template/],
    ["unterminated block comment", '/* oops', /unterminated block comment/],
    ["unterminated regex", 'const r = /oops', /unterminated regex/],
    ["multiline import", 'import {\n a\n} from "missing-round2";', /imports "missing-round2"/],
    ["side-effect import", 'import "missing-round2";', /imports "missing-round2"/],
    ["server electron", 'import { app } from "electron";', /imports "electron"/],
    ["dynamic require", 'require(name);', /non-literal or composed/],
  ];
  for (const [name, source, expected] of cases) {
    writeFileSync(probe, source);
    const red = run();
    const output = red.stdout + red.stderr;
    assert.equal(red.status, 1, `${name}: real test must fail\n${output}`);
    assert.match(output, expected, name);
    assert.match(output, /round2-import-probe\.ts/, name);
    if (!expected.source.startsWith('imports')) {
      assert.match(output, /round2-import-probe\.ts:\d+:/);
      if (name === "regex ambiguity") {
        // The one fail() case with nothing on its line implying an import
        // (plain division): must NOT get the "verify ... package is
        // declared" phrasing that every real import-shaped construct below does.
        assert.match(output, /cannot be tokenized statically/, name);
        assert.doesNotMatch(output, /verify by hand that its package is declared/, name);
      } else {
        assert.match(output, /verify by hand that its package is declared/);
      }
    }
    rmSync(probe);
    const green = run();
    assert.equal(green.status, 0, `${name}: restored real test\n${green.stdout}${green.stderr}`);
    console.log(`${name}: RED exit ${red.status}, GREEN exit ${green.status}`);
  }
  const withoutZod = JSON.parse(manifest);
  delete withoutZod.dependencies.zod;
  writeFileSync(join(dir, "package.json"), JSON.stringify(withoutZod));
  const red = run();
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout + red.stderr, /leader-tools\.ts imports "zod"/);
  writeFileSync(join(dir, "package.json"), manifest);
  const green = run();
  assert.equal(green.status, 0, green.stdout + green.stderr);
  console.log(`removed zod declaration: RED exit ${red.status}, GREEN exit ${green.status}`);
});
