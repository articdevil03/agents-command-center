export type ProcessKind = "dev" | "design" | "mkt";
export type ProcessId = "main" | "duo" | "solo";
export type ProcessPhase = "review" | "fix" | "clean";
export type ApprovalState = "none" | "pending" | "approved";
export type SeatStatus = "idle" | "working" | "waiting" | "done" | "stopped" | "failed";
export type RunStatus = "working" | "done" | "stopped" | "failed";
export type ReviewOutcome = "findings" | "clean";

export type SeatCli = "claude" | "codex" | "opencode" | `acp:${string}`;
export type StepType = "work" | "look" | "rounds" | "finish";
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
  pic?: string;
}
export interface RoundPair { reviewer: string; fixers: string[] }
export type Step =
  | { id: string; label: string; type: "work" | "finish"; owners: string[] }
  | { id: string; label: string; type: "look"; owners: ["user"] }
  | { id: string; label: string; type: "rounds"; pairs: RoundPair[] };
export interface Setup { crew: Seat[]; steps: Step[]; lookPause?: boolean }
export interface Template extends Setup { id: string; name: string; kind: ProcessKind; desc: string; lookPause: boolean }

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
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const KINDS = deepFreeze({
  dev: { label: "Development" },
  design: { label: "Design" },
  mkt: { label: "Marketing" },
} satisfies Record<ProcessKind, { label: string }>);

// ---- What each CLI can do. The one table: config.ts adds installed/models/efforts to it for the page, the checks below and the launch gate read it. ----
export type CliCapStatic = { id: string; label: string; advisor: boolean; readOnlyEnforced: boolean; crewTools: boolean; customModel: string | null };
// CLI-CAPABILITIES-TABLE (the one place the seat CLIs are written out; everything else reads this)
export const CLI_CAPS: Record<"claude" | "codex" | "opencode", CliCapStatic> = {
  claude: { id: "claude", label: "Claude Code", advisor: true, readOnlyEnforced: true, crewTools: true, customModel: null },
  codex: { id: "codex", label: "Codex", advisor: false, readOnlyEnforced: false, crewTools: true, customModel: "^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" },
  opencode: { id: "opencode", label: "OpenCode", advisor: false, readOnlyEnforced: true, crewTools: true, customModel: "^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$" },
};
export const isAcpCli = (value: unknown): value is `acp:${string}` => typeof value === "string" && value.length <= 40 && /^acp:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
// A CLI added in Settings by its start command: its read-only mode is not enforced (a launch counts as able to write), and its crew tools depend on the CLI taking HTTP MCP servers (checked when the run starts).
export function acpCaps(cli: `acp:${string}`): CliCapStatic {
  return { id: cli, label: cli.slice(4), advisor: false, readOnlyEnforced: false, crewTools: true, customModel: null };
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

export const stepOwners = (step: Step): string[] => step.type === "rounds" ? [...new Set(step.pairs.flatMap((pair) => [pair.reviewer, ...pair.fixers]))] : [...step.owners];
