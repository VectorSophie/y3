import { describe, expect, it } from "vitest";
import { createInitialState, parseProgram, runProgram, type Program } from "../../src/v1/core";

describe("runtime", () => {
  it("supports push/add/sub/pop and output stack", () => {
    const source = `@layer 0
값은 7이다
값은 2이다
값을 더한다
값은 3이다
값을 뺀다
값은 999이다
값을 버린다
출력은 값이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("6");
  });

  it("supports conditional true branch", () => {
    const source = `@layer 0
값은 1이다
조건이면 위로
아니다 아래로

@layer 1
값은 99이다
출력은 "T"이다

@layer -1
값은 99이다
출력은 "F"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("T");
  });

  it("supports conditional false + else pair", () => {
    const source = `@layer 0
값은 0이다
조건이면 위로
아니다 아래로

@layer 1
값은 99이다
출력은 "T"이다

@layer -1
값은 99이다
값은 99이다
출력은 "F"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("F");
  });

  it("supports output char", () => {
    const source = `@layer 0
출력은 "Z"이다`;
    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("Z");
  });

  it("halts on undefined coordinate", () => {
    const source = `@layer 0
값은 1이다
조건이면 위로
출력은 "A"이다

@layer 1
출력은 "B"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.halted).toBe(true);
    expect(finalState.output).toBe("");
    expect(finalState.stepCount).toBe(2);
  });

  it("halts on bounds exit", () => {
    const source = `@layer 0
출력은 "A"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.halted).toBe(true);
    expect(finalState.output).toBe("A");
    expect(finalState.stepCount).toBe(1);
  });

  it("halts at step limit", () => {
    const program: Program = {
      cells: new Map([
        [
          "0,0,0",
          {
            x: 0,
            y: 0,
            z: 0,
            instruction: { type: "NOOP" },
            raw: "NOOP",
            sourceLine: 1,
          },
        ],
      ]),
      layerMetadata: new Map([[0, null]]),
      bounds: {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        minZ: 0,
        maxZ: 0,
      },
    };

    const initial = createInitialState();
    initial.dx = 0;
    initial.dy = 0;
    initial.dz = 0;

    const finalState = runProgram(program, initial);
    expect(finalState.halted).toBe(true);
    expect(finalState.stepCount).toBe(10000);
  });

  it("supports input instruction via initial input queue", () => {
    const source = `@layer 0
입력은 값이다
출력은 값이다`;

    const state = createInitialState({ input: [42] });
    const finalState = runProgram(parseProgram(source), state);
    expect(finalState.output).toBe("42");
  });

  it("supports relative rotation and portal jump", () => {
    const source = `@layer 0
방향을 오른쪽으로 회전한다
이동은 (0,2,0)로
출력은 "R"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("R");
  });

  it("supports sparse memory operations", () => {
    const source = `@layer 0
칸 값을 하나 늘린다
칸 값을 하나 늘린다
칸을 오른쪽으로 이동한다
칸 값을 하나 늘린다
칸 값을 가져온다
출력은 값이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("1");
  });

  it("supports memory zero-conditional branch", () => {
    const source = `@layer 0
칸 값이 0이면 위로
아니다 아래로

@layer 1
출력은 "Z"이다

@layer -1
출력은 "N"이다`;

    const finalState = runProgram(parseProgram(source));
    expect(finalState.output).toBe("Z");
  });

  it("supports custom max step option", () => {
    const program: Program = {
      cells: new Map([
        [
          "0,0,0",
          {
            x: 0,
            y: 0,
            z: 0,
            instruction: { type: "NOOP" },
            raw: "NOOP",
            sourceLine: 1,
          },
        ],
      ]),
      layerMetadata: new Map([[0, null]]),
      bounds: {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        minZ: 0,
        maxZ: 0,
      },
    };

    const initial = createInitialState();
    initial.dx = 0;
    initial.dy = 0;
    initial.dz = 0;

    const finalState = runProgram(program, initial, { maxSteps: 12 });
    expect(finalState.stepCount).toBe(12);
  });
});
