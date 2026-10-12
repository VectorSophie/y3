import { describe, expect, it } from "vitest";
import { EditError, modelViolations, ProgramModel, type CellId, type Command, type DocumentId, type PlaneId } from "../../src/editor";
import { compileProgram, loadDocument, parseDocument, semanticKey } from "../../src/v2";
import { prng } from "./program-generator";

// M10 properties and mutation-sequence fuzzing: seeded random edits on small programs,
// with every invariant checked after every operation, undo and redo.

const SENTENCES = ["x는 1이다.", "x에 2를 더한다.", "x를 말한다.", "y는 x이다.", "끝이다.", "앞으로 간다.", "동쪽을 본다.", "위층으로 간다.", "z는 미정이다.", "z는 3이었다.", "x가 3이면 끝이다."];

type Rng = ReturnType<typeof prng>;

function randomDocument(r: Rng): string {
  const floors = 1 + r.int(2);
  const plane = () => {
    const w = 1 + r.int(3);
    const h = 1 + r.int(3);
    return Array.from({ length: h }, () => Array.from({ length: w }, () => (r.int(3) === 0 ? "[ ]" : `[${r.pick(SENTENCES)}]`)).join(" ")).join("\n");
  };
  const volume = Array.from({ length: floors }, (_, z) => (z === 1 && r.int(2) === 0 ? "⟦ :층: ⟧" : `⟦\n${plane()}\n⟧`));
  const named = volume.includes("⟦ :층: ⟧") ? `\n※\n\n:층: ⟦\n${plane()}\n⟧\n` : "";
  return `${volume.join("\n\n")}\n${named}`;
}

const identity = (m: ProgramModel) =>
  m.documents().map((d) => {
    const doc = m.getDocument(d);
    return { text: doc.text, revision: doc.revision, floors: doc.floors, planes: doc.planes.map((p) => ({ ...m.getPlane(p), cells: m.getPlane(p).cells.map((row) => row.map((c) => m.getCell(c))) })) };
  });

const allCells = (m: ProgramModel, d: DocumentId) => m.getDocument(d).planes.flatMap((p) => m.getPlane(p).cells.flat());

function randomCommand(r: Rng, m: ProgramModel, d: DocumentId): Command | Command[] | null {
  const doc = m.getDocument(d);
  const planes = doc.planes;
  const plane = r.pick(planes);
  const v = m.getPlane(plane);
  const cells = allCells(m, d);
  const cell = r.pick(cells);
  switch (r.int(14)) {
    case 0:
      return { kind: "EditSentence", cell, sentence: r.pick(SENTENCES) };
    case 1:
      return { kind: "MakeBlank", cell };
    case 2:
      return { kind: "SwapCells", a: cell, b: r.pick(cells) };
    case 3:
      return { kind: "InsertRow", plane, y: r.int(v.height + 1) };
    case 4:
      return v.height > 1 ? { kind: "DeleteRow", plane, y: r.int(v.height) } : null;
    case 5:
      return { kind: "InsertColumn", plane, x: r.int(v.width + 1) };
    case 6:
      return v.width > 1 ? { kind: "DeleteColumn", plane, x: r.int(v.width) } : null;
    case 7: {
      // Move a cell into VOID below the plane, filling the new row and the hole.
      const c = m.getCell(cell);
      const target = m.getPlane(c.plane);
      return [
        { kind: "InsertRow", plane: c.plane, y: target.height },
        { kind: "SwapCells", a: cell, b: cell },
        ...(target.width > 0 ? [] : []),
        { kind: "MoveCell", cell, plane: c.plane, x: target.width, y: 0 },
        ...Array.from({ length: target.height + 1 }, (_, y) => (y === 0 ? null : { kind: "InsertCell" as const, plane: c.plane, x: target.width, y, sentence: null })).filter((x) => x !== null),
        { kind: "InsertCell", plane: c.plane, x: c.x, y: c.y, sentence: null },
      ] as Command[];
    }
    case 8:
      return { kind: "InsertPlane", document: d, z: r.int(doc.floors.length + 1), width: 1 + r.int(2), height: 1 + r.int(2) };
    case 9:
      return doc.floors.length > 1 ? { kind: "MoveLayer", document: d, from: r.int(doc.floors.length), to: r.int(doc.floors.length) } : null;
    case 10:
      return v.name !== null ? { kind: "RenamePlane", plane, name: r.pick(["층", "새층", "바닥", "위"]) } : null;
    case 11: {
      const z = r.int(doc.floors.length);
      const p = doc.floors[z];
      return p && m.getPlane(p).kind === "floor" ? { kind: "ExtractNamedPlane", document: d, z, name: `면${r.int(100)}` } : null;
    }
    case 12: {
      const z = r.int(doc.floors.length);
      const p = doc.floors[z];
      return p && m.getPlane(p).kind === "named" ? { kind: "InlineNamedPlane", document: d, z } : null;
    }
    default:
      return { kind: "DeleteCell", cell }; // usually refused (a hole), sometimes empties a row
  }
}

describe("identity properties (seeded)", () => {
  it("move and swap preserve CellIds; rename preserves PlaneIds; formatting preserves both", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = prng(seed);
      const m = new ProgramModel({ nonce: `p${seed}` });
      const d = m.open({ text: randomDocument(r) });
      const cells = allCells(m, d);
      const a = r.pick(cells);
      const b = r.pick(cells);
      const [ta, tb] = [m.getCell(a).sentence, m.getCell(b).sentence];
      const [pa, pb] = [m.getCell(a), m.getCell(b)];
      m.apply({ kind: "SwapCells", a, b });
      expect(m.getCell(a)).toMatchObject({ sentence: ta, x: pb.x, y: pb.y, plane: pb.plane });
      expect(m.getCell(b)).toMatchObject({ sentence: tb, x: pa.x, y: pa.y, plane: pa.plane });
      const before = allCells(m, d).map((c) => [c, m.getCell(c).node]);
      m.format(d, r.pick(["flat", "perspective", "strong"] as const));
      expect(allCells(m, d).map((c) => [c, m.getCell(c).node])).toEqual(before);
      const z = m.getDocument(d).floors.findIndex((p) => p !== null && m.getPlane(p).kind === "floor");
      const plane = m.getDocument(d).floors[z] as PlaneId;
      m.apply({ kind: "ExtractNamedPlane", document: d, z, name: "추출" });
      m.apply({ kind: "RenamePlane", plane, name: "개명" });
      expect(m.getPlane(plane)).toMatchObject({ name: "개명", floors: [z] });
      expect(modelViolations(m)).toEqual([]);
    }
  });

  it("an edit to one cell leaves every other id unchanged; delete + undo restores ids exactly", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = prng(seed * 31);
      const m = new ProgramModel({ nonce: `q${seed}` });
      const d = m.open({ text: randomDocument(r) });
      const cells = allCells(m, d);
      const target = r.pick(cells);
      const others = cells.filter((c) => c !== target).map((c) => [c, m.getCell(c).node, m.getCell(c).plane, m.getCell(c).x, m.getCell(c).y]);
      m.apply({ kind: "EditSentence", cell: target, sentence: "q는 42이다." });
      expect(cells.filter((c) => c !== target).map((c) => [c, m.getCell(c).node, m.getCell(c).plane, m.getCell(c).x, m.getCell(c).y])).toEqual(others);
      const before = identity(m);
      const v = m.getPlane(m.getCell(target).plane);
      try {
        m.apply({ kind: "DeleteRow", plane: v.id, y: m.getCell(target).y });
        expect(m.hasCell(target)).toBe(false);
        m.undo();
      } catch (e) {
        if (!(e instanceof EditError)) throw e; // a one-row plane cannot lose its row
      }
      expect(identity(m)).toEqual(before);
    }
  });

  it("source → model → source → model preserves meaning", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const text = randomDocument(prng(seed * 7));
      const m = new ProgramModel({ nonce: "x" });
      const d = m.open({ text });
      m.format(d);
      const m2 = new ProgramModel({ nonce: "y" });
      const d2 = m2.open({ text: m.getDocument(d).text });
      const key = (t: string) => semanticKey(loadDocument(t).space as never);
      expect(key(m2.getDocument(d2).text)).toBe(key(text));
      expect(m2.getDocument(d2).planes.map((p) => m2.getPlane(p).cells.flat().map((c) => m2.getCell(c).sentence))).toEqual(m.getDocument(d).planes.map((p) => m.getPlane(p).cells.flat().map((c) => m.getCell(c).sentence)));
    }
  });
});

describe("mutation sequence fuzzing", () => {
  it("random edits, undos, redos and raw text edits never break an invariant", () => {
    let applied = 0;
    let refused = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      const r = prng(seed * 1009);
      const m = new ProgramModel({ nonce: `f${seed}` });
      const d = m.open({ text: randomDocument(r) });
      const history: ReturnType<typeof identity>[] = [identity(m)];
      let at = 0; // position of the current state in `history`
      for (let step = 0; step < 25; step += 1) {
        const roll = r.int(10);
        if (roll === 0) {
          if (m.undo()) {
            at -= 1;
            expect(identity(m), `seed ${seed} step ${step}: undo`).toEqual(history[at]);
          }
        } else if (roll === 1) {
          if (m.redo()) {
            at += 1;
            expect(identity(m), `seed ${seed} step ${step}: redo`).toEqual(history[at]);
          }
        } else if (roll === 2) {
          // A raw edit: one sentence replaced in the text.
          const cells = allCells(m, d).filter((c) => !m.getCell(c).blank);
          if (cells.length === 0) continue;
          const c = m.getCell(r.pick(cells));
          m.setText(d, m.getDocument(d).text.replace(`[${c.sentence}]`, `[${r.pick(SENTENCES)}]`));
          history.splice(at + 1, history.length, identity(m));
          at += 1;
        } else {
          const command = randomCommand(r, m, d);
          if (!command) continue;
          const before = identity(m);
          try {
            m.apply(command);
            applied += 1;
            history.splice(at + 1, history.length, identity(m));
            at += 1;
          } catch (e) {
            if (!(e instanceof EditError)) throw new Error(`seed ${seed} step ${step}: ${JSON.stringify(command)}: ${String(e)}`);
            refused += 1;
            expect(identity(m), `seed ${seed}: a refused edit changed the model`).toEqual(before);
          }
        }
        expect(modelViolations(m), `seed ${seed} step ${step}`).toEqual([]);
      }
      // Whatever happened, the text parses and compiles without crashing.
      const text = m.getDocument(d).text;
      const parsed = parseDocument(text);
      expect(parsed.ok).toBe(true);
      const loaded = loadDocument(text);
      if (loaded.ast && loaded.space) compileProgram(loaded.ast, loaded.space);
      m.build(d);
    }
    expect(applied).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(20);
  });
});
