import { LEADER_START_TIMEOUT_MS } from "../leader-common/types.ts";

export const OPENCODE_START_TIMEOUT_MESSAGE = `OpenCode did not start within ${LEADER_START_TIMEOUT_MS / 1000} seconds`;

// Response bodies can contain credentials, even on a failed request.
export async function readApiResponse(response: Response, method: string, path: string): Promise<any> {
  const text = await response.text();
  // Only fixed operation labels and status codes. Never log response bodies, headers or ids.
  const operation = path.endsWith("/prompt_async") ? "send message" : path.startsWith("/permission/") ? "answer approval" : path.startsWith("/question/") ? "answer question" : "session request";
  if (!response.ok) {
    console.warn("[OpenCode] Request failed", { reason: "api-response", operation, method, status: response.status });
    throw new Error("OpenCode could not finish this turn. Try again.");
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    console.warn("[OpenCode] Unreadable response", { reason: "unreadable-response", operation, method, status: response.status });
    throw new Error("OpenCode could not finish this turn. Try again.");
  }
}

export type OpencodeFailureReason = "turn-end" | "permission-reply" | "question-reject" | "session-error" | "stream" | "stream-end" | "spawn" | "exit" | "timeout" | "start" | "prompt";
export function plainOpencodeFailure(message: string, reason: OpencodeFailureReason, error?: unknown): string {
  console.warn("[OpenCode] Run stopped", { reason, ...(error instanceof Error ? { kind: error.name.slice(0, 64) } : {}) });
  if (message === "leader session ended; a new one will start on the next message") return "The OpenCode session ended. Send your message again.";
  if (message === OPENCODE_START_TIMEOUT_MESSAGE) return `${OPENCODE_START_TIMEOUT_MESSAGE}. Try again.`;
  if (message === "OpenCode could not start. Try again.") return message;
  if (message === "OpenCode exited before it started; is it installed?") return message;
  return "OpenCode could not finish this turn. Try again.";
}
