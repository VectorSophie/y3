import { describe, expect, it } from "vitest";
import { canonicalCell, canonicalDeclaration, canonicalSignature, formatDocument, parseDocument, parseSentence, PROJECTIONS } from "../../src/v2";
import { compileSource, observable, runHir } from "./compile-helpers";
import { ORIENTATIONS, prng, randomCallee, randomGrid, renderProgram } from "./program-generator";

// fmt is canonical and never changes meaning: fmt(fmt(x)) = fmt(x), and the formatted
// program is the same program.

const fmt = (source: string) => {
  const parsed = parseDocument(source);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
  return formatDocument(parsed.ast);
};
const sentences = (source: string) => {
  const parsed = parseDocument(source);
  if (!parsed.ok) throw new Error("parse");
  return JSON.stringify(
    parsed.ast.volume.map((s) => (s.plane.kind === "inline" ? s.plane.rows.map((r) => r.cells.map((c) => (c.text === null ? null : parseSentence(c.text).sentence))) : s.plane.name)),
    (_, v) => (typeof v === "bigint" ? `${v}n` : v),
  );
};
const shape = (source: string) => {
  const parsed = parseDocument(source);
  if (!parsed.ok) throw new Error("parse");
  return parsed.ast.volume.map((s) => (s.plane.kind === "inline" ? s.plane.rows.map((r) => r.cells.map((c) => c.text === null)) : s.plane.name));
};

// Writes a cell the long way round: leading zeros, loose spacing, '->'.
function noisy(cell: string | null, r: ReturnType<typeof prng>): string | null {
  if (cell === null) return null;
  return cell
    .replace(/(?<![\d.])(\d+)(?=이다|을|를|보다|이면|이었다|일 )/gu, (d) => (r.next() < 0.5 ? `00${d}` : d))
    .replace(/: /g, () => (r.next() < 0.5 ? ":" : ":   "))
    .replace(/, /g, () => (r.next() < 0.5 ? "," : " ,  "));
}

describe("fmt is canonical and preserves meaning (property)", () => {
  it("on 300 seeded random programs written untidily", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const r = prng(seed * 31337);
      const opts = { temporal: seed % 2 === 0, calls: seed % 3 === 0 };
      const grid = randomGrid(r, { floors: 2, width: 3, height: 3 }, opts).map((f) => f.map((row) => row.map((c) => noisy(c, r))));
      const source = renderProgram(grid, opts.calls ? randomCallee(r) : null, r.pick(ORIENTATIONS));
      const once = fmt(source);
      expect(fmt(once), `seed ${seed}`).toBe(once);
      expect(sentences(once), `seed ${seed}`).toBe(sentences(source));
      expect(shape(once), `seed ${seed}: blank stays blank, VOID stays VOID`).toEqual(shape(source));
      for (const projection of PROJECTIONS) expect(fmt(formatDocument(parseDocument(once).ast!, { projection })), `seed ${seed} ${projection}`).toBe(once);
      const a = compileSource(source);
      const b = compileSource(once);
      expect(b === null, `seed ${seed}`).toBe(a === null);
      if (a && b) expect(observable(runHir(b, 60)).trace.length).toBe(observable(runHir(a, 60)).trace.length);
    }
  });

  it("canonicalises call arguments, named fields, match arms and numeric literals", () => {
    expect(canonicalCell("위치는 점:가로 = 3 ,세로=4")).toBe("위치는 점: 가로=3, 세로=4");
    expect(canonicalCell("y는 x에 따라:Some(n)->n,None -> 0")).toBe("y는 x에 따라: Some(n) → n, None → 0");
    expect(canonicalCell("x는 007이다.")).toBe("x는 7이다.");
    expect(canonicalCell("x는 1.50f32이다.")).toBe("x는 1.5f32이다.");
    expect(canonicalCell("x는 -0.0이다.")).toBe("x는 -0.0이다.");
    expect(canonicalCell('s는 "007, 1.50"이다.')).toBe('s는 "007, 1.50"이다.'); // text is never touched
    expect(canonicalCell("이건 문장이 아니다")).toBe("이건 문장이 아니다"); // kept when it does not parse
  });

  it("canonicalises declarations and signatures, and keeps what it cannot parse", () => {
    expect(canonicalDeclaration("자료  점={가로:i64,세로 : i64}")).toBe("자료 점 = { 가로: i64, 세로: i64 }");
    expect(canonicalDeclaration("자료 모양<T>=원(T)|빈것")).toBe("자료 모양<T> = 원(T) | 빈것");
    expect(canonicalDeclaration("자료 = 깨짐")).toBe("자료 = 깨짐");
    expect(canonicalSignature("(x:i64,y : []i64)->(i64,bool)")).toBe("(x: i64, y: []i64) → (i64, bool)");
    expect(canonicalSignature("() -> ()")).toBe("()");
    const doc = "⟦ [x는 둘배: 2] ⟧\n※\n자료  점={가로:i64}\n:둘배: (x:i64)->i64 ⟦ [x를 돌려준다.] ⟧\n";
    expect(fmt(doc)).toBe("⟦\n[x는 둘배: 2]\n⟧\n\n※\n\n자료 점 = { 가로: i64 }\n\n:둘배: (x: i64) → i64 ⟦\n[x를 돌려준다.]\n⟧\n");
  });
});
