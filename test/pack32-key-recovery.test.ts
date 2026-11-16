import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { SettingsService } from "../server/settings/service.ts";
import { IpcCredentialStore, MemoryCredentialStore, UNSAFE_KEY_REMOVAL, UNSAFE_KEY_STORE } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { keyProfile, validateKeyRecord } from "../server/settings/cli-key-profiles.ts";
import { leaderChildEnv } from "../server/leader-common/cli-path.ts";
import { scratchDir } from "./temp-root.ts";

const KEY = "ccTEST-KEY-" + randomUUID();
const connection = catalogProfile(catalogTool("gemini"));
const serviceFor = (store: any) => new SettingsService({ dataRoot: scratchDir(), credentialStore: store });

test("first read hiccup retries once, absence permits launch, two failed reads refuse a possibly saved key", async () => {
  for (const saved of [false, true]) {
    const store = new MemoryCredentialStore();
    if (saved) await store.set("gemini", { key: KEY });
    const get = store.get.bind(store); let attempts = 0;
    store.get = async (tool) => { if (++attempts === 1) throw new Error("synthetic timeout"); return get(tool); };
    const service = serviceFor(store);
    try {
      await assert.doesNotReject(service.cliKeys.prepareConnection(connection));
      assert.equal(attempts, 2);
      assert.deepEqual(service.cliKeys.launch(connection).secrets, saved ? [KEY] : []);
    } finally { service.cliKeys.close(); }
  }
  const store = new MemoryCredentialStore(); await store.set("gemini", { key: KEY });
  let attempts = 0; store.get = async () => { attempts++; throw new Error("synthetic timeout"); };
  const service = serviceFor(store);
  try {
    await assert.rejects(service.cliKeys.prepareConnection(connection), /could not read/);
    assert.equal(attempts, 2);
    assert.throws(() => service.cliKeys.launch(connection), /not ready/);
  } finally { service.cliKeys.close(); }
});

test("client Run prepares the selected catalog connection before launchWorker and reports preparation failure", async () => {
  const source = readFileSync("server/main/messages/setups-runs.ts", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  const calls: string[] = [], errors: string[] = [], replies: any[] = [];
  let fail = false;
  const api = runInNewContext(stripTypeScriptTypes(source) + "\n({setupMessages})", {
    tabLocation: () => ({ tab: {} }), isFixedTab: () => false, crewDefinition: () => ({ cli: "acp:gemini" }),
    refuseIfFolderBusy: () => false, acpClis: [connection], acpKindOf: () => "acp:gemini",
    settingsService: { cliKeys: { async prepareConnection(cli: any) { assert.equal(cli, connection); calls.push("prepare"); if (fail) throw new Error("read failed"); } } },
    launchWorker: () => { calls.push("launch"); return { ok: true, runId: "synthetic" }; },
    describeError: (e: Error) => e.message, sendError: (_ws: any, text: string) => errors.push(text), chatRequestErrorDetails: () => ({}),
  });
  const handler = api.setupMessages().find(([name]: any) => name === "run")[1];
  handler({ send: (raw: string) => replies.push(JSON.parse(raw)) }, { tabId: "synthetic", slot: "coder", prompt: "synthetic" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["prepare", "launch"]); assert.equal(replies[0].type, "runAccepted");
  calls.length = 0; fail = true;
  handler({}, { tabId: "synthetic", slot: "coder", prompt: "synthetic" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["prepare"]); assert.deepEqual(errors, ["read failed"]);
});

for (const operation of ["set", "remove"]) test(`timed-out ${operation} invalidates cached key and re-reads the late completed store change`, async () => {
  let record: any = { key: KEY }, slow = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  class Channel extends EventEmitter {
    connected = true;
    send = (m: any, cb: any) => {
      cb(null);
      const finish = () => {
        if (m.operation === "set") record = { ...m.record };
        if (m.operation === "remove") record = null;
        this.emit("message", { type: "cliCredentialResult", id: m.id, available: true, ok: true, record });
      };
      if (slow && m.operation !== "get") timers.push(setTimeout(finish, 45)); else queueMicrotask(finish);
    };
  }
  const store = new IpcCredentialStore(new Channel(), 10), service = serviceFor(store);
  try {
    await service.cliKeys.prepareConnection(connection);
    assert.deepEqual(service.cliKeys.launch(connection).secrets, [KEY]); slow = true;
    await assert.rejects(service.cliKey({ type: operation === "set" ? "submitCliKey" : "removeCliKey", cli: "gemini", requestId: randomUUID(), ...(operation === "set" ? { fields: { key: KEY + "new" } } : {}) }, {}), { message: "Could not confirm the change. Check again." });
    assert.throws(() => service.cliKeys.launch(connection), /not ready/);
    await new Promise((r) => setTimeout(r, 60));
    await service.cliKeys.prepareConnection(connection);
    assert.deepEqual(service.cliKeys.launch(connection).secrets, operation === "set" ? [KEY + "new"] : []);
    assert.equal(service.state.catalogTools.gemini.keySaved, operation === "set");
  } finally { timers.forEach(clearTimeout); service.cliKeys.close(); }
});

test("secret minimum is eight UTF-8 bytes, not eight characters", () => {
  for (const key of ["a", "1234567", "   1234567   ", "\u00e9".repeat(3)]) assert.throws(() => validateKeyRecord("gemini", { key }), /8 and 4096 bytes/);
  for (const key of ["12345678", "\u00e9".repeat(4)]) assert.equal(validateKeyRecord("gemini", { key }).key, key);
});

test("mixed-case inherited Gemini variable is replaced rather than duplicated", () => {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === "gemini_api_key") delete process.env[key];
    process.env.Gemini_Api_Key = "synthetic inherited";
    const child = leaderChildEnv({ GEMINI_API_KEY: KEY });
    assert.deepEqual(Object.keys(child).filter((key) => key.toLowerCase() === "gemini_api_key"), ["GEMINI_API_KEY"]);
    assert.equal(child.GEMINI_API_KEY, KEY);
  } finally { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); }
});

test("a PC where encryption is unavailable launches a tool with no key, without a read error", async () => {
  class Channel extends EventEmitter {
    connected = true;
    send = (m: any, cb: any) => { cb(null); queueMicrotask(() => this.emit("message", { type: "cliCredentialResult", id: m.id, available: false, ok: false })); };
  }
  const service = serviceFor(new IpcCredentialStore(new Channel(), 50));
  try {
    await assert.doesNotReject(service.cliKeys.prepareConnection(connection));
    assert.deepEqual(service.cliKeys.launch(connection), { env: {}, secrets: [] });
  } finally { service.cliKeys.close(); }
});

test("a failed removal says so in its own words, and a failed save keeps the save text", async () => {
  const store = new MemoryCredentialStore(), service = serviceFor(store), ask = (type: string, fields?: any) => service.cliKey({ type, cli: "gemini", requestId: randomUUID(), ...(fields ? { fields } : {}) }, {});
  try {
    await ask("submitCliKey", { key: KEY });
    store.remove = async () => { throw new Error("synthetic"); };
    await assert.rejects(ask("removeCliKey"), { message: UNSAFE_KEY_REMOVAL });
    assert.equal(UNSAFE_KEY_REMOVAL, "Command Center could not remove the key safely on this PC. Check again.");
    store.set = async () => { throw new Error("synthetic"); };
    await assert.rejects(ask("submitCliKey", { key: KEY + "new" }), { message: UNSAFE_KEY_STORE });
    store.enabled = false;
    await assert.rejects(ask("removeCliKey"), { message: UNSAFE_KEY_REMOVAL });
  } finally { service.cliKeys.close(); }
});

test("a pasted trailing space in the model name is trimmed, and the Kimi model field shows the documented example", () => {
  assert.doesNotThrow(() => validateKeyRecord("kimi", { key: KEY, model: "  kimi-for-coding " }));
  assert.equal(validateKeyRecord("kimi", { key: KEY, model: "  kimi-for-coding " }).model, "kimi-for-coding");
  assert.throws(() => validateKeyRecord("kimi", { key: KEY, model: "kimi for coding" }), /Invalid model name/);
  assert.equal(keyProfile("kimi")!.fields.find((field) => field.id === "model")!.placeholder, "kimi-for-coding");
});
