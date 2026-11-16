import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { api, setup } from "./pack29-first-run.setup.ts";
import { scratchDir, stopOwnedChild } from "./temp-root.ts";
import { spawnFakeLeaderCli } from "./fake-leader-cli.ts";
const { createOpencodeLeader } = await import("../server/leader-opencode.ts");

async function until(check: () => unknown, label: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (check()) return; await new Promise((ok) => setTimeout(ok, 10)); }
  assert.fail(label);
}

async function fixture(fakeEnv: Record<string, string> = {}) {
  const context = setup(), folder = scratchDir(), log = join(folder, "fake.log");
  const state = api.state, tab = state.workspaces.projects[0].tabs[0];
  tab.fixedCrew!.preferences.leader = { assignment: { cli: "opencode", model: "fakeprov/fake-model", effort: "" }, source: "user" };
  const bridge = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  await new Promise<void>((ok) => bridge.listen(0, "127.0.0.1", ok));
  let child: ChildProcess | undefined, finished = 0;
  const errors: string[] = [];
  const leader = createOpencodeLeader({ model: "fakeprov/fake-model" }, folder, {
    onDelta() {}, onUsage() {}, onDone() { finished++; }, onError(message) { errors.push(message); },
  }, {
    mode: "accept", ask: async () => true,
    bridge: { url: `http://127.0.0.1:${(bridge.address() as { port: number }).port}/mcp`, token: "synthetic-bridge-token" },
    spawnFn: (command, options) => { child = spawnFakeLeaderCli(command, { ...options, env: { ...options.env, ...fakeEnv, FAKE_LEADER_LOG: log } }); return child; },
  });
  state.leaders.set(tab.id, leader);
  const socket = [...state.clients][0]; let sequence = 0;
  const dispatch = async (mode: string) => {
    const requestId = `p36-${++sequence}`;
    api.messages.handleMessage(socket, JSON.stringify({ type: "setPermissionMode", tabId: tab.id, requestId, mode, confirm: true }));
    await until(() => context.replies.find((r) => r.requestId === requestId && ["error", "actionResult"].includes(r.type)), "mode handler answered");
    return context.replies.find((r) => r.requestId === requestId && ["error", "actionResult"].includes(r.type));
  };
  const entries = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { leader, dispatch, entries, errors, done: () => finished, saved: () => state.settingsService.permissionMode(tab.id),
    savedBytes: () => existsSync(state.settingsService.path) ? readFileSync(state.settingsService.path, "utf8") : null,
    close: async () => {
      leader.stop(); if (child) await stopOwnedChild(child, 1500);
      await new Promise<void>((ok) => bridge.close(() => ok()));
      state.leaders.clear(); state.settingsService.cliKeys.close();
      assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "owned fake ended");
    },
  };
}

test("real mode handler refuses a running OpenCode turn, preserves both modes, then PATCHes the next turn", async () => {
  const f = await fixture();
  try {
    assert.equal(f.leader.modeLocked?.() ?? false, false, "idle handle is unlocked");
    assert.equal((await f.dispatch("accept")).type, "actionResult", "idle change works");
    const before = f.savedBytes(), patches = () => f.entries().filter((r) => r.method === "PATCH");
    const patchCount = patches().length;
    f.leader.send(JSON.stringify([{ sleep: 500 }, { say: "finished" }]));
    const refusal = await f.dispatch("bypass");
    assert.equal(refusal.type, "error");
    assert.match(refusal.message, /^Finish or stop .+'s current turn first, then change the mode\.$/);
    assert.equal(f.leader.modeLocked?.(), true, "send locks until turn completion");
    assert.equal(f.saved(), "accept"); assert.equal(f.savedBytes(), before);
    assert.equal(f.leader.getPermissionMode!(), "acceptEdits");
    assert.equal(patches().length, patchCount, "busy change never PATCHes");
    await until(() => f.done() === 1, "held turn ended");
    assert.equal(f.leader.modeLocked?.(), false);
    assert.equal((await f.dispatch("bypass")).type, "actionResult");
    assert.equal(f.saved(), "bypass"); assert.equal(f.leader.getPermissionMode!(), "bypassPermissions");
    assert.ok(patches().at(-1).body.permission.some((rule: any) => rule.permission === "*" && rule.pattern === "*" && rule.action === "allow"), "PATCH applies allow rules before next turn");
    f.leader.send(JSON.stringify([{ sleep: 400 }, { read: ".env" }]));
    assert.equal((await f.dispatch("ask")).type, "error", "reverse switch is also refused");
    assert.equal(f.saved(), "bypass"); assert.equal(f.leader.getPermissionMode!(), "bypassPermissions");
    await until(() => f.done() === 2, "next turn used patched rules and ended");
    assert.equal(f.entries().filter((r) => /^\/permission\//.test(r.path)).length, 0, "next read ran under patched Bypass rules");
    assert.equal((await f.dispatch("ask")).type, "actionResult");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Stop clears a running OpenCode lock", async () => {
  const f = await fixture();
  try {
    f.leader.send(JSON.stringify([{ hang: true }]));
    assert.equal(f.leader.modeLocked?.(), true);
    f.leader.stop(); assert.equal(f.leader.modeLocked?.(), false);
    assert.equal((await f.dispatch("ask")).type, "actionResult", "stopped session cannot lock saved mode");
  } finally { await f.close(); }
});

test("a failed turn clears the OpenCode lock", async () => {
  const f = await fixture();
  try {
    f.leader.send(JSON.stringify([{ error: "synthetic turn failure" }]));
    assert.equal(f.leader.modeLocked?.(), true);
    await until(() => f.errors.length > 0, "turn failure reported");
    assert.match(f.errors[0], /synthetic turn failure/);
    assert.equal(f.leader.modeLocked?.(), false);
    assert.equal((await f.dispatch("ask")).type, "actionResult");
  } finally { await f.close(); }
});

test("a steer keeps the lock until the combined turn ends", async () => {
  const f = await fixture();
  try {
    f.leader.send(JSON.stringify([{ sleep: 400 }]));
    await until(() => f.entries().some((r) => /prompt_async$/.test(r.path)), "first prompt accepted");
    assert.equal(f.leader.steer!("steered message"), true);
    assert.equal(f.leader.modeLocked?.(), true);
    assert.equal((await f.dispatch("bypass")).type, "error");
    await until(() => f.done() === 1, "steered turn ended");
    assert.equal(f.leader.modeLocked?.(), false);
  } finally { await f.close(); }
});

const order = (entries: any[], match: (r: any) => boolean) => entries.findIndex(match);

test("a message sent while a between-turns mode change is still applying starts after the PATCH, on the new rules", async () => {
  const f = await fixture({ FAKE_OPENCODE_PATCH_DELAY_MS: "600" });
  try {
    const change = f.leader.setPermissionMode!("bypass");
    await until(() => f.entries().some((r) => r.method === "PATCH"), "PATCH reached the fake and is held");
    f.leader.send(JSON.stringify([{ read: ".env" }, { say: "ran" }]));
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(f.entries().some((r) => /prompt_async$/.test(r.path)), false, "prompt is held back while the PATCH is pending");
    assert.equal(await change, true);
    await until(() => f.done() === 1, "turn ended without asking");
    const all = f.entries();
    const patch = order(all, (r) => r.method === "PATCH"), applied = order(all, (r) => r.patchApplied), prompt = order(all, (r) => /prompt_async$/.test(r.path || ""));
    assert.ok(patch >= 0 && applied > patch && prompt > applied, `order PATCH ${patch}, applied ${applied}, prompt ${prompt}`);
    assert.equal(all.filter((r) => /^\/permission\//.test(r.path || "")).length, 0, "the read ran under the new Bypass rules, not asked");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a steered second message waits for the applying mode change too", async () => {
  const f = await fixture({ FAKE_OPENCODE_PATCH_DELAY_MS: "600" });
  try {
    const change = f.leader.setPermissionMode!("bypass");
    await until(() => f.entries().some((r) => r.method === "PATCH"), "PATCH reached the fake and is held");
    f.leader.send("FIRST message");
    assert.equal(f.leader.steer!("SECOND steered message"), true, "second message joins as a steer");
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(f.entries().some((r) => /prompt_async$/.test(r.path || "")), false, "neither prompt is posted while the PATCH is pending");
    assert.equal(await change, true);
    await until(() => f.done() === 1, "turn ended");
    const all = f.entries(), applied = order(all, (r) => r.patchApplied);
    const prompts = all.map((r, i) => /prompt_async$/.test(r.path || "") ? i : -1).filter((i) => i >= 0);
    assert.equal(prompts.length, 2, "both prompts arrived");
    assert.ok(applied >= 0 && prompts.every((i) => i > applied), `order applied ${applied}, prompts ${prompts}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Stop while the mode change is applying posts no prompt afterwards", async () => {
  const f = await fixture({ FAKE_OPENCODE_PATCH_DELAY_MS: "100" }); // answers before the 200 ms kill, so a prompt posted after Stop would still reach the fake
  try {
    const change = f.leader.setPermissionMode!("bypass");
    await until(() => f.entries().some((r) => r.method === "PATCH"), "PATCH reached the fake and is held");
    f.leader.send("plain message");
    f.leader.stop();
    await change;
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(f.entries().some((r) => /prompt_async$/.test(r.path || "")), false, "no prompt reached the server after Stop");
  } finally { await f.close(); }
});

test("a failed mode PATCH still lets a waiting turn start, on the restored mode", async () => {
  const f = await fixture({ FAKE_OPENCODE_PATCH_FAILS: "1", FAKE_OPENCODE_PATCH_DELAY_MS: "300" });
  try {
    const change = f.leader.setPermissionMode!("bypass");
    await until(() => f.entries().some((r) => r.method === "PATCH"), "PATCH reached the fake");
    f.leader.send("plain message");
    assert.equal(await change, false);
    assert.equal(f.leader.getPermissionMode!(), "acceptEdits", "mode restored");
    await until(() => f.done() === 1, "the turn started and ended after the failed PATCH");
    assert.ok(f.entries().some((r) => r.patchFailed), "fake refused the PATCH");
  } finally { await f.close(); }
});

test("with no PATCH pending a turn starts at once", async () => {
  const f = await fixture({ FAKE_OPENCODE_PATCH_DELAY_MS: "5000" });
  try {
    f.leader.send("plain message");
    await until(() => f.done() === 1, "turn ended with no wait");
    assert.equal(f.entries().some((r) => r.method === "PATCH"), false);
  } finally { await f.close(); }
});
