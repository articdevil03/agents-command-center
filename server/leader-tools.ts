import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CrewMember } from "./config.ts";
import type { Step } from "./process.ts";

const SERVER_NAME = "tab-crew";
export const LAUNCH_BRIEF_MAX_CHARS = 200_000;
export type LaunchResult = { ok: true; runId: string } | { ok: false; error: string };
export type LeaderToolSeat = CrewMember & { seatKey: string; isLeader: boolean };
export type LeaderRequest = { id: string; fromTabId: string; toTabId: string; title: string; body: string; status: string; createdAt: number };
// Where the tab's process stands, for the crew status (a seat that runs the process reads it to know what to do next).
export type ProcessView = { stepId: string | null; stepLabel: string | null; stepType: string | null; phase: string; round: number; look: "none" | "not reached" | "waiting" | "approved"; orchestrator: string | null };
export type StepBarItem = { stepId: string; label: string; type: string; state: string; owners: readonly string[] };
// What a step tool answers: whether the process moved, why it did not, and the step bar as it is now.
export type StepResult = { changed: boolean; reason?: string; stepBar: readonly StepBarItem[] };
// The same engine functions as the page's buttons; only the seat that runs the process gets these.
export type StepOps = {
  advance: (fromStepId: string) => StepResult;
  reportRound: (round: number, outcome: "findings" | "clean") => StepResult;
  finishFix: (round: number) => StepResult;
};
export type WaitedRun = { runId: string; seatKey: string; status: string; outcome: string | null; logPath: string | null; tail: string };
export const WAIT_MAX_RUNS = 8;
export const WAIT_MAX_SECONDS = 120;
export type LeaderToolDeps = {
  tabName: string;
  crew: () => LeaderToolSeat[];
  // The process steps (owners and reviewer pairs) of this tab, so the leader hands each step's work to its owner.
  steps?: () => Step[];
  // Who is asking: undefined is the tab leader; a seat's run names its slot. A seat cannot launch itself; only the seat running the process can give the leader jobs.
  callerSlot?: string;
  // On the seat that runs the process: a step the leader owns goes to the leader as a job in its chat (launch_seat on the leader's slot), so the leader is runnable.
  leaderTakesJobs?: boolean;
  // On the leader of a tab where another seat runs the process: the one seat it may launch (the leader only talks).
  onlyLaunchable?: () => string | undefined;
  processView?: () => ProcessView;
  stepOps?: StepOps;
  waitForRuns?: (runIds: string[], maxWaitSeconds: number) => Promise<WaitedRun[]>;
  statusOf: (seatKey: string) => string;
  launch: (slot: string, brief: string) => LaunchResult | Promise<LaunchResult>;
  sendRequest?: (toTabId: string, title: string, body: string) => { ok: true; request: LeaderRequest; requestId: string } | { ok: false; error: string };
  listRequests?: () => LeaderRequest[];
};
export const LEADER_ALLOWED_TOOLS = [
  `mcp__${SERVER_NAME}__get_crew_status`,
  `mcp__${SERVER_NAME}__launch_seat`,
  `mcp__${SERVER_NAME}__send_request`,
  `mcp__${SERVER_NAME}__list_requests`,
];

// One definition per crew tool, served three ways: SDK MCP (Claude), Codex dynamicTools, and the OpenCode MCP bridge.
export type ToolContent = { content: { type: "text"; text: string }[]; isError?: true };
export type LeaderToolSpec = { name: string; description: string; shape: Record<string, z.ZodType>; handler: (args: any) => Promise<ToolContent> };
export type ToolRun = { text: string; isError: boolean };

export function buildLeaderToolSpecs(deps: LeaderToolDeps): LeaderToolSpec[] {
  let lastSeen = new Map<string, { model: string; effort: string; cli: string }>();
  const leaderJobs = deps.leaderTakesJobs === true ? " A step the leader owns goes to the leader the same way: launch_seat with the leader's slot puts the brief into the leader's chat as a job (one at a time; it waits for the leader's current reply), and wait_for_runs on the returned run id gives the leader's reply as the tail." : "";
  const getCrewStatus: LeaderToolSpec = spec(
    "get_crew_status",
    "List the crew in this tab with each seat's role, model, effort, CLI, whether it can write, its advisor and live status, and the process steps. Each step names its owner seat; hand a step's work to its owner. The steps come from the seats' roles: a crew with none of Planner, Coder, Design coder, Reviewer, Fixer or Final reviewer has no steps, and then you do the work and ask a Researcher or Helper by name. This tool is scoped to the current tab." + leaderJobs,
    {},
    async () => {
      const crew = deps.crew();
      lastSeen = new Map(crew.map((seat) => [seat.slot, { model: seat.model, effort: seat.effort, cli: seat.cli }]));
      const only = deps.onlyLaunchable?.();
      return { content: [{ type: "text", text: JSON.stringify({ tab: deps.tabName, crew: crew.map((seat) => ({
        slot: seat.slot, seatKey: seat.seatKey, name: seat.name, role: seat.role, cli: seat.cli, model: seat.model, effort: seat.effort,
        advisor: seat.advisor ?? null, canWrite: seat.canWrite, orchestrates: seat.orchestrates === true,
        status: deps.statusOf(seat.seatKey), runnable: (!seat.isLeader || deps.leaderTakesJobs === true) && seat.slot !== deps.callerSlot && (only === undefined || seat.slot === only),
      })), steps: deps.steps?.() ?? [], process: deps.processView?.() ?? null }) }] };
    },
  );
  const launchSeat: LeaderToolSpec = spec(
    "launch_seat",
    (deps.leaderTakesJobs === true ? "Launch a seat" : "Launch a non-leader seat") + " in this tab on a brief. Use a slot from get_crew_status. Launches with the current saved seat settings." + leaderJobs,
    // A brief goes to a file, so it may be long, but not without end: a model's runaway output would otherwise ride in every state message.
    { slot: z.string(), brief: z.string().max(LAUNCH_BRIEF_MAX_CHARS) },
    async ({ slot, brief }) => {
      const before = lastSeen.get(slot);
      const result = await deps.launch(slot, brief);
      if (!result.ok) return { content: [{ type: "text", text: `launch failed: ${result.error}` }], isError: true };
      const live = deps.crew().find((seat) => seat.slot === slot);
      const changed = live && before && (before.model !== live.model || before.effort !== live.effort || before.cli !== live.cli);
      const note = changed ? ` (seat settings changed since the last status check; launched with ${live.cli}/${live.model}/${live.effort})` : "";
      return { content: [{ type: "text", text: `launched "${live?.seatKey ?? slot}"${result.runId ? ` as run ${result.runId}` : ""}${note}` }] };
    },
  );
  const sendRequest: LeaderToolSpec = spec(
    "send_request",
    "Send a request from this tab to another existing tab. The server validates the destination and persists the request.",
    { toTabId: z.string().min(1).max(128), title: z.string().min(1).max(200), body: z.string().min(1).max(24 * 1024) },
    async ({ toTabId, title, body }) => {
      try {
        const result = deps.sendRequest?.(toTabId, title, body);
        if (!result) return { content: [{ type: "text", text: "send_request is unavailable" }], isError: true };
        if (!result.ok) return { content: [{ type: "text", text: `request failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ requestId: result.requestId, request: result.request }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `request failed: ${error instanceof Error ? error.message : "invalid request"}` }], isError: true };
      }
    },
  );
  const listRequests: LeaderToolSpec = spec(
    "list_requests",
    "List requests addressed to this tab, including their current status.",
    {},
    async () => {
      if (!deps.listRequests) return { content: [{ type: "text", text: "list_requests is unavailable" }], isError: true };
      try { return { content: [{ type: "text", text: JSON.stringify({ tab: deps.tabName, requests: deps.listRequests() }) }] }; }
      catch (error) { return { content: [{ type: "text", text: `list_requests failed: ${error instanceof Error ? error.message : "unavailable"}` }], isError: true }; }
    },
  );
  const specs = [getCrewStatus, launchSeat, sendRequest, listRequests];
  const stepResult = (result: StepResult): ToolContent => ({ content: [{ type: "text", text: JSON.stringify(result) }], ...(result.changed ? {} : { isError: true as const }) });
  // The tools of the seat that runs the process: they wait for runs and move the steps. Present only when the server hands them in.
  const ops = deps.stepOps;
  if (ops) specs.push(
    spec("advance_step", "Move the process to the next step. fromStepId must be the current step (see get_crew_status). Refused while an owner of the current step still has a run working; answers with the new step bar, or why nothing changed. A step you own yourself (Plan, Gate, Ship, and Review or Final review when the leader built the code) you do in your own run, then move on with advance_step or report_round; you cannot launch yourself.",
      { fromStepId: z.string().min(1).max(60) }, async ({ fromStepId }) => stepResult(ops.advance(fromStepId))),
    spec("report_round", "Report how the review round ended: 'findings' sends the round to the fixer, 'clean' moves past the review. round must be the current round. Answers with the new step bar, or why nothing changed.",
      { round: z.number().int().min(1).max(1000), outcome: z.enum(["findings", "clean"]) }, async ({ round, outcome }) => stepResult(ops.reportRound(round, outcome))),
    spec("finish_fix", "Report that the fixer finished the current round's fixes; the next round starts. round must be the current round. Answers with the new step bar, or why nothing changed.",
      { round: z.number().int().min(1).max(1000) }, async ({ round }) => stepResult(ops.finishFix(round))),
  );
  const wait = deps.waitForRuns;
  if (wait) specs.push(spec("wait_for_runs",
    `Wait until every listed run has ended (at most ${WAIT_MAX_SECONDS} seconds per call; call again if some are still working). Answers with each run's status, outcome, log path and the last 8 KB of its output.`,
    { runIds: z.array(z.string().min(1).max(300)).min(1).max(WAIT_MAX_RUNS), maxWaitSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional() },
    async ({ runIds, maxWaitSeconds }) => {
      const runs = await wait(runIds, maxWaitSeconds ?? 60);
      return { content: [{ type: "text", text: JSON.stringify({ allEnded: runs.every((run) => run.status !== "working" && run.status !== "unknown"), runs }) }] };
    }));
  return specs;
}

function spec(name: string, description: string, shape: Record<string, z.ZodType>, handler: LeaderToolSpec["handler"]): LeaderToolSpec {
  return { name, description, shape, handler };
}

export function buildLeaderToolDefs(deps: LeaderToolDeps): SdkMcpToolDefinition[] {
  return buildLeaderToolSpecs(deps).map((s) => tool(s.name, s.description, s.shape as any, s.handler as any));
}

export function leaderToolJsonSchema(s: LeaderToolSpec): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(s.shape)) as Record<string, unknown>;
  return schema;
}

// Codex and the OpenCode bridge call tools by name with raw JSON arguments: validate like the SDK does, never throw.
export async function runLeaderTool(specs: LeaderToolSpec[], name: string, args: unknown): Promise<ToolRun> {
  const found = specs.find((s) => s.name === name);
  if (!found) return { text: `unknown tool: ${name}`, isError: true };
  const parsed = z.object(found.shape).safeParse(args ?? {});
  if (!parsed.success) return { text: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
  try {
    const result = await found.handler(parsed.data);
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  } catch (error) {
    return { text: `${name} failed: ${error instanceof Error ? error.message : "unavailable"}`, isError: true };
  }
}

export function createLeaderTools(deps: LeaderToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SERVER_NAME, version: "1.0.0", tools: buildLeaderToolDefs(deps) });
}
