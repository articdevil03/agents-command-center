import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setGitProcessBoundaryForTests } from "../server/fixed-crew/git-process.ts";
import { createTreeTracker } from "../server/leader-common/process-tree.ts";

if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Run 2 preload requires fake CLI authorization.");
if (process.env.CC_DATA_DIR) {
const base = join(process.env.CC_DATA_DIR!, "..");
const children = new Map<number, { child: ReturnType<typeof spawn>; at: number }>();
const tracker = createTreeTracker({
  list: async () => [...children].filter(([, { child }]) => child.exitCode === null && child.signalCode === null)
    .map(([pid, { at }]) => ({ pid, ppid: process.pid, created: at })),
  kill: async (pid) => {
    const entry = children.get(pid);
    if (!entry) throw new Error("Refusing to kill an unowned Git fixture PID.");
    entry.child.kill();
    await new Promise<void>((done) => { if (entry.child.exitCode !== null || entry.child.signalCode !== null) done(); else entry.child.once("exit", () => done()); });
    return true;
  },
});
const settings = () => { try { return JSON.parse(readFileSync(join(base, "git-process-options.json"), "utf8")); } catch { return {}; } };
process.on("exit", (code) => {
  const rows = (name: string) => existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  console.log(`P26R2_OWNERSHIP ${JSON.stringify({ temp: base, serverPid: process.pid, code,
    evidence: "owned ChildProcess closes; Git creation timestamps are injected, not native Windows proof",
    children: rows("children.jsonl"), git: rows("git-owned.jsonl") })}`);
});
setGitProcessBoundaryForTests({
  spawn(program, args, options) {
    appendFileSync(join(base, "git-spawn.jsonl"), JSON.stringify({ program, args, cwd: options.cwd, shell: options.shell,
      stdio: options.stdio, windowsHide: options.windowsHide, privateEnv: ["CC_DATA_DIR", "CC_APP_KEY", "OPENCODE_SERVER_PASSWORD"].filter((key) => options.env?.[key]) }) + "\n");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./pack26-review1-run2-git-fixture.cjs", import.meta.url)), base, ...args], { ...options, env: { ...options.env, NODE_OPTIONS: "" } });
    if (child.pid) {
      const at = Date.now(); children.set(child.pid, { child, at });
      appendFileSync(join(base, "git-owned.jsonl"), JSON.stringify({ event: "start", pid: child.pid, created: at }) + "\n");
      child.once("close", () => { appendFileSync(join(base, "git-owned.jsonl"), JSON.stringify({ event: "close", pid: child.pid, created: at }) + "\n"); });
    }
    return child;
  },
  watch: (pid, at) => {
    const watched = tracker.watch(pid, at);
    return { ...watched, sweep: async (endedAt, strict) => {
      const config = settings();
      if (config.unknownAfterAdd && existsSync(join(base, "work", "owned.txt")) && readFileSync(join(base, "work", "owned.txt"), "utf8") === "AFTER!") return null;
      if (config.cleanupHold) {
        appendFileSync(join(base, "git-cleanup-held"), "held\n");
        await new Promise<void>((done) => { const timer = setInterval(() => { if (existsSync(join(base, "git-cleanup-release"))) { clearInterval(timer); done(); } }, 10); });
      }
      return watched.sweep(endedAt, strict);
    } };
  },
});
}
