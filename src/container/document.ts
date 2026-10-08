import type { DocumentAst } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { parseDocument } from "../language/document-parser";
import { buildSpace, type Space } from "../space/volume";

// A .y3 file is one plain-text document holding the whole space: front matter
// (manifest), the volume, and the ※ section of named planes.

export const Y3_EXTENSION = ".y3";

export type LoadedDocument = {
  ast: DocumentAst | null;
  space: Space | null;
  diagnostics: Diagnostic[];
};

export function loadDocument(source: string): LoadedDocument {
  const parsed = parseDocument(source);
  if (!parsed.ok) {
    return { ast: null, space: null, diagnostics: parsed.diagnostics };
  }
  const built = buildSpace(parsed.ast);
  return { ast: parsed.ast, space: built.space, diagnostics: built.diagnostics };
}

// v2 documents are made of planes; v1 files never contain "⟦".
export function looksLikeV2(source: string): boolean {
  return source.includes("⟦");
}
