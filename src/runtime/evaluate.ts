import { callable, type Callable, type CallTypes } from "../ir/callables";
import type { CallableId, Expr, Moment, NounId, Pattern } from "../ir/hir";
import { bool, elementsOf, float, int, sameValue, UNIT, type ConcreteValue } from "../semantics/values";
import { RuntimeFault } from "../semantics/fault";
import { numericType, order, type ArithOp, type OrderOp } from "../semantics/numeric";
import type { NumericName, Type } from "../types/types";
import type { SymbolicTerm } from "../temporal/terms";
import { foreignLabel } from "./ffi";

// Evaluation of typed IR expressions. A value is concrete, or (for bigint and Text only)
// a symbolic term the temporal store will settle later. Everything that touches nouns,
// time or effects is supplied by the environment; this module is the pure part, the
// same for the interpreter and for tests.

export type Value = { readonly kind: "concrete"; readonly value: ConcreteValue } | { readonly kind: "symbolic"; readonly term: SymbolicTerm };

export interface EvalEnv {
  load(noun: NounId): Value;
  anchor(noun: NounId, moment: Moment): Value;
  // Arithmetic of this numeric type; the environment handles symbolic operands.
  arithmetic(op: ArithOp, type: NumericName, left: Value, right: Value): Value;
  // Standard output: the one effect whose value may still be symbolic (the write is held).
  output(value: Value, newline: boolean): void;
  // Any other effect, with concrete arguments, through the host.
  effect(target: Callable & { kind: "effect" }, args: readonly ConcreteValue[], types: CallTypes): ConcreteValue;
  // A call across the FFI boundary, with concrete arguments (docs/v2-ffi.md).
  foreign(id: string, args: readonly ConcreteValue[]): ConcreteValue;
  // A value needed now: concrete, or the environment stops (it throws).
  now(value: Value, purpose: string): ConcreteValue;
}

export const concrete = (value: ConcreteValue): Value => ({ kind: "concrete", value });

export { RuntimeFault };

// Data values (variants, records, arrays) are concrete for now: building one from an
// open temporal symbol needs that symbol's value now, so the run is UNRESOLVED.

// Matches a value against a pattern, collecting bound locals; null when it does not
// match. `bound` may start with the enclosing locals, which a pattern can shadow; a name
// bound twice by the same pattern is an invariant violation the checker rejects.
export function matchPattern(pattern: Pattern, value: ConcreteValue, bound: Map<string, ConcreteValue> = new Map()): Map<string, ConcreteValue> | null {
  const seen = new Set<string>();
  const go = (p: Pattern, v: ConcreteValue): boolean => {
    switch (p.kind) {
      case "wildcard":
        return true;
      case "bind":
        if (seen.has(p.local)) throw new Error(`'${p.local}' is bound twice in one pattern; the type checker should have caught this`);
        seen.add(p.local);
        bound.set(p.local, v);
        return true;
      case "literal":
        return sameValue(p.value, v);
      case "variant":
      case "record": {
        if (v.kind !== "data" || v.type !== p.type) return false;
        if (p.kind === "variant" && v.variant !== p.variant) return false;
        return p.fields.every((sub, i) => {
          const field = v.fields[i];
          return field !== undefined && go(sub, field);
        });
      }
    }
  };
  return go(pattern, value) ? bound : null;
}

// ---- Operations. Each is one step of evaluation on concrete values, shared by the HIR
// interpreter (evaluate, below) and the bytecode VM (runtime/vm), which call them in the
// same order. Checks that can FAULT happen inside them, at the same point for both.

function sequence(value: ConcreteValue): readonly ConcreteValue[] {
  const elements = elementsOf(value);
  if (!elements) throw new Error("an array or slice was expected; the type checker should have caught this");
  return elements;
}

// A checked position: an element index (below `length`), or a slice bound (up to `length`).
function position(value: ConcreteValue, length: number, what: "element" | "bound"): number {
  if (value.kind !== "int") throw new Error("an Int index was expected; the type checker should have caught this");
  const limit = what === "element" ? length - 1 : length;
  if (value.value < 0n || value.value > BigInt(limit)) {
    throw new RuntimeFault(`${what === "element" ? "index" : "slice bound"} ${value.value} is out of range for ${length} element${length === 1 ? "" : "s"}`);
  }
  return Number(value.value);
}

export const ops = {
  // A literal at its type: a float literal is rounded to the type's width.
  literal: (value: ConcreteValue, type: Type): ConcreteValue =>
    value.kind === "float" && type.kind === "prim" && type.name === "f32" ? float(value.value, 32) : value,
  not: (v: ConcreteValue): ConcreteValue => bool(!(v.kind === "bool" && v.value)),
  eq: (a: ConcreteValue, b: ConcreteValue): ConcreteValue => bool(sameValue(a, b)),
  order: (op: OrderOp, a: ConcreteValue, b: ConcreteValue): ConcreteValue => bool(order(op, a, b)),
  construct: (type: string, variant: string | null, fields: readonly ConcreteValue[]): ConcreteValue => ({ kind: "data", type, variant, fields }),
  field: (record: ConcreteValue, index: number, name: string): ConcreteValue => {
    const field = record.kind === "data" ? record.fields[index] : undefined;
    if (!field) throw new Error(`no field '${name}'; the type checker should have caught this`);
    return field;
  },
  // A record field write: the record is checked before the new value is evaluated.
  checkField: (record: ConcreteValue, index: number, name: string): void => {
    if (record.kind !== "data" || record.fields[index] === undefined) throw new Error(`no field '${name}'; the type checker should have caught this`);
  },
  setField: (record: ConcreteValue, index: number, value: ConcreteValue): ConcreteValue => {
    if (record.kind !== "data") throw new Error("a record was expected; the type checker should have caught this");
    const fields = [...record.fields];
    fields[index] = value;
    return { ...record, fields };
  },
  array: (elements: readonly ConcreteValue[]): ConcreteValue => ({ kind: "array", elements }),
  // An element read: the position is checked once both operands are known.
  index: (base: ConcreteValue, index: ConcreteValue): ConcreteValue => {
    const elements = sequence(base);
    return elements[position(index, elements.length, "element")] as ConcreteValue;
  },
  // An element write: the base is checked first, then the position (before the new
  // value is evaluated), then the write.
  checkWritable: (base: ConcreteValue): void => {
    if (base.kind !== "array" && base.kind !== "list") throw new Error("only an array's or a list's element can be written; the type checker should have caught this");
  },
  writePosition: (base: ConcreteValue, index: ConcreteValue): ConcreteValue => int(BigInt(position(index, sequence(base).length, "element"))),
  setIndex: (base: ConcreteValue, at: ConcreteValue, value: ConcreteValue): ConcreteValue => {
    if (base.kind !== "array" && base.kind !== "list") throw new Error("only an array's or a list's element can be written");
    const elements = [...base.elements];
    elements[Number(at.kind === "int" ? at.value : 0n)] = value;
    return { kind: base.kind, elements };
  },
  // Slice bounds are checked one at a time, as each is evaluated.
  sliceBound: (base: ConcreteValue, bound: ConcreteValue): ConcreteValue => int(BigInt(position(bound, sequence(base).length, "bound"))),
  slice: (base: ConcreteValue, from: ConcreteValue, to: ConcreteValue): ConcreteValue => {
    const a = Number(from.kind === "int" ? from.value : 0n);
    const b = Number(to.kind === "int" ? to.value : 0n);
    if (a > b) throw new RuntimeFault(`a slice cannot start at ${a} and end at ${b}`);
    // A view of the same storage: a slice of a slice still views the array.
    const storage = base.kind === "slice" ? base.storage : base.kind === "array" ? base.elements : [];
    const offset = base.kind === "slice" ? base.start : 0;
    return { kind: "slice", storage, start: offset + a, length: b - a };
  },
  length: (base: ConcreteValue): ConcreteValue => int(BigInt(sequence(base).length)),
};

// A built-in call, once its arguments are evaluated: output takes its value as it is
// (it may be symbolic); everything else needs every argument now, in order.
export function callBuiltin(env: EvalEnv, callee: CallableId, args: readonly Value[], types: CallTypes): Value {
  const target = callable(callee);
  if (target.kind === "output") {
    env.output(args[0] as Value, target.newline);
    return concrete(UNIT);
  }
  // Everything else needs its arguments now: the present never waits for the future.
  const values = args.map((arg) => env.now(arg, `'${target.namespace} ${target.name}'`));
  return concrete(target.kind === "pure" ? target.apply(values, types) : env.effect(target, values, types));
}

export function evaluate(e: Expr, env: EvalEnv, locals: ReadonlyMap<string, ConcreteValue> = new Map()): Value {
  const sub = (x: Expr) => evaluate(x, env, locals);
  const needed = (x: Expr, purpose: string) => env.now(sub(x), purpose);
  switch (e.node) {
    case "Literal":
      return concrete(ops.literal(e.value, e.type));
    case "LoadNoun":
      return env.load(e.noun);
    case "LoadLocal": {
      const value = locals.get(e.local);
      if (!value) throw new Error(`'${e.local}' is not bound; the type checker should have caught this`);
      return concrete(value);
    }
    case "TemporalAnchorRead":
      return env.anchor(e.noun, e.moment);
    case "Add":
    case "Sub":
    case "Mul":
    case "Div": {
      const left = sub(e.left);
      return env.arithmetic(ARITH[e.node], numericType(e.type), left, sub(e.right));
    }
    case "Compare": {
      const left = needed(e.left, "this comparison");
      return concrete(ops.order(e.op, left, needed(e.right, "this comparison")));
    }
    case "Eq": {
      const left = needed(e.left, "this comparison");
      return concrete(ops.eq(left, needed(e.right, "this comparison")));
    }
    case "Not":
      return concrete(ops.not(needed(e.operand, "this negation")));
    case "Call":
      return callBuiltin(env, e.callee, e.args.map(sub), { args: e.args.map((a) => a.type), result: e.type });
    case "ForeignCall":
      return concrete(env.foreign(e.foreign, e.args.map((a) => needed(a, foreignLabel(e.foreign)))));
    case "Construct":
      return concrete(ops.construct(e.typeName, e.variant, e.args.map((arg) => needed(arg, "a data value"))));
    case "Field":
      return concrete(ops.field(needed(e.record, "a field"), e.index, e.field));
    case "SetField": {
      const record = needed(e.record, "a field");
      ops.checkField(record, e.index, e.field);
      return concrete(ops.setField(record, e.index, needed(e.value, "a data value")));
    }
    case "ArrayLiteral":
      return concrete(ops.array(e.elements.map((x) => needed(x, "an array"))));
    case "Index": {
      const base = needed(e.base, "an element");
      return concrete(ops.index(base, needed(e.index, "an index")));
    }
    case "SetIndex": {
      const base = needed(e.base, "an element");
      ops.checkWritable(base);
      const at = ops.writePosition(base, needed(e.index, "an index"));
      return concrete(ops.setIndex(base, at, needed(e.value, "an array")));
    }
    case "Slice": {
      const base = needed(e.base, "a slice");
      const from = ops.sliceBound(base, needed(e.from, "a slice"));
      const to = ops.sliceBound(base, needed(e.to, "a slice"));
      return concrete(ops.slice(base, from, to));
    }
    case "Length":
      return concrete(ops.length(needed(e.base, "a length")));
    case "Match": {
      const scrutinee = needed(e.scrutinee, "a match");
      for (const arm of e.arms) {
        const bound = matchPattern(arm.pattern, scrutinee, new Map(locals));
        if (bound) return evaluate(arm.body, env, bound);
      }
      throw new Error("no arm matched; the type checker should have caught this");
    }
  }
}

export const ARITH = { Add: "add", Sub: "sub", Mul: "mul", Div: "div" } as const;
