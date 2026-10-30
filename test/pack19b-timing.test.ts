import test from "node:test";
import assert from "node:assert/strict";
import { source, shellHarness, within } from "./electron-helpers.ts";
import { SWEEP_CAP_MS, describeStartupSweep } from "../server/leader-common.ts";

// Electron waits for the server, which first runs its start-up sweep (up to SWEEP_CAP_MS) before it listens.
test("Electron's readiness wait is longer than the server's start-up sweep cap plus start-up work", async () => {
  const found = source.match(/const READY_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(found, "READY_TIMEOUT_MS found in electron/server-process.js");
  const ready = Number(found[1].replaceAll("_", ""));
  const h = shellHarness();
  const started = h.startServer();
  await Promise.resolve();
  assert.deepEqual([...h.timers.values()].map(({ ms }) => ms), [ready], "startServer arms the declared readiness timer");
  h.proc.stdout.emit("data", Buffer.from("Command Center running at http://127.0.0.1:51234\n"));
  await within(started, "started");
  assert.ok(ready >= SWEEP_CAP_MS + 15_000, `READY_TIMEOUT_MS ${ready} must be at least SWEEP_CAP_MS ${SWEEP_CAP_MS} + 15000`);
});

test("the start-up sweep says when its cap won, and what it stopped", () => {
  assert.deepEqual(describeStartupSweep({ killed: 4, finished: true }, 41_000, 2), ["[cleanup] stopped 2 processes left by an earlier server"]);
  assert.deepEqual(describeStartupSweep({ killed: 2, finished: true }, 41_000, 2), []);
  assert.deepEqual(describeStartupSweep({ killed: 0, finished: true }, 41_000), []);
  assert.deepEqual(describeStartupSweep({ killed: 2, finished: true }, 41_000), ["[cleanup] stopped 2 processes left by an earlier server"]);
  assert.deepEqual(describeStartupSweep({ killed: 0, finished: false }, 41_000), ["[cleanup] the check for processes left by an earlier server did not finish within 41 s; the server starts now and finishes it in the background"]);
});
