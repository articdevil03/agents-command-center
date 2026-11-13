import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorTestMs, withPage, skipped, click, taskFixture, type Page } from "./pack18-editor-harness.ts";

// Pack 26 Block 3c over the REAL WebSocket: the page is loaded from a real server on a temp data root (fresh install, fake CLIs,
// CC_SKIP_DISCOVERY=1, CC_SKIP_LEADER_CHECK=1, no paid turn), with a saved task file the server's own createTask built. Nothing is
// delivered by hand: each approval is checked in the server's own task file on disk and again after a page reload.

const savedTask = (dataDir: string, tabId: string) => JSON.parse(readFileSync(join(dataDir, "tasks", `${tabId}.json`), "utf8"));
const cards = (ev: Page["ev"]): Promise<string[]> => ev(`[...document.querySelectorAll("#fixedView [data-fct-card]")].map((c)=>c.dataset.fctCard)`);
const sentOf = (ev: Page["ev"], type: string): Promise<any[]> => ev(`window.__sent.filter((m)=>m.type===${JSON.stringify(type)})`);

test("FCTUI live: Approve this plan over the real socket is saved in the task file, shown only after the server's record, and still approved after a reload", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  const tabId = "example-development";
  await withPage(async ({ ev, waitFor, dataDir, reload }) => {
    const before = savedTask(dataDir, tabId);
    assert.deepEqual([before.ownerScopeApproval, before.recordRevision, before.requests], [null, 1, []], "control: the saved plan waits for the owner");
    await waitFor(`Boolean(document.querySelector("#fixedView [data-fct-approve=plan]:not([disabled])"))`, "the server's plan is read and can be approved");
    assert.deepEqual(await cards(ev), ["plan"]);
    await click(ev, "#fixedView [data-fct-approve=plan]");
    await waitFor(`Boolean(document.querySelector('#fixedView [data-fct-card="plan-approved"]'))`, "the approved plan, from the server's new record");
    const [sent] = await sentOf(ev, "approveFixedPlan");
    const after = savedTask(dataDir, tabId);
    console.log(`FCTUI live plan on disk: ${JSON.stringify({ approval: after.ownerScopeApproval, recordRevision: after.recordRevision, requests: after.requests.map((r: any) => r.id), executions: after.executions.length })}`);
    assert.deepEqual(after.ownerScopeApproval, { planVersion: 1, digest: before.planDigest, revision: null });
    assert.deepEqual([after.recordRevision, after.requests.map((r: any) => r.id), after.executions], [2, [sent.requestId], []], "one recorded answer, and no work started");
    await reload();
    await waitFor(`Boolean(document.querySelector('#fixedView [data-fct-card="plan-approved"]'))`, "still approved after a reload");
    assert.equal(await ev(`document.querySelectorAll("#fixedView [data-fct-approve]").length`), 0);
    assert.deepEqual((await sentOf(ev, "approveFixedPlan")).length, 0, "the reloaded page sent nothing again");
  }, { fixture: "fixed", realSocket: true, tasks: (work) => ({ [tabId]: taskFixture(work, tabId, "planned") }) });
});

test("FCTUI live: Approve rough over the real socket names the inspected rough revision, is saved in the task file and still approved after a reload", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  const tabId = "example-development";
  await withPage(async ({ ev, waitFor, dataDir, reload }) => {
    const before = savedTask(dataDir, tabId);
    assert.deepEqual([before.stage, before.ownerRoughApproval, typeof before.roughRevision], ["inspected", null, "string"], "control: the saved rough waits for the owner");
    await waitFor(`Boolean(document.querySelector("#fixedView [data-fct-approve=rough]:not([disabled])"))`, "the server's rough is read and can be approved");
    await click(ev, "#fixedView [data-fct-approve=rough]");
    await waitFor(`Boolean(document.querySelector('#fixedView [data-fct-card="rough-approved"]'))`, "the approved rough, from the server's new record");
    const [sent] = await sentOf(ev, "approveFixedRough");
    const after = savedTask(dataDir, tabId);
    console.log(`FCTUI live rough on disk: ${JSON.stringify({ approval: after.ownerRoughApproval, sent: { ...sent, requestId: "…" } })}`);
    assert.equal(sent.roughRevision, before.roughRevision);
    assert.deepEqual(after.ownerRoughApproval, { planVersion: 1, digest: before.planDigest, revision: before.roughRevision });
    assert.deepEqual([after.requests.map((r: any) => r.id), after.executions.length], [[sent.requestId], before.executions.length], "one recorded answer, and no work started");
    assert.deepEqual(await sentOf(ev, "approveLook"), [], "the old look approval is never used");
    await reload();
    await waitFor(`Boolean(document.querySelector('#fixedView [data-fct-card="rough-approved"]'))`, "still approved after a reload");
  }, { fixture: "fixed", realSocket: true, tasks: (work) => ({ [tabId]: taskFixture(work, tabId, "inspected") }) });
});
