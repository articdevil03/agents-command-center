import { randomUUID } from "node:crypto";
import type { KeyRecord } from "./cli-key-profiles.ts";

export const UNSAFE_KEY_STORE = "Command Center could not save the key safely on this PC. Nothing was saved.";
export const UNSAFE_KEY_REMOVAL = "Command Center could not remove the key safely on this PC. Check again.";
export class CredentialChangeUnconfirmed extends Error {
  constructor() { super("Could not confirm the change. Check again."); }
}
export class CredentialEncryptionUnavailable extends Error {
  constructor() { super(UNSAFE_KEY_STORE); }
}
export interface CredentialStore {
  available(): boolean;
  // Replacement is atomic, but a timed-out IPC change may still complete.
  set(tool: string, record: KeyRecord): Promise<void>;
  get(tool: string): Promise<KeyRecord | null>;
  remove(tool: string): Promise<void>;
}
export type CredentialChannel = {
  send?: (message: any, callback: (error: Error | null) => void) => unknown;
  connected?: boolean;
  on(event: "message", listener: (message: any) => void): unknown;
  off(event: "message", listener: (message: any) => void): unknown;
};
export class IpcCredentialStore implements CredentialStore {
  private encryptionUnavailable = false;
  private listening = false;
  private pending = new Map<string, (message: any) => void>();
  private receive = (message: any) => {
    if (message?.type === "cliCredentialResult" && typeof message.id === "string") this.pending.get(message.id)?.(message);
  };
  private channel: CredentialChannel;
  private timeoutMs: number;
  constructor(channel: CredentialChannel = process, timeoutMs = 5000) { this.channel = channel; this.timeoutMs = timeoutMs; }
  // Test servers run with a parent that never answers: in fake-CLI mode the real channel holds no keys.
  // Channel availability includes reads and removal, which do not require encryption.
  available(): boolean { if (this.channel === process && process.env.CC_TEST_FAKE_CLI === "1") return false; return !!this.channel.send && this.channel.connected === true; }
  private request(operation: "get" | "set" | "remove", tool: string, record?: KeyRecord): Promise<any> {
    if (!this.available()) return Promise.reject(new Error(UNSAFE_KEY_STORE));
    if (operation === "set" && this.encryptionUnavailable) return Promise.reject(new CredentialEncryptionUnavailable());
    if (!this.listening) { this.channel.on("message", this.receive); this.listening = true; }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (message?: any, timedOut = false) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (!this.pending.size) { this.channel.off("message", this.receive); this.listening = false; }
        if (typeof message?.available === "boolean") this.encryptionUnavailable = !message.available;
        if (timedOut && operation !== "get") reject(new CredentialChangeUnconfirmed());
        else if (operation === "set" && message?.available === false) reject(new CredentialEncryptionUnavailable());
        else if (typeof message?.available !== "boolean" || message?.ok !== true) reject(new Error(UNSAFE_KEY_STORE));
        else resolve(message.record ?? null);
      };
      const timer = setTimeout(() => {
        finish(undefined, true);
      }, this.timeoutMs);
      this.pending.set(id, finish);
      try { this.channel.send!({ type: "cliCredentialRequest", id, operation, tool, ...(record ? { record } : {}) }, (error) => { if (error) finish(); }); }
      catch { finish(); }
    });
  }
  async set(tool: string, record: KeyRecord): Promise<void> { await this.request("set", tool, record); }
  get(tool: string): Promise<KeyRecord | null> { return this.request("get", tool); }
  async remove(tool: string): Promise<void> { await this.request("remove", tool); }
  close(): void { this.channel.off("message", this.receive); for (const finish of [...this.pending.values()]) finish(); }
}

// Injectable boundary for synthetic tests. Failure occurs after staging, before publication.
export class MemoryCredentialStore implements CredentialStore {
  private records = new Map<string, KeyRecord>();
  enabled = true;
  failNextWrite = false;
  calls: string[] = [];
  available(): boolean { return this.enabled; }
  async set(tool: string, record: KeyRecord): Promise<void> {
    this.calls.push("set:" + tool);
    const staged = { ...record };
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error("Synthetic interrupted replacement"); }
    this.records.set(tool, staged);
  }
  async get(tool: string): Promise<KeyRecord | null> { this.calls.push("get:" + tool); const record = this.records.get(tool); return record ? { ...record } : null; }
  async remove(tool: string): Promise<void> { this.calls.push("remove:" + tool); this.records.delete(tool); }
}
