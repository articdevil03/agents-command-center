import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixed, connect, fixtureWorkspaces, source, settleLeaderTurns } from "./round2-helpers.ts";
import { taskFixture } from "./pack18-editor-task-fixture.ts";
import { ownedTemp } from "./pack26-review1-run2-helpers.ts";
import type { Stage } from "../server/fixed-crew/task-types.ts";

export async function deliveryFixture(t: { after: (fn: () => any) => void }, stage: Stage = "planned", visible = false) {
  let server: any;
  t.after(async () => {
    if (!server) return;
    server.activeLeaderTurns.clear(); server.stopLeaderSession("alpha-dev"); await settleLeaderTurns(server);
    assert.equal(server.active.size, 0);
  });
  const root = ownedTemp(t), data = join(root, "data"), folder = join(root, "work"); mkdirSync(folder);
  const workspaces = fixtureWorkspaces();
  for (const project of workspaces.projects) for (const tab of project.tabs) tab.folder = folder;
  const tabId = "alpha-dev";
  server = await loadFixed({ skipHealth: true, testRoot: data, workspaces,
    serverSource: source + '\nfixedTasks.run3Install = (store) => { fixedTasks = store; };',
    preload(root) {
      mkdirSync(join(root, "tasks"));
      const task = taskFixture(folder, tabId, visible ? "roughApproved" : "approved");
      if (!visible) { task.plan.visibleWork = false;
        // Rebuild the plan digest/approval exactly as a non-visible approved fixture.
        task.planDigest = digestForFixture({ plan: task.plan, seats: task.seats });
        task.ownerScopeApproval.digest = task.planDigest;
      }
      task.stage = stage;
      writeFileSync(join(root, "tasks", `${tabId}.json`), JSON.stringify(task));
    } });
  const ws = connect(server); ws.terminate = () => { ws.readyState = 3; };
  server.createTabLeader(tabId);
  const task = () => server.fixedTasks.get(tabId);
  const expected = () => { const current = task(); return { taskId: current.id, planVersion: current.planVersion, recordRevision: current.recordRevision }; };
  const message = { type: "requestFixedTaskAction", requestId: "run3-request", tabId, ...expected(), action: visible ? "polish" : "build" };
  const disk = () => readFileSync(join(data, "tasks", `${tabId}.json`), "utf8");
  const wait = async () => {
    for (let i = 0; i < 200; i++) {
      const error = ws.messages.find((m: any) => m.type === "error" && m.requestId === message.requestId);
      if (error) return error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("correlated delivery error was not delivered");
  };
  const reject = (change: () => void = () => {}) => {
    server.leaders.get(tabId).send = () => { change(); throw new Error("injected delivery rejection"); };
  };
  return { server, ws, root, data, folder, tabId, task, expected, message, disk, wait, reject };
}

import { digest as digestForFixture } from "../server/fixed-crew/task-revision.ts";
