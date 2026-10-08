import { describe, expect, it } from "vitest";
import { endingOf, parseSentence, SENTENCE_CODES as CODES, type SentenceAst } from "../../src/v2";

function ok(text: string): SentenceAst {
  const result = parseSentence(text);
  if (!result.sentence) {
    throw new Error(`expected '${text}' to parse: ${result.issues.map((i) => i.message).join("; ")}`);
  }
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  return result.sentence;
}

function rejected(text: string): string {
  const result = parseSentence(text);
  expect(result.sentence, text).toBeNull();
  const error = result.issues.find((issue) => issue.severity === "error");
  if (!error) throw new Error(`expected an error for '${text}'`);
  return error.code;
}

const int = (value: number) => ({ kind: "int", value: BigInt(value) });
const noun = (name: string) => ({ kind: "noun", name });

describe("present-tense sentences", () => {
  const cases: [string, unknown][] = [
    ["값은 3이다.", { kind: "assign", noun: "값", value: int(3) }],
    ["값은 -3이다.", { kind: "assign", noun: "값", value: int(-3) }],
    ['인사는 "안녕"이다.', { kind: "assign", noun: "인사", value: { kind: "text", value: "안녕" } }],
    ["합은 값이다.", { kind: "assign", noun: "합", value: noun("값") }],
    ["값에 1을 더한다.", { kind: "add", noun: "값", amount: int(1) }],
    ["값에 수를 더한다.", { kind: "add", noun: "값", amount: noun("수") }],
    ["값에서 2를 뺀다.", { kind: "subtract", noun: "값", amount: int(2) }],
    ["값을 말한다.", { kind: "say", value: noun("값") }],
    ['"다른 수"를 말한다.', { kind: "say", value: { kind: "text", value: "다른 수" } }],
    ['"따옴표 \\" 안"을 말한다.', { kind: "say", value: { kind: "text", value: '따옴표 " 안' } }],
    ["오른쪽을 본다.", { kind: "turn", turn: "right" }],
    ["왼쪽을 본다.", { kind: "turn", turn: "left" }],
    ["뒤를 본다.", { kind: "turn", turn: "around" }],
    ["위를 본다.", { kind: "turn", turn: "up" }],
    ["아래를 본다.", { kind: "turn", turn: "down" }],
    ["동쪽을 본다.", { kind: "face", compass: "east" }],
    ["북쪽을 본다.", { kind: "face", compass: "north" }],
    ["앞으로 간다.", { kind: "step", relative: "forward" }],
    ["뒤로 간다.", { kind: "step", relative: "back" }],
    ["오른쪽으로 간다.", { kind: "step", relative: "right" }],
    ["위로 간다.", { kind: "step", relative: "up" }],
    ["위층으로 간다.", { kind: "floor", delta: 1 }],
    ["아래층으로 간다.", { kind: "floor", delta: -1 }],
    ["여기가 처음이다.", { kind: "anchor" }],
    ["끝은 처음이다.", { kind: "back" }],
    ["끝이다.", { kind: "end" }],
    [
      "값이 2이면 위층으로 간다.",
      { kind: "when", condition: { left: noun("값"), right: int(2), negated: false }, then: { kind: "floor", delta: 1 } },
    ],
    [
      "값이 0이 아니면 끝은 처음이다.",
      { kind: "when", condition: { left: noun("값"), right: int(0), negated: true }, then: { kind: "back" } },
    ],
    [
      '이름이 "이상"이면 "날자"를 말한다.',
      {
        kind: "when",
        condition: { left: noun("이름"), right: { kind: "text", value: "이상" }, negated: false },
        then: { kind: "say", value: { kind: "text", value: "날자" } },
      },
    ],
  ];
  for (const [text, expected] of cases) {
    it(text, () => {
      expect(ok(text)).toEqual(expected);
    });
  }

  it("lets particles, not word order, assign roles", () => {
    expect(ok("1을 값에 더한다.")).toEqual(ok("값에 1을 더한다."));
    expect(ok("2를 값에서 뺀다.")).toEqual(ok("값에서 2를 뺀다."));
  });

  it("ignores how many spaces separate words", () => {
    expect(ok("값에   1을    더한다.")).toEqual(ok("값에 1을 더한다."));
  });
});

describe("orthography is lint, not syntax", () => {
  const lint = (text: string) => {
    const result = parseSentence(text);
    expect(result.sentence, text).not.toBeNull();
    return result.issues.filter((issue) => issue.code === CODES.NON_CANONICAL).map((issue) => issue.message);
  };

  it("accepts a non-canonical allomorph and reports the canonical one", () => {
    expect(ok("값를 말한다.")).toEqual(ok("값을 말한다."));
    expect(lint("값를 말한다.")).toEqual(["non-canonical Korean: write '값을' instead of '값를'"]);
    expect(lint("값는 3이다.")).toEqual(["non-canonical Korean: write '값은' instead of '값는'"]);
    expect(lint("위층로 간다.")).toEqual(["non-canonical Korean: write '위층으로' instead of '위층로'"]);
  });

  it("uses the Sino-Korean reading of numbers", () => {
    expect(lint("값에 3를 더한다.")).toEqual(["non-canonical Korean: write '3을' instead of '3를'"]); // 삼
    expect(lint("값에 2을 더한다.")).toEqual(["non-canonical Korean: write '2를' instead of '2을'"]); // 이
    expect(lint("값에 10를 더한다.")).toEqual(["non-canonical Korean: write '10을' instead of '10를'"]); // 십
    expect(lint("값에 5를 더한다.")).toEqual([]); // 오
    expect(lint("값에 1을 더한다.")).toEqual([]); // 일
  });

  it("reads endings correctly", () => {
    expect(endingOf("3")).toBe("consonant"); // 삼
    expect(endingOf("4")).toBe("vowel"); // 사
    expect(endingOf("1")).toBe("rieul"); // 일
    expect(endingOf("0")).toBe("consonant"); // 영
    expect(endingOf("20")).toBe("consonant"); // 이십
    expect(endingOf("100")).toBe("consonant"); // 백
    expect(endingOf("-9")).toBe("vowel"); // 구
    expect(endingOf("값")).toBe("consonant");
    expect(endingOf("발사")).toBe("vowel");
    expect(endingOf('"둘"')).toBe("rieul");
    expect(endingOf('"abc"')).toBeNull();
  });
});

describe("past and future tense are relations (M3)", () => {
  const relations: [string, unknown][] = [
    ["값은 미정이다.", { kind: "declare", noun: "값" }],
    ["값은 3이었다.", { kind: "assert", noun: "값", anchor: null, value: int(3) }],
    ["값은 4였다.", { kind: "assert", noun: "값", anchor: null, value: int(4) }],
    ["원래는 값이었다.", { kind: "assert", noun: "원래", anchor: null, value: noun("값") }],
    ['이름은 "이상"이었다.', { kind: "assert", noun: "이름", anchor: null, value: { kind: "text", value: "이상" } }],
    ["값은 5일 것이다.", { kind: "promise", noun: "값", anchor: null, value: int(5) }],
    ["합은 값일 것이다.", { kind: "promise", noun: "합", anchor: null, value: noun("값") }],
  ];
  for (const [text, expected] of relations) {
    it(text, () => {
      expect(ok(text)).toEqual(expected);
    });
  }

  it("lints the past-tense allomorph by the Sino-Korean reading", () => {
    const lint = (text: string) => parseSentence(text).issues.map((issue) => issue.message);
    expect(lint("값은 3였다.")).toEqual(["non-canonical Korean: write '3이었다' instead of '3였다'"]);
    expect(lint("값은 4이었다.")).toEqual(["non-canonical Korean: write '4였다' instead of '4이었다'"]);
    expect(ok("값은 3였다.")).toEqual(ok("값은 3이었다."));
  });

  it("keeps relations out of conditions: a consequence is present tense", () => {
    expect(rejected("값이 2이면 수는 3이었다.")).toBe(CODES.BAD_CONDITIONAL);
    expect(rejected("값이 2이면 수는 3일 것이다.")).toBe(CODES.BAD_CONDITIONAL);
  });
});

describe("temporal cycles (M4)", () => {
  const cycles: [string, unknown][] = [
    ["수가 다음에서 온다.", { kind: "receive", noun: "수" }],
    ["다음에서 수가 온다.", { kind: "receive", noun: "수" }],
    ["수를 전으로 보낸다.", { kind: "send", noun: "수" }],
    ["처음은 끝이었다.", { kind: "fixed" }],
    ["처음의 값은 0이었다.", { kind: "assert", noun: "값", anchor: "처음", value: int(0) }],
    ["끝의 값은 0일 것이다.", { kind: "promise", noun: "값", anchor: "끝", value: int(0) }],
    ["원래는 처음의 값이다.", { kind: "assign", noun: "원래", value: { kind: "anchored", anchor: "처음", name: "값" } }],
    ["결과는 끝의 합이다.", { kind: "assign", noun: "결과", value: { kind: "anchored", anchor: "끝", name: "합" } }],
    ["처음의 값을 말한다.", { kind: "say", value: { kind: "anchored", anchor: "처음", name: "값" } }],
  ];
  for (const [text, expected] of cycles) {
    it(text, () => {
      expect(ok(text)).toEqual(expected);
    });
  }

  const wrong: [string, string][] = [
    ["처음의 값은 3이다.", CODES.ANCHOR_WRITE],
    ["끝의 값에 1을 더한다.", CODES.ANCHOR_WRITE],
    ["처음의 값은 0일 것이다.", CODES.ANCHOR_TENSE],
    ["끝의 값은 0이었다.", CODES.ANCHOR_TENSE],
    ["끝은 처음일 것이다.", CODES.UNKNOWN_SENTENCE],
    ["수가 전에서 온다.", CODES.WRONG_ROLES],
    ["수를 다음으로 보낸다.", CODES.WRONG_ROLES],
    ["3을 전으로 보낸다.", CODES.BAD_PHRASE],
  ];
  for (const [text, code] of wrong) {
    it(`rejects ${text}`, () => {
      expect(rejected(text)).toBe(code);
    });
  }
});

describe("forms outside the core are recognised, not run", () => {
  const later: [string, string][] = [
    ["결과가 0일 것이라면 남쪽을 본다.", CODES.TEMPORAL_LATER],
    ["값에 2를 곱한다.", CODES.FEATURE_LATER],
    ["값을 듣는다.", CODES.FEATURE_LATER],
    ["값에 1을 더했다.", CODES.VERB_TENSE],
    ["값에 1을 더할 것이다.", CODES.VERB_TENSE],
  ];
  for (const [text, code] of later) {
    it(text, () => {
      expect(rejected(text)).toBe(code);
    });
  }
});

describe("rejected sentences", () => {
  const errors: [string, string][] = [
    ["값은 3이다", CODES.NO_FULL_STOP],
    ["값을 춤춘다.", CODES.UNKNOWN_SENTENCE],
    ["값 1을 더한다.", CODES.BAD_PHRASE],
    ["값을 더한다.", CODES.WRONG_ROLES],
    ["값에 1을 2를 더한다.", CODES.WRONG_ROLES],
    ["값은 3을 이다.", CODES.WRONG_ROLES],
    ["앞을 본다.", CODES.UNKNOWN_DIRECTION],
    ["옆으로 간다.", CODES.UNKNOWN_DIRECTION],
    ["처음은 3이다.", CODES.RESERVED_NOUN],
    ["위는 3이다.", CODES.RESERVED_NOUN],
    ["값이 2이면.", CODES.BAD_CONDITIONAL],
    ["값이 2이면 여기가 처음이다.", CODES.BAD_CONDITIONAL],
    ["값이 2이면 수가 3이면 끝이다.", CODES.BAD_CONDITIONAL],
    ['"열린을 말한다.', CODES.BAD_PHRASE],
  ];
  for (const [text, code] of errors) {
    it(text, () => {
      expect(rejected(text)).toBe(code);
    });
  }
});
