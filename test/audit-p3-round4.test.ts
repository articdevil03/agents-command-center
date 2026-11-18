import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

const { modules: { buildLeaderOptions, createCodexLeader, createAcpLeader } } = await importWithTempDataRoot(async () => ({
  buildLeaderOptions: (await import("../server/leader.ts")).buildLeaderOptions,
  createCodexLeader: (await import("../server/leader-codex.ts")).createCodexLeader,
  createAcpLeader: (await import("../server/leader-acp.ts")).createAcpLeader,
}));
const folder = scratchDir();
const privateText = "turn failed in fake POST /private req_SECRET C:/Users/someone";
const authText = "Authentication required POST /private req_SECRET";
const authMessage = (name: string) => `${name} is not signed in. Open Settings and check the tool's sign-in or key settings, then try again.`;

function permissionFixture(root = folder, vault: string | null = null) {
  let asks = 0;
  const options = buildLeaderOptions({ model: "fake", effort: "medium" }, root, null, undefined, "accept", async () => { asks++; return false; }, undefined, undefined, undefined, vault);
  const hook = (tool: string, input: object) => options.hooks!.PreToolUse![0].hooks[0]({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, permission_mode: "acceptEdits",
  } as any, "t", { signal: new AbortController().signal }) as Promise<any>;
  return { hook, asks: () => asks };
}

test("space and tab before tilde ask for Read, Write, Edit and Glob", async () => {
  const f = permissionFixture();
  for (const prefix of [" ", "\t"]) for (const tool of ["Read", "Write", "Edit", "Glob"]) {
    const path = `${prefix}~/private`;
    assert.equal((await f.hook(tool, tool === "Glob" ? { pattern: path } : { file_path: path })).hookSpecificOutput?.permissionDecision, "deny", `${tool}: ${JSON.stringify(path)}`);
  }
  assert.equal(f.asks(), 8);
});

test("absolute project roots containing dollar and percent do not ask; ambiguous descendants and outside paths do", async () => {
  const root = join(folder, "Work$%", "app"), f = permissionFixture(root);
  for (const tool of ["Read", "Write", "Edit"]) assert.deepEqual(await f.hook(tool, { file_path: join(root, "src", "a.ts") }), {});
  assert.deepEqual(await f.hook("Glob", { path: root, pattern: "src/*.ts" }), {});
  assert.equal(f.asks(), 0);
  for (const file_path of ["$HOME/x", "%USERPROFILE%/x", join(folder, "outside$", "a.ts"), join(folder, "outside%", "a.ts"), join(root, "$param.tsx"), "$param.tsx"]) {
    assert.equal((await f.hook("Read", { file_path })).hookSpecificOutput?.permissionDecision, "deny", file_path);
  }
  assert.equal(f.asks(), 6);
});

// No subprocess or vendor executable: exercise the adapters' real JSON-RPC boundary with writable pipes.
function fakeChild(reply: (message: any, emit: (message: any) => void) => void) {
  const child = new ChildProcess();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const emit = (message: any) => child.stdout!.push(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(String(chunk));
    queueMicrotask(() => reply(message, emit)); done();
  } });
  return child;
}

async function failure(kind: "Codex" | "ACP", site: string, raw = privateText, code = -32603): Promise<string[]> {
  const errors: string[] = [];
  let session!: () => void, failed!: () => void;
  const started = new Promise<void>((resolve) => { session = resolve; });
  const ended = new Promise<void>((resolve) => { failed = resolve; });
  const cb = { onDelta() {}, onDone() { assert.fail("failure cannot report success"); }, onUsage() {}, onSession() { session(); }, onError(text: string) { errors.push(text); failed(); } };
  const child = fakeChild((m, emit) => {
    if (m.id === undefined) return;
    if (m.method === "initialize") { emit({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }); return; }
    if (["thread/start", "session/new"].includes(m.method)) {
      if (site === "ready") emit({ id: m.id, error: { code, message: raw } });
      else emit({ id: m.id, result: kind === "Codex" ? { thread: { id: "thread" } } : { sessionId: "session" } });
      return;
    }
    if (m.method === "turn/start") {
      if (site === "turn-start") { emit({ id: m.id, error: { message: raw } }); return; }
      emit({ id: m.id, result: { turn: { id: "turn" } } });
      if (site === "notification") emit({ method: "error", params: { turnId: "turn", error: { message: raw } } });
      else emit({ method: "turn/completed", params: { turn: { id: "turn", status: site, error: { message: raw } } } });
    }
    if (m.method === "session/prompt") emit({ id: m.id, error: { code, message: raw } });
  });
  const spawn = () => {
    if (site === "startText") throw new Error(raw);
    if (site === "spawn") setImmediate(() => child.emit("error", new Error(raw)));
    return child;
  };
  const leader = kind === "Codex"
    ? createCodexLeader({ model: "fake", effort: "medium" }, folder, cb, { tools: [], mode: "accept", ask: async () => false, spawnFn: spawn, startTimeoutMs: 1000 })
    : createAcpLeader({ model: "fake", effort: "medium" }, folder, cb, { cli: { name: "Fake", program: "fake", args: [] }, spawnFn: spawn, startTimeoutMs: 1000 });
  let timer: ReturnType<typeof setTimeout>;
  try {
    if (!["spawn", "ready", "startText"].includes(site)) {
      await started;
      const images = site === "turn-catch" ? { [Symbol.iterator]() { throw new Error(raw); } } as any : [];
      leader.send("hi", images);
    }
    await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`missing failure: ${kind} ${site}`)), 2000); })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, `${kind} ${site}: one failure`);
    assert.doesNotMatch(errors[0], /turn failed in fake|POST|req_SECRET|someone|terminal|PowerShell/);
    return errors;
  } finally { clearTimeout(timer!); leader.stop(); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); }
}

for (const site of ["failed", "interrupted", "notification", "turn-start", "spawn", "ready"]) test(`Codex ${site} has an exact plain failure`, async () => {
  const expected = ["spawn", "ready"].includes(site) ? "Codex could not start. Try again." : `The Codex leader turn ${site === "interrupted" ? "interrupted" : "failed"}. Try again.`;
  assert.deepEqual(await failure("Codex", site), [expected]);
});
for (const site of ["startText", "spawn", "turn-catch", "prompt", "ready"]) test(`ACP ${site} has an exact plain failure`, async () => {
  assert.deepEqual(await failure("ACP", site), [site === "prompt" || site === "turn-catch" ? "Fake could not finish this turn. Try again." : "Fake could not start. Try again."]);
});
for (const kind of ["Codex", "ACP"] as const) test(`${kind} startup auth and limit errors give fixed app remedies`, async () => {
  const name = kind === "Codex" ? "Codex" : "Fake";
  assert.deepEqual(await failure(kind, "ready", authText), [authMessage(name)]);
  for (const raw of ["usage limit reached POST /private", "rate_limit_exceeded req_SECRET", "too many requests req_SECRET"])
    assert.deepEqual(await failure(kind, "ready", raw), [`${name} has reached its usage limit. Try again later.`]);
});

test("trimmed outside absolute and parent paths ask before Read, Write, Edit and Glob", async () => {
  const f = permissionFixture();
  for (const prefix of [" ", "\t"]) for (const raw of [join(folder, "..", "outside", "secret"), "../../outside"]) {
    for (const tool of ["Read", "Write", "Edit"]) {
      const file_path = prefix + raw;
      assert.equal((await f.hook(tool, { file_path })).hookSpecificOutput?.permissionDecision, "deny", tool + JSON.stringify(file_path));
    }
    const pattern = prefix + raw;
    assert.equal((await f.hook("Glob", { pattern })).hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(pattern));
  }
  assert.equal(f.asks(), 16);
});

test("vault root characters are ignored but ambiguous vault descendants still ask", async () => {
  for (const name of ["Notes$", "Notes%"]) {
    const vault = join(folder, name, "vault"), f = permissionFixture(join(folder, "project"), vault);
    for (const tool of ["Read", "Write", "Edit"]) assert.deepEqual(await f.hook(tool, { file_path: " \t" + join(vault, "a.md") }), {});
    assert.deepEqual(await f.hook("Glob", { path: vault, pattern: "*.md" }), {});
    assert.equal(f.asks(), 0);
    assert.equal((await f.hook("Read", { file_path: join(vault, "$param.md") })).hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(f.asks(), 1);
  }
});

for (const site of ["notification", "failed", "turn-start"]) test("Codex " + site + " maps auth and usage remedies", async () => {
  assert.deepEqual(await failure("Codex", site, authText), [authMessage("Codex")]);
  assert.deepEqual(await failure("Codex", site, "usage limit reached POST /private"), ["Codex has reached its usage limit. Try again later."]);
});

test("ACP startup auth code alone gives the sign-in remedy", async () => {
  assert.deepEqual(await failure("ACP", "ready", "boom", -32000), [authMessage("Fake")]);
});

test("ordinary token, path permission and storage failures stay generic", async () => {
  for (const raw of ["invalid token count", "invalid tokenizer config", "Unauthorized to read that path", "disk quota exceeded", "storage quota exceeded", "api storage quota exceeded", "quota exceeded"])
    assert.deepEqual(await failure("ACP", "prompt", raw), ["Fake could not finish this turn. Try again."], raw);
});

test("known authentication and contextual usage messages retain their remedies", async () => {
  for (const raw of ["invalid token", "invalid api key", "missing token", "Unauthorized", "Unauthorised", "HTTP 401 Unauthorized", "not signed in", "not logged in", "sign-in required", "Authentication required"])
    assert.deepEqual(await failure("ACP", "prompt", raw), [authMessage("Fake")], raw);
  for (const raw of ["api quota exceeded", "request quota reached", "quota exceeded for usage", "rate quota exceeded", "insufficient_quota"])
    assert.deepEqual(await failure("ACP", "prompt", raw), ["Fake has reached its usage limit. Try again later."], raw);
});
