import type { Expr, Noun, Pattern, Stmt } from "./hir";
import { showValue } from "../semantics/values";
import { formatType } from "../types/types";

// A readable listing of typed IR, one statement per cell, with its provenance. Used by
// `y3 ir`; the shape is for people, not a serialisation format.

export function formatPattern(p: Pattern): string {
  switch (p.kind) {
    case "wildcard":
      return "_";
    case "bind":
      return p.local;
    case "literal":
      return showValue(p.value);
    case "variant":
      return p.fields.length === 0 ? p.variant : `${p.variant}(${p.fields.map(formatPattern).join(", ")})`;
    case "record":
      return `${p.type}(${p.fields.map(formatPattern).join(", ")})`;
  }
}

export function formatExpr(e: Expr, nouns: ReadonlyMap<number, string>): string {
  const sub = (x: Expr) => formatExpr(x, nouns);
  const noun = (id: number) => `${nouns.get(id) ?? "?"}#${id}`;
  const body = (() => {
    switch (e.node) {
      case "Literal":
        return showValue(e.value);
      case "LoadNoun":
        return noun(e.noun);
      case "LoadLocal":
        return e.local;
      case "TemporalAnchorRead":
        return `TemporalAnchorRead(${e.moment}, ${noun(e.noun)})`;
      case "Add":
      case "Sub":
      case "Eq":
        return `${e.node}(${sub(e.left)}, ${sub(e.right)})`;
      case "Not":
        return `Not(${sub(e.operand)})`;
      case "Call":
        return `Call ${e.callee}(${e.args.map(sub).join(", ")})`;
      case "Construct":
        return `${e.variant ?? e.typeName}(${e.args.map(sub).join(", ")})`;
      case "Field":
        return `${sub(e.record)}.${e.field}`;
      case "Match":
        return `Match ${sub(e.scrutinee)} { ${e.arms.map((arm) => `${formatPattern(arm.pattern)} => ${sub(arm.body)}`).join("; ")} }`;
    }
  })();
  return `${body} : ${formatType(e.type)}`;
}

export function formatStmt(s: Stmt, nouns: ReadonlyMap<number, string>): string {
  const expr = (e: Expr) => formatExpr(e, nouns);
  const noun = (id: number) => `${nouns.get(id) ?? "?"}#${id}`;
  switch (s.node) {
    case "StoreNoun":
      return `StoreNoun ${noun(s.noun)} ← ${expr(s.value)}`;
    case "Eval":
      return `Eval ${expr(s.expr)}`;
    case "Branch":
      return `Branch ${expr(s.condition)} → ${formatStmt(s.then, nouns)}`;
    case "Move":
      return `Move ${s.relative}`;
    case "Turn":
      return `Turn ${s.turn ?? s.compass}`;
    case "FloorMove":
      return `FloorMove ${s.delta > 0 ? "+1" : "-1"}`;
    case "Anchor":
    case "BackEdge":
    case "End":
    case "TemporalFixedPoint":
      return s.node;
    case "TemporalDeclare":
    case "TemporalReceive":
    case "TemporalSend":
      return `${s.node} ${noun(s.noun)}`;
    case "TemporalAssert":
      return `TemporalAssert ${s.moment === "start" ? "처음:" : ""}${noun(s.noun)} = ${expr(s.value)}`;
    case "TemporalPromise":
      return `TemporalPromise ${noun(s.noun)} = ${expr(s.value)}`;
  }
}

export function formatProgramIr(cells: Iterable<Stmt>, nouns: readonly Noun[]): string {
  const names = new Map(nouns.map((n) => [n.id, n.name]));
  const stmts = [...cells].sort((a, b) => a.at.cell.z - b.at.cell.z || a.at.cell.y - b.at.cell.y || a.at.cell.x - b.at.cell.x);
  const lines = stmts.map((s) => {
    const { cell, span, plane } = s.at;
    const where = `(${cell.x},${cell.y},${cell.z}) ${plane.name ? `:${plane.name}: ` : ""}${span.start.line}:${span.start.column}`;
    return `${where}  ${formatStmt(s, names)}`;
  });
  return [...lines, "nouns:", ...nouns.map((n) => `  ${n.name}#${n.id} : ${formatType(n.type)}`)].join("\n") + "\n";
}

