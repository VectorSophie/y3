import type { Pose, Coordinate } from "../space/manifest";

// How a run of the spatial machine ends. Later milestones add the temporal outcomes
// (PARADOX, UNRESOLVED, AMBIGUOUS); see docs/v2-space-and-time.md §6.5.

export type Outcome =
  | { readonly status: "HALT"; readonly steps: number; readonly at: Coordinate } // an END cell ran
  | { readonly status: "VOID"; readonly steps: number; readonly at: Coordinate; readonly from: Coordinate | null }
  | { readonly status: "STEP_LIMIT"; readonly steps: number; readonly pose: Pose }
  | { readonly status: "FAULT"; readonly steps: number; readonly at: Coordinate; readonly message: string };

export type OutcomeStatus = Outcome["status"];

export const OUTCOME_LABELS: Readonly<Record<OutcomeStatus, string>> = {
  HALT: "정지",
  VOID: "허공",
  STEP_LIMIT: "한계",
  FAULT: "고장",
};

export const EXIT_CODES: Readonly<Record<OutcomeStatus, number>> = {
  HALT: 0,
  FAULT: 1,
  VOID: 2,
  STEP_LIMIT: 3,
};

function at(position: Coordinate): string {
  return `(${position.x},${position.y},${position.z})`;
}

export function describeOutcome(outcome: Outcome): string {
  const head = `진단: ${OUTCOME_LABELS[outcome.status]} (${outcome.status}) · ${outcome.steps}보`;
  switch (outcome.status) {
    case "HALT":
      return `${head} · ended at ${at(outcome.at)}`;
    case "VOID":
      return outcome.from
        ? `${head} · moved from ${at(outcome.from)} to ${at(outcome.at)}, where there is no cell`
        : `${head} · started at ${at(outcome.at)}, where there is no cell`;
    case "STEP_LIMIT":
      return `${head} · still running at ${at(outcome.pose.position)}`;
    case "FAULT":
      return `${head} · ${at(outcome.at)}: ${outcome.message}`;
  }
}
