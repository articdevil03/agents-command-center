// Proves the discovery parsers against REAL captured CLI output (guard 4:
// "a pure parser over captured real CLI output"), and the call site
// (discoverClaudeEffort/discoverOpencodeModels) against an injected fake
// async spawn -- never the real claude/opencode binaries, so this suite never
// depends on what happens to be installed on the machine running it.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setCliSkipFolders, spawnTrackedClaude, windowsTaskkillPath } from "../server/leader-common.ts";
import {
  parseClaudeEffortLevels, parseOpencodeModels, discoverClaudeEffort, discoverOpencodeModels,
  parseSupportedModels, discoverClaudeModels,
} from "../server/cli-discovery.ts";

// Captured verbatim from a real `claude --help` run (2026-09-08): the
// --effort option wraps across two lines before its choices appear.
const REAL_CLAUDE_HELP_EFFORT_BLOCK =
  `  --effort <level>                      Effort level for the current session\n` +
  `                                        (low, medium, high, xhigh, max)\n` +
  `  --environment <environment_id>        Create a new cloud session that runs on`;

// Captured verbatim from a real `opencode models` run (2026-09-08), trimmed
// to a representative slice -- one model id per line, nothing else.
const REAL_OPENCODE_MODELS_OUTPUT =
  "opencode/big-pickle\nopencode/claude-opus-5\nopencode/gpt-6-astra\nopencode/glm-5.2\nopencode/qwen3.6-plus\n";

test("parseClaudeEffortLevels: extracts the real five choices from a real captured --help block", () => {
  assert.deepEqual(parseClaudeEffortLevels(REAL_CLAUDE_HELP_EFFORT_BLOCK), ["low", "medium", "high", "xhigh", "max"]);
});

test("parseClaudeEffortLevels: a --help output with no --effort line at all returns null, never a guess", () => {
  assert.equal(parseClaudeEffortLevels("Usage: claude [options]\n  --model <model>  Model for the session"), null);
});

test("parseClaudeEffortLevels: an --effort line with an empty parenthetical returns null", () => {
  assert.equal(parseClaudeEffortLevels("--effort <level> Effort level ()"), null);
});

test("parseOpencodeModels: one model id per line, blank lines dropped", () => {
  assert.deepEqual(parseOpencodeModels(REAL_OPENCODE_MODELS_OUTPUT), [
    "opencode/big-pickle", "opencode/claude-opus-5", "opencode/gpt-6-astra", "opencode/glm-5.2", "opencode/qwen3.6-plus",
  ]);
});

test("parseOpencodeModels: empty/whitespace-only output returns null, never an empty picker", () => {
  assert.equal(parseOpencodeModels(""), null);
  assert.equal(parseOpencodeModels("   \n  \n"), null);
});

// Item 1 (P1): discovery output is a subprocess's stdout, not trusted input.
// A line shaped like shell syntax must never survive into the parsed list --
// it would otherwise reach OPENCODE_MODEL_SUGGESTIONS and be assigned
// straight into a seat's model field by applySeatKindUpdate's cascade,
// unvalidated, on the way to a `shell: true` command line.
test("parseOpencodeModels: a line carrying shell metacharacters (poisoned discovery output) is dropped, not passed through", () => {
  const poisoned = "opencode/claude-sonnet-5\nbad & echo INJECTED\nopencode/glm-5.2\n";
  assert.deepEqual(parseOpencodeModels(poisoned), ["opencode/claude-sonnet-5", "opencode/glm-5.2"]);
});

test("parseOpencodeModels: a line with no provider/model slash is dropped (item 3: not a real opencode model id)", () => {
  assert.deepEqual(parseOpencodeModels("opencode/glm-5.2\ngpt-6-astra\nsonnet\n"), ["opencode/glm-5.2"]);
});

test("parseOpencodeModels: entirely poisoned/malformed output returns null (the honest fallback), never an empty picker", () => {
  assert.equal(parseOpencodeModels("bad & echo INJECTED\nnot-a-model-either\n"), null);
});

// ---- call site: never the real binaries, an injected fake async spawn ----

type FakeProc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };

function fakeSpawn(stdout: string | null, status = 0) {
  return (() => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout, "utf8"));
      proc.emit("close", stdout === null ? 1 : status);
    });
    return proc;
  }) as any;
}

test("discoverClaudeEffort: a real parse success reports fallback:false with the parsed values", async () => {
  const result = await discoverClaudeEffort(["low", "medium", "high"], fakeSpawn(REAL_CLAUDE_HELP_EFFORT_BLOCK));
  assert.deepEqual(result, { values: ["low", "medium", "high", "xhigh", "max"], fallback: false });
});

test("discoverClaudeEffort: a missing/broken CLI (empty stdout) degrades to the fallback list, marked as such -- never an empty picker", async () => {
  const result = await discoverClaudeEffort(["low", "medium", "high"], fakeSpawn(null));
  assert.deepEqual(result, { values: ["low", "medium", "high"], fallback: true });
});

test("discoverClaudeEffort: a non-zero exit also degrades to the fallback, even with stdout present", async () => {
  const result = await discoverClaudeEffort(["low", "medium", "high"], fakeSpawn(REAL_CLAUDE_HELP_EFFORT_BLOCK, 1));
  assert.deepEqual(result, { values: ["low", "medium", "high"], fallback: true });
});

test("discoverClaudeEffort: a spawn that throws outright still degrades cleanly, never crashes the caller", async () => {
  const throwing = (() => { throw new Error("ENOENT"); }) as any;
  assert.deepEqual(await discoverClaudeEffort(["low", "medium", "high"], throwing), { values: ["low", "medium", "high"], fallback: true });
});

test("discoverClaudeEffort: a spawn that emits an error event (not a throw) still degrades cleanly", async () => {
  const erroring = (() => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
    return proc;
  }) as any;
  assert.deepEqual(await discoverClaudeEffort(["low", "medium", "high"], erroring), { values: ["low", "medium", "high"], fallback: true });
});

// Exercise both public discovery paths, including the timeout's tree-kill call.
for (const discover of [discoverClaudeEffort, discoverOpencodeModels]) {
  for (const killFailure of ["none", "throw", "error"]) {
    test(`${discover.name}: timeout targets the CLI process tree (${killFailure})`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const proc = Object.assign(new EventEmitter(), {
        pid: 4321, stdout: new EventEmitter(),
        kill: () => assert.fail("killing only the shell leaves the CLI orphaned"),
      });
      const calls: unknown[][] = [];
      const hanging = ((...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) return proc;
        if (killFailure === "throw") throw new Error("taskkill spawn failed");
        const killer = new EventEmitter();
        if (killFailure === "error") queueMicrotask(() => killer.emit("error", new Error("ENOENT")));
        // Even a successful-looking late close must retain fallback.
        proc.stdout.emit("data", Buffer.from("opencode/model\n--effort <level> (low, high)"));
        proc.emit("close", 0);
        return killer;
      }) as any;
      const result = discover(["fallback"], hanging);
      t.mock.timers.tick(10_000);
      assert.deepEqual(await result, { values: ["fallback"], fallback: true });
      assert.deepEqual(calls[1], [windowsTaskkillPath(), ["/pid", "4321", "/T", "/F"], { windowsHide: true }], "absolute System32 path, no shell (an args array with a shell is deprecated, DEP0190)");
      assert.equal(calls.length, 2);
    });
  }
}

test("discoverOpencodeModels: a real parse success reports fallback:false with the parsed values", async () => {
  const result = await discoverOpencodeModels(["opencode/fallback"], fakeSpawn(REAL_OPENCODE_MODELS_OUTPUT));
  assert.deepEqual(result, {
    values: ["opencode/big-pickle", "opencode/claude-opus-5", "opencode/gpt-6-astra", "opencode/glm-5.2", "opencode/qwen3.6-plus"],
    fallback: false,
  });
});

test("discoverOpencodeModels: a missing/broken CLI degrades to the fallback list, marked as such", async () => {
  const result = await discoverOpencodeModels(["opencode/fallback"], fakeSpawn(null));
  assert.deepEqual(result, { values: ["opencode/fallback"], fallback: true });
});

test("discoverOpencodeModels: poisoned output (shell metacharacters, no real model line survives) degrades to the fallback (item 1)", async () => {
  const result = await discoverOpencodeModels(["opencode/fallback"], fakeSpawn("bad & echo INJECTED\n"));
  assert.deepEqual(result, { values: ["opencode/fallback"], fallback: true });
});

// ---- claude's own model list: parseSupportedModels (pure) + discoverClaudeModels (call site) ----

// Captured verbatim (fields trimmed to what parseSupportedModels reads) from
// a real Query.supportedModels() response, 2026-09-09.
const REAL_SUPPORTED_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "..." },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "..." },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "..." },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true, description: "..." },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];

test("parseSupportedModels: extracts value/displayName/supportsEffort from a real captured response, including Fable", () => {
  assert.deepEqual(parseSupportedModels(REAL_SUPPORTED_MODELS), [
    { value: "default", displayName: "Default (recommended)", supportsEffort: false },
    { value: "opus[1m]", displayName: "Opus (1M context)", supportsEffort: false },
    { value: "claude-fable-5-1[1m]", displayName: "Fable", supportsEffort: false },
    { value: "sonnet", displayName: "Sonnet", supportsEffort: true },
    { value: "haiku", displayName: "Haiku", supportsEffort: false },
  ]);
});

test("parseSupportedModels: not an array (a rejected/malformed control response) returns null, never a guess", () => {
  assert.equal(parseSupportedModels(null), null);
  assert.equal(parseSupportedModels(undefined), null);
  assert.equal(parseSupportedModels("nope"), null);
});

test("parseSupportedModels: entries missing a real string value are dropped; an entirely empty result returns null", () => {
  assert.equal(parseSupportedModels([{ displayName: "no value" }, { value: "" }, null, 42]), null);
});

test("parseSupportedModels: a missing displayName falls back to the value itself, never blank", () => {
  assert.deepEqual(parseSupportedModels([{ value: "sonnet" }]), [{ value: "sonnet", displayName: "sonnet", supportsEffort: false }]);
});

function fakeQueryHandle(models, { rejects = false } = {}) {
  return {
    supportedModels: () => (rejects ? Promise.reject(new Error("control request failed")) : Promise.resolve(models)),
    return: () => Promise.resolve(),
  };
}

test("discoverClaudeModels: no resolved CLI path means nothing to ask -- immediate fallback, queryFn never invoked", async () => {
  let called = false;
  const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
  const result = await discoverClaudeModels(fallback, null, () => { called = true; return fakeQueryHandle([]); });
  assert.deepEqual(result, { values: fallback, fallback: true });
  assert.equal(called, false, "a null cliPath must never spawn a real Query");
});

test("discoverClaudeModels: a Claude CLI inside any workspace folder is never started -- one log line, fallback, queryFn never invoked", async () => {
  const original = console.error; const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  setCliSkipFolders(() => ["C:/other-project", "C:/work/project-b"]);
  try {
    let called = false;
    const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
    const inside = await discoverClaudeModels(fallback, "C:/work/project-b/tools/claude.exe", () => { called = true; return fakeQueryHandle([]); });
    assert.deepEqual(inside, { values: fallback, fallback: true });
    assert.equal(called, false, "a CLI inside a project folder must never reach the SDK");
    assert.equal(logged.length, 1, JSON.stringify(logged));
    assert.match(logged[0], /Claude model discovery skipped/);
    const outside = await discoverClaudeModels([], "C:/elsewhere/claude.exe", () => { called = true; return fakeQueryHandle(REAL_SUPPORTED_MODELS); });
    assert.equal(outside.fallback, false, "a CLI outside every folder still discovers");
    assert.equal(called, true);
  } finally { setCliSkipFolders(() => []); console.error = original; }
});

test("discoverClaudeModels: a real parse success reports fallback:false with the parsed values", async () => {
  const result = await discoverClaudeModels([], "C:/fake/claude.exe", () => fakeQueryHandle(REAL_SUPPORTED_MODELS));
  assert.deepEqual(result, {
    values: [
      { value: "default", displayName: "Default (recommended)", supportsEffort: false },
      { value: "opus[1m]", displayName: "Opus (1M context)", supportsEffort: false },
      { value: "claude-fable-5-1[1m]", displayName: "Fable", supportsEffort: false },
      { value: "sonnet", displayName: "Sonnet", supportsEffort: true },
      { value: "haiku", displayName: "Haiku", supportsEffort: false },
    ],
    fallback: false,
  });
});

test("discoverClaudeModels: supportedModels() rejecting degrades to the fallback, never throws", async () => {
  const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
  const result = await discoverClaudeModels(fallback, "C:/fake/claude.exe", () => fakeQueryHandle([], { rejects: true }));
  assert.deepEqual(result, { values: fallback, fallback: true });
});

test("discoverClaudeModels: an empty/unparseable supportedModels() result degrades to the fallback -- never an empty picker", async () => {
  const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
  const result = await discoverClaudeModels(fallback, "C:/fake/claude.exe", () => fakeQueryHandle([]));
  assert.deepEqual(result, { values: fallback, fallback: true });
});

test("discoverClaudeModels: queryFn throwing synchronously (a spawn failure) degrades cleanly, never crashes the caller", async () => {
  const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
  const result = await discoverClaudeModels(fallback, "C:/fake/claude.exe", () => { throw new Error("ENOENT"); });
  assert.deepEqual(result, { values: fallback, fallback: true });
});

test("discoverClaudeModels: a hung Query (never resolves) times out at 10s, degrades to the fallback, and tears the handle down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fallback = [{ value: "fallback", displayName: "Fallback", supportsEffort: true }];
  let returned = false;
  const handle = { supportedModels: () => new Promise(() => {}), return: () => { returned = true; return Promise.resolve(); } };
  const resultP = discoverClaudeModels(fallback, "C:/fake/claude.exe", () => handle);
  t.mock.timers.tick(10_000);
  assert.deepEqual(await resultP, { values: fallback, fallback: true });
  assert.equal(returned, true, "a timed-out Query must be torn down (return()), never left running");
});

test("discoverClaudeModels: the probe's claude.exe is started through the tracked spawn, so aborting it also ends what it started", async (t) => {
  process.env.CC_APP_KEY = "secret-app-key"; process.env.CC_DATA_DIR = "C:/private/data";
  t.after(() => { delete process.env.CC_APP_KEY; delete process.env.CC_DATA_DIR; });
  let seen: any;
  const result = await discoverClaudeModels([], "C:/fake/claude.exe", (args: any) => { seen = args.options; return fakeQueryHandle(REAL_SUPPORTED_MODELS); });
  assert.equal(result.fallback, false);
  assert.equal(seen.spawnClaudeCodeProcess, spawnTrackedClaude);
  assert.equal(seen.pathToClaudeCodeExecutable, "C:/fake/claude.exe");
  assert.equal(Object.hasOwn(seen.env, "CC_APP_KEY"), false, "the probe never sees the app key");
  assert.equal(Object.hasOwn(seen.env, "CC_DATA_DIR"), false, "nor the private data root");
});
