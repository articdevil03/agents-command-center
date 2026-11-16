import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { createCliCredentialStore, handleCliCredentialMessage } from "../electron/cli-credentials.js";
import { validateLoginUrl } from "../server/settings/cli-login-policy.js";

const KEY = "ccTEST-KEY-" + randomUUID();
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "cc-key-store-"));
  const key = randomBytes(32); let enabled = true;
  const safeStorage = {
    isEncryptionAvailable: () => enabled,
    encryptString(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes: Buffer) { const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"); },
  };
  const store = createCliCredentialStore({ safeStorage, dir });
  const call = async (operation: string, extra = {}) => {
    let result: any;
    await handleCliCredentialMessage({ type: "cliCredentialRequest", id: "test", operation, tool: "qwen", ...extra }, (reply: any) => { result = reply; }, store);
    return result;
  };
  return { dir, safeStorage, store, call, enable: (value: boolean) => { enabled = value; }, close() { for (const file of fs.readdirSync(dir)) fs.unlinkSync(join(dir, file)); fs.rmdirSync(dir); } };
}

test("encrypted round trip, restart, unavailable writes nothing, remove and plaintext scan", async () => {
  const f = fixture();
  try {
    f.enable(false);
    assert.equal((await f.call("set", { record: { key: KEY } })).ok, false);
    await assert.rejects(f.store.set("qwen", { key: KEY }));
    assert.deepEqual(fs.readdirSync(f.dir), []);
    const absent = join(f.dir, "absent");
    await assert.rejects(createCliCredentialStore({ safeStorage: f.safeStorage, dir: absent }).set("qwen", { key: KEY }));
    assert.equal(fs.existsSync(absent), false);
    f.enable(true);
    assert.equal((await f.call("set", { record: { key: KEY } })).ok, true);
    const restarted = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir });
    assert.deepEqual(await restarted.get("qwen"), { key: KEY });
    for (const name of fs.readdirSync(f.dir)) {
      const bytes = fs.readFileSync(join(f.dir, name));
      for (const value of [KEY, JSON.stringify(KEY).slice(1, -1), Buffer.from(KEY).toString("base64")]) assert.equal(bytes.includes(Buffer.from(value)), false);
    }
    assert.deepEqual((await f.call("get")).record, { key: KEY });
    assert.equal((await f.call("remove")).ok, true);
    assert.equal((await f.call("remove")).ok, true);
    assert.equal((await f.call("get")).record, null);
  } finally { f.close(); }
});

test("atomic failures preserve prior bytes and remove only the temporary file", async () => {
  const f = fixture();
  try {
    await f.store.set("qwen", { key: KEY });
    const original = fs.readFileSync(join(f.dir, "qwen.cred"));
    for (const failure of ["renameSync", "writeFileSync", "fsyncSync", "closeSync"]) {
      let failed = false;
      const io = { ...fs, [failure]: (...args: any[]) => { if (!failed) { failed = true; throw new Error(KEY); } return (fs as any)[failure](...args); } };
      const store = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io });
      await assert.rejects(store.set("qwen", { key: KEY + "replacement" }), (error: Error) => !error.message.includes(KEY));
      assert.deepEqual(fs.readFileSync(join(f.dir, "qwen.cred")), original, failure);
      assert.deepEqual(await f.store.get("qwen"), { key: KEY });
      assert.deepEqual(fs.readdirSync(f.dir), ["qwen.cred"]);
    }
  } finally { f.close(); }
});

test("corruption, wrong-key ciphertext, unreadable, oversized and link directories fail closed with ok:false, never as no key", async () => {
  const f = fixture();
  try {
    await f.store.set("qwen", { key: KEY });
    const wrong = fixture();
    try { await assert.rejects(createCliCredentialStore({ safeStorage: wrong.safeStorage, dir: f.dir }).get("qwen")); } finally { wrong.close(); }
    fs.writeFileSync(join(f.dir, "qwen.cred"), "tampered"); await assert.rejects(f.store.get("qwen"));
    assert.deepEqual(await f.call("get"), { type: "cliCredentialResult", id: "test", available: true, ok: false });
    fs.writeFileSync(join(f.dir, "qwen.cred"), Buffer.alloc(65537)); await assert.rejects(f.store.get("qwen"));
    const io = { ...fs, lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => true }) };
    const linked = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io });
    await assert.rejects(linked.set("qwen", { key: KEY })); await assert.rejects(linked.get("qwen"));
    const unreadable = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io: { ...fs, readFileSync: () => { throw new Error(KEY); } } });
    await assert.rejects(unreadable.get("qwen"), (error: Error) => !error.message.includes(KEY));
  } finally { f.close(); }
});

test("a transient read error on a saved key replies ok:false; only a missing file or directory replies ok:true with no record", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.call("get"), { type: "cliCredentialResult", id: "test", available: true, ok: true, record: null }, "missing file");
    await f.store.set("qwen", { key: KEY });
    const busy = Object.assign(new Error(KEY), { code: "EBUSY" });
    const locked = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io: { ...fs, readFileSync: () => { throw busy; } } });
    let reply: any;
    await handleCliCredentialMessage({ type: "cliCredentialRequest", id: "test", operation: "get", tool: "qwen" }, (r: any) => { reply = r; }, locked);
    assert.deepEqual(reply, { type: "cliCredentialResult", id: "test", available: true, ok: false });
    assert.equal(JSON.stringify(reply).includes(KEY), false);
    const absent = createCliCredentialStore({ safeStorage: f.safeStorage, dir: join(f.dir, "absent") });
    await handleCliCredentialMessage({ type: "cliCredentialRequest", id: "test", operation: "get", tool: "qwen" }, (r: any) => { reply = r; }, absent);
    assert.equal(reply.ok, true); assert.equal(reply.record, null, "missing directory");
  } finally { f.close(); }
});

test("strict message and tool validation, size bounds, no logs or thrown secret values", async () => {
  const f = fixture(), logs: string[] = [], originals = new Map<string, any>();
  for (const name of Object.getOwnPropertyNames(console)) if (typeof (console as any)[name] === "function") {
    originals.set(name, (console as any)[name]); (console as any)[name] = (...args: any[]) => logs.push(JSON.stringify(args));
  }
  try {
    const base = { type: "cliCredentialRequest", id: "test", tool: "qwen", operation: "set", record: { key: KEY } };
    const invalid = [
      ...["../escape", "Qwen", "a/b", "a\\b", "a".repeat(33), "a--b", "", null, "__proto__"].map((tool) => ({ ...base, tool })),
      ...[null, 5, "a".repeat(65)].map((id) => ({ ...base, id })),
      { ...base, extra: true }, { ...base, operation: "unknown" }, { ...base, operation: "get" },
      ...[null, [], { key: 12 }, { key: "x".repeat(16384) }, {}].map((record) => ({ ...base, record })),
    ];
    for (const message of invalid) { let reply: any; await handleCliCredentialMessage(message, (r: any) => { reply = r; }, f.store); assert.equal(reply.ok, false); }
    assert.deepEqual(fs.readdirSync(f.dir), []);
    // Keep even a deliberately broken path validator inside this test's owned directory.
    for (const tool of ["Qwen", "a--b", "a".repeat(33)]) await assert.rejects(f.store.set(tool, { key: KEY }));
    assert.equal((await f.call("set", { record: { key: KEY } })).ok, true);
    assert.equal(logs.join(" ").includes(KEY), false);
  } finally { for (const [name, original] of originals) (console as any)[name] = original; f.close(); }
});

test("actual server child listener replies through its own IPC channel with fake encryption", async () => {
  const f = fixture(), replies: any[] = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true, send: (value: any, cb: any) => { replies.push(value); cb(); } });
  const source = fs.readFileSync("electron/server-process.js", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const api = runInNewContext(source + "\n({startServer})", {
    createCliCredentialStore: () => f.store, handleCliCredentialMessage, safeStorage: f.safeStorage, validateLoginUrl,
    app: { isPackaged: false, getPath: () => f.dir }, randomBytes, root: ".", smokeReadyFile: null, join,
    process: { env: {} }, serverNodeRuntime: () => ({ command: "fake", args: [], env: {} }), spawn: () => child, setTimeout, clearTimeout,
    createServer: () => ({ on() {}, listen(_p: any, _h: any, ready: any) { ready(); }, address: () => ({ port: 51234 }), close(done: any) { done(); } }),
  });
  try {
    const ready = api.startServer(); await Promise.resolve(); await Promise.resolve();
    child.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n")); await ready;
    for (const message of [{ type: "cliCredentialRequest", id: "same-id", operation: "set", tool: "qwen", record: { key: KEY } }, { type: "cliCredentialRequest", id: "bad-id", operation: "wat", tool: "qwen" }]) {
      child.emit("message", message); for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(replies.at(-1).id, message.id); assert.equal(replies.at(-1).ok, message.id === "same-id");
      assert.equal(JSON.stringify(replies).includes(KEY), false);
    }
  } finally { child.emit("exit", 0); f.close(); }
});

test("parent-link directory refusal covers existing and not-yet-created directories", async () => {
  const f = fixture(), missing = join(f.dir, "missing");
  try {
    const io = { ...fs, realpathSync: () => join(f.dir, "redirected") };
    const existing = createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io });
    await assert.rejects(existing.set("qwen", { key: KEY }));
    await assert.rejects(existing.get("qwen"));
    await assert.rejects(createCliCredentialStore({ safeStorage: f.safeStorage, dir: missing, io }).set("qwen", { key: KEY }));
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readdirSync(f.dir), []);
  } finally {
    if (fs.existsSync(missing)) {
      assert.equal(fs.lstatSync(missing).isSymbolicLink(), false);
      assert.deepEqual(fs.readdirSync(missing), []);
      fs.rmdirSync(missing);
    }
    f.close();
  }
});

test("set sweeps only that tool's stale temporary regular files before writing", async () => {
  const f = fixture();
  try {
    for (const name of ["qwen.cred.tmp-old", "qwen.cred.tmp-other", "gemini.cred.tmp-old", "qwen.cred.unrelated"]) fs.writeFileSync(join(f.dir, name), "synthetic ciphertext");
    let presentAtOpen: boolean[] = [];
    const io = { ...fs, openSync: (...args: any[]) => {
      presentAtOpen = ["qwen.cred.tmp-old", "qwen.cred.tmp-other"].map((name) => fs.existsSync(join(f.dir, name)));
      return (fs.openSync as any)(...args);
    } };
    await createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io }).set("qwen", { key: KEY });
    assert.deepEqual(presentAtOpen, [false, false], "stale files removed BEFORE open");
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ["gemini.cred.tmp-old", "qwen.cred", "qwen.cred.unrelated"]);
    assert.deepEqual(await f.store.get("qwen"), { key: KEY });
  } finally { f.close(); }
});

test("a locked stale temporary file does not block the save, and a symbolic-link stale name is skipped, not followed", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.dir, "qwen.cred.tmp-locked"), "synthetic ciphertext");
    const locked = { ...fs, unlinkSync: (path: string, ...rest: any[]) => { if (String(path).endsWith("tmp-locked")) throw Object.assign(new Error("locked"), { code: "EBUSY" }); return (fs.unlinkSync as any)(path, ...rest); } };
    await assert.doesNotReject(createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io: locked }).set("qwen", { key: KEY }));
    assert.deepEqual(await f.store.get("qwen"), { key: KEY });
    assert.equal(fs.existsSync(join(f.dir, "qwen.cred.tmp-locked")), true, "the locked file was really attempted and left");
    fs.unlinkSync(join(f.dir, "qwen.cred.tmp-locked"));

    // A link needs a privilege on some Windows setups, so the file system reports one at its boundary.
    const linkName = join(f.dir, "qwen.cred.tmp-link"); fs.writeFileSync(linkName, "stands in for a link");
    const unlinked: string[] = [], statted: string[] = [];
    const watching = {
      ...fs,
      lstatSync: (path: string, ...rest: any[]) => { if (String(path) === linkName) { statted.push(String(path)); return { isFile: () => true, isSymbolicLink: () => true }; } return (fs.lstatSync as any)(path, ...rest); },
      unlinkSync: (path: string, ...rest: any[]) => { unlinked.push(String(path)); return (fs.unlinkSync as any)(path, ...rest); },
    };
    await createCliCredentialStore({ safeStorage: f.safeStorage, dir: f.dir, io: watching }).set("qwen", { key: KEY });
    assert.deepEqual(statted, [linkName], "the link name was FOUND by the sweep");
    assert.equal(unlinked.includes(linkName), false, "a link is never unlinked by the sweep");
    assert.equal(fs.existsSync(linkName), true);
    fs.unlinkSync(linkName);
  } finally { f.close(); }
});
