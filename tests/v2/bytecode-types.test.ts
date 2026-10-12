import { describe, expect, it } from "vitest";
import { compileToMir, encodeBytecode, loadBytecode, memoryHost, readArtifact, runExecutable, writeArtifact, type BytecodeModule } from "../../src/v2";
import { column, compileSource } from "./compile-helpers";

// Hand-crafted artifacts that break the typed-MIR invariant: each is refused by the
// loader, before anything runs, without the source.

type Mutable = { -readonly [K in keyof BytecodeModule]: BytecodeModule[K] extends readonly (infer T)[] ? T[] : BytecodeModule[K] };
const build = (cells: string[], appendix = ""): Mutable => {
  const c = compileSource(column(cells, appendix));
  if (!c) throw new Error("expected a program");
  const { mir, nodes } = compileToMir(c.program, c.manifest.start);
  return JSON.parse(JSON.stringify(encodeBytecode(mir, nodes, c.program, { module: "main", maxSteps: 100, start: c.manifest.start }))) as Mutable;
};
const code = (m: Mutable) => m.blocks.flatMap((b) => b.code as unknown[][]);
const OP = { const: 0, arith: 5, builtin: 10, assign: 24, declare: 25 };
const addType = (m: Mutable, t: unknown) => (m.types.push(t as never), m.types.length - 1);
const addConst = (m: Mutable, v: unknown) => (m.constants.push(v as never), m.constants.length - 1);
const TEXT = { kind: "prim", name: "Text" };
const refuse = (m: Mutable, message: RegExp) => {
  let ran = false;
  expect(() => {
    const loaded = loadBytecode(m as unknown as BytecodeModule);
    ran = true;
    runExecutable(loaded.executable, loaded.program, { name: null, start: m.start, maxSteps: 100, imports: new Map(), test: null }, { host: memoryHost() });
  }).toThrow(message);
  expect(ran, "refused before execution").toBe(false);
};
// The const instruction whose constant is this JSON value.
const constOf = (m: Mutable, value: unknown) => code(m).find((c) => c[0] === OP.const && JSON.stringify(m.constants[c[2] as number]) === JSON.stringify(value)) as unknown[];

describe("the bytecode type verifier", () => {
  it("accepts every artifact the compiler writes (also checked on every fixture and random program)", () => {
    expect(() => loadBytecode(build(["x는 1이다.", "끝이다."]) as unknown as BytecodeModule)).not.toThrow();
  });

  it("refuses Text assigned to an i64 noun", () => {
    const m = build(["x는 1이다.", "끝이다."]);
    const c = constOf(m, { int: "1" });
    c[2] = addConst(m, { text: "a" });
    c[3] = addType(m, TEXT);
    refuse(m, /the value assigned to #1 must be i64, not Text/);
  });

  it("refuses an i64 returned from a plane declared Text", () => {
    const m = build(["f:", "끝이다."], ":f: () → i64 ⟦\n[1을 돌려준다.]\n⟧\n");
    m.procedures[0] = { ...m.procedures[0]!, results: [TEXT as never] };
    refuse(m, /returned value 1 must be Text, not i64/);
  });

  it("refuses a wrongly typed callable-plane argument", () => {
    const m = build(["f: 1", "끝이다."], ":f: (a: i64) ⟦\n[돌아간다.]\n⟧\n");
    const p = m.procedures[0]!;
    m.procedures[0] = { ...p, params: [{ ...p.params[0]!, type: TEXT as never }] };
    refuse(m, /argument 1 of 'main.f' must be Text, not i64/);
  });

  it("refuses a wrongly typed callable-plane result target", () => {
    const m = build(["x는 f:", "끝이다."], ":f: () → i64 ⟦\n[1을 돌려준다.]\n⟧\n");
    const main = m.bodies.find((b) => b.id === "main")!;
    (main.nouns as unknown as unknown[][])[0]![2] = TEXT;
    refuse(m, /result 1 of 'main.f' is i64, but #1 is Text/);
  });

  it("refuses Text passed to a numeric built-in", () => {
    const m = build(["x는 수학 절댓값: 1", "끝이다."]);
    const c = constOf(m, { int: "1" });
    c[2] = addConst(m, { text: "a" });
    c[3] = addType(m, TEXT);
    refuse(m, /'std.math.abs' is called with Text, but its call types say i64/);
    const n = build(["x는 수학 절댓값: 1", "끝이다."]);
    const d = constOf(n, { int: "1" });
    d[2] = addConst(n, { text: "a" });
    d[3] = addType(n, TEXT);
    n.callTypes[0] = { args: [TEXT], result: TEXT } as never;
    n.bodies[0]!.nouns[0]![2] = TEXT as never;
    refuse(n, /'std.math.abs' needs a number for T, not Text/);
  });

  it("refuses an i64 used as a Bool condition", () => {
    const m = build(["x는 1이다.", "x가 1이면 끝이다.", "끝이다."]);
    const b = m.blocks.find((x) => (x.end as unknown[])[0] === "test")!;
    const end = b.end as unknown[];
    end[1] = ["bool", (end[1] as unknown[])[1]];
    refuse(m, /a condition must be Bool, not i64/);
  });

  it("refuses an f64 operand under an i64 arithmetic instruction", () => {
    const m = build(["x는 1이다.", "x에 2를 더한다.", "끝이다."]);
    const c = constOf(m, { int: "2" });
    c[2] = addConst(m, { float: 2, width: 64 });
    c[3] = addType(m, { kind: "prim", name: "f64" });
    refuse(m, /the right operand of add i64 must be i64, not f64/);
  });

  it("refuses a non-bigint number at the temporal boundary", () => {
    const m = build(["x는 미정이다.", "x는 3이었다.", "끝이다."]);
    m.bodies[0]!.nouns[0]![2] = { kind: "prim", name: "i64" } as never;
    // The past statement's 3 is a bigint constant; retype it too so only the declaration is wrong.
    const c = constOf(m, { int: "3" });
    c[3] = addType(m, { kind: "prim", name: "i64" });
    refuse(m, /a temporal value is bigint or Text, and #1 is i64/);
  });

  it("refuses registers whose types disagree where match arms join", () => {
    const m = build(["o는 Some: 1", "y는 o에 따라: Some(n) → n, None → 0", "끝이다."]);
    const c = constOf(m, { int: "0" });
    c[2] = addConst(m, { text: "영" });
    c[3] = addType(m, TEXT);
    refuse(m, /incompatible register types joining here: r\d+ is i64 on one path and Text on another/);
  });
});

describe("constant representation", () => {
  it("refuses a surrogate rune", () => {
    const m = build(["r은 '가'이다.", "끝이다."]);
    m.constants[m.constants.findIndex((c) => JSON.stringify(c).includes("rune"))] = { rune: 0xd800 } as never;
    expect(() => loadBytecode(m as unknown as BytecodeModule)).toThrow(/rune 55296 is not a Unicode scalar value/);
    m.constants[0] = { rune: 0x110000 } as never;
    expect(() => loadBytecode(m as unknown as BytecodeModule)).toThrow(/rune 1114112 is not a Unicode scalar value/);
  });

  it("refuses an f32 constant that is not a binary32 value, and keeps the ones that are", () => {
    const m = build(["f는 0.5f32이다.", "f를 말한다.", "끝이다."]);
    const i = m.constants.findIndex((c) => JSON.stringify(c).includes("float"));
    m.constants[i] = { float: 0.1, width: 32 } as never;
    expect(() => loadBytecode(m as unknown as BytecodeModule)).toThrow(/0.1 is not a binary32 value/);
    m.constants[i] = { float: Math.fround(0.1), width: 32 } as never;
    const loaded = loadBytecode(m as unknown as BytecodeModule);
    const r = runExecutable(loaded.executable, loaded.program, { name: null, start: m.start, maxSteps: 100, imports: new Map(), test: null }, { host: memoryHost() });
    expect(r.output).toEqual(["0.1"]);
  });

  it("refuses a constant whose value does not fit its declared type", () => {
    const m = build(["x는 1u8이다.", "끝이다."]);
    constOf(m, { int: "1" })[2] = addConst(m, { int: "300" });
    expect(() => loadBytecode(m as unknown as BytecodeModule)).toThrow(/constant .*300.* is not a u8/);
  });

  it("round-trips an artifact through text unchanged", () => {
    const m = build(["x는 1이다.", "끝이다."]);
    expect(readArtifact(writeArtifact(m as unknown as BytecodeModule))).toEqual(m);
  });
});
