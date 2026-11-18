import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { setEnv } from "./temp-root.ts";
import { removeCandidate } from "../server/settings/opencode/paths.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-p3-folders-")));
function directory(...parts: string[]): string {
  const path = join(root, ...parts); mkdirSync(path, { recursive: true }); return path;
}
const home = directory("Users", "Tester"), appData = directory("Users", "Tester", "AppData");
const roaming = directory("Users", "Tester", "AppData", "Roaming");
const local = directory("Users", "Tester", "AppData", "Local");
const work = directory("Users", "Tester", "Documents", "My Project 项目");
const originalWork = directory("existing project");
const windows = directory("Windows"), programs = directory("Program Files"), data = directory("data");
const restore = setEnv({ HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
  SystemRoot: windows, windir: windows, ProgramFiles: programs, "ProgramFiles(x86)": programs,
  ProgramW6432: programs, PATH: "", CLAUDE_CLI_PATH: undefined,
  CC_DATA_DIR: data, CC_TEST_FORCE_PACKAGED: "1", CC_TEST_FAKE_CLI: "1" });
after(async () => { restore(); await removeCandidate(root); });
const { fixedProject, fixedTab, fixedWorkspaces } = await import("./fixed-server-fixture.ts");
const config = await import("../server/config.ts");
const state = await import("../server/main/state.ts");
const { handleMessage } = await import("../server/main/messages/index.ts");
const first = await import("../server/first-run/state.ts");
assert.equal(config.workspacesPath, join(data, "config", "workspaces.json"), "fixture must isolate workspace writes before setup");
assert.equal(first.firstRunPath, join(data, "config", "first-run.json"), "fixture must isolate setup writes before setup");
const recovery = await import("../server/fixed-crew/recovery.ts");
const { SettingsService } = await import("../server/settings.ts");
const { ChatStore } = await import("../server/chat-store.ts");
const { RequestsStore } = await import("../server/requests.ts");
const cli = await import("../server/leader-common/cli-path.ts");
const { validateFolderPath } = await import("../server/main/workspace.ts");
let sequence = 0;
function setup(pending = false) {
  state.tabs.clear(); state.clients.clear(); state.activeLeaderTurns.clear(); state.runContexts.clear();
  state.savingTabs.clear(); state.setBlockedSeatKeys(new Set()); state.setAcpClis([]);
  state.setDataRoot(data); state.setSelectedTabId(pending ? "example-development" : "existing-development");
  state.setWorkspaces(pending ? config.defaultWorkspaces() : fixedWorkspaces([fixedProject("existing", originalWork)]));
  state.setLaunchSafety({ blocked: [], uncertain: [], released: [], notices: [] });
  state.setChatStore(new ChatStore(directory(`chats-${++sequence}`)));
  state.setRequestsStore(new RequestsStore(directory(`requests-${sequence}`)));
  state.setClientPrefs(config.readClientPrefs());
  state.setFolderActivity({ watchFolders() {} } as any);
  state.setCliRunner(async () => ({ code: 1, stdout: "", stderr: "not a git repo" }));
  state.setSettingsService(new SettingsService({ dataRoot: directory(`settings-${sequence}`), runCli: state.cliRunner }));
  Object.assign(state.settingsService.state.tools.codex, { installed: true, signedIn: true });
  writeFileSync(config.workspacesPath, JSON.stringify(state.workspaces));
  writeFileSync(first.firstRunPath, JSON.stringify({ version: 1, status: pending ? "pending" : "complete", createdAt: "2026-01-01T00:00:00.000Z" }));
  recovery.initializeWorkspaceRecovery(config.defaultWorkspaces);
  const replies: any[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(raw: string) { replies.push(JSON.parse(raw)); } } as any;
  state.clients.add(socket);
  return {
    replies,
    bytes: () => [readFileSync(config.workspacesPath, "utf8"), readFileSync(first.firstRunPath, "utf8")],
    async dispatch(message: any) {
      const start = replies.length;
      handleMessage(socket, JSON.stringify({ requestId: `p3_${++sequence}`, ...message }));
      await new Promise((done) => setImmediate(done));
      return replies.slice(start);
    },
  };
}
const plainMessage = "Choose a project folder, not your whole home folder or a system folder.";
const broad = [home, dirname(home), appData, roaming, local, parse(root).root, windows, programs];
function admission(type: string, folder: string) {
  if (type === "completeFirstRun") return { type, name: "My Project", folder, cli: "codex" };
  if (type === "addProject") return { type, id: "new-project", name: "New project", folder, fixedCrewVersion: 1, autoAssign: true };
  if (type === "addTab") return { type, projectId: "existing", tabId: "new-tab", folder, fixedCrewVersion: 1, autoAssign: true };
  return { type, projectId: "existing", tabId: "existing-development", folder };
}
for (const type of ["completeFirstRun", "addProject", "addTab", "changeFolder", "changeProjectFolder"]) {
  test(`${type} refuses home, profile root, AppData, drive and system folders without saving`, async () => {
    const ctx = setup(type === "completeFirstRun");
    for (const folder of broad) {
      const before = ctx.bytes(), memory = JSON.stringify(state.workspaces);
      const replies = await ctx.dispatch(admission(type, folder));
      assert.equal(replies.find((reply) => reply.type === "error")?.message, plainMessage, `${type}: ${folder}`);
      assert.deepEqual(ctx.bytes(), before, `no saved change: ${folder}`);
      assert.equal(JSON.stringify(state.workspaces), memory, `no in-memory change: ${folder}`);
    }
  });
  test(`${type} accepts an ordinary home subfolder with spaces and non-ASCII characters`, async () => {
    const ctx = setup(type === "completeFirstRun");
    const replies = await ctx.dispatch(admission(type, work));
    assert.equal(replies.find((reply) => reply.type === "error"), undefined);
    const saved = config.readWorkspaces();
    if (type === "addTab") assert.equal(saved.projects[0].tabs.find((tab) => tab.id === "new-tab")?.folder, work);
    else if (type === "addProject" || type === "completeFirstRun") assert.equal(saved.projects.at(-1)?.folder, work);
    else if (type === "changeFolder") {
      assert.equal(saved.projects[0].tabs[0].folder, work);
      assert.equal(saved.projects[0].folder, originalWork);
    } else assert.equal(saved.projects[0].folder, work);
    if (type === "completeFirstRun") assert.equal(first.firstRunMarker()?.status, "complete");
  });
}
test("addProject separately refuses a broad initial tab folder and saves nothing", async () => {
  const ctx = setup(), before = ctx.bytes();
  const replies = await ctx.dispatch({ ...admission("addProject", work), tabFolder: home });
  assert.equal(replies.find((reply) => reply.type === "error")?.message, plainMessage);
  assert.deepEqual(ctx.bytes(), before);
});
test("addProject saves the canonical project folder as well as the canonical tab folder", async () => {
  const ctx = setup();
  const replies = await ctx.dispatch(admission("addProject", work + "/."));
  assert.equal(replies.find((reply) => reply.type === "error"), undefined);
  const project = config.readWorkspaces().projects.at(-1)!;
  assert.equal(project.folder, work);
  assert.equal(project.tabs[0].folder, work);
});
test("first-run rejects a broad folder before resolving a custom ACP program", async () => {
  const ctx = setup(true), before = ctx.bytes();
  const entry = { id: "missing-basic", name: "Missing basic", program: "missing-acp-p3", args: [] };
  state.setAcpClis([entry]);
  try {
    const replies = await ctx.dispatch({ ...admission("completeFirstRun", home), cli: config.acpKindOf(entry), acpConsent: true });
    assert.equal(replies.find((reply) => reply.type === "error")?.message, plainMessage);
    assert.deepEqual(ctx.bytes(), before);
  } finally { state.setAcpClis([]); }
});
test("admissions refuse all discovered PATH install ancestors, including a second installation", () => {
  setup();
  const bin = directory("custom tools", "bin"), parent = dirname(bin);
  writeFileSync(join(bin, "codex.cmd"), "inert");
  const second = directory("second install", "bin"); writeFileSync(join(second, "codex.cmd"), "inert");
  const env = setEnv({ PATH: `${bin};${second}` });
  try {
    assert.equal(cli.resolveCliPath("codex"), join(bin, "codex.cmd"), "real resolver discovers fixture");
    for (const folder of [bin, parent, second, dirname(second)]) assert.throws(() => validateFolderPath(folder), { message: plainMessage });
  } finally { env(); }
});
test("admissions refuse a configured Claude installation outside PATH", () => {
  setup();
  const native = directory("native tools", "bin"), executable = join(native, "claude.exe");
  writeFileSync(executable, "inert");
  const nativeEnv = setEnv({ CLAUDE_CLI_PATH: executable });
  try { assert.throws(() => validateFolderPath(dirname(native)), { message: plainMessage }); }
  finally { nativeEnv(); }
});
test("admissions refuse managed install directories outside PATH", () => {
  setup();
  const managed = directory("managed profile"), install = directory("managed profile", "Command Center", "tools", "opencode-v1", "install-abc");
  writeFileSync(join(install, "opencode.exe"), "inert");
  writeFileSync(join(dirname(install), "active.json"), JSON.stringify({ executable: "install-abc/opencode.exe", version: "1.19.5" }));
  const managedEnv = setEnv({ LOCALAPPDATA: managed });
  try { assert.throws(() => validateFolderPath(install), { message: plainMessage }); }
  finally { managedEnv(); }
});
test("admissions refuse a registered CLI installation outside the built-in catalogue", () => {
  setup();
  const acpBin = directory("registered tools", "bin"); writeFileSync(join(acpBin, "custom-agent.cmd"), "inert");
  state.setAcpClis([{ id: "custom", name: "Custom", program: "custom-agent", args: [] }] as any);
  const acpEnv = setEnv({ PATH: acpBin });
  try { assert.throws(() => validateFolderPath(dirname(acpBin)), { message: plainMessage }); }
  finally { acpEnv(); state.setAcpClis([]); }
});
test("an old saved CLI skip folder cannot hide an installation from admission", () => {
  setup();
  const bin = directory("previously saved tools"); writeFileSync(join(bin, "gemini.cmd"), "inert");
  const env = setEnv({ PATH: bin }); cli.setCliSkipFolders(() => [bin]);
  try {
    assert.equal(cli.resolveCliPath("gemini"), null, "control: the saved exclusion hides it from launches");
    assert.throws(() => validateFolderPath(bin), { message: plainMessage });
  } finally { env(); cli.setCliSkipFolders(() => []); }
});
test("ordinary admitted folders still exclude planted executables from CLI lookup", () => {
  const bin = directory("safe bin"); writeFileSync(join(bin, "codex.cmd"), "safe inert");
  writeFileSync(join(work, "codex.cmd"), "planted inert");
  assert.equal(validateFolderPath(work), work);
  cli.setCliSkipFolders(() => [work]);
  try {
    assert.equal(cli.resolveCliPath("codex", { PATH: `${work};${bin}` }), join(bin, "codex.cmd"));
    assert.equal(cli.resolveCliPath("codex", { PATH: work }), null);
  } finally { cli.setCliSkipFolders(() => []); }
});
test("existing saved broad project and tab folders load unchanged", () => {
  setup();
  const saved = fixedWorkspaces([fixedProject("old", home, [fixedTab("old-development", appData)])]);
  config.writeWorkspaces(saved);
  const before = readFileSync(config.workspacesPath, "utf8");
  assert.deepEqual(config.readWorkspaces(), saved);
  assert.equal(readFileSync(config.workspacesPath, "utf8"), before);
});
