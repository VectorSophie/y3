import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES as CODES, normalizeCellText, withoutSpans } from "../../src/v2";
import { parseError, parseOk } from "./helpers";

describe("document parser: accepted forms", () => {
  it("reads planes in order as z, rows as y and cells as x", () => {
    const ast = parseOk(`⟦
[A] [B]
[C] [D]
⟧

    ⟦
    [E] [F]
    [G] [H]
    ⟧
`);
    expect(ast.volume).toHaveLength(2);
    const [first, second] = ast.volume.map((slot) => slot.plane);
    expect(first?.kind === "inline" && first.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
    expect(second?.kind === "inline" && second.rows[1]?.cells[0]?.text).toBe("G");
  });

  it("ignores indentation and gaps entirely", () => {
    const tidy = parseOk("⟦\n[A] [B]\n⟧\n\n⟦\n[C] [D]\n⟧\n");
    const messy = parseOk("\t\t⟦\n  [A][B]   \n           ⟧\n\n\n ⟦\n[C]        [D]\n⟧");
    expect(withoutSpans(messy)).toEqual(withoutSpans(tidy));
  });

  it("accepts the one-row form", () => {
    const ast = parseOk("⟦ [값은 3이다.] [끝이다.] ⟧\n");
    const plane = ast.volume[0]?.plane;
    expect(plane?.kind === "inline" && plane.rows[0]?.cells.map((cell) => cell.text)).toEqual(["값은 3이다.", "끝이다."]);
  });

  it("treats [ ] and [] as blank cells", () => {
    const ast = parseOk("⟦\n[ ] []\n⟧");
    const plane = ast.volume[0]?.plane;
    expect(plane?.kind === "inline" && plane.rows[0]?.cells.map((cell) => cell.text)).toEqual([null, null]);
  });

  it("reads references and the ※ section", () => {
    const ast = parseOk(`⟦ :바닥: ⟧

※

# the ground floor
:바닥: ⟦
[끝이다.]
⟧
`);
    expect(ast.volume[0]?.plane).toMatchObject({ kind: "ref", name: "바닥" });
    expect(ast.appendix?.definitions.map((definition) => definition.name)).toEqual(["바닥"]);
    expect(ast.appendix?.definitions[0]?.comments.map((comment) => comment.text)).toEqual([" the ground floor"]);
  });

  it("reads front matter verbatim", () => {
    const ast = parseOk('+++\nname = "t"\n\n[limits]\nsteps = 5\n+++\n⟦ [끝이다.] ⟧');
    expect(ast.frontMatter?.text).toBe('name = "t"\n\n[limits]\nsteps = 5');
  });

  it("attaches comments to the following item, and the rest to the end", () => {
    const ast = parseOk("# one\n⟦ [A] ⟧\n# two\n⟦ [B] ⟧\n# end\n");
    expect(ast.volume.map((slot) => slot.comments.map((comment) => comment.text))).toEqual([[" one"], [" two"]]);
    expect(ast.trailingComments.map((comment) => comment.text)).toEqual([" end"]);
  });

  it("keeps brackets and spacing inside quoted text", () => {
    const ast = parseOk('⟦ ["[  ]"를   말한다.] ⟧');
    const plane = ast.volume[0]?.plane;
    expect(plane?.kind === "inline" && plane.rows[0]?.cells[0]?.text).toBe('"[  ]"를 말한다.');
  });

  it("handles CRLF line endings and a byte-order mark", () => {
    const ast = parseOk("﻿⟦\r\n[A]\r\n⟧\r\n");
    expect(ast.volume).toHaveLength(1);
  });

  it("records source positions", () => {
    const ast = parseOk("\n    ⟦\n    [A] [B]\n    ⟧\n");
    const plane = ast.volume[0]?.plane;
    expect(plane?.span.start).toEqual({ line: 2, column: 5 });
    expect(plane?.kind === "inline" && plane.rows[0]?.cells[1]?.span.start).toEqual({ line: 3, column: 9 });
  });
});

describe("document parser: cell text", () => {
  it("collapses whitespace outside quotes and trims", () => {
    expect(normalizeCellText("  값은   3이다.  ")).toBe("값은 3이다.");
    expect(normalizeCellText('"a   b"를\t말한다.')).toBe('"a   b"를 말한다.');
    expect(normalizeCellText('"a \\" b"')).toBe('"a \\" b"');
    expect(normalizeCellText("   ")).toBeNull();
  });
});

describe("document parser: rejected forms", () => {
  const cases: [string, string, string, number][] = [
    ["ragged rows", "⟦\n[A] [B]\n[C]\n⟧", CODES.RAGGED_PLANE, 3],
    ["empty multi-line plane", "⟦\n⟧", CODES.EMPTY_PLANE, 1],
    ["empty one-row plane", "⟦ ⟧", CODES.EMPTY_PLANE, 1],
    ["a blank line where ⟧ was expected", "⟦\n[A]\n", CODES.BLANK_LINE_IN_PLANE, 3],
    ["plane never closed at end of file", "⟦\n[A]", CODES.UNTERMINATED_PLANE, 1],
    ["blank line inside a plane", "⟦\n[A]\n\n[B]\n⟧", CODES.BLANK_LINE_IN_PLANE, 3],
    ["comment inside a plane", "⟦\n[A]\n# no\n⟧", CODES.COMMENT_IN_PLANE, 3],
    ["closing bracket on a row", "⟦\n[A] ⟧", CODES.CLOSE_NOT_ALONE, 2],
    ["text outside a plane", "값은 3이다.", CODES.TEXT_OUTSIDE_PLANE, 1],
    ["no planes at all", "# only a comment\n", CODES.NO_PLANES, 1],
    ["unterminated cell", "⟦\n[값은 3이다.\n⟧", CODES.UNTERMINATED_CELL, 2],
    ["unterminated quote", '⟦ ["열린 따옴표] ⟧', CODES.UNTERMINATED_QUOTE, 1],
    ["bracket inside a cell", "⟦ [a [b] ⟧", CODES.BRACKET_IN_CELL, 1],
    ["something that is not a cell", "⟦\n[A] B\n⟧", CODES.EXPECTED_CELL, 2],
    ["text after a one-row plane", "⟦ [A] ⟧ [B]", CODES.TEXT_AFTER_CLOSE, 1],
    ["malformed reference", "⟦ :a ⟧", CODES.MALFORMED_REFERENCE, 1],
    ["invalid name", "⟦ :1층: ⟧", CODES.INVALID_NAME, 1],
    ["unterminated front matter", "+++\nname = 1\n⟦ [A] ⟧", CODES.UNTERMINATED_FRONT_MATTER, 1],
    ["※ before any plane", "※\n:a: ⟦ [A] ⟧", CODES.APPENDIX_BEFORE_PLANES, 1],
    ["a second ※", "⟦ [A] ⟧\n※\n※", CODES.SECOND_APPENDIX, 3],
    ["unnamed plane in ※", "⟦ [A] ⟧\n※\n⟦ [B] ⟧", CODES.UNNAMED_DEFINITION, 3],
    ["named plane that is a reference", "⟦ :a: ⟧\n※\n:a: ⟦ :b: ⟧", CODES.DEFINITION_IS_REFERENCE, 3],
    ["stray text in ※", "⟦ [A] ⟧\n※\nhello", CODES.TEXT_OUTSIDE_PLANE, 3],
  ];

  for (const [label, source, code, line] of cases) {
    it(`rejects ${label}`, () => {
      const error = parseError(source);
      expect(error.code).toBe(code);
      expect(error.line).toBe(line);
    });
  }
});
