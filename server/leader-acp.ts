import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { IMAGE_EXT_TO_MIME } from "./config.ts";
import {
  ACTIVITY, createActivityTracker, createParagraphs, deadline, killProcessTree, leaderChildEnv, leaderProcessState, spawnAcpChild, trackLeaderChild, watchesLeaderChild, LEADER_START_TIMEOUT_MS,
  type AcpSpawn, type ActivityStep, type LeaderCallbacks, type LeaderHandle, type LeaderSeat,
} from "./leader-common.ts";
import { permissionModeForSdk, type PermissionMode } from "./settings.ts";

// A leader for ANY CLI that speaks the Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0, one JSON object per line, over the CLI's stdin/stdout.
// One adapter, no per-CLI code. The CLI decides by itself whether it asks before editing (OpenCode, probed 2026-10-18, wrote a file without ever asking), so this
// leader runs in Full access only: every permission request the CLI does send is allowed once.
const KILL_GRACE_MS = 200;
const MAX_LINE = 8 * 1024 * 1024;
// JSON-RPC / ACP error code for "sign in first" (spec: auth_required); a CLI that uses another code is still caught by its message.
const AUTH_REQUIRED = -32000;
const AUTH_WORDS = /auth|sign.?in|log.?in|credential|unauthori[sz]ed|api.?key|token/i;

// The step line from the tool's KIND only (spec: read, edit, delete, move, search, execute, think, fetch, switch_mode, other), never its title, path, command or content.
const KIND_STEPS: Record<string, string> = {
  execute: ACTIVITY.command, read: ACTIVITY.read, search: ACTIVITY.search, edit: ACTIVITY.edit, delete: ACTIVITY.edit, move: ACTIVITY.edit,
  fetch: ACTIVITY.page, think: ACTIVITY.think, switch_mode: ACTIVITY.plan, other: ACTIVITY.tool,
};
export const acpToolStep = (kind: unknown): ActivityStep => ({ label: (typeof kind === "string" && Object.hasOwn(KIND_STEPS, kind) ? KIND_STEPS[kind] : null) ?? ACTIVITY.tool, helper: false });

export type AcpLeaderDeps = {
  cli: { name: string; program: string; args: string[] };
  bridge: { url: string; token: string };
  spawnFn?: AcpSpawn;
  startTimeoutMs?: number;
  maxLine?: number; // test knob; the default is MAX_LINE
};

type Json = Record<string, any>;
const clean = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function createAcpLeader(_seat: LeaderSeat, tabFolder: string, cb: LeaderCallbacks, deps: AcpLeaderDeps): LeaderHandle {
  const name = deps.cli.name;
  let stopped = false, dead = false, turnOpen = false, killFailed = false;
  let sessionId: string | null = null;
  let child: ReturnType<AcpSpawn> | null = null;
  let nextId = 1;
  let caps: Json = {};
  let authText = "";
  let modelName: string | null = null;
  let usage: { used: number | null; size: number | null; cost: number | null } = { used: null, size: null, cost: null };
  let messageKey = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const activity = createActivityTracker((label) => cb.onActivity?.(label));
  const paragraphs = createParagraphs();

  // The bridge token is this leader's own secret: it never reaches the chat. A token split across two chunks is found because the last characters wait for the next chunk.
  const secret = deps.bridge.token;
  const HIDDEN = "[hidden]";
  const hold = Math.max(0, secret.length - 1);
  let held = "";
  const redact = (text: string): string => (secret ? text.split(secret).join(HIDDEN) : text);
  // Every string the CLI supplies that leaves this adapter (model, sign-in text, error and stop texts) goes through here: redacted BEFORE it is cut short, so a cut never leaves part of the token.
  const safe = (value: unknown, max: number): string => clean(redact(typeof value === "string" || typeof value === "number" ? String(value) : ""), max);
  // `gap` is the paragraph break put before a new message. `held` is the raw text (no breaks); each break waits in `gaps` at its place in `held` and is written out with the text before it.
  // It is dropped only when the token really spans it (the token is then shown as [hidden]); text that is not the token never loses or moves its break.
  let gaps: { at: number; gap: string }[] = [];
  const tokenSpans = (raw: string): [number, number][] => { const found: [number, number][] = []; if (secret) for (let i = raw.indexOf(secret); i >= 0; i = raw.indexOf(secret, i + secret.length)) found.push([i, i + secret.length]); return found; };
  // The raw text up to `upto`, redacted, with every break at or before it that no token spans.
  function weave(raw: string, upto: number): string {
    const spans = tokenSpans(raw);
    let out = "", pos = 0;
    for (const g of gaps) {
      if (g.at > upto) break;
      if (spans.some(([s, e]) => s < g.at && g.at < e)) continue;
      out += redact(raw.slice(pos, g.at)) + g.gap;
      pos = g.at;
    }
    return out + redact(raw.slice(pos, upto));
  }
  function emit(text: string, gap = ""): void {
    if (!text) return;
    if (gap) gaps.push({ at: held.length, gap });
    const raw = held + text;
    let cut = Math.max(0, raw.length - hold);
    for (const [s, e] of tokenSpans(raw)) if (s < cut && cut < e) cut = e;
    const out = weave(raw, cut);
    held = raw.slice(cut);
    gaps = gaps.filter((g) => g.at > cut).map((g) => ({ at: g.at - cut, gap: g.gap }));
    if (out) cb.onDelta(out);
  }
  function flushTail(): void {
    let raw = held, mark = "";
    held = "";
    for (let n = Math.min(secret.length - 1, raw.length); n >= 4; n--) if (secret.startsWith(raw.slice(raw.length - n))) { raw = raw.slice(0, raw.length - n); mark = HIDDEN; break; }
    const out = weave(raw, raw.length) + mark;
    gaps = [];
    if (out) cb.onDelta(out);
  }

  const unconfirmedKill = (): void => { const said = killFailed; killFailed = true; if (!said) cb.onNotice?.(`Could not confirm the old ${name} leader stopped. Check Task Manager.`); };
  function endTurn(error?: string): void {
    if (!turnOpen) return;
    turnOpen = false;
    flushTail();
    activity.reset();
    if (error === undefined) {
      cb.onUsage({ modelId: modelName, contextTokens: usage.used, contextWindow: usage.size, costUsd: usage.cost });
      cb.onDone();
    } else cb.onError(redact(error));
  }
  function die(message: string): void {
    if (dead) return;
    dead = true;
    for (const entry of waiting.values()) entry.reject(new Error("leader ended"));
    waiting.clear();
    if (child) killProcessTree(child, unconfirmedKill);
    if (!stopped) { cb.onStop?.(); if (turnOpen) flushTail(); turnOpen = false; cb.onError(redact(message)); }
  }

  function write(message: Json): void {
    try { child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); } catch { /* a closed pipe ends the CLI; the exit handler reports it */ }
  }
  function request(method: string, params: Json): Promise<any> {
    return new Promise((resolve, reject) => {
      if (dead || stopped) { reject(new Error("leader ended")); return; }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }

  // What to say when the CLI refuses because nobody is signed in: its own description of how to sign in (from initialize), cleaned.
  function failureText(error: Json): string {
    const message = safe(error?.message, 200);
    if (error?.code === AUTH_REQUIRED || AUTH_WORDS.test(message)) return `${name} is not signed in${authText ? `: ${authText}` : message ? `: ${message}` : ""}`;
    return `${name} reported an error${message ? `: ${message}` : ""}`;
  }
  const asError = (error: Json): Error => Object.assign(new Error(failureText(error)), { acp: true });

  // The CLI asks before it does something: in Full access every request is allowed once (allow_always only when that is the one allow choice).
  function onPermission(id: unknown, params: Json): void {
    const options: Json[] = Array.isArray(params?.options) ? params.options : [];
    const pick = options.find((option) => option?.kind === "allow_once") ?? options.find((option) => option?.kind === "allow_always");
    if (pick && typeof pick.optionId === "string") { write({ id, result: { outcome: { outcome: "selected", optionId: pick.optionId } } }); return; }
    write({ id, result: { outcome: { outcome: "cancelled" } } });
    cb.onNotice?.(`${name} asked for permission with no way to allow it, so the request was refused.`);
  }

  function onUpdate(params: Json): void {
    if (stopped || dead || params?.sessionId !== sessionId) return;
    const update: Json = params.update ?? {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
        if (turnOpen && text) { activity.quiet(); const shown = paragraphs.text(text, messageKey); emit(text, shown.slice(0, shown.length - text.length)); }
        return;
      }
      case "agent_thought_chunk": messageKey++; if (turnOpen) activity.thinking(); return;
      case "tool_call": {
        messageKey++;
        if (!turnOpen) return;
        const id = String(update.toolCallId);
        // The crew tools already show as crew runs in the side panel (their title names the tab-crew server; the title itself is never shown).
        if (/tab-crew/.test(String(update.title ?? ""))) return;
        if (update.status === "completed" || update.status === "failed") activity.end(id); else activity.start(id, acpToolStep(update.kind));
        return;
      }
      case "tool_call_update":
        if (turnOpen && (update.status === "completed" || update.status === "failed")) activity.end(String(update.toolCallId));
        return;
      case "usage_update": {
        const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
        usage = { used: num(update.used), size: num(update.size), cost: update.cost?.currency === "USD" ? num(update.cost.amount) : usage.cost };
        return;
      }
    }
  }

  function onLine(line: string): void {
    let message: Json;
    try { message = JSON.parse(line); } catch { return; } // one bad line never ends the CLI
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string") {
      if (message.id === undefined) { if (message.method === "session/update") onUpdate(message.params); return; }
      if (message.method === "session/request_permission") { if (!stopped && !dead) onPermission(message.id, message.params ?? {}); else write({ id: message.id, result: { outcome: { outcome: "cancelled" } } }); return; }
      // Nothing else is offered to the CLI (no file access, no terminal: it uses its own).
      write({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
      return;
    }
    const entry = typeof message.id === "number" ? waiting.get(message.id) : undefined;
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(asError(message.error)); else entry.resolve(message.result ?? {});
  }

  const ready = deadline((async () => {
    child = (deps.spawnFn ?? spawnAcpChild)(deps.cli.program, deps.cli.args, { cwd: tabFolder, env: leaderChildEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    trackLeaderChild(child, watchesLeaderChild(deps.spawnFn), unconfirmedKill);
    child.stderr?.resume();
    const gone = (): void => die(sessionId ? `${name} stopped unexpectedly; a new one will start on the next message` : `${name} exited before it started; is it installed?`);
    child.stdin?.on("error", gone); // a broken pipe while the process stays alive would strand the turn
    child.on("error", (error) => die(`${name} could not start: ${error.message}`));
    child.on("exit", gone);
    child.stdout?.on("end", gone); child.stdout?.on("close", gone);
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    const maxLine = deps.maxLine ?? MAX_LINE;
    child.stdout?.on("data", (chunk: string) => {
      if (dead) return;
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        if (at > maxLine) { buffer = ""; die(`${name} sent unreadable data`); return; }
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        // What the CLI sends is untrusted: a message that makes the handling throw is skipped, and the rest of the chunk (maybe the reply to the prompt) is still read.
        if (line) try { onLine(line); } catch { /* skipped */ }
      }
      if (buffer.length > maxLine) { buffer = ""; die(`${name} sent unreadable data`); }
    });
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "command-center", title: "Command Center", version: "1.0.0" } });
    if (init.protocolVersion !== 1) throw new Error(`${name} speaks ACP version ${safe(init.protocolVersion, 10)}, which this app does not support`);
    caps = init.agentCapabilities ?? {};
    const methods: Json[] = Array.isArray(init.authMethods) ? init.authMethods : [];
    authText = safe(methods.find((method) => method?.description)?.description ?? methods.find((method) => method?.name)?.name, 200);
    const http = caps.mcpCapabilities?.http === true;
    const session = await request("session/new", {
      cwd: tabFolder,
      mcpServers: http ? [{ type: "http", name: "tab-crew", url: deps.bridge.url, headers: [{ name: "Authorization", value: `Bearer ${deps.bridge.token}` }] }] : [],
    });
    if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error(`${name} did not return a session`);
    if (redact(session.sessionId) !== session.sessionId) throw new Error(`${name} returned an unusable session`);
    sessionId = session.sessionId;
    cb.onSession?.(sessionId);
    const modelOption = (Array.isArray(session.configOptions) ? session.configOptions : []).find((option: Json) => option?.category === "model" || option?.id === "model");
    if (typeof modelOption?.currentValue === "string") { modelName = safe(modelOption.currentValue, 100) || null; if (modelName) cb.onModel?.(modelName); }
    if (!http) cb.onNotice?.(`The crew tools are not available for ${name}: it does not take tool servers over HTTP.`);
  })(), deps.startTimeoutMs ?? LEADER_START_TIMEOUT_MS, `${name} did not start within 20 seconds`);
  ready.catch((error: Error) => die((error as { acp?: boolean }).acp ? error.message : `${name} failed to start: ${error.message}`));

  function blocks(text: string, images: string[]): Json[] {
    const parts: Json[] = [{ type: "text", text }];
    for (const path of images) {
      if (caps.promptCapabilities?.image !== true) { parts.push({ type: "text", text: `[image not sent: ${name} does not take images]` }); continue; }
      try {
        const mimeType = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
        parts.push({ type: "image", mimeType, data: readFileSync(path).toString("base64") });
      } catch { parts.push({ type: "text", text: `[image failed to load: ${path}]` }); }
    }
    return parts;
  }
  // Other stop reasons end the turn with a plain message (spec: max_tokens, max_turn_requests, refusal, cancelled).
  const STOP_TEXT: Record<string, string> = {
    max_tokens: `${name} stopped because the reply reached its length limit.`,
    max_turn_requests: `${name} stopped because it reached its limit of steps for one reply.`,
    refusal: `${name} declined to continue.`,
    cancelled: `${name} stopped before finishing.`,
  };
  function send(text: string, images: string[] = []): void {
    if (stopped) return;
    if (dead) { cb.onError("leader is not available (the agent process ended); starting a new one on the next message"); return; }
    turnOpen = true;
    activity.reset(); paragraphs.reset();
    usage = { ...usage, used: null, size: null };
    void ready.then(() => request("session/prompt", { sessionId, prompt: blocks(text, images) })).then((result) => {
      if (stopped || dead) return;
      cb.onSession?.(sessionId!);
      const reason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
      if (reason === "end_turn") { const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
        if (usage.used === null && result?.usage) usage = { ...usage, used: count(result.usage.inputTokens) + count(result.usage.cachedReadTokens) || null }; endTurn(); }
      else endTurn((Object.hasOwn(STOP_TEXT, reason) ? STOP_TEXT[reason] : null) ?? `${name} stopped (${safe(reason, 40)}).`);
    }, (error: Error) => { if (!stopped && !dead) endTurn((error as { acp?: boolean }).acp ? error.message : `leader turn failed: ${error.message}`); });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cb.onStop?.();
    if (turnOpen) flushTail();
    turnOpen = false;
    for (const entry of waiting.values()) entry.reject(new Error("leader ended"));
    waiting.clear();
    if (sessionId) write({ method: "session/cancel", params: { sessionId } });
    setTimeout(() => { if (child) killProcessTree(child, unconfirmedKill); }, KILL_GRACE_MS).unref();
  }

  return {
    send,
    // ACP has no mid-turn input: the tab hands the message back as the next turn.
    steer: () => false,
    stop,
    isDead: () => stopped || dead,
    // The CLI's own model stays; changing it live is not offered in this version.
    setModel: () => Promise.resolve(!stopped && !dead),
    // Full access only: any other mode is refused here too (the server refuses it first).
    setPermissionMode: (mode: PermissionMode) => Promise.resolve(!stopped && !dead && mode === "bypass"),
    getPermissionMode: () => permissionModeForSdk("bypass"),
    process: () => leaderProcessState(child, killFailed),
  };
}
