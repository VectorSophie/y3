import type { Coordinate, Pose } from "../space/manifest";
import type { EffectContext, HostEvent } from "../ir/callables";
import { memoryHost, type Host } from "../stdlib/host";
import type { Moment, NounId } from "../ir/hir";
import type { Body, CompiledProgram, Procedure } from "../ir/program";
import { renderValue, sameValue, showValue, UNIT, type ConcreteValue } from "../semantics/values";
import { TemporalStore, type Resolution, type SymbolInfo } from "../temporal/store";
import { carriesCause, literal, symbolsOf, TermError, type SymbolicTerm } from "../temporal/terms";
import { concrete, RuntimeFault, type EvalEnv, type Value } from "./evaluate";
import { arith, order, type OrderOp } from "../semantics/numeric";
import type { ProgramOutcome, TemporalStatus } from "./program-outcome";
import type { TraceEntry } from "./trace";

// The runtime core: everything that executing a Y3 program does, as services. Two
// engines drive it: the HIR interpreter (runtime/interpreter), which finds control flow
// by moving a pointer through space and evaluates HIR trees; and the bytecode VM
// (runtime/vm), which follows a compiled spatial CFG and evaluates MIR on registers.
// Neither engine has semantics of its own: noun versions, frames, loops and their
// iterations, the temporal store, channels, promises, fixed points, output holding, the
// effect barrier, built-in dispatch, trace effects and the result all live here.
//
// Present tense executes on concrete values (M2). Past and future tense add constraints
// to the temporal store, which resolves a symbol only when the constraints leave exactly
// one value (M3). Temporal cycles (M4): channels carry a value from later to earlier,
// fixed points equate an iteration's end with its start, and time anchors read a noun at
// 처음 or 끝, all as linear equalities for the same solver.
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

// One iteration of a loop, or a whole activation (the run, or one call of a callable
// plane). It remembers how it began, what it wrote, and what must be closed when it ends.
type Scope = {
  readonly anchor: Pose | null; // null for the run or a call
  iteration: number;
  start: Map<NounId, Version>; // 처음: the versions current when this iteration began
  written: Set<NounId>;
  promises: Promise[];
  endReads: EndRead[]; // 끝의 N, read before the end
  fixed: FixedPoint[]; // 처음은 끝이었다
};

type Slot = { readonly id: string; readonly noun: NounId; readonly symbol: SymbolicTerm; readonly openedAt: number };

// One activation of a body: the main volume (the run), or one call of a callable plane.
// Its nouns, cycles and channels are its own; a lexical scope is a body, and a frame is
// one run of it. Temporal symbols are not frame-local: they live in the store, so a
// value can leave a call still symbolic and be determined after the frame is gone.
type Frame = {
  readonly activation: number; // 0 for the run, then 1, 2, … for each call
  readonly label: string | null; // "제곱#2"; null for the main volume
  readonly body: Body;
  readonly current: Map<NounId, Version>;
  readonly root: Scope; // the run, or the call: obligations made with no open cycle fall due when it ends
  readonly cycles: Scope[];
  readonly slots: Map<NounId, Slot[]>; // per noun, most recent last
  readonly returnTo: Pose | null; // the call cell's pose in the caller: position and full orientation
  readonly results: readonly NounId[]; // the caller's nouns that receive the returned values
};
// One write to standard output. Writes commit to the host in program order; a write
// whose value is still symbolic is held, and holds every write after it, until the
// value is determined. A held write never becomes a different text: it is written
// once, when known (or as "?" if the run ends first).
type Write = { text: string | null; term: SymbolicTerm | null; heldSince: number | null; readonly newline: boolean };

export type Effect =
  // ordinary present execution
  | { readonly kind: "set"; readonly name: string; readonly value: ConcreteValue }
  | { readonly kind: "say"; readonly line: string }
  | { readonly kind: "test"; readonly left: ConcreteValue; readonly right: ConcreteValue; readonly negated: boolean; readonly holds: boolean }
  | { readonly kind: "condition"; readonly holds: boolean } // a Bool condition that is not a comparison
  | { readonly kind: "order"; readonly op: OrderOp; readonly left: ConcreteValue; readonly right: ConcreteValue; readonly holds: boolean }
  | { readonly kind: "anchor"; readonly at: Coordinate; readonly iteration: number }
  | { readonly kind: "back"; readonly to: Coordinate }
  | { readonly kind: "leave"; readonly anchor: Coordinate }
  | { readonly kind: "end" }
  | { readonly kind: "write"; readonly text: string } // output without a line break
  | { readonly kind: "effect"; readonly source: string; readonly value: string } // an external effect, committed
  // calls
  | { readonly kind: "call"; readonly frame: string; readonly args: readonly string[] }
  | { readonly kind: "return"; readonly frame: string; readonly values: readonly string[] }
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

// `frame` names the activation the cell ran in ("제곱#2"); null for the main volume.
export type ProgramTraceEntry = TraceEntry & { readonly effects: readonly Effect[]; readonly frame: string | null };

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
  readonly frame?: string; // the call that defined it; absent for the main volume
  readonly noun: string;
  readonly index: number;
  readonly definedAt: number;
  readonly value: string; // as it stands at the end of the run
  readonly uses: readonly number[];
};

export type ProgramResult = {
  readonly outcome: ProgramOutcome;
  readonly output: readonly string[]; // standard output as lines; "?" for a value with no unique value
  readonly events: readonly HostEvent[]; // grounded inputs (stdin, clocks, files), in order, for replay
  readonly values: ReadonlyMap<string, ConcreteValue>; // nouns with concrete (or resolved) values
  readonly symbols: readonly SymbolSummary[];
  readonly versions: readonly VersionSummary[];
  readonly trace: readonly ProgramTraceEntry[];
};

// A temporal stop (UNRESOLVED, PARADOX) in the middle of a statement: the engine ends
// the step as if the cell moved the pointer forward, and the run stops.
export class Stopped extends Error {}

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function at(c: Coordinate): string {
  return `(${c.x},${c.y},${c.z})`;
}

// Where a call starts: the callable plane's first cell, facing 남, up 위.
export const CALL_ENTRY: Pose = { position: { x: 0, y: 0, z: 0 }, orientation: { forward: "south", up: "up" } };

export type RunOptions = { readonly maxSteps?: number; readonly host?: Host };

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(program: CompiledProgram, options: RunOptions = {}) {
  const store = new TemporalStore();
  const bodies = [program, ...program.procedures.values()];
  const names = new Map(bodies.flatMap((body) => body.nouns.map((noun) => [noun.id, noun.name] as const)));
  const nameOf = (id: NounId) => names.get(id) ?? `#${id}`;
  const history: (Version & { readonly frame: string | null })[] = [];
  const writes: Write[] = [];
  let committed = 0; // writes [0, committed) have reached the host
  const host = options.host ?? memoryHost();
  const events: HostEvent[] = [];
  const effectContext: EffectContext = { host, files: new Map() };
  // Commits every write up to the first one whose value is not yet known.
  const commit = (all = false) => {
    while (committed < writes.length) {
      const w = writes[committed] as Write;
      if (w.text === null && !all) return;
      const text = (w.text ?? "?") + (w.newline ? "\n" : "");
      host.write(text);
      events.push({ step: now, source: "std.io.stdout", value: JSON.stringify(text) });
      committed += 1;
    }
  };
  const newScope = (): Scope => ({ anchor: null, iteration: 1, start: new Map(), written: new Set(), promises: [], endReads: [], fixed: [] });
  const main: Frame = { activation: 0, label: null, body: program, current: new Map(), root: newScope(), cycles: [], slots: new Map(), returnTo: null, results: [] };
  const run = main.root;
  const frames: Frame[] = [main];
  let activations = 0;
  // The innermost frame's state, rebound on every call and return.
  let frame = main;
  let current = main.current;
  let cycles = main.cycles;
  let slots = main.slots;
  const enter = (f: Frame) => {
    frame = f;
    current = f.current;
    cycles = f.cycles;
    slots = f.slots;
  };
  let slotCount = 0;
  let effects: Effect[] = [];
  let now = 0; // the step being executed
  let sentence = "";
  let stop: { status: TemporalStatus; message: string } | null = null;

  const halt = (status: TemporalStatus, message: string) => {
    if (!stop) stop = { status, message };
  };

  const scope = (): Scope => cycles[cycles.length - 1] ?? frame.root;
  const dueLabel = (s: Scope) =>
    s.anchor ? `end of 처음 ${at(s.anchor.position)} #${s.iteration}` : frame.label === null ? "end of run" : `end of call ${frame.label}`;

  // A binding, made concrete whenever the store can justify it.
  const settle = (binding: Binding): Binding => {
    if (binding.kind === "concrete") return binding;
    const value = store.resolve(binding.term);
    return value ? concrete(value) : binding;
  };
  const describe = (binding: Binding): string => {
    const settled = settle(binding);
    return settled.kind === "concrete" ? renderValue(settled.value) : store.format(settled.term);
  };
  // As a trace shows it: text quoted.
  const show = (binding: Binding): string => {
    const settled = settle(binding);
    return settled.kind === "concrete" ? showValue(settled.value) : store.format(settled.term);
  };
  const termOf = (binding: Binding): SymbolicTerm => (binding.kind === "concrete" ? literal(binding.value) : binding.term);
  const pendingLabels = (term: SymbolicTerm) => store.pending(term).map((info) => info.label);

  // A noun's current version, keeping its symbolic identity even when resolved.
  const version = (noun: NounId): Version => {
    const found = current.get(noun);
    if (!found) throw new RuntimeFault(`'${nameOf(noun)}' has no value or symbol yet`);
    return found;
  };
  // Every read of a version is a use, whether the present computes with it or a
  // constraint (past, promise, send, 처음, 끝, fixed point) speaks about it.
  const use = (v: Version): Version => {
    if (v.uses[v.uses.length - 1] !== now) v.uses.push(now);
    return v;
  };
  const recorded = (noun: NounId): Binding => use(version(noun)).binding;
  const bound = (noun: NounId): Binding => settle(recorded(noun));

  // A new version of the noun.
  const define = (noun: NounId, binding: Binding) => {
    const previous = current.get(noun);
    const next: Version = { noun, index: previous ? previous.index + 1 : 0, binding, definedAt: now, uses: [] };
    current.set(noun, next);
    history.push({ ...next, frame: frame.label, uses: next.uses });
    frame.root.written.add(noun);
    for (const cycle of cycles) cycle.written.add(noun);
  };

  const atStart = (noun: NounId): Binding => {
    const s = scope();
    if (!s.anchor) throw new RuntimeFault(`'처음의 ${nameOf(noun)}' needs an open '여기가 처음이다'`);
    const v = s.start.get(noun);
    if (!v) throw new RuntimeFault(`'${nameOf(noun)}' had no value at 처음 ${at(s.anchor.position)}`);
    return use(v).binding;
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
    for (const line of writes) {
      if (line.text !== null || !line.term) continue;
      const value = store.resolve(line.term);
      if (!value) continue;
      line.text = renderValue(value);
      effects.push({ kind: "flush", line: line.text, heldSince: line.heldSince ?? now });
    }
    commit();
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
      constrain(termOf(use(v).binding), promise.term, `promised at t${promise.madeAt}`, promise.sentence);
    }
    for (const read of ending.endReads.splice(0)) {
      if (stop) return;
      const v = current.get(read.noun);
      if (!v) throw new RuntimeFault(`'끝의 ${nameOf(read.noun)}' was read, but '${nameOf(read.noun)}' has no value at the end`);
      noteLoop(read.symbol, termOf(use(v).binding), `끝의 ${nameOf(read.noun)}`);
      constrain(read.symbol, termOf(v.binding), `끝의 ${nameOf(read.noun)} from t${read.madeAt}`, read.sentence);
    }
    for (const fixed of ending.fixed.splice(0)) {
      const written = [...ending.written].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
      for (const noun of written) {
        if (stop) return;
        const before = ending.start.get(noun);
        const after = current.get(noun);
        if (!before || !after || before === after) continue; // introduced during the iteration, or untouched
        use(before);
        use(after);
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
    arithmetic: (op, type, left, right) => {
      if (left.kind === "concrete" && right.kind === "concrete") return concrete(arith(op, type, left.value, right.value));
      // Only bigint is temporal (the solver's integers are unbounded), and time solves
      // straight lines: a symbol may be added or subtracted, nothing more.
      if (type !== "bigint") throw new Error(`a symbolic ${type}; the type checker should have caught this`);
      if (op !== "add" && op !== "sub") {
        const [l, r] = needNow([left, right], op === "mul" ? "this multiplication" : "this division");
        return concrete(arith(op, type, l as ConcreteValue, r as ConcreteValue));
      }
      try {
        return { kind: "symbolic", term: store.arithmetic(termOf(left), termOf(right), op === "add" ? 1n : -1n) };
      } catch (error) {
        if (error instanceof TermError) throw new RuntimeFault(error.message);
        throw error;
      }
    },
    output: (arg, newline) => {
      const value = settle(arg);
      if (value.kind === "concrete") {
        const text = renderValue(value.value);
        writes.push({ text, term: null, heldSince: null, newline });
        effects.push(newline ? { kind: "say", line: text } : { kind: "write", text });
      } else {
        // The write happens now, but only the future can say what it reads.
        writes.push({ text: null, term: value.term, heldSince: now, newline });
        store.noteUse(value.term, now);
        effects.push({ kind: "hold", term: store.format(value.term) });
      }
      commit();
    },
    effect: (target, args, types) => {
      // An effect barrier: output held on an open symbol was written before this
      // effect, so this effect may not reach the outside world first. Stop here,
      // before anything is committed, rather than reorder what the world observes.
      if (committed < writes.length) {
        const open = [...new Set(writes.slice(committed).flatMap((w) => (w.text === null && w.term ? pendingLabels(w.term) : [])))];
        effects.push({ kind: "unresolved", symbols: open });
        halt("UNRESOLVED", `'${target.namespace} ${target.name}' cannot run while earlier output is held on ${open.join(", ")}: an effect never overtakes held output`);
        throw new Stopped();
      }
      try {
        const result = target.perform(args, effectContext, types);
        events.push({ step: now, source: target.id, value: showValue(result) });
        effects.push({ kind: "effect", source: target.id, value: showValue(result) });
        return result;
      } catch (error) {
        if (error instanceof RuntimeFault) throw error;
        // The host itself broke (not an ordinary error the program can handle).
        throw new RuntimeFault(`'${target.namespace} ${target.name}' failed in the host: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    now: (value, purpose) => needNow([value], purpose)[0] as ConcreteValue,
  };

  // ---- Statement services. Each engine evaluates expressions its own way, then calls
  // these with the values, in the order the reference interpreter does.

  const declare = (noun: NounId) => {
    const term = store.declare(nameOf(noun), now);
    define(noun, { kind: "symbolic", term });
    effects.push({ kind: "declare", name: nameOf(noun), symbol: store.format(term) });
  };

  // A channel opens: the noun takes a value that something later will send back.
  const receive = (noun: NounId) => {
    const symbol = store.declare(nameOf(noun), now, "다음");
    slotCount += 1;
    const slot: Slot = { id: `S${slotCount}`, noun, symbol, openedAt: now };
    slots.set(noun, [...(slots.get(noun) ?? []), slot]);
    define(noun, { kind: "symbolic", term: symbol });
    effects.push({ kind: "open", slot: slot.id, name: nameOf(noun), symbol: store.format(symbol) });
  };

  const send = (noun: NounId) => {
    const slot = slots.get(noun)?.pop();
    const sent = recorded(noun);
    if (!slot) {
      effects.push({ kind: "contradiction", reason: `nothing earlier is waiting for '${nameOf(noun)}'` });
      halt("PARADOX", `[${sentence}] cannot hold: no past is listening for '${nameOf(noun)}'`);
      return;
    }
    const selfLoop = noteLoop(slot.symbol, termOf(sent), `channel ${slot.id}`);
    effects.push({ kind: "close", slot: slot.id, sent: store.format(termOf(sent)), openedAt: slot.openedAt, selfLoop });
    constrain(slot.symbol, termOf(sent), `channel ${slot.id}`, sentence);
  };

  // A past statement: its left side is taken before its right side is evaluated.
  const pastLeft = (noun: NounId, moment: "now" | "start"): Binding => (moment === "start" ? atStart(noun) : recorded(noun));
  const past = (left: Binding, right: Binding, moment: "now" | "start") => {
    constrain(termOf(left), termOf(right), moment === "start" ? "past, at 처음" : "past", sentence);
  };

  const promise = (noun: NounId, value: Binding) => {
    const s = scope();
    const term = termOf(value);
    effects.push({ kind: "promise", name: nameOf(noun), term: store.format(term), due: dueLabel(s) });
    s.promises.push({ noun, term, madeAt: now, sentence });
  };

  const fixedPoint = () => {
    const s = scope();
    if (!s.anchor) throw new RuntimeFault("'처음은 끝이었다' needs an open '여기가 처음이다' whose start it can compare with");
    s.fixed.push({ madeAt: now, sentence });
    effects.push({ kind: "fixed", due: dueLabel(s) });
  };

  const anchor = (pose: Pose) => {
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
  };

  // Ends the innermost iteration and says where its anchor is.
  const backEdge = (): Pose => {
    const cycle = cycles[cycles.length - 1];
    if (!cycle) throw new RuntimeFault("'끝은 처음이다' with no open '여기가 처음이다' to return to");
    endIteration(cycle);
    effects.push({ kind: "back", to: (cycle.anchor as Pose).position });
    return cycle.anchor as Pose;
  };

  // A call: arguments are values the caller evaluated (and may be symbolic).
  const callEnter = (procedure: Procedure, evaluated: readonly Value[], returnTo: Pose, results: readonly NounId[]): string => {
    const args = evaluated.map(settle);
    activations += 1;
    const callee: Frame = {
      activation: activations,
      label: `${procedure.name}#${activations}`,
      body: procedure,
      current: new Map(),
      root: newScope(),
      cycles: [],
      slots: new Map(),
      returnTo,
      results,
    };
    frames.push(callee);
    enter(callee);
    procedure.params.forEach((p, i) => {
      const arg = args[i] as Value;
      if (arg.kind === "symbolic") store.noteUse(arg.term, now);
      define(p.noun, arg);
    });
    effects.push({ kind: "call", frame: callee.label as string, args: procedure.params.map((p, i) => `${p.name} := ${show(args[i] as Value)}`) });
    return callee.label as string;
  };

  // A return: closes the call's loops and obligations, pops its frame and writes the
  // results into the caller. Says where the call was made from.
  const callReturn = (evaluated: readonly Value[]): { returnTo: Pose; caller: Frame } => {
    const values = evaluated.map(settle);
    const returning = frame;
    if (!returning.returnTo) throw new RuntimeFault("only a callable plane returns; the main volume ends with '끝이다'");
    // The call is over: its open cycles, then its own obligations, fall due now.
    while (cycles.length > 0 && !stop) leaveInnermost();
    endIteration(returning.root);
    for (const [, open] of slots) {
      for (const slot of open) effects.push({ kind: "unanswered", slot: slot.id, symbol: store.format(slot.symbol) });
    }
    effects.push({ kind: "return", frame: returning.label as string, values: values.map(show) });
    frames.pop();
    const caller = frames[frames.length - 1] as Frame;
    enter(caller);
    // A plane that returns nothing gives () to a single receiving noun.
    returning.results.forEach((noun, i) => assign(noun, values[i] ?? concrete(UNIT)));
    return { returnTo: returning.returnTo, caller };
  };

  const end = () => {
    if (frames.length > 1) throw new RuntimeFault("'끝이다' ends the program; a callable plane returns with '돌려준다' or '돌아간다'");
    while (cycles.length > 0 && !stop) leaveInnermost();
    endIteration(run);
    effects.push({ kind: "end" });
    for (const [, open] of slots) {
      for (const slot of open) effects.push({ kind: "unanswered", slot: slot.id, symbol: store.format(slot.symbol) });
    }
    const undetermined = writes.flatMap((line) => (line.text === null && line.term ? pendingLabels(line.term) : []));
    if (!stop && undetermined.length > 0) {
      const symbols = [...new Set(undetermined)];
      effects.push({ kind: "ambiguous", symbols });
      halt("AMBIGUOUS", `the output depends on ${symbols.join(", ")}, which the constraints leave open`);
    }
  };

  // Conditions. A comparison reports both sides; it needs both of them now.
  const testEquality = (left: Value, right: Value, negated: boolean): boolean => {
    const [l, r] = needNow([left, right], "this condition") as [ConcreteValue, ConcreteValue];
    const holds = sameValue(l, r) !== negated;
    effects.push({ kind: "test", left: l, right: r, negated, holds });
    return holds;
  };
  const testOrder = (op: OrderOp, left: Value, right: Value): boolean => {
    const [l, r] = needNow([left, right], "this condition") as [ConcreteValue, ConcreteValue];
    const holds = order(op, l, r);
    effects.push({ kind: "order", op, left: l, right: r, holds });
    return holds;
  };
  const testBool = (value: Value): boolean => {
    const [v] = needNow([value], "this condition");
    const holds = v?.kind === "bool" && v.value;
    effects.push({ kind: "condition", holds });
    return holds;
  };

  // ---- Steps and the result.

  let lastAt: Coordinate = { x: 0, y: 0, z: 0 };
  let lastFrame: string | null = null;
  const beginStep = (step: number, at: Coordinate, source: string) => {
    effects = [];
    now = step;
    lastAt = at;
    lastFrame = frame.label;
    sentence = source;
  };

  // The run's result. `machine` is how space ended the run (null if time stopped it
  // first); a temporal stop outranks it.
  const finish = (machine: ProgramOutcome | null, steps: number, trace: readonly ProgramTraceEntry[]): ProgramResult => {
    const finalStop = stop as { status: TemporalStatus; message: string } | null;
    const ended: ProgramOutcome = finalStop ? { status: finalStop.status, steps, at: lastAt, message: finalStop.message } : (machine as ProgramOutcome);
    // An outcome inside a call says which activation it happened in: where the pointer
    // went for VOID and STEP_LIMIT (their positions are the next pose), where the cell ran
    // for the rest.
    const label = !finalStop && (ended.status === "VOID" || ended.status === "STEP_LIMIT") ? frame.label : lastFrame;
    const outcome: ProgramOutcome = label === null ? ended : { ...ended, frame: label };

    const values = new Map<string, ConcreteValue>();
    for (const [noun, v] of main.current) {
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

    // The run is over: whatever is still held is written as "?".
    commit(true);
    const stdout = writes.map((w) => (w.text ?? "?") + (w.newline ? "\n" : "")).join("");
    const output = stdout === "" ? [] : (stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout).split("\n");

    return {
      outcome,
      output,
      events,
      values,
      symbols: store.all().map(summarize),
      versions: history.map((v) => ({
        ...(v.frame === null ? {} : { frame: v.frame }),
        noun: nameOf(v.noun),
        index: v.index,
        definedAt: v.definedAt,
        value: describe(v.binding),
        uses: [...v.uses],
      })),
      trace,
    };
  };

  return {
    env,
    settle,
    recorded,
    assign,
    declare,
    receive,
    send,
    pastLeft,
    past,
    promise,
    fixedPoint,
    anchor,
    backEdge,
    leaveInnermost,
    callEnter,
    callReturn,
    end,
    testEquality,
    testOrder,
    testBool,
    beginStep,
    finish,
    effects: () => effects,
    stopped: () => stop !== null,
    frame: () => frame,
    depth: () => frames.length,
  };
}
