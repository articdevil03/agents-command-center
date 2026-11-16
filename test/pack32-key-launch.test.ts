import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir, setEnv } from "./temp-root.ts";
import { CLI_KEY_PROFILES, keyEnvFor } from "../server/settings/cli-key-profiles.ts";
import { MemoryCredentialStore } from "../server/settings/cli-key-store.ts";
import { catalogProfile } from "../server/settings/catalog-acp.ts";
import { catalogTool } from "../server/settings/cli-catalog-validation.ts";
import { SettingsService } from "../server/settings/service.ts";
import { createAcpLeader } from "../server/leader-acp.ts";

const { modules: runner } = await importWithTempDataRoot(() => import("../server/runner.ts"));
const KEY = 'ccTEST-KEY-' + randomUUID() + '"/+\\';
const record = (tool: string) => Object.fromEntries(CLI_KEY_PROFILES[tool].map((f) => [f.id, f.kind === "secret" ? KEY : f.kind === "choice" ? f.choices![0].value : tool === "mimo" ? "model-1" : "provider/model-1"]));
async function until(fn: () => boolean) {
  for (let n = 0; n < 400; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail("Synthetic launch did not settle");
}
test("a corrupted saved Qwen endpoint refuses the actual ACP leader launch before spawn", async () => {
  const store = new MemoryCredentialStore(), root = scratchDir();
  await store.set("qwen", { ...record("qwen"), endpoint: "https://evil.invalid/v1" });
  const service = new SettingsService({ dataRoot: root, credentialStore: store });
  const connection = catalogProfile(catalogTool("qwen"));
  const errors: string[] = []; let spawns = 0;
  const leader = createAcpLeader({ model: "default", effort: "default" }, root, { onDelta() {}, onDone() {}, onUsage() {}, onError: (message) => errors.push(message) }, {
    cli: connection, loadKey: async () => { await service.cliKeys.prepareConnection(connection); return service.cliKeys.launch(connection); },
    spawnFn: () => { spawns++; assert.fail("A changed endpoint must not launch"); },
  });
  try { await until(() => errors.length > 0); assert.equal(spawns, 0); assert.equal(JSON.stringify(errors).includes(KEY), false); }
  finally { leader.stop(); service.cliKeys.close(); }
});
for (const tool of Object.keys(CLI_KEY_PROFILES)) {
  test(`${tool}: actual ACP leader and crew spawn receive only their own saved key; loopback authenticates and output is redacted`, async () => {
    const home = scratchDir(), store = new MemoryCredentialStore();
    const service = new SettingsService({ dataRoot: home, credentialStore: store, runCli: async () => { assert.fail("No vendor probes"); } });
    await service.cliKey({ type: "submitCliKey", requestId: randomUUID(), cli: tool, fields: record(tool) }, {});
    const connection = catalogProfile(catalogTool(tool));
    const expected = keyEnvFor(tool, record(tool));
    const keyEnv = CLI_KEY_PROFILES[tool].find((f) => f.kind === "secret")!.env;
    let authenticated = 0;
    const provider = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${KEY}`;
      if (ok) authenticated++;
      res.writeHead(ok ? 200 : 401); res.end("synthetic");
    });
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const address = provider.address() as { port: number };
    const restore = setEnv({ CC_TEST_FAKE_CLI: "1", HOME: home, USERPROFILE: home, [keyEnv]: "user-environment-synthetic" });
    const before = { ...process.env }, children: ReturnType<typeof spawn>[] = [], calls: any[] = [];
    const output: string[] = [], errors: string[] = [];
    const spawnFake = (program: string, args: string[], options: any) => {
      calls.push({ program, args, env: options.env });
      assert.equal(program, tool === "mistral" ? "vibe-acp" : catalogTool(tool).leader.start!.program);
      assert.equal(args.some((arg) => arg.includes(KEY)), false, "key never enters argv");
      for (const [name, value] of Object.entries(expected)) assert.equal(options.env[name], value, name);
      for (const [other, fields] of Object.entries(CLI_KEY_PROFILES)) if (other !== tool) {
        for (const f of fields) if (!(f.env in expected)) assert.notEqual(options.env[f.env], KEY, `no ${other} key`);
      }
      const child = spawn(process.execPath, [fileURLToPath(new URL("./pack32-key-child.mjs", import.meta.url))], {
        ...options, shell: false, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: home, USERPROFILE: home, ...expected, CC_TEST_FAKE_CLI: "1", CC_FAKE_KEY_ENV: keyEnv, CC_FAKE_PROVIDER: `http://127.0.0.1:${address.port}` },
      });
      children.push(child); return child;
    };
    let leader: ReturnType<typeof createAcpLeader> | undefined;
    try {
      let done = false;
      leader = createAcpLeader({ model: "default", effort: "default" }, home, {
        onDelta: (t) => output.push(t), onError: (t) => errors.push(t), onUsage() {}, onDone() { done = true; },
      }, { cli: connection, loadKey: async () => { await service.cliKeys.prepareConnection(connection); return service.cliKeys.launch(connection); }, spawnFn: spawnFake });
      leader.send("synthetic prompt");
      await until(() => done || errors.length > 0); assert.deepEqual(errors, []); assert.equal(done, true);
      leader.stop(); await until(() => children.every((c) => c.exitCode !== null || c.signalCode !== null));
      const run = { runId: "p32-" + tool, seatKey: "synthetic.coder", slotId: "coder", name: "Synthetic", cli: `acp:${connection.id}` as const, acp: connection, model: "default", effort: "default", folder: home, canWrite: false, startedAt: Date.now() };
      let finished = false;
      const result = runner.runSeat(run, "synthetic prompt", {
        onOutput: (_, text) => output.push(text), onStatus: (_, status) => { if (status !== "working") finished = true; },
      }, spawnFake as any, { keyLaunch: service.cliKeys.launch(connection) });
      assert.equal(result.ok, true);
      await until(() => finished); await until(() => children.every((c) => c.exitCode !== null || c.signalCode !== null));
      assert.equal(authenticated, 2, "both real children authenticated against the loopback fake");
      assert.equal(calls.length, 2); assert.ok(Object.keys(process.env).length === Object.keys(before).length && Object.entries(before).every(([name, value]) => process.env[name] === value), "launch never changes process.env");
      assert.deepEqual(service.cliKeys.launch({ ...connection, id: "manual-other", name: connection.name }), { env: {}, secrets: [] });
      if (result.ok) {
        const logPath = join(runner.logsDir, `${run.seatKey}-${result.timestamp}.log`);
        const persisted = readFileSync(logPath, "utf8");
        assert.match(persisted, /Authenticated/); assert.match(persisted, /End\./);
        for (const secret of [KEY, JSON.stringify(KEY).slice(1, -1), encodeURIComponent(KEY)]) {
          assert.equal(persisted.includes(secret), false); assert.equal(output.join("").includes(secret), false);
        }
        assert.match(persisted, /\[hidden\]/);
        unlinkSync(logPath); unlinkSync(join(runner.logsDir, `${run.seatKey}-${result.timestamp}.brief.txt`));
      }
    } finally {
      leader?.stop();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await until(() => children.every((c) => c.exitCode !== null || c.signalCode !== null));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      service.cliKeys.close(); restore();
    }
  });
}
