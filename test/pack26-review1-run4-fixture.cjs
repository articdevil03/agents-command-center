const fs = require("node:fs"), path = require("node:path");
const root = process.argv[2];
fs.writeFileSync(path.join(root, "run4-native-hook.json"), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 20000;
while (!fs.existsSync(path.join(root, "run4-native-release")) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 25);
if (!fs.existsSync(path.join(root, "run4-native-release"))) {
  process.stderr.write("Run 4 native hook was never released\n"); process.exitCode = 2;
}
