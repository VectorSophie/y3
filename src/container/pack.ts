import type { DefinitionAst, DocumentAst } from "../language/ast";
import { DIAGNOSTIC_CODES as CODES, Y3DocumentError, type Diagnostic } from "../language/diagnostics";
import { parseDocument } from "../language/document-parser";
import { formatDocument } from "../format/formatter";

// The folder form of a .y3 document, produced only on request:
//
//   META-INF/manifest.toml   front matter, if any
//   space/main.y3s           the volume (inline planes stay inline), plus a bare "※"
//                            line when comments belong to the ※ section
//   planes/<name>.y2         one named plane per file
//
// A folder has no order, so pack() lists named planes by first use in the volume, then
// unused ones by name. pack(unpack(doc)) is the canonical formatting of doc.

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
  const main: DocumentAst = {
    frontMatter: null,
    volume: ast.volume,
    appendix: appendixComments.length > 0 ? { comments: appendixComments, definitions: [], span: NO_SPAN } : null,
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
    files.set(`${PLANES_DIR}${definition.name}${PLANE_EXTENSION}`, formatDocument(planeFile));
  }
  return files;
}

function readPlaneFile(path: string, source: string): DefinitionAst {
  const name = path.slice(PLANES_DIR.length, -PLANE_EXTENSION.length);
  const ast = parseOrThrow(source, path);
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
  return { name, plane: slot.plane, comments: slot.comments, span: NO_SPAN };
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

  const firstUse = new Map<string, number>();
  main.volume.forEach((slot, z) => {
    if (slot.plane.kind === "ref" && !firstUse.has(slot.plane.name)) {
      firstUse.set(slot.plane.name, z);
    }
  });
  planeFiles.sort((a, b) => {
    const za = firstUse.get(a.name) ?? Number.POSITIVE_INFINITY;
    const zb = firstUse.get(b.name) ?? Number.POSITIVE_INFINITY;
    if (za !== zb) return za - zb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const definitions = [...(main.appendix?.definitions ?? []), ...planeFiles];
  const manifest = files.get(MANIFEST_PATH);
  const document: DocumentAst = {
    frontMatter: manifest === undefined ? null : { text: manifest.replace(/\s+$/, ""), span: NO_SPAN },
    volume: main.volume,
    appendix:
      definitions.length > 0 || (main.appendix?.comments.length ?? 0) > 0
        ? { comments: main.appendix?.comments ?? [], definitions, span: NO_SPAN }
        : null,
    trailingComments: main.trailingComments,
  };
  return formatDocument(document);
}
