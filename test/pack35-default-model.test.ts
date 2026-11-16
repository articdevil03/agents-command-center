import test from "node:test";
import assert from "node:assert/strict";
import { api, setup } from "./pack29-first-run.setup.ts";
import { autoFillPreferences, freshPreferences } from "../server/fixed-crew/assignment.ts";

const preferred = "opencode/longcat-2.5-free", old = "opencode/beam-free";
const catalogue = (models: string[]) => ({ clis: [{ id: "opencode" as const, installed: true, models, efforts: [], advisor: false }] });
test("first-run preference uses only live models; ordinary auto choices and user choices stay unchanged", () => {
  for (const models of [[old, preferred], [old], [preferred], []]) {
    const normal = autoFillPreferences({}, catalogue(models));
    const first = autoFillPreferences({}, catalogue(models), true);
    assert.equal(first.leader.assignment?.model, models.includes(preferred) ? preferred : normal.leader.assignment?.model);
    if (!models.includes(preferred)) assert.equal(JSON.stringify(first), JSON.stringify(normal), "fallback unchanged byte-for-byte");
    if (first.leader.assignment) assert.ok(models.includes(first.leader.assignment.model), "choice is live");
    for (const slot of Object.keys(normal) as (keyof typeof normal)[]) if (slot !== "leader") assert.deepEqual(first[slot], normal[slot]);
  }
  assert.equal(autoFillPreferences({}, catalogue([old, preferred])).leader.assignment?.model, old);
  const prefs = freshPreferences(); prefs.leader = { source: "user", assignment: { cli: "opencode", model: old, effort: "" } };
  assert.deepEqual(autoFillPreferences(prefs, catalogue([old, preferred]), true).leader, prefs.leader);
});

test("completeFirstRun handler uses the preferred live OpenCode model, with the existing fallback", async () => {
  for (const models of [[old, preferred], [old]]) {
    const context = setup();
    await api.config.refreshDiscovery(() => ({ values: [], fallback: true }), () => ({ values: models, fallback: false }), (fallback) => ({ values: [...fallback], fallback: true }));
    Object.assign(api.state.settingsService.state.tools.opencode, { installed: true, signedIn: true });
    Object.assign(api.state.settingsService.state.catalogTools.opencode, { installed: true, signedIn: true });
    const reply = await context.dispatch({ cli: "opencode" });
    assert.equal(reply.type, "actionResult", JSON.stringify(reply));
    const project = api.state.workspaces.projects.find((p) => p.id === "my-project")!;
    assert.equal(project.tabs[0].fixedCrew!.preferences.leader.assignment?.model, models.includes(preferred) ? preferred : old);
  }
});
