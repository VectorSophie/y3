import { RuntimeFault } from "../semantics/fault";
import { bool, float, int, UNIT, elementsOf, type ConcreteValue } from "../semantics/values";
import { arrayOf, BOOL, named, prim, sliceOf, TEXT, UNIT_TYPE, type Type } from "../types/types";
import { sha256 } from "../tools/sha256";
import { formatFuncType, readInterface, sameType, WasmFormatError, type FuncType, type ValType } from "./wasm-binary";

// Foreign calls (docs/v2-ffi.md). A foreign library is a WebAssembly module following the
// wasm32 C ABI, instantiated with no imports: it can reach its own memory and nothing else.
// An 외부 declaration states one exported function's signature in FFI types; this file
// maps those to Y3 types and to wasm types, and runs calls across the boundary.

export type FfiScalar = "i8" | "i16" | "i32" | "u8" | "u16" | "u32" | "i64" | "u64" | "f32" | "f64" | "Bool";
export const FFI_SCALARS: readonly FfiScalar[] = ["i8", "i16", "i32", "u8", "u16", "u32", "i64", "u64", "f32", "f64", "Bool"];

export type FfiParam =
  | { readonly kind: "scalar"; readonly type: FfiScalar }
  | { readonly kind: "text" } // UTF-8, borrowed for the call: (pointer, byte length)
  | { readonly kind: "bytes"; readonly length: number | null } // [u8; N] or []u8, borrowed: (pointer, length)
  | { readonly kind: "handle" } // a Foreign pointer the library returned earlier
  | { readonly kind: "out"; readonly length: number }; // a zeroed N-byte buffer: (pointer, length); its bytes are the result

export type FfiResult = { readonly kind: "unit" } | { readonly kind: "scalar"; readonly type: FfiScalar } | { readonly kind: "handle" } | { readonly kind: "out"; readonly length: number };

export type ForeignId = string; // "<library alias>.<name>"

export type ForeignDecl = {
  readonly id: ForeignId;
  readonly library: string; // alias in [foreign]
  readonly name: string; // as Y3 calls it
  readonly symbol: string; // the export
  readonly params: readonly FfiParam[]; // in C order, out-buffers included
  readonly result: FfiResult;
  readonly pure: boolean; // 순수: no effect barrier, no event
  readonly frees: boolean; // 해제: frees its handle argument
};

// How a foreign function is named in messages: '씨 더하기'.
export const foreignLabel = (id: ForeignId) => `'${id.replace(".", " ")}'`;

export type ForeignLibrary = { readonly alias: string; readonly path: string; readonly sha256: string };

export const FOREIGN_TYPE: Type = named("Foreign");
const U8 = prim("u8");

export const scalarType = (s: FfiScalar): Type => (s === "Bool" ? BOOL : prim(s));

// The Y3 parameter types a call supplies (out-buffers are not supplied) and its result.
export function y3Signature(d: ForeignDecl): { params: Type[]; result: Type } {
  const params = d.params.flatMap((p): Type[] =>
    p.kind === "scalar" ? [scalarType(p.type)] : p.kind === "text" ? [TEXT] : p.kind === "bytes" ? [p.length === null ? sliceOf(U8) : arrayOf(U8, p.length)] : p.kind === "handle" ? [FOREIGN_TYPE] : [],
  );
  const r = d.result;
  const result = r.kind === "unit" ? UNIT_TYPE : r.kind === "scalar" ? scalarType(r.type) : r.kind === "handle" ? FOREIGN_TYPE : arrayOf(U8, r.length);
  return { params, result };
}

const valOf = (s: FfiScalar): ValType => (s === "i64" || s === "u64" ? "i64" : s === "f32" ? "f32" : s === "f64" ? "f64" : "i32");

// The export's wasm32 C ABI type: what the library must actually export.
export function wasmSignature(d: ForeignDecl): FuncType {
  const params = d.params.flatMap((p): ValType[] => (p.kind === "scalar" ? [valOf(p.type)] : p.kind === "handle" ? ["i32"] : ["i32", "i32"]));
  const results: ValType[] = d.result.kind === "scalar" ? [valOf(d.result.type)] : d.result.kind === "handle" ? ["i32"] : [];
  return { params, results };
}

const borrows = (d: ForeignDecl) => d.params.some((p) => p.kind === "text" || p.kind === "bytes" || p.kind === "out");

export class FfiError extends Error {}

// A declaration's own rules, independent of any library. The compiler checks them, and so
// does the bytecode loader: an artifact is not trusted to have been compiled.
export function checkDecl(d: ForeignDecl): void {
  const fail = (m: string): never => {
    throw new FfiError(`외부 ${d.library} ${d.name}: ${m}`);
  };
  const outs = d.params.filter((p) => p.kind === "out");
  if (outs.length > 1) fail("at most one parameter is an out-buffer");
  const out = outs[0];
  if (out && !(d.result.kind === "out" && d.result.length === (out as { length: number }).length)) fail(`an out-buffer [u8; ${(out as { length: number }).length}] is the call's result: declare '→ [u8; ${(out as { length: number }).length}]'`);
  if (!out && d.result.kind === "out") fail("a [u8; N] result needs an out-buffer parameter ('이름: 출력 [u8; N]')");
  for (const p of d.params) {
    if ((p.kind === "bytes" || p.kind === "out") && p.length !== null && !(Number.isInteger(p.length) && p.length >= 0 && p.length <= 1 << 20)) fail("a buffer is at most 1 MiB");
    if (p.kind === "scalar" && !FFI_SCALARS.includes(p.type)) fail(`'${String(p.type)}' does not cross the FFI boundary`);
  }
  if (d.result.kind === "scalar" && !FFI_SCALARS.includes(d.result.type)) fail(`'${String(d.result.type)}' does not cross the FFI boundary`);
  if (d.pure && (d.frees || d.result.kind === "handle" || d.params.some((p) => p.kind === "handle"))) fail("a 순수 (pure) function cannot take, return or free a Foreign pointer: pointers are state");
  // 해제 consumes exactly one resource, so the declaration must say which: until there is
  // syntax to name it, a free function takes exactly one Foreign pointer.
  const handles = d.params.filter((p) => p.kind === "handle").length;
  if (d.frees && handles === 0) fail("a 해제 (free) function takes the Foreign pointer it frees");
  if (d.frees && handles > 1) fail(`a 해제 (free) function takes exactly one Foreign pointer, not ${handles}: which one it frees would be ambiguous`);
  if (d.frees && d.result.kind === "handle") fail("a 해제 (free) function cannot return a pointer");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.symbol)) fail(`'${d.symbol}' is not a C symbol`);
}

const ALLOC: FuncType = { params: ["i32"], results: ["i32"] };
const FREE: FuncType = { params: ["i32", "i32"], results: [] };

// Checks a library's bytes against the declarations that use it: no imports, every symbol
// exported with exactly the declared wasm type, and the allocator when buffers cross.
export function checkLibrary(bytes: Uint8Array, alias: string, decls: readonly ForeignDecl[]): void {
  let iface;
  try {
    iface = readInterface(bytes);
  } catch (e) {
    if (e instanceof WasmFormatError) throw new FfiError(`foreign library '${alias}' is ${e.message}`);
    throw e;
  }
  if (iface.imports.length > 0) throw new FfiError(`foreign library '${alias}' imports '${iface.imports[0]?.module}.${iface.imports[0]?.name}': a foreign library is instantiated with no imports`);
  const fn = (name: string) => {
    const e = iface.exports.get(name);
    return e?.kind === "func" ? e.type : null;
  };
  for (const d of decls) {
    const actual = fn(d.symbol);
    if (!actual) throw new FfiError(`foreign library '${alias}' has no exported function '${d.symbol}' (외부 ${alias} ${d.name})`);
    const want = wasmSignature(d);
    if (!sameType(actual, want)) throw new FfiError(`외부 ${alias} ${d.name}: '${d.symbol}' has type ${formatFuncType(actual)} in the library, but the declaration needs ${formatFuncType(want)}`);
  }
  if (decls.some(borrows)) {
    const a = fn("y3_alloc");
    const f = fn("y3_free");
    if (!a || !sameType(a, ALLOC) || !f || !sameType(f, FREE) || iface.exports.get("memory")?.kind !== "memory") {
      throw new FfiError(`foreign library '${alias}' takes buffers, so it must export 'memory', 'y3_alloc(i32) → i32' and 'y3_free(i32, i32)'`);
    }
  }
}

// ---- Calls, for one run.

// A foreign resource: one (library, address) for one stretch of life. The handle id Y3
// sees names the resource, not the call that returned it. An address returned again
// while live is the same resource, the same id; returned again after it was freed, it
// is a new generation with a new id, so a stale alias never comes back to life.
type Handle = { readonly library: string; readonly address: number; readonly generation: number; freed: boolean };

export class ForeignRuntime {
  private readonly instances = new Map<string, WebAssembly.Instance>();
  private readonly handles: Handle[] = [];
  private readonly live = new Map<string, number>(); // "library address" → id, while live
  private readonly generations = new Map<string, number>(); // "library address" → last generation

  private issue(library: string, address: number): number {
    const key = `${library} ${address}`;
    const known = this.live.get(key);
    if (known !== undefined) return known;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    this.handles.push({ library, address, generation, freed: false });
    this.live.set(key, this.handles.length - 1);
    return this.handles.length - 1;
  }

  private release(h: Handle): void {
    h.freed = true;
    this.live.delete(`${h.library} ${h.address}`);
  }

  constructor(
    private readonly libraries: ReadonlyMap<string, ForeignLibrary>,
    private readonly decls: ReadonlyMap<ForeignId, ForeignDecl>,
    private readonly load: ((path: string) => Uint8Array | null) | undefined,
  ) {}

  private instance(alias: string): WebAssembly.Instance {
    const known = this.instances.get(alias);
    if (known) return known;
    const lib = this.libraries.get(alias);
    if (!lib) throw new RuntimeFault(`no foreign library '${alias}'`);
    const bytes = this.load?.(lib.path) ?? null;
    if (!bytes) throw new RuntimeFault(`foreign library '${alias}' (${lib.path}) cannot be loaded by this host`);
    // The bytes must be the ones the program was built against, and still match its declarations.
    if (sha256(bytes) !== lib.sha256) throw new RuntimeFault(`foreign library '${alias}' (${lib.path}) is not the library this program was built with: its sha256 differs`);
    try {
      checkLibrary(bytes, alias, [...this.decls.values()].filter((d) => d.library === alias));
    } catch (e) {
      if (e instanceof FfiError) throw new RuntimeFault(e.message);
      throw e;
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>), {});
    this.instances.set(alias, instance);
    return instance;
  }

  // Checks a call's handles before anything crosses: a freed, foreign or forged handle
  // never reaches foreign code.
  private address(d: ForeignDecl, v: ConcreteValue): number {
    if (v.kind !== "resource" || v.resource !== "foreign") throw new RuntimeFault(`${d.name}: a Foreign pointer was expected`);
    const h = this.handles[v.id];
    if (!h) throw new RuntimeFault(`${d.name}: Foreign pointer #${v.id} was never issued`);
    if (h.library !== d.library) throw new RuntimeFault(`${d.name}: Foreign pointer #${v.id} belongs to library '${h.library}', not '${d.library}'`);
    if (h.freed) throw new RuntimeFault(`${d.name}: Foreign pointer #${v.id} was already freed`);
    return h.address;
  }

  call(id: ForeignId, args: readonly ConcreteValue[]): ConcreteValue {
    const d = this.decls.get(id);
    if (!d) throw new RuntimeFault(`no foreign function '${id}'`);
    const label = `외부 ${d.library} ${d.name}`;
    const supplied = d.params.filter((p) => p.kind !== "out").length;
    if (args.length !== supplied) throw new RuntimeFault(`${label} takes ${supplied} argument(s), not ${args.length}`);
    // Handles first: nothing is allocated or called for a dead pointer.
    let next = 0;
    const freed: Handle[] = [];
    const plan = d.params.map((p) => {
      if (p.kind === "out") return { p, v: null };
      const v = args[next++] as ConcreteValue;
      if (p.kind === "handle") {
        const address = this.address(d, v);
        if (d.frees) freed.push(this.handles[(v as { id: number }).id] as Handle); // exactly one (checkDecl)
        return { p, v, address };
      }
      return { p, v };
    });
    const instance = this.instance(d.library);
    const exports = instance.exports as Record<string, unknown>;
    const fn = exports[d.symbol] as (...a: unknown[]) => unknown;
    const memory = exports.memory as WebAssembly.Memory | undefined;
    const alloc = exports.y3_alloc as ((n: number) => number) | undefined;
    const free = exports.y3_free as ((p: number, n: number) => void) | undefined;
    const borrowed: { ptr: number; len: number }[] = [];
    let out: { ptr: number; len: number } | undefined;
    const lend = (bytes: Uint8Array) => {
      const ptr = (alloc as (n: number) => number)(bytes.length) >>> 0;
      const mem = new Uint8Array((memory as WebAssembly.Memory).buffer);
      if (ptr === 0 || ptr + bytes.length > mem.length) throw new RuntimeFault(`${label}: y3_alloc(${bytes.length}) returned an unusable address ${ptr}`);
      mem.set(bytes, ptr);
      borrowed.push({ ptr, len: bytes.length });
      return [ptr, bytes.length];
    };
    let raw: unknown;
    let written: Uint8Array | null = null;
    try {
      const wasmArgs = plan.flatMap((x) => {
        const { p, v } = x;
        switch (p.kind) {
          case "scalar":
            return [toWasm(p.type, v as ConcreteValue)];
          case "handle":
            return [(x as { address: number }).address];
          case "text":
            return lend(new TextEncoder().encode((v as { value: string }).value));
          case "bytes":
            return lend(Uint8Array.from((elementsOf(v as ConcreteValue) ?? []).map((e) => Number((e as { value: bigint }).value))));
          case "out": {
            const [ptr, len] = lend(new Uint8Array(p.length)) as [number, number];
            out = { ptr, len };
            return [ptr, len];
          }
        }
      });
      raw = fn(...wasmArgs);
      // An out-buffer's bytes are copied out before it is freed with the others.
      const o = out as { ptr: number; len: number } | undefined; // set inside the plan's closure
      if (o) written = new Uint8Array((memory as WebAssembly.Memory).buffer).slice(o.ptr, o.ptr + o.len);
    } catch (e) {
      if (e instanceof RuntimeFault) throw e;
      // A trap (unreachable, out-of-bounds memory) inside foreign code.
      throw new RuntimeFault(`${label} trapped in foreign code: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Every runtime-owned buffer, out-buffer included, whether the call returned or trapped.
      for (const b of borrowed) free?.(b.ptr, b.len);
    }
    for (const h of freed) this.release(h);
    const r = d.result;
    if (r.kind === "unit") return UNIT;
    if (r.kind === "scalar") return fromWasm(label, r.type, raw);
    if (r.kind === "handle") {
      const address = (raw as number) >>> 0;
      if (address === 0) throw new RuntimeFault(`${label} returned a null pointer where a Foreign pointer was declared`);
      return { kind: "resource", resource: "foreign", id: this.issue(d.library, address) };
    }
    return { kind: "array", elements: [...(written ?? [])].map((b) => int(BigInt(b))) };
  }
}

function toWasm(type: FfiScalar, v: ConcreteValue): number | bigint {
  switch (v.kind) {
    case "int":
      return type === "i64" || type === "u64" ? BigInt.asIntN(64, v.value) : Number(BigInt.asIntN(32, v.value));
    case "float":
      return v.value;
    case "bool":
      return v.value ? 1 : 0;
    default:
      throw new RuntimeFault(`a ${type} was expected at the FFI boundary`);
  }
}

const RANGES: Partial<Record<FfiScalar, [number, number]>> = { i8: [-128, 127], u8: [0, 255], i16: [-32768, 32767], u16: [0, 65535] };

// A foreign result, checked against its declared type: a value outside it is the foreign
// code breaking its contract, never a Y3 value outside its type.
function fromWasm(label: string, type: FfiScalar, raw: unknown): ConcreteValue {
  const violation = (shown: string): never => {
    throw new RuntimeFault(`${label} broke its declared ABI: it returned ${shown}, which is not a ${type}`);
  };
  switch (type) {
    case "f32":
      return float(raw as number, 32);
    case "f64":
      return float(raw as number, 64);
    case "i64":
      return int(raw as bigint);
    case "u64":
      return int(BigInt.asUintN(64, raw as bigint));
    case "u32":
      return int(BigInt((raw as number) >>> 0));
    case "i32":
      return int(BigInt(raw as number));
    case "Bool":
      return raw === 0 ? bool(false) : raw === 1 ? bool(true) : violation(String(raw));
    default: {
      const [lo, hi] = RANGES[type] as [number, number];
      const n = raw as number;
      return n < lo || n > hi ? violation(String(n)) : int(BigInt(n));
    }
  }
}
