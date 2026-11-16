import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLI_CATALOG } from "../server/settings/cli-catalog.ts";
import { checkInstallPrerequisites, INSTALL_OUTPUT_CAP, runInstallRecipe } from "../server/settings/cli-installers.ts";
import { windowsPowerShellPath, windowsSystem32 } from "../server/leader-common/cli-path.ts";
import { setProcessTreeForTests } from "../server/leader-common/process-tree.ts";
import { fixture, injectedRunner } from "./pack29-cli-install.setup.ts";

test("every real catalog recipe dispatches exact fixed argv through production runner", async () => {
  const entries = CLI_CATALOG.filter((entry) => entry.recipe && entry.id !== "opencode" && entry.id !== "copilot");
  assert.ok(entries.length > 0, "catalog recipe list must be found");
  assert.equal(entries.length, 9);
  for (const entry of entries) {
    console.log(`RECIPE ${entry.id} ${entry.recipe!.kind}`);
    const fx = fixture(), calls: any[] = [], errors: unknown[] = [];
    try {
      fx.write("node.exe"); fx.write("npm.cmd"); fx.write("uv.exe");
      mkdirSync(join(fx.bin, "node_modules", "npm", "bin"), { recursive: true });
      writeFileSync(join(fx.bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
      const run = injectedRunner(fx.env, (bin, args, options, proc) => {
        calls.push({ bin, args, options });
        try {
          assert.equal(options.shell, false, entry.id);
          assert.equal(options.windowsHide, true, entry.id);
          assert.equal(options.env.CC_APP_KEY, undefined);
          assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
          if (args[0] === "--version" && basename(bin) === "node.exe") { queueMicrotask(() => proc.end(0, "v24.1.0")); return; }
          if (args[1] === "--version" && basename(bin) === "node.exe") {
            assert.equal(args[0], join(fx.bin, "node_modules", "npm", "bin", "npm-cli.js"));
            queueMicrotask(() => proc.end(0, "11.0.0")); return;
          }
          assert.equal(options.env.OPENAI_API_KEY, undefined);
          assert.equal(options.detached, false);
          assert.equal(options.windowsVerbatimArguments, false);
          assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
          assert.equal(options.cwd, windowsSystem32());
          if (bin === windowsPowerShellPath()) {
            assert.deepEqual(args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
            const recipe = entry.recipe!.kind === "ordered" ? entry.recipe!.steps[0] : entry.recipe!;
            assert.equal(recipe.kind, "powershell");
            if (recipe.kind === "powershell") {
              assert.equal(args.at(-1), `$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; irm ${recipe.url} | iex; if (-not $?) { exit 1 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
              assert.deepEqual(args.slice(5, -2), /(?:-ExecutionPolicy|-ep)\s+Bypass/i.test(recipe.command) ? ["-ExecutionPolicy", "Bypass"] : []);
            }
          } else if (basename(bin) === "node.exe") {
            assert.equal(entry.recipe!.kind, "npm");
            assert.deepEqual(args, [join(fx.bin, "node_modules", "npm", "bin", "npm-cli.js"), "install", "-g", (entry.recipe as any).package, "--registry=https://registry.npmjs.org"]);
          } else if (basename(bin) === "uv.exe") assert.deepEqual(args, ["tool", "install", "mistral-vibe"]);
          else assert.fail(`Unexpected ${entry.id}: ${bin} ${args.join(" ")}`);
        } catch (error) { errors.push(error); }
        queueMicrotask(() => proc.end(0));
      });
      let refreshes = 0;
      if (entry.recipe!.kind === "winget") {
        await assert.rejects(runInstallRecipe(entry.recipe!, run, fx.env, new AbortController().signal, async () => {}), /non-elevated/);
        assert.equal(calls.length, 0, "unqualified WinGet is refused before spawn");
      } else {
        let result: Awaited<ReturnType<typeof runInstallRecipe>>;
        await assert.doesNotReject(async () => { result = await runInstallRecipe(entry.recipe!, run, fx.env, new AbortController().signal, async () => { refreshes++; }); }, entry.id);
        assert.equal(result!.code, 0, entry.id); assert.equal(result!.cleanupConfirmed, true, entry.id);
        assert.ok(calls.length > 0, entry.id);
        assert.equal(refreshes, entry.recipe!.kind === "ordered" ? 1 : 0, entry.id);
      }
      assert.deepEqual(errors, [], `${entry.id}: ${errors.map(String).join(";")}`);
    } finally { fx.close(); }
  }
});
test("installer drains flood but retains at most 64 KiB per stream", async () => {
  const fx = fixture();
  try {
    const run = injectedRunner(fx.env, (_bin, _args, _options, proc) => {
      queueMicrotask(() => proc.end(0, "x".repeat(INSTALL_OUTPUT_CAP * 3), "y".repeat(INSTALL_OUTPUT_CAP * 4)));
    });
    const result = await runInstallRecipe(CLI_CATALOG[0].recipe!, run, fx.env, new AbortController().signal, async () => {});
    assert.equal(Buffer.byteLength(result.stdout), 65536); assert.equal(Buffer.byteLength(result.stderr), 65536);
  } finally { fx.close(); }
});
test("installer cancellation invokes strict tree sweep and preserves uncertainty for retry", async () => {
  const fx = fixture(); let proc: any, strict = false, confirm = false, sweeps = 0;
  setProcessTreeForTests({ watch: () => ({ failed: 0, release() {}, sweep: async (_at, strictArg) => {
    strict = strictArg === true; sweeps++; if (confirm) { proc.end(-1); return 1; } return null;
  } }), flushRegistry() {} });
  try {
    const run = injectedRunner(fx.env, (_bin, _args, _options, child) => { proc = child; child.pid = 887766; });
    const controller = new AbortController();
    const pending = run(windowsPowerShellPath(), [], { timeoutMs: 600_000, cwd: windowsSystem32(), installer: { signal: controller.signal } });
    controller.abort();
    const result = await pending;
    assert.equal(strict, true); assert.equal(sweeps, 1);
    assert.equal(result.cleanupConfirmed, false); assert.equal(result.cancelled, true);
    confirm = true; assert.equal(await result.retryCleanup!(), true); assert.equal(sweeps, 2);
  } finally { setProcessTreeForTests(null); fx.close(); }
});
test("missing prerequisites do not install Node, Git, WinGet or PowerShell", async () => {
  const fx = fixture();
  try {
    const noRun = async () => assert.fail("no process expected");
    for (const id of ["kimi"]) {
      await assert.rejects(checkInstallPrerequisites(CLI_CATALOG.find((entry) => entry.id === id)!, noRun, fx.env), /Git Bash/);
    }
    await assert.rejects(runInstallRecipe(CLI_CATALOG.find((entry) => entry.id === "gemini")!.recipe!, noRun, fx.env, new AbortController().signal, async () => {}), /Node.js/);
    await assert.doesNotReject(checkInstallPrerequisites(CLI_CATALOG.find((entry) => entry.id === "copilot")!, noRun, fx.env));
    fx.write("git.exe");
    await assert.rejects(checkInstallPrerequisites(CLI_CATALOG.find((entry) => entry.id === "kimi")!, noRun, fx.env), /Git Bash/, "git.exe is insufficient");
  } finally { fx.close(); }
});

test("a found launcher returning 127 remains unknown rather than permitting replacement", async () => {
  const fx = fixture();
  try {
    fx.write("qwen.exe");
    const run = injectedRunner(fx.env, (_bin, _args, _options, proc) => queueMicrotask(() => proc.end(127)));
    const result = await run("qwen", ["--version"], { timeoutMs: 8000 });
    assert.equal(result.code, -1, "the launcher exists but is broken");
  } finally { fx.close(); }
});
