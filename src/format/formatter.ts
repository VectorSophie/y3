import type { Comment, DocumentAst, InlinePlaneAst, PlaneRefAst } from "../language/ast";
import { APPENDIX_STYLE, planeStyle, type PlaneStyle, type Projection } from "./projection";
import { displayWidth } from "./width";

// Canonical text for a document. Formatting never changes the AST (other than source
// positions): parse(format(parse(s))) equals parse(s) for every projection.

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

export function formatDocument(ast: DocumentAst, options: FormatOptions = {}): string {
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
