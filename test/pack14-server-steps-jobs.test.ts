// Pack 14 (the leader's steps, its background jobs, its own follow-up replies, and no more glued text), the server side through real servers, part 1: sections A the step line, B it is cleared at every kind of turn end, C Claude's background jobs.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CLIS, tabOf, sleep, SECRET, ALLOWED, client, fakeLog, chatFile, withServer, LABEL_RUN, RUNNING, NEXT_REPLY, PAUSE, DIE } from "./pack14-server-helpers.ts";

// ---- A: the step line ----

test("A: the step line shows the KIND of each step, per CLI, in order; crew tools are skipped; it is never in the chat log; no secret is ever in it", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const tab = tabOf(cli, 1), from = c.messages.length;
      await c.start(tab, JSON.stringify(LABEL_RUN[cli].steps));
      await c.finished(tab, 1, `${cli}: the reply ends`);
      const seen = c.labels(tab, from);
      assert.deepEqual(seen, LABEL_RUN[cli].labels, `${cli}: the labels, in order`);
      for (const label of seen) if (label !== null) assert.match(label, ALLOWED, `${cli}: ${label} is on the fixed list`);
      // The step line goes quiet as the answer starts: the clear comes BEFORE the first text reaches the page, not only at the end.
      const firstDeltaAt = c.messages.findIndex((m, i) => i >= from && m.type === "chatDelta" && m.tabId === tab), firstClearAt = c.messages.findIndex((m, i) => i >= from && m.type === "leaderActivity" && m.tabId === tab && m.label === null);
      assert.ok(firstClearAt >= 0 && firstDeltaAt >= 0 && firstClearAt < firstDeltaAt, `${cli}: the step line is cleared before the answer streams (clear at ${firstClearAt}, first text at ${firstDeltaAt})`);
      // The end: cleared before the reply is closed, and the state agrees.
      assert.equal(c.tabState(tab).leaderActivity, null, `${cli}: nothing left in the state`);
      const clearedAt = c.messages.findLastIndex((m) => m.type === "leaderActivity" && m.tabId === tab), doneAt = c.messages.findLastIndex((m) => m.type === "chatDone" && m.tabId === tab);
      assert.ok(clearedAt < doneAt, `${cli}: the step line is gone before chatDone`);
      // Never in the chat: no row of the transcript holds a label.
      const chat = JSON.stringify(chatFile(server, tab));
      for (const label of new Set(seen)) if (label) assert.ok(!chat.includes(label), `${cli}: "${label}" is not in the chat log`);
      assert.ok(chat.includes("All done."), `${cli}: control: the reply itself is in the chat log`);
      // No secret anywhere the step line or the job list travels: its own messages and every state message's fields for this tab.
      const carried = JSON.stringify([c.messages.filter((m) => m.type === "leaderActivity"), c.messages.filter((m) => m.type === "state").map((m) => { const t = m.projects[0].tabs.find((x: any) => x.id === tab); return [t.leaderActivity, t.leaderJobs]; })]);
      assert.ok(!carried.includes(SECRET), `${cli}: the planted secret is not in any leaderActivity or leaderJobs data`);
      if (cli === "opencode") {
        const secrets = fakeLog(server).find((entry) => entry.toolSecrets)?.toolSecrets;
        assert.ok(secrets?.password && secrets?.token, "control: the fake put the OpenCode password and bridge token into tool input and output");
        assert.ok(!carried.includes(secrets.password) && !carried.includes(secrets.token), "opencode: neither the server password nor the bridge token is in the step line");
      }
    }
  });
});

test("A: a step line is only ever sent while a reply runs, and a Claude helper count follows the helpers that run", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 2), from = c.messages.length;
    // A sub-agent's own tool calls (they carry the id of the Task call that started it) never move the leader's step line.
    await c.start(tab, JSON.stringify([{ toolUse: { id: "h1", name: "Task", input: {} } }, { toolUse: { id: "h2", name: "Task", input: {} } }, { toolUse: { id: "s1", name: "WebSearch", input: { query: SECRET }, parent: "h1" } }, { toolResult: { id: "s1", parent: "h1" } },
      { toolUse: { id: "h3", name: "Task", input: {} } }, { toolResult: { id: "h1" } }, { block: "text" }, { say: "x" }]));
    await c.finished(tab, 1, "ends");
    assert.deepEqual(c.labels(tab, from), ["1 helper working", "2 helpers working", "3 helpers working", "2 helpers working", null], "the count follows the helpers that run now, a sub-agent's own steps are not shown; the end of the reply clears it");
    await sleep(300);
    const later = c.labels(tab, from).length;
    await sleep(600);
    assert.equal(c.labels(tab, from).length, later, "nothing more arrives after the reply");
  });
});

test("A: a steered message's own text part (OpenCode) is not the answer being written: the step line stays while the leader is still thinking", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("opencode", 3), from = c.messages.length;
    await c.start(tab, JSON.stringify([{ reasoning: "hmm" }, { sleep: 1500 }, { say: "done" }]));
    await c.wait(() => c.labels(tab, from).includes("Thinking"), "thinking shows");
    c.send({ type: "steer", tabId: tab, text: "STEER-TEXT-PART", requestId: "p14-steer-part" });
    await c.wait(() => fakeLog(server).some((entry) => entry.midRun), "the steer reached OpenCode");
    await sleep(400);
    assert.deepEqual(c.labels(tab, from), ["Thinking"], "the steer's user text part did not clear the step line");
    await c.finished(tab, 1, "ends");
  });
});

// ---- B: cleared at every kind of turn end ----

test("B: the step line is cleared when a reply ends with a step still running, on Stop, when the leader dies, and on Clear (every CLI)", { timeout: 240_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of CLIS) {
      const running = (tab: string, from: number) => c.wait(() => c.labels(tab, from).includes("Running a command"), `${cli}: the step shows`, 10_000);
      const cleared = (tab: string, from: number, how: string) => {
        const seen = c.labels(tab, from);
        assert.equal(seen.at(-1), null, `${cli} ${how}: the last thing sent is a clear: ${JSON.stringify(seen)}`);
        assert.equal(c.tabState(tab).leaderActivity, null, `${cli} ${how}: the state holds nothing`);
        assert.equal(c.tabState(tab).derived.leaderTurnActive, false, `${cli} ${how}: and the reply is over`);
      };
      // 1. the reply ends on its own with the step still open
      let tab = tabOf(cli, 2), from = c.messages.length;
      await c.start(tab, RUNNING[cli]([{ say: "ok" }]));
      await running(tab, from);
      await c.finished(tab, 1, `${cli}: ends`);
      cleared(tab, from, "end");
      assert.ok(c.messages.findLastIndex((m) => m.type === "leaderActivity" && m.tabId === tab) < c.messages.findLastIndex((m) => m.type === "chatDone" && m.tabId === tab), `${cli}: cleared before chatDone`);
      // The next reply on the same tab starts clean: the step the last one left open is not remembered (it would hide "Thinking" and the quiet while the answer is written).
      from = c.messages.length;
      await c.start(tab, NEXT_REPLY[cli]);
      await c.finished(tab, 2, `${cli}: the next reply ends`);
      assert.deepEqual(c.labels(tab, from), ["Thinking", null], `${cli}: a step left open by the last reply does not leak into the next one`);
      // 2. Stop all while the step runs
      tab = tabOf(cli, 3); from = c.messages.length;
      await c.start(tab, RUNNING[cli]([PAUSE[cli]]));
      await running(tab, from);
      // A page that connects now (a reload, a second window) is told what the leader is doing by the state itself.
      const late = await client(server);
      assert.equal(late.tabState(tab).leaderActivity, "Running a command", `${cli}: a page that connects mid-reply gets the step in its first state`);
      late.close();
      c.send({ type: "stopAll" });
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the stopped reply reports`, 10_000); await sleep(150);
      cleared(tab, from, "stop");
      // 3. the leader dies while the step runs
      tab = tabOf(cli, 4); from = c.messages.length;
      await c.start(tab, RUNNING[cli](DIE[cli]));
      await running(tab, from);
      if (cli === "claude") server.child.send("end-query");
      await c.wait(() => c.failed(tab) >= 1, `${cli}: the death reports`, 15_000); await sleep(150);
      cleared(tab, from, "death");
      // 4. Clear while the step runs
      tab = tabOf(cli, 5); from = c.messages.length;
      await c.start(tab, RUNNING[cli]([PAUSE[cli]]));
      await running(tab, from);
      c.send({ type: "clear", tabId: tab });
      await c.wait(() => c.messages.slice(from).some((m) => m.type === "chatCleared" && m.tabId === tab), `${cli}: cleared`, 10_000); await sleep(150);
      cleared(tab, from, "clear");
    }
  });
});

// ---- C: Claude's background jobs ----

const JOB = (id: string, description: string) => ({ id, description });
test("C: Claude background jobs: listed in the state with a count and a start time, kept after the reply ends, cleaned, never carrying the command", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    const tab = tabOf("claude", 6);
    const jobs = () => c.tabState(tab).leaderJobs as Array<{ id: string; description: string; startedAt: number }>;
    await c.start(tab, JSON.stringify([{ toolUse: { id: "bg", name: "Bash", input: { command: `sleep 99 # ${SECRET}`, run_in_background: true } } }, { bgJobs: [JOB("b1", "Generate 5 concept images")] }, { toolResult: { id: "bg", output: SECRET } }, { say: "Started it." }]));
    await c.finished(tab, 1, "the first reply ends");
    assert.equal(jobs().length, 1, "one job");
    assert.deepEqual([jobs()[0]!.id, jobs()[0]!.description, typeof jobs()[0]!.startedAt], ["b1", "Generate 5 concept images", "number"]);
    assert.equal(c.tabState(tab).derived.leaderTurnActive, false, "the job survives the end of the reply, and the leader is free");
    const firstStart = jobs()[0]!.startedAt;
    assert.ok(Math.abs(Date.now() - firstStart) < 15_000, "the start time is real");
    const long = `${"x".repeat(200)}`;
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Generate 5 concept images"), JOB("b2", `line one\nline two\u0007 ${long}`), JOB("b3", "")] }, { say: "Three." }]));
    await c.finished(tab, 2, "the second reply ends");
    assert.equal(jobs().length, 3, "the list is the CLI's full list: three now");
    assert.equal(jobs().find((job) => job.id === "b1")!.startedAt, firstStart, "a job that was already there keeps its start time");
    const dirty = jobs().find((job) => job.id === "b2")!.description;
    assert.ok(!/[\u0000-\u001f]/.test(dirty) && dirty.length <= 80 && dirty.startsWith("line one line two"), `control characters out, 80 at most: ${JSON.stringify(dirty)}`);
    assert.equal(jobs().find((job) => job.id === "b3")!.description, "a background command", "an empty description reads a background command");
    await c.start(tab, JSON.stringify([{ bgJobs: [] }, { say: "None." }]));
    await c.finished(tab, 3, "the third reply ends");
    assert.deepEqual(jobs(), [], "the CLI said none: none");
    // The same id again later is a new job: it starts counting from now, not from the old one.
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Generate 5 concept images")] }, { say: "Again." }]));
    await c.finished(tab, 4, "the fourth reply ends");
    assert.ok(jobs()[0]!.startedAt > firstStart, "a job that came back is a new job with a new start time");
    const carried = JSON.stringify(c.messages.filter((m) => m.type === "state").map((m) => m.projects[0].tabs.find((t: any) => t.id === tab).leaderJobs));
    assert.ok(!carried.includes(SECRET) && !carried.includes("sleep 99"), "the command (and the secret in it) is never in the job list");
  });
});

test("C: Claude background jobs end with their leader: Stop, death, a new folder, Clear and a replaced dead leader", { timeout: 120_000 }, async () => {
  await withServer({}, async (server, c) => {
    const jobsOf = (tab: string) => c.tabState(tab).leaderJobs as unknown[];
    const withJob = async (n: number) => {
      const tab = tabOf("claude", n);
      await c.start(tab, JSON.stringify([{ bgJobs: [JOB("b1", "Render the video")] }, { say: "ok" }]));
      await c.finished(tab, 1, `tab ${n}: the reply ends`);
      assert.equal(jobsOf(tab).length, 1, `tab ${n}: control: a job runs`);
      return tab;
    };
    let tab = await withJob(7);
    c.send({ type: "stopAll" });
    await c.wait(() => jobsOf(tab).length === 0, "Stop clears the jobs");
    tab = await withJob(8);
    server.child.send("end-query");
    await c.wait(() => jobsOf(tab).length === 0, "a dying leader clears the jobs");
    // The dead leader is replaced by the tab's next message: still none, and a new leader's own jobs show again.
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("n1", "New job")] }, { say: "again" }]));
    await c.finished(tab, 2, "the replacement answers");
    assert.deepEqual((jobsOf(tab) as any[]).map((job) => job.id), ["n1"], "only the new leader's job");
    tab = await withJob(9);
    c.send({ type: "changeFolder", tabId: tab, folder: join(server.temp, "work2") });
    await c.wait(() => jobsOf(tab).length === 0, "a new folder clears the jobs");
    tab = await withJob(10);
    c.send({ type: "clear", tabId: tab });
    await c.wait(() => jobsOf(tab).length === 0, "Clear clears the jobs");
  });
});

test("C: an older leader that ends late (its stream closes after a newer leader started) never clears the newer leader's jobs", { timeout: 60_000 }, async () => {
  // The old Claude leader's stop is slow to reach its stream: the adapter reports onStop a second time then, long after the tab's next leader began.
  await withServer({ FAKE_CLAUDE_STOP_DELAY_MS: "2500" }, async (server, c) => {
    const tab = tabOf("claude", 11);
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("old", "Old leader's job")] }, { say: "ok" }]));
    await c.finished(tab, 1, "the first leader answers");
    c.send({ type: "stopAll" });
    await c.wait(() => (c.tabState(tab).leaderJobs as unknown[]).length === 0, "Stop clears the old leader's jobs");
    await c.start(tab, JSON.stringify([{ bgJobs: [JOB("new", "New leader's job")] }, { say: "ok" }]));
    await c.finished(tab, 2, "the new leader answers");
    assert.deepEqual((c.tabState(tab).leaderJobs as any[]).map((job) => job.id), ["new"], "control: the new leader's job shows");
    await sleep(3500);
    // A late clear sends no state of its own: a page that connects afterwards reads what the server holds.
    const fresh = await client(server);
    assert.deepEqual((fresh.tabState(tab).leaderJobs as any[]).map((job) => job.id), ["new"], "the old leader's late end left it alone");
    fresh.close();
  });
});

test("C: Codex and OpenCode never show background jobs (they start theirs detached where Command Center cannot see them)", { timeout: 60_000 }, async () => {
  await withServer({}, async (server, c) => {
    for (const cli of ["codex", "opencode"] as const) {
      const tab = tabOf(cli, 6);
      await c.start(tab, JSON.stringify(cli === "codex"
        ? [{ itemRun: { type: "commandExecution", id: "bg", command: "nohup ping -n 40 127.0.0.1 &", commandActions: [] } }, { say: "started" }]
        : [{ toolPart: { tool: "bash", id: "bg", input: { command: "nohup ping -n 40 127.0.0.1 &" } } }, { say: "started" }]));
      await c.finished(tab, 1, `${cli}: ends`);
      assert.deepEqual(c.messages.filter((m) => m.type === "state").map((m) => m.projects[0].tabs.find((t: any) => t.id === tab).leaderJobs).filter((jobs) => jobs.length), [], `${cli}: no state message ever lists a job`);
    }
  });
});
