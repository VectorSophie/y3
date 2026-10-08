import type { Instruction } from "../runtime/instructions";

// What a cell does, independent of how it was written. Korean ends at the sentence
// parser; from here on there are only operations on named values and the machine's
// spatial instructions.

export type Value = { readonly kind: "int"; readonly value: bigint } | { readonly kind: "text"; readonly value: string };

export type Operand = { readonly kind: "literal"; readonly value: Value } | { readonly kind: "name"; readonly name: string };

export type Test = { readonly left: Operand; readonly right: Operand; readonly negated: boolean };

export type Operation =
  | { readonly op: "assign"; readonly name: string; readonly value: Operand }
  | { readonly op: "add"; readonly name: string; readonly amount: Operand }
  | { readonly op: "subtract"; readonly name: string; readonly amount: Operand }
  | { readonly op: "say"; readonly value: Operand }
  | { readonly op: "move"; readonly instruction: Exclude<Instruction, { op: "end" } | { op: "jump" } | { op: "nop" }> }
  | { readonly op: "anchor" }
  | { readonly op: "back" }
  | { readonly op: "end" }
  | { readonly op: "when"; readonly test: Test; readonly then: Exclude<Operation, { op: "when" } | { op: "anchor" }> };

export function renderValue(value: Value): string {
  return value.kind === "int" ? value.value.toString() : value.value;
}

export function showValue(value: Value): string {
  return value.kind === "int" ? value.value.toString() : JSON.stringify(value.value);
}

export function sameValue(a: Value, b: Value): boolean {
  return a.kind === b.kind && a.value === b.value;
}
