// Loaded before startup's first await. Do not touch services until index binds the drain.
let pendingShutdown: string | undefined;
let shutdownHandler: ((signal: string) => void) | undefined;
let shutdownDispatched = false;
export function shutdownRequested(): boolean { return pendingShutdown !== undefined; }
function latchShutdown(signal: string): void {
  pendingShutdown ??= signal;
  if (!shutdownHandler || shutdownDispatched) return;
  shutdownDispatched = true;
  shutdownHandler(pendingShutdown);
}
export function bindShutdown(handler: (signal: string) => void): void {
  shutdownHandler = handler;
  if (pendingShutdown) latchShutdown(pendingShutdown);
}
process.on("SIGINT", () => latchShutdown("SIGINT"));
process.on("SIGTERM", () => latchShutdown("SIGTERM"));
process.on("disconnect", () => latchShutdown("disconnect"));
process.on("message", (message) => { if (message === "shutdown") latchShutdown("IPC shutdown"); });
if (process.send && !process.connected) latchShutdown("disconnect");
