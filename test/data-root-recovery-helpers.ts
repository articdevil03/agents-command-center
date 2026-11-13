import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateFixedCrew } from "../server/fixed-crew/preferences.ts";
export function assertFresh(workspaces: any) {
  assert.equal(workspaces.projects.length, 1);
  const tab = workspaces.projects[0].tabs[0];
  assert.equal(tab.setupName, "Fixed crew"); assert.deepEqual(tab.crew, []);
  assert.deepEqual(tab.steps, []); assert.equal(tab.lookPause, false);
  assert.equal(tab.fixedCrew.version, 1); assert.equal(Object.keys(tab.fixedCrew.preferences).length, 18);
  assert.deepEqual(validateFixedCrew(tab.fixedCrew), tab.fixedCrew);
}
export function assertRecovery(root: string, path: string, original: string) {
  const marker = JSON.parse(readFileSync(join(root, "config/fixed-crew-recovery.json"), "utf8"));
  assert.equal(marker.status, "complete");
  const bytes = readFileSync(join(root, "backups", marker.archive, path));
  assert.deepEqual(bytes, Buffer.from(original));
  const entry = marker.entries.find((entry: any) => entry.path === path); assert.ok(entry);
  assert.equal(entry.size, bytes.length); assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  return { marker, bytes };
}
