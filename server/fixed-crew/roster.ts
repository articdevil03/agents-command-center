import { deepFreeze, type SeatCli } from "../process-types.ts";

export type FixedSlot =
  | "leader" | "planner" | "researcher" | "coder" | "designCoder" | "helper"
  | "imageMaker" | "socialMaker" | "videoMaker" | "secondOpinion"
  | "reviewer1" | "fixer1" | "reviewer2" | "fixer2" | "final" | "designFinal"
  | "minimalFixer" | "minimalReviewer";

export interface Assignment {
  cli: SeatCli;
  model: string;
  effort: string;
  advisor?: string;
}
export interface FixedSeat {
  slot: FixedSlot;
  role: string;
  canWrite: boolean;
  preferred: Readonly<Assignment>;
  preferredAdvisor?: string;
  reviews?: FixedSlot;
}

const SONNET = "claude-sonnet-5-5[1m]";
const OPUS = "claude-opus-5-5[1m]";
const SOL = "gpt-6.1-sol";
export const DEFAULT_WORKER_MODELS: Readonly<Record<string, readonly string[]>> = deepFreeze({
  claude: [SONNET, OPUS], codex: [SOL],
});
function seat(slot: FixedSlot, role: string, cli: SeatCli, model: string, effort: string,
  canWrite: boolean, extra: Pick<FixedSeat, "preferredAdvisor" | "reviews"> = {}): FixedSeat {
  return { slot, role, canWrite, preferred: { cli, model, effort }, ...extra };
}

// Preferences describe the approved roster, never the user's actual assignments.
// Fable 5.2 is a request by name until a supplied catalogue identifies its CLI id.
export const FIXED_CREW = deepFreeze([
  seat("leader", "Leader", "claude", SONNET, "high", false, { preferredAdvisor: "Fable 5.2" }),
  seat("planner", "Planner", "codex", SOL, "xhigh", false),
  seat("researcher", "Researcher", "claude", SONNET, "medium", false),
  seat("coder", "Coder", "codex", SOL, "medium", true),
  seat("designCoder", "Design coder", "claude", OPUS, "high", true),
  seat("helper", "Helper", "codex", SOL, "medium", false),
  seat("imageMaker", "Image maker", "codex", SOL, "medium", true),
  seat("socialMaker", "Social maker", "claude", SONNET, "medium", true),
  seat("videoMaker", "Video maker", "claude", OPUS, "high", true),
  seat("secondOpinion", "Second opinion", "codex", SOL, "medium", false),
  seat("reviewer1", "Reviewer", "claude", SONNET, "high", false, { reviews: "coder" }),
  seat("fixer1", "Fixer", "codex", SOL, "medium", true),
  seat("reviewer2", "Reviewer", "claude", SONNET, "high", false, { reviews: "fixer1" }),
  seat("fixer2", "Fixer", "claude", SONNET, "medium", true),
  seat("final", "Final reviewer", "claude", SONNET, "high", false, { reviews: "fixer2" }),
  seat("designFinal", "Design final reviewer", "codex", SOL, "medium", false, { reviews: "designCoder" }),
  seat("minimalFixer", "Minimal fixer", "codex", SOL, "low", true),
  seat("minimalReviewer", "Minimal reviewer", "claude", SONNET, "medium", false, { reviews: "minimalFixer" }),
] satisfies FixedSeat[]);
