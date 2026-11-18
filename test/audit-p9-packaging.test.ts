import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as installer from "../scripts/dist-installer.mjs";
import { packagedFiles, scanFiles } from "../scripts/export-public/scan.mjs";

const root = resolve("."), pkg = JSON.parse(readFileSync("package.json", "utf8"));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-p9-packaging-"));
  t.after(() => installer.removeOwnedTree(dir));
  const put = (path, bytes) => { const file = join(dir, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); return file; };
  return { dir, put };
}
function child(args, options = {}) {
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, timeout: 30000, ...options, env });
  assert.equal(result.error, undefined, String(result.error));
  return { ...result, output: result.stdout + result.stderr };
}

test("P9 config build inclusion is an exact seed allow-list", () => {
  assert.deepEqual(pkg.build.files.filter((entry) => !entry.startsWith("!") && entry.startsWith("config/")), ["config/.gitkeep"]);
});

for (const entry of ["config/.seed-anything", "config/.seed-other/settings.json", "config/other.json"]) {
  for (const scanner of ["assertPackageClean", "packagedFiles", "scanFiles", "scanPackaged"]) {
  test(`P9 ${scanner} rejects ${entry} without private patterns`, async (t) => {
    const f = fixture(t);
    for (let n = 0; n < 50; n++) f.put(`app/${n}.txt`, "clean");
    f.put(`app/${entry}`, "clean");
    const app = join(f.dir, "app");
    if (scanner === "assertPackageClean") assert.throws(() => installer.assertPackageClean(app), /config seed allow-list/);
    if (scanner === "packagedFiles") assert.throws(() => packagedFiles(app), /config seed allow-list/);
    if (scanner === "scanFiles") assert.ok([...scanFiles([{ path: entry, bytes: Buffer.from("clean") }], [])].some((hit) => hit.includes(entry) && hit.includes("forbidden config")));
    const patterns = process.env.CC_EXPORT_PATTERNS;
    try {
      process.env.CC_EXPORT_PATTERNS = join(f.dir, "absent-patterns");
      if (scanner === "scanPackaged") await assert.rejects(installer.scanPackaged(app), /config seed allow-list/);
    } finally {
      if (patterns === undefined) delete process.env.CC_EXPORT_PATTERNS; else process.env.CC_EXPORT_PATTERNS = patterns;
    }
  });
  }
}

test("P9 only the config seed passes package and export scans", (t) => {
  const f = fixture(t);
  f.put("app/config/.gitkeep", "");
  for (let n = 0; n < 50; n++) f.put(`app/${n}.txt`, "clean");
  assert.doesNotThrow(() => installer.assertPackageClean(join(f.dir, "app")));
  assert.equal(packagedFiles(join(f.dir, "app")).length, 51);
  assert.equal(scanFiles([{ path: "config/.gitkeep", bytes: Buffer.alloc(0) }], []).size, 0);
});

test("P9 the real runtime proof writes success only after executed checks", (t) => {
  const f = fixture(t), artifact = f.put("candidate.exe", "synthetic installer bytes");
  const record = join(f.dir, "success.json"), startedAt = Date.now(), runId = "p9-setter-proof";
  const env = { ...process.env, CC_RUNTIME_PROOF_RECORD: record, CC_RUNTIME_PROOF_ARTIFACT: artifact, CC_RUNTIME_PROOF_RUN_ID: runId };
  const run = child(["scripts/pack29-runtime-proof.mjs", "--electron", resolve("node_modules/electron/dist/electron.exe")], { env, timeout: 150000 });
  assert.equal(run.status, 0, run.output);
  assert.equal(existsSync(record), true, "real proof setter wrote its success record");
  assert.equal(typeof installer.assertRuntimeProofRecord, "function", "publisher validation is available");
  const result = installer.assertRuntimeProofRecord(record, artifact, runId, startedAt);
  assert.equal(result.checksRun, 7, "readiness, observer exit, environment, runtime identity, HTTP, shutdown and free port all executed");
  const missingRecord = join(f.dir, "failure.json");
  const failed = child(["scripts/pack29-runtime-proof.mjs", "--invalid"], { env: { ...env, CC_RUNTIME_PROOF_RECORD: missingRecord } });
  assert.equal(failed.status, 1, failed.output);
  assert.equal(existsSync(missingRecord), false, "failure never writes success");
});

// Run the production publisher with synthetic builders/proofs, never real installers.
for (const mode of ["silent", "empty", "other-artifact", "stale", "replay", "zero-checks", "future", "valid"]) {
  test(`P9 publisher requires fresh artifact-bound proof: ${mode}`, (t) => {
    const f = fixture(t), artifact = `Command Center Setup ${pkg.version}.exe`;
    f.put(`installers/${artifact}`, "previous");
    f.put(`installers/${artifact}.sha256`, "previous hash");
    const builder = f.put("builder.mjs", `import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const stage=process.env.CC_INSTALLER_STAGE; mkdirSync(join(stage,'win-unpacked/resources/app'),{recursive:true});
writeFileSync(join(stage,'win-unpacked/Command Center.exe'),'runtime');
for(let n=0;n<50;n++)writeFileSync(join(stage,'win-unpacked/resources/app',n+'.txt'),'clean');
writeFileSync(join(stage,process.env.CC_INSTALLER_ARTIFACT),'candidate');`);
    const proof = f.put("proof.mjs", `import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const mode=${JSON.stringify(mode)}, now=Date.now();
const record={proof:'pack29-runtime',runId:process.env.CC_RUNTIME_PROOF_RUN_ID,
artifactSha256:createHash('sha256').update(readFileSync(process.env.CC_RUNTIME_PROOF_ARTIFACT ?? process.argv[3])).digest('hex'),
startedAt:now,endedAt:now,checksRun:7};
if(mode==='other-artifact')record.artifactSha256='0'.repeat(64);
if(mode==='stale'){record.startedAt=1;record.endedAt=2;}
if(mode==='replay')record.runId='previous-run';
if(mode==='zero-checks')record.checksRun=0;
if(mode==='future')record.endedAt=now+60000;
if(mode!=='silent')writeFileSync(process.env.CC_RUNTIME_PROOF_RECORD ?? process.argv[3]+'.json',JSON.stringify(mode==='empty'?{}:record));`);
    const patterns = f.put("patterns", "synthetic-p9-private-word\n");
    const env = { ...process.env, CC_INSTALLER_DIST: f.dir, CC_INSTALLER_BUILDER: builder, CC_INSTALLER_PROOF: proof, CC_EXPORT_PATTERNS: patterns };
    const run = child(["scripts/dist-installer.mjs"], { env });
    assert.equal(run.status, mode === "valid" ? 0 : 1, run.output);
    assert.equal(readFileSync(join(f.dir, "installers", artifact), "utf8"), mode === "valid" ? "candidate" : "previous");
    if (mode !== "valid") {
      assert.match(run.output, /no valid success record/);
      assert.equal(readFileSync(join(f.dir, "installers", artifact + ".sha256"), "utf8"), "previous hash");
    }
    assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith("installer-stage-") || name.endsWith(".lock")), []);
  });
}

const entries = ["config-guard", "line-cap", "pack29-runtime-proof", "mutation-proof", "mutation-repoint"];
for (const entry of entries) {
  test(`P9 ${entry} executes with the older Node main flag absent`, (t) => {
    const f = fixture(t);
    // Node's synchronous loader makes the older-runtime condition executable on current Node too.
    const loader = f.put("older-node.mjs", `import {registerHooks,syncBuiltinESMExports} from 'node:module'; import cp from 'node:child_process';
const spawnSync=cp.spawnSync;
cp.spawnSync=(command,args,options)=>command==='git'?{status:0,stdout:args[0]==='rev-parse'?${JSON.stringify(f.dir)}:'',stderr:''}:spawnSync(command,args,options);
syncBuiltinESMExports();
registerHooks({load(url,context,next){const r=next(url,context);if(url.endsWith('.mjs')&&r.source) return {...r,source:String(r.source).replaceAll('import.meta' + '.main','undefined')};return r;}});`);
    f.put("test/crash-catcher-self.ts", "");
    f.put("test/entry.test.ts", "import test from 'node:test'; test('isolated entry executed',()=>{});");
    const absolute = resolve("scripts", entry + ".mjs");
    const paths = [relative(f.dir, absolute)];
    if (process.platform === "win32") paths.push(absolute[0] === absolute[0].toUpperCase() ? absolute[0].toLowerCase() + absolute.slice(1) : absolute[0].toUpperCase() + absolute.slice(1));
    for (const script of paths) {
      const args = entry === "pack29-runtime-proof" ? ["--invalid"] : entry === "mutation-proof" ? ["--invalid"] : [];
      const run = child(["--import", pathToFileURL(loader).href, script, ...args], { cwd: f.dir, env: { ...process.env, CC_LINE_CAP_BASE: "fake-base" } });
      if (entry === "config-guard") { assert.equal(run.status, 0, run.output); assert.match(run.output, /isolated entry executed/); }
      if (entry === "line-cap") { assert.equal(run.status, 0, run.output); assert.match(run.output, /0 files checked, 0 over 400 lines/); }
      if (entry === "pack29-runtime-proof") { assert.equal(run.status, 1, run.output); assert.match(run.output, /Usage: node scripts\/pack29-runtime-proof/); }
      if (entry === "mutation-proof") { assert.equal(run.status, 1, run.output); assert.match(run.output, /unknown option --invalid/); }
      if (entry === "mutation-repoint") { assert.equal(run.status, 1, run.output); assert.match(run.output, /usage: mutation-repoint/); }
    }
  });
}

function unsafeEntry(source) {
  return source.includes("import.meta" + ".main") || /(?:import\.meta\.url\s*={2,3}|={2,3}\s*import\.meta\.url)/.test(source)
    || /(?:pathToFileURL\([^\n]*argv|argv\[1\][^\n]*={2,3}[^\n]*import\.meta|import\.meta[^\n]*={2,3}[^\n]*argv\[1\])/.test(source);
}

test("P9 production source cannot reintroduce unsupported or noncanonical main comparisons", () => {
  const meta = ['import', 'meta'].join('.');
  for (const bad of [`${meta}.main`, `if (${meta}.url === entry) {}`, `if (entry === ${meta}.url) {}`,
    `if (fileURLToPath(${meta}.url) === process.argv[1]) {}`, 'pathToFile' + 'URL(resolve(process.' + 'argv[1])).href']) {
    assert.equal(unsafeEntry(bad), true, `seeded bad entry FOUND: ${bad}`);
  }
  const hits = [], found = new Set();
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(?:[cm]?js|ts)$/.test(item.name)) {
        found.add(file);
        if (unsafeEntry(readFileSync(file, "utf8"))) hits.push(relative(root, file));
      }
    }
  };
  for (const folder of ["scripts", "electron", "server", "build", "test"]) walk(join(root, folder));
  assert.ok(found.has(join(root, "test", "fixed-crew-task-plan.test.ts")), "shared task-plan test entry was scanned");
  for (const entry of entries) assert.ok(found.has(join(root, "scripts", entry + ".mjs")), `${entry} was scanned`);
  assert.deepEqual(hits, [], `unsupported entry points found: ${hits.join(", ")}`);
});

for (const entry of ['dist-installer', 'pack29-installer-proof', 'packaged-smoke']) {
  test(`P9 ${entry} executes its cheap help path through a junction`, (t) => {
    const f = fixture(t), link = join(f.dir, 'linked-scripts');
    symlinkSync(resolve('scripts'), link, 'junction');
    try {
      assert.equal(lstatSync(link).isSymbolicLink(), true, 'test really traverses a junction');
      const run = child([join(link, entry + '.mjs'), '--help']);
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, new RegExp(`Usage: node scripts/${entry}\\.mjs`));
    } finally { assert.ok(lstatSync(link).isSymbolicLink()); rmdirSync(link); }
  });
}

test('P9 runtime record rejects each forged field independently', (t) => {
  const f = fixture(t), artifact = f.put('artifact.exe', 'inert'), file = join(f.dir, 'proof.json');
  const start = Date.now() - 1000;
  const valid = { proof: 'pack29-runtime', runId: 'current', artifactSha256: installer.sha256('inert'), startedAt: start, endedAt: start + 1, checksRun: 1 };
  const invalid = [
    { proof: 'other' }, { runId: 'old' }, { artifactSha256: 'wrong' }, { checksRun: 0 }, { checksRun: 1.5 },
    { startedAt: start - 1 }, { startedAt: start + 0.5 }, { endedAt: start - 1 }, { endedAt: Date.now() + 60000 }, { endedAt: start + 0.5 },
  ];
  for (const patch of invalid) {
    writeFileSync(file, JSON.stringify({ ...valid, ...patch }));
    assert.throws(() => installer.assertRuntimeProofRecord(file, artifact, 'current', start), /no valid success record/, JSON.stringify(patch));
  }
  writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(installer.assertRuntimeProofRecord(file, artifact, 'current', start), valid);
});
