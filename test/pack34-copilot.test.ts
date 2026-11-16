import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { managedCli, managedRoot, createCandidate, publishCandidate } from "../server/settings/opencode/paths.ts";
import { resolveCliPath, setCliSkipFolders } from "../server/leader-common/cli-path.ts";
import { request as releaseRequest, selectRelease } from "../server/settings/opencode/releases.ts";
import { RELEASE_TOOLS } from "../server/settings/opencode/release-tools.ts";
import { catalogTool, catalogMetadata } from "../server/settings/cli-catalog-validation.ts";
import { fixture, release, zipBytes, ok, VERSION } from "./pack34-copilot.setup.ts";

test("Copilot publishes only verified bytes, resolves managed native executable and leaves OpenCode untouched", async (t) => {
  const fx = await fixture(t);
  try {
    const prior = await createCandidate(fx.env), old = join(prior.dir, "opencode.exe"); writeFileSync(old, "previous");
    await publishCandidate(prior.root, old, "1.2.3"); const descriptor = readFileSync(join(prior.root, "active.json"));
    await fx.service.installCli(fx.request);
    const installed = managedCli(fx.env, "copilot"); assert.ok(installed);
    assert.deepEqual(readFileSync(installed), Buffer.from("inert"));
    assert.equal(resolveCliPath("copilot", fx.env, process.cwd()), installed);
    assert.equal(fx.service.state.catalogTools.copilot.action?.message, "Installed");
    assert.equal(fx.service.state.catalogTools.copilot.version, VERSION);
    assert.equal(fx.service.state.catalogTools.copilot.signedIn, null);
    assert.equal(managedCli(fx.env), old); assert.deepEqual(readFileSync(join(prior.root, "active.json")), descriptor);
    assert.deepEqual(readdirSync(join(installed, "..")).sort(), ["copilot.exe"]);
    assert.equal(fx.requests.length, 2); fx.assertBoundaries();
    setCliSkipFolders(() => [fx.root]); assert.equal(resolveCliPath("copilot", fx.env, process.cwd()), null);
  } finally { setCliSkipFolders(() => []); await fx.close(); }
});

for (const mode of ["hash", "size", "excess", "digest", "origin", "redirect", "prerelease", "draft", "version", "interrupted"]) {
  test(`Copilot refuses ${mode} without publication or alternate installation`, async (t) => {
    const bytes = zipBytes([{ name: "copilot.exe" }]), row = release(bytes);
    if (mode === "hash") row.assets[0].digest = "sha256:" + "0".repeat(64);
    if (mode === "size") row.assets[0].size++;
    if (mode === "excess") row.assets[0].size--;
    if (mode === "digest") row.assets[0].digest = "";
    if (mode === "origin") row.assets[0].browser_download_url = "https://evil.invalid/copilot.zip";
    if (mode === "prerelease") { row.prerelease = true; row.tag_name += "-0"; }
    if (mode === "draft") row.draft = true;
    const fx = await fixture(t, { bytes, rows: [row],
      ...(mode === "version" ? { run: async (bin) => bin === "copilot" ? { code: 127, stdout: "", stderr: "" } : ok("GitHub Copilot CLI 1.0.113.") } : {}),
      ...(["redirect", "interrupted"].includes(mode) ? { transport: async (url: string) => {
        if (url.includes("api.github")) return Response.json([row]);
        if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.invalid/file" } });
        throw new Error("synthetic interrupted transfer");
      } } : {}),
    });
    try {
      // A bypass of the no-fallback guard reaches harmless external Node probes.
      const bin = join(fx.root, "bin"); mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true });
      fx.env.PATH = bin; writeFileSync(join(bin, "node.exe"), "inert"); writeFileSync(join(bin, "npm.cmd"), "inert"); writeFileSync(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "inert");
      await assert.rejects(fx.service.installCli(fx.request));
      assert.equal(managedCli(fx.env, "copilot"), null);
      assert.equal(fx.calls.some((c) => /node|npm|winget|powershell/i.test(c.bin)), false, `no fallback for ${mode}`);
      const root = managedRoot(fx.env, "copilot")!;
      if (existsSync(root)) assert.deepEqual(readdirSync(root), []);
      fx.assertBoundaries();
    } finally { await fx.close(); }
  });
}

const invalidEntries = [
  [{ name: "copilot.exe" }, { name: "extra.txt" }], [{ name: "../copilot.exe" }], [{ name: "/copilot.exe" }],
  [{ name: "copilot.exe", attrs: 0xa1ff0000 }], [{ name: "copilot.exe" }, { name: "copilot.exe" }],
  [{ name: "COPILOT.EXE" }], [{ name: "copilot.exe", declared: 256 * 1024 * 1024 + 1 }], [],
];
for (const [index, entries] of invalidEntries.entries()) test(`unsafe single-entry archive ${index} is rejected before candidate execution`, async (t) => {
  const fx = await fixture(t, { bytes: zipBytes(entries) });
  try {
    await assert.rejects(fx.service.installCli(fx.request));
    assert.equal(managedCli(fx.env, "copilot"), null);
    assert.equal(fx.calls.filter((c) => c.bin !== "copilot").length, 0);
    assert.deepEqual(readdirSync(managedRoot(fx.env, "copilot")!), []); fx.assertBoundaries();
  } finally { await fx.close(); }
});

test("release selection is numeric, excludes draft/prerelease, supports arm64 and enforces per-tool limits", async () => {
  const bytes = zipBytes([{ name: "copilot.exe" }]), rows = [release(bytes, "1.0.9", "arm64"), release(bytes, "1.0.112", "arm64")];
  const result = await selectRelease(async () => Response.json(rows), new AbortController().signal, "arm64", "copilot");
  assert.equal(result.version, VERSION); assert.match(result.url, /arm64/);
  assert.equal(RELEASE_TOOLS.opencode.downloadLimit, 128 * 1024 * 1024);
  assert.equal(RELEASE_TOOLS.copilot.downloadLimit, 192 * 1024 * 1024);
  const row = release(bytes); row.assets[0].size = 136_440_682;
  assert.equal((await selectRelease(async () => Response.json([row]), new AbortController().signal, "x64", "copilot")).size, 136_440_682);
  row.assets[0].size = 192 * 1024 * 1024 + 1;
  await assert.rejects(selectRelease(async () => Response.json([row]), new AbortController().signal, "x64", "copilot"));
  for (const origin of ["https://evil.invalid/a", "http://github.com/github/copilot-cli/releases/download/a", "https://github.com/anomalyco/opencode/releases/download/a"]) {
    let calls = 0; await assert.rejects(releaseRequest(async () => { calls++; return new Response(bytes); }, origin, new AbortController().signal, "copilot"));
    assert.equal(calls, 0);
  }
});

test("version checks cannot publish early and rollback restores the previous descriptor byte for byte", async (t) => {
  let descriptor: string, before: Buffer;
  const fx = await fixture(t, { run: async () => { assert.deepEqual(readFileSync(descriptor), before); return ok(); } });
  try {
    const prior = await createCandidate(fx.env, "copilot"), exe = join(prior.dir, "copilot.exe"); writeFileSync(exe, "previous");
    await publishCandidate(prior.root, exe, "1.0.100"); descriptor = join(prior.root, "active.json"); before = readFileSync(descriptor);
    const tx = await fx.transaction(); assert.equal(tx.result.code, 0); assert.deepEqual(readFileSync(descriptor), before);
    await tx.commit!(); assert.equal(managedCli(fx.env, "copilot"), tx.candidate);
    await tx.rollback!(); assert.deepEqual(readFileSync(descriptor), before); assert.equal(managedCli(fx.env, "copilot"), exe);
    assert.equal(existsSync(tx.candidate!), false);
  } finally { await fx.close(); }
});

test("outside descriptors are refused while PATH-only native Copilot remains available", async (t) => {
  const fx = await fixture(t);
  try {
    const candidate = await createCandidate(fx.env, "copilot"), outside = join(fx.root, "copilot.exe"); writeFileSync(outside, "inert");
    for (const executable of [outside, relative(candidate.root, outside), "install-a/COPILOT.EXE", "install-a/npm/copilot.cmd"]) {
      writeFileSync(join(candidate.root, "active.json"), JSON.stringify({ executable, version: VERSION }));
      assert.equal(managedCli(fx.env, "copilot"), null, executable);
    }
    fx.env.PATH = fx.root; assert.equal(resolveCliPath("copilot", fx.env, process.cwd()), outside);
    assert.equal(catalogTool("copilot").recipe?.kind, "copilot");
    assert.doesNotMatch(JSON.stringify(catalogMetadata().find((e) => e.id === "copilot")), /winget|powershell|terminal|\u2014/i);
    assert.match(catalogTool("copilot").limitation, /do not update/);
  } finally { await fx.close(); }
});

test("cancel, deadline and retained cleanup block concurrent installs until confirmed", async (t) => {
  let entered!: () => void, finish!: () => void, confirmed = false;
  const started = new Promise<void>((r) => { entered = r; }), held = new Promise<void>((r) => { finish = r; });
  const fx = await fixture(t, { run: async (bin) => {
    if (bin === "copilot") return { code: 127, stdout: "", stderr: "" };
    entered(); await held; return { ...ok(), cleanupConfirmed: confirmed, retryCleanup: async () => confirmed };
  } });
  try {
    const pending = fx.service.installCli(fx.request), rejection = assert.rejects(pending);
    await assert.rejects(fx.service.installCli({ ...fx.request, requestId: "second" }), /still active/);
    await started;
    const cancel = { type: "cancelCliInstall", requestId: "cancel", cli: "copilot", installRequestId: fx.request.requestId };
    const stop = assert.rejects(fx.service.cancelCliInstall(cancel)); finish(); await stop; await rejection;
    assert.equal(fx.service.installer.busy, true); confirmed = true; await fx.service.cancelCliInstall(cancel);
    assert.equal(fx.service.installer.busy, false); assert.equal(managedCli(fx.env, "copilot"), null);
  } finally { finish(); await fx.close(); }
});

test("a deadline during transfer cleans the candidate and never publishes", async (t) => {
  const bytes = zipBytes([{ name: "copilot.exe" }]);
  const fx = await fixture(t, { bytes, transport: async (url, options) => {
    if (url.includes("api.github")) return Response.json([release(bytes)]);
    await new Promise((done) => setTimeout(done, 30)); options.signal.throwIfAborted(); return new Response(bytes);
  } });
  try {
    const tx = await fx.transaction(new AbortController().signal, Date.now() + 10);
    assert.equal(tx.result.code, 124); assert.equal(tx.result.cleanupConfirmed, true);
    assert.equal(managedCli(fx.env, "copilot"), null); assert.equal(fx.calls.length, 0);
  } finally { await fx.close(); }
});

test("partial-stream interruption and cancellation leave no candidate or alternate-route calls", async (t) => {
  for (const cancel of [false, true]) {
    const abort = new AbortController(), bytes = zipBytes([{ name: "copilot.exe" }]);
    const fx = await fixture(t, { bytes, transport: async (url) => url.includes("api.github") ? Response.json([release(bytes)]) : new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 20)); },
      pull(controller) { if (cancel) abort.abort(); controller.error(new Error("synthetic interrupted body")); },
    })) });
    try {
      const tx = await fx.transaction(abort.signal);
      assert.notEqual(tx.result.code, 0); assert.equal(tx.result.cancelled, cancel);
      assert.equal(tx.result.cleanupConfirmed, true); assert.equal(fx.calls.length, 0);
      assert.deepEqual(readdirSync(managedRoot(fx.env, "copilot")!), []);
    } finally { await fx.close(); }
  }
});

test("candidate output requires the exact selected version at the start", async (t) => {
  for (const output of ["GitHub Copilot CLI 1.0.1120.", "GitHub Copilot CLI 1.0.112.1", "GitHub Copilot CLI 1.0.112-0", "banner\nGitHub Copilot CLI 1.0.112.", "copilot 1.0.112"]) {
    const fx = await fixture(t, { run: async () => ok(output) });
    try { const tx = await fx.transaction(); assert.notEqual(tx.result.code, 0, output); assert.equal(managedCli(fx.env, "copilot"), null); }
    finally { await fx.close(); }
  }
});

test("arm64 installation follows only the allowed manual asset redirect", async (t) => {
  const bytes = zipBytes([{ name: "copilot.exe" }]), row = release(bytes, VERSION, "arm64");
  const fx = await fixture(t, { arch: "arm64", bytes, rows: [row], transport: async (url) => {
    if (url.includes("api.github")) return Response.json([row]);
    if (url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/synthetic" } });
    assert.equal(url, "https://release-assets.githubusercontent.com/synthetic"); return new Response(bytes);
  } });
  try { await fx.service.installCli(fx.request); assert.ok(managedCli(fx.env, "copilot")); assert.equal(fx.requests.length, 3); fx.assertBoundaries(); }
  finally { await fx.close(); }
});
