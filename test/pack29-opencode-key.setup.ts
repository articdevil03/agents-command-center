import { modelOutput } from "./opencode-models.setup.ts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fixture } from "./pack29-cli-install.setup.ts";
import { SettingsService } from "../server/settings/service.ts";
import { openCodeCredentialSource } from "../server/settings/cli-auth.ts";
import { parseVersion } from "../server/settings/parse.ts";
import { createKeyRunner } from "../server/settings/opencode/key.ts";
export { until } from "./pack29-cli-login.setup.ts";
export const KEY = "synthetic-key-\"-private-α";
export const begin = (extra = {}) => ({ type: "cliLogin", requestId: "key-start", cli: "opencode", ...extra });
export async function keyFixture(t: any, options: any = {}) {
  const fx = fixture(), requests: any[] = [], spawns: any[] = [], events: any[] = [], snapshots: string[] = [], probes: any[] = [];
  fx.write("opencode.exe");
  const originalFetch = globalThis.fetch;
  const spawnSpy = t.mock.method(childProcess, "spawn", () => { throw new Error("FORBIDDEN vendor process"); });
  const fetchSpy = t.mock.method(globalThis, "fetch", () => { throw new Error("FORBIDDEN external network"); });
  syncBuiltinESMExports();
  let authorization = "", password = "", current: any, authReads = 0, sweeps = 0, clean = options.clean !== false;
  let releaseSweep: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    const authorized = req.headers.authorization === authorization;
    res.setHeader("content-type", "application/json");
    if (!authorized && !options.noProtection) { res.writeHead(401); res.end("{}"); return; }
    if (options.onRequest) await options.onRequest(req, body, res);
    if (options.redirect === req.url) { res.writeHead(302, { location: "https://forbidden.invalid/" }); res.end("{}"); return; }
    if (req.url === "/global/health") res.end(JSON.stringify({ healthy: options.healthy !== false, version: options.healthVersion ?? "1.19.5" }));
    else if (req.url === "/auth/opencode-go") res.end(JSON.stringify(options.put ?? true));
    else if (req.url === "/provider") res.end(JSON.stringify({ connected: options.connected ?? ["opencode-go"] }));
    else if (req.url === "/instance/dispose") res.end(JSON.stringify(options.dispose ?? true));
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const run = async (bin: string, args: string[], settings: any) => {
    probes.push({ bin, args, settings });
    if (args[0] === "--version") return { code: 0, stdout: options.version ?? "1.19.5", stderr: "" };
    if (args[0] === "models") return { code: 0, stdout: modelOutput("fakeprov/fake-model", []), stderr: "" };
    authReads++;
    return { code: options.authCode ?? 0, stdout: options.authAt?.(authReads) ?? options.auth ?? "0 credentials", stderr: "" };
  };
  const spawn = (bin: string, argv: string[], settings: any) => {
    current = Object.assign(new EventEmitter(), { pid: 987654, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    current.kill = () => { throw new Error("tree tracker must own cleanup"); };
    current.finish = () => { if (current.exitCode !== null) return; current.exitCode = 0; current.emit("exit", 0); current.emit("close", 0); current.stdout.end(); current.stderr.end(); };
    password = settings.env.OPENCODE_SERVER_PASSWORD;
    authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
    spawns.push({ bin, argv, settings });
    setImmediate(() => {
      const output = options.announcement ?? ("opencode server listening on " + origin + "\n");
      for (const part of options.outputChunks ?? [output]) current.stdout.write(part);
    });
    return current;
  };
  const tree = () => ({ failed: 0, sweep: async () => {
    sweeps++;
    if (options.holdSweep) await new Promise<void>((done) => { releaseSweep = done; });
    if (clean) current.finish();
    return clean ? 0 : null;
  } });
  const fetchLocal = async (url: any, init: any) => {
    assert.equal(new URL(String(url)).origin, origin, "fixture never contacts another origin");
    assert.equal(init.redirect, "manual");
    const response = await originalFetch(url, init);
    return options.response ? options.response(response, String(url), init) : response;
  };
  const runner = createKeyRunner({ run, spawn: spawn as any, tree: tree as any, fetch: fetchLocal });
  const env = { ...fx.env, ...options.env };
  const service = new SettingsService({ dataRoot: fx.data, env, runCli: run, runKey: options.runKey ?? runner,
    refreshPath: async () => {}, loginTimeoutMs: options.timeoutMs ?? 5000, openLogin: options.open ?? (async () => true),
    onChange: () => { const state = service.snapshot(); snapshots.push(JSON.stringify(state)); options.onPublish?.(state); } });
  // The app detects tools before exposing Sign in. Opening the panel consumes only these cached facts.
  const initialVersion = parseVersion(options.version ?? "1.19.5");
  const credentialSource = openCodeCredentialSource({ code: options.authCode ?? 0, stdout: options.auth ?? options.authAt?.(0) ?? "0 credentials", stderr: "" });
  const facts = { installed: true, version: initialVersion, supportedVersion: initialVersion ? initialVersion.startsWith("1.") : null,
    credentialSource, signedIn: credentialSource === "stored" };
  Object.assign(service.state.catalogTools.opencode, facts); Object.assign(service.state.tools.opencode, facts);
  const send = (event: any) => events.push(event);
  const request = (type: string, extra = {}) => ({ type, requestId: "private-key", cli: "opencode", loginId: events.find((e) => e.loginId)?.loginId, ...extra });
  const close = async () => {
    clean = true; options.holdSweep = false; releaseSweep?.();
    try { await service.login.drain(); await service.installer.drain(); }
    finally {
      try { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
      finally { spawnSpy.mock.restore(); fetchSpy.mock.restore(); syncBuiltinESMExports(); fx.close(); }
    }
    assert.equal(spawnSpy.mock.callCount(), 0); assert.equal(fetchSpy.mock.callCount(), 0);
  };

  return { ...fx, service, env, runner, run, requests, spawns, events, snapshots, probes, request, send, close, origin,
    secretValues: () => [KEY, JSON.stringify(KEY).slice(1, -1), password, authorization, authorization.slice(6)].filter(Boolean),
    authReads: () => authReads, sweeps: () => sweeps, proc: () => current,
    setClean: (value: boolean) => { clean = value; }, releaseSweep: () => { options.holdSweep = false; releaseSweep?.(); } };
}
