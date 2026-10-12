import { describe, expect, it } from "vitest";
import {
  arith,
  compileProgram,
  convert,
  describeEffect,
  float,
  formatFloat,
  formatType,
  hasErrors,
  int,
  integerRange,
  keyOf,
  loadDocument,
  memoryHost,
  NumericFault,
  runProgram,
  sameValue,
  text,
  type ConcreteValue,
  type IntegerName,
  type MemoryHost,
  type ProgramResult,
} from "../../src/v2";

// M7: numbers, text, the value model and the standard library.

const program = (cells: string[], appendix = "") => `⟦\n${cells.map((c) => `[${c}]`).join("\n")}\n⟧\n${appendix ? `\n※\n\n${appendix}` : ""}`;

function compile(cells: string[], appendix = "") {
  const loaded = loadDocument(program(cells, appendix));
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
  return { ...compileProgram(loaded.ast, loaded.space), manifest: loaded.manifest };
}
const errors = (cells: string[], appendix = "") => compile(cells, appendix).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
const types = (cells: string[], appendix = "") => Object.fromEntries((compile(cells, appendix).program?.nouns ?? []).map((n) => [n.name, formatType(n.type)]));
function run(cells: string[], appendix = "", host: MemoryHost = memoryHost()): ProgramResult & { host: MemoryHost } {
  const { program: p, diagnostics, manifest } = compile(cells, appendix);
  if (!p) throw new Error(diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
  return { ...runProgram(p, manifest, { host }), host };
}
const out = (cells: string[], appendix = "", host?: MemoryHost) => run(cells, appendix, host).output;
const outcome = (cells: string[]) => {
  const r = run(cells);
  return `${r.outcome.status}${"message" in r.outcome ? `: ${r.outcome.message}` : ""}`;
};

// A small seeded PRNG, so property tests are reproducible.
function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const big = (min: bigint, max: bigint): bigint => {
    // Bias toward the edges, where bugs live.
    const r = next();
    if (r < 0.1) return min;
    if (r < 0.2) return max;
    if (r < 0.3) return min + BigInt(Math.floor(next() * 4));
    if (r < 0.4) return max - BigInt(Math.floor(next() * 4));
    const span = max - min + 1n;
    let v = 0n;
    for (let i = 0; i < 5; i += 1) v = (v << 32n) | BigInt(Math.floor(next() * 2 ** 32));
    return min + (v % span);
  };
  return { next, big, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T };
}

const FIXED: IntegerName[] = ["i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128"];

describe("numeric literals", () => {
  it("default to i64 and f64, and take any exact type from context", () => {
    expect(types(["x는 3이다.", "y는 1.5이다.", "끝이다."])).toEqual({ x: "i64", y: "f64" });
    expect(types(["x는 3u8이다.", "y는 x이다.", "y에 1을 더한다.", "z는 1.5f32이다.", "끝이다."])).toEqual({ x: "u8", y: "u8", z: "f32" });
    expect(types(["x는 3이다.", "y는 변환 u8: 1", "끝이다."])).toEqual({ x: "i64", y: "u8" });
  });

  it("name every type with a suffix", () => {
    const all = [...FIXED, "bigint"].map((t, i) => `x${i}는 7${t}이다.`);
    expect(Object.values(types([...all, "f는 1f32이다.", "g는 2.5f64이다.", "끝이다."]))).toEqual([...FIXED, "bigint", "f32", "f64"]);
  });

  it("must fit their type, checked before the run", () => {
    expect(errors(["x는 128i8이다.", "끝이다."])).toEqual(["Y3N001 [x는 128i8이다.] 128 does not fit in i8 (-128 … 127)"]);
    expect(errors(["x는 -1u8이다.", "끝이다."])).toEqual(["Y3N001 [x는 -1u8이다.] -1 does not fit in u8 (0 … 255)"]);
    expect(errors(["x는 1u8이다.", "x에 256을 더한다.", "끝이다."])).toEqual(["Y3N001 [x에 256을 더한다.] 256 does not fit in u8 (0 … 255)"]);
    // i128's limits, exactly.
    expect(errors(["x는 170141183460469231731687303715884105727i128이다.", "y는 -170141183460469231731687303715884105728i128이다.", "끝이다."])).toEqual([]);
    expect(errors(["x는 170141183460469231731687303715884105728i128이다.", "끝이다."])[0]).toMatch(/^Y3N001/);
  });

  it("never let an integer literal become a known float type", () => {
    expect(errors(["x는 2.5f64이다.", "x에 1을 더한다.", "끝이다."])[0]).toMatch(/arithmetic needs two values of one type, not f64 and \{integer\}/);
    expect(errors(["끝이다."], ":반: (x: f32) → f32 ⟦\n[x를 돌려준다.]\n⟧\n").length).toBe(0);
    expect(errors(["y는 반: 1", "끝이다."], ":반: (x: f32) → f32 ⟦\n[x를 돌려준다.]\n⟧\n")[0]).toMatch(/argument 1 of ':반:' must be f32, not \{integer\}/);
  });

  it("never turn an integer literal into a float", () => {
    expect(errors(["x는 1.5이다.", "x에 1을 더한다.", "끝이다."])).toEqual([
      "Y3Y001 [x에 1을 더한다.] arithmetic needs two values of one type, not {float} and {integer}; convert one explicitly ('변환 …')",
    ]);
  });
});

describe("no implicit conversion", () => {
  it("refuses mixed arithmetic and comparison", () => {
    expect(errors(["x는 3i64이다.", "y는 2i32이다.", "x에 y를 더한다.", "끝이다."])[0]).toMatch(/arithmetic needs two values of one type, not i64 and i32/);
    expect(errors(["x는 3u64이다.", "y는 3i64이다.", "x가 y이면 끝이다.", "끝이다."])[0]).toMatch(/cannot compare u64 with i64/);
    expect(errors(["x는 3이다.", "y는 1.0이다.", "x가 y보다 크면 끝이다.", "끝이다."])[0]).toMatch(/cannot order \{integer\} against \{float\}/);
  });

  it("converts only through 변환, with faults for values that do not fit", () => {
    expect(out(["x는 300이다.", "y는 변환 u16: x", "z는 변환 f64: x", "y를 말한다.", "z를 말한다.", "끝이다."])).toEqual(["300", "300.0"]);
    expect(outcome(["x는 300이다.", "y는 변환 u8: x", "끝이다."])).toBe("FAULT: cannot convert 300 to u8: outside 0 … 255");
    expect(outcome(["x는 -1i64이다.", "y는 변환 u64: x", "끝이다."])).toBe("FAULT: cannot convert -1 to u64: outside 0 … 18446744073709551615");
    expect(out(["x는 -2.9이다.", "y는 변환 i32: x", "y를 말한다.", "끝이다."])).toEqual(["-2"]); // toward zero
    expect(outcome(["n은 0.0이다.", "x는 n이다.", "x를 n으로 나눈다.", "y는 변환 i64: x", "끝이다."])).toBe("FAULT: cannot convert NaN to i64");
  });
});

describe("checked arithmetic", () => {
  it("faults on overflow instead of wrapping, for every fixed width", () => {
    for (const t of FIXED) {
      const range = integerRange(t) as { min: bigint; max: bigint };
      expect(outcome([`x는 ${range.max}${t}이다.`, "x에 1을 더한다.", "끝이다."])).toBe(`FAULT: ${t} overflow: ${range.max} + 1 = ${range.max + 1n} is outside ${range.min} … ${range.max}`);
      expect(outcome([`x는 ${range.min}${t}이다.`, "x에서 1을 뺀다.", "끝이다."])).toMatch(new RegExp(`^FAULT: ${t} overflow`));
    }
  });

  it("divides toward zero, faults on division by zero and on MIN ÷ -1", () => {
    expect(out(["x는 -7이다.", "x를 2로 나눈다.", "x를 말한다.", "r은 수학 나머지: -7, 2", "r을 말한다.", "끝이다."])).toEqual(["-3", "-1"]);
    expect(outcome(["x는 1이다.", "x를 0으로 나눈다.", "끝이다."])).toBe("FAULT: i64 division by zero: 1 ÷ 0");
    expect(outcome(["x는 -128i8이다.", "x를 -1로 나눈다.", "끝이다."])).toMatch(/^FAULT: i8 overflow: -128 ÷ -1 = 128/);
    expect(outcome(["x는 -128i8이다.", "y는 수학 절댓값: x", "끝이다."])).toMatch(/^FAULT: i8 overflow: \|-128\| = 128/);
  });

  it("bigint has no bounds", () => {
    expect(out(["x는 170141183460469231731687303715884105727bigint이다.", "x에 x를 곱한다.", "x를 말한다.", "끝이다."])).toEqual([
      String(170141183460469231731687303715884105727n * 170141183460469231731687303715884105727n),
    ]);
  });

  // Property: in range, every operation agrees with exact integer arithmetic; out of
  // range, it always faults.
  it("agrees with mathematics in range and always faults outside it (property, 4000 cases)", () => {
    const r = prng(7);
    for (let i = 0; i < 4000; i += 1) {
      const t = r.pick(FIXED);
      const range = integerRange(t) as { min: bigint; max: bigint };
      const a = r.big(range.min, range.max);
      const b = r.big(range.min, range.max);
      const op = r.pick(["add", "sub", "mul", "div", "rem"] as const);
      if ((op === "div" || op === "rem") && b === 0n) {
        expect(() => arith(op, t, int(a), int(b))).toThrow(NumericFault);
        continue;
      }
      const exact = op === "add" ? a + b : op === "sub" ? a - b : op === "mul" ? a * b : op === "div" ? a / b : a % b;
      if (exact >= range.min && exact <= range.max) expect(arith(op, t, int(a), int(b))).toEqual(int(exact));
      else expect(() => arith(op, t, int(a), int(b)), `${t} ${a} ${op} ${b}`).toThrow(NumericFault);
    }
  });

  // Property: a conversion that fits is exact and reverses.
  it("converts exactly where the value fits, and back again (property)", () => {
    const r = prng(11);
    for (let i = 0; i < 2000; i += 1) {
      const from = r.pick(FIXED);
      const to = r.pick(FIXED);
      const fr = integerRange(from) as { min: bigint; max: bigint };
      const tr = integerRange(to) as { min: bigint; max: bigint };
      const v = r.big(fr.min, fr.max);
      if (v >= tr.min && v <= tr.max) {
        expect(convert(from, convert(to, int(v)))).toEqual(int(v));
        expect(convert("bigint", int(v))).toEqual(int(v));
      } else {
        expect(() => convert(to, int(v))).toThrow(NumericFault);
      }
    }
  });

  // Property: integer → f32 rounds once, to the nearest f32, ties to even.
  it("rounds integers to f32 exactly once (property)", () => {
    const r = prng(3);
    const f32Neighbours = (x: number) => {
      const buf = new DataView(new ArrayBuffer(4));
      buf.setFloat32(0, x);
      const bits = buf.getUint32(0);
      const at = (b: number) => {
        buf.setUint32(0, b);
        return buf.getFloat32(0);
      };
      return [at(bits - 1), at(bits + 1)];
    };
    for (let i = 0; i < 2000; i += 1) {
      const v = r.big(-(1n << 100n), 1n << 100n);
      const got = convert("f32", int(v));
      if (got.kind !== "float") throw new Error("float expected");
      const d = (x: number) => (BigInt(x) - v < 0n ? v - BigInt(x) : BigInt(x) - v);
      if (Math.abs(got.value) < 2 ** 24) continue; // exact
      for (const n of f32Neighbours(Math.abs(got.value)).map((n) => n * Math.sign(got.value))) {
        expect(d(got.value) <= d(n), `${v} → ${got.value}, but ${n} is closer`).toBe(true);
      }
    }
  });
});

describe("floats", () => {
  it("follow IEEE 754: NaN is not equal to itself, -0 equals 0, infinities", () => {
    const cells = ["z는 0.0이다.", "n은 z이다.", "n을 z로 나눈다.", "n이 n이면 \"NaN = NaN\"을 말한다.", "n이 n이 아니면 \"NaN ≠ NaN\"을 말한다.", "m은 -0.0이다.", "m이 z이면 \"-0 = 0\"을 말한다."];
    const more = ["i는 1.0이다.", "i를 z로 나눈다.", "i를 말한다.", "j는 -1.0이다.", "j를 z로 나눈다.", "j를 말한다.", "m을 말한다.", "n을 말한다.", "n이 z보다 작으면 \"NaN < 0\"을 말한다.", "n이 z보다 크거나 같으면 \"NaN ≥ 0\"을 말한다.", "끝이다."];
    expect(out([...cells, ...more])).toEqual(["NaN ≠ NaN", "-0 = 0", "+Inf", "-Inf", "-0.0", "NaN"]);
  });

  it("round each f32 operation to binary32", () => {
    expect(out(["x는 0.1f32이다.", "x에 0.2f32를 더한다.", "x를 말한다.", "y는 0.1이다.", "y에 0.2를 더한다.", "y를 말한다.", "끝이다."])).toEqual(["0.3", "0.30000000000000004"]);
  });

  it("print the shortest text that reads back (property)", () => {
    const r = prng(5);
    for (let i = 0; i < 3000; i += 1) {
      const bits = new DataView(new ArrayBuffer(8));
      bits.setUint32(0, Math.floor(r.next() * 2 ** 32));
      bits.setUint32(4, Math.floor(r.next() * 2 ** 32));
      const x = bits.getFloat64(0);
      const shown = formatFloat(x, 64);
      const back = shown === "+Inf" ? Infinity : shown === "-Inf" ? -Infinity : Number(shown);
      if (Number.isNaN(x)) expect(shown).toBe("NaN");
      else expect(Object.is(back, x), `${x} → ${shown}`).toBe(true);
      const y = Math.fround(x);
      const s32 = formatFloat(y, 32);
      if (!Number.isNaN(y) && Number.isFinite(y)) expect(Math.fround(Number(s32))).toBe(y);
    }
  });

  it("are never patterns or keys, and math stays in floats", () => {
    expect(errors(["x는 1.0이다.", "y는 x에 따라: 1.0 → 1, _ → 0", "끝이다."])[0]).toMatch(/floats are never patterns/);
    expect(errors(["s는 집합 새:", "s는 집합 넣기: s, 1.0", "끝이다."])[0]).toMatch(/^Y3N002/);
    expect(errors(["x는 수학 제곱근: 4", "끝이다."])[0]).toMatch(/must be \{float\}, not \{integer\}/);
    expect(out(["x는 수학 제곱근: 2.0", "x를 말한다.", "y는 수학 반올림: -2.5", "y를 말한다.", "z는 수학 내림: -0.5", "z를 말한다.", "끝이다."])).toEqual(["1.4142135623730951", "-3.0", "-1.0"]);
  });
});

describe("ordering", () => {
  it("feeds the spatial branch: 보다 크면, 작으면, 크거나 같으면, 작거나 같으면", () => {
    const cells = ["x는 3이다.", "x가 2보다 크면 \">\"를 말한다.", "x가 3보다 크거나 같으면 \"≥\"를 말한다.", "x가 3보다 작으면 \"<\"를 말한다.", "x가 3보다 작거나 같으면 \"≤\"를 말한다.", "끝이다."];
    const result = run(cells);
    expect(result.output).toEqual([">", "≥", "≤"]);
    expect(result.trace.flatMap((e) => e.effects.map(describeEffect))).toContain("test 3 > 2: yes");
  });

  it("drives a loop with an exit", () => {
    expect(out(["i는 0이다.", "여기가 처음이다.", "i에 1을 더한다.", "i가 5보다 작으면 끝은 처음이다.", "i를 말한다.", "끝이다."])).toEqual(["5"]);
  });

  it("orders runes by scalar value, and refuses Text", () => {
    expect(out(["a는 'a'이다.", "a가 'b'보다 작으면 \"a<b\"를 말한다.", "끝이다."])).toEqual(["a<b"]);
    expect(errors(['a는 "a"이다.', 'a가 "b"보다 작으면 끝이다.', "끝이다."])[0]).toMatch(/only numbers and runes are ordered, not Text/);
  });

  it("needs concrete values: ordering an open symbol is UNRESOLVED", () => {
    expect(run(["x는 미정이다.", "x가 3보다 크면 끝이다.", "끝이다."]).outcome.status).toBe("UNRESOLVED");
  });
});

describe("the temporal numeric boundary", () => {
  it("makes temporal integers bigint, and refuses any other number as a temporal value", () => {
    expect(types(["x는 미정이다.", "x에 1을 더한다.", "x는 4였다.", "끝이다."])).toEqual({ x: "bigint" });
    expect(errors(["x는 미정이다.", "x는 3i64였다.", "끝이다."])[0]).toBe(
      "Y3Y004 [x는 미정이다.] 'x' is i64; a temporal value (미정) must be bigint or Text, the sorts the temporal solver knows",
    );
    expect(errors(["x는 미정이다.", "x는 1.5였다.", "끝이다."])[0]).toMatch(/^Y3Y004 .* 'x' is f64/);
    expect(errors(["x가 다음에서 온다.", "x는 1u8이다.", "x를 전으로 보낸다.", "끝이다."])[0]).toMatch(/^Y3Y004 .* 'x' is u8/);
  });

  it("does not let a clock reading or input become a symbol", () => {
    expect(errors(["t는 시계 지금:", "x는 미정이다.", "x는 t였다.", "끝이다."])[0]).toMatch(/^Y3Y004 .*'x' is i64/);
    expect(errors(["l은 표준 줄읽기:", "x는 미정이다.", "x는 l이었다.", "끝이다."])[0]).toMatch(/^Y3Y004 .*'x' is Option<Text>/);
  });

  it("an explicit conversion out of the temporal world needs the value now", () => {
    const result = run(["x는 미정이다.", "y는 변환 i64: x", "끝이다."]);
    expect(result.outcome.status).toBe("UNRESOLVED");
    expect(run(["x는 미정이다.", "x는 7이었다.", "y는 변환 i64: x", "y를 말한다.", "끝이다."]).output).toEqual(["7"]);
  });

  it("multiplying or dividing a symbol is UNRESOLVED: time solves straight lines", () => {
    expect(run(["x는 미정이다.", "x에 2를 곱한다.", "끝이다."]).outcome.status).toBe("UNRESOLVED");
    expect(run(["x는 미정이다.", "x에 x를 더한다.", "x는 6이었다.", "x를 말한다.", "끝이다."]).output).toEqual(["6"]); // addition is still linear
  });

  it("keeps M3–M6 temporal programs as they were", () => {
    expect(run(["값은 미정이다.", "원래는 값이다.", "값에 1을 더한다.", "원래를 말한다.", "값은 4였다.", "끝이다."]).output).toEqual(["3"]);
  });
});

describe("text and runes", () => {
  it("distinguishes runes, UTF-8 bytes and grapheme clusters", () => {
    // e + combining acute, an emoji outside the BMP, a Hangul syllable.
    const s = '"é😀가"';
    expect(out([`s는 ${s}이다.`, "a는 글 길이: s", "b는 글 바이트길이: s", "c는 글 글자수: s", "a를 말한다.", "b를 말한다.", "c를 말한다.", "끝이다."])).toEqual(["4", "10", "3"]);
  });

  it("slices by rune, never by UTF-16 unit or byte", () => {
    expect(out(['s는 "a😀b"이다.', "t는 글 자르기: s, 1, 2", "t를 말한다.", "u는 글 자르기: s, 2, 3", "u를 말한다.", "끝이다."])).toEqual(["😀", "b"]);
    expect(outcome(['s는 "a😀b"이다.', "t는 글 자르기: s, 0, 4", "끝이다."])).toBe("FAULT: bound 4 is out of range for 3 elements");
    expect(errors(['s는 "abc"이다.', "c는 s의 0번이다.", "끝이다."])[0]).toMatch(/an element needs an array, a slice or a List/);
  });

  it("has rune literals, including the space and escapes", () => {
    expect(out(["a는 ' '이다.", "b는 '\\n'이다.", "c는 '😀'이다.", "l은 목록 만들기: a, c", "t는 글 모으기: l", "t를 말한다.", "끝이다."])).toEqual([" 😀"]);
    expect(types(["a는 '가'이다.", "끝이다."])).toEqual({ a: "Rune" });
  });

  it("splits, joins, searches and parses", () => {
    const cells = ['s는 "가,나,다"이다.', 'l은 글 나누기: s, ","', 'j는 글 잇기: l, "/"', "j를 말한다.", 'p는 글 포함: s, "나"', "p를 말한다.", 'q는 글 시작함: s, "가"', "q를 말한다.", 'e는 글 끝남: s, "가"', "e를 말한다."];
    const parse = ['n은 글 정수로: "42"', "n을 말한다.", 'm은 글 정수로: "4x"', "m을 말한다.", 'o는 글 정수로: "9223372036854775808"', "o를 말한다.", 'f는 글 실수로: "-0.5"', "f를 말한다.", "끝이다."];
    expect(out([...cells, ...parse])).toEqual(["가/나/다", "참", "참", "거짓", "Ok(42)", `Err(Invalid("'4x' is not an integer"))`, `Err(OutOfRange("9223372036854775808 does not fit in i64"))`, "Ok(-0.5)"]);
  });

  it("round-trips any Unicode text through runes (property)", () => {
    const r = prng(13);
    for (let i = 0; i < 300; i += 1) {
      const chars = Array.from({ length: Math.floor(r.next() * 8) }, () => {
        const pick = r.next();
        const cp = pick < 0.3 ? 0x20 + Math.floor(r.next() * 0x5e) : pick < 0.5 ? 0x0300 + Math.floor(r.next() * 0x70) : pick < 0.7 ? 0xac00 + Math.floor(r.next() * 11172) : 0x1f300 + Math.floor(r.next() * 0x300);
        return String.fromCodePoint(cp);
      });
      const s = chars.join("").replaceAll("\\", "").replaceAll('"', "");
      const result = run([`s는 ${JSON.stringify(s)}이다.`, "l은 글 문자들: s", "t는 글 모으기: l", "t가 s이면 \"같다\"를 말한다.", "n은 글 길이: s", "n을 말한다.", "b는 글 바이트길이: s", "b를 말한다.", "끝이다."]);
      expect(result.output).toEqual(["같다", String([...s].length), String(new TextEncoder().encode(s).length)]);
    }
  });

  it("makes a rune from a scalar value, refusing surrogates", () => {
    expect(out(["a는 글 문자: 44032u32", "a를 말한다.", "b는 글 문자: 55296u32", "b를 말한다.", "끝이다."])).toEqual(["Some('가')", "None"]);
  });
});

describe("records by name", () => {
  const POINT = "자료 점 = { 가로: i64, 세로: i64 }\n";
  it("builds a record from named fields in any order", () => {
    expect(out(["a는 점: 가로=3, 세로=4", "b는 점: 세로=4, 가로=3", "a가 b이면 \"같다\"를 말한다.", "a를 말한다.", "끝이다."], POINT)).toEqual(["같다", "점(3, 4)"]);
  });

  it("refuses duplicate, missing, unknown and mixed fields", () => {
    expect(errors(["a는 점: 가로=3, 가로=4", "끝이다."], POINT)).toEqual(["Y3Y006 [a는 점: 가로=3, 가로=4] field '가로' is given twice"]);
    expect(errors(["a는 점: 가로=3", "끝이다."], POINT)).toEqual(["Y3Y006 [a는 점: 가로=3] '점' needs '세로' too"]);
    expect(errors(["a는 점: 가로=3, 높이=4", "끝이다."], POINT)).toEqual(["Y3Y006 [a는 점: 가로=3, 높이=4] '점' has no field '높이'; it has 가로, 세로"]);
    expect(errors(["a는 점: 가로=3, 4", "끝이다."], POINT)).toEqual(["Y3G012 [a는 점: 가로=3, 4] write every argument by name ('가로=3') or none"]);
    expect(errors(["a는 Some: 값=3", "끝이다."])).toEqual(["Y3Y006 [a는 Some: 값=3] 'Some' takes its fields in order; only a record's fields have names"]);
  });

  it("keeps positional construction", () => {
    expect(out(["a는 점: 3, 4", "a를 말한다.", "끝이다."], POINT)).toEqual(["점(3, 4)"]);
  });
});

describe("arrays and slices: value semantics", () => {
  // Property: writing a copy never changes the original; a slice sees the version it
  // was taken from.
  it("copies are independent and slices are persistent views (property)", () => {
    const r = prng(17);
    for (let i = 0; i < 60; i += 1) {
      const n = 1 + Math.floor(r.next() * 5);
      const xs = Array.from({ length: n }, () => Math.floor(r.next() * 100));
      const from = Math.floor(r.next() * (n + 1));
      const to = from + Math.floor(r.next() * (n - from + 1));
      const writes = Array.from({ length: 1 + Math.floor(r.next() * 4) }, () => [Math.floor(r.next() * n), Math.floor(r.next() * 100)] as const);
      const cells = [`a는 배열: ${xs.join(", ")}`, "b는 a이다.", `s는 배열 자르기: a, ${from}, ${to}`, ...writes.map(([k, v]) => `b의 ${k}번은 ${v}이다.`), ...writes.map(([k, v]) => `a의 ${k}번은 ${v + 1}이다.`), "a를 말한다.", "b를 말한다.", "s를 말한다.", "끝이다."];
      const b = [...xs];
      const a = [...xs];
      for (const [k, v] of writes) b[k] = v;
      for (const [k, v] of writes) a[k] = v + 1;
      expect(out(cells)).toEqual([`[${a.join(", ")}]`, `[${b.join(", ")}]`, `[${xs.slice(from, to).join(", ")}]`]);
    }
  });

  it("handles empty and nested slices", () => {
    expect(out(["a는 배열: 1, 2, 3", "e는 배열 자르기: a, 3, 3", "e를 말한다.", "n은 배열 길이: e", "n을 말한다.", "s는 배열 자르기: a, 1, 3", "t는 배열 자르기: s, 1, 2", "t를 말한다.", "끝이다."])).toEqual(["[]", "0", "[3]"]);
    expect(outcome(["a는 배열: 1, 2, 3", "s는 배열 자르기: a, 1, 3", "t는 배열 자르기: s, 0, 3", "끝이다."])).toBe("FAULT: slice bound 3 is out of range for 2 elements");
  });
});

describe("collections", () => {
  it("List: build, push, index, get, and lists are values", () => {
    const cells = ["l은 목록 만들기: 1, 2, 3", "m은 목록 추가: l, 4", "l을 말한다.", "m을 말한다.", "x는 m의 3번이다.", "x를 말한다.", "g는 목록 가져오기: m, 9", "g를 말한다.", "n은 목록 길이: m", "n을 말한다.", "끝이다."];
    expect(out(cells)).toEqual(["[1, 2, 3]", "[1, 2, 3, 4]", "4", "None", "4"]);
  });

  it("Map: insert, find, remove, keys in insertion order", () => {
    const cells = ["m은 사전 새:", 'm은 사전 넣기: m, "둘", 2', 'm은 사전 넣기: m, "하나", 1', 'm은 사전 넣기: m, "둘", 22', "k는 사전 열쇠들: m", "k를 말한다.", 'v는 사전 찾기: m, "둘"', "v를 말한다.", 'm은 사전 빼기: m, "둘"', "n은 사전 길이: m", "n을 말한다.", 'h는 사전 포함: m, "둘"', "h를 말한다.", "끝이다."];
    expect(out(cells)).toEqual([`["둘", "하나"]`, "Some(22)", "1", "거짓"]);
  });

  it("Set: no duplicates; records of keys are keys", () => {
    const cells = ["s는 집합 새:", "a는 점: 1, 2", "b는 점: 가로=1, 세로=2", "s는 집합 넣기: s, a", "s는 집합 넣기: s, b", "n은 집합 길이: s", "n을 말한다.", "끝이다."];
    expect(out(cells, "자료 점 = { 가로: i64, 세로: i64 }\n")).toEqual(["1"]);
  });

  it("refuses keys whose equality is not reflexive or not structural", () => {
    expect(errors(["m은 사전 새:", "m은 사전 넣기: m, 1.5, 1", "끝이다."])[0]).toMatch(/^Y3N002 .*not f64/);
    expect(errors(["a는 배열: 1", "s는 집합 새:", "s는 집합 넣기: s, a", "끝이다."])[0]).toMatch(/^Y3N002 .*not \[i64; 1\]/);
    expect(errors(["s는 집합 새:", "l은 목록 새:", "s는 집합 넣기: s, l", "끝이다."])[0]).toMatch(/^Y3N002 .*not List/);
    expect(errors(["s는 집합 새:", "s는 집합 넣기: s, 점: 1.5", "끝이다."], "자료 점 = { x: f64 }\n").length).toBeGreaterThan(0);
  });

  // Property: keyOf agrees with equality on key values.
  it("hashes equal keys equally and different keys differently (property)", () => {
    const r = prng(19);
    const value = (depth: number): ConcreteValue => {
      const k = r.next();
      if (k < 0.2) return int(BigInt(Math.floor(r.next() * 5) - 2));
      if (k < 0.3) return int((1n << 53n) + BigInt(Math.floor(r.next() * 3))); // past exact doubles
      if (k < 0.5) return text(r.pick(["", "a", "가", "a,b", '"']));
      if (k < 0.6) return { kind: "bool", value: r.next() < 0.5 };
      if (k < 0.7) return { kind: "rune", value: r.pick([97, 44032, 128512]) };
      if (depth > 2) return { kind: "unit" };
      return { kind: "data", type: r.pick(["P", "Q"]), variant: r.pick([null, "A"]), fields: Array.from({ length: Math.floor(r.next() * 3) }, () => value(depth + 1)) };
    };
    for (let i = 0; i < 3000; i += 1) {
      const a = value(0);
      const b = r.next() < 0.3 ? a : value(0);
      expect(keyOf(a) === keyOf(b), `${keyOf(a)} vs ${keyOf(b)}`).toBe(sameValue(a, b));
    }
  });
});

describe("std/io", () => {
  it("말한다 and 표준 줄출력 are one output path; 출력 writes without a line break", () => {
    const result = run(["1을 말한다.", "표준 줄출력: 2", '표준 출력: "a"', '표준 출력: "b"', "표준 줄출력: 3", "끝이다."]);
    expect(result.host.stdout.join("")).toBe("1\n2\nab3\n");
    expect(result.output).toEqual(["1", "2", "ab3"]);
  });

  it("formats with {} holes, checked statically when the template is written out", () => {
    expect(out(['s는 표준 형식: "{} + {} = {{{}}}", 1, 2, 3', "s를 말한다.", "끝이다."])).toEqual(["1 + 2 = {3}"]);
    expect(errors(['s는 표준 형식: "{}와 {}", 1', "끝이다."])).toEqual([`Y3Y003 [s는 표준 형식: "{}와 {}", 1] the template has 2 '{}' for 1 value`]);
  });

  it("reads lines and tokens from stdin, None at the end, and records them", () => {
    const host = memoryHost({ stdin: "첫 줄\n  12 34\n" });
    const result = run(["a는 표준 줄읽기:", "b는 표준 낱말읽기:", "c는 표준 낱말읽기:", "d는 표준 낱말읽기:", "a를 말한다.", "b를 말한다.", "c를 말한다.", "d를 말한다.", "끝이다."], "", host);
    expect(result.output).toEqual([`Some("첫 줄")`, `Some("12")`, `Some("34")`, "None"]);
    expect(result.events.map((e) => `${e.source} ${e.value}`)).toEqual(['stdin.line "첫 줄"', 'stdin.token "12"', 'stdin.token "34"', "stdin.token <end>"]);
  });

  it("input is grounded: a past statement can only check it, never rewrite it", () => {
    const host = memoryHost({ stdin: "5\n" });
    const result = run(["l은 표준 줄읽기:", 'x는 l에 따라: Some(t) → t, None → ""', 'x는 "6"이었다.', "끝이다."], "", host);
    expect(result.outcome.status).toBe("PARADOX");
  });

  it("commits output in order; a held write holds the writes after it until it is known", () => {
    const host = memoryHost();
    const result = run(["x는 미정이다.", "x를 말한다.", '"뒤"를 말한다.', "x는 7이었다.", "끝이다."], "", host);
    expect(result.output).toEqual(["7", "뒤"]);
    expect(host.stdout).toEqual(["7\n", "뒤\n"]);
  });

  it("an effect other than output needs its value now: a symbol is UNRESOLVED at the boundary", () => {
    expect(run(["x는 미정이다.", "t는 글 글로: x", 'r은 파일 쓰기: "a", t', "끝이다."]).outcome.status).toBe("UNRESOLVED");
  });
});

describe("std/fs", () => {
  it("reads, writes, opens, appends and closes", () => {
    const host = memoryHost({ files: { "a.txt": "가" } });
    const cells = ['r은 파일 읽기: "a.txt"', "r을 말한다.", 'w는 파일 쓰기: "b.txt", "나"', 'f는 파일 열기: "b.txt"', "h는 결과 꺼내기: f", 'd는 파일 덧쓰기: h, "다"', "c는 파일 닫기: h", 'e는 파일 덧쓰기: h, "라"', "e를 말한다.", 'b는 파일 읽기: "b.txt"', "b를 말한다.", 'i는 파일 정보: "b.txt"', "s는 i에 따라: Ok(x) → x의 크기, Err(_) → 0u64", "s를 말한다.", 'z는 파일 존재: "없다"', "z를 말한다.", "끝이다."];
    expect(out(cells, "", host)).toEqual([`Ok("가")`, `Err(Closed("b.txt is closed"))`, `Ok("나다")`, "6", "거짓"]);
  });

  it("reports failures as Result values, never FAULT", () => {
    const result = run(['r은 파일 읽기: "없음.txt"', 't는 r에 따라: Ok(s) → s, Err(NotFound(p)) → "없음", Err(_) → "다른 오류"', "t를 말한다.", "끝이다."]);
    expect(result.output).toEqual(["없음"]);
    expect(result.outcome.status).toBe("HALT");
    const host = memoryHost();
    host.files.set("bad.txt", new Uint8Array([0xff, 0xfe]));
    expect(out(['r은 파일 읽기: "bad.txt"', "r을 말한다.", "끝이다."], "", host)).toEqual([`Err(Other("the file is not valid UTF-8"))`]);
  });

  it("joins paths", () => {
    expect(out(['p는 파일 경로잇기: "a/", "b.txt"', "p를 말한다.", 'q는 파일 경로잇기: "a", "/etc"', "q를 말한다.", "끝이다."])).toEqual(["a/b.txt", "/etc"]);
  });
});

describe("std/clock", () => {
  it("reads the wall clock and a monotonic clock as recorded, concrete i64 events", () => {
    const result = run(["t는 시계 지금:", "a는 시계 단조:", "b는 시계 단조:", "b가 a보다 크면 \"증가\"를 말한다.", "t를 말한다.", "끝이다."], "", memoryHost({ now: 1700000000000n }));
    expect(result.output).toEqual(["증가", "1700000000000"]);
    expect(result.events.map((e) => e.source)).toEqual(["clock.now", "clock.monotonic", "clock.monotonic"]);
    expect(types(["t는 시계 지금:", "끝이다."])).toEqual({ t: "i64" });
  });
});

describe("std/math", () => {
  it("is generic over one numeric type at a time", () => {
    expect(out(["a는 수학 최댓값: 3u8, 7u8", "a를 말한다.", "b는 수학 최솟값: -1.5, 2.0", "b를 말한다.", "c는 수학 범위: 15, 0, 10", "c를 말한다.", "d는 수학 올림: 1.2f32", "d를 말한다.", "끝이다."])).toEqual(["7", "-1.5", "10", "2.0"]);
    expect(errors(["a는 수학 최댓값: 3u8, 7i8", "끝이다."])[0]).toMatch(/^Y3Y001/);
    expect(outcome(["c는 수학 범위: 1, 10, 0", "끝이다."])).toMatch(/^FAULT: a range cannot run from 10 down to 0/);
  });
});

describe("ordinary errors and machine outcomes stay apart", () => {
  it("a Result is a value the program handles; a FAULT ends the run", () => {
    expect(run(['r은 글 정수로: "x"', 'm은 r에 따라: Ok(n) → "수", Err(_) → "아님"', "m을 말한다.", "끝이다."]).outcome.status).toBe("HALT");
    expect(run(["l은 목록 새:", "x는 l의 0번이다.", "끝이다."]).outcome.status).toBe("FAULT");
  });

  it("FAULT is reported with the cell it happened in, and nothing after it runs", () => {
    const result = run(["x는 255u8이다.", "x에 1을 더한다.", '"닿지 않음"을 말한다.', "끝이다."]);
    expect(result.output).toEqual([]);
    expect(result.outcome).toMatchObject({ status: "FAULT", at: { x: 0, y: 1, z: 0 } });
  });
});

describe("taking values out of Option and Result", () => {
  it("아니면 gives a default; 꺼내기 is an explicit assertion that FAULTs on Err or None", () => {
    expect(out(['n은 글 정수로: "x"', "v는 결과 아니면: n, 0", "v를 말한다.", "o는 None이다.", "w는 선택 아니면: o, 5", "w를 말한다.", "끝이다."])).toEqual(["0", "5"]);
    expect(outcome(['n은 글 정수로: "x"', "v는 결과 꺼내기: n", "끝이다."])).toBe(`FAULT: '결과 꺼내기' found Err(Invalid("'x' is not an integer"))`);
    expect(outcome(["o는 None이다.", "v는 선택 꺼내기: o", "끝이다."])).toBe("FAULT: '선택 꺼내기' found None");
  });
});
