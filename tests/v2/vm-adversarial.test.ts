import { describe, expect, it } from "vitest";
import { compileToMir, encodeBytecode, memoryHost, moduleOf, runExecutable, writeArtifact } from "../../src/v2";
import { column, compileSource, observable, runHir, runVm } from "./compile-helpers";

// Small programs aimed at the places an engine could go wrong; both engines must agree.
const same = (source: string, maxSteps?: number, stdin?: string) => {
  const c = compileSource(source);
  if (!c) throw new Error("expected a program");
  const vm = runVm(c, maxSteps, stdin, true);
  expect(observable(vm)).toEqual(observable(runHir(c, maxSteps, stdin)));
  return vm;
};

describe("VM adversarial cases", () => {
  it("VOID right after a taken branch", () => {
    expect(same(column(["x는 1이다.", "x가 1이면 동쪽을 본다.", "끝이다."])).outcome).toMatchObject({ status: "VOID", at: { x: 1, y: 1, z: 0 } });
  });

  it("deep recursion, and the step limit inside it", () => {
    const appendix = ":합: (n: i64) → i64 ⟦\n[n이 0이면 0을 돌려준다.]\n[m은 n이다.]\n[m에서 1을 뺀다.]\n[r은 합: m]\n[r에 n을 더한다.]\n[r을 돌려준다.]\n⟧\n";
    expect(same(column(["s는 합: 300", "s를 말한다.", "끝이다."], appendix), 100_000).output).toEqual(["45150"]);
    expect(same(column(["s는 합: 300", "끝이다."], appendix), 500).outcome).toMatchObject({ status: "STEP_LIMIT" });
  });

  it("numeric overflow and NaN comparisons", () => {
    expect(same(column(["x는 127i8이다.", "x에 1을 더한다.", "끝이다."])).outcome.status).toBe("FAULT");
    expect(same(column(["z는 0.0이다.", "n은 z이다.", "n을 z로 나눈다.", "n이 n이면 \"같다\"를 말한다.", "n이 z보다 작으면 \"작다\"를 말한다.", "끝이다."])).output).toEqual([]);
  });

  it("a temporal symbol through a call, channel and fixed-point self-cycles, and a PARADOX cycle", () => {
    same(column(["값은 미정이다.", "결과는 하나더: 값", "결과를 말한다.", "값은 3이었다.", "끝이다."], ":하나더: (수: bigint) → bigint ⟦\n[수에 1을 더한다.]\n[수를 돌려준다.]\n⟧\n"));
    expect(same(column(["수가 다음에서 온다.", "수에 수를 더한다.", "수를 말한다.", "수를 전으로 보낸다.", "끝이다."])).symbols).toMatchObject([{ mark: "SELF_CAUSED", value: "0" }]);
    expect(same(column(["수는 미정이다.", "여기가 처음이다.", "수에 수를 더한다.", "처음은 끝이었다.", "수를 말한다.", "끝이다."])).symbols).toMatchObject([{ mark: "SELF_CAUSED" }]);
    expect(same(column(["수가 다음에서 온다.", "수에 1을 더한다.", "수를 전으로 보낸다.", "끝이다."])).outcome.status).toBe("PARADOX");
  });

  it("the held-stdout barrier and file effect ordering", () => {
    expect(same(column(["x는 미정이다.", "x를 말한다.", 'w는 파일 쓰기: "a", "b"', "x는 1이었다.", "끝이다."])).outcome.status).toBe("UNRESOLVED");
    const r = same(column(['"a"를 말한다.', 'w는 파일 쓰기: "f", "x"', 'r은 파일 읽기: "f"', "r을 말한다.", "끝이다."]));
    expect(r.events.map((e) => e.source)).toEqual(["std.io.stdout", "std.fs.write", "std.fs.read", "std.io.stdout"]);
  });

  it("reads stdin the same way", () => {
    expect(same(column(["l은 표준 줄읽기:", "l을 말한다.", "끝이다."]), undefined, "안녕\n").output).toEqual(['Some("안녕")']);
  });

  it("restores a pitched, rolled orientation through VM calls", () => {
    const source = `+++\n[start]\nfacing = "동"\nup = "남"\n+++\n\n⟦\n[결과는 돈다: 3] [결과를 말한다.] [끝이다.]\n⟧\n\n※\n\n:돈다: (n: i64) → i64 ⟦\n[위를 본다.] [ ]\n[ ] [ ]\n⟧\n`.replace("[위를 본다.] [ ]\n[ ] [ ]", "[왼쪽을 본다.] [n을 돌려준다.]");
    expect(same(source).output).toEqual(["3"]);
  });
});

describe("source map", () => {
  it("a FAULT in bytecode names its sentence, plane, cell and source line", () => {
    const source = column(["x는 f: 1", "끝이다."], ":f: (a: i64) → i64 ⟦\n[b는 255u8이다.]\n[b에 a를 더한다.]\n[a를 돌려준다.]\n⟧\n").replace("[b에 a를 더한다.]", "[b에 1을 더한다.]");
    const c = compileSource(source)!;
    const { mir, nodes } = compileToMir(c.program, c.manifest.start);
    const loaded = moduleOf(writeArtifact(encodeBytecode(mir, nodes, c.program, { module: "main", maxSteps: 100, start: c.manifest.start })));
    const r = runExecutable(loaded.executable, loaded.program, c.manifest, { host: memoryHost() });
    expect(r.outcome).toMatchObject({ status: "FAULT", at: { x: 0, y: 1, z: 0 }, frame: "f#1" });
    // bytecode instruction → block → node → source
    const block = loaded.executable.blocks.find((b) => b.ops.some((o) => o.op === "arith"))!;
    const node = loaded.executable.nodes[block.node]!;
    expect({ sentence: node.sentence, plane: node.plane, at: node.pose.position, line: node.span?.start.line }).toEqual({ sentence: "b에 1을 더한다.", plane: "f", at: { x: 0, y: 1, z: 0 }, line: 10 });
  });
});
