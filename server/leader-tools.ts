import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const SERVER_NAME = "tab-crew";
export const LAUNCH_BRIEF_MAX_CHARS = 200_000;
export type LaunchResult = { ok: true; runId: string } | { ok: false; error: string };
// The leader's tools on a fixed crew are the fixed specs the server supplies; tabName only names the tab for the caller.
export type LeaderToolDeps = {
  fixedSpecs: () => LeaderToolSpec[];
  tabName?: string;
};

// One definition per crew tool, served three ways: SDK MCP (Claude), Codex dynamicTools, and the OpenCode MCP bridge.
export type ToolContent = { content: { type: "text"; text: string }[]; isError?: true };
export type LeaderToolSpec = { name: string; description: string; shape: Record<string, z.ZodType>; handler: (args: any) => Promise<ToolContent> };
export type ToolRun = { text: string; isError: boolean };

export function buildLeaderToolSpecs(deps: LeaderToolDeps): LeaderToolSpec[] {
  if (typeof deps?.fixedSpecs !== "function") throw new Error("the leader's tools are the fixed crew tools: fixedSpecs is required");
  return deps.fixedSpecs();
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
