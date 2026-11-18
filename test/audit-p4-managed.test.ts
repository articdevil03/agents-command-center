import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import mutableFs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createCliCredentialStore } from "../electron/cli-credentials.js";
import { createCandidate, managedCli, managedRoot, publishCandidate, removeCandidate } from "../server/settings/opencode/paths.ts";
import { installManagedRelease } from "../server/settings/opencode/install.ts";
import { removeManagedInstall } from "../server/settings/opencode/remove.ts";
import { sweepCopilotInstalls } from "../server/settings/opencode/sweep.ts";
import { zipBytes } from "./pack29-opencode-install.setup.ts";

function fixture() {
  const scratch = fs.mkdtempSync(join(tmpdir(), "cc-p4-managed-"));
  const target = join(scratch, "target"), alias = join(scratch, "alias"), outside = join(scratch, "outside");
  fs.mkdirSync(target); fs.mkdirSync(outside);
  const sentinel = join(outside, "SENTINEL"); fs.writeFileSync(sentinel, "keep external bytes");
  const links: string[] = [];
  function link(path: string, destination = outside) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.symlinkSync(destination, path, "junction"); links.push(path);
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
  }
  link(alias, target);
  const base = join(alias, "local"); fs.mkdirSync(base);
  function clear(path: string) {
    assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
    for (const name of fs.readdirSync(path)) {
      const child = join(path, name), info = fs.lstatSync(child);
      assert.equal(info.isSymbolicLink(), false, child);
      if (info.isDirectory()) clear(child); else fs.unlinkSync(child);
    }
    assert.deepEqual(fs.readdirSync(path), []); fs.rmdirSync(path);
  }
  return { scratch, target, alias, outside, sentinel, base, link,
    close() {
      for (const path of links.reverse()) {
        try { if (fs.lstatSync(path).isSymbolicLink()) fs.rmdirSync(path); }
        catch (error: any) { if (error.code !== "ENOENT") throw error; }
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep external bytes");
      }
      assert.equal(fs.readFileSync(sentinel, "utf8"), "keep external bytes"); clear(scratch);
    },
  };
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text).map((byte) => byte ^ 0xa5),
  decryptString: (bytes: Buffer) => bytes.map((byte) => byte ^ 0xa5).toString(),
};

for (const tool of ["opencode", "copilot"] as const) test(`${tool}: real linked ancestor supports install, detect, activate, rollback and removal`, async () => {
  const f = fixture();
  try {
    const env = { LOCALAPPDATA: f.base }, version = "1.0.112", name = `${tool}.exe`;
    const bytes = zipBytes([{ name }]), asset = tool === "copilot" ? "copilot-win32-x64.zip" : "opencode-windows-x64-baseline.zip";
    const owner = tool === "copilot" ? "github/copilot-cli" : "anomalyco/opencode";
    const row = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: asset, size: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      browser_download_url: `https://github.com/${owner}/releases/download/v${version}/${asset}` }] };
    const transport = async (url: string) => url.includes("api.github.com") ? Response.json([row]) : new Response(bytes);
    let probes = 0;
    const run = async () => { probes++; return { code: 0, stdout: tool === "copilot" ? `GitHub Copilot CLI ${version}.` : version, stderr: "", cleanupConfirmed: true }; };
    const install = () => installManagedRelease(run, env, new AbortController().signal, Date.now() + 5000, { transport, arch: "x64" }, tool);
    const first = await install();
    assert.equal(first.result.code, 0, "linked profile must install without a vendor process or download");
    await first.commit!(); assert.equal(managedCli(env, tool), first.candidate);
    const second = await install(); assert.equal(second.result.code, 0);
    await second.commit!(); assert.equal(managedCli(env, tool), second.candidate);
    await second.rollback!(); assert.equal(managedCli(env, tool), first.candidate);
    assert.equal(fs.existsSync(dirname(second.candidate!)), false);
    if (tool === "copilot") {
      const orphan = join(managedRoot(env, tool)!, "install-dead"); fs.mkdirSync(orphan);
      fs.writeFileSync(join(orphan, "old"), "inert"); await sweepCopilotInstalls(env);
      assert.equal(fs.existsSync(orphan), false);
    }
    assert.equal(probes, 2); await removeManagedInstall(env, tool);
    assert.equal(managedCli(env, tool), null);
  } finally { f.close(); }
});

for (const level of ["Command Center", "tools", "tool", "version", "file"] as const) test(`managed ${level} junction remains refused with a linked profile`, async () => {
  const f = fixture();
  try {
    const env = { LOCALAPPDATA: f.base }, root = managedRoot(env)!;
    const path = level === "Command Center" ? dirname(dirname(root)) : level === "tools" ? dirname(root) : level === "tool" ? root : join(root, "install-abcd", ...(level === "file" ? ["opencode.exe"] : []));
    f.link(path);
    if (["Command Center", "tools", "tool"].includes(level)) await assert.rejects(createCandidate(env));
    else {
      fs.writeFileSync(join(root, "active.json"), JSON.stringify({ version: "1.0.112", executable: "install-abcd/opencode.exe" }));
      assert.equal(managedCli(env), null);
      await assert.rejects(publishCandidate(root, join(root, "install-abcd", "opencode.exe"), "1.0.112"));
      await assert.rejects(removeCandidate(join(root, "install-abcd")));
    }
    await assert.rejects(removeManagedInstall(env, "opencode"));
  } finally { f.close(); }
});

test("credentials save, restart, read and remove through a real linked userData ancestor", async () => {
  const f = fixture();
  try {
    const userData = join(f.alias, "userData"); fs.mkdirSync(userData);
    const dir = join(userData, "credentials"), store = createCliCredentialStore({ dir, safeStorage });
    await assert.doesNotReject(store.set("qwen", { key: "synthetic-key" }));
    assert.equal(fs.readFileSync(join(dir, "qwen.cred")).includes(Buffer.from("synthetic-key")), false);
    assert.deepEqual(await createCliCredentialStore({ dir, safeStorage }).get("qwen"), { key: "synthetic-key" });
    const unavailable = createCliCredentialStore({ dir, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    await assert.rejects(unavailable.get("qwen")); await assert.rejects(unavailable.set("qwen", { key: "replacement" }));
    await unavailable.remove("qwen"); assert.equal(await store.get("qwen"), null);
    await store.remove("qwen");
  } finally { f.close(); }
});

for (const file of [false, true]) test(`credentials refuse linked ${file ? "file" : "directory"} through a linked ancestor`, async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials");
    if (file) { fs.mkdirSync(dir); f.link(join(dir, "qwen.cred")); } else f.link(dir);
    const store = createCliCredentialStore({ dir, safeStorage });
    await assert.rejects(store.set("qwen", { key: "synthetic-key" }));
    await assert.rejects(store.get("qwen")); await assert.rejects(store.remove("qwen"));
  } finally { f.close(); }
});

test("pinned credential and managed roots refuse replacement by ordinary directories", async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials"), store = createCliCredentialStore({ dir, safeStorage });
    await assert.doesNotReject(store.set("qwen", { key: "synthetic-key" }));
    fs.renameSync(dir, dir + "-old"); fs.mkdirSync(dir);
    await assert.rejects(store.set("qwen", { key: "replacement" }));
    await assert.rejects(store.get("qwen")); await assert.rejects(store.remove("qwen"));
    const env = { LOCALAPPDATA: f.base }, candidate = await createCandidate(env);
    const exe = join(candidate.dir, "opencode.exe"); fs.writeFileSync(exe, "inert");
    const undo = await publishCandidate(candidate.root, exe, "1.0.112");
    const tools = dirname(candidate.root); fs.renameSync(tools, tools + "-old"); fs.mkdirSync(tools);
    await assert.rejects(createCandidate(env)); await assert.rejects(undo());
    await assert.rejects(removeCandidate(candidate.dir));
  } finally { f.close(); }
});

test("activation refuses an executable in another registered tool root", async () => {
  const f = fixture();
  try {
    const env = { LOCALAPPDATA: f.base };
    let first: Awaited<ReturnType<typeof createCandidate>>, other: typeof first;
    await assert.doesNotReject(async () => { first = await createCandidate(env); other = await createCandidate(env, "copilot"); });
    const exe = join(other.dir, "copilot.exe"); fs.writeFileSync(exe, "inert");
    await assert.rejects(publishCandidate(first.root, exe, "1.0.112"));
    assert.equal(fs.existsSync(join(first.root, "active.json")), false);
  } finally { f.close(); }
});

test("retargeting a trusted profile alias refuses later credential writes and managed cleanup", async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials"), store = createCliCredentialStore({ dir, safeStorage });
    await assert.doesNotReject(store.set("qwen", { key: "synthetic-key" }));
    const candidate = await createCandidate({ LOCALAPPDATA: f.base });
    fs.rmdirSync(f.alias); fs.symlinkSync(f.outside, f.alias, "junction");
    await assert.rejects(store.set("qwen", { key: "replacement" }));
    await assert.rejects(store.get("qwen")); await assert.rejects(store.remove("qwen"));
    await assert.rejects(removeCandidate(candidate.dir));
  } finally { f.close(); }
});

test("credentials retry an unresolved root, then retain a successful pin", async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials"); fs.mkdirSync(dir);
    let fail = true;
    const io = { ...fs, realpathSync(path: any) {
      if (fail) { fail = false; throw Object.assign(new Error("temporary busy root"), { code: "EBUSY" }); }
      return fs.realpathSync(path);
    } };
    const store = createCliCredentialStore({ dir, safeStorage, io });
    await assert.rejects(store.set("qwen", { key: "synthetic" }));
    await assert.doesNotReject(store.set("qwen", { key: "synthetic" }));
    assert.deepEqual(await store.get("qwen"), { key: "synthetic" });
    fs.renameSync(dir, dir + "-old"); fs.mkdirSync(dir);
    await assert.rejects(store.set("qwen", { key: "replacement" }));
    await assert.rejects(store.set("qwen", { key: "replacement" }), "refusal must not clear the successful pin");
  } finally { f.close(); }
});

test("credential file check refuses a link appearing after its component preflight", async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials"); fs.mkdirSync(dir);
    const file = join(dir, "qwen.cred"); fs.writeFileSync(file, "synthetic ciphertext");
    let leafChecks = 0, renamed = false;
    // Model a link arriving after checked(file), at the independent file-type check.
    const io = { ...fs, lstatSync(path: any) {
      const info = fs.lstatSync(path);
      if (String(path) === file && ++leafChecks === 2) return { ...info, isFile: () => true, isSymbolicLink: () => true };
      return info;
    }, renameSync(...args: any[]) { renamed = true; return (fs.renameSync as any)(...args); } };
    await assert.rejects(createCliCredentialStore({ dir, safeStorage, io }).set("qwen", { key: "replacement" }));
    assert.equal(leafChecks, 2, "file type check FOUND after component preflight");
    assert.equal(renamed, false); assert.equal(fs.readFileSync(file, "utf8"), "synthetic ciphertext");
  } finally { f.close(); }
});

for (const changed of ["temporary", "destination"]) test(`credential rename rechecks the ${changed} after flushing`, async () => {
  const f = fixture();
  try {
    const dir = join(f.base, "credentials"); fs.mkdirSync(dir);
    const file = join(dir, "qwen.cred"); fs.writeFileSync(file, "old ciphertext");
    let flushed = false, inspected = false, renamed = false;
    const io = { ...fs, fsyncSync(fd: number) { fs.fsyncSync(fd); flushed = true; }, lstatSync(path: any) {
      const info = fs.lstatSync(path);
      if (flushed && (changed === "temporary" ? String(path).includes(".tmp-") : String(path) === file)) {
        inspected = true; return { ...info, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };
      }
      return info;
    }, renameSync(...args: any[]) { renamed = true; return (fs.renameSync as any)(...args); } };
    await assert.rejects(createCliCredentialStore({ dir, safeStorage, io }).set("qwen", { key: "replacement" }));
    assert.equal(inspected, true, "post-flush guard FOUND"); assert.equal(renamed, false);
    assert.equal(fs.readFileSync(file, "utf8"), "old ciphertext");
  } finally { f.close(); }
});

test("managed cleanup checks a child before unlinking even when async metadata looks ordinary", async (t) => {
  const f = fixture(); let spy: any;
  try {
    const candidate = await createCandidate({ LOCALAPPDATA: f.base });
    const file = join(candidate.dir, "keep"); fs.writeFileSync(file, "preserve");
    const original = mutableFs.lstatSync, canonical = fs.realpathSync(file); let found = 0;
    spy = t.mock.method(mutableFs, "lstatSync", ((path: any, ...args: any[]) => {
      const info = (original as any)(path, ...args);
      if (String(path) === file || String(path) === canonical) { found++; info.isSymbolicLink = () => true; }
      return info;
    }) as any); syncBuiltinESMExports();
    await assert.rejects(removeCandidate(candidate.dir), /[Ll]ink/);
    assert.ok(found > 0, "child check FOUND"); assert.equal(fs.readFileSync(file, "utf8"), "preserve");
  } finally { spy?.mock.restore(); syncBuiltinESMExports(); f.close(); }
});

for (const phase of ["publish", "rollback"]) test(`managed ${phase} rechecks the descriptor after asynchronous IO`, async (t) => {
  const f = fixture(); let spy: any;
  try {
    const candidate = await createCandidate({ LOCALAPPDATA: f.base });
    const executable = join(candidate.dir, "opencode.exe"), active = join(candidate.root, "active.json");
    fs.writeFileSync(executable, "inert"); fs.writeFileSync(active, "old descriptor");
    const undo = phase === "rollback" ? await publishCandidate(candidate.root, executable, "1.0.112") : null;
    const before = fs.readFileSync(active, "utf8"), original = promises.writeFile;
    let found = false;
    spy = t.mock.method(promises, "writeFile", (async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (String(args[0]).endsWith(".tmp")) { found = true; fs.renameSync(active, active + "-old"); f.link(active); }
      return result;
    }) as any); syncBuiltinESMExports();
    if (undo) await assert.rejects(undo(), /[Ll]ink/);
    else await assert.rejects(publishCandidate(candidate.root, executable, "1.0.112"), /[Ll]ink/);
    assert.equal(found, true, "async publication boundary FOUND");
    assert.equal(fs.lstatSync(active).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(active + "-old", "utf8"), before);
  } finally { spy?.mock.restore(); syncBuiltinESMExports(); f.close(); }
});
