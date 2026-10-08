import type { Pose, Coordinate } from "../space/manifest";
import { orientationLabel, type Orientation } from "../space/orientation";
import type { Instruction } from "./instructions";

// One executed cell. `at` and `orientation` describe the pointer while the cell ran;
// `next` is where the pointer went afterwards. A trace never records a destination
// as if it had executed.

export type TraceEntry = {
  readonly step: number; // 1-based
  readonly at: Coordinate;
  readonly orientation: Orientation;
  readonly cell: string | null; // null for a blank cell
  readonly instruction: Instruction;
  readonly next: Pose;
};

function describeInstruction(instruction: Instruction): string {
  switch (instruction.op) {
    case "nop":
      return "nop";
    case "turn":
      return `turn ${instruction.turn}`;
    case "face":
      return `face ${instruction.compass}`;
    case "step":
      return `step ${instruction.relative}`;
    case "floor":
      return `floor ${instruction.delta > 0 ? "up" : "down"}`;
    case "end":
      return "end";
  }
}

export function formatTraceEntry(entry: TraceEntry): string {
  const { x, y, z } = entry.at;
  const next = entry.next.position;
  const cell = entry.cell === null ? "[ ]" : `[${entry.cell}]`;
  return `${String(entry.step).padStart(4)}  (${x},${y},${z}) ${orientationLabel(entry.orientation)}  ${cell}  ${describeInstruction(entry.instruction)} → (${next.x},${next.y},${next.z}) ${orientationLabel(entry.next.orientation)}`;
}
