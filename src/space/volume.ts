import type { DocumentAst, InlinePlaneAst } from "../language/ast";
import { DIAGNOSTIC_CODES as CODES, type Diagnostic } from "../language/diagnostics";
import { cellOf, planeFromAst, type Cell, type Plane } from "./plane";

// The semantic model of a Y3 program: a stack of planes. Whether a plane was written
// inline or referenced by name is presentation only, so it is kept apart from the
// semantics (inline ≡ referenced).

export type LayerPresentation = { readonly kind: "inline" } | { readonly kind: "named"; readonly name: string };

export type Layer = {
  readonly z: number;
  readonly plane: Plane;
  readonly presentation: LayerPresentation;
};

export type Space = {
  readonly manifest: string | null; // raw TOML; interpreted from M1 on
  readonly layers: readonly Layer[];
};

export type BuildResult = { space: Space | null; diagnostics: Diagnostic[] };

export function buildSpace(ast: DocumentAst): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const definitions = new Map<string, InlinePlaneAst>();

  for (const definition of ast.appendix?.definitions ?? []) {
    if (definitions.has(definition.name)) {
      diagnostics.push({
        code: CODES.DUPLICATE_PLANE,
        severity: "error",
        message: `plane ':${definition.name}:' is defined more than once`,
        span: definition.span,
      });
      continue;
    }
    definitions.set(definition.name, definition.plane);
  }

  const used = new Set<string>();
  const layers: Layer[] = [];
  ast.volume.forEach((slot, z) => {
    const plane = slot.plane;
    if (plane.kind === "inline") {
      layers.push({ z, plane: planeFromAst(plane), presentation: { kind: "inline" } });
      return;
    }
    used.add(plane.name);
    const definition = definitions.get(plane.name);
    if (!definition) {
      diagnostics.push({
        code: CODES.UNKNOWN_PLANE,
        severity: "error",
        message: `no plane named ':${plane.name}:' in the ※ section`,
        span: plane.span,
      });
      return;
    }
    layers.push({ z, plane: planeFromAst(definition), presentation: { kind: "named", name: plane.name } });
  });

  for (const definition of ast.appendix?.definitions ?? []) {
    if (!used.has(definition.name)) {
      diagnostics.push({
        code: CODES.UNUSED_PLANE,
        severity: "warning",
        message: `plane ':${definition.name}:' is never placed in the volume`,
        span: definition.span,
      });
      used.add(definition.name); // report each name once
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { space: null, diagnostics };
  }
  return { space: { manifest: ast.frontMatter?.text ?? null, layers }, diagnostics };
}

export type Lookup = { kind: "cell"; cell: Cell } | { kind: "void" };

// The only way the runtime will see space: a position either holds a cell or is VOID.
export function lookup(space: Space, x: number, y: number, z: number): Lookup {
  const layer = space.layers[z];
  const cell = layer ? cellOf(layer.plane, x, y) : null;
  return cell ? { kind: "cell", cell } : { kind: "void" };
}

// A canonical serialisation of what a program is, excluding presentation (names,
// inline-versus-referenced, comments, layout). Equal keys mean equal programs.
export function semanticKey(space: Space): string {
  return JSON.stringify({
    manifest: space.manifest,
    layers: space.layers.map((layer) => layer.plane.rows.map((row) => row.map((cell) => cell.sentence))),
  });
}

export function sameSpace(a: Space, b: Space): boolean {
  return semanticKey(a) === semanticKey(b);
}
