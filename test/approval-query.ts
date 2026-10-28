// Fake only at query(), so the real createLeader -> buildLeaderOptions call site runs.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export function query({ prompt, options }: any) {
  const output: any[] = []; let wake: (() => void) | undefined; let stopped = false;
  let mode = options.permissionMode;
  const controller = new AbortController();
  // FAKE_CLAUDE_SPAWN=1: the SDK would start claude.exe through the leader's own spawn; this stand-in does the same with a Node process and reports its pid.
  if (process.env.FAKE_CLAUDE_SPAWN === "1") {
    const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: { ...process.env }, signal: options.abortController.signal });
    process.send?.({ type: "claudeSpawned", pid: child.pid });
  }
  // "end-query": the CLI process ends on its own (iterator ends without an intentional stop).
  // "throw-query" (or a { crashQuery: true } request): the iterator throws instead of ending.
  let crash: Error | undefined;
  const receive = (message: any) => { if (message === "abort-approval") controller.abort(); if (message === "end-query") { stopped = true; wake?.(); inboxWake?.(); } if (message === "throw-query") { crash = new Error("fake query crashed"); wake?.(); inboxWake?.(); } };
  process.on("message", receive);
  // Messages are read the moment they arrive (a steer lands while a turn runs, and the log says so); the loop below takes them one turn at a time.
  // Like the real CLI it echoes each message it starts on (isReplay), a message that arrives mid-turn is folded into that turn unless the turn says noFold
  // (then it waits for its own turn and its own result), and { say } / { wait } steps play text and time (FAKE_CLAUDE_NO_REPLAY=1: an older CLI that never echoes).
  const inbox: any[] = []; let inboxWake: (() => void) | undefined; let turnOpen = false, noFold = false;
  const textOf = (message: any): string => message.message.content[0].text;
  const stepsIn = (text: string): any[] | null => { const current = text.lastIndexOf("Current message:\n"), listAt = text.indexOf("[{", Math.max(current, 0)); return listAt < 0 ? null : JSON.parse(text.slice(listAt)); };
  (async () => {
    for await (const message of prompt) {
      // Every text this leader is given is logged, like the Codex and OpenCode fakes do, so a test can read exactly what it received.
      if (process.env.FAKE_LEADER_LOG) appendFileSync(process.env.FAKE_LEADER_LOG, JSON.stringify({ cli: "claude", userText: textOf(message), whileTurnOpen: turnOpen, imageBlocks: message.message.content.filter((block: any) => block.type === "image").length }) + "\n");
      inbox.push(message); inboxWake?.();
    }
  })().catch((error) => process.send?.({ type: "fakeError", message: error.message }));
  // Like the real CLI it echoes only when it was started with --replay-user-messages (the leader passes that in extraArgs); without the flag every Claude steer would be refused.
  const replay = (message: any) => { if (process.env.FAKE_CLAUDE_NO_REPLAY !== "1" && options.extraArgs && "replay-user-messages" in options.extraArgs) { output.push({ type: "user", isReplay: true, uuid: message.uuid, message: message.message, parent_tool_use_id: null, session_id: "fake" }); wake?.(); } };
  const say = (text: string) => { output.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }); wake?.(); };
  // Pack 14, the measured shapes (probe 2026-10-17): stream_event message_start / content_block_start (a tool_use block carries its NAME and id, never its input), the
  // assistant message that holds the input, the user message that holds the tool_result, and system background_tasks_changed { tasks: [{ task_id, run_id, task_type, description }] }.
  const emit = (message: any) => { output.push(message); wake?.(); };
  // parent: the id of the tool call that started the sub-agent this event belongs to (the CLI marks a sub-agent's own messages that way).
  const blockStart = (content_block: any, parent: string | null = null) => emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block }, parent_tool_use_id: parent });
  // The steps a test plays: block "text" | "thinking" starts a block; message starts a new assistant message; toolUse { id, name, input } runs a tool call (input is secret-laden on purpose);
  // toolResult { id, output } ends it; bgJobs [{ id, description }] is the CLI's full background list; followUp [steps] + after is a turn the CLI starts BY ITSELF after this turn's result.
  const STEP_KEYS = ["say", "wait", "noFold", "block", "message", "toolUse", "toolResult", "bgJobs", "followUp"];
  const followUps: Array<{ steps: any[]; after: number }> = [];
  const play = async (steps: any[]) => {
    for (const step of steps) {
      if (step.noFold) noFold = true;
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      if (step.message) emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg", role: "assistant", content: [] } }, parent_tool_use_id: step.parent ?? null });
      if (step.block) blockStart({ type: step.block });
      if (step.toolUse) {
        blockStart({ type: "tool_use", id: step.toolUse.id, name: step.toolUse.name }, step.toolUse.parent ?? null);
        emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: step.toolUse.id, name: step.toolUse.name, input: step.toolUse.input ?? {} }] }, parent_tool_use_id: step.toolUse.parent ?? null, session_id: "fake" });
      }
      if (step.toolResult) emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: step.toolResult.id, content: step.toolResult.output ?? "" }] }, parent_tool_use_id: step.toolResult.parent ?? null, session_id: "fake" });
      if (step.bgJobs) emit({ type: "system", subtype: "background_tasks_changed", tasks: step.bgJobs.map((job: any) => ({ task_id: job.id, run_id: `run-${job.id}`, task_type: "local_bash", description: job.description })), session_id: "fake" });
      if (step.followUp) followUps.push({ steps: step.followUp, after: step.after ?? 200 });
      if (step.say !== undefined) say(step.say);
      await fold();
    }
  };
  const fold = async () => { while (!noFold && !stopped && inbox.length) { const folded = inbox.shift(); replay(folded); const nested = stepsIn(textOf(folded)); if (nested) await play(nested.filter((step) => step.say !== undefined || step.wait)); else say(`[folded: ${textOf(folded).slice(0, 40)}]`); } };
  (async () => {
    while (!stopped) {
      if (!inbox.length) { await new Promise<void>((resolve) => { inboxWake = resolve; }); continue; }
      const message = inbox.shift();
      const text = textOf(message);
      turnOpen = true; noFold = false; replay(message);
      // Save asks the leader to Write the handover; an allowed Write really writes it, a denied one does not.
      const handover = text.startsWith("Save a concise handover") ? text.match(/ to (.+RESUME\.md)\./)?.[1] : undefined;
      // The requests are the part after "Current message:" (the chat handed back before it may hold anything); a plain message has none.
      const requests = handover
        ? [{ tool: "Write", input: { file_path: handover, content: "handover" }, handover }]
        : stepsIn(text) ?? [];
      process.send?.({ type: "queryStarted", registered: Boolean(options.hooks?.PreToolUse?.length), timeout: options.hooks?.PreToolUse?.[0]?.timeout, sources: options.settingSources, extraArgs: options.extraArgs });
      // A { failTurn: true } request ends the turn with an error result, the CLI staying alive (the leader reports a failed turn, not a dead leader).
      const failTurn = requests.some((request: any) => request.failTurn);
      if (requests.some((request: any) => request.crashQuery)) { crash = new Error("fake query crashed"); turnOpen = false; wake?.(); continue; }
      const isStep = (request: any) => STEP_KEYS.some((key) => request[key] !== undefined);
      await Promise.all(requests.filter((request: any) => !request.failTurn && !isStep(request)).map(async (request: any) => {
        if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, request.delayMs));
        const result = request.canUseTool
          ? await options.canUseTool(request.tool, request.input, { signal: controller.signal })
          : await options.hooks?.PreToolUse?.[0]?.hooks[0]({ hook_event_name: "PreToolUse", tool_name: request.tool, tool_input: request.input, tool_use_id: "measured-id", permission_mode: request.permissionMode ?? mode }, "measured-id", { signal: controller.signal }) ?? {};
        if (request.handover) await new Promise((resolve) => setTimeout(resolve, Number(process.env.CC_TEST_SAVE_WRITE_DELAY_MS ?? 0)));
        if (request.handover && result?.hookSpecificOutput?.permissionDecision !== "deny") { mkdirSync(dirname(request.handover), { recursive: true }); writeFileSync(request.handover, "handover"); }
        process.send?.({ type: "hookResult", tool: request.tool, result });
      }));
      await play(requests.filter(isStep));
      await fold();
      turnOpen = false;
      if (!stopped) { output.push({ type: "result", subtype: failTurn ? "error_during_execution" : "success", is_error: failTurn,...(process.env.FAKE_CLAUDE_SESSION_ID ? { session_id: process.env.FAKE_CLAUDE_SESSION_ID } : {}) }); wake?.(); }
      // A turn the CLI starts by itself (a finished background job): no message of ours behind it, then a second result.
      for (const later of followUps.splice(0)) {
        await new Promise((resolve) => setTimeout(resolve, later.after));
        if (stopped) break;
        turnOpen = true; await play(later.steps.filter(isStep)); turnOpen = false;
        if (!stopped) emit({ type: "result", subtype: "success", is_error: false, origin: "background" });
      }
    }
  })().catch((error) => process.send?.({ type: "fakeError", message: error.message }));
  return {
    async *[Symbol.asyncIterator]() { while (!stopped) { if (!output.length && !crash) await new Promise<void>((resolve) => { wake = resolve; }); if (crash) throw crash; if (output.length) yield output.shift(); } },
    // FAKE_CLAUDE_STOP_DELAY_MS: the stream ends that long after the leader's stop, as a CLI that takes its time to exit does (its adapter's end-of-stream handling then runs late).
    async return() { if (process.env.FAKE_CLAUDE_STOP_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_STOP_DELAY_MS))); stopped = true; process.off("message", receive); wake?.(); inboxWake?.(); return { done: true }; },
    async setModel() {}, async setPermissionMode(value: string) {
      // FAKE_CLAUDE_MODE_DELAY_MS: the change takes that long to reach the CLI, so a test can queue another change behind it.
      process.send?.({ type: "modeChangeStarted" });
      if (process.env.FAKE_CLAUDE_MODE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_MODE_DELAY_MS)));
      mode = value;
    },
  };
}
