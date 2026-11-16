import { isSafeRequestId } from "../chat-store.ts";
import { catalogOwner, catalogLaunchAllowed } from "./catalog-acp.ts";
import type { AcpCli } from "../config-acp.ts";
import { CLI_KEY_PROFILES, keyEnvFor, validateKeyRecord, type KeyRecord } from "./cli-key-profiles.ts";
import { CredentialChangeUnconfirmed, IpcCredentialStore, UNSAFE_KEY_REMOVAL, UNSAFE_KEY_STORE, type CredentialStore } from "./cli-key-store.ts";
import type { SettingsState } from "./types.ts";

export type KeyLaunch = { env: Record<string, string>; secrets: string[] };
export class CliKeys {
  #cache = new Map<string, KeyRecord | null>();
  #loading = new Map<string, Promise<void>>();
  #busy = new Set<string>();
  #used = new WeakMap<object, Set<string>>();
  #closed = false;
  private store: CredentialStore;
  private state: SettingsState;
  private publish: () => void;
  constructor(store: CredentialStore, state: SettingsState, publish: () => void) { this.store = store; this.state = state; this.publish = publish; }
  async prepare(tool: string): Promise<void> {
    if (this.#closed) throw new Error("Key storage is closed.");
    if (!Object.hasOwn(CLI_KEY_PROFILES, tool) || this.#cache.has(tool)) return;
    if (this.#busy.has(tool)) throw new Error("A key action is already running for this tool.");
    if (!this.store.available()) return;
    let loading = this.#loading.get(tool);
    if (!loading) {
      loading = (async () => {
        try {
          let saved;
          try { saved = await this.store.get(tool); }
          catch {
            if (!this.store.available()) return; // Encryption is unavailable here, so no key can exist.
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (this.#closed) throw new Error("Key storage is closed.");
            saved = await this.store.get(tool);
          }
          const record = saved === null ? null : validateKeyRecord(tool, saved);
          if (this.#closed) return;
          this.#cache.set(tool, record);
          this.state.catalogTools[tool].keySaved = record !== null;
          this.publish();
        } catch { throw new Error("Command Center could not read the saved key safely on this PC."); }
        finally { this.#loading.delete(tool); }
      })();
      this.#loading.set(tool, loading);
    }
    await loading;
  }
  // Waits at most waitMs for the key reads. Unfinished reads keep running and publish when done; an unread tool is never cached as "no key".
  async prepareAllBounded(tools: string[], waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reads = Promise.all(tools.map((tool) => this.prepare(tool).catch(() => {})));
    try { await Promise.race([reads, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]); }
    finally { clearTimeout(timer); }
  }
  async prepareConnection(cli: AcpCli): Promise<void> {
    const tool = catalogOwner(cli);
    if (tool && catalogLaunchAllowed(cli)) await this.prepare(tool.id);
  }
  launch(cli: AcpCli): KeyLaunch {
    if (this.#closed) throw new Error("Key storage is closed.");
    const tool = catalogOwner(cli);
    if (!tool || !catalogLaunchAllowed(cli) || !Object.hasOwn(CLI_KEY_PROFILES, tool.id)) return { env: {}, secrets: [] };
    if (this.#busy.has(tool.id) || this.#loading.has(tool.id)) throw new Error("A key action is already running for this tool.");
    if (!this.#cache.has(tool.id) && this.store.available()) throw new Error("The saved key is not ready. Try again.");
    const record = this.#cache.get(tool.id);
    return record ? { env: keyEnvFor(tool.id, record), secrets: [record.key] } : { env: {}, secrets: [] };
  }
  async request(message: any, owner: object): Promise<void> {
    let fields = message?.fields;
    if (message && typeof message === "object") delete message.fields;
    try {
      if (!message || typeof message !== "object" || Array.isArray(message) || !["submitCliKey", "removeCliKey"].includes(message.type)
        || !isSafeRequestId(message.requestId) || Object.keys(message).some((key) => !["type", "cli", "requestId"].includes(key))) throw new Error("Invalid key request.");
      const tool = message.cli;
      if (typeof tool !== "string" || !Object.hasOwn(CLI_KEY_PROFILES, tool)) throw new Error("This tool does not support saved keys.");
      const record = message.type === "submitCliKey" ? validateKeyRecord(tool, fields) : null;
      if (message.type === "removeCliKey" && fields !== undefined) throw new Error("Invalid key request.");
      if (this.#closed || !this.store.available()) throw new Error(record ? UNSAFE_KEY_STORE : UNSAFE_KEY_REMOVAL);
      const used = this.#used.get(owner) ?? new Set<string>();
      if (used.has(message.requestId) || used.size >= 256) throw new Error("This key request was already used. Open Settings again.");
      if (this.#busy.has(tool) || this.#loading.has(tool)) throw new Error("A key action is already running for this tool.");
      used.add(message.requestId); this.#used.set(owner, used);
      this.#busy.add(tool);
      try {
        if (record) await this.store.set(tool, record);
        else await this.store.remove(tool);
        if (this.#closed) return;
        this.#cache.set(tool, record);
        const target = this.state.catalogTools[tool];
        target.keySaved = record !== null;
        target.signedIn = null; target.connection = "unknown";
        if (Object.hasOwn(this.state.tools, tool)) this.state.tools[tool as keyof SettingsState["tools"]].signedIn = null;
        target.action = { requestId: message.requestId, status: "done", message: record ? "Key saved. Connection checked when you first chat." : "Key removed." };
        this.publish();
      } catch (error) {
        if (error instanceof CredentialChangeUnconfirmed) {
          this.#cache.delete(tool);
          throw error;
        }
        throw new Error(record ? UNSAFE_KEY_STORE : UNSAFE_KEY_REMOVAL);
      }
      finally { this.#busy.delete(tool); }
    } finally { fields = undefined; }
  }
  close(): boolean {
    this.#closed = true;
    this.#cache.clear();
    for (const facts of Object.values(this.state.catalogTools)) if (facts.keySaved) facts.keySaved = false;
    if (this.store instanceof IpcCredentialStore) this.store.close();
    return this.#cache.size === 0;
  }
}
