import { describe, expect, it } from "vitest";
import {
  buildSpace,
  canonicalizeDocument,
  formatDocument,
  packDocument,
  PROJECTIONS,
  sameDocument,
  semanticKey,
  unpackDocument,
} from "../../src/v2";
import { parseOk } from "./helpers";

// Seeded random documents written in messy layouts: odd indentation, uneven gaps,
// one-row and multi-line planes, comments everywhere, quotes, wide characters.

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  return { next, int, pick };
}

const CELLS = [
  "[ ]",
  "[]",
  "[    ]",
  "[값은 3이다.]",
  "[  값은   3이다.  ]",
  "[A]",
  '["[ ]"를 말한다.]',
  '["a   b"를\t말한다.]',
  '["따옴표 \\" 안"이다.]',
  "[😀]",
  "[끝이다.]",
  "[⟧]",
  "[# not a comment]",
];
const NAMES = ["a", "바닥", "층_1", "detour", "B-2"];

function generate(seed: number): string {
  const r = random(seed);
  const lines: string[] = [];
  const ws = () => r.pick(["", " ", "  ", "\t", "        "]);
  const comment = () => `${ws()}#${r.pick(["", " note", " 주석", "!", " ⟦ [x] ⟧"])}`;
  const blanks = () => {
    for (let i = r.int(0, 2); i > 0; i -= 1) lines.push(r.pick(["", "   "]));
  };
  const comments = () => {
    for (let i = r.int(0, 2); i > 0; i -= 1) lines.push(comment());
  };
  const plane = (prefix: string) => {
    const width = r.int(1, 4);
    const height = r.int(1, 3);
    const rows = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => r.pick(CELLS)).join(r.pick(["", " ", "   ", "\t"])),
    );
    if (height === 1 && r.next() < 0.5) {
      lines.push(`${prefix}⟦${ws()}${rows[0]}${ws()}⟧${ws()}`);
      return;
    }
    lines.push(`${prefix}⟦${ws()}`);
    for (const row of rows) lines.push(`${ws()}${row}${ws()}`);
    lines.push(`${ws()}⟧${ws()}`);
  };

  if (r.next() < 0.4) {
    lines.push("+++", 'name = "generated"', r.pick(["", "[limits]"]), "+++");
  }
  const used = new Set<string>();
  const count = r.int(1, 4);
  for (let z = 0; z < count; z += 1) {
    blanks();
    comments();
    if (r.next() < 0.35) {
      const name = r.pick(NAMES);
      used.add(name);
      lines.push(`${ws()}⟦${ws()}:${name}:${ws()}⟧`);
    } else {
      plane(ws());
    }
  }
  const unused = r.next() < 0.3 ? [r.pick(NAMES)] : [];
  const defined = [...new Set([...used, ...unused])];
  if (defined.length > 0 || r.next() < 0.2) {
    blanks();
    comments();
    lines.push(`${ws()}※${ws()}`);
    for (const name of defined.sort(() => r.next() - 0.5)) {
      blanks();
      comments();
      plane(`${ws()}:${name}:${ws()}`);
    }
  }
  blanks();
  comments();
  return lines.join(r.pick(["\n", "\r\n"]));
}

describe("generated documents", () => {
  const SEEDS = 400;

  it(`hold every M0 invariant across ${SEEDS} seeds`, () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const source = generate(seed);
      const ast = parseOk(source);
      const label = `seed ${seed}:\n${source}`;

      // fmt(s), fmt(fmt(s)) and pack(unpack(s)) are one and the same text.
      const canonical = formatDocument(ast);
      expect(formatDocument(parseOk(canonical)), label).toBe(canonical);
      expect(packDocument(unpackDocument(source)), label).toBe(canonical);

      // Formatting changes nothing but whitespace and the order of the ※ section.
      for (const projection of PROJECTIONS) {
        expect(sameDocument(parseOk(formatDocument(ast, { projection })), canonicalizeDocument(ast)), `${label}\n(${projection})`).toBe(
          true,
        );
      }

      const { space } = buildSpace(ast);
      expect(space, label).not.toBeNull();
      const repacked = buildSpace(parseOk(canonical)).space;
      expect(repacked && space && semanticKey(repacked) === semanticKey(space), label).toBe(true);
    }
  });
});
