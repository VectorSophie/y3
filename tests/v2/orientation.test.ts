import { describe, expect, it } from "vitest";
import {
  ALL_ORIENTATIONS,
  COMPASS,
  cross,
  DEFAULT_ORIENTATION,
  DIRECTIONS,
  dot,
  face,
  isValidOrientation,
  nextPose,
  OPPOSITE,
  orientationLabel,
  RELATIVES,
  rightOf,
  sameOrientation,
  turn,
  TURNS,
  vectorOf,
  worldDirection,
  type Orientation,
  type Turn,
} from "../../src/v2";

const key = (o: Orientation) => `${o.forward}/${o.up}`;
const apply = (o: Orientation, turns: Turn[]) => turns.reduce((current, which) => turn(current, which), o);
const times = (which: Turn, n: number): Turn[] => Array.from({ length: n }, () => which);

describe("the 24 orientations", () => {
  it("are exactly the perpendicular forward/up pairs", () => {
    expect(ALL_ORIENTATIONS).toHaveLength(24);
    expect(new Set(ALL_ORIENTATIONS.map(key)).size).toBe(24);
    let perpendicularPairs = 0;
    for (const forward of DIRECTIONS) {
      for (const up of DIRECTIONS) {
        const valid = isValidOrientation({ forward, up });
        expect(valid).toBe(dot(vectorOf(forward), vectorOf(up)) === 0);
        if (valid) perpendicularPairs += 1;
      }
    }
    expect(perpendicularPairs).toBe(24);
  });

  it("starts at facing 남, up 위, with right 서", () => {
    expect(DEFAULT_ORIENTATION).toEqual({ forward: "south", up: "up" });
    expect(rightOf(DEFAULT_ORIENTATION)).toBe("west");
    expect(orientationLabel(DEFAULT_ORIENTATION)).toBe("남/위");
  });

  it("are all reachable from the default pose by turning", () => {
    const seen = new Set([key(DEFAULT_ORIENTATION)]);
    const queue = [DEFAULT_ORIENTATION];
    while (queue.length > 0) {
      const current = queue.shift() as Orientation;
      for (const which of TURNS) {
        const next = turn(current, which);
        if (!seen.has(key(next))) {
          seen.add(key(next));
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(24);
  });
});

describe.each(ALL_ORIENTATIONS.map((o) => [orientationLabel(o), o] as const))("orientation %s", (_label, o) => {
  it("has a right vector perpendicular to forward and up, with the same handedness as every other", () => {
    const f = vectorOf(o.forward);
    const u = vectorOf(o.up);
    const r = vectorOf(rightOf(o));
    expect(dot(r, f)).toBe(0);
    expect(dot(r, u)).toBe(0);
    // det[f, u, r] = f · (u × r) is the same for every orientation: turning is a
    // rotation, never a reflection.
    expect(dot(f, cross(u, r))).toBe(-1);
  });

  it("turns only into valid orientations", () => {
    for (const which of TURNS) {
      expect(isValidOrientation(turn(o, which)), which).toBe(true);
    }
  });

  it("right × 4 = identity, left × 4 = identity", () => {
    expect(apply(o, times("right", 4))).toEqual(o);
    expect(apply(o, times("left", 4))).toEqual(o);
    for (let n = 1; n < 4; n += 1) {
      expect(sameOrientation(apply(o, times("right", n)), o)).toBe(false);
    }
  });

  it("right then left = identity, and left then right = identity", () => {
    expect(apply(o, ["right", "left"])).toEqual(o);
    expect(apply(o, ["left", "right"])).toEqual(o);
  });

  it("around = right × 2 = left × 2, and around × 2 = identity", () => {
    expect(turn(o, "around")).toEqual(apply(o, times("right", 2)));
    expect(turn(o, "around")).toEqual(apply(o, times("left", 2)));
    expect(apply(o, ["around", "around"])).toEqual(o);
  });

  it("up × 4 = identity, down × 4 = identity, up then down = identity", () => {
    expect(apply(o, times("up", 4))).toEqual(o);
    expect(apply(o, times("down", 4))).toEqual(o);
    expect(apply(o, ["up", "down"])).toEqual(o);
    expect(apply(o, ["down", "up"])).toEqual(o);
  });

  it("yaw keeps up; pitch keeps right", () => {
    for (const which of ["right", "left", "around"] as const) {
      expect(turn(o, which).up, which).toBe(o.up);
    }
    for (const which of ["up", "down"] as const) {
      expect(rightOf(turn(o, which)), which).toBe(rightOf(o));
    }
  });

  it("turning right faces the old right; looking up faces the old up", () => {
    expect(turn(o, "right").forward).toBe(rightOf(o));
    expect(turn(o, "left").forward).toBe(OPPOSITE[rightOf(o)]);
    expect(turn(o, "up").forward).toBe(o.up);
    expect(turn(o, "down").forward).toBe(OPPOSITE[o.up]);
  });

  it("maps the six relative directions onto the six world directions", () => {
    const world = RELATIVES.map((relative) => worldDirection(o, relative));
    expect(new Set(world).size).toBe(6);
    expect(worldDirection(o, "forward")).toBe(o.forward);
    expect(worldDirection(o, "back")).toBe(OPPOSITE[o.forward]);
    expect(worldDirection(o, "up")).toBe(o.up);
    expect(worldDirection(o, "down")).toBe(OPPOSITE[o.up]);
  });

  it("changes only z on a floor transition, never the facing", () => {
    const pose = { position: { x: 4, y: 5, z: 6 }, orientation: o };
    for (const delta of [1, -1] as const) {
      const next = nextPose(pose, { op: "floor", delta });
      expect(next.position).toEqual({ x: 4, y: 5, z: 6 + delta });
      expect(next.orientation).toEqual(o);
    }
  });

  it("steps one cell without changing orientation", () => {
    const pose = { position: { x: 4, y: 5, z: 6 }, orientation: o };
    for (const relative of RELATIVES) {
      const next = nextPose(pose, { op: "step", relative });
      const v = vectorOf(worldDirection(o, relative));
      expect(next.position).toEqual({ x: 4 + v.x, y: 5 + v.y, z: 6 + v.z });
      expect(next.orientation).toEqual(o);
    }
  });

  it("stays exactly where it is on END, and advances one cell on NOP", () => {
    const pose = { position: { x: 4, y: 5, z: 6 }, orientation: o };
    expect(nextPose(pose, { op: "end" })).toEqual(pose);
    const v = vectorOf(o.forward);
    expect(nextPose(pose, { op: "nop" })).toEqual({ position: { x: 4 + v.x, y: 5 + v.y, z: 6 + v.z }, orientation: o });
  });

  it("applies a turn before this step's advance (no late turns)", () => {
    const pose = { position: { x: 0, y: 0, z: 0 }, orientation: o };
    for (const which of TURNS) {
      const next = nextPose(pose, { op: "turn", turn: which });
      expect(next.position).toEqual(vectorOf(turn(o, which).forward));
    }
  });
});

describe("facing a compass direction", () => {
  it("is valid and level from every orientation", () => {
    for (const compass of COMPASS) {
      const faced = face(compass);
      expect(faced).toEqual({ forward: compass, up: "up" });
      expect(isValidOrientation(faced)).toBe(true);
      for (const o of ALL_ORIENTATIONS) {
        expect(nextPose({ position: { x: 0, y: 0, z: 0 }, orientation: o }, { op: "face", compass }).orientation).toEqual(faced);
      }
    }
  });
});
