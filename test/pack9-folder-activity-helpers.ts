// Pack 9 folder-activity tests, shared setup: fake Claude, Codex and OpenCode records under a fake home, and the folder constants.
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type OwnSessions } from "../server/folder-activity.ts";
import { codexRecord as plantCodexRecord } from "./codex-record.ts";

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export const noOwn = (): OwnSessions => ({ ids: new Map(), windows: new Map() });
export const touch = (path: string, mtimeMs: number) => utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
export const keys = (found: { sessionKey: string }[]) => found.map((item) => item.sessionKey).sort();
// A reader that throws must fail an ASSERTION (not just crash the test), so the check can be proven red by putting the throw back.
export const safely = <T>(read: () => T): T => { let result!: T; assert.doesNotThrow(() => { result = read(); }); return result; };

// ---- fake records, in the shapes the tools write (field names confirmed on this machine; no content) ----
export function claudeRecord(home: string, folder: string, id: string, mtimeMs: number, slugCase: "original" | "lower" = "original"): void {
  const slug = folder.replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", slugCase === "lower" ? slug.toLowerCase() : slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `{"type":"user","sessionId":"${id}","cwd":"x"}\n`);
  touch(file, mtimeMs);
}
export const pad = (value: number) => String(value).padStart(2, "0");
export const codexRecord = (home: string, cwd: string, id: string, mtimeMs: number, options: { dayOf?: number; firstLine?: string; bulk?: number } = {}): string =>
  plantCodexRecord(home, cwd, id, mtimeMs, { day: options.dayOf, firstLine: options.firstLine, bulk: options.bulk ?? 100 });
// `time_created` left out means the row has no known start; `withCreated: false` builds a database without the column at all.
export type Row = { id: string; directory: string; time_updated: number; time_created?: number };
export function opencodeDb(home: string, rows: Row[], withCreated = true): string {
  const path = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = process.getBuiltinModule("node:sqlite")!;
  const db = new sqlite.DatabaseSync(path);
  db.exec(`create table session (id text primary key, directory text, time_updated integer${withCreated ? ", time_created integer" : ""})`);
  const insert = db.prepare(`insert into session (id, directory, time_updated${withCreated ? ", time_created" : ""}) values (?, ?, ?${withCreated ? ", ?" : ""})`);
  for (const row of rows) withCreated ? insert.run(row.id, row.directory, row.time_updated, row.time_created ?? null) : insert.run(row.id, row.directory, row.time_updated);
  db.close();
  return path;
}

export const TAB = "C:/w/proj/app";
export const SAME = TAB, PARENT = "C:/w/proj", CHILD = "C:/w/proj/app/sub", OTHER = "C:/w/other", LOOKALIKE = "C:/w/proj/apple", SHORTER = "C:/w/pro";
