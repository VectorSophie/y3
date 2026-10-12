import { describe, expect, it } from "vitest";
import { EditError, modelViolations, ProgramModel, type CellId, type DocumentId, type PlaneId } from "../../src/editor";
import { compileProgram, loadDocument, semanticKey } from "../../src/v2";

// M10: the editor model (docs/v2-editor-model.md). Identity, structural edits,
// transactions, undo/redo, source maps and the links to HIR, MIR and traces.

const SOURCE = `+++
name = "예"
+++

# the main floor
⟦
[x는 1이다.]   [ ]
[x를 말한다.]  [y는 x이다.]
[끝이다.]      [ ]
⟧

※

자료 점 = { 가로: i64, 세로: i64 }

:두배: (n: i64) → i64 ⟦
[m은 n이다.]
[m에 n을 더한다.]
[m을 돌려준다.]
⟧
`;

function open(text = SOURCE) {
  const model = new ProgramModel({ nonce: "t" });
  const doc = model.open({ text, path: "main.y3" });
  const floor = model.getDocument(doc).floors[0] as PlaneId;
  const at = (x: number, y: number, plane = floor) => model.cellAt(plane, x, y) as CellId;
  const ok = () => expect(modelViolations(model)).toEqual([]);
  ok();
  return { model, doc, floor, at, ok };
}

// Everything identity-relevant about a model, as data.
function snapshot(model: ProgramModel) {
  return model.documents().map((d) => {
    const doc = model.getDocument(d);
    return { doc, planes: doc.planes.map((p) => ({ plane: model.getPlane(p), cells: model.getPlane(p).cells.flat().map((c) => model.getCell(c)) })) };
  });
}

describe("identities", () => {
  it("every authored cell has a CellId, blank ones included; VOID has none", () => {
    const { model, at, floor } = open();
    const blank = model.getCell(at(1, 0));
    expect(blank).toMatchObject({ blank: true, sentence: null, node: null });
    expect(model.getCell(at(0, 0))).toMatchObject({ blank: false, sentence: "x는 1이다." });
    expect(model.cellAt(floor, 2, 0)).toBeNull();
    expect(model.cellAt(floor, 0, 3)).toBeNull();
    expect(model.spaceCellAt(model.documents()[0] as DocumentId, 0, 0, 1)).toBeNull();
  });

  it("ids are distinct kinds and never coordinates, names or offsets", () => {
    const { model, doc, at } = open();
    const view = model.getDocument(doc);
    const cell = at(0, 0);
    expect(new Set([view.id, view.module, view.floors[0], cell, model.getCell(cell).node]).size).toBe(5);
    for (const id of [view.id, view.module, cell]) expect(id).not.toMatch(/\d+,\d+|main|두배|^\d+$/);
  });

  it("the module id is not the document id, the manifest name or an alias", () => {
    const { model, doc } = open();
    const m = model.getModule(model.moduleOfDocument(doc));
    expect(m.name).toBe("예");
    expect(m.id).not.toBe(doc);
    model.setText(doc, model.getDocument(doc).text.replace('name = "예"', 'name = "다른이름"'));
    expect(model.moduleOfDocument(doc)).toBe(m.id);
    expect(model.getModule(m.id).name).toBe("다른이름");
  });
});

describe("structural edits", () => {
  it("MoveCell keeps the CellId; an occupied destination is refused, never overwritten", () => {
    const { model, at, floor, ok } = open();
    const x = at(0, 0);
    const blank = at(1, 0);
    expect(() => model.apply({ kind: "MoveCell", cell: x, plane: floor, x: 1, y: 0 })).toThrow(/occupied: a move never overwrites/);
    expect(model.getCell(blank).blank).toBe(true);
    // Into VOID, with the hole filled in the same transaction: a rectangle again.
    const r = model.apply([
      { kind: "MoveCell", cell: x, plane: floor, x: 2, y: 0 },
      { kind: "InsertCell", plane: floor, x: 0, y: 0, sentence: null },
      { kind: "InsertCell", plane: floor, x: 2, y: 1, sentence: null },
      { kind: "InsertCell", plane: floor, x: 2, y: 2, sentence: null },
    ]);
    expect(model.getCell(x)).toMatchObject({ x: 2, y: 0, sentence: "x는 1이다." });
    expect(r.created).toHaveLength(3);
    ok();
  });

  it("SwapCells exchanges two cells (the explicit form of moving onto a blank), across planes too", () => {
    const { model, at, ok } = open();
    const plane = model.getDocument(model.documents()[0] as DocumentId).planes.find((p) => model.getPlane(p).kind === "callable") as PlaneId;
    const a = at(0, 0);
    const b = model.cellAt(plane, 0, 0) as CellId;
    model.apply({ kind: "SwapCells", a, b });
    expect(model.getCell(a)).toMatchObject({ plane, x: 0, y: 0 });
    expect(model.getCell(b).plane).not.toBe(plane);
    ok();
  });

  it("a move that would leave a hole is refused, and the model is unchanged", () => {
    const { model, at, floor } = open();
    const before = model.revision;
    const text = model.getDocument(model.documents()[0] as DocumentId).text;
    expect(() => model.apply({ kind: "MoveCell", cell: at(0, 1), plane: floor, x: 3, y: 3 })).toThrow(/hole/);
    expect(model.revision).toBe(before);
    expect(model.getDocument(model.documents()[0] as DocumentId).text).toBe(text);
    expect(model.getCell(at(0, 1)).sentence).toBe("x를 말한다.");
  });

  it("MakeBlank keeps the cell; DeleteCell and MakeVoid remove geometry; MakeVoid needs a blank", () => {
    const { model, at, floor, ok } = open();
    const say = at(0, 1);
    model.apply({ kind: "MakeBlank", cell: say });
    expect(model.getCell(say)).toMatchObject({ blank: true, node: null });
    expect(() => model.apply({ kind: "MakeVoid", cell: at(0, 0) })).toThrow(/only a blank cell becomes VOID/);
    // A whole column becomes VOID: the plane narrows.
    model.apply([
      { kind: "MakeVoid", cell: at(1, 0) },
      { kind: "DeleteCell", cell: at(1, 1) },
      { kind: "MakeVoid", cell: at(1, 2) },
    ]);
    expect(model.getPlane(floor).width).toBe(1);
    expect(model.cellAt(floor, 1, 0)).toBeNull();
    ok();
  });

  it("delete, then undo, restores the very same CellId", () => {
    const { model, floor, at, ok } = open();
    const row = [at(0, 2), at(1, 2)];
    model.apply({ kind: "DeleteRow", plane: floor, y: 2 });
    expect(row.map((c) => model.hasCell(c))).toEqual([false, false]);
    model.undo();
    expect(row.map((c) => model.hasCell(c))).toEqual([true, true]);
    expect(at(0, 2)).toBe(row[0]);
    ok();
  });

  it("EditSentence keeps the cell and gives the statement a new NodeId; the same sentence keeps it", () => {
    const { model, at } = open();
    const cell = at(0, 0);
    const node = model.getCell(cell).node;
    model.apply({ kind: "EditSentence", cell, sentence: "x는   1이다." });
    expect(model.getCell(cell).node).toBe(node);
    model.apply({ kind: "EditSentence", cell, sentence: "x는 2이다." });
    expect(model.getCell(cell).id).toBe(cell);
    expect(model.getCell(cell).node).not.toBe(node);
    expect(model.hirNodesForCell(cell).map((n) => n.id)).toEqual([model.getCell(cell).node, `${model.getCell(cell).node}/0`]);
  });

  it("CopyCell makes a new cell; inlining a named plane makes copies, so no id is in two places", () => {
    const text = SOURCE.replace("# the main floor\n⟦\n[x는 1이다.]   [ ]\n[x를 말한다.]  [y는 x이다.]\n[끝이다.]      [ ]\n⟧", "⟦ :바닥: ⟧\n\n⟦ :바닥: ⟧").replace("※\n", "※\n\n:바닥: ⟦\n[x는 1이다.] [위층으로 간다.]\n[끝이다.] [ ]\n⟧\n");
    const { model, doc, ok } = open(text);
    const named = model.getDocument(doc).floors[0] as PlaneId;
    expect(model.getDocument(doc).floors[1]).toBe(named);
    const original = model.getPlane(named).cells.flat();
    expect(model.getCell(original[0] as CellId).floors).toEqual([0, 1]);
    const r = model.apply({ kind: "InlineNamedPlane", document: doc, z: 0 });
    const inline = model.getDocument(doc).floors[0] as PlaneId;
    expect(inline).not.toBe(named);
    expect(model.getPlane(inline).cells.flat().some((c) => original.includes(c))).toBe(false);
    expect(r.created).toContain(inline);
    expect(model.getPlane(named).floors).toEqual([1]); // still placed on floor 1: kept
    ok();
  });

  it("ExtractNamedPlane keeps the PlaneId and every CellId; RenamePlane keeps it and its placements follow", () => {
    const { model, doc, floor, ok } = open();
    const cells = model.getPlane(floor).cells.flat();
    model.apply({ kind: "ExtractNamedPlane", document: doc, z: 0, name: "본층" });
    expect(model.getPlane(floor)).toMatchObject({ kind: "named", name: "본층", floors: [0] });
    expect(model.getPlane(floor).cells.flat()).toEqual(cells);
    expect(model.getDocument(doc).text).toContain("⟦ :본층: ⟧");
    model.apply({ kind: "RenamePlane", plane: floor, name: "새층" });
    expect(model.getPlane(floor).name).toBe("새층");
    expect(model.getDocument(doc).text).toContain("⟦ :새층: ⟧");
    expect(() => model.apply({ kind: "RenamePlane", plane: floor, name: "두배" })).toThrow(/already exists/);
    ok();
  });

  it("plane moves keep ids; a placed named plane or a called callable plane cannot be deleted", () => {
    const { model, doc, floor, ok } = open();
    const r = model.apply({ kind: "InsertPlane", document: doc, z: 0, width: 2, height: 1 });
    const fresh = r.created[0] as PlaneId;
    expect(model.getDocument(doc).floors).toEqual([fresh, floor]);
    model.apply({ kind: "MovePlane", plane: fresh, z: 1 });
    expect(model.getDocument(doc).floors).toEqual([floor, fresh]);
    const callable = model.getDocument(doc).planes.find((p) => model.getPlane(p).kind === "callable") as PlaneId;
    model.apply({ kind: "EditSentence", cell: model.cellAt(floor, 1, 0) as CellId, sentence: "z는 두배: 3" });
    expect(() => model.apply({ kind: "DeletePlane", plane: callable })).toThrow(/still called from 1 cell/);
    model.apply({ kind: "ExtractNamedPlane", document: doc, z: 1, name: "빈층" });
    expect(() => model.apply({ kind: "DeletePlane", plane: fresh })).toThrow(/is placed on floor 1/);
    model.apply({ kind: "MoveLayer", document: doc, from: 1, to: 0 });
    ok();
  });
});

describe("transactions and history", () => {
  it("a transaction applies completely or not at all", () => {
    const { model, at, floor } = open();
    const before = snapshot(model);
    expect(() =>
      model.apply([
        { kind: "EditSentence", cell: at(0, 0), sentence: "x는 5이다." },
        { kind: "MoveCell", cell: at(0, 1), plane: floor, x: 1, y: 1 }, // occupied
      ]),
    ).toThrow(EditError);
    expect(snapshot(model)).toEqual(before);
  });

  it("undo restores the exact prior model; redo the exact later one", () => {
    const { model, at, floor } = open();
    const s0 = snapshot(model);
    model.apply({ kind: "SwapCells", a: at(0, 0), b: at(1, 0) });
    model.apply({ kind: "InsertRow", plane: floor, y: 1 });
    const s2 = snapshot(model);
    expect(model.undo()).toBe(true);
    expect(model.undo()).toBe(true);
    expect(snapshot(model)).toEqual(s0);
    expect(model.redo()).toBe(true);
    expect(model.redo()).toBe(true);
    expect(snapshot(model)).toEqual(s2);
    expect(model.redo()).toBe(false);
  });

  it("a new edit after undo discards the redo branch, and never reuses ids", () => {
    const { model, floor } = open();
    const first = model.apply({ kind: "InsertRow", plane: floor, y: 0 });
    model.undo();
    const second = model.apply({ kind: "InsertRow", plane: floor, y: 0 });
    expect(model.canRedo).toBe(false);
    expect(second.created.some((c) => first.created.includes(c))).toBe(false);
    expect(second.revision).not.toBe(first.revision);
  });
});

describe("source mapping", () => {
  it("every cell maps to its span and back, by position and by offset", () => {
    const { model, doc } = open();
    const text = model.getDocument(doc).text;
    for (const p of model.getDocument(doc).planes) {
      for (const cell of model.getPlane(p).cells.flat()) {
        const span = model.sourceSpanOf(cell);
        expect(span).not.toBeNull();
        const line = text.split("\n")[(span?.start.line as number) - 1] as string;
        expect(line.slice((span?.start.column as number) - 1).startsWith("[")).toBe(true);
        expect(model.cellAtSourcePosition(doc, span?.start.line as number, (span?.start.column as number) + 1)).toBe(cell);
        const offset = text.split("\n").slice(0, (span?.start.line as number) - 1).join("\n").length + 1 + (span?.start.column as number);
        expect(model.cellAtSourceOffset(doc, offset)).toBe(cell);
      }
    }
  });

  it("comments, declarations, manifests and plane heads are elements, not cells", () => {
    const { model, doc } = open();
    const lines = model.getDocument(doc).text.split("\n");
    const lineOf = (s: string) => lines.findIndex((l) => l.startsWith(s)) + 1;
    expect(model.elementAt(doc, lineOf("# the main"), 1)?.kind).toBe("comment");
    expect(model.elementAt(doc, lineOf("자료"), 1)?.kind).toBe("declaration");
    expect(model.elementAt(doc, lineOf("name"), 1)?.kind).toBe("manifest");
    expect(model.elementAt(doc, lineOf(":두배:"), 1)).toMatchObject({ kind: "plane" });
  });

  it("after a move, the source map follows the cell, not the coordinates", () => {
    const { model, at } = open();
    const a = at(0, 0);
    const b = at(1, 0);
    const spanA = model.sourceSpanOf(a);
    model.apply({ kind: "SwapCells", a, b });
    expect(model.sourceSpanOf(b)?.start).toEqual(spanA?.start); // alignment may change the end
    expect(model.cellAtSourcePosition(model.documents()[0] as DocumentId, spanA?.start.line as number, (spanA?.start.column as number) + 1)).toBe(b);
  });
});

describe("HIR, MIR and trace links", () => {
  it("every HIR statement, MIR instruction and trace entry carries the cell that produced it", () => {
    const { model, doc, at, ok } = open();
    const say = at(0, 1);
    expect(model.hirNodesForCell(say)[0]).toMatchObject({ kind: "Eval", cell: say, id: model.getCell(say).node });
    const mir = model.mirInstructionsForCell(say);
    expect(mir.length).toBeGreaterThan(0);
    for (const i of mir) expect(model.instruction(doc, i.id)).toMatchObject({ cell: say, node: model.getCell(say).node });
    const run = model.run(doc);
    expect(run.result.output).toEqual(["1"]);
    const events = model.traceEventsForCell(run, say);
    expect(events.stale).toBe(false);
    expect(events.events.map((e) => `${e.kind}:${"type" in e ? e.type : ""}`)).toContain("io:Stdout");
    expect(events.events.every((e) => e.ids?.cell === say && e.ids.plane === model.getCell(say).plane && e.ids.document === doc)).toBe(true);
    ok();
  });

  it("the HIR interpreter and the VM report the same identities", () => {
    const { model, doc } = open();
    const vm = model.run(doc);
    const hir = model.run(doc, { engine: "hir" });
    expect(hir.result.trace.map((t) => t.ids)).toEqual(vm.result.trace.map((t) => t.ids));
  });

  it("after a refactor, diagnostics, traces and maps still name the right cells", () => {
    const { model, doc, at } = open();
    const bad = at(1, 1);
    model.apply({ kind: "EditSentence", cell: bad, sentence: "y는 없는것이다." });
    const diag = model.diagnostics(doc).find((d) => d.severity === "error");
    expect(diag).toMatchObject({ cell: bad, node: model.getCell(bad).node, document: doc });
    model.apply({ kind: "SwapCells", a: bad, b: at(1, 0) });
    expect(model.diagnostics(doc).find((d) => d.severity === "error")).toMatchObject({ cell: bad, span: model.sourceSpanOf(bad) });
    model.apply({ kind: "EditSentence", cell: bad, sentence: "y는 x이다." });
    const say = at(0, 1);
    model.apply({ kind: "ExtractNamedPlane", document: doc, z: 0, name: "층" });
    const run = model.run(doc);
    expect(model.traceEventsForCell(run, say).events.some((e) => e.kind === "io")).toBe(true);
  });

  it("a trace from an older revision is stale, never mapped as if current", () => {
    const { model, doc, at } = open();
    const run = model.run(doc);
    expect(model.isCurrent(run)).toBe(true);
    model.apply({ kind: "EditSentence", cell: at(0, 0), sentence: "x는 7이다." });
    expect(model.isCurrent(run)).toBe(false);
    expect(model.traceEvents(run).stale).toBe(true);
    expect(model.isCurrent(model.build(doc))).toBe(true);
    // Undo returns to that exact state, so the trace is current again.
    model.undo();
    expect(model.traceEvents(run).stale).toBe(false);
  });

  it("builds are Y3BC 3, stamped with their revision; the artifact keeps every cell's ids", () => {
    const { model, doc, at } = open();
    const build = model.build(doc);
    expect(build.artifact).toMatch(/^Y3BC 3\n/);
    expect(build.loaded?.revision).toBe(model.revision);
    expect(build.loaded?.executable.nodes.some((n) => n.ids?.cell === at(0, 0))).toBe(true);
  });
});

describe("raw text, formatting and persistence", () => {
  it("formatting never changes identity", () => {
    const { model, doc } = open();
    const before = snapshot(model).map((d) => d.planes.map((p) => p.cells.map((c) => [c.id, c.node])));
    model.format(doc, "flat");
    model.format(doc, "strong");
    expect(snapshot(model).map((d) => d.planes.map((p) => p.cells.map((c) => [c.id, c.node])))).toEqual(before);
  });

  it("a raw edit of one sentence keeps every id but that statement's", () => {
    const { model, doc, at, ok } = open();
    const cells = [at(0, 0), at(0, 1), at(1, 1)];
    const nodes = cells.map((c) => model.getCell(c).node);
    model.setText(doc, model.getDocument(doc).text.replace("[x는 1이다.]", "[x는 3이다.]"));
    expect([at(0, 0), at(0, 1), at(1, 1)]).toEqual(cells);
    expect(cells.map((c) => model.getCell(c).node)).toEqual([expect.not.stringMatching(nodes[0] as string), nodes[1], nodes[2]]);
    ok();
  });

  it("a raw move of a unique sentence keeps its CellId; a replaced plane gets new ids", () => {
    const { model, doc, at, floor } = open();
    const y = at(1, 1);
    const text = model.getDocument(doc).text;
    model.setText(doc, text.replace("[x를 말한다.]  [y는 x이다.]", "[y는 x이다.]   [x를 말한다.]"));
    expect(model.getCell(y)).toMatchObject({ x: 0, y: 1 });
    // Every sentence different and a different size: nothing can be matched with confidence.
    model.setText(doc, text.replace(/⟦\n\[x는[\s\S]*?⟧/u, "⟦\n[a는 1이다.] [b는 2이다.] [c는 3이다.]\n⟧"));
    expect(model.getDocument(doc).floors[0]).not.toBe(floor);
    expect(model.hasCell(y)).toBe(false);
  });

  it("text that does not parse: the document is broken, structural edits and formatting are refused, ids come back when it parses again", () => {
    const { model, doc, at } = open();
    const cell = at(0, 0);
    const good = model.getDocument(doc).text;
    model.setText(doc, good.replace("⟧\n\n※", "\n\n※"));
    expect(model.getDocument(doc).broken).toBe(true);
    expect(model.diagnostics(doc)[0]?.severity).toBe("error");
    expect(() => model.apply({ kind: "MakeBlank", cell })).toThrow(/does not parse/);
    expect(() => model.format(doc)).toThrow(/cannot be formatted/);
    model.setText(doc, good);
    expect(model.getDocument(doc).broken).toBe(false);
    expect(at(0, 0)).toBe(cell);
  });

  it("half a declaration deleted: the document still parses; the declaration is reported, not lost", () => {
    const { model, doc } = open();
    model.setText(doc, model.getDocument(doc).text.replace("자료 점 = { 가로: i64, 세로: i64 }", "자료 점 = { 가로: i64,"));
    expect(model.getDocument(doc).broken).toBe(false);
    expect(model.diagnostics(doc).some((d) => d.code === "Y3C006" && d.node !== undefined)).toBe(true);
  });

  it("source → model → source → model keeps the program's meaning", () => {
    const { model, doc } = open();
    const text = model.getDocument(doc).text;
    model.format(doc);
    const again = new ProgramModel({ nonce: "u" });
    const d2 = again.open({ text: model.getDocument(doc).text });
    const key = (t: string) => {
      const l = loadDocument(t);
      return semanticKey(l.space as never);
    };
    expect(key(again.getDocument(d2).text)).toBe(key(text));
    expect(compileProgram(loadDocument(text).ast as never, loadDocument(text).space as never).program).not.toBeNull();
  });

  it("an identity sidecar brings ids back in a new session, reconciled with edits made outside", () => {
    const { model, doc, at } = open();
    const cells = [at(0, 0), at(0, 1)];
    const sidecar = model.sidecar(doc);
    expect(sidecar).toMatch(/^Y3MODEL 1\n/);
    const text = model.getDocument(doc).text;
    const next = new ProgramModel({ nonce: "t" }); // even the same nonce never collides
    const reopened = next.open({ text: text.replace("[x는 1이다.]", "[x는 9이다.]"), sidecar });
    expect(reopened).toBe(doc);
    const floor = next.getDocument(reopened).floors[0] as PlaneId;
    expect([next.cellAt(floor, 0, 0), next.cellAt(floor, 0, 1)]).toEqual(cells);
    const created = next.apply({ kind: "InsertRow", plane: floor, y: 0 }).created;
    expect(created.some((c) => model.getPlane(model.getDocument(doc).floors[0] as PlaneId).cells.flat().includes(c as CellId))).toBe(false);
    expect(modelViolations(next)).toEqual([]);
    expect(() => next.open({ text, sidecar: "Y3MODEL 2\n{}" })).toThrow(/version 1/);
  });
});

describe("adversarial cases", () => {
  it("undo after several dependent edits walks back through each, exactly", () => {
    const { model, floor } = open();
    const states = [snapshot(model)];
    const row = model.apply({ kind: "InsertRow", plane: floor, y: 3 }).created[0] as CellId;
    states.push(snapshot(model));
    model.apply({ kind: "EditSentence", cell: row, sentence: "z는 9이다." });
    states.push(snapshot(model));
    model.apply({ kind: "SwapCells", a: row, b: model.cellAt(floor, 0, 0) as CellId });
    states.push(snapshot(model));
    for (let i = states.length - 2; i >= 0; i -= 1) {
      model.undo();
      expect(snapshot(model)).toEqual(states[i]);
    }
    expect(model.hasCell(row)).toBe(false);
  });

  it("VOID becomes blank geometry only as a whole row or column: new cells, new ids", () => {
    const { model, floor, ok } = open();
    const created = model.apply([0, 1, 2].map((y) => ({ kind: "InsertCell" as const, plane: floor, x: 2, y, sentence: null }))).created;
    expect(created.map((c) => model.getCell(c as CellId).blank)).toEqual([true, true, true]);
    expect(model.getPlane(floor).width).toBe(3);
    expect(() => model.apply({ kind: "InsertCell", plane: floor, x: 3, y: 0, sentence: null })).toThrow(/hole/);
    ok();
  });

  it("a cell moved between planes keeps its id, and its HIR follows into the other body", () => {
    const { model, doc, at } = open();
    const callable = model.getDocument(doc).planes.find((p) => model.getPlane(p).kind === "callable") as PlaneId;
    const cell = at(1, 0);
    const blanks = model.apply([
      { kind: "EditSentence", cell, sentence: "q는 5이다." },
      { kind: "InsertColumn", plane: callable, x: 1 },
    ]).created;
    model.apply({ kind: "SwapCells", a: cell, b: blanks[0] as CellId });
    expect(model.getCell(cell)).toMatchObject({ plane: callable, x: 1, y: 0 });
    const hir = model.hirNodesForCell(cell);
    expect(hir[0]?.kind).toBe("StoreNoun");
    expect(hir[0]?.item.at.plane.name).toBe("두배");
    expect(model.diagnostics(doc).filter((d) => d.severity === "error")).toEqual([]);
    expect(modelViolations(model)).toEqual([]);
  });

  it("extracting a floor with a loop anchor (여기가 처음이다) changes nothing the program does", () => {
    const text = "⟦\n[i는 0이다.]\n[여기가 처음이다.]\n[i에 1을 더한다.]\n[i가 3보다 작으면 끝은 처음이다.]\n[i를 말한다.]\n[끝이다.]\n⟧\n";
    const { model, doc } = open(text);
    const before = model.run(doc).result;
    model.apply({ kind: "ExtractNamedPlane", document: doc, z: 0, name: "고리" });
    const after = model.run(doc).result;
    expect(after.output).toEqual(["3"]);
    expect(after.trace.map((t) => t.ids?.cell)).toEqual(before.trace.map((t) => t.ids?.cell));
  });

  it("a raw replacement in a resized plane never hands an old id to a different sentence", () => {
    const { model, doc } = open("⟦\n[a는 1이다.] [b는 2이다.]\n[끝이다.] [ ]\n⟧\n");
    const floor = model.getDocument(doc).floors[0] as PlaneId;
    const [a, b] = [model.cellAt(floor, 0, 0), model.cellAt(floor, 1, 0)];
    model.setText(doc, "⟦\n[c는 3이다.] [b는 2이다.] [d는 4이다.]\n[끝이다.] [ ] [ ]\n⟧\n");
    const now = model.getDocument(doc).floors[0] as PlaneId;
    expect(model.cellAt(now, 1, 0)).toBe(b); // same sentence, same place
    expect(model.cellAt(now, 0, 0)).not.toBe(a); // another sentence, in a plane of another size
    expect(model.hasCell(a as CellId)).toBe(false);
    expect(modelViolations(model)).toEqual([]);
  });

  it("an identical sentence written twice is not guessed: duplicates get new ids when they move", () => {
    const { model, doc } = open("⟦\n[x는 1이다.] [x는 1이다.]\n[끝이다.] [ ]\n⟧\n");
    const floor = model.getDocument(doc).floors[0] as PlaneId;
    const [a, b] = [model.cellAt(floor, 0, 0), model.cellAt(floor, 1, 0)];
    model.setText(doc, "⟦\n[ ] [ ] [x는 1이다.] [x는 1이다.]\n[끝이다.] [ ] [ ] [ ]\n⟧\n");
    const now = model.getDocument(doc).floors[0] as PlaneId;
    expect([model.cellAt(now, 2, 0), model.cellAt(now, 3, 0)].some((c) => c === a || c === b)).toBe(false);
  });
});

import { compileWasm, loadWasmArtifact, memoryHost, runWasm } from "../../src/v2";
import { observable } from "./compile-helpers";
import { fixtures } from "./helpers";

describe("engines agree, identities included", () => {
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const model = new ProgramModel({ nonce: "e" });
      const doc = model.open({ text: source, path });
      const build = model.build(doc);
      if (!build.loaded || !build.artifact || !build.manifest) return;
      const host = () => memoryHost({ now: 42n });
      const vm = model.run(doc, { host: host() }).result;
      const hir = model.run(doc, { host: host(), engine: "hir" }).result;
      expect(observable(vm)).toEqual(observable(hir));
      const wasm = loadWasmArtifact(compileWasm(build.loaded, build.artifact));
      expect(observable(runWasm(wasm.module, wasm.loaded, build.manifest, { host: host() }))).toEqual(observable(hir));
      // Every executed cell is a cell of the model.
      for (const t of vm.trace) if (t.ids) expect(model.hasCell(t.ids.cell)).toBe(true);
      expect(vm.trace.every((t) => t.ids !== undefined)).toBe(true);
    });
  }
});

import { moduleOf, writeArtifact, type BytecodeModule } from "../../src/v2";

describe("reconciliation and artifacts, more adversarial cases", () => {
  it("a named plane resized by a raw edit keeps its id, but a position never vouches for a different sentence", () => {
    const { model, doc } = open("⟦ :층: ⟧\n\n※\n\n:층: ⟦\n[a는 1이다.] [b는 2이다.]\n[끝이다.] [ ]\n⟧\n");
    const plane = model.getDocument(doc).floors[0] as PlaneId;
    const [a, b] = [model.cellAt(plane, 0, 0), model.cellAt(plane, 1, 0)];
    model.setText(doc, model.getDocument(doc).text.replace("[a는 1이다.] [b는 2이다.]", "[c는 3이다.] [b는 2이다.] [d는 4이다.]").replace("[끝이다.] [ ]", "[끝이다.] [ ] [ ]"));
    expect(model.getDocument(doc).floors[0]).toBe(plane); // matched by name
    expect(model.cellAt(plane, 1, 0)).toBe(b);
    expect(model.cellAt(plane, 0, 0)).not.toBe(a);
    expect(modelViolations(model)).toEqual([]);
  });

  it("Y3BC 3 refuses malformed identities in its debug map, and carries well-formed ones", () => {
    const { model, doc } = open();
    const text = model.build(doc).artifact as string;
    const m = JSON.parse(text.split("\n")[1] as string) as BytecodeModule & { nodes: { ids?: unknown }[] };
    expect(moduleOf(writeArtifact(m)).revision).toBe(model.revision);
    const bad = (ids: unknown) => moduleOf(writeArtifact({ ...m, nodes: m.nodes.map((n, i) => (i === 0 ? { ...n, ids } : n)) } as never));
    expect(() => bad({ document: "d", module: "m", plane: "p", cell: 7, node: null })).toThrow(/malformed identities/);
    expect(() => bad({ document: "d", module: "m", plane: "p" })).toThrow(/malformed identities/);
    expect(() => bad("c:1")).toThrow(/malformed identities/);
    expect(() => moduleOf(writeArtifact({ ...m, revision: 3 } as never))).toThrow(/revision/);
  });
});
