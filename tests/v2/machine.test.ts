import { describe, expect, it } from "vitest";
import {
  ALL_ORIENTATIONS,
  createMachine,
  decodeAssembly,
  describeOutcome,
  formatTraceEntry,
  hasErrors,
  loadDocument,
  lookup,
  MANIFEST_CODES,
  orientationLabel,
  RELATIVES,
  run,
  vectorOf,
  worldDirection,
  type Coordinate,
  type Decoder,
  type Manifest,
  type Orientation,
  type Space,
} from "../../src/v2";

function load(source: string): { space: Space; manifest: Manifest } {
  const loaded = loadDocument(source);
  if (hasErrors(loaded.diagnostics) || !loaded.space || !loaded.manifest) {
    throw new Error(loaded.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
  }
  return { space: loaded.space, manifest: loaded.manifest };
}

function runSource(source: string, options: { maxSteps?: number } = {}) {
  const { space, manifest } = load(source);
  return run(space, manifest, decodeAssembly, options);
}

const add = (a: Coordinate, b: Coordinate, k = 1): Coordinate => ({ x: a.x + k * b.x, y: a.y + k * b.y, z: a.z + k * b.z });

// A 3×3×3 cube of blank cells, with the pointer starting at its centre.
function cube(orientation: Orientation, centre = "[ ]"): string {
  const plane = (z: number) =>
    ["⟦", ...[0, 1, 2].map((y) => [0, 1, 2].map((x) => (x === 1 && y === 1 && z === 1 ? centre : "[ ]")).join(" ")), "⟧"].join("\n");
  const names = { east: "동", west: "서", south: "남", north: "북", up: "위", down: "아래" };
  return `+++
[start]
plane = 1
cell = [1, 1]
facing = "${names[orientation.forward]}"
up = "${names[orientation.up]}"
+++
${plane(0)}
${plane(1)}
${plane(2)}
`;
}

describe("running and ending", () => {
  it("walks down the page by default and halts on END", () => {
    const result = runSource("⟦\n[nop]\n[ ]\n[end]\n⟧");
    expect(result.outcome).toEqual({ status: "HALT", steps: 3, at: { x: 0, y: 2, z: 0 } });
    expect(result.trace.map((entry) => entry.at)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 2, z: 0 },
    ]);
    expect(result.trace[1]).toMatchObject({ cell: null, instruction: { op: "nop" } });
    expect(describeOutcome(result.outcome)).toBe("진단: 정지 (HALT) · 3보 · ended at (0,2,0)");
  });

  it("enters VOID when it walks off the plane instead of ending", () => {
    const result = runSource("⟦\n[nop]\n[ ]\n⟧");
    expect(result.outcome).toEqual({ status: "VOID", steps: 2, at: { x: 0, y: 2, z: 0 }, from: { x: 0, y: 1, z: 0 } });
    expect(result.trace).toHaveLength(2);
  });

  it("faults on a cell the decoder cannot read, without executing it", () => {
    const result = runSource("⟦\n[nop]\n[fly]\n⟧");
    expect(result.outcome).toMatchObject({ status: "FAULT", steps: 1, at: { x: 0, y: 1, z: 0 } });
    expect(result.trace).toHaveLength(1);
  });

  it("passes only non-blank sentences to the decoder, with their position", () => {
    const { space, manifest } = load("⟦\n[a] [ ]\n[ ] [ ]\n[end] [ ]\n⟧");
    const calls: [string, Coordinate][] = [];
    const decode: Decoder = (sentence, pose) => {
      calls.push([sentence, pose.position]);
      return sentence === "end" ? { op: "end" } : { op: "nop" };
    };
    expect(run(space, manifest, decode).outcome.status).toBe("HALT");
    expect(calls).toEqual([
      ["a", { x: 0, y: 0, z: 0 }],
      ["end", { x: 0, y: 2, z: 0 }],
    ]);
  });
});

describe("blank cells versus VOID", () => {
  it("walks through any number of blank cells but never into a missing one", () => {
    const blanks = runSource("⟦\n[ ] [ ]\n[ ] [ ]\n[ ] [ ]\n⟧");
    expect(blanks.outcome).toMatchObject({ status: "VOID", steps: 3, at: { x: 0, y: 3, z: 0 } });
    expect(blanks.trace.every((entry) => entry.cell === null)).toBe(true);
  });

  for (const orientation of ALL_ORIENTATIONS) {
    it(`facing ${orientationLabel(orientation)}: one blank cell, then VOID at the boundary`, () => {
      const centre = { x: 1, y: 1, z: 1 };
      const f = vectorOf(orientation.forward);
      const result = runSource(cube(orientation));
      expect(result.trace.map((entry) => entry.at)).toEqual([centre, add(centre, f)]);
      expect(result.trace[1]?.cell).toBeNull(); // the face cell exists and is blank
      expect(result.outcome).toEqual({ status: "VOID", steps: 2, at: add(centre, f, 2), from: add(centre, f) });
    });
  }

  for (const orientation of ALL_ORIENTATIONS) {
    it(`facing ${orientationLabel(orientation)}: a step in each of the six relative directions lands on a cell`, () => {
      const centre = { x: 1, y: 1, z: 1 };
      for (const relative of RELATIVES) {
        const result = runSource(cube(orientation, `[step ${relative}]`), { maxSteps: 2 });
        const landed = add(centre, vectorOf(worldDirection(orientation, relative)));
        expect(result.trace[0]?.next).toEqual({ position: landed, orientation });
        expect(result.trace[1]?.at, relative).toEqual(landed);
        expect(result.trace[1]?.orientation).toEqual(orientation);
      }
    });
  }

  it("enters VOID through a floor transition above the top floor or below the ground", () => {
    expect(runSource("⟦\n[floor up]\n⟧").outcome).toMatchObject({ status: "VOID", at: { x: 0, y: 0, z: 1 } });
    expect(runSource("⟦\n[floor down]\n⟧").outcome).toMatchObject({ status: "VOID", at: { x: 0, y: 0, z: -1 } });
  });

  it("enters VOID when the floor above is smaller and has no cell at (x, y)", () => {
    const source = "⟦\n[ ]\n[ ]\n[floor up]\n⟧\n\n    ⟦\n    [ ]\n    ⟧";
    const result = runSource(source);
    expect(result.outcome).toEqual({ status: "VOID", steps: 3, at: { x: 0, y: 2, z: 1 }, from: { x: 0, y: 2, z: 0 } });
    const { space } = load(source);
    expect(lookup(space, 0, 0, 1).kind).toBe("cell"); // the floor itself exists
  });

  it("keeps x, y and facing across a floor transition", () => {
    const source = `+++
[start]
facing = "동"
+++
⟦
[floor up] [ ]
⟧

    ⟦
    [ ] [end]
    ⟧`;
    const result = runSource(source);
    expect(result.trace.map((entry) => [entry.at, entry.orientation.forward])).toEqual([
      [{ x: 0, y: 0, z: 0 }, "east"],
      [{ x: 0, y: 0, z: 1 }, "east"],
      [{ x: 1, y: 0, z: 1 }, "east"],
    ]);
    expect(result.outcome.status).toBe("HALT");
  });
});

describe("turning", () => {
  it("takes effect on the same step (v1 turned one step late)", () => {
    // Default facing 남, so left is 동: the pointer must go straight to (1,0).
    const result = runSource("⟦\n[turn left] [end]\n[ ]         [ ]\n⟧");
    expect(result.trace.map((entry) => entry.at)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
    expect(result.outcome.status).toBe("HALT");
  });

  it("can fly through floors only by facing along z", () => {
    const source = "⟦\n[turn up]\n⟧\n\n    ⟦\n    [ ]\n    ⟧\n\n        ⟦\n        [end]\n        ⟧";
    const result = runSource(source);
    expect(result.trace.map((entry) => entry.at.z)).toEqual([0, 1, 2]);
    expect(result.trace[1]?.orientation).toEqual({ forward: "up", up: "north" });
    expect(result.outcome.status).toBe("HALT");
  });
});

describe("STEP_LIMIT", () => {
  const ring = "⟦\n[face south] [face west]\n[face east]  [face north]\n⟧";

  it("stops a loop at the step limit", () => {
    const result = runSource(ring, { maxSteps: 10 });
    expect(result.outcome).toMatchObject({ status: "STEP_LIMIT", steps: 10 });
    expect(result.trace).toHaveLength(10);
    expect(result.trace.slice(0, 5).map((entry) => [entry.at.x, entry.at.y])).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ]);
  });

  it("reads the limit from the manifest, and lets the caller override it", () => {
    expect(runSource(`+++\n[limits]\nsteps = 7\n+++\n${ring}`).outcome).toMatchObject({ status: "STEP_LIMIT", steps: 7 });
    expect(runSource(`+++\n[limits]\nsteps = 7\n+++\n${ring}`, { maxSteps: 3 }).outcome).toMatchObject({ steps: 3 });
    expect(runSource(ring).outcome).toMatchObject({ status: "STEP_LIMIT", steps: 10_000 });
  });

  it("lets HALT or VOID on the last allowed step win over STEP_LIMIT", () => {
    expect(runSource("⟦\n[nop]\n[end]\n⟧", { maxSteps: 2 }).outcome.status).toBe("HALT");
    expect(runSource("⟦\n[nop]\n[nop]\n⟧", { maxSteps: 2 }).outcome.status).toBe("VOID");
    expect(runSource("⟦\n[nop]\n[nop]\n[end]\n⟧", { maxSteps: 2 }).outcome.status).toBe("STEP_LIMIT");
  });

  it("is deterministic", () => {
    const a = runSource(ring, { maxSteps: 50 });
    const b = runSource(ring, { maxSteps: 50 });
    expect(b).toEqual(a);
  });
});

describe("trace entries", () => {
  it("record the cell that executed, not where it led", () => {
    const source = `⟦
[step right] [end]
[ ]          [ ]
[floor up]   [ ]
⟧

    ⟦
    [ ] [ ]
    [ ] [ ]
    [ ] [ ]
    [ ] [ ]
    ⟧`;
    // Default facing 남: right is 서, so "step right" at (0,0) leaves the plane.
    const result = runSource(source);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({ at: { x: 0, y: 0, z: 0 }, cell: "step right", next: { position: { x: -1, y: 0, z: 0 } } });
    expect(result.outcome).toMatchObject({ status: "VOID", at: { x: -1, y: 0, z: 0 } });

    const floor = runSource(`+++\n[start]\ncell = [0, 2]\n+++\n${source}`);
    expect(floor.trace[0]).toMatchObject({ at: { x: 0, y: 2, z: 0 }, cell: "floor up", next: { position: { x: 0, y: 2, z: 1 } } });
    expect(floor.trace[1]?.at).toEqual({ x: 0, y: 2, z: 1 });
    expect(formatTraceEntry(floor.trace[0] as never)).toBe("   1  (0,2,0) 남/위  [floor up]  floor up → (0,2,1) 남/위");
  });
});

describe("the manifest's start pose", () => {
  it("places and orients the pointer", () => {
    const result = runSource(`+++
[start]
plane = 1
cell = [1, 0]
facing = "서"
+++
⟦
[ ] [ ]
⟧

    ⟦
    [end] [nop]
    ⟧`);
    expect(result.trace.map((entry) => entry.at)).toEqual([
      { x: 1, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ]);
    expect(result.trace[0]?.orientation).toEqual({ forward: "west", up: "up" });
  });

  it("reports a start position in VOID, and the machine refuses to step", () => {
    const loaded = loadDocument("+++\n[start]\ncell = [5, 5]\n+++\n⟦\n[end]\n⟧");
    expect(loaded.diagnostics.map((d) => d.code)).toEqual([MANIFEST_CODES.START_IN_VOID]);
    if (!loaded.space || !loaded.manifest) throw new Error("expected a space and manifest");
    const state = createMachine(loaded.space, loaded.manifest);
    expect(state.outcome).toEqual({ status: "VOID", steps: 0, at: { x: 5, y: 5, z: 0 }, from: null });
  });

  const invalid: [string, string, string][] = [
    ["not TOML", "[start\n", MANIFEST_CODES.INVALID_TOML],
    ["an unknown direction", '[start]\nfacing = "east"', MANIFEST_CODES.INVALID_VALUE],
    ["facing and up not perpendicular", '[start]\nfacing = "위"', MANIFEST_CODES.INVALID_VALUE],
    ["a negative plane", "[start]\nplane = -1", MANIFEST_CODES.INVALID_VALUE],
    ["a malformed cell", "[start]\ncell = [1]", MANIFEST_CODES.INVALID_VALUE],
    ["a zero step limit", "[limits]\nsteps = 0", MANIFEST_CODES.INVALID_VALUE],
  ];
  for (const [label, toml, code] of invalid) {
    it(`rejects ${label}`, () => {
      const loaded = loadDocument(`+++\n${toml}\n+++\n⟦\n[end]\n⟧`);
      expect(loaded.manifest).toBeNull();
      expect(loaded.diagnostics.map((d) => d.code)).toContain(code);
    });
  }

  it("warns about unknown keys but keeps going", () => {
    const loaded = loadDocument('+++\ncolour = "blue"\n[start]\nspin = 1\n+++\n⟦\n[end]\n⟧');
    expect(loaded.manifest).not.toBeNull();
    expect(loaded.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      [MANIFEST_CODES.UNKNOWN_KEY, "warning"],
      [MANIFEST_CODES.UNKNOWN_KEY, "warning"],
    ]);
  });

  it("accepts every example's manifest", () => {
    for (const path of ["examples/v2/stairwell.y3", "examples/v2/projection.y3"]) {
      const loaded = loadDocument(require("node:fs").readFileSync(path, "utf8"));
      expect(hasErrors(loaded.diagnostics), path).toBe(false);
    }
  });
});
