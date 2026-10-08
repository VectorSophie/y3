import type { Coordinate, Manifest, Pose } from "../space/manifest";
import { coordinateKey, type CompiledProgram } from "../semantics/program";
import { renderValue, sameValue, showValue, type Operand, type Operation, type Value } from "../semantics/operations";
import type { DecodeResult, Instruction } from "./instructions";
import { createMachine, step } from "./machine";
import type { Outcome } from "./outcomes";
import type { TraceEntry } from "./trace";

// Present tense executes (M2). The interpreter keeps the named values, the output and
// the loop anchors, and turns each cell's operation into one spatial instruction for
// the machine. It never sees Korean, and the machine never sees values.

type Cycle = { anchor: Pose; iteration: number };

export type Effect =
  | { readonly kind: "set"; readonly name: string; readonly value: Value }
  | { readonly kind: "say"; readonly line: string }
  | { readonly kind: "test"; readonly left: Value; readonly right: Value; readonly negated: boolean; readonly holds: boolean }
  | { readonly kind: "anchor"; readonly at: Coordinate; readonly iteration: number }
  | { readonly kind: "back"; readonly to: Coordinate }
  | { readonly kind: "leave"; readonly anchor: Coordinate }
  | { readonly kind: "end" };

export type ProgramTraceEntry = TraceEntry & { readonly effects: readonly Effect[] };

export type ProgramResult = {
  readonly outcome: Outcome;
  readonly output: readonly string[];
  readonly values: ReadonlyMap<string, Value>;
  readonly trace: readonly ProgramTraceEntry[];
};

class RuntimeFault extends Error {}

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function runProgram(program: CompiledProgram, manifest: Manifest, options: { maxSteps?: number } = {}): ProgramResult {
  const values = new Map<string, Value>();
  const output: string[] = [];
  const cycles: Cycle[] = [];
  let effects: Effect[] = [];

  const read = (operand: Operand): Value => {
    if (operand.kind === "literal") return operand.value;
    const value = values.get(operand.name);
    if (value === undefined) throw new RuntimeFault(`'${operand.name}' has no value yet`);
    return value;
  };

  const integer = (operand: Operand, role: string): bigint => {
    const value = read(operand);
    if (value.kind !== "int") throw new RuntimeFault(`${role} must be an integer, not the text ${showValue(value)}`);
    return value.value;
  };

  const set = (name: string, value: Value) => {
    values.set(name, value);
    effects.push({ kind: "set", name, value });
  };

  const leaveInnermost = () => {
    const cycle = cycles.pop();
    if (cycle) effects.push({ kind: "leave", anchor: cycle.anchor.position });
  };

  const forward: Instruction = { op: "nop" };

  const execute = (operation: Operation, pose: Pose): Instruction => {
    switch (operation.op) {
      case "assign":
        set(operation.name, read(operation.value));
        return forward;
      case "add":
        set(operation.name, { kind: "int", value: integer({ kind: "name", name: operation.name }, `'${operation.name}'`) + integer(operation.amount, "the amount") });
        return forward;
      case "subtract":
        set(operation.name, { kind: "int", value: integer({ kind: "name", name: operation.name }, `'${operation.name}'`) - integer(operation.amount, "the amount") });
        return forward;
      case "say": {
        const line = renderValue(read(operation.value));
        output.push(line);
        effects.push({ kind: "say", line });
        return forward;
      }
      case "move":
        return operation.instruction;
      case "anchor": {
        const open = cycles.findIndex((cycle) => sameCoordinate(cycle.anchor.position, pose.position));
        if (open >= 0) {
          // Returning to an open anchor: close any cycles opened inside it, next iteration.
          while (cycles.length > open + 1) leaveInnermost();
          const cycle = cycles[open] as Cycle;
          cycle.iteration += 1;
          effects.push({ kind: "anchor", at: pose.position, iteration: cycle.iteration });
        } else {
          cycles.push({ anchor: pose, iteration: 1 });
          effects.push({ kind: "anchor", at: pose.position, iteration: 1 });
        }
        return forward;
      }
      case "back": {
        const cycle = cycles[cycles.length - 1];
        if (!cycle) throw new RuntimeFault("'끝은 처음이다' with no open '여기가 처음이다' to return to");
        effects.push({ kind: "back", to: cycle.anchor.position });
        return { op: "jump", to: cycle.anchor };
      }
      case "end":
        while (cycles.length > 0) leaveInnermost();
        effects.push({ kind: "end" });
        return { op: "end" };
      case "when": {
        const left = read(operation.test.left);
        const right = read(operation.test.right);
        const holds = sameValue(left, right) !== operation.test.negated;
        effects.push({ kind: "test", left, right, negated: operation.test.negated, holds });
        if (holds) return execute(operation.then, pose);
        // A back-edge whose condition fails falls through, leaving the loop.
        if (operation.then.op === "back") leaveInnermost();
        return forward;
      }
    }
  };

  const decode = (_sentence: string, pose: Pose): DecodeResult => {
    const operation = program.operations.get(coordinateKey(pose.position));
    if (!operation) return { error: "this cell was not compiled" };
    try {
      return execute(operation, pose);
    } catch (error) {
      if (error instanceof RuntimeFault) return { error: error.message };
      throw error;
    }
  };

  let state = createMachine(program.space, manifest, options);
  const trace: ProgramTraceEntry[] = [];
  while (!state.outcome) {
    effects = [];
    const result = step(program.space, state, decode);
    state = result.state;
    if (result.entry) trace.push({ ...result.entry, effects });
  }
  return { outcome: state.outcome, output, values, trace };
}
