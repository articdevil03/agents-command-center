import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CrewMember } from "./config.ts";

const SERVER_NAME = "tab-crew";
export const LAUNCH_BRIEF_MAX_CHARS = 200_000;
export type LaunchResult = { ok: true } | { ok: false; error: string };
export type LeaderToolSeat = CrewMember & { seatKey: string; isLeader: boolean };
export type LeaderRequest = { id: string; fromTabId: string; toTabId: string; title: string; body: string; status: string; createdAt: number };
export type LeaderToolDeps = {
  tabName: string;
  crew: () => LeaderToolSeat[];
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
  const getCrewStatus: LeaderToolSpec = spec(
    "get_crew_status",
    "List the crew in this tab with each seat's model, effort, CLI, and live status. This tool is scoped to the current tab.",
    {},
    async () => {
      const crew = deps.crew();
      lastSeen = new Map(crew.map((seat) => [seat.slot, { model: seat.model, effort: seat.effort, cli: seat.cli }]));
      return { content: [{ type: "text", text: JSON.stringify({ tab: deps.tabName, crew: crew.map((seat) => ({
        slot: seat.slot, seatKey: seat.seatKey, name: seat.name, cli: seat.cli, model: seat.model, effort: seat.effort,
        status: deps.statusOf(seat.seatKey), runnable: !seat.isLeader,
      })) }) }] };
    },
  );
  const launchSeat: LeaderToolSpec = spec(
    "launch_seat",
    "Launch a non-leader seat in this tab on a brief. Use a slot from get_crew_status. Launches with the current saved seat settings.",
    // A brief goes to a file, so it may be long, but not without end: a model's runaway output would otherwise ride in every state message.
    { slot: z.string(), brief: z.string().max(LAUNCH_BRIEF_MAX_CHARS) },
    async ({ slot, brief }) => {
      const before = lastSeen.get(slot);
      const result = await deps.launch(slot, brief);
      if (!result.ok) return { content: [{ type: "text", text: `launch failed: ${result.error}` }], isError: true };
      const live = deps.crew().find((seat) => seat.slot === slot);
      const changed = live && before && (before.model !== live.model || before.effort !== live.effort || before.cli !== live.cli);
      const note = changed ? ` (seat settings changed since the last status check; launched with ${live.cli}/${live.model}/${live.effort})` : "";
      return { content: [{ type: "text", text: `launched "${live?.seatKey ?? slot}"${note}` }] };
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
  return [getCrewStatus, launchSeat, sendRequest, listRequests];
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
