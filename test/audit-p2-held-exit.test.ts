import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root.ts";
import { loadFixed } from "./round2-helpers.ts";

test("startup and clean exit retain held live facts in memory without attempting publication", async () => {
  const root = tempRoot(), safetyPath = join(root, "launch-safety.json");
  const live = [{ seatId: "old.coder", runId: "old-run" }];
  writeFileSync(safetyPath, JSON.stringify({ recoveryHold: true, blocked: ["old.coder"], live }));
  let writes = 0;
  const server = await loadFixed({ testRoot: root, safetyPath, onSafetyWrite: () => { writes++; } });
  assert.deepEqual(JSON.parse(JSON.stringify(server.launchSafety.live)), live);
  assert.equal(writes, 0);
  server.processHandlers.exit(0);
  assert.deepEqual(JSON.parse(JSON.stringify(server.launchSafety.live)), live);
  assert.equal(writes, 0);
});
