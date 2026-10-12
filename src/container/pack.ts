import type { DefinitionAst, DocumentAst } from "../language/ast";
import { DIAGNOSTIC_CODES as CODES, Y3DocumentError, type Diagnostic } from "../language/diagnostics";
import { parseDocument } from "../language/document-parser";
import { formatDocument } from "../format/formatter";

// The folder form of a .y3 document, produced only on request:
//
//   META-INF/manifest.toml   front matter, if any
//   space/main.y3s           the volume (inline planes stay inline), plus the ※ section's
//                            comments and type declarations (자료 …), when there are any
//   planes/<name>.y2         one named plane per file; a callable plane's file opens
//                            with its signature: "(수: Int) → Int ⟦"
//
// A folder has no order; the formatter puts the ※ section in its one canonical order
// (first use, then lexical), so pack(unpack(doc)) is exactly formatDocument(doc).

export const MANIFEST_PATH = "META-INF/manifest.toml";
export const MAIN_PATH = "space/main.y3s";
export const PLANES_DIR = "planes/";
export const PLANE_EXTENSION = ".y2";

export type FileMap = Map<string, string>;

const NO_SPAN = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

function error(code: string, message: string): Diagnostic {
  return { code, severity: "error", message, span: NO_SPAN };
}

function parseOrThrow(source: string, path: string): DocumentAst {
  const parsed = parseDocument(source);
  if (!parsed.ok) {
    throw new Y3DocumentError(parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${path}: ${diagnostic.message}` })));
  }
  return parsed.ast;
}

export function unpackDocument(source: string): FileMap {
  const ast = parseOrThrow(source, "<document>");
  const files: FileMap = new Map();

  if (ast.frontMatter) {
    files.set(MANIFEST_PATH, ast.frontMatter.text.length > 0 ? `${ast.frontMatter.text}\n` : "");
  }

  const appendixComments = ast.appendix?.comments ?? [];
  const declarations = ast.appendix?.declarations ?? [];
  const library = ast.volume.length === 0;
  const main: DocumentAst = {
    frontMatter: null,
    volume: ast.volume,
    appendix:
      library || appendixComments.length > 0 || declarations.length > 0
        ? { comments: appendixComments, declarations, definitions: [], span: NO_SPAN }
        : null,
    trailingComments: ast.trailingComments,
  };
  files.set(MAIN_PATH, formatDocument(main));

  const seen = new Map<string, string>();
  for (const definition of ast.appendix?.definitions ?? []) {
    const folded = definition.name.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) {
      throw new Y3DocumentError([
        error(
          clash === definition.name ? CODES.DUPLICATE_PLANE : CODES.NAME_COLLISION,
          clash === definition.name
            ? `plane ':${definition.name}:' is defined more than once`
            : `planes ':${clash}:' and ':${definition.name}:' would share a file name on case-insensitive file systems`,
        ),
      ]);
    }
    seen.set(folded, definition.name);
    const planeFile: DocumentAst = {
      frontMatter: null,
      volume: [{ plane: definition.plane, comments: definition.comments }],
      appendix: null,
      trailingComments: [],
    };
    const text = formatDocument(planeFile);
    // The plane's own "⟦" line (after any comments) carries the signature.
    const withSignature =
      definition.signature === null ? text : text.replace(/^⟦$/mu, `${definition.signature} ⟦`);
    files.set(`${PLANES_DIR}${definition.name}${PLANE_EXTENSION}`, withSignature);
  }
  return files;
}

function readPlaneFile(path: string, source: string): DefinitionAst {
  const name = path.slice(PLANES_DIR.length, -PLANE_EXTENSION.length);
  // A callable plane's file opens with "(signature) ⟦"; the rest is an ordinary plane.
  let signature: string | null = null;
  const lines = source.split(/\r\n|\n|\r/);
  const open = lines.findIndex((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  const head = lines[open]?.trim() ?? "";
  if (head.startsWith("(") && head.includes("⟦")) {
    signature = head.slice(0, head.indexOf("⟦")).trim().replace(/\s+/g, " ");
    lines[open] = head.slice(head.indexOf("⟦"));
  }
  const ast = parseOrThrow(lines.join("\n"), path);
  const slot = ast.volume[0];
  if (
    ast.volume.length !== 1 ||
    !slot ||
    slot.plane.kind !== "inline" ||
    ast.frontMatter !== null ||
    ast.appendix !== null ||
    ast.trailingComments.length > 0
  ) {
    throw new Y3DocumentError([
      error(CODES.BAD_PLANE_FILE, `${path}: a .y2 file holds exactly one written-out plane (comments may precede it)`),
    ]);
  }
  return { name, signature, plane: slot.plane, comments: slot.comments, span: NO_SPAN };
}

export function packDocument(files: FileMap): string {
  const mainSource = files.get(MAIN_PATH);
  if (mainSource === undefined) {
    throw new Y3DocumentError([error(CODES.MISSING_MAIN, `missing ${MAIN_PATH}`)]);
  }

  const planeFiles: DefinitionAst[] = [];
  for (const [path, content] of files) {
    if (path === MAIN_PATH || path === MANIFEST_PATH) {
      continue;
    }
    if (path.startsWith(PLANES_DIR) && path.endsWith(PLANE_EXTENSION) && !path.slice(PLANES_DIR.length).includes("/")) {
      planeFiles.push(readPlaneFile(path, content));
      continue;
    }
    throw new Y3DocumentError([error(CODES.UNKNOWN_FILE, `unexpected file '${path}' in an unpacked Y3 document`)]);
  }

  const main = parseOrThrow(mainSource, MAIN_PATH);
  if (main.frontMatter !== null) {
    throw new Y3DocumentError([
      error(CODES.FRONT_MATTER_IN_MAIN, `${MAIN_PATH} cannot have front matter; the manifest lives in ${MANIFEST_PATH}`),
    ]);
  }

  const definitions = [...(main.appendix?.definitions ?? []), ...planeFiles];
  const declarations = main.appendix?.declarations ?? [];
  const manifest = files.get(MANIFEST_PATH);
  const document: DocumentAst = {
    frontMatter: manifest === undefined ? null : { text: manifest.replace(/\s+$/, ""), span: NO_SPAN },
    volume: main.volume,
    appendix:
      main.volume.length === 0 || definitions.length > 0 || declarations.length > 0 || (main.appendix?.comments.length ?? 0) > 0
        ? { comments: main.appendix?.comments ?? [], declarations, definitions, span: NO_SPAN }
        : null,
    trailingComments: main.trailingComments,
  };
  return formatDocument(document);
}
