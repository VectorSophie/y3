import { describe, expect, it } from "vitest";
import { compileProgram, describeEffect, hasErrors, loadDocument, runProgram, type ProgramResult } from "../../src/v2";

function run(...cells: string[]): ProgramResult {
  const loaded = loadDocument(`⟦\n${cells.map((cell) => `[${cell}]`).join("\n")}\n⟧\n`);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) {
    throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
  }
  const compiled = compileProgram(loaded.ast, loaded.space);
  if (!compiled.program) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
  return runProgram(compiled.program, loaded.manifest);
}

const effects = (result: ProgramResult) => result.trace.flatMap((entry) => entry.effects.map(describeEffect));
const marks = (result: ProgramResult) => result.symbols.map((s) => [s.label, s.value, s.mark, s.loop]);

describe("channels", () => {
  it("close the most recent open slot for the name first", () => {
    const result = run(
      "수가 다음에서 온다.", // S1: β1
      "첫째는 수이다.",
      "수가 다음에서 온다.", // S2: β2
      "둘째는 수이다.",
      "수는 7이다.",
      "수를 전으로 보낸다.", // closes S2: β2 = 7
      "수는 3이다.",
      "수를 전으로 보낸다.", // closes S1: β1 = 3
      "첫째를 말한다.",
      "둘째를 말한다.",
      "끝이다.",
    );
    expect(result.output).toEqual(["3", "7"]);
    expect(effects(result).filter((e) => e.startsWith("constraint"))).toEqual(["constraint β2 = 7  [channel S2]", "constraint β1 = 3  [channel S1]"]);
  });

  it("carry a value caused by a literal: that is retroactive, not self-caused", () => {
    const result = run("수가 다음에서 온다.", "수를 말한다.", "수는 4이다.", "수를 전으로 보낸다.", "끝이다.");
    expect(result.output).toEqual(["4"]);
    expect(marks(result)).toEqual([["β1", "4", "RETRO", null]]);
  });

  it("recognise a loop through other names, as long as no literal enters it", () => {
    const result = run("수가 다음에서 온다.", "다른은 수이다.", "다른에 수를 더한다.", "수는 다른이다.", "수를 말한다.", "수를 전으로 보낸다.", "끝이다.");
    expect(result.output).toEqual(["0"]); // β = 2β
    expect(marks(result)).toEqual([["β1", "0", "SELF_CAUSED", "channel S1"]]);
  });

  it("judge cause on the normal form: x + 0 and x - 0 are x, so β = β + 0 is β = β", () => {
    for (const neutral of [["수에 0을 더한다."], ["수에서 0을 뺀다."], ["수에 3을 더한다.", "수에서 3을 뺀다."]]) {
      const result = run("수가 다음에서 온다.", ...neutral, "수를 말한다.", "수를 전으로 보낸다.", "끝이다.");
      expect(result.outcome.status).toBe("AMBIGUOUS"); // pins nothing …
      expect(marks(result)).toEqual([["β1", null, null, "channel S1"]]); // … but closes on itself
    }
  });

  it("count a value that came from a zero-valued name as neutral, and a non-zero one as a cause", () => {
    const zero = run("영은 0이다.", "수가 다음에서 온다.", "수에 수를 더한다.", "수에 영을 더한다.", "수를 말한다.", "수를 전으로 보낸다.", "끝이다.");
    expect(marks(zero)).toEqual([["β1", "0", "SELF_CAUSED", "channel S1"]]);
    const one = run("수가 다음에서 온다.", "수에 수를 더한다.", "수에 1을 더한다.", "수를 말한다.", "수를 전으로 보낸다.", "끝이다.");
    expect(one.output).toEqual(["-1"]); // β = 2β + 1: unique, but the literal 1 caused it
    expect(marks(one)).toEqual([["β1", "-1", "RETRO", null]]);
  });

  it("never let an open self-loop decide a branch", () => {
    const result = run("수가 다음에서 온다.", "수를 전으로 보낸다.", "수가 0이면 끝이다.", "끝이다.");
    expect(result.outcome.status).toBe("UNRESOLVED");
  });
});

describe("time anchors", () => {
  it("끝의 N can close on itself: β = β stays open, ε = 2ε is self-caused", () => {
    const open = run("수는 끝의 수이다.", "수를 말한다.", "끝이다.");
    expect(open.outcome.status).toBe("AMBIGUOUS");
    expect(open.symbols[0]?.loop).toBe("끝의 수");

    const zero = run("수는 끝의 수이다.", "수에 수를 더한다.", "수를 말한다.", "끝이다.");
    expect(zero.output).toEqual(["0"]);
    expect(marks(zero)).toEqual([["ε1", "0", "SELF_CAUSED", "끝의 수"]]);
    expect(effects(zero)).toContain("self-caused ε1 = 0  [via 끝의 수; closed on itself, no external cause]");
  });

  it("처음의 N is the start of the current iteration, renewed each time round", () => {
    const result = run(
      "수는 1이다.",
      "여기가 처음이다.",
      "처음의 수를 말한다.",
      "수에 수를 더한다.",
      "수가 8이 아니면 끝은 처음이다.",
      "끝이다.",
    );
    expect(result.output).toEqual(["1", "2", "4"]);
  });

  it("끝의 N inside a loop closes at the end of that iteration", () => {
    const result = run(
      "수는 1이다.",
      "여기가 처음이다.",
      "다음값은 끝의 수이다.",
      "다음값을 말한다.",
      "수에 1을 더한다.",
      "수가 3이 아니면 끝은 처음이다.",
      "끝이다.",
    );
    expect(result.output).toEqual(["2", "3"]);
    expect(effects(result).filter((e) => e.startsWith("constraint"))).toEqual([
      "constraint ε1 = 2  [끝의 수 from t3]",
      "constraint ε2 = 3  [끝의 수 from t8]",
    ]);
  });

  it("need an open iteration for 처음", () => {
    expect(run("수는 1이다.", "처음의 수를 말한다.", "끝이다.").outcome).toMatchObject({ status: "FAULT" });
    expect(run("수는 1이다.", "처음은 끝이었다.", "끝이다.").outcome).toMatchObject({ status: "FAULT" });
  });
});

describe("fixed points (처음은 끝이었다)", () => {
  it("solve x = f(x) once, symbolically", () => {
    const result = run("수는 미정이다.", "여기가 처음이다.", "수에 수를 더한다.", "수에서 3을 뺀다.", "처음은 끝이었다.", "수를 말한다.", "끝이다.");
    expect(result.output).toEqual(["3"]);
  });

  it("are self-caused when they close on their own origin: α = 2α", () => {
    const result = run("수는 미정이다.", "여기가 처음이다.", "수에 수를 더한다.", "처음은 끝이었다.", "수를 말한다.", "끝이다.");
    expect(result.output).toEqual(["0"]);
    expect(marks(result)).toEqual([["α1", "0", "SELF_CAUSED", "fixed point at t4"]]);
    expect(effects(result)).toContain("self-caused α1 = 0  [via fixed point at t4; closed on itself, no external cause]");
  });

  it("stay open when they close on an identity, α = α (even through + 0)", () => {
    const result = run("수는 미정이다.", "여기가 처음이다.", "수에 0을 더한다.", "처음은 끝이었다.", "수를 말한다.", "끝이다.");
    expect(result.outcome.status).toBe("AMBIGUOUS");
    expect(marks(result)).toEqual([["α1", null, null, "fixed point at t4"]]);
  });

  it("are caused, not self-caused, when a literal enters the loop: α = 2α - 3", () => {
    const result = run("수는 미정이다.", "여기가 처음이다.", "수에 수를 더한다.", "수에서 3을 뺀다.", "처음은 끝이었다.", "수를 말한다.", "끝이다.");
    expect(marks(result)).toEqual([["α1", "3", "RETRO", null]]);
  });

  it("are caused when the start itself carries a cause: α + 1 doubled", () => {
    const result = run("수는 미정이다.", "수에 1을 더한다.", "여기가 처음이다.", "수에 수를 더한다.", "처음은 끝이었다.", "수를 말한다.", "끝이다.");
    expect(result.output).toEqual(["0"]); // α + 1 = 2α + 2, so α = -1
    expect(marks(result)).toEqual([["α1", "-1", "RETRO", null]]);
  });

  it("check an invariant when the start is known", () => {
    expect(run("수는 3이다.", "여기가 처음이다.", "수에 수를 더한다.", "수에서 3을 뺀다.", "처음은 끝이었다.", "끝이다.").outcome.status).toBe("HALT");
    expect(run("수는 5이다.", "여기가 처음이다.", "수에 수를 더한다.", "수에서 3을 뺀다.", "처음은 끝이었다.", "끝이다.").outcome.status).toBe("PARADOX");
  });

  it("cover every name the iteration writes, so a loop counter breaks the invariant", () => {
    const result = run(
      "수는 3이다.",
      "번은 2이다.",
      "여기가 처음이다.",
      "수에 수를 더한다.",
      "수에서 3을 뺀다.",
      "처음은 끝이었다.",
      "번에서 1을 뺀다.",
      "번이 0이 아니면 끝은 처음이다.",
      "끝이다.",
    );
    expect(result.outcome.status).toBe("PARADOX");
    expect(effects(result)).toContain("constraint 2 = 1  [처음은 끝이었다 at t6]");
  });

  it("leave names introduced during the iteration out of the comparison", () => {
    const result = run("수는 3이다.", "여기가 처음이다.", "새것은 9이다.", "처음은 끝이었다.", "끝이다.");
    expect(result.outcome.status).toBe("HALT");
  });

  it("are not loops: replacing the relation with the back-edge runs forever", () => {
    const loop = run("수는 3이다.", "여기가 처음이다.", "수에 수를 더한다.", "수에서 3을 뺀다.", "끝은 처음이다.");
    expect(loop.outcome.status).toBe("STEP_LIMIT");
  });
});
