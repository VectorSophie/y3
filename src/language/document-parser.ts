import type {
  CellAst,
  Comment,
  DefinitionAst,
  DocumentAst,
  FrontMatterAst,
  InlinePlaneAst,
  PlaneRefAst,
  PlaneSlotAst,
  Position,
  RowAst,
  Span,
} from "./ast";
import { DIAGNOSTIC_CODES as CODES, type Diagnostic } from "./diagnostics";

// Parses the text of a .y3 document into an AST. Only layout is read here: sentences
// inside cells are kept as text. Indentation and gaps between cells are never read
// (indentation is projection, not syntax).

export type ParseResult =
  | { ok: true; ast: DocumentAst; diagnostics: Diagnostic[] }
  | { ok: false; ast: null; diagnostics: Diagnostic[] };

const PLANE_OPEN = "⟦";
const PLANE_CLOSE = "⟧";
const APPENDIX_MARK = "※";
const FRONT_MATTER_FENCE = "+++";

export const PLANE_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
const DEFINITION_HEAD = /^:([^:\s]*):\s*(.*)$/u;

class SyntaxFailure extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

function fail(code: string, message: string, span: Span): never {
  throw new SyntaxFailure({ code, severity: "error", message, span });
}

function pos(line: number, column: number): Position {
  return { line, column };
}

function spanOf(line: number, startColumn: number, endLine: number, endColumn: number): Span {
  return { start: pos(line, startColumn), end: pos(endLine, endColumn) };
}

function lineSpan(lineIndex: number, text: string): Span {
  return spanOf(lineIndex + 1, 1, lineIndex + 1, text.length + 1);
}

function leadingWhitespace(text: string): number {
  return text.length - text.trimStart().length;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

// Whitespace runs outside quotes become one space; the result is trimmed.
export function normalizeCellText(raw: string): string | null {
  let out = "";
  let inQuote = false;
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    if (inQuote) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (isWhitespace(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
    if (ch === '"') {
      inQuote = true;
    }
  }
  return out.length === 0 ? null : out;
}

type Cursor = { lines: string[]; index: number };

// Parses cells from `text` starting at `start`. Stops at end of line, or at "⟧" when
// `stopAtClose` is set; returns the cells and the offset where scanning stopped.
function parseCells(
  text: string,
  start: number,
  lineNumber: number,
  stopAtClose: boolean,
): { cells: CellAst[]; end: number } {
  const cells: CellAst[] = [];
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === PLANE_CLOSE && stopAtClose) {
      return { cells, end: i };
    }
    if (ch !== "[") {
      fail(
        CODES.EXPECTED_CELL,
        `expected a cell "[…]" but found '${ch}'`,
        spanOf(lineNumber, i + 1, lineNumber, i + 2),
      );
    }
    const cellStart = i;
    let raw = "";
    let inQuote = false;
    let quoteStart = -1;
    i += 1;
    let closed = false;
    while (i < text.length) {
      const c = text[i] ?? "";
      if (inQuote) {
        raw += c;
        if (c === "\\" && i + 1 < text.length) {
          raw += text[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          inQuote = false;
        }
        i += 1;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        quoteStart = i;
        raw += c;
        i += 1;
        continue;
      }
      if (c === "]") {
        closed = true;
        i += 1;
        break;
      }
      if (c === "[") {
        fail(
          CODES.BRACKET_IN_CELL,
          `'[' cannot appear inside a cell; put it inside a quoted text literal`,
          spanOf(lineNumber, i + 1, lineNumber, i + 2),
        );
      }
      raw += c;
      i += 1;
    }
    if (!closed) {
      if (inQuote) {
        fail(
          CODES.UNTERMINATED_QUOTE,
          "unterminated text literal inside a cell",
          spanOf(lineNumber, quoteStart + 1, lineNumber, text.length + 1),
        );
      }
      fail(
        CODES.UNTERMINATED_CELL,
        "cell is missing its closing ']' (a cell must fit on one line)",
        spanOf(lineNumber, cellStart + 1, lineNumber, text.length + 1),
      );
    }
    cells.push({
      text: normalizeCellText(raw),
      span: spanOf(lineNumber, cellStart + 1, lineNumber, i + 1),
    });
  }
  return { cells, end: i };
}

function checkRectangular(rows: RowAst[], span: Span): void {
  const first = rows[0];
  if (!first) {
    fail(CODES.EMPTY_PLANE, "a plane needs at least one row of cells", span);
  }
  const width = first.cells.length;
  for (const row of rows) {
    if (row.cells.length !== width) {
      fail(
        CODES.RAGGED_PLANE,
        `planes are rectangular: this row has ${row.cells.length} cell(s) but the first row has ${width}. Use "[ ]" for empty cells`,
        row.span,
      );
    }
  }
}

// Parses a plane whose "⟦" is at `openColumn` (0-based) of the cursor's current line.
// Leaves the cursor on the line after the plane.
function parsePlane(cursor: Cursor, openColumn: number): InlinePlaneAst | PlaneRefAst {
  const lineIndex = cursor.index;
  const lineNumber = lineIndex + 1;
  const text = cursor.lines[lineIndex] ?? "";
  let i = openColumn + 1;
  while (isWhitespace(text[i])) {
    i += 1;
  }
  const openSpanStart = pos(lineNumber, openColumn + 1);

  // Multi-line form: "⟦" alone on its line.
  if (i >= text.length) {
    const rows: RowAst[] = [];
    let index = lineIndex + 1;
    for (;;) {
      const rowText = cursor.lines[index];
      if (rowText === undefined) {
        fail(
          CODES.UNTERMINATED_PLANE,
          `plane opened here is never closed with '${PLANE_CLOSE}'`,
          spanOf(lineNumber, openColumn + 1, lineNumber, openColumn + 2),
        );
      }
      const trimmed = rowText.trim();
      const rowLine = index + 1;
      if (trimmed === PLANE_CLOSE) {
        const span: Span = { start: openSpanStart, end: pos(rowLine, rowText.indexOf(PLANE_CLOSE) + 2) };
        checkRectangular(rows, span);
        cursor.index = index + 1;
        return { kind: "inline", rows, span };
      }
      if (trimmed.length === 0) {
        fail(CODES.BLANK_LINE_IN_PLANE, "blank lines are not allowed inside a plane", lineSpan(index, rowText));
      }
      if (trimmed.startsWith("#")) {
        fail(CODES.COMMENT_IN_PLANE, "comments are not allowed inside a plane", lineSpan(index, rowText));
      }
      const start = leadingWhitespace(rowText);
      const { cells, end } = parseCells(rowText, start, rowLine, true);
      if (end < rowText.length) {
        fail(
          CODES.CLOSE_NOT_ALONE,
          `'${PLANE_CLOSE}' must be on its own line in a multi-line plane`,
          spanOf(rowLine, end + 1, rowLine, end + 2),
        );
      }
      rows.push({ cells, span: spanOf(rowLine, start + 1, rowLine, rowText.trimEnd().length + 1) });
      index += 1;
    }
  }

  // Reference form: "⟦ :name: ⟧".
  if (text[i] === ":") {
    const match = text.slice(i).match(/^:([^:\s]*):\s*⟧\s*$/u);
    const name = match?.[1];
    if (match === null || name === undefined) {
      fail(
        CODES.MALFORMED_REFERENCE,
        `a plane reference is written "${PLANE_OPEN} :name: ${PLANE_CLOSE}" on one line`,
        lineSpan(lineIndex, text),
      );
    }
    if (!PLANE_NAME_PATTERN.test(name)) {
      fail(
        CODES.INVALID_NAME,
        `'${name}' is not a valid plane name (letters, digits, '_' and '-', starting with a letter or '_')`,
        spanOf(lineNumber, i + 1, lineNumber, i + name.length + 3),
      );
    }
    cursor.index = lineIndex + 1;
    return {
      kind: "ref",
      name,
      span: { start: openSpanStart, end: pos(lineNumber, text.trimEnd().length + 1) },
    };
  }

  // One-row form: "⟦ [A] [B] ⟧".
  if (text[i] === "[") {
    const { cells, end } = parseCells(text, i, lineNumber, true);
    if (text[end] !== PLANE_CLOSE) {
      fail(
        CODES.UNTERMINATED_PLANE,
        `a one-row plane must close with '${PLANE_CLOSE}' on the same line`,
        spanOf(lineNumber, openColumn + 1, lineNumber, text.length + 1),
      );
    }
    if (text.slice(end + 1).trim().length > 0) {
      fail(
        CODES.TEXT_AFTER_CLOSE,
        `unexpected text after '${PLANE_CLOSE}'`,
        spanOf(lineNumber, end + 2, lineNumber, text.length + 1),
      );
    }
    const span: Span = { start: openSpanStart, end: pos(lineNumber, end + 2) };
    const rows: RowAst[] = [{ cells, span: spanOf(lineNumber, i + 1, lineNumber, end + 1) }];
    checkRectangular(rows, span);
    cursor.index = lineIndex + 1;
    return { kind: "inline", rows, span };
  }

  if (text[i] === PLANE_CLOSE) {
    fail(CODES.EMPTY_PLANE, "a plane needs at least one row of cells", lineSpan(lineIndex, text));
  }
  fail(
    CODES.MALFORMED_OPENING,
    `after '${PLANE_OPEN}' expect a new line, a cell "[…]", or a reference ":name:"`,
    spanOf(lineNumber, i + 1, lineNumber, i + 2),
  );
}

function toComment(lineIndex: number, text: string): Comment {
  const start = leadingWhitespace(text);
  return {
    text: text.trim().slice(1).trimEnd(),
    span: spanOf(lineIndex + 1, start + 1, lineIndex + 1, text.trimEnd().length + 1),
  };
}

function parseFrontMatter(lines: string[]): { frontMatter: FrontMatterAst | null; next: number } {
  if ((lines[0] ?? "").trim() !== FRONT_MATTER_FENCE) {
    return { frontMatter: null, next: 0 };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === FRONT_MATTER_FENCE) {
      const body = lines.slice(1, index);
      while (body.length > 0 && (body[0] ?? "").trim() === "") body.shift();
      while (body.length > 0 && (body[body.length - 1] ?? "").trim() === "") body.pop();
      return {
        frontMatter: {
          text: body.map((line) => line.trimEnd()).join("\n"),
          span: spanOf(1, 1, index + 1, (lines[index] ?? "").length + 1),
        },
        next: index + 1,
      };
    }
  }
  fail(CODES.UNTERMINATED_FRONT_MATTER, "front matter opened with '+++' is never closed", lineSpan(0, lines[0] ?? ""));
}

export function parseDocument(source: string): ParseResult {
  try {
    return { ok: true, ast: parseOrThrow(source), diagnostics: [] };
  } catch (error) {
    if (error instanceof SyntaxFailure) {
      return { ok: false, ast: null, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}

function parseOrThrow(source: string): DocumentAst {
  const lines = source.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const { frontMatter, next } = parseFrontMatter(lines);
  const cursor: Cursor = { lines, index: next };

  const volume: PlaneSlotAst[] = [];
  let appendix: DocumentAst["appendix"] = null;
  let pending: Comment[] = [];

  while (cursor.index < lines.length) {
    const lineIndex = cursor.index;
    const text = lines[lineIndex] ?? "";
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      cursor.index += 1;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pending.push(toComment(lineIndex, text));
      cursor.index += 1;
      continue;
    }
    if (trimmed === APPENDIX_MARK) {
      if (appendix !== null) {
        fail(CODES.SECOND_APPENDIX, `a document has at most one '${APPENDIX_MARK}' section`, lineSpan(lineIndex, text));
      }
      if (volume.length === 0) {
        fail(
          CODES.APPENDIX_BEFORE_PLANES,
          `the volume needs at least one plane before '${APPENDIX_MARK}'`,
          lineSpan(lineIndex, text),
        );
      }
      appendix = { comments: pending, definitions: [], span: lineSpan(lineIndex, text) };
      pending = [];
      cursor.index += 1;
      continue;
    }

    const indent = leadingWhitespace(text);
    if (appendix === null) {
      if (!trimmed.startsWith(PLANE_OPEN)) {
        fail(
          CODES.TEXT_OUTSIDE_PLANE,
          `unexpected text outside a plane; planes are written "${PLANE_OPEN} … ${PLANE_CLOSE}"`,
          lineSpan(lineIndex, text),
        );
      }
      volume.push({ plane: parsePlane(cursor, indent), comments: pending });
      pending = [];
      continue;
    }

    const head = trimmed.match(DEFINITION_HEAD);
    if (head === null) {
      if (trimmed.startsWith(PLANE_OPEN)) {
        fail(
          CODES.UNNAMED_DEFINITION,
          `planes in the '${APPENDIX_MARK}' section are named: ":name: ${PLANE_OPEN}"`,
          lineSpan(lineIndex, text),
        );
      }
      fail(
        CODES.TEXT_OUTSIDE_PLANE,
        `expected a named plane ":name: ${PLANE_OPEN} … ${PLANE_CLOSE}"`,
        lineSpan(lineIndex, text),
      );
    }
    const name = head[1] ?? "";
    const rest = head[2] ?? "";
    if (!PLANE_NAME_PATTERN.test(name)) {
      fail(
        CODES.INVALID_NAME,
        `'${name}' is not a valid plane name (letters, digits, '_' and '-', starting with a letter or '_')`,
        spanOf(lineIndex + 1, indent + 1, lineIndex + 1, indent + name.length + 3),
      );
    }
    if (!rest.startsWith(PLANE_OPEN)) {
      fail(
        CODES.UNNAMED_DEFINITION,
        `expected '${PLANE_OPEN}' after ':${name}:'`,
        lineSpan(lineIndex, text),
      );
    }
    const openColumn = text.length - text.trimStart().length + (trimmed.length - rest.length);
    const plane = parsePlane(cursor, openColumn);
    if (plane.kind === "ref") {
      fail(
        CODES.DEFINITION_IS_REFERENCE,
        `':${name}:' must be written out as cells; a named plane cannot refer to another plane`,
        plane.span,
      );
    }
    const definition: DefinitionAst = {
      name,
      plane,
      comments: pending,
      span: { start: pos(lineIndex + 1, indent + 1), end: plane.span.end },
    };
    appendix.definitions.push(definition);
    pending = [];
  }

  if (volume.length === 0) {
    fail(CODES.NO_PLANES, "a Y3 document needs at least one plane", spanOf(1, 1, 1, 1));
  }
  const keptAppendix = appendix !== null && (appendix.definitions.length > 0 || appendix.comments.length > 0) ? appendix : null;
  return { frontMatter, volume, appendix: keptAppendix, trailingComments: pending };
}
