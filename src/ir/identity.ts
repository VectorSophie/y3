// Stable identities of authored program elements (docs/v2-editor-model.md). They are
// created and kept by the editor model (src/editor); the compiler and runtime only carry
// them, from the layout AST into provenance, the debug map, bytecode and traces. Nothing
// below the editor creates, interprets or depends on them.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type DocumentId = Brand<string, "DocumentId">;
export type ModuleId = Brand<string, "ModuleId">;
export type PlaneId = Brand<string, "PlaneId">; // an authored plane (not hir.PlaneId, a callable's name)
export type CellId = Brand<string, "CellId">;
export type NodeId = Brand<string, "NodeId">;
export type ProgramRevision = Brand<string, "ProgramRevision">;

// Everything a cell's provenance knows about who it is.
export type CellIds = {
  readonly document: DocumentId;
  readonly module: ModuleId;
  readonly plane: PlaneId;
  readonly cell: CellId;
  readonly node: NodeId | null; // the cell's statement; null for a blank cell
};
