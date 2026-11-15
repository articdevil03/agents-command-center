import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { createServer } from "node:http";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsService } from "../server/settings/service.ts";
import { CliInstaller } from "../server/settings/cli-install.ts";
import { managedCli, managedRoot } from "../server/settings/opencode/paths.ts";
import { RELEASE_API } from "../server/settings/opencode/releases.ts";
import type { CliResult, InstallTransport, OpenCodeInstallOptions, RunCli } from "../server/settings/types.ts";

const loopbackFetch = globalThis.fetch;
export type ZipEntry = { name: string; body?: Buffer; attrs?: number; declared?: number };
// Fixture writer only. The installed unzipper performs all parsing/decompression.
export function zipBytes(entries: ZipEntry[] = [{ name: "opencode.exe", body: Buffer.from("INERT TEST BYTES") }]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = entry.body ?? Buffer.from("inert"), compressed = deflateRawSync(body);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(body), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.declared ?? body.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(body), 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(entry.declared ?? body.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((entry.attrs ?? 0x81a40000) >>> 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(record, name); offset += local.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
export function release(version: string, bytes = zipBytes(), overrides: Record<string, unknown> = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: "opencode-windows-x64-baseline.zip", size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    browser_download_url: `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-windows-x64-baseline.zip` }], ...overrides };
}
export function removeOwned(dir: string): void {
  assert.equal(lstatSync(dir).isSymbolicLink(), false, dir);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), info = lstatSync(path);
    assert.equal(info.isSymbolicLink(), false, path);
    if (info.isDirectory()) removeOwned(path); else unlinkSync(path);
  }
  assert.deepEqual(readdirSync(dir), []); rmdirSync(dir);
}
export async function installFixture(t: TestContext, options: { bytes?: Buffer; pages?: unknown[][]; version?: string; pathVersion?: string; run?: RunCli; transport?: InstallTransport } = {}) {
  // Backstops are installed before exercising any guard. They remain if a guard
  // is removed by O4. Only the saved fetch to a fixed loopback origin is allowed.
  const spawned = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN spawn"); });
  syncBuiltinESMExports();
  const fetched = t.mock.method(globalThis, "fetch", () => { throw new Error("FORBIDDEN fetch"); });
  const root = mkdtempSync(join(tmpdir(), "cc-o1-")), data = join(root, "data"), bin = join(root, "bin"); mkdirSync(data); mkdirSync(bin);
  const env = { LOCALAPPDATA: root, USERPROFILE: root, HOME: root, PATH: bin, SystemRoot: process.env.SystemRoot, CC_TEST_FAKE_CLI: "1", OPENAI_API_KEY: "synthetic-provider-secret" };
  const bytes = options.bytes ?? zipBytes(), pages = options.pages ?? [[release("1.19.5", bytes)]];
  const requests: string[] = [], calls: { bin: string; args: string[]; options: any }[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url!.startsWith("/releases")) { const page = Number(new URL(req.url!, "http://127.0.0.1").searchParams.get("page")); res.end(JSON.stringify(pages[page - 1] ?? [])); }
    else { res.setHeader("Content-Type", "application/zip"); res.end(bytes); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;
  const transport: InstallTransport = options.transport ?? ((url, settings) => {
    const address = new URL(url);
    assert.ok(url.startsWith(RELEASE_API) || address.hostname === "github.com", url);
    return loopbackFetch(`http://127.0.0.1:${port}${url.startsWith(RELEASE_API) ? "/releases" + address.search : "/asset"}`, settings);
  });
  const run: RunCli = async (program, args, settings) => {
    calls.push({ bin: program, args, options: settings });
    // Same rule as the real tracked-installer runner (cli-runner.ts): no working folder, no run.
    if (settings.installer && !settings.cwd) return { code: -1, stdout: "", stderr: "", cleanupConfirmed: true };
    if (options.run) return options.run(program, args, settings);
    if (program === "opencode") {
      if (options.pathVersion) return { code: 0, stdout: options.pathVersion, stderr: "" };
      const managed = managedCli(env);
      return managed ? { code: 0, stdout: options.version ?? "1.19.5", stderr: "" } : { code: 127, stdout: "", stderr: "" };
    }
    assert.ok(program.startsWith(managedRoot(env)! + "\\") || program.startsWith(managedRoot(env)! + "/"), `unexpected process ${program}`);
    assert.deepEqual(args, args[0] === "auth" ? ["auth", "list"] : ["--version"]);
    return { code: 0, stdout: args[0] === "auth" ? "0 credentials" : options.version ?? "1.19.5", stderr: "", cleanupConfirmed: true };
  };
  let refreshes = 0;
  const installOptions: OpenCodeInstallOptions = { transport, arch: "x64" };
  const service = new SettingsService({ dataRoot: data, env, runCli: run, installOptions, refreshPath: async () => { refreshes++; } });
  const installer = service.installer;
  const request = { type: "installCli", requestId: "o1-install", cli: "opencode", confirm: true };
  const close = async () => {
    await service.login.drain(); await installer.drain();
    await new Promise<void>((done, fail) => { server.close((error) => error ? fail(error) : done()); server.closeAllConnections(); });
    removeOwned(root);
    spawned.mock.restore(); syncBuiltinESMExports(); fetched.mock.restore();
  };
  return { root, data, bin, env, bytes, pages, calls, requests, service, installer, run, transport, request, installOptions, spawned, fetched, refreshes: () => refreshes, close };
}
export const ok = (stdout = "1.19.5", extra: Partial<CliResult> = {}): CliResult => ({ code: 0, stdout, stderr: "", cleanupConfirmed: true, ...extra });
export function npmFiles(bin: string): { node: string; npm: string } {
  const node = join(bin, "node.exe"), npm = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(npm, ".."), { recursive: true }); writeFileSync(node, "inert"); writeFileSync(join(bin, "npm.cmd"), "inert"); writeFileSync(npm, "inert");
  return { node, npm };
}
