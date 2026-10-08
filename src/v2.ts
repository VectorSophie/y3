// Y3 v2. Layers: language (source → AST), space (semantic model), format, container.
// semantics/ lowers sentences into operations (M2); runtime/ is the spatial machine
// (M1) and the present-tense interpreter (M2). The temporal layer arrives in M3–M4.

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
export * from "./space/orientation";
export * from "./space/manifest";
export * from "./runtime/instructions";
export * from "./runtime/outcomes";
export * from "./runtime/trace";
export * from "./runtime/movement";
export * from "./runtime/machine";
export { decodeAssembly } from "./runtime/assembly";
export * from "./language/korean";
export * from "./language/sentence-ast";
export { parseSentence, SENTENCE_CODES, RESERVED_WORDS, type SentenceIssue, type SentenceResult } from "./language/sentence-parser";
export * from "./semantics/operations";
export { lower } from "./semantics/lower";
export * from "./semantics/program";
export * from "./runtime/interpreter";
export * from "./runtime/program-trace";
