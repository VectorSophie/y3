// Seeded random Y3 programs for differential testing. Programs are grids of cells drawn
// from a menu of sentences that type-check together: x and y are i64, t and c are
// temporal bigints. They are not meant to be useful: they wander in 3D, loop, call,
// fault, overflow, run out of steps and constrain the past, and both engines must agree
// on every one of those outcomes.

export function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return { next, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T, int: (n: number) => Math.floor(next() * n) };
}

const TURNS = ["오른쪽을 본다.", "왼쪽을 본다.", "뒤를 본다.", "위를 본다.", "아래를 본다.", "동쪽을 본다.", "남쪽을 본다.", "서쪽을 본다.", "북쪽을 본다."];
const MOVES = ["앞으로 간다.", "뒤로 간다.", "오른쪽으로 간다.", "왼쪽으로 간다.", "위로 간다.", "아래로 간다.", "위층으로 간다.", "아래층으로 간다."];
const ACTS = [...TURNS, ...MOVES, "끝은 처음이다.", "끝이다.", "x를 말한다.", "x에 1을 더한다."];

export type Shape = { floors: number; width: number; height: number };

// One random sentence (or a blank cell, as null).
export function randomCell(r: ReturnType<typeof prng>, opts: { temporal: boolean; calls: boolean }): string | null {
  const n = () => r.pick(["0", "1", "2", "3", "-1", "7", "9223372036854775807"]);
  const menu: (() => string | null)[] = [
    () => null,
    () => null,
    () => `x는 ${n()}이다.`,
    () => `x에 ${n()}을 더한다.`,
    () => "x에서 1을 뺀다.",
    () => `x에 ${r.pick(["2", "3"])}을 곱한다.`,
    () => "x를 말한다.",
    () => "y는 x이다.",
    () => `x가 ${n()}보다 ${r.pick(["크면", "작으면"])} ${r.pick(ACTS)}`,
    () => `x가 ${n()}이면 ${r.pick(ACTS)}`,
    () => `x가 ${n()}이 아니면 ${r.pick(ACTS)}`,
    () => r.pick(TURNS),
    () => r.pick(MOVES),
    () => "여기가 처음이다.",
    () => "끝은 처음이다.",
    () => "끝이다.",
  ];
  if (opts.temporal) {
    menu.push(
      () => "t는 미정이다.",
      () => "t에 1을 더한다.",
      () => "t에 t를 더한다.",
      () => `t는 ${r.pick(["3", "4", "0"])}이었다.`,
      () => "t를 말한다.",
      () => "t는 5일 것이다.",
      () => "처음은 끝이었다.",
      () => "c가 다음에서 온다.",
      () => "c에 c를 더한다.",
      () => "c를 전으로 보낸다.",
      () => "c를 말한다.",
    );
  }
  if (opts.calls) menu.push(() => "y는 f: x", () => "x는 f: y");
  return r.pick(menu)();
}

// Every noun is introduced somewhere in the first row (the cells may still run first).
export function randomGrid(r: ReturnType<typeof prng>, shape: Shape, opts: { temporal: boolean; calls: boolean }): (string | null)[][][] {
  const grid = Array.from({ length: shape.floors }, () => Array.from({ length: shape.height }, () => Array.from({ length: shape.width }, () => randomCell(r, opts))));
  const intro = ["x는 0이다.", "y는 1이다.", ...(opts.temporal ? ["t는 미정이다.", "c가 다음에서 온다."] : [])];
  intro.forEach((cell, i) => {
    const floor = grid[0] as (string | null)[][];
    const row = floor[Math.floor(i / shape.width)] as (string | null)[];
    row[i % shape.width] = cell;
  });
  return grid;
}

const cellText = (c: string | null) => `[${c ?? " "}]`;

export function renderProgram(grid: (string | null)[][][], callee: (string | null)[][] | null, start: { facing: string; up: string }): string {
  const manifest = `+++\n[start]\nfacing = "${start.facing}"\nup = "${start.up}"\n+++\n\n`;
  const floors = grid.map((rows) => `⟦\n${rows.map((row) => row.map(cellText).join(" ")).join("\n")}\n⟧`).join("\n\n");
  const appendix = callee ? `\n\n※\n\n:f: (a: i64) → i64 ⟦\n${callee.map((row) => row.map(cellText).join(" ")).join("\n")}\n⟧\n` : "\n";
  return `${manifest}${floors}${appendix}`;
}

// A callee that always has its parameter and a way back.
export function randomCallee(r: ReturnType<typeof prng>): (string | null)[][] {
  const rows = Array.from({ length: 3 }, () =>
    Array.from({ length: 2 }, () => r.pick<string | null>([null, "a에 1을 더한다.", "오른쪽을 본다.", "왼쪽을 본다.", "a를 돌려준다.", "a가 3보다 크면 a를 돌려준다.", "여기가 처음이다.", "a가 2보다 작으면 끝은 처음이다.", "a를 말한다."])),
  );
  (rows[2] as (string | null)[])[0] = "a를 돌려준다.";
  return rows;
}

export const ORIENTATIONS: { facing: string; up: string }[] = [
  { facing: "남", up: "위" },
  { facing: "동", up: "위" },
  { facing: "동", up: "남" },
  { facing: "위", up: "북" },
  { facing: "아래", up: "서" },
  { facing: "북", up: "아래" },
];
