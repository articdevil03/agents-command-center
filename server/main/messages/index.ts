import type { WebSocket } from "ws";
import { chatRequestErrorDetails } from "../../chat-store.ts";
import { sendError } from "../broadcast.ts";
import { approvalMessages } from "./approvals.ts";
import { chatMessages } from "./chat.ts";
import { processMessages } from "./process.ts";
import { projectMessages } from "./projects.ts";
import { settingsMessages } from "./settings.ts";
import { setupMessages } from "./setups-runs.ts";
import type { MessageHandler } from "./types.ts";
import { describeError } from "../state.ts";

// The handlers by message type. Built on first use: a module cycle must not make the groups read each other while they load.
// A Map, never a plain object: the type comes from the page, and "constructor" or "toString" must not find a function on Object.prototype.
let handlers: Map<string, MessageHandler> | undefined;
function messageHandlers(): Map<string, MessageHandler> {
  handlers ??= new Map([...approvalMessages(), ...settingsMessages(), ...projectMessages(), ...setupMessages(), ...chatMessages(), ...processMessages()]);
  return handlers;
}
export function handleMessage(ws: WebSocket, raw: string): void {
  let message: any;
  try { message = JSON.parse(raw); } catch { sendError(ws, "message must be valid JSON"); return; }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") { sendError(ws, "expected an object with a string type"); return; }
  try {
    const handler = messageHandlers().get(message.type);
    if (!handler) throw new Error(`unknown message type: ${message.type}`);
    handler(ws, message);
  } catch (err) {
    // Name the refused request and its target so the client only rolls back the action this error is about.
    sendError(ws, describeError(err), chatRequestErrorDetails(message));
  }
}
