import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { withPage, deliverState, deliver, taskFixture, editorTestMs } from "./pack18-editor-harness.ts";

test("P26R3B interrupted task explains app-confirmed leader release", { timeout: editorTestMs(90_000) }, async () => {
  let executed = false;
  let browserRoot = "";
  await withPage(async ({ ev, discovered, fixed, work, dataDir }) => {
    executed = true;
    browserRoot = dirname(dataDir); console.log(`P26R3_BROWSER_TEMP ${browserRoot}`);
    const task = taskFixture(work, fixed.id, "interrupted");
    await deliverState(ev, discovered, `state.projects[0].tabs[0].fixedTask=${JSON.stringify({ taskId: task.id, planVersion: task.planVersion, detailRevision: task.recordRevision, stage: task.stage })};`);
    const request = await ev('window.__sent.filter(m=>m.type==="getFixedTask").at(-1)'); assert.ok(request);
    await deliver(ev, { type: "fixedTask", tabId: fixed.id, requestId: request.requestId, task });
    assert.match(await ev('document.querySelector("#fixedView").innerText'), /The leader can release this run once the app confirms its whole process tree ended\. If that is unknown, the run stays held\./);
  });
  assert.equal(executed, true, "Chrome must execute this case; absence is NOT RUN, never passed");
  assert.equal(existsSync(browserRoot), false, "owned browser/server fixture was removed after process cleanup");
});
