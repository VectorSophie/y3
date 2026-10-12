import type { Coordinate } from "../space/manifest";
import type { Space } from "../space/volume";
import type { Noun, Stmt } from "./hir";

// A compiled program: the space and, for every non-blank cell, its typed HIR. This is
// all the runtime receives; how the HIR was produced (from Korean, or built directly)
// is not its concern.

export type CompiledProgram = {
  readonly space: Space;
  readonly cells: ReadonlyMap<string, Stmt>; // key: "x,y,z"
  readonly nouns: readonly Noun[]; // with their inferred types
};

export function coordinateKey(at: Coordinate): string {
  return `${at.x},${at.y},${at.z}`;
}
