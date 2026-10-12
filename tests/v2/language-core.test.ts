import { describe, expect, it } from "vitest";
import {
  ALL_ORIENTATIONS,
  DIRECTION_NAMES,
  orientationLabel,
  vectorOf,
  compileProgram,
  describeEffect,
  formatDocument,
  formatProgramTrace,
  formatType,
  hasErrors,
  loadDocument,
  parseSentence,
  runProgram,
  type CompiledProgram,
  type ProgramResult,
} from "../../src/v2";

// M6: ordinary language abstractions around the spatial and temporal core: callable
// planes with frames, records, sums and matches, arrays and slices, and modules.

type Files = Record<string, string>;

function compile(source: string, files: Files = {}) {
  const loaded = loadDocument(source);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) {
    return { program: null, errors: loaded.diagnostics.map((d) => `${d.code} ${d.message}`), manifest: null };
  }
  const compiled = compileProgram(loaded.ast, loaded.space, {
    resolve: (path) => (files[path] === undefined ? null : { path, source: files[path] as string }),
  });
  return {
    program: compiled.program,
    errors: compiled.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`),
    manifest: loaded.manifest,
  };
}

function run(source: string, files: Files = {}, maxSteps?: number): ProgramResult {
  const { program, errors, manifest } = compile(source, files);
  if (!program || !manifest) throw new Error(errors.join("\n"));
  return runProgram(program, manifest, { maxSteps });
}

const errors = (source: string, files: Files = {}) => compile(source, files).errors;
const effects = (result: ProgramResult) => result.trace.flatMap((e) => e.effects.map(describeEffect));

// A volume of one column, then a ※ section.
const program = (cells: string[], appendix = "") => `⟦\n${cells.map((c) => `[${c}]`).join("\n")}\n⟧\n${appendix ? `\n※\n\n${appendix}` : ""}`;

const SQUARE = `:제곱: (수: Int) → Int ⟦
[곱은 0이다.]
[번은 0이다.]
[여기가 처음이다.]
[곱에 수를 더한다.]
[번에 1을 더한다.]
[번이 수가 아니면 끝은 처음이다.]
[곱을 돌려준다.]
⟧
`;

describe("callable planes", () => {
  it("run in a frame of their own: arguments in, a value back", () => {
    const result = run(program(["결과는 제곱: 7", "결과를 말한다.", "끝이다."], SQUARE));
    expect(result.output).toEqual(["49"]);
    expect(result.outcome.status).toBe("HALT");
  });

  it("pass arguments by value: the callee's parameter is its own noun", () => {
    const appendix = `:바꾼다: (수: Int) → Int ⟦
[수에 100을 더한다.]
[수를 돌려준다.]
⟧
`;
    const result = run(program(["수는 1이다.", "다른것은 바꾼다: 수", "수를 말한다.", "다른것을 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["1", "101"]);
  });

  it("return several values, Go-style, into several nouns", () => {
    const appendix = `:합차: (가: Int, 나: Int) → (Int, Int) ⟦
[합은 가이다.]
[합에 나를 더한다.]
[차는 가이다.]
[차에서 나를 뺀다.]
[합과 차를 돌려준다.]
⟧
`;
    expect(run(program(["합과 차는 합차: 17, 5", "합을 말한다.", "차를 말한다.", "끝이다."], appendix)).output).toEqual(["22", "12"]);
    // Results may be discarded, but not miscounted.
    expect(run(program(["합차: 1, 2", "끝이다."], appendix)).outcome.status).toBe("HALT");
    expect(errors(program(["하나는 합차: 1, 2", "끝이다."], appendix))).toEqual([
      "Y3Y003 [하나는 합차: 1, 2] ':합차:' returns 2 values, not 1",
    ]);
  });

  it("return Unit with 돌아간다; a single receiving noun gets ()", () => {
    const appendix = `:인사: () ⟦
["안녕"을 말한다.]
[돌아간다.]
⟧
`;
    const result = run(program(["빈것은 인사:", "빈것을 말한다.", "인사:", "끝이다."], appendix));
    expect(result.output).toEqual(["안녕", "()", "안녕"]);
  });

  it("recurse: each activation has its own nouns", () => {
    const appendix = `:누적: (수: Int) → Int ⟦
[수가 0이면 0을 돌려준다.]
[작은것은 수이다.]
[작은것에서 1을 뺀다.]
[나머지는 누적: 작은것]
[나머지에 수를 더한다.]
[나머지를 돌려준다.]
⟧
`;
    const result = run(program(["합은 누적: 5", "합을 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["15"]);
    expect(effects(result).filter((e) => e.startsWith("call "))).toEqual([
      "call 누적#1(수 := 5)",
      "call 누적#2(수 := 4)",
      "call 누적#3(수 := 3)",
      "call 누적#4(수 := 2)",
      "call 누적#5(수 := 1)",
      "call 누적#6(수 := 0)",
    ]);
    // Six activations each defined their own 수.
    expect(result.versions.filter((v) => v.noun === "수" && v.index === 0).map((v) => v.frame)).toEqual(["누적#1", "누적#2", "누적#3", "누적#4", "누적#5", "누적#6"]);
  });

  it("are bounded by the step limit, not by a separate depth limit", () => {
    const appendix = `:영원: (수: Int) → Int ⟦
[또는 영원: 수]
[또를 돌려준다.]
⟧
`;
    const result = run(program(["x는 영원: 1", "끝이다."], appendix), {}, 50);
    expect(result.outcome).toMatchObject({ status: "STEP_LIMIT", steps: 50, frame: "영원#50" });
  });
});

describe("frames restore the caller's pose", () => {
  // The callee turns left (facing 동) and climbs no stairs; the caller keeps walking 남.
  const TURNING = `:합차: (가: Int, 나: Int) → (Int, Int) ⟦
[합은 가이다.] [ ] [ ] [ ]
[합에 나를 더한다.] [ ] [ ] [ ]
[왼쪽을 본다.] [차는 가이다.] [차에서 나를 뺀다.] [합과 차를 돌려준다.]
⟧
`;

  it("restores position and full orientation: the call cell is left as if it were any cell", () => {
    const result = run(program(["합과 차는 합차: 17, 5", "합을 말한다.", "차를 말한다.", "끝이다."], TURNING));
    expect(result.output).toEqual(["22", "12"]);
    const back = result.trace.find((e) => e.instruction.op === "return");
    expect(back?.orientation).toEqual({ forward: "east", up: "up" }); // the callee faced 동
    expect(back?.next).toEqual({ position: { x: 0, y: 1, z: 0 }, orientation: { forward: "south", up: "up" } });
  });

  it("restores a pitched, rolled orientation exactly", () => {
    // Caller: pitch up then look right, so forward and up are both off the defaults,
    // then call from a column that runs along that forward.
    const source = `+++
[start]
facing = "동"
up = "남"
+++

⟦
[결과는 제곱: 3] [결과를 말한다.] [끝이다.]
⟧

※

${SQUARE}`;
    const result = run(source);
    expect(result.output).toEqual(["9"]);
    const call = result.trace.find((e) => e.instruction.op === "call");
    const back = result.trace.find((e) => e.instruction.op === "return");
    expect(call?.orientation).toEqual({ forward: "east", up: "south" });
    expect(back?.next.orientation).toEqual({ forward: "east", up: "south" });
    expect(back?.next.position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("keeps each recursive activation's return pose", () => {
    // Each activation turns (동, then 남 again in a second column) before it recurses;
    // the stack of return poses must unwind exactly.
    const turning = `:돈다: (수: Int) → Int ⟦
[수가 0이면 0을 돌려준다.] [ ]
[왼쪽을 본다.] [오른쪽을 본다.]
[ ] [작은것은 수이다.]
[ ] [작은것에서 1을 뺀다.]
[ ] [r은 돈다: 작은것]
[ ] [r에 1을 더한다.]
[ ] [r을 돌려준다.]
⟧
`;
    const result = run(program(["결과는 돈다: 3", "결과를 말한다.", "끝이다."], turning));
    expect(result.output).toEqual(["3"]);
    // Every return lands one cell past the call that made it, facing as that caller did.
    const returns = result.trace.filter((e) => e.instruction.op === "return").map((e) => [e.next.position, e.next.orientation.forward, e.frame]);
    expect(returns).toEqual([
      [{ x: 1, y: 5, z: 0 }, "south", "돈다#4"],
      [{ x: 1, y: 5, z: 0 }, "south", "돈다#3"],
      [{ x: 1, y: 5, z: 0 }, "south", "돈다#2"],
      [{ x: 0, y: 1, z: 0 }, "south", "돈다#1"],
    ]);
  });

  // Property: from every one of the 24 orientations, a call into a callee that turns
  // returns to the cell after the call along the caller's own forward, facing exactly as
  // the caller did. The callee always starts facing 남 and turns to 동 before returning.
  for (const o of ALL_ORIENTATIONS) {
    it(`restores ${orientationLabel(o)} after a callee that turns`, () => {
      const plane = (center: string) => `⟦\n[끝이다.] [끝이다.] [끝이다.]\n[끝이다.] [${center}] [끝이다.]\n[끝이다.] [끝이다.] [끝이다.]\n⟧`;
      const source = `+++
[start]
plane = 1
cell = [1, 1]
facing = "${DIRECTION_NAMES[o.forward]}"
up = "${DIRECTION_NAMES[o.up]}"
+++

${plane("끝이다.")}

    ${plane("돈다:")}

        ${plane("끝이다.")}

※

:돈다: () ⟦
[왼쪽을 본다.] [돌아간다.]
⟧
`;
      const result = run(source);
      expect(result.outcome.status).toBe("HALT");
      const back = result.trace.find((e) => e.instruction.op === "return");
      expect(back?.orientation).toEqual({ forward: "east", up: "up" });
      const v = vectorOf(o.forward);
      expect(back?.next).toEqual({ position: { x: 1 + v.x, y: 1 + v.y, z: 1 + v.z }, orientation: o });
    });
  }

  it("calls are not jumps: a back-edge in a callee cannot reach the caller's anchor", () => {
    const appendix = `:도망: () → Int ⟦
[끝은 처음이다.]
⟧
`;
    const result = run(program(["여기가 처음이다.", "x는 도망:", "끝이다."], appendix));
    expect(result.outcome).toMatchObject({ status: "FAULT", frame: "도망#1" });
  });

  it("a return falling off the caller's plane is VOID in the caller's space", () => {
    const result = run(`⟦\n[x는 제곱: 2]\n⟧\n\n※\n\n${SQUARE}`);
    expect(result.outcome).toMatchObject({ status: "VOID", at: { x: 0, y: 1, z: 0 } });
    expect(result.outcome.frame).toBeUndefined();
  });
});

describe("lexical scope", () => {
  it("a callee cannot see the caller's nouns", () => {
    const appendix = `:엿보기: () → Int ⟦
[비밀을 돌려준다.]
⟧
`;
    expect(errors(program(["비밀은 42이다.", "x는 엿보기:", "끝이다."], appendix))).toEqual([
      "Y3G007 '비밀' is used but never introduced: give it a value ('비밀은 3이다') or declare it ('비밀은 미정이다')",
    ]);
  });

  it("the same name in two bodies is two nouns, with two types", () => {
    const appendix = `:글로: (값: Text) → Text ⟦
[값을 돌려준다.]
⟧
`;
    const { program: compiled } = compile(program(["값은 3이다.", "글은 글로: \"셋\"", "글을 말한다.", "값을 말한다.", "끝이다."], appendix));
    const p = compiled as CompiledProgram;
    expect(p.nouns.map((n) => [n.name, formatType(n.type)])).toEqual([
      ["값", "Int"],
      ["글", "Text"],
    ]);
    expect([...p.procedures.values()][0]?.nouns.map((n) => [n.name, formatType(n.type)])).toEqual([["값", "Text"]]);
  });

  it("a callee's nouns do not survive the call: values are reported for the main volume only", () => {
    const result = run(program(["결과는 제곱: 3", "끝이다."], SQUARE));
    expect([...result.values.keys()]).toEqual(["결과"]);
  });

  it("composition is not a call: a placed plane shares the main body's nouns", () => {
    const source = `⟦
[값은 1이다.]
[위층으로 간다.]
⟧

    ⟦ :위: ⟧

※

:위: ⟦
[ ]
[값을 말한다.]
[끝이다.]
⟧
`;
    expect(run(source).output).toEqual(["1"]);
  });

  it("a match arm's bindings are visible only in that arm", () => {
    expect(errors(program(["o는 Some: 1", "x는 o에 따라: Some(n) → n, None → n", "끝이다."]))).toEqual([
      "Y3G007 'n' is used but never introduced: give it a value ('n은 3이다') or declare it ('n은 미정이다')",
    ]);
  });
});

describe("temporal values through calls", () => {
  const PLUS_ONE = `:하나더: (수: Int) → Int ⟦
[수에 1을 더한다.]
[수를 돌려준다.]
⟧
`;

  it("a symbol passes through a call and is determined after it returns", () => {
    const result = run(program(["값은 미정이다.", "결과는 하나더: 값", "결과를 말한다.", "값은 3이었다.", "끝이다."], PLUS_ONE));
    expect(result.output).toEqual(["4"]);
    expect(effects(result)).toContain("call 하나더#1(수 := α1)");
    expect(effects(result)).toContain("return from 하나더#1: α1 + 1");
    expect(result.symbols).toMatchObject([{ label: "α1", value: "3", mark: "RETRO" }]);
  });

  it("a symbol born in a callee outlives its frame", () => {
    const appendix = `:모름: () → Text ⟦
[y는 미정이다.]
[y를 돌려준다.]
⟧
`;
    const result = run(program(["x는 모름:", "x를 말한다.", 'x는 "날자"였다.', "끝이다."], appendix));
    expect(result.output).toEqual(["날자"]);
    expect(result.symbols).toMatchObject([{ noun: "y", born: 2, value: "날자", mark: "RETRO" }]);
  });

  it("a channel closes through a call: β = 2β is self-caused 0", () => {
    const appendix = `:두배: (n: Int) → Int ⟦
[n에 n을 더한다.]
[n을 돌려준다.]
⟧
`;
    const result = run(program(["수가 다음에서 온다.", "수는 두배: 수", "수를 말한다.", "수를 전으로 보낸다.", "끝이다."], appendix));
    expect(result.output).toEqual(["0"]);
    expect(result.symbols).toMatchObject([{ label: "β1", value: "0", mark: "SELF_CAUSED" }]);
  });

  it("a promise made in a callee with no open cycle falls due when the call returns", () => {
    const appendix = `:약속: () → Int ⟦
[k는 미정이다.]
[k는 5일 것이다.]
[k를 돌려준다.]
⟧
`;
    const result = run(program(["a는 약속:", "a가 5이면 \"다섯\"을 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["다섯"]);
    expect(effects(result)).toContain("promise k = 5  [due end of call 약속#1]");
  });

  it("branching on a symbolic argument inside a callee is UNRESOLVED there", () => {
    const appendix = `:판단: (수: Int) → Int ⟦
[수가 1이면 1을 돌려준다.]
[0을 돌려준다.]
⟧
`;
    const result = run(program(["값은 미정이다.", "x는 판단: 값", "끝이다."], appendix));
    expect(result.outcome).toMatchObject({ status: "UNRESOLVED", frame: "판단#1" });
  });

  it("data values are concrete for now: building one from an open symbol is UNRESOLVED", () => {
    const result = run(program(["값은 미정이다.", "o는 Some: 값", "끝이다."]));
    expect(result.outcome.status).toBe("UNRESOLVED");
    expect(effects(result)).toContain("unresolved: needs α1");
  });
});

describe("records and sums", () => {
  const TYPES = `자료 점 = { 가로: Int, 세로: Int }
자료 모양 = 원(Int) | 사각(Int, Int) | 빈모양
자료 쌍<A, B> = { 첫: A, 둘: B }
`;

  it("build records, read and write fields: a write makes a new value", () => {
    const result = run(program(["위치는 점: 1, 2", "옛위치는 위치이다.", "위치의 가로에 10을 더한다.", "위치를 말한다.", "옛위치를 말한다.", "위치의 세로를 말한다.", "끝이다."], TYPES));
    expect(result.output).toEqual(["점(11, 2)", "점(1, 2)", "2"]);
  });

  it("match sums exhaustively, binding fields", () => {
    const cells = ["도형은 사각: 3, 4", "넓이는 도형에 따라: 원(r) → r, 사각(w, _) → w, 빈모양 → 0", "넓이를 말한다.", "끝이다."];
    expect(run(program(cells, TYPES)).output).toEqual(["3"]);
    expect(errors(program(["도형은 빈모양이다.", "x는 도형에 따라: 원(r) → r", "끝이다."], TYPES))).toEqual([
      "Y3Y005 [x는 도형에 따라: 원(r) → r] this match does not cover 사각(_, _), 빈모양",
    ]);
  });

  it("instantiate generic records", () => {
    const { program: p } = compile(program(['p는 쌍: 1, "하나"', "x는 p의 둘이다.", "x를 말한다.", "끝이다."], TYPES));
    expect(p?.nouns.map((n) => `${n.name}: ${formatType(n.type)}`)).toEqual(["p: 쌍<Int, Text>", "x: Text"]);
  });

  it("refuses wrong fields and field types", () => {
    expect(errors(program(['위치는 점: 1, "둘"', "x는 위치의 높이이다.", "끝이다."], TYPES))).toEqual([
      `Y3Y001 [위치는 점: 1, "둘"] field 2 of '점' must be Int, not Text`,
      "Y3Y006 [x는 위치의 높이이다.] '점' has no field '높이'; it has 가로, 세로",
    ]);
  });

  it("refuses bad declarations and name clashes", () => {
    expect(errors(program(["끝이다."], "자료 점 = { 가로: Int, 가로: Int }\n"))).toEqual([
      "Y3C006 [자료 점 = { 가로: Int, 가로: Int }] field '가로' appears twice",
    ]);
    expect(errors(program(["끝이다."], "자료 가 = { x: 없는타입 }\n"))).toEqual(["Y3C006 [자료 가 = { x: 없는타입 }] unknown type '없는타입'"]);
    expect(errors(program(["끝이다."], "자료 가 = Some(Int)\n"))).toEqual(["Y3C007 constructor 'Some' is already defined"]);
    expect(errors(program(["끝이다."], "자료 Option = { x: Int }\n"))).toEqual(["Y3C007 type 'Option' is already defined"]);
  });

  it("a constructor's name never names a noun", () => {
    expect(errors(program(["None은 3이다.", "끝이다."]))).toEqual(["Y3Y006 [None은 3이다.] 'None' is a constructor and cannot name a value"]);
  });

  it("allows recursive types", () => {
    const list = "자료 목록 = 마디(Int, 목록) | 끝마디\n";
    const result = run(program(["빈것은 끝마디이다.", "하나는 마디: 1, 빈것", "둘은 마디: 2, 하나", "머리는 둘에 따라: 마디(h, _) → h, 끝마디 → 0", "머리를 말한다.", "끝이다."], list));
    expect(result.output).toEqual(["2"]);
  });
});

describe("Option and Result: ordinary errors are values", () => {
  it("are built, returned and matched; there is no null", () => {
    const appendix = `:찾기: (수: Int) → Option<Int> ⟦
[수가 0이면 None을 돌려준다.]
[o는 Some: 수]
[o를 돌려준다.]
⟧
`;
    const result = run(program(["a는 찾기: 0", "b는 찾기: 7", "x는 a에 따라: Some(n) → n, None → -1", "y는 b에 따라: Some(n) → n, None → -1", "x를 말한다.", "y를 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["-1", "7"]);
  });

  it("a Result is matched, never thrown", () => {
    const appendix = `:나눔: (수: Int, 나눌수: Int) → Result<Int, Text> ⟦
[나눌수가 0이면 "0으로 나눌 수 없다"를 말한다.]
[r은 Ok: 수]
[나눌수가 0이면 r은 Err: "0"]
[r을 돌려준다.]
⟧
`;
    const result = run(program(["r은 나눔: 6, 0", 'm은 r에 따라: Ok(n) → "됨", Err(e) → e', "m을 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["0으로 나눌 수 없다", "0"]);
  });
});

describe("arrays and slices", () => {
  it("an array owns its elements; writing one makes a new array", () => {
    const result = run(program(["수들은 배열: 10, 20, 30", "옛것은 수들이다.", "수들의 1번은 99이다.", "수들을 말한다.", "옛것을 말한다.", "끝이다."]));
    expect(result.output).toEqual(["[10, 99, 30]", "[10, 20, 30]"]);
  });

  it("a slice views the array version it was taken from", () => {
    const result = run(
      program(["수들은 배열: 1, 2, 3, 4", "가운데는 배열 자르기: 수들, 1, 3", "수들의 1번은 0이다.", "가운데를 말한다.", "수들을 말한다.", "작은것은 배열 자르기: 가운데, 1, 2", "작은것을 말한다.", "n은 배열 길이: 가운데", "n을 말한다.", "끝이다."]),
    );
    expect(result.output).toEqual(["[2, 3]", "[1, 0, 3, 4]", "[3]", "2"]);
  });

  it("types [T; N] and []T, with element reads by 번", () => {
    const { program: p } = compile(program(["수들은 배열: 1, 2", "s는 배열 자르기: 수들, 0, 1", "i는 1이다.", "x는 수들의 i번이다.", "끝이다."]));
    expect(p?.nouns.map((n) => `${n.name}: ${formatType(n.type)}`)).toEqual(["수들: [Int; 2]", "s: []Int", "i: Int", "x: Int"]);
  });

  it("checks bounds at run time: FAULT, not a wrapped value", () => {
    expect(run(program(["수들은 배열: 1, 2", "x는 수들의 2번이다.", "끝이다."])).outcome).toMatchObject({
      status: "FAULT",
      message: "index 2 is out of range for 2 elements",
    });
    expect(run(program(["수들은 배열: 1, 2", "x는 배열 자르기: 수들, 1, 3", "끝이다."])).outcome).toMatchObject({
      status: "FAULT",
      message: "slice bound 3 is out of range for 2 elements",
    });
  });

  it("refuses a write through a slice, and mixed element types", () => {
    expect(errors(program(["수들은 배열: 1, 2", "s는 배열 자르기: 수들, 0, 1", "s의 0번은 5이다.", "끝이다."]))).toEqual([
      "Y3Y001 [s의 0번은 5이다.] a slice ([]Int) is a view of an array; write the element through the array",
    ]);
    expect(errors(program(['수들은 배열: 1, "둘"', "끝이다."]))).toEqual(['Y3Y001 [수들은 배열: 1, "둘"] every element of an array must be Int, not Text']);
  });

  it("passes arrays to callable planes by value", () => {
    const appendix = `:첫째: (수들: [Int; 3]) → Int ⟦
[수들의 0번은 0이다.]
[x는 수들의 0번이다.]
[x를 돌려준다.]
⟧
`;
    const result = run(program(["수들은 배열: 7, 8, 9", "x는 첫째: 수들", "수들을 말한다.", "x를 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["[7, 8, 9]", "0"]);
  });
});

describe("modules", () => {
  const GEO = `+++
name = "기하"
+++

※

자료 점 = { 가로: Int, 세로: Int }
자료 모양 = 원(Int) | 없는모양

:넓이: (p: 점) → Int ⟦
[x는 p의 가로이다.]
[x에 p의 세로를 더한다.]
[x를 돌려준다.]
⟧
`;
  const importing = (alias: string, cells: string[]) => `+++
[imports]
"${alias}" = "geo.y3"
+++

${program(cells)}`;

  it("are imported by alias: callables, constructors, types and patterns", () => {
    const result = run(
      importing("도형", ["p는 도형 점: 3, 4", "a는 도형 넓이: p", "a를 말한다.", "m은 도형 원: 2", "k는 m에 따라: 도형 원(r) → r, 도형 없는모양 → 0", "k를 말한다.", "끝이다."]),
      { "geo.y3": GEO },
    );
    expect(result.output).toEqual(["7", "2"]);
  });

  it("are namespaces, not planes: an imported type is that module's type", () => {
    const { program: p } = compile(importing("도형", ["p는 도형 점: 3, 4", "끝이다."]), { "geo.y3": GEO });
    expect(p?.nouns.map((n) => formatType(n.type))).toEqual(["기하.점"]);
    expect([...(p?.procedures.keys() ?? [])]).toEqual(["기하.넓이"]);
  });

  it("an alias that looks like a particle phrase still resolves as a namespace", () => {
    // [나이 넓이: p] could be '나(이) is 넓이: p'; the module 나이 exists, so it is a call into it.
    expect(run(importing("나이", ["p는 나이 점: 1, 2", "a는 나이 넓이: p", "a를 말한다.", "끝이다."]), { "geo.y3": GEO }).output).toEqual(["3"]);
  });

  it("refuses missing modules, import cycles and bad aliases", () => {
    expect(errors(importing("도형", ["끝이다."]))).toEqual(["Y3C008 cannot find module 'geo.y3' (imported as '도형')"]);
    const a = `+++\nname = "에이"\n[imports]\n"비" = "b.y3"\n+++\n\n※\n`;
    const b = `+++\nname = "비"\n[imports]\n"에이" = "a.y3"\n+++\n\n※\n`;
    expect(errors(`+++\n[imports]\n"에이" = "a.y3"\n+++\n\n⟦ [끝이다.] ⟧\n`, { "a.y3": a, "b.y3": b })).toEqual([
      "Y3C009 b.y3: 'a.y3' imports this module back: a.y3 → b.y3 → a.y3",
    ]);
    expect(errors(importing("표준", ["끝이다."]), { "geo.y3": GEO })[0]).toMatch(/^Y3C010 '표준' cannot name a module/);
  });

  it("reports an imported module's errors under its path", () => {
    const broken = GEO.replace("[x를 돌려준다.]", '[x는 "글"이다.]');
    expect(errors(importing("도형", ["끝이다."]), { "geo.y3": broken })).toEqual([
      `Y3Y001 geo.y3: [x는 "글"이다.] 'x' holds Int since [x는 p의 가로이다.] (line 11), not Text`,
    ]);
  });
});

describe("static rules for calls", () => {
  it("only a callable plane returns, and only the main volume ends", () => {
    expect(errors(program(["3을 돌려준다.", "끝이다."]))).toEqual([
      "Y3C001 [3을 돌려준다.] only a callable plane returns; the main volume ends with '끝이다'",
    ]);
    expect(errors(program(["x는 끝내기:", "끝이다."], ":끝내기: () ⟦ [끝이다.] ⟧\n"))).toEqual([
      "Y3C002 [끝이다.] '끝이다' ends the program; a callable plane returns with '돌려준다' or '돌아간다'",
    ]);
  });

  it("a callable plane is called, never placed in the volume", () => {
    expect(errors(`⟦ :f: ⟧\n\n※\n\n:f: () ⟦ [돌아간다.] ⟧\n`)).toEqual([
      "Y3V004 ':f:' has a signature: it is a callable plane, run by a call, not a floor of the volume",
    ]);
  });

  it("checks arity and argument types against the signature", () => {
    expect(errors(program(["x는 제곱: 1, 2", 'y는 제곱: "셋"', "끝이다."], SQUARE))).toEqual([
      "Y3Y003 [x는 제곱: 1, 2] ':제곱:' takes 1 argument, not 2",
      `Y3Y001 [y는 제곱: "셋"] argument 1 of ':제곱:' must be Int, not Text`,
    ]);
    expect(errors(program(["끝이다."], ":f: (x: Int) → Int ⟦ [\"글\"을 돌려준다.] ⟧\n"))).toEqual([
      `Y3Y001 ["글"을 돌려준다.] returned value 1 must be Int, not Text`,
    ]);
  });

  it("several targets need a callable plane", () => {
    expect(errors(program(["a와 b는 수학 절댓값: 1", "끝이다."]))).toEqual([
      "Y3C003 [a와 b는 수학 절댓값: 1] only a callable plane returns several values; '수학 절댓값' returns one",
    ]);
  });

  it("refuses malformed signatures and duplicate parameters", () => {
    expect(errors(program(["끝이다."], ":f: (x Int) ⟦ [돌아간다.] ⟧\n"))).toEqual(["Y3C005 :f: (x Int): expected ':' but found 'Int'"]);
    expect(errors(program(["끝이다."], ":f: (x: Int, x: Int) ⟦ [돌아간다.] ⟧\n"))).toEqual(["Y3C005 :f: (x: Int, x: Int): parameter 'x' appears twice"]);
  });
});

describe("surface syntax", () => {
  it("parses paths, matches, returns and multi-target calls", () => {
    expect(parseSentence("위치의 가로는 3이다.").sentence).toMatchObject({ kind: "assign", place: { noun: "위치", steps: [{ kind: "field", name: "가로" }] } });
    expect(parseSentence("x는 수들의 i번이다.").sentence).toMatchObject({ kind: "assign", value: { kind: "index", target: { kind: "noun", name: "수들" }, index: { kind: "noun", name: "i" } } });
    expect(parseSentence("y는 x에 따라: Some(n) → n, None → 0").sentence).toMatchObject({ kind: "match", target: "y" });
    expect(parseSentence("몫과 나머지를 돌려준다.").sentence).toEqual({ kind: "return", values: [{ kind: "noun", name: "몫" }, { kind: "noun", name: "나머지" }] });
    expect(parseSentence("돌아간다.").sentence).toEqual({ kind: "return", values: [] });
    expect(parseSentence("몫과 나머지는 나눗셈: 7, 2").sentence).toMatchObject({ kind: "call", call: { readings: [{ targets: ["몫", "나머지"], callee: ["나눗셈"] }] } });
  });

  it("lints 과/와 like the other particle pairs", () => {
    expect(parseSentence("몫와 나머지를 돌려준다.").issues).toEqual([
      { code: "Y3K001", severity: "warning", message: "non-canonical Korean: write '몫과' instead of '몫와'" },
    ]);
  });

  it("a trace shows call and return as movement between spaces", () => {
    const text = formatProgramTrace(run(program(["결과는 제곱: 1", "끝이다."], SQUARE)));
    expect(text).toContain("1 (0,0,0) 남/위 [결과는 제곱: 1] → 제곱#1(0,0,0) 남/위\n  call 제곱#1(수 := 1)");
    expect(text).toContain("제곱#1(0,6,0) 남/위 [곱을 돌려준다.] → (0,1,0) 남/위\n  return from 제곱#1: 1\n  결과 := 1");
  });
});

describe("adversarial cases", () => {
  it("a callee cannot close the caller's channel: channels belong to a frame's nouns", () => {
    const appendix = `:보내기: (수: Int) ⟦
[수를 전으로 보낸다.]
[돌아간다.]
⟧
`;
    const result = run(program(["수가 다음에서 온다.", "보내기: 수", "끝이다."], appendix));
    expect(result.outcome).toMatchObject({ status: "PARADOX", frame: "보내기#1" });
  });

  it("a channel left open in a callee is reported unanswered when it returns", () => {
    const appendix = `:열기: () → Int ⟦
[b가 다음에서 온다.]
[b를 돌려준다.]
⟧
`;
    const result = run(program(["x는 열기:", "x는 7이었다.", "x를 말한다.", "끝이다."], appendix));
    expect(effects(result)).toContain("channel S1 never answered: β1 has no sender");
    expect(result.output).toEqual(["7"]); // the caller's testimony still settles the symbol
  });

  it("returning from inside a loop closes the loop: its promises fall due first", () => {
    const appendix = `:고리: () → Int ⟦
[k는 미정이다.]
[여기가 처음이다.]
[k는 2일 것이다.]
[k를 돌려준다.]
⟧
`;
    const result = run(program(["x는 고리:", "x를 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["2"]);
    expect(effects(result)).toContain("leave 처음 (0,1,0)");
  });

  it("an open symbol returned and never constrained makes the output AMBIGUOUS", () => {
    const appendix = `:모름: () → Int ⟦
[y는 미정이다.]
[y를 돌려준다.]
⟧
`;
    expect(run(program(["x는 모름:", "x를 말한다.", "끝이다."], appendix)).outcome.status).toBe("AMBIGUOUS");
  });

  it("refuses a noun that would receive two results", () => {
    expect(errors(program(["a와 a는 f: 1", "끝이다."]))).toEqual([
      "Y3G012 [a와 a는 f: 1] 'a' would receive two results; each result needs its own noun",
    ]);
  });

  it("keeps '->' inside a text literal in a match arm", () => {
    expect(run(program(["o는 Some: 1", 'x는 o에 따라: Some(_) -> "a->b", None -> "c"', "x를 말한다.", "끝이다."])).output).toEqual(["a->b"]);
  });

  it("writes through nested places: an element's field, an element of an element", () => {
    const result = run(
      program(["p는 점: 1, 2", "q는 점: 3, 4", "점들은 배열: p, q", "점들의 1번의 가로는 30이다.", "점들을 말한다.", "끝이다."], "자료 점 = { 가로: Int, 세로: Int }\n"),
    );
    expect(result.output).toEqual(["[점(1, 2), 점(30, 4)]"]);
    expect(run(program(["행은 배열: 1, 2", "표는 배열: 행, 행", "표의 0번의 1번은 9이다.", "표를 말한다.", "끝이다."])).output).toEqual(["[[1, 9], [1, 2]]"]);
  });

  it("canonicalises a signature's arrow", () => {
    const loaded = loadDocument(program(["끝이다."], ":f: (x: Int) -> Int ⟦ [x를 돌려준다.] ⟧\n"));
    expect(loaded.ast?.appendix?.definitions[0]?.signature).toBe("(x: Int) -> Int");
    expect(formatDocumentOf(program(["끝이다."], ":f: (x: Int) -> Int ⟦ [x를 돌려준다.] ⟧\n"))).toContain(":f: (x: Int) → Int ⟦");
  });

  it("a plane with no signature cannot be called: composition and calls stay apart", () => {
    expect(errors(program(["x는 바닥:", "끝이다."], ":바닥: ⟦ [ ] ⟧\n"))).toEqual(["Y3Y006 [x는 바닥:] '바닥' is not a callable plane or a constructor here"]);
  });

  it("a module's volume is never run when it is imported", () => {
    const lib = `+++\nname = "라이브러리"\n+++\n\n⟦\n["실행되면 안 된다"를 말한다.]\n[끝이다.]\n⟧\n\n※\n\n:하나: () → Int ⟦ [1을 돌려준다.] ⟧\n`;
    const result = run(`+++\n[imports]\n"라" = "lib.y3"\n+++\n\n${program(["x는 라 하나:", "x를 말한다.", "끝이다."])}`, { "lib.y3": lib });
    expect(result.output).toEqual(["1"]);
  });
});

function formatDocumentOf(source: string): string {
  const loaded = loadDocument(source);
  if (!loaded.ast) throw new Error("expected a document");
  return formatDocument(loaded.ast);
}
