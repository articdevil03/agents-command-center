// Preloaded into every test file process by the test script (`node --import ./test/crash-catcher-self.ts --test ...`), and imported by temp-root.ts
// for single-file runs that go through the shared helpers. Attaching twice to one pid is a no-op.
import { basename } from "node:path";
import { attachCrashCatcher } from "./crash-catcher.ts";

attachCrashCatcher(process.pid, `test-file:${basename(process.argv[1] ?? "")}`);
