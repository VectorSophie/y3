import { describe, expect, it } from "vitest";
import { Y3ParseError, parseProgram } from "../src/core";

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
});
