import type { AppendixAst, DocumentAst, InlinePlaneAst } from "../language/ast";
import { PLANE_NAME_PATTERN } from "../language/document-parser";

// Moving a plane between the volume and the ※ section changes how a document is
// written, never what it means. Both functions return a new AST.

export class Y3RefactorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Y3RefactorError";
  }
}

const NO_SPAN = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };

function clonePlane(plane: InlinePlaneAst): InlinePlaneAst {
  return structuredClone(plane);
}

// Turns the inline plane at layer z into "⟦ :name: ⟧" plus a named definition.
export function extractPlane(ast: DocumentAst, z: number, name: string): DocumentAst {
  const slot = ast.volume[z];
  if (!slot) {
    throw new Y3RefactorError(`there is no layer z=${z}`);
  }
  if (slot.plane.kind !== "inline") {
    throw new Y3RefactorError(`layer z=${z} is already the named plane ':${slot.plane.name}:'`);
  }
  if (!PLANE_NAME_PATTERN.test(name)) {
    throw new Y3RefactorError(`'${name}' is not a valid plane name`);
  }
  if (ast.appendix?.definitions.some((definition) => definition.name === name)) {
    throw new Y3RefactorError(`a plane named ':${name}:' already exists`);
  }

  const appendix: AppendixAst = ast.appendix
    ? structuredClone(ast.appendix)
    : { comments: [], definitions: [], span: NO_SPAN };
  appendix.definitions.push({ name, plane: clonePlane(slot.plane), comments: [], span: NO_SPAN });

  const volume = ast.volume.map((other, index) =>
    index === z ? { comments: structuredClone(other.comments), plane: { kind: "ref" as const, name, span: NO_SPAN } } : structuredClone(other),
  );
  return { ...structuredClone(ast), volume, appendix };
}

// Replaces the reference at layer z with a copy of the named plane. A definition that is
// no longer referenced is removed; its comments move to the layer.
export function inlinePlane(ast: DocumentAst, z: number): DocumentAst {
  const slot = ast.volume[z];
  if (!slot) {
    throw new Y3RefactorError(`there is no layer z=${z}`);
  }
  if (slot.plane.kind !== "ref") {
    throw new Y3RefactorError(`layer z=${z} is already inline`);
  }
  const name = slot.plane.name;
  const definition = ast.appendix?.definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Y3RefactorError(`no plane named ':${name}:' in the ※ section`);
  }

  const result = structuredClone(ast);
  const stillUsed = result.volume.some((other, index) => index !== z && other.plane.kind === "ref" && other.plane.name === name);
  const target = result.volume[z];
  if (!target) {
    throw new Y3RefactorError(`there is no layer z=${z}`);
  }
  target.plane = clonePlane(definition.plane);
  if (!stillUsed && result.appendix) {
    target.comments = [...target.comments, ...structuredClone(definition.comments)];
    result.appendix.definitions = result.appendix.definitions.filter((candidate) => candidate.name !== name);
    if (result.appendix.definitions.length === 0 && result.appendix.comments.length === 0) {
      result.appendix = null;
    }
  }
  return result;
}
