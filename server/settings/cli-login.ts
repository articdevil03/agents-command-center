import { GITHUB_STATUS_ARGS } from "./github-login.ts";
import { parseGitHubAuthStatus } from "./parse.ts";
import { hasCredentialOverride } from "./opencode/credentials.ts";
import { checkKeyCredentials, normalizeApiKey } from "./opencode/key.ts";
import { randomBytes } from "node:crypto";
import { isSafeRequestId } from "../chat-store.ts";
import { refreshProcessPath } from "../leader-common/path-refresh.ts";
import { catalogTool } from "./cli-catalog-validation.ts";
import { catalogLoginStatus, detectCatalogTool } from "./cli-auth.ts";
import { LoginOutput } from "./cli-login-output.ts";
import { runLogin, type LoginChild, type RunLogin } from "./cli-login-runner.ts";
import { validLoginCode, validateLoginUrl, UNSUPPORTED_MESSAGE } from "./cli-login-policy.js";
import { AUTH_ARGS, CLI_TIMEOUT_MS } from "./constants.ts";
import type { CliId, CliResult, RunCli, RunKey, KeyRunResult, SettingsState } from "./types.ts";
export const LOGIN_MESSAGES = {
  githubMissing: "GitHub CLI is not installed on this PC.",
  unsupportedVersion: "OpenCode 1 is needed.", existingCredentials: "A credential is already saved.",
  environmentCredentials: "OpenCode is using credentials set outside Command Center. Remove that setting in Windows Settings before adding a key here.",
  credentialUnknown: "Could not check saved credentials.", invalidKey: "Enter an OpenCode Go API key.", keyFailed: "Could not save the key. Try again.",
  possiblySaved: "The key may have been saved. Check again.",
  unsupported: UNSUPPORTED_MESSAGE, notInstalled: "Install the tool first.", installationUnknown: "Could not confirm the installation.",
  busy: "Another installation or sign-in is running.", launchFailed: "Could not start sign-in.",
  unsafeOutput: "The tool returned unsupported sign-in information.", outputLimit: "The tool returned unsupported sign-in information.",
  browserUnavailable: "Could not open the browser. Copy the address below.", cancelled: "Sign-in stopped.", timeout: "Sign-in expired. Try again.",
  cleanupUnconfirmed: "Could not confirm sign-in stopped.", statusUnknown: "Sign-in command finished. Connection will be checked when you first chat.",
  notSignedIn: "Sign-in did not finish. Try again.", loginFailed: "Sign-in did not finish. Try again.",
};
export type LoginReason = keyof typeof LOGIN_MESSAGES;
export type LoginPhase = "starting" | "waitingKey" | "waitingBrowser" | "waitingCode" | "verifying" | null;
export type LoginEvent = { type: "cliLoginState"; cli: string; loginRequestId: string; loginId: string | null; revision: number;
  status: "running" | "done" | "failed"; phase: LoginPhase; reason: LoginReason | null;
  verificationUrl: string | null; deviceCode: string | null; pasteRequired: boolean; expiresAt: number | null; cleanupPending: boolean };
export type LoginSend = (event: LoginEvent) => void;
export function validateLoginRequest(message: unknown): asserts message is Record<string, any> {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid sign-in request.");
  const value = message as Record<string, unknown>;
  const extra = { cliLogin: [], replaceCliLogin: ["confirm"], submitCliLoginKey: ["loginId", "apiKey"], getCliLoginState: ["loginId"], openCliLogin: ["loginId"], submitCliLoginCode: ["loginId", "code"], cancelCliLogin: ["loginRequestId"] };
  if (typeof value.type !== "string" || !Object.hasOwn(extra, value.type)) throw new Error("Invalid sign-in request.");
  const fields = ["type", "requestId", "cli", ...extra[value.type as keyof typeof extra]];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) || Object.keys(value).some((field) => !fields.includes(field)) || !isSafeRequestId(value.requestId)) throw new Error("Invalid sign-in request.");
  if (value.cli !== "github") catalogTool(value.cli);
  if (["replaceCliLogin", "submitCliLoginKey"].includes(value.type) && value.cli !== "opencode") throw new Error("Invalid sign-in request.");
  if (value.type === "submitCliLoginCode" && ["opencode", "github"].includes(value.cli as string)) throw new Error("Invalid sign-in request.");
  if (value.type === "replaceCliLogin" && value.confirm !== true) throw new Error("Invalid sign-in request.");
  if (fields.includes("loginId") && (typeof value.loginId !== "string" || !/^[a-f0-9]{48}$/.test(value.loginId))) throw new Error("Sign-in is already running. Cancel to start again.");
  if (value.type === "cancelCliLogin" && !isSafeRequestId(value.loginRequestId)) throw new Error("Invalid sign-in request.");
}
const openerPending = new Map<string, (ok: boolean) => void>();
process.on("message", (message: any) => {
  if (message?.type === "cliLoginOpened" && typeof message.id === "string" && typeof message.ok === "boolean") openerPending.get(message.id)?.(message.ok);
});
export function openLoginBrowser(cli: string, url: string): Promise<boolean> {
  if (!validateLoginUrl(cli, url) || !process.send || !process.connected) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = randomBytes(24).toString("hex");
    const finish = (ok: boolean) => { clearTimeout(timer); openerPending.delete(id); resolve(ok); };
    const timer = setTimeout(() => finish(false), 5000);
    openerPending.set(id, finish);
    try { process.send!({ type: "openCliLogin", id, cli, url }, (error) => { if (error) finish(false); }); } catch { finish(false); }
  });
}
type Operation = { id: string; requestId: string; capability: string | null; send: LoginSend; event: LoginEvent; parser: LoginOutput;
  abort: AbortController; done: Promise<void>; child?: LoginChild; result?: CliResult; failure?: LoginReason;
  replace: boolean; keyWriteAttempt?: boolean; acceptKey?: (key: string) => void; keyResult?: KeyRunResult;
  attempts: number; lastAttempt: number; probeTimer?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout>; probe?: Promise<void>; positive: boolean };
type LoginDeps = { state: SettingsState; run: RunCli; env: NodeJS.ProcessEnv; publish: () => void; busy: () => boolean;
  refreshModels?: () => Promise<void>; admission?: () => boolean; refreshPath?: () => Promise<unknown>; runner?: RunLogin; runKey?: RunKey; probeMs?: number; timeoutMs?: number; open?: (cli: string, url: string) => Promise<boolean> };
export class CliLogin {
  private active: Operation | null = null;
  private closed = false;
  private deps: LoginDeps;
  private readonly state: SettingsState;
  constructor(deps: LoginDeps) { this.deps = deps; this.state = deps.state; }
  get busy(): boolean { return this.active !== null; }
  close(): void { this.closed = true; if (this.active) { this.active.failure ??= "cancelled"; this.clearPrivate(this.active); this.publish(this.active, null, (this.active.keyWriteAttempt || this.active.keyResult?.persisted) ? "possiblySaved" : "cancelled"); this.active.abort.abort(); } }
  private clearPrivate(op: Operation): void {
    op.capability = null; op.parser.clear();
    Object.assign(op.event, { loginId: null, verificationUrl: null, deviceCode: null, pasteRequired: false, expiresAt: null });
  }
  private publish(op: Operation, phase: LoginPhase, reason: LoginReason | null = null, status: LoginEvent["status"] = "running"): void {
    Object.assign(op.event, { revision: op.event.revision + 1, phase, reason, status });
    const action = { requestId: op.requestId, kind: "login" as const, phase, reason, status, cleanupPending: op.event.cleanupPending,
      message: reason ? LOGIN_MESSAGES[reason] : status === "done" ? op.id === "opencode" ? "Key saved. OpenCode will check it when you first chat." : "Signed in" : phase === "waitingKey" ? "Sign in with your OpenCode Go key" : op.id === "opencode" ? "Saving your key…" : phase === "waitingCode" ? "Paste the code from the website" : phase === "waitingBrowser" ? "Finish signing in in your browser" : "Signing in" };
    const cli = op.id;
    if (reason === "possiblySaved" && status === "failed" && !op.event.cleanupPending) action.message = "Sign-in stopped. The key may have been saved. Check again.";
    const target = cli === "github" ? this.state.github : this.state.catalogTools[cli];
    target.action = action;
    if (Object.hasOwn(this.state.tools, op.id)) this.state.tools[op.id as CliId].action = action;
    try { op.send({ ...op.event }); } catch { /* socket loss does not affect child ownership */ }
    this.deps.publish();
  }
  start(message: unknown, send: LoginSend = () => {}): Promise<void> {
    validateLoginRequest(message);
    if (!["cliLogin", "replaceCliLogin"].includes(message.type)) throw new Error("Invalid sign-in request.");
    if (this.closed || this.active || this.deps.busy() || this.deps.admission?.() === false) return Promise.reject(new Error(LOGIN_MESSAGES.busy));
    const capability = randomBytes(24).toString("hex");
    const op: Operation = { id: message.cli, requestId: message.requestId, capability, send, parser: new LoginOutput(message.cli), abort: new AbortController(),
      done: Promise.resolve(), replace: message.type === "replaceCliLogin", attempts: 0, lastAttempt: -Infinity, positive: false,
      event: { type: "cliLoginState", cli: message.cli, loginRequestId: message.requestId, loginId: capability, revision: 0, status: "running", phase: "starting", reason: null,
        verificationUrl: null, deviceCode: null, pasteRequired: false, cleanupPending: false, expiresAt: Date.now() + (this.deps.timeoutMs ?? 600_000) } };
    this.active = op; // Synchronous lock before the first await, shared with installer admission.
    this.publish(op, "starting");
    op.done = this.execute(op);
    return op.done;
  }
  private async execute(op: Operation): Promise<void> {
    let cleanupConfirmed = true;
    op.deadline = setTimeout(() => { op.failure = "timeout"; this.clearPrivate(op); this.publish(op, null, op.keyWriteAttempt ? "possiblySaved" : "timeout"); op.abort.abort(); }, this.deps.timeoutMs ?? 600_000);
    try {
      if (op.id === "github") {
        await (this.deps.refreshPath ?? (() => refreshProcessPath({ env: this.deps.env })))();
        const version = await this.deps.run("gh", ["--version"], { timeoutMs: CLI_TIMEOUT_MS, directExecutable: true });
        if (version.code !== 0) throw new Error("githubMissing");
      } else {
        const entry = catalogTool(op.id);
        if (op.id !== "opencode" && !entry.signIn.managed) throw new Error("unsupported");
        if (op.id !== "opencode" && this.state.catalogTools[op.id].signedIn === true) throw new Error("existingCredentials");
        if (op.id !== "opencode") {
          await (this.deps.refreshPath ?? (() => refreshProcessPath({ env: this.deps.env })))();
          await detectCatalogTool(op.id, this.state, (bin, args, options) => this.deps.run(bin, args, { ...options, directExecutable: true }));
          if (this.state.catalogTools[op.id].signedIn === true) throw new Error("existingCredentials");
        }
        const installed = this.state.catalogTools[op.id].installed;
        if (installed !== true) throw new Error(installed === false ? "notInstalled" : "installationUnknown");
      }
      if (op.abort.signal.aborted) throw new Error(op.failure ?? "cancelled");
      if (op.id === "opencode") {
        if (hasCredentialOverride(this.deps.env) && this.state.catalogTools.opencode.credentialSource !== "stored") {
          this.state.catalogTools.opencode.credentialSource = this.state.tools.opencode.credentialSource = "environment";
          this.state.catalogTools.opencode.signedIn = this.state.tools.opencode.signedIn = false;
        }
        const facts = this.state.catalogTools.opencode;
        if (facts.supportedVersion !== true) throw new Error("unsupportedVersion");
        if (hasCredentialOverride(this.deps.env) || facts.credentialSource === "environment") throw new Error("environmentCredentials");
        if (!facts.credentialSource || facts.credentialSource === "unknown") throw new Error("credentialUnknown");
        if (!op.replace && facts.credentialSource === "stored") throw new Error("existingCredentials");
        let accept!: (key: string) => void;
        const pending = new Promise<string>((resolve) => { accept = resolve; });
        op.acceptKey = accept;
        const abort = () => accept("");
        op.abort.signal.addEventListener("abort", abort, { once: true });
        op.event.verificationUrl = "https://opencode.ai/auth";
        this.publish(op, "waitingKey");
        if (op.abort.signal.aborted) abort();
        let apiKey = await pending;
        op.acceptKey = undefined;
        op.abort.signal.removeEventListener("abort", abort);
        if (op.abort.signal.aborted) throw new Error(op.failure ?? "cancelled");
        this.publish(op, "verifying");
        await (this.deps.refreshPath ?? (() => refreshProcessPath({ env: this.deps.env })))();
        await checkKeyCredentials(this.deps.run, this.deps.env, op.replace, op.abort.signal, CLI_TIMEOUT_MS);
        if (!this.deps.runKey) throw new Error("launchFailed");
        cleanupConfirmed = false;
        try {
          op.keyResult = await this.deps.runKey({ env: this.deps.env, signal: op.abort.signal,
            timeoutMs: Math.max(1, op.event.expiresAt! - Date.now()), apiKey, replace: op.replace, onWriteAttempt: () => { op.keyWriteAttempt = true; } });
        } finally { apiKey = ""; }
        cleanupConfirmed = op.keyResult.cleanupConfirmed === true;
        if (!cleanupConfirmed) throw new Error(op.keyResult.persisted ? "possiblySaved" : "cleanupUnconfirmed");
        if (!op.keyResult.saved || op.failure || op.abort.signal.aborted) throw new Error(op.keyResult.persisted ? "possiblySaved" : op.failure ?? (op.keyResult as any).reason ?? "keyFailed");
        this.state.catalogTools.opencode.credentialSource = this.state.tools.opencode.credentialSource = "stored";
        this.state.catalogTools.opencode.signedIn = this.state.tools.opencode.signedIn = true;
        this.clearPrivate(op); this.publish(op, null, null, "done");
        clearTimeout(op.deadline);
        await this.deps.refreshModels?.().catch(() => {});
        return;
      }
      op.child = (this.deps.runner ?? runLogin)({ cli: op.id, env: this.deps.env, signal: op.abort.signal,
        timeoutMs: Math.max(1, op.event.expiresAt! - Date.now()), output: (chunk, stream) => {
          if (op.abort.signal.aborted) return;
          try {
            const progress = op.parser.feed(chunk, stream);
            if (op.event.verificationUrl === progress.verificationUrl && op.event.deviceCode === progress.deviceCode && op.event.pasteRequired === progress.pasteRequired) return;
            Object.assign(op.event, progress);
            this.publish(op, progress.pasteRequired ? "waitingCode" : progress.verificationUrl ? "waitingBrowser" : "starting");
          } catch (error) { op.failure = (error as Error).message === "outputLimit" ? "outputLimit" : "unsafeOutput"; op.abort.abort(); }
        } });
      cleanupConfirmed = false;
      this.scheduleProbe(op);
      op.result = await op.child.done;
      clearTimeout(op.probeTimer);
      if (op.probe) await op.probe;
      cleanupConfirmed = op.result.cleanupConfirmed === true;
      if (!cleanupConfirmed) throw new Error("cleanupUnconfirmed");
      if (op.failure || op.result.cancelled) throw new Error(op.failure ?? "cancelled");
      if (op.result.code === 124) throw new Error("timeout");
      if (op.result.code !== 0) throw new Error(op.result.code === -1 ? "launchFailed" : "loginFailed");
      try { op.parser.flush(); } catch (error) { throw new Error((error as Error).message); }
      this.publish(op, "verifying");
      await this.probe(op);
      if (op.failure) throw new Error(op.failure);
      const reason = (op.id === "github" || AUTH_ARGS[op.id as CliId]) ? op.positive ? null : "notSignedIn" : "statusUnknown";
      if (reason === "notSignedIn") throw new Error(reason);
      this.clearPrivate(op); this.publish(op, null, reason, "done");
    } catch (error) {
      const key = (error as Error)?.message;
      const reason: LoginReason = op.keyWriteAttempt ? "possiblySaved" : Object.hasOwn(LOGIN_MESSAGES, key) ? key as LoginReason : "loginFailed";
      op.event.cleanupPending = !cleanupConfirmed;
      this.clearPrivate(op); this.publish(op, null, reason, "failed");
      throw new Error(LOGIN_MESSAGES[reason]);
    } finally {
      clearTimeout(op.deadline); clearTimeout(op.probeTimer);
      if (cleanupConfirmed && this.active === op) this.active = null;
      this.deps.publish();
    }
  }
  private async probe(op: Operation): Promise<void> {
    const args = op.id === "github" ? GITHUB_STATUS_ARGS : AUTH_ARGS[op.id as CliId];
    if (!args || op.abort.signal.aborted) return;
    if (op.id === "github" && (!op.result || op.result.code !== 0 || op.result.cleanupConfirmed !== true)) return;
    const result = await this.deps.run(op.id === "github" ? "gh" : catalogTool(op.id).detection!.program, args, { timeoutMs: CLI_TIMEOUT_MS, directExecutable: true })
      .catch((error) => { if (op.id !== "github") throw error; return { code: -1, stdout: "", stderr: "" }; });
    if (op.id === "github") {
      const parsed = parseGitHubAuthStatus(result, "settings");
      if (op.abort.signal.aborted) return;
      // Account names stay out of shared login state and persistence.
      this.state.github.connected = parsed.connected;
      this.state.github.account = null;
      op.positive = parsed.connected === true;
      this.deps.publish();
      return;
    }
    const signedIn = catalogLoginStatus(op.id, result);
    this.state.catalogTools[op.id].signedIn = signedIn;
    if (Object.hasOwn(this.state.tools, op.id)) this.state.tools[op.id as CliId].signedIn = signedIn;
    op.positive = signedIn === true;
    this.deps.publish();
  }
  private scheduleProbe(op: Operation): void {
    if (!AUTH_ARGS[op.id as CliId]) return;
    op.probeTimer = setTimeout(() => {
      if (op.result || op.abort.signal.aborted) return;
      op.probe = this.probe(op).catch(() => {});
      void op.probe.then(() => { if (!op.result && !op.abort.signal.aborted) this.scheduleProbe(op); });
    }, this.deps.probeMs ?? 3000);
  }
  private owned(message: any): Operation {
    const op = this.active;
    if (!op || op.id !== message.cli || !op.capability || op.capability !== message.loginId || op.event.status !== "running" || op.abort.signal.aborted) throw new Error("Sign-in is already running. Cancel to start again.");
    return op;
  }
  async request(message: unknown, send: LoginSend): Promise<void> {
    validateLoginRequest(message);
    if (message.type === "cliLogin" || message.type === "replaceCliLogin") return this.start(message, send);
    if (message.type === "cancelCliLogin") return this.cancel(message);
    const op = this.owned(message);
    if (message.type === "getCliLoginState") { op.send = send; send({ ...op.event }); return; }
    if (message.type === "openCliLogin") {
      if (op.id === "opencode" && op.event.phase !== "waitingKey") throw new Error("No sign-in address is available.");
      const url = op.event.verificationUrl;
      if (!url || !validateLoginUrl(op.id, url)) throw new Error("No sign-in address is available.");
      const ok = await (this.deps.open ?? openLoginBrowser)(op.id, url).catch(() => false);
      if (this.active === op && op.capability) this.publish(op, op.event.phase, ok ? null : "browserUnavailable");
      return;
    }
    if (message.type === "submitCliLoginKey") {
      let apiKey = message.apiKey;
      delete message.apiKey;
      try {
        const now = Date.now();
        if (op.attempts >= 5 || now - op.lastAttempt < 2000) throw new Error("Wait before submitting another key.");
        op.attempts++; op.lastAttempt = now;
        if (op.event.phase !== "waitingKey" || !op.acceptKey) throw new Error("Sign-in is not waiting for a key.");
        apiKey = normalizeApiKey(apiKey);
        const accept = op.acceptKey; op.acceptKey = undefined;
        this.publish(op, "verifying"); // Consume synchronously before the first await.
        accept(apiKey);
      } finally { apiKey = ""; }
      return op.done;
    }
    if (message.type === "submitCliLoginCode") {
      const now = Date.now();
      if (op.attempts >= 5 || now - op.lastAttempt < 2000) throw new Error("Wait before submitting another code.");
      op.attempts++; op.lastAttempt = now;
      if (!validLoginCode(message.code) || op.event.phase !== "waitingCode" || !op.event.pasteRequired || !op.child?.writable()) throw new Error("Sign-in is not waiting for a code.");
      op.parser.consumePaste(); op.event.pasteRequired = false;
      this.publish(op, "verifying"); // consume before writing, so concurrent submits cannot repeat it
      try { op.child.submit(message.code); } catch { op.failure = "loginFailed"; op.abort.abort(); throw new Error(LOGIN_MESSAGES.loginFailed); }
    }
  }
  async cancel(message: unknown): Promise<void> {
    validateLoginRequest(message);
    if (message.type !== "cancelCliLogin") throw new Error("Invalid sign-in request.");
    const op = this.active;
    if (!op || op.id !== message.cli || op.requestId !== message.loginRequestId) throw new Error("No matching active sign-in.");
    op.failure ??= "cancelled"; this.clearPrivate(op); this.publish(op, null, (op.keyWriteAttempt || op.keyResult?.persisted) ? "possiblySaved" : op.failure); op.abort.abort();
    await op.done.catch(() => {});
    if (this.active !== op) return;
    let cleaned = false;
    try { cleaned = await (op.keyResult?.retryCleanup ?? op.result?.retryCleanup)?.() === true; } catch { /* Retain ownership on cleanup failure. */ }
    op.event.cleanupPending = !cleaned;
    if (!cleaned) {
      this.publish(op, null, (op.keyWriteAttempt || op.keyResult?.persisted) ? "possiblySaved" : "cleanupUnconfirmed", "failed");
      throw new Error(LOGIN_MESSAGES.cleanupUnconfirmed);
    }
    this.active = null; this.publish(op, null, (op.keyWriteAttempt || op.keyResult?.persisted) ? "possiblySaved" : "cancelled", "failed");
  }
  async drain(): Promise<boolean> {
    this.close(); const op = this.active;
    if (!op) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.cancel({ type: "cancelCliLogin", requestId: "shutdown", cli: op.id, loginRequestId: op.requestId }).then(() => !this.busy, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 110_000); })]); }
    finally { clearTimeout(timer); }
  }
}
