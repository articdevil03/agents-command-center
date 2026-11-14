import test from "node:test";
import assert from "node:assert/strict";
import { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { installReviewDependencies } from "./pack26-review1-helpers.ts";
import { loadFixed, connect, setAssignment, tick, waitFor } from "./round2-helpers.ts";

installReviewDependencies();
const main = { cli: "claude", model: "claude-sonnet-5-5[1m]", effort: "medium" };
const advisor = "claude-fable-5-1";

test("P27 worker launch carries advisor and Off without changing access", { timeout: 90_000 }, async () => {
  const f = await fixedServer({ assignments: { helper: main }, nativeProcess: process.env.CC_FCX_NATIVE_PROCESS === "1" });
  try {
    assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    await f.c.chat("fixed", "start fixture leader");
    for (const value of [advisor, undefined]) {
      const assignment = { ...main, ...(value ? { advisor: value } : {}) };
      assert.deepEqual(await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "helper", assignment }), { ok: true });
      f.worker({});
      const result = await f.assist("helper");
      assert.ok(result.runId, "actual assist run id FOUND");
      await f.ended(result.runId);
      const capture = f.spawnCapture(result.runId);
      assert.ok(capture, "production command capture FOUND");
      assert.equal(capture.program.includes(`--advisor ${advisor}`), Boolean(value), capture.program);
      if (!value) assert.doesNotMatch(capture.program, /--advisor\b/, "Off forwards no advisor flag");
      assert.match(capture.program, /--permission-mode plan --permission-prompts none --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit/);
      assert.doesNotMatch(capture.program, /--dangerously-skip-permissions/, "advisor never grants write access");
      const record = f.journal().executions.find((entry: any) => entry.id === result.runId);
      assert.ok(record, "execution journal entry FOUND");
      assert.equal(record.assignment.advisor, value);
      assert.equal(Object.hasOwn(record.assignment, "advisor"), Boolean(value), "journal snapshot preserves advisor field absence for Off");
      assert.equal(f.c.tab("fixed").crew.find((seat: any) => seat.slot === "helper").canWrite, false);
    }
    console.log(`P27 worker transport: ${process.env.CC_FCX_NATIVE_PROCESS === "1" ? "native" : "injected tree/process boundary"}`);
  } finally { await f.close(); }
});

test("P27 leader starts the next session with the saved advisor", async () => {
  for (const cliPath of ["C:/outside-fixture/claude.exe", undefined]) {
    const queries: any[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    const server = await loadFixed({ skipHealth: true, claudeCli: cliPath, sdkLeader: ({ prompt, options }: any) => {
      queries.push(options);
      const iterator = (async function* () {
        for await (const message of prompt) {
          if (hold) await new Promise<void>((resolve) => { release = resolve; });
          yield { type: "result", subtype: "success", is_error: false, usage: {}, session_id: "fixture-session" };
        }
      })();
      return Object.assign(iterator, { async setModel() {}, async setPermissionMode() {} });
    } });
    const ws = connect(server);
    const send = async (text: string) => {
      ws.message({ type: "chat", tabId: "alpha-dev", text });
      await server.flush();
      await waitFor(() => server.activeLeaderTurns.size === 0, "fixture SDK reply completed");
    };
    try {
      assert.equal((await setAssignment(ws, "alpha-dev", "leader", { ...main, advisor })).type, "actionResult");
      await send("first");
      assert.equal(queries.length, 1, "one initial SDK session");
      assert.equal(queries[0].extraArgs?.advisor, cliPath ? advisor : undefined, "advisor forwarded through real session and SDK options");
      if (!cliPath) assert.equal(queries[0].extraArgs, undefined, "absent native path omits extra flags");
      const current = server.leaders.get("alpha-dev");
      hold = true;
      ws.message({ type: "chat", tabId: "alpha-dev", text: "held turn" });
      await waitFor(() => Boolean(release), "injected SDK took the active message");
      assert.equal((await setAssignment(ws, "alpha-dev", "leader", main)).type, "error", "active turn refuses advisor change");
      assert.equal(server.leaders.get("alpha-dev"), current);
      hold = false; release!(); release = undefined;
      await server.flush();
      await waitFor(() => server.activeLeaderTurns.size === 0, "held reply ended");
      assert.equal((await setAssignment(ws, "alpha-dev", "leader", main)).type, "actionResult");
      assert.equal(server.leaders.get("alpha-dev"), current, "saving leaves the current session unchanged");
      assert.equal(queries.length, 1);
      await send("next message");
      // Keep function-bearing session objects out of the assertion's serialized actual/expected fields.
      assert.equal(server.leaders.get("alpha-dev") !== current, true, "next message retires the old session");
      assert.equal(queries.length, 2, "exactly one replacement");
      assert.equal(queries[1].extraArgs?.advisor, undefined, "new session uses saved Off");
      await send("another message");
      assert.equal(queries.length, 2, "unchanged assignment reuses the new session");
    } finally {
      hold = false; release?.(); server.stopLeaderSession("alpha-dev");
      await tick(); await server.flush(); ws.close?.();
    }
  }
});

test("P27 approved tasks refuse advisor assignment drift", { timeout: 90_000 }, async () => {
  const f = await fixedServer({ assignments: { coder: main } });
  try {
    assert.equal((await f.c.request({ type: "refreshSettings" })).ok, true);
    await f.planning(); await f.approve();
    const before = f.children().filter((entry: any) => entry.event === "start" && entry.worker).length;
    assert.deepEqual(await f.c.request({ type: "setCrewAssignment", tabId: "fixed", slot: "coder", assignment: { ...main, advisor } }), { ok: true });
    const result = await f.action("build");
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.text, /assignment|plan/i);
    assert.equal(f.children().filter((entry: any) => entry.event === "start" && entry.worker).length, before, "assignment drift starts zero new worker processes");
  } finally { await f.close(); }
});
