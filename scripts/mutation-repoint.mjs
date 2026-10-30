import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Usage: node scripts/mutation-repoint.mjs <catalogue.mjs> <old-path> <new-file>...
// After code moved out of <old-path>, re-points each catalogue row whose from-text is no longer found exactly once there to the ONE new file
// that holds it exactly once. Only that row's path string is rewritten. Ambiguous or vanished rows are listed and left alone (exit 1).
// Prints the re-pointed row names, comma-joined: the input for a scoped sweep.
const readLf = (file) => { try { return readFileSync(file, "utf8").replaceAll("\r\n", "\n"); } catch { return null; } };
const countIn = (text, from) => (text === null ? 0 : text.split(from).length - 1);
function rowPaths(text, name, path) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\[\\s*(["'])${escape(name)}\\2\\s*,\\s*)(["'])${escape(path)}\\3`, "g");
  return [...text.matchAll(pattern)].map((hit) => ({ index: hit.index + hit[1].length, length: path.length + 2 }));
}

export async function repoint(catalogue, oldPath, newFiles) {
  const rows = Object.values(await import(`${pathToFileURL(resolve(catalogue)).href}?t=${Date.now()}`)).flat();
  const oldText = readLf(oldPath);
  const newTexts = newFiles.map((file) => [file, readLf(file)]);
  let data = readFileSync(catalogue, "utf8");
  const moved = [];
  const refused = [];
  for (const [name, path, from] of rows) {
    if (path !== oldPath || countIn(oldText, from) === 1) continue;
    const holders = newTexts.filter(([, text]) => countIn(text, from) > 0);
    if (holders.length !== 1 || countIn(holders[0][1], from) !== 1) {
      refused.push(`${name}: ${holders.length === 0 ? "text found in no new file" : `text found ${holders.map(([file, text]) => `${countIn(text, from)}x in ${file}`).join(", ")}`}`);
      continue;
    }
    const hits = rowPaths(data, name, oldPath);
    if (hits.length !== 1) { refused.push(`${name}: expected exactly one row in ${catalogue}, found ${hits.length}`); continue; }
    const [pathHit] = hits;
    const quote = data[pathHit.index];
    data = data.slice(0, pathHit.index) + quote + holders[0][0] + quote + data.slice(pathHit.index + pathHit.length);
    moved.push(name);
  }
  if (moved.length) writeFileSync(catalogue, data);
  return { moved, refused };
}

if (import.meta.main) {
  const [catalogue, oldPath, ...newFiles] = process.argv.slice(2);
  if (!catalogue || !oldPath || !newFiles.length) throw new Error("usage: mutation-repoint.mjs <catalogue.mjs> <old-path> <new-file>...");
  const { moved, refused } = await repoint(catalogue, oldPath, newFiles);
  console.log(moved.join(","));
  for (const line of refused) console.error(`REFUSED ${line}`);
  if (refused.length) process.exit(1);
}
