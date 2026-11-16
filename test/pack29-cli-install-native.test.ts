import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliRunner } from "../server/settings/cli-runner.ts";
import { SettingsService } from "../server/settings/service.ts";
import { windowsPowerShellPath, windowsSystem32, windowsTaskkillPath } from "../server/leader-common/cli-path.ts";
import { createTreeTracker, listProcesses, setProcessTreeForTests } from "../server/leader-common/process-tree.ts";
import { refreshProcessPath } from "../server/leader-common/path-refresh.ts";
import { fixture, request } from "./pack29-cli-install.setup.ts";

// Real process enumeration and strict production tracker, with no registry writes.
function nativeTracker() {
  return createTreeTracker({ list: () => {
    const cwd = process.cwd(); process.chdir(windowsSystem32());
    try { return listProcesses(); } finally { process.chdir(cwd); }
  }, kill: (pid) => new Promise((done) => {
    const child = spawn(windowsTaskkillPath(), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    child.once("error", () => done(false)); child.once("close", (code) => done(code === 0 || code === 128));
  }), pollMs: 50 });
}
const modes = ["success", "nonzero", "throw", "flood", "absent", "timeout", "cancel", "shutdown"];
test("harmless native PowerShell installer: success, errors, flood, absent CLI, timeout and owned child cleanup", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  for (const mode of modes) {
    console.log(`NATIVE ${mode}`);
    const fx = fixture(), script = join(fx.root, "fake-installer.ps1"), marker = join(fx.root, "child.pid"), errors: unknown[] = [], pids: number[] = [];
    const sleeping = ["cancel", "shutdown", "timeout"].includes(mode);
    const fakeCli = join(fx.bin, "qwen.cmd");
    const childScript = join(fx.root, "sleep.cjs"); writeFileSync(childScript, "setInterval(() => {}, 1000)");
    writeFileSync(script, `$ErrorActionPreference='Stop'\n` +
      (sleeping ? `$child = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${childScript.replaceAll("'", "''")}"' -WindowStyle Hidden -PassThru\n[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', [string]$child.Id)\nStart-Sleep -Seconds 60\n` :
      mode === "throw" ? "throw 'fake failure'\n" : mode === "nonzero" ? "exit 7\n" :
      (mode === "flood" ? "[Console]::Out.Write(('x' * 200000)); [Console]::Error.Write(('y' * 200000))\n" : "") +
      (mode === "absent" ? "exit 0\n" : `[IO.File]::WriteAllText('${fakeCli.replaceAll("'", "''")}', "@echo off\r\necho 1.2.3\r\n")\n`)));
    setProcessTreeForTests(nativeTracker());
    let productionSeen = false;
    const spawnFake = ((bin: string, args: string[], options: any) => {
      if (bin === windowsPowerShellPath() && args.includes("-WindowStyle")) {
        try {
          assert.equal(args.at(-1), "$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex; if (-not $?) { exit 1 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
          assert.deepEqual(args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
          assert.equal(options.cwd, windowsSystem32()); assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.detached, false);
          assert.equal(options.env.CC_APP_KEY, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined);
        } catch (error) { errors.push(error); }
        productionSeen = true;
        const child = spawn(bin, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], options);
        if (child.pid) pids.push(child.pid);
        return child;
      }
      // Only the fixture-created CLI's version check is permitted otherwise.
      assert.equal(bin, fx.env.ComSpec, `Unexpected native process: ${bin}`);
      assert.ok(args.at(-1)?.includes(fakeCli));
      return spawn(bin, args, options);
    }) as typeof spawn;
    const actual = createCliRunner(spawnFake, fx.env);
    fx.env.PATH = "";
    let refreshed = 0;
    const service = new SettingsService({ dataRoot: fx.data, env: fx.env,
      refreshPath: async () => { refreshed++; await refreshProcessPath({ env: fx.env, readRegistryPath: () => productionSeen ? [fx.bin] : [], platform: "win32" }); }, runCli: (bin, args, options) => actual(bin, args,
        mode === "timeout" && options.installer ? { ...options, timeoutMs: 3000 } : options) });
    try {
      const pending = service.installCli(request());
      const caught = pending.then(() => null, (error) => error);
      if (mode === "cancel" || mode === "shutdown") {
        const end = Date.now() + 10_000;
        while (!existsSync(marker) && Date.now() < end) await new Promise((done) => setTimeout(done, 30));
        assert.ok(existsSync(marker), `${mode} child must start`);
        assert.ok((await listProcesses())?.some((row) => row.pid === Number(readFileSync(marker, "utf8"))), "sleeping child must be live before stopping");
        if (mode === "cancel") await service.cancelCliInstall({ type: "cancelCliInstall", requestId: "stop", cli: "qwen", installRequestId: "install1" });
        else assert.equal(await service.installer.drain(), true);
      }
      const error = await caught;
      assert.equal(productionSeen, true); assert.deepEqual(errors, []);
      if (["success", "flood"].includes(mode)) { assert.equal(error, null); assert.equal(service.state.catalogTools.qwen.installed, true); }
      else assert.ok(error, mode);
      const expected = { absent: "notFoundAfterInstall", timeout: "timeout", cancel: "cancelled", shutdown: "cancelled", nonzero: "installFailed", throw: "installFailed" }[mode];
      if (expected) assert.equal(service.state.catalogTools.qwen.action?.reason, expected, mode);
      assert.equal(service.installer.busy, false, mode); assert.equal(refreshed, 2, mode);
      if (existsSync(marker)) pids.push(Number(readFileSync(marker, "utf8")));
      // The process table can lag a moment behind a finished cleanup on a loaded PC: wait up to 5 s for each owned PID to leave it, and still fail if one never does.
      for (const pid of pids) {
        let gone = false;
        for (let tries = 0; tries < 50 && !gone; tries++) { const alive = await listProcesses(); assert.ok(alive); gone = !alive.some((row) => row.pid === pid); if (!gone) await new Promise((done) => setTimeout(done, 100)); }
        assert.equal(gone, true, `Owned PID ${pid} must have ended (${mode})`);
      }
    } finally { setProcessTreeForTests(null); fx.close(); }
  }
});

test("fake npm-cli records fixed argv through external Node without a global install", { skip: process.platform !== "win32" }, async () => {
  const fx = fixture();
  try {
    copyFileSync(process.execPath, join(fx.bin, "node.exe")); fx.write("npm.cmd");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(fx.bin, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(fx.bin, "node_modules", "npm", "package.json"), '{"type":"commonjs"}');
    const record = join(fx.root, "argv.json");
    writeFileSync(join(fx.bin, "node_modules", "npm", "bin", "npm-cli.js"), `if(process.argv[2]==='--version') console.log('11.0.0'); else require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
    setProcessTreeForTests(nativeTracker());
    const { runInstallRecipe } = await import("../server/settings/cli-installers.ts");
    const { catalogTool } = await import("../server/settings/cli-catalog-validation.ts");
    const result = await runInstallRecipe(catalogTool("gemini").recipe!, createCliRunner(spawn, fx.env), fx.env, new AbortController().signal, async () => {});
    assert.equal(result.code, 0); assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), ["install", "-g", "@google/gemini-cli", "--registry=https://registry.npmjs.org"]);
  } finally { setProcessTreeForTests(null); fx.close(); }
});
