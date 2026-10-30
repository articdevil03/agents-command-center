// Fix pack 2, block 1 (server core), part 2: the engine (server/process.ts), the folder rule, the start-up sweep of a crashed server's leftovers, and a damaged chat file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatStore } from "../server/chat-store.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import {
  advanceStep, approveLook, createTabState, finishRun, getProcessDefinition, legacySetup, getStepBar, isBusy, startRun, stopAll, stopRun, MAX_FINISHED_RUNS,
  type ProcessState,
} from "../server/process.ts";
import { SWEEP_CAP_MS } from "../server/leader-common/types.ts";
import { sleep, type Server, boot, connect, makeData } from "./pack2-server-helpers.ts";

// ---- The engine (server/process.ts) ---------------------------------------------------------------------------------------------

test("getProcessDefinition names an unknown kind or process plainly, for inherited names too", () => {
  for (const [kind, process] of [["dev", "nope"], ["nope", "main"], ["constructor", "main"], ["dev", "__proto__"], ["dev", "toString"], ["dev", undefined]] as const) {
    assert.throws(() => getProcessDefinition(kind as any, process as any), new RegExp(`^Error: unknown kind/process: ${kind}/${process}$`), `${kind}/${process}`);
  }
  assert.equal(getProcessDefinition("dev", "main").seats.length, 6);
});

function waitingReview(): ProcessState {
  let state = createTabState(legacySetup("dev", "main"), { tabId: "tab", folderPath: "C:/work" });
  state = advanceStep(state); state = advanceStep(state); state = advanceStep(state); // brief -> build -> gate -> look
  state = startRun(state, { id: "build-1", seatSlotId: "coder", label: "Build", startedAt: 1 });
  state = approveLook(state);
  assert.equal(state.approval.reviewWaits, true, "the review waits for the build");
  return state;
}
const seatOf = (state: ProcessState, slot: string) => state.seats.find((seat) => seat.slotId === slot)!;

test("Stop all pauses a review that was waiting for workers: it never opens, not now and not when the stopped worker's run closes", () => {
  let state = stopAll(waitingReview(), 9, new Set(["build-1"])); // the worker's process is still closing
  assert.equal(state.approval.reviewWaits, false, "the wait ends with the stop");
  assert.deepEqual([seatOf(state, "reviewer1").status, seatOf(state, "leader").status, seatOf(state, "coder").status], ["stopped", "stopped", "stopped"]);
  assert.equal(state.runs[0].status, "working", "the closing run settles only when its close is confirmed");
  state = stopRun(state, "build-1", 12);
  assert.deepEqual([seatOf(state, "reviewer1").status, seatOf(state, "leader").status], ["stopped", "stopped"], "the confirmed close does not start the review");
  assert.equal(isBusy(state), false, "a stopped tab is not busy");
  assert.equal(state.approval.reviewWaits, false);
  assert.match(getStepBar(state).find((step) => step.state === "current")!.label, /Vera stopped/);
  // With nothing closing the result is the same, in one step.
  const direct = stopAll(waitingReview(), 9);
  assert.deepEqual([seatOf(direct, "reviewer1").status, seatOf(direct, "leader").status, isBusy(direct)], ["stopped", "stopped", false]);
});

test("a finished run is pruned by when it ended, never the run that just settled, even when that run is the oldest to have ended", () => {
  let state = createTabState(legacySetup("dev", "main"), { tabId: "tab", folderPath: "C:/work" });
  state = startRun(state, { id: "long-run", seatSlotId: "coder", label: "Long", startedAt: 1 });
  state = startRun(state, { id: "slow", seatSlotId: "coder", label: "Slow", startedAt: 2 });
  for (let i = 0; i < MAX_FINISHED_RUNS - 1; i++) {
    state = startRun(state, { id: `quick-${i}`, seatSlotId: "reviewer1", label: "Quick", startedAt: 10 + i });
    state = finishRun(state, `quick-${i}`, 100 + i);
  }
  state = finishRun(state, "slow", 5000); // started early, ended last: by start order it would look oldest
  assert.equal(state.runs.filter((run) => run.status !== "working").length, MAX_FINISHED_RUNS, "exactly at the cap");
  state = finishRun(state, "long-run", 0); // settles with the oldest end of all
  const ids = state.runs.map((run) => run.id);
  assert.equal(state.runs.filter((run) => run.status !== "working").length, MAX_FINISHED_RUNS, "the cap still holds");
  assert.ok(ids.includes("long-run"), "the run that just settled is still listed");
  assert.ok(ids.includes("slow"), "a run that started early but ended late is kept");
  assert.equal(ids.includes("quick-0"), false, "the one that ended longest ago (of the others) went");
  assert.ok(ids.includes("quick-1"));
});

test("a run settled without an end time ends now, not at its own start", () => {
  let state = createTabState(legacySetup("dev", "main"), { tabId: "tab", folderPath: "C:/work" });
  state = startRun(state, { id: "r1", seatSlotId: "coder", label: "x", startedAt: 5 });
  const before = Date.now();
  state = finishRun(state, "r1");
  assert.ok(state.runs[0].endedAt! >= before && state.runs[0].endedAt! <= Date.now(), `endedAt ${state.runs[0].endedAt}`);
});

test("the Review step counts '1 round' and '2 rounds'", () => {
  let rounds = waitingReview(); rounds = finishRun(rounds, "build-1", 5);
  rounds = { ...rounds, roundHistory: [{ round: 1, reviewerSlotId: "reviewer1", reviewerName: "Vera", outcome: "findings", fixerSlotId: "coder", fixerName: "Sonny" }], currentStepIndex: 5 };
  assert.match(getStepBar(rounds).find((step) => step.stepId === "review")!.label, / · 1 round$/);
  rounds = { ...rounds, roundHistory: [...rounds.roundHistory, { ...rounds.roundHistory[0], round: 2 }] };
  assert.match(getStepBar(rounds).find((step) => step.stepId === "review")!.label, / · 2 rounds$/);
});

// ---- C6: which folders a tab may have --------------------------------------------------------------------------------------------
// The rule both sides report: the server refuses only a path no worker can run in (not absolute, climbing out with "..", control
// characters, a path that does not exist or is not a folder). Parentheses, & ^ % in a name and a drive root are fine: the runner puts
// the folder in the environment and quotes a trailing backslash, so every folder the server accepts can be launched in.
test("the folder rule: ( ) & ^ % in a name and a drive root are accepted for a tab; a relative, climbing, control-character, missing or file path is refused", async () => {
  const data = makeData();
  const work = mkdtempSync(join(tmpdir(), "cc-pack2-folders-"));
  const odd = join(work, "My App (v2) & Co ^ 100%");
  const plainFile = join(work, "file.txt");
  const driveRoot = resolve(tmpdir()).split(/[\\/]/)[0] + "\\";
  let server: Server | undefined, opened: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    mkdirSync(odd); writeFileSync(plainFile, "x");
    server = await boot(data); const client = opened = await connect(server);
    const projectId = client.state().projects[0].id;
    const tabsOf = () => client.state().projects.flatMap((project: any) => project.tabs);
    const addTab = async (folder: string, requestId: string) => {
      const before = tabsOf().length;
      client.send({ type: "addTab", projectId, name: requestId, folder, requestId });
      return await client.wait(() => client.messages.find((m) => m.type === "error" && m.requestId === requestId) ?? (tabsOf().length > before ? "added" : undefined), `addTab ${requestId}`);
    };
    assert.equal(await addTab(odd, "f_odd"), "added", "( ) & ^ % in the name");
    assert.ok(tabsOf().some((tab: any) => tab.folder === odd));
    assert.match(driveRoot, /^[A-Za-z]:\\$/, "the temp folder sits on a lettered drive, so the drive-root checks below always run");
    assert.equal(await addTab(driveRoot, "f_root"), "added", `a drive root (${driveRoot})`);
    assert.ok(tabsOf().some((tab: any) => tab.folder === driveRoot));
    const refused = async (folder: string, requestId: string, pattern: RegExp) => assert.match(((await addTab(folder, requestId)) as any).message, pattern, requestId);
    await refused("relative\\dir", "f_rel", /absolute directory path/);
    await refused(work + "/../x", "f_dots", /without traversal/);
    await refused(`${work}\u0007`, "f_ctl", /absolute directory path/);
    await refused(join(work, "missing"), "f_missing", /does not exist/);
    await refused(plainFile, "f_file", /must be a directory/);
    await refused("   ", "f_blank", /is required/);
  } finally { opened?.close(); await server?.stop(); removeWithRetry(work); removeWithRetry(data); }
});

test("the server start finishes what a crashed earlier server left behind: its registry names a live child, which is stopped with no run launched", { skip: process.platform !== "win32" ? "Windows process behaviour" : false }, async () => {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  // The earlier server is a LIVE process of ours whose recorded creation time does not match (a "reused pid"), never an exited one: an exited pid can be handed to the new server itself, which skips the file named after its own pid.
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const created = (await listProcesses())?.find((proc) => proc.pid === orphan.pid)?.created;
    assert.ok(created, "the fake child is in the process list");
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: 1 }, roots: [{ pid: orphan.pid, rootCreated: created, known: [] }] }));
    assert.equal(alive(orphan.pid!), true);
    server = await boot(data);
    const end = Date.now() + SWEEP_CAP_MS + 5_000; // the start-up sweep may take up to its cap; the server is already listening, but the leftover is stopped by the sweep that boot waited for
    while ((alive(orphan.pid!) || existsSync(registry) || !server.log().includes("[cleanup]")) && Date.now() < end) await sleep(50);
    assert.equal(alive(orphan.pid!), false, `the start-up sweep stopped the leftover child: ${server.log().slice(-300)}`);
    assert.equal(existsSync(registry), false, "the dead server's registry file is removed");
    assert.match(server.log(), /\[cleanup\] stopped 1 processes left by an earlier server/);
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill(); // through the objects this test spawned, never a bare pid
    await server?.stop();
    removeWithRetry(data);
  }
});

test("round 1 fix 2: the server listens only after the start-up sweep finished, so nothing can launch before a crashed server's leftovers are stopped", { skip: process.platform !== "win32" ? "Windows process behaviour" : false }, async () => {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  // The earlier server is a LIVE process of ours with a mismatched recorded creation time (see the test above), never an exited pid.
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const created = (await listProcesses())?.find((proc) => proc.pid === orphan.pid)?.created;
    assert.ok(created, "the fake child is in the process list");
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: 1 }, roots: [{ pid: orphan.pid, rootCreated: created, known: [] }] }));
    server = await boot(data); // returns the moment the server says it listens
    assert.equal(alive(orphan.pid!), false, "the leftover was already stopped when the server started listening");
    assert.equal(existsSync(registry), false, "and the registry already handled");
    const log = server.log();
    assert.ok(log.indexOf("[cleanup] stopped 1 processes left by an earlier server") >= 0 && log.indexOf("[cleanup]") < log.indexOf("127.0.0.1"), `the sweep's line comes before the listening line: ${log.slice(-300)}`);
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill(); // through the objects this test spawned, never a bare pid
    await server?.stop();
    removeWithRetry(data);
  }
});

// The owner check in the sweep: a live pid with a different creation time is a REUSED pid (the owner is gone); a live pid with no recorded time or the matching time is the owner.
async function ownerCase(ownerCreated: "reused" | "null" | "match") {
  const { listProcesses } = await import("../server/leader-common.ts");
  const data = makeData();
  const logs = join(data, "logs"); mkdirSync(logs, { recursive: true });
  const harmless = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const owner = harmless(), orphan = harmless();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const registry = join(logs, `.children-${owner.pid}.json`);
  let server: Server | null = null;
  try {
    await Promise.all([once(owner, "spawn"), once(orphan, "spawn")]);
    const list = await listProcesses();
    const createdOf = (pid?: number) => list?.find((proc) => proc.pid === pid)?.created;
    assert.ok(createdOf(owner.pid) && createdOf(orphan.pid), "both fake processes are in the process list");
    const recorded = ownerCreated === "reused" ? 1 : ownerCreated === "null" ? null : createdOf(owner.pid);
    writeFileSync(registry, JSON.stringify({ owner: { pid: owner.pid, created: recorded }, roots: [{ pid: orphan.pid, rootCreated: createdOf(orphan.pid), known: [] }] }));
    server = await boot(data); // returns after the start-up sweep
    return { orphanAlive: alive(orphan.pid!), registryLeft: existsSync(registry), log: server.log() };
  } finally {
    for (const child of [owner, orphan]) if (child.exitCode === null && child.signalCode === null) child.kill();
    await server?.stop();
    removeWithRetry(data);
  }
}
const winOnly = { skip: process.platform !== "win32" ? "Windows process behaviour" : false };
test("pack 15: the owner's pid is alive but its creation time differs (a reused pid): the start-up sweep still stops the leftover and removes the file", winOnly, async () => {
  const result = await ownerCase("reused");
  assert.equal(result.orphanAlive, false, `the leftover was stopped: ${result.log.slice(-300)}`);
  assert.equal(result.registryLeft, false, "the registry file is removed");
});
test("pack 15: the owner is alive with no recorded creation time, or with its matching one: the sweep leaves the leftover and the file alone", winOnly, async () => {
  for (const kind of ["null", "match"] as const) {
    const result = await ownerCase(kind);
    assert.equal(result.orphanAlive, true, `owner alive (${kind}): the leftover is NOT stopped`);
    assert.equal(result.registryLeft, true, `owner alive (${kind}): the registry file stays`);
  }
});

// ---- A damaged chat file: the tab still opens, refuses chat, and Clear starts it over -------------------------------------------

test("a tab whose chat file is damaged opens with an empty history, refuses a chat message, and Clear keeps the file as .bad-* and starts an empty chat; other tabs are untouched", async () => {
  const data = makeData(), work = mkdtempSync(join(tmpdir(), "cc-pack2-damaged-work-"));
  const damaged = `{"role":"user","text":"hello"}\n{"role":"assis`;
  let first: Server | undefined, server: Server | undefined, client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    first = await boot(data);
    const setup = await connect(first);
    const projectId = setup.state().projects[0].id;
    setup.send({ type: "addTab", projectId, name: "Second", folder: work, requestId: "dm_add" });
    await setup.wait(() => setup.state().projects.flatMap((p: any) => p.tabs).length > 1, "second tab added");
    const [bad, good] = setup.state().projects.flatMap((p: any) => p.tabs).map((tab: any) => tab.id) as string[];
    setup.close(); await first.stop(); first = undefined;
    mkdirSync(join(data, "chats"), { recursive: true });
    const file = join(data, "chats", `${bad}.jsonl`);
    writeFileSync(file, damaged);
    const goodStore = new ChatStore(join(data, "chats")); goodStore.appendMessage(good, "user", "kept");
    const goodBefore = readFileSync(join(data, "chats", `${good}.jsonl`), "utf8");

    server = await boot(data); client = await connect(server);
    const tabOf = (id: string) => client!.state().projects.flatMap((p: any) => p.tabs).find((tab: any) => tab.id === id);
    const history = (id: string) => client!.messages.filter((m) => m.type === "chatHistory" && m.tabId === id);
    client.send({ type: "hello" });
    await client.wait(() => history(bad).length, "hello sends chatHistory for the damaged selected tab");
    assert.deepEqual([history(bad)[0].messages, history(bad)[0].revision, history(bad)[0].savedRevision], [[], 0, 0], "hello: empty history at revision 0");
    assert.match(tabOf(bad).chatProblem, /invalid chat transcript/);

    client.send({ type: "selectTab", tabId: good });
    await client.wait(() => history(good).length, "healthy tab opens");
    assert.equal(history(good)[0].messages[0].text, "kept");
    client.send({ type: "selectTab", tabId: bad });
    await client.wait(() => history(bad).length > 1, "selectTab to the damaged tab sends a chatHistory");
    assert.deepEqual([history(bad).at(-1).messages, history(bad).at(-1).revision], [[], 0], "selectTab: empty history at revision 0");
    assert.equal(client.messages.some((m) => m.type === "error" && /invalid chat transcript/.test(m.message)), false, "no error toast");
    client.send({ type: "selectTab", tabId: "no-such-tab" });
    await client.wait(() => client!.messages.find((m) => m.type === "error" && /unknown tab: no-such-tab/.test(m.message)), "an unknown tab is still refused");

    client.send({ type: "chat", tabId: bad, text: "are you there", requestId: "dm_chat" });
    const refused = await client.wait(() => client!.messages.find((m) => m.type === "error" && m.requestId === "dm_chat"), "chat refused");
    assert.equal(refused.message, "This chat could not be read. Clear it to start a new one.");
    await sleep(300);
    assert.equal(client.messages.some((m) => m.type === "chatMessage" || m.type === "chatError" || m.type === "chatDone"), false, "no turn was started");
    assert.equal(readFileSync(file, "utf8"), damaged, "the damaged file was not appended to");

    client.send({ type: "clear", tabId: bad });
    const cleared = await client.wait(() => client!.messages.find((m) => m.type === "chatCleared" && m.tabId === bad), "chatCleared");
    assert.equal(cleared.noUndo, true, "no Undo for a Clear with nothing good to restore");
    await client.wait(() => tabOf(bad) && !("chatProblem" in tabOf(bad)), "chatProblem gone");
    const kept = readdirSync(join(data, "chats")).filter((name) => name.startsWith(`${bad}.jsonl.bad-`));
    assert.equal(kept.length, 1, `one .bad copy: ${readdirSync(join(data, "chats"))}`);
    assert.equal(readFileSync(join(data, "chats", kept[0]), "utf8"), damaged, "the copy holds the original bytes");
    client.send({ type: "selectTab", tabId: good }); client.send({ type: "selectTab", tabId: bad });
    await client.wait(() => history(bad).length > 2, "history after Clear");
    assert.equal(history(bad).at(-1).messages.length, 0, "an empty chat");
    assert.equal(tabOf(bad).chatRevision, cleared.revision);
    assert.equal(readFileSync(join(data, "chats", `${good}.jsonl`), "utf8"), goodBefore, "the other tab's file is untouched");
    assert.equal(tabOf(good).chatRevision, 1);
  } finally {
    client?.close(); await server?.stop(); await first?.stop();
    removeWithRetry(data); removeWithRetry(work);
  }
});
