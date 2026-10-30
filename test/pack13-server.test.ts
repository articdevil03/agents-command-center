import { waitForServerStart } from "./server-start.ts";
// Pack 13 (Work on this project only), the server side through a real server: addProject and addTab write an AGENTS.md into the tab's folder when projectOnly is
// true, never overwrite or write through anything already at that path, report one outcome to the window that asked, and a failed write never undoes the project or tab.
// The last test is the sweep: every place that gives a tab or project a folder is listed and mapped to "writes rules" or "excluded", so a new one goes red.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { getProcessDefinition } from "../server/process.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { sourceText } from "./source-text.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const MAIN = getProcessDefinition("dev", "main").seats;
const crew = MAIN.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
// The exact file the owner approved, written independently of the server's own helper (CRLF, one sentence per line).
const expected = (name: string) => [`This folder is the ${name} project.`, "Work only on this project, inside this folder.", "Do not read or change files outside this folder unless the user names them.", "Keep this project's notes and progress in this folder.", ""].join("\r\n");

type Server = { port: number; key: string; temp: string; folders: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack13-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), folders = join(temp, "folders");
  for (const dir of [home, work, folders, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "base", name: "Base", folder: work, tabs: [{ id: "base-dev", name: "Dev", kind: "dev", process: "main", folder: work, crew }] }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1", CC_APP_KEY: key,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: env as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack13-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
  return {
    port, key, temp, folders, child, log: () => log,
    stop: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((ok) => child.once("exit", ok));
          child.once("error", () => {});
          try { child.send("shutdown", () => {}); } catch { /* IPC already closed: fall through to kill */ }
          await Promise.race([exited, sleep(8000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, sleep(3000)]); }
        }
      } finally { removeWithRetry(temp, 40, 500); }
    },
  };
}

async function client(server: Server) {
  const messages: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${server.key}`, { origin: `http://127.0.0.1:${server.port}` });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello" }));
  const wait = async <T>(fn: () => T, label: string, ms = 3000): Promise<NonNullable<T>> => { // a local socket answers in milliseconds; a reply that never comes must fail fast, not stall a mutation run
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-500)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const rules = () => messages.filter((m) => m.type === "projectRules");
  return { messages, state, rules, wait, send: (payload: any) => socket.send(JSON.stringify(payload)), close: () => socket.terminate() };
}
type Client = Awaited<ReturnType<typeof client>>;

let counter = 0;
const folderIn = (server: Server, name: string): string => { const dir = join(server.folders, name); mkdirSync(dir); return dir; };
// Creates a project in `folder` and waits for the state that holds it. `extra` is added to the message as is.
async function addProject(c: Client, folder: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `p13-${++counter}`;
  c.send({ type: "addProject", id, name, folder, tabFolder: folder, kind: "dev", process: "main", ...extra });
  await c.wait(() => c.state().projects.find((p: any) => p.id === id), `project ${id} exists`);
  return id;
}
async function addTab(c: Client, projectId: string, folder: string, extra: Record<string, unknown> = {}): Promise<string> {
  const known = new Set(c.state().projects.find((p: any) => p.id === projectId).tabs.map((t: any) => t.id));
  c.send({ type: "addTab", projectId, name: "Second", kind: "dev", process: "main", folder, ...extra });
  const tab = await c.wait(() => c.state().projects.find((p: any) => p.id === projectId).tabs.find((t: any) => !known.has(t.id)), "the new tab exists");
  return tab.id;
}
// A create with no reply: wait until the server surely answered anything it was going to, then check none came.
const quiet = async (c: Client, before: number) => { await sleep(300); assert.equal(c.rules().length, before, "no projectRules reply was sent"); };
const withServer = async (body: (server: Server, c: Client) => Promise<void>) => {
  const server = await boot(); const c = await client(server);
  try { await body(server, c); } finally { c.close(); await server.stop(); }
};

test("addProject ticked: AGENTS.md holds the exact text with the project's name, and the window that asked is told 'Added AGENTS.md'", async () => {
  await withServer(async (server, c) => {
    const folder = folderIn(server, "swim");
    await addProject(c, folder, "Swimeroo", { projectOnly: true });
    const reply = await c.wait(() => c.rules()[0], "the rules reply");
    assert.deepEqual([reply.outcome, reply.message], ["added", "Added AGENTS.md"]);
    assert.equal(readFileSync(join(folder, "AGENTS.md"), "utf8"), expected("Swimeroo"));
    assert.deepEqual(readdirSync(folder), ["AGENTS.md"], "no CLAUDE.md or any other file");
  });
});

test("addTab ticked: AGENTS.md names the project (not the tab) and the reply says Added", async () => {
  await withServer(async (server, c) => {
    const folder = folderIn(server, "tabs");
    const project = await addProject(c, folderIn(server, "first"), "Quiet", {});
    await addTab(c, project, folder, { projectOnly: true });
    const reply = await c.wait(() => c.rules()[0], "the rules reply");
    assert.deepEqual([reply.outcome, reply.message], ["added", "Added AGENTS.md"]);
    assert.equal(readFileSync(join(folder, "AGENTS.md"), "utf8"), expected("Quiet"));
  });
});

test("unticked, or anything but the boolean true: nothing is written and nothing is said", async () => {
  await withServer(async (server, c) => {
    const folders = ["no", "missing", "string", "one"].map((name) => folderIn(server, name));
    await addProject(c, folders[0], "Off", { projectOnly: false });
    await addProject(c, folders[1], "Missing", {});
    await addProject(c, folders[2], "Str", { projectOnly: "true" });
    const project = await addProject(c, folders[3], "One", { projectOnly: 1 });
    const tabFolder = folderIn(server, "tabno");
    await addTab(c, project, tabFolder, { projectOnly: false });
    await quiet(c, 0);
    for (const folder of [...folders, tabFolder]) assert.deepEqual(readdirSync(folder), [], `${folder} stayed empty`);
  });
});

test("a second tab on the same folder finds our file and leaves it byte for byte, and the reply names the first project", async () => {
  await withServer(async (server, c) => {
    const folder = folderIn(server, "shared");
    const project = await addProject(c, folder, "Quokka", { projectOnly: true });
    await c.wait(() => c.rules().length === 1, "the first reply");
    const path = join(folder, "AGENTS.md"), before = readFileSync(path), mtime = statSync(path).mtimeMs;
    await addTab(c, project, folder, { projectOnly: true });
    const reply = await c.wait(() => c.rules()[1], "the second reply");
    assert.deepEqual([reply.outcome, reply.message], ["ours", "This folder already has rules for Quokka, left alone"]);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mtimeMs, mtime, "not even rewritten with the same bytes");
  });
});

test("someone else's AGENTS.md is never touched and the reply says it was left alone (also when it only looks like ours further down)", async () => {
  await withServer(async (server, c) => {
    const folder = folderIn(server, "theirs"), second = folderIn(server, "lookalike");
    const theirs = "# Team rules\r\nBe kind.\r\n", lookalike = "# Notes\nThis folder is the Sneaky project.\n";
    writeFileSync(join(folder, "AGENTS.md"), theirs); writeFileSync(join(second, "AGENTS.md"), lookalike);
    await addProject(c, folder, "Mine", { projectOnly: true });
    await addProject(c, second, "Mine2", { projectOnly: true });
    await c.wait(() => c.rules().length === 2, "both replies");
    assert.deepEqual(c.rules().map((r) => [r.outcome, r.message]), Array(2).fill(["other", "This folder already has an AGENTS.md of its own, left alone"]));
    assert.equal(readFileSync(join(folder, "AGENTS.md"), "utf8"), theirs);
    assert.equal(readFileSync(join(second, "AGENTS.md"), "utf8"), lookalike);
  });
});

test("an AGENTS.md that is a folder, a folder link or a file link is left alone and nothing is written through it", async (t) => {
  await withServer(async (server, c) => {
    const asFolder = folderIn(server, "asdir"); mkdirSync(join(asFolder, "AGENTS.md"));
    const target = folderIn(server, "target"), asJunction = folderIn(server, "asjunction");
    symlinkSync(target, join(asJunction, "AGENTS.md"), "junction");
    const outside = join(server.folders, "outside.txt"); writeFileSync(outside, "keep me");
    const asLink = folderIn(server, "aslink");
    let fileLink = true;
    try { symlinkSync(outside, join(asLink, "AGENTS.md"), "file"); } catch (error) { fileLink = false; t.diagnostic(`file links need admin rights here (${(error as NodeJS.ErrnoException).code}); the folder link above covers a link of any kind`); }
    await addProject(c, asFolder, "A", { projectOnly: true });
    await addProject(c, asJunction, "B", { projectOnly: true });
    if (fileLink) await addProject(c, asLink, "C", { projectOnly: true });
    await c.wait(() => c.rules().length === (fileLink ? 3 : 2), "the replies");
    assert.ok(c.rules().every((r) => r.outcome === "other"), JSON.stringify(c.rules()));
    assert.ok(lstatSync(join(asFolder, "AGENTS.md")).isDirectory() && readdirSync(join(asFolder, "AGENTS.md")).length === 0, "the folder stayed an empty folder");
    assert.ok(lstatSync(join(asJunction, "AGENTS.md")).isSymbolicLink() && readdirSync(target).length === 0, "nothing was written through the folder link");
    if (fileLink) { assert.ok(lstatSync(join(asLink, "AGENTS.md")).isSymbolicLink()); assert.equal(readFileSync(outside, "utf8"), "keep me", "nothing was written through the file link"); }
  });
});

test("a folder the write fails in: the project and the tab still exist, and the reply says it could not be written", async () => {
  await withServer(async (server, c) => {
    const locked = folderIn(server, "locked");
    const who = execFileSync("whoami", { encoding: "utf8", windowsHide: true }).trim();
    const icacls = (...args: string[]) => execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { windowsHide: true, stdio: "ignore" });
    icacls(locked, "/deny", `${who}:(WD,AD)`);
    try {
      const project = await addProject(c, locked, "Locked", { projectOnly: true });
      const tab = await addTab(c, project, locked, { projectOnly: true });
      await c.wait(() => c.rules().length === 2, "both replies");
      assert.ok(c.rules().every((r) => r.outcome === "failed" && /^Could not write AGENTS\.md: .+/.test(r.message)), JSON.stringify(c.rules()));
      assert.ok(c.state().projects.find((p: any) => p.id === project).tabs.some((t: any) => t.id === tab), "the tab survived");
      assert.ok(readFileSync(join(server.temp, "data", "config", "workspaces.json"), "utf8").includes(project), "the project was saved to disk");
      assert.equal(existsSync(join(locked, "AGENTS.md")), false);
    } finally { icacls(locked, "/remove:d", who); }
  });
});

test("a project name with a newline and control characters is written on one line, cleaned", async () => {
  await withServer(async (server, c) => {
    const folder = folderIn(server, "dirty");
    const LS = String.fromCharCode(0x2028);
    await addProject(c, folder, `Swim\r\neromo\u0001\u0007 Two\tgo${LS}x`, { projectOnly: true });
    await c.wait(() => c.rules().length === 1, "the reply");
    const text = readFileSync(join(folder, "AGENTS.md"), "utf8");
    assert.equal(text, expected("Swim eromo Two go x"));
    assert.equal(text.split("\r\n").length, 5, "four lines and the end: the name added no line");
    assert.ok(!/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text) && !text.includes(LS), "no control characters");
  });
});

// ---- the sweep: every place a tab or project gets a folder ----
const SWEEP: Record<string, "writes rules" | "excluded"> = {
  "addProject|project folder": "writes rules", "addProject|tab folder": "writes rules", "addTab|tab folder": "writes rules",
  "changeFolder|tab folder": "excluded", "changeProjectFolder|project folder": "excluded",
};
test("sweep: every validateFolderPath site in the server is listed, and 'writes rules' sites call writeProjectRules while 'excluded' ones do not", () => {
  const source = sourceText("server/index.ts");
  const sites: string[] = [];
  // Each message handler is the function `onXxx(ws, message)` in server/main/messages/ (named after its first message type), ending at its closing brace line.
  const cases = [...source.matchAll(/^function on([A-Z][A-Za-z]*)\(ws: WebSocket, message: any\): void \{/gm)].map((m) => ({ name: m[1][0].toLowerCase() + m[1].slice(1), at: m.index!, end: source.indexOf("\n}\n", m.index!) }));
  assert.ok(cases.length >= 55, `control: the scan found only ${cases.length} message handlers`);
  for (const call of source.matchAll(/validateFolderPath\((.*?), "((?:tab|project) folder)"\)/g)) {
    const owner = cases.find((c) => c.at < call.index! && call.index! < c.end);
    sites.push(`${owner?.name ?? "(outside every message handler)"}|${call[2]}`);
  }
  assert.equal(source.match(/validateFolderPath\(/g)!.length, sites.length + 1, "every call has a label of 'tab folder' or 'project folder' (+1 for the definition)");
  assert.deepEqual([...sites].sort(), Object.keys(SWEEP).sort(), "a new or removed folder-assignment site needs a decision in SWEEP");
  for (const [key, decision] of Object.entries(SWEEP)) {
    const name = key.split("|")[0];
    const owner = cases.find((c) => c.name === name)!;
    const body = source.slice(owner.at, owner.end);
    assert.equal(/writeProjectRules\(/.test(body), decision === "writes rules", `${name} is ${decision}`);
    if (decision === "writes rules") assert.match(body, /message\.projectOnly === true/, `${name} only writes when projectOnly is true`);
    else assert.match(body, /Deliberately no "Work on this project only"/, `${name} says why it is excluded`);
  }
  // Seeds that set a folder without a dialog (first-run example project, legacy-file migration) are also decided: no rules file.
  const config = readFileSync("server/config.ts", "utf8");
  assert.equal(config.match(/tabs: \[defaultTab\(/g)!.length, 2, "config.ts seeds exactly two tab folders (migration, first-run example); a third needs a decision here");
  assert.ok(!/writeProjectRules|AGENTS\.md/.test(config), "seeds write no rules file");
});
