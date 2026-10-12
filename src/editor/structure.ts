import type { CellAst, Comment, DeclarationAst, DefinitionAst, DocumentAst, InlinePlaneAst, PlaneSlotAst, Span } from "../language/ast";
import type { CellId, CellIds, DocumentId, ModuleId, NodeId, PlaneId } from "../ir/identity";
import { canonicalDeclarationOrder, canonicalDefinitionOrder } from "../format/formatter";

// A document's structure with its identities (docs/v2-editor-model.md). It mirrors the
// layout AST one to one (volume slots, planes, rows, cells, declarations, comments) and
// adds the ids; it is not a second syntax tree. Text goes to and from it through the
// existing parser and formatter only.

export type CellEntry = { readonly id: CellId; readonly node: NodeId | null; readonly text: string | null };
// rows[y][x]. A null entry is VOID inside the bounding rectangle: it exists only in a
// transaction's draft, and a commit refuses it (planes are rectangles).
export type Grid = readonly (readonly (CellEntry | null)[])[];
export type PlaneEntry = {
  readonly id: PlaneId;
  readonly name: string | null; // null: an inline floor of the volume
  readonly signature: string | null; // a callable plane's signature
  readonly comments: readonly Comment[]; // a named plane's doc comments
  readonly grid: Grid;
};
// A floor: an inline plane, a placement of a named plane, or a reference to a name no
// plane has (an error the compiler reports; the model keeps it as written).
export type SlotEntry = { readonly plane: PlaneId; readonly comments: readonly Comment[] } | { readonly missing: string; readonly comments: readonly Comment[] };
export const slotPlane = (slot: SlotEntry): PlaneId | null => ("plane" in slot ? slot.plane : null);
export type DeclEntry = { readonly node: NodeId; readonly name: string; readonly text: string; readonly comments: readonly Comment[] };

export type Structure = {
  readonly frontMatter: string | null;
  readonly volume: readonly SlotEntry[]; // z order
  readonly planes: ReadonlyMap<PlaneId, PlaneEntry>;
  readonly definitions: readonly PlaneId[]; // named planes, in ※ order
  readonly appendix: { readonly comments: readonly Comment[] } | null;
  readonly declarations: readonly DeclEntry[];
  readonly trailing: readonly Comment[];
};

export type IdKind = "cell" | "plane" | "node";
export type NewId = <K extends IdKind>(kind: K) => K extends "cell" ? CellId : K extends "plane" ? PlaneId : NodeId;

export class StructureError extends Error {}

const NO_SPAN: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };

// ---- Structure → AST (for the formatter).

function planeAst(grid: Grid): InlinePlaneAst {
  return {
    kind: "inline",
    rows: grid.map((row) => ({
      cells: row.map((c) => {
        if (!c) throw new StructureError("a plane has a hole: planes are rectangles");
        return { text: c.text, span: NO_SPAN };
      }),
      span: NO_SPAN,
    })),
    span: NO_SPAN,
  };
}

export function toAst(s: Structure): DocumentAst {
  const plane = (id: PlaneId) => {
    const p = s.planes.get(id);
    if (!p) throw new StructureError(`plane ${id} does not exist`);
    return p;
  };
  const volume: PlaneSlotAst[] = s.volume.map((slot) => {
    if ("missing" in slot) return { comments: [...slot.comments], plane: { kind: "ref", name: slot.missing, span: NO_SPAN } };
    const p = plane(slot.plane);
    return { comments: [...slot.comments], plane: p.name === null ? planeAst(p.grid) : { kind: "ref", name: p.name, span: NO_SPAN } };
  });
  const definitions: DefinitionAst[] = s.definitions.map((id) => {
    const p = plane(id);
    return { name: p.name as string, signature: p.signature, plane: planeAst(p.grid), comments: [...p.comments], span: NO_SPAN };
  });
  const declarations: DeclarationAst[] = s.declarations.map((d) => ({ name: d.name, text: d.text, comments: [...d.comments], span: NO_SPAN }));
  const appendix = s.appendix || definitions.length > 0 || declarations.length > 0 ? { comments: [...(s.appendix?.comments ?? [])], declarations, definitions, span: NO_SPAN } : null;
  return { frontMatter: s.frontMatter === null ? null : { text: s.frontMatter, span: NO_SPAN }, volume, appendix, trailingComments: [...s.trailing] };
}

// The formatter's order of the ※ section, applied to the structure, so that formatting
// never moves anything the structure does not know about.
export function canonicalOrder(s: Structure): Structure {
  const ast = toAst(s);
  const defs = ast.appendix?.definitions ?? [];
  const decls = ast.appendix?.declarations ?? [];
  const defOrder = canonicalDefinitionOrder(ast.volume, defs).map((d) => s.definitions[defs.indexOf(d)] as PlaneId);
  const declOrder = canonicalDeclarationOrder(decls).map((d) => s.declarations[decls.indexOf(d)] as DeclEntry);
  return { ...s, definitions: defOrder, declarations: declOrder };
}

// ---- AST → structure.

const gridOf = (plane: InlinePlaneAst, cell: (c: CellAst, x: number, y: number) => CellEntry): CellEntry[][] => plane.rows.map((row, y) => row.cells.map((c, x) => cell(c, x, y)));

// A freshly opened document: every element gets a new id.
export function fromAst(ast: DocumentAst, newId: NewId): Structure {
  const fresh = (c: CellAst): CellEntry => ({ id: newId("cell"), node: c.text === null ? null : newId("node"), text: c.text });
  const planes = new Map<PlaneId, PlaneEntry>();
  const byName = new Map<string, PlaneId>();
  const definitions = (ast.appendix?.definitions ?? []).map((d) => {
    const id = newId("plane");
    planes.set(id, { id, name: d.name, signature: d.signature, comments: d.comments, grid: gridOf(d.plane, fresh) });
    if (!byName.has(d.name)) byName.set(d.name, id);
    return id;
  });
  const volume = ast.volume.map((slot) => {
    if (slot.plane.kind === "ref") {
      const id = byName.get(slot.plane.name);
      return id ? { plane: id, comments: slot.comments } : { missing: slot.plane.name, comments: slot.comments };
    }
    const id = newId("plane");
    planes.set(id, { id, name: null, signature: null, comments: [], grid: gridOf(slot.plane, fresh) });
    return { plane: id, comments: slot.comments };
  });
  return {
    frontMatter: ast.frontMatter?.text ?? null,
    volume,
    planes,
    definitions,
    appendix: ast.appendix ? { comments: ast.appendix.comments } : null,
    declarations: (ast.appendix?.declarations ?? []).map((d) => ({ node: newId("node"), name: d.name, text: d.text, comments: d.comments })),
    trailing: ast.trailingComments,
  };
}

// ---- Attaching identities to parsed text.

// After the model serialized a structure, the parse of that text must have exactly its
// shape. The structure takes the parsed texts (the formatter's canonical spellings); the
// AST takes the ids. Anything else is a bug, reported, never patched over.
export function attach(s: Structure, ast: DocumentAst, owner: { document: DocumentId; module: ModuleId }): { structure: Structure; ast: DocumentAst } {
  const fail = (m: string): never => {
    throw new StructureError(`the parsed text does not have the model's structure: ${m}`);
  };
  if (ast.volume.length !== s.volume.length) fail("volume");
  const defs = ast.appendix?.definitions ?? [];
  if (defs.length !== s.definitions.length) fail("definitions");
  const decls = ast.appendix?.declarations ?? [];
  if (decls.length !== s.declarations.length) fail("declarations");
  const planes = new Map(s.planes);
  const annotate = (id: PlaneId, plane: InlinePlaneAst): InlinePlaneAst => {
    const p = s.planes.get(id) ?? fail(`plane ${id}`);
    if (plane.rows.length !== p.grid.length) fail(`rows of ${id}`);
    const grid: CellEntry[][] = [];
    const rows = plane.rows.map((row, y) => {
      const entries = p.grid[y] as readonly (CellEntry | null)[];
      if (row.cells.length !== entries.length) fail(`cells of ${id}`);
      grid.push([]);
      return {
        ...row,
        cells: row.cells.map((c, x) => {
          const e = entries[x] ?? fail(`a hole in ${id}`);
          if ((c.text === null) !== (e.text === null)) fail(`blank/non-blank at ${id} (${x},${y})`);
          // A canonical respelling keeps the statement's id; it is the same sentence.
          (grid[y] as CellEntry[]).push({ ...e, text: c.text });
          const ids: CellIds = { document: owner.document, module: owner.module, plane: id, cell: e.id, node: e.node };
          return { ...c, ids };
        }),
      };
    });
    planes.set(id, { ...p, grid });
    return { ...plane, rows };
  };
  const volume = ast.volume.map((slot, z) => {
    const entry = s.volume[z] as SlotEntry;
    if ("missing" in entry) {
      if (slot.plane.kind !== "ref" || slot.plane.name !== entry.missing) fail(`reference at z=${z}`);
      return slot;
    }
    const p = s.planes.get(entry.plane) ?? fail(`plane ${entry.plane}`);
    if (slot.plane.kind === "ref") {
      if (p.name !== slot.plane.name) fail(`reference at z=${z}`);
      return slot;
    }
    if (p.name !== null) fail(`inline plane at z=${z}`);
    return { ...slot, plane: annotate(entry.plane, slot.plane) };
  });
  const definitions = defs.map((d, i) => {
    const id = s.definitions[i] as PlaneId;
    if (s.planes.get(id)?.name !== d.name) fail(`definition ${i}`);
    return { ...d, plane: annotate(id, d.plane) };
  });
  const declarations = s.declarations.map((d, i) => {
    const parsed = decls[i] as DeclarationAst;
    if (parsed.name !== d.name) fail(`declaration ${i}`);
    return { ...d, text: parsed.text };
  });
  const annotated: DocumentAst = { ...ast, volume, appendix: ast.appendix ? { ...ast.appendix, definitions } : null };
  return { structure: { ...s, planes, declarations }, ast: annotated };
}

// ---- Reconciliation after a raw text edit (docs/v2-editor-model.md § raw text).

type Cand = { readonly plane: PlaneId; readonly x: number; readonly y: number; readonly entry: CellEntry };

// Old structure, new parsed text → a structure for the new text, keeping old ids only
// where the match is certain. Deterministic: no ordering depends on anything but the two
// inputs.
export function reconcile(old: Structure, ast: DocumentAst, newId: NewId): Structure {
  // 1. Planes.
  const newPlanes: { key: string; name: string | null; plane: InlinePlaneAst; signature: string | null; comments: readonly Comment[] }[] = [];
  (ast.appendix?.definitions ?? []).forEach((d, i) => newPlanes.push({ key: `d${i}`, name: d.name, plane: d.plane, signature: d.signature, comments: d.comments }));
  ast.volume.forEach((slot, z) => {
    if (slot.plane.kind === "inline") newPlanes.push({ key: `v${z}`, name: null, plane: slot.plane, signature: null, comments: [] });
  });
  const texts = (g: Grid | InlinePlaneAst) => JSON.stringify("rows" in g ? g.rows.map((r) => r.cells.map((c) => c.text)) : g.map((r) => r.map((c) => c?.text ?? null)));
  const planeMatch = new Map<string, PlaneId>(); // new key → old plane
  const usedOld = new Set<PlaneId>();
  const oldNamed = new Map([...old.planes.values()].filter((p) => p.name !== null).map((p) => [p.name as string, p.id]));
  for (const n of newPlanes) {
    const id = n.name !== null ? oldNamed.get(n.name) : undefined;
    if (id && !usedOld.has(id)) {
      planeMatch.set(n.key, id);
      usedOld.add(id);
    }
  }
  const oldInline = old.volume.flatMap((s) => ("plane" in s ? [old.planes.get(s.plane) as PlaneEntry] : [])).filter((p) => p.name === null);
  const newInline = newPlanes.filter((n) => n.name === null);
  // Identical contents, when unique on both sides.
  const count = <T>(xs: readonly T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>());
  const oldCounts = count(oldInline, (p) => texts(p.grid));
  const newCounts = count(newInline, (n) => texts(n.plane));
  for (const n of newInline) {
    const key = texts(n.plane);
    if (newCounts.get(key) !== 1 || oldCounts.get(key) !== 1) continue;
    const p = oldInline.find((o) => texts(o.grid) === key && !usedOld.has(o.id));
    if (p) {
      planeMatch.set(n.key, p.id);
      usedOld.add(p.id);
    }
  }
  // In volume order: same size and at least half the cells unchanged in place.
  const restOld = oldInline.filter((p) => !usedOld.has(p.id));
  let cursor = 0;
  for (const n of newInline.filter((n) => !planeMatch.has(n.key))) {
    for (let i = cursor; i < restOld.length; i += 1) {
      const p = restOld[i] as PlaneEntry;
      const rows = n.plane.rows;
      if (rows.length !== p.grid.length || rows.some((r, y) => r.cells.length !== (p.grid[y] as readonly unknown[]).length)) continue;
      let same = 0;
      let total = 0;
      rows.forEach((r, y) => r.cells.forEach((c, x) => ((total += 1), (same += p.grid[y]?.[x]?.text === c.text ? 1 : 0))));
      if (total > 0 && same * 2 >= total) {
        planeMatch.set(n.key, p.id);
        usedOld.add(p.id);
        cursor = i + 1;
        break;
      }
    }
  }

  // 2. Cells: candidates from every old plane, consumed as they match.
  const unmatched = new Map<CellId, Cand>();
  for (const p of old.planes.values()) p.grid.forEach((row, y) => row.forEach((e, x) => e && unmatched.set(e.id, { plane: p.id, x, y, entry: e })));
  const result = new Map<string, CellEntry[][]>(); // new key → grid
  const pending: { key: string; x: number; y: number; text: string | null }[] = [];
  const take = (c: Cand, text: string | null): CellEntry => {
    unmatched.delete(c.entry.id);
    return { id: c.entry.id, node: text === null ? null : c.entry.text === text && c.entry.node ? c.entry.node : newId("node"), text };
  };
  const at = (plane: PlaneId, x: number, y: number) => {
    const e = old.planes.get(plane)?.grid[y]?.[x];
    return e && unmatched.has(e.id) ? (unmatched.get(e.id) as Cand) : null;
  };
  for (const n of newPlanes) {
    const grid: (CellEntry | null)[][] = n.plane.rows.map((r) => r.cells.map(() => null));
    result.set(n.key, grid as CellEntry[][]);
    const p = planeMatch.get(n.key);
    // Same position, same sentence.
    n.plane.rows.forEach((r, y) =>
      r.cells.forEach((c, x) => {
        const o = p ? at(p, x, y) : null;
        if (o && o.entry.text === c.text) (grid[y] as (CellEntry | null)[])[x] = take(o, c.text);
        else pending.push({ key: n.key, x, y, text: c.text });
      }),
    );
  }
  const fill = (key: string, x: number, y: number, e: CellEntry) => (((result.get(key) as CellEntry[][])[y] as CellEntry[])[x] = e);
  const isEmpty = (key: string, x: number, y: number) => !(result.get(key) as (CellEntry | null)[][])[y]?.[x];
  // A sentence unique among the unmatched on both sides: the same cell, moved (within a
  // plane or between planes).
  const oldByText = count([...unmatched.values()].filter((c) => c.entry.text !== null), (c) => c.entry.text as string);
  const newByText = count(pending.filter((q) => q.text !== null), (q) => q.text as string);
  for (const q of pending) {
    if (q.text === null || newByText.get(q.text) !== 1 || oldByText.get(q.text) !== 1) continue;
    const c = [...unmatched.values()].find((u) => u.entry.text === q.text);
    if (c) fill(q.key, q.x, q.y, take(c, q.text));
  }
  // Same position in a plane that kept its size: the sentence was edited (or blanked).
  for (const q of pending) {
    if (!isEmpty(q.key, q.x, q.y)) continue;
    const p = planeMatch.get(q.key);
    const oldPlane = p ? old.planes.get(p) : undefined;
    const n = newPlanes.find((m) => m.key === q.key) as (typeof newPlanes)[number];
    const sameSize = oldPlane && oldPlane.grid.length === n.plane.rows.length && oldPlane.grid.every((r, y) => r.length === n.plane.rows[y]?.cells.length);
    const o = sameSize && p ? at(p, q.x, q.y) : null;
    fill(q.key, q.x, q.y, o ? take(o, q.text) : { id: newId("cell"), node: q.text === null ? null : newId("node"), text: q.text });
  }

  // 3. Assemble, in the new text's order.
  const planes = new Map<PlaneId, PlaneEntry>();
  const idOf = (key: string) => planeMatch.get(key) ?? newId("plane");
  const ids = new Map(newPlanes.map((n) => [n.key, idOf(n.key)]));
  for (const n of newPlanes) {
    const id = ids.get(n.key) as PlaneId;
    planes.set(id, { id, name: n.name, signature: n.signature, comments: n.comments, grid: result.get(n.key) as CellEntry[][] });
  }
  const byName = new Map<string, PlaneId>();
  for (const n of newPlanes) if (n.name !== null && !byName.has(n.name)) byName.set(n.name, ids.get(n.key) as PlaneId);
  const volume = ast.volume.map((slot, z): SlotEntry => {
    if (slot.plane.kind === "inline") return { plane: ids.get(`v${z}`) as PlaneId, comments: slot.comments };
    const id = byName.get(slot.plane.name);
    return id ? { plane: id, comments: slot.comments } : { missing: slot.plane.name, comments: slot.comments };
  });
  // 4. Declarations: identical text keeps its node.
  const oldDecls = new Map<string, NodeId[]>();
  for (const d of old.declarations) oldDecls.set(d.text, [...(oldDecls.get(d.text) ?? []), d.node]);
  const declarations = (ast.appendix?.declarations ?? []).map((d) => ({ node: oldDecls.get(d.text)?.shift() ?? newId("node"), name: d.name, text: d.text, comments: d.comments }));
  return {
    frontMatter: ast.frontMatter?.text ?? null,
    volume,
    planes,
    definitions: (ast.appendix?.definitions ?? []).map((_, i) => ids.get(`d${i}`) as PlaneId),
    appendix: ast.appendix ? { comments: ast.appendix.comments } : null,
    declarations,
    trailing: ast.trailingComments,
  };
}
