import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsService } from "../server/settings/service.ts";
import { installManagedRelease } from "../server/settings/opencode/install.ts";
import { managedCli, managedRoot } from "../server/settings/opencode/paths.ts";
import type { InstallTransport, RunCli } from "../server/settings/types.ts";
import { zipBytes, removeOwned } from "./pack29-opencode-install.setup.ts";

export { zipBytes, removeOwned };
export const VERSION = "1.0.112";
export const ok = (stdout = `GitHub Copilot CLI ${VERSION}.\nRun 'copilot update' to check for updates.`) => ({ code: 0, stdout, stderr: "", cleanupConfirmed: true });
export function release(bytes: Buffer, version = VERSION, arch = "x64") {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: `copilot-win32-${arch}.zip`, size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    browser_download_url: `https://github.com/github/copilot-cli/releases/download/v${version}/copilot-win32-${arch}.zip` }] };
}
export async function fixture(t: TestContext, config: { bytes?: Buffer; rows?: any[]; run?: RunCli; transport?: InstallTransport; arch?: string } = {}) {
  const spawned = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN real spawn"); });
  syncBuiltinESMExports();
  const fetched = t.mock.method(globalThis, "fetch", () => { throw new Error("FORBIDDEN network"); });
  const root = mkdtempSync(join(tmpdir(), "cc-p34-")), data = join(root, "data"); mkdirSync(data);
  const env = { LOCALAPPDATA: root, USERPROFILE: root, HOME: root, APPDATA: root, TEMP: root, TMP: root,
    PATH: "", CC_TEST_FAKE_CLI: "1", SystemRoot: process.env.SystemRoot };
  const bytes = config.bytes ?? zipBytes([{ name: "copilot.exe" }]), rows = config.rows ?? [release(bytes)];
  const requests: string[] = [], calls: { bin: string; args: string[]; options: any }[] = [];
  const transport: InstallTransport = async (url, options) => {
    requests.push(url); assert.equal(options.redirect, "manual");
    if (config.transport) return config.transport(url, options);
    if (url.startsWith("https://api.github.com/repos/github/copilot-cli/releases?")) return Response.json(rows);
    assert.match(url, /^https:\/\/github.com\/github\/copilot-cli\/releases\/download\/v1\.\d+\.\d+\/copilot-win32-(?:x64|arm64)\.zip$/);
    return new Response(bytes);
  };
  const run: RunCli = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (config.run) return config.run(bin, args, options);
    if (bin === "copilot") return managedCli(env, "copilot") ? ok() : { code: 127, stdout: "", stderr: "" };
    assert.ok(bin.startsWith(managedRoot(env, "copilot")!));
    assert.deepEqual(args, ["--version"]);
    assert.equal(options.env?.COPILOT_AUTO_UPDATE, "false");
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) assert.equal(options.env?.[key], join(bin, "..", "probe-home"));
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 25 * 60_000);
    assert.equal(options.installer?.signal.aborted, false);
    return ok();
  };
  const installOptions = { transport, arch: config.arch ?? "x64" };
  const service = new SettingsService({ dataRoot: data, env, runCli: run, installOptions, refreshPath: async () => {} });
  const request = { type: "installCli", requestId: "p34-install", cli: "copilot", confirm: true };
  return { root, env, bytes, rows, calls, requests, run, service, request, installOptions,
    transaction: (signal = new AbortController().signal, deadline = Date.now() + 5000) => installManagedRelease(run, env, signal, deadline, installOptions, "copilot"),
    close: async () => { await service.installer.drain(); await service.login.drain(); removeOwned(root);
      spawned.mock.restore(); syncBuiltinESMExports(); fetched.mock.restore(); },
    assertBoundaries: () => { assert.equal(spawned.mock.callCount(), 0); assert.equal(fetched.mock.callCount(), 0); },
  };
}
