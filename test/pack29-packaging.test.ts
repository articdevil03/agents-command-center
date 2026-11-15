import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { assertPackageClean, removeOwnedTree, sha256 } from "../scripts/dist-installer.mjs";
import { FORBIDDEN_PACKAGED_ENTRIES } from "../scripts/export-public/scan.mjs";
import { manifest } from "../scripts/pack29-installer-proof.mjs";
import { runIsolatedPackagedServer } from "../scripts/packaged-smoke.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const electron = join(createRequire(import.meta.url).resolve("electron/package.json"), "../dist/electron.exe");

test("installer config leaves the portable command, identity and target unchanged", () => {
  assert.equal(pkg.scripts.dist, "node scripts/dist.mjs");
  assert.equal(pkg.scripts["dist:installer"], "node scripts/dist-installer.mjs");
  assert.equal(pkg.build.win.target, "portable");
  assert.equal(pkg.build.portable.artifactName, "Command Center.exe");
  assert.equal(pkg.name, "command-center");
  assert.equal(pkg.build.appId, "com.agents.command-center");
  assert.equal(pkg.build.productName, "Command Center");
  assert.equal(pkg.build.asar, false);
  assert.ok(pkg.build.files.includes("!config/first-run.json"), "first-run marker never packaged");
  for (const [key, value] of Object.entries({ oneClick: true, perMachine: false, allowElevation: false, createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true, differentialPackage: false, include: "build/installer.nsh", shortcutName: "Command Center", artifactName: "Command Center Setup ${version}.exe" })) assert.equal(pkg.build.nsis[key], value, key);
  assert.equal(pkg.build.publish, undefined);
  assert.equal(pkg.dependencies["electron-updater"], undefined);
});

function simulatedBuild({ buildExit = 0, proofExit = 0, scanHit = false, missingPatterns = false, fault = "" } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "cc-installer-test-"));
  const artifact = `Command Center Setup ${pkg.version}.exe`;
  mkdirSync(join(temp, "installers"));
  writeFileSync(join(temp, "installers", artifact), "previous");
  writeFileSync(join(temp, "installers", artifact + ".sha256"), "previous hash");
  writeFileSync(join(temp, "Command Center.exe"), "portable sentinel");
  const builder = join(temp, "builder.mjs"), proof = join(temp, "proof.mjs");
  const patterns = join(temp, "patterns");
  if (!missingPatterns) writeFileSync(patterns, "quartzplatypus\n");
  writeFileSync(builder, `import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const out=process.env.CC_INSTALLER_STAGE;
mkdirSync(join(out,'win-unpacked/resources/app'),{recursive:true});
for(let n=0;n<50;n++) writeFileSync(join(out,'win-unpacked/resources/app',n+'.txt'),'clean');
writeFileSync(join(out,'win-unpacked/resources/app/payload.txt'),${JSON.stringify(scanHit ? 'quartzplatypus' : 'clean')});
writeFileSync(join(out,'win-unpacked/Command Center.exe'),'bundled');
writeFileSync(join(out,process.env.CC_INSTALLER_ARTIFACT),'candidate');
process.exit(${buildExit});`);
  writeFileSync(proof, `import assert from 'node:assert/strict'; import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
assert.equal(process.argv[2],'--electron');
assert.equal(readFileSync(process.argv[3],'utf8'),'bundled');
assert.equal(readFileSync(join(process.env.CC_INSTALLER_DIST,'installers',process.env.CC_INSTALLER_ARTIFACT),'utf8'),'previous','proof must precede publishing');
writeFileSync(join(process.env.CC_INSTALLER_DIST,'proof-ran'),'yes'); process.exit(${proofExit});`);
  const preload = join(temp, "fault.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync, rmdir = fs.rmdirSync;
fs.renameSync = (from, to) => {
  if (${JSON.stringify(fault)} === 'sidecar' && String(from).endsWith('.sha256.tmp')) throw new Error('forced sidecar rename failure');
  rename(from, to);
  if (${JSON.stringify(fault)} === 'hash' && String(from).endsWith('.sha256.tmp')) fs.writeFileSync(to, 'wrong hash');
  if (${JSON.stringify(fault)} === 'name' && String(from).endsWith('.sha256.tmp')) fs.writeFileSync(to, '${sha256("candidate")}  wrong.exe\\n');
};
fs.rmdirSync = (dir, ...args) => { if (${JSON.stringify(fault)} === 'cleanup' && String(dir).includes('installer-stage-')) throw new Error('forced cleanup failure'); return rmdir(dir, ...args); };
syncBuiltinESMExports();`);
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/dist-installer.mjs"], { encoding: "utf8", timeout: 20000, env: { ...process.env, CC_EXPORT_PATTERNS: patterns, CC_INSTALLER_DIST: temp, CC_INSTALLER_BUILDER: builder, CC_INSTALLER_PROOF: proof } });
  return { temp, artifact, run };
}

for (const [label, buildExit, proofExit] of [["success", 0, 0], ["builder failure", 3, 0], ["proof failure", 0, 4]] as const) {
  test(`installer ${label} preserves portable, publishes only after proof, and cleans its stage`, () => {
    const { temp, artifact, run } = simulatedBuild({ buildExit, proofExit });
    try {
      assert.equal(run.status, buildExit || proofExit ? 1 : 0, `${run.stdout}\n${run.stderr}`);
      assert.equal(readFileSync(join(temp, "Command Center.exe"), "utf8"), "portable sentinel");
      assert.equal(readFileSync(join(temp, "installers", artifact), "utf8"), buildExit || proofExit ? "previous" : "candidate");
      assert.equal(readFileSync(join(temp, "installers", artifact + ".sha256"), "utf8"), buildExit || proofExit ? "previous hash" : `${sha256("candidate")}  ${artifact}\n`);
      assert.equal(existsSync(join(temp, "proof-ran")), buildExit === 0, "PATH-less proof invoked on every completed build");
      assert.deepEqual(readdirSync(temp).filter((s) => s.startsWith("installer-stage-") || s.endsWith(".lock")), []);
      if (!buildExit && !proofExit) assert.ok(run.stdout.includes(sha256("candidate")), "printed artifact hash");
    } finally { removeOwnedTree(temp); }
  });
}

test("package scanner inspects actual resources, catches every forbidden entry and finds an absent root", () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-installer-scan-"));
  try {
    assert.throws(() => assertPackageClean(join(temp, "absent")));
    for (const entry of FORBIDDEN_PACKAGED_ENTRIES) {
      const app = join(temp, String(readdirSync(temp).length)); mkdirSync(app); mkdirSync(join(app, "config"));
      writeFileSync(join(app, entry), "private");
      assert.throws(() => assertPackageClean(app), /private packaged entry:/, entry);
    }
  } finally { removeOwnedTree(temp); }
});

test("data manifest counts empty folders and detects added files, changed bytes and names", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-installer-manifest-"));
  try {
    mkdirSync(join(dir, "empty")); writeFileSync(join(dir, "odd # [].txt"), "abc");
    const before = manifest(dir);
    assert.deepEqual(before, [{ path: "empty/", bytes: 0, hash: null }, { path: "odd # [].txt", bytes: 3, hash: sha256("abc") }]);
    writeFileSync(join(dir, "odd # [].txt"), "abd"); assert.notDeepEqual(manifest(dir), before);
    writeFileSync(join(dir, "extra"), ""); assert.equal(manifest(dir).length, 3);
  } finally { removeOwnedTree(dir); }
});

test("isolated smoke selects packaged Electron, sets Node mode and keeps permission flags", async () => {
  const seen = [];
  const outsideRoot = mkdtempSync(join(tmpdir(), "cc-installer-smoke-"));
  try {
  for (const permission of [false, true]) {
    await runIsolatedPackagedServer({ app: resolve("app"), exe: electron, outsideRoot, data: resolve("data"), permission, logger: { log() {} },
      spawnProcess: (command, args, options) => {
        seen.push({ command, args, env: options.env });
        const child = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, connected: true, stdout: new PassThrough(), stderr: new PassThrough(), disconnect() { this.connected = false; this.exitCode = 0; this.emit("exit", 0); } });
        setImmediate(() => child.stdout.write("Command Center running at http://127.0.0.1:12345\n"));
        return child;
      } });
  }
  assert.equal(seen.length, 2);
  for (const record of seen) { assert.equal(record.command, electron, "bundled runtime, no system Node"); assert.equal(record.env.ELECTRON_RUN_AS_NODE, "1"); }
  assert.ok(seen[1].args.includes("--permission"));
  assert.ok(seen[1].args.includes(`--allow-fs-write=${resolve("data")}`));
  } finally { removeOwnedTree(outsideRoot); }
});

test("installer normalization checks errors and falls back before comparing paths", () => {
  const source = readFileSync("build/installer.nsh", "utf8").replace(/^\s*;.*$/gm, "");
  const hook = source.match(/!macro customInit\b([\s\S]*?)!macroend/)?.[1];
  assert.ok(hook, "customInit found");
  const calls = [...source.matchAll(/GetFullPathName\s+(\$\w+)\s+("[^"\r\n]*")/g)];
  assert.equal(calls.length, 2, "both normalized paths found");
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const call of calls) {
    assert.match(source.slice(0, call.index), /ClearErrors\s*$/);
    const fallback = String.raw`^\s*\$\{If\} \$\{Errors\}\s*\$\{OrIf\} ${escape(call[1])} == ""\s*StrCpy ${escape(call[1])} ${escape(call[2])}\s*\$\{EndIf\}`;
    assert.match(source.slice(call.index! + call[0].length), new RegExp(fallback), `checked fallback for ${call[0]}`);
  }
  assert.match(hook, /\$\{If\} \$R0 != ""\s*\$\{AndIf\} \$R1 != ""/);
});

// Unsafe mutations schedule the real lifecycle automatically, never a static-only catch.
const nativeRequired = process.env.CC_INSTALLER_LIFECYCLE === "1" || pkg.build.nsis.deleteAppDataOnUninstall === true
  || !readFileSync("build/installer.nsh", "utf8").includes('    StrCpy $R0 "$INSTDIR"')
  || readFileSync("build/installer.nsh", "utf8").includes("w rR4")
  || !readFileSync("build/installer.nsh", "utf8").includes('${GetOptions} $R0 "--delete-app-data" $R1');
test("native installer preservation lifecycle (opt in or unsafe mutation)", { skip: !nativeRequired, timeout: 900000 }, () => {
  const started = Date.now();
  const args = ["scripts/pack29-installer-proof.mjs", ...(process.env.CC_INSTALLER_LIFECYCLE === "1" ? [] : ["--once"])];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, timeout: 850000 });
  console.log(`NATIVE LIFECYCLE exit=${run.status} wall=${((Date.now() - started) / 1000).toFixed(2)}s\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

for (const scanHit of [true, false]) {
  test(`installer scan ${scanHit ? "failure blocks publishing" : "explicit missing list blocks publishing"}`, () => {
    const { temp, artifact, run } = simulatedBuild({ scanHit, missingPatterns: !scanHit });
    try {
      assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
      assert.equal(readFileSync(join(temp, "installers", artifact), "utf8"), "previous");
      assert.equal(readFileSync(join(temp, "installers", artifact + ".sha256"), "utf8"), "previous hash");
      if (scanHit) { assert.match(run.stdout, /leak scan running/); assert.match(run.stderr, /payload.txt:1: pattern #1/); }
      else { assert.match(run.stderr, /CC_EXPORT_PATTERNS file is missing/); assert.doesNotMatch(run.stdout, /leak scan skipped/); }
      assert.deepEqual(readdirSync(temp).filter((s) => s.startsWith("installer-stage-") || s.endsWith(".lock")), []);
    } finally { removeOwnedTree(temp); }
  });
}


for (const fault of ["hash", "name", "sidecar", "cleanup"]) {
  test(`installer publish failure injection: ${fault}`, () => {
    const { temp, artifact, run } = simulatedBuild({ fault });
    try {
      assert.equal(run.status, fault === "cleanup" ? 0 : 1, run.stdout + run.stderr);
      assert.equal(readFileSync(join(temp, "installers", artifact), "utf8"), "candidate");
      if (fault === "cleanup") {
        assert.match(run.stderr, /warning: could not remove the stage folder .*forced cleanup failure/);
        assert.equal(readFileSync(join(temp, "installers", artifact + ".sha256"), "utf8"), `${sha256("candidate")}  ${artifact}\n`);
        assert.ok(readdirSync(temp).some((name) => name.startsWith("installer-stage-")));
      } else if (fault === "sidecar") {
        assert.match(run.stderr, /could not publish checksum .*sha256.tmp to .*sha256 for installer/);
        assert.equal(existsSync(join(temp, "installers", artifact + ".sha256")), false, "never leave the old hash beside a new installer");
      } else assert.match(run.stderr, /published checksum mismatch: .*exe and .*sha256/);
      assert.equal(existsSync(join(temp, ".dist-installer.lock")), false);
      assert.equal(readdirSync(join(temp, "installers")).some((name) => name.endsWith(".tmp")), false);
    } finally { removeOwnedTree(temp); }
  });
}
