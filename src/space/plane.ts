import type { InlinePlaneAst } from "../language/ast";
import type { CellIds } from "../ir/identity";

// A Y2 plane: a rectangle of cells. A cell holds a sentence (still unparsed in M0) or
// is blank. Blank cells exist; positions outside the rectangle do not (they are VOID).

export type Cell = { readonly sentence: string | null; readonly ids?: CellIds }; // ids: from the editor model, if any

export type Plane = {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly (readonly Cell[])[]; // rows[y][x]
};

export function planeFromAst(ast: InlinePlaneAst): Plane {
  const rows = ast.rows.map((row) => row.cells.map((cell): Cell => (cell.ids ? { sentence: cell.text, ids: cell.ids } : { sentence: cell.text })));
  return { width: rows[0]?.length ?? 0, height: rows.length, rows };
}

export function cellOf(plane: Plane, x: number, y: number): Cell | null {
  return plane.rows[y]?.[x] ?? null;
}
