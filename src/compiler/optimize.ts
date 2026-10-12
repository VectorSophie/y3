import { arith, NumericFault } from "../semantics/numeric";
import type { ConcreteValue } from "../semantics/values";
import type { Mir, MirBlock, MirOp, MirTerminator, Reg } from "./mir";

// MIR optimizations (docs/v2-compiler-pipeline.md §6). They rewrite registers inside one
// step and nothing else: no node, edge, cell, orientation, noun, temporal operation,
// built-in call or branch test is ever removed, moved or merged.
//
//   fold       arithmetic and comparisons on constants (never one that would FAULT: a
//              fault must happen at its own step); `now` of a constant
//   neutral    x+0, x-0, x×1, x÷1 on fixed-width integers; x-(+0.0), x×1.0, x÷1.0 on
//              floats (not x+0.0, which turns -0.0 into +0.0). Never on bigint, the one
//              type that can be symbolic: temporal classification stays untouched.
//   copy       uses of a register copied from another read the original
//   dead       constants and copies nobody reads are dropped

export type OptimizationStats = { folded: number; neutral: number; copies: number; dead: number };

function readsOf(o: MirOp): Reg[] {
  const r = o as Record<string, unknown>;
  const single = ["src", "a", "b", "record", "value", "base", "at", "bound", "from", "to", "scrutinee", "left", "right"].filter((k) => typeof r[k] === "number").map((k) => r[k] as Reg);
  const index = typeof r.index === "number" && o.op !== "field" && o.op !== "checkField" && o.op !== "setField" ? [r.index as Reg] : [];
  const lists = ["args", "fields", "elements"].flatMap((k) => (Array.isArray(r[k]) ? (r[k] as Reg[]) : []));
  return [...single, ...index, ...lists];
}

function termReads(t: MirTerminator): Reg[] {
  switch (t.kind) {
    case "call":
      return [...t.args];
    case "return":
      return [...t.values];
    case "if":
      return [t.cond];
    case "test":
      return t.test.kind === "bool" ? [t.test.a] : [t.test.a, t.test.b];
    default:
      return [];
  }
}

// Rewrites the registers an operation reads.
function mapReads(o: MirOp, f: (r: Reg) => Reg): MirOp {
  const r = { ...(o as Record<string, unknown>) };
  for (const k of ["src", "a", "b", "record", "value", "base", "at", "bound", "from", "to", "scrutinee", "left", "right"]) if (typeof r[k] === "number") r[k] = f(r[k] as Reg);
  if (typeof r.index === "number" && o.op !== "field" && o.op !== "checkField" && o.op !== "setField") r.index = f(r.index as Reg);
  for (const k of ["args", "fields", "elements"]) if (Array.isArray(r[k])) r[k] = (r[k] as Reg[]).map(f);
  return r as MirOp;
}

function mapTermReads(t: MirTerminator, f: (r: Reg) => Reg): MirTerminator {
  switch (t.kind) {
    case "call":
      return { ...t, args: t.args.map(f) };
    case "return":
      return { ...t, values: t.values.map(f) };
    case "if":
      return { ...t, cond: f(t.cond) };
    case "test":
      return { ...t, test: t.test.kind === "bool" ? { ...t.test, a: f(t.test.a) } : { ...t.test, a: f(t.test.a), b: f(t.test.b) } };
    default:
      return t;
  }
}

const isZero = (v: ConcreteValue) => (v.kind === "int" && v.value === 0n) || (v.kind === "float" && Object.is(v.value, 0));
const isOne = (v: ConcreteValue) => (v.kind === "int" && v.value === 1n) || (v.kind === "float" && v.value === 1);

export function optimizeMir(mir: Mir): { mir: Mir; stats: OptimizationStats } {
  const stats: OptimizationStats = { folded: 0, neutral: 0, copies: 0, dead: 0 };
  const blocks: MirBlock[] = mir.blocks.map((b) => ({ ...b, ops: [...b.ops] }));
  const byNode = new Map<number, MirBlock[]>();
  for (const b of blocks) byNode.set(b.node, [...(byNode.get(b.node) ?? []), b]);

  for (const step of byNode.values()) {
    // Registers written exactly once in this step: only those are safe to reason about.
    const writes = new Map<Reg, number>();
    for (const b of step) for (const o of b.ops) for (const w of [...("dst" in o ? [o.dst] : []), ...(o.op === "test" ? o.binds.map((x) => x.reg) : [])]) writes.set(w, (writes.get(w) ?? 0) + 1);
    const once = (r: Reg) => writes.get(r) === 1;
    const constants = new Map<Reg, ConcreteValue>();
    const alias = new Map<Reg, Reg>();
    const resolve = (r: Reg): Reg => {
      let x = r;
      while (alias.has(x)) x = alias.get(x) as Reg;
      return x;
    };
    // Blocks of a step are visited in id order; a register is only folded or aliased when
    // its single definition dominates its uses, which holds for every register the
    // lowering writes once (a step's blocks are a tree joined only through match results,
    // and those are written in several arms, so they are never written once).
    for (const b of step) {
      b.ops = b.ops.map((o0) => {
        const o = mapReads(o0, resolve);
        const k = (r: Reg) => constants.get(r);
        if (o.op === "const" && once(o.dst)) constants.set(o.dst, o.value);
        if (o.op === "move" && once(o.dst) && once(o.src)) {
          alias.set(o.dst, o.src);
          stats.copies += 1;
          if (constants.has(o.src)) constants.set(o.dst, constants.get(o.src) as ConcreteValue);
          return o;
        }
        if (o.op === "now" && once(o.dst) && k(o.src)) {
          stats.folded += 1;
          constants.set(o.dst, k(o.src) as ConcreteValue);
          return { op: "const", dst: o.dst, value: k(o.src) as ConcreteValue };
        }
        if (o.op === "arith" && o.type !== "bigint" && once(o.dst)) {
          const a = k(o.a);
          const b2 = k(o.b);
          if (a && b2) {
            try {
              const value = arith(o.arith, o.type, a, b2);
              stats.folded += 1;
              constants.set(o.dst, value);
              return { op: "const", dst: o.dst, value };
            } catch (error) {
              if (!(error instanceof NumericFault)) throw error;
              return o; // it faults: leave it to fault at its own step
            }
          }
          const float = o.type === "f32" || o.type === "f64";
          const neutral =
            b2 !== undefined &&
            ((!float && (o.arith === "add" || o.arith === "sub") && isZero(b2)) ||
              ((o.arith === "mul" || o.arith === "div") && isOne(b2)) ||
              (float && o.arith === "sub" && b2.kind === "float" && Object.is(b2.value, 0)));
          if (neutral && once(o.a)) {
            stats.neutral += 1;
            alias.set(o.dst, o.a);
            return { op: "move", dst: o.dst, src: o.a };
          }
        }
        return o;
      });
      b.terminator = mapTermReads(b.terminator, resolve);
    }
    // Dead temporaries: constants and copies whose register nobody reads.
    for (;;) {
      const read = new Set<Reg>();
      for (const b of step) {
        for (const o of b.ops) for (const r of readsOf(o)) read.add(r);
        for (const r of termReads(b.terminator)) read.add(r);
      }
      let removed = 0;
      for (const b of step) {
        b.ops = b.ops.filter((o) => {
          const dead = (o.op === "const" || o.op === "move") && once(o.dst) && !read.has(o.dst);
          if (dead) removed += 1;
          return !dead;
        });
      }
      stats.dead += removed;
      if (removed === 0) break;
    }
  }
  return { mir: { ...mir, blocks }, stats };
}
