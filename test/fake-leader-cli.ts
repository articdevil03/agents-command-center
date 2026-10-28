// Far-boundary fakes for the Codex and OpenCode leader children. The server swaps its spawn for this one
// (CC_TEST_FAKE_CLI + CC_TEST_FAKE_LEADER_CLI), so the real leader code, JSON-RPC, HTTP and SSE all run.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnAcpChild } from "../server/leader-common.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export function spawnFakeLeaderCli(command: string, options: any) {
  const opencode = /^opencode serve /.test(command);
  if (!opencode && command !== "codex app-server") throw new Error(`fake leader CLI does not know: ${command}`);
  const args = opencode ? [here("fake-opencode-server.mjs"), ...command.split(" ").slice(2)] : [here("fake-codex-app-server.mjs")];
  // The tab folder (inside the test's own temp folder) rides along as an argument no fake reads, so a test can tell this run's fake from another run's.
  if (typeof options?.cwd === "string") args.push(options.cwd);
  return spawn(process.execPath, args, { ...options, shell: false });
}

// The fake ACP agent stands in for the program named "fake-acp" only. Any other program name takes the real, safe resolution (tests of a CLI inside a project folder rely on that).
export function spawnFakeAcp(program: string, args: string[], options: any) {
  if (program !== "fake-acp") return spawnAcpChild(program, args, options);
  return spawn(process.execPath, [here("fake-acp-agent.mjs"), ...args], { ...options, shell: false });
}
