import type { ActAst, Expr, SentenceAst } from "../language/sentence-ast";
import type { Operand, Operation } from "./operations";

// Sentence AST → operation. A thin, total mapping: everything Korean-specific has
// already been resolved by the sentence parser.

function operand(expr: Expr): Operand {
  switch (expr.kind) {
    case "int":
      return { kind: "literal", value: { kind: "int", value: expr.value } };
    case "text":
      return { kind: "literal", value: { kind: "text", value: expr.value } };
    case "noun":
      return { kind: "name", name: expr.name };
  }
}

type SimpleOperation = Exclude<Operation, { op: "when" } | { op: "anchor" }>;

function lowerAct(act: Exclude<ActAst, { kind: "anchor" }>): SimpleOperation {
  switch (act.kind) {
    case "assign":
      return { op: "assign", name: act.noun, value: operand(act.value) };
    case "add":
      return { op: "add", name: act.noun, amount: operand(act.amount) };
    case "subtract":
      return { op: "subtract", name: act.noun, amount: operand(act.amount) };
    case "say":
      return { op: "say", value: operand(act.value) };
    case "turn":
      return { op: "move", instruction: { op: "turn", turn: act.turn } };
    case "face":
      return { op: "move", instruction: { op: "face", compass: act.compass } };
    case "step":
      return { op: "move", instruction: { op: "step", relative: act.relative } };
    case "floor":
      return { op: "move", instruction: { op: "floor", delta: act.delta } };
    case "back":
      return { op: "back" };
    case "end":
      return { op: "end" };
  }
}

export function lower(sentence: SentenceAst): Operation {
  if (sentence.kind === "anchor") {
    return { op: "anchor" };
  }
  if (sentence.kind === "when") {
    if (sentence.then.kind === "anchor") {
      throw new Error("an anchor cannot be conditional"); // the parser rejects this
    }
    return {
      op: "when",
      test: { left: operand(sentence.condition.left), right: operand(sentence.condition.right), negated: sentence.condition.negated },
      then: lowerAct(sentence.then),
    };
  }
  return lowerAct(sentence);
}

// Names an operation reads and writes, for static checks.
export function namesIn(operation: Operation): { reads: string[]; writes: string[] } {
  const read = (o: Operand) => (o.kind === "name" ? [o.name] : []);
  switch (operation.op) {
    case "assign":
      return { reads: read(operation.value), writes: [operation.name] };
    case "add":
    case "subtract":
      return { reads: [operation.name, ...read(operation.amount)], writes: [operation.name] };
    case "say":
      return { reads: read(operation.value), writes: [] };
    case "when": {
      const inner = namesIn(operation.then);
      return { reads: [...read(operation.test.left), ...read(operation.test.right), ...inner.reads], writes: inner.writes };
    }
    default:
      return { reads: [], writes: [] };
  }
}
