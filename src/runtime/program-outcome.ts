import type { Coordinate } from "../space/manifest";
import { describeOutcome, EXIT_CODES, OUTCOME_LABELS, type Outcome } from "./outcomes";

// How a program run ends: the machine's spatial outcomes, plus the temporal ones the
// interpreter adds. The machine itself never produces or sees the temporal outcomes.

export type TemporalStatus = "PARADOX" | "UNRESOLVED" | "AMBIGUOUS";

export type TemporalOutcome = {
  readonly status: TemporalStatus;
  readonly steps: number;
  readonly at: Coordinate;
  readonly message: string;
};

export type ProgramOutcome = Outcome | TemporalOutcome;
export type ProgramStatus = ProgramOutcome["status"];

export const PROGRAM_LABELS: Readonly<Record<ProgramStatus, string>> = {
  ...OUTCOME_LABELS,
  PARADOX: "역설",
  UNRESOLVED: "미결",
  AMBIGUOUS: "중의",
};

export const PROGRAM_EXIT_CODES: Readonly<Record<ProgramStatus, number>> = {
  ...EXIT_CODES,
  PARADOX: 4,
  UNRESOLVED: 5,
  AMBIGUOUS: 6,
};

function isTemporal(outcome: ProgramOutcome): outcome is TemporalOutcome {
  return outcome.status === "PARADOX" || outcome.status === "UNRESOLVED" || outcome.status === "AMBIGUOUS";
}

export function describeProgramOutcome(outcome: ProgramOutcome): string {
  if (!isTemporal(outcome)) {
    return describeOutcome(outcome);
  }
  const { x, y, z } = outcome.at;
  return `진단: ${PROGRAM_LABELS[outcome.status]} (${outcome.status}) · ${outcome.steps}보 · (${x},${y},${z}): ${outcome.message}`;
}
