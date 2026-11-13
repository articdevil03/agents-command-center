import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_RENDER_MS, waitForFirstRender } from "./page-first-render.ts";

// Pack 22 block D: every page's first-render wait goes through the one shared helper, so no copy keeps the short 15 s bound.
const TEST_DIR = import.meta.dirname;
const SKIPPED = new Set(["page-first-render.ts", "tooling-render-wait.test.ts"]);
const EXPECTED_FILES = ["overlap-chrome.ts", "pack18-editor-harness.ts"];
// Any first argument (literal, identifier, call, multi-line) before the "app render" label; the lazy middle may not cross into another waitFor call or past the end of a statement.
const FIRST_RENDER_CALL = /\b(waitFor|waitForFirstRender)\s*\((?:(?!\bwaitFor(?:FirstRender)?\s*\(|\)\s*;)[\s\S])*?,\s*(["'`])app render[^"'`\r\n]*\2\s*\)/g;

function firstRenderCalls(files: [string, string][]) {
  return files.flatMap(([name, text]) => [...text.matchAll(FIRST_RENDER_CALL)].map((match) => ({
    name, line: text.slice(0, match.index).split("\n").length, callee: match[1],
  })));
}
const realFiles = (): [string, string][] => readdirSync(TEST_DIR).filter((n) => n.endsWith(".ts") && !SKIPPED.has(n)).map((n) => [n, readFileSync(join(TEST_DIR, n), "utf8")]);

test("every first-render wait uses waitForFirstRender, in exactly the 2 known files, once each", () => {
  const calls = firstRenderCalls(realFiles());
  console.log(`matched: ${calls.map((c) => `${c.name}:${c.line}`).join(", ")}`);
  assert.deepEqual(calls.filter((c) => c.callee !== "waitForFirstRender"), [], "raw waitFor on the app render");
  assert.deepEqual(calls.map((c) => c.name).sort(), [...EXPECTED_FILES].sort());
});

test("the first-render bound is generous", () => {
  assert.ok(FIRST_RENDER_MS >= 60_000, `FIRST_RENDER_MS is ${FIRST_RENDER_MS}`);
});

test("control: a planted raw app-render wait is flagged", () => {
  const planted = "    await " + "waitFor(`document.body`, " + '"app render");';
  const calls = firstRenderCalls([["planted.ts", planted]]);
  assert.deepEqual(calls.map((c) => c.callee), ["waitFor"]);
});

test("control: a planted raw app-render wait with an identifier first argument is flagged, and a neighbouring call is not swallowed", () => {
  const planted = ["await " + "waitFor(EXPR_CONST, \"app render\");", "await waitFor(other, \"later\");"].join("\n");
  const calls = firstRenderCalls([["planted.ts", planted]]);
  assert.deepEqual(calls, [{ name: "planted.ts", line: 1, callee: "waitFor" }]);
  const neighbour = ["await " + "waitFor(first, \"x\");", "report(second, \"app render\");"].join("\n");
  assert.deepEqual(firstRenderCalls([["planted.ts", neighbour]]), [], "an unrelated later call is not matched");
});

test("R1 waitForFirstRender forwards the shared timeout to waitFor", async () => {
  const calls: unknown[][] = [];
  await waitForFirstRender(async (...args) => { calls.push(args); }, "document.body", "app render fixture");
  assert.deepEqual(calls, [["document.body", "app render fixture", FIRST_RENDER_MS]]);
});

test("control: a planted multi-line single-quoted raw app-render wait with suffix is flagged", () => {
  const planted = ["await " + "waitFor(", "  `document.body`,", "  'app render fixture'", ");"].join("\n");
  const calls = firstRenderCalls([["planted.ts", planted]]);
  assert.deepEqual(calls, [{ name: "planted.ts", line: 1, callee: "waitFor" }]);
});
