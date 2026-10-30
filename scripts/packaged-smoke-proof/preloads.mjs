import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeUnlinkFailurePreload(dir) {
  const preload = join(dir, "unlink-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.unlinkSync;
fs.unlinkSync = (path) => {
  if (String(path).includes(".cc-exe-displaced-")) {
    const error = new Error("simulated EPERM on displaced exe");
    error.code = "EPERM";
    throw error;
  }
  return original(path);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

export function writeAmbiguousPidPreload(dir) {
  const preload = join(dir, "ambiguous-pid.mjs");
  writeFileSync(preload, `const original = process.kill;
process.kill = (pid, signal) => {
  if (pid === 987654321 && signal === 0) {
    const error = new Error("simulated EPERM PID check");
    error.code = "EPERM";
    throw error;
  }
  return original(pid, signal);
};
`, "utf8");
  return preload;
}

export function writeOwnerIdentityPreload(dir, identity) {
  const preload = join(dir, "owner-identity.mjs");
  const targetPid = process.pid;
  const statFields = ["S", ...Array(18).fill("0"), identity].join(" ");
  const statPath = `/proc/${targetPid}/stat`;
  const statLine = `${targetPid} (node) ${statFields}\n`;
  writeFileSync(preload, `import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const targetPid = ${targetPid};
const identity = ${JSON.stringify(identity)};
const statPath = ${JSON.stringify(statPath)};
const originalRead = fs.readFileSync;
const originalSpawn = childProcess.spawnSync;
fs.readFileSync = (path, ...args) => {
  if (String(path).replaceAll(String.fromCharCode(92), "/") === statPath) return ${JSON.stringify(statLine)};
  return originalRead(path, ...args);
};
childProcess.spawnSync = (command, args, options) => {
  if (String(command).toLowerCase() === "powershell.exe") return { status: 0, stdout: identity, stderr: "", error: undefined };
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

export function writePublishFailurePreload(dir, failRestore = false) {
  const preload = join(dir, "publish-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  const source = String(from);
  const destination = String(to);
  if (source.includes(".cc-exe-publish-") && destination.endsWith("Command Center.exe")) {
    const error = new Error("simulated EPERM on publish rename"); error.code = "EPERM"; throw error;
  }
  if (${failRestore} && source.includes(".cc-exe-displaced-") && destination.endsWith("Command Center.exe")) {
    const error = new Error("simulated EPERM on rollback restore"); error.code = "EPERM"; throw error;
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

export function writeSiblingRenameFailurePreload(dir, prefix, target, rollbackPrefix = null) {
  const preload = join(dir, "sibling-rename-failure.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  if ((String(from).includes(${JSON.stringify(prefix)}) || (${JSON.stringify(rollbackPrefix)} && String(from).includes(${JSON.stringify(rollbackPrefix)}))) && String(to).endsWith(${JSON.stringify(target)})) {
    const error = new Error("simulated sibling rename failure"); error.code = "EPERM"; throw error;
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

// The moment this run moves the stale lock aside, another run has already replaced it with its own live lock.
export function writeLockReplacedPreload(dir) {
  const preload = join(dir, "lock-replaced.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).includes(".dist-build.lock.stale-")) {
    fs.unlinkSync(from);
    fs.writeFileSync(from, JSON.stringify({ pid: 1, token: "other-run", startedAt: Date.now() }));
  }
  return original(from, to);
};
syncBuiltinESMExports();
`, "utf8");
  return preload;
}

// A read-only or locked old fingerprint: it can be neither replaced nor displaced nor deleted.
export function writeLockedSidecarPreload(dir) {
  const preload = join(dir, "locked-sidecar.mjs");
  writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const locked = (path) => String(path).endsWith("Command Center.exe.sha256");
const fail = () => { const error = new Error("simulated locked sidecar"); error.code = "EPERM"; throw error; };
const rename = fs.renameSync, unlink = fs.unlinkSync;
fs.renameSync = (from, to) => (locked(from) || locked(to) ? fail() : rename(from, to));
fs.unlinkSync = (path) => (locked(path) ? fail() : unlink(path));
syncBuiltinESMExports();
`, "utf8");
  return preload;
}
