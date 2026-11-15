import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import { installFixture, release, zipBytes } from "./pack29-opencode-install.setup.ts";
import { createKeyRunner, checkKeyCredentials } from "../server/settings/opencode/key.ts";
import { selectRelease, operationSignal, ReleaseFailure } from "../server/settings/opencode/releases.ts";
import { installOpenCode } from "../server/settings/opencode/install.ts";
import { setEnv } from "./temp-root.ts";
import { keyFixture, begin, KEY, until } from "./pack29-opencode-key.setup.ts";
import { extractExecutable } from "../server/settings/opencode/archive.ts";
import { editorTestMs, J, withPage, skipped, click, deliver } from "./pack18-editor-harness.ts";
import { showFirstRun, catalogChange, signInPolicy, sentSince, sentCount } from "./pack29-onboarding-page.setup.ts";
import { toToolStep } from "./pack29-onboarding-page-acp.setup.ts";

test("incomplete pagination with a valid selected candidate still fails explicitly at page 50", async (t) => {
  const fx = await installFixture(t);
  let pages = 0;
  try {
    await assert.rejects(selectRelease(async () => {
      pages++;
      const rows = [release(`1.1.${pages}`), ...Array.from({ length: 99 }, () => release("2.0.0"))];
      return Response.json(rows);
    }, new AbortController().signal, "x64"), ReleaseFailure);
    assert.equal(pages, 50, "pagination cap FOUND with a valid candidate");
  } finally { await fx.close(); }
});

test("an already aborted operation never creates a signal or begins metadata work", () => {
  const abort = new AbortController(); abort.abort(new Error("synthetic cancellation"));
  assert.throws(() => operationSignal(abort.signal, Date.now() + 10000), /synthetic cancellation/);
});

test("direct installation cannot return a successful transaction for unknown or major-two candidates", async (t) => {
  for (const version of ["unrecognized", "2.0.0"]) {
    const fx = await installFixture(t, { version });
    try {
      const tx = await installOpenCode(fx.run, fx.env, new AbortController().signal, Date.now() + 5000, fx.installOptions);
      try { assert.notEqual(tx.result.code, 0, version); assert.equal(tx.commit, undefined); }
      finally { await tx.rollback?.(); }
    } finally { await fx.close(); }
  }
});

test("runner credential checks reject unsupported, unknown and environment sources before a server exists", async (t) => {
  const fx = await installFixture(t);
  try {
    for (const [version, auth, expected, count] of [
      ["2.0.0", "0 credentials", "unsupportedVersion", 1],
      ["unrecognized", "0 credentials", "unsupportedVersion", 1],
      ["1.2.3", "unrecognized", "credentialUnknown", 2],
      ["1.2.3", "0 credentials\nEnvironment\nOpenCode", "environmentCredentials", 2],
      ["1.2.3", "1 credentials", "existingCredentials", 2],
    ] as const) {
      const calls: string[][] = [];
      await assert.rejects(checkKeyCredentials(async (_bin, args) => {
        calls.push(args); return { code: 0, stdout: args[0] === "--version" ? version : auth, stderr: "" };
      }, fx.env, false, new AbortController().signal, 1000), new RegExp(expected));
      assert.equal(calls.length, count, expected + ": probe boundary FOUND");
    }
    assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { await fx.close(); }
});

test("default key spawn gates have independent throwing spawn and fetch backstops for host and injected flags", async (t) => {
  const fx = await installFixture(t);
  const restore = setEnv({ CC_TEST_FAKE_CLI: undefined });
  writeFileSync(join(fx.bin, "opencode.exe"), "inert, never executable");
  try {
    for (const source of ["host", "injected"]) {
      process.env.CC_TEST_FAKE_CLI = source === "host" ? "1" : "";
      const runner = createKeyRunner({ run: async (_bin, args) => ({ code: 0, stdout: args[0] === "--version" ? "1.2.3" : "0 credentials", stderr: "" }) });
      const result = await runner({ env: { ...fx.env, CC_TEST_FAKE_CLI: source === "injected" ? "1" : "" },
        signal: new AbortController().signal, apiKey: KEY, replace: false, timeoutMs: 1000 });
      assert.equal(result.saved, false); assert.equal((result as any).reason, "launchFailed");
      assert.equal(fx.spawned.mock.callCount(), 0, source + ": zero far-boundary spawns");
      assert.equal(fx.fetched.mock.callCount(), 0, source + ": zero far-boundary fetches");
    }
  } finally { restore(); await fx.close(); syncBuiltinESMExports(); }
});

test("setup action gates independently block the native runner even when its own second gate is replaced by a recording fake", async (t) => {
  const fx = await installFixture(t), calls: any[] = [];
  const restore = setEnv({ CC_TEST_FAKE_CLI: "" });
  (globalThis as any).__o4NativeRunner = async (...args: any[]) => { calls.push(args); return { code: -1, stdout: "", stderr: "", cleanupConfirmed: true }; };
  let found = 0;
  const hook = registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (!url.includes("/server/settings/setup-actions.ts?o4-gates")) return result;
    const source = String(result.source), seam = "const defaultRun = createCliRunner(undefined, env);";
    assert.equal(source.split(seam).length, 2, "native runner seam FOUND exactly once"); found++;
    return { ...result, source: source.replace(seam, "const defaultRun = (globalThis as any).__o4NativeRunner;") };
  } });
  try {
    const { createSetupActions } = await import("../server/settings/setup-actions.ts?o4-gates");
    assert.equal(found, 1);
    for (const source of ["host", "injected"]) {
      process.env.CC_TEST_FAKE_CLI = source === "host" ? "1" : "";
      const env = { ...fx.env, CC_TEST_FAKE_CLI: source === "injected" ? "1" : "" };
      const actions = createSetupActions({ dataRoot: fx.data }, fx.service.state, env, () => {});
      try {
        calls.length = 0;
        await actions.run("qwen", ["--version"], { timeoutMs: 1000, installer: { signal: new AbortController().signal } });
        assert.deepEqual(calls, [], source + ": installer wrapper blocks the native boundary independently");
        await actions.run("qwen", ["--version"], { timeoutMs: 1000 });
        assert.deepEqual(calls, [], source + ": probes select the test runner independently");
      } finally { await actions.login.drain(); await actions.installer.drain(); }
    }
    assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { hook.deregister(); delete (globalThis as any).__o4NativeRunner; restore(); await fx.close(); }
});

// This fake never delegates to fetch or spawn. Its only origin is fixed loopback;
// outer throwing spies remain installed by installFixture under every mutation.
async function boundedRunner(t: any, mode: string) {
  const fx = await installFixture(t), calls: string[] = [];
  writeFileSync(join(fx.bin, "opencode.exe"), "inert fixture");
  let child: any, sweeps = 0;
  const runner = createKeyRunner({
    run: async (_bin, args) => ({ code: 0, stdout: args[0] === "--version" ? "1.2.3" : "0 credentials", stderr: "" }),
    spawn: (() => {
      child = Object.assign(new EventEmitter(), { pid: 987654, stdout: new PassThrough(), stderr: new PassThrough() });
      setImmediate(() => child.stdout.write("opencode server listening on http://127.0.0.1:43210\n"));
      return child;
    }) as any,
    tree: (() => ({ failed: 0, sweep: async () => {
      sweeps++; child.emit("exit", 0); child.emit("close", 0); child.stdout.end(); child.stderr.end();
      return mode === "unclean" ? null : 0;
    } })) as any,
    fetch: (async (url: string, init: any) => {
      const address = new URL(url); assert.equal(address.origin, "http://127.0.0.1:43210");
      assert.equal(init.redirect, "manual"); calls.push(address.pathname);
      if (mode === "error") throw new Error(KEY);
      if (address.pathname === "/global/health") return new Response((mode === "oversize" ? " ".repeat(1024 * 1024) : "") + JSON.stringify({ healthy: true, version: "1.2.3" }));
      if (!init.headers.authorization) return new Response("{}", { status: 401 });
      if (address.pathname === "/provider") return Response.json({ connected: ["opencode-go"] });
      return Response.json(true);
    }) as typeof fetch,
  });
  try {
    const result = await runner({ env: fx.env, signal: new AbortController().signal, apiKey: KEY, replace: false, timeoutMs: 2000 });
    assert.equal(result.saved, false, mode + ": cannot report success");
    assert.equal(JSON.stringify(result).includes(KEY), false, "no raw synthetic key in runner outcome");
    if (mode === "oversize") assert.deepEqual(calls, ["/global/health"], "response cap stops before any credential PUT");
    assert.equal(result.cleanupConfirmed, mode !== "unclean");
    assert.equal(sweeps, 1, "one owned fake tree sweep FOUND");
    assert.equal(fx.spawned.mock.callCount(), 0); assert.equal(fx.fetched.mock.callCount(), 0);
  } finally { await fx.close(); }
}
for (const mode of ["oversize", "unclean", "error"]) test("runner outcome guard: " + mode, async (t) => boundedRunner(t, mode));

test("expanded byte guard stops output bytes before the writer even when final size validation also fails", async (t) => {
  const fx = await installFixture(t);
  try {
    const archive = join(fx.root, "archive.zip");
    writeFileSync(archive, zipBytes([{ name: "opencode.exe", body: Buffer.from("inert excess bytes"), declared: 1 }]));
    await assert.rejects(extractExecutable(archive, fx.root, new AbortController().signal));
    assert.equal(statSync(join(fx.root, "opencode.exe")).size, 0, "excess expanded bytes never reach disk");
  } finally { await fx.close(); }
});

test("capability status and waiting phase each reject a request before consuming its key", async (t) => {
  for (const field of ["status", "phase"]) {
    const fx = await keyFixture(t);
    try {
      const pending = fx.service.cliLogin(begin(), fx.send), stopped = pending.catch(() => {});
      await until(() => fx.events.at(-1)?.phase === "waitingKey");
      const op = (fx.service.login as any).active;
      assert.ok(op?.capability && op.acceptKey, "owned waiting operation FOUND");
      if (field === "status") {
        op.event.status = "done";
        await assert.rejects(fx.service.cliLogin(fx.request("getCliLoginState"), fx.send), /already running/);
      } else {
        op.event.phase = "verifying";
        await assert.rejects(fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send), /not waiting/);
      }
      assert.equal(fx.spawns.length, 0);
      await fx.service.login.drain(); await stopped;
    } finally { await fx.close(); }
  }
});

test("waiting-key consumption removes the accept callback synchronously before the runner resumes", async (t) => {
  const fx = await keyFixture(t);
  try {
    const pending = fx.service.cliLogin(begin(), fx.send);
    await until(() => fx.events.at(-1)?.phase === "waitingKey");
    const submitted = fx.service.cliLogin(fx.request("submitCliLoginKey", { apiKey: KEY }), fx.send);
    const active = (fx.service.login as any).active;
    assert.ok(active, "active operation FOUND"); assert.equal(active.acceptKey, undefined);
    assert.equal(active.event.phase, "verifying");
    await submitted; await pending;
  } finally { await fx.close(); }
});

test("real masked-key Enter listener cancels default wizard navigation and stops propagation", { timeout: editorTestMs(120000) }, async (t) => {
  if (skipped(t)) return;
  await withPage(async ({ ev, seed }) => {
    const tools = { claude: [false, null], codex: [false, null], opencode: [true, false] } as const;
    const facts = { installed: true, version: "1.2.3", supportedVersion: true, signedIn: false, credentialSource: "none" };
    const extra = signInPolicy(["opencode"]) + catalogChange({ opencode: facts });
    await showFirstRun(ev, seed, tools, extra); await toToolStep(ev, "C:\\work\\O4");
    const mark = await sentCount(ev); await click(ev, '[data-frun-login="opencode"]');
    const [request] = await sentSince(ev, "cliLogin", mark); assert.ok(request, "real Sign in listener FOUND");
    await showFirstRun(ev, seed, tools, extra + catalogChange({ opencode: { ...facts, action: { kind: "login", requestId: request.requestId, status: "running", phase: "waitingKey" } } }));
    await deliver(ev, { type: "cliLoginState", cli: "opencode", loginRequestId: request.requestId, loginId: "a".repeat(48),
      revision: 1, status: "running", phase: "waitingKey", verificationUrl: "https://opencode.ai/auth", pasteRequired: false });
    await deliver(ev, { type: "cliLoginState", cli: "opencode", loginRequestId: request.requestId, loginId: "a".repeat(48),
      revision: 0, status: "running", phase: "verifying" });
    assert.equal(await ev("cliLoginUi.viewOf('opencode').phase"), "waitingKey", "stale revision cannot change the active phase");
    const result = await ev(`(()=>{const input=document.querySelector('#frunTools [data-cli="opencode"] .cli-login input');
      input.value=${J(KEY)};let bubbled=0;const watch=()=>bubbled++;document.addEventListener('keydown',watch);
      const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(event);
      document.removeEventListener('keydown',watch);return {prevented:event.defaultPrevented,bubbled,empty:input.value===''};})()`);
    assert.deepEqual(result, { prevented: true, bubbled: 0, empty: true });
    const cancelled = await ev(`(()=>{const input=document.querySelector('#frunTools [data-cli="opencode"] .cli-login input');
      input.value=${J(KEY)};const original=send;let observed=null;send=(m)=>{if(m.type==='cancelCliLogin')observed=input.value;return original(m)};
      try{cliLoginUi.cancel('opencode')}finally{send=original}return observed})()`);
    assert.equal(cancelled, "", "cancel clears synchronously before the socket boundary");
    const terminal = await ev(`(()=>{const input=document.querySelector('#frunTools [data-cli="opencode"] .cli-login input');input.value=${J(KEY)};
      cliLoginUi.onEvent({type:'cliLoginState',cli:'opencode',loginRequestId:${J(request.requestId)},revision:2,status:'failed',phase:null,loginId:null});
      return input.value})()`);
    assert.equal(terminal, "", "terminal private event clears synchronously before any paint");
  });
});
