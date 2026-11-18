import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createCliCredentialStore, handleCliCredentialMessage } from "../electron/cli-credentials.js";
import { IpcCredentialStore } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir } from "./temp-root.ts";
import { withPage, skipped, editorTestMs, J, click, deliverState } from "./pack18-editor-harness.ts";
import { sentCount, sentSince } from "./pack29-onboarding-page.setup.ts";

const KEY = "synthetic-replacement-" + randomUUID();
const OLD = Buffer.from("synthetic-unreadable-original");
const connection = catalogProfile(catalogTool("gemini"));
async function fixture(failure = "decrypt") {
  const ctx = setup(), root = scratchDir(), dir = join(root, "keys"), file = join(dir, "gemini.cred");
  fs.mkdirSync(dir); fs.writeFileSync(file, OLD);
  let failRemove = false, failReplace = false;
  const io = { ...fs,
    renameSync(from: any, to: any) { if (failReplace) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); fs.renameSync(from, to); },
    unlinkSync(path: any) { if (failRemove && path === file) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); fs.unlinkSync(path); },
    readFileSync(path: any, ...args: any[]) {
      if (failure === "read" && path === file) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return (fs.readFileSync as any)(path, ...args);
    },
  };
  const disk = createCliCredentialStore({ dir, io, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from("encrypted:" + value),
    decryptString: (bytes: Buffer) => {
      if (!bytes.equals(OLD)) return bytes.toString().slice("encrypted:".length);
      if (failure === "schema") return JSON.stringify({ key: KEY, obsolete: "field" });
      if (failure === "json") return "{";
      throw new Error("synthetic private key " + KEY + " " + ["C:", "Users", "PrivateName"].join("\\"));
    },
  } });
  class Channel extends EventEmitter {
    connected = true;
    send = (message: any, callback: any) => {
      callback(null);
      void handleCliCredentialMessage(message, (reply: any) => this.emit("message", reply), disk);
    };
  }
  const states: string[] = [], service = new api.SettingsService({ dataRoot: root, credentialStore: new IpcCredentialStore(new Channel()),
    onChange: () => states.push(JSON.stringify(service.snapshot())), runCli: async () => { assert.fail("No vendor calls"); } });
  api.state.setSettingsService(service);
  Object.assign(service.state.catalogTools.gemini, { installed: true, version: "1.0.0" });
  const socket = [...api.state.clients][0];
  const dispatch = async (message: any) => {
    api.messages.handleMessage(socket, JSON.stringify(message));
    for (let n = 0; n < 200; n++) {
      const reply = ctx.replies.find((r: any) => r.requestId === message.requestId && ["error", "actionResult"].includes(r.type));
      if (reply) return reply;
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.fail("Key action did not finish");
  };
  const ask = (type: string) => dispatch({ type, cli: "gemini", requestId: randomUUID(), ...(type === "submitCliKey" ? { fields: { key: KEY } } : {}) });
  const blocked = () => {
    assert.equal(service.snapshot().catalogTools.gemini.keyUnreadable, true);
    assert.equal(service.snapshot().catalogTools.gemini.keySaved, false);
    assert.throws(() => service.cliKeys.launch(connection), /Replace it or remove it in the tool's key settings in the app/);
  };
  const privateState = () => {
    const visible = JSON.stringify([service.snapshot(), states, ctx.replies]);
    for (const secret of [KEY, OLD.toString(), "PrivateName"]) assert.equal(visible.includes(secret), false, "private bytes escaped");
  };
  return { service, dispatch, ask, blocked, privateState, file, io,
    refuseRemove: () => { failRemove = true; }, refuseReplace: () => { failReplace = true; },
    close: () => { service.cliKeys.close(); service.login.close(); service.installer.close(); } };
}

for (const failure of ["decrypt", "schema", "json", "read"]) test(`${failure}: unreadable saved key is published, blocks launch, and recovers through Settings messages`, async () => {
  const fx = await fixture(failure);
  try {
    await assert.rejects(fx.service.cliKeys.prepareConnection(connection));
    fx.blocked(); fx.privateState();
    assert.deepEqual(fs.readFileSync(fx.file), OLD);
    if (failure === "read") {
      assert.equal((await fx.ask("removeCliKey")).type, "actionResult");
      assert.equal(fs.existsSync(fx.file), false);
    } else {
      assert.equal((await fx.ask("submitCliKey")).type, "actionResult");
      assert.equal(fx.service.cliKeys.launch(connection).secrets[0], KEY);
    }
    assert.equal(fx.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    fx.privateState();
  } finally { fx.close(); }
});

for (const operation of ["remove", "replace"]) test(`failed ${operation} preserves original bytes and unreadable state`, async () => {
  const fx = await fixture();
  try {
    await assert.rejects(fx.service.cliKeys.prepareConnection(connection));
    const before = fx.service.snapshot();
    if (operation === "remove") fx.refuseRemove(); else fx.refuseReplace();
    assert.equal((await fx.ask(operation === "remove" ? "removeCliKey" : "submitCliKey")).type, "error");
    assert.deepEqual(fs.readFileSync(fx.file), OLD);
    assert.deepEqual(fx.service.snapshot(), before);
    fx.blocked(); fx.privateState();
    assert.deepEqual(fs.readdirSync(join(fx.file, "..")), ["gemini.cred"], "failed replacement cleaned only its staged file");
  } finally { fx.close(); }
});

test("confirmed removal clears unreadable state and allows launch without a saved key", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(fx.service.cliKeys.prepareConnection(connection)); fx.blocked();
    assert.equal((await fx.ask("removeCliKey")).type, "actionResult");
    assert.equal(fs.existsSync(fx.file), false);
    assert.equal(fx.service.snapshot().catalogTools.gemini.keyUnreadable, false);
    assert.deepEqual(fx.service.cliKeys.launch(connection), { env: {}, secrets: [] });
    fx.privateState();
  } finally { fx.close(); }
});

test("real key panel Replace and Remove controls recover unreadable keys through the Settings handler", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  const fx = await fixture();
  try {
    await assert.rejects(fx.service.cliKeys.prepareConnection(connection));
    await withPage(async ({ ev, seed }) => {
      const panel = '#s-tools [data-cli-key-slot="gemini"]';
      const publish = () => deliverState(ev, seed, `state.firstRun={required:false};state.settings=${J(fx.service.snapshot())}`);
      await publish(); await ev("openSettings(undefined,'tools');true");
      assert.match(await ev(`document.querySelector(${J(panel + ' .cli-key-status')}).textContent`), /saved key.*cannot be read.*Replace it or remove it/);
      for (const action of ["replace", "remove"]) assert.equal(await ev(`document.querySelector(${J(panel + ` [data-key-act="${action}"]`)}).hidden`), false);
      const send = async (act: string) => {
        const mark = await sentCount(ev); await click(ev, panel + ` [data-key-act="${act}"]`);
        const [message] = await sentSince(ev, act === "remove" ? "removeCliKey" : "submitCliKey", mark);
        assert.ok(message, "the real page sent a recovery request");
        const reply = await fx.dispatch(message);
        await publish(); await ev(`window.__ccDeliver(${J(reply)});true`);
        return reply;
      };
      fx.refuseRemove();
      assert.equal((await send("remove")).type, "error"); fx.blocked();
      assert.deepEqual(fs.readFileSync(fx.file), OLD);
      assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="remove"]')}).hidden`), false);
      await click(ev, panel + ' [data-key-act="replace"]');
      await ev(`document.querySelector(${J(panel + ' [data-key-field="key"]')}).value=${J(KEY)};true`);
      assert.equal((await send("save")).type, "actionResult");
      assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-field="key"]')}).value`), "");
      assert.equal(fx.service.snapshot().catalogTools.gemini.keyUnreadable, false);
      assert.equal(await ev(`JSON.stringify(serverState).includes(${J(KEY)})`), false);
      fx.privateState();
    }, { fixture: "fixed" });
  } finally { fx.close(); }
});

test("real key panel confirms removal of an unreadable key", { timeout: editorTestMs(120_000) }, async (t) => {
  if (skipped(t)) return;
  const fx = await fixture();
  try {
    await assert.rejects(fx.service.cliKeys.prepareConnection(connection));
    await withPage(async ({ ev, seed }) => {
      const panel = '#s-tools [data-cli-key-slot="gemini"]';
      const publish = () => deliverState(ev, seed, `state.firstRun={required:false};state.settings=${J(fx.service.snapshot())}`);
      await publish(); await ev("openSettings(undefined,'tools');true");
      const mark = await sentCount(ev);
      await click(ev, panel + ' [data-key-act="remove"]');
      const [message] = await sentSince(ev, "removeCliKey", mark);
      assert.ok(message, "unreadable key removal request was sent");
      const reply = await fx.dispatch(message);
      assert.equal(reply.type, "actionResult");
      await publish(); await ev(`window.__ccDeliver(${J(reply)});true`);
      assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="add"]')}).hidden`), false);
      assert.equal(await ev(`document.querySelector(${J(panel + ' [data-key-act="remove"]')}).hidden`), true);
      assert.doesNotMatch(await ev(`document.querySelector(${J(panel + ' .cli-key-status')}).textContent`), /cannot be read/);
      assert.equal(fs.existsSync(fx.file), false);
      assert.deepEqual(fx.service.cliKeys.launch(connection), { env: {}, secrets: [] });
      fx.privateState();
    }, { fixture: "fixed" });
  } finally { fx.close(); }
});
