import { appendFileSync, readFileSync } from "node:fs";
import type { CliResult, RunCli } from "./settings.ts";

type Script = { responses?: Record<string, CliResult> };

export function createTestCliRunner(env: NodeJS.ProcessEnv = process.env): RunCli | undefined {
  if (env.CC_TEST_FAKE_CLI !== "1") return undefined;

  let responses: Record<string, CliResult> = {};
  const scriptPath = env.CC_TEST_FAKE_CLI_SCRIPT;
  if (scriptPath) {
    try {
      const parsed = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
      if (parsed && parsed.responses && typeof parsed.responses === "object" && !Array.isArray(parsed.responses)) {
        responses = parsed.responses;
      }
    } catch {
      responses = {};
    }
  }

  const recordPath = env.CC_TEST_FAKE_CLI_RECORD;
  return async (bin, args) => {
    const argv = [bin, ...args];
    if (recordPath) appendFileSync(recordPath, `${JSON.stringify(argv)}\n`, "utf8");
    const result = responses[JSON.stringify(argv)];
    return result && Number.isInteger(result.code)
      ? { code: result.code, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }
      : { code: 127, stdout: "", stderr: "test fake runner" };
  };
}
