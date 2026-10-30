import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { removeSmokeTemp } from "../packaged-smoke.mjs";
import { root, tempRoot, distScript } from "./context.mjs";
import assert from "node:assert/strict";

export function makeTemp(prefix) {
  return mkdtempSync(join(tempRoot, prefix));
}

export function removeOwnedTemp(dir) {
  const resolved = realpathSync(dir);
  const rel = relative(tempRoot, resolved);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), `refusing cleanup outside OS temp: ${resolved}`);
  removeSmokeTemp(resolved);
  assert.equal(existsSync(resolved), false, `temp directory remains: ${resolved}`);
}

function builderSource() {
  return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.env.CC_DIST_BUILD_OUTPUT_DIR;
const ownerStartedAt = JSON.parse(readFileSync(process.env.CC_DIST_LOCK_OVERRIDE, "utf8")).ownerStartedAt;
if (!/^\\d+$/.test(String(ownerStartedAt ?? ""))) throw new Error("dist lock omitted the numeric process start identity");
mkdirSync(out, { recursive: true });
if (process.env.CC_TEST_BUILD_HANG) { writeFileSync(process.env.CC_TEST_BUILD_HANG, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000)); }
writeFileSync(join(out, "Command Center.exe"), process.env.CC_TEST_BUILD_CONTENT ?? "BROKEN");
if (process.env.CC_TEST_BUILD_MARKER) writeFileSync(process.env.CC_TEST_BUILD_MARKER, out);
process.exit(Number(process.env.CC_TEST_BUILD_EXIT ?? 0));
`;
}

function smokeSource() {
  return `import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dist = process.env.CC_DIST_DIR_OVERRIDE;
const exe = join(dist, "Command Center.exe");
const lastGood = join(dist, "Command Center.exe.last-good");
if (process.env.CC_TEST_EXPECTED_PUBLISHED === "__ABSENT__") assert.equal(existsSync(exe), false, "published exe appeared before smoke started");
else assert.equal(readFileSync(exe, "utf8"), process.env.CC_TEST_EXPECTED_PUBLISHED, "published exe changed before smoke started");
if (process.env.CC_TEST_EXPECTED_LAST_GOOD === "__ABSENT__") assert.equal(existsSync(lastGood), false, "last-good appeared before smoke started");
else assert.equal(readFileSync(lastGood, "utf8"), process.env.CC_TEST_EXPECTED_LAST_GOOD, "last-good changed before smoke started");
if (process.env.CC_TEST_SMOKE_HANG) { writeFileSync(process.env.CC_TEST_SMOKE_HANG, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000)); }
process.exitCode = Number(process.env.CC_TEST_SMOKE_EXIT ?? 0);
`;
}

export function makeDistEnv(distDir, builderFile, smokeFile, {
  buildContent = "GOOD BUILD v2",
  buildExit = 0,
  smokeExit = 0,
  marker,
  env = {},
} = {}) {
  return {
    ...process.env,
    CC_DIST_DIR_OVERRIDE: distDir,
    CC_DIST_LOCK_OVERRIDE: join(distDir, ".dist-build.lock"),
    CC_DIST_BUILD_OVERRIDE: `"${process.execPath}" "${builderFile}"`,
    CC_DIST_SMOKE_OVERRIDE: smokeFile,
    CC_TEST_BUILD_CONTENT: buildContent,
    CC_TEST_BUILD_EXIT: String(buildExit),
    CC_TEST_SMOKE_EXIT: String(smokeExit),
    ...(marker ? { CC_TEST_BUILD_MARKER: marker } : {}),
    ...env,
  };
}

export function writeDistSimulations(distDir) {
  const builderFile = join(distDir, "builder-sim.mjs");
  const smokeFile = join(distDir, "smoke-sim.mjs");
  writeFileSync(builderFile, builderSource(), "utf8");
  writeFileSync(smokeFile, smokeSource(), "utf8");
  return { builderFile, smokeFile };
}

export function runDistWrapper(distDir, { preload, ...options } = {}) {
  const { builderFile, smokeFile } = writeDistSimulations(distDir);
  const lastGood = join(distDir, "Command Center.exe.last-good");
  const exe = join(distDir, "Command Center.exe");
  const expectedLastGood = existsSync(lastGood) ? readFileSync(lastGood, "utf8") : "__ABSENT__";
  const expectedPublished = expectedLastGood !== "__ABSENT__"
    ? expectedLastGood
    : existsSync(exe) ? readFileSync(exe, "utf8") : "__ABSENT__";
  return spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), distScript], {
    encoding: "utf8",
    timeout: 30000,
    cwd: root,
    env: {
      ...makeDistEnv(distDir, builderFile, smokeFile, options),
      CC_TEST_EXPECTED_PUBLISHED: expectedPublished,
      CC_TEST_EXPECTED_LAST_GOOD: expectedLastGood,
    },
  });
}

export function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH" && error?.code !== "EINVAL"; }
}

export function brokenArtifacts(distDir) {
  return readdirSync(distDir).filter((name) => name.startsWith("Command Center.BROKEN-"));
}

export function seedVerifiedExe(distDir, value = "VERIFIED BUILD v1") {
  writeFileSync(join(distDir, "Command Center.exe"), value);
  writeFileSync(join(distDir, "Command Center.exe.last-good"), value);
}

export function deadPid() {
  for (let pid = 900000; pid < 901000; pid++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EINVAL") return pid;
    }
  }
  throw new Error("could not find an unused process id for the interrupted-build fixture");
}
