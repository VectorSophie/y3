import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgram, describeEffect, hasErrors, loadDocument, runProgram, SENTENCE_CODES, type ProgramResult } from "../../src/v2";

function compile(source: string) {
  const loaded = loadDocument(source);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) {
    throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
  }
  return { compiled: compileProgram(loaded.ast, loaded.space), manifest: loaded.manifest };
}

function run(...cells: string[]): ProgramResult {
  const { compiled, manifest } = compile(`⟦\n${cells.map((cell) => `[${cell}]`).join("\n")}\n⟧\n`);
  if (!compiled.program) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
  return runProgram(compiled.program, manifest);
}

const effects = (result: ProgramResult) => result.trace.flatMap((entry) => entry.effects.map(describeEffect));

describe("introducing names is temporal-aware", () => {
  it("accepts a name with no present-tense writer when it is declared 미정", () => {
    const { compiled } = compile("⟦\n[값은 미정이다.]\n[값을 말한다.]\n[값은 4였다.]\n[끝이다.]\n⟧");
    expect(compiled.diagnostics).toEqual([]);
    const { compiled: program, manifest } = compile("⟦\n[값은 미정이다.]\n[값을 말한다.]\n[값은 4였다.]\n[끝이다.]\n⟧");
    if (!program.program) throw new Error("expected a program");
    expect(runProgram(program.program, manifest).output).toEqual(["4"]);
  });

  it("still rejects a name that is only ever constrained, never introduced", () => {
    const { compiled } = compile("⟦\n[값은 4였다.]\n[끝이다.]\n⟧");
    expect(compiled.diagnostics.map((d) => d.code)).toEqual([SENTENCE_CODES.NEVER_INTRODUCED]);
    expect(compiled.diagnostics[0]?.message).toMatch(/미정/);
  });
});

describe("linear equalities", () => {
  it("x + 1 = 4 → x = 3, filled in retroactively", () => {
    const result = run("값은 미정이다.", "원래는 값이다.", "값에 1을 더한다.", "원래를 말한다.", "값은 4였다.", "끝이다.");
    expect(result.output).toEqual(["3"]);
    expect(result.outcome.status).toBe("HALT");
    expect(effects(result)).toContain("retro α1 = 3  [born t1; fills t2, t3, t4]");
  });

  it("calls a resolution plain, not retroactive, when nothing used the symbol yet", () => {
    const result = run("값은 미정이다.", "값은 7이었다.", "값을 말한다.", "끝이다.");
    expect(effects(result)).toContain("resolved α1 = 7");
    expect(result.symbols[0]?.mark).toBeNull();
    expect(result.trace[2]?.effects.map(describeEffect)).toEqual(['out "7"']); // concrete by the time it is read
  });

  it("solves two unknowns from two equations", () => {
    const result = run(
      "가는 미정이다.",
      "나는 미정이다.",
      "합은 가이다.",
      "합에 나를 더한다.",
      "차는 가이다.",
      "차에서 나를 뺀다.",
      "가를 말한다.",
      "나를 말한다.",
      "합은 5였다.",
      "차는 1이었다.",
      "끝이다.",
    );
    expect(result.output).toEqual(["3", "2"]);
    expect(result.outcome.status).toBe("HALT");
    expect(result.symbols.map((s) => [s.label, s.value, s.state])).toEqual([
      ["α1", "3", "resolved"],
      ["α2", "2", "resolved"],
    ]);
  });

  it("leaves several solutions open: AMBIGUOUS", () => {
    const result = run("가는 미정이다.", "나는 미정이다.", "합은 가이다.", "합에 나를 더한다.", "가를 말한다.", "합은 5였다.", "끝이다.");
    expect(result.outcome).toMatchObject({ status: "AMBIGUOUS" });
    expect(result.output).toEqual(["?"]);
    expect(result.symbols.map((s) => s.state)).toEqual(["constrained", "constrained"]);
  });

  it("finds no integer solution: PARADOX", () => {
    const result = run("값은 미정이다.", "값에 값을 더한다.", "값은 3이었다.", "끝이다.");
    expect(result.outcome).toMatchObject({ status: "PARADOX", steps: 3 });
    expect(effects(result)).toContain("contradiction: 2·α1 = 3 has no integer solution");
  });

  it("contradicts a concrete past: PARADOX", () => {
    const result = run("값은 1이다.", "값은 2였다.", "끝이다.");
    expect(result.outcome).toMatchObject({ status: "PARADOX", steps: 2 });
  });

  it("is harmless when a past statement agrees with what happened", () => {
    expect(run("값은 1이다.", "값은 1이었다.", "끝이다.").outcome.status).toBe("HALT");
  });

  it("does not care about unknowns that never reach the output", () => {
    expect(run("값은 미정이다.", "끝이다.").outcome.status).toBe("HALT");
  });
});

describe("text unknowns", () => {
  it("resolve by unification", () => {
    const result = run("이름은 미정이다.", "이름을 말한다.", '이름은 "이상"이었다.', "끝이다.");
    expect(result.output).toEqual(["이상"]);
  });

  it("cannot be both a number and text: the type checker refuses it before the run (M5)", () => {
    const { compiled } = compile('⟦\n[값은 미정이다.]\n[값에 1을 더한다.]\n[값은 "하나"였다.]\n[끝이다.]\n⟧');
    expect(compiled.program).toBeNull();
    expect(compiled.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["Y3Y001", '[값은 "하나"였다.] \'값\' holds Int since [값에 1을 더한다.] (line 3), not Text'],
    ]);
  });
});

describe("promises (일 것이다)", () => {
  it("bind the end of the run, after later writes", () => {
    const result = run("값은 미정이다.", "값은 4일 것이다.", "원래는 값이다.", "값에 1을 더한다.", "원래를 말한다.", "끝이다.");
    expect(result.output).toEqual(["3"]);
    expect(effects(result)).toContain("constraint α1 + 1 = 4  [promised at t2]");
  });

  it("are checked at the end of each loop iteration", () => {
    const loop = (decrement: number) =>
      run(
        "값은 3이다.",
        "여기가 처음이다.",
        "이전은 값이다.",
        "이전에서 1을 뺀다.",
        "값은 이전일 것이다.",
        `값에서 ${decrement}${decrement === 1 ? "을" : "를"} 뺀다.`,
        "값이 0이 아니면 끝은 처음이다.",
        "끝이다.",
      );
    const kept = loop(1);
    expect(kept.outcome.status).toBe("HALT");
    expect(effects(kept).filter((e) => e.startsWith("constraint"))).toEqual([
      "constraint 2 = 2  [promised at t5]",
      "constraint 1 = 1  [promised at t11]",
      "constraint 0 = 0  [promised at t17]",
    ]);
    const broken = loop(2);
    expect(broken.outcome).toMatchObject({ status: "PARADOX", steps: 7 }); // the first back-edge ends iteration 1
    expect(effects(broken)).toContain("contradiction: 1 ≠ 2");
  });
});

describe("the solver never chooses control flow", () => {
  it("stops at a condition on an undetermined symbol: UNRESOLVED", () => {
    const result = run("값은 미정이다.", "값이 3이면 끝이다.", "값은 3이었다.", "끝이다.");
    expect(result.outcome).toMatchObject({ status: "UNRESOLVED", steps: 2 });
    expect(effects(result)).toContain("unresolved: needs α1");
  });

  it("does not reason symbolically even about α = α", () => {
    expect(run("값은 미정이다.", "원래는 값이다.", "값이 원래이면 끝이다.", "끝이다.").outcome.status).toBe("UNRESOLVED");
  });

  it("branches normally once the past has been determined", () => {
    const result = run("값은 미정이다.", "값은 3이었다.", "값이 3이면 \"셋\"을 말한다.", "끝이다.");
    expect(result.output).toEqual(["셋"]);
    expect(result.outcome.status).toBe("HALT");
  });
});

describe("layering", () => {
  it("keeps the temporal layer free of the runtime, the language and the machine", () => {
    const dir = join(__dirname, "..", "..", "src", "temporal");
    for (const file of readdirSync(dir)) {
      const imports = [...readFileSync(join(dir, file), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const path of imports) {
        expect(path === "../semantics/values" || path.startsWith("./"), `${file} imports ${path}`).toBe(true);
      }
    }
  });

  it("keeps ConcreteValue concrete: plain data, never a symbol or a term", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "semantics", "values.ts"), "utf8");
    const declaration = source.match(/^export type ConcreteValue =[\s\S]*?;$/m)?.[0] ?? "";
    expect([...declaration.matchAll(/kind: "(\w+)"/g)].map((m) => m[1])).toEqual(["int", "text", "bool", "unit", "data"]);
  });
});
