import type { CellId, DocumentId, NodeId, PlaneId } from "../ir/identity";
import { PLANE_NAME_PATTERN } from "../language/document-parser";
import type { CellEntry, DeclEntry, NewId, PlaneEntry, SlotEntry, Structure } from "./structure";

// Structural edits (docs/v2-editor-model.md § structural commands). A command is data;
// a transaction applies a list of them to a draft and validates once, at the end, so a
// geometry change that needs several steps (planes are rectangles) is one edit.

export type Command =
  | { readonly kind: "InsertCell"; readonly plane: PlaneId; readonly x: number; readonly y: number; readonly sentence: string | null }
  | { readonly kind: "DeleteCell"; readonly cell: CellId }
  | { readonly kind: "MakeBlank"; readonly cell: CellId }
  | { readonly kind: "MakeVoid"; readonly cell: CellId }
  | { readonly kind: "MoveCell"; readonly cell: CellId; readonly plane: PlaneId; readonly x: number; readonly y: number }
  | { readonly kind: "SwapCells"; readonly a: CellId; readonly b: CellId }
  | { readonly kind: "CopyCell"; readonly cell: CellId; readonly plane: PlaneId; readonly x: number; readonly y: number }
  | { readonly kind: "EditSentence"; readonly cell: CellId; readonly sentence: string }
  | { readonly kind: "InsertRow"; readonly plane: PlaneId; readonly y: number }
  | { readonly kind: "DeleteRow"; readonly plane: PlaneId; readonly y: number }
  | { readonly kind: "InsertColumn"; readonly plane: PlaneId; readonly x: number }
  | { readonly kind: "DeleteColumn"; readonly plane: PlaneId; readonly x: number }
  | { readonly kind: "InsertPlane"; readonly document: DocumentId; readonly z: number; readonly width: number; readonly height: number }
  | { readonly kind: "DeletePlane"; readonly plane: PlaneId }
  | { readonly kind: "MovePlane"; readonly plane: PlaneId; readonly z: number }
  | { readonly kind: "MoveLayer"; readonly document: DocumentId; readonly from: number; readonly to: number }
  | { readonly kind: "RenamePlane"; readonly plane: PlaneId; readonly name: string }
  | { readonly kind: "ExtractNamedPlane"; readonly document: DocumentId; readonly z: number; readonly name: string }
  | { readonly kind: "InlineNamedPlane"; readonly document: DocumentId; readonly z: number }
  | { readonly kind: "EditDeclaration"; readonly node: NodeId; readonly text: string }
  | { readonly kind: "EditSignature"; readonly plane: PlaneId; readonly signature: string };

export class EditError extends Error {}

type MutablePlane = { id: PlaneId; name: string | null; signature: string | null; comments: PlaneEntry["comments"]; grid: (CellEntry | null)[][] };

// One document's structure, being edited.
export class Draft {
  readonly planes = new Map<PlaneId, MutablePlane>();
  volume: SlotEntry[];
  definitions: PlaneId[];
  declarations: DeclEntry[];

  constructor(
    readonly document: DocumentId,
    private readonly base: Structure,
    private readonly newId: NewId,
  ) {
    for (const p of base.planes.values()) this.planes.set(p.id, { ...p, grid: p.grid.map((r) => [...r]) });
    this.volume = [...base.volume];
    this.definitions = [...base.definitions];
    this.declarations = [...base.declarations];
  }

  // ---- Lookups.
  plane(id: PlaneId): MutablePlane {
    const p = this.planes.get(id);
    if (!p) throw new EditError(`plane ${id} does not exist`);
    return p;
  }
  find(cell: CellId): { plane: MutablePlane; x: number; y: number; entry: CellEntry } | null {
    for (const plane of this.planes.values()) {
      for (let y = 0; y < plane.grid.length; y += 1) {
        const row = plane.grid[y] as (CellEntry | null)[];
        for (let x = 0; x < row.length; x += 1) if (row[x]?.id === cell) return { plane, x, y, entry: row[x] as CellEntry };
      }
    }
    return null;
  }
  has(cell: CellId): boolean {
    return this.find(cell) !== null;
  }
  private cell(cell: CellId) {
    const found = this.find(cell);
    if (!found) throw new EditError(`cell ${cell} does not exist`);
    return found;
  }
  private put(plane: MutablePlane, x: number, y: number, entry: CellEntry | null) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 4096 || y > 4096) throw new EditError(`(${x},${y}) is not a position in a plane`);
    while (plane.grid.length <= y) plane.grid.push(new Array<CellEntry | null>(plane.grid[0]?.length ?? 0).fill(null));
    const width = Math.max(x + 1, ...plane.grid.map((r) => r.length));
    for (const row of plane.grid) while (row.length < width) row.push(null);
    (plane.grid[y] as (CellEntry | null)[])[x] = entry;
  }
  private occupied(plane: MutablePlane, x: number, y: number): CellEntry | null {
    return plane.grid[y]?.[x] ?? null;
  }
  private fresh(text: string | null): CellEntry {
    return { id: this.newId("cell"), node: text === null ? null : this.newId("node"), text };
  }
  private slotOf(plane: PlaneId): number[] {
    return this.volume.flatMap((s, z) => ("plane" in s && s.plane === plane ? [z] : []));
  }
  private checkName(name: string, except: PlaneId | null) {
    if (!PLANE_NAME_PATTERN.test(name)) throw new EditError(`'${name}' is not a valid plane name`);
    for (const p of this.planes.values()) if (p.name === name && p.id !== except) throw new EditError(`a plane named ':${name}:' already exists`);
  }

  // ---- Commands. Each returns the ids it created.
  apply(c: Command): readonly string[] {
    switch (c.kind) {
      case "InsertCell": {
        const plane = this.plane(c.plane);
        if (this.occupied(plane, c.x, c.y)) throw new EditError(`(${c.x},${c.y}) in plane ${c.plane} already has a cell`);
        const entry = this.fresh(c.sentence);
        this.put(plane, c.x, c.y, entry);
        return [entry.id];
      }
      case "DeleteCell": {
        const { plane, x, y } = this.cell(c.cell);
        (plane.grid[y] as (CellEntry | null)[])[x] = null;
        return [];
      }
      case "MakeVoid": {
        const { plane, x, y, entry } = this.cell(c.cell);
        if (entry.text !== null) throw new EditError(`cell ${c.cell} has a sentence: only a blank cell becomes VOID (make it blank first, or delete it)`);
        (plane.grid[y] as (CellEntry | null)[])[x] = null;
        return [];
      }
      case "MakeBlank": {
        const { plane, x, y, entry } = this.cell(c.cell);
        (plane.grid[y] as (CellEntry | null)[])[x] = { id: entry.id, node: null, text: null };
        return [];
      }
      case "EditSentence": {
        const { plane, x, y, entry } = this.cell(c.cell);
        const text = c.sentence.trim().replace(/\s+/g, " ");
        if (text.length === 0) throw new EditError("a sentence is not empty: use MakeBlank");
        if (/[[\]⟦⟧\n]/u.test(text)) throw new EditError("a sentence cannot contain brackets or line breaks");
        // The same sentence keeps its statement's id; a changed one is a new statement.
        (plane.grid[y] as (CellEntry | null)[])[x] = { id: entry.id, node: entry.text === text && entry.node ? entry.node : this.newId("node"), text };
        return [];
      }
      case "MoveCell": {
        const { plane, x, y, entry } = this.cell(c.cell);
        const to = this.plane(c.plane);
        if (this.occupied(to, c.x, c.y)) throw new EditError(`(${c.x},${c.y}) in plane ${c.plane} is occupied: a move never overwrites a cell (swap with it instead)`);
        (plane.grid[y] as (CellEntry | null)[])[x] = null;
        this.put(to, c.x, c.y, entry);
        return [];
      }
      case "SwapCells": {
        const a = this.cell(c.a);
        const b = this.cell(c.b);
        (a.plane.grid[a.y] as (CellEntry | null)[])[a.x] = b.entry;
        (b.plane.grid[b.y] as (CellEntry | null)[])[b.x] = a.entry;
        return [];
      }
      case "CopyCell": {
        const { entry } = this.cell(c.cell);
        const to = this.plane(c.plane);
        if (this.occupied(to, c.x, c.y)) throw new EditError(`(${c.x},${c.y}) in plane ${c.plane} is occupied`);
        const copy = this.fresh(entry.text); // a copy is a new cell
        this.put(to, c.x, c.y, copy);
        return [copy.id];
      }
      case "InsertRow": {
        const plane = this.plane(c.plane);
        if (c.y < 0 || c.y > plane.grid.length) throw new EditError(`row ${c.y} is outside the plane`);
        const row = Array.from({ length: plane.grid[0]?.length ?? 1 }, () => this.fresh(null));
        plane.grid.splice(c.y, 0, row);
        return row.map((e) => e.id);
      }
      case "DeleteRow": {
        const plane = this.plane(c.plane);
        if (c.y < 0 || c.y >= plane.grid.length) throw new EditError(`row ${c.y} is outside the plane`);
        plane.grid.splice(c.y, 1);
        return [];
      }
      case "InsertColumn": {
        const plane = this.plane(c.plane);
        const width = plane.grid[0]?.length ?? 0;
        if (c.x < 0 || c.x > width) throw new EditError(`column ${c.x} is outside the plane`);
        return plane.grid.map((row) => {
          const e = this.fresh(null);
          row.splice(c.x, 0, e);
          return e.id;
        });
      }
      case "DeleteColumn": {
        const plane = this.plane(c.plane);
        if (c.x < 0 || c.x >= (plane.grid[0]?.length ?? 0)) throw new EditError(`column ${c.x} is outside the plane`);
        for (const row of plane.grid) row.splice(c.x, 1);
        return [];
      }
      case "InsertPlane": {
        if (c.z < 0 || c.z > this.volume.length) throw new EditError(`z=${c.z} is outside the volume`);
        if (!(c.width >= 1 && c.height >= 1 && c.width <= 256 && c.height <= 256)) throw new EditError("a plane is at least 1×1");
        const id = this.newId("plane");
        const grid = Array.from({ length: c.height }, () => Array.from({ length: c.width }, () => this.fresh(null)));
        this.planes.set(id, { id, name: null, signature: null, comments: [], grid });
        this.volume.splice(c.z, 0, { plane: id, comments: [] });
        return [id, ...grid.flat().map((e) => e.id)];
      }
      case "DeletePlane": {
        const plane = this.plane(c.plane);
        if (plane.name === null) {
          this.volume = this.volume.filter((s) => !("plane" in s && s.plane === c.plane));
        } else {
          const placed = this.slotOf(c.plane);
          if (placed.length > 0) throw new EditError(`':${plane.name}:' is placed on floor${placed.length > 1 ? "s" : ""} ${placed.join(", ")}: remove the placements first`);
          this.definitions = this.definitions.filter((d) => d !== c.plane);
        }
        this.planes.delete(c.plane);
        return [];
      }
      case "MovePlane": {
        const slots = this.slotOf(c.plane);
        if (slots.length !== 1) throw new EditError(`plane ${c.plane} is on ${slots.length} floors: move a floor with MoveLayer`);
        return this.apply({ kind: "MoveLayer", document: this.document, from: slots[0] as number, to: c.z });
      }
      case "MoveLayer": {
        if (c.from < 0 || c.from >= this.volume.length || c.to < 0 || c.to >= this.volume.length) throw new EditError("a floor index is outside the volume");
        const [slot] = this.volume.splice(c.from, 1);
        this.volume.splice(c.to, 0, slot as SlotEntry);
        return [];
      }
      case "RenamePlane": {
        const plane = this.plane(c.plane);
        if (plane.name === null) throw new EditError(`plane ${c.plane} is an inline floor: it has no name (extract it first)`);
        this.checkName(c.name, plane.id);
        plane.name = c.name; // its placements follow: they refer to the plane, not to the name
        return [];
      }
      case "ExtractNamedPlane": {
        const slot = this.volume[c.z];
        if (!slot || !("plane" in slot)) throw new EditError(`there is no floor z=${c.z}`);
        const plane = this.plane(slot.plane);
        if (plane.name !== null) throw new EditError(`floor z=${c.z} is already the named plane ':${plane.name}:'`);
        this.checkName(c.name, null);
        // The same plane and the same cells, now named; the floor becomes a placement.
        plane.name = c.name;
        this.definitions.push(plane.id);
        return [];
      }
      case "InlineNamedPlane": {
        const slot = this.volume[c.z];
        if (!slot || !("plane" in slot)) throw new EditError(`there is no floor z=${c.z}`);
        const named = this.plane(slot.plane);
        if (named.name === null) throw new EditError(`floor z=${c.z} is already inline`);
        // Copies: the named plane may be placed on other floors too.
        const id = this.newId("plane");
        const grid = named.grid.map((row) => row.map((e) => this.fresh(e?.text ?? null)));
        this.planes.set(id, { id, name: null, signature: null, comments: [], grid });
        this.volume[c.z] = { plane: id, comments: [...slot.comments] };
        if (named.signature === null && this.slotOf(named.id).length === 0) {
          this.volume[c.z] = { plane: id, comments: [...slot.comments, ...named.comments] };
          this.definitions = this.definitions.filter((d) => d !== named.id);
          this.planes.delete(named.id);
        }
        return [id, ...grid.flat().map((e) => e.id)];
      }
      case "EditSignature": {
        const plane = this.plane(c.plane);
        if (plane.signature === null) throw new EditError(`plane ${c.plane} is not callable: it has no signature`);
        const signature = c.signature.trim().replace(/\s+/g, " ");
        if (!signature.startsWith("(") || /[⟦⟧\n]/u.test(signature)) throw new EditError("a signature is written '(이름: 타입, …) → 타입'");
        plane.signature = signature;
        return [];
      }
      case "EditDeclaration": {
        const i = this.declarations.findIndex((d) => d.node === c.node);
        if (i < 0) throw new EditError(`declaration ${c.node} does not exist`);
        const old = this.declarations[i] as DeclEntry;
        const text = c.text.trim().replace(/\s+/g, " ");
        const name = text.match(/^자료\s+([\p{L}_][\p{L}\p{N}_]*)/u)?.[1] ?? text.match(/^외부\s+([\p{L}_][\p{L}\p{N}_]*\s+[\p{L}_][\p{L}\p{N}_]*)/u)?.[1];
        if (!name || text.includes("\n")) throw new EditError("a declaration is one line: '자료 이름 = …' or '외부 라이브러리 이름 …'");
        this.declarations[i] = { ...old, name, text, node: text === old.text ? old.node : this.newId("node") };
        return [];
      }
    }
  }

  // The structure, if it is one: rows and columns emptied by the edit are removed, and
  // every plane must then be a non-empty rectangle with no hole.
  commit(): Structure {
    const planes = new Map<PlaneId, PlaneEntry>();
    for (const p of this.planes.values()) {
      let grid = p.grid.filter((row) => row.some((e) => e !== null));
      const width = Math.max(0, ...grid.map((r) => r.length));
      const keep = Array.from({ length: width }, (_, x) => grid.some((r) => r[x] != null));
      grid = grid.map((r) => Array.from({ length: width }, (_, x) => r[x] ?? null).filter((_, x) => keep[x]));
      if (grid.length === 0) {
        if (p.name === null && this.volume.some((s) => "plane" in s && s.plane === p.id)) throw new EditError(`the edit leaves floor ${p.id} with no cells: delete the plane instead`);
        if (p.name !== null) throw new EditError(`the edit leaves ':${p.name}:' with no cells`);
        continue;
      }
      if (grid.some((r) => r.some((e) => e === null))) throw new EditError(`the edit leaves a hole in plane ${p.name ? `:${p.name}:` : p.id}: planes are rectangles (use MakeBlank, or fill the gap)`);
      planes.set(p.id, { id: p.id, name: p.name, signature: p.signature, comments: p.comments, grid: grid as CellEntry[][] });
    }
    // Inline planes are on exactly one floor; named planes are definitions.
    const seen = new Set<PlaneId>();
    for (const s of this.volume) {
      if (!("plane" in s)) continue;
      const p = planes.get(s.plane);
      if (!p) throw new EditError(`a floor refers to plane ${s.plane}, which no longer exists`);
      if (p.name === null && seen.has(p.id)) throw new EditError(`inline plane ${p.id} is on two floors`);
      seen.add(p.id);
    }
    const definitions = this.definitions.filter((d) => planes.has(d));
    for (const p of planes.values()) {
      if (p.name !== null && !definitions.includes(p.id)) throw new EditError(`named plane ':${p.name}:' is not in the ※ section`);
      if (p.name === null && !seen.has(p.id)) throw new EditError(`inline plane ${p.id} is not on any floor`);
    }
    const names = [...planes.values()].flatMap((p) => (p.name === null ? [] : [p.name]));
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) throw new EditError(`two planes are named ':${twice}:'`);
    return { ...this.base, volume: this.volume, planes, definitions, declarations: this.declarations };
  }
}
