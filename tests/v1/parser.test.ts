import { describe, expect, it } from "vitest";
import { Y3ParseError, parseProgram } from "../../src/v1/core";

describe("parser", () => {
  it("parses layers and computes coordinates one-line-one-cell", () => {
    const source = `@layer 0
값은 5이다
값은 3이다

@layer 1
출력은 "A"이다`;

    const program = parseProgram(source);
    expect(program.cells.size).toBe(3);

    const first = program.cells.get("0,0,0");
    const second = program.cells.get("0,1,0");
    const third = program.cells.get("0,0,1");

    expect(first?.raw).toBe("값은 5이다");
    expect(second?.raw).toBe("값은 3이다");
    expect(third?.raw).toBe('출력은 "A"이다');
    expect(program.bounds).toEqual({
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 1,
      minZ: 0,
      maxZ: 1,
    });
  });

  it("rejects invalid sentence", () => {
    const source = `@layer 0
값은 다섯이다`;

    expect(() => parseProgram(source)).toThrowError(Y3ParseError);
    expect(() => parseProgram(source)).toThrowError(/unknown sentence|malformed number/);
  });

  it("rejects instruction before first layer", () => {
    const source = `값은 1이다`;
    expect(() => parseProgram(source)).toThrowError(/instruction before first @layer/);
  });

  it("rejects misplaced else", () => {
    const source = `@layer 0
아니다 위로`;

    expect(() => parseProgram(source)).toThrowError(/misplaced 아니다/);
  });

  it("parses semantic layer labels and strict macros", () => {
    const source = `@macro PUSH_ONE=값은 1이다
@layer 0 [control]
@use PUSH_ONE
출력은 값이다`;

    const program = parseProgram(source);
    expect(program.layerMetadata.get(0)).toBe("control");
    expect(program.cells.get("0,0,0")?.raw).toBe("값은 1이다");
    expect(program.cells.get("0,1,0")?.raw).toBe("출력은 값이다");
  });

  it("rejects unknown macro reference", () => {
    const source = `@layer 0
@use UNKNOWN`;

    expect(() => parseProgram(source)).toThrowError(/unknown macro/);
  });

  it("parses v1 spatial and memory instructions", () => {
    const source = `@layer 0
입력은 값이다
방향을 오른쪽으로 회전한다
이동은 (0,0,0)로
칸 값을 하나 늘린다
칸 값이 0이면 위로`;

    const program = parseProgram(source);
    expect(program.cells.size).toBe(5);
  });
});
