import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { importWithTempDataRoot } from "./temp-root.ts";
const { modules: imports } = await importWithTempDataRoot(async () => ({
  install: await import("../server/settings/opencode/install.ts"),
  paths: await import("../server/settings/opencode/paths.ts"),
  archive: await import("../server/settings/opencode/archive.ts"),
  releases: await import("../server/settings/opencode/releases.ts"),
  fixture: await import("./pack29-opencode-install.setup.ts"),
}));
const { installOpenCode } = imports.install;
const { managedCli, managedRoot, publishCandidate, createCandidate } = imports.paths;
const { extractExecutable, EXPANDED_LIMIT } = imports.archive;
const { ReleaseFailure } = imports.releases;
const { installFixture, release, zipBytes, ok, npmFiles } = imports.fixture;

test("candidate links and non-files are refused before the verification runner", async (t) => {
  for (const kind of ["link", "nonfile", "healthy"]) {
    const fx = await installFixture(t), stat = fs.lstatSync, asyncStat = fsp.lstat;
    let checking = false, reached = 0;
    fx.installOptions.phase = (message) => { checking = message === "Checking OpenCode 1…"; };
    const altered = (path: any, value: any) => {
      if (!checking || !String(path).endsWith("opencode.exe")) return value;
      reached++;
      return new Proxy(value, { get(target, key) {
        if (key === "isSymbolicLink" && kind === "link") return () => true;
        if (key === "isFile" && kind === "nonfile") return () => false;
        return Reflect.get(target, key);
      } });
    };
    const syncSpy = t.mock.method(fs, "lstatSync", ((path: any, ...args: any[]) => altered(path, (stat as any)(path, ...args))) as any);
    const asyncSpy = t.mock.method(fsp, "lstat", (async (path: any, ...args: any[]) => altered(path, await (asyncStat as any)(path, ...args))) as any);
    syncBuiltinESMExports();
    try {
      const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, Date.now() + 5000, fx.installOptions);
      assert.ok(reached > 0, kind + " pre-execution boundary reached");
      assert.equal(fx.calls.length, kind === "healthy" ? 1 : 0, kind + " verification runner count");
      assert.equal(tx.result.code === 0, kind === "healthy");
    } finally { checking = false; syncSpy.mock.restore(); asyncSpy.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
  }
});

test("ZIP traversal rejects the entire archive before extracting a valid executable", async (t) => {
  for (const name of ["../evil.exe", "a/../b"]) {
    const fx = await installFixture(t, { bytes: zipBytes([{ name: "opencode.exe" }, { name }]) });
    const writer = t.mock.method(fs, "createWriteStream"); syncBuiltinESMExports();
    try {
      await assert.rejects(fx.service.installCli(fx.request), /Installation failed/, `traversal ${name} refuses installation`);
      assert.equal(writer.mock.callCount(), 0, "the whole archive is refused before opening an extraction writer");
      assert.equal(managedCli(fx.env), null);
      assert.equal(fx.calls.some((call) => call.bin !== "opencode"), false);
      assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
      assert.equal(existsSync(join(fx.root, "evil.exe")), false);
    } finally { writer.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
  }
});

test("ZIP entry count accepts exactly 64 valid entries and refuses 65 before extraction", async (t) => {
  for (const count of [64, 65]) {
    const entries = Array.from({ length: count }, (_, i) => ({ name: i ? `file-${i}.txt` : "opencode.exe" }));
    const fx = await installFixture(t, { bytes: zipBytes(entries) });
    const writer = t.mock.method(fs, "createWriteStream"); syncBuiltinESMExports();
    try {
      if (count === 64) {
        await assert.doesNotReject(fx.service.installCli(fx.request));
        assert.ok(managedCli(fx.env), "64 entries activates the checked executable");
        assert.equal(writer.mock.callCount(), 1, "64 entries reaches the real extraction writer");
      } else {
        await assert.rejects(fx.service.installCli(fx.request), /Installation failed/, "65 valid entries must fail");
        assert.equal(writer.mock.callCount(), 0, "65 entries is refused before opening an extraction writer");
        assert.equal(managedCli(fx.env), null);
        assert.equal(fx.calls.some((call) => call.bin !== "opencode"), false);
        assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
      }
    } finally { writer.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
  }
});

test("Node-free install verifies bytes before any executable probe and activates only the checked candidate", async (t) => {
  const fx = await installFixture(t, { pathVersion: "2.3.0" });
  try {
    await fx.service.installCli(fx.request);
    const path = managedCli(fx.env); assert.ok(path);
    assert.deepEqual(readFileSync(path), Buffer.from("INERT TEST BYTES"));
    assert.equal(fx.service.state.catalogTools.opencode.supportedVersion, true);
    assert.equal(fx.service.state.catalogTools.opencode.action?.status, "done");
    assert.equal(fx.refreshes(), 2);
    const candidates = fx.calls.filter((call) => call.bin !== "opencode");
    assert.ok(candidates.length >= 2);
    assert.ok(candidates.every((call) => call.bin === path));
    assert.ok(candidates.every((call) => call.options.env?.OPENCODE_DISABLE_AUTOUPDATE === "1" || call.options.installer));
    assert.deepEqual(fx.calls[0].args, ["--version"], "PATH major 2 gets no auth calls");
    assert.equal(fx.calls.some((call) => /node|npm|powershell/i.test(call.bin)), false);
    assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
    assert.deepEqual(fx.requests, ["/releases?per_page=100&page=1", "/asset"]);
  } finally { await fx.close(); }
});

test("integrity failures cannot probe a candidate, activate, or enter npm fallback", async (t) => {
  for (const mode of ["digest", "hash", "short", "excess", "header-only", "redirect"]) {
    const bytes = zipBytes(), row = release("1.19.5", bytes);
    if (mode === "digest") row.assets[0].digest = "";
    if (mode === "hash") row.assets[0].digest = `sha256:${"0".repeat(64)}`;
    if (mode === "short") row.assets[0].size += 1;
    if (mode === "excess") row.assets[0].size -= 1;
    if (mode === "header-only") row.assets[0].size -= 1;
    const fx = await installFixture(t, { pages: [[row]], ...(["redirect", "header-only"].includes(mode) ? { transport: async (url) => url.includes("api.github") ? Response.json([row]) :
      mode === "header-only" ? new Response(bytes, { headers: { "content-length": String(row.assets[0].size) } }) : url.startsWith("http://evil.example") ? new Response(bytes) :
        new Response(null, { status: 302, headers: { location: "http://evil.example/vendor.exe" } }) } : {}) });
    try {
      npmFiles(fx.bin);
      await assert.rejects(fx.service.installCli(fx.request), /Installation failed/);
      assert.deepEqual(fx.calls.map((call) => call.bin), ["opencode", "opencode"], mode);
      assert.equal(managedCli(fx.env), null, mode);
      const root = managedRoot(fx.env)!;
      if (existsSync(root)) assert.deepEqual(readdirSync(root), [], `${mode}: staging cleaned`);
    } finally { await fx.close(); }
  }
});

test("actual installCli message handler reaches service, installer and loopback boundary with private static completion", async (t) => {
  const fx = await installFixture(t);
  try {
    const { api, setup } = await import("./pack29-first-run.setup.ts");
    const ctx = setup(); api.state.setSettingsService(fx.service);
    const socket = [...api.state.clients][0];
    api.messages.handleMessage(socket, JSON.stringify(fx.request));
    const deadline = Date.now() + 3000;
    while (!ctx.replies.some((reply) => ["actionResult", "error"].includes(reply.type) && reply.requestId === fx.request.requestId)) {
      assert.ok(Date.now() < deadline, "installCli handler must finish"); await new Promise((done) => setImmediate(done));
    }
    const result = ctx.replies.find((reply) => ["actionResult", "error"].includes(reply.type) && reply.requestId === fx.request.requestId);
    assert.equal(result.type, "actionResult", JSON.stringify(result));
    assert.equal(fx.service.state.catalogTools.opencode.action?.status, "done");
    assert.ok(managedCli(fx.env)); assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { await fx.close(); }
});

test("no activation is visible during version or auth probes; rollback restores an earlier installation", async (t) => {
  let oldDescriptor: Buffer, descriptor: string;
  const fx = await installFixture(t, { run: async (_bin, args) => {
    assert.deepEqual(readFileSync(descriptor), oldDescriptor, "activation must wait for every candidate probe");
    return ok(args[0] === "auth" ? "0 credentials" : "1.19.5");
  } });
  try {
    const prior = await createCandidate(fx.env), exe = join(prior.dir, "opencode.exe"); writeFileSync(exe, "old inert");
    await publishCandidate(prior.root, exe, "1.0.0"); descriptor = join(prior.root, "active.json"); oldDescriptor = readFileSync(descriptor);
    const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, Date.now() + 5000, fx.installOptions);
    assert.equal(tx.result.code, 0); assert.deepEqual(readFileSync(descriptor), oldDescriptor);
    await tx.commit!(); assert.equal(managedCli(fx.env), tx.candidate);
    await tx.rollback!(); assert.deepEqual(readFileSync(descriptor), oldDescriptor); assert.equal(managedCli(fx.env), exe);
  } finally { await fx.close(); }
});

test("fallback never installs without positive external Node AND npm probes, and cannot reset the deadline or ignore cancellation", async (t) => {
  for (const mode of ["missing", "node", "npm", "cancel", "deadline", "cleanup"]) {
    const abort = new AbortController(); let retry = false;
    const fx = await installFixture(t, {
      transport: async (url) => { if (url.includes("api.github")) return Response.json([release("1.19.5")]); throw new Error("transport interruption"); },
      run: async (_bin, args) => {
        if (args.includes("install")) { abort.abort(); return ok("", { cleanupConfirmed: mode !== "cleanup", retryCleanup: async () => retry }); }
        if (mode === "cancel") abort.abort();
        if (mode === "deadline") await new Promise((done) => setTimeout(done, 120));
        return ok(args.length === 1 ? mode === "node" ? "unknown" : "v24.1.0" : mode === "npm" ? "unknown" : "11.0.0");
      },
    });
    try {
      if (mode !== "missing") npmFiles(fx.bin);
      const tx = await installOpenCode(fx.run, fx.env, abort.signal, Date.now() + (mode === "deadline" ? 60 : 5000), fx.installOptions);
      assert.notEqual(tx.result.code, 0, mode); assert.equal(managedCli(fx.env), null);
      if (mode === "cleanup") { assert.equal(tx.result.cleanupConfirmed, false); retry = true; assert.equal(await tx.result.retryCleanup!(), true); }
      else assert.equal(fx.calls.some((call) => call.args.includes("install")), false, mode);
    } finally { await fx.close(); }
  }
});

test("malicious ZIP entries cannot write outside staging and never trigger fallback", async (t) => {
  const entries = ["../escape.exe", "/absolute", "//host/share/file", "C:/file", "C:relative", "opencode.exe:stream", "..\\escape", "aux.txt", "trailing. "];
  const variants = entries.map((name) => [{ name: "opencode.exe" }, { name }]);
  variants.push([{ name: "opencode.exe", attrs: 0xa1ff0000 }], [{ name: "opencode.exe", attrs: 0x81a40400 }],
    [{ name: "opencode.exe" }, { name: "OPENCODE.EXE" }], [{ name: "other.exe" }],
    [{ name: "opencode.exe", declared: EXPANDED_LIMIT + 1 }], [{ name: "opencode.exe", declared: 1 }]);
  for (const entries of variants) {
    const fx = await installFixture(t, { bytes: zipBytes(entries) });
    try {
      npmFiles(fx.bin);
      await assert.rejects(fx.service.installCli(fx.request));
      assert.equal(managedCli(fx.env), null, JSON.stringify(entries));
      assert.equal(fx.calls.filter((call) => call.bin !== "opencode").length, 0);
      assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
      assert.deepEqual(readdirSync(fx.root).sort(), ["Command Center", "bin", "data"].sort());
    } finally { await fx.close(); }
  }
});

test("ZIP record bounds are checked before the installed library allocates entry arrays", async (t) => {
  const fx = await installFixture(t);
  try {
    for (const [offset, value] of [[8, 65], [10, 65535], [4, 1], [20, 1]]) {
      const bytes = zipBytes(); bytes.writeUInt16LE(value, bytes.length - 22 + offset);
      const path = join(fx.root, "bad.zip"); writeFileSync(path, bytes);
      await assert.rejects(extractExecutable(path, fx.root, new AbortController().signal));
    }
    assert.equal(existsSync(join(fx.root, "opencode.exe")), false);
  } finally { await fx.close(); }
});

test("major 2, unknown or failed candidate probes leave the previous descriptor byte-identical", async (t) => {
  for (const version of ["2.0.0", "unknown", "1.19.5"]) {
    let probes = 0;
    const fx = await installFixture(t, { run: async (bin) => {
      if (bin === "opencode") return { code: 127, stdout: "", stderr: "" };
      probes++; return ok(version, version === "1.19.5" ? { code: 1 } : {});
    } });
    try {
      const previous = await createCandidate(fx.env); const exe = join(previous.dir, "opencode.exe"); writeFileSync(exe, "old inert");
      await publishCandidate(previous.root, exe, "1.0.0");
      const active = join(previous.root, "active.json"), before = readFileSync(active);
      await assert.rejects(fx.service.installCli(fx.request));
      assert.equal(probes, 1); assert.deepEqual(readFileSync(active), before);
      assert.equal(managedCli(fx.env), exe); assert.deepEqual(readdirSync(previous.root).sort(), ["active.json", previous.dir.split(/[\\/]/).at(-1)!].sort());
    } finally { await fx.close(); }
  }
});

test("transfer-only npm fallback positively probes Node/npm, pins selected version and uses a private prefix with one deadline", async (t) => {
  let fx: Awaited<ReturnType<typeof installFixture>>;
  fx = await installFixture(t, { transport: async (url) => { if (url.includes("api.github")) return Response.json([release("1.19.5")]); throw new Error("synthetic transfer interruption"); },
    run: async (bin, args) => {
      if (bin === "opencode") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "--version" && bin.endsWith("node.exe")) return ok("v24.1.0");
      if (args[1] === "--version") return ok("11.0.0");
      if (args.includes("install")) { const prefix = args[args.indexOf("--prefix") + 1]; mkdirSync(prefix); writeFileSync(join(prefix, "opencode.cmd"), "inert"); return ok(""); }
      return ok(args[0] === "auth" ? "0 credentials" : "1.19.5");
    } });
  try {
    const external = npmFiles(fx.bin);
    const started = Date.now();
    const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, started + 4000, fx.installOptions);
    assert.equal(tx.result.code, 0); assert.equal(managedCli(fx.env), null, "not activated until commit");
    const calls = fx.calls; assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].args, ["--version"]); assert.equal(calls[0].bin, external.node);
    assert.deepEqual(calls[1].args, [external.npm, "--version"]);
    assert.deepEqual(calls[2].args, [external.npm, "install", "--global", "--prefix", join(tx.candidate!, ".."), "opencode-ai@1.19.5", "--registry=https://registry.npmjs.org"]);
    assert.ok(calls.every((call) => call.options.timeoutMs <= 4000 && call.options.timeoutMs > 0));
    assert.ok(calls.at(-1)!.options.timeoutMs <= calls[0].options.timeoutMs, "fallback cannot reset the deadline");
    await tx.commit!(); assert.equal(managedCli(fx.env), tx.candidate);
    await tx.rollback!(); assert.equal(managedCli(fx.env), null);
  } finally { await fx.close(); }
});

test("cancellation at metadata, transfer, extraction/checking and verification cleans staging and releases admission only after confirmed cleanup", async (t) => {
  for (const phase of ["metadata", "transfer", "Checking the download…", "Checking OpenCode 1…", "probe"]) {
    const abort = new AbortController();
    const fx = await installFixture(t, { run: async () => { abort.abort(); return ok(); } });
    const original = fx.transport;
    fx.installOptions.transport = async (url, options) => {
      if ((phase === "metadata" && url.includes("api.github")) || (phase === "transfer" && !url.includes("api.github"))) abort.abort();
      return original(url, options);
    };
    fx.installOptions.phase = (message) => { if (message === phase) abort.abort(); };
    try {
      const tx = await installOpenCode(fx.run, fx.env, abort.signal, Date.now() + 5000, fx.installOptions);
      assert.equal(tx.result.cancelled, true, phase); assert.equal(tx.result.cleanupConfirmed, true);
      assert.equal(managedCli(fx.env), null);
      if (existsSync(managedRoot(fx.env)!)) assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
    } finally { await fx.close(); }
  }
});

test("OpenCode install owns synchronous admission, shutdown drain and retained cleanup lock", async (t) => {
  let releaseProbe!: () => void, started!: () => void, confirmed = false;
  const entered = new Promise<void>((done) => { started = done; }), waiting = new Promise<void>((done) => { releaseProbe = done; });
  const fx = await installFixture(t, { run: async (bin) => {
    if (bin === "opencode") return { code: 127, stdout: "", stderr: "" };
    started(); await waiting; return ok("1.19.5", { cleanupConfirmed: confirmed, retryCleanup: async () => confirmed });
  } });
  try {
    const pending = fx.service.installCli(fx.request), rejected = assert.rejects(pending);
    assert.equal(fx.installer.busy, true);
    await assert.rejects(fx.service.installCli({ ...fx.request, requestId: "second" }), /still active/);
    await entered;
    let settled = false; const drain = fx.installer.drain().then((value) => { settled = true; return value; });
    await new Promise((done) => setImmediate(done)); assert.equal(settled, false, "shutdown waits for the owned operation");
    releaseProbe(); await rejected; assert.equal(await drain, false); assert.equal(fx.installer.busy, true);
    confirmed = true;
    await fx.service.cancelCliInstall({ type: "cancelCliInstall", requestId: "cancel", cli: "opencode", installRequestId: fx.request.requestId });
    assert.equal(fx.installer.busy, false); assert.equal(managedCli(fx.env), null);
  } finally { releaseProbe(); await fx.close(); }
});

test("cancellation while the executable stream is open stops extraction and removes only the candidate", async (t) => {
  const abort = new AbortController(), fx = await installFixture(t, { bytes: zipBytes([{ name: "opencode.exe", body: Buffer.alloc(1024 * 1024, 65) }]) });
  const create = fs.createWriteStream;
  let opened = false;
  const streamSpy = t.mock.method(fs, "createWriteStream", (path, options) => {
    const stream = create(path, options);
    if (String(path).endsWith("opencode.exe")) stream.once("open", () => { opened = true; abort.abort(); });
    return stream;
  });
  syncBuiltinESMExports();
  try {
    const tx = await installOpenCode(fx.run, fx.env, abort.signal, Date.now() + 5000, fx.installOptions);
    assert.equal(opened, true, "the real extraction write boundary must be FOUND");
    assert.equal(tx.result.cancelled, true); assert.equal(tx.result.cleanupConfirmed, true);
    assert.equal(fx.calls.length, 0); assert.deepEqual(readdirSync(managedRoot(fx.env)!), []);
  } finally { streamSpy.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
});

test("expanded-size and expected-executable guards fail before creating an output file", async (t) => {
  const fx = await installFixture(t);
  try {
    for (const entries of [[{ name: "opencode.exe", declared: EXPANDED_LIMIT + 1 }], [{ name: "other.exe" }]]) {
      const path = join(fx.root, "archive.zip"); writeFileSync(path, zipBytes(entries));
      await assert.rejects(extractExecutable(path, fx.root, new AbortController().signal), ReleaseFailure);
      assert.equal(existsSync(join(fx.root, "opencode.exe")), false, "declared oversized entries must not reach the writer");
    }
  } finally { await fx.close(); }
});

test("actual streamed bytes are bounded before disk writes even when Content-Length claims the declared size", async (t) => {
  const bytes = zipBytes(), row = release("1.19.5", bytes); row.assets[0].size = 1;
  const fx = await installFixture(t, { transport: async (url) => url.includes("api.github") ? Response.json([row]) : new Response(bytes, { headers: { "content-length": "1" } }) });
  const open = fsp.open; let written = 0;
  const openSpy = t.mock.method(fsp, "open", async (path, flags, mode) => {
    const file = await open(path, flags, mode);
    if (String(path).endsWith("download.zip")) {
      const write = file.writeFile.bind(file);
      t.mock.method(file, "writeFile", async (data, options) => { written += Buffer.byteLength(data as Uint8Array); return write(data, options); });
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, Date.now() + 5000, fx.installOptions);
    assert.notEqual(tx.result.code, 0); assert.equal(written, 0, "the excess bytes must be rejected before writing");
    assert.equal(fx.calls.length, 0); assert.equal(managedCli(fx.env), null);
  } finally { openSpy.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
});
