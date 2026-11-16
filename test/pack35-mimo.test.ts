import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CLI_KEY_PROFILES, keyEnvFor, keyProfile, validateKeyRecord } from "../server/settings/cli-key-profiles.ts";
import { SettingsService } from "../server/settings/service.ts";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { scratchDir } from "./temp-root.ts";

const KEY = 'synthetic-mimo-key-' + randomUUID() + '"\\/+';
const record = { key: KEY, model: "mimo-v2.5-pro" };

test("MiMo validation trims, bounds UTF-8 key bytes, and accepts only conservative 1..64 model characters", () => {
  for (const model of ["a", "Model_2.5-pro", "x".repeat(64)]) {
    assert.deepEqual(validateKeyRecord("mimo", { key: "  " + KEY + "  ", model: "  " + model + "  " }), { key: KEY, model });
  }
  for (const model of ["", " ", "x".repeat(65), "a/b", "a:b", 'x","evil', "a b", "a\n", "模型", "a{env:X}"]) {
    assert.throws(() => keyEnvFor("mimo", { key: KEY, model }), /model|field/i, JSON.stringify(model));
  }
  for (const key of ["", "1234567", "é".repeat(3), "x".repeat(4097)]) assert.throws(() => validateKeyRecord("mimo", { ...record, key }), /bytes/);
  for (const key of ["12345678", "é".repeat(4), "x".repeat(4096)]) assert.equal(validateKeyRecord("mimo", { ...record, key }).key, key);
  assert.throws(() => validateKeyRecord("mimo", { key: KEY }), /field/);
  assert.deepEqual(keyProfile("mimo")!.fields.map((f) => [f.id, f.kind, f.maxLength]), [["key", "secret", 4096], ["model", "text", 64]]);
  assert.equal(keyProfile("mimo")!.fields[1].placeholder, "mimo-v2.5-pro");
  assert.equal(JSON.stringify(keyProfile("mimo")).includes("MIMO_API_KEY"), false);
});

test("MiMo refuses reserved merge keys case-insensitively", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    for (const model of [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)]) {
      assert.throws(() => keyEnvFor("mimo", { ...record, model }), { message: "Invalid MiMo model name." }, model);
    }
  }
});

test("MiMo derived config contains only the fixed non-secret provider and the selected model", () => {
  const before = { ...process.env };
  for (const model of ["mimo-v2.5-pro", "custom_3.0"]) {
    const env = keyEnvFor("mimo", { ...record, model });
    assert.deepEqual(Object.keys(env).sort(), ["MIMOCODE_CONFIG_CONTENT", "MIMO_API_KEY"]);
    assert.equal(env.MIMO_API_KEY, KEY);
    assert.equal(env.MIMOCODE_CONFIG_CONTENT.includes(KEY), false);
    assert.deepEqual(JSON.parse(env.MIMOCODE_CONFIG_CONTENT), {
      provider: { mimo: { npm: "@ai-sdk/openai-compatible", name: "MiMo",
        options: { baseURL: "https://api.xiaomimimo.com/v1", headers: { "api-key": "{env:MIMO_API_KEY}" } },
        models: { [model]: { name: model } } } }, model: `mimo/${model}`,
    });
  }
  // Serialization is a security constraint even when today's accepted charset would make hand assembly equivalent.
  assert.match(String(CLI_KEY_PROFILES.mimo.derive), /MIMOCODE_CONFIG_CONTENT:\s*JSON\.stringify\(/);
  assert.deepEqual({ ...process.env }, before);
});

test("MiMo launch env is private to its catalog identity; detection, installers and login never receive it", async () => {
  const root = scratchDir(), calls: any[] = [], logins: any[] = [], store = new MemoryCredentialStore();
  const service = new SettingsService({ dataRoot: root, env: { HOME: root, USERPROFILE: root, CC_TEST_FAKE_CLI: "1", PATH: "" }, credentialStore: store,
    refreshPath: async () => {}, runCli: async (bin, args, options) => {
      calls.push({ bin, args, options }); return { code: bin === "grok" ? 0 : 127, stdout: "1.0.0", stderr: "", cleanupConfirmed: true };
    }, runLogin: (options) => { logins.push(options); return { done: Promise.resolve({ code: 1, stdout: "", stderr: "", cleanupConfirmed: true }), writable: () => false, submit() {} }; },
  });
  const before = { ...process.env }, connection = catalogProfile(catalogTool("mimo"));
  try {
    await service.cliKey({ type: "submitCliKey", requestId: randomUUID(), cli: "mimo", fields: record }, {});
    assert.deepEqual(service.cliKeys.launch(connection), { env: keyEnvFor("mimo", record), secrets: [KEY] });
    for (const cli of ["gemini", "qwen", "copilot"]) {
      await service.cliKeys.prepare(cli);
      let launch; assert.doesNotThrow(() => { launch = service.cliKeys.launch(catalogProfile(catalogTool(cli))); });
      assert.deepEqual(launch, { env: {}, secrets: [] }, cli);
    }
    assert.deepEqual(service.cliKeys.launch({ ...connection, id: "other-mimo" }), { env: {}, secrets: [] });
    await service.refreshAll(null);
    await assert.rejects(service.installCli("qwen", randomUUID(), true));
    await assert.rejects(service.loginCli("grok", randomUUID(), null));
    assert.ok(calls.some((c) => c.args.includes("--version")), "detection FOUND");
    assert.equal(logins.length, 1, "login FOUND");
    for (const call of calls) {
      assert.equal(JSON.stringify(call).includes(KEY), false);
      assert.equal(call.options.env?.MIMOCODE_CONFIG_CONTENT, undefined);
      assert.equal(call.options.env?.MIMO_API_KEY, undefined);
    }
    assert.equal(JSON.stringify(logins).includes(KEY), false);
    assert.equal(JSON.stringify(service.snapshot()).includes(KEY), false);
    assert.deepEqual({ ...process.env }, before);
  } finally { await service.installer.drain(); await service.login.drain(); service.cliKeys.close(); }
});
