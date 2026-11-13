import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { loadFixed, fixedGateServer, startHelper, ASSIST, connect, lastState, tick, waitFor } from "./round2-helpers.ts";
import { pendingFor, tabState } from "./round2-gate-helpers.ts";

test("a tab over the pending request cap is refused with a clear message and the echoed id, from the panel", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  const exists = (tabId: string) => ["alpha-dev", "beta-dev"].includes(tabId);
  for (let index = 0; index < 50; index++) server.requestsStore.send({ fromTabId: "alpha-dev", toTabId: "beta-dev", title: `Fill ${index}`, body: "Filler." }, exists);
  ws.message({ type: "sendRequest", requestId: "send_over_cap", fromTabId: "alpha-dev", toTabId: "beta-dev", title: "One too many", body: "Refused." });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "send_over_cap"), "over-cap refusal");
  const refusal = ws.messages.find((message: any) => message.type === "error" && message.requestId === "send_over_cap");
  assert.match(refusal.message, /too many pending requests from this tab/);
  assert.equal(server.requestsStore.list().length, 50);
  const failed = Object.values(server.stateMessage().requestActions).filter((action: any) => action.status === "failed" && /too many pending/.test(action.message));
  assert.equal(failed.length >= 1, true);
  assert.equal(server.requestsStore.list().length, 50);
});

test("a permission change for a tab that does not exist is refused and leaves nothing in state", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  ws.message({ type: "hello" });
  ws.message({ type: "setPermissionMode", requestId: "perm_ghost", tabId: "zz-not-a-tab", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "error" && message.requestId === "perm_ghost"), "unknown tab refusal");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "zz-not-a-tab"), false);
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionModes, "zz-not-a-tab"), false);
  ws.message({ type: "setPermissionMode", requestId: "perm_real", tabId: "alpha-dev", mode: "plan" });
  await waitFor(() => ws.messages.some((message: any) => message.type === "actionResult" && message.requestId === "perm_real"), "real tab result");
  assert.equal(Object.hasOwn(server.stateMessage().settings.permissionActions, "alpha-dev"), true, "a real tab still records its action");
});

// The fixed launch call site for one tab's current leader: the approval is asked from here, whatever slot it is for.
const launchFrom = (server: any, tabId: string, brief: string) => server.launchFixedAction(server.currentActor(tabId), null, ASSIST, brief, "helper");

async function twoTabApprovals() {
  const server = await loadFixed({ skipHealth: true });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create leader" });
  ws.message({ type: "chat", tabId: "beta-dev", text: "create leader" });
  await tick();
  for (const tabId of ["alpha-dev", "beta-dev"]) {
    ws.message({ type: "setPermissionMode", requestId: `two_tab_${tabId}`, tabId, mode: "ask" });
    await waitFor(() => server.settingsService.permissionMode(tabId) === "ask", `${tabId} ask`);
  }
  return { server, ws };
}

test("each tab's state lists only its own pending approvals", async () => {
  const { server, ws } = await twoTabApprovals();
  const alpha = launchFrom(server, "alpha-dev", "alpha work"), beta = launchFrom(server, "beta-dev", "beta work");
  alpha.catch(() => {}); beta.catch(() => {});
  await waitFor(() => server.pendingApprovals.size === 2, "two pending approvals");
  const listed = server.stateMessage().projects.flatMap((project: any) => project.tabs).map((tab: any) => [tab.id, tab.pendingApprovals.map((item: any) => item.summary)]).filter(([, list]: any) => list.length);
  assert.equal(JSON.stringify(listed), JSON.stringify([["alpha-dev", ["Action: assist\nPosition: Helper (helper)\nExecution: codex / gpt-6.1-sol / low\nFolder: C:/work/alpha\n\nLeader brief:\nalpha work"]], ["beta-dev", ["Action: assist\nPosition: Helper (helper)\nExecution: codex / gpt-6.1-sol / low\nFolder: C:/work/beta\n\nLeader brief:\nbeta work"]]]));
});

test("answering an approval with another tab's id is refused even when that tab has a live leader", async () => {
  const { server, ws } = await twoTabApprovals();
  const waiting = launchFrom(server, "alpha-dev", "alpha work"); waiting.catch(() => {});
  await waitFor(() => server.pendingApprovals.size === 1, "alpha approval");
  const [item] = [...server.pendingApprovals.values()] as any[];
  ws.message({ type: "answerApproval", requestId: "wrong_tab_answer", tabId: "beta-dev", approvalId: item.approvalId, allow: true });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /no longer available/);
  assert.equal(server.pendingApprovals.size, 1, "the approval is still waiting");
  assert.equal(server.launched.length, 0);
  ws.message({ type: "answerApproval", requestId: "right_tab_answer", tabId: "alpha-dev", approvalId: item.approvalId, allow: false });
  await assert.rejects(waiting, /The owner denied this action\./);
  server.stopLeaderSession("alpha-dev"); server.stopLeaderSession("beta-dev");
});

test("answering a leader's approval is refused once that leader is dead, even if its stop has not yet cleared the approval", async () => {
  const { server, ws } = await twoTabApprovals();
  const waiting = launchFrom(server, "alpha-dev", "alpha work"); waiting.catch(() => {});
  await waitFor(() => server.pendingApprovals.size === 1, "alpha approval");
  const [item] = [...server.pendingApprovals.values()] as any[];
  const leader = server.leaders.get("alpha-dev") as any, handle = server.leaderHandles[0] as any;
  handle.dead = true; assert.equal(leader.isDead(), true, "control: the leader is dead and its approval is still listed");
  ws.message({ type: "answerApproval", requestId: "dead_leader_answer", tabId: "alpha-dev", approvalId: item.approvalId, allow: true });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /no longer available/);
  assert.equal(server.pendingApprovals.size, 1, "the dead leader's approval is not settled by an answer");
  assert.equal(server.launched.length, 0);
  handle.dead = false;
  ws.message({ type: "answerApproval", requestId: "live_leader_deny", tabId: "alpha-dev", approvalId: item.approvalId, allow: false });
  await assert.rejects(waiting, /The owner denied this action\./);
  server.stopLeaderSession("alpha-dev"); server.stopLeaderSession("beta-dev");
});

test("answerApproval without a request id is refused and settles nothing", async () => {
  const { server, ws } = await twoTabApprovals();
  const waiting = launchFrom(server, "alpha-dev", "alpha work"); waiting.catch(() => {});
  await waitFor(() => server.pendingApprovals.size === 1, "alpha approval");
  const [item] = [...server.pendingApprovals.values()] as any[];
  ws.message({ type: "answerApproval", tabId: "alpha-dev", approvalId: item.approvalId, allow: true });
  assert.equal(ws.messages.at(-1).type, "error");
  assert.match(ws.messages.at(-1).message, /requestId is required/);
  assert.equal(server.pendingApprovals.size, 1);
  assert.equal(server.launched.length, 0);
  ws.message({ type: "answerApproval", requestId: "with_request_id", tabId: "alpha-dev", approvalId: item.approvalId, allow: false });
  await assert.rejects(waiting, /The owner denied this action\./);
  server.stopLeaderSession("alpha-dev"); server.stopLeaderSession("beta-dev");
});

test("the leader test seam needs BOTH test flags; the fake leader flag alone never loads the test module", async () => {
  const server = await loadFixed({ skipHealth: true, leaderSeamOnly: true })
    .catch((err: any) => assert.fail(`the server reached for the test module with only CC_TEST_FAKE_LEADER set: ${err?.code ?? err}`));
  assert.ok(server.wss, "the server starts and ignores a lone CC_TEST_FAKE_LEADER");
  // Control: with both flags the server source does reach for the test module (the vm has no dynamic import), so the check above can go red.
  await assert.rejects(loadFixed({ skipHealth: true, bothSeams: true }), { code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING" });
});

test("a slower, older Changes and Notes refresh cannot overwrite a newer one", async () => {
  const gates: Array<(value: any) => void> = [];
  const server = await loadFixed({ skipHealth: true, gitChanges: () => new Promise((resolveChanges) => { gates.push(resolveChanges); }) });
  const ws = connect(server);
  const before = gates.length;
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  ws.message({ type: "selectTab", tabId: "alpha-dev" });
  await waitFor(() => gates.length === before + 2, "two refreshes in flight");
  const changes = (branch: string) => ({ repo: true, branch, ahead: 0, behind: 0, lastCommit: null, uncommittedFiles: [] });
  gates[before + 1](changes("newer"));
  await tick();
  assert.equal(tabState(ws, "alpha-dev").changes.branch, "newer");
  gates[before](changes("older"));
  await tick();
  assert.equal(tabState(ws, "alpha-dev").changes.branch, "newer", "the late older refresh was dropped");
});

test("chat refuses a scratch attachment whose name is not file-<uuid>, and takes one that is", async () => {
  const server = await loadFixed({ skipHealth: true }), ws = connect(server);
  const scratch = path.join(server.testRoot, "scratch");
  mkdirSync(scratch, { recursive: true });
  const odd = path.join(scratch, "notes.txt");
  writeFileSync(odd, "not generated by an upload");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [odd], requestId: "file_odd_name" });
  assert.equal(ws.messages.at(-1).requestId, "file_odd_name");
  assert.match(ws.messages.at(-1).message, /uploaded scratch file/);
  assert.equal(server.leaders.size, 0);
  const good = path.join(scratch, `file-${randomUUID()}.txt`);
  writeFileSync(good, "generated");
  ws.message({ type: "chat", tabId: "alpha-dev", text: "read this", files: [good], requestId: "file_good_name" });
  assert.ok(ws.messages.some((message: any) => message.type === "chatMessage" && message.requestId === "file_good_name"));
  await tick();
});

test("final2 Allow then Plan refuses the launch at resume", async () => {
  for (const timing of ["before Allow", "after Allow"]) {
    const { server, ws, deps } = await fixedGateServer("ask");
    const launch = deps.launch("helper", "work");
    await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
    if (timing === "before Allow") server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    ws.message({ type: "answerApproval", requestId: "after_plan", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    if (timing === "after Allow") server.settingsService.state.permissionModes["alpha-dev"] = "plan";
    const result = await launch;
    assert.equal(server.launched.length, 0, `${timing}: Plan is active, but Allow launched a worker`);
    assert.match(result.error, /permission changed while approving/);
    assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "no reservation is left behind");
    server.stopLeaderSession("alpha-dev");
  }
});

test("final2 Allow then Clear before resume starts nothing", async () => {
  const { server, ws, deps } = await fixedGateServer("ask");
  const launch = deps.launch("helper", "work");
  await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "answerApproval", requestId: "before_clear", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  ws.message({ type: "clear", tabId: "alpha-dev" });
  const result = await launch;
  assert.equal(server.launched.length, 0, "Cleared leader still launches its worker after Allow resumes");
  assert.match(result.error, /no longer current/);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "no reservation is left behind");
});

test("final2 a changed assignment cancels the launch after Allow", async () => {
  const { server, ws, deps } = await fixedGateServer("ask");
  const launch = deps.launch("helper", "work");
  await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
  ws.message({ type: "setCrewAssignment", requestId: "change_while_asking", tabId: "alpha-dev", slot: "helper", assignment: { cli: "codex", model: "gpt-6.1-sol", effort: "high" } });
  await waitFor(() => server.getWorkspaces().projects[0].tabs[0].fixedCrew.preferences.helper.assignment.effort === "high", "the helper assignment is saved while the approval waits");
  ws.message({ type: "answerApproval", requestId: "changed_assignment", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
  const result = await launch;
  assert.equal(server.launched.length, 0, "a changed assignment launched after Allow");
  assert.match(result.error, /assignment or permission changed while approving/);
  assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null);
  server.stopLeaderSession("alpha-dev");
});

test("final2 Plan mode refuses a launch without waiting for an approval", async () => {
  const { server, deps } = await fixedGateServer("plan");
  const plan = await Promise.race([deps.launch("helper", "work"), tick(150).then(() => null)]);
  assert.equal(plan?.ok, false, "Plan must refuse without waiting for approval");
  assert.match(plan?.error, /Plan mode/);
  assert.equal(pendingFor(server).length, 0);
  assert.equal(server.launched.length, 0);
  server.stopLeaderSession("alpha-dev");
});

test("final2 an approved launch still runs after switching to Accept or Bypass", async () => {
  for (const mode of ["accept", "bypass"] as const) {
    const { server, ws, deps } = await fixedGateServer("ask");
    const launch = deps.launch("helper", "work");
    await waitForApproval(() => pendingFor(server).length === 1, "launch approval");
    await server.leaders.get("alpha-dev").setPermissionMode(mode);
    server.settingsService.state.permissionModes["alpha-dev"] = mode;
    ws.message({ type: "answerApproval", requestId: "changed_" + mode, tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    assert.equal((await launch).ok, true);
    server.stopLeaderSession("alpha-dev");
  }
});

async function waitForApproval(predicate: () => boolean, label: string) { try { await waitFor(predicate, label); } catch (error) { assert.fail((error as Error).message); } }

async function liveFixedLeader() {
  let sdk: any;
  const server = await loadFixed({ skipHealth: true, sdkLeader: ({ options }: any) => {
    sdk = options;
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, async return() { return { done: true }; }, async setModel() {}, async setPermissionMode() {} };
  } });
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "start" });
  const observe = (mode: string) => sdk.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", permission_mode: mode,
    tool_name: "mcp__tab-crew__request_task_action", tool_input: {} }, "id", { signal: new AbortController().signal });
  const tool = server.leaderDeps.get("Development").fixedSpecs().find((spec: any) => spec.name === "request_task_action");
  const launch = () => tool.handler({ expected: null, ...ASSIST, brief: "live fixed work" });
  assert.equal(server.settingsService.permissionMode("alpha-dev"), "accept", "control: the saved mode is Accept");
  return { server, ws, observe, launch };
}

test("final2 live default with saved Accept asks through the real SDK hook and fixed launch tool", async () => {
  const { server, ws, observe, launch } = await liveFixedLeader();
  try {
    await observe("default");
    const waiting = launch(); waiting.catch(() => {});
    await tick();
    assert.equal(pendingFor(server).length, 1, "live default with saved Accept must ask before fixed work");
    assert.equal(server.launched.length, 0, "live default must not launch before Allow");
    ws.message({ type: "answerApproval", requestId: "live_fixed_allow", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    const result = JSON.parse((await waiting).content[0].text);
    assert.equal(server.launched.length, 1, "Allow starts exactly one fixed worker");
    assert.equal(result.runId, server.launched[0].run.runId, "the fixed tool returns the launched run");
    assert.equal(pendingFor(server).length, 0, "Allow settles the approval callback");
    server.closeRun(result.runId, 0);
  } finally { server.stopLeaderSession("alpha-dev"); }
});

test("final2 live Plan with saved Accept refuses through the real SDK hook and fixed launch tool", async () => {
  const { server, observe, launch } = await liveFixedLeader();
  try {
    await observe("plan");
    await assert.rejects(launch(), /Switch out of Plan mode before starting fixed work\./);
    assert.equal(server.launched.length, 0, "live Plan starts no worker");
    assert.equal(pendingFor(server).length, 0, "live Plan refuses without asking");
    assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "live Plan reserves nothing");
  } finally { server.stopLeaderSession("alpha-dev"); }
});

test("final2 live Plan after Allow cancels the fixed launch with saved Accept", async () => {
  const { server, ws, observe, launch } = await liveFixedLeader();
  try {
    await observe("default");
    const waiting = launch(); waiting.catch(() => {});
    await tick();
    assert.equal(pendingFor(server).length, 1, "the fixed launch is waiting for Allow");
    ws.message({ type: "answerApproval", requestId: "live_fixed_plan", tabId: "alpha-dev", approvalId: pendingFor(server)[0].approvalId, allow: true });
    const observed = observe("plan");
    await assert.rejects(waiting, /The assignment or permission changed while approving\./);
    await observed;
    assert.equal(server.launched.length, 0, "live Plan after Allow starts no worker");
    assert.equal(pendingFor(server).length, 0, "Allow executed and settled its callback");
    assert.equal(server.executionJournal(server.testRoot, "alpha-dev").activeExecutionId, null, "cancelled work reserves nothing");
  } finally { server.stopLeaderSession("alpha-dev"); }
});
