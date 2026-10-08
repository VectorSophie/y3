import { orientationLabel } from "../space/orientation";
import { showValue } from "../semantics/operations";
import type { Effect, ProgramResult, ProgramTraceEntry } from "./interpreter";
import { describeOutcome } from "./outcomes";

// Text form of a v2 run: one header line per executed cell (where it ran, how the
// pointer faced, what the cell said, where the pointer went next), then the cell's
// effects, indented. Used by `y3 trace` and by the conformance golden files.

function at(c: { x: number; y: number; z: number }): string {
  return `(${c.x},${c.y},${c.z})`;
}

export function describeEffect(effect: Effect): string {
  switch (effect.kind) {
    case "set":
      return `${effect.name} := ${showValue(effect.value)}`;
    case "say":
      return `out ${JSON.stringify(effect.line)}`;
    case "test":
      return `test ${showValue(effect.left)} ${effect.negated ? "≠" : "="} ${showValue(effect.right)}: ${effect.holds ? "yes" : "no"}`;
    case "anchor":
      return `처음 ${at(effect.at)} #${effect.iteration}`;
    case "back":
      return `back to 처음 ${at(effect.to)}`;
    case "leave":
      return `leave 처음 ${at(effect.anchor)}`;
    case "end":
      return "end";
  }
}

export function formatProgramTraceEntry(entry: ProgramTraceEntry): string {
  const cell = entry.cell === null ? "[ ]" : `[${entry.cell}]`;
  const head = `${entry.step} ${at(entry.at)} ${orientationLabel(entry.orientation)} ${cell} → ${at(entry.next.position)} ${orientationLabel(entry.next.orientation)}`;
  return [head, ...entry.effects.map((effect) => `  ${describeEffect(effect)}`)].join("\n");
}

export function formatProgramTrace(result: ProgramResult): string {
  return `${[...result.trace.map(formatProgramTraceEntry), describeOutcome(result.outcome)].join("\n")}\n`;
}
