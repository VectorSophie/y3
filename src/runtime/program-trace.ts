import { orientationLabel } from "../space/orientation";
import { showValue } from "../semantics/operations";
import type { Effect, ProgramResult, ProgramTraceEntry, SymbolSummary } from "./interpreter";
import { describeProgramOutcome } from "./program-outcome";

// Text form of a v2 run: one header line per executed cell (where it ran, how the
// pointer faced, what the cell said, where the pointer went next), then the cell's
// effects, indented. Used by `y3 trace` and by the conformance golden files.
//
// Effects read in four registers:
//   ordinary present execution   값 := 3 · out "3" · test 3 = 2: no
//   constraint introduced        constraint α1 + 1 = 4  [past]
//   symbol resolved              resolved α1 = 3
//   retroactive resolution       retro α1 = 3  [born t1; fills t2, t3, t4]

function at(c: { x: number; y: number; z: number }): string {
  return `(${c.x},${c.y},${c.z})`;
}

const steps = (list: readonly number[]) => list.map((n) => `t${n}`).join(", ");

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
    case "declare":
      return `${effect.name} := ${effect.symbol}  [미정]`;
    case "bind":
      return `${effect.name} := ${effect.term}`;
    case "hold":
      return `out ${effect.term}  [held]`;
    case "constrain":
      return `constraint ${effect.equation}  [${effect.tense === "past" ? "past" : `promised at t${effect.promisedAt}`}]`;
    case "promise":
      return `promise ${effect.name} = ${effect.term}  [due ${effect.due}]`;
    case "resolve":
      return effect.fills.length === 0
        ? `resolved ${effect.symbol} = ${showValue(effect.value)}`
        : `retro ${effect.symbol} = ${showValue(effect.value)}  [born t${effect.born}; fills ${steps(effect.fills)}]`;
    case "flush":
      return `out ${JSON.stringify(effect.line)}  [held since t${effect.heldSince}]`;
    case "contradiction":
      return `contradiction: ${effect.reason}`;
    case "unresolved":
      return `unresolved: needs ${effect.symbols.join(", ")}`;
    case "ambiguous":
      return `ambiguous: ${effect.symbols.join(", ")} ${effect.symbols.length === 1 ? "has" : "have"} no unique value`;
  }
}

export function formatProgramTraceEntry(entry: ProgramTraceEntry): string {
  const cell = entry.cell === null ? "[ ]" : `[${entry.cell}]`;
  const head = `${entry.step} ${at(entry.at)} ${orientationLabel(entry.orientation)} ${cell} → ${at(entry.next.position)} ${orientationLabel(entry.next.orientation)}`;
  return [head, ...entry.effects.map((effect) => `  ${describeEffect(effect)}`)].join("\n");
}

export function describeSymbol(symbol: SymbolSummary): string {
  const head = `${symbol.label} (${symbol.noun}, born t${symbol.born})`;
  if (symbol.value === null) return `${head} ${symbol.state}, open`;
  return `${head} = ${symbol.value} at t${symbol.resolvedAt}${symbol.mark === "RETRO" ? " [retro]" : ""}`;
}

export function formatProgramTrace(result: ProgramResult): string {
  const lines = [...result.trace.map(formatProgramTraceEntry), describeProgramOutcome(result.outcome)];
  if (result.symbols.length > 0) {
    lines.push("symbols:", ...result.symbols.map((symbol) => `  ${describeSymbol(symbol)}`));
  }
  return `${lines.join("\n")}\n`;
}
