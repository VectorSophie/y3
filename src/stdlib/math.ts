import { RuntimeFault } from "../semantics/fault";
import { arith, fit, numericType, order } from "../semantics/numeric";
import { float, type ConcreteValue } from "../semantics/values";
import { asFloat, namespace, T } from "./core";

// std/math (수학). Generic over one numeric type at a time; integers stay checked.
// Float functions follow IEEE 754 at the value's width.

const width = (v: ConcreteValue) => (v.kind === "float" ? v.width : 64);
const floatOp = (f: (x: number) => number) => ([x]: readonly ConcreteValue[]) => float(f(asFloat(x)), width(x as ConcreteValue));

// Half away from zero, like Go's math.Round and Rust's f64::round. Exact: x − trunc(x)
// never rounds.
export function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x;
  const t = Math.trunc(x);
  return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t;
}

const pick = (op: "lt" | "gt") => (args: readonly ConcreteValue[]) => {
  const [a, b] = args as [ConcreteValue, ConcreteValue];
  if (a.kind === "float" && (Number.isNaN(a.value) || Number.isNaN(b.kind === "float" ? b.value : 0))) return float(NaN, a.width);
  return order(op, a, b) ? a : b;
};

export const MATH = namespace("std.math", "수학", {
  abs: [
    "절댓값",
    {
      kind: "pure",
      signature: { typeParams: ["T"], bounds: { T: "number" }, params: [T], result: T },
      apply: ([x], types) => {
        const v = x as ConcreteValue;
        if (v.kind === "float") return float(Math.abs(v.value), v.width);
        const n = v.kind === "int" ? v.value : 0n;
        return fit(numericType(types.result), n < 0n ? -n : n, () => `|${n}|`);
      },
    },
  ],
  min: ["최솟값", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "number" }, params: [T, T], result: T }, apply: pick("lt") }],
  max: ["최댓값", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "number" }, params: [T, T], result: T }, apply: pick("gt") }],
  clamp: [
    "범위",
    {
      kind: "pure",
      signature: { typeParams: ["T"], bounds: { T: "number" }, params: [T, T, T], result: T },
      apply: ([x, lo, hi]) => {
        const [v, a, b] = [x, lo, hi] as ConcreteValue[] as [ConcreteValue, ConcreteValue, ConcreteValue];
        if (order("gt", a, b)) throw new RuntimeFault(`a range cannot run from ${a.kind === "int" || a.kind === "float" ? a.value : "?"} down to ${b.kind === "int" || b.kind === "float" ? b.value : "?"}`);
        return order("lt", v, a) ? a : order("gt", v, b) ? b : v;
      },
    },
  ],
  rem: [
    "나머지",
    {
      kind: "pure",
      signature: { typeParams: ["T"], bounds: { T: "integer" }, params: [T, T], result: T },
      apply: ([a, b], types) => arith("rem", numericType(types.result), a as ConcreteValue, b as ConcreteValue),
    },
  ],
  sqrt: ["제곱근", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "float" }, params: [T], result: T }, apply: floatOp(Math.sqrt) }],
  floor: ["내림", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "float" }, params: [T], result: T }, apply: floatOp(Math.floor) }],
  ceil: ["올림", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "float" }, params: [T], result: T }, apply: floatOp(Math.ceil) }],
  round: ["반올림", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "float" }, params: [T], result: T }, apply: floatOp(roundHalfAway) }],
});

