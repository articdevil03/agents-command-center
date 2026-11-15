import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshProcessPath } from "../server/leader-common/path-refresh.ts";
import { resolveCliPath } from "../server/leader-common/cli-path.ts";
import { createCandidate, managedCli, managedRoot, publishCandidate } from "../server/settings/opencode/paths.ts";
import { goCredentialSecrets } from "../server/settings/opencode/credentials.ts";
import { installFixture } from "./pack29-opencode-install.setup.ts";
import { setEnv } from "./temp-root.ts";

test("demo flag uses the injected environment, reads no registry and exposes no registry data", async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const readRegistryPath = (env: NodeJS.ProcessEnv) => { calls.push(env); return ["C:\\private-vendor-bin"]; };
  const restore = setEnv({ CC_DEMO_ISOLATED: undefined });
  try {
    const env = { PATH: "C:\\Windows\\System32", CC_DEMO_ISOLATED: "1" };
    const before = { ...env };
    assert.deepEqual(await refreshProcessPath({ env, platform: "win32", readRegistryPath, isDirectory: () => true }), { added: [] });
    assert.deepEqual(calls, [], "demo registry calls must be zero");
    assert.deepEqual(env, before);
    process.env.CC_DEMO_ISOLATED = "1";
    // A host flag must not override an explicitly injected normal environment.
    for (const flag of [undefined, "0", "true"]) {
      const normal = { PATH: "C:\\Windows\\System32", CC_DEMO_ISOLATED: flag };
      assert.deepEqual(await refreshProcessPath({ env: normal, platform: "win32", readRegistryPath, isDirectory: () => true }), { added: ["C:\\private-vendor-bin"] });
      assert.equal(calls.at(-1), normal);
    }
    calls.length = 0;
    assert.deepEqual(await refreshProcessPath({ platform: "win32", readRegistryPath }), { added: [] });
    assert.deepEqual(calls, [], "default process.env demo flag also skips the reader");
  } finally { restore(); }
});

test("fake demo profiles hide a synthetic host installation and resolve only their own new installation", async (t) => {
  const fx = await installFixture(t);
  const restore = setEnv({ LOCALAPPDATA: fx.root, USERPROFILE: fx.root, HOME: fx.root });
  try {
    const host = await createCandidate(fx.env), hostExe = join(host.dir, "opencode.exe");
    writeFileSync(hostExe, "inert host fixture"); await publishCandidate(host.root, hostExe, "1.2.3");
    assert.equal(managedCli(process.env), hostExe, "synthetic host installation FOUND");
    const profile = join(fx.root, "demo"); mkdirSync(profile);
    const env = { LOCALAPPDATA: profile, USERPROFILE: profile, HOME: profile, PATH: "", CC_DEMO_ISOLATED: "1" };
    let reads = 0;
    assert.deepEqual(await refreshProcessPath({ env, platform: "win32", readRegistryPath: () => { reads++; return [host.dir]; } }), { added: [] });
    assert.equal(reads, 0); assert.equal(resolveCliPath("opencode", env), null);
    assert.equal(managedCli({ PATH: "" }), null, "missing injected profile must never use the host");
    assert.equal(managedRoot(env), join(profile, "Command Center", "tools", "opencode-v1"));
    const demo = await createCandidate(env), exe = join(demo.dir, "opencode.exe");
    writeFileSync(exe, "inert demo fixture"); await publishCandidate(demo.root, exe, "1.2.3");
    assert.equal(resolveCliPath("opencode", env), exe);
    assert.equal(managedCli(process.env), hostExe, "demo publication leaves the host descriptor unchanged");
    assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { restore(); await fx.close(); }
});

test("cleared launcher credential overrides leave the injected profile as the only credential location", async (t) => {
  const fx = await installFixture(t);
  try {
    const xdg = join(fx.root, "host-xdg"), store = join(xdg, "opencode"); mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "synthetic-host-key" } }));
    const env: NodeJS.ProcessEnv = { ...fx.env, XDG_DATA_HOME: xdg, OPENCODE_AUTH_CONTENT: "", OPENCODE_API_KEY: "synthetic-env-key" };
    assert.deepEqual(goCredentialSecrets(env), ["synthetic-host-key"], "synthetic override fixture FOUND");
    // Models the leader-owned launcher's exact clearing contract, without reading real credentials.
    for (const name of Object.keys(env)) if (/^(?:XDG_(?:DATA|CONFIG|STATE|CACHE)_HOME|OPENCODE_(?:AUTH_CONTENT|API_KEY|CONFIG.*))$/.test(name)) delete env[name];
    assert.deepEqual(goCredentialSecrets(env), []);
    assert.equal(env.XDG_DATA_HOME, undefined); assert.equal(env.OPENCODE_API_KEY, undefined);
  } finally { await fx.close(); }
});
