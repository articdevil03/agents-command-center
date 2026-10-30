import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// One reader for the page script, the page styles and the server entry, so a test does not care whether the code sits in one file or in
// parts. Every text is CRLF-normalised to LF. Before a split these return exactly the one file's text.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const lf = (path: string): string => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

// The paths a tag attribute names in public/index.html, in document order, as repo-relative paths (`/app.js` -> `public/app.js`).
function pagePaths(pattern: RegExp, root: string): string[] {
  return [...lf(join(root, "public/index.html")).matchAll(pattern)].map((match) => `public${match[1]}`);
}
export const pageScripts = (root = repoRoot): string[] => pagePaths(/<script\b[^>]*\ssrc="([^"]+)"/g, root);
export const pageStyles = (root = repoRoot): string[] => pagePaths(/<link\b[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g, root);

// public/app.js, or (once it is split into public/app/*.js parts) the old file rebuilt exactly: its wrapper, then each part with everything
// up to and including its own first "use strict"; line removed.
export function appSource(root = repoRoot): string {
  const whole = join(root, "public/app.js");
  if (existsSync(whole)) return lf(whole);
  const parts = pageScripts(root).filter((path) => path.startsWith("public/app/"));
  const body = parts.map((path) => { const text = lf(join(root, path)); return text.slice(text.indexOf("\n", text.indexOf('"use strict";')) + 1); });
  return `(() => {\n  "use strict";\n${body.join("")}})();\n`;
}

// public/style.css, or (once split) the public/styles/*.css parts in page order.
export function styleSource(root = repoRoot): string {
  const whole = join(root, "public/style.css");
  if (existsSync(whole)) return lf(whole);
  return pageStyles(root).filter((path) => path.startsWith("public/styles/")).map((path) => lf(join(root, path))).join("");
}

// A server file plus every .ts file in its folder (server/<d>.ts -> server/<d>/), the folder sorted by path.
function serverJoined(root: string, file: string, folder: string): string {
  const files = existsSync(join(root, file)) ? [join(root, file)] : [];
  const dir = join(root, folder);
  if (existsSync(dir)) {
    const nested = (at: string): string[] => readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? nested(join(at, name)) : name.endsWith(".ts") ? [join(at, name)] : []));
    files.push(...nested(dir).sort());
  }
  return files.length ? files.map(lf).join("") : lf(join(root, file));
}
// server/index.ts with every server/main/** module it imports, in the order Node evaluates them: a module after the modules it imports (depth first, in import
// order, each once), server/index.ts last. That is one runnable program, so a test can run it whole or slice it. A module nothing imports is left out.
export function serverIndexSource(root = repoRoot): string {
  const mainDir = resolve(root, "server/main") + sep;
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of lf(file).matchAll(/\bfrom\s+"(\.[^"]+)"/g)) {
      const target = resolve(dirname(file), match[1]);
      if (target.startsWith(mainDir) && existsSync(target)) visit(target);
    }
    order.push(file);
  };
  visit(resolve(root, "server/index.ts"));
  return order.map(lf).join("");
}

// test/browser-harness.js, or (once it is split) the test/browser-harness/*.js parts joined in name order.
export function harnessSource(root = repoRoot): string {
  const whole = join(root, "test/browser-harness.js");
  if (existsSync(whole)) return lf(whole);
  const dir = join(root, "test/browser-harness");
  return readdirSync(dir).filter((name) => name.endsWith(".js")).sort().map((name) => lf(join(dir, name))).join("");
}

export function sourceText(path: string, root = repoRoot): string {
  if (path === "public/app.js") return appSource(root);
  if (path === "public/style.css") return styleSource(root);
  if (path === "server/index.ts") return serverIndexSource(root);
  const server = /^server\/([^/]+)\.ts$/.exec(path);
  if (server) return serverJoined(root, path, `server/${server[1]}`);
  return lf(join(root, path));
}

// Every .ts/.js/.mjs file under server/ and public/ (recursive, on disk), each part inside a split folder listed as the one file it came
// from: server/main/** -> server/index.ts, server/<d>/** -> server/<d>.ts, public/app/** -> public/app.js. A file no rule claims throws.
const SOURCE_FILE = /\.(ts|js|mjs)$/;
function walk(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(root, path) : SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}
function logicalEntry(file: string, root: string): string {
  const [top, folder] = file.split("/");
  if (file.split("/").length === 2) return file;
  if (top === "public" && folder === "app") return "public/app.js";
  if (top === "server" && folder === "main") return "server/index.ts";
  if (top === "server" && existsSync(join(root, `server/${folder}.ts`))) return `server/${folder}.ts`;
  throw new Error(`${file} sits in a folder that is not a split part of any source file`);
}
export function sourceFiles(root = repoRoot): string[] {
  return [...new Set(["server", "public"].flatMap((dir) => walk(root, dir)).map((file) => logicalEntry(file, root)))].sort();
}
