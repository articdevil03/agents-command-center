import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCliRunner } from "../server/test-cli-runner.ts";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";

test("the fake CLI is script-gated, records exact argv, and never imports a process runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-fake-cli-test-"));
  try {
    const script = join(root, "responses.json");
    const record = join(root, "argv.jsonl");
    const response = { code: 0, stdout: "Gemini CLI 1.0.0\n", stderr: "" };
    writeFileSync(script, JSON.stringify({ responses: { [JSON.stringify(["gemini", "--version"])]: response } }));
    const disabled = createTestCliRunner({ CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: record } as NodeJS.ProcessEnv);
    assert.equal(disabled, undefined, "the script file alone cannot activate a fake runner");

    const runner = createTestCliRunner({ CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: record } as NodeJS.ProcessEnv);
    assert.ok(runner);
    assert.deepEqual(await runner("gemini", ["--version"], { timeoutMs: 500 }), response);
    assert.deepEqual(await runner("unknown", ["--version"], { timeoutMs: 500 }), { code: 127, stdout: "", stderr: "test fake runner" });
    assert.deepEqual(readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
      ["gemini", "--version"], ["unknown", "--version"],
    ]);

    const source = readFileSync(new URL("../server/test-cli-runner.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /node:child_process|from\s+["']child_process|require\s*\(\s*["']child_process/);
    assert.doesNotMatch(source, /\b(?:spawn|exec|fork)\s*\(/);
  } finally { removeWithRetry(root); }
});
