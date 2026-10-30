import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { permissionModeForSdk, type PermissionMode } from "./settings.ts";
import { leaderToolJsonSchema, runLeaderTool, type LeaderToolSpec } from "./leader-tools.ts";
import {
  ACTIVITY, createActivityTracker, createParagraphs, deadline, killProcessTree, leaderChildEnv, leaderProcessState, spawnLeaderChild, toolActivity, trackLeaderChild, watchesLeaderChild, LEADER_START_TIMEOUT_MS, USER_DENIED,
  type ActivityStep, type AskApproval, type LeaderCallbacks, type LeaderHandle, type LeaderSeat, type LeaderSpawn,
} from "./leader-common.ts";

// Fixed argv: the model, folder and prompt travel in JSON-RPC, never on the command line.
const CODEX_COMMAND = "codex app-server";
const KILL_GRACE_MS = 200;

export type CodexPolicy = { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> };
export function codexPolicy(mode: PermissionMode, folder: string): CodexPolicy {
  if (mode === "bypass") return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  if (mode === "plan") return { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  const workspace = { type: "workspaceWrite", writableRoots: [resolve(folder)], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { approvalPolicy: mode === "ask" ? "untrusted" : "on-request", sandbox: "workspace-write", sandboxPolicy: workspace };
}

export type CodexLeaderDeps = {
  tools: LeaderToolSpec[];
  mode: PermissionMode;
  ask: AskApproval;
  savedAsks?: () => boolean;
  spawnFn?: LeaderSpawn;
  startTimeoutMs?: number;
  // The turn/start deadline alone (tests shorten it without shortening the start).
  turnTimeoutMs?: number;
};

type Json = Record<string, any>;

export function createCodexLeader(seat: LeaderSeat, tabFolder: string, cb: LeaderCallbacks, deps: CodexLeaderDeps): LeaderHandle {
  let model = seat.model;
  let mode: PermissionMode = deps.mode;
  let stopped = false;
  let dead = false;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnOpen = false;
  let turnModel = model;
  let lastUsage: Json | null = null;
  let nextId = 0;
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  const abort = new AbortController();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  // Server requests still waiting for our answer, with the reply that refuses them. None is ever left hanging.
  const openRequests = new Map<string | number, Json>();
  const fileChanges = new Map<string, Json[]>();
  const activity = createActivityTracker((label) => cb.onActivity?.(label));
  const paragraphs = createParagraphs();
  // Notifications that name a turn, kept while this turn's id is still unknown: an old turn's straggler must not pass for ours.
  let held: Array<[string, Json]> = [];
  // Steers taken before this turn's id is known (turn/steer needs it): sent from setTurnId.
  let steerHeld: Array<{ text: string; images: string[] }> = [];

  const child = (deps.spawnFn ?? spawnLeaderChild)(CODEX_COMMAND, { shell: true, cwd: tabFolder, env: leaderChildEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  trackLeaderChild(child, watchesLeaderChild(deps.spawnFn), () => unconfirmedKill());

  const write = (message: Json): void => {
    try { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* the child is gone */ }
  };
  child.stdin?.on("error", () => {});
  child.stderr?.resume();
  const request = (method: string, params: Json): Promise<any> => new Promise((resolveRequest, rejectRequest) => {
    if (dead || stopped) { rejectRequest(new Error("leader ended")); return; }
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    write({ id, method, params });
  });

  // A live leader's thread must never age out of Command Center's own-session list: it is reported again at every turn start and on every notification of an open turn (turn/completed included).
  const reportThread = (): void => { if (threadId) cb.onSession?.(threadId); };
  function endTurn(error?: string): void {
    if (!turnOpen) return;
    turnOpen = false;
    if (error === undefined) cb.onDone(); else cb.onError(error);
  }

  // One exit for every way this leader can end on its own (a terminal turn failure included): the next message starts a fresh one.
  function die(message: string): void {
    if (dead) return;
    dead = true;
    for (const waiter of pending.values()) waiter.reject(new Error(message));
    pending.clear();
    abort.abort();
    const hadOpen = openRequests.size > 0;
    for (const [id, refusal] of openRequests) write({ id, result: refusal });
    openRequests.clear();
    // The refusals get a moment to leave before the tree is killed.
    if (hadOpen) setTimeout(() => killProcessTree(child, unconfirmedKill), KILL_GRACE_MS).unref(); else killProcessTree(child, unconfirmedKill);
    if (!stopped) { cb.onStop?.(); turnOpen = false; cb.onError(message); }
  }
  let killFailed = false;
  // Said once per leader: Stop's kill, die()'s kill and the exit sweep can each fail for the same leader.
  const unconfirmedKill = (): void => { const said = killFailed; killFailed = true; if (!said) cb.onNotice?.("Could not confirm the old Codex leader stopped. Check Task Manager."); };

  const approve = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    try { return !abort.signal.aborted && await deps.ask(tool, input, abort.signal) && !abort.signal.aborted; }
    catch { return false; }
  };
  const answer = (id: string | number, result: Json): void => {
    if (!openRequests.delete(id)) return;
    write({ id, result });
  };

  // The requests that run something or ask the user: only this leader's thread and current turn may use them.
  const TURN_REQUESTS = new Set(["item/tool/call", "item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
  const refusalOf = (method: string): Json => (method === "item/tool/call" ? { contentItems: [{ type: "inputText", text: "leader stopped" }], success: false } : { decision: "decline" });
  // Requests that name this turn before its id is known: held, and decided on the turn/start reply.
  let heldRequests: Array<[string | number, string, Json]> = [];

  function dispatchRequest(id: string | number, method: string, params: Json): void {
    void onServerRequest(id, method, params).catch(() => {
      // An unexpected failure: refuse this request, then end the leader (a half-handled turn must not report done).
      const refusal = openRequests.get(id);
      if (refusal) answer(id, refusal); else write({ id, error: { code: -32603, message: "Command Center could not handle this request" } });
      die("leader failed: Codex sent a request that could not be handled");
    });
  }

  function onRequest(id: string | number, method: string, params: Json): void {
    // The old v1 approval names carry a conversationId, not our thread: this leader uses the v2 API, so they are declined outright.
    if (method === "execCommandApproval" || method === "applyPatchApproval") { write({ id, result: { decision: { denied: { rejection: USER_DENIED } } } }); return; }
    if (TURN_REQUESTS.has(method)) {
      const named = params.turnId;
      const foreign = typeof params.threadId !== "string" || params.threadId !== threadId;
      // Never run, never ask the user: a request for a finished turn, another thread, or no turn at all is refused.
      if (foreign || !turnOpen || typeof named !== "string" || (turnId !== null && named !== turnId)) { write({ id, result: refusalOf(method) }); return; }
      if (turnId === null) { openRequests.set(id, refusalOf(method)); heldRequests.push([id, method, params]); return; }
    }
    dispatchRequest(id, method, params);
  }

  async function onServerRequest(id: string | number, method: string, params: Json): Promise<void> {
    const decline = { decision: "decline" };
    switch (method) {
      case "item/tool/call": {
        openRequests.set(id, refusalOf(method));
        const result = await runLeaderTool(deps.tools, String(params.tool), params.arguments);
        answer(id, { contentItems: [{ type: "inputText", text: result.text }], success: !result.isError });
        return;
      }
      case "item/commandExecution/requestApproval": {
        openRequests.set(id, decline);
        const allow = await approve("Bash", { command: params.command, cwd: params.cwd, reason: params.reason });
        answer(id, { decision: allow ? "accept" : "decline" });
        return;
      }
      case "item/fileChange/requestApproval": {
        openRequests.set(id, decline);
        const changes = fileChanges.get(String(params.itemId)) ?? [];
        const allow = await approve("Edit", { file_path: changes[0]?.path, paths: changes.map((change) => String(change.path)), changes: changes.map((change) => `${change.path} (${change.kind?.type ?? "change"})\n${change.diff ?? ""}`).join("\n\n"), reason: params.reason, grantRoot: params.grantRoot });
        answer(id, { decision: allow ? "accept" : "decline" });
        return;
      }
      // There is no screen for these questions: decline them.
      case "item/permissions/requestApproval": write({ id, result: { permissions: {}, scope: "turn" } }); return;
      case "item/tool/requestUserInput": write({ id, result: { answers: {} } }); return;
      case "mcpServer/elicitation/request": write({ id, result: { action: "decline", content: null, _meta: null } }); return;
      default: write({ id, error: { code: -32601, message: `Command Center does not handle ${method}` } });
    }
  }

  const turnOf = (method: string, params: Json): unknown => (method === "turn/started" || method === "turn/completed" ? params.turn?.id : params.turnId);
  function setTurnId(id: string): void {
    turnId = id;
    const replay = held;
    held = [];
    const requests = heldRequests;
    heldRequests = [];
    for (const [requestId, method, params] of requests) {
      if (params.turnId === id) dispatchRequest(requestId, method, params); else answer(requestId, refusalOf(method));
    }
    for (const [method, params] of replay) if (turnOf(method, params) === id) onNotification(method, params);
    for (const waiting of steerHeld.splice(0)) sendSteer(waiting.text, waiting.images, id);
  }

  // The step line from an item's TYPE (and a command's action types) only: its command, query, output, paths and results are never read.
  function codexStep(item: Json): ActivityStep | null {
    const make = (label: string): ActivityStep => ({ label, helper: false });
    switch (item.type) {
      case "commandExecution": {
        const kinds = Array.isArray(item.commandActions) ? item.commandActions.map((action: Json) => String(action?.type)) : [];
        if (kinds.length && kinds.every((kind: string) => kind === "read")) return make(ACTIVITY.read);
        if (kinds.length && kinds.every((kind: string) => /^(list|search)/i.test(kind))) return make(ACTIVITY.search);
        return make(ACTIVITY.command);
      }
      case "fileChange": return make(ACTIVITY.edit);
      case "webSearch": return make(ACTIVITY.web);
      case "mcpToolCall": return toolActivity(`mcp__${item.server}__${item.tool}`);
      // The only dynamic tools the leader registers are the crew tools, which already show as crew runs.
      case "dynamicToolCall": return null;
      default: return typeof item.type === "string" && /toolcall/i.test(item.type) ? make(ACTIVITY.tool) : null;
    }
  }
  function noteStep(started: boolean, item: Json | undefined): void {
    const id = item?.id, type = item?.type;
    if (typeof id !== "string" || typeof type !== "string") return;
    if (!started) activity.end(id);
    else if (type === "reasoning") activity.thinking();
    else if (type === "agentMessage") activity.quiet();
    else activity.start(id, codexStep(item!));
  }

  function onNotification(method: string, params: Json): void {
    if (stopped || dead) return;
    if (turnOpen) reportThread();
    const scoped = method === "turn/started" || method === "item/agentMessage/delta" || method === "error" || method === "turn/completed";
    // Codex always names the turn on these; while a turn is open one that does not cannot be told from a straggler.
    if (turnOpen && scoped && typeof turnOf(method, params) !== "string") return;
    const stale = (id: unknown): boolean => typeof id === "string" && turnId !== null && id !== turnId;
    // The turn id comes only from the turn/start reply; until then every turn-scoped notification waits for it.
    if (turnOpen && turnId === null && (method === "turn/started" || method === "item/agentMessage/delta" || method === "error" || method === "turn/completed") && typeof turnOf(method, params) === "string") { held.push([method, params]); return; }
    switch (method) {
      case "turn/started": return;
      case "item/agentMessage/delta":
        // Each agent message is its own item: the first text of a new one starts a new paragraph (the item id is only compared, never shown).
        if (turnOpen && !stale(params.turnId) && typeof params.delta === "string" && params.delta) cb.onDelta(paragraphs.text(params.delta, String(params.itemId ?? "")));
        return;
      case "thread/tokenUsage/updated": if (params.tokenUsage) lastUsage = params.tokenUsage; return;
      case "item/started":
      case "item/completed":
        if (params.item?.type === "fileChange" && Array.isArray(params.item.changes)) fileChanges.set(params.item.id, params.item.changes);
        if (turnOpen && !stale(params.turnId)) noteStep(method === "item/started", params.item);
        return;
      case "error":
        // willRetry means Codex is still trying; only a final error ends the turn.
        if (params.willRetry === true || stale(params.turnId) || !turnOpen) return;
        die(`leader turn failed: ${params.error?.message ?? "Codex reported an error"}`);
        return;
      case "turn/completed": {
        if (!turnOpen || stale(params.turn?.id)) return;
        const status = params.turn?.status;
        const last = lastUsage?.last;
        if (last) {
          const window = lastUsage?.modelContextWindow;
          cb.onUsage({ modelId: turnModel, contextTokens: typeof last.inputTokens === "number" ? last.inputTokens : null, contextWindow: typeof window === "number" && window > 0 ? window : null, costUsd: null });
        }
        if (status === "completed") endTurn();
        else die(`leader turn ${status === "interrupted" ? "interrupted" : "failed"}${params.turn?.error?.message ? `: ${params.turn.error.message}` : ""}`);
        return;
      }
    }
  }

  function onLine(line: string): void {
    let message: Json;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { die("leader failed: Codex sent a message that could not be read"); return; }
    try {
      if (message.id !== undefined && message.method === undefined) {
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex request failed")); else waiter.resolve(message.result);
      } else if (message.id !== undefined) {
        if (stopped || dead) { write({ id: message.id, error: { code: -32000, message: "leader stopped" } }); return; }
        onRequest(message.id, String(message.method), message.params ?? {});
      } else if (typeof message.method === "string") onNotification(message.method, message.params ?? {});
    } catch { die("leader failed: Codex sent a message that could not be handled"); }
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  });
  child.on("error", (error) => die(`Codex could not start: ${error.message}`));
  // The CLI can exit on its own; that ends this leader, once, unless Stop already did.
  child.on("exit", () => die(threadId ? "leader session ended; a new one will start on the next message" : "Codex exited before it started; is it installed and signed in?"));

  const effectiveMode = (): PermissionMode => (deps.savedAsks?.() ? "ask" : mode);
  const ready = deadline((async () => {
    await request("initialize", { clientInfo: { name: "command-center", title: "Command Center", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    write({ method: "initialized" });
    const policy = codexPolicy(effectiveMode(), tabFolder);
    const started = await request("thread/start", {
      cwd: resolve(tabFolder), model, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox,
      dynamicTools: deps.tools.map((spec) => ({ type: "function", name: spec.name, description: spec.description, inputSchema: leaderToolJsonSchema(spec) })),
    });
    threadId = started?.thread?.id ?? null;
    if (!threadId) throw new Error("Codex did not return a thread");
    cb.onSession?.(threadId);
  })(), deps.startTimeoutMs ?? LEADER_START_TIMEOUT_MS, `Codex did not start within ${LEADER_START_TIMEOUT_MS / 1000} seconds`);
  ready.catch((error: Error) => die(`Codex leader failed to start: ${error.message}`));

  const inputOf = (text: string, images: string[]): Json[] => [{ type: "text", text, text_elements: [] }, ...images.map((path) => ({ type: "localImage", path }))];

  async function startTurn(text: string, images: string[]): Promise<void> {
    const policy = codexPolicy(effectiveMode(), tabFolder);
    turnModel = model;
    turnId = null;
    held = [];
    lastUsage = null;
    try {
      const started = await deadline(request("turn/start", {
        threadId, model, effort: seat.effort, approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy,
        input: inputOf(text, images),
      }), deps.turnTimeoutMs ?? LEADER_START_TIMEOUT_MS, "Codex did not answer the turn request");
      if (!turnOpen || stopped || dead) return;
      if (typeof started?.turn?.id === "string" && started.turn.id) setTurnId(started.turn.id);
      else die("leader turn failed: Codex did not identify the turn");
    } catch (error) {
      if (!stopped && !dead && turnOpen) die(`leader turn failed: ${(error as Error).message}`);
    }
  }

  function send(text: string, images: string[] = []): void {
    if (stopped) return;
    if (dead) { cb.onError("leader is not available (the agent process ended); starting a new one on the next message"); return; }
    turnOpen = true;
    reportThread();
    // From here until the new turn's id is known, nothing that names a turn is trusted.
    turnId = null;
    held = [];
    steerHeld = [];
    fileChanges.clear(); // an approval only ever names an item of the current turn
    activity.reset(); paragraphs.reset();
    // Codex starts no turn on its own and cannot see what it starts detached (probed 2026-10-17): it never reports background jobs (onBackgroundJobs).
    void ready.then(() => startTurn(text, images), () => {});
  }

  // turn/steer joins the running turn (probed 2026-10-16: one turn/completed for both messages). Once that turn is over Codex answers "no active turn to steer": the message then goes out as the next turn.
  function sendSteer(text: string, images: string[], id: string): void {
    request("turn/steer", { threadId, expectedTurnId: id, input: inputOf(text, images) }).catch((error: Error) => {
      if (stopped || dead) return;
      if (!/no active turn|expected turn/i.test(error.message)) cb.onNotice?.(`Codex did not take the steered message (${error.message}); it goes out as the next message.`);
      cb.onSteerMissed?.(text, images);
    });
  }
  function steer(text: string, images: string[] = []): boolean {
    if (stopped || dead || !turnOpen) return false;
    if (turnId === null) steerHeld.push({ text, images }); else sendSteer(text, images, turnId);
    return true;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cb.onStop?.();
    abort.abort();
    for (const [id, refusal] of openRequests) write({ id, result: refusal });
    openRequests.clear();
    if (turnOpen && threadId && turnId) write({ id: ++nextId, method: "turn/interrupt", params: { threadId, turnId } });
    turnOpen = false;
    for (const waiter of pending.values()) waiter.reject(new Error("leader ended"));
    pending.clear();
    // A short grace lets the refusals and the interrupt leave the pipe; the process-exit hook covers a server shutdown.
    setTimeout(() => killProcessTree(child, unconfirmedKill), KILL_GRACE_MS).unref();
  }

  // The model for the NEXT turn: Codex takes it per turn/start.
  const setModel = (next: string): Promise<boolean> => { if (stopped || dead) return Promise.resolve(false); model = next; return Promise.resolve(true); };
  // A running turn keeps the policy it started with, so a change mid-turn would only look applied: refuse it.
  const setPermissionMode = (next: PermissionMode): Promise<boolean> => { if (stopped || dead || turnOpen) return Promise.resolve(false); mode = next; return Promise.resolve(true); };

  return { send, steer, stop, isDead: () => stopped || dead, setModel, setPermissionMode, getPermissionMode: () => permissionModeForSdk(mode), modeLocked: () => turnOpen, process: () => leaderProcessState(child, killFailed) };
}
