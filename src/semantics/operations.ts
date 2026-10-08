import type { Instruction } from "../runtime/instructions";

// What a cell does, independent of how it was written. Korean ends at the sentence
// parser; from here on there are only operations on named values and the machine's
// spatial instructions.

// A concrete runtime value. Present-tense execution only ever handles these; symbolic
// temporal terms live in temporal/ and are never folded into this type.
export type ConcreteValue = { readonly kind: "int"; readonly value: bigint } | { readonly kind: "text"; readonly value: string };

export type Operand = { readonly kind: "literal"; readonly value: ConcreteValue } | { readonly kind: "name"; readonly name: string };

export type Test = { readonly left: Operand; readonly right: Operand; readonly negated: boolean };

export type Operation =
  | { readonly op: "assign"; readonly name: string; readonly value: Operand }
  | { readonly op: "declare"; readonly name: string } // a symbol only the future can determine
  | { readonly op: "add"; readonly name: string; readonly amount: Operand }
  | { readonly op: "subtract"; readonly name: string; readonly amount: Operand }
  | { readonly op: "say"; readonly value: Operand }
  | { readonly op: "move"; readonly instruction: Exclude<Instruction, { op: "end" } | { op: "jump" } | { op: "nop" }> }
  | { readonly op: "anchor" }
  | { readonly op: "back" }
  | { readonly op: "end" }
  | { readonly op: "when"; readonly test: Test; readonly then: Act }
  // Relations (past and future tense): they add constraints and never write or move.
  | { readonly op: "assert"; readonly name: string; readonly value: Operand } // the name's current value is this
  | { readonly op: "promise"; readonly name: string; readonly value: Operand }; // the name will be this when the iteration (or run) ends

export type Relation = Extract<Operation, { op: "assert" } | { op: "promise" }>;
export type Act = Exclude<Operation, Relation | { op: "when" } | { op: "anchor" }>;

export function renderValue(value: ConcreteValue): string {
  return value.kind === "int" ? value.value.toString() : value.value;
}

export function showValue(value: ConcreteValue): string {
  return value.kind === "int" ? value.value.toString() : JSON.stringify(value.value);
}

export function sameValue(a: ConcreteValue, b: ConcreteValue): boolean {
  return a.kind === b.kind && a.value === b.value;
}
