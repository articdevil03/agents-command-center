import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fixture } from "./pack34-copilot.setup.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { createCandidate, publishCandidate } from "../server/settings/opencode/paths.ts";
import { sweepCopilotInstalls } from "../server/settings/opencode/sweep.ts";
import { RELEASE_TOOLS } from "../server/settings/opencode/release-tools.ts";
import { detectCatalogTool } from "../server/settings/cli-auth.ts";
import { parseVersion } from "../server/settings/parse.ts";
import { INSTALL_TIMEOUT_MS } from "../server/settings/cli-installers.ts";

test("Copilot detection uses the offline flag and parses both exact vendor outputs", async (t) => {
  const fx = await fixture(t);
  try {
    for (const text of ["GitHub Copilot CLI 1.0.112\nYou are running the latest version.", "GitHub Copilot CLI 1.0.112.\nRun 'copilot update' to check for updates."]) {
      assert.equal(parseVersion(text), "1.0.112");
      await detectCatalogTool("copilot", fx.service.state, async (_bin, args, options) => {
        assert.deepEqual(args, ["--version"]);
        assert.equal(options.env?.COPILOT_AUTO_UPDATE, undefined, "runner owns launch policy");
        return { code: 0, stdout: text, stderr: "" };
      });
      assert.equal(fx.service.state.catalogTools.copilot.version, "1.0.112");
      assert.equal(fx.service.state.catalogTools.copilot.supportedVersion, true);
    }
  } finally { await fx.close(); }
});

test("Copilot profile and service allow 1500 seconds; OpenCode keeps 600 seconds", async (t) => {
  assert.equal(RELEASE_TOOLS.copilot.timeoutMs, 1_500_000);
  assert.equal(INSTALL_TIMEOUT_MS, 600_000);
  const fx = await fixture(t);
  try {
    await fx.service.installCli(fx.request);
    const probe = fx.calls.find((call) => call.bin.endsWith("copilot.exe")); assert.ok(probe);
    assert.ok(probe.options.timeoutMs > 1_490_000 && probe.options.timeoutMs <= 1_500_000, String(probe.options.timeoutMs));
    assert.deepEqual(probe.args, ["--version"]);
  } finally { await fx.close(); }
});

test("Copilot admission sweeps orphan installs and preserves active, in-progress, foreign and linked folders", async (t) => {
  const fx = await fixture(t);
  let spy: any;
  try {
    const active = await createCandidate(fx.env, "copilot"), exe = join(active.dir, "copilot.exe"); writeFileSync(exe, "active");
    await publishCandidate(active.root, exe, "1.0.112");
    // Committed active folders are protected by the descriptor, independently of the in-progress set.
    const { candidatesInProgress } = await import("../server/settings/opencode/paths.ts"); candidatesInProgress.delete(active.dir);
    const pending = await createCandidate(fx.env, "copilot"); writeFileSync(join(pending.dir, "pending"), "pending");
    const stale = join(active.root, "install-dead"), foreign = join(active.root, "foreign"), linked = join(active.root, "install-abcd");
    for (const dir of [stale, foreign, linked]) { mkdirSync(dir); writeFileSync(join(dir, "keep"), "inert"); }
    mkdirSync(join(stale, "nested")); writeFileSync(join(stale, "nested", "old"), "old");
    const original = fs.lstatSync; let linksFound = 0;
    // Model Windows junction refusal without requiring developer-mode link privileges.
    spy = t.mock.method(fs, "lstatSync", ((path: any, ...args: any[]) => {
      const stat = (original as any)(path, ...args);
      if (String(path) === linked) { linksFound++; return new Proxy(stat, { get(target, key) { return key === "isSymbolicLink" ? () => true : Reflect.get(target, key); } }); }
      return stat;
    }) as any); syncBuiltinESMExports();
    // Already-installed preflight fails, proving sweep runs at admission before a new candidate.
    await assert.rejects(fx.service.installCli(fx.request), /already installed/);
    assert.equal(existsSync(stale), false, "orphan removed at install start");
    for (const dir of [active.dir, pending.dir, foreign, linked]) assert.equal(existsSync(join(dir, dir === active.dir ? "copilot.exe" : dir === pending.dir ? "pending" : "keep")), true, dir);
    assert.ok(linksFound > 0, "link refusal reached");
    const second = join(active.root, "install-beef"); mkdirSync(second);
    await sweepCopilotInstalls(fx.env); assert.equal(existsSync(second), false);
  } finally { spy?.mock.restore(); syncBuiltinESMExports(); await fx.close(); }
});

test("a replaced committed installation becomes sweepable while the new active install survives", async (t) => {
  const fx = await fixture(t);
  try {
    const first = await fx.transaction(); assert.equal(first.result.code, 0); await first.commit!();
    const second = await fx.transaction(); assert.equal(second.result.code, 0); await second.commit!();
    assert.notEqual(first.candidate, second.candidate);
    await sweepCopilotInstalls(fx.env);
    assert.equal(existsSync(first.candidate!), false, "former active install is no longer in progress");
    assert.equal(existsSync(second.candidate!), true, "new active descriptor target survives");
  } finally { await fx.close(); }
});

test("the sweep deletes nothing when the descriptor is corrupt, oversized, unreadable or points outside the managed root; only a missing descriptor lets it proceed", async (t) => {
  const fx = await fixture(t);
  try {
    const { candidatesInProgress } = await import("../server/settings/opencode/paths.ts");
    const seed = await createCandidate(fx.env, "copilot"); candidatesInProgress.delete(seed.dir);
    const descriptor = join(seed.root, "active.json"), victims = [seed.dir, join(seed.root, "install-beef")];
    mkdirSync(victims[1]); writeFileSync(join(victims[1], "keep"), "inert"); writeFileSync(join(seed.dir, "keep"), "inert");
    const cases: [string, (path: string) => void][] = [
      ["corrupt json", (path) => writeFileSync(path, "{not json")],
      ["odd executable outside the managed root", (path) => writeFileSync(path, JSON.stringify({ executable: "..\outside\copilot.exe" }))],
      ["non-string executable", (path) => writeFileSync(path, JSON.stringify({ executable: 5 }))],
      ["oversized descriptor", (path) => writeFileSync(path, JSON.stringify({ executable: "install-dead/copilot.exe", pad: "x".repeat(5000) }))],
      ["read error other than a missing file", (path) => mkdirSync(path)],
    ];
    for (const [label, make] of cases) {
      make(descriptor); await sweepCopilotInstalls(fx.env);
      for (const dir of victims) assert.equal(existsSync(dir), true, `${label}: ${dir} must survive`);
      removeWithRetry(descriptor);
    }
    // Missing descriptor (ENOENT) is the only case that proceeds. Names that are not the app's own install-<hex> pattern always survive.
    const notes = join(seed.root, "install-notes"), upper = join(seed.root, "install-ABC");
    for (const dir of [notes, upper]) mkdirSync(dir);
    await sweepCopilotInstalls(fx.env);
    for (const dir of victims) assert.equal(existsSync(dir), false, `missing descriptor: ${dir} is an orphan`);
    for (const dir of [notes, upper]) assert.equal(existsSync(dir), true, `${dir} is not an app install folder`);
  } finally { await fx.close(); }
});
