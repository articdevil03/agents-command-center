import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { importWithTempDataRoot } from "./temp-root.ts";
const { modules } = await importWithTempDataRoot(async () => ({
  fixture: await import("./pack29-opencode-install.setup.ts"),
  paths: await import("../server/settings/opencode/paths.ts"),
  install: await import("../server/settings/opencode/install.ts"),
}));
const { installFixture, release, ok, npmFiles } = modules.fixture;
const { installOpenCode } = modules.install;
const { createCandidate, candidatesInProgress, publishCandidate, managedCli } = modules.paths;
const limited = "GitHub is limiting requests right now. Wait a few minutes, then choose Try again.";

for (const [label, status, headers, rateLimited] of [
  ["429", 429, {}, true],
  ["403 exhausted", 403, { "x-ratelimit-remaining": "0" }, true],
  ["403 retry after", 403, { "Retry-After": "60" }, true],
  ["503 retry after", 503, { "Retry-After": "60" }, true],
  ["ordinary 403", 403, {}, false],
] as const) {
  test(`release-list ${label} stops after one request and publishes the correct failure`, async (t) => {
    const requests: string[] = [];
    const fx = await installFixture(t, { transport: async (url) => {
      requests.push(url); return new Response("refused", { status, headers });
    } });
    try {
      await assert.rejects(fx.service.installCli(fx.request), (error: Error) => {
        assert.equal(error.message, rateLimited ? limited : "Installation failed. Check your connection and Windows security settings before trying again."); return true;
      });
      const action = fx.service.state.catalogTools.opencode.action!;
      assert.equal(action.status, "failed");
      assert.equal(action.message, rateLimited ? limited : "Installation failed. Check your connection and Windows security settings before trying again.");
      assert.equal(action.reason, rateLimited ? "rateLimited" : "installFailed");
      assert.equal(requests.length, 1);
      assert.match(requests[0], /\/releases\?per_page=100&page=1$/);
      assert.ok(fx.calls.every((call) => call.bin === "opencode"), "no download, candidate probe or npm fallback");
      assert.equal(fx.installer.busy, false);
    } finally { await fx.close(); }
  });
}

test("a rate limit on a later page refuses the partial semantic maximum without downloading", async (t) => {
  const requests: string[] = [];
  const fx = await installFixture(t, { transport: async (url) => {
    requests.push(url);
    return requests.length === 1 ? Response.json(Array.from({ length: 100 }, (_, i) => release(`1.1.${i}`))) : new Response("limited", { status: 429 });
  } });
  try {
    await assert.rejects(fx.service.installCli(fx.request), { message: limited });
    assert.equal(requests.length, 2);
    assert.match(requests[1], /page=2$/);
    assert.equal(managedCli(fx.env), null);
  } finally { await fx.close(); }
});

for (const layout of ["opencode.exe", join("npm", "opencode.cmd")]) {
  test(`OpenCode admission sweeps stale copies and protects active ${layout}, pending, foreign and linked entries`, async (t) => {
    const fx = await installFixture(t);
    let spy: any;
    const owned: string[] = [];
    try {
      const active = await createCandidate(fx.env); owned.push(active.dir);
      const exe = join(active.dir, layout); fs.mkdirSync(join(exe, ".."), { recursive: true }); fs.writeFileSync(exe, "active");
      await publishCandidate(active.root, exe, "1.19.5"); candidatesInProgress.delete(active.dir);
      const pending = await createCandidate(fx.env); owned.push(pending.dir); fs.writeFileSync(join(pending.dir, "keep"), "pending");
      const stale = join(active.root, "install-dead"), foreign = join(active.root, "foreign"), linked = join(active.root, "install-abcd");
      for (const dir of [stale, foreign, linked]) { fs.mkdirSync(dir); fs.writeFileSync(join(dir, "keep"), "inert"); }
      const stat = fs.lstatSync; let links = 0;
      spy = t.mock.method(fs, "lstatSync", ((path: any, ...args: any[]) => {
        const info = (stat as any)(path, ...args);
        if (String(path) !== linked) return info;
        links++; return new Proxy(info, { get(target, key) { return key === "isSymbolicLink" ? () => true : Reflect.get(target, key); } });
      }) as any); syncBuiltinESMExports();
      await assert.rejects(fx.service.installCli(fx.request), /already installed/);
      assert.equal(fs.existsSync(stale), false, "admission removes stale managed copy before preflight");
      assert.equal(fs.readFileSync(exe, "utf8"), "active");
      for (const dir of [pending.dir, foreign, linked]) assert.equal(fs.existsSync(join(dir, "keep")), true, dir);
      assert.ok(links > 0, "linked boundary was checked");
    } finally {
      spy?.mock.restore(); syncBuiltinESMExports();
      for (const dir of owned) candidatesInProgress.delete(dir);
      await fx.close();
    }
  });
}

test("OpenCode finish sweeps a replaced install and reports locked cleanup without failing installation", async (t) => {
  const fx = await installFixture(t, { pathVersion: "2.0.0" });
  const old = await createCandidate(fx.env); candidatesInProgress.delete(old.dir);
  fs.writeFileSync(join(old.dir, "opencode.exe"), "old");
  await publishCandidate(old.root, join(old.dir, "opencode.exe"), "1.0.0");
  const locked = join(old.root, "install-beef"); fs.mkdirSync(locked); fs.writeFileSync(join(locked, "keep"), "locked");
  const unlink = fsp.unlink; let attempts = 0;
  const spy = t.mock.method(fsp, "unlink", (async (path: any) => {
    if (String(path) === join(locked, "keep")) { attempts++; throw Object.assign(new Error("locked"), { code: "EPERM" }); }
    return unlink(path);
  }) as any); syncBuiltinESMExports();
  try {
    await fx.service.installCli(fx.request);
    assert.equal(fs.existsSync(old.dir), false, "finish removes previous active install after activation");
    assert.ok(managedCli(fx.env), "new active installation survives finish");
    assert.ok(attempts >= 1, "locked file cleanup reached");
    assert.equal(fs.readFileSync(join(locked, "keep"), "utf8"), "locked");
    const action = fx.service.state.catalogTools.opencode.action!;
    assert.equal(action.status, "done");
    assert.match(action.message, /old installation files could not be removed/i);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
});

for (const interruption of ["cancelled", "timeout"] as const) test(`P6 ${interruption} overrides an earlier rate-limit failure`, async (t) => {
  const { CliInstaller } = await import("../server/settings/cli-install.ts");
  const { InstallFailure, INSTALL_MESSAGES } = await import("../server/settings/cli-installers.ts");
  const fx = await installFixture(t, { transport: async () => new Response("limited", { status: 429 }) });
  let refreshes = 0;
  const installer = new CliInstaller({ state: fx.service.state, env: fx.env, run: fx.run, publish() {}, installOptions: fx.installOptions,
    refreshPath: async () => { if (++refreshes === 2) throw new InstallFailure(interruption); } });
  try {
    await assert.rejects(installer.install(fx.request), { message: INSTALL_MESSAGES[interruption] });
    assert.equal(refreshes, 2, "interruption follows the failed transaction");
    assert.equal(fx.service.state.catalogTools.opencode.action!.reason, interruption);
    assert.equal(installer.busy, false);
  } finally { await installer.drain(); await fx.close(); }
});

test("a 429 with Retry-After on an asset download is an ordinary transfer failure and takes the npm fallback", async (t) => {
  const fx = await installFixture(t, { transport: async (url) => url.includes("api.github") ? Response.json([release("1.19.5")]) : new Response("limited", { status: 429, headers: { "Retry-After": "60" } }),
    run: async (bin, args) => {
      if (bin === "opencode") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "--version" && bin.endsWith("node.exe")) return ok("v24.1.0");
      if (args[1] === "--version") return ok("11.0.0");
      if (args.includes("install")) { const prefix = args[args.indexOf("--prefix") + 1]; fs.mkdirSync(prefix); fs.writeFileSync(join(prefix, "opencode.cmd"), "inert"); return ok(""); }
      return ok(args[0] === "auth" ? "0 credentials" : "1.19.5");
    } });
  try {
    npmFiles(fx.bin);
    const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, Date.now() + 4000, fx.installOptions);
    assert.equal(tx.failureReason, undefined, "an asset download is never reported as a rate limit");
    assert.equal(tx.result.code, 0);
    assert.ok(fx.calls.some((call) => call.args.includes("install") && call.args.includes("opencode-ai@1.19.5")), "the npm transfer fallback ran");
  } finally { await fx.close(); }
});
