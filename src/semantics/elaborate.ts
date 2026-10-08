import type { CallAst, ExprAst, SentenceAst } from "../language/sentence-ast";
import { PRINTLN, resolveCallable } from "../ir/callables";
import { childExprs, type Expr, type Noun, type NounId, type Provenance, type Stmt } from "../ir/hir";
import { bool, int, text } from "./values";
import type { Type } from "../types/types";

// Sentence AST → HIR. Resolves nouns to ids and calls to callables, and spells every
// surface form as a language-neutral node: 더한다 is a store of an Add, 말한다 is a call
// to the same output callable as [표준 줄출력: …], 이 아니면 is Not(Eq). Types are left
// open here (PENDING) and filled in by the type checker.

export const PENDING: Type = { kind: "var", id: 0 };

export class ElaborationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const ELABORATION_CODES = { UNKNOWN_CALLABLE: "Y3Y002" } as const;

export class NounTable {
  private readonly byName = new Map<string, Noun>();

  id(name: string): NounId {
    const known = this.byName.get(name);
    if (known) return known.id;
    const noun: Noun = { id: this.byName.size + 1, name, type: PENDING };
    this.byName.set(name, noun);
    return noun.id;
  }

  all(): Noun[] {
    return [...this.byName.values()];
  }
}

export function elaborate(sentence: SentenceAst, at: Provenance, nouns: NounTable): Stmt {
  const node = <T extends object>(fields: T) => ({ ...fields, at });
  const typed = <T extends object>(fields: T): Expr => ({ ...fields, type: PENDING, at }) as unknown as Expr;

  const expr = (e: ExprAst): Expr => {
    switch (e.kind) {
      case "int":
        return typed({ node: "Literal", value: int(e.value) });
      case "text":
        return typed({ node: "Literal", value: text(e.value) });
      case "bool":
        return typed({ node: "Literal", value: bool(e.value) });
      case "noun":
        return typed({ node: "LoadNoun", noun: nouns.id(e.name) });
      case "anchored":
        return typed({ node: "TemporalAnchorRead", noun: nouns.id(e.name), moment: e.anchor === "처음" ? "start" : "end" });
    }
  };

  const call = (c: CallAst): Expr => {
    const resolution = resolveCallable(c.namespace, c.name);
    if (resolution.kind === "no-namespace") {
      throw new ElaborationError(
        ELABORATION_CODES.UNKNOWN_CALLABLE,
        `unknown namespace '${c.namespace}'; known namespaces: ${resolution.known.join(", ")}`,
      );
    }
    if (resolution.kind === "no-name") {
      throw new ElaborationError(
        ELABORATION_CODES.UNKNOWN_CALLABLE,
        `'${c.namespace}' has no callable '${c.name}'; it has ${resolution.known.join(", ")}`,
      );
    }
    return typed({ node: "Call", callee: resolution.callable.id, args: c.args.map(expr) });
  };

  const load = (name: string) => typed({ node: "LoadNoun", noun: nouns.id(name) });

  const stmt = (s: SentenceAst): Stmt => {
    switch (s.kind) {
      case "assign":
        return node({ node: "StoreNoun", noun: nouns.id(s.noun), value: s.value.kind === "call" ? call(s.value) : expr(s.value) }) as Stmt;
      case "call":
        return node({ node: "Eval", expr: call(s.call) }) as Stmt;
      case "declare":
        return node({ node: "TemporalDeclare", noun: nouns.id(s.noun) }) as Stmt;
      case "add":
      case "subtract":
        return node({
          node: "StoreNoun",
          noun: nouns.id(s.noun),
          value: typed({ node: s.kind === "add" ? "Add" : "Sub", left: load(s.noun), right: expr(s.amount) }),
        }) as Stmt;
      case "say":
        return node({ node: "Eval", expr: typed({ node: "Call", callee: PRINTLN, args: [expr(s.value)] }) }) as Stmt;
      case "receive":
        return node({ node: "TemporalReceive", noun: nouns.id(s.noun) }) as Stmt;
      case "send":
        return node({ node: "TemporalSend", noun: nouns.id(s.noun) }) as Stmt;
      case "turn":
        return node({ node: "Turn", turn: s.turn, compass: null }) as Stmt;
      case "face":
        return node({ node: "Turn", turn: null, compass: s.compass }) as Stmt;
      case "step":
        return node({ node: "Move", relative: s.relative }) as Stmt;
      case "floor":
        return node({ node: "FloorMove", delta: s.delta }) as Stmt;
      case "anchor":
        return node({ node: "Anchor" }) as Stmt;
      case "back":
        return node({ node: "BackEdge" }) as Stmt;
      case "end":
        return node({ node: "End" }) as Stmt;
      case "assert":
        return node({
          node: "TemporalAssert",
          noun: nouns.id(s.noun),
          moment: s.anchor === "처음" ? "start" : "now",
          value: expr(s.value),
        }) as Stmt;
      case "promise":
        // 끝의 N은 E일 것이다 and N은 E일 것이다 both speak of the end of the iteration.
        return node({ node: "TemporalPromise", noun: nouns.id(s.noun), value: expr(s.value) }) as Stmt;
      case "fixed":
        return node({ node: "TemporalFixedPoint" }) as Stmt;
      case "when": {
        const eq = typed({ node: "Eq", left: expr(s.condition.left), right: expr(s.condition.right) });
        return node({
          node: "Branch",
          condition: s.condition.negated ? typed({ node: "Not", operand: eq }) : eq,
          then: stmt(s.then),
        }) as Stmt;
      }
    }
  };

  return stmt(sentence);
}

// How a statement touches nouns, for the never-introduced check. A noun is introduced
// by a present-tense store, a 미정 declaration or a receive; anything else that names
// it (reading, sending, constraining) needs it introduced somewhere.
export function nounsIn(stmt: Stmt): { uses: NounId[]; introduces: NounId[] } {
  const uses: NounId[] = [];
  const introduces: NounId[] = [];
  const visitExpr = (e: Expr): void => {
    if (e.node === "LoadNoun" || e.node === "TemporalAnchorRead") uses.push(e.noun);
    for (const child of childExprs(e)) visitExpr(child);
  };
  const visit = (s: Stmt): void => {
    switch (s.node) {
      case "StoreNoun":
        visitExpr(s.value);
        introduces.push(s.noun);
        return;
      case "TemporalDeclare":
      case "TemporalReceive":
        introduces.push(s.noun);
        return;
      case "TemporalSend":
        uses.push(s.noun);
        return;
      case "TemporalAssert":
      case "TemporalPromise":
        uses.push(s.noun);
        visitExpr(s.value);
        return;
      case "Eval":
        visitExpr(s.expr);
        return;
      case "Branch":
        visitExpr(s.condition);
        visit(s.then);
        return;
      default:
        return;
    }
  };
  visit(stmt);
  return { uses, introduces };
}

