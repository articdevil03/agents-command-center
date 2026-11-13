import test from "node:test";
import assert from "node:assert/strict";
import { neverFixture } from "./pack26-review2-never-launched-helpers.ts";

test("P26R8N cold journal admissions keep the stage interrupted", async t => {
  for (const state of ["matching-row", "other-active"]) {
    const f = await neverFixture(t), id = await f.request(), journal = f.journal();
    const row = f.journalRow(state === "matching-row" ? id : "other-active");
    journal.executions.push(row); journal.activeExecutionId = state === "matching-row" ? null : row.id;
    f.saveJournal(journal);
    const cold = f.restart();
    assert.equal(cold.stage, "interrupted", `${state}: journal admission forbids task-only normalization`);
    assert.equal(cold.executions.at(-1).status, "interrupted");
    console.log(`COLD ${state}: interrupted`);
  }
});
