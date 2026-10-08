// The pointer's orientation: a forward and an up direction, both along the axes and
// perpendicular to each other. There are exactly 24 such pairs, the rotations of a
// cube. Right is derived: right = up × forward.
//
// World axes: east +x, south +y (rows go down the page), up +z (floors).

export type Direction = "east" | "west" | "south" | "north" | "up" | "down";

export const DIRECTIONS: readonly Direction[] = ["east", "west", "south", "north", "up", "down"];

// How directions are written in Y3 (manifest values, and sentences from M2 on).
export const DIRECTION_NAMES: Readonly<Record<Direction, string>> = {
  east: "동",
  west: "서",
  south: "남",
  north: "북",
  up: "위",
  down: "아래",
};

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

const VECTORS: Readonly<Record<Direction, Vec3>> = {
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  south: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  down: { x: 0, y: 0, z: -1 },
};

export const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  east: "west",
  west: "east",
  south: "north",
  north: "south",
  up: "down",
  down: "up",
};

export function vectorOf(direction: Direction): Vec3 {
  return VECTORS[direction];
}

export function directionOf(vector: Vec3): Direction {
  const found = DIRECTIONS.find((direction) => {
    const v = VECTORS[direction];
    return v.x === vector.x && v.y === vector.y && v.z === vector.z;
  });
  if (!found) {
    throw new Error(`(${vector.x},${vector.y},${vector.z}) is not an axis direction`);
  }
  return found;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export type Orientation = { readonly forward: Direction; readonly up: Direction };

export const DEFAULT_ORIENTATION: Orientation = { forward: "south", up: "up" };

export function isValidOrientation(orientation: Orientation): boolean {
  const { forward, up } = orientation;
  return forward !== up && forward !== OPPOSITE[up];
}

export function orientation(forward: Direction, up: Direction): Orientation {
  const result = { forward, up };
  if (!isValidOrientation(result)) {
    throw new Error(`forward ${forward} and up ${up} are not perpendicular`);
  }
  return result;
}

// All 24 orientations, in a fixed order.
export const ALL_ORIENTATIONS: readonly Orientation[] = DIRECTIONS.flatMap((forward) =>
  DIRECTIONS.filter((up) => isValidOrientation({ forward, up })).map((up) => ({ forward, up })),
);

export function rightOf(orientation: Orientation): Direction {
  return directionOf(cross(vectorOf(orientation.up), vectorOf(orientation.forward)));
}

export function sameOrientation(a: Orientation, b: Orientation): boolean {
  return a.forward === b.forward && a.up === b.up;
}

export function orientationLabel(orientation: Orientation): string {
  return `${DIRECTION_NAMES[orientation.forward]}/${DIRECTION_NAMES[orientation.up]}`;
}

// Turns, in the body frame. Yaw keeps up; pitch keeps right.
export type Turn = "right" | "left" | "around" | "up" | "down";

export const TURNS: readonly Turn[] = ["right", "left", "around", "up", "down"];

export function turn(current: Orientation, which: Turn): Orientation {
  const { forward, up } = current;
  switch (which) {
    case "right":
      return { forward: rightOf(current), up };
    case "left":
      return { forward: OPPOSITE[rightOf(current)], up };
    case "around":
      return { forward: OPPOSITE[forward], up };
    case "up":
      return { forward: up, up: OPPOSITE[forward] };
    case "down":
      return { forward: OPPOSITE[up], up: forward };
  }
}

// Facing a compass direction levels the pointer: up becomes 위 again.
export type Compass = "east" | "west" | "south" | "north";

export const COMPASS: readonly Compass[] = ["east", "west", "south", "north"];

export function face(compass: Compass): Orientation {
  return { forward: compass, up: "up" };
}

// Directions relative to the body.
export type Relative = "forward" | "back" | "right" | "left" | "up" | "down";

export const RELATIVES: readonly Relative[] = ["forward", "back", "right", "left", "up", "down"];

export function worldDirection(current: Orientation, relative: Relative): Direction {
  switch (relative) {
    case "forward":
      return current.forward;
    case "back":
      return OPPOSITE[current.forward];
    case "right":
      return rightOf(current);
    case "left":
      return OPPOSITE[rightOf(current)];
    case "up":
      return current.up;
    case "down":
      return OPPOSITE[current.up];
  }
}
