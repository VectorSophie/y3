import type { Span } from "./ast";

export type Severity = "error" | "warning";

export type Diagnostic = {
  code: string;
  severity: Severity;
  message: string;
  span: Span;
};

// Y3S… syntax of the document, Y3V… resolving the volume, Y3P… pack/unpack.
export const DIAGNOSTIC_CODES = {
  UNTERMINATED_FRONT_MATTER: "Y3S001",
  TEXT_OUTSIDE_PLANE: "Y3S002",
  NO_PLANES: "Y3S003",
  SECOND_APPENDIX: "Y3S010",
  APPENDIX_BEFORE_PLANES: "Y3S011",
  DEFINITION_IS_REFERENCE: "Y3S020",
  UNNAMED_DEFINITION: "Y3S021",
  INVALID_NAME: "Y3S022",
  BLANK_LINE_IN_PLANE: "Y3S030",
  COMMENT_IN_PLANE: "Y3S031",
  CLOSE_NOT_ALONE: "Y3S032",
  UNTERMINATED_PLANE: "Y3S033",
  MALFORMED_OPENING: "Y3S034",
  MALFORMED_REFERENCE: "Y3S035",
  TEXT_AFTER_CLOSE: "Y3S036",
  RAGGED_PLANE: "Y3S040",
  EMPTY_PLANE: "Y3S041",
  BRACKET_IN_CELL: "Y3S050",
  UNTERMINATED_CELL: "Y3S051",
  UNTERMINATED_QUOTE: "Y3S052",
  EXPECTED_CELL: "Y3S053",
  UNKNOWN_PLANE: "Y3V001",
  DUPLICATE_PLANE: "Y3V002",
  UNUSED_PLANE: "Y3V003",
  UNKNOWN_FILE: "Y3P001",
  MISSING_MAIN: "Y3P002",
  BAD_PLANE_FILE: "Y3P003",
  FRONT_MATTER_IN_MAIN: "Y3P004",
  NAME_COLLISION: "Y3P005",
} as const;

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function formatDiagnostic(diagnostic: Diagnostic, fileName = "<input>"): string {
  const { line, column } = diagnostic.span.start;
  return `${fileName}:${line}:${column}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
}

export class Y3DocumentError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
    this.name = "Y3DocumentError";
  }
}
