import assert from "node:assert/strict";
import { after } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "cc-pack29-flow-"));
function removeOwned(dir: string): void {
  assert.equal(lstatSync(dir).isSymbolicLink(), false, dir);
  for (const name of readdirSync(dir)) {
    const file = join(dir, name), info = lstatSync(file);
    assert.equal(info.isSymbolicLink(), false, file);
    if (info.isDirectory()) removeOwned(file); else unlinkSync(file);
  }
  assert.deepEqual(readdirSync(dir), []); rmdirSync(dir);
}
after(() => removeOwned(root));
const oldData = process.env.CC_DATA_DIR, oldPackaged = process.env.CC_TEST_FORCE_PACKAGED;
process.env.CC_DATA_DIR = root; process.env.CC_TEST_FORCE_PACKAGED = "1";
const { windowsPowerShellPath, windowsSystem32, windowsTaskkillPath } = await import("../server/leader-common/cli-path.ts");
const { createTreeTracker, listProcesses, setProcessTreeForTests } = await import("../server/leader-common/process-tree.ts");
const { refreshProcessPath } = await import("../server/leader-common/path-refresh.ts");
const { createCliRunner } = await import("../server/settings/cli-runner.ts");
const { SettingsService } = await import("../server/settings/service.ts");
export const api = {
  config: await import("../server/config.ts"), state: await import("../server/main/state.ts"),
  messages: await import("../server/main/messages/index.ts"), broadcast: await import("../server/main/broadcast.ts"),
  ChatStore: (await import("../server/chat-store.ts")).ChatStore,
  RequestsStore: (await import("../server/requests.ts")).RequestsStore,
  fixedCatalogue: (await import("../server/main/fixed-crew.ts")).fixedCatalogue,
  createTabLeader: (await import("../server/main/leader-session.ts")).createTabLeader,
};
if (oldPackaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = oldPackaged;
if (oldData === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = oldData;

function tracker() {
  return createTreeTracker({ list: () => {
    const cwd = process.cwd(); process.chdir(windowsSystem32());
    try { return listProcesses(); } finally { process.chdir(cwd); }
  }, kill: (pid) => new Promise((done) => {
    const proc = spawn(windowsTaskkillPath(), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    proc.once("error", () => done(false)); proc.once("close", (code) => done(code === 0 || code === 128));
  }), pollMs: 50 });
}
const quote = (value: string) => value.replaceAll("'", "''");
const urls = {
  kimi: "https://code.kimi.com/kimi-code/install.ps1",
  qwen: "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1",
};

export function flowFixture(id: "kimi" | "qwen") {
  const folder = mkdtempSync(join(root, `${id}-`)), bin = join(folder, "bin"), data = join(folder, "data");
  mkdirSync(bin); mkdirSync(data);
  const cwd = process.cwd(), pathBefore = process.env.PATH;
  process.chdir(data);
  const fakeCli = join(bin, `${id}.cmd`), bash = join(bin, "bash.exe"), script = join(folder, "installer.ps1");
  writeFileSync(bash, "fixture shell, intercepted before execution");
  writeFileSync(script, `$ErrorActionPreference='Stop'\n[IO.File]::WriteAllText('${quote(fakeCli)}', "@echo off\r\necho 1.2.3\r\n")\n`);
  const env = { PATH: "", SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, USERPROFILE: folder,
    HOME: folder, TEMP: folder, TMP: folder, KIMI_CODE_GIT_BASH_PATH: bash };
  const errors: unknown[] = [], pids: number[] = [], phases: string[] = [], refreshes: string[] = [];
  let installed = false, prerequisite = false;
  setProcessTreeForTests(tracker());
  const native = createCliRunner(((program: string, args: string[], options: any) => {
    let command = args;
    if (program === bash) {
      assert.deepEqual(args, ["--version"]); prerequisite = true;
      return spawn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", "'GNU bash 5.0'"], options);
    }
    if (args.includes("-WindowStyle")) {
      try {
        assert.equal(program, windowsPowerShellPath());
        assert.deepEqual(args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
        assert.equal(args.at(-1), `$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; irm ${urls[id]} | iex; if (-not $?) { exit 1 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
        assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.detached, false);
        assert.equal(options.cwd, windowsSystem32());
        if (id === "kimi") assert.equal(prerequisite, true, "Git Bash must be checked first");
      } catch (error) { errors.push(error); }
      command = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script];
      installed = true;
    } else {
      assert.equal(program, env.ComSpec, `unexpected process ${program}`);
      assert.ok(args.at(-1)?.includes(fakeCli), "only the fixture CLI may run");
    }
    const proc = spawn(program, command, options); if (proc.pid) pids.push(proc.pid); return proc;
  }) as typeof spawn, env);
  const service = new SettingsService({ dataRoot: data, env, runCli: native, refreshPath: async () => {
    refreshes.push(installed ? "after installer" : "before installer");
    await refreshProcessPath({ env, platform: "win32", readRegistryPath: () => installed ? [bin] : [] });
  }, onChange: () => { phases.push(service.state.catalogTools[id].action?.phase ?? "none"); } });
  const { state, config } = api;
  state.setDataRoot(root); state.setWorkspaces(config.defaultWorkspaces()); state.setSelectedTabId("example-development");
  state.setSettingsService(service); state.setAcpClis([]); config.writeAcpClis([]);
  state.setChatStore(new api.ChatStore(join(data, "chats"))); state.setRequestsStore(new api.RequestsStore(data));
  state.setClientPrefs(config.readClientPrefs()); state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] } as any);
  const replies: any[] = [], ws = { readyState: 1, send: (text: string) => replies.push(JSON.parse(text)) } as any;
  const dispatch = async (message: any) => {
    process.env.PATH = env.PATH;
    api.messages.handleMessage(ws, JSON.stringify(message));
    const deadline = Date.now() + 20_000;
    for (;;) {
      const reply = replies.find((row) => row.requestId === message.requestId && ["actionResult", "error"].includes(row.type));
      if (reply) return reply;
      assert.ok(Date.now() < deadline, `handler did not settle: ${JSON.stringify(replies)}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  return { service, native, env, bin, data, phases, errors, pids, refreshes, dispatch,
    exists: () => existsSync(fakeCli), persisted: () => readFileSync(config.acpClisPath, "utf8"),
    close: async () => {
      await service.installer.drain(); setProcessTreeForTests(null);
      if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
      process.chdir(cwd); removeOwned(folder);
    } };
}
