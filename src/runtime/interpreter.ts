import type { Coordinate, Manifest, Pose } from "../space/manifest";
import { PRINTLN } from "../ir/callables";
import type { CallableId, Expr, Moment, NounId, Stmt } from "../ir/hir";
import { coordinateKey, type CompiledProgram } from "../semantics/program";
import { renderValue, sameValue, UNIT, type ConcreteValue } from "../semantics/values";
import { TemporalStore, type Resolution, type SymbolInfo } from "../temporal/store";
import { carriesCause, literal, symbolsOf, TermError, type SymbolicTerm } from "../temporal/terms";
import { concrete, evaluate, type EvalEnv, type Value } from "./evaluate";
import type { DecodeResult, Instruction } from "./instructions";
import { createMachine, step } from "./machine";
import type { ProgramOutcome, TemporalStatus } from "./program-outcome";
import type { TraceEntry } from "./trace";

// The interpreter. It runs the typed IR, never the Korean that produced it. Present
// tense executes on concrete values (M2). Past and future tense add constraints to the
// temporal store, which resolves a symbol only when the constraints leave exactly one
// value (M3). Temporal cycles (M4): channels carry a value from later to earlier, fixed
// points equate an iteration's end with its start, and time anchors read a noun at
// 처음 or 끝, all as linear equalities for the same solver. The interpreter never sees
// Korean, the machine never sees values, and the store never decides control flow.
//
// A noun's history is a chain of semantic versions (값₀, 값₁, …), SSA style: each store,
// declaration or receive defines a new version, and reads use the current one. A
// 처음 snapshot is a set of versions, not a copy of the machine.

// A noun's binding: concrete, or a symbolic term. Whether it carries an operational
// cause is read from its normal form (carriesCause), never from the syntax that built it.
type Binding = Value;

type Version = {
  readonly noun: NounId;
  readonly index: number; // 값₀, 값₁, …
  readonly binding: Binding;
  readonly definedAt: number; // step
  readonly uses: number[]; // steps that read this version
};

type Promise = { readonly noun: NounId; readonly term: SymbolicTerm; readonly madeAt: number; readonly sentence: string };
type EndRead = { readonly noun: NounId; readonly symbol: SymbolicTerm; readonly madeAt: number; readonly sentence: string };
type FixedPoint = { readonly madeAt: number; readonly sentence: string };

// One iteration of a loop, or the whole run. It remembers how it began, what it wrote,
// and what must be closed when it ends.
type Scope = {
  readonly anchor: Pose | null; // null for the run
  iteration: number;
  start: Map<NounId, Version>; // 처음: the versions current when this iteration began
  written: Set<NounId>;
  promises: Promise[];
  endReads: EndRead[]; // 끝의 N, read before the end
  fixed: FixedPoint[]; // 처음은 끝이었다
};

type Slot = { readonly id: string; readonly noun: NounId; readonly symbol: SymbolicTerm; readonly openedAt: number };
type Line = { text: string | null; term: SymbolicTerm | null; heldSince: number | null };

export type Effect =
  // ordinary present execution
  | { readonly kind: "set"; readonly name: string; readonly value: ConcreteValue }
  | { readonly kind: "say"; readonly line: string }
  | { readonly kind: "test"; readonly left: ConcreteValue; readonly right: ConcreteValue; readonly negated: boolean; readonly holds: boolean }
  | { readonly kind: "condition"; readonly holds: boolean } // a Bool condition that is not a comparison
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

// One semantic version of a noun and its def-use record.
export type VersionSummary = {
  readonly noun: string;
  readonly index: number;
  readonly definedAt: number;
  readonly value: string; // as it stands at the end of the run
  readonly uses: readonly number[];
};

export type ProgramResult = {
  readonly outcome: ProgramOutcome;
  readonly output: readonly string[]; // "?" for a line with no unique value
  readonly values: ReadonlyMap<string, ConcreteValue>; // nouns with concrete (or resolved) values
  readonly symbols: readonly SymbolSummary[];
  readonly versions: readonly VersionSummary[];
  readonly trace: readonly ProgramTraceEntry[];
};

class RuntimeFault extends Error {}
class Stopped extends Error {} // a temporal stop (UNRESOLVED, PARADOX) mid-statement

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function at(c: Coordinate): string {
  return `(${c.x},${c.y},${c.z})`;
}

export function runProgram(program: CompiledProgram, manifest: Manifest, options: { maxSteps?: number } = {}): ProgramResult {
  const store = new TemporalStore();
  const names = new Map(program.nouns.map((noun) => [noun.id, noun.name]));
  const nameOf = (id: NounId) => names.get(id) ?? `#${id}`;
  const current = new Map<NounId, Version>();
  const history: Version[] = [];
  const lines: Line[] = [];
  const run: Scope = { anchor: null, iteration: 1, start: new Map(), written: new Set(), promises: [], endReads: [], fixed: [] };
  const cycles: Scope[] = [];
  const slots = new Map<NounId, Slot[]>(); // per noun, most recent last
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
    return value ? concrete(value) : binding;
  };
  const termOf = (binding: Binding): SymbolicTerm => (binding.kind === "concrete" ? literal(binding.value) : binding.term);
  const pendingLabels = (term: SymbolicTerm) => store.pending(term).map((info) => info.label);

  // A noun's current version, keeping its symbolic identity even when resolved.
  const version = (noun: NounId): Version => {
    const found = current.get(noun);
    if (!found) throw new RuntimeFault(`'${nameOf(noun)}' has no value or symbol yet`);
    return found;
  };
  const recorded = (noun: NounId): Binding => version(noun).binding;
  const bound = (noun: NounId): Binding => {
    const v = version(noun);
    if (v.uses[v.uses.length - 1] !== now) v.uses.push(now);
    return settle(v.binding);
  };

  // A new version of the noun.
  const define = (noun: NounId, binding: Binding) => {
    const previous = current.get(noun);
    const next: Version = { noun, index: previous ? previous.index + 1 : 0, binding, definedAt: now, uses: [] };
    current.set(noun, next);
    history.push(next);
    run.written.add(noun);
    for (const cycle of cycles) cycle.written.add(noun);
  };

  const atStart = (noun: NounId): Binding => {
    const s = scope();
    if (!s.anchor) throw new RuntimeFault(`'처음의 ${nameOf(noun)}' needs an open '여기가 처음이다'`);
    const v = s.start.get(noun);
    if (!v) throw new RuntimeFault(`'${nameOf(noun)}' had no value at 처음 ${at(s.anchor.position)}`);
    return v.binding;
  };

  // 끝의 N: a value from the end of the iteration, carried back as a fresh symbol that
  // the end will settle.
  const fromEnd = (noun: NounId): Binding => {
    const s = scope();
    const symbol = store.declare(nameOf(noun), now, "끝");
    s.endReads.push({ noun, symbol, madeAt: now, sentence });
    effects.push({ kind: "endread", name: nameOf(noun), symbol: store.format(symbol), due: dueLabel(s) });
    return { kind: "symbolic", term: symbol };
  };

  const assign = (noun: NounId, binding: Binding) => {
    const settled = settle(binding);
    define(noun, settled);
    if (settled.kind === "concrete") {
      effects.push({ kind: "set", name: nameOf(noun), value: settled.value });
    } else {
      store.noteUse(settled.term, now);
      effects.push({ kind: "bind", name: nameOf(noun), term: store.format(settled.term) });
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
      const v = current.get(promise.noun);
      if (!v) throw new RuntimeFault(`'${nameOf(promise.noun)}' was promised a value but has none when the promise falls due`);
      constrain(termOf(v.binding), promise.term, `promised at t${promise.madeAt}`, promise.sentence);
    }
    for (const read of ending.endReads.splice(0)) {
      if (stop) return;
      const v = current.get(read.noun);
      if (!v) throw new RuntimeFault(`'끝의 ${nameOf(read.noun)}' was read, but '${nameOf(read.noun)}' has no value at the end`);
      noteLoop(read.symbol, termOf(v.binding), `끝의 ${nameOf(read.noun)}`);
      constrain(read.symbol, termOf(v.binding), `끝의 ${nameOf(read.noun)} from t${read.madeAt}`, read.sentence);
    }
    for (const fixed of ending.fixed.splice(0)) {
      const written = [...ending.written].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
      for (const noun of written) {
        if (stop) return;
        const before = ending.start.get(noun);
        const after = current.get(noun);
        if (!before || !after || before === after) continue; // introduced during the iteration, or untouched
        noteLoop(termOf(before.binding), termOf(after.binding), `fixed point at t${fixed.madeAt}`);
        constrain(termOf(before.binding), termOf(after.binding), `처음은 끝이었다 at t${fixed.madeAt}`, fixed.sentence);
      }
    }
  };

  const beginIteration = (s: Scope) => {
    s.start = new Map(current);
    s.written = new Set();
  };

  const leaveInnermost = () => {
    const cycle = cycles[cycles.length - 1];
    if (!cycle) return;
    endIteration(cycle);
    cycles.pop();
    effects.push({ kind: "leave", anchor: (cycle.anchor as Pose).position });
  };

  // A value the present needs now. An open symbol cannot be waited for: space never
  // waits for time, so the run stops here, UNRESOLVED.
  const needNow = (values: readonly Value[], purpose: string): ConcreteValue[] => {
    const open = [...new Set(values.flatMap((v) => (v.kind === "symbolic" ? pendingLabels(v.term) : [])))];
    if (open.length > 0) {
      effects.push({ kind: "unresolved", symbols: open });
      halt("UNRESOLVED", `${purpose} needs ${open.join(", ")}, which only the future could decide`);
      throw new Stopped();
    }
    return values.map((v) => {
      const settled = settle(v);
      if (settled.kind !== "concrete") throw new Error("a settled value with no open symbols must be concrete");
      return settled.value;
    });
  };

  const env: EvalEnv = {
    load: (noun) => bound(noun),
    anchor: (noun: NounId, moment: Moment) => (moment === "start" ? settle(atStart(noun)) : fromEnd(noun)),
    arithmetic: (left, right, sign) => {
      if (left.kind === "concrete" && right.kind === "concrete") {
        if (left.value.kind !== "int" || right.value.kind !== "int") throw new Error("arithmetic on a non-Int; the type checker should have caught this");
        return concrete({ kind: "int", value: left.value.value + sign * right.value.value });
      }
      try {
        return { kind: "symbolic", term: store.arithmetic(termOf(left), termOf(right), sign) };
      } catch (error) {
        if (error instanceof TermError) throw new RuntimeFault(error.message);
        throw error;
      }
    },
    effect: (callee: CallableId, args) => {
      if (callee !== PRINTLN) throw new Error(`no runtime support for ${callee}`);
      const value = settle(args[0] as Value);
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
      return concrete(UNIT);
    },
    now: (value, purpose) => needNow([value], purpose)[0] as ConcreteValue,
  };

  const forward: Instruction = { op: "nop" };

  const condition = (e: Expr): boolean => {
    // A comparison reports both sides; it needs both of them now.
    const comparison = e.node === "Eq" ? { eq: e, negated: false } : e.node === "Not" && e.operand.node === "Eq" ? { eq: e.operand, negated: true } : null;
    if (comparison) {
      const [left, right] = needNow([evaluate(comparison.eq.left, env), evaluate(comparison.eq.right, env)], "this condition");
      const holds = sameValue(left as ConcreteValue, right as ConcreteValue) !== comparison.negated;
      effects.push({ kind: "test", left: left as ConcreteValue, right: right as ConcreteValue, negated: comparison.negated, holds });
      return holds;
    }
    const [value] = needNow([evaluate(e, env)], "this condition");
    const holds = value?.kind === "bool" && value.value;
    effects.push({ kind: "condition", holds });
    return holds;
  };

  const execute = (stmt: Stmt, pose: Pose): Instruction => {
    switch (stmt.node) {
      case "StoreNoun":
        assign(stmt.noun, evaluate(stmt.value, env));
        return forward;
      case "Eval":
        evaluate(stmt.expr, env);
        return forward;
      case "TemporalDeclare": {
        const term = store.declare(nameOf(stmt.noun), now);
        define(stmt.noun, { kind: "symbolic", term });
        effects.push({ kind: "declare", name: nameOf(stmt.noun), symbol: store.format(term) });
        return forward;
      }
      case "TemporalReceive": {
        // A channel opens: the noun takes a value that something later will send back.
        const symbol = store.declare(nameOf(stmt.noun), now, "다음");
        slotCount += 1;
        const slot: Slot = { id: `S${slotCount}`, noun: stmt.noun, symbol, openedAt: now };
        slots.set(stmt.noun, [...(slots.get(stmt.noun) ?? []), slot]);
        define(stmt.noun, { kind: "symbolic", term: symbol });
        effects.push({ kind: "open", slot: slot.id, name: nameOf(stmt.noun), symbol: store.format(symbol) });
        return forward;
      }
      case "TemporalSend": {
        const slot = slots.get(stmt.noun)?.pop();
        const sent = recorded(stmt.noun);
        if (!slot) {
          effects.push({ kind: "contradiction", reason: `nothing earlier is waiting for '${nameOf(stmt.noun)}'` });
          halt("PARADOX", `[${sentence}] cannot hold: no past is listening for '${nameOf(stmt.noun)}'`);
          return forward;
        }
        const selfLoop = noteLoop(slot.symbol, termOf(sent), `channel ${slot.id}`);
        effects.push({ kind: "close", slot: slot.id, sent: store.format(termOf(sent)), openedAt: slot.openedAt, selfLoop });
        constrain(slot.symbol, termOf(sent), `channel ${slot.id}`, sentence);
        return forward;
      }
      case "Move":
        return { op: "step", relative: stmt.relative };
      case "Turn":
        return stmt.turn ? { op: "turn", turn: stmt.turn } : { op: "face", compass: stmt.compass as NonNullable<typeof stmt.compass> };
      case "FloorMove":
        return { op: "floor", delta: stmt.delta };
      case "Anchor": {
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
      case "BackEdge": {
        const cycle = cycles[cycles.length - 1];
        if (!cycle) throw new RuntimeFault("'끝은 처음이다' with no open '여기가 처음이다' to return to");
        endIteration(cycle);
        effects.push({ kind: "back", to: (cycle.anchor as Pose).position });
        return { op: "jump", to: cycle.anchor as Pose };
      }
      case "End": {
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
      case "Branch": {
        if (condition(stmt.condition)) return execute(stmt.then, pose);
        if (stmt.then.node === "BackEdge") leaveInnermost();
        return forward;
      }
      case "TemporalAssert": {
        const left = stmt.moment === "start" ? atStart(stmt.noun) : recorded(stmt.noun);
        // A noun on the right keeps its symbolic identity, so the constraint says what it is about.
        const right = stmt.value.node === "LoadNoun" ? recorded(stmt.value.noun) : evaluate(stmt.value, env);
        constrain(termOf(left), termOf(right), stmt.moment === "start" ? "past, at 처음" : "past", sentence);
        return forward;
      }
      case "TemporalPromise": {
        const s = scope();
        const term = termOf(evaluate(stmt.value, env));
        effects.push({ kind: "promise", name: nameOf(stmt.noun), term: store.format(term), due: dueLabel(s) });
        s.promises.push({ noun: stmt.noun, term, madeAt: now, sentence });
        return forward;
      }
      case "TemporalFixedPoint": {
        const s = scope();
        if (!s.anchor) throw new RuntimeFault("'처음은 끝이었다' needs an open '여기가 처음이다' whose start it can compare with");
        s.fixed.push({ madeAt: now, sentence });
        effects.push({ kind: "fixed", due: dueLabel(s) });
        return forward;
      }
    }
  };

  const decode = (_text: string, pose: Pose): DecodeResult => {
    const stmt = program.cells.get(coordinateKey(pose.position));
    if (!stmt) return { error: "this cell was not compiled" };
    sentence = stmt.at.source;
    try {
      return execute(stmt, pose);
    } catch (error) {
      if (error instanceof RuntimeFault) return { error: error.message };
      if (error instanceof Stopped) return forward;
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
  for (const [noun, v] of current) {
    const settled = settle(v.binding);
    if (settled.kind === "concrete") values.set(nameOf(noun), settled.value);
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
  const describe = (binding: Binding): string => {
    const settled = settle(binding);
    return settled.kind === "concrete" ? renderValue(settled.value) : store.format(settled.term);
  };

  return {
    outcome,
    output: lines.map((line) => line.text ?? "?"),
    values,
    symbols: store.all().map(summarize),
    versions: history.map((v) => ({ noun: nameOf(v.noun), index: v.index, definedAt: v.definedAt, value: describe(v.binding), uses: [...v.uses] })),
    trace,
  };
}
