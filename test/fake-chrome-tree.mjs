// A stand-in for a Chrome that never ends, for test/browser-guards.test.ts: it starts one helper process (as Chrome starts renderers) and waits for ever.
// The helper's command line carries the marker (argv[2]) and its pid goes to the file (argv[3]), so a test finds that helper and nothing else.
// detached: Node on Windows otherwise puts a child in a job object that dies with its parent, which real Chrome helpers are not in.
// A kill of this process alone leaves the helper running; only a kill of the whole tree ends it.
// argv[4] (ms, optional): wait that long before starting the helper, so a test can tell a cap armed at spawn from one armed at the helper's start.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [marker, pidFile, delayMs] = process.argv.slice(2);
setTimeout(() => {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore", windowsHide: true, detached: true });
  writeFileSync(pidFile, String(helper.pid));
}, Number(delayMs ?? 0));
setInterval(() => {}, 1000);
