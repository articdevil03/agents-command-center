import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { importWithTempDataRoot, newAppKey, keyedWsUrl, stopOwnedChild } from "./temp-root.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { attachCrashCatcher } from "./crash-catcher.ts";

// leader.ts loads config.ts, which reads its data root once at import and sweeps leftover .seed-* folders in that root's config/. So it is loaded
// on a fresh temp data root, never on the repo's own live config/; the root stays in force as the modules keep it for their whole life.
const { dataDir: moduleDataDir, modules: { config, buildLeaderOptions } } = await importWithTempDataRoot(async () => ({
  config: await import("../server/config.ts"),
  buildLeaderOptions: (await import("../server/leader.ts")).buildLeaderOptions,
}));

test("this file's config module keeps its files in a temp data folder, never in the repo's config/", () => {
  assert.equal(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), moduleDataDir.toLowerCase());
  assert.notEqual(path.dirname(path.dirname(config.workspacesPath)).toLowerCase(), resolve(".").toLowerCase());
});

test("approval callback failures and aborted signals always deny", async () => {
  const options = buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, "ask", async () => { throw new Error("internal"); });
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const result: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x", content: "y" }, tool_use_id: "id", permission_mode: "default", session_id: "s", transcript_path: "x", cwd: "." }, "id", { signal: new AbortController().signal });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await options.canUseTool!("Write", {}, { signal: AbortSignal.abort(), toolUseID: "id" })).behavior, "deny");
});

test("the hook asks when the SDK mode is default OR the tab is saved as Ask", async () => {
  const hookFor = (saved: boolean, asked: string[]) => buildLeaderOptions({ model: "fake", effort: "medium" }, ".", null, undefined, saved ? "ask" : "accept", async (tool) => { asked.push(tool); return true; }, () => saved).hooks!.PreToolUse![0].hooks[0];
  const run = async (saved: boolean, liveMode: string, tool = "Write") => {
    const asked: string[] = [];
    const result: any = await hookFor(saved, asked)({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: "x" }, tool_use_id: "id", permission_mode: liveMode, session_id: "s", transcript_path: "x", cwd: "." } as any, "id", { signal: new AbortController().signal });
    return { asked, result };
  };
  // saved ask + a subagent or ExitPlanMode landing in another live mode still asks
  for (const live of ["acceptEdits", "bypassPermissions", "plan"]) assert.deepEqual((await run(true, live)).asked, ["Write"], `saved ask + live ${live}`);
  // saved accept + live default still asks: the live mode wins as before
  assert.deepEqual((await run(false, "default")).asked, ["Write"]);
  // saved accept + live acceptEdits and a tool outside the list never ask
  assert.deepEqual(await run(false, "acceptEdits"), { asked: [], result: {} });
  assert.deepEqual((await run(true, "acceptEdits", "Read")).asked, []);
});

test("real leader options and WS approval lifecycle", { timeout: 30000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-approvals-"));
  const home = join(temp, "home"), data = join(temp, "data");
  mkdirSync(home); mkdirSync(join(data, "config"), { recursive: true });
  // Use the production definition's entire roster, not a reduced fake state.
  const { getProcessDefinition } = await import("../server/process.ts");
  const tabs = ["approval-dev", "approval-other"].map((id) => ({ id, name: id, kind: "dev", process: "main", folder: temp, crew: getProcessDefinition("dev", "main").seats.map((s) => ({ slot: s.slotId, name: s.defaultName, cli: s.cli, model: s.model, effort: s.effort })) }));
  const spare = { id: "approval-spare", name: "approval-spare", kind: "dev", process: "main", folder: temp, crew: getProcessDefinition("dev", "main").seats.map((s) => ({ slot: s.slotId, name: s.defaultName, cli: s.cli, model: s.model, effort: s.effort })) };
  writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "approval", name: "Approval", folder: temp, tabs }, { id: "approval-two", name: "Approval Two", folder: temp, tabs: [spare] }] }));
  const script = join(temp, "cli.json"); writeFileSync(script, JSON.stringify({ responses: {} }));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as any).port; await new Promise<void>((ok) => probe.close(() => ok())); assert.notEqual(port, 4317);
  const key = newAppKey();
  const child = spawn(process.execPath, [join(resolve("."), "server", "index.ts")], { cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data, CC_PORT: String(port), CC_APP_KEY: key, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_LEADER: "1", CC_TEST_CHAT_TIMEOUT_MS: "600", CC_TEST_SAVE_WRITE_DELAY_MS: "200" } });
  attachCrashCatcher(child.pid, "approvals");
  const ipc: any[] = [], messages: any[] = []; let socket: WebSocket | undefined; let log = "";
  child.on("message", (m) => ipc.push(m)); child.stdout!.on("data", (d) => { log += d; }); child.stderr!.on("data", (d) => { log += d; });
  const wait = async (fn: () => any, label: string) => { const end = Date.now() + 5000; while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise((ok) => setTimeout(ok, 10)); } assert.fail(`${label}: ${log} IPC=${JSON.stringify(ipc)} messages=${JSON.stringify(messages.filter(m => m.type !== "state").slice(-5))}`); };
  const tabId = tabs[0].id;
  const state = () => messages.filter((m) => m.type === "state").at(-1);
  const pendingOf = (id: string) => state()?.projects.flatMap((p: any) => p.tabs).find((t: any) => t.id === id)?.pendingApprovals ?? [];
  const pending = () => pendingOf(tabId);
  const idle = (id = tabId) => !state().projects.flatMap((p: any) => p.tabs).find((t: any) => t.id === id).derived.leaderTurnActive;
  let number = 0;
  const action = async (payload: any) => { const requestId = `approval_request_${++number}`; socket!.send(JSON.stringify({ ...payload, requestId })); return await wait(() => messages.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "actionResult" || m.type === "permissionModeChanged")), payload.type); };
  const chat = (requests: any[]) => socket!.send(JSON.stringify({ type: "chat", tabId, text: JSON.stringify(requests) }));
  const write = { tool: "Write", input: { file_path: "C:/work/file.ts", content: "hello" } };
  try {
    await wait(() => log.includes("127.0.0.1"), "server start");
    // The mutation sweep's timeout cleanup finds a hung server by its command line, so that line must carry this run's own folder.
    if (process.platform === "win32") {
      const line = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 20000 }).stdout;
      assert.ok(line.includes(resolve(".")), `the server's command line must hold this run's folder ${resolve(".")}, got: ${line.trim()}`);
    }
    socket = new WebSocket(keyedWsUrl(`ws://127.0.0.1:${port}`, key), { origin: `http://127.0.0.1:${port}` }); socket.on("message", (raw) => messages.push(JSON.parse(String(raw)))); await once(socket, "open"); socket.send(JSON.stringify({ type: "hello" })); await wait(state, "initial state");
    await action({ type: "setPermissionMode", tabId, mode: "ask" });
    chat([write, { tool: "Bash", input: { command: "echo measured", description: "measured" } }]);
    await wait(() => pending().length === 2, "ask Write waits until answered");
    assert.equal(ipc.filter((m) => m.type === "hookResult").length, 0, "hook must wait");
    assert.equal(ipc.find((m) => m.type === "queryStarted").timeout, 86400);
    assert.deepEqual(ipc.find((m) => m.type === "queryStarted").sources, ["user", "project", "local"]);
    const ids = pending().map((p: any) => p.approvalId); const before = structuredClone(pending());
    assert.equal((await action({ type: "answerApproval", tabId: tabs[1].id, approvalId: ids[0], allow: true })).type, "error", "stale or wrong-tab answer must be refused"); assert.deepEqual(pending(), before);
    assert.equal((await action({ type: "answerApproval", tabId, approvalId: "unknown", allow: true })).type, "error"); assert.deepEqual(pending(), before);
    socket.send(JSON.stringify({ type: "save", tabId })); await wait(() => messages.some((m) => m.action === "save" && m.message.includes("waiting for your answer")), "Save gives clear refusal");
    assert.equal((await action({ type: "answerApproval", tabId, approvalId: ids[0], allow: true })).type, "actionResult");
    assert.equal((await action({ type: "answerApproval", tabId, approvalId: ids[1], allow: false })).type, "actionResult");
    await wait(() => ipc.filter((m) => m.type === "hookResult").length === 2, "answers resolve");
    assert.equal(ipc.find((m) => m.type === "hookResult" && m.tool === "Write").result.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(ipc.find((m) => m.type === "hookResult" && m.tool === "Bash").result.hookSpecificOutput.permissionDecisionReason, "The user denied this.");
    await wait(() => messages.some((m) => m.type === "chatDone"), "turn done");
    for (const mode of ["accept", "plan", "bypass", "ask"]) {
      await action({ type: "setPermissionMode", tabId, mode, confirm: true }); const start = ipc.length;
      chat([mode === "ask" ? { tool: "Read", input: { file_path: "x" } } : write]);
      const result = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), `${mode} returns immediately`); assert.deepEqual(result.result, {}); assert.equal(pending().length, 0);
      await wait(() => !state().projects[0].tabs[0].derived.leaderTurnActive, "idle turn");
    }
    await action({ type: "setPermissionMode", tabId, mode: "accept" });
    let start = ipc.length; chat([{ ...write, canUseTool: true }]); await wait(() => pending().length === 1, "accept-mode SDK callback waits");
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: true });
    const result = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "SDK allow"); assert.deepEqual(result.result, { behavior: "allow", updatedInput: write.input });
    await wait(() => !state().projects[0].tabs[0].derived.leaderTurnActive, "idle callback");
    await action({ type: "setPermissionMode", tabId, mode: "ask" });
    start = messages.length; chat([{ ...write, delayMs: 100 }]);
    await wait(() => state().projects[0].tabs[0].derived.leaderTurnActive, "active before approval");
    socket.send(JSON.stringify({ type: "save", tabId }));
    await wait(() => pending().length === 1, "approval appears while Save waits");
    await wait(() => messages.slice(start).some((m) => m.action === "save" && m.message.includes("waiting for your answer")), "waiting Save refuses promptly");
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: false });
    await wait(() => !state().projects[0].tabs[0].derived.leaderTurnActive, "idle delayed turn");
    // Save's OWN Write approval: Save waits for the answer (its timeout is 600 ms here) instead of refusing.
    const saveErrors = (from: number) => messages.slice(from).filter((m) => m.type === "error" && m.action === "save");
    start = messages.length; socket.send(JSON.stringify({ type: "save", tabId }));
    await wait(() => pending().length === 1, "Save itself requests approval");
    assert.equal(saveErrors(start).length, 0, "Save does not refuse its own approval");
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: false });
    await wait(() => saveErrors(start).some((m) => m.message.includes("could not save the handover")), "Save fails with a clear message after Deny");
    assert.equal(messages.slice(start).some((m) => m.type === "saved"), false); assert.equal(existsSync(join(temp, ".command-center", tabId, "RESUME.md")), false);
    await wait(() => idle(), "idle Save turn");
    const beforeSaved = state().projects[0].tabs[0].savedRevision;
    start = messages.length; socket.send(JSON.stringify({ type: "save", tabId }));
    await wait(() => pending().length === 1, "second Save requests approval");
    assert.equal(pending()[0].tool, "Write"); assert.match(pending()[0].summary, /^[^\n]*RESUME\.md\n\nNew content:\nhandover$/);
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(pending().length, 1, "still waiting past the Save timeout"); assert.equal(saveErrors(start).length, 0, "Save timeout does not fire while its own approval is pending");
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: true });
    const saved = await wait(() => messages.slice(start).find((m) => m.type === "saved" && m.tabId === tabId), "Save completes after Allow");
    assert.equal(saved.savedRevision, saved.revision); assert.ok(existsSync(join(temp, ".command-center", tabId, "RESUME.md")), "the handover was written");
    await wait(() => idle(), "idle after Save");
    assert.equal(messages.slice(start).filter((m) => m.type === "saved").length, 1, "Save reports saved exactly once");
    const savedChanges = (from: number, before: number) => {
      let previous = before, changes = 0;
      for (const m of messages.slice(from)) {
        const revision = m.type === "state" ? m.projects.flatMap((p: any) => p.tabs).find((t: any) => t.id === tabId)?.savedRevision : m.tabId === tabId ? m.savedRevision : undefined;
        if (revision !== undefined && revision !== previous) { changes++; previous = revision; }
      }
      return changes;
    };
    assert.equal(savedChanges(start, beforeSaved), 1, "normal Save changes savedRevision exactly once");
    // Add an unsaved revision, then Allow near the end of the 600ms execution budget.
    chat([{ tool: "Read", input: { file_path: "x" }, delayMs: 100 }]); await wait(() => !idle(), "new unsaved turn"); await wait(() => idle(), "unsaved turn finished");
    const beforeLate = state().projects[0].tabs[0].savedRevision;
    start = messages.length; socket.send(JSON.stringify({ type: "save", tabId }));
    await wait(() => pending().length === 1, "late Save requests approval");
    await new Promise((ok) => setTimeout(ok, 510));
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: true });
    const lateSaved = await wait(() => messages.slice(start).find((m) => m.type === "saved"), "late Allow leaves a full execution timeout");
    await wait(() => idle(), "idle after late Save"); await new Promise((ok) => setTimeout(ok, 650));
    assert.equal(saveErrors(start).length, 0, "late Save must not time out after Allow");
    assert.equal(lateSaved.savedRevision, lateSaved.revision);
    assert.equal(messages.slice(start).filter((m) => m.type === "saved").length, 1, "late Save reports saved exactly once");
    assert.equal(savedChanges(start, beforeLate), 1, "Save changes savedRevision exactly once");
    // Every listed tool asks, and a chat while an approval is pending gets the approval message.
    start = messages.length; chat([{ tool: "Edit", input: { file_path: "C:/w/edit.ts" } }, { tool: "MultiEdit", input: { file_path: "C:/w/multi.ts" } }, { tool: "NotebookEdit", input: { notebook_path: "C:/w/book.ipynb" } }, { tool: "PowerShell", input: { command: "Get-Date" } }]);
    await wait(() => pending().length === 4, "Edit, MultiEdit, NotebookEdit and PowerShell all ask");
    assert.deepEqual(pending().map((p: any) => `${p.tool}:${p.summary}`).sort(), ["Edit:C:/w/edit.ts", "MultiEdit:C:/w/multi.ts", "NotebookEdit:C:/w/book.ipynb", "PowerShell:Get-Date"]);
    start = messages.length; chat([write]);
    await wait(() => messages.slice(start).some((m) => m.type === "error" && m.message === "Atlas is waiting for your answer on a change"), "chat refused with the approval message while one is pending");
    const four = structuredClone(pending());
    const yes = await action({ type: "answerApproval", tabId, approvalId: four[0].approvalId, allow: "yes" as any }); assert.equal(yes.type, "error"); assert.match(yes.message, /boolean/); assert.deepEqual(pending(), four, "a non-boolean allow settles nothing");
    for (const item of four) await action({ type: "answerApproval", tabId, approvalId: item.approvalId, allow: false });
    await wait(() => idle(), "idle after four answers");
    // Allow approves the whole operation, so the card carries all of it, as a plain terminal would show the diff.
    chat([{ tool: "Write", input: { file_path: "C:/w/new.ts", content: "line one\nline two" } },
      { tool: "Edit", input: { file_path: "C:/w/e.ts", old_string: "before text", new_string: "after text", replace_all: true } },
      { tool: "MultiEdit", input: { file_path: "C:/w/m.ts", edits: [{ old_string: "a1", new_string: "b1" }, { old_string: "a2", new_string: "b2", replace_all: true }] } },
      { tool: "NotebookEdit", input: { notebook_path: "C:/w/n.ipynb", cell_id: "c7", cell_type: "code", edit_mode: "insert", new_source: "print(1)" } },
      { tool: "Bash", input: { command: "npm test", cwd: "C:/w", description: "run the tests" } }]);
    await wait(() => pending().length === 5, "five full-change approvals");
    const card = (tool: string) => pending().find((p: any) => p.tool === tool).summary;
    assert.equal(card("Write"), "C:/w/new.ts\n\nNew content:\nline one\nline two");
    assert.equal(card("Edit"), "C:/w/e.ts\n\nReplaces every match\nReplace:\nbefore text\n\nWith:\nafter text");
    assert.equal(card("MultiEdit"), "C:/w/m.ts\n\nEdit 1 of 2:\nReplace:\na1\n\nWith:\nb1\n\nEdit 2 of 2:\nReplaces every match\nReplace:\na2\n\nWith:\nb2");
    assert.equal(card("NotebookEdit"), "C:/w/n.ipynb\n\nCell: c7\nCell type: code\nEdit mode: insert\n\nNew source:\nprint(1)");
    assert.equal(card("Bash"), "npm test\n\nRuns in: C:/w\n\nDescription: run the tests");
    for (const item of structuredClone(pending())) await action({ type: "answerApproval", tabId, approvalId: item.approvalId, allow: false });
    await wait(() => idle(), "idle after the full-change cards");
    // Saved ask + a live mode other than default still asks (the call site passes the saved mode).
    chat([{ ...write, permissionMode: "acceptEdits" }]); await wait(() => pending().length === 1, "saved ask + live acceptEdits asks");
    await action({ type: "answerApproval", tabId, approvalId: pending()[0].approvalId, allow: false }); await wait(() => idle(), "idle after acceptEdits ask");
    // A leader that ends on its own mid-approval denies and clears it.
    start = ipc.length; chat([write]); await wait(() => pending().length === 1, "pending before the leader dies");
    child.send("end-query");
    const died = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "a leader ending on its own denies its approval"); assert.equal(died.result.hookSpecificOutput.permissionDecision, "deny");
    await wait(() => pending().length === 0, "dead leader approval cleared"); await wait(() => idle(), "idle after the leader died");
    // A hook from a leader replaced meanwhile is denied at once and never shown.
    start = ipc.length; chat([{ ...write, delayMs: 400 }]); await wait(() => !idle(), "delayed turn active");
    socket.send(JSON.stringify({ type: "clear", tabId }));
    const late = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "a replaced leader's late request is denied at once"); assert.equal(late.result.hookSpecificOutput.permissionDecision, "deny"); assert.equal(pending().length, 0);
    await wait(() => state().projects[0].tabs[0].leaderStatus === "not-started", "cleared before the next step");
    start = ipc.length; chat([write]); await wait(() => pending().length === 1, "stop pending"); const stoppedId = pending()[0].approvalId;
    socket.send(JSON.stringify({ type: "clear", tabId }));
    const denied = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "stopping resolves pending as deny"); assert.equal(denied.result.hookSpecificOutput.permissionDecision, "deny"); await wait(() => pending().length === 0, "stop clears state");
    assert.equal((await action({ type: "answerApproval", tabId, approvalId: stoppedId, allow: true })).type, "error");
    start = ipc.length; chat([write]); await wait(() => pending().length === 1, "replacement pending"); const replacement = structuredClone(pending());
    assert.equal((await action({ type: "answerApproval", tabId, approvalId: stoppedId, allow: true })).type, "error"); assert.deepEqual(pending(), replacement);
    child.send("abort-approval"); await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "signal abort denies"); await wait(() => pending().length === 0, "abort clears");
    await wait(() => !state().projects[0].tabs[0].derived.leaderTurnActive, "abort turn idle");
    // A stopped session is recreated with a fresh tool signal before testing removal.
    socket.send(JSON.stringify({ type: "clear", tabId })); await wait(() => state().projects[0].tabs[0].leaderStatus === "not-started", "clear replacement");
    start = ipc.length; chat([write]); await wait(() => pending().length === 1, "remove pending");
    socket.send(JSON.stringify({ type: "removeTab", tabId }));
    await wait(() => !state().projects[0].tabs.some((t: any) => t.id === tabId), "tab removed");
    const removed = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "removal denies"); assert.equal(removed.result.hookSpecificOutput.permissionDecision, "deny");
    const remainingId = tabs[1].id;
    start = ipc.length;
    socket.send(JSON.stringify({ type: "chat", tabId: remainingId, text: JSON.stringify([{ ...write, canUseTool: true }]) }));
    await wait(() => state().projects[0].tabs[0].pendingApprovals.length === 1, "SDK deny pending");
    await action({ type: "answerApproval", tabId: remainingId, approvalId: state().projects[0].tabs[0].pendingApprovals[0].approvalId, allow: false });
    const shutdown = await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "SDK denial resolves");
    assert.deepEqual(shutdown.result, { behavior: "deny", message: "The user denied this." });
    // removeProject denies a pending approval and removes, like removeTab.
    await action({ type: "setPermissionMode", tabId: spare.id, mode: "ask" });
    start = ipc.length; socket.send(JSON.stringify({ type: "chat", tabId: spare.id, text: JSON.stringify([write]) }));
    await wait(() => pendingOf(spare.id).length === 1, "spare project approval pending");
    socket.send(JSON.stringify({ type: "removeProject", projectId: "approval-two" }));
    await wait(() => !state().projects.some((p: any) => p.id === "approval-two"), "project with a pending approval removed");
    assert.equal((await wait(() => ipc.slice(start).find((m) => m.type === "hookResult"), "project removal denies")).result.hookSpecificOutput.permissionDecision, "deny");

  } finally {
    socket?.terminate();
    // Bounded, and the temp folder goes even when the server will not stop (or a test assertion is already failing).
    try { await stopOwnedChild(child); } finally { removeWithRetry(temp); }
  }
});
