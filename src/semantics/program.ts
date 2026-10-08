import type { DocumentAst, InlinePlaneAst, Span } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { parseSentence, SENTENCE_CODES } from "../language/sentence-parser";
import type { Coordinate } from "../space/manifest";
import type { Space } from "../space/volume";
import { lower, namesIn } from "./lower";
import type { Operation } from "./operations";

// A compiled program: every non-blank cell of the space, parsed and lowered once,
// before anything runs. Sentence errors are found here, with source positions, rather
// than in the middle of a run.

export type CompiledProgram = {
  readonly space: Space;
  readonly operations: ReadonlyMap<string, Operation>; // key: "x,y,z"
};

export function coordinateKey(at: Coordinate): string {
  return `${at.x},${at.y},${at.z}`;
}

// Where each layer's cells were written. A named plane used on two floors has one set
// of source cells, so its diagnostics are reported once.
function cellSpans(ast: DocumentAst): (z: number, x: number, y: number) => Span | null {
  const definitions = new Map<string, InlinePlaneAst>((ast.appendix?.definitions ?? []).map((d) => [d.name, d.plane]));
  const planes = ast.volume.map((slot) => (slot.plane.kind === "inline" ? slot.plane : (definitions.get(slot.plane.name) ?? null)));
  return (z, x, y) => planes[z]?.rows[y]?.cells[x]?.span ?? null;
}

const NOWHERE: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

export function compileProgram(ast: DocumentAst, space: Space): { program: CompiledProgram | null; diagnostics: Diagnostic[] } {
  const spanAt = cellSpans(ast);
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const operations = new Map<string, Operation>();
  const reads = new Map<string, { span: Span }>();
  const written = new Set<string>();
  let unparsed = 0;

  for (const layer of space.layers) {
    layer.plane.rows.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell.sentence === null) return;
        const span = spanAt(layer.z, x, y) ?? NOWHERE;
        const result = parseSentence(cell.sentence);
        for (const issue of result.issues) {
          const key = `${span.start.line}:${span.start.column}:${issue.code}:${issue.message}`;
          if (reported.has(key)) continue;
          reported.add(key);
          diagnostics.push({ ...issue, message: `[${cell.sentence}] ${issue.message}`, span });
        }
        if (!result.sentence) {
          unparsed += 1;
          return;
        }
        const operation = lower(result.sentence);
        operations.set(coordinateKey({ x, y, z: layer.z }), operation);
        const names = namesIn(operation);
        for (const name of names.writes) written.add(name);
        for (const name of names.reads) if (!reads.has(name)) reads.set(name, { span });
      });
    });
  }

  // A cell that did not parse might have given the name a value, so only judge names
  // when every cell parsed; otherwise the report would be noise.
  for (const [name, { span }] of unparsed > 0 ? [] : reads) {
    if (!written.has(name)) {
      diagnostics.push({
        code: SENTENCE_CODES.NEVER_ASSIGNED,
        severity: "error",
        message: `'${name}' is read, but no sentence ever gives it a value`,
        span,
      });
    }
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { program: null, diagnostics };
  }
  return { program: { space, operations }, diagnostics };
}
