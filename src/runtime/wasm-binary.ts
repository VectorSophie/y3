// A small WebAssembly binary reader and writer (core spec 1.0 + reference types), shared
// by the FFI (which checks a foreign library's real export signatures, docs/v2-ffi.md),
// the WASM backend (docs/v2-wasm.md), and tests that assemble tiny libraries by hand.

export type ValType = "i32" | "i64" | "f32" | "f64" | "externref";
export type FuncType = { readonly params: readonly ValType[]; readonly results: readonly ValType[] };

const VAL_CODE: Record<ValType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, externref: 0x6f };
const CODE_VAL = new Map(Object.entries(VAL_CODE).map(([k, v]) => [v, k as ValType]));

export class WasmFormatError extends Error {}

// ---- Reading: just what a foreign library's interface needs.

export type ModuleInterface = {
  readonly imports: readonly { readonly module: string; readonly name: string; readonly kind: number }[];
  readonly exports: ReadonlyMap<string, { readonly kind: "func"; readonly type: FuncType } | { readonly kind: "memory" | "table" | "global" }>;
};

export function readInterface(bytes: Uint8Array): ModuleInterface {
  let at = 0;
  const fail = (m: string): never => {
    throw new WasmFormatError(`not a valid WebAssembly module: ${m}`);
  };
  const byte = () => (at < bytes.length ? (bytes[at++] as number) : fail("unexpected end"));
  const u32 = () => {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = byte();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
    }
    return fail("bad LEB128");
  };
  const name = () => {
    const n = u32();
    if (at + n > bytes.length) fail("unexpected end");
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, at + n));
    at += n;
    return s;
  };
  const valtype = () => CODE_VAL.get(byte()) ?? fail("unknown value type");
  const limits = () => {
    const flag = byte();
    u32();
    if (flag & 1) u32();
  };
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail("no \\0asm header");
  at = 8;
  const types: FuncType[] = [];
  const funcs: number[] = []; // type index of each function, imports first
  const imports: { module: string; name: string; kind: number }[] = [];
  const exports = new Map<string, { kind: "func"; type: FuncType } | { kind: "memory" | "table" | "global" }>();
  while (at < bytes.length) {
    const id = byte();
    const size = u32();
    const end = at + size;
    if (end > bytes.length) fail("a section runs past the end");
    if (id === 1) {
      for (let n = u32(); n > 0; n -= 1) {
        if (byte() !== 0x60) fail("a type is not a function type");
        const params = Array.from({ length: u32() }, valtype);
        const results = Array.from({ length: u32() }, valtype);
        types.push({ params, results });
      }
    } else if (id === 2) {
      for (let n = u32(); n > 0; n -= 1) {
        const module = name();
        const field = name();
        const kind = byte();
        imports.push({ module, name: field, kind });
        if (kind === 0) funcs.push(u32());
        else if (kind === 1) (byte(), limits());
        else if (kind === 2) limits();
        else if (kind === 3) (valtype(), byte());
        else fail("unknown import kind");
      }
    } else if (id === 3) {
      for (let n = u32(); n > 0; n -= 1) funcs.push(u32());
    } else if (id === 7) {
      for (let n = u32(); n > 0; n -= 1) {
        const field = name();
        const kind = byte();
        const index = u32();
        if (kind === 0) {
          const type = types[funcs[index] ?? -1] ?? fail(`export '${field}' names no function`);
          exports.set(field, { kind: "func", type });
        } else exports.set(field, { kind: kind === 2 ? "memory" : kind === 1 ? "table" : "global" });
      }
    }
    at = end;
  }
  return { imports, exports };
}

export const sameType = (a: FuncType, b: FuncType) => a.params.join() === b.params.join() && a.results.join() === b.results.join();
export const formatFuncType = (t: FuncType) => `(${t.params.join(", ")}) → (${t.results.join(", ")})`;

// ---- Writing.

export const leb = (n: number | bigint, signed = false): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    const done = signed ? (v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40) : v === 0n;
    out.push(done ? b : b | 0x80);
    if (done) return out;
  }
};
const str = (s: string) => {
  const b = [...new TextEncoder().encode(s)];
  return [...leb(b.length), ...b];
};
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => (body.length === 0 ? [] : [id, ...leb(body.length), ...body]);

export type FuncDef = {
  readonly type: FuncType;
  readonly locals?: readonly ValType[];
  readonly body: readonly number[]; // instructions, without the final `end`
  readonly export?: string;
};

export type ModuleDef = {
  readonly imports?: readonly { readonly module: string; readonly name: string; readonly type: FuncType }[];
  readonly memory?: { readonly pages: number; readonly export?: string };
  readonly globals?: readonly { readonly type: ValType; readonly mutable: boolean; readonly init: readonly number[] }[];
  readonly functions: readonly FuncDef[];
  readonly data?: readonly { readonly offset: number; readonly bytes: readonly number[] }[];
};

// Function indices: imports first, then `functions` in order.
export function encodeModule(def: ModuleDef): Uint8Array {
  const types: FuncType[] = [];
  const typeIndex = (t: FuncType) => {
    const i = types.findIndex((u) => sameType(t, u));
    return i >= 0 ? i : types.push(t) - 1;
  };
  const imports = (def.imports ?? []).map((i) => [...str(i.module), ...str(i.name), 0, ...leb(typeIndex(i.type))]);
  const funcs = def.functions.map((f) => leb(typeIndex(f.type)));
  const nImports = imports.length;
  const exports = def.functions.flatMap((f, i) => (f.export ? [[...str(f.export), 0, ...leb(nImports + i)]] : []));
  if (def.memory?.export) exports.push([...str(def.memory.export), 2, 0]);
  const code = def.functions.map((f) => {
    const runs: number[][] = [];
    for (const l of f.locals ?? []) {
      const last = runs[runs.length - 1];
      if (last && last[1] === VAL_CODE[l]) last[0] = (last[0] as number) + 1;
      else runs.push([1, VAL_CODE[l]]);
    }
    const body = [...vec(runs.map(([n, t]) => [...leb(n as number), t as number])), ...f.body, 0x0b];
    return [...leb(body.length), ...body];
  });
  const typeSec = vec(types.map((t) => [0x60, ...vec(t.params.map((p) => [VAL_CODE[p]])), ...vec(t.results.map((r) => [VAL_CODE[r]]))]));
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types.length ? typeSec : []),
    ...section(2, imports.length ? vec(imports) : []),
    ...section(3, funcs.length ? vec(funcs) : []),
    ...section(5, def.memory ? vec([[0x00, ...leb(def.memory.pages)]]) : []),
    ...section(6, def.globals?.length ? vec(def.globals.map((g) => [VAL_CODE[g.type], g.mutable ? 1 : 0, ...g.init, 0x0b])) : []),
    ...section(7, exports.length ? vec(exports) : []),
    ...section(10, code.length ? vec(code) : []),
    ...section(11, def.data?.length ? vec(def.data.map((d) => [0x00, 0x41, ...leb(d.offset, true), 0x0b, ...leb(d.bytes.length), ...d.bytes])) : []),
  ]);
}

// Instruction helpers for hand-written bodies.
export const I = {
  localGet: (i: number) => [0x20, ...leb(i)],
  localSet: (i: number) => [0x21, ...leb(i)],
  localTee: (i: number) => [0x22, ...leb(i)],
  globalGet: (i: number) => [0x23, ...leb(i)],
  globalSet: (i: number) => [0x24, ...leb(i)],
  i32: (n: number) => [0x41, ...leb(n, true)],
  i64: (n: bigint) => [0x42, ...leb(n, true)],
  call: (f: number) => [0x10, ...leb(f)],
  br: (d: number) => [0x0c, ...leb(d)],
  brIf: (d: number) => [0x0d, ...leb(d)],
  i32Load8u: [0x2d, 0x00, 0x00],
  i32Store8: [0x3a, 0x00, 0x00],
  i32Load: [0x28, 0x02, 0x00],
  i32Store: [0x36, 0x02, 0x00],
} as const;
