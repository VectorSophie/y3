import type { Comment, DefinitionAst, DocumentAst, InlinePlaneAst, PlaneRefAst } from "../language/ast";
import { APPENDIX_STYLE, planeStyle, type PlaneStyle, type Projection } from "./projection";
import { displayWidth } from "./width";

// Canonical text for a document. Formatting changes only what carries no meaning:
// whitespace, and the order of the ※ section. parse(format(parse(s))) equals
// canonicalizeDocument(parse(s)) for every projection, which is parse(s) itself
// whenever s is already canonical.

export type FormatOptions = { projection?: Projection };

function renderCell(text: string | null): string {
  return `[${text ?? " "}]`;
}

function renderComments(comments: readonly Comment[], indent: string): string[] {
  return comments.map((comment) => `${indent}#${comment.text}`);
}

function renderRows(plane: InlinePlaneAst, style: PlaneStyle): string[] {
  const rows = plane.rows.map((row) => row.cells.map((cell) => renderCell(cell.text)));
  const widths: number[] = [];
  if (style.align) {
    for (const row of rows) {
      row.forEach((cell, x) => {
        widths[x] = Math.max(widths[x] ?? 0, displayWidth(cell));
      });
    }
  }
  const indent = " ".repeat(style.indent);
  const gap = " ".repeat(style.gap);
  return rows.map((row) => {
    let line = indent;
    row.forEach((cell, x) => {
      line += cell;
      if (x < row.length - 1) {
        const padding = style.align ? (widths[x] ?? 0) - displayWidth(cell) : 0;
        line += " ".repeat(padding) + gap;
      }
    });
    return line;
  });
}

function renderPlane(plane: InlinePlaneAst | PlaneRefAst, style: PlaneStyle): string[] {
  const indent = " ".repeat(style.indent);
  if (plane.kind === "ref") {
    return [`${indent}⟦ :${plane.name}: ⟧`];
  }
  return [`${indent}⟦`, ...renderRows(plane, style), `${indent}⟧`];
}

// The one canonical order of the ※ section, shared by fmt and pack: named planes in
// order of first use in the volume, then never-used planes in lexical (code point)
// order. Ties (duplicate names, an error caught later) keep their source order.
export function canonicalDefinitionOrder(volume: DocumentAst["volume"], definitions: readonly DefinitionAst[]): DefinitionAst[] {
  const firstUse = new Map<string, number>();
  volume.forEach((slot, z) => {
    if (slot.plane.kind === "ref" && !firstUse.has(slot.plane.name)) {
      firstUse.set(slot.plane.name, z);
    }
  });
  return [...definitions].sort((a, b) => {
    const za = firstUse.get(a.name) ?? Number.POSITIVE_INFINITY;
    const zb = firstUse.get(b.name) ?? Number.POSITIVE_INFINITY;
    if (za !== zb) return za - zb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function canonicalizeDocument(ast: DocumentAst): DocumentAst {
  if (!ast.appendix) {
    return ast;
  }
  return { ...ast, appendix: { ...ast.appendix, definitions: canonicalDefinitionOrder(ast.volume, ast.appendix.definitions) } };
}

export function formatDocument(source: DocumentAst, options: FormatOptions = {}): string {
  const ast = canonicalizeDocument(source);
  const projection = options.projection ?? "perspective";
  const blocks: string[][] = [];

  if (ast.frontMatter) {
    blocks.push(["+++", ...(ast.frontMatter.text.length > 0 ? ast.frontMatter.text.split("\n") : []), "+++"]);
  }

  ast.volume.forEach((slot, z) => {
    const style = planeStyle(projection, z);
    blocks.push([...renderComments(slot.comments, " ".repeat(style.indent)), ...renderPlane(slot.plane, style)]);
  });

  if (ast.appendix) {
    blocks.push([...renderComments(ast.appendix.comments, ""), "※"]);
    for (const definition of ast.appendix.definitions) {
      const [open, ...rest] = renderPlane(definition.plane, APPENDIX_STYLE);
      blocks.push([...renderComments(definition.comments, ""), `:${definition.name}: ${open}`, ...rest]);
    }
  }

  if (ast.trailingComments.length > 0) {
    blocks.push(renderComments(ast.trailingComments, ""));
  }

  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}
