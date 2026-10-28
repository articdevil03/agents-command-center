import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import { IMAGE_EXT_TO_MIME } from "./config.ts";
import { permissionModeForSdk, type PermissionMode } from "./settings.ts";
import {
  createActivityTracker, createParagraphs, deadline, killProcessTree, leaderChildEnv, leaderProcessState, spawnLeaderChild, toolActivity, trackLeaderChild, watchesLeaderChild, LEADER_START_TIMEOUT_MS,
  type AskApproval, type LeaderCallbacks, type LeaderHandle, type LeaderSeat, type LeaderSpawn,
} from "./leader-common.ts";

export const OPENCODE_CREW_SERVER = "tab-crew";
const HOST = "127.0.0.1";
const KILL_GRACE_MS = 200;

// OpenCode 1.18's own list of permissions that only look (checked in its binary: new Set(["read","glob","grep","list"])).
const READ_ONLY_PERMISSIONS = ["read", "glob", "grep", "list"];
type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };
// OpenCode evaluates the LAST matching rule, so the broad rule comes first and the specific ones override it.
export function opencodeRules(mode: PermissionMode): Rule[] {
  const crew: Rule = { permission: `${OPENCODE_CREW_SERVER}_*`, pattern: "*", action: "allow" };
  if (mode === "bypass") return [{ permission: "*", pattern: "*", action: "allow" }, crew];
  const rules: Rule[] = [{ permission: "*", pattern: "*", action: "ask" }];
  // Looking is free, as in Claude's default mode and in Codex; secrets files still ask. Anything else, outside folders included, asks.
  for (const permission of READ_ONLY_PERMISSIONS) rules.push({ permission, pattern: "*", action: "allow" });
  for (const pattern of ["*.env", "*.env.*"]) rules.push({ permission: "read", pattern, action: "ask" });
  if (mode === "accept") rules.push({ permission: "edit", pattern: "*", action: "allow" });
  if (mode === "plan") rules.push({ permission: "edit", pattern: "*", action: "deny" });
  rules.push(crew);
  return rules;
}

// OpenCode's wildcard: * matches any run of characters.
function wildcard(pattern: string, text: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(text);
}
// The last matching rule wins (as in OpenCode); no match asks.
export function decideByRules(rules: Rule[], permission: string, patterns: string[]): "allow" | "deny" | "ask" {
  const actions = (patterns.length ? patterns : ["*"]).map((pattern) => rules.filter((rule) => wildcard(rule.permission, permission) && wildcard(rule.pattern, pattern)).at(-1)?.action ?? "ask");
  return actions.includes("deny") ? "deny" : actions.every((action) => action === "allow") ? "allow" : "ask";
}
// A sub-agent session inherits only its parent's deny rules (checked in OpenCode 1.18's task tool), so left alone it runs on OpenCode's permissive defaults.
// This baseline makes every sub-agent request ask; the leader then answers each one by the tab's mode (see onPermission).
export const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { "*": "ask", read: { "*": "allow", "*.env": "ask", "*.env.*": "ask" }, glob: "allow", grep: "allow", list: "allow", [`${OPENCODE_CREW_SERVER}_*`]: "allow" },
});

// bash -> Bash, edit/write/patch -> Edit, anything else keeps its own name so the approval card says what it is.
export function opencodeApprovalRequest(permission: string, patterns: string[], metadata: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  if (permission === "bash") return { tool: "Bash", input: { command: patterns.join("\n"), ...metadata } };
  if (permission === "edit" || permission === "write" || permission === "patch") {
    const path = typeof metadata.filepath === "string" ? metadata.filepath : patterns[0];
    return { tool: "Edit", input: { file_path: path, patterns, ...metadata } };
  }
  return { tool: permission, input: { patterns, ...metadata } };
}

export function splitOpencodeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export type OpencodeLeaderDeps = {
  bridge: { url: string; token: string };
  mode: PermissionMode;
  ask: AskApproval;
  savedAsks?: () => boolean;
  spawnFn?: LeaderSpawn;
  startTimeoutMs?: number;
  // Tests only: a fixed port for a fake server. Otherwise OpenCode binds a port itself and says which (no probe-then-reuse race for another process to win).
  pickPort?: () => Promise<number>;
};

type Json = Record<string, any>;

// Per-session maps grow with every message; the oldest entries go first (a duplicate event only ever arrives close to the original).
const MAP_LIMIT = 4000;
function trimOldest(collection: Map<string, unknown> | Set<string>): void {
  while (collection.size > MAP_LIMIT) collection.delete(collection.keys().next().value as string);
}

export function createOpencodeLeader(seat: LeaderSeat, tabFolder: string, cb: LeaderCallbacks, deps: OpencodeLeaderDeps): LeaderHandle {
  let model = seat.model;
  let mode: PermissionMode = deps.mode;
  let stopped = false;
  let dead = false;
  let turnOpen = false;
  let turnGeneration = 0;
  let idleSeq = 0; // every session.idle takes the next number; only the newest one may end the turn (an older one is still waiting for the usage lookup)
  // The steers of this turn, counted. A steer that reached OpenCode after its loop ended starts a second run with its own idle: until every steer was either refused or
  // answered (its own user message was seen AND an assistant message created after that has FINISHED), an idle is not the end of the turn. Counts, not a flag, so the
  // order in which messages, answers and refusals arrive does not matter (a refusal can come after another steer's answer finished).
  let ownUserExpected = false; // the turn's own message has not shown up yet: the first user event is that one
  let steersPosted = 0, steersRefused = 0, steerUsersSeen = 0, steerUsersAnswered = 0;
  let idleHeld = false; // an idle arrived while a steer was unanswered: if that steer then fails, nothing else will end the turn
  const seenUsers = new Set<string>();
  const answerFor = new Map<string, { generation: number; users: number }>(); // an assistant message -> how many steer messages had been seen when it was created
  const finishedMessages = new Set<string>();
  const steerPending = (): boolean => steersPosted - steersRefused > steerUsersAnswered;
  let sessionId: string | null = null;
  let base = "";
  let turnModel = model;
  let lastTokens: Json | null = null;
  let cumulativeCost = 0;
  let sawCost = false;
  let windows: Map<string, number> | null = null;
  const ac = new AbortController();
  const password = randomBytes(24).toString("hex");
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const activity = createActivityTracker((label) => cb.onActivity?.(label));
  const paragraphs = createParagraphs();
  const partTypes = new Map<string, string>();
  const partMessages = new Map<string, string>();
  const messageRoles = new Map<string, string>();
  const countedMessages = new Set<string>();
  const openPermissions = new Set<string>();
  // Sub-agent sessions of this leader (their parent is the leader session or another owned one): their permission requests must be answered too.
  const ownedSessions = new Set<string>();
  let child: ReturnType<LeaderSpawn> | null = null;

  // The bridge token and the server password must never reach chat errors (they are stored in the chat log).
  const secrets = [password, deps.bridge.token, Buffer.from(`opencode:${password}`).toString("base64")];
  const redact = (text: string): string => secrets.reduce((out, secret) => (secret ? out.split(secret).join("[hidden]") : out), text);
  // Streamed text is redacted too (a command the leader runs can print its own environment). A secret can be split across two deltas,
  // so the last few characters wait for the next delta and are released when the turn ends.
  // Redaction always sees the text exactly as OpenCode sent it: a paragraph break between two parts is only a mark (an index into the held text, shown before that character)
  // and becomes "\n\n" after redaction, so a secret split across two parts is still found.
  const holdBack = Math.max(0, ...secrets.map((secret) => secret.length)) - 1;
  const HIDDEN = "[hidden]";
  let pendingTail = "";
  let tailBreaks: number[] = [];
  function redactMarked(raw: string, marks: number[]): { text: string; marks: number[] } {
    const found: [number, number][] = [];
    for (const secret of secrets) if (secret) for (let at = raw.indexOf(secret); at >= 0; at = raw.indexOf(secret, at + secret.length)) found.push([at, at + secret.length]);
    const ranges: [number, number][] = [];
    for (const range of found.sort((a, b) => a[0] - b[0])) { const last = ranges.at(-1); if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]); else ranges.push([...range]); }
    let text = "", from = 0;
    for (const [start, end] of ranges) { text += raw.slice(from, start) + HIDDEN; from = end; }
    // A mark inside a hidden secret moves to the start of its [hidden].
    return { text: text + raw.slice(from), marks: marks.map((mark) => { let shift = 0; for (const [start, end] of ranges) { if (mark <= start) break; if (mark < end) { mark = start; break; } shift += HIDDEN.length - (end - start); } return mark + shift; }) };
  }
  // The text up to `end` with the paragraph breaks put in (a break at `end` itself only when `atEnd`).
  function withBreaks(text: string, marks: number[], end: number, atEnd: boolean): string {
    let out = "", from = 0;
    for (const mark of marks) { if (mark > end || (mark === end && !atEnd)) break; out += `${text.slice(from, mark)}\n\n`; from = mark; }
    return out + text.slice(from, end);
  }
  // Shows everything before `cut` and keeps the rest (and its breaks) held back.
  function release(held: { text: string; marks: number[] }, cut: number): void {
    const out = withBreaks(held.text, held.marks, cut, false);
    pendingTail = held.text.slice(cut);
    tailBreaks = held.marks.filter((mark) => mark >= cut).map((mark) => mark - cut);
    if (out) cb.onDelta(out);
  }
  function emitDelta(text: string, breakBefore = false): void {
    const joined = redactMarked(pendingTail + text, breakBefore ? [...tailBreaks, pendingTail.length] : tailBreaks);
    release(joined, joined.text.length - Math.min(holdBack, joined.text.length));
  }
  // How many characters at the end of `text` could be the start of a secret whose rest has not arrived.
  function secretPrefixLength(text: string): number {
    let keep = 0;
    for (const secret of secrets) for (let n = Math.min(secret.length - 1, text.length); n > keep; n--) if (secret.startsWith(text.slice(text.length - n))) { keep = n; break; }
    return keep;
  }
  // The end of the text (a stop, a death, the turn's end): nothing more arrives, so an end that is the start of a secret is never shown. From 4 characters on it is
  // shown as [hidden]; a shorter match is ordinary text.
  function flushTail(): void {
    const held = redactMarked(pendingTail, tailBreaks);
    pendingTail = ""; tailBreaks = [];
    const cut = secretPrefixLength(held.text);
    const out = cut >= 4 ? `${withBreaks(held.text, held.marks, held.text.length - cut, true)}${HIDDEN}` : withBreaks(held.text, held.marks, held.text.length, false);
    if (out) cb.onDelta(out);
  }
  // At a steer: everything held back is released through the same redaction, except an end that could still be the start of a secret (its rest has not arrived), which keeps waiting.
  function flushSafeTail(): void {
    const held = redactMarked(pendingTail, tailBreaks);
    release(held, held.text.length - secretPrefixLength(held.text));
  }

  const url = (path: string): string => `${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(tabFolder)}`;
  async function api(method: string, path: string, body?: unknown, ms = 10_000): Promise<any> {
    const response = await fetch(url(path), {
      method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(ms)]),
    });
    const text = await response.text();
    const label = `OpenCode ${method} ${path.split("?")[0].replace(/ses_[A-Za-z0-9]+/g, ":id")}`;
    if (!response.ok) {
      let detail = "";
      // Setup calls (/mcp, /session, /config/providers) can echo config and keys: only the prompt call's detail is shown.
      if (path.includes("/prompt_async")) try { const parsed = JSON.parse(text); detail = parsed?.data?.message ?? parsed?.message ?? ""; } catch { /* not json */ }
      throw new Error(`${label} returned ${response.status}${detail ? `: ${redact(String(detail)).slice(0, 200)}` : ""}`);
    }
    if (!text) return null;
    // JSON.parse quotes the start of the text in its error: say only that the data was unreadable.
    try { return JSON.parse(text); } catch { throw new Error(`${label} returned unreadable data`); }
  }

  // A live leader's sessions must never age out of Command Center's own-session list: they are reported again at every turn start and end, and on every event for them.
  const reportSessions = (): void => { if (sessionId) cb.onSession?.(sessionId); for (const id of ownedSessions) cb.onSession?.(id); };
  function endTurn(error?: string): void {
    if (!turnOpen) return;
    turnOpen = false;
    reportSessions();
    flushTail();
    if (error === undefined) cb.onDone(); else cb.onError(redact(error));
  }

  // Tell OpenCode every waiting permission is refused (bounded, so a dead server never holds us up).
  function rejectOpen(): void {
    const open = [...openPermissions];
    openPermissions.clear();
    if (!base) return;
    for (const id of open) void fetch(url(`/permission/${id}/reply`), { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ reply: "reject" }), signal: AbortSignal.timeout(KILL_GRACE_MS * 4) }).catch(() => {});
  }

  function die(message: string): void {
    if (dead) return;
    dead = true;
    ac.abort();
    const hadOpen = openPermissions.size > 0;
    rejectOpen();
    // The refusals get a moment to leave before the tree is killed.
    if (child) { const target = child; if (hadOpen) setTimeout(() => killProcessTree(target, unconfirmedKill), KILL_GRACE_MS).unref(); else killProcessTree(target, unconfirmedKill); }
    if (!stopped) { cb.onStop?.(); if (turnOpen) flushTail(); turnOpen = false; cb.onError(redact(message)); }
  }
  let killFailed = false;
  // Said once per leader: Stop's kill, die()'s kill and the exit sweep can each fail for the same leader.
  const unconfirmedKill = (): void => { const said = killFailed; killFailed = true; if (!said) cb.onNotice?.("Could not confirm the old OpenCode leader stopped. Check Task Manager."); };

  const approve = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    try { return !ac.signal.aborted && await deps.ask(tool, input, ac.signal) && !ac.signal.aborted; }
    catch { return false; }
  };

  async function onPermission(p: Json, subagent = false): Promise<void> {
    const id = String(p.id);
    openPermissions.add(id);
    const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : [];
    // The main session asks only what its rules say to ask. A sub-agent's request is decided here by the tab's mode (its own rules are OpenCode's defaults).
    const verdict = subagent ? decideByRules(opencodeRules(deps.savedAsks?.() ? "ask" : mode), String(p.permission), patterns) : "ask";
    const { tool, input } = opencodeApprovalRequest(String(p.permission), patterns, (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>);
    const allow = verdict === "ask" ? await approve(tool, input) : verdict === "allow";
    if (!openPermissions.has(id)) return;
    // The id stays open until OpenCode acknowledged the reply: an unanswered permission would wait forever.
    try { await api("POST", `/permission/${id}/reply`, { reply: allow ? "once" : "reject" }); }
    catch (error) { if (openPermissions.has(id)) die(`leader turn failed: could not answer an OpenCode permission request (${(error as Error).message})`); return; }
    openPermissions.delete(id);
  }

  // One read of the providers at a time: idles that overlap share it (never two fetches of the key-holding payload).
  let windowsLoading: Promise<void> | null = null;
  async function contextWindowFor(modelId: string): Promise<number | null> {
    if (!windows) {
      windowsLoading ??= (async () => {
        try {
          // This payload also holds the user's API keys: read the limits, keep nothing else, never log it.
          const data = await api("GET", "/config/providers");
          const read = new Map<string, number>();
          const list = Array.isArray(data?.providers) ? data.providers : [];
          for (const provider of list) for (const [id, info] of Object.entries<Json>(provider?.models ?? {})) {
            const limit = info?.limit?.context;
            if (typeof limit === "number" && limit > 0) read.set(`${provider.id}/${id}`, limit);
          }
          windows = read;
        } catch { /* the window stays unknown for this turn; the next turn tries again */ }
        windowsLoading = null;
      })();
      await windowsLoading;
    }
    return windows?.get(modelId) ?? null;
  }

  // Every idle runs this, none is dropped or remembered: the decision is made after the usage lookup, from what is true then. An idle that finds a steer unanswered
  // then waits (idleHeld); the steer's own idle, or its refusal, decides. A newer idle replaces an older one that is still waiting for the lookup.
  async function onIdle(): Promise<void> {
    if (!turnOpen) return;
    const seq = ++idleSeq;
    idleHeld = false;
    const generation = turnGeneration, idleModel = turnModel, tokens = lastTokens;
    const window = tokens ? await contextWindowFor(idleModel) : null;
    // A turn that started meanwhile is not ours to finish; nor is it this idle's to finish when a newer one is deciding.
    if (generation !== turnGeneration || !turnOpen) return;
    if (seq !== idleSeq) return;
    // A steer was posted while the usage window was read: this idle is not the end, the steer's own idle is.
    if (steerPending()) { idleHeld = true; return; }
    if (tokens) {
      const input = (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0) + (Number(tokens.cache?.write) || 0);
      cb.onUsage({ modelId: idleModel, contextTokens: input, contextWindow: window, costUsd: sawCost ? cumulativeCost : null });
    }
    endTurn();
  }

  // The step line from a tool part's NAME and status only (a tool part's input, output and title are never read). Sub-agent sessions stay hidden; their task tool part here counts them.
  function noteStep(part: Json): void {
    const id = String(part.id), type = String(part.type);
    if (type === "tool") {
      const status = part.state?.status;
      if (status === "completed" || status === "error") activity.end(id); else activity.start(id, toolActivity(part.tool));
    } else if (type === "reasoning") activity.thinking();
    else if (type === "text" && messageRoles.get(String(part.messageID)) !== "user") activity.quiet();
  }

  function onEvent(event: Json): void {
    if (stopped || dead) return;
    const p = event.properties ?? {};
    if (event.type === "session.created") {
      const parent = p.info?.parentID;
      if (typeof p.info?.id === "string" && typeof parent === "string" && (parent === sessionId || ownedSessions.has(parent))) { ownedSessions.add(p.info.id); cb.onSession?.(p.info.id); }
      return;
    }
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (typeof sid === "string" && (sid === sessionId || ownedSessions.has(sid))) cb.onSession?.(sid);
    if (sid && sid !== sessionId) {
      // A sub-agent of this leader: nothing of it is shown, but a request it makes must be answered or the turn would hang.
      if (ownedSessions.has(sid)) {
        if (event.type === "permission.asked") void onPermission(p, true).catch(() => {});
        else if (event.type === "question.asked") void api("POST", `/question/${p.id}/reject`, {}).catch((error: Error) => die(`leader turn failed: could not answer an OpenCode question (${error.message})`));
      }
      return;
    }
    switch (event.type) {
      case "message.updated": {
        const info = p.info ?? {};
        if (typeof info.id === "string" && typeof info.role === "string") {
          const known = messageRoles.has(info.id);
          messageRoles.set(info.id, info.role); trimOldest(messageRoles);
          if (info.role === "user" && !seenUsers.has(info.id)) { seenUsers.add(info.id); trimOldest(seenUsers); if (ownUserExpected) ownUserExpected = false; else steerUsersSeen++; }
          // An assistant message created after a steer's own message was seen is OpenCode answering it, and the steer is answered once that message is FINISHED
          // (begun is not enough: a duplicate idle of the older run cannot be told from the answer's own idle, a finished answer can).
          if (info.role === "assistant" && !known) { answerFor.set(info.id, { generation: turnGeneration, users: steerUsersSeen }); trimOldest(answerFor); }
          if (info.role === "assistant" && info.time?.completed && !finishedMessages.has(info.id)) {
            finishedMessages.add(info.id); trimOldest(finishedMessages);
            const born = answerFor.get(info.id);
            if (born?.generation === turnGeneration) steerUsersAnswered = Math.max(steerUsersAnswered, born.users);
          }
        }
        // The same completed message arrives more than once: count it once.
        if (info.role === "assistant" && info.time?.completed && info.tokens && !countedMessages.has(info.id)) {
          countedMessages.add(info.id); trimOldest(countedMessages);
          lastTokens = info.tokens;
          if (typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0) { cumulativeCost += info.cost; sawCost = true; }
        }
        return;
      }
      case "message.part.updated":
        if (p.part?.id && p.part?.type) {
          partTypes.set(String(p.part.id), String(p.part.type)); trimOldest(partTypes);
          if (p.part.messageID) { partMessages.set(String(p.part.id), String(p.part.messageID)); trimOldest(partMessages); }
          if (turnOpen) noteStep(p.part);
        }
        return;
      case "message.part.delta":
        // Reasoning parts stream with field "text" too: only a text part of the assistant is the answer. Each text part is its own message: the first text of a new one starts a new paragraph.
        if (turnOpen && p.field === "text" && typeof p.delta === "string" && p.delta && partTypes.get(String(p.partID)) === "text" && messageRoles.get(partMessages.get(String(p.partID)) ?? String(p.messageID)) !== "user") emitDelta(p.delta, paragraphs.text(p.delta, String(p.partID)).length > p.delta.length);
        return;
      case "permission.asked":
        void onPermission(p).catch(() => {});
        return;
      case "question.asked":
        // No screen for questions: reject, so the CLI never waits on us.
        // A reject that fails leaves OpenCode waiting for an answer for ever: end this leader.
        void api("POST", `/question/${p.id}/reject`, {}).catch((error: Error) => die(`leader turn failed: could not answer an OpenCode question (${error.message})`));
        return;
      case "session.error": {
        const name = p.error?.name;
        const detail = p.error?.data?.message ?? p.error?.message;
        if (turnOpen) die(`leader turn failed: ${detail ?? name ?? "OpenCode reported an error"}`);
        return;
      }
      case "session.idle":
        void onIdle();
        return;
    }
  }

  async function readEvents(response: Response): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, "");
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("");
          if (!data) continue;
          try { onEvent(JSON.parse(data)); } catch { /* one bad event never ends the stream */ }
        }
      }
    } catch { /* ended below */ }
    die("leader session ended; a new one will start on the next message");
  }

  const ready = deadline((async () => {
    const fixedPort = deps.pickPort ? await deps.pickPort() : 0;
    child = (deps.spawnFn ?? spawnLeaderChild)(`opencode serve --hostname ${HOST} --port ${fixedPort}`, {
      shell: true, cwd: tabFolder, env: leaderChildEnv({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    trackLeaderChild(child, watchesLeaderChild(deps.spawnFn), () => unconfirmedKill());
    child.stderr?.resume();
    child.on("error", (error) => die(`OpenCode could not start: ${error.message}`));
    child.on("exit", () => die(sessionId ? "leader session ended; a new one will start on the next message" : "OpenCode exited before it started; is it installed?"));
    // Port 0 lets OpenCode choose and print the port it actually bound. ponytail: depends on that "listening on http://127.0.0.1:N" line; a CLI that stops printing it fails the start check.
    const bound = new Promise<number>((found) => {
      let seen = "";
      child!.stdout?.on("data", (chunk: Buffer) => {
        if (!fixedPort && !base) { seen += chunk.toString("utf8"); const match = seen.match(/listening on https?:\/\/[^\s:]+:(\d+)/); if (match) found(Number(match[1])); }
      });
    });
    base = `http://${HOST}:${fixedPort || await Promise.race([bound, new Promise<never>((_ok, no) => ac.signal.addEventListener("abort", () => no(new Error("leader ended")), { once: true }))])}`;
    for (;;) {
      if (ac.signal.aborted) throw new Error("leader ended");
      try { await api("GET", "/global/health", undefined, 2000); break; } catch { await new Promise((ok) => setTimeout(ok, 150)); }
    }
    const added = await api("POST", "/mcp", { name: OPENCODE_CREW_SERVER, config: { type: "remote", url: deps.bridge.url, headers: { Authorization: `Bearer ${deps.bridge.token}` }, oauth: false } });
    if (added?.[OPENCODE_CREW_SERVER]?.status !== "connected") throw new Error("OpenCode could not reach the crew tools");
    const effective = deps.savedAsks?.() ? "ask" : mode;
    const session = await api("POST", "/session", { title: "Command Center leader", permission: opencodeRules(effective) });
    if (!session?.id) throw new Error("OpenCode did not return a session");
    sessionId = String(session.id);
    cb.onSession?.(sessionId);
    // Subscribe before the first prompt so no early event is missed.
    const events = await fetch(url("/event"), { headers: { authorization: auth }, signal: ac.signal });
    if (!events.ok || !events.body) throw new Error(`OpenCode event stream returned ${events.status}`);
    void readEvents(events);
  })(), deps.startTimeoutMs ?? LEADER_START_TIMEOUT_MS, "OpenCode did not start within 20 seconds");
  ready.catch((error: Error) => die(`OpenCode leader failed to start: ${error.message}`));

  function prompt(text: string, images: string[]): Promise<any> {
    const parts: Json[] = [{ type: "text", text }];
    for (const path of images) {
      try {
        const mime = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
        parts.push({ type: "file", mime, filename: path.split(/[\\/]/).pop(), url: `data:${mime};base64,${readFileSync(path).toString("base64")}` });
      } catch { parts.push({ type: "text", text: `[image failed to load: ${path}]` }); }
    }
    return api("POST", `/session/${sessionId}/prompt_async`, { model: splitOpencodeModel(model), variant: seat.effort, parts });
  }

  function startTurn(text: string, images: string[]): Promise<void> {
    turnModel = model;
    lastTokens = null;
    return prompt(text, images).then(() => {}, (error: Error) => {
      if (!stopped && !dead && turnOpen) die(`leader turn failed: ${error.message}`);
    });
  }

  function send(text: string, images: string[] = []): void {
    if (stopped) return;
    if (dead) { cb.onError("leader is not available (the agent process ended); starting a new one on the next message"); return; }
    turnOpen = true;
    reportSessions();
    turnGeneration++;
    ownUserExpected = true; steersPosted = 0; steersRefused = 0; steerUsersSeen = 0; steerUsersAnswered = 0; idleHeld = false;
    activity.reset(); paragraphs.reset();
    // OpenCode starts no turn on its own and starts background commands detached where Command Center cannot see them (probed 2026-10-17): it never reports background jobs (onBackgroundJobs).
    void ready.then(() => startTurn(text, images), () => {});
  }

  // A second prompt_async while a turn runs joins it: one assistant answer, one session.idle at the end (probed 2026-10-16). turnGeneration stays as it is.
  // The reply so far is released first, so the server saves it complete before the steered message; the idle waits until an answer to the steer has finished (a second run keeps the turn open).
  function steer(text: string, images: string[] = []): boolean {
    if (stopped || dead || !turnOpen) return false;
    flushSafeTail();
    steersPosted++;
    const generation = turnGeneration;
    void ready.then(() => prompt(text, images)).then(() => {}, () => {
      if (generation === turnGeneration) steersRefused++;
      if (!stopped && !dead) cb.onSteerMissed?.(text, images);
      if (generation === turnGeneration && idleHeld && turnOpen && !steerPending()) void onIdle();
    });
    return true;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cb.onStop?.();
    if (turnOpen) flushTail(); // the held-back end of the answer is part of what was said
    turnOpen = false;
    // Refuse what is waiting and abort the turn, but only after those calls had a moment to leave; then end the whole tree.
    rejectOpen();
    if (sessionId && base) void fetch(url(`/session/${sessionId}/abort`), { method: "POST", headers: { authorization: auth }, signal: AbortSignal.timeout(KILL_GRACE_MS * 4) }).catch(() => {});
    setTimeout(() => { ac.abort(); if (child) killProcessTree(child, unconfirmedKill); }, KILL_GRACE_MS).unref();
  }

  const setModel = (next: string): Promise<boolean> => { if (stopped || dead) return Promise.resolve(false); model = next; return Promise.resolve(true); };
  async function setPermissionMode(next: PermissionMode): Promise<boolean> {
    if (stopped || dead) return false;
    try {
      await ready;
      await api("PATCH", `/session/${sessionId}`, { permission: opencodeRules(next) });
      if (stopped || dead) return false;
      mode = next;
      return true;
    } catch {
      // The caller reports the failed change once (and stops the chat); a second error here would fail a turn that is not ours.
      return false;
    }
  }

  return { send, steer, stop, isDead: () => stopped || dead, setModel, setPermissionMode, getPermissionMode: () => permissionModeForSdk(mode), process: () => leaderProcessState(child, killFailed) };
}
