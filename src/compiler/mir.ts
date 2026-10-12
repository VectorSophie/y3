import type { CallableId, Expr, Moment, NounId, Pattern, PlaneId, Stmt } from "../ir/hir";
import type { CompiledProgram } from "../ir/program";
import type { ArithOp, OrderOp } from "../semantics/numeric";
import { numericType } from "../semantics/numeric";
import { showValue, type ConcreteValue } from "../semantics/values";
import type { Pose } from "../space/manifest";
import { ARITH, ops } from "../runtime/evaluate";
import type { Instruction } from "../runtime/instructions";
import { formatType, type NumericName, type Type } from "../types/types";
import type { BodyId, Cfg, CfgNode, Edge, Target } from "./cfg";

// MIR: the spatial CFG with every step's work written out as explicit operations on
// registers (docs/v2-compiler-pipeline.md §4). Each operation is one call into the
// runtime core or one shared evaluation operation, in exactly the order the reference
// interpreter evaluates HIR. No Korean appears here; sentences live in the debug map.
//
// Registers are written once. None outlives the step that writes it: values that cross
// steps are nouns, which the runtime keeps as semantic versions.

export type Reg = number;

export type MirOp =
  | { readonly op: "const"; readonly dst: Reg; readonly value: ConcreteValue }
  | { readonly op: "load"; readonly dst: Reg; readonly noun: NounId } // a noun's value, settled; records a use
  | { readonly op: "recorded"; readonly dst: Reg; readonly noun: NounId } // the version itself, symbolic identity kept
  | { readonly op: "anchorRead"; readonly dst: Reg; readonly noun: NounId; readonly moment: Moment }
  | { readonly op: "move"; readonly dst: Reg; readonly src: Reg }
  | { readonly op: "arith"; readonly dst: Reg; readonly arith: ArithOp; readonly type: NumericName; readonly a: Reg; readonly b: Reg }
  | { readonly op: "now"; readonly dst: Reg; readonly src: Reg; readonly purpose: string } // concrete now, or UNRESOLVED
  | { readonly op: "not"; readonly dst: Reg; readonly a: Reg }
  | { readonly op: "eq"; readonly dst: Reg; readonly a: Reg; readonly b: Reg }
  | { readonly op: "order"; readonly dst: Reg; readonly order: OrderOp; readonly a: Reg; readonly b: Reg }
  | { readonly op: "builtin"; readonly dst: Reg; readonly callee: CallableId; readonly args: readonly Reg[]; readonly types: { readonly args: readonly Type[]; readonly result: Type } }
  | { readonly op: "construct"; readonly dst: Reg; readonly type: string; readonly variant: string | null; readonly fields: readonly Reg[] }
  | { readonly op: "field"; readonly dst: Reg; readonly record: Reg; readonly index: number; readonly name: string }
  | { readonly op: "checkField"; readonly record: Reg; readonly index: number; readonly name: string }
  | { readonly op: "setField"; readonly dst: Reg; readonly record: Reg; readonly index: number; readonly value: Reg }
  | { readonly op: "array"; readonly dst: Reg; readonly elements: readonly Reg[] }
  | { readonly op: "index"; readonly dst: Reg; readonly base: Reg; readonly index: Reg }
  | { readonly op: "checkWritable"; readonly base: Reg }
  | { readonly op: "writePosition"; readonly dst: Reg; readonly base: Reg; readonly index: Reg }
  | { readonly op: "setIndex"; readonly dst: Reg; readonly base: Reg; readonly at: Reg; readonly value: Reg }
  | { readonly op: "sliceBound"; readonly dst: Reg; readonly base: Reg; readonly bound: Reg }
  | { readonly op: "slice"; readonly dst: Reg; readonly base: Reg; readonly from: Reg; readonly to: Reg }
  | { readonly op: "length"; readonly dst: Reg; readonly base: Reg }
  // Pattern test: dst is a Bool; on a match, `binds` receive the bound values, in the
  // order the pattern names them.
  | { readonly op: "test"; readonly dst: Reg; readonly scrutinee: Reg; readonly pattern: Pattern; readonly binds: readonly { readonly local: string; readonly reg: Reg }[] }
  // Statement services of the runtime core.
  | { readonly op: "assign"; readonly noun: NounId; readonly src: Reg }
  | { readonly op: "declare"; readonly noun: NounId }
  | { readonly op: "receive"; readonly noun: NounId }
  | { readonly op: "send"; readonly noun: NounId }
  | { readonly op: "pastLeft"; readonly dst: Reg; readonly noun: NounId; readonly moment: "now" | "start" }
  | { readonly op: "past"; readonly left: Reg; readonly right: Reg; readonly moment: "now" | "start" }
  | { readonly op: "promise"; readonly noun: NounId; readonly src: Reg }
  | { readonly op: "fixedPoint" }
  | { readonly op: "anchor"; readonly pose: Pose }
  | { readonly op: "leave" } // a conditional back-edge not taken leaves the innermost loop
  | { readonly op: "end" };

export type MirTest =
  | { readonly kind: "eq"; readonly a: Reg; readonly b: Reg; readonly negated: boolean }
  | { readonly kind: "order"; readonly order: OrderOp; readonly a: Reg; readonly b: Reg }
  | { readonly kind: "bool"; readonly a: Reg };

// How a block ends. `edge` targets are CFG targets; `block` targets stay inside the step.
export type MirTerminator =
  | { readonly kind: "edge"; readonly edge: Edge } // the step is over: leave the node by this edge
  | { readonly kind: "back"; readonly edge: Edge | null } // end the iteration, then the edge (null: FAULT)
  | { readonly kind: "call"; readonly plane: PlaneId; readonly args: readonly Reg[]; readonly results: readonly NounId[]; readonly edge: Edge }
  | { readonly kind: "return"; readonly values: readonly Reg[] }
  | { readonly kind: "test"; readonly test: MirTest; readonly then: number; readonly otherwise: number } // a statement's condition: reports a test effect
  | { readonly kind: "if"; readonly cond: Reg; readonly then: number; readonly otherwise: number } // inside an expression (a pattern test)
  | { readonly kind: "goto"; readonly block: number }
  | { readonly kind: "unreachable"; readonly reason: string };

// A block belongs to one CFG node; the node's first block is where its step begins.
export type MirBlock = { readonly id: number; readonly node: number; readonly start: boolean; ops: MirOp[]; terminator: MirTerminator };

export type Mir = {
  readonly cfg: Cfg;
  readonly blocks: readonly MirBlock[];
  readonly nodeBlock: ReadonlyMap<number, number>; // CFG node → its first block
  readonly registers: number; // registers per step, at most
};

export class LoweringError extends Error {}

export function lowerToMir(program: CompiledProgram, cfg: Cfg): Mir {
  const blocks: MirBlock[] = [];
  const nodeBlock = new Map<number, number>();
  let maxRegisters = 0;

  const newBlock = (node: number, start = false): MirBlock => {
    const block: MirBlock = { id: blocks.length, node, start, ops: [], terminator: { kind: "unreachable", reason: "unfinished" } };
    blocks.push(block);
    return block;
  };

  for (const node of cfg.nodes) {
    let next = 0; // registers, numbered per step
    const reg = () => next++;
    let block = newBlock(node.id, true);
    nodeBlock.set(node.id, block.id);
    const emit = (op: MirOp) => block.ops.push(op);

    // Lowers an expression in the reference interpreter's order; returns its register.
    const expr = (e: Expr, locals: ReadonlyMap<string, Reg>): Reg => {
      const sub = (x: Expr) => expr(x, locals);
      const needed = (x: Expr, purpose: string): Reg => {
        const r = sub(x);
        const dst = reg();
        emit({ op: "now", dst, src: r, purpose });
        return dst;
      };
      const dst = () => reg();
      switch (e.node) {
        case "Literal": {
          const d = dst();
          // At the literal's type: the same function the interpreter uses.
          emit({ op: "const", dst: d, value: ops.literal(e.value, e.type) });
          return d;
        }
        case "LoadNoun": {
          const d = dst();
          emit({ op: "load", dst: d, noun: e.noun });
          return d;
        }
        case "LoadLocal": {
          const r = locals.get(e.local);
          if (r === undefined) throw new LoweringError(`'${e.local}' is not bound`);
          const d = dst();
          emit({ op: "move", dst: d, src: r });
          return d;
        }
        case "TemporalAnchorRead": {
          const d = dst();
          emit({ op: "anchorRead", dst: d, noun: e.noun, moment: e.moment });
          return d;
        }
        case "Add":
        case "Sub":
        case "Mul":
        case "Div": {
          const a = sub(e.left);
          const b = sub(e.right);
          const d = dst();
          emit({ op: "arith", dst: d, arith: ARITH[e.node], type: numericType(e.type), a, b });
          return d;
        }
        case "Compare": {
          const a = needed(e.left, "this comparison");
          const b = needed(e.right, "this comparison");
          const d = dst();
          emit({ op: "order", dst: d, order: e.op, a, b });
          return d;
        }
        case "Eq": {
          const a = needed(e.left, "this comparison");
          const b = needed(e.right, "this comparison");
          const d = dst();
          emit({ op: "eq", dst: d, a, b });
          return d;
        }
        case "Not": {
          const a = needed(e.operand, "this negation");
          const d = dst();
          emit({ op: "not", dst: d, a });
          return d;
        }
        case "Call": {
          const args = e.args.map(sub);
          const d = dst();
          emit({ op: "builtin", dst: d, callee: e.callee, args, types: { args: e.args.map((a) => a.type), result: e.type } });
          return d;
        }
        case "Construct": {
          const fields = e.args.map((a) => needed(a, "a data value"));
          const d = dst();
          emit({ op: "construct", dst: d, type: e.typeName, variant: e.variant, fields });
          return d;
        }
        case "Field": {
          const record = needed(e.record, "a field");
          const d = dst();
          emit({ op: "field", dst: d, record, index: e.index, name: e.field });
          return d;
        }
        case "SetField": {
          const record = needed(e.record, "a field");
          emit({ op: "checkField", record, index: e.index, name: e.field });
          const value = needed(e.value, "a data value");
          const d = dst();
          emit({ op: "setField", dst: d, record, index: e.index, value });
          return d;
        }
        case "ArrayLiteral": {
          const elements = e.elements.map((x) => needed(x, "an array"));
          const d = dst();
          emit({ op: "array", dst: d, elements });
          return d;
        }
        case "Index": {
          const base = needed(e.base, "an element");
          const index = needed(e.index, "an index");
          const d = dst();
          emit({ op: "index", dst: d, base, index });
          return d;
        }
        case "SetIndex": {
          const base = needed(e.base, "an element");
          emit({ op: "checkWritable", base });
          const index = needed(e.index, "an index");
          const at = dst();
          emit({ op: "writePosition", dst: at, base, index });
          const value = needed(e.value, "an array");
          const d = dst();
          emit({ op: "setIndex", dst: d, base, at, value });
          return d;
        }
        case "Slice": {
          const base = needed(e.base, "a slice");
          const fromValue = needed(e.from, "a slice");
          const from = dst();
          emit({ op: "sliceBound", dst: from, base, bound: fromValue });
          const toValue = needed(e.to, "a slice");
          const to = dst();
          emit({ op: "sliceBound", dst: to, base, bound: toValue });
          const d = dst();
          emit({ op: "slice", dst: d, base, from, to });
          return d;
        }
        case "Length": {
          const base = needed(e.base, "a length");
          const d = dst();
          emit({ op: "length", dst: d, base });
          return d;
        }
        case "Match": {
          // Each arm: test the pattern, then either evaluate the body or try the next arm.
          const scrutinee = needed(e.scrutinee, "a match");
          const result = dst();
          const join = newBlock(node.id);
          for (const arm of e.arms) {
            const binds = bindsOf(arm.pattern).map((local) => ({ local, reg: reg() }));
            const ok = dst();
            emit({ op: "test", dst: ok, scrutinee, pattern: arm.pattern, binds });
            const body = newBlock(node.id);
            const rest = newBlock(node.id);
            block.terminator = { kind: "if", cond: ok, then: body.id, otherwise: rest.id };
            block = body;
            const inner = new Map(locals);
            for (const b of binds) inner.set(b.local, b.reg);
            const value = expr(arm.body, inner);
            emit({ op: "move", dst: result, src: value });
            block.terminator = { kind: "goto", block: join.id };
            block = rest;
          }
          block.terminator = { kind: "unreachable", reason: "no arm matched; the type checker should have caught this" };
          block = join;
          return result;
        }
      }
    };

    const noLocals = new Map<string, Reg>();
    const statement = (stmt: Stmt | null, edge: Edge | null): void => {
      const leave = (): void => {
        if (!edge) throw new LoweringError(`node #${node.id} has no edge for ${stmt?.node ?? "a blank cell"}`);
        block.terminator = { kind: "edge", edge };
      };
      if (stmt === null) return leave();
      switch (stmt.node) {
        case "StoreNoun":
          emit({ op: "assign", noun: stmt.noun, src: expr(stmt.value, noLocals) });
          return leave();
        case "Eval":
          expr(stmt.expr, noLocals);
          return leave();
        case "TemporalDeclare":
          emit({ op: "declare", noun: stmt.noun });
          return leave();
        case "TemporalReceive":
          emit({ op: "receive", noun: stmt.noun });
          return leave();
        case "TemporalSend":
          emit({ op: "send", noun: stmt.noun });
          return leave();
        case "TemporalAssert": {
          const left = reg();
          emit({ op: "pastLeft", dst: left, noun: stmt.noun, moment: stmt.moment });
          let right: Reg;
          if (stmt.value.node === "LoadNoun") {
            right = reg();
            emit({ op: "recorded", dst: right, noun: stmt.value.noun });
          } else {
            right = expr(stmt.value, noLocals);
          }
          emit({ op: "past", left, right, moment: stmt.moment });
          return leave();
        }
        case "TemporalPromise":
          emit({ op: "promise", noun: stmt.noun, src: expr(stmt.value, noLocals) });
          return leave();
        case "TemporalFixedPoint":
          emit({ op: "fixedPoint" });
          return leave();
        case "Move":
        case "Turn":
        case "FloorMove":
          return leave();
        case "Anchor":
          emit({ op: "anchor", pose: node.pose });
          return leave();
        case "BackEdge":
          block.terminator = { kind: "back", edge };
          return;
        case "CallPlane": {
          const args = stmt.args.map((a) => expr(a, noLocals));
          if (!edge) throw new LoweringError(`node #${node.id}: a call with no edge`);
          block.terminator = { kind: "call", plane: stmt.plane, args, results: stmt.results, edge };
          return;
        }
        case "Return":
          block.terminator = { kind: "return", values: stmt.values.map((v) => expr(v, noLocals)) };
          return;
        case "End":
          emit({ op: "end" });
          return leave();
        case "Branch": {
          const c = stmt.condition;
          let test: MirTest;
          if (c.node === "Eq") test = { kind: "eq", a: expr(c.left, noLocals), b: expr(c.right, noLocals), negated: false };
          else if (c.node === "Not" && c.operand.node === "Eq") test = { kind: "eq", a: expr(c.operand.left, noLocals), b: expr(c.operand.right, noLocals), negated: true };
          else if (c.node === "Compare") test = { kind: "order", order: c.op, a: expr(c.left, noLocals), b: expr(c.right, noLocals) };
          else test = { kind: "bool", a: expr(c, noLocals) };
          const thenBlock = newBlock(node.id);
          const elseBlock = newBlock(node.id);
          block.terminator = { kind: "test", test, then: thenBlock.id, otherwise: elseBlock.id };
          block = thenBlock;
          statement(stmt.then, node.then);
          block = elseBlock;
          if (stmt.then.node === "BackEdge") emit({ op: "leave" });
          if (!node.otherwise) throw new LoweringError(`node #${node.id}: a branch with no fall-through edge`);
          block.terminator = { kind: "edge", edge: node.otherwise };
          return;
        }
      }
    };

    statement(node.stmt, node.always);
    maxRegisters = Math.max(maxRegisters, next);
  }
  return { cfg, blocks, nodeBlock, registers: maxRegisters };
}

// The locals a pattern binds, in the order the matcher binds them.
function bindsOf(p: Pattern): string[] {
  switch (p.kind) {
    case "bind":
      return [p.local];
    case "variant":
    case "record":
      return p.fields.flatMap(bindsOf);
    default:
      return [];
  }
}

// ---- Printing, for `y3 mir`.

const r = (n: Reg) => `r${n}`;

export function formatTarget(t: Target, mir: Mir): string {
  switch (t.kind) {
    case "node":
      return `b${mir.nodeBlock.get(t.node)}`;
    case "void":
      return `VOID (${t.at.x},${t.at.y},${t.at.z})`;
    case "halt":
      return "HALT";
    case "return":
      return "RETURN";
    case "call":
      return `call ${t.plane}`;
  }
}

export function formatMirOp(o: MirOp): string {
  switch (o.op) {
    case "const":
      return `${r(o.dst)} = const ${showValue(o.value)}`;
    case "load":
    case "recorded":
      return `${r(o.dst)} = ${o.op} #${o.noun}`;
    case "anchorRead":
      return `${r(o.dst)} = anchorRead ${o.moment} #${o.noun}`;
    case "move":
      return `${r(o.dst)} = ${r(o.src)}`;
    case "arith":
      return `${r(o.dst)} = ${o.arith} ${o.type} ${r(o.a)}, ${r(o.b)}`;
    case "now":
      return `${r(o.dst)} = now ${r(o.src)}`;
    case "not":
      return `${r(o.dst)} = not ${r(o.a)}`;
    case "eq":
      return `${r(o.dst)} = eq ${r(o.a)}, ${r(o.b)}`;
    case "order":
      return `${r(o.dst)} = ${o.order} ${r(o.a)}, ${r(o.b)}`;
    case "builtin":
      return `${r(o.dst)} = builtin ${o.callee}(${o.args.map(r).join(", ")}) : ${formatType(o.types.result)}`;
    case "construct":
      return `${r(o.dst)} = construct ${o.variant ?? o.type}(${o.fields.map(r).join(", ")})`;
    case "field":
      return `${r(o.dst)} = field ${r(o.record)}.${o.index}`;
    case "checkField":
      return `checkField ${r(o.record)}.${o.index}`;
    case "setField":
      return `${r(o.dst)} = setField ${r(o.record)}.${o.index} ← ${r(o.value)}`;
    case "array":
      return `${r(o.dst)} = array [${o.elements.map(r).join(", ")}]`;
    case "index":
      return `${r(o.dst)} = index ${r(o.base)}[${r(o.index)}]`;
    case "checkWritable":
      return `checkWritable ${r(o.base)}`;
    case "writePosition":
      return `${r(o.dst)} = writePosition ${r(o.base)}[${r(o.index)}]`;
    case "setIndex":
      return `${r(o.dst)} = setIndex ${r(o.base)}[${r(o.at)}] ← ${r(o.value)}`;
    case "sliceBound":
      return `${r(o.dst)} = sliceBound ${r(o.base)} ${r(o.bound)}`;
    case "slice":
      return `${r(o.dst)} = slice ${r(o.base)}[${r(o.from)}..${r(o.to)}]`;
    case "length":
      return `${r(o.dst)} = length ${r(o.base)}`;
    case "test":
      return `${r(o.dst)} = test ${r(o.scrutinee)} pattern${o.binds.length ? ` binds ${o.binds.map((b) => `${b.local}→${r(b.reg)}`).join(", ")}` : ""}`;
    case "assign":
      return `assign #${o.noun} ← ${r(o.src)}`;
    case "declare":
    case "receive":
    case "send":
      return `${o.op} #${o.noun}`;
    case "pastLeft":
      return `${r(o.dst)} = pastLeft ${o.moment} #${o.noun}`;
    case "past":
      return `past ${r(o.left)} = ${r(o.right)} (${o.moment})`;
    case "promise":
      return `promise #${o.noun} = ${r(o.src)}`;
    case "anchor":
      return `anchor (${o.pose.position.x},${o.pose.position.y},${o.pose.position.z})`;
    case "fixedPoint":
    case "leave":
    case "end":
      return o.op;
  }
}

export function formatMir(mir: Mir, describeNode: (node: CfgNode) => string = () => ""): string {
  const lines: string[] = [];
  const edgeText = (e: Edge) => `${e.kind} → ${formatTarget(e.target, mir)}`;
  for (const b of mir.blocks) {
    const node = mir.cfg.nodes[b.node] as CfgNode;
    lines.push(`b${b.id}${b.start ? `  node #${node.id} ${node.body}  ${describeNode(node)}` : ""}`);
    if (b.start) lines.push("  step");
    for (const o of b.ops) lines.push(`  ${formatMirOp(o)}`);
    const t = b.terminator;
    switch (t.kind) {
      case "edge":
        lines.push(`  ${edgeText(t.edge)}`);
        break;
      case "back":
        lines.push(t.edge ? `  back ${edgeText(t.edge)}` : "  back (no loop: FAULT)");
        break;
      case "call":
        lines.push(`  call ${t.plane}(${t.args.map(r).join(", ")})${t.results.length ? ` → ${t.results.map((n) => `#${n}`).join(", ")}` : ""} then ${t.edge.target.kind === "call" ? formatTarget(t.edge.target.continuation, mir) : "?"}`);
        break;
      case "return":
        lines.push(`  return ${t.values.map(r).join(", ")}`.trimEnd());
        break;
      case "test": {
        const c = t.test;
        const cond = c.kind === "eq" ? `${c.negated ? "ne" : "eq"} ${r(c.a)}, ${r(c.b)}` : c.kind === "order" ? `${c.order} ${r(c.a)}, ${r(c.b)}` : r(c.a);
        lines.push(`  test ${cond} ? b${t.then} : b${t.otherwise}`);
        break;
      }
      case "if":
        lines.push(`  if ${r(t.cond)} ? b${t.then} : b${t.otherwise}`);
        break;
      case "goto":
        lines.push(`  goto b${t.block}`);
        break;
      case "unreachable":
        lines.push(`  unreachable  # ${t.reason}`);
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}

export type { BodyId, Instruction };
