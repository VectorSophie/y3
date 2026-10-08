import type { ActAst, Expr, SentenceAst } from "../language/sentence-ast";
import type { Act, Operand, Operation } from "./operations";

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

function lowerAct(act: Exclude<ActAst, { kind: "anchor" }>): Act {
  switch (act.kind) {
    case "assign":
      return { op: "assign", name: act.noun, value: operand(act.value) };
    case "declare":
      return { op: "declare", name: act.noun };
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
  switch (sentence.kind) {
    case "anchor":
      return { op: "anchor" };
    case "assert":
      return { op: "assert", name: sentence.noun, value: operand(sentence.value) };
    case "promise":
      return { op: "promise", name: sentence.noun, value: operand(sentence.value) };
    case "when":
      if (sentence.then.kind === "anchor") {
        throw new Error("an anchor cannot be conditional"); // the parser rejects this
      }
      return {
        op: "when",
        test: { left: operand(sentence.condition.left), right: operand(sentence.condition.right), negated: sentence.condition.negated },
        then: lowerAct(sentence.then),
      };
    default:
      return lowerAct(sentence);
  }
}

// How an operation touches names, for static checks. A name leaves the unbound state
// only when it is introduced: assigned in the present, or declared 미정. Reading it, or
// constraining it in the past or future, needs it to be introduced somewhere.
export function namesIn(operation: Operation): { uses: string[]; introduces: string[] } {
  const read = (o: Operand) => (o.kind === "name" ? [o.name] : []);
  switch (operation.op) {
    case "assign":
      return { uses: read(operation.value), introduces: [operation.name] };
    case "declare":
      return { uses: [], introduces: [operation.name] };
    case "add":
    case "subtract":
      return { uses: [operation.name, ...read(operation.amount)], introduces: [operation.name] };
    case "say":
      return { uses: read(operation.value), introduces: [] };
    case "assert":
    case "promise":
      return { uses: [operation.name, ...read(operation.value)], introduces: [] };
    case "when": {
      const inner = namesIn(operation.then);
      return { uses: [...read(operation.test.left), ...read(operation.test.right), ...inner.uses], introduces: inner.introduces };
    }
    default:
      return { uses: [], introduces: [] };
  }
}
