import { waitForServerStart } from "./server-start.ts";
import test from "node:test";
import { KILL_TIMEOUT_MS } from "../server/leader-common/types.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { sleep, SECRET, scratch, MAIN, LEADER_SLOT, crewFor } from "./pack17-acp-helpers.ts";

const TAB_COUNT = 12;
const tabId = (n: number) => `p17-${n}`;
type Server = { port: number; key: string; temp: string; data: string; work: string; child: ChildProcess; log: () => string; stop: () => Promise<void> };
async function boot(): Promise<Server> {
  const temp = mkdtempSync(join(tmpdir(), "cc-pack17s-"));
  const home = join(temp, "home"), data = join(temp, "data"), work = join(temp, "work"), bin = join(temp, "bin");
  for (const dir of [home, work, bin, join(data, "config"), join(data, "chats"), join(data, "scratch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "fake-acp.cmd"), "@echo off\r\n"); // found on PATH (outside every project folder); the test spawn runs the fake agent in its place
  writeFileSync(join(work, "evilacp.cmd"), "@echo off\r\n"); // a program planted INSIDE the tab folder, which is on PATH
  const tab = (id: string, leader?: { cli: string; model: string; effort: string }) => ({ id, name: id, kind: "dev", process: "main", folder: work, crew: crewFor(leader) });
  const tabs = [...Array.from({ length: TAB_COUNT }, (_, index) => tab(tabId(index + 1))), tab("p17-evil", { cli: "acp:evil", model: "default", effort: "default" }), tab("p17-ghost", { cli: "acp:ghost", model: "default", effort: "default" })];
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p17", name: "P17", folder: work, tabs }] }));
  writeFileSync(join(data, "config", "acp-clis.json"), JSON.stringify({ clis: [{ id: "evil", name: "Evil", program: "evilacp", args: [] }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: Object.fromEntries(["claude", "codex"].map((cli) => [JSON.stringify([cli, "--version"]), { code: 0, stdout: `${cli} 1.0.0`, stderr: "" }])) }));
  const key = randomBytes(32).toString("hex");
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const full: Record<string, string | undefined> = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), system32, bin, work].join(";"),
    CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: "0", CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1",
    CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_FAKE_LEADER_CLI: "1",
    FAKE_LEADER_LOG: join(temp, "fake-leader.log"), CC_APP_KEY: key, CLAUDE_CLI_PATH: process.execPath,
  };
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: full as NodeJS.ProcessEnv });
  attachCrashCatcher(child.pid, "pack17-server");
  let log = "";
  child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  // CC_PORT=0: the OS picks the port at the server's own listen, so no other test can take it first.
  const port = await waitForServerStart(child, () => log);
  return {
    port, key, temp, data, work, child, log: () => log,
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
  const wait = async <T>(fn: () => T, label: string, ms = 12_000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = fn(); if (value) return value as NonNullable<T>; await sleep(10); }
    assert.fail(`${label}: server log=${server.log().slice(-600)} last=${JSON.stringify(messages.filter((m) => m.type !== "state").slice(-6))}`);
  };
  await wait(() => messages.find((m) => m.type === "state"), "initial state");
  let n = 0;
  const send = (payload: any) => socket.send(JSON.stringify(payload));
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const tabState = (id: string) => state().projects[0].tabs.find((t: any) => t.id === id);
  const done = (id: string) => messages.filter((m) => m.type === "chatDone" && m.tabId === id).length;
  const errors = (id: string) => messages.filter((m) => m.type === "chatError" && m.tabId === id);
  const answers = (id: string) => messages.filter((m) => m.type === "chatMessage" && m.tabId === id && m.role !== "notice").map((m) => ({ role: m.role as string, text: m.text as string }));
  // A request that answers with actionResult or an error carrying its requestId.
  const request = async (payload: any): Promise<{ ok: boolean; message?: string }> => {
    const requestId = `p17r${++n}`; const from = messages.length;
    send({ ...payload, requestId });
    const reply = await wait(() => messages.slice(from).find((m) => m.requestId === requestId && (m.type === "actionResult" || m.type === "error")), `reply to ${payload.type}`);
    return reply.type === "actionResult" ? { ok: true } : { ok: false, message: reply.message };
  };
  const chat = async (id: string, text: string): Promise<void> => {
    const requestId = `p17c${++n}`;
    send({ type: "chat", tabId: id, text, requestId });
    await wait(() => messages.find((m) => m.type === "chatMessage" && m.requestId === requestId), `chat ${requestId} taken`);
  };
  const finished = async (id: string, count: number, label: string, ms = 20_000) => { await wait(() => done(id) >= count || errors(id).length >= count, label, ms); await sleep(150); };
  return { messages, state, tabState, wait, send, request, chat, done, errors, answers, finished, close: () => socket.terminate() };
}
type Client = Awaited<ReturnType<typeof client>>;
const fakeLog = (server: Server): any[] => (existsSync(join(server.temp, "fake-leader.log")) ? readFileSync(join(server.temp, "fake-leader.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const chatFile = (server: Server, id: string): any[] => readFileSync(join(server.data, "chats", `${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const workspaceFile = (server: Server): any => JSON.parse(readFileSync(join(server.data, "config", "workspaces.json"), "utf8"));
const leaderOf = (tab: any) => tab.crew.find((member: any) => member.slot === LEADER_SLOT);

// Adds the scenario's CLI (once) and makes it the tab's leader, the way the page does.
async function useAcp(c: Client, id: string, scenario: string): Promise<string> {
  const name = `Fake ${scenario}`, kind = `acp:fake-${scenario}`;
  if (!c.state().acpClis.some((cli: any) => cli.kind === kind)) assert.deepEqual(await c.request({ type: "addAcpCli", name, command: `fake-acp --scenario=${scenario}` }), { ok: true });
  const from = c.messages.length;
  c.send({ type: "updateSeat", tabId: id, slot: LEADER_SLOT, cli: kind, model: "default", confirm: true });
  await c.wait(() => leaderOf(c.tabState(id)).cli === kind, `${id} leads with ${kind}: ${JSON.stringify(c.messages.slice(from).filter((m) => m.type === "error"))}`);
  return kind;
}

test("D1: Settings adds a CLI by its start command; nothing that needs a shell is saved; it cannot be removed while it leads a tab", async () => {
  const server = await boot(); const c = await client(server);
  try {
    assert.deepEqual(c.state().acpClis.map((cli: any) => cli.id), ["evil"], "the saved list is loaded at start");
    assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake basic", command: "fake-acp --scenario=basic" }), { ok: true });
    const added = c.state().acpClis.find((cli: any) => cli.id === "fake-basic");
    assert.deepEqual(added, { id: "fake-basic", name: "Fake basic", program: "fake-acp", args: ["--scenario=basic"], kind: "acp:fake-basic" });
    assert.deepEqual(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.map((cli: any) => cli.id), ["evil", "fake-basic"]);
    const before = readFileSync(join(server.data, "config", "acp-clis.json"), "utf8");
    for (const command of ["fake-acp && calc", "fake-acp | more", 'fake-acp "x y"', "..\\fake-acp", "C:\\tools\\fake-acp --acp", "fake-acp %PATH%"]) {
      const result = await c.request({ type: "addAcpCli", name: "Shell", command });
      assert.equal(result.ok, false, command);
    }
    assert.equal((await c.request({ type: "addAcpCli", name: "FAKE BASIC", command: "fake-acp" })).ok, false, "the same name twice");
    const missing = await c.request({ type: "addAcpCli", name: "Not real", command: "notarealcli --acp" });
    assert.equal(missing.ok, false); assert.equal(missing.message, "notarealcli was not found. Install it first, or check the name.");
    assert.equal(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8"), before, "a refused add changes nothing on disk");
    assert.equal(c.state().acpClis.length, 2);
    await useAcp(c, tabId(1), "basic");
    const refusal = await c.request({ type: "removeAcpCli", id: "fake-basic" });
    assert.equal(refusal.ok, false); assert.match(refusal.message!, /Fake basic is used by Atlas \(Leader\) in "p17-1"/);
    assert.ok(c.state().acpClis.some((cli: any) => cli.id === "fake-basic"));
    assert.deepEqual(await c.request({ type: "refreshSettings" }), { ok: true });
    c.send({ type: "updateSeat", tabId: tabId(1), slot: LEADER_SLOT, cli: "claude", model: "claude-opus-5-5[1m]" });
    await c.wait(() => leaderOf(c.tabState(tabId(1))).cli === "claude", "back to Claude");
    assert.deepEqual(await c.request({ type: "removeAcpCli", id: "fake-basic" }), { ok: true });
    assert.deepEqual(c.state().acpClis.map((cli: any) => cli.id), ["evil"]);
    assert.deepEqual(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.map((cli: any) => cli.id), ["evil"]);
  } finally { c.close(); await server.stop(); }
});

test("D2: picking an ACP leader needs the Full access confirmation, a crew seat may use it too (with the confirmation), and the leader shows Full access only", async () => {
  const server = await boot(); const c = await client(server);
  try {
    assert.deepEqual(await c.request({ type: "addAcpCli", name: "Fake basic", command: "fake-acp --scenario=basic" }), { ok: true });
    const slots = MAIN.map((seat) => seat.slotId);
    const crewSlot = slots.find((slot) => slot !== LEADER_SLOT)!;
    let from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:fake-basic", model: "default" });
    const noConfirm = await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "refused without the confirmation");
    assert.match(noConfirm.message, /Full access confirmation is required: Fake basic may edit files and run commands without asking/);
    assert.equal(leaderOf(c.tabState(tabId(2))).cli, "claude");
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: crewSlot, cli: "acp:fake-basic", model: "default", confirm: true });
    const crewModel = c.tabState(tabId(2)).crew.find((seat: any) => seat.slot === crewSlot).model;
    await c.wait(() => c.tabState(tabId(2)).crew.find((seat: any) => seat.slot === crewSlot).cli === "acp:fake-basic", "a crew seat takes an ACP CLI with the confirmation (pack 18)");
    assert.notEqual(c.tabState(tabId(2)).permissionMode, "bypass", "a crew seat on an ACP CLI does not change the tab's mode: only an ACP LEADER shows Full access");
    assert.deepEqual(await c.request({ type: "refreshSettings" }), { ok: true });
    c.send({ type: "updateSeat", tabId: tabId(2), slot: crewSlot, cli: "codex", model: crewModel });
    await c.wait(() => c.tabState(tabId(2)).crew.find((seat: any) => seat.slot === crewSlot).cli === "codex", "the crew seat is back on Codex");
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:nobody", model: "default", confirm: true });
    assert.match((await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "unknown ACP CLI")).message, /not in your ACP CLIs list/);
    from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "acp:fake-basic", model: "opus", confirm: true });
    assert.match((await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "a model of another CLI")).message, /valid acp:fake-basic model is required/);
    await useAcp(c, tabId(2), "basic");
    const tab = c.tabState(tabId(2));
    assert.equal(leaderOf(tab).model, "default"); assert.equal(leaderOf(tab).effort, "default");
    assert.equal(tab.permissionMode, "bypass", "an ACP leader shows Full access");
    assert.deepEqual(tab.acpLeader, { name: "Fake basic", model: null });
    const saved = workspaceFile(server).projects[0].tabs.find((t: any) => t.id === tabId(2));
    assert.equal(saved.crew.find((m: any) => m.slot === LEADER_SLOT).cli, "acp:fake-basic");
    // Ask, Plan and Accept are refused for it; Full access is what it already has (nothing changes, and the tab's saved mode stays as it was).
    for (const mode of ["ask", "accept", "plan"]) {
      const result = await c.request({ type: "setPermissionMode", tabId: tabId(2), mode });
      assert.equal(result.ok, false, mode); assert.match(result.message!, /Fake basic can only run with Full access: it may edit files and run commands without asking, and Command Center cannot make it ask yet\./);
    }
    assert.deepEqual(await c.request({ type: "setPermissionMode", tabId: tabId(2), mode: "bypass", confirm: true }), { ok: true });
    assert.equal(c.state().settings.permissionModes[tabId(2)], undefined, "the saved mode is untouched (it applies again if the leader is switched back)");
    assert.equal(c.tabState(tabId(2)).permissionMode, "bypass");
    // Switching back restores the tab's own saved mode.
    assert.deepEqual(await c.request({ type: "refreshSettings" }), { ok: true });
    c.send({ type: "updateSeat", tabId: tabId(2), slot: LEADER_SLOT, cli: "claude", model: "claude-opus-5-5[1m]" });
    await c.wait(() => leaderOf(c.tabState(tabId(2))).cli === "claude", "back to Claude");
    assert.equal(c.tabState(tabId(2)).permissionMode, c.tabState(tabId(12)).permissionMode, "the tab's own saved mode applies again"); assert.equal(c.tabState(tabId(2)).acpLeader, null);
    assert.equal(leaderOf(c.tabState(tabId(2))).effort !== "default", true);
  } finally { c.close(); await server.stop(); }
});

test("D3: an ACP leader chats through the real server: the reply is streamed and saved, the model it reports is shown, a step shows only its kind, nothing secret is saved", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(3), "basic");
    const from = c.messages.length;
    await c.chat(tabId(3), "Reply with exactly: OK");
    await c.finished(tabId(3), 1, "turn done");
    assert.equal(c.errors(tabId(3)).length, 0);
    const [user, reply] = c.answers(tabId(3));
    assert.equal(user.role, "user"); assert.equal(reply.role, "assistant");
    assert.match(reply.text, /^Hello from the fake\. You said: [\s\S]*Reply with exactly: OK\n\nAll done\.$/);
    const saved = chatFile(server, tabId(3)).filter((row) => row.type === "message" && row.role === "assistant");
    assert.equal(saved.length, 1); assert.equal(saved[0].text, reply.text, "the reply is saved");
    assert.ok(!readFileSync(join(server.data, "chats", `${tabId(3)}.jsonl`), "utf8").includes(SECRET), "no step title, path or content in the saved chat");
    assert.ok(!JSON.stringify(c.messages.slice(from)).includes(SECRET), "nothing of a step or a thought reaches the page");
    const labels = c.messages.slice(from).filter((m) => m.type === "leaderActivity" && m.tabId === tabId(3)).map((m) => m.label).filter(Boolean);
    assert.ok(labels.includes("Editing files"), JSON.stringify(labels));
    const tab = c.tabState(tabId(3));
    assert.deepEqual(tab.acpLeader, { name: "Fake basic", model: "fakeprov/fake-default" }, "the model the CLI reports is in the state");
    assert.equal(c.state().acpClis.find((cli: any) => cli.id === "fake-basic").lastModel, "fakeprov/fake-default", "the CLI's model is remembered for the picker");
    assert.equal(JSON.parse(readFileSync(join(server.data, "config", "acp-clis.json"), "utf8")).clis.find((cli: any) => cli.id === "fake-basic").lastModel, "fakeprov/fake-default", "and saved");
    assert.equal(tab.leaderUsage.contextTokens, 4321); assert.equal(tab.leaderUsage.contextWindow, 200000); assert.equal(tab.leaderUsage.costUsd, 0.0123);
    const sent = fakeLog(server).filter((row) => row.cli === "acp" && row.scenario === "basic");
    assert.equal(sent.find((row) => row.received === "session/new").params.cwd, server.work);
    // The reply works a second time on the same session (one prompt per turn).
    await c.chat(tabId(3), "again");
    await c.finished(tabId(3), 2, "second turn");
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp" && row.prompt).length, 2);
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp" && row.started).length, 1, "one process for the whole session");
  } finally { c.close(); await server.stop(); }
});

test("D4: Stop ends the ACP leader's process; the next message starts a new one", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(4), "cancel");
    await c.chat(tabId(4), "long job");
    await c.wait(() => c.messages.find((m) => m.type === "chatDelta" && m.tabId === tabId(4)), "streaming");
    const pid = fakeLog(server).find((row) => row.started && row.scenario === "cancel").pid as number;
    c.send({ type: "stopSeat", tabId: tabId(4), slot: LEADER_SLOT });
    await c.wait(() => c.messages.find((m) => m.type === "chatError" && m.tabId === tabId(4) && m.message === "leader turn stopped"), "stopped");
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const end = Date.now() + KILL_TIMEOUT_MS + 5_000; while (alive() && Date.now() < end) await sleep(50);
    assert.equal(alive(), false, "the agent process is gone");
    assert.ok(fakeLog(server).some((row) => row.received === "session/cancel"), "the agent was asked to cancel");
    const partial = c.answers(tabId(4)).filter((m) => m.role === "assistant").map((m) => m.text);
    assert.deepEqual(partial, [`${"-".repeat(100)}working

(Stopped before it finished.)`]);
    await c.chat(tabId(4), "second");
    await c.wait(() => fakeLog(server).filter((row) => row.started && row.scenario === "cancel").length === 2, "a new process starts on the next message");
    c.send({ type: "stopSeat", tabId: tabId(4), slot: LEADER_SLOT });
    await sleep(500);
  } finally { c.close(); await server.stop(); }
});

test("D5: the crew tools reach an ACP leader through the real bridge with its own token; an error and a death are shown plainly", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(5), "crew");
    await c.chat(tabId(5), "who is in the crew?");
    await c.finished(tabId(5), 1, "crew turn");
    assert.match(c.answers(tabId(5)).at(-1)!.text, /^crew ok: 200$/);
    const row = fakeLog(server).find((entry) => entry.bridgeTools);
    assert.ok(row, "the agent used the bridge");
    assert.deepEqual([...row.bridgeTools].sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    assert.match(row.bridgeCrew, /"tab":"p17-5"/);
    const labels = c.messages.filter((m) => m.type === "leaderActivity" && m.tabId === tabId(5)).map((m) => m.label).filter(Boolean);
    assert.ok(!labels.some((label: string) => /crew/i.test(label)), `a crew tool shows as a crew run, not a step: ${JSON.stringify(labels)}`);
    // Not signed in.
    await useAcp(c, tabId(6), "auth");
    await c.chat(tabId(6), "hello");
    await c.finished(tabId(6), 1, "auth failure");
    assert.equal(c.errors(tabId(6)).at(-1).message, "Fake auth is not signed in: Run `fakecli auth login` in the terminal");
    assert.equal(c.answers(tabId(6)).at(-1)!.text, "Fake auth is not signed in: Run `fakecli auth login` in the terminal", "the plain error is saved as the reply");
    // Death mid-turn.
    await useAcp(c, tabId(7), "die");
    await c.chat(tabId(7), "hello");
    await c.finished(tabId(7), 1, "death");
    assert.match(c.errors(tabId(7)).at(-1).message, /Fake die stopped unexpectedly/);
    assert.equal(c.errors(tabId(7)).length, 1, "the turn fails once");
    // A permission request in Full access is allowed; the reply says which option the CLI got.
    await useAcp(c, tabId(8), "permission");
    await c.chat(tabId(8), "edit it");
    await c.finished(tabId(8), 1, "permission turn");
    assert.equal(c.answers(tabId(8)).at(-1)!.text, "permission:selected:once");
    assert.equal(c.tabState(tabId(8)).pendingApprovals.length, 0, "no approval card: Full access never asks");
    // The token is hidden if the CLI echoes it.
    await useAcp(c, tabId(9), "echotoken");
    await c.chat(tabId(9), "hello");
    await c.finished(tabId(9), 1, "echo");
    assert.equal(c.answers(tabId(9)).at(-1)!.text, "whole [hidden]. split [hidden] end");
    assert.ok(!readFileSync(join(server.data, "chats", `${tabId(9)}.jsonl`), "utf8").match(/[0-9a-f]{64}/), "no 64-character token in the saved chat");
  } finally { c.close(); await server.stop(); }
});

test("D6: a program found only inside the tab folder is refused (at the pick and at the start); a removed CLI says so", async () => {
  const server = await boot(); const c = await client(server);
  try {
    // Picked from Settings: refused before it is saved.
    const from = c.messages.length;
    c.send({ type: "updateSeat", tabId: tabId(10), slot: LEADER_SLOT, cli: "acp:evil", model: "default", confirm: true });
    const refusal = await c.wait(() => c.messages.slice(from).find((m) => m.type === "error"), "inside-folder pick refused");
    assert.match(refusal.message, /evilacp was found only inside a project folder/);
    assert.equal(leaderOf(c.tabState(tabId(10))).cli, "claude");
    // Saved as the leader already: the start is refused, nothing runs.
    await c.chat("p17-evil", "hello");
    await c.finished("p17-evil", 1, "evil start");
    assert.match(c.errors("p17-evil").at(-1).message, /evilacp was found only inside a project folder/);
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp").length, 0, "no ACP process was started");
    // A leader whose CLI left the list.
    await c.chat("p17-ghost", "hello");
    await c.finished("p17-ghost", 1, "ghost start");
    assert.match(c.errors("p17-ghost").at(-1).message, /The CLI "ghost" was removed in Settings\. Pick another leader CLI for /);
    assert.equal(c.tabState("p17-ghost").permissionMode, "bypass", "a leader of this kind has Full access, listed or not");
  } finally { c.close(); await server.stop(); }
});

test("D7: a tab whose process changes keeps its ACP leader; a Claude tab still starts as Claude (not the ACP adapter)", async () => {
  const server = await boot(); const c = await client(server);
  try {
    await useAcp(c, tabId(11), "basic");
    const before = c.tabState(tabId(11)).setupName;
    c.send({ type: "useSetup", tabId: tabId(11), templateId: "duo" });
    await sleep(300);
    assert.equal(c.tabState(tabId(11)).setupName, "The Duo", `the tab really switched setup (was ${before})`);
    assert.equal(leaderOf(c.tabState(tabId(11))).cli, "acp:fake-basic");
    await c.chat(tabId(12), "hello claude");
    await c.finished(tabId(12), 1, "claude turn");
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp").length, 0, "a Claude leader never starts the ACP adapter");
    assert.equal(c.errors(tabId(12)).length, 0);
  } finally { c.close(); await server.stop(); }
});
