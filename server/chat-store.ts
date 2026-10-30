import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "./data-root.ts";
import { keepBadCopy } from "./safe-file.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A job a Planner handed the leader: the full brief the leader was sent (the notice text shows it cut).
export type JobNotice = { from: string; brief: string };
export type ChatMessage = { tabId: string; revision: number; role: "user" | "assistant" | "notice"; text: string; images?: string[]; files?: string[]; requestId?: string; job?: JobNotice; at: number };
type ChatLine =
  | ({ type: "message" } & ChatMessage)
  | { type: "clear"; tabId: string; revision: number; at: number }
  | { type: "restore"; tabId: string; messages: ChatMessage[]; revision: number; savedRevision: number; at: number }
  | { type: "saved"; tabId: string; savedRevision: number; at: number };
// "notice" is a quiet line from Command Center itself (a heads-up): shown in the chat, never part of what the leader is told. The one exception is a notice carrying `job`: the leader's own brief.
const ROLES = new Set(["user", "assistant", "notice"]);
const isJobNotice = (value: unknown): value is JobNotice => typeof value === "object" && value !== null && typeof (value as JobNotice).from === "string" && typeof (value as JobNotice).brief === "string";
export type ChatSnapshot = { messages: ChatMessage[]; revision: number; savedRevision: number };

export function isTabSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isSafeRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export function readChatRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeRequestId(value)) throw new Error("invalid request id");
  return value;
}

export function chatMessageEvent(message: ChatMessage): { type: "chatMessage" } & ChatMessage {
  return { type: "chatMessage", ...message };
}

export function chatRequestErrorDetails(message: { type: string; tabId?: unknown; projectId?: unknown; requestId?: unknown }): Record<string, unknown> {
  const target = Object.fromEntries(([["tabId", message.tabId], ["projectId", message.projectId]] as const)
    .filter(([, value]) => typeof value === "string"));
  if (isSafeRequestId(message.requestId)) target.requestId = message.requestId;
  return { action: message.type, ...target };
}

export class ChatStore {
  readonly directory: string;
  private readonly snapshots = new Map<string, ChatSnapshot>();
  // A file that ends in a torn line (no newline) must not get the next message glued onto that line.
  private readonly unterminated = new Set<string>();

  constructor(directory = join(resolveDataRoot(process.env, repoRoot), "chats")) {
    this.directory = directory;
  }

  private path(tabId: string): string {
    if (!isTabSlug(tabId)) throw new Error(`unsafe tab id: ${tabId}`);
    return join(this.directory, `${tabId}.jsonl`);
  }

  private load(tabId: string): ChatSnapshot {
    const cached = this.snapshots.get(tabId);
    if (cached) return cached;
    const current: ChatSnapshot = { messages: [], revision: 0, savedRevision: 0 };
    let raw: string;
    try { raw = readFileSync(this.path(tabId), "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") { this.snapshots.set(tabId, current); return current; }
      throw err;
    }
    if (raw && !raw.endsWith("\n")) this.unterminated.add(tabId);
    // A line that is not JSON (a write cut short by a crash or power loss) is skipped so the rest of the chat loads.
    const torn: number[] = [];
    let newerRoles = 0;
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line) continue;
      let entry: ChatLine;
      try { entry = JSON.parse(line) as ChatLine; }
      catch { torn.push(index + 1); continue; }
      if (!entry || entry.tabId !== tabId || !Number.isSafeInteger(entry.revision) && entry.type !== "saved") {
        throw new Error(`invalid chat transcript ${tabId}.jsonl at line ${index + 1}`);
      }
      // A line from a newer version with a role this one does not know is skipped like a torn line, so it never makes the chat unreadable.
      if (entry.type === "message" && typeof entry.role === "string" && !ROLES.has(entry.role)) { torn.push(index + 1); continue; }
      if (entry.type === "message") {
        if (!ROLES.has(entry.role) || typeof entry.text !== "string" || !Array.isArray(entry.images ?? []) || (entry.images ?? []).some((image) => typeof image !== "string") || !Array.isArray(entry.files ?? []) || (entry.files ?? []).some((file) => typeof file !== "string") || (entry.requestId !== undefined && !isSafeRequestId(entry.requestId)) || (entry.job !== undefined && !isJobNotice(entry.job))) {
          throw new Error(`invalid chat message ${tabId}.jsonl at line ${index + 1}`);
        }
        current.revision = Math.max(current.revision, entry.revision);
        current.messages.push({
          tabId: entry.tabId,
          revision: entry.revision,
          role: entry.role,
          text: entry.text,
          ...(entry.images?.length ? { images: [...entry.images] } : {}),
          ...(entry.files?.length ? { files: [...entry.files] } : {}),
          ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
          ...(entry.job !== undefined ? { job: { from: entry.job.from, brief: entry.job.brief } } : {}),
          at: entry.at,
        });
      } else if (entry.type === "clear") {
        current.revision = Math.max(current.revision, entry.revision);
        current.messages = [];
        current.savedRevision = 0;
      } else if (entry.type === "restore") {
        // Messages with a role from a newer version are dropped like the message rows above; everything else stays strict.
        const known = Array.isArray(entry.messages) ? entry.messages.filter((message) => !(message && typeof message.role === "string" && !ROLES.has(message.role))) : entry.messages;
        if (Array.isArray(known)) newerRoles += entry.messages.length - known.length;
        const validMessages = Array.isArray(known) && known.every((message) =>
          message && message.tabId === tabId && Number.isSafeInteger(message.revision) && message.revision > 0 && message.revision <= entry.revision
          && ROLES.has(message.role) && typeof message.text === "string"
          && Array.isArray(message.images ?? []) && (message.images ?? []).every((image) => typeof image === "string")
          && Array.isArray(message.files ?? []) && (message.files ?? []).every((file) => typeof file === "string")
          && (message.requestId === undefined || isSafeRequestId(message.requestId))
          && (message.job === undefined || isJobNotice(message.job)),
        );
        if (!validMessages || !Number.isSafeInteger(entry.savedRevision) || entry.savedRevision < 0 || entry.savedRevision > entry.revision || (entry.revision > current.revision && !torn.length)) {
          throw new Error(`invalid transcript restore in ${tabId}.jsonl at line ${index + 1}`);
        }
        current.messages = known.map((message) => ({ ...message, ...(message.images?.length ? { images: [...message.images] } : {}), ...(message.files?.length ? { files: [...message.files] } : {}) }));
        current.revision = entry.revision;
        current.savedRevision = entry.savedRevision;
      } else if (entry.type === "saved") {
        if (!Number.isSafeInteger(entry.savedRevision) || entry.savedRevision < 0 || (entry.savedRevision > current.revision && !torn.length)) {
          throw new Error(`invalid saved revision in ${tabId}.jsonl at line ${index + 1}`);
        }
        // A skipped torn line may have held the revision this marker names: clamp to what loaded.
        current.savedRevision = Math.min(entry.savedRevision, current.revision);
      } else {
        throw new Error(`unknown chat transcript event ${tabId}.jsonl at line ${index + 1}`);
      }
    }
    if (torn.length) console.error(`chat transcript ${tabId}.jsonl: skipped ${torn.length} unreadable line(s) (line ${torn.join(", ")}); the other lines loaded`);
    if (newerRoles) console.error(`chat transcript ${tabId}.jsonl: skipped ${newerRoles} restored message(s) with a role from a newer version`);
    this.snapshots.set(tabId, current);
    return current;
  }

  snapshot(tabId: string): ChatSnapshot {
    const value = this.load(tabId);
    return { messages: value.messages.map((message) => ({ ...message, ...(message.images ? { images: [...message.images] } : {}), ...(message.files ? { files: [...message.files] } : {}) })), revision: value.revision, savedRevision: value.savedRevision };
  }

  // A transcript that cannot be read opens as an empty chat at revision 0 (the tab's chatProblem says why), so a damaged tab can still be selected and cleared.
  snapshotOrEmpty(tabId: string): ChatSnapshot {
    try { return this.snapshot(tabId); }
    catch { return { messages: [], revision: 0, savedRevision: 0 }; }
  }

  // Clear on a transcript that cannot be read: the damaged file is kept as "<name>.bad-<time>" and the chat starts empty. False when it was readable.
  setAsideIfUnreadable(tabId: string): boolean {
    try { this.load(tabId); return false; } catch { /* unreadable: handled below */ }
    const path = this.path(tabId);
    keepBadCopy(path);
    unlinkSync(path);
    this.forget(tabId);
    return true;
  }

  // The two counters every state message needs, without copying the whole transcript.
  counters(tabId: string): { revision: number; savedRevision: number } {
    const value = this.load(tabId);
    return { revision: value.revision, savedRevision: value.savedRevision };
  }

  // A removed tab: its in-memory transcript goes (the file stays on disk, so no chat is ever deleted by this).
  forget(tabId: string): void {
    this.snapshots.delete(tabId);
    this.unterminated.delete(tabId);
  }

  appendMessage(tabId: string, role: ChatMessage["role"], text: string, images: string[] = [], at = Date.now(), requestId?: string, files: string[] = []): ChatMessage {
    if (typeof text !== "string") throw new Error("chat text must be a string");
    if (requestId !== undefined && !isSafeRequestId(requestId)) throw new Error("invalid request id");
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) throw new Error("chat files must be paths");
    return this.add(tabId, { role, text, ...(images.length ? { images: [...images] } : {}), ...(files.length ? { files: [...files] } : {}), ...(requestId !== undefined ? { requestId } : {}), at });
  }

  // A job handed to the leader: a notice in the chat that also carries the full brief, so the leader's rebuilt context and Save's history can tell it.
  appendJobNotice(tabId: string, text: string, job: JobNotice): ChatMessage {
    if (typeof text !== "string" || !isJobNotice(job)) throw new Error("invalid job notice");
    return this.add(tabId, { role: "notice", text, job: { from: job.from, brief: job.brief }, at: Date.now() });
  }

  private add(tabId: string, fields: Omit<ChatMessage, "tabId" | "revision">): ChatMessage {
    const current = this.load(tabId);
    const message: ChatMessage = { tabId, revision: current.revision + 1, ...fields };
    this.append({ type: "message", ...message });
    current.revision = message.revision;
    current.messages.push(message);
    return message;
  }

  clear(tabId: string, at = Date.now()): ChatSnapshot {
    const current = this.load(tabId);
    const revision = current.revision + 1;
    this.append({ type: "clear", tabId, revision, at });
    current.revision = revision;
    current.savedRevision = 0;
    current.messages = [];
    return this.snapshot(tabId);
  }

  restore(tabId: string, snapshot: ChatSnapshot, at = Date.now()): ChatSnapshot {
    const current = this.load(tabId);
    const validMessages = Array.isArray(snapshot.messages) && snapshot.messages.every((message) =>
      message && message.tabId === tabId && Number.isSafeInteger(message.revision) && message.revision > 0 && message.revision <= snapshot.revision
      && ROLES.has(message.role) && typeof message.text === "string"
      && Array.isArray(message.images ?? []) && (message.images ?? []).every((image) => typeof image === "string")
      && Array.isArray(message.files ?? []) && (message.files ?? []).every((file) => typeof file === "string")
      && (message.requestId === undefined || isSafeRequestId(message.requestId))
      && (message.job === undefined || isJobNotice(message.job)),
    );
    if (!validMessages || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.revision > current.revision
      || !Number.isSafeInteger(snapshot.savedRevision) || snapshot.savedRevision < 0 || snapshot.savedRevision > snapshot.revision) {
      throw new Error("invalid transcript restore");
    }
    const messages = snapshot.messages.map((message) => ({ ...message, ...(message.images?.length ? { images: [...message.images] } : {}), ...(message.files?.length ? { files: [...message.files] } : {}) }));
    this.append({ type: "restore", tabId, messages, revision: snapshot.revision, savedRevision: snapshot.savedRevision, at });
    current.messages = messages;
    current.revision = snapshot.revision;
    current.savedRevision = snapshot.savedRevision;
    return this.snapshot(tabId);
  }

  markSaved(tabId: string, savedRevision: number, at = Date.now()): ChatSnapshot {
    const current = this.load(tabId);
    if (!Number.isSafeInteger(savedRevision) || savedRevision < 0 || savedRevision > current.revision) throw new Error("invalid saved chat revision");
    this.append({ type: "saved", tabId, savedRevision, at });
    current.savedRevision = savedRevision;
    return this.snapshot(tabId);
  }

  private append(line: ChatLine): void {
    mkdirSync(this.directory, { recursive: true });
    const lead = this.unterminated.has(line.tabId) ? "\n" : "";
    // A failed write may still have put part of the line on disk: the next one starts on a fresh line instead of being glued to it.
    try { appendFileSync(this.path(line.tabId), `${lead}${JSON.stringify(line)}\n`, "utf8"); }
    catch (err) { this.unterminated.add(line.tabId); throw err; }
    this.unterminated.delete(line.tabId);
  }
}

export const defaultChatDirectory = join(resolveDataRoot(process.env, repoRoot), "chats");
