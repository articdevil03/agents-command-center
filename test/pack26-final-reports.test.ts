import test from "node:test";
import assert from "node:assert/strict";
import { reportsServer, planned, acted, logSize, unchanged, CAP } from "./pack26-final-reports-helpers.ts";

const MIB = 1024 * 1024;
const refuses = (answer: { ok: boolean; text: string }, pattern: RegExp, label: string) => {
  assert.equal(answer.ok, false, `${label}: ${answer.text}`);
  assert.match(answer.text, pattern, label);
};

test("P26F report accepts a large transcript", { timeout: 300_000 }, async () => {
  const f = await reportsServer();
  try {
    // Planner: the brief echoed, 3 MiB of tool output, a 1 MiB line that is not a report, then the report on stderr and again on stdout.
    const planning = await planned(f, { megabytes: 3, giantLineMb: 1, order: "stderr-first" });
    assert.ok(logSize(f, planning.runId) >= 4 * MIB, `a Codex-like log of ${logSize(f, planning.runId)} bytes`);
    const accepted = await planning.accept(); assert.equal(accepted.ok, true, accepted.text);
    await f.approve();
    // Build: the other output order, the delimiters cut into 7-character writes (so they cross data events), CRLF on stdout.
    const build = await acted(f, "build", { write: "after!", megabytes: 3, order: "stdout-first", split: 7, crlf: true });
    assert.ok(logSize(f, build.runId) >= 3 * MIB);
    const built = await build.verify(); assert.equal(built.ok, true, built.text);
    // Check: the report only on stdout, at the very end of a 3 MiB transcript.
    const check = await acted(f, "check", { megabytes: 3, variant: "single", order: "stdout-first" });
    assert.ok(logSize(f, check.runId) >= 3 * MIB);
    const checked = await check.verify("focused"); assert.equal(checked.ok, true, checked.text);
    console.log(`REPORT TRANSPORT large logs: planner ${logSize(f, planning.runId)}, build ${logSize(f, build.runId)}, check ${logSize(f, check.runId)} bytes; both orders, split delimiters, CRLF, 1 MiB non-report line`);
  } finally { await f.close(); }
});

test("P26F report accepts identical CLI echoes", { timeout: 300_000 }, async () => {
  const f = await reportsServer();
  try {
    // The same report on stderr (LF) and stdout (CRLF): one report after line-ending normalisation only.
    const planning = await planned(f, { megabytes: 1, crlf: true });
    const accepted = await planning.accept(); assert.equal(accepted.ok, true, accepted.text);
    await f.approve();
    const build = await acted(f, "build", { write: "after!", split: 5 });
    const built = await build.verify(); assert.equal(built.ok, true, built.text);
  } finally { await f.close(); }
});

test("P26F report refuses different CLI blocks", { timeout: 300_000 }, async () => {
  const f = await reportsServer();
  try {
    // Valid identity and schema in both blocks, different payloads: never first-wins, last-wins, a merge or a deduplication by identity.
    const different = await planned(f, { variant: "different" });
    const before = unchanged(f);
    refuses(await different.accept(), /Worker report blocks differ/, "different payloads");
    assert.deepEqual(unchanged(f), before, "a refusal changes no task and no journal fact");
    // Everything else that must refuse, through the same route.
    for (const [options, pattern] of [
      [{ foreign: true }, /Report belongs to another run/], [{ variant: "malformed" }, /JSON|Unexpected/], [{ exit: 2 }, /did not finish successfully/],
    ] as const) {
      const run = await planned(f, options); refuses(await run.accept(), pattern, JSON.stringify(options));
      assert.equal(f.task(), null, `${JSON.stringify(options)} creates no plan`);
    }
    // Unknown tree end: the report itself is valid, but the run's end was never confirmed.
    const { writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const marker = join(f.server.temp, "unknown-tree");
    writeFileSync(marker, "unknown");
    try {
      const unknownEnd = await planned(f, { variant: "single" });
      refuses(await unknownEnd.accept(), /not been confirmed ended|did not finish successfully/, "unknown tree end");
    } finally { rmSync(marker, { force: true }); }
    assert.equal(f.task(), null);
    console.log("REPORT MATRIX refused: different duplicate blocks, foreign identity, malformed block, failed run, unknown tree end");
  } finally { await f.close(); }
});

test("P26F report enforces payload bytes", { timeout: 300_000 }, async () => {
  const f = await reportsServer();
  try {
    // A schema-valid report one byte over the cap (bytes, not characters: the plan scope is 2-byte characters) refuses on the limit alone.
    const over = await planned(f, { bytes: CAP + 1, variant: "single" });
    refuses(await over.accept(), /Worker report payload exceeds its limit/, "cap + 1 byte");
    assert.equal(f.task(), null);
    // Exactly the cap is accepted, and it is the same report shape.
    const exact = await planned(f, { bytes: CAP, variant: "single" });
    const accepted = await exact.accept(); assert.equal(accepted.ok, true, accepted.text);
    assert.ok(f.task().plan.scope.includes("é"), "the accepted report carried multi-byte characters");
    console.log(`REPORT SIZE cap ${CAP}: ${CAP + 1} bytes refused, ${CAP} bytes accepted`);
  } finally { await f.close(); }
});

test("P26F report refuses unfinished framing", { timeout: 300_000 }, async () => {
  const f = await reportsServer();
  try {
    for (const [variant, pattern] of [["unfinished", /Worker report block is unfinished/], ["nested", /Worker report block is nested/]] as const) {
      const run = await planned(f, { variant });
      refuses(await run.accept(), pattern, variant);
      assert.equal(f.task(), null, `${variant} creates no plan`);
    }
  } finally { await f.close(); }
});

test("P26F scanner reads fixed chunks: split delimiters, CRLF, a giant line and a changing log", async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync, rmdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { scanWorkerReport } = await import("../server/fixed-crew/task-report-scan.ts");
  const dir = mkdtempSync(join(tmpdir(), "cc-p26f-scan-")), file = join(dir, "run.log");
  try {
    const scan = (text: string, chunk: number) => { writeFileSync(file, text); return scanWorkerReport(file, chunk)?.toString() ?? null; };
    const block = (eol: string) => `CC_REPORT_BEGIN${eol}{"a":1}${eol}CC_REPORT_END${eol}`;
    for (const chunk of [1, 2, 3, 7, 13, 64 * 1024]) {
      assert.equal(scan(`noise\n${block("\n")}tail\n`, chunk), '{"a":1}', `LF, chunk ${chunk}`);
      assert.equal(scan(`noise\r\n${block("\r\n")}`, chunk), '{"a":1}', `CRLF, chunk ${chunk}`);
      assert.equal(scan(`${block("\n")}x\n${block("\r\n")}`, chunk), '{"a":1}', `identical LF and CRLF echoes, chunk ${chunk}`);
      assert.equal(scan("g".repeat(2 * MIB) + `\n${block("\n")}`, chunk), '{"a":1}', `2 MiB non-report line, chunk ${chunk}`);
    }
    assert.equal(scan("CC_REPORT_BEGIN_X\nCC_REPORT_BEGIN \n x CC_REPORT_END\n", 3), null, "only exact delimiter lines count");
    assert.throws(() => scan(`${block("\n")}${block("\n").replace("1", "2")}`, 5), /blocks differ/);
    // A log that grows between the snapshot and the end of the read is refused, not chased.
    writeFileSync(file, block("\n"));
    assert.throws(() => scanWorkerReport(file, 4, () => appendFileSync(file, "more output\n")), /changed while it was read/);
  } finally { rmSync(file, { force: true }); rmdirSync(dir); }
});
