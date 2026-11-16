import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SettingsService } from "../server/settings/service.ts";
import { IpcCredentialStore, MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { scratchDir } from "./temp-root.ts";

const KEY = "ccTEST-KEY-" + randomUUID();
const gemini = catalogProfile(catalogTool("gemini"));
function serviceFor(store: any) {
  const root = scratchDir();
  return new SettingsService({ dataRoot: root, env: { HOME: root, USERPROFILE: root, CC_TEST_FAKE_CLI: "1" }, credentialStore: store, refreshPath: async () => {},
    runCli: async () => ({ code: 127, stdout: "", stderr: "", cleanupConfirmed: true }) });
}
function closeAll(service: SettingsService) { service.cliKeys.close(); service.login.close(); service.installer.close(); }

test("refresh does not wait on a key read that never answers; the tool stays unread, not 'no key', and the launch path still guards it", async () => {
  const store = new MemoryCredentialStore(); await store.set("gemini", { key: KEY }); await store.set("grok", { key: KEY });
  const get = store.get.bind(store); let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let hungReads = 0;
  store.get = async (tool) => { if (tool === "gemini") { hungReads++; await gate; } return get(tool); };
  const service = serviceFor(store);
  try {
    const started = Date.now();
    let limit: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([service.refreshAll(null).then(() => "done"), new Promise((r) => { limit = setTimeout(() => r("waited"), 2500); })]);
    clearTimeout(limit);
    const took = Date.now() - started;
    assert.ok(hungReads >= 1, "the slow read was FOUND and started");
    assert.equal(outcome, "done", `refreshAll was still waiting on the key store after ${took} ms`);
    assert.equal(service.state.catalogTools.gemini.keySaved, false, "unread is not published as saved");
    assert.throws(() => service.cliKeys.launch(gemini), /already running|not ready/, "an unread key is refused, never launched as 'no key'");
    release();
    await service.cliKeys.prepareConnection(gemini);
    assert.equal(service.state.catalogTools.gemini.keySaved, true, "the finished read publishes");
    assert.deepEqual(service.cliKeys.launch(gemini).secrets, [KEY]);
  } finally { release(); closeAll(service); }
});

test("with a normal store refresh still returns with keySaved filled in", async () => {
  const store = new MemoryCredentialStore(); await store.set("grok", { key: KEY });
  const service = serviceFor(store);
  try {
    await service.refreshAll(null);
    assert.equal(service.state.catalogTools.grok.keySaved, true);
    assert.equal(service.state.catalogTools.gemini.keySaved, false);
  } finally { closeAll(service); }
});

test("fake-CLI mode: the real parent channel holds no keys and no request is sent", async () => {
  const had = Object.getOwnPropertyDescriptor(process, "send"), hadConnected = Object.getOwnPropertyDescriptor(process, "connected");
  const oldMode = process.env.CC_TEST_FAKE_CLI; let sent = 0;
  Object.defineProperty(process, "send", { value: () => { sent++; return true; }, configurable: true, writable: true });
  Object.defineProperty(process, "connected", { value: true, configurable: true, writable: true });
  try {
    delete process.env.CC_TEST_FAKE_CLI;
    assert.equal(new IpcCredentialStore().available(), true, "control: a connected process channel is available outside fake mode");
    process.env.CC_TEST_FAKE_CLI = "1";
    assert.equal(new IpcCredentialStore().available(), false);
    const channel = { connected: true, send: () => { sent++; return true; }, on() {}, off() {} };
    assert.equal(new IpcCredentialStore(channel).available(), true, "an injected channel is still used");
    const service = new SettingsService({ dataRoot: scratchDir(), env: { CC_TEST_FAKE_CLI: "1" }, refreshPath: async () => {}, runCli: async () => ({ code: 127, stdout: "", stderr: "", cleanupConfirmed: true }) });
    try {
      const started = Date.now();
      await service.refreshAll(null);
      assert.ok(Date.now() - started < 2500);
      assert.deepEqual(service.cliKeys.launch(gemini), { env: {}, secrets: [] });
      assert.equal(sent, 0, "no credential request was sent to the parent");
    } finally { closeAll(service); }
  } finally {
    if (oldMode === undefined) delete process.env.CC_TEST_FAKE_CLI; else process.env.CC_TEST_FAKE_CLI = oldMode;
    if (had) Object.defineProperty(process, "send", had); else delete (process as any).send;
    if (hadConnected) Object.defineProperty(process, "connected", hadConnected); else delete (process as any).connected;
  }
});
