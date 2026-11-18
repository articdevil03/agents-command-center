import { isSafeRequestId } from "../chat-store.ts";
import { refreshProcessPath } from "../leader-common/path-refresh.ts";
import { windowsSystem32 } from "../leader-common/cli-path.ts";
import { catalogTool } from "./cli-catalog-validation.ts";
import { detectCatalogTool } from "./cli-auth.ts";
import { checkInstallPrerequisites, InstallFailure, INSTALL_MESSAGES, INSTALL_TIMEOUT_MS, runInstallRecipe } from "./cli-installers.ts";
import type { ActionState, CliId, CliResult, RunCli, SettingsState } from "./types.ts";
import type { OpenCodeInstallOptions, InstallTransaction } from "./types.ts";
import { installManagedRelease } from "./opencode/install.ts";
import { RELEASE_TOOLS } from "./opencode/release-tools.ts";
import { sweepManagedInstalls, SWEEP_WARNING } from "./opencode/sweep.ts";
import { RATE_LIMIT_MESSAGE } from "./opencode/releases.ts";
import { managedCli } from "./opencode/paths.ts";
import { removeManagedInstall } from "./opencode/remove.ts";

export function validateRemoveRequest(message: unknown): asserts message is Record<string, any> {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid removal request.");
  const value = message as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["type", "requestId", "cli", "confirm"].includes(key))
    || value.type !== "removeCliInstall" || !isSafeRequestId(value.requestId)
    || !["opencode", "copilot"].includes(value.cli as string)) throw new Error("This tool has no managed removal.");
  if (true !== value.confirm) throw new Error("Removal confirmation is required.");
}

export function validateInstallRequest(message: unknown, cancel = false): asserts message is Record<string, any> {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid install request");
  const value = message as Record<string, unknown>;
  const fields = cancel ? ["type", "requestId", "cli", "installRequestId"] : ["type", "requestId", "cli", "confirm"];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unexpected install request field");
  if (value.type !== (cancel ? "cancelCliInstall" : "installCli") || !isSafeRequestId(value.requestId)) throw new Error("Invalid install request");
  catalogTool(value.cli);
  if (cancel ? !isSafeRequestId(value.installRequestId) : value.confirm !== true) throw new Error(cancel ? "Invalid install request id" : "install confirmation is required");
}
type Operation = { removing?: boolean; id: string; requestId: string; abort: AbortController; done: Promise<void>; result?: CliResult };
type InstallerDeps = { state: SettingsState; run: RunCli; env: NodeJS.ProcessEnv; publish: () => void;
  refreshModels?: () => Promise<void>; refreshPath?: () => Promise<unknown>; admission?: () => boolean; installOptions?: OpenCodeInstallOptions };

export class CliInstaller {
  private active: Operation | null = null;
  private closed = false;
  private readonly refresh: () => Promise<unknown>;
  private readonly deps: InstallerDeps;
  constructor(deps: InstallerDeps) {
    this.deps = deps;
    this.refresh = deps.refreshPath ?? (() => refreshProcessPath({ env: deps.env }));
  }
  get busy(): boolean { return this.active !== null; }
  owns(id: string): boolean { return this.active?.id === id; }
  close(): void { this.closed = true; this.active?.abort.abort(); }
  private update(op: Operation, action: ActionState): void {
    this.deps.state.catalogTools[op.id].action = action;
    if (Object.hasOwn(this.deps.state.tools, op.id)) this.deps.state.tools[op.id as CliId].action = action;
    this.deps.publish();
  }
  private phase(op: Operation, phase: "checking" | "installing" | "verifying" | "cancelling"): void {
    this.update(op, { requestId: op.requestId, kind: "install", status: "running", phase, reason: null,
      message: { checking: "Checking installation", installing: "Downloading and installing", verifying: "Looking for the tool", cancelling: "Stopping installation" }[phase] });
  }
  install(message: unknown): Promise<void> {
    validateInstallRequest(message);
    if (this.closed || this.deps.admission?.() === false) return Promise.reject(new Error("Installation is blocked while shutdown or orphan cleanup is incomplete"));
    if (this.active) return Promise.reject(new Error("Another installation is still active"));
    const op: Operation = { id: message.cli, requestId: message.requestId, abort: new AbortController(), done: Promise.resolve() };
    this.active = op; // Admission is synchronous, before preflight or PATH refresh.
    this.phase(op, "checking");
    op.done = this.execute(op);
    return op.done;
  }
  remove(message: unknown, inUse: () => boolean): Promise<void> {
    validateRemoveRequest(message);
    if (this.active || this.deps.admission?.() === false || this.closed) return Promise.reject(new Error("Another installation or removal is running."));
    if (inUse()) return Promise.reject(new Error("Stop the chats and seats that use it first, then try again."));
    const op: Operation = { id: message.cli, requestId: message.requestId, abort: new AbortController(), done: Promise.resolve() };
    this.active = op;
    op.removing = true;
    this.update(op, { requestId: op.requestId, kind: "remove", status: "running", message: "Removing..." });
    op.done = (async () => {
      let failure: string | undefined;
      try { await removeManagedInstall(this.deps.env, op.id as "opencode" | "copilot"); }
      catch (error) {
        failure = error instanceof Error && ["Nothing installed by Command Center to remove.", "Some files could not be removed. Close programs that use them and try again."].includes(error.message)
          ? error.message : "Could not remove this installation safely.";
      }
      try { await detectCatalogTool(op.id, this.deps.state, this.deps.run, this.deps.env); }
      catch { failure ??= "Could not check the installation after removal. Check again."; }
      finally {
        if (this.active === op) this.active = null;
        this.update(op, { requestId: op.requestId, kind: "remove", status: failure ? "failed" : "done", message: failure ?? "Removed" });
      }
      if (failure) throw new Error(failure);
    })();
    return op.done;
  }
  private async execute(op: Operation): Promise<void> {
    let cleanupConfirmed = true;
    let sweepIncomplete = false;
    let transaction: InstallTransaction | undefined;
    let previousFacts: Pick<import("./types.ts").InstalledTool, "installed" | "version" | "signedIn" | "supportedVersion" | "credentialSource"> | undefined;
    try {
      const deadline = Date.now() + (op.id === "copilot" ? RELEASE_TOOLS.copilot.timeoutMs : INSTALL_TIMEOUT_MS);
      if (op.id === "copilot" || op.id === "opencode") {
        sweepIncomplete = await sweepManagedInstalls(this.deps.env, op.id);
        if (sweepIncomplete) this.update(op, { requestId: op.requestId, kind: "install", status: "running", phase: "checking", message: SWEEP_WARNING });
      }
      await this.refresh();
      await detectCatalogTool(op.id, this.deps.state, this.deps.run, this.deps.env);
      const facts = this.deps.state.catalogTools[op.id];
      previousFacts = { installed: facts.installed, version: facts.version, signedIn: facts.signedIn, supportedVersion: facts.supportedVersion, credentialSource: facts.credentialSource };
      const installed = this.deps.state.catalogTools[op.id].installed;
      const unsupported = op.id === "opencode" && installed === true && this.deps.state.catalogTools[op.id].supportedVersion === false;
      if (installed === true && !unsupported) throw new Error("CLI is already installed");
      if (installed !== false && !unsupported) throw new Error("CLI installation status is unknown");
      const entry = catalogTool(op.id);
      await checkInstallPrerequisites(entry, this.deps.run, this.deps.env);
      if (op.abort.signal.aborted) throw new InstallFailure("cancelled");
      this.phase(op, "installing");
      transaction = op.id === "opencode" || op.id === "copilot" ? await installManagedRelease(this.deps.run, this.deps.env, op.abort.signal, deadline, {
        ...this.deps.installOptions, phase: (message) => {
          this.deps.installOptions?.phase?.(message);
          this.update(op, { requestId: op.requestId, kind: "install", status: "running", phase: "installing", reason: null, message });
        },
      }, op.id) : undefined;
      const result = transaction ? transaction.result : await runInstallRecipe(entry.recipe!, this.deps.run, this.deps.env, op.abort.signal, this.refresh, deadline);
      op.result = result;
      cleanupConfirmed = result.cleanupConfirmed === true;
      if (!cleanupConfirmed) throw new InstallFailure("cleanupUnconfirmed");
      this.phase(op, op.abort.signal.aborted ? "cancelling" : "verifying");
      await this.refresh();
      await detectCatalogTool(op.id, this.deps.state, transaction?.candidate ? async (bin, args, options) => {
        if (op.id === "copilot") return transaction!.result; // Reuse the isolated, exact-version candidate probe.
        const checked = await this.deps.run(bin === op.id ? transaction!.candidate! : bin, args,
          // The tracked installer runner refuses a run without a working folder, which read as "not found".
          { ...options, cwd: process.platform === "win32" ? windowsSystem32() : "/", installer: { signal: op.abort.signal }, timeoutMs: Math.max(1, deadline - Date.now()) });
        op.result = checked;
        if (checked.cleanupConfirmed !== true) { cleanupConfirmed = false; throw new InstallFailure("cleanupUnconfirmed"); }
        return checked;
      } : this.deps.run, this.deps.env);
      if (op.abort.signal.aborted || result.cancelled) throw new InstallFailure("cancelled");
      if (result.code === 124) throw new InstallFailure("timeout");
      if (result.code !== 0) throw new InstallFailure("installFailed");
      if (this.deps.state.catalogTools[op.id].installed !== true) throw new InstallFailure("notFoundAfterInstall");
      if (transaction) {
        if (this.deps.state.catalogTools[op.id].supportedVersion !== true) throw new InstallFailure("notFoundAfterInstall");
        if (Date.now() >= deadline) throw new InstallFailure("timeout");
        await transaction.commit?.();
        if (op.abort.signal.aborted) throw new InstallFailure("cancelled");
        if (managedCli(this.deps.env, op.id as "opencode" | "copilot") !== transaction.candidate) throw new InstallFailure("notFoundAfterInstall");
        this.deps.state.catalogTools[op.id].managedInstall = true;
        sweepIncomplete = await sweepManagedInstalls(this.deps.env, op.id as "opencode" | "copilot");
      }
      this.update(op, { requestId: op.requestId, kind: "install", status: "done", phase: null, reason: null, message: sweepIncomplete ? `Installed. ${SWEEP_WARNING}` : "Installed" });
      if (op.id === "opencode") await this.deps.refreshModels?.().catch(() => {});
    } catch (error) {
      if (cleanupConfirmed) try { await transaction?.rollback?.(); } catch {
        cleanupConfirmed = false;
        if (op.result) op.result.retryCleanup = async () => { try { await transaction?.rollback?.(); return true; } catch { return false; } };
      }
      if (!cleanupConfirmed && transaction?.rollback && op.result) {
        const retry = op.result.retryCleanup;
        op.result.retryCleanup = async () => { if (!await retry?.()) return false; await transaction!.rollback!(); return true; };
      }
      const interrupted = error instanceof InstallFailure && (error.reason === "cancelled" || error.reason === "timeout");
      const reason = !cleanupConfirmed ? "cleanupUnconfirmed" : interrupted ? error.reason : transaction?.failureReason ?? (error instanceof InstallFailure ? error.reason : "installFailed");
      if ((op.id === "opencode" || op.id === "copilot") && previousFacts) {
        const facts = cleanupConfirmed ? previousFacts : { installed: null, version: null, signedIn: null, supportedVersion: null, credentialSource: "unknown" };
        Object.assign(this.deps.state.catalogTools[op.id], facts);
        if (op.id === "opencode") Object.assign(this.deps.state.tools.opencode, facts);
      }
      // Only known preflight messages are retained. No exception/vendor text crosses state.
      const message = reason === "rateLimited" ? RATE_LIMIT_MESSAGE : error instanceof Error && ["CLI is already installed", "CLI installation status is unknown"].includes(error.message) ? error.message : INSTALL_MESSAGES[reason];
      this.update(op, { requestId: op.requestId, kind: "install", status: "failed", phase: null, reason, message });
      throw new Error(message);
    } finally {
      if (cleanupConfirmed && this.active === op) this.active = null;
      this.deps.publish();
    }
  }
  async cancel(message: unknown): Promise<void> {
    validateInstallRequest(message, true);
    const op = this.active;
    if (!op || op.removing || op.id !== message.cli || op.requestId !== message.installRequestId) throw new Error("No matching active installation");
    this.phase(op, "cancelling");
    op.abort.abort();
    await op.done.catch(() => {});
    if (this.active === op) {
      const confirmed = await op.result?.retryCleanup?.();
      if (!confirmed) {
        this.update(op, { requestId: op.requestId, kind: "install", status: "failed", phase: null, reason: "cleanupUnconfirmed", message: INSTALL_MESSAGES.cleanupUnconfirmed });
        throw new InstallFailure("cleanupUnconfirmed");
      }
      await this.refresh();
      await detectCatalogTool(op.id, this.deps.state, this.deps.run, this.deps.env);
      this.active = null;
      this.update(op, { requestId: op.requestId, kind: "install", status: "failed", phase: null, reason: "cancelled", message: INSTALL_MESSAGES.cancelled });
    }
  }
  async drain(): Promise<boolean> {
    this.close();
    const op = this.active;
    if (!op) return true;
    if (op.removing) { await op.done.catch(() => {}); return !this.busy; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.cancel({ type: "cancelCliInstall", requestId: "shutdown", cli: op.id, installRequestId: op.requestId }).then(() => !this.busy, () => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 110_000); })]);
    } finally { clearTimeout(timer); }
  }
}
