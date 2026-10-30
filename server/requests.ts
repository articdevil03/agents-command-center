import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isTabSlug } from "./chat-store.ts";
import { keepBadCopy, writeFileSynced, replaceFile } from "./safe-file.ts";

export type RequestStatus = "pending" | "accepted" | "declined" | "destinationRemoved";
export type TabRequest = {
  id: string;
  fromTabId: string;
  toTabId: string;
  title: string;
  body: string;
  status: RequestStatus;
  createdAt: number;
  resolvedAt?: number;
};
export type SendRequestInput = { fromTabId: unknown; toTabId: unknown; title: unknown; body: unknown };

const MAX_TITLE = 200;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_PENDING_PER_SOURCE = 50;
const MAX_RESOLVED_KEPT = 200;
const STATUSES = new Set<RequestStatus>(["pending", "accepted", "declined", "destinationRemoved"]);

function validateMessage(input: SendRequestInput): Omit<TabRequest, "id" | "status" | "createdAt"> {
  if (!isTabSlug(input.fromTabId) || !isTabSlug(input.toTabId)) throw new Error("source and destination tabs are required");
  if (input.fromTabId === input.toTabId) throw new Error("a request must go to another tab");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > MAX_TITLE) throw new Error(`request title must be 1-${MAX_TITLE} characters`);
  if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > MAX_BODY_BYTES) throw new Error(`request body must be non-empty and at most ${MAX_BODY_BYTES} bytes`);
  return { fromTabId: input.fromTabId, toTabId: input.toTabId, title: input.title.trim(), body: input.body.trim() };
}

function validRow(value: unknown): value is TabRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<TabRequest>;
  return typeof row.id === "string" && /^[0-9a-f-]{36}$/i.test(row.id)
    && isTabSlug(row.fromTabId) && isTabSlug(row.toTabId)
    && typeof row.title === "string" && row.title.length > 0 && row.title.length <= MAX_TITLE
    && typeof row.body === "string" && Buffer.byteLength(row.body, "utf8") <= MAX_BODY_BYTES
    && STATUSES.has(row.status as RequestStatus)
    && Number.isSafeInteger(row.createdAt) && (row.resolvedAt === undefined || Number.isSafeInteger(row.resolvedAt));
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSynced(temporary, text);
    replaceFile(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already consumed the temporary file */ }
  }
}

export class RequestsStore {
  readonly path: string;
  private rows: TabRequest[];

  constructor(dataRoot: string) {
    this.path = join(resolve(dataRoot), "requests.json");
    this.rows = [];
    let data: unknown;
    try { data = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A file the app cannot read (empty after a crash, hand-edited) is kept beside it and the list starts empty, so the app still starts.
      keepBadCopy(this.path);
      return;
    }
    if (!Array.isArray(data) || !data.every(validRow) || new Set(data.map((row) => row.id)).size !== data.length) {
      keepBadCopy(this.path);
      return;
    }
    this.rows = data.map((row) => ({ ...row }));
  }

  list(): TabRequest[] { return this.rows.map((row) => ({ ...row })); }

  send(input: SendRequestInput, tabExists: (tabId: string) => boolean, now = Date.now()): TabRequest {
    const checked = validateMessage(input);
    if (!tabExists(checked.fromTabId)) throw new Error("source tab does not exist");
    if (!tabExists(checked.toTabId)) throw new Error("destination tab does not exist");
    if (this.rows.filter((item) => item.fromTabId === checked.fromTabId && item.status === "pending").length >= MAX_PENDING_PER_SOURCE) {
      throw new Error(`too many pending requests from this tab (limit ${MAX_PENDING_PER_SOURCE}); wait for some to be answered`);
    }
    const row: TabRequest = { id: randomUUID(), ...checked, status: "pending", createdAt: now };
    const previous = this.rows;
    // ponytail: trimmed only when a request is sent; resolved rows stay bounded by the pending cap between sends.
    const resolved = previous.filter((item) => item.status !== "pending");
    const dropped = new Set(resolved.slice(0, Math.max(0, resolved.length - MAX_RESOLVED_KEPT)));
    this.rows = [...previous.filter((item) => !dropped.has(item)), row];
    try { atomicWrite(this.path, `${JSON.stringify(this.rows, null, 2)}\n`); }
    catch (error) { this.rows = previous; throw error; }
    return { ...row };
  }

  resolve(id: unknown, status: unknown, resolverTabId: unknown, tabExists: (tabId: string) => boolean, now = Date.now()): TabRequest {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid request id");
    if (status !== "accepted" && status !== "declined") throw new Error("request status must be accepted or declined");
    if (!isTabSlug(resolverTabId) || !tabExists(resolverTabId)) throw new Error("request destination tab does not exist");
    const row = this.rows.find((item) => item.id === id);
    if (!row || row.status !== "pending") throw new Error("request is no longer pending");
    if (row.toTabId !== resolverTabId) throw new Error("request is not addressed to this tab");
    const previous = { ...row };
    row.status = status;
    row.resolvedAt = now;
    try { atomicWrite(this.path, `${JSON.stringify(this.rows, null, 2)}\n`); }
    catch (error) { Object.assign(row, previous); throw error; }
    return { ...row };
  }

  markDestinationRemoved(tabId: string, now = Date.now()): number {
    let changed = 0;
    const previous = this.rows.map((row) => ({ ...row }));
    for (const row of this.rows) {
      if (row.toTabId === tabId && row.status === "pending") {
        row.status = "destinationRemoved";
        row.resolvedAt = now;
        changed++;
      }
    }
    if (changed) {
      try { atomicWrite(this.path, `${JSON.stringify(this.rows, null, 2)}\n`); }
      catch (error) { this.rows = previous; throw error; }
    }
    return changed;
  }

  // The leader's view. A declined request is the user's "no": the leader still sees that it was declined, never what it said.
  incoming(tabId: string): TabRequest[] {
    return this.rows.filter((row) => row.toTabId === tabId).map((row) => ({ ...row, ...(row.status === "declined" ? { body: "" } : {}) }));
  }
  pendingCount(tabId: string): number { return this.rows.filter((row) => row.toTabId === tabId && row.status === "pending").length; }
}
