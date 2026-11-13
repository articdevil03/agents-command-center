export type ProcessKind = "dev" | "design" | "mkt";
export type SeatStatus = "idle" | "working" | "waiting" | "done" | "stopped" | "failed";
export type RunStatus = "working" | "done" | "stopped" | "failed";

export type SeatCli = "claude" | "codex" | "opencode" | `acp:${string}`;
export interface Seat {
  slot: string;
  name: string;
  role: string;
  cli: SeatCli;
  model: string;
  effort: string;
  canWrite: boolean;
  isLeader: boolean;
  advisor?: string;
  orchestrates?: boolean;
}

export type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const KINDS = deepFreeze({
  dev: { label: "Development" },
  design: { label: "Design" },
  mkt: { label: "Marketing" },
} satisfies Record<ProcessKind, { label: string }>);

// ---- What each CLI can do. The one table: config.ts adds installed/models/efforts to it for the page, the checks below and the launch gate read it. ----
export type CliCapStatic = { id: string; label: string; advisor: boolean; readOnlyEnforced: boolean; customModel: string | null };
// CLI-CAPABILITIES-TABLE (the one place the seat CLIs are written out; everything else reads this)
export const CLI_CAPS: Record<"claude" | "codex" | "opencode", CliCapStatic> = {
  claude: { id: "claude", label: "Claude Code", advisor: true, readOnlyEnforced: true, customModel: null },
  codex: { id: "codex", label: "Codex", advisor: false, readOnlyEnforced: false, customModel: "^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" },
  opencode: { id: "opencode", label: "OpenCode", advisor: false, readOnlyEnforced: true, customModel: "^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$" },
};
export const isAcpCli = (value: unknown): value is `acp:${string}` => typeof value === "string" && value.length <= 40 && /^acp:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
// A CLI added in Settings by its start command: its read-only mode is not enforced (a launch counts as able to write).
export function acpCaps(cli: `acp:${string}`): CliCapStatic {
  return { id: cli, label: cli.slice(4), advisor: false, readOnlyEnforced: false, customModel: null };
}
export function cliCaps(cli: unknown): CliCapStatic | null {
  if (typeof cli === "string" && Object.hasOwn(CLI_CAPS, cli)) return CLI_CAPS[cli as keyof typeof CLI_CAPS];
  return isAcpCli(cli) ? acpCaps(cli) : null;
}
// A launch counts as able to write when the seat may write, or its CLI cannot enforce read-only.
export function launchMayWrite(cli: string, canWrite: boolean | undefined): boolean {
  const caps = cliCaps(cli);
  return canWrite === true || (caps !== null && !caps.readOnlyEnforced);
}

export const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- Seat ids ----
const WINDOWS_RESERVED_CHARS = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
const LOG_TS_DIGITS = 13;
const MAX_SEAT_ID_LENGTH = 255 - (1 + LOG_TS_DIGITS + ".brief.txt".length);
export function isSafeSeatId(id: string): boolean {
  if (id.trim().length === 0 || id.length > MAX_SEAT_ID_LENGTH) return false;
  if (WINDOWS_RESERVED_CHARS.some((ch) => id.includes(ch))) return false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !id.endsWith(".") && !id.endsWith(" ");
}
