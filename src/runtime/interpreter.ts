import type { Coordinate, Manifest, Pose } from "../space/manifest";
import { coordinateKey, type CompiledProgram } from "../semantics/program";
import { renderValue, sameValue, type Act, type ConcreteValue, type Operand, type Operation } from "../semantics/operations";
import { TemporalStore, type Resolution, type SymbolInfo } from "../temporal/store";
import { carriesCause, literal, symbolsOf, TermError, type SymbolicTerm } from "../temporal/terms";
import type { DecodeResult, Instruction } from "./instructions";
import { createMachine, step } from "./machine";
import type { ProgramOutcome, TemporalStatus } from "./program-outcome";
import type { TraceEntry } from "./trace";

// The interpreter. Present tense executes on concrete values (M2). Past and future
// tense add constraints to the temporal store, which resolves a symbol only when the
// constraints leave exactly one value (M3). Temporal cycles (M4): channels carry a
// value from later to earlier, fixed points equate an iteration's end with its start,
// and time anchors read a name at 처음 or 끝 — all as linear equalities for the same
// solver. The interpreter never sees Korean, the machine never sees values, and the
// store never decides control flow.

// A noun's current binding. A name with no binding is unbound. Whether a binding has an
// operational cause is read from its normal form (carriesCause), never from the syntax
// that built it.
type Binding =
  | { readonly kind: "concrete"; readonly value: ConcreteValue }
  | { readonly kind: "symbolic"; readonly term: SymbolicTerm };

type Promise = { readonly name: string; readonly term: SymbolicTerm; readonly madeAt: number; readonly sentence: string };
type EndRead = { readonly name: string; readonly symbol: SymbolicTerm; readonly madeAt: number; readonly sentence: string };
type FixedPoint = { readonly madeAt: number; readonly sentence: string };

// One iteration of a loop, or the whole run. It remembers how it began, what it wrote,
// and what must be closed when it ends.
type Scope = {
  readonly anchor: Pose | null; // null for the run
  iteration: number;
  start: Map<string, Binding>; // 처음: the bindings when this iteration began
  written: Set<string>;
  promises: Promise[];
  endReads: EndRead[]; // 끝의 N, read before the end
  fixed: FixedPoint[]; // 처음은 끝이었다
};

type Slot = { readonly id: string; readonly name: string; readonly symbol: SymbolicTerm; readonly openedAt: number };
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
  // temporal cycles
  | { readonly kind: "open"; readonly slot: string; readonly name: string; readonly symbol: string }
  | { readonly kind: "close"; readonly slot: string; readonly sent: string; readonly openedAt: number; readonly selfLoop: boolean }
  | { readonly kind: "unanswered"; readonly slot: string; readonly symbol: string }
  | { readonly kind: "endread"; readonly name: string; readonly symbol: string; readonly due: string }
  | { readonly kind: "fixed"; readonly due: string }
  // constraints
  | { readonly kind: "constrain"; readonly equation: string; readonly source: string }
  | { readonly kind: "promise"; readonly name: string; readonly term: string; readonly due: string }
  // resolution
  | {
      readonly kind: "resolve";
      readonly symbol: string;
      readonly value: ConcreteValue;
      readonly born: number;
      readonly fills: readonly number[];
      readonly selfLoop: string | null;
    }
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
  readonly loop: string | null; // the edge whose cycle closed on this symbol, if any
  readonly mark: "SELF_CAUSED" | "RETRO" | null;
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

function at(c: Coordinate): string {
  return `(${c.x},${c.y},${c.z})`;
}

export function runProgram(program: CompiledProgram, manifest: Manifest, options: { maxSteps?: number } = {}): ProgramResult {
  const store = new TemporalStore();
  const bindings = new Map<string, Binding>();
  const lines: Line[] = [];
  const run: Scope = { anchor: null, iteration: 1, start: new Map(), written: new Set(), promises: [], endReads: [], fixed: [] };
  const cycles: Scope[] = [];
  const slots = new Map<string, Slot[]>(); // per name, most recent last
  let slotCount = 0;
  let effects: Effect[] = [];
  let now = 0; // the step being executed
  let sentence = "";
  let stop: { status: TemporalStatus; message: string } | null = null;

  const halt = (status: TemporalStatus, message: string) => {
    if (!stop) stop = { status, message };
  };

  const scope = (): Scope => cycles[cycles.length - 1] ?? run;
  const dueLabel = (s: Scope) => (s.anchor ? `end of 처음 ${at(s.anchor.position)} #${s.iteration}` : "end of run");

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

  const atStart = (name: string): Binding => {
    const current = scope();
    if (!current.anchor) throw new RuntimeFault(`'처음의 ${name}' needs an open '여기가 처음이다'`);
    const binding = current.start.get(name);
    if (!binding) throw new RuntimeFault(`'${name}' had no value at 처음 ${at(current.anchor.position)}`);
    return binding;
  };

  // 끝의 N: a value from the end of the iteration, carried back as a fresh symbol that
  // the end will settle.
  const fromEnd = (name: string): Binding => {
    const current = scope();
    const symbol = store.declare(name, now, "끝");
    current.endReads.push({ name, symbol, madeAt: now, sentence });
    effects.push({ kind: "endread", name, symbol: store.format(symbol), due: dueLabel(current) });
    return { kind: "symbolic", term: symbol };
  };

  const read = (operand: Operand): Binding => {
    switch (operand.kind) {
      case "literal":
        return { kind: "concrete", value: operand.value };
      case "name":
        return bound(operand.name);
      case "anchored":
        return operand.anchor === "start" ? settle(atStart(operand.name)) : fromEnd(operand.name);
    }
  };
  // Like read, but a name keeps its symbolic identity, so constraints say what they are about.
  const readRecorded = (operand: Operand): Binding => (operand.kind === "name" ? recorded(operand.name) : read(operand));

  const markWritten = (name: string) => {
    run.written.add(name);
    for (const cycle of cycles) cycle.written.add(name);
  };

  const assign = (name: string, binding: Binding) => {
    const settled = settle(binding);
    bindings.set(name, settled);
    markWritten(name);
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
        selfLoop: resolution.symbol.selfLoop,
      });
    }
    if (resolutions.length > 0) flushHeld();
  };

  // Adds left = right as a constraint and reports what it settles.
  const constrain = (left: SymbolicTerm, right: SymbolicTerm, source: string, statement: string) => {
    effects.push({ kind: "constrain", equation: `${store.format(left)} = ${store.format(right)}`, source });
    const result = store.equate(left, right, now);
    if (result.kind === "contradiction") {
      effects.push({ kind: "contradiction", reason: result.reason });
      halt("PARADOX", `[${statement}] cannot hold: ${result.reason}`);
      return;
    }
    recordResolutions(result.resolutions);
  };

  // One rule for every cycle edge (channel, 끝의 N, fixed point): the edge equates an
  // origin with what came back to it. When neither side carries an external cause and
  // the returned value contains the origin's own symbols, the cycle closes on those
  // symbols. Whether it also determines them is left to the solver.
  const noteLoop = (origin: SymbolicTerm, returned: SymbolicTerm, via: string): boolean => {
    if (carriesCause(origin) || carriesCause(returned)) return false;
    const back = new Set(symbolsOf(returned));
    const closed = symbolsOf(origin).filter((id) => back.has(id));
    for (const id of closed) store.info(id).selfLoop ??= via;
    return closed.length > 0;
  };

  // Everything that falls due when an iteration (or the run) ends.
  const endIteration = (ending: Scope) => {
    for (const promise of ending.promises.splice(0)) {
      if (stop) return;
      const binding = bindings.get(promise.name);
      if (!binding) throw new RuntimeFault(`'${promise.name}' was promised a value but has none when the promise falls due`);
      constrain(termOf(binding), promise.term, `promised at t${promise.madeAt}`, promise.sentence);
    }
    for (const read of ending.endReads.splice(0)) {
      if (stop) return;
      const binding = bindings.get(read.name);
      if (!binding) throw new RuntimeFault(`'끝의 ${read.name}' was read, but '${read.name}' has no value at the end`);
      noteLoop(read.symbol, termOf(binding), `끝의 ${read.name}`);
      constrain(read.symbol, termOf(binding), `끝의 ${read.name} from t${read.madeAt}`, read.sentence);
    }
    for (const fixed of ending.fixed.splice(0)) {
      for (const name of [...ending.written].sort()) {
        if (stop) return;
        const before = ending.start.get(name);
        const after = bindings.get(name);
        if (!before || !after || before === after) continue; // introduced during the iteration, or untouched
        noteLoop(termOf(before), termOf(after), `fixed point at t${fixed.madeAt}`);
        constrain(termOf(before), termOf(after), `처음은 끝이었다 at t${fixed.madeAt}`, fixed.sentence);
      }
    }
  };

  const beginIteration = (current: Scope) => {
    current.start = new Map(bindings);
    current.written = new Set();
  };

  const leaveInnermost = () => {
    const cycle = cycles[cycles.length - 1];
    if (!cycle) return;
    endIteration(cycle);
    cycles.pop();
    effects.push({ kind: "leave", anchor: (cycle.anchor as Pose).position });
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
      const term = store.arithmetic(termOf(left), termOf(right), sign);
      assign(name, { kind: "symbolic", term });
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
        markWritten(operation.name);
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
      case "receive": {
        // A channel opens: the name takes a value that something later will send back.
        const symbol = store.declare(operation.name, now, "다음");
        slotCount += 1;
        const slot: Slot = { id: `S${slotCount}`, name: operation.name, symbol, openedAt: now };
        slots.set(operation.name, [...(slots.get(operation.name) ?? []), slot]);
        bindings.set(operation.name, { kind: "symbolic", term: symbol });
        markWritten(operation.name);
        effects.push({ kind: "open", slot: slot.id, name: operation.name, symbol: store.format(symbol) });
        return forward;
      }
      case "send": {
        const slot = slots.get(operation.name)?.pop();
        const sent = recorded(operation.name);
        if (!slot) {
          effects.push({ kind: "contradiction", reason: `nothing earlier is waiting for '${operation.name}'` });
          halt("PARADOX", `[${sentence}] cannot hold: no past is listening for '${operation.name}'`);
          return forward;
        }
        const selfLoop = noteLoop(slot.symbol, termOf(sent), `channel ${slot.id}`);
        effects.push({ kind: "close", slot: slot.id, sent: store.format(termOf(sent)), openedAt: slot.openedAt, selfLoop });
        constrain(slot.symbol, termOf(sent), `channel ${slot.id}`, sentence);
        return forward;
      }
      case "move":
        return operation.instruction;
      case "anchor": {
        const open = cycles.findIndex((cycle) => cycle.anchor && sameCoordinate(cycle.anchor.position, pose.position));
        if (open >= 0) {
          while (cycles.length > open + 1) leaveInnermost();
          const cycle = cycles[open] as Scope;
          endIteration(cycle); // reached again without a back-edge: the iteration ended here
          cycle.iteration += 1;
          beginIteration(cycle);
          effects.push({ kind: "anchor", at: pose.position, iteration: cycle.iteration });
        } else {
          const cycle: Scope = { anchor: pose, iteration: 1, start: new Map(), written: new Set(), promises: [], endReads: [], fixed: [] };
          beginIteration(cycle);
          cycles.push(cycle);
          effects.push({ kind: "anchor", at: pose.position, iteration: 1 });
        }
        return forward;
      }
      case "back": {
        const cycle = cycles[cycles.length - 1];
        if (!cycle) throw new RuntimeFault("'끝은 처음이다' with no open '여기가 처음이다' to return to");
        endIteration(cycle);
        effects.push({ kind: "back", to: (cycle.anchor as Pose).position });
        return { op: "jump", to: cycle.anchor as Pose };
      }
      case "end": {
        while (cycles.length > 0 && !stop) leaveInnermost();
        endIteration(run);
        effects.push({ kind: "end" });
        for (const [, open] of slots) {
          for (const slot of open) effects.push({ kind: "unanswered", slot: slot.id, symbol: store.format(slot.symbol) });
        }
        const undetermined = lines.flatMap((line) => (line.text === null && line.term ? pendingLabels(line.term) : []));
        if (!stop && undetermined.length > 0) {
          const symbols = [...new Set(undetermined)];
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
        const left = operation.at === "start" ? atStart(operation.name) : recorded(operation.name);
        constrain(termOf(left), termOf(readRecorded(operation.value)), operation.at === "start" ? "past, at 처음" : "past", sentence);
        return forward;
      }
      case "promise": {
        const current = scope();
        const term = termOf(read(operation.value));
        effects.push({ kind: "promise", name: operation.name, term: store.format(term), due: dueLabel(current) });
        current.promises.push({ name: operation.name, term, madeAt: now, sentence });
        return forward;
      }
      case "fixed": {
        const current = scope();
        if (!current.anchor) throw new RuntimeFault("'처음은 끝이었다' needs an open '여기가 처음이다' whose start it can compare with");
        current.fixed.push({ madeAt: now, sentence });
        effects.push({ kind: "fixed", due: dueLabel(current) });
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
    loop: info.selfLoop,
    mark: info.value && info.selfLoop ? "SELF_CAUSED" : info.retroactive ? "RETRO" : null,
  });

  return {
    outcome,
    output: lines.map((line) => line.text ?? "?"),
    values,
    symbols: store.all().map(summarize),
    trace,
  };
}
