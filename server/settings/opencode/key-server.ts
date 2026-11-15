import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { trackLeaderChild } from "../../leader-common.ts";
import { KILL_CONFIRM_MS } from "../../leader-common/types.ts";
import { resolveCliOrThrow, windowsSystem32 } from "../../leader-common/cli-path.ts";
import { cmdQuote, installerTree, posixCli } from "../cli-runner.ts";
import { loginEnv } from "../cli-login-runner.ts";

export type KeyServerDeps = { spawn?: typeof spawn; tree?: typeof installerTree };
export function startKeyServer(env: NodeJS.ProcessEnv, signal: AbortSignal, deps: KeyServerDeps = {}) {
  if (!deps.spawn && (env.CC_TEST_FAKE_CLI === "1" || process.env.CC_TEST_FAKE_CLI === "1")) throw new Error("launchFailed");
  if (signal.aborted) throw new Error("cancelled");
  const password = randomBytes(24).toString("hex");
  const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const childEnv = { ...loginEnv(env), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password };
  const program = process.platform === "win32" ? resolveCliOrThrow("opencode", childEnv, process.cwd(), true) : posixCli("opencode", childEnv);
  if (!program) throw new Error("launchFailed");
  const shim = /\.(cmd|bat)$/i.test(program);
  if ((shim ? /["!%\r\n\0]/ : /["\r\n\0]/).test(program)) throw new Error("launchFailed");
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
  let child: ChildProcess;
  try {
    child = (deps.spawn ?? spawn)(shim ? join(windowsSystem32(), "cmd.exe") : program,
      shim ? ["/d", "/s", "/c", '"' + [program, ...args].map(cmdQuote).join(" ") + '"'] : args,
      { shell: false, windowsHide: true, detached: false, windowsVerbatimArguments: shim,
        cwd: process.platform === "win32" ? windowsSystem32() : "/", env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error("launchFailed"); }
  trackLeaderChild(child);
  let tree: ReturnType<typeof installerTree> | null = null;
  try { if (child.pid) tree = (deps.tree ?? installerTree)(child.pid, childEnv); } catch { /* retain ownership and report unconfirmed cleanup below */ }
  let closed = false, endedAt: number | undefined, ready = false, bytes = 0, tail = "";
  let fail!: (error: Error) => void;
  const decoder = new StringDecoder("utf8");
  const origin = new Promise<string>((resolve, reject) => {
    fail = reject;
    const output = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { reject(new Error("outputLimit")); return; }
      if (ready) return; // Drain, but never retain vendor text or a key echo.
      tail += decoder.write(chunk);
      let end: number;
      while ((end = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, end).replace(/\r$/, ""); tail = tail.slice(end + 1);
        const match = /^(?:opencode server )?listening on http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(line);
        if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) {
          ready = true; tail = ""; resolve("http://127.0.0.1:" + Number(match[1])); return;
        }
      }
      if (Buffer.byteLength(tail) > 8192) { tail = ""; reject(new Error("unsafeOutput")); }
    };
    child.stdout?.on("data", output); child.stderr?.on("data", output);
  });
  // A process can fail before its caller reaches the await.
  void origin.catch(() => {});
  child.once("exit", () => { endedAt = Date.now(); fail(new Error("launchFailed")); });
  child.once("close", () => { closed = true; endedAt ??= Date.now(); fail(new Error("launchFailed")); });
  child.once("error", () => { if (!child.pid) closed = true; fail(new Error("launchFailed")); });
  const abort = () => fail(new Error("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const stop = async (): Promise<boolean> => {
    signal.removeEventListener("abort", abort); tail = "";
    if (!child.pid) return closed;
    if (!tree) return false;
    try {
      const swept = await tree!.sweep(endedAt, true);
      if (swept === null || tree!.failed !== 0) return false;
      if (!closed) await new Promise<void>((done) => {
        const finish = () => { clearTimeout(timer); child.off("close", finish); done(); };
        const timer = setTimeout(finish, KILL_CONFIRM_MS); child.once("close", finish);
      });
      return closed;
    } catch { return false; }
  };
  return { origin, authorization, stop };
}
