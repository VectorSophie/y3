// Y3 v2. Layers: language (source → AST), space (semantic model), format, container.
// semantics/ elaborates sentences into the typed IR in ir/ (M5), which types/ checks;
// runtime/ is the spatial machine (M1) and the interpreter (M2–M5); temporal/ holds
// symbols, constraints and the solver (M3–M4).

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
export * from "./semantics/values";
export { elaborate, NounTable, PENDING, ELABORATION_CODES } from "./semantics/elaborate";
export * from "./semantics/program";
export * from "./ir/hir";
export * from "./ir/callables";
export * from "./ir/print";
export * from "./types/types";
export * from "./types/check";
export * from "./runtime/interpreter";
export * from "./runtime/evaluate";
export * from "./runtime/program-trace";
export * from "./runtime/program-outcome";
export * from "./temporal/terms";
export * from "./temporal/solver";
export * from "./temporal/store";
