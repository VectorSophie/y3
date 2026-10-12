import { describe, expect, it } from "vitest";
import {
  formatDocument,
  MAIN_PATH,
  MANIFEST_PATH,
  packDocument,
  unpackDocument,
  Y3DocumentError,
  type FileMap,
} from "../../src/v2";
import { fixtures, parseOk, readRepoFile } from "./helpers";

describe("pack / unpack", () => {
  it("lays out the folder form", () => {
    const files = unpackDocument(readRepoFile("examples/v2/stairwell-named.y3"));
    expect([...files.keys()].sort()).toEqual([MANIFEST_PATH, "planes/detour.y2", MAIN_PATH].sort());
    expect(files.get(MANIFEST_PATH)).toBe('name = "stairwell"\n');
    expect(files.get(MAIN_PATH)).toContain("    ⟦ :detour: ⟧");
    expect(files.get("planes/detour.y2")).toBe('⟦\n[ ]\n[ ]\n[ ]\n["둘"을 말한다.]\n[아래층으로 간다.]\n⟧\n');
  });

  it("keeps signatures and type declarations through fmt and pack/unpack (M6)", () => {
    const source = `⟦
[결과는 제곱: 3]
[끝이다.]
⟧

※

자료 점 = { 가로: Int, 세로: Int }

# squares a number
:제곱:   (수: Int)   →  Int ⟦
[수를 돌려준다.]
⟧

:바닥: ⟦ [ ] ⟧
`;
    const ast = parseOk(source);
    expect(ast.appendix?.declarations.map((d) => [d.name, d.text])).toEqual([["점", "자료 점 = { 가로: Int, 세로: Int }"]]);
    expect(ast.appendix?.definitions.map((d) => [d.name, d.signature])).toEqual([
      ["제곱", "(수: Int) → Int"],
      ["바닥", null],
    ]);
    const formatted = formatDocument(ast);
    expect(formatted).toContain("※\n\n자료 점 = { 가로: Int, 세로: Int }\n\n:바닥: ⟦");
    expect(formatted).toContain("\n\n# squares a number\n:제곱: (수: Int) → Int ⟦\n[수를 돌려준다.]\n⟧\n");
    expect(formatDocument(parseOk(formatted))).toBe(formatted);
    const files = unpackDocument(source);
    expect(files.get("planes/제곱.y2")).toBe("# squares a number\n(수: Int) → Int ⟦\n[수를 돌려준다.]\n⟧\n");
    expect(files.get(MAIN_PATH)).toContain("자료 점 = { 가로: Int, 세로: Int }");
    expect(packDocument(files)).toBe(formatted);
  });

  it("accepts a library module: a ※ section and no volume (M6)", () => {
    const source = "※\n\n자료 쌍 = { 첫: Int, 둘: Int }\n\n:하나더: (수: Int) → Int ⟦ [수를 돌려준다.] ⟧\n";
    const ast = parseOk(source);
    expect(ast.volume).toEqual([]);
    const formatted = formatDocument(ast);
    expect(formatted).toBe("※\n\n자료 쌍 = { 첫: Int, 둘: Int }\n\n:하나더: (수: Int) → Int ⟦\n[수를 돌려준다.]\n⟧\n");
    expect(packDocument(unpackDocument(source))).toBe(formatted);
    expect(formatDocument(parseOk("※\n"))).toBe("※\n");
    expect(packDocument(unpackDocument("※\n"))).toBe("※\n");
  });

  it("keeps inline planes inline in main.y3s", () => {
    const files = unpackDocument(readRepoFile("examples/v2/stairwell.y3"));
    expect([...files.keys()].sort()).toEqual([MANIFEST_PATH, MAIN_PATH].sort());
  });

  for (const { path, source } of fixtures()) {
    it(`${path}: pack(unpack(s)) = format(s)`, () => {
      const packed = packDocument(unpackDocument(source));
      expect(packed).toBe(formatDocument(parseOk(source)));
    });
  }

  it("converges with fmt on the canonical order and keeps every comment", () => {
    const source = `⟦ :b: ⟧

⟦ :a: ⟧

# before the section
※

:z: ⟦
[Z]
⟧

# about a
:a: ⟦
[A]
⟧

:b: ⟦
[B]
⟧

# the end
`;
    const packed = packDocument(unpackDocument(source));
    expect(packed).toBe(formatDocument(parseOk(source)));
    expect(formatDocument(parseOk(packed))).toBe(packed);
    const ast = parseOk(packed);
    expect(ast.appendix?.definitions.map((definition) => definition.name)).toEqual(["b", "a", "z"]);
    expect(ast.appendix?.comments.map((comment) => comment.text)).toEqual([" before the section"]);
    expect(ast.appendix?.definitions[1]?.comments.map((comment) => comment.text)).toEqual([" about a"]);
    expect(ast.trailingComments.map((comment) => comment.text)).toEqual([" the end"]);
  });

  const rejects = (files: FileMap, code: string) => {
    try {
      packDocument(files);
    } catch (error) {
      expect(error).toBeInstanceOf(Y3DocumentError);
      expect((error as Y3DocumentError).diagnostics[0]?.code).toBe(code);
      return;
    }
    throw new Error("expected pack to fail");
  };

  it("rejects malformed folders", () => {
    rejects(new Map([["planes/a.y2", "⟦ [A] ⟧\n"]]), "Y3P002");
    rejects(new Map([[MAIN_PATH, "⟦ [A] ⟧\n"], ["notes.txt", "hi"]]), "Y3P001");
    rejects(new Map([[MAIN_PATH, "⟦ [A] ⟧\n"], ["planes/a.y2", "⟦ [A] ⟧\n⟦ [B] ⟧\n"]]), "Y3P003");
    rejects(new Map([[MAIN_PATH, "⟦ [A] ⟧\n"], ["planes/a.y2", "⟦ :b: ⟧\n"]]), "Y3P003");
    rejects(new Map([[MAIN_PATH, "+++\nx = 1\n+++\n⟦ [A] ⟧\n"]]), "Y3P004");
  });

  it("refuses names that collide on case-insensitive file systems", () => {
    expect(() => unpackDocument("⟦ :a: ⟧\n⟦ :A: ⟧\n※\n:a: ⟦ [x] ⟧\n:A: ⟦ [y] ⟧\n")).toThrow(/case-insensitive/);
  });
});
