import { startKeyServer, type KeyServerDeps } from "./key-server.ts";
import { hasCredentialOverride } from "./credentials.ts";
import { openCodeCredentialSource } from "../cli-auth.ts";
import { parseVersion } from "../parse.ts";
import type { KeyRunOptions, KeyRunResult, RunCli, RunKey } from "../types.ts";

export function validApiKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
export async function checkKeyCredentials(run: RunCli, env: NodeJS.ProcessEnv, replace: boolean, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) throw new Error("cancelled");
  const version = await run("opencode", ["--version"], { timeoutMs, directExecutable: true, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  if (version.code !== 0 || !/^1\./.test(parseVersion(version.stdout || version.stderr) ?? "")) throw new Error("unsupportedVersion");
  if (signal.aborted) throw new Error("cancelled");
  if (hasCredentialOverride(env)) throw new Error("environmentCredentials");
  const auth = await run("opencode", ["auth", "list"], { timeoutMs, directExecutable: true, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  const source = openCodeCredentialSource(auth);
  if (source === "environment") throw new Error("environmentCredentials");
  if (source === "unknown") throw new Error("credentialUnknown");
  if (!replace && source === "stored") throw new Error("existingCredentials");
  if (signal.aborted) throw new Error("cancelled");
}

type KeyDeps = KeyServerDeps & { run: RunCli; fetch?: typeof fetch };
export function createKeyRunner(deps: KeyDeps): RunKey {
  return async (options: KeyRunOptions): Promise<KeyRunResult> => {
    let server: ReturnType<typeof startKeyServer> | undefined, persisted = false, saved = false, reason = "keyFailed";
    const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs));
    const signal = AbortSignal.any([options.signal, deadline]);
    const remaining = () => Math.max(1, Math.min(10_000, options.timeoutMs - (Date.now() - started)));
    const started = Date.now();
    try {
      if (!validApiKey(options.apiKey)) throw new Error("invalidKey");
      await checkKeyCredentials(deps.run, options.env, options.replace, signal, remaining());
      server = startKeyServer(options.env, signal, deps);
      const origin = await server.origin;
      const request = async (method: string, route: string, body?: unknown, authenticated = true) => {
        signal.throwIfAborted();
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining())]);
        if (method === "PUT" && authenticated) { persisted = true; options.onWriteAttempt?.(); }
        const response = await (deps.fetch ?? fetch)(origin + route, {
          method, redirect: "manual", signal: requestSignal,
          headers: { "content-type": "application/json", ...(authenticated ? { authorization: server!.authorization } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.redirected || (response.url && response.url !== origin + route) || (response.status >= 300 && response.status < 400)) throw new Error("keyFailed");
        let bytes = 0, text = "";
        if (response.body) {
          const reader = response.body.getReader(), decoder = new TextDecoder();
          try {
            for (;;) {
              requestSignal.throwIfAborted();
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.length;
              if (bytes > 1024 * 1024) throw new Error("keyFailed");
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        return { status: response.status, ok: response.ok, json: () => JSON.parse(text) };
      };
      const health = await request("GET", "/global/health");
      const data = health.json();
      if (!health.ok || data?.healthy !== true || typeof data.version !== "string" || !/^1\.\d+\.\d+(?:$|[-+])/.test(data.version)) throw new Error("unsupportedVersion");
      const denied = await request("PUT", "/auth/opencode-go", {}, false);
      if (denied.status !== 401) throw new Error("keyFailed");
      // A credential may have appeared while the user was copying the key or the server was starting.
      await checkKeyCredentials(deps.run, options.env, options.replace, signal, remaining());
      const put = await request("PUT", "/auth/opencode-go", { type: "api", key: options.apiKey });
      if (!put.ok || put.json() !== true) throw new Error("keyFailed");
      const providers = await request("GET", "/provider");
      if (!providers.ok || !Array.isArray(providers.json()?.connected) || !providers.json().connected.includes("opencode-go")) throw new Error("keyFailed");
      const disposed = await request("POST", "/instance/dispose");
      if (!disposed.ok || disposed.json() !== true) throw new Error("keyFailed");
      signal.throwIfAborted();
      saved = true;
    } catch (error) {
      const message = (error as Error)?.message;
      if (["unsupportedVersion", "environmentCredentials", "credentialUnknown", "existingCredentials", "invalidKey", "launchFailed"].includes(message)) reason = message;
      else if (signal.aborted) reason = options.signal.aborted ? "cancelled" : "timeout";
    } finally { options.apiKey = ""; }
    const cleanupConfirmed = server ? await server.stop() : true;
    if (signal.aborted) saved = false;
    return { saved: saved && cleanupConfirmed, persisted, cleanupConfirmed, retryCleanup: server?.stop, reason } as KeyRunResult;
  };
}
