// Plants a fake Codex session record. Codex names the day folder after the local date the session was CREATED on, which can never be
// ahead of the server's clock, while the file's mtime is whatever the test asks for (often "30 s from now"). So the folder follows
// `day` (default: now), never the mtime: a record planted at 23:59:53 + 30 s must not land in tomorrow's folder.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pad = (value: number) => String(value).padStart(2, "0");

export function codexRecord(home: string, cwd: string, id: string, mtimeMs: number, options: { day?: number; now?: number; firstLine?: string; bulk?: number } = {}): string {
  const day = new Date(options.day ?? options.now ?? Date.now());
  const dir = join(home, ".codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-15T10-00-00-${id}.jsonl`);
  const first = options.firstLine ?? JSON.stringify({ timestamp: "2026-10-15T10:00:00Z", type: "session_meta", payload: { id, cwd, ...(options.bulk ? { base_instructions: "i".repeat(options.bulk) } : {}) } });
  writeFileSync(file, `${first}\n{"type":"event_msg"}\n`);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
