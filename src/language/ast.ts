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
  plane: InlinePlaneAst;
  comments: Comment[];
  span: Span;
};

export type AppendixAst = {
  comments: Comment[]; // comments written just before "※"
  definitions: DefinitionAst[];
  span: Span;
};

export type FrontMatterAst = { text: string; span: Span };

export type DocumentAst = {
  frontMatter: FrontMatterAst | null;
  volume: PlaneSlotAst[]; // index = z
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
