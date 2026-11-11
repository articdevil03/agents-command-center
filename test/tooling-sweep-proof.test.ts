import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mutations, controlMutations } from "../scripts/mutation-proof.mjs";
import { createLane, removeTree, writeVerified } from "../scripts/sweep/lanes.mjs";
import { lowerOwnPriority, runTests, SWEEP_PRIORITY } from "../scripts/sweep/run.mjs";

// Explicit safe mappings. Ownership guards select pure cases; run guards select fake process seams.
const PROOFS: Record<string, [string, string]> = {
  "guard-p24-cleanup-budget": ["test/tooling-temp-cleanup.test.ts", "^P24 budget and retry"],
  "guard-p24-cleanup-retry": ["test/tooling-temp-cleanup.test.ts", "^P24 budget and retry"],
  "guard-p24-cleanup-exit-setter": ["test/tooling-temp-cleanup.test.ts", "^P24 permanent lock"],
  "guard-p24-cleanup-marker": ["test/tooling-temp-cleanup.test.ts", "^P24 permanent lock"],
  "guard-p24-cleanup-root-link": ["test/tooling-temp-cleanup.test.ts", "^P24 linked root"],
  "guard-p24-cleanup-no-follow": ["test/tooling-temp-cleanup.test.ts", "^P24 nested junction"],
  "guard-p24-cleanup-directory": ["test/tooling-temp-cleanup.test.ts", "^P24 immediate success"],
  "guard-p24-cleanup-continue-siblings": ["test/tooling-temp-cleanup.test.ts", "^P24 locked child"],
  "guard-p24-cleanup-temp-root-call": ["test/tooling-temp-cleanup.test.ts", "^P24 tempRoot registered"],
  "guard-p24-cleanup-scratch-call": ["test/tooling-temp-cleanup.test.ts", "^P24 scratchDir registered"],
  "guard-p24-cleanup-overlap-call": ["test/tooling-temp-cleanup.test.ts", "^P24 overlap actual"],
  "guard-p24-cleanup-dist-call": ["test/tooling-temp-cleanup.test.ts", "^P24 dist actual"],
  "guard-p24-cleanup-dist-status": ["test/tooling-temp-cleanup.test.ts", "^P24 dist actual"],
  "guard-p24-cleanup-icon-call": ["test/tooling-temp-cleanup.test.ts", "^P24 icon partial"],
  "guard-p24-cleanup-pack1-call": ["test/tooling-temp-cleanup.test.ts", "^P24 pack1 actual"],
  "guard-p24-cleanup-pack2-call": ["test/tooling-temp-cleanup.test.ts", "^P24 pack2 actual"],
  "guard-p24-cleanup-health-call": ["test/tooling-temp-cleanup.test.ts", "^P24 health actual"],
  "guard-p24-cleanup-any-cli-call": ["test/tooling-temp-cleanup.test.ts", "^P24 any-cli actual"],
  "guard-p24-cleanup-acp-call": ["test/tooling-temp-cleanup.test.ts", "^P24 acp actual"],
  "guard-p24-cleanup-lanes-call": ["test/tooling-temp-cleanup.test.ts", "^P24 lanes actual"],
  "guard-p24-cleanup-run-call": ["test/tooling-temp-cleanup.test.ts", "^P24 run actual"],
  "guard-sweep-confirm-live-flakes": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-quiet-error": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-call": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-file": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-name": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-flakes": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-pending": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-error": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-scope": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-canary": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-quiet": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-confirm-evidence": ["test/tooling-sweep-confirm.test.ts", "^P23"],
  "guard-sweep-r1-reused-root": ["test/tooling-sweep-proctree.test.ts", "^R1 watchTree registration"],
  "guard-sweep-r1-root-first-sight": ["test/tooling-sweep-proctree.test.ts", "^R1 recordTree never replaces"],
  "guard-sweep-r1-exited-root": ["test/tooling-sweep-run.test.ts", "^R1 fake runner passes root"],
  "guard-sweep-r1-signal-root": ["test/tooling-sweep-run.test.ts", "^R1 fake runner passes root"],
  "guard-sweep-r1-top-level-not-leaked": ["test/tooling-sweep-lanes.test.ts", "^R1 resyncLane removes and reports"],
  "guard-sweep-r1-kill-targets": ["test/tooling-sweep-proctree.test.ts", "^R1 killTracked calls only"],
  "guard-sweep-r1-render-timeout": ["test/tooling-render-wait.test.ts", "^R1 waitForFirstRender forwards"],
  "guard-sweep-r1-cleanup-kill-retry": ["test/tooling-sweep-main.test.ts", "^R1 cleanup kills a lane"],
  "guard-sweep-r1-top-level": ["test/tooling-sweep-lanes.test.ts", "^R1 resyncLane removes and reports"],
  "guard-sweep-record-survivor": ["test/tooling-sweep-main.test.ts","^a survivor does not"],
  "guard-sweep-strip-cc-data-dir": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-mutation-sweep-final-cleanup-retry": ["test/tooling-sweep-lanes.test.ts","^C1 removal retry"],
  "guard-packc-r2-test-root-postcheck": ["test/tooling-sweep-row.test.ts","^a leak after"],
  "guard-sweep-startup-only-own-prefix": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-red-checked-at-call-site": ["test/tooling-sweep-row.test.ts","^a failure that is not"],
  "guard-sweep-leak-never-makes-red": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-baseline-green": ["test/tooling-sweep-main.test.ts","^baseline: red twice"],
  "guard-sweep-timeout-reported": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-private-temp": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-sweep-scoped-run-strips-env": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-wholesuite-run-strips-env": ["test/tooling-sweep-lanes.test.ts","^laneEnv"],
  "guard-sweep-cleanup-matches-own-folder": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-cleanup-matches-temp-folder": ["test/tooling-sweep-proctree.test.ts","^(planKill|pid reuse)"],
  "guard-sweep-cleanup-excludes-own-shell": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-cleanup-no-port-kill": ["test/tooling-sweep-proctree.test.ts","^killTracked on a refusal"],
  "guard-sweep-parse-check": ["test/tooling-sweep-row.test.ts","^a mutation that breaks"],
  "guard-sweep-dollar-literal": ["test/tooling-sweep-row.test.ts","^the canary"],
  "guard-sweep-single-match": ["test/tooling-sweep-row.test.ts","^a mutation that breaks"],
  "guard-sweep-filter-list": ["test/tooling-sweep-main.test.ts","^a name part"],
  "guard-sweep-filter-unmatched-rejected": ["test/tooling-sweep-main.test.ts","^a filter part"],
  "guard-sweep-cleanup-failure-throws": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-final-cleanup-failure-releases-lock": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-final-cleanup-failure-keeps-evidence": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-final-cleanup-failure-keeps-earlier-error": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-restores-mutated-file": ["test/tooling-sweep-row.test.ts","^C1 restore call"],
  "guard-sweep-evidence-renamed": ["test/tooling-sweep-main.test.ts","^a finished all-RED"],
  "guard-sweep-evidence-kept": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-sigint-flag": ["test/tooling-sweep.test.ts","^the first Ctrl-C"],
  "guard-sweep-interrupt-checked": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-finished-removes-folder": ["test/tooling-sweep-main.test.ts","^lanes are removed"],
  "guard-sweep-lock-released": ["test/tooling-sweep-main.test.ts","^lowerOwnPriority"],
  "guard-sweep-temp-removed": ["test/tooling-sweep-lanes.test.ts","^removeLane"],
  "guard-sweep-temp-cleared-at-start": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-temp-clear-only-own-prefix": ["test/tooling-sweep-lanes.test.ts","^cleanupLeftovers"],
  "guard-sweep-temp-outside-repo": ["test/tooling-sweep-lanes.test.ts","^createLane copies"],
  "guard-sweep-plan-self": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-parent": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-grandparent": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-older": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-plan-missing-self": ["test/tooling-sweep-proctree.test.ts","^planKill"],
  "guard-sweep-record-younger": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-record-reused-parent": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-record-dead-parent": ["test/tooling-sweep-proctree.test.ts","^recordTree"],
  "guard-sweep-register-root": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-cleanup-every-run": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-early-stop-cleanup": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-final-cleanup-propagates": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-only-assertion-early-stop": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-record-and-continue": ["test/tooling-sweep-main.test.ts","^a survivor does not"],
  "guard-sweep-survivor-setter": ["test/tooling-sweep-row.test.ts","^a whole suite that passes"],
  "guard-sweep-survived-exit": ["test/tooling-sweep-report.test.ts","^exit code"],
  "guard-sweep-error-exit": ["test/tooling-sweep-report.test.ts","^exit code"],
  "guard-sweep-selected-positive": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-reported-count": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-reported-unique": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-selected-names": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-canary-red": ["test/tooling-sweep-report.test.ts","^controls:"],
  "guard-sweep-control-survives": ["test/tooling-sweep-report.test.ts","^control rows"],
  "guard-sweep-walker-bounds": ["test/tooling-sweep-lanes.test.ts","^removeTree refuses"],
  "guard-sweep-walker-no-follow": ["test/tooling-sweep-lanes.test.ts","^removeTree removes a junction"],
  "guard-sweep-slot-budget": ["test/tooling-sweep-lanes.test.ts","^createSlots hands"],
  "guard-sweep-quiet-exclusion": ["test/tooling-sweep-row.test.ts","^survivor re-check"],
  "guard-sweep-restored-catching-only": ["test/tooling-sweep-row.test.ts","^a catching scoped"],
  "guard-sweep-own-priority-call": ["test/tooling-sweep-main.test.ts","^lowerOwnPriority"],
  "guard-sweep-child-priority-call": ["test/tooling-sweep-run.test.ts","^C1 fake"],
  "guard-sweep-stop-detection": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-stop-consumption": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-stop-setter": ["test/tooling-sweep.test.ts","^a STOP file"],
  "guard-sweep-until-setter": ["test/tooling-sweep.test.ts","^--until stops"],
  "guard-sweep-second-sigint": ["test/tooling-sweep.test.ts","^the first Ctrl-C"],
  "guard-sweep-resume-head": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-dirty": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-vanished": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-resume-complete": ["test/tooling-sweep.test.ts","^resume refuses"],
  "guard-sweep-never-checked-scheduling": ["test/tooling-sweep-main.test.ts","^never-checked"],
  "guard-sweep-incomplete-no-map": ["test/tooling-sweep.test.ts","^a stop after the last"],
  "guard-sweep-failed-no-map": ["test/tooling-sweep-main.test.ts","^C1 failed controls"],
  "guard-sweep-controls-no-map": ["test/tooling-sweep-main.test.ts","^a control row"],
};

const root = fileURLToPath(new URL("..", import.meta.url));
const selection = process.env.CC_SWEEP_PROOF_ROW;
const lf = (text: string) => text.replaceAll("\r\n", "\n");
const passedNames = (log: string) => [...log.matchAll(/^✔ (.+) \([\d.]+m?s\)$/gm)].map((match) => match[1]);

// Only the copy is mutated. Imports above keep the controller and its cleanup on trusted real source.
// No main(), startup cleanup, calibration, full baseline or survivor fallback is reachable here.
test("C1 scoped mutation proof", { skip: !selection && "CC_SWEEP_PROOF_ROW unset: expensive proof explicitly skipped" }, async () => {
  const name = selection!;
  const entries = [...mutations, ...controlMutations].filter(([row]) => row === name);
  assert.equal(entries.length, 1, `proof failure: unknown or duplicate row ${name} (${entries.length})`);
  const mapped = name === "control-must-survive" ? ["test/tooling-sweep-main.test.ts", "^lowerOwnPriority"] : PROOFS[name];
  assert.ok(mapped, `proof failure: missing explicit mapping for ${name}`);
  const [file, pattern] = mapped;
  const [_, target, from, to] = entries[0];
  const original = readFileSync(join(root, target));
  const text = lf(original.toString("utf8"));
  assert.ok(from.length > 0, `${name}: empty target`);
  assert.equal(text.split(from).length - 1, 1, `${name}: missing or multiple target matches in ${target}`);
  const mutated = text.replace(from, () => to);
  assert.notEqual(mutated, text, `${name}: mutation must change bytes`);
  const parse = (source: string) => {
    const input = target.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
    const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${name}: parse failure, never a catch: ${result.stderr}`);
  };
  parse(text); parse(mutated);
  const priority = lowerOwnPriority();
  assert.equal(priority, SWEEP_PRIORITY);
  const lane = createLane(root, ["scripts", "test", "server"], 1);
  const files = [`--test-name-pattern=${pattern}`, file];
  let sequence = 0;
  const run = async (red: boolean, earlyStop: boolean) => {
    // The test-name option is deliberately passed with the sole mapped file, never with a glob.
    const logPath = join(lane.temp, `proof-${++sequence}.log`);
    const result = await runTests({ lane, files, red, earlyStop, concurrency: 1, timeoutMs: 90_000, logPath });
    const log = readFileSync(logPath, "utf8");
    const count = Math.max(passedNames(log).length + result.failures.length, result.catching ? 1 : 0);
    assert.ok(count > 0, `${name}: proof failure: zero executed tests\n${log}`);
    return { result, log, count };
  };
  let restoreVerified = false;
  try {
    const baseline = await run(false, false);
    assert.equal(baseline.result.outcome, "pass", `${name}: unrelated unmutated failure\n${baseline.log}`);
    const expectedNames = new Set(passedNames(baseline.log));
    assert.ok(expectedNames.size > 0, `${name}: baseline did not execute a mapped assertion`);
    let caught;
    try {
      writeVerified(lane, target, mutated);
      assert.equal(lf(readFileSync(join(lane.dir, target), "utf8")), mutated, `${name}: mutation write verified`);
      caught = await run(true, true);
    } finally {
      writeVerified(lane, target, original);
      assert.deepEqual(readFileSync(join(lane.dir, target)), original, `${name}: byte-exact restoration`);
      restoreVerified = true;
      const restored = await run(false, false);
      assert.equal(restored.result.outcome, "pass", `${name}: restored catching file is not GREEN\n${restored.log}`);
      console.log(`RESTORED ${name}: byte equality=${restoreVerified}, GREEN ${file}, executed=${restored.count}`);
    }
    assert.equal(caught.result.outcome, "assertion", `${name}: proof failure: scoped ${caught.result.outcome}, no whole-suite confirmation\n${caught.log}`);
    assert.equal(caught.result.catching?.file, file, `${name}: unrelated catching file`);
    assert.ok(expectedNames.has(caught.result.catching!.name), `${name}: unrelated catching assertion ${caught.result.catching!.name}`);
    assert.ok(caught.result.failures.every((failure: any) => failure.cause === "ERR_ASSERTION" && expectedNames.has(failure.name)), `${name}: unrelated non-assertion failure`);
    const assertion = caught.result.failures.find((failure: any) => failure.name === caught.result.catching!.name);
    console.log(`PROOF ${JSON.stringify({ row: name, target, from, to, assertion, executed: caught.count, baselineExecuted: baseline.count, priority, restored: restoreVerified })}`);
  } finally {
    // Trusted no-follow walker, restricted to the two folders createLane created for this test.
    assert.deepEqual(removeTree(lane.dir, root).leftovers, [], `${name}: proof copy leftovers`);
    assert.deepEqual(removeTree(lane.temp, tmpdir()).leftovers, [], `${name}: proof temp leftovers`);
  }
});
