import type { Vec3 } from "./types";

const DIRECTION_MAP: Record<string, Vec3> = {
  위로: { dx: 0, dy: 0, dz: 1 },
  아래로: { dx: 0, dy: 0, dz: -1 },
  오른쪽으로: { dx: 1, dy: 0, dz: 0 },
  왼쪽으로: { dx: -1, dy: 0, dz: 0 },
  앞으로: { dx: 0, dy: -1, dz: 0 },
  뒤로: { dx: 0, dy: 1, dz: 0 },
};

export function parseDirectionToken(token: string): Vec3 | null {
  const parsed = DIRECTION_MAP[token];
  return parsed ?? null;
}

export const VALID_DIRECTIONS = Object.keys(DIRECTION_MAP);
