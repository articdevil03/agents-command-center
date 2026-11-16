import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir } from "./temp-root.ts";
import { MemoryCredentialStore, IpcCredentialStore, UNSAFE_KEY_STORE } from "../server/settings/cli-key-store.ts";
import { CLI_KEY_PROFILES, keyProfile, keyEnvFor } from "../server/settings/cli-key-profiles.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";

export const KEY = 'ccTEST-KEY-' + randomUUID() + '"/+\\';
export const fieldsFor = (tool: string, key = KEY) => Object.fromEntries(CLI_KEY_PROFILES[tool].map((f) => [f.id, f.kind === "secret" ? key : f.kind === "choice" ? f.choices![0].value : tool === "mimo" ? "model-1" : "provider/model-1"]));
const message = (cli = "gemini", fields: any = fieldsFor(cli)) => ({ type: "submitCliKey", requestId: randomUUID(), cli, fields });
function fixture() {
  const store = new MemoryCredentialStore(); let spawns = 0;
  const states: string[] = [];
  const service = new api.SettingsService({ dataRoot: scratchDir(), credentialStore: store, runCli: async () => { spawns++; throw new Error("No vendor calls allowed"); }, onChange: () => states.push(JSON.stringify(service.snapshot())) });
  return { store, service, states, spawns: () => spawns };
}
async function until(fn: () => boolean) {
  for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail("Expected key action result did not arrive");
}
test("real registered WebSocket handlers save, replace, remove without exposing a key or claiming connection", async () => {
  const context = setup(), f = fixture(), other: string[] = [], owner = [...api.state.clients][0];
  api.state.setSettingsService(f.service);
  api.state.clients.add({ readyState: 1, bufferedAmount: 0, send: (raw: string) => other.push(raw) } as any);
  const dispatch = async (m: any) => {
    api.messages.handleMessage(owner, JSON.stringify(m));
    await until(() => context.replies.some((r) => r.requestId === m.requestId && ["error", "actionResult"].includes(r.type)));
    return context.replies.find((r) => r.requestId === m.requestId && ["error", "actionResult"].includes(r.type));
  };
  try {
    for (const tool of Object.keys(CLI_KEY_PROFILES)) {
      assert.equal((await dispatch(message(tool))).type, "actionResult");
      assert.equal(f.service.state.catalogTools[tool].keySaved, true);
      assert.notEqual(f.service.state.catalogTools[tool].signedIn, true);
      assert.equal(f.service.state.catalogTools[tool].connection, "unknown");
      assert.equal(f.service.state.catalogTools[tool].action?.message, "Key saved. Connection checked when you first chat.");
      const connection = catalogProfile(catalogTool(tool));
      assert.deepEqual(f.service.cliKeys.launch(connection).env, keyEnvFor(tool, fieldsFor(tool)));
      Object.assign(f.service.state.catalogTools[tool], { signedIn: true, connection: "verified" });
      const replaced = KEY + "replacement";
      assert.equal((await dispatch(message(tool, fieldsFor(tool, replaced)))).type, "actionResult");
      assert.equal(f.service.state.catalogTools[tool].connection, "unknown");
      assert.equal(f.service.state.catalogTools[tool].signedIn, null, "a saved key leaves sign-in honestly unknown");
      if (tool === "gemini") assert.equal(f.service.state.tools.gemini.signedIn, null, "the legacy Gemini row agrees");
      assert.equal(f.service.cliKeys.launch(connection).secrets[0], replaced);
      assert.equal((await dispatch({ type: "removeCliKey", requestId: randomUUID(), cli: tool })).type, "actionResult");
      assert.equal(f.service.state.catalogTools[tool].keySaved, false);
      assert.deepEqual(f.service.cliKeys.launch(connection), { env: {}, secrets: [] });
      assert.equal(await f.store.get(tool), null);
    }
    const visible = JSON.stringify([context.replies, other, f.states, api.state.requestActions, f.service.snapshot()]);
    for (const value of [KEY, JSON.stringify(KEY).slice(1, -1), encodeURIComponent(KEY), KEY.slice(0, 30)]) assert.equal(visible.includes(value), false);
    assert.equal(f.spawns(), 0);
  } finally { f.service.cliKeys.close(); }
});
test("all invalid fields are refused and consumed before store calls or vendor spawns", async () => {
  const f = fixture();
  try {
    for (const invalid of ["", " ", "x\n", "x\0", "x\u0080", "x\u2028y", "x\u2029y", "x".repeat(4097), "α".repeat(2049), null]) {
      const m = message("gemini", { key: invalid });
      await assert.rejects(f.service.cliKey(m, {})); assert.equal(Object.hasOwn(m, "fields"), false);
    }
    for (const m of [message("gemini", { key: KEY, extra: "bad" }), message("gemini", {}), message("mimo", { key: KEY }), message("minimax", { key: KEY }),
      message("constructor", { key: KEY }), message("qwen", { ...fieldsFor("qwen"), endpoint: "https://evil.invalid/v1" }),
      message("qwen", { ...fieldsFor("qwen"), model: "" }), message("kimi", { key: KEY }), message("kimi", { key: KEY, model: "bad model" }), message("kimi", { key: KEY, model: "model\n" }),
      { ...message(), env: { OPENAI_API_KEY: KEY } }, { ...message(), requestId: "" }]) {
      await assert.rejects(f.service.cliKey(m, {})); assert.equal(Object.hasOwn(m, "fields"), false);
    }
    assert.deepEqual(f.store.calls, []); assert.equal(f.spawns(), 0);
    assert.deepEqual(keyProfile("mimo")!.fields.map((field) => field.id), ["key", "model"]); assert.equal(keyProfile("minimax"), null);
    assert.equal(JSON.stringify(keyProfile("qwen")).includes("OPENAI_API_KEY"), false);
  } finally { f.service.cliKeys.close(); }
});
test("registered WebSocket validation rejects unknown fields and malformed secrets before storage", async () => {
  const context = setup(), f = fixture(), socket = [...api.state.clients][0];
  api.state.setSettingsService(f.service);
  try {
    for (const m of [message("gemini", { key: "" }), message("gemini", { key: "x\n" }), message("gemini", { key: "x".repeat(4097) }),
      message("gemini", { key: KEY, env: KEY }), message("mimo", { key: KEY }), message("qwen", { ...fieldsFor("qwen"), endpoint: "https://evil.invalid" })]) {
      api.messages.handleMessage(socket, JSON.stringify(m));
      await until(() => context.replies.some((r) => r.requestId === m.requestId && r.type === "error"));
    }
    assert.deepEqual(f.store.calls, []); assert.equal(f.spawns(), 0);
    assert.equal(JSON.stringify([context.replies, f.states]).includes(KEY), false);
  } finally { f.service.cliKeys.close(); }
});
test("saved keys stay out of real detection, installer and login-helper boundaries", async () => {
  const root = scratchDir(), calls: any[] = [], logins: any[] = [], store = new MemoryCredentialStore();
  const service = new api.SettingsService({ dataRoot: root, env: { HOME: root, USERPROFILE: root, CC_TEST_FAKE_CLI: "1" }, credentialStore: store,
    refreshPath: async () => {}, runCli: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { code: bin === "grok" ? 0 : 127, stdout: bin === "grok" ? "1.0.0" : "", stderr: "", cleanupConfirmed: true };
    }, runLogin: (options) => { logins.push(options.env); return { done: Promise.resolve({ code: 1, stdout: "", stderr: "", cleanupConfirmed: true }), writable: () => false, submit() {} }; },
  });
  try {
    await service.cliKey(message("grok"), {});
    await service.refreshAll(null);
    await assert.rejects(service.loginCli("grok", "login-fake-key", null));
    await assert.rejects(service.installCli("qwen", "install-fake-key", true));
    assert.ok(calls.some((c) => c.args.includes("--version")), "detection boundary FOUND");
    assert.ok(calls.some((c) => c.bin !== "grok"), "other tools FOUND");
    assert.equal(logins.length, 1, "login-helper boundary FOUND");
    assert.equal(JSON.stringify([calls, logins]).includes(KEY), false);
    assert.equal(service.cliKeys.launch(catalogProfile(catalogTool("grok"))).secrets[0], KEY);
  } finally { service.cliKeys.close(); service.login.close(); service.installer.close(); }
});
test("unavailable storage refuses without changes; interrupted replacement keeps the previous key", async () => {
  const f = fixture(), owner = {};
  try {
    const before = f.service.snapshot(); f.store.enabled = false;
    await assert.rejects(f.service.cliKey(message(), owner), { message: UNSAFE_KEY_STORE });
    assert.deepEqual(f.store.calls, []); assert.deepEqual(f.service.snapshot(), before);
    f.store.enabled = true; await f.service.cliKey(message(), owner);
    f.store.failNextWrite = true;
    await assert.rejects(f.service.cliKey(message("gemini", { key: KEY + "new" }), owner), { message: UNSAFE_KEY_STORE });
    assert.equal(f.service.cliKeys.launch(catalogProfile(catalogTool("gemini"))).secrets[0], KEY);
    assert.equal((await f.store.get("gemini"))?.key, KEY);
    assert.equal(f.spawns(), 0);
  } finally { f.service.cliKeys.close(); }
});
test("one action per tool takes admission synchronously and an owner cannot replay a consumed request", async () => {
  const f = fixture(), owner = {}, m = message();
  let release!: () => void;
  const set = f.store.set.bind(f.store);
  let attempts = 0;
  f.store.set = async (...args) => { if (++attempts === 1) await new Promise<void>((r) => { release = r; }); await set(...args); };
  const first = f.service.cliKey(m, owner);
  try {
    assert.equal(Object.hasOwn(m, "fields"), false);
    await assert.rejects(f.service.cliKey(message(), {}), /already running/);
    release(); await first;
    await assert.rejects(f.service.cliKey({ ...m, fields: fieldsFor("gemini") }, owner), /already used/);
    assert.deepEqual(f.store.calls, ["set:gemini"]);
  } finally { release(); await first; f.service.cliKeys.close(); }
});
test("lazy cache reload validates records, refuses changed Qwen endpoints, and shutdown clears cached secrets", async () => {
  const f = fixture();
  try {
    await f.store.set("qwen", fieldsFor("qwen")); f.store.calls.length = 0;
    const connection = catalogProfile(catalogTool("qwen"));
    await Promise.all([f.service.cliKeys.prepareConnection(connection), f.service.cliKeys.prepareConnection(connection)]);
    assert.deepEqual(f.store.calls, ["get:qwen"]);
    assert.equal(f.service.cliKeys.launch(connection).env.OPENAI_API_KEY, KEY);
    await f.service.cliKeys.prepare("mistral");
    let unrelated;
    assert.doesNotThrow(() => { unrelated = f.service.cliKeys.launch(catalogProfile(catalogTool("mistral"))); });
    assert.deepEqual(unrelated, { env: {}, secrets: [] });
    assert.deepEqual(f.service.cliKeys.launch({ ...connection, program: "other" }), { env: {}, secrets: [] });
    assert.throws(() => keyEnvFor("qwen", { ...fieldsFor("qwen"), endpoint: "https://evil.invalid/v1" }), /allowed region/);
    assert.equal(f.service.cliKeys.close(), true);
    assert.equal(f.service.state.catalogTools.qwen.keySaved, false);
    await assert.rejects(f.service.cliKeys.prepare("qwen"), /closed/);
    assert.throws(() => f.service.cliKeys.launch(connection), /closed/);
  } finally { f.service.cliKeys.close(); }
});
test("IPC uses correlated private messages, bounded failure, unavailable refusal and no fallback", async () => {
  class Channel extends EventEmitter {
    connected = true; sent: any[] = [];
    send = (m: any, cb: any) => { this.sent.push(m); cb(null); };
  }
  const channel = new Channel(), store = new IpcCredentialStore(channel, 25);
  try {
    const saving = store.set("gemini", { key: KEY });
    const request = channel.sent[0];
    assert.equal(request.type, "cliCredentialRequest");
    channel.emit("message", { type: "cliCredentialResult", id: "wrong", ok: true, available: true });
    channel.emit("message", { type: "cliCredentialResult", id: request.id, ok: true, available: true });
    await saving;
    await assert.rejects(store.get("gemini"), { message: UNSAFE_KEY_STORE });
    const reading = store.get("gemini");
    channel.emit("message", { type: "cliCredentialResult", id: channel.sent.at(-1).id, ok: false, available: false });
    await assert.rejects(reading, { message: UNSAFE_KEY_STORE });
    const count = channel.sent.length;
    await assert.rejects(store.set("gemini", { key: KEY }), { message: UNSAFE_KEY_STORE });
    assert.equal(channel.sent.length, count);
  } finally { store.close(); }
  const unavailable = new IpcCredentialStore(new EventEmitter(), 10);
  try { assert.equal(unavailable.available(), false); await assert.rejects(unavailable.get("gemini"), { message: UNSAFE_KEY_STORE }); }
  finally { unavailable.close(); }
});
