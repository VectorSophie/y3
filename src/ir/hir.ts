import type { Span } from "../language/ast";
import type { Compass, Relative, Turn } from "../space/orientation";
import type { Coordinate } from "../space/manifest";
import type { ConcreteValue } from "../semantics/values";
import type { Type } from "../types/types";

// Y3's typed semantic IR (its HIR). Surface syntax ends at the sentence parser; this is
// what every later layer targets. Nouns are resolved to ids, every expression carries
// its type, and every node keeps the place it came from. Nothing here knows about
// Korean particles or tense morphology: tense has become the choice between ordinary
// statements (present) and Temporal* statements (past, future, cycles).

// Where a node came from: source text, plane and cell.
export type Provenance = {
  readonly span: Span;
  readonly plane: { readonly slot: number; readonly name: string | null }; // floor index; named plane, if referenced
  readonly cell: Coordinate;
  readonly source: string; // the cell's sentence as written
};

export type NounId = number;
export type Noun = { readonly id: NounId; readonly name: string; type: Type };

export type Moment = "start" | "end"; // 처음, 끝 of the innermost iteration (or the run)

export type CallableId = string; // e.g. "std.io.println"

export type Pattern =
  | { readonly kind: "wildcard" }
  | { readonly kind: "bind"; readonly local: string } // binds the matched value for the arm
  | { readonly kind: "literal"; readonly value: ConcreteValue }
  | { readonly kind: "variant"; readonly type: string; readonly variant: string; readonly fields: readonly Pattern[] }
  | { readonly kind: "record"; readonly type: string; readonly fields: readonly Pattern[] }; // declaration order

type Typed = { type: Type; readonly at: Provenance };

export type Expr = Typed &
  (
    | { readonly node: "Literal"; readonly value: ConcreteValue }
    | { readonly node: "LoadNoun"; readonly noun: NounId }
    | { readonly node: "LoadLocal"; readonly local: string } // a name bound by a pattern
    | { readonly node: "Add"; readonly left: Expr; readonly right: Expr }
    | { readonly node: "Sub"; readonly left: Expr; readonly right: Expr }
    | { readonly node: "Eq"; readonly left: Expr; readonly right: Expr } // Eq<T>(T, T) -> Bool
    | { readonly node: "Not"; readonly operand: Expr }
    | { readonly node: "Call"; readonly callee: CallableId; readonly args: readonly Expr[] }
    | { readonly node: "TemporalAnchorRead"; readonly noun: NounId; readonly moment: Moment } // 처음의 N, 끝의 N
    // Algebraic data: build a variant (or a record, variant null), take a record field,
    // and match by pattern.
    | { readonly node: "Construct"; readonly typeName: string; readonly variant: string | null; readonly args: readonly Expr[] }
    | { readonly node: "Field"; readonly record: Expr; readonly field: string; index: number } // index: resolved by the checker
    | { readonly node: "Match"; readonly scrutinee: Expr; readonly arms: readonly { readonly pattern: Pattern; readonly body: Expr }[] }
  );

type Located = { readonly at: Provenance };

export type Stmt = Located &
  (
    | { readonly node: "StoreNoun"; readonly noun: NounId; readonly value: Expr }
    | { readonly node: "Eval"; readonly expr: Expr } // an expression for its effect (a call)
    | { readonly node: "Branch"; readonly condition: Expr; readonly then: Stmt } // falls through when false
    | { readonly node: "Move"; readonly relative: Relative }
    | { readonly node: "Turn"; readonly turn: Turn | null; readonly compass: Compass | null }
    | { readonly node: "FloorMove"; readonly delta: 1 | -1 }
    | { readonly node: "Anchor" }
    | { readonly node: "BackEdge" }
    | { readonly node: "End" }
    | { readonly node: "TemporalDeclare"; readonly noun: NounId } // N은 미정이다
    | { readonly node: "TemporalAssert"; readonly noun: NounId; readonly moment: "now" | "start"; readonly value: Expr } // past
    | { readonly node: "TemporalPromise"; readonly noun: NounId; readonly value: Expr } // future: due at the end of the iteration
    | { readonly node: "TemporalReceive"; readonly noun: NounId } // a value from later
    | { readonly node: "TemporalSend"; readonly noun: NounId } // back to the most recent receive
    | { readonly node: "TemporalFixedPoint" } // 처음은 끝이었다
  );

export type ExprNode = Expr["node"];
export type StmtNode = Stmt["node"];

// Every expression directly inside a statement or expression.
export function childExprs(item: Stmt | Expr): Expr[] {
  switch (item.node) {
    case "StoreNoun":
    case "TemporalAssert":
    case "TemporalPromise":
      return [item.value];
    case "Eval":
      return [item.expr];
    case "Branch":
      return [item.condition];
    case "Add":
    case "Sub":
    case "Eq":
      return [item.left, item.right];
    case "Not":
      return [item.operand];
    case "Call":
    case "Construct":
      return [...item.args];
    case "Field":
      return [item.record];
    case "Match":
      return [item.scrutinee, ...item.arms.map((arm) => arm.body)];
    default:
      return [];
  }
}

// Visits a statement and everything inside it, depth first.
export function walk(stmt: Stmt, visit: (item: Stmt | Expr) => void): void {
  const go = (item: Stmt | Expr) => {
    visit(item);
    if (item.node === "Branch") go(item.then);
    for (const child of childExprs(item)) go(child);
  };
  go(stmt);
}
