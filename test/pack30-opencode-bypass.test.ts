import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeLeader, opencodePermissionVerdict } from "../server/leader-opencode.ts";
import type { PermissionMode } from "../server/settings.ts";
import { spawnFakeLeaderCli } from "./fake-leader-cli.ts";
import { scratchDir, stopOwnedChild } from "./temp-root.ts";
import type { ChildProcess } from "node:child_process";

const modes: PermissionMode[] = ["bypass", "accept", "ask", "plan"];
for (const mode of modes) for (const subagent of [false, true]) {
  for (const [permission, pattern] of [["bash", "echo hi"], ["edit", "a.txt"], ["external_directory", "C:/outside"], ["read", "a.txt"], ["read", ".env"], ["read", "C:/work/.env.local"]]) {
    test(`verdict ${mode} ${subagent ? "child" : "main"} ${permission} ${pattern}`, () => {
      const expected = mode === "bypass" ? "allow" : !subagent ? "ask" : permission === "read" && pattern === "a.txt" ? "allow" : permission === "edit" && mode === "accept" ? "allow" : permission === "edit" && mode === "plan" ? "deny" : "ask";
      assert.equal(opencodePermissionVerdict(mode, subagent, permission, [pattern]), expected);
    });
  }
}
test("Bypass allows unknown permission names, empty and mixed patterns for either session", () => {
  for (const child of [false, true]) for (const patterns of [[], [".env", "outside/*"]]) assert.equal(opencodePermissionVerdict("bypass", child, "future_permission", patterns), "allow");
});

async function scenario(mode: PermissionMode, body: (run: (steps: unknown[], asks: number, replies: string[]) => Promise<void>, leader: ReturnType<typeof createOpencodeLeader>, saved: (value: boolean) => void, waitPatch: () => Promise<void>) => Promise<void>, answer = true, patchDelay = 0) {
  const folder = scratchDir(), log = join(folder, "fake.log");
  const bridge = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  await new Promise<void>((ok) => bridge.listen(0, "127.0.0.1", ok));
  let child: ChildProcess | undefined, asks = 0, finished = 0, savedAsks = false;
  const errors: string[] = [];
  const leader = createOpencodeLeader({ model: "fakeprov/fake-model", effort: "max" }, folder, {
    onDelta() {}, onUsage() {}, onDone() { finished++; }, onError(message) { errors.push(message); },
  }, {
    mode, savedAsks: () => savedAsks, ask: async () => { asks++; return answer; },
    bridge: { url: `http://127.0.0.1:${(bridge.address() as { port: number }).port}/mcp`, token: "synthetic-bridge-token" },
    spawnFn: (command, options) => { child = spawnFakeLeaderCli(command, { ...options, env: { ...options.env, FAKE_LEADER_LOG: log, FAKE_OPENCODE_PATCH_DELAY_MS: String(patchDelay) } }); return child; },
  });
  const replies = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => /^\/permission\/[^/]+\/reply$/.test(entry.path)).map((entry) => entry.body.reply) : [];
  const run = async (steps: unknown[], expectedAsks: number, expectedReplies: string[]) => {
    const before = finished, repliesBefore = replies().length, asksBefore = asks;
    leader.send(JSON.stringify(steps));
    const deadline = Date.now() + 20_000;
    while (finished === before && !errors.length && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 20));
    assert.deepEqual(errors, [], "no leader errors");
    assert.equal(finished, before + 1, "turn finished before the deadline");
    assert.equal(asks - asksBefore, expectedAsks, "ask call count");
    assert.deepEqual(replies().slice(repliesBefore), expectedReplies, "actual permission reply POST bodies");
  };
  const waitPatch = async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (existsSync(log) && readFileSync(log, "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line).method === "PATCH")) return;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.fail("FOUND the in-flight PATCH before its deadline");
  };
  try { await body(run, leader, (value) => { savedAsks = value; }, waitPatch); }
  finally {
    leader.stop();
    if (child) await stopOwnedChild(child, 1500);
    await new Promise<void>((ok) => bridge.close(() => ok()));
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, `owned fake ${child?.pid} ended`);
  }
}

test("Bypass answers main and child bash requests itself even when OpenCode asks anyway", { timeout: 30_000 }, () => scenario("bypass", async (run) => {
  await run([{ bash: "echo main" }, { childBash: "echo child" }, { childRead: ".env" }, { grandBash: "echo grandchild" }], 0, ["once", "once", "once", "once"]);
}));
for (const mode of ["accept", "ask", "plan"] as PermissionMode[]) for (const answer of [true, false]) {
  test(`${mode} main bash asks once and posts ${answer ? "once" : "reject"}`, { timeout: 30_000 }, () => scenario(mode, async (run) => {
    await run([{ bash: "echo control" }], 1, [answer ? "once" : "reject"]);
  }, answer));
}
test("live mode switches and saved asks govern the next request in the same chat", { timeout: 30_000 }, () => scenario("accept", async (run, leader, saved) => {
  await run([{ say: "ready" }], 0, []);
  assert.equal(await leader.setPermissionMode!("bypass"), true);
  await run([{ bash: "echo bypass" }], 0, ["once"]);
  saved(true);
  await run([{ bash: "echo saved ask" }, { childBash: "echo child saved ask" }], 2, ["once", "once"]);
  saved(false);
  await run([{ bash: "echo bypass again" }], 0, ["once"]);
  assert.equal(await leader.setPermissionMode!("ask"), true);
  await run([{ bash: "echo ask" }], 1, ["once"]);
}));

for (const next of ["ask", "plan"] as PermissionMode[]) for (const answer of [true, false]) {
  test(`Bypass to ${next} applies while PATCH is held and follows answer ${answer}`, { timeout: 30_000 }, () => scenario("bypass", async (run, leader, _saved, waitPatch) => {
    await run([{ say: "ready" }], 0, []);
    let settled = false;
    const switching = leader.setPermissionMode!(next).then((ok) => { settled = true; return ok; });
    await waitPatch();
    try {
      assert.equal(settled, false, "PATCH is still held before permission");
      await run([{ bash: "echo during switch" }], 1, [answer ? "once" : "reject"]);
      assert.equal(settled, false, "permission answered while PATCH is still held");
    } finally { assert.equal(await switching, true); }
  }, answer, 2500));
}

test("failed PATCH restores Bypass for the following request", { timeout: 30_000 }, async (t) => {
  const originalFetch = globalThis.fetch;
  let patches = 0;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "PATCH") { patches++; return Promise.resolve(new Response("{}", { status: 500 })); }
    return originalFetch(input, init);
  });
  await scenario("bypass", async (run, leader) => {
    await run([{ say: "ready" }], 0, []);
    assert.equal(await leader.setPermissionMode!("ask"), false);
    assert.equal(patches, 1, "failed PATCH was attempted");
    assert.equal(leader.getPermissionMode!(), "bypassPermissions");
    await run([{ bash: "echo restored bypass" }], 0, ["once"]);
  });
});
