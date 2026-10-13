import type { CellIds } from "../ir/identity";

// Syntax tree of a Y3 document. It records what was written (including comments and
// whether a plane was inline or referenced) but nothing about how a program runs.

export type Position = { line: number; column: number }; // 1-based; column in UTF-16 units
export type Span = { start: Position; end: Position };

export type Comment = { text: string; span: Span }; // text after "#", trailing spaces removed

export type CellAst = {
  // null for an empty cell "[ ]". Otherwise the sentence, with whitespace outside quotes
  // collapsed to single spaces and trimmed.
  text: string | null;
  span: Span;
  // Stable identities, attached by the editor model (src/editor) and carried by the
  // compiler into provenance, the debug map and traces. Never set by the parser.
  ids?: CellIds;
};

export type RowAst = { cells: CellAst[]; span: Span };

export type InlinePlaneAst = { kind: "inline"; rows: RowAst[]; span: Span };
export type PlaneRefAst = { kind: "ref"; name: string; span: Span };

export type PlaneSlotAst = {
  plane: InlinePlaneAst | PlaneRefAst;
  comments: Comment[];
};

export type DefinitionAst = {
  name: string;
  // A callable plane's signature as written between ':name:' and '⟦', e.g.
  // "(수: Int) → Int"; null for a plane that is only ever placed in the volume.
  // Kept as text, like a cell's sentence; semantics/ parses it.
  signature: string | null;
  plane: InlinePlaneAst;
  comments: Comment[];
  span: Span;
};

// A type declaration in the ※ section, one line: "자료 점 = { 가로: Int, 세로: Int }".
// Kept as text (whitespace collapsed); semantics/ parses it.
export type DeclarationAst = {
  name: string;
  text: string;
  comments: Comment[];
  span: Span;
};

export type AppendixAst = {
  comments: Comment[]; // comments written just before "※"
  declarations: DeclarationAst[];
  definitions: DefinitionAst[];
  span: Span;
};

export type FrontMatterAst = { text: string; span: Span };

export type DocumentAst = {
  frontMatter: FrontMatterAst | null;
  volume: PlaneSlotAst[]; // index = z; empty only in a library module, which has a ※ section
  appendix: AppendixAst | null;
  trailingComments: Comment[];
};

// Deep copy without source positions, for comparing documents structurally.
export function withoutSpans<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((item) => withoutSpans(item)) as T;
  }
  if (node !== null && typeof node === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== "span") {
        copy[key] = withoutSpans(value);
      }
    }
    return copy as T;
  }
  return node;
}

export function sameDocument(a: DocumentAst, b: DocumentAst): boolean {
  return JSON.stringify(withoutSpans(a)) === JSON.stringify(withoutSpans(b));
}
