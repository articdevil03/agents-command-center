import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsOnly, sleep, until, alive, killTree, made, scratch, put } from "./pack2-process-helpers.ts";

import { LIST_TIMEOUT_MS, KILL_TIMEOUT_MS } from "../server/leader-common/types.ts";
const REPORT_WAIT_MS = LIST_TIMEOUT_MS + KILL_TIMEOUT_MS + 10_000;

// A run that has been reported over must not keep the server's pipe handles open because a leftover process inherited them.
// A real server-like process (a node script that imports the real runner) runs a fake CLI that starts a holder and exits; the sweep cannot stop the holder
// (its process list is unreadable), so only letting go of the pipes lets the script exit.
test("a finished run lets go of its output pipes: a leftover that inherited them does not keep the server process alive", { ...windowsOnly, timeout: REPORT_WAIT_MS + 30_000 }, async () => {
  const work = scratch("cc-p19b-work-"), bin = scratch("cc-p19b-bin-"), data = scratch("cc-p19b-data-"), home = scratch("cc-p19b-script-");
  const holderPid = join(bin, "holder.pid"); made.push(holderPid);
  put(bin, "hold.js", `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => process.exit(0), 60000);`);
  put(bin, "codex.cmd", `@echo off\r\nstart "" /b "${process.execPath}" "%~dp0hold.js" "%~dp0holder.pid"\r\nping -n 2 127.0.0.1 >nul\r\nexit /b 0\r\n`);
  const treeFile = put(data, "tree.json", JSON.stringify({ failList: true }));
  const runnerUrl = pathToFileURL(join(process.cwd(), "server", "runner.ts")).href;
  const script = put(home, "drive.mjs", `
    const { runSeat } = await import(${JSON.stringify(runnerUrl)});
    const run = { runId: "p19b-pipes", seatKey: "p19b.coder", slotId: "coder", name: "Sonny", cli: "codex", model: "gpt-6-sol", effort: "high", folder: ${JSON.stringify(work)}, canWrite: true, startedAt: 100 };
    const cb = { onOutput() {}, onStatus(_run, status) { if (status !== "working") console.log("REPORTED " + status); } };
    if (!runSeat(run, "go", cb).ok) process.exit(3);
  `);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CC_DATA_DIR: data, CC_TEST_FORCE_PACKAGED: "1", CC_TEST_FAKE_CLI: "1", CC_TEST_TREE_FILE: treeFile };
  const child = spawn(process.execPath, [script], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", reportedAt = 0, exitedAt = 0;
  child.stderr.on("data", (chunk) => { out += chunk; });
  child.stdout.on("data", (chunk) => { out += chunk; if (!reportedAt && out.includes("REPORTED")) reportedAt = Date.now(); });
  child.on("exit", () => { exitedAt = Date.now(); });
  try {
    assert.ok(await until(() => reportedAt > 0, REPORT_WAIT_MS), `the run was reported over; output: ${out}`);
    assert.ok(await until(() => existsSync(holderPid) && readFileSync(holderPid, "utf8").length > 0, 5000), "the leftover holder started");
    const held = Number(readFileSync(holderPid, "utf8"));
    try {
      assert.ok(await until(() => exitedAt > 0, 15_000), "the process exits within 15 s of the report although a leftover holds the CLI's pipes");
      assert.ok(exitedAt - reportedAt < 15_000);
      assert.ok(alive(held), "the leftover was not stopped (the sweep was blinded), so only the destroyed pipes let the process go");
    } finally { killTree(held); await sleep(100); }
  } finally { if (!exitedAt) killTree(child.pid!); }
});
