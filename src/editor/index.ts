// The editor-facing API (docs/v2-editor-model.md). A future IDE imports only this.
export * from "../ir/identity";
export { ProgramModel, ModelError, EditError, hirNodes, callablePlane } from "./model";
export type { Command, EditResult, ModelDiagnostic, Build, RunRecord, DocumentView, ModuleView, PlaneView, CellView, Element, HirNode, InstructionId, InstructionView, ModelOptions } from "./model";
export * from "./events";
export * from "./services";
export { modelViolations } from "./invariants";
