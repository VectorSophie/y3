import { float, int, type ConcreteValue } from "./values";
import { integerRange, isFloat, isInteger, type NumericName, type Type } from "../types/types";
import { RuntimeFault } from "./fault";

// Y3 arithmetic: one definition of every numeric operation, by operation and operand
// type (docs/v2-runtime-model.md §1). Fixed-width integers are checked, never wrapped;
// floats are IEEE 754 at their width. Any later backend must agree with this module.

export class NumericFault extends RuntimeFault {}

// An integer rounded to `bits` significant bits, ties to even: exact, so the only
// rounding an int → f32 conversion does is this one.
function roundToBits(v: bigint, bits: number): bigint {
  const sign = v < 0n ? -1n : 1n;
  const m = v * sign;
  const shift = BigInt(Math.max(0, m.toString(2).length - bits));
  if (shift === 0n) return v;
  const q = m >> shift;
  const rest = m - (q << shift);
  const half = 1n << (shift - 1n);
  const up = rest > half || (rest === half && (q & 1n) === 1n);
  return sign * ((q + (up ? 1n : 0n)) << shift);
}

export type ArithOp = "add" | "sub" | "mul" | "div" | "rem";
export type OrderOp = "lt" | "le" | "gt" | "ge";

const SYMBOL: Readonly<Record<ArithOp, string>> = { add: "+", sub: "-", mul: "×", div: "÷", rem: "%" };

// The numeric type of a typed expression (types are resolved before anything runs).
export function numericType(type: Type): NumericName {
  if (type.kind === "prim" && (isInteger(type.name) || isFloat(type.name))) return type.name;
  throw new Error(`a numeric type was expected, not ${type.kind === "prim" ? type.name : type.kind}; the type checker should have caught this`);
}

// An integer of this type, or a fault: values never wrap.
export function fit(type: NumericName, value: bigint, what: () => string): ConcreteValue {
  if (!isInteger(type)) throw new Error(`${type} is not an integer type`);
  const range = integerRange(type);
  if (range && (value < range.min || value > range.max)) throw new NumericFault(`${type} overflow: ${what()} = ${value} is outside ${range.min} … ${range.max}`);
  return int(value);
}

export function arith(op: ArithOp, type: NumericName, a: ConcreteValue, b: ConcreteValue): ConcreteValue {
  if (isFloat(type)) {
    if (a.kind !== "float" || b.kind !== "float") throw new Error("float operands expected; the type checker should have caught this");
    if (op === "rem") throw new Error("no remainder on floats; the type checker should have caught this");
    const x = a.value;
    const y = b.value;
    const r = op === "add" ? x + y : op === "sub" ? x - y : op === "mul" ? x * y : x / y;
    return float(r, type === "f32" ? 32 : 64); // computed in binary64, rounded once to binary32
  }
  if (a.kind !== "int" || b.kind !== "int") throw new Error("integer operands expected; the type checker should have caught this");
  const x = a.value;
  const y = b.value;
  const what = () => `${x} ${SYMBOL[op]} ${y}`;
  if ((op === "div" || op === "rem") && y === 0n) throw new NumericFault(`${type} division by zero: ${what()}`);
  // bigint division truncates toward zero, and a remainder takes the dividend's sign.
  const r = op === "add" ? x + y : op === "sub" ? x - y : op === "mul" ? x * y : op === "div" ? x / y : x % y;
  return fit(type, r, what);
}

export function order(op: OrderOp, a: ConcreteValue, b: ConcreteValue): boolean {
  const x = a.kind === "int" || a.kind === "float" || a.kind === "rune" ? a.value : null;
  const y = b.kind === "int" || b.kind === "float" || b.kind === "rune" ? b.value : null;
  if (x === null || y === null) throw new Error("ordered values expected; the type checker should have caught this");
  // IEEE: every comparison with NaN is false.
  return op === "lt" ? x < y : op === "le" ? x <= y : op === "gt" ? x > y : x >= y;
}

// An explicit conversion to `target` (docs/v2-runtime-model.md §1.3).
export function convert(target: NumericName, value: ConcreteValue): ConcreteValue {
  if (isFloat(target)) {
    const width = target === "f32" ? 32 : 64;
    if (value.kind === "float") return float(value.value, width);
    // Round to nearest, ties to even, once: Number() is exact below 2^53 and itself
    // rounds correctly to binary64; for binary32 round to 24 bits first.
    if (value.kind === "int") return float(Number(width === 32 ? roundToBits(value.value, 24) : value.value), width);
    throw new Error("a number was expected; the type checker should have caught this");
  }
  if (value.kind === "int") return fit(target, value.value, () => `${value.value} as ${target}`);
  if (value.kind === "float") {
    if (!Number.isFinite(value.value)) throw new NumericFault(`cannot convert ${value.value} to ${target}`);
    return fit(target, BigInt(Math.trunc(value.value)), () => `${value.value} as ${target}`);
  }
  throw new Error("a number was expected; the type checker should have caught this");
}
