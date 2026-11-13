import type { LeaderToolSpec } from "../leader-tools.ts";
import { bridgeTokens, leaderBridge } from "./state.ts";

// One bridge entry per key; its token is remembered so no run's output is ever shown back with a live token in it.
export function openBridge(key: string, specs: LeaderToolSpec[], onCall?: () => void): { token: string; revoke: () => void } {
  const bridge = leaderBridge.open(key, specs, onCall);
  bridgeTokens.set(key, bridge.token);
  return { token: bridge.token, revoke: () => { bridge.revoke(); if (bridgeTokens.get(key) === bridge.token) bridgeTokens.delete(key); } };
}
export function hideTokens(text: string): string {
  let out = text;
  for (const token of bridgeTokens.values()) out = out.split(token).join("[hidden]");
  return out;
}
