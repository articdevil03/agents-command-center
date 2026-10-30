import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKUserMessage, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { IMAGE_EXT_TO_MIME } from "./config.ts";
import { usageDeltaFromResult } from "./usage.ts";
import { permissionModeForSdk, type PermissionMode } from "./settings.ts";
import { cleanJobDescription, cleanSkillName, createActivityTracker, createParagraphs, isInsideFolder, leaderChildEnv, leaderProcessState, spawnTrackedClaude, toolActivity, USER_DENIED, type LeaderProcessState, type LeaderCallbacks, type AskApproval, type LeaderHandle } from "./leader-common.ts";

export type { LeaderCallbacks, AskApproval, LeaderHandle };
export { resolveClaudeCli } from "./leader/claude-cli.ts";

export type LeaderOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  model: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  allowDangerouslySkipPermissions: true;
  includePartialMessages: true;
  settingSources: ["user", "project", "local"];
  pathToClaudeCodeExecutable?: string;
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
  extraArgs?: Record<string, string | null>;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  hooks: Options["hooks"];
  canUseTool: Options["canUseTool"];
};

// The leader's own in-process tools (see server/leader-tools.ts) -- omitted
// entirely for the startup health check, which never calls createLeader with
// a third argument, so that throwaway "reply OK" probe never even sees them.
export type LeaderTools = { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] };

// Both the streaming leader and startup health check use these SDK options.
// Neither child may inherit the app's private data root.
// advisor: the Claude model passed as --advisor; it is read when the session starts and only with the native CLI.
export type LeaderSettings = { model: string; effort: string; advisor?: string };
// holdsPlan: the tab is meant to be in Plan. An approved ExitPlanMode puts the live session back in its earlier mode (edits allowed), which must not read as "the user allowed edits".
export function buildLeaderOptions(seat: LeaderSettings, tabFolder: string, cliPath: string | null, tools?: LeaderTools, mode: PermissionMode = "accept", ask: AskApproval = async () => false, savedAsks: () => boolean = () => false, observeMode: (mode: string) => void = () => {}, holdsPlan: () => boolean = () => mode === "plan"): LeaderOptions {
  // The path is resolved once but used for every tab: an executable inside this tab's folder is a planted one.
  if (cliPath && isInsideFolder(cliPath, tabFolder)) throw new Error(`The Claude CLI (${cliPath}) lies inside the tab folder (${tabFolder}); refusing to start it from there.`);
  const approve: AskApproval = async (tool, input, signal) => {
    try { return !signal?.aborted && await ask(tool, input, signal) && !signal?.aborted; }
    catch { return false; }
  };
  const options: LeaderOptions = {
    env: leaderChildEnv(),
    cwd: tabFolder,
    model: seat.model,
    permissionMode: permissionModeForSdk(mode),
    // Without this the SDK refuses a live switch to bypassPermissions on a running
    // session. It changes nothing at start: the mode above still decides that.
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: ["user", "project", "local"],
    hooks: { PreToolUse: [{ timeout: 86400, hooks: [async (event, _id, context) => {
      try {
      if (event.hook_event_name === "PreToolUse" && event.permission_mode) observeMode(event.permission_mode);
      // Ask when the live SDK mode is "default" OR the tab is saved as Ask OR the tab is meant to be in Plan but the live mode left it (after ExitPlanMode): a subagent's own permissionMode or a mode the SDK lands in must not skip the question.
      if (event.hook_event_name !== "PreToolUse" || (event.permission_mode !== "default" && !savedAsks() && !(holdsPlan() && event.permission_mode !== "plan"))) return {};
      if (!["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell"].includes(event.tool_name)) return {};
      const allow = await approve(event.tool_name, event.tool_input as Record<string, unknown>, context.signal);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allow ? "allow" : "deny", ...(allow ? {} : { permissionDecisionReason: USER_DENIED }) } };
      } catch { return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: USER_DENIED } }; }
    }] }] },
    // There is no screen for a question: "Allow" would hand the model an empty answer. Say so, as the Codex and OpenCode leaders do.
    canUseTool: async (tool, input, context) => tool === "AskUserQuestion"
      ? { behavior: "deny", message: "Questions cannot be answered here. Decide yourself, state your assumption in the reply, and continue." }
      : await approve(tool, input, context.signal)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: USER_DENIED },
  };
  // The SDK's own spawn kills only claude.exe on abort; this one tracks and kills the whole tree (background shells, MCP servers).
  options.spawnClaudeCodeProcess = spawnTrackedClaude;
  if (cliPath) {
    options.pathToClaudeCodeExecutable = cliPath;
    // replay-user-messages: the CLI echoes each message we give it the moment it starts on it, which is how a steer is told apart from a message that waits for the next turn (probed 2026-10-16).
    options.extraArgs = { effort: seat.effort, ...(seat.advisor ? { advisor: seat.advisor } : {}), "replay-user-messages": null };
  }
  if (tools) {
    options.mcpServers = tools.mcpServers;
    // Keep crew tools pre-allowed. Any SDK prompt that still reaches this
    // headless leader is answered through canUseTool's browser approval flow.
    options.allowedTools = tools.allowedTools;
  }
  return options;
}

function mediaType(path: string): string {
  return IMAGE_EXT_TO_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function buildContent(text: string, images: string[]): unknown[] {
  const blocks: unknown[] = [{ type: "text", text }];
  for (const path of images) {
    try {
      const data = readFileSync(path).toString("base64");
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType(path), data } });
    } catch {
      // ponytail: an unreadable image path is dropped rather than failing the whole turn.
      blocks.push({ type: "text", text: `[image failed to load: ${path}]` });
    }
  }
  return blocks;
}

// Streaming-input session: one Leader per tab, holding one long-lived
// `claude` subprocess across turns via query()'s AsyncIterable prompt mode.
export function createLeader(seat: LeaderSettings, tabFolder: string, cliPath: string | null, cb: LeaderCallbacks, tools?: LeaderTools, mode: PermissionMode = "accept", ask?: AskApproval, queryFn: typeof query = query, savedAsks?: () => boolean): {
  send: (text: string, images: string[]) => void;
  steer: (text: string, images: string[]) => boolean;
  stop: () => void;
  isDead: () => boolean;
  setModel: (model: string) => Promise<boolean>;
  setPermissionMode: (mode: PermissionMode) => Promise<boolean>;
  getPermissionMode: () => string;
  process: () => LeaderProcessState;
} {
  // Mutable: usageDeltaFromResult (below) must scope a turn's usage/window to
  // whichever model actually produced it, so a successful live switch (see
  // setModel) has to move this forward -- otherwise usage keeps reporting the
  // OLD model and its window after the switch has already taken effect.
  let modelId = seat.model;
  let liveMode: string = permissionModeForSdk(mode);
  let requestedMode: PermissionMode = mode;
  const inbox: SDKUserMessage[] = [];
  let waiter: ((msg: SDKUserMessage | null) => void) | null = null;
  let stopped = false;
  let dead = false;
  // Every message given to the CLI (send and steers) that has no answer yet: uuid -> whether the CLI has started on it (its replay arrived).
  // A steer the CLI folds into its running turn is answered by that turn's one result; one it queues behind gets its own result later.
  const waiting = new Map<string, boolean>();
  let replaySeen = false;
  // A failed result seen while a steer still waits behind it: the turn stays open for that steer's answer and then ends with this failure.
  let failedTurn: string | undefined;
  const abortController = new AbortController();

  async function nextInput(): Promise<SDKUserMessage | null> {
    const queued = inbox.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!stopped) {
      const message = await nextInput();
      if (stopped || message === null) return;
      yield message;
    }
  }

  const options: Options = { abortController, ...buildLeaderOptions(seat, tabFolder, cliPath, tools, mode, ask, savedAsks, (value) => { liveMode = value; }, () => requestedMode === "plan") };

  // The SDK's own spawn is replaced by the tracked one, so a kill that cannot be confirmed is reported and remembered for the tab's next leader.
  let claudeChild: ChildProcess | null = null;
  let killFailed = false;
  options.spawnClaudeCodeProcess = (spawnOptions) => {
    claudeChild = spawnTrackedClaude(spawnOptions, () => { const said = killFailed; killFailed = true; if (!said) cb.onNotice?.("Could not confirm the old Claude leader stopped. Check Task Manager."); });
    return claudeChild;
  };

  const input = inputStream();
  const handle: Query = queryFn({ prompt: input, options });

  // The step line, the paragraph break between separate messages of one reply, and when each background job was first seen.
  const activity = createActivityTracker((label) => cb.onActivity?.(label));
  const paragraphs = createParagraphs();
  let messageKey = 0;
  const jobStarts = new Map<string, number>();

  (async () => {
    let failure: string | undefined;
    try {
      for await (const message of handle) {
        if (stopped) break;
        const sessionId = (message as { session_id?: unknown }).session_id;
        if (typeof sessionId === "string" && sessionId) cb.onSession?.(sessionId);
        // A sub-agent's own messages carry the id of the tool call that started it: they never move the leader's step line or start a paragraph.
        const own = !(message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
        if (message.type === "stream_event") {
          const event = message.event as { type: string; content_block?: { type?: string; id?: string; name?: string }; delta?: { type: string; text?: string } };
          if (own && event.type === "message_start") messageKey++;
          // The tool NAME arrives with the block start, before its input: the earliest signal for the step line (the input is never read, except a Skill's name below).
          if (own && event.type === "content_block_start" && event.content_block) {
            const block = event.content_block;
            if (block.type === "text") { messageKey++; activity.quiet(); }
            else if (block.type === "thinking" || block.type === "redacted_thinking") activity.thinking();
            else if (block.type === "tool_use" && typeof block.id === "string") activity.start(block.id, toolActivity(block.name));
          }
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            cb.onDelta(own ? paragraphs.text(event.delta.text, messageKey) : event.delta.text);
          }
        } else if (message.type === "assistant") {
          // The whole message: a Skill's name lives in its input (an identifier, cleaned); no other input is looked at.
          const blocks = (message as { message?: { content?: unknown } }).message?.content;
          if (own && Array.isArray(blocks)) for (const block of blocks as Array<{ type?: string; id?: string; name?: string; input?: { skill?: unknown } }>) {
            if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
            const step = toolActivity(block.name);
            const skill = block.name === "Skill" ? cleanSkillName(block.input?.skill) : null;
            activity.start(block.id, step && skill ? { ...step, label: `Using skill: ${skill}` } : step);
          }
        } else if (message.type === "user") {
          const echoed = message as { uuid?: unknown; isReplay?: unknown; message?: { content?: unknown } };
          if (echoed.isReplay === true && typeof echoed.uuid === "string" && waiting.has(echoed.uuid)) { waiting.set(echoed.uuid, true); replaySeen = true; }
          // A tool's result ends its step.
          else if (own && Array.isArray(echoed.message?.content)) for (const block of echoed.message.content as Array<{ type?: string; tool_use_id?: unknown }>) if (block?.type === "tool_result" && typeof block.tool_use_id === "string") activity.end(block.tool_use_id);
        } else if (message.type === "system") {
          // The CLI's full list of background shells each time it changes (measured 2026-10-17: background_tasks_changed { tasks: [{ task_id, run_id, task_type, description }] }).
          const system = message as unknown as { subtype?: string; tasks?: Array<{ task_id?: unknown; run_id?: unknown; description?: unknown }> };
          if (system.subtype === "background_tasks_changed" && Array.isArray(system.tasks)) {
            const jobs = system.tasks.map((task) => {
              const id = String(task?.task_id ?? task?.run_id ?? "");
              if (!jobStarts.has(id)) jobStarts.set(id, Date.now());
              return { id, description: cleanJobDescription(task?.description), startedAt: jobStarts.get(id)! };
            });
            for (const id of [...jobStarts.keys()]) if (!jobs.some((job) => job.id === id)) jobStarts.delete(id);
            cb.onBackgroundJobs?.(jobs);
          }
        } else if (message.type === "result") {
          // A reply is over: the next one starts without steps and without text said.
          activity.reset(); paragraphs.reset();
          cb.onUsage(usageDeltaFromResult(message, modelId));
          // A result answers the messages the CLI had started on (all of them when this CLI never echoes: then there is no steering either).
          for (const [id, started] of [...waiting]) if (started || !replaySeen) waiting.delete(id);
          // A failed turn still ends with a result; it must never read as success.
          if (message.is_error) failedTurn = `leader turn failed: ${message.subtype}`;
          // A steer the CLI has not started on yet keeps the turn open (also behind a failed one): its own result ends it, so its answer is never dropped.
          if (!waiting.size) { const ended = failedTurn; failedTurn = undefined; if (ended) cb.onError(ended); else cb.onDone(); }
        }
      }
    } catch (err) {
      if (!stopped) {
        failure = (err as Error).message;
      }
    } finally {
      // The CLI can exit 0 and simply end the iterator without ever throwing.
      // That is still the end of this leader: mark it dead so the next chat
      // starts a fresh one, and say so once (a thrown iterator says why), unless this was an intentional stop.
      // The death is announced (onStop) before the error, like the Codex and OpenCode leaders do.
      dead = true;
      cb.onStop?.();
      if (!stopped) cb.onError(failure ?? "leader session ended; a new one will start on the next message");
    }
  })();

  function give(text: string, images: string[]): void {
    const uuid = randomUUID();
    waiting.set(uuid, false);
    const message = {
      type: "user",
      uuid,
      message: { role: "user", content: buildContent(text, images) },
      parent_tool_use_id: null,
      session_id: "",
    } as unknown as SDKUserMessage;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(message);
    } else {
      inbox.push(message);
    }
  }

  function send(text: string, images: string[] = []): void {
    if (stopped) return;
    if (dead) {
      cb.onError("leader is not available (the agent process ended); starting a new one on the next message");
      return;
    }
    give(text, images);
  }

  // Only while a message of ours is unanswered, and only once this CLI has shown it echoes what it starts on (without that a steer cannot be told from a queued message).
  function steer(text: string, images: string[] = []): boolean {
    if (stopped || dead || !replaySeen || !waiting.size) return false;
    give(text, images);
    return true;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cb.onStop?.();
    inbox.length = 0;
    waiter?.(null);
    waiter = null;
    abortController.abort();
    void input.return();
    void handle.return().catch(() => {});
  }

  // The SDK's own streaming-input control: changes the model for this
  // session's SUBSEQUENT responses without tearing down the child process or
  // its conversation (see Query.setModel in the SDK's runtimeTypes.d.ts --
  // "Only available in streaming input mode", which this leader always is).
  // A stopped/dead handle is a no-op: a fresh leader picks up seat.model on
  // its own next createLeader() call, so there is nothing live left to change.
  // Resolves true/false rather than swallowing the outcome: the caller (the
  // "updateSeat" WS handler) must know whether the switch actually applied
  // before it ever persists or broadcasts the new model -- a picker that
  // claims a change that didn't happen is worse than no control at all.
  function setModel(model: string): Promise<boolean> {
    if (stopped || dead) return Promise.resolve(false);
    return handle.setModel(model).then(
      () => {
        modelId = model;
        return true;
      },
      // The caller (updateSeat) reports a failed change. A turn may be running: reporting it as the turn's error would end that answer early and attach its late text to the next message.
      () => false
    );
  }

  function setPermissionMode(nextMode: PermissionMode): Promise<boolean> {
    if (stopped || dead) return Promise.resolve(false);
    return handle.setPermissionMode(permissionModeForSdk(nextMode)).then(
      () => { if (stopped || dead) return false; liveMode = permissionModeForSdk(nextMode); requestedMode = nextMode; return true; },
      // The caller reports a failed change once; an error here would end a turn that is not ours.
      () => false,
    );
  }

  return { send, steer, stop, isDead: () => stopped || dead, setModel, setPermissionMode, getPermissionMode: () => liveMode, process: () => leaderProcessState(claudeChild, killFailed) };
}
