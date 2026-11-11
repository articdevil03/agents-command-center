import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Which rows were checked before: the catch map, a RED or SURVIVED record in an earlier sweep folder (<out>/<day>/sweep-*/results.jsonl), or a line
// of today's old per-row shape in an old log (<out>/<day>/*.log, *.out). Two folder depths only, never a recursive walk.
const entriesOf = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const linesOf = (path) => { try { return readFileSync(path, "utf8").split("\n"); } catch { return []; } };
const parseJson = (line) => { try { return JSON.parse(line); } catch { return null; } };

function addSweepRecords(folder, names) {
  for (const line of linesOf(join(folder, "results.jsonl"))) {
    const record = line.startsWith("{") ? parseJson(line) : null;
    if (record?.type === "row" && (record.status === "RED" || record.status === "SURVIVED")) names.add(record.name);
  }
}

// {"name":"<n>","red":<non-zero>,"restored":0,...}: the old tool printed one per row that went red and restored green.
function addOldLogRows(path, names) {
  for (const line of linesOf(path)) {
    if (!line.trimStart().startsWith('{"name":')) continue;
    const row = parseJson(line.trim());
    if (typeof row?.name === "string" && Number.isInteger(row.red) && row.red !== 0 && row.restored === 0) names.add(row.name);
  }
}

export function checkedBefore({ out, catchMap, exclude = null }) {
  const names = new Set(catchMap.keys());
  const skip = exclude && resolve(exclude);
  for (const day of entriesOf(out)) {
    if (!day.isDirectory()) continue;
    for (const item of entriesOf(join(out, day.name))) {
      const path = join(out, day.name, item.name);
      if (item.isDirectory() && item.name.startsWith("sweep-")) { if (resolve(path) !== skip) addSweepRecords(path, names); }
      else if (item.isFile() && /\.(log|out)$/.test(item.name)) addOldLogRows(path, names);
    }
  }
  return names;
}
