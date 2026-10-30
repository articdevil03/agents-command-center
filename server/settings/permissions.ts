import type { PermissionMode } from "./types.ts";

export const LIVE_TIMEOUT = Symbol("live permission mode change timed out");
// The live leader cannot take a mode right now (a Codex turn runs on its old policy): a plain refusal, not a failed apply, so the chat is never stopped for it.
export class ModeBusyError extends Error {}

export function permissionModeForSdk(value: PermissionMode): "default" | "acceptEdits" | "plan" | "bypassPermissions" {
  return value === "ask" ? "default" : value === "plan" ? "plan" : value === "bypass" ? "bypassPermissions" : "acceptEdits";
}

export function applyBounded(permissionTimeoutMs: number, applyLive: (mode: PermissionMode) => Promise<boolean>, mode: PermissionMode): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((_resolve, reject) => {
      timer = setTimeout(() => reject(LIVE_TIMEOUT), permissionTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => applyLive(mode)), timeout])
      .finally(() => { if (timer) clearTimeout(timer); });
}

export function serializePermissionMode<T>(permissionModeSequences: Map<string, number>, permissionModeTails: Map<string, Promise<void>>, tabId: string, work: () => Promise<T>): Promise<T> {
    const sequence = (permissionModeSequences.get(tabId) ?? 0) + 1;
    permissionModeSequences.set(tabId, sequence);
    const isCurrent = () => permissionModeSequences.get(tabId) === sequence;
    const previous = permissionModeTails.get(tabId) ?? Promise.resolve();
    const operation = previous.then(() => {
      if (!isCurrent()) throw new Error("permission mode request superseded");
      return work();
    });
    const tail = operation.then(() => undefined, () => undefined);
    permissionModeTails.set(tabId, tail);
    void tail.then(() => {
      if (permissionModeTails.get(tabId) !== tail) return;
      permissionModeTails.delete(tabId);
      if (permissionModeSequences.get(tabId) === sequence) permissionModeSequences.delete(tabId);
    });
    return operation;
}
