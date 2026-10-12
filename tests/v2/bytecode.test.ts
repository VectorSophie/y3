import { describe, expect, it } from "vitest";
import { BytecodeError, compileToMir, encodeBytecode, loadBytecode, moduleOf, readArtifact, writeArtifact, type BytecodeModule } from "../../src/v2";
import { compileSource, column } from "./compile-helpers";

// The verifier: malformed bytecode is refused before it runs, whoever wrote it.

const build = (cells: string[], appendix = ""): BytecodeModule => {
  const c = compileSource(column(cells, appendix))!;
  const { mir, nodes } = compileToMir(c.program, c.manifest.start);
  return encodeBytecode(mir, nodes, c.program, { module: "main", maxSteps: 100, start: c.manifest.start });
};
const clone = (m: BytecodeModule): BytecodeModule => JSON.parse(JSON.stringify(m));
const refuse = (m: BytecodeModule, message: RegExp) => expect(() => loadBytecode(m)).toThrow(message);

describe("bytecode verifier", () => {
  const base = build(["x는 1이다.", "x에 2를 더한다.", "x가 3이면 \"셋\"을 말한다.", "y는 f: x", "끝이다."], ":f: (a: i64) → i64 ⟦\n[a를 돌려준다.]\n⟧\n");

  it("accepts what the compiler wrote", () => {
    expect(() => loadBytecode(base)).not.toThrow();
  });

  it("refuses a jump to a block or node that does not exist", () => {
    const m = clone(base);
    const b = m.blocks.find((x) => (x.end as unknown[])[0] === "test")!;
    (b.end as unknown[])[2] = 999;
    refuse(m, /is not a block of the same step/);
    const n = clone(base);
    const e = n.edges.find((x) => (x as { target: { kind: string } }).target.kind === "node") as { target: { node: number } };
    e.target.node = 999;
    refuse(n, /node #999, which does not exist/);
  });

  it("refuses an invalid constant, register, noun or opcode", () => {
    const withConst = clone(base);
    const ins = withConst.blocks.flatMap((b) => b.code).find((c) => c[0] === 0)!; // const
    ins[2] = 999;
    refuse(withConst, /constant 999 is not in the pool/);
    const withReg = clone(base);
    withReg.blocks.flatMap((b) => b.code).find((c) => c[0] === 0)![1] = 5000;
    refuse(withReg, /register 5000 does not exist/);
    const withNoun = clone(base);
    withNoun.blocks.flatMap((b) => b.code).find((c) => c[0] === 24)![1] = 77; // assign
    refuse(withNoun, /noun #77 is not a noun of body 'main'/);
    const withOp = clone(base);
    withOp.blocks[0]!.code.push([99]);
    refuse(withOp, /unknown opcode 99/);
  });

  it("refuses a return with no call frame, and a wrong built-in arity", () => {
    const m = clone(base);
    const mainBlock = m.blocks.find((b) => (m.nodes[b.node] as { body: string }).body === "main")!;
    (mainBlock as { end: unknown }).end = ["return", []];
    refuse(m, /a return with no call frame/);
    const a = clone(base);
    const builtin = a.blocks.flatMap((b) => b.code).find((c) => c[0] === 10)!;
    builtin[3] = [];
    refuse(a, /takes 1 arguments, not 0/);
  });

  it("refuses an ill-shaped temporal instruction and a register read before it is written", () => {
    const t = build(["x는 미정이다.", "x는 3이었다.", "끝이다."]);
    const past = clone(t);
    past.blocks.flatMap((b) => b.code).find((c) => c[0] === 29)![3] = "end"; // pastLeft moment
    refuse(past, /a past statement speaks of now or 처음, never 끝/);
    const early = clone(base);
    const first = early.blocks[0]!;
    first.code.unshift([4, 0, 3]); // move r0 ← r3 before r3 exists
    refuse(early, /reads r3 before it is written/);
  });

  it("refuses another bytecode version, cleanly", () => {
    const text = writeArtifact(base).replace(/^Y3BC 1/, "Y3BC 2");
    expect(() => readArtifact(text)).toThrow(/bytecode version 2 is not supported: this toolchain reads version 1/);
    expect(() => moduleOf("hello")).toThrow(BytecodeError);
  });

  it("builds byte-identical artifacts from the same source", () => {
    expect(writeArtifact(build(["x는 1이다.", "x를 말한다.", "끝이다."]))).toBe(writeArtifact(build(["x는 1이다.", "x를 말한다.", "끝이다."])));
    expect(writeArtifact(base)).not.toMatch(/20\d\d-\d\d-\d\d|timestamp/);
  });
});
