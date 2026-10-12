import type { CallableId, NounId, Pattern, PlaneId } from "../ir/hir";
import { callable, CALLABLES } from "../ir/callables";
import type { CompiledProgram, Procedure } from "../ir/program";
import type { ConcreteValue } from "../semantics/values";
import type { Pose } from "../space/manifest";
import type { Type } from "../types/types";
import type { Executable, NodeInfo } from "../runtime/vm";
import type { BodyId, Edge, Target } from "./cfg";
import type { Mir, MirBlock, MirOp, MirTerminator } from "./mir";

// Y3 bytecode: MIR in a portable, versioned, verified form (docs/v2-bytecode.md).
// One MIR operation is one instruction: [opcode, operands…]. Constants, patterns, call
// types and edges live in pools and are referenced by index. The artifact is text: a
// header line "Y3BC <version>" and one JSON document, written deterministically, so the
// same program always builds to the same bytes.

export const BYTECODE_MAGIC = "Y3BC";
export const BYTECODE_VERSION = 1;

export class BytecodeError extends Error {}

// ---- Operand kinds and the instruction table. The table is the encoding.

type Kind = "reg" | "regs" | "noun" | "int" | "str" | "const" | "pattern" | "types" | "pose" | "moment" | "binds" | "strOrNull";

const OPS: readonly (readonly [MirOp["op"], readonly (readonly [string, Kind])[]])[] = [
  ["const", [["dst", "reg"], ["value", "const"]]],
  ["load", [["dst", "reg"], ["noun", "noun"]]],
  ["recorded", [["dst", "reg"], ["noun", "noun"]]],
  ["anchorRead", [["dst", "reg"], ["noun", "noun"], ["moment", "moment"]]],
  ["move", [["dst", "reg"], ["src", "reg"]]],
  ["arith", [["dst", "reg"], ["arith", "str"], ["type", "str"], ["a", "reg"], ["b", "reg"]]],
  ["now", [["dst", "reg"], ["src", "reg"], ["purpose", "str"]]],
  ["not", [["dst", "reg"], ["a", "reg"]]],
  ["eq", [["dst", "reg"], ["a", "reg"], ["b", "reg"]]],
  ["order", [["dst", "reg"], ["order", "str"], ["a", "reg"], ["b", "reg"]]],
  ["builtin", [["dst", "reg"], ["callee", "str"], ["args", "regs"], ["types", "types"]]],
  ["construct", [["dst", "reg"], ["type", "str"], ["variant", "strOrNull"], ["fields", "regs"]]],
  ["field", [["dst", "reg"], ["record", "reg"], ["index", "int"], ["name", "str"]]],
  ["checkField", [["record", "reg"], ["index", "int"], ["name", "str"]]],
  ["setField", [["dst", "reg"], ["record", "reg"], ["index", "int"], ["value", "reg"]]],
  ["array", [["dst", "reg"], ["elements", "regs"]]],
  ["index", [["dst", "reg"], ["base", "reg"], ["index", "reg"]]],
  ["checkWritable", [["base", "reg"]]],
  ["writePosition", [["dst", "reg"], ["base", "reg"], ["index", "reg"]]],
  ["setIndex", [["dst", "reg"], ["base", "reg"], ["at", "reg"], ["value", "reg"]]],
  ["sliceBound", [["dst", "reg"], ["base", "reg"], ["bound", "reg"]]],
  ["slice", [["dst", "reg"], ["base", "reg"], ["from", "reg"], ["to", "reg"]]],
  ["length", [["dst", "reg"], ["base", "reg"]]],
  ["test", [["dst", "reg"], ["scrutinee", "reg"], ["pattern", "pattern"], ["binds", "binds"]]],
  ["assign", [["noun", "noun"], ["src", "reg"]]],
  ["declare", [["noun", "noun"]]],
  ["receive", [["noun", "noun"]]],
  ["send", [["noun", "noun"]]],
  ["pastLeft", [["dst", "reg"], ["noun", "noun"], ["moment", "moment"]]],
  ["past", [["left", "reg"], ["right", "reg"], ["moment", "moment"]]],
  ["promise", [["noun", "noun"], ["src", "reg"]]],
  ["fixedPoint", []],
  ["anchor", [["pose", "pose"]]],
  ["leave", []],
  ["end", []],
];
const OPCODE = new Map(OPS.map(([name], i) => [name, i]));
const ARITH_OPS = new Set(["add", "sub", "mul", "div", "rem"]);
const ORDER_OPS = new Set(["lt", "le", "gt", "ge"]);
const NUMERIC = new Set(["i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "bigint", "f32", "f64"]);

// ---- Values in JSON. Integers are strings (they are unbounded); floats keep NaN, ±Inf, −0.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function encodeValue(v: ConcreteValue): Json {
  switch (v.kind) {
    case "int":
      return { int: v.value.toString() };
    case "float":
      return { float: Number.isNaN(v.value) ? "NaN" : Object.is(v.value, -0) ? "-0" : Number.isFinite(v.value) ? v.value : v.value > 0 ? "+Inf" : "-Inf", width: v.width };
    case "rune":
      return { rune: v.value };
    case "text":
      return { text: v.value };
    case "bool":
      return { bool: v.value };
    case "unit":
      return { unit: true };
    case "data":
      return { data: v.type, variant: v.variant, fields: v.fields.map(encodeValue) };
    default:
      throw new BytecodeError(`a ${v.kind} cannot be a bytecode constant`);
  }
}

export function decodeValue(j: Json): ConcreteValue {
  const o = j as Record<string, Json>;
  if (typeof o !== "object" || o === null) throw new BytecodeError("a constant must be an object");
  if (typeof o.int === "string" && /^-?\d+$/.test(o.int)) return { kind: "int", value: BigInt(o.int) };
  if ("float" in o) {
    const f = o.float;
    const value = f === "NaN" ? NaN : f === "-0" ? -0 : f === "+Inf" ? Infinity : f === "-Inf" ? -Infinity : f;
    if (typeof value !== "number" || (o.width !== 32 && o.width !== 64)) throw new BytecodeError("a malformed float constant");
    return { kind: "float", value, width: o.width };
  }
  if (typeof o.rune === "number" && Number.isInteger(o.rune) && o.rune >= 0 && o.rune <= 0x10ffff) return { kind: "rune", value: o.rune };
  if (typeof o.text === "string") return { kind: "text", value: o.text };
  if (typeof o.bool === "boolean") return { kind: "bool", value: o.bool };
  if (o.unit === true) return { kind: "unit" };
  if (typeof o.data === "string" && Array.isArray(o.fields)) return { kind: "data", type: o.data, variant: typeof o.variant === "string" ? o.variant : null, fields: o.fields.map(decodeValue) };
  throw new BytecodeError(`a malformed constant: ${JSON.stringify(j)}`);
}

const encodePattern = (p: Pattern): Json =>
  p.kind === "literal" ? { kind: "literal", value: encodeValue(p.value) } : p.kind === "variant" || p.kind === "record" ? { ...p, fields: p.fields.map(encodePattern) } : { ...p };
const decodePattern = (j: Json): Pattern => {
  const o = j as Record<string, Json>;
  switch (o?.kind) {
    case "wildcard":
      return { kind: "wildcard" };
    case "bind":
      if (typeof o.local !== "string") break;
      return { kind: "bind", local: o.local };
    case "literal":
      return { kind: "literal", value: decodeValue(o.value as Json) };
    case "variant":
      if (typeof o.type !== "string" || typeof o.variant !== "string" || !Array.isArray(o.fields)) break;
      return { kind: "variant", type: o.type, variant: o.variant, fields: o.fields.map(decodePattern) };
    case "record":
      if (typeof o.type !== "string" || !Array.isArray(o.fields)) break;
      return { kind: "record", type: o.type, fields: o.fields.map(decodePattern) };
  }
  throw new BytecodeError(`a malformed pattern: ${JSON.stringify(j)}`);
};

// ---- The artifact.

export type BytecodeModule = {
  readonly magic: string;
  readonly version: number;
  readonly module: string; // the program's manifest name, or "main"
  readonly maxSteps: number;
  readonly start: Pose;
  readonly registers: number;
  readonly bodies: readonly { readonly id: BodyId; readonly nouns: readonly [number, string][] }[];
  readonly procedures: readonly { readonly id: PlaneId; readonly name: string; readonly module: string; readonly params: readonly { readonly noun: NounId; readonly name: string; readonly type: Type }[]; readonly results: readonly Type[] }[];
  readonly constants: readonly Json[];
  readonly patterns: readonly Json[];
  readonly types: readonly Json[];
  readonly edges: readonly Json[];
  readonly entries: readonly [BodyId, Json][];
  readonly nodes: readonly Json[]; // the debug map: body, pose, sentence, plane, span per CFG node
  readonly blocks: readonly { readonly node: number; readonly start: boolean; readonly code: readonly Json[][]; readonly end: Json }[];
};

export function encodeBytecode(mir: Mir, nodes: readonly NodeInfo[], program: CompiledProgram, options: { module: string; maxSteps: number; start: Pose }): BytecodeModule {
  const pool = <T>(encode: (x: T) => Json) => {
    const items: Json[] = [];
    const index = new Map<string, number>();
    return {
      items,
      add: (x: T): number => {
        const j = encode(x);
        const key = JSON.stringify(j);
        let i = index.get(key);
        if (i === undefined) {
          i = items.length;
          items.push(j);
          index.set(key, i);
        }
        return i;
      },
    };
  };
  const constants = pool(encodeValue);
  const patterns = pool(encodePattern);
  const types = pool((t: { args: readonly Type[]; result: Type }) => t as unknown as Json);
  const edges = pool((e: Edge) => e as unknown as Json);

  const operand = (kind: Kind, v: unknown): Json => {
    switch (kind) {
      case "const":
        return constants.add(v as ConcreteValue);
      case "pattern":
        return patterns.add(v as Pattern);
      case "types":
        return types.add(v as { args: readonly Type[]; result: Type });
      case "binds":
        return (v as { local: string; reg: number }[]).map((b) => [b.local, b.reg]);
      default:
        return v as Json;
    }
  };
  const encodeOp = (o: MirOp): Json[] => {
    const code = OPCODE.get(o.op) as number;
    const [, fields] = OPS[code] as (typeof OPS)[number];
    return [code, ...fields.map(([name, kind]) => operand(kind, (o as Record<string, unknown>)[name]))];
  };
  const encodeTerm = (t: MirTerminator): Json => {
    switch (t.kind) {
      case "edge":
        return ["edge", edges.add(t.edge)];
      case "back":
        return ["back", t.edge ? edges.add(t.edge) : null];
      case "call":
        return ["call", t.plane, t.args as number[], t.results as number[], edges.add(t.edge)];
      case "return":
        return ["return", t.values as number[]];
      case "test": {
        const c = t.test;
        const test: Json = c.kind === "eq" ? ["eq", c.a, c.b, c.negated] : c.kind === "order" ? ["order", c.order, c.a, c.b] : ["bool", c.a];
        return ["test", test, t.then, t.otherwise];
      }
      case "if":
        return ["if", t.cond, t.then, t.otherwise];
      case "goto":
        return ["goto", t.block];
      case "unreachable":
        return ["unreachable", t.reason];
    }
  };

  const bodies: BodyId[] = ["main", ...program.procedures.keys()];
  const bodyOf = (id: BodyId) => (id === "main" ? program : (program.procedures.get(id) as Procedure));
  const blocks = mir.blocks.map((b) => ({ node: b.node, start: b.start, code: b.ops.map(encodeOp), end: encodeTerm(b.terminator) }));
  return {
    magic: BYTECODE_MAGIC,
    version: BYTECODE_VERSION,
    module: options.module,
    maxSteps: options.maxSteps,
    start: options.start,
    registers: mir.registers,
    bodies: bodies.map((id) => ({ id, nouns: bodyOf(id).nouns.map((n) => [n.id, n.name] as [number, string]) })),
    procedures: [...program.procedures.values()].map((p) => ({ id: p.id, name: p.name, module: p.module, params: p.params.map((x) => ({ noun: x.noun, name: x.name, type: x.type })), results: p.results })),
    constants: constants.items,
    patterns: patterns.items,
    types: types.items,
    edges: edges.items,
    entries: [...mir.cfg.entries].map(([id, t]) => [id, t as unknown as Json]),
    nodes: nodes.map((n) => n as unknown as Json),
    blocks,
  };
}

// The artifact's bytes: a header line, then the module as JSON.
export function writeArtifact(module: BytecodeModule): string {
  return `${BYTECODE_MAGIC} ${BYTECODE_VERSION}\n${JSON.stringify(module)}\n`;
}

export function readArtifact(text: string): BytecodeModule {
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  const match = header.match(/^Y3BC (\d+)$/);
  if (!match) throw new BytecodeError("not a Y3 bytecode artifact (no 'Y3BC <version>' header)");
  const version = Number(match[1]);
  if (version !== BYTECODE_VERSION) throw new BytecodeError(`bytecode version ${version} is not supported: this toolchain reads version ${BYTECODE_VERSION}; rebuild from source`);
  let module: BytecodeModule;
  try {
    module = JSON.parse(text.slice(newline + 1)) as BytecodeModule;
  } catch {
    throw new BytecodeError("the artifact's body is not valid JSON");
  }
  if (module.magic !== BYTECODE_MAGIC || module.version !== BYTECODE_VERSION) throw new BytecodeError("the artifact's header and body disagree");
  return module;
}

// ---- Decoding and verification. Nothing here trusts that a compiler wrote the module.

export type Loaded = { readonly executable: Executable; readonly program: CompiledProgram; readonly maxSteps: number; readonly module: string };

export function loadBytecode(m: BytecodeModule): Loaded {
  const fail = (where: string, message: string): never => {
    throw new BytecodeError(`${where}: ${message}`);
  };
  const isInt = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isInteger(x) && x >= lo && x < hi;
  if (!isInt(m.registers, 0, 1 << 20)) fail("module", "a bad register count");
  if (!Array.isArray(m.blocks) || !Array.isArray(m.nodes) || !Array.isArray(m.constants)) fail("module", "missing tables");

  const constants = m.constants.map(decodeValue);
  const patterns = m.patterns.map(decodePattern);
  const types = m.types as unknown as { args: Type[]; result: Type }[];
  const nodes = m.nodes as unknown as NodeInfo[];
  const bodies = new Map(m.bodies.map((b) => [b.id, new Set(b.nouns.map(([id]) => id))]));
  const procedures = new Map(m.procedures.map((p) => [p.id, p]));
  if (!bodies.has("main")) fail("module", "no main body");

  // Nodes and their first blocks.
  const nodeBlock = new Map<number, number>();
  m.blocks.forEach((b, i) => {
    if (!isInt(b.node, 0, nodes.length)) fail(`block b${i}`, `node #${b.node} does not exist`);
    if (b.start) {
      if (nodeBlock.has(b.node)) fail(`block b${i}`, `node #${b.node} has two starting blocks`);
      nodeBlock.set(b.node, i);
    }
  });
  nodes.forEach((n, i) => {
    if (!bodies.has(n.body)) fail(`node #${i}`, `unknown body '${n.body}'`);
    if (!nodeBlock.has(i)) fail(`node #${i}`, "has no starting block");
  });

  const target = (t: Target, where: string): Target => {
    switch (t?.kind) {
      case "node":
        if (!nodeBlock.has(t.node)) fail(where, `jumps to node #${t.node}, which does not exist`);
        return t;
      case "void":
      case "halt":
      case "return":
        return t;
      case "call":
        if (!procedures.has(t.plane)) fail(where, `calls '${t.plane}', which does not exist`);
        target(t.entry, where);
        target(t.continuation, where);
        return t;
      default:
        return fail(where, "a malformed jump target");
    }
  };
  const edge = (i: unknown, where: string): Edge => {
    if (!isInt(i, 0, m.edges.length)) fail(where, `edge ${String(i)} is not in the edge table`);
    const e = m.edges[i as number] as unknown as Edge;
    target(e.target, where);
    return e;
  };

  const blocks: MirBlock[] = m.blocks.map((b, i) => {
    const where = `block b${i}`;
    const node = nodes[b.node] as NodeInfo;
    const nouns = bodies.get(node.body) as Set<number>;
    const reg = (x: unknown) => {
      if (!isInt(x, 0, m.registers)) fail(where, `register ${String(x)} does not exist`);
      return x as number;
    };
    const blockRef = (x: unknown) => {
      if (!isInt(x, 0, m.blocks.length) || m.blocks[x as number]?.node !== b.node) fail(where, `block ${String(x)} is not a block of the same step`);
      return x as number;
    };
    const decodeOperand = (kind: Kind, v: Json): unknown => {
      switch (kind) {
        case "reg":
          return reg(v);
        case "regs":
          if (!Array.isArray(v)) fail(where, "expected a register list");
          return (v as Json[]).map(reg);
        case "noun":
          if (typeof v !== "number" || !nouns.has(v)) fail(where, `noun #${String(v)} is not a noun of body '${node.body}'`);
          return v;
        case "int":
          if (!isInt(v, 0, 1 << 30)) fail(where, "a bad integer operand");
          return v;
        case "str":
          if (typeof v !== "string") fail(where, "expected a string operand");
          return v;
        case "strOrNull":
          if (v !== null && typeof v !== "string") fail(where, "expected a string or null");
          return v;
        case "const":
          if (!isInt(v, 0, constants.length)) fail(where, `constant ${String(v)} is not in the pool`);
          return constants[v as number];
        case "pattern":
          if (!isInt(v, 0, patterns.length)) fail(where, `pattern ${String(v)} is not in the pool`);
          return patterns[v as number];
        case "types":
          if (!isInt(v, 0, types.length)) fail(where, `call types ${String(v)} are not in the pool`);
          return types[v as number];
        case "pose":
          return v;
        case "moment":
          if (v !== "now" && v !== "start" && v !== "end") fail(where, `'${String(v)}' is not a moment`);
          return v;
        case "binds":
          if (!Array.isArray(v)) fail(where, "expected bindings");
          return (v as Json[]).map((x) => {
            const [local, r] = x as [string, number];
            if (typeof local !== "string") fail(where, "a binding needs a name");
            return { local, reg: reg(r) };
          });
      }
    };
    const ops: MirOp[] = b.code.map((ins) => {
      const [code, ...rest] = ins;
      if (!isInt(code, 0, OPS.length)) fail(where, `unknown opcode ${String(code)}`);
      const [name, fields] = OPS[code as number] as (typeof OPS)[number];
      if (rest.length !== fields.length) fail(where, `'${name}' takes ${fields.length} operands, not ${rest.length}`);
      const o: Record<string, unknown> = { op: name };
      fields.forEach(([field, kind], k) => (o[field] = decodeOperand(kind, rest[k] as Json)));
      // Shapes the table alone cannot check.
      if (name === "arith" && (!ARITH_OPS.has(o.arith as string) || !NUMERIC.has(o.type as string))) fail(where, "an arith instruction with a bad operation or type");
      if (name === "order" && !ORDER_OPS.has(o.order as string)) fail(where, "a bad ordering");
      if (name === "builtin") {
        const id = o.callee as CallableId;
        if (!CALLABLES.some((c) => c.id === id)) fail(where, `no built-in '${id}'`);
        const sig = callable(id).signature;
        const n = (o.args as number[]).length;
        if (sig.rest ? n < sig.params.length : n !== sig.params.length) fail(where, `'${id}' takes ${sig.params.length}${sig.rest ? " or more" : ""} arguments, not ${n}`);
      }
      if ((name === "pastLeft" || name === "past") && o.moment === "end") fail(where, "a past statement speaks of now or 처음, never 끝");
      return o as MirOp;
    });
    const t = b.end as Json[];
    if (!Array.isArray(t)) fail(where, "no terminator");
    let terminator: MirTerminator;
    switch (t[0]) {
      case "edge":
        terminator = { kind: "edge", edge: edge(t[1], where) };
        break;
      case "back":
        terminator = { kind: "back", edge: t[1] === null ? null : edge(t[1], where) };
        break;
      case "call": {
        const plane = t[1] as string;
        const procedure = procedures.get(plane);
        if (!procedure) fail(where, `calls '${String(plane)}', which does not exist`);
        const args = (t[2] as Json[]).map(reg);
        if (args.length !== procedure?.params.length) fail(where, `'${plane}' takes ${procedure?.params.length} arguments, not ${args.length}`);
        const results = t[3] as number[];
        if (!Array.isArray(results) || results.some((r) => !nouns.has(r))) fail(where, "a call's results must be nouns of the caller");
        const e = edge(t[4], where);
        if (e.target.kind !== "call" || e.target.plane !== plane) fail(where, "a call's edge must lead into the callee");
        terminator = { kind: "call", plane, args, results, edge: e };
        break;
      }
      case "return":
        if (node.body === "main") fail(where, "a return with no call frame: the main body never returns");
        terminator = { kind: "return", values: (t[1] as Json[]).map(reg) };
        break;
      case "test": {
        const c = t[1] as Json[];
        const test =
          c[0] === "eq"
            ? { kind: "eq" as const, a: reg(c[1]), b: reg(c[2]), negated: c[3] === true }
            : c[0] === "order" && ORDER_OPS.has(c[1] as string)
              ? { kind: "order" as const, order: c[1] as "lt", a: reg(c[2]), b: reg(c[3]) }
              : c[0] === "bool"
                ? { kind: "bool" as const, a: reg(c[1]) }
                : fail(where, "a malformed test");
        terminator = { kind: "test", test, then: blockRef(t[2]), otherwise: blockRef(t[3]) };
        break;
      }
      case "if":
        terminator = { kind: "if", cond: reg(t[1]), then: blockRef(t[2]), otherwise: blockRef(t[3]) };
        break;
      case "goto":
        terminator = { kind: "goto", block: blockRef(t[1]) };
        break;
      case "unreachable":
        terminator = { kind: "unreachable", reason: String(t[1]) };
        break;
      default:
        return fail(where, `unknown terminator '${String(t[0])}'`);
    }
    return { id: i, node: b.node, start: b.start, ops, terminator };
  });

  verifyRegisters(blocks, nodeBlock);
  const entries = new Map(m.entries.map(([id, t]) => [id, target(t as unknown as Target, `entry ${id}`)]));
  if (!entries.has("main")) fail("module", "no entry for main");

  // What the runtime core needs to know about the program: nouns and callable planes.
  const empty = { manifest: null, layers: [] };
  const nounsOf = (id: BodyId) => (m.bodies.find((b) => b.id === id)?.nouns ?? []).map(([nid, name]) => ({ id: nid, name, type: { kind: "var", id: 0 } as Type }));
  const program: CompiledProgram = {
    space: empty,
    cells: new Map(),
    nouns: nounsOf("main"),
    procedures: new Map(
      m.procedures.map((p) => [p.id, { id: p.id, name: p.name, module: p.module, params: p.params, results: p.results, space: empty, cells: new Map(), nouns: nounsOf(p.id) } as Procedure]),
    ),
  };
  return {
    executable: { blocks, nodeBlock, nodes, entries, registers: m.registers, start: m.start.position },
    program,
    maxSteps: m.maxSteps,
    module: m.module,
  };
}

// Every register a step reads must have been written earlier on every path through that
// step's blocks. A step's blocks only branch forward, so a pass in path order settles it.
function verifyRegisters(blocks: readonly MirBlock[], nodeBlock: ReadonlyMap<number, number>): void {
  const reads = (o: MirOp): number[] => {
    const r = o as Record<string, unknown>;
    return ["src", "a", "b", "record", "value", "base", "index", "at", "bound", "from", "to", "scrutinee", "left", "right"]
      .filter((k) => typeof r[k] === "number" && k !== "index" || (k === "index" && o.op !== "field" && o.op !== "checkField" && o.op !== "setField" && typeof r[k] === "number"))
      .map((k) => r[k] as number)
      .concat(...["args", "fields", "elements"].map((k) => (Array.isArray(r[k]) ? (r[k] as number[]) : [])));
  };
  const writes = (o: MirOp): number[] => {
    const r = o as Record<string, unknown>;
    return [...(typeof r.dst === "number" ? [r.dst] : []), ...(o.op === "test" ? o.binds.map((b) => b.reg) : [])];
  };
  // Pattern bindings are written only when the pattern matches: they count as written
  // in the arm (the `then` of the `if` that follows the test).
  const termReads = (t: MirTerminator): number[] =>
    t.kind === "call" ? [...t.args] : t.kind === "return" ? [...t.values] : t.kind === "if" ? [t.cond] : t.kind === "test" ? (t.test.kind === "bool" ? [t.test.a] : [t.test.a, t.test.b]) : [];
  for (const first of nodeBlock.values()) {
    const seen = new Map<number, Set<number>>(); // block → registers defined on entry (intersection over paths)
    const visit = (id: number, defined: Set<number>, depth: number): void => {
      if (depth > blocks.length) throw new BytecodeError(`block b${id}: a step's blocks loop`);
      const before = seen.get(id);
      const entry = before ? new Set([...before].filter((r) => defined.has(r))) : defined;
      if (before && before.size === entry.size) return;
      seen.set(id, entry);
      const b = blocks[id] as MirBlock;
      const now = new Set(entry);
      for (const o of b.ops) {
        for (const r of reads(o)) if (!now.has(r)) throw new BytecodeError(`block b${id}: '${o.op}' reads r${r} before it is written`);
        for (const r of writes(o)) if (o.op !== "test" || r === (o as { dst: number }).dst) now.add(r);
      }
      const t = b.terminator;
      for (const r of termReads(t)) if (!now.has(r)) throw new BytecodeError(`block b${id}: the terminator reads r${r} before it is written`);
      if (t.kind === "goto") visit(t.block, now, depth + 1);
      if (t.kind === "test") {
        visit(t.then, now, depth + 1);
        visit(t.otherwise, now, depth + 1);
      }
      if (t.kind === "if") {
        // The test just before writes its bindings on a match.
        const test = [...b.ops].reverse().find((o): o is Extract<MirOp, { op: "test" }> => o.op === "test" && o.dst === t.cond);
        visit(t.then, new Set([...now, ...(test?.binds.map((x) => x.reg) ?? [])]), depth + 1);
        visit(t.otherwise, now, depth + 1);
      }
    };
    visit(first, new Set(), 0);
  }
}

export function moduleOf(text: string): Loaded {
  return loadBytecode(readArtifact(text));
}
