import { callable } from "../ir/callables";
import type { CallableId, Expr, Moment, NounId, Pattern } from "../ir/hir";
import { bool, sameValue, type ConcreteValue } from "../semantics/values";
import type { SymbolicTerm } from "../temporal/terms";

// Evaluation of typed IR expressions. A value is concrete, or (for Int and Text only)
// a symbolic term the temporal store will settle later. Everything that touches nouns,
// time or effects is supplied by the environment; this module is the pure part, the
// same for the interpreter and for tests.

export type Value = { readonly kind: "concrete"; readonly value: ConcreteValue } | { readonly kind: "symbolic"; readonly term: SymbolicTerm };

export interface EvalEnv {
  load(noun: NounId): Value;
  anchor(noun: NounId, moment: Moment): Value;
  // Add or subtract; handles symbolic operands.
  arithmetic(left: Value, right: Value, sign: 1n | -1n): Value;
  // An effect callable (output). Its arguments may be symbolic.
  effect(callee: CallableId, args: readonly Value[]): Value;
  // A value needed now: concrete, or the environment stops (it throws).
  now(value: Value, purpose: string): ConcreteValue;
}

export const concrete = (value: ConcreteValue): Value => ({ kind: "concrete", value });

// Matches a value against a pattern, collecting bound locals; null when it does not match.
export function matchPattern(pattern: Pattern, value: ConcreteValue, bound: Map<string, ConcreteValue> = new Map()): Map<string, ConcreteValue> | null {
  switch (pattern.kind) {
    case "wildcard":
      return bound;
    case "bind":
      bound.set(pattern.local, value);
      return bound;
    case "literal":
      return sameValue(pattern.value, value) ? bound : null;
    case "variant":
    case "record": {
      if (value.kind !== "data" || value.type !== pattern.type) return null;
      if (pattern.kind === "variant" && value.variant !== pattern.variant) return null;
      for (let i = 0; i < pattern.fields.length; i += 1) {
        const field = value.fields[i];
        if (!field || !matchPattern(pattern.fields[i] as Pattern, field, bound)) return null;
      }
      return bound;
    }
  }
}

export function evaluate(e: Expr, env: EvalEnv, locals: ReadonlyMap<string, ConcreteValue> = new Map()): Value {
  const sub = (x: Expr) => evaluate(x, env, locals);
  const needed = (x: Expr, purpose: string) => env.now(sub(x), purpose);
  switch (e.node) {
    case "Literal":
      return concrete(e.value);
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
    case "Sub": {
      const left = sub(e.left);
      return env.arithmetic(left, sub(e.right), e.node === "Add" ? 1n : -1n);
    }
    case "Eq": {
      const left = needed(e.left, "this comparison");
      return concrete(bool(sameValue(left, needed(e.right, "this comparison"))));
    }
    case "Not": {
      const operand = needed(e.operand, "this negation");
      return concrete(bool(!(operand.kind === "bool" && operand.value)));
    }
    case "Call": {
      const target = callable(e.callee);
      const args = e.args.map(sub);
      if (target.kind === "effect") return env.effect(e.callee, args);
      return concrete(target.apply(args.map((arg) => env.now(arg, `'${target.namespace} ${target.name}'`))));
    }
    case "Construct":
      return concrete({ kind: "data", type: e.typeName, variant: e.variant, fields: e.args.map((arg) => needed(arg, "a data value")) });
    case "Field": {
      const record = needed(e.record, "a field");
      const field = record.kind === "data" ? record.fields[e.index] : undefined;
      if (!field) throw new Error(`no field '${e.field}'; the type checker should have caught this`);
      return concrete(field);
    }
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

