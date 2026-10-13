import { describe, expect, it } from "vitest";
import { EditorServices, modelViolations, ProgramModel, RenameError, type CellId, type DocumentId, type PlaneId } from "../../src/editor";

// M10 semantic services (docs/v2-lsp-services.md): every answer comes from the compiler's
// resolution of names, never from searching text.

const SOURCE = `⟦
[값은 1이다.]
[합은 두배: 값]
[o는 Some: 값]
[v는 o에 따라: Some(값) → 값, None → 0]
["값을 말한다"를 말한다.]
[값을 말한다.]
[합을 말한다.]
[끝이다.]
⟧

※

자료 점 = { 가로: i64, 세로: i64 }

:두배: (값: i64) → i64 ⟦
[결과는 값이다.]
[결과에 값을 더한다.]
[결과를 돌려준다.]
⟧
`;

function setup(text = SOURCE) {
  const model = new ProgramModel({ nonce: "s" });
  const doc = model.open({ text, path: "main.y3" });
  const services = new EditorServices(model);
  const floor = model.getDocument(doc).floors[0] as PlaneId;
  const callable = model.getDocument(doc).planes.find((p) => model.getPlane(p).kind === "callable") as PlaneId;
  const at = (x: number, y: number, plane = floor) => model.cellAt(plane, x, y) as CellId;
  // A source position inside a cell, at the first occurrence of `word` in its text.
  const pos = (cell: CellId, word: string, nth = 0) => {
    const span = model.sourceSpanOf(cell);
    const line = model.getDocument(doc).text.split("\n")[(span?.start.line as number) - 1] as string;
    let i = (span?.start.column as number) - 1;
    for (let k = 0; k <= nth; k += 1) i = line.indexOf(word, i + (k ? 1 : 0));
    return { line: span?.start.line as number, column: i + 1 };
  };
  return { model, doc, services, floor, callable, at, pos };
}

describe("definition and references", () => {
  it("a noun's references are the cells of its body that mean it: not a string, not a pattern binding, not another body's noun", () => {
    const { services, doc, at, pos, callable } = setup();
    const p = pos(at(0, 5), "값");
    const sym = services.symbolAt(doc, p.line, p.column);
    expect(sym).toMatchObject({ kind: "noun", name: "값", body: "main" });
    const refs = services.references(sym as never).map((l) => l.cell);
    expect(refs).toEqual([at(0, 0), at(0, 1), at(0, 2), at(0, 5)]);
    expect(refs).not.toContain(at(0, 4)); // only inside a string
    expect(refs).not.toContain(at(0, 3)); // 값 there is bound by the pattern Some(값)
    expect(refs.some((c) => c !== undefined && [at(0, 0, callable), at(0, 1, callable)].includes(c))).toBe(false);
    expect(services.definition(sym as never)).toMatchObject({ cell: at(0, 0) });
  });

  it("go to definition by HIR NodeId: a noun, a callable plane, a constructor's type", () => {
    const { model, services, at, callable } = setup();
    const call = model.hirNodesForCell(at(0, 1));
    const callNode = call.find((n) => n.kind === "CallPlane");
    expect(services.definitionOf(callNode?.id as never)).toMatchObject({ plane: callable });
    const load = call.find((n) => n.kind === "LoadNoun");
    expect(services.definitionOf(load?.id as never)).toMatchObject({ cell: at(0, 0) });
    expect(services.referencesOf(callNode?.id as never).map((l) => l.cell)).toEqual([at(0, 1)]);
  });

  it("references of a callable plane are its call sites, from its HIR, not text", () => {
    const { services, callable, at } = setup();
    expect(services.references({ kind: "plane", plane: callable, name: "두배" }).map((l) => l.cell)).toEqual([at(0, 1)]);
  });
});

describe("rename", () => {
  it("renames a noun in its body only, re-choosing particles, leaving strings, patterns and other bodies alone", () => {
    const { model, doc, services, at, pos, callable } = setup();
    const p = pos(at(0, 0), "값");
    services.rename(services.symbolAt(doc, p.line, p.column) as never, "수");
    expect(model.getCell(at(0, 0)).sentence).toBe("수는 1이다.");
    expect(model.getCell(at(0, 1)).sentence).toBe("합은 두배: 수");
    expect(model.getCell(at(0, 5)).sentence).toBe("수를 말한다.");
    expect(model.getCell(at(0, 4)).sentence).toBe('"값을 말한다"를 말한다.');
    expect(model.getCell(at(0, 3)).sentence).toBe("v는 o에 따라: Some(값) → 값, None → 0");
    expect(model.getCell(at(0, 0, callable)).sentence).toBe("결과는 값이다.");
    expect(model.run(doc).result.output).toEqual(["값을 말한다", "1", "2"]);
    expect(modelViolations(model)).toEqual([]);
    // One transaction: one undo.
    model.undo();
    expect(model.getCell(at(0, 0)).sentence).toBe("값은 1이다.");
  });

  it("renames a parameter in the callable plane's body and signature", () => {
    const { model, doc, services, at, pos, callable } = setup();
    const p = pos(at(0, 0, callable), "값");
    services.rename(services.symbolAt(doc, p.line, p.column) as never, "수");
    expect(model.getPlane(callable).signature).toBe("(수: i64) → i64");
    expect(model.getCell(at(0, 1, callable)).sentence).toBe("결과에 수를 더한다.");
    expect(model.getCell(at(0, 0)).sentence).toBe("값은 1이다.");
    expect(model.run(doc).result.output).toEqual(["값을 말한다", "1", "2"]);
  });

  it("refuses a rename to a name already taken, and leaves the model unchanged", () => {
    const { model, doc, services, at, pos } = setup();
    const before = model.getDocument(doc).text;
    const p = pos(at(0, 0), "값");
    expect(() => services.rename(services.symbolAt(doc, p.line, p.column) as never, "합")).toThrow(RenameError);
    expect(model.getDocument(doc).text).toBe(before);
  });

  it("refuses a rename that a pattern binding would capture", () => {
    const text = SOURCE.replace("[v는 o에 따라: Some(값) → 값, None → 0]", "[v는 o에 따라: Some(n) → 값, None → 0]");
    const { model, doc, services, at, pos } = setup(text);
    const p = pos(at(0, 0), "값");
    expect(() => services.rename(services.symbolAt(doc, p.line, p.column) as never, "n")).toThrow(/capture/);
    expect(model.getCell(at(0, 0)).sentence).toBe("값은 1이다.");
  });

  it("renames a callable plane and its call sites; the PlaneId stays", () => {
    const { model, doc, services, callable, at } = setup();
    services.rename({ kind: "plane", plane: callable, name: "두배" }, "곱하기둘");
    expect(model.getPlane(callable).name).toBe("곱하기둘");
    expect(model.getCell(at(0, 1)).sentence).toBe("합은 곱하기둘: 값");
    expect(model.run(doc).result.output).toEqual(["값을 말한다", "1", "2"]);
  });

  it("renames a type in declarations and signatures", () => {
    const text = SOURCE.replace(":두배: (값: i64) → i64", ":두배: (값: i64) → i64").replace("자료 점 = { 가로: i64, 세로: i64 }", "자료 점 = { 가로: i64, 세로: i64 }\n자료 선 = { 시작: 점, 끝: 점 }");
    const { model, doc, services } = setup(text);
    services.rename({ kind: "type", document: doc, name: "점" }, "위치");
    expect(model.getDocument(doc).text).toContain("자료 위치 = { 가로: i64, 세로: i64 }");
    expect(model.getDocument(doc).text).toContain("자료 선 = { 시작: 위치, 끝: 위치 }");
    expect(model.diagnostics(doc).filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("hover, completion and semantic tokens", () => {
  it("hover: noun types and temporal roles, plane signatures, built-ins", () => {
    const text = SOURCE.replace("[합을 말한다.]", "[t는 미정이다.]").replace("[끝이다.]", "[t는 3이었다.]\n[끝이다.]");
    const { services, doc, at, pos } = setup(text);
    const t = pos(at(0, 6), "t");
    expect(services.hover(doc, t.line, t.column)).toMatch(/^t: (i64|bigint|\{integer\}|.*) — temporal unknown \(미정\), stated in the past/);
    const v = pos(at(0, 0), "값");
    expect(services.hover(doc, v.line, v.column)).toBe("값: i64");
    const call = pos(at(0, 1), "두배");
    expect(services.hover(doc, call.line, call.column)).toMatch(/^:두배: \(값: i64\) → i64 — callable plane/);
    const some = pos(at(0, 2), "Some");
    expect(services.hover(doc, some.line, some.column)).toMatch(/Some — variant of Option/);
  });

  it("completion offers what is visible: nouns of the body, callables, namespaces, then a namespace's names", () => {
    const { services, doc, model, at } = setup();
    const span = model.sourceSpanOf(at(0, 0));
    const all = services.completion(doc, span?.start.line as number, (span?.start.column as number) + 1);
    expect(all.filter((i) => i.kind === "noun").map((i) => i.label)).toEqual(expect.arrayContaining(["값", "합", "o", "v"]));
    expect(all.filter((i) => i.kind === "noun").map((i) => i.label)).not.toContain("결과");
    expect(all.some((i) => i.kind === "callable" && i.label === "두배")).toBe(true);
    expect(all.some((i) => i.kind === "module" && i.label === "표준")).toBe(true);
    const text = model.getDocument(doc).text;
    // Half-typed text is not a sentence: typing is a raw text edit, which keeps the cell.
    model.setText(doc, text.replace("[값은 1이다.]", "[값은 표준 줄]"));
    expect(model.getCell(at(0, 0)).sentence).toBe("값은 표준 줄");
    const s2 = model.sourceSpanOf(at(0, 0));
    const line = model.getDocument(doc).text.split("\n")[(s2?.start.line as number) - 1] as string;
    const col = line.indexOf("표준 줄") + "표준 줄".length + 1;
    expect(services.completion(doc, s2?.start.line as number, col).map((i) => i.label)).toEqual(expect.arrayContaining(["줄읽기", "줄출력"]));
    void text;
  });

  it("semantic tokens classify words by resolution, with no colors", () => {
    const { services, doc, model, at } = setup(`# 주석\n${SOURCE.replace('["값을 말한다"를 말한다.]', '["값 # 아님"을 말한다.]')}`);
    const tokens = services.semanticTokens(doc);
    const textOf = (t: { line: number; column: number; length: number }) => (model.getDocument(doc).text.split("\n")[t.line - 1] as string).slice(t.column - 1, t.column - 1 + t.length);
    const kinds = new Map(tokens.map((t) => [`${textOf(t)}@${t.line}`, t.type]));
    const line = (cell: CellId) => model.sourceSpanOf(cell)?.start.line as number;
    expect(kinds.get(`값은@${line(at(0, 0))}`)).toBe("noun");
    expect(kinds.get(`두배@${line(at(0, 1))}`)).toBe("plane");
    expect(kinds.get(`Some@${line(at(0, 2))}`)).toBe("variant");
    expect(kinds.get(`"값 # 아님"@${line(at(0, 4))}`)).toBe("literal");
    expect(kinds.get(`말한다@${line(at(0, 5))}`)).toBe("keyword");
    // One comment line; a '#' inside a string is part of the literal.
    expect(tokens.filter((t) => t.type === "comment").map(textOf)).toEqual(["# 주석"]);
    expect(tokens.every((t) => ["keyword", "type", "module", "plane", "callable", "noun", "field", "variant", "literal", "comment", "temporal"].includes(t.type))).toBe(true);
  });
});

describe("several documents", () => {
  const LIB = `+++\nname = "기하"\n+++\n\n※\n\n:넓이: (가로: i64, 세로: i64) → i64 ⟦\n[r은 가로이다.]\n[r에 세로를 곱한다.]\n[r을 돌려준다.]\n⟧\n`;
  const MAIN = `+++\n[imports]\n"기" = "lib/geo.y3"\n+++\n⟦\n[a는 기 넓이: 3, 4]\n[a를 말한다.]\n[끝이다.]\n⟧\n`;

  it("imports resolve to open documents, by module id; an alias change does not change the module", () => {
    const model = new ProgramModel({ nonce: "m" });
    const lib = model.open({ text: LIB, path: "lib/geo.y3" });
    const main = model.open({ text: MAIN, path: "main.y3" });
    const m = model.getModule(model.moduleOfDocument(main));
    expect(m.imports).toEqual([{ alias: "기", spec: "lib/geo.y3", module: model.moduleOfDocument(lib) }]);
    expect(model.run(main).result.output).toEqual(["12"]);
    model.setText(main, model.getDocument(main).text.replace('"기"', '"도형"').replace("기 넓이", "도형 넓이"));
    expect(model.getModule(model.moduleOfDocument(main)).imports[0]?.module).toBe(model.moduleOfDocument(lib));
    expect(modelViolations(model)).toEqual([]);
  });

  it("renaming a callable plane follows its calls into importing documents", () => {
    const model = new ProgramModel({ nonce: "m" });
    const lib = model.open({ text: LIB, path: "lib/geo.y3" });
    const main = model.open({ text: MAIN, path: "main.y3" });
    const services = new EditorServices(model);
    const plane = model.getDocument(lib).planes[0] as PlaneId;
    expect(services.references({ kind: "plane", plane, name: "넓이" }).map((l) => l.document)).toEqual([main]);
    services.rename({ kind: "plane", plane, name: "넓이" }, "면적");
    expect(model.getDocument(main).text).toContain("[a는 기 면적: 3, 4]");
    expect(model.run(main as DocumentId).result.output).toEqual(["12"]);
  });
});

describe("rename checks errors by owner, not by count", () => {
  it("a rename that fixes one error but makes another is refused", () => {
    const text = "⟦\n[위치는 3이다.]\n[끝이다.]\n⟧\n\n※\n\n자료 점 = { 가로: i64 }\n\n:함수: (p: 위치) → i64 ⟦\n[r은 1이다.]\n[r을 돌려준다.]\n⟧\n";
    const model = new ProgramModel({ nonce: "o" });
    const doc = model.open({ text });
    const services = new EditorServices(model);
    const errors = () => model.diagnostics(doc).filter((d) => d.severity === "error").map((d) => `${d.code} ${d.cell ? "cell" : d.plane ? "plane" : "-"}`);
    expect(errors()).toHaveLength(1); // the signature's unknown type
    expect(() => services.rename({ kind: "type", document: doc, name: "점" }, "위치")).toThrow(RenameError);
    expect(model.getDocument(doc).text).toBe(text);
    expect(errors()).toHaveLength(1);
  });
});
