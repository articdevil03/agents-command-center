import { createHash } from "node:crypto";
import { defaultEffort } from "../config.ts";
import { validateAssignment, type AssignmentCatalogue } from "./assignment.ts";
import type { FixedCrew } from "./preferences.ts";
import { FIXED_CREW, type Assignment, type FixedSlot } from "./roster.ts";

export function assignmentsDigest(crew: FixedCrew): string {
  return createHash("sha256").update(JSON.stringify(FIXED_CREW.map(({ slot }) => {
    const { source, assignment } = crew.preferences[slot];
    return [slot, source, assignment ? [assignment.cli, assignment.model, assignment.effort, assignment.advisor ?? null] : null];
  }))).digest("hex");
}

export function bulkAssignment(current: FixedCrew, catalogue: AssignmentCatalogue,
  cliId: unknown, model: unknown, expectedDigest: unknown, confirmReplace: unknown,
  busy: (slot: FixedSlot) => boolean) {
  const currentDigest = assignmentsDigest(current);
  if (expectedDigest !== currentDigest) throw new Error("Crew choices changed. Choose the model again.");
  if (typeof confirmReplace !== "boolean") throw new Error("confirmReplace must be true or false");
  const cli = catalogue.clis.find((item) => item.id === cliId && item.installed === true);
  if (!cli) throw new Error("This CLI is unavailable. Refresh installed tools first");
  const fallback = defaultEffort(cli.id as Assignment["cli"]);
  const selected = validateAssignment({ cli: cli.id, model, effort: fallback })!;
  const models = cli.models ?? catalogue.opencodeSuggestions ?? [];
  if (!models.includes(selected.model) && !cli.id.startsWith("opencode") && !cli.id.startsWith("acp:")) throw new Error("Unknown crew model");
  const next = structuredClone(current);
  const changed: FixedSlot[] = [], skipped: FixedSlot[] = [];
  let replacesUserChoice = false;
  for (const { slot } of FIXED_CREW) {
    if (busy(slot)) { skipped.push(slot); continue; }
    const previous = current.preferences[slot];
    const old = previous.assignment;
    const assignment: Assignment = { ...selected,
      effort: old && cli.efforts.includes(old.effort) ? old.effort : fallback,
      ...(old?.advisor && cli.advisor && catalogue.claudeModels?.some((item) => item.value === old.advisor) ? { advisor: old.advisor } : {}),
    };
    if (previous.source === "user" && JSON.stringify(old) === JSON.stringify(assignment)) continue;
    if (previous.source === "user") replacesUserChoice = true;
    next.preferences[slot] = { assignment, source: "user" };
    changed.push(slot);
  }
  if (replacesUserChoice && confirmReplace !== true) throw new Error("Confirm replacing your chosen models.");
  const label = (slot: FixedSlot) => ({ slot, label: FIXED_CREW.find((seat) => seat.slot === slot)!.role });
  return { crew: next, changed: changed.map(label), skipped: skipped.map(label),
    notice: skipped.length === FIXED_CREW.length ? "All positions are busy. No choices changed." : changed.length ? "Crew choices updated." : "No choices changed." };
}
