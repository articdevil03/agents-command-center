import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { createCodexLeader, codexPolicy } from "../server/leader-codex.ts";
import { createOpencodeLeader } from "../server/leader-opencode.ts";
import { opencodeRules, opencodePermissionVerdict, opencodeVaultPattern, decideByRules } from "../server/leader-opencode/rules.ts";
import { loadLeaderHarness } from "./round2-leader-harness.ts";
import { query } from "./approval-query.ts";
import { scratchDir, stopOwnedChild } from "./temp-root.ts";
import { spawnFakeLeaderCli } from "./fake-leader-cli.ts";
import type { PermissionMode } from "../server/settings/types.ts";
import type { ChildProcess } from "node:child_process";

const modes: PermissionMode[] = ["ask", "accept", "plan", "bypass"];
// Literal pre-vault rules from c8317d1. Changes to the new builder cannot change this baseline.
const oldRules = {
  ask: [{ permission: "*", pattern: "*", action: "ask" }, { permission: "read", pattern: "*", action: "allow" }, { permission: "glob", pattern: "*", action: "allow" }, { permission: "grep", pattern: "*", action: "allow" }, { permission: "list", pattern: "*", action: "allow" }, { permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*.env.*", action: "ask" }, { permission: "tab-crew_*", pattern: "*", action: "allow" }],
  accept: [{ permission: "*", pattern: "*", action: "ask" }, { permission: "read", pattern: "*", action: "allow" }, { permission: "glob", pattern: "*", action: "allow" }, { permission: "grep", pattern: "*", action: "allow" }, { permission: "list", pattern: "*", action: "allow" }, { permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*.env.*", action: "ask" }, { permission: "edit", pattern: "*", action: "allow" }, { permission: "tab-crew_*", pattern: "*", action: "allow" }],
  plan: [{ permission: "*", pattern: "*", action: "ask" }, { permission: "read", pattern: "*", action: "allow" }, { permission: "glob", pattern: "*", action: "allow" }, { permission: "grep", pattern: "*", action: "allow" }, { permission: "list", pattern: "*", action: "allow" }, { permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*.env.*", action: "ask" }, { permission: "edit", pattern: "*", action: "deny" }, { permission: "tab-crew_*", pattern: "*", action: "allow" }],
  bypass: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "tab-crew_*", pattern: "*", action: "allow" }],
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(fn: () => boolean) {
  const end = Date.now() + 15000;
  while (!fn() && Date.now() < end) await sleep(10);
  assert.ok(fn(), "operation completed before deadline");
}

for (const mode of modes) test(`Claude query receives vault directories in ${mode}, no-vault options unchanged`, async () => {
  const folder = scratchDir(), vault = scratchDir();
  async function capture(path?: string | null) {
    let captured: any, done = false;
    const create = loadLeaderHarness((args) => { captured = args.options; return query(args); });
    const leader = (create as any)({ model: "fake", effort: "medium" }, folder, null, { onDelta() {}, onUsage() {}, onDone() { done = true; }, onError(message: string) { assert.fail(message); } }, undefined, mode, undefined, undefined, undefined, path);
    try { leader.send("work"); await until(() => done); return JSON.parse(JSON.stringify(captured)); }
    finally { leader.stop(); await sleep(5); }
  }
  const baseline = await capture(), without = await capture(null), withVault = await capture(vault);
  assert.deepEqual(without, baseline, "no-vault request byte-for-byte fields");
  assert.deepEqual(withVault.additionalDirectories, [vault]);
  delete withVault.additionalDirectories;
  assert.deepEqual(withVault, baseline, "vault does not loosen permission mode or any other option");
});

for (const kind of ["codex", "opencode"] as const) for (const mode of modes) test(`${kind} ${mode}: real boundary requests and live mode PATCH carry vault`, { timeout: 60000 }, async () => {
  const folder = scratchDir(), vault = scratchDir(), log = join(folder, "requests.jsonl");
  const bridge = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: { tools: [] } })); }); });
  await new Promise<void>((ok) => bridge.listen(0, "127.0.0.1", ok));
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  async function capture(path?: string | null) {
    let child: ChildProcess | undefined, done = 0;
    const errors: string[] = [];
    const before = requests().length;
    const deps = { mode, ask: async () => false, ...(path === undefined ? {} : { vaultPath: () => path }), spawnFn: (command: string, options: any) => { child = spawnFakeLeaderCli(command, { ...options, env: { ...options.env, FAKE_LEADER_LOG: log } }); return child; } };
    const cb = { onDelta() {}, onUsage() {}, onDone() { done++; }, onError(message: string) { errors.push(message); } };
    const seat = { model: "fakeprov/fake-model", effort: "medium" };
    const leader = kind === "codex" ? createCodexLeader(seat, folder, cb, { ...deps, tools: [] }) : createOpencodeLeader(seat, folder, cb, { ...deps, bridge: { url: `http://127.0.0.1:${(bridge.address() as any).port}/mcp`, token: "fake-token" } });
    try {
      leader.send("work"); await until(() => done === 1 || errors.length > 0);
      assert.deepEqual(errors, []);
      assert.equal(done, 1);
      if (kind === "opencode") assert.equal(await leader.setPermissionMode!(mode), true);
      return requests().slice(before).filter((row) => kind === "codex" ? ["thread/start", "turn/start"].includes(row.method) : row.path === "/session" || row.method === "PATCH").map((row) => kind === "codex" ? { method: row.method, params: row.params } : { method: row.method, body: row.body });
    } finally { leader.stop(); if (child) await stopOwnedChild(child, 1500); }
  }
  try {
    const baseline = await capture(), without = await capture(null), withVault = await capture(vault);
    assert.deepEqual(without, baseline, "full no-vault request equality");
    assert.equal(withVault.length, 2, "FOUND both creation and turn/PATCH");
    if (kind === "codex") {
      const approvalPolicy = mode === "bypass" ? "never" : mode === "ask" ? "untrusted" : "on-request";
      const sandbox = mode === "bypass" ? "danger-full-access" : mode === "plan" ? "read-only" : "workspace-write";
      const oldThread = { method: "thread/start", params: { cwd: folder, model: "fakeprov/fake-model", approvalPolicy, sandbox, dynamicTools: [] } };
      assert.deepEqual(baseline[0], oldThread, "exact OLD thread/start shape");
      assert.deepEqual(withVault[0], oldThread, "vault adds no dead thread/start fields");
      for (const row of withVault.filter((row) => row.method === "turn/start")) {
        const policy = row.params.sandboxPolicy;
        if (mode === "ask" || mode === "accept") assert.deepEqual(policy.writableRoots, [folder, vault]);
        else assert.equal(policy.writableRoots, undefined, "Plan and Bypass add no writable roots");
      }
      assert.deepEqual(codexPolicy(mode, folder), codexPolicy(mode, folder, null));
    } else {
      for (const row of baseline) assert.deepEqual(row.body.permission, oldRules[mode], "exact OLD no-vault rules");
      for (const row of withVault) {
        const rules = row.body.permission, broad = rules.findIndex((rule: any) => rule.permission === "*");
        const index = rules.findIndex((rule: any) => rule.permission === "external_directory");
        assert.ok(index > broad, `vault rule follows broad rule: ${JSON.stringify(rules)}`);
        assert.deepEqual(rules[index], { permission: "external_directory", pattern: opencodeVaultPattern(vault), action: "allow" });
        assert.deepEqual(rules.filter((rule: any) => rule.permission !== "external_directory"), baseline[0].body.permission);
      }
      const sample = opencodeVaultPattern(vault).replace(/\*$/, "note.md");
      assert.equal(opencodePermissionVerdict(mode, true, "external_directory", [sample], vault), "allow");
      assert.equal(decideByRules(opencodeRules(mode, vault), "edit", [sample]), mode === "plan" ? "deny" : mode === "ask" ? "ask" : "allow");
    }
  } finally { await new Promise<void>((ok) => bridge.close(() => ok())); }
});
