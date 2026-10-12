import type { NounId, Pattern, PlaneId } from "../ir/hir";
import { callable } from "../ir/callables";
import type { ConcreteValue } from "../semantics/values";
import { BUILTIN_TYPE_DEFS, formatType, integerRange, isFloat, isInteger, isNumeric, substituteParams, type Type, type TypeDef } from "../types/types";
import type { NodeInfo } from "../runtime/vm";
import type { BodyId } from "./cfg";
import type { MirBlock, MirOp, Reg } from "./mir";
import { BytecodeError } from "./bytecode";
import { y3Signature, type ForeignDecl } from "../runtime/ffi";

// The bytecode type verifier: proves, from the artifact alone, the typed-MIR invariant
// the VM and the runtime rely on. Every register has one type on every path through a
// step, and every instruction's operands and results have the types the instruction
// demands. This is not the source type checker run again: it reads only the resolved
// types the artifact carries (noun types, type declarations, procedure signatures, the
// types of literals, constructions and arrays, and instantiated built-in call types).
// A type variable (an open type the checker left) is rigid: it equals only itself.

const BOOL: Type = { kind: "prim", name: "Bool" };
const I64: Type = { kind: "prim", name: "i64" };
const UNIT: Type = { kind: "prim", name: "Unit" };

export type TypeContext = {
  readonly blocks: readonly MirBlock[];
  readonly nodeBlock: ReadonlyMap<number, number>;
  readonly nodes: readonly NodeInfo[];
  readonly nounTypes: ReadonlyMap<BodyId, ReadonlyMap<NounId, Type>>;
  readonly procedures: ReadonlyMap<PlaneId, { readonly params: readonly Type[]; readonly results: readonly Type[] }>;
  readonly typedefs: readonly TypeDef[];
  readonly foreign: ReadonlyMap<string, ForeignDecl>;
};

export function same(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "prim":
      return a.name === (b as typeof a).name;
    case "var":
      return a.id === (b as typeof a).id;
    case "param":
      return a.name === (b as typeof a).name;
    case "named": {
      const n = b as typeof a;
      return a.name === n.name && a.args.length === n.args.length && a.args.every((x, i) => same(x, n.args[i] as Type));
    }
    case "array":
      return a.length === (b as typeof a).length && same(a.element, (b as typeof a).element);
    case "slice":
      return same(a.element, (b as typeof a).element);
  }
}

const show = (t: Type) => formatType(t);

export function verifyTypes(ctx: TypeContext): void {
  const defs = new Map<string, TypeDef>(BUILTIN_TYPE_DEFS.map((d) => [d.name, d]));
  for (const d of ctx.typedefs) {
    if (defs.has(d.name)) throw new BytecodeError(`type '${d.name}' is declared twice`);
    defs.set(d.name, d);
  }

  // A type the artifact names must be well-formed: known names, right arities, no
  // parameters outside a definition.
  const wellFormed = (t: Type, where: string, params: ReadonlySet<string> = new Set()): void => {
    const fail = (m: string): never => {
      throw new BytecodeError(`${where}: ${m}`);
    };
    switch (t?.kind) {
      case "prim":
        if (!isNumeric(t.name) && !["Bool", "Text", "Unit", "Rune"].includes(t.name)) fail(`unknown type '${t.name}'`);
        return;
      case "var":
        if (!Number.isInteger(t.id)) fail("a malformed type variable");
        return;
      case "param":
        if (!params.has(t.name)) fail(`type parameter '${t.name}' outside its definition`);
        return;
      case "named": {
        const def = defs.get(t.name);
        if (!def) fail(`unknown type '${t.name}'`);
        if (def?.params.length !== t.args.length) fail(`'${t.name}' takes ${def?.params.length} type arguments, not ${t.args.length}`);
        for (const a of t.args) wellFormed(a, where, params);
        return;
      }
      case "array":
        if (!Number.isInteger(t.length) || t.length < 0) fail("a malformed array length");
        wellFormed(t.element, where, params);
        return;
      case "slice":
        wellFormed(t.element, where, params);
        return;
      default:
        fail("a malformed type");
    }
  };
  for (const d of ctx.typedefs) {
    const params = new Set(d.params);
    if (d.kind === "product") for (const f of d.fields) wellFormed(f.type, `type '${d.name}'`, params);
    else if (d.kind === "sum") for (const v of d.variants) for (const f of v.fields) wellFormed(f, `type '${d.name}'`, params);
    else throw new BytecodeError(`type '${d.name}': only built-in types are opaque`);
  }
  for (const [body, nouns] of ctx.nounTypes) for (const [id, t] of nouns) wellFormed(t, `noun #${id} of ${body}`);
  for (const [id, p] of ctx.procedures) for (const t of [...p.params, ...p.results]) wellFormed(t, `callable plane '${id}'`);

  // The fields of a data type, instantiated at `t`.
  const fieldsOf = (t: Type, variant: string | null, where: string): readonly Type[] => {
    const fail = (m: string): never => {
      throw new BytecodeError(`${where}: ${m}`);
    };
    if (t.kind !== "named") return fail(`${show(t)} is not a data type`);
    const def = defs.get(t.name);
    if (!def || def.kind === "opaque") return fail(`'${t.name}' is not built from fields`);
    const args = new Map(def.params.map((p, i) => [p, t.args[i] as Type]));
    if (def.kind === "product") {
      if (variant !== null) fail(`'${t.name}' is a record, not a sum`);
      return def.fields.map((f) => substituteParams(f.type, args));
    }
    const v = def.variants.find((x) => x.name === variant);
    if (!v) return fail(`'${t.name}' has no variant '${String(variant)}'`);
    return v.fields.map((f) => substituteParams(f, args));
  };

  // Whether a constant is a value of a type.
  const fits = (v: ConcreteValue, t: Type): boolean => {
    switch (v.kind) {
      case "int": {
        if (t.kind !== "prim" || !isInteger(t.name)) return false;
        const range = integerRange(t.name);
        return !range || (v.value >= range.min && v.value <= range.max);
      }
      case "float":
        return t.kind === "prim" && isFloat(t.name) && (t.name === "f32") === (v.width === 32);
      case "rune":
        return t.kind === "prim" && t.name === "Rune";
      case "text":
        return t.kind === "prim" && t.name === "Text";
      case "bool":
        return t.kind === "prim" && t.name === "Bool";
      case "unit":
        return t.kind === "prim" && t.name === "Unit";
      case "data": {
        if (t.kind !== "named" || t.name !== v.type) return false;
        try {
          const fields = fieldsOf(t, v.variant, "a constant");
          return fields.length === v.fields.length && v.fields.every((f, i) => fits(f, fields[i] as Type));
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  };

  // Key types: reflexive, structural equality (runtime model §3).
  const isKey = (t: Type, seen: ReadonlySet<string> = new Set()): boolean => {
    if (t.kind === "prim") return !isFloat(t.name);
    if (t.kind === "var") return true;
    if (t.kind !== "named") return false;
    const def = defs.get(t.name);
    if (!def || def.kind === "opaque") return false;
    if (seen.has(t.name)) return true;
    const args = new Map(def.params.map((p, i) => [p, t.args[i] as Type]));
    const fields = def.kind === "product" ? def.fields.map((f) => f.type) : def.variants.flatMap((v) => v.fields);
    return fields.every((f) => isKey(substituteParams(f, args), new Set([...seen, t.name])));
  };

  const temporal = (t: Type) => t.kind === "var" || (t.kind === "prim" && (t.name === "bigint" || t.name === "Text"));
  const numericOrRune = (t: Type) => t.kind === "prim" && (isNumeric(t.name) || t.name === "Rune");
  const elementOf = (t: Type, lists: boolean): Type | null =>
    t.kind === "array" || t.kind === "slice" ? t.element : lists && t.kind === "named" && t.name === "List" ? (t.args[0] as Type) : null;

  // A built-in's signature, matched against the instantiated call types: every type
  // parameter is bound once, consistently, and satisfies its bound.
  const matchCall = (callee: string, args: readonly Type[], call: { args: readonly Type[]; result: Type }, where: string): void => {
    const fail = (m: string): never => {
      throw new BytecodeError(`${where}: ${m}`);
    };
    const sig = callable(callee).signature;
    if (call.args.length !== args.length || !call.args.every((t, i) => same(t, args[i] as Type))) fail(`'${callee}' is called with ${args.map(show).join(", ")}, but its call types say ${call.args.map(show).join(", ")}`);
    const subst = new Map<string, Type>();
    const bind = (s: Type, a: Type): boolean => {
      switch (s.kind) {
        case "param": {
          const known = subst.get(s.name);
          if (known) return same(known, a);
          subst.set(s.name, a);
          return true;
        }
        case "named":
          return a.kind === "named" && a.name === s.name && a.args.length === s.args.length && s.args.every((x, i) => bind(x, a.args[i] as Type));
        case "array":
          return a.kind === "array" && a.length === s.length && bind(s.element, a.element);
        case "slice":
          return a.kind === "slice" && bind(s.element, a.element);
        default:
          return same(s, a);
      }
    };
    const fixed = sig.params.length;
    if (sig.rest ? args.length < fixed : args.length !== fixed) fail(`'${callee}' takes ${fixed}${sig.rest ? " or more" : ""} arguments, not ${args.length}`);
    args.forEach((a, i) => {
      const s = i < fixed ? (sig.params[i] as Type) : sig.rest === "same" ? ({ kind: "param", name: "T" } as Type) : null;
      if (s && !bind(s, a)) fail(`argument ${i + 1} of '${callee}' cannot be ${show(a)}`);
    });
    if (!bind(sig.result, call.result)) fail(`'${callee}' cannot return ${show(call.result)}`);
    for (const [name, bound] of Object.entries(sig.bounds ?? {})) {
      const t = subst.get(name);
      if (!t) continue;
      const ok =
        bound === "key" ? isKey(t) : t.kind === "prim" && (bound === "integer" ? isInteger(t.name) : bound === "float" ? isFloat(t.name) : isNumeric(t.name));
      if (!ok) fail(`'${callee}' needs ${bound === "key" ? "a key type" : `a ${bound}`} for ${name}, not ${show(t)}`);
    }
  };

  // The locals a pattern binds, with their types, in the order the matcher binds them.
  const patternBinds = (p: Pattern, t: Type, where: string): { local: string; type: Type }[] => {
    switch (p.kind) {
      case "wildcard":
        return [];
      case "bind":
        return [{ local: p.local, type: t }];
      case "literal":
        if (!fits(p.value, t)) throw new BytecodeError(`${where}: a pattern literal is not a ${show(t)}`);
        return [];
      case "variant":
      case "record": {
        if (t.kind !== "named" || t.name !== p.type) throw new BytecodeError(`${where}: a ${p.type} pattern cannot match ${show(t)}`);
        const fields = fieldsOf(t, p.kind === "variant" ? p.variant : null, where);
        if (fields.length !== p.fields.length) throw new BytecodeError(`${where}: the pattern has ${p.fields.length} fields, not ${fields.length}`);
        return p.fields.flatMap((sub, i) => patternBinds(sub, fields[i] as Type, where));
      }
    }
  };

  for (const [node, first] of ctx.nodeBlock) {
    const body = (ctx.nodes[node] as NodeInfo).body;
    const nouns = ctx.nounTypes.get(body) ?? new Map<NounId, Type>();
    const noun = (id: NounId, where: string) => {
      const t = nouns.get(id);
      if (!t) throw new BytecodeError(`${where}: noun #${id} has no type`);
      return t;
    };
    const seen = new Map<number, Map<Reg, Type>>();
    const visit = (id: number, entry: Map<Reg, Type>): void => {
      const where = `block b${id}`;
      const fail = (m: string): never => {
        throw new BytecodeError(`${where}: ${m}`);
      };
      const before = seen.get(id);
      if (before) {
        // A join: every register both paths know must have one type.
        for (const [r, t] of entry) {
          const other = before.get(r);
          if (other && !same(other, t)) fail(`incompatible register types joining here: r${r} is ${show(other)} on one path and ${show(t)} on another`);
        }
        return;
      }
      seen.set(id, entry);
      const regs = new Map(entry);
      const type = (r: Reg): Type => regs.get(r) ?? fail(`r${r} has no type here`);
      const set = (r: Reg, t: Type) => {
        const old = regs.get(r);
        if (old && !same(old, t)) fail(`r${r} would be both ${show(old)} and ${show(t)}`);
        regs.set(r, t);
      };
      const expect = (r: Reg, t: Type, what: string) => {
        if (!same(type(r), t)) fail(`${what} must be ${show(t)}, not ${show(type(r))}`);
      };
      const b = ctx.blocks[id] as MirBlock;
      for (const o of b.ops) instruction(o);
      function instruction(o: MirOp): void {
        switch (o.op) {
          case "const":
            wellFormed(o.type, where);
            if (!fits(o.value, o.type)) fail(`constant ${JSON.stringify(o.value, (_, v) => (typeof v === "bigint" ? `${v}` : v))} is not a ${show(o.type)}`);
            return set(o.dst, o.type);
          case "load":
          case "recorded":
            return set(o.dst, noun(o.noun, where));
          case "anchorRead": {
            const t = noun(o.noun, where);
            if (o.moment === "end" && !temporal(t)) fail(`'끝의' reads a temporal value, and #${o.noun} is ${show(t)}`);
            return set(o.dst, t);
          }
          case "move":
            return set(o.dst, type(o.src));
          case "now":
            return set(o.dst, type(o.src));
          case "arith": {
            const t: Type = { kind: "prim", name: o.type };
            expect(o.a, t, `the left operand of ${o.arith} ${o.type}`);
            expect(o.b, t, `the right operand of ${o.arith} ${o.type}`);
            return set(o.dst, t);
          }
          case "not":
            expect(o.a, BOOL, "a negation's operand");
            return set(o.dst, BOOL);
          case "eq":
            if (!same(type(o.a), type(o.b))) fail(`cannot compare ${show(type(o.a))} with ${show(type(o.b))}`);
            return set(o.dst, BOOL);
          case "order":
            if (!same(type(o.a), type(o.b)) || !numericOrRune(type(o.a))) fail(`cannot order ${show(type(o.a))} against ${show(type(o.b))}`);
            return set(o.dst, BOOL);
          case "builtin":
            o.types.args.forEach((t) => wellFormed(t, where));
            wellFormed(o.types.result, where);
            matchCall(o.callee, o.args.map(type), o.types, where);
            return set(o.dst, o.types.result);
          case "foreign": {
            // Exactly the declared FFI types: the declaration, not the instruction, decides.
            const decl = ctx.foreign.get(o.callee) ?? fail(`no foreign function '${o.callee}'`);
            const sig = y3Signature(decl);
            if (sig.params.length !== o.args.length) fail(`'${o.callee}' takes ${sig.params.length} arguments, not ${o.args.length}`);
            o.args.forEach((r, i) => expect(r, sig.params[i] as Type, `argument ${i + 1} of '${o.callee}'`));
            return set(o.dst, sig.result);
          }
          case "construct": {
            wellFormed(o.result, where);
            if (o.result.kind !== "named" || o.result.name !== o.type) fail(`a construction of ${o.type} cannot be a ${show(o.result)}`);
            const fields = fieldsOf(o.result, o.variant, where);
            if (fields.length !== o.fields.length) fail(`'${o.variant ?? o.type}' has ${fields.length} fields, not ${o.fields.length}`);
            o.fields.forEach((r, i) => expect(r, fields[i] as Type, `field ${i + 1} of '${o.variant ?? o.type}'`));
            return set(o.dst, o.result);
          }
          case "field":
          case "checkField": {
            const fields = fieldsOf(type(o.record), null, where);
            if (o.index >= fields.length) fail(`field ${o.index} does not exist`);
            if (o.op === "field") set(o.dst, fields[o.index] as Type);
            return;
          }
          case "setField": {
            const fields = fieldsOf(type(o.record), null, where);
            expect(o.value, fields[o.index] ?? fail(`field ${o.index} does not exist`), "the new field");
            return set(o.dst, type(o.record));
          }
          case "array":
            wellFormed(o.type, where);
            if (o.type.kind !== "array" || o.type.length !== o.elements.length) fail(`an array of ${o.elements.length} cannot be a ${show(o.type)}`);
            for (const r of o.elements) expect(r, (o.type as { element: Type }).element, "an element");
            return set(o.dst, o.type);
          case "index": {
            const e = elementOf(type(o.base), true) ?? fail(`${show(type(o.base))} has no elements`);
            expect(o.index, I64, "an index");
            return set(o.dst, e);
          }
          case "checkWritable": {
            const t = type(o.base);
            if (!(t.kind === "array" || (t.kind === "named" && t.name === "List"))) fail(`${show(t)} has no writable elements`);
            return;
          }
          case "writePosition":
            if (!elementOf(type(o.base), true)) fail(`${show(type(o.base))} has no elements`);
            expect(o.index, I64, "an index");
            return set(o.dst, I64);
          case "setIndex": {
            const t = type(o.base);
            const e = t.kind === "array" ? t.element : t.kind === "named" && t.name === "List" ? (t.args[0] as Type) : fail(`${show(t)} has no writable elements`);
            expect(o.at, I64, "a position");
            expect(o.value, e, "the new element");
            return set(o.dst, t);
          }
          case "sliceBound":
            if (!elementOf(type(o.base), false)) fail(`${show(type(o.base))} cannot be sliced`);
            expect(o.bound, I64, "a slice bound");
            return set(o.dst, I64);
          case "slice": {
            const e = elementOf(type(o.base), false) ?? fail(`${show(type(o.base))} cannot be sliced`);
            expect(o.from, I64, "a slice start");
            expect(o.to, I64, "a slice end");
            return set(o.dst, { kind: "slice", element: e });
          }
          case "length":
            if (!elementOf(type(o.base), false)) fail(`${show(type(o.base))} has no length`);
            return set(o.dst, I64);
          case "test": {
            const binds = patternBinds(o.pattern, type(o.scrutinee), where);
            if (binds.length !== o.binds.length || binds.some((x, i) => x.local !== o.binds[i]?.local)) fail("a pattern's bindings do not match the test's registers");
            set(o.dst, BOOL);
            // Bindings are written only on a match: recorded for the `if` that follows.
            pendingBinds.set(o.dst, o.binds.map((x, i) => [x.reg, (binds[i] as { type: Type }).type] as [Reg, Type]));
            return;
          }
          case "assign":
            return expect(o.src, noun(o.noun, where), `the value assigned to #${o.noun}`);
          case "declare":
          case "receive": {
            // These make a temporal value. (A send only closes a channel a receive opened,
            // so it needs no check of its own: with nothing listening it is a PARADOX.)
            const t = noun(o.noun, where);
            if (!temporal(t)) fail(`a temporal value is bigint or Text, and #${o.noun} is ${show(t)}`);
            return;
          }
          case "send":
            noun(o.noun, where);
            return;
          case "pastLeft":
            return set(o.dst, noun(o.noun, where));
          case "past":
            if (!same(type(o.left), type(o.right))) fail(`a past statement equates ${show(type(o.left))} with ${show(type(o.right))}`);
            return;
          case "promise":
            return expect(o.src, noun(o.noun, where), `the value promised for #${o.noun}`);
          case "fixedPoint":
          case "anchor":
          case "leave":
          case "end":
            return;
        }
      }
      const t = b.terminator;
      switch (t.kind) {
        case "call": {
          const p = ctx.procedures.get(t.plane) ?? fail(`no callable plane '${t.plane}'`);
          if (p.params.length !== t.args.length) fail(`'${t.plane}' takes ${p.params.length} arguments, not ${t.args.length}`);
          t.args.forEach((r, i) => expect(r, p.params[i] as Type, `argument ${i + 1} of '${t.plane}'`));
          const results = p.results.length === 0 && t.results.length === 1 ? [UNIT] : p.results;
          if (t.results.length > 0 && t.results.length !== results.length) fail(`'${t.plane}' returns ${p.results.length} values, not ${t.results.length}`);
          t.results.forEach((n, i) => {
            const nt = noun(n, where);
            if (!same(nt, results[i] as Type)) fail(`result ${i + 1} of '${t.plane}' is ${show(results[i] as Type)}, but #${n} is ${show(nt)}`);
          });
          return;
        }
        case "return": {
          const p = ctx.procedures.get(body) ?? fail("a return outside a callable plane");
          if (t.values.length !== p.results.length) fail(`this plane returns ${p.results.length} values, not ${t.values.length}`);
          t.values.forEach((r, i) => expect(r, p.results[i] as Type, `returned value ${i + 1}`));
          return;
        }
        case "test": {
          const c = t.test;
          if (c.kind === "bool") expect(c.a, BOOL, "a condition");
          else if (!same(type(c.a), type(c.b)) || (c.kind === "order" && !numericOrRune(type(c.a)))) fail(`a condition cannot ${c.kind === "eq" ? "compare" : "order"} ${show(type(c.a))} with ${show(type(c.b))}`);
          visit(t.then, regs);
          visit(t.otherwise, regs);
          return;
        }
        case "if": {
          expect(t.cond, BOOL, "a pattern test");
          const bound = new Map(regs);
          for (const [r, ty] of pendingBinds.get(t.cond) ?? []) bound.set(r, ty);
          visit(t.then, bound);
          visit(t.otherwise, regs);
          return;
        }
        case "goto":
          visit(t.block, regs);
          return;
        default:
          return;
      }
    };
    const pendingBinds = new Map<Reg, [Reg, Type][]>();
    visit(first, new Map());
  }
}
