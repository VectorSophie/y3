// Y3 v2. Layers: language (source → AST), space (semantic model), format, container.
// The runtime and temporal layers arrive in later milestones (M1–M4).

export * from "./language/ast";
export * from "./language/diagnostics";
export { parseDocument, normalizeCellText, PLANE_NAME_PATTERN, type ParseResult } from "./language/document-parser";
export * from "./space/plane";
export * from "./space/volume";
export * from "./format/projection";
export * from "./format/formatter";
export * from "./format/refactor";
export { displayWidth } from "./format/width";
export * from "./container/document";
export * from "./container/pack";
