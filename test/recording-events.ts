// Small EventTarget for VM pages. Retain registrations and dispatch real handler calls.
export function recordingEvents() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    listeners,
    addEventListener(type: string, listener: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event: any) { for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return !event.defaultPrevented; },
  };
}
