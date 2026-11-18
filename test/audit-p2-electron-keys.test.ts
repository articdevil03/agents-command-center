import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createCliCredentialStore, handleCliCredentialMessage } from "../electron/cli-credentials.js";
import { IpcCredentialStore } from "../server/settings/cli-key-store.ts";
import { SettingsService } from "../server/settings/service.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";

const ORIGINAL = Buffer.from("synthetic-encrypted-saved-key");
const KEY = "synthetic-replacement-" + randomUUID();
const connection = catalogProfile(catalogTool("gemini"));
function fixture(saved = true, missingDirectory = false) {
  // Own exactly this file and directory; refuse to clean up anything unexpected.
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "cc-p2-encryption-")));
  const credentialDir = missingDirectory ? join(dir, "missing") : dir;
  const file = join(credentialDir, "gemini.cred");
  if (saved) fs.writeFileSync(file, ORIGINAL);
  let unlinkFailure = "";
  const operations: string[] = [], replies: any[] = [];
  const io = { ...fs, unlinkSync(path: any) {
    if (unlinkFailure && path === file) throw Object.assign(new Error(KEY), { code: unlinkFailure });
    fs.unlinkSync(path);
  } };
  const disk = createCliCredentialStore({ dir: credentialDir, io, safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => assert.fail("Encryption must not run"),
    decryptString: () => assert.fail("Decryption must not run"),
  } });
  class Channel extends EventEmitter {
    connected = true;
    send = (message: any, callback: any) => {
      operations.push(message.operation); callback(null);
      void handleCliCredentialMessage(message, (reply: any) => {
        replies.push(reply); this.emit("message", reply);
      }, disk);
    };
  }
  const channel = new Channel(), store = new IpcCredentialStore(channel, 100);
  const states: any[] = [];
  const service = new SettingsService({ dataRoot: dir, credentialStore: store,
    env: { HOME: dir, USERPROFILE: dir },
    runCli: async () => assert.fail("No vendor calls"),
    onChange: () => states.push(service.snapshot()),
  });
  const ask = (type: string) => service.cliKey({ type, cli: "gemini", requestId: randomUUID(),
    ...(type === "submitCliKey" ? { fields: { key: KEY } } : {}) }, {});
  return { disk, store, service, ask, operations, replies, file, dir,
    failUnlink: (code: string) => { unlinkFailure = code; },
    privateState() {
      const visible = JSON.stringify([replies, states, service.snapshot()]);
      for (const secret of [KEY, ORIGINAL.toString()]) assert.equal(visible.includes(secret), false);
    },
    close() {
      service.cliKeys.close(); service.login.close(); service.installer.close();
      assert.equal(channel.listenerCount("message"), 0);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
      assert.deepEqual(fs.readdirSync(dir), []);
      fs.rmdirSync(dir);
    },
  };
}

test("unavailable encryption with a saved file is unreadable through disk and IPC, never absence", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.disk.get("gemini"), /Could not read credential safely/);
    await assert.rejects(f.store.get("gemini"));
    assert.equal(f.store.available(), true, "the channel still supports recovery");
    assert.deepEqual(f.replies.map(({ id, ...reply }) => reply), [
      { type: "cliCredentialResult", available: false, ok: false },
    ]);
    assert.deepEqual(fs.readFileSync(f.file), ORIGINAL); f.privateState();
  } finally { f.close(); }
});

for (const missingDirectory of [false, true]) test(`unavailable encryption and no saved ${missingDirectory ? "directory" : "file"} confirms absence through IPC and permits launch`, async () => {
  const f = fixture(false, missingDirectory);
  try {
    assert.equal(await f.disk.get("gemini"), null);
    let record: unknown = "not read";
    await assert.doesNotReject(async () => { record = await f.store.get("gemini"); });
    assert.equal(record, null);
    await f.service.cliKeys.prepareConnection(connection);
    assert.equal(f.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    assert.deepEqual(f.service.cliKeys.launch(connection), { env: {}, secrets: [] });
    assert.equal(f.replies.every((reply) => reply.ok && reply.available === false && reply.record === null), true);
    assert.deepEqual(fs.readdirSync(f.dir), []); f.privateState();
  } finally { f.close(); }
});

test("Remove reaches Electron after unavailable encryption and clears published unreadable state only on success", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.cliKeys.prepareConnection(connection));
    assert.equal(f.service.snapshot().catalogTools.gemini.keyUnreadable, true);
    assert.throws(() => f.service.cliKeys.launch(connection), /Replace it or remove it/);
    await f.ask("removeCliKey");
    assert.equal(f.operations.at(-1), "remove");
    assert.equal(f.replies.at(-1).ok, true);
    assert.equal(f.replies.at(-1).available, false);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    assert.equal(f.service.snapshot().catalogTools.gemini.action?.message, "Key removed.");
    assert.deepEqual(f.service.cliKeys.launch(connection), { env: {}, secrets: [] });
    f.privateState();
  } finally { f.close(); }
});

for (const code of ["EBUSY", "EACCES"]) test(`${code}: refused removal retains original bytes and unreadable state, then can retry`, async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.cliKeys.prepareConnection(connection));
    const before = f.service.snapshot();
    f.failUnlink(code);
    await assert.rejects(f.ask("removeCliKey"), { message: "Command Center could not remove the key safely on this PC. Check again." });
    assert.equal(f.operations.at(-1), "remove");
    assert.equal(f.replies.at(-1).ok, false);
    assert.deepEqual(fs.readFileSync(f.file), ORIGINAL);
    assert.deepEqual(f.service.snapshot(), before);
    assert.throws(() => f.service.cliKeys.launch(connection), /Replace it or remove it/);
    f.failUnlink(""); await f.ask("removeCliKey");
    assert.equal(f.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    f.privateState();
  } finally { f.close(); }
});

test("unavailable encryption refuses Replace plainly without changing original bytes or state, while Remove stays usable", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.cliKeys.prepareConnection(connection));
    const before = f.service.snapshot();
    await assert.rejects(f.disk.set("gemini", { key: KEY }));
    await assert.rejects(f.ask("submitCliKey"), { message: "Windows encryption is unavailable. The key was not saved. You can remove the saved key in Settings." });
    assert.deepEqual(fs.readFileSync(f.file), ORIGINAL);
    assert.deepEqual(f.service.snapshot(), before);
    assert.equal(f.operations.includes("set"), false, "known unavailable encryption sends no replacement bytes");
    await f.ask("removeCliKey");
    assert.equal(f.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    f.privateState();
  } finally { f.close(); }
});

test("a first Replace request learns encryption is unavailable from Electron without changing saved bytes or publishing success", async () => {
  const f = fixture();
  try {
    const before = f.service.snapshot();
    await assert.rejects(f.ask("submitCliKey"), { message: "Windows encryption is unavailable. The key was not saved. You can remove the saved key in Settings." });
    assert.deepEqual(f.operations, ["set"]);
    assert.equal(f.replies.at(-1).ok, false);
    assert.equal(f.replies.at(-1).available, false);
    assert.deepEqual(fs.readFileSync(f.file), ORIGINAL);
    assert.deepEqual(f.service.snapshot(), before);
    await f.ask("removeCliKey");
    assert.equal(f.operations.at(-1), "remove");
    assert.equal(fs.existsSync(f.file), false); f.privateState();
  } finally { f.close(); }
});
