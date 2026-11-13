import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importWithTempDataRoot, stopOwnedChild } from "./temp-root.ts";
import { lowerOwnPriority } from "../scripts/sweep/run.mjs";
import { boot, client, workspaceFile } from "./pack18-harness.ts";
lowerOwnPriority();
const { modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const choices = { crewChoices: {}, autoAssign: false, fixedCrewVersion: 1 };

// Project and tab creation only ever make fixed-crew tabs: the creation fields and the request id are checked for every message, never only when the old marker is present.
test("b5-server creation: a project or tab is made only from a valid fixed-crew message with a request id", { timeout: 60_000 }, async () => {
  const server = await boot({ tabs: (work) => config.defaultWorkspaces(work).projects[0].tabs });
  let connection: Awaited<ReturnType<typeof client>> | undefined;
  const disk = () => readFileSync(join(server.data, "config", "workspaces.json"), "utf8");
  try {
    connection = await client(server);
    const before = disk();
    const project = { type: "addProject", id: "made", folder: server.work, name: "Made" };
    const tab = { type: "addTab", projectId: "made", tabId: "made-two", folder: server.work, name: "Two" };
    // Every refusal is checked against the bytes on disk: nothing is written before the check.
    const refusals: [string, any, RegExp][] = [
      ["project without a request id", { ...project, ...choices }, /requestId is required/],
      ["project without the fixed version", { ...project, requestId: "no-version", crewChoices: {}, autoAssign: false }, /Unsupported fixed crew version/],
      ["project with the old template field", { ...project, ...choices, requestId: "old-template", template: "our-process" }, /Unknown or locked/],
      ["project with the old kind field", { ...project, ...choices, requestId: "old-kind", kind: "dev" }, /Unknown or locked/],
    ];
    for (const [what, message, pattern] of refusals) {
      const result = await connection.attempt(message);
      assert.match(result.error ?? "", pattern, what);
      assert.equal(disk(), before, `${what}: nothing written`);
    }
    assert.equal((await connection.attempt({ ...project, ...choices, requestId: "project-ok" })).error, undefined);
    await connection.wait(() => connection!.state().projects.find((item: any) => item.id === "made"), "created project");
    const made = workspaceFile(server).projects.find((item: any) => item.id === "made");
    assert.deepEqual([made.tabs[0].crew, made.tabs[0].steps, Object.hasOwn(made.tabs[0], "fixedCrew")], [[], [], true]);
    const afterProject = disk();
    for (const [what, message, pattern] of [
      ["tab without a request id", { ...tab, ...choices }, /requestId is required/],
      ["tab without the fixed version", { ...tab, requestId: "tab-no-version", crewChoices: {}, autoAssign: false }, /Unsupported fixed crew version/],
      ["tab with the old template field", { ...tab, ...choices, requestId: "tab-old-template", template: "duo" }, /Unknown or locked/],
    ] as [string, any, RegExp][]) {
      const result = await connection.attempt(message);
      assert.match(result.error ?? "", pattern, what);
      assert.equal(disk(), afterProject, `${what}: nothing written`);
    }
    assert.equal((await connection.attempt({ ...tab, ...choices, requestId: "tab-ok" })).error, undefined);
    await connection.wait(() => connection!.tab("made-two"), "created tab");
    const second = workspaceFile(server).projects.find((item: any) => item.id === "made").tabs.find((item: any) => item.id === "made-two");
    assert.deepEqual([second.crew, second.steps, Object.hasOwn(second, "fixedCrew"), second.name], [[], [], true, "Two"]);
  } finally { connection?.close(); await stopOwnedChild(server.child); await server.stop(); }
});
