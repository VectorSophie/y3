import type { Coordinate } from "../space/manifest";
import type { Space } from "../space/volume";
import type { Type, TypeDef } from "../types/types";
import type { Noun, NounId, PlaneId, Stmt } from "./hir";
import type { ForeignDecl, ForeignId, ForeignLibrary } from "../runtime/ffi";

// A compiled program: the space and, for every non-blank cell, its typed HIR. This is
// all the runtime receives; how the HIR was produced (from Korean, or built directly)
// is not its concern.

// A body of code: the main volume, or a callable plane. Each has its own lexical scope:
// its nouns are its own, and a noun is visible everywhere in its body, wherever the
// cell sits in space. Placing a named plane in the volume adds floors to the main body;
// calling a callable plane runs another body.
export type Body = {
  readonly space: Space;
  readonly cells: ReadonlyMap<string, Stmt>; // key: "x,y,z"
  readonly nouns: readonly Noun[]; // with their inferred types
};

export type Procedure = Body & {
  readonly id: PlaneId;
  readonly name: string; // as written
  readonly module: string;
  readonly params: readonly { readonly noun: NounId; readonly name: string; readonly type: Type }[];
  readonly results: readonly Type[]; // empty: Unit
};

export type CompiledProgram = Body & {
  readonly procedures: ReadonlyMap<PlaneId, Procedure>; // every callable plane reachable from the program
  readonly types: readonly TypeDef[]; // the program's own type declarations (built-in ones are implied)
  // 외부 declarations and the foreign libraries they use, each pinned by its sha256.
  readonly foreign: ReadonlyMap<ForeignId, ForeignDecl>;
  readonly libraries: ReadonlyMap<string, ForeignLibrary>;
};

export function coordinateKey(at: Coordinate): string {
  return `${at.x},${at.y},${at.z}`;
}
