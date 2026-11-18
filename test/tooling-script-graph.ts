import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Static relative imports and re-exports of one script (import x from "./y.mjs", export * from "./y.mjs", import "./y.mjs").
const LOCAL_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const DYNAMIC_SPECIFIER = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const URL_SPECIFIER = /\bimport\(\s*new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)\s*\)/g;

// Repo-relative (forward-slash) files an entry script needs, itself included, following local imports transitively.
export function localImportClosure(root: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const key = relative(root, file).replaceAll("\\", "/");
    if (seen.has(key)) return;
    seen.add(key);
    if (!/\.(?:mjs|js|ts)$/.test(file)) return;
    const text = readFileSync(file, "utf8");
    for (const pattern of [LOCAL_SPECIFIER, DYNAMIC_SPECIFIER, URL_SPECIFIER]) {
      for (const match of text.matchAll(pattern)) visit(resolve(dirname(file), match[1]));
    }
  };
  visit(join(root, entry));
  return [...seen].sort();
}

// Entry scripts the project itself runs: every `node scripts/<file>` in package.json "scripts".
export function packageScriptEntries(pkg: { scripts: Record<string, string> }): string[] {
  const entries = new Set<string>();
  for (const command of Object.values(pkg.scripts)) for (const match of command.matchAll(/node\s+(scripts\/[\w./-]+\.mjs)/g)) entries.add(match[1]);
  return [...entries].sort();
}

// Files an entry needs that the shipped list does not carry.
export function missingFromShipped(root: string, entries: string[], shipped: Set<string>): string[] {
  return entries.flatMap((entry) => localImportClosure(root, entry).filter((file) => !shipped.has(file)).map((file) => `${entry} needs ${file}`));
}
