import type { DocumentAst, InlinePlaneAst, Span } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { parseSentence, SENTENCE_CODES } from "../language/sentence-parser";
import type { Noun, Provenance, Stmt } from "../ir/hir";
import type { Coordinate } from "../space/manifest";
import type { Space } from "../space/volume";
import { checkProgram } from "../types/check";
import { elaborate, ElaborationError, nounsIn, NounTable } from "./elaborate";

// A compiled program: every non-blank cell of the space, parsed, elaborated into HIR
// and type checked once, before anything runs. Sentence and type errors are found
// here, with source positions, rather than in the middle of a run. The runtime sees
// only the HIR.
//
//   sentence AST → elaborate (names, calls) → HIR → check (types) → typed HIR

export type CompiledProgram = {
  readonly space: Space;
  readonly cells: ReadonlyMap<string, Stmt>; // key: "x,y,z"
  readonly nouns: readonly Noun[]; // with their inferred types
};

export function coordinateKey(at: Coordinate): string {
  return `${at.x},${at.y},${at.z}`;
}

// Where each layer's cells were written. A named plane used on two floors has one set
// of source cells, so its diagnostics are reported once.
function cellSources(ast: DocumentAst): (z: number, x: number, y: number) => { span: Span; name: string | null } | null {
  const definitions = new Map<string, InlinePlaneAst>((ast.appendix?.definitions ?? []).map((d) => [d.name, d.plane]));
  const planes = ast.volume.map((slot) =>
    slot.plane.kind === "inline"
      ? { plane: slot.plane, name: null }
      : { plane: definitions.get(slot.plane.name) ?? null, name: slot.plane.name },
  );
  return (z, x, y) => {
    const slot = planes[z];
    const span = slot?.plane?.rows[y]?.cells[x]?.span;
    return slot && span ? { span, name: slot.name } : null;
  };
}

const NOWHERE: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

export function compileProgram(ast: DocumentAst, space: Space): { program: CompiledProgram | null; diagnostics: Diagnostic[] } {
  const sourceAt = cellSources(ast);
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (diagnostic: Diagnostic) => {
    const key = `${diagnostic.span.start.line}:${diagnostic.span.start.column}:${diagnostic.code}:${diagnostic.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    diagnostics.push(diagnostic);
  };
  const nouns = new NounTable();
  const cells = new Map<string, Stmt>();
  const uses = new Map<number, { span: Span }>();
  const introduced = new Set<number>();
  let unparsed = 0;

  for (const layer of space.layers) {
    layer.plane.rows.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell.sentence === null) return;
        const source = sourceAt(layer.z, x, y);
        const span = source?.span ?? NOWHERE;
        const result = parseSentence(cell.sentence);
        for (const issue of result.issues) report({ ...issue, message: `[${cell.sentence}] ${issue.message}`, span });
        if (!result.sentence) {
          unparsed += 1;
          return;
        }
        const at: Provenance = { span, plane: { slot: layer.z, name: source?.name ?? null }, cell: { x, y, z: layer.z }, source: cell.sentence };
        let stmt: Stmt;
        try {
          stmt = elaborate(result.sentence, at, nouns);
        } catch (error) {
          if (!(error instanceof ElaborationError)) throw error;
          report({ code: error.code, severity: "error", message: `[${cell.sentence}] ${error.message}`, span });
          unparsed += 1;
          return;
        }
        cells.set(coordinateKey(at.cell), stmt);
        const names = nounsIn(stmt);
        for (const id of names.introduces) introduced.add(id);
        for (const id of names.uses) if (!uses.has(id)) uses.set(id, { span });
      });
    });
  }

  const table = nouns.all();
  // A cell that did not parse might have given the name a value, so only judge names
  // when every cell parsed; otherwise the report would be noise.
  for (const [id, { span }] of unparsed > 0 ? [] : uses) {
    if (introduced.has(id)) continue;
    const name = table[id - 1]?.name ?? "";
    report({
      code: SENTENCE_CODES.NEVER_INTRODUCED,
      severity: "error",
      message: `'${name}' is used but never introduced: give it a value ('${name}은 3이다') or declare it ('${name}은 미정이다')`,
      span,
    });
  }

  // Types are checked once every cell is in hand, in source order, so the first
  // statement that pins a noun's type is the one reported against a later conflict.
  if (unparsed === 0) {
    for (const diagnostic of checkProgram(inSourceOrder(cells), table)) report(diagnostic);
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { program: null, diagnostics };
  }
  return { program: { space, cells, nouns: table }, diagnostics };
}

function inSourceOrder(cells: ReadonlyMap<string, Stmt>): Stmt[] {
  const position = (s: Stmt) => [s.at.span.start.line, s.at.span.start.column, s.at.cell.z] as const;
  return [...cells.values()].sort((a, b) => {
    const [la, ca, za] = position(a);
    const [lb, cb, zb] = position(b);
    return la - lb || ca - cb || za - zb;
  });
}
