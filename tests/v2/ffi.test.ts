import { describe, expect, it } from "vitest";
import {
  compileProgram,
  compileToMir,
  compileWasm,
  loadWasmArtifact,
  runWasm,
  encodeBytecode,
  hasErrors,
  loadDocument,
  memoryHost,
  moduleOf,
  optimizeMir,
  readReplay,
  runExecutable,
  runProgram,
  writeArtifact,
  writeReplay,
  type BytecodeModule,
  type CompiledProgram,
  type Manifest,
  type MemoryHost,
  type ProgramResult,
} from "../../src/v2";
import { observable } from "./compile-helpers";
import { BUFFERS, IMPORTS, MATH } from "./ffi-libraries";

// M9 FFI (docs/v2-ffi.md): 외부 declarations, the C ABI over wasm32, pointers as opaque
// handles, and every way the boundary can be misused.

const LIBS: Record<string, Uint8Array> = { "math.wasm": MATH, "buf.wasm": BUFFERS, "imports.wasm": IMPORTS };

const DECLS = [
  "외부 씨 더하기 (a: i32, b: i32) → i32 = add",
  "외부 씨 순더하기 (a: i32, b: i32) → i32 = add 순수",
  "외부 씨 큰더하기 (a: i64, b: i64) → i64 = add64",
  "외부 씨 무부호더하기 (a: u64, b: u64) → u64 = add64",
  "외부 씨 제곱근 (x: f64) → f64 = sqrt",
  "외부 씨 실더하기 (a: f32, b: f32) → f32 = fadd",
  "외부 씨 삼백 () → u8 = three_hundred",
  "외부 씨 둘 () → Bool = two",
  "외부 씨 음수 () → i32 = minus_one",
  "외부 씨 큰음수 () → u32 = minus_one",
  "외부 씨 홀수 (n: i32) → Bool = is_odd",
  "외부 씨 함정 () = trap",
  "외부 씨 널 () → Foreign = null",
  "외부 버 세기 (s: Text) → u32 = count",
  "외부 버 합 (b: []u8) → u32 = sum",
  "외부 버 배열합 (b: [u8; 3]) → u32 = sum",
  "외부 버 채우기 (n: u8, 버퍼: 출력 [u8; 4]) → [u8; 4] = fill",
  "외부 버 새계수기 () → Foreign = new_counter",
  "외부 버 다음 (c: Foreign) → i32 = next",
  "외부 버 해방 (c: Foreign) = free_counter 해제",
  "외부 버 거친 (n: i32) → i32 = wild",
];

const source = (cells: string[], decls = DECLS, foreign = '"씨" = "math.wasm"\n"버" = "buf.wasm"') =>
  `+++\n[foreign]\n${foreign}\n+++\n⟦\n${cells.map((c) => `[${c}]`).join("\n")}\n⟧\n\n※\n\n${decls.join("\n")}\n`;

function compile(cells: string[], decls = DECLS, foreign?: string, libs = LIBS): { program: CompiledProgram; manifest: Manifest } | { errors: string[] } {
  const loaded = loadDocument(source(cells, decls, foreign));
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) return { errors: loaded.diagnostics.map((d) => `${d.code} ${d.message}`) };
  const c = compileProgram(loaded.ast, loaded.space, { libraries: (p) => libs[p] ?? null });
  return c.program ? { program: c.program, manifest: loaded.manifest } : { errors: c.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`) };
}

const ok = (cells: string[], decls?: string[]) => {
  const c = compile(cells, decls);
  if ("errors" in c) throw new Error(c.errors.join("\n"));
  return c;
};
const errors = (cells: string[], decls?: string[], foreign?: string, libs?: Record<string, Uint8Array>) => {
  const c = compile(cells, decls, foreign, libs);
  return "errors" in c ? c.errors : [];
};

const artifactOf = (c: { program: CompiledProgram; manifest: Manifest }) => {
  const { mir, nodes } = compileToMir(c.program, c.manifest.start);
  return writeArtifact(encodeBytecode(optimizeMir(mir).mir, nodes, c.program, { module: "main", maxSteps: c.manifest.maxSteps, start: c.manifest.start }));
};

// Both engines, which must agree on everything.
function run(cells: string[], options: { host?: () => MemoryHost; decls?: string[] } = {}): ProgramResult {
  const c = ok(cells, options.decls);
  const host = options.host ?? (() => memoryHost({ libraries: LIBS }));
  const hir = runProgram(c.program, c.manifest, { host: host() });
  const artifact = artifactOf(c);
  const loaded = moduleOf(artifact);
  const vm = runExecutable(loaded.executable, loaded.program, c.manifest, { host: host() });
  expect(observable(vm)).toEqual(observable(hir));
  const wasm = loadWasmArtifact(compileWasm(loaded, artifact));
  expect(observable(runWasm(wasm.module, wasm.loaded, c.manifest, { host: host() }))).toEqual(observable(hir));
  return hir;
}
const out = (cells: string[]) => run([...cells, "끝이다."]).output;
const fault = (cells: string[], options?: { host?: () => MemoryHost }) => {
  const r = run([...cells, "끝이다."], options);
  expect(r.outcome.status).toBe("FAULT");
  return (r.outcome as { message: string }).message;
};

describe("FFI: by-value scalars", () => {
  it("int add(int, int), double sqrt(double)", () => {
    expect(out(["x는 씨 더하기: 2i32, 40i32", "x를 말한다.", "r은 씨 제곱근: 2.0", "r을 말한다."])).toEqual(["42", "1.4142135623730951"]);
  });

  it("i32 wraps in C, but its result is still an i32; u32 reads the same bits unsigned", () => {
    expect(out(["x는 씨 더하기: 2147483647i32, 1i32", "x를 말한다.", "a는 씨 음수:", "a를 말한다.", "b는 씨 큰음수:", "b를 말한다."])).toEqual(["-2147483648", "-1", "4294967295"]);
  });

  it("i64 and u64 cross as wasm i64, without precision loss", () => {
    expect(out(["x는 씨 큰더하기: 9007199254740993i64, 1i64", "x를 말한다.", "y는 씨 무부호더하기: 18446744073709551615u64, 1u64", "y를 말한다."])).toEqual(["9007199254740994", "0"]);
  });

  it("f32 is computed at f32", () => {
    expect(out(["x는 씨 실더하기: 0.1f32, 0.2f32", "x를 말한다."])).toEqual(["0.3"]);
    const r = run(["x는 씨 실더하기: 16777216.0f32, 1.0f32", "x를 말한다.", "끝이다."]);
    expect(r.output).toEqual(["16777216.0"]);
  });

  it("Bool crosses as 0/1", () => {
    expect(out(["x는 씨 홀수: 7i32", "x를 말한다.", "y는 씨 홀수: 8i32", "y를 말한다."])).toEqual(["참", "거짓"]);
  });

  it("a result outside its declared type is an ABI violation: FAULT, never a bad value", () => {
    expect(fault(["x는 씨 삼백:"])).toMatch(/broke its declared ABI: it returned 300, which is not a u8/);
    expect(fault(["x는 씨 둘:"])).toMatch(/returned 2, which is not a Bool/);
    expect(fault(["x는 씨 널:"])).toMatch(/null pointer/);
  });

  it("a trap in foreign code is a FAULT", () => {
    expect(fault(["씨 함정:"])).toMatch(/trapped in foreign code/);
    expect(fault(["x는 버 거친: 1i32"])).toMatch(/trapped in foreign code/);
  });

  it("a 순수 call runs with no event; any other foreign call is an effect event", () => {
    const r = run(["x는 씨 더하기: 1i32, 2i32", "y는 씨 순더하기: 3i32, 4i32", "끝이다."]);
    expect(r.events.map((e) => [e.source, e.kind, e.args.join(","), e.value])).toEqual([["foreign.씨.더하기", "foreign", "1,2", "3"]]);
  });
});

describe("FFI: buffers and pointers", () => {
  it("Text crosses as UTF-8 (pointer, byte length): length is bytes, not characters", () => {
    expect(out(['n은 버 세기: "가나다"', "n을 말한다.", 'm은 버 세기: "abc"', "m을 말한다."])).toEqual(["9", "3"]);
  });

  it("byte arrays and slices are borrowed for the call", () => {
    expect(out(["a는 배열: 1u8, 2u8, 250u8", "s는 버 배열합: a", "s를 말한다.", "b는 배열 자르기: a, 1, 3", "t는 버 합: b", "t를 말한다."])).toEqual(["253", "252"]);
  });

  it("an out-buffer's bytes become the call's [u8; N] result", () => {
    expect(out(["b는 버 채우기: 10u8", "b를 말한다."])).toEqual(["[10, 11, 12, 13]"]);
  });

  it("a foreign pointer is an opaque handle: used, then freed once", () => {
    expect(out(["c는 버 새계수기:", "a는 버 다음: c", "b는 버 다음: c", "b를 말한다.", "버 해방: c", "c를 말한다."])).toEqual(["2", "<foreign #0>"]);
  });

  it("use after free and double free are FAULTs before foreign code runs", () => {
    expect(fault(["c는 버 새계수기:", "버 해방: c", "a는 버 다음: c"])).toMatch(/Foreign pointer #0 was already freed/);
    expect(fault(["c는 버 새계수기:", "버 해방: c", "버 해방: c"])).toMatch(/already freed/);
  });

  it("two handles are equal only if they are the same handle", () => {
    expect(out(["c는 버 새계수기:", "d는 버 새계수기:", "e는 c이다.", 'c가 d이면 "같다"를 말한다.', 'c가 e이면 "같은 손잡이"를 말한다.'])).toEqual(["같은 손잡이"]);
  });
});

describe("FFI: the type checker sees the declared signature", () => {
  it("wrong argument types, wrong arity", () => {
    expect(errors(["x는 씨 더하기: 1i64, 2i32", "끝이다."]).join("\n")).toMatch(/Y3Y001 .*argument 1 of '씨 더하기'/);
    expect(errors(["x는 씨 더하기: 1i32", "끝이다."]).join("\n")).toMatch(/Y3Y003 .*'씨 더하기' takes 2 arguments, not 1/);
    expect(errors(["x는 씨 더하기: 1i32, 2i32", "y는 x에 1i64를 더한다.", "끝이다."])).not.toEqual([]);
    expect(errors(["x는 씨 없음: 1i32", "끝이다."]).join("\n")).toMatch(/has no 외부 declaration '없음'/);
  });

  it("a Foreign value cannot be made from an integer, kept temporal, or used as a key", () => {
    expect(errors(["c는 버 새계수기:", "c에 1을 더한다.", "끝이다."])).not.toEqual([]);
    expect(errors(["c는 3이다.", "a는 버 다음: c", "끝이다."]).join("\n")).toMatch(/argument 1 of '버 다음'/);
    expect(errors(["c는 미정이다.", "a는 버 다음: c", "끝이다."]).join("\n")).toMatch(/Y3Y004/);
    expect(errors(["c는 버 새계수기:", "s는 집합 새:", "t는 집합 넣기: s, c", "끝이다."]).join("\n")).toMatch(/Y3N002/);
  });
});

describe("FFI: malformed declarations and libraries are refused at build time", () => {
  const one = (decl: string, foreign?: string, libs?: Record<string, Uint8Array>) => errors(["끝이다."], [decl], foreign, libs).join("\n");

  it("the declared wasm type must be the library's real export type", () => {
    expect(one("외부 씨 더하기 (a: i64, b: i32) → i32 = add")).toMatch(/'add' has type \(i32, i32\) → \(i32\) in the library, but the declaration needs \(i64, i32\) → \(i32\)/);
    expect(one("외부 씨 더하기 (a: i32) → i32 = add")).toMatch(/needs \(i32\) → \(i32\)/);
    expect(one("외부 씨 제곱근 (x: f32) → f32 = sqrt")).toMatch(/needs \(f32\) → \(f32\)/);
  });

  it("a missing symbol, a missing library, an unlisted library", () => {
    expect(one("외부 씨 없다 () = nothing_here")).toMatch(/has no exported function 'nothing_here'/);
    expect(one("외부 씨 더하기 (a: i32, b: i32) → i32 = add", '"씨" = "nope.wasm"')).toMatch(/cannot load foreign library '씨' \(nope.wasm\)/);
    expect(one("외부 다른 더하기 (a: i32, b: i32) → i32 = add")).toMatch(/'다른' is not a foreign library/);
  });

  it("types that do not cross, and contradictory attributes", () => {
    expect(one("외부 씨 더하기 (a: i128, b: i32) → i32 = add")).toMatch(/i128 does not cross the FFI boundary/);
    expect(one("외부 씨 더하기 (a: bigint, b: i32) → i32 = add")).toMatch(/does not cross/);
    expect(one("외부 씨 더하기 (a: i32, b: i32) → Text = add")).toMatch(/Text and \[\]u8 cannot be returned/);
    expect(one("외부 버 다음 (c: Foreign) → i32 = next 순수")).toMatch(/순수 \(pure\) function cannot take, return or free a Foreign pointer/);
    expect(one("외부 버 다음 (c: i32) → i32 = next 해제")).toMatch(/takes the Foreign pointer it frees/);
    expect(one("외부 버 채우기 (n: u8, 버퍼: 출력 [u8; 4]) → [u8; 5] = fill")).toMatch(/out-buffer/);
    expect(one("외부 씨 더하기 (a: i32, b: i32) → i32 = add 마법")).toMatch(/'마법' is not 순수 or 해제/);
  });

  it("a library with imports, a library that is not wasm, a library outside the project", () => {
    expect(one("외부 임 실행 (n: i32) → i32 = run", '"임" = "imports.wasm"')).toMatch(/imports 'env.system': a foreign library is instantiated with no imports/);
    expect(one("외부 씨 더하기 (a: i32, b: i32) → i32 = add", undefined, { ...LIBS, "math.wasm": new TextEncoder().encode("#!/bin/sh") })).toMatch(/not a valid WebAssembly module/);
    expect(errors(["끝이다."], [], '"씨" = "../../etc/lib.wasm"').join("\n")).toMatch(/leaves the project/);
    expect(errors(["끝이다."], [], '"씨" = "/usr/lib/x.wasm"').join("\n")).toMatch(/leaves the project/);
    expect(errors(["끝이다."], [], '"표준" = "math.wasm"').join("\n")).toMatch(/cannot name a foreign library/);
  });

  it("a library that takes buffers must export its allocator and memory", () => {
    expect(one("외부 씨 세기 (s: Text) → i32 = add")).toMatch(/must export 'memory', 'y3_alloc/);
  });
});

describe("FFI: capabilities and the run-time host", () => {
  it("a host that denies ffi: the call is a FAULT naming the capability", () => {
    expect(fault(["x는 씨 더하기: 1i32, 2i32"], { host: () => memoryHost({ libraries: LIBS, deny: ["ffi"] }) })).toMatch(/needs the 'ffi' capability/);
    expect(fault(["x는 씨 순더하기: 1i32, 2i32"], { host: () => memoryHost({ libraries: LIBS, deny: ["ffi"] }) })).toMatch(/needs the 'ffi' capability/);
  });

  it("a host that cannot load the library, or loads different bytes", () => {
    expect(fault(["x는 씨 더하기: 1i32, 2i32"], { host: () => memoryHost() })).toMatch(/cannot be loaded by this host/);
    const swapped = { ...LIBS, "math.wasm": BUFFERS };
    expect(fault(["x는 씨 더하기: 1i32, 2i32"], { host: () => memoryHost({ libraries: swapped }) })).toMatch(/not the library this program was built with/);
  });

  it("a foreign call is an effect barrier: it never overtakes held output", () => {
    const r = run(["x는 미정이다.", "x를 말한다.", "y는 씨 더하기: 1i32, 2i32", "x는 5였다.", "끝이다."]);
    expect(r.outcome).toMatchObject({ status: "UNRESOLVED", message: expect.stringMatching(/'씨 더하기' cannot run while earlier output is held/) });
    expect(r.events.map((e) => e.source)).toEqual(["std.io.stdout"]); // the held "?" at the end; no foreign call
  });

  it("a 순수 call is not a barrier", () => {
    const r = run(["x는 미정이다.", "x를 말한다.", "y는 씨 순더하기: 1i32, 2i32", "x는 5였다.", "끝이다."]);
    expect(r.output).toEqual(["5"]);
  });

  it("foreign results replay without the library", () => {
    const c = ok(["c는 버 새계수기:", "a는 버 다음: c", "a를 말한다.", "끝이다."]);
    const artifact = artifactOf(c);
    const loaded = moduleOf(artifact);
    const recorded = runExecutable(loaded.executable, loaded.program, c.manifest, { host: memoryHost({ libraries: LIBS }) });
    const events = readReplay(writeReplay(artifact, recorded.events), artifact).events;
    const replayed = runExecutable(loaded.executable, loaded.program, c.manifest, { host: memoryHost(), replay: events });
    expect(observable(replayed)).toEqual(observable(recorded));
  });
});

describe("FFI: hostile bytecode", () => {
  const base = () => JSON.parse(artifactOf(ok(["c는 버 새계수기:", "a는 버 다음: c", "x는 씨 더하기: 1i32, 2i32", "끝이다."])).split("\n")[1] as string) as BytecodeModule;
  const load = (m: BytecodeModule) => moduleOf(writeArtifact(m));
  const tamper = (f: (m: Record<string, any>) => void) => {
    const m = base() as unknown as Record<string, any>;
    f(m);
    return () => load(m as unknown as BytecodeModule);
  };
  const run = (m: BytecodeModule) => {
    const l = load(m);
    return runExecutable(l.executable, l.program, { name: null, start: m.start, maxSteps: 100, imports: new Map(), foreign: new Map(), test: null }, { host: memoryHost({ libraries: LIBS }) });
  };

  it("cannot call an undeclared symbol", () => {
    expect(tamper((m) => m.blocks.forEach((b: any) => b.code.forEach((ins: any[]) => ins[2] === "씨.더하기" && (ins[2] = "씨.system"))))).toThrow(/foreign function '씨.system', which is not declared/);
  });

  it("cannot change an ABI signature: the library's real export type decides", () => {
    // A declaration edited to take an i64 now disagrees with the instruction's argument
    // types (the type verifier), and also with the library itself.
    expect(tamper((m) => (m.foreign.find((d: any) => d.name === "더하기").params[0] = { kind: "scalar", type: "i64" }))).toThrow(/argument 1 of '씨.더하기'/);
    const m = base() as unknown as Record<string, any>;
    m.foreign.find((d: any) => d.name === "더하기").params = [{ kind: "scalar", type: "u32" }, { kind: "scalar", type: "u32" }];
    m.foreign.find((d: any) => d.name === "더하기").symbol = "add64";
    expect(() => run(m as unknown as BytecodeModule)).toThrow(); // the type verifier refuses u32 for i32 registers
  });

  it("cannot point a symbol at a different export", () => {
    const m = base() as unknown as Record<string, any>;
    m.foreign.find((d: any) => d.name === "더하기").symbol = "add64";
    const r = run(m as unknown as BytecodeModule);
    expect(r.outcome).toMatchObject({ status: "FAULT" });
    expect((r.outcome as { message: string }).message).toMatch(/'add64' has type \(i64, i64\) → \(i64\) in the library/);
  });

  it("cannot load a library outside the project, or a library with another hash", () => {
    expect(tamper((m) => (m.libraries[0].path = "../../../etc/x.wasm"))).toThrow(/outside the project/);
    expect(tamper((m) => (m.libraries[0].sha256 = "nothex"))).toThrow(/malformed library entry/);
    const m = base() as unknown as Record<string, any>;
    m.libraries.find((l: any) => l.alias === "씨").sha256 = "0".repeat(64);
    const r = run(m as unknown as BytecodeModule);
    expect((r.outcome as { message: string }).message).toMatch(/not the library this program was built with/);
  });

  it("cannot forge a pointer: Foreign has no constant, and a handle id is never an integer", () => {
    expect(tamper((m) => m.constants.push({ resource: "foreign", id: 0 }))).toThrow(/malformed constant/);
    // An i64 register handed to a Foreign parameter fails the type verifier.
    expect(
      tamper((m) => {
        const block = m.blocks.find((b: any) => b.code.some((ins: any[]) => ins[2] === "버.다음"));
        const ins = block.code.find((i: any[]) => i[2] === "버.다음");
        const constant = m.constants.push({ int: "0" }) - 1;
        const type = m.types.push({ kind: "prim", name: "i64" }) - 1;
        block.code.splice(block.code.indexOf(ins), 0, [0, ins[3][0], constant, type]);
      }),
    ).toThrow(/Foreign/);
  });

  it("cannot bypass the declaration rules (pure pointers, free without pointer)", () => {
    expect(tamper((m) => (m.foreign.find((d: any) => d.name === "다음").pure = true))).toThrow(/순수 \(pure\) function cannot take/);
    expect(tamper((m) => (m.foreign.find((d: any) => d.name === "더하기").frees = true))).toThrow(/takes the Foreign pointer it frees/);
    expect(tamper((m) => (m.foreign.find((d: any) => d.name === "더하기").library = "없음"))).toThrow();
    expect(tamper((m) => (m.foreign.find((d: any) => d.name === "더하기").params[0] = { kind: "scalar", type: "i128" }))).toThrow(/malformed FFI parameter/);
  });
});
