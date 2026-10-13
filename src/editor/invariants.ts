import type { CellId, NodeId } from "../ir/identity";
import type { ProgramModel } from "./model";

// The model's invariants (docs/v2-editor-model.md), checked through the public queries
// only. Returns the violations; tests and the mutation fuzzer assert it is empty after
// every edit, undo and redo.
export function modelViolations(model: ProgramModel): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  const unique = (id: string, what: string) => {
    if (seen.has(id)) out.push(`${what} ${id} is also ${seen.get(id)}`);
    seen.set(id, what);
  };
  const cells = new Set<CellId>();
  for (const d of model.documents()) {
    const doc = model.getDocument(d);
    unique(doc.id, "document");
    unique(doc.module, "module");
    const placed = new Set(doc.floors.filter((p) => p !== null));
    for (const p of doc.planes) {
      unique(p, "plane");
      const plane = model.getPlane(p);
      if (plane.document !== d) out.push(`plane ${p} says it belongs to ${plane.document}`);
      if (plane.kind === "floor" && plane.floors.length !== 1) out.push(`inline plane ${p} is on ${plane.floors.length} floors`);
      if (plane.kind === "callable" && placed.has(p)) out.push(`callable plane ${p} is placed in the volume`);
      if (plane.height === 0 || plane.cells.some((r) => r.length !== plane.width)) out.push(`plane ${p} is not a non-empty rectangle`);
      plane.cells.forEach((row, y) =>
        row.forEach((id, x) => {
          unique(id, "cell");
          cells.add(id);
          const c = model.getCell(id);
          if (c.plane !== p || c.x !== x || c.y !== y) out.push(`cell ${id} says it is at ${c.plane} (${c.x},${c.y}), not ${p} (${x},${y})`);
          if (model.cellAt(p, x, y) !== id) out.push(`cellAt(${p}, ${x}, ${y}) is not ${id}`);
          if (c.blank !== (c.node === null)) out.push(`cell ${id}: a blank cell has no statement, and only a blank cell`);
          if (c.node) unique(c.node, "statement");
          if (!doc.broken) {
            if (!c.span) out.push(`cell ${id} has no source span`);
            else if (model.cellAtSourcePosition(d, c.span.start.line, c.span.start.column) !== id) out.push(`the source map sends cell ${id}'s span to another element`);
          }
        }),
      );
      // VOID has no cell: just outside the rectangle.
      if (model.cellAt(p, plane.width, 0) !== null || model.cellAt(p, 0, plane.height) !== null) out.push(`plane ${p} has a cell outside its rectangle`);
    }
    if (doc.broken) continue;
    // HIR and MIR point at cells that exist, with their current statements.
    for (const [cell, stmt] of model.statements(d)) {
      if (!cells.has(cell)) out.push(`HIR provenance names cell ${cell}, which does not exist`);
      else if (stmt.at.ids?.node !== model.getCell(cell).node) out.push(`HIR of cell ${cell} has statement ${stmt.at.ids?.node}, the model ${model.getCell(cell).node}`);
    }
    for (const i of model.instructions(d)) {
      if (!cells.has(i.cell)) out.push(`MIR ${i.id} names cell ${i.cell}, which does not exist`);
      else if (i.node !== model.getCell(i.cell).node) out.push(`MIR ${i.id} has statement ${i.node as NodeId}, the model ${model.getCell(i.cell).node}`);
    }
  }
  return out;
}
