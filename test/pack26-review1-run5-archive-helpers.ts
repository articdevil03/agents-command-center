import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { archiveJson, archiveHash, byteIdentity } from "../server/fixed-crew/task-archive-files.ts";
import type { Run4Fixture } from "./pack26-review1-run4-helpers.ts";

export const archiveBase = (f: Run4Fixture, id: string) => join(f.data, "tasks", "finished", f.tabId, id);
export function archiveBytes(f: Run4Fixture): Record<string, string> {
  const base = join(f.data, "tasks", "finished");
  const files: Record<string, string> = {};
  const walk = (folder: string) => { for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path); else files[path] = readFileSync(path).toString("hex");
  } };
  walk(base); return files;
}
// Re-sign the fixture so metadata/task validation is exercised beyond receipt/hash checks.
export function rewriteArchive(f: Run4Fixture, id: string, change: (manifest: any, source: any) => void) {
  const base = archiveBase(f, id), manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8"));
  const source = JSON.parse(readFileSync(join(base, "source.json"), "utf8"));
  change(manifest, source);
  const sourceBytes = archiveJson(source), taskBytes = archiveJson({ ...source, stage: "complete" });
  writeFileSync(join(base, "source.json"), sourceBytes); writeFileSync(join(base, "task.json"), taskBytes);
  manifest.source = byteIdentity(sourceBytes); manifest.task = byteIdentity(taskBytes);
  const bytes = archiveJson(manifest); writeFileSync(join(base, "manifest.json"), bytes);
  writeFileSync(join(base, "complete.json"), archiveJson({ version: 1, tabId: f.tabId, taskId: id, manifestHash: archiveHash(bytes) }));
}
export async function bothLists(f: Run4Fixture, cursor: string | null = null, limit = 50) {
  const tool = await f.tool("list_task_archives", { kind: "task", cursor, limit });
  const requestId = `owner-list-${f.ws.messages.length}`;
  f.ws.message({ type: "listFixedTaskArchives", requestId, tabId: f.tabId, cursor, limit });
  const reply = f.ws.messages.find((m: any) => m.requestId === requestId);
  assert.equal(reply.type, "fixedTaskArchives", JSON.stringify(reply));
  assert.deepEqual({ items: reply.items, nextCursor: reply.nextCursor }, tool);
  return tool;
}
export async function bothRefuse(f: Run4Fixture) {
  const result = await f.call("list_task_archives", { kind: "task", cursor: null, limit: 50 });
  assert.equal(result.isError, true, `unverified archive advertised: ${result.text}`);
  const requestId = `refused-${f.ws.messages.length}`;
  f.ws.message({ type: "listFixedTaskArchives", requestId, tabId: f.tabId, cursor: null, limit: 50 });
  assert.equal(f.ws.messages.find((m: any) => m.requestId === requestId).type, "error");
}
