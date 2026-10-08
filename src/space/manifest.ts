import { parse as parseToml } from "smol-toml";
import type { Span } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { DIRECTION_NAMES, DIRECTIONS, isValidOrientation, type Direction, type Orientation } from "./orientation";
import { lookup, type Space } from "./volume";

// The interpreted manifest (the document's +++ front matter). M1 reads the start pose
// and the step limit; other known tables are accepted and checked in later milestones.

export type Coordinate = { readonly x: number; readonly y: number; readonly z: number };
export type Pose = { readonly position: Coordinate; readonly orientation: Orientation };

export type Manifest = {
  readonly name: string | null;
  readonly start: Pose;
  readonly maxSteps: number;
};

export const DEFAULT_MAX_STEPS = 10_000;

export const DEFAULT_MANIFEST: Manifest = {
  name: null,
  start: { position: { x: 0, y: 0, z: 0 }, orientation: { forward: "south", up: "up" } },
  maxSteps: DEFAULT_MAX_STEPS,
};

export const MANIFEST_CODES = {
  INVALID_TOML: "Y3M001",
  INVALID_VALUE: "Y3M002",
  UNKNOWN_KEY: "Y3M003",
  START_IN_VOID: "Y3M004",
} as const;

const KNOWN_TOP_LEVEL = new Set(["name", "y3", "start", "limits", "experimental"]);
const KNOWN_START = new Set(["plane", "cell", "facing", "up"]);
const KNOWN_LIMITS = new Set(["steps", "future-forks"]);

const DIRECTION_BY_NAME = new Map<string, Direction>(DIRECTIONS.map((direction) => [DIRECTION_NAMES[direction], direction]));

const WHOLE_FILE: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

export type ManifestResult = { manifest: Manifest | null; diagnostics: Diagnostic[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function interpretManifest(raw: string | null, span: Span = WHOLE_FILE): ManifestResult {
  if (raw === null) {
    return { manifest: DEFAULT_MANIFEST, diagnostics: [] };
  }
  const diagnostics: Diagnostic[] = [];
  const error = (message: string) => diagnostics.push({ code: MANIFEST_CODES.INVALID_VALUE, severity: "error", message, span });
  const unknown = (key: string) =>
    diagnostics.push({ code: MANIFEST_CODES.UNKNOWN_KEY, severity: "warning", message: `unknown manifest key '${key}'`, span });

  let table: Record<string, unknown>;
  try {
    table = parseToml(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return {
      manifest: null,
      diagnostics: [{ code: MANIFEST_CODES.INVALID_TOML, severity: "error", message: `manifest is not valid TOML: ${message}`, span }],
    };
  }

  for (const key of Object.keys(table)) {
    if (!KNOWN_TOP_LEVEL.has(key)) unknown(key);
  }

  let name: string | null = null;
  const y3 = table["y3"];
  const rawName = table["name"] ?? (isRecord(y3) ? y3["name"] : undefined);
  if (rawName !== undefined) {
    if (typeof rawName === "string") name = rawName;
    else error("name must be a string");
  }

  let position = DEFAULT_MANIFEST.start.position;
  let forward: Direction = DEFAULT_MANIFEST.start.orientation.forward;
  let up: Direction = DEFAULT_MANIFEST.start.orientation.up;
  const start = table["start"];
  if (start !== undefined) {
    if (!isRecord(start)) {
      error("[start] must be a table");
    } else {
      for (const key of Object.keys(start)) {
        if (!KNOWN_START.has(key)) unknown(`start.${key}`);
      }
      const plane = start["plane"] ?? 0;
      const cell = start["cell"] ?? [0, 0];
      if (typeof plane !== "number" || !Number.isInteger(plane) || plane < 0) {
        error("start.plane must be a non-negative integer (the layer's z)");
      }
      const validCell =
        Array.isArray(cell) && cell.length === 2 && cell.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0);
      if (!validCell) {
        error("start.cell must be [x, y] with non-negative integers");
      }
      if (typeof plane === "number" && validCell) {
        position = { x: cell[0] as number, y: cell[1] as number, z: plane };
      }
      for (const [key, assign] of [
        ["facing", (direction: Direction) => (forward = direction)],
        ["up", (direction: Direction) => (up = direction)],
      ] as const) {
        const value = start[key];
        if (value === undefined) continue;
        const direction = typeof value === "string" ? DIRECTION_BY_NAME.get(value) : undefined;
        if (!direction) {
          error(`start.${key} must be one of ${DIRECTIONS.map((d) => `"${DIRECTION_NAMES[d]}"`).join(", ")}`);
        } else {
          assign(direction);
        }
      }
      if (!isValidOrientation({ forward, up })) {
        error(`start.facing "${DIRECTION_NAMES[forward]}" and start.up "${DIRECTION_NAMES[up]}" must be perpendicular`);
      }
    }
  }

  let maxSteps = DEFAULT_MAX_STEPS;
  const limits = table["limits"];
  if (limits !== undefined) {
    if (!isRecord(limits)) {
      error("[limits] must be a table");
    } else {
      for (const key of Object.keys(limits)) {
        if (!KNOWN_LIMITS.has(key)) unknown(`limits.${key}`);
      }
      const steps = limits["steps"];
      if (steps !== undefined) {
        if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) error("limits.steps must be a positive integer");
        else maxSteps = steps;
      }
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { manifest: null, diagnostics };
  }
  return { manifest: { name, start: { position, orientation: { forward, up } }, maxSteps }, diagnostics };
}

// The start pose must be on an authored cell; starting in VOID is a document error.
export function checkStart(space: Space, manifest: Manifest, span: Span = WHOLE_FILE): Diagnostic[] {
  const { x, y, z } = manifest.start.position;
  if (lookup(space, x, y, z).kind === "void") {
    return [
      {
        code: MANIFEST_CODES.START_IN_VOID,
        severity: "error",
        message: `the start position (${x},${y},${z}) is not a cell of the space`,
        span,
      },
    ];
  }
  return [];
}
