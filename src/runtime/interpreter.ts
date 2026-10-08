import type { Coordinate, Manifest, Pose } from "../space/manifest";
import { coordinateKey, type CompiledProgram } from "../semantics/program";
import { renderValue, sameValue, type Act, type ConcreteValue, type Operand, type Operation } from "../semantics/operations";
import { TemporalStore, type Resolution, type SymbolInfo } from "../temporal/store";
import { literal, TermError, type SymbolicTerm } from "../temporal/terms";
import type { DecodeResult, Instruction } from "./instructions";
import { createMachine, step } from "./machine";
import type { ProgramOutcome, TemporalStatus } from "./program-outcome";
import type { TraceEntry } from "./trace";

// The interpreter. Present tense executes on concrete values (M2). Past and future
// tense add constraints to the temporal store, which resolves a symbol only when the
// constraints leave exactly one value (M3). The interpreter never sees Korean, the
// machine never sees values, and the store never decides control flow.

// A noun's current binding. A name with no binding is unbound.
type Binding = { readonly kind: "concrete"; readonly value: ConcreteValue } | { readonly kind: "symbolic"; readonly term: SymbolicTerm };

type Promise = { readonly name: string; readonly term: SymbolicTerm; readonly madeAt: number; readonly sentence: string };
type Cycle = { anchor: Pose; iteration: number; promises: Promise[] };
type Line = { text: string | null; term: SymbolicTerm | null; heldSince: number | null };

export type Effect =
  // ordinary present execution
  | { readonly kind: "set"; readonly name: string; readonly value: ConcreteValue }
  | { readonly kind: "say"; readonly line: string }
  | { readonly kind: "test"; readonly left: ConcreteValue; readonly right: ConcreteValue; readonly negated: boolean; readonly holds: boolean }
  | { readonly kind: "anchor"; readonly at: Coordinate; readonly iteration: number }
  | { readonly kind: "back"; readonly to: Coordinate }
  | { readonly kind: "leave"; readonly anchor: Coordinate }
  | { readonly kind: "end" }
  // present execution on symbolic values
  | { readonly kind: "declare"; readonly name: string; readonly symbol: string }
  | { readonly kind: "bind"; readonly name: string; readonly term: string }
  | { readonly kind: "hold"; readonly term: string }
  // constraints
  | { readonly kind: "constrain"; readonly equation: string; readonly tense: "past" | "future"; readonly promisedAt: number | null }
  | { readonly kind: "promise"; readonly name: string; readonly term: string; readonly due: string }
  // resolution
  | { readonly kind: "resolve"; readonly symbol: string; readonly value: ConcreteValue; readonly born: number; readonly fills: readonly number[] }
  | { readonly kind: "flush"; readonly line: string; readonly heldSince: number }
  // how time can stop a run
  | { readonly kind: "contradiction"; readonly reason: string }
  | { readonly kind: "unresolved"; readonly symbols: readonly string[] }
  | { readonly kind: "ambiguous"; readonly symbols: readonly string[] };

export type ProgramTraceEntry = TraceEntry & { readonly effects: readonly Effect[] };

export type SymbolSummary = {
  readonly label: string;
  readonly noun: string;
  readonly born: number;
  readonly state: "declared" | "constrained" | "resolved";
  readonly value: string | null;
  readonly resolvedAt: number | null;
  readonly mark: "RETRO" | null;
};

export type ProgramResult = {
  readonly outcome: ProgramOutcome;
  readonly output: readonly string[]; // "?" for a line with no unique value
  readonly values: ReadonlyMap<string, ConcreteValue>; // names with concrete (or resolved) values
  readonly symbols: readonly SymbolSummary[];
  readonly trace: readonly ProgramTraceEntry[];
};

class RuntimeFault extends Error {}

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function runProgram(program: CompiledProgram, manifest: Manifest, options: { maxSteps?: number } = {}): ProgramResult {
  const store = new TemporalStore();
  const bindings = new Map<string, Binding>();
  const lines: Line[] = [];
  const cycles: Cycle[] = [];
  const runPromises: Promise[] = [];
  let effects: Effect[] = [];
  let now = 0; // the step being executed
  let sentence = "";
  let stop: { status: TemporalStatus; message: string } | null = null;

  const halt = (status: TemporalStatus, message: string) => {
    if (!stop) stop = { status, message };
  };

  // A binding, made concrete whenever the store can justify it.
  const settle = (binding: Binding): Binding => {
    if (binding.kind === "concrete") return binding;
    const value = store.resolve(binding.term);
    return value ? { kind: "concrete", value } : binding;
  };
  const termOf = (binding: Binding): SymbolicTerm => (binding.kind === "concrete" ? literal(binding.value) : binding.term);
  const pendingLabels = (term: SymbolicTerm) => store.pending(term).map((info) => info.label);

  // A name's binding as recorded, keeping its symbolic identity even when resolved.
  const recorded = (name: string): Binding => {
    const binding = bindings.get(name);
    if (!binding) throw new RuntimeFault(`'${name}' has no value or symbol yet`);
    return binding;
  };
  const bound = (name: string): Binding => settle(recorded(name));
  const read = (operand: Operand): Binding => (operand.kind === "literal" ? { kind: "concrete", value: operand.value } : bound(operand.name));

  const assign = (name: string, binding: Binding) => {
    const settled = settle(binding);
    bindings.set(name, settled);
    if (settled.kind === "concrete") {
      effects.push({ kind: "set", name, value: settled.value });
    } else {
      store.noteUse(settled.term, now);
      effects.push({ kind: "bind", name, term: store.format(settled.term) });
    }
  };

  const flushHeld = () => {
    for (const line of lines) {
      if (line.text !== null || !line.term) continue;
      const value = store.resolve(line.term);
      if (!value) continue;
      line.text = renderValue(value);
      effects.push({ kind: "flush", line: line.text, heldSince: line.heldSince ?? now });
    }
  };

  const recordResolutions = (resolutions: Resolution[]) => {
    for (const resolution of resolutions) {
      effects.push({
        kind: "resolve",
        symbol: resolution.symbol.label,
        value: resolution.value,
        born: resolution.symbol.born,
        fills: resolution.fills,
      });
    }
    if (resolutions.length > 0) flushHeld();
  };

  // Adds left = right as a constraint and reports what it settles.
  const constrain = (left: SymbolicTerm, right: SymbolicTerm, tense: "past" | "future", promisedAt: number | null, source: string) => {
    effects.push({ kind: "constrain", equation: `${store.format(left)} = ${store.format(right)}`, tense, promisedAt });
    const result = store.equate(left, right, now);
    if (result.kind === "contradiction") {
      effects.push({ kind: "contradiction", reason: result.reason });
      halt("PARADOX", `[${source}] cannot hold: ${result.reason}`);
      return;
    }
    recordResolutions(result.resolutions);
  };

  const dueLabel = () => {
    const cycle = cycles[cycles.length - 1];
    if (!cycle) return "end of run";
    const { x, y, z } = cycle.anchor.position;
    return `end of 처음 (${x},${y},${z}) #${cycle.iteration}`;
  };

  const discharge = (promises: Promise[]) => {
    for (const promise of promises.splice(0)) {
      if (stop) return;
      const binding = bindings.get(promise.name);
      if (!binding) throw new RuntimeFault(`'${promise.name}' was promised a value but has none when the promise falls due`);
      constrain(termOf(binding), promise.term, "future", promise.madeAt, promise.sentence);
    }
  };

  const leaveInnermost = () => {
    const cycle = cycles[cycles.length - 1];
    if (!cycle) return;
    discharge(cycle.promises);
    cycles.pop();
    effects.push({ kind: "leave", anchor: cycle.anchor.position });
  };

  const forward: Instruction = { op: "nop" };

  const arithmetic = (name: string, amount: Operand, sign: 1n | -1n) => {
    const left = bound(name);
    const right = read(amount);
    if (left.kind === "concrete" && right.kind === "concrete") {
      if (left.value.kind !== "int") throw new RuntimeFault(`'${name}' must be an integer, not text`);
      if (right.value.kind !== "int") throw new RuntimeFault("the amount must be an integer, not text");
      assign(name, { kind: "concrete", value: { kind: "int", value: left.value.value + sign * right.value.value } });
      return;
    }
    try {
      assign(name, { kind: "symbolic", term: store.arithmetic(termOf(left), termOf(right), sign) });
    } catch (error) {
      if (error instanceof TermError) throw new RuntimeFault(error.message);
      throw error;
    }
  };

  const execute = (operation: Operation | Act, pose: Pose): Instruction => {
    switch (operation.op) {
      case "assign":
        assign(operation.name, read(operation.value));
        return forward;
      case "declare": {
        const term = store.declare(operation.name, now);
        bindings.set(operation.name, { kind: "symbolic", term });
        effects.push({ kind: "declare", name: operation.name, symbol: store.format(term) });
        return forward;
      }
      case "add":
        arithmetic(operation.name, operation.amount, 1n);
        return forward;
      case "subtract":
        arithmetic(operation.name, operation.amount, -1n);
        return forward;
      case "say": {
        const value = read(operation.value);
        if (value.kind === "concrete") {
          const text = renderValue(value.value);
          lines.push({ text, term: null, heldSince: null });
          effects.push({ kind: "say", line: text });
        } else {
          // The line is written now, but only the future can say what it reads.
          lines.push({ text: null, term: value.term, heldSince: now });
          store.noteUse(value.term, now);
          effects.push({ kind: "hold", term: store.format(value.term) });
        }
        return forward;
      }
      case "move":
        return operation.instruction;
      case "anchor": {
        const open = cycles.findIndex((cycle) => sameCoordinate(cycle.anchor.position, pose.position));
        if (open >= 0) {
          while (cycles.length > open + 1) leaveInnermost();
          const cycle = cycles[open] as Cycle;
          discharge(cycle.promises); // reached again without a back-edge: the iteration ended here
          cycle.iteration += 1;
          effects.push({ kind: "anchor", at: pose.position, iteration: cycle.iteration });
        } else {
          cycles.push({ anchor: pose, iteration: 1, promises: [] });
          effects.push({ kind: "anchor", at: pose.position, iteration: 1 });
        }
        return forward;
      }
      case "back": {
        const cycle = cycles[cycles.length - 1];
        if (!cycle) throw new RuntimeFault("'끝은 처음이다' with no open '여기가 처음이다' to return to");
        discharge(cycle.promises);
        effects.push({ kind: "back", to: cycle.anchor.position });
        return { op: "jump", to: cycle.anchor };
      }
      case "end": {
        while (cycles.length > 0 && !stop) leaveInnermost();
        discharge(runPromises);
        effects.push({ kind: "end" });
        const open = lines.flatMap((line) => (line.text === null && line.term ? pendingLabels(line.term) : []));
        if (!stop && open.length > 0) {
          const symbols = [...new Set(open)];
          effects.push({ kind: "ambiguous", symbols });
          halt("AMBIGUOUS", `the output depends on ${symbols.join(", ")}, which the constraints leave open`);
        }
        return { op: "end" };
      }
      case "when": {
        const left = read(operation.test.left);
        const right = read(operation.test.right);
        if (left.kind === "symbolic" || right.kind === "symbolic") {
          // Space never waits for time: a branch needs a value now.
          const symbols = [
            ...new Set([...(left.kind === "symbolic" ? pendingLabels(left.term) : []), ...(right.kind === "symbolic" ? pendingLabels(right.term) : [])]),
          ];
          effects.push({ kind: "unresolved", symbols });
          halt("UNRESOLVED", `this condition needs ${symbols.join(", ")}, which only the future could decide`);
          return forward;
        }
        const holds = sameValue(left.value, right.value) !== operation.test.negated;
        effects.push({ kind: "test", left: left.value, right: right.value, negated: operation.test.negated, holds });
        if (holds) return execute(operation.then, pose);
        if (operation.then.op === "back") leaveInnermost();
        return forward;
      }
      case "assert": {
        // Constrain the symbolic identity, so the trace shows what the statement is about.
        const left = recorded(operation.name);
        const right = operation.value.kind === "name" ? recorded(operation.value.name) : read(operation.value);
        constrain(termOf(left), termOf(right), "past", null, sentence);
        return forward;
      }
      case "promise": {
        const term = termOf(read(operation.value));
        const promise: Promise = { name: operation.name, term, madeAt: now, sentence };
        effects.push({ kind: "promise", name: operation.name, term: store.format(term), due: dueLabel() });
        (cycles[cycles.length - 1]?.promises ?? runPromises).push(promise);
        return forward;
      }
    }
  };

  const decode = (text: string, pose: Pose): DecodeResult => {
    const operation = program.operations.get(coordinateKey(pose.position));
    if (!operation) return { error: "this cell was not compiled" };
    sentence = text;
    try {
      return execute(operation, pose);
    } catch (error) {
      if (error instanceof RuntimeFault) return { error: error.message };
      throw error;
    }
  };

  let state = createMachine(program.space, manifest, options);
  const trace: ProgramTraceEntry[] = [];
  let lastAt: Coordinate = state.pose.position;
  while (!state.outcome && !stop) {
    effects = [];
    now = state.steps + 1;
    lastAt = state.pose.position;
    const result = step(program.space, state, decode);
    state = result.state;
    if (result.entry) trace.push({ ...result.entry, effects });
  }

  // A temporal stop happens while a cell runs; it outranks whatever the machine did next.
  const finalStop = stop as { status: TemporalStatus; message: string } | null;
  const outcome: ProgramOutcome = finalStop
    ? { status: finalStop.status, steps: state.steps, at: lastAt, message: finalStop.message }
    : (state.outcome as ProgramOutcome);

  const values = new Map<string, ConcreteValue>();
  for (const [name, binding] of bindings) {
    const settled = settle(binding);
    if (settled.kind === "concrete") values.set(name, settled.value);
  }
  const summarize = (info: SymbolInfo): SymbolSummary => ({
    label: info.label,
    noun: info.noun,
    born: info.born,
    state: store.state(info.id),
    value: info.value ? renderValue(info.value) : null,
    resolvedAt: info.resolvedAt,
    mark: info.retroactive ? "RETRO" : null,
  });

  return {
    outcome,
    output: lines.map((line) => line.text ?? "?"),
    values,
    symbols: store.all().map(summarize),
    trace,
  };
}
