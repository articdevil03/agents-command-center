import { createHash } from "node:crypto";
import { open, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { externalNpm, InstallFailure } from "../cli-installers.ts";
import { windowsSystem32 } from "../../leader-common/cli-path.ts";
import { parseVersion } from "../parse.ts";
import type { CliResult, InstallTransaction, OpenCodeInstallOptions, RunCli } from "../types.ts";
import { assertNoLinks, createCandidate, publishCandidate, removeCandidate } from "./paths.ts";
import { defaultTransport, DOWNLOAD_LIMIT, operationSignal, ReleaseFailure, request, selectRelease } from "./releases.ts";
import { extractExecutable } from "./archive.ts";

export async function installOpenCode(run: RunCli, env: NodeJS.ProcessEnv, abort: AbortSignal, deadline: number,
  options: OpenCodeInstallOptions = {}): Promise<InstallTransaction> {
  const signal = operationSignal(abort, deadline), transport = options.transport ?? defaultTransport(env);
  let candidate: Awaited<ReturnType<typeof createCandidate>> | undefined;
  let processResult: CliResult | undefined;
  let undo: (() => Promise<void>) | undefined;
  const rollback = async () => {
    // Restore our publication if activation failed after the atomic rename.
    if (undo) { await undo(); undo = undefined; }
    if (candidate) await removeCandidate(candidate.dir);
  };
  const failure = async (reason: "cancelled" | "timeout" | "installFailed" | "cleanupUnconfirmed"): Promise<InstallTransaction> => {
    let cleaned = !processResult || processResult.cleanupConfirmed === true;
    if (cleaned) try { await rollback(); } catch { cleaned = false; }
    return { result: { code: reason === "timeout" ? 124 : -1, stdout: "", stderr: "", cancelled: abort.aborted,
      cleanupConfirmed: cleaned, retryCleanup: async () => {
        if (processResult && processResult.cleanupConfirmed !== true && !await processResult.retryCleanup?.()) return false;
        try { await rollback(); return true; } catch { return false; }
      } } };
  };
  try {
    options.phase?.("Checking OpenCode 1 releases");
    const release = await selectRelease(transport, signal, options.arch ?? process.arch);
    candidate = await createCandidate(env);
    signal.throwIfAborted();
    const zip = join(candidate.dir, "download.zip");
    let executable: string;
    try {
      options.phase?.("Downloading OpenCode 1…");
      const response = await request(transport, release.url, signal);
      const file = await open(zip, "wx");
      let count = 0; const hash = createHash("sha256");
      const reader = response.body!.getReader();
      try {
        for (;;) {
          let read: ReadableStreamReadResult<Uint8Array>;
          try { read = await reader.read(); }
          catch { signal.throwIfAborted(); throw new ReleaseFailure(true); }
          if (read.done) break;
          const chunk = read.value;
          signal.throwIfAborted(); count += chunk.length;
          if (count > DOWNLOAD_LIMIT || count > release.size) throw new ReleaseFailure();
          hash.update(chunk); await file.writeFile(chunk);
        }
      } finally { await reader.cancel().catch(() => {}); await file.close(); }
      options.phase?.("Checking the download…");
      if (count !== release.size || hash.digest("hex") !== release.hash) throw new ReleaseFailure();
      executable = await extractExecutable(zip, candidate.dir, signal);
      await unlink(zip);
    } catch (error) {
      // Only a transfer transport failure with selected, valid metadata can use
      // npm. Integrity, archive, version, cancellation and deadline failures cannot.
      if (!(error instanceof ReleaseFailure) || !error.transport) throw error;
      signal.throwIfAborted();
      await unlink(zip).catch((error) => { if (error.code !== "ENOENT") throw error; });
      const { node, npm } = externalNpm(env);
      const runOwned = async (bin: string, args: string[]) => {
        signal.throwIfAborted();
        processResult = await run(bin, args, { timeoutMs: Math.max(1, deadline - Date.now()), cwd: windowsSystem32(), env: { OPENCODE_DISABLE_AUTOUPDATE: "1" }, installer: { signal } });
        if (processResult.cleanupConfirmed !== true) throw new InstallFailure("cleanupUnconfirmed");
        signal.throwIfAborted();
        if (processResult.code !== 0) throw new InstallFailure("installFailed");
        return processResult;
      };
      const nodeProbe = await runOwned(node, ["--version"]);
      if (!/^v\d+\.\d+\.\d+\s*$/.test(nodeProbe.stdout)) throw new InstallFailure("needsNode");
      const npmProbe = await runOwned(node, [npm, "--version"]);
      if (!/^\d+\.\d+\.\d+\s*$/.test(npmProbe.stdout)) throw new InstallFailure("needsNode");
      options.phase?.("Trying another install method…");
      const prefix = join(candidate.dir, "npm");
      await runOwned(node, [npm, "install", "--global", "--prefix", prefix, `opencode-ai@${release.version}`, "--registry=https://registry.npmjs.org"]);
      executable = join(prefix, "opencode.cmd");
    }
    options.phase?.("Checking OpenCode 1…");
    signal.throwIfAborted();
    assertNoLinks(executable);
    if (!(await lstat(executable)).isFile()) throw new ReleaseFailure();
    processResult = await run(executable, ["--version"], { timeoutMs: Math.max(1, deadline - Date.now()), cwd: windowsSystem32(), env: { OPENCODE_DISABLE_AUTOUPDATE: "1" }, installer: { signal } });
    if (processResult.cleanupConfirmed !== true) throw new InstallFailure("cleanupUnconfirmed");
    signal.throwIfAborted();
    const version = processResult.code === 0 ? parseVersion(processResult.stdout || processResult.stderr) : null;
    if (!version || !/^1\.\d+\.\d+$/.test(version)) throw new ReleaseFailure();
    return { result: processResult, candidate: executable, rollback, commit: async () => {
      signal.throwIfAborted();
      undo = await publishCandidate(candidate!.root, executable, version);
    } };
  } catch {
    return failure(abort.aborted ? "cancelled" : signal.aborted || processResult?.code === 124 ? "timeout" : "installFailed");
  }
}
