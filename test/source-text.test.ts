import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appSource, harnessSource, pageScripts, pageStyles, serverIndexSource, sourceFiles, sourceText, styleSource } from "./source-text.ts";
import { scratchDir } from "./temp-root.ts";

const repoFile = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8").replaceAll("\r\n", "\n");

test("the readers return the real files' text (the server entry last, after the modules it imports)", () => {
  assert.ok(appSource().startsWith('(() => {\n  "use strict";\n') && appSource().endsWith("\n})();\n"), "the page script is rebuilt inside its one wrapper");
  assert.equal(styleSource(), pageStyles().filter((path) => path.startsWith("public/styles/")).map(repoFile).join(""));
  assert.ok(serverIndexSource().endsWith(repoFile("server/index.ts")), "the entry comes last");
  assert.equal(sourceText("public/app.js"), appSource());
  assert.equal(sourceText("public/style.css"), styleSource());
  assert.equal(sourceText("server/index.ts"), serverIndexSource());
  assert.equal(sourceText("server/config.ts"), repoFile("server/config.ts"));
});

test("the page lists come from index.html in order and hold the app script and the main style", () => {
  const scripts = pageScripts();
  const styles = pageStyles();
  assert.ok(scripts.length > 0 && styles.length > 0, "found no script or style tags at all");
  assert.ok(scripts.includes("public/app.js") || scripts.some((path) => path.startsWith("public/app/")), `no app script in ${scripts.join(", ")}`);
  assert.ok(styles.includes("public/style.css") || styles.some((path) => path.startsWith("public/styles/")), `no main style in ${styles.join(", ")}`);
});

test("a split tree rebuilds the one-file text: wrapper, parts without their header up to the first use-strict line, parts in page order", () => {
  const root = scratchDir();
  const files: Record<string, string> = {
    "public/index.html": '<link rel="stylesheet" href="/styles/b.css"><link rel="stylesheet" href="/styles/a.css">\r\n<script defer src="/logos.js"></script><script defer src="/app/02.js"></script><script defer src="/app/01.js"></script>',
    "public/app/01.js": '// header\n  "use strict";\n  const one = 1;\n',
    "public/app/02.js": '  "use strict";\n  const two = 2;\n',
    "public/styles/a.css": "a {}\n",
    "public/styles/b.css": "b {}\n",
    "server/index.ts": "index\n",
  };
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
  assert.deepEqual(pageScripts(root), ["public/logos.js", "public/app/02.js", "public/app/01.js"]);
  assert.equal(appSource(root), '(() => {\n  "use strict";\n  const two = 2;\n  const one = 1;\n})();\n');
  assert.equal(styleSource(root), "b {}\na {}\n");
  assert.equal(serverIndexSource(root), "index\n");
});

test("the server entry joins with the server/main modules it imports in Node's evaluation order: a module after what it imports, the entry last, each once, unimported files left out", () => {
  const root = scratchDir();
  const files: Record<string, string> = {
    "server/index.ts": 'import { z } from "./main/z.ts";\nimport {\n  a,\n} from "./main/sub/a.ts";\nindex\n',
    "server/main/z.ts": 'import { a } from "./sub/a.ts";\nimport { other } from "../other.ts";\nz\n',
    "server/main/sub/a.ts": "sub-a\n",
    "server/main/orphan.ts": "orphan\n",
    "server/other.ts": "other\n",
  };
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
  // index imports z first; z imports a first. So: a, then z, then index. other.ts is not a main module, orphan.ts is imported by nobody.
  assert.equal(serverIndexSource(root), `sub-a\n${files["server/main/z.ts"]}${files["server/index.ts"]}`);
  assert.ok(!sourceText("server/index.ts", root).includes("orphan"), "control: an unimported file must not be joined in");
});

test("the harness text is the one file while it exists, else its parts joined in name order with CRLF turned to LF", () => {
  const root = scratchDir();
  mkdirSync(join(root, "test/browser-harness"), { recursive: true });
  writeFileSync(join(root, "test/browser-harness/02-b.js"), "b\r\n");
  writeFileSync(join(root, "test/browser-harness/01-a.js"), "a\n");
  assert.equal(harnessSource(root), "a\nb\n");
  writeFileSync(join(root, "test/browser-harness.js"), "whole\r\n");
  assert.equal(harnessSource(root), "whole\n");
});

const plant = (root: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
};

test("sourceFiles lists top-level files as themselves and each split folder's parts as its one logical file, once, sorted; other file types are not matched", () => {
  const root = scratchDir();
  plant(root, {
    "public/index.html": '<script defer src="/app/01.js"></script>', "public/app/01.js": '"use strict";\n', "public/top.js": "top\n", "public/avatars/x.svg": "<svg/>",
    "server/index.ts": "index\n", "server/main/m.ts": "m\n", "server/foo.ts": "foo\n", "server/foo/a.ts": "a\n", "server/foo/sub/b.ts": "b\n",
  });
  assert.deepEqual(sourceFiles(root), ["public/app.js", "public/top.js", "server/foo.ts", "server/index.ts"]);
  assert.equal(sourceText("server/foo.ts", root), "foo\na\nb\n");
});

test("a source file inside a folder that no rule claims throws, naming the file (never skipped)", () => {
  const root = scratchDir();
  plant(root, { "server/orphan/x.ts": "x\n", "public/top.js": "top\n" });
  assert.throws(() => sourceFiles(root), /server\/orphan\/x\.ts/);
});

test("real repo: an independent walk of server/ and public/ finds every file's text inside its logical entry, and every entry is listed", () => {
  const walk = (dir: string): string[] => readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url)), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.(ts|js|mjs)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []));
  const physical = [...walk("server"), ...walk("public")];
  const listed = sourceFiles();
  const entries = new Set<string>();
  for (const file of physical) {
    const parts = file.split("/");
    const entry = parts.length === 2 ? file : parts[1] === "app" ? "public/app.js" : parts[1] === "main" ? "server/index.ts" : `server/${parts[1]}.ts`;
    entries.add(entry);
    let text = repoFile(file);
    if (entry === "public/app.js" && parts.length > 2) text = text.slice(text.indexOf("\n", text.indexOf('"use strict";')) + 1);
    assert.ok(sourceText(entry).includes(text), `${file} is not inside ${entry}`);
    assert.ok(listed.includes(entry), `${entry} is not listed by sourceFiles`);
  }
  console.log(`source scan: ${physical.length} physical files, ${entries.size} logical entries`);
  assert.ok(physical.length >= 40, `control: the walk found only ${physical.length} files`);
});

test("real repo, before any split: the top-level names are exactly what the three sweeps listed with readdirSync", () => {
  const names = (dir: string, pattern: RegExp): string[] => readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))).filter((name) => pattern.test(name)).sort().map((name) => `${dir}/${name}`);
  const top = sourceFiles().filter((file) => file.split("/").length === 2 && file !== "public/app.js"); // public/app.js is the logical entry of public/app/*.js
  assert.deepEqual(top, [...names("public", /\.(ts|js|mjs)$/), ...names("server", /\.(ts|js|mjs)$/)].sort());
});
