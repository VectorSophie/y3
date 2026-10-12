import { RuntimeFault } from "../semantics/fault";
import { integerRange } from "../types/types";
import { int, renderValue, rune, type ConcreteValue } from "../semantics/values";
import { BOOL, F64, I64, named, prim, RUNE, TEXT } from "../types/types";
import { asInt, asList, asText, bool, err, list, listOf, namespace, none, ok, option, position, result, some, T, text, variant } from "./core";

// std/text (글). Text is a sequence of Unicode scalar values, stored as UTF-8. There is
// no direct indexing: positions count scalars (runes), never bytes or UTF-16 units.
//   길이       scalars (runes)            "é" → 2
//   바이트길이  UTF-8 bytes                 "가" → 3
//   글자수     grapheme clusters (UAX #29, as the host's ICU segments them)  "é" → 1

const scalars = (s: string): string[] => [...s];
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const PARSE_ERROR = named("ParseError");

function parseInteger(source: string): ConcreteValue {
  if (!/^[+-]?\d+$/u.test(source)) return err(variant("ParseError", "Invalid", text(`'${source}' is not an integer`)));
  const value = BigInt(source);
  const range = integerRange("i64");
  if (range && (value < range.min || value > range.max)) return err(variant("ParseError", "OutOfRange", text(`${source} does not fit in i64`)));
  return ok(int(value));
}

function parseFloat(source: string): ConcreteValue {
  const named: Record<string, number> = { NaN: NaN, "+Inf": Infinity, Inf: Infinity, "-Inf": -Infinity };
  if (source in named) return ok({ kind: "float", value: named[source] as number, width: 64 });
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u.test(source)) return err(variant("ParseError", "Invalid", text(`'${source}' is not a number`)));
  return ok({ kind: "float", value: Number(source), width: 64 });
}

export const TEXT_LIBRARY = namespace("std.text", "글", {
  length: ["길이", { kind: "pure", signature: { params: [TEXT], result: I64 }, apply: ([s]) => int(BigInt(scalars(asText(s)).length)) }],
  byteLength: ["바이트길이", { kind: "pure", signature: { params: [TEXT], result: I64 }, apply: ([s]) => int(BigInt(encoder.encode(asText(s)).length)) }],
  graphemes: ["글자수", { kind: "pure", signature: { params: [TEXT], result: I64 }, apply: ([s]) => int(BigInt([...segmenter.segment(asText(s))].length)) }],
  contains: ["포함", { kind: "pure", signature: { params: [TEXT, TEXT], result: BOOL }, apply: ([s, x]) => bool(asText(s).includes(asText(x))) }],
  startsWith: ["시작함", { kind: "pure", signature: { params: [TEXT, TEXT], result: BOOL }, apply: ([s, x]) => bool(asText(s).startsWith(asText(x))) }],
  endsWith: ["끝남", { kind: "pure", signature: { params: [TEXT, TEXT], result: BOOL }, apply: ([s, x]) => bool(asText(s).endsWith(asText(x))) }],
  slice: [
    "자르기",
    {
      kind: "pure",
      signature: { params: [TEXT, I64, I64], result: TEXT },
      apply: ([s, from, to]) => {
        const all = scalars(asText(s));
        const a = position(asInt(from), all.length, "bound");
        const b = position(asInt(to), all.length, "bound");
        if (a > b) throw new RuntimeFault(`a subtext cannot start at ${a} and end at ${b}`);
        return text(all.slice(a, b).join(""));
      },
    },
  ],
  split: [
    "나누기",
    {
      kind: "pure",
      signature: { params: [TEXT, TEXT], result: listOf(TEXT) },
      // An empty separator splits between runes.
      apply: ([s, sep]) => list((asText(sep) === "" ? scalars(asText(s)) : asText(s).split(asText(sep))).map(text)),
    },
  ],
  join: ["잇기", { kind: "pure", signature: { params: [listOf(TEXT), TEXT], result: TEXT }, apply: ([xs, sep]) => text(asList(xs).map(asText).join(asText(sep))) }],
  runes: ["문자들", { kind: "pure", signature: { params: [TEXT], result: listOf(RUNE) }, apply: ([s]) => list(scalars(asText(s)).map((c) => rune(c.codePointAt(0) as number))) }],
  fromRunes: [
    "모으기",
    {
      kind: "pure",
      signature: { params: [listOf(RUNE)], result: TEXT },
      apply: ([rs]) => text(asList(rs).map((r) => String.fromCodePoint(r.kind === "rune" ? r.value : 0)).join("")),
    },
  ],
  rune: [
    "문자",
    {
      kind: "pure",
      signature: { params: [prim("u32")], result: option(RUNE) },
      // A scalar value: U+0000–U+10FFFF without the surrogates.
      apply: ([n]) => {
        const v = Number(asInt(n));
        return v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) ? none : some(rune(v));
      },
    },
  ],
  parseInt: ["정수로", { kind: "pure", signature: { params: [TEXT], result: result(I64, PARSE_ERROR) }, apply: ([s]) => parseInteger(asText(s)) }],
  parseFloat: ["실수로", { kind: "pure", signature: { params: [TEXT], result: result(F64, PARSE_ERROR) }, apply: ([s]) => parseFloat(asText(s)) }],
  show: ["글로", { kind: "pure", signature: { typeParams: ["T"], params: [T], result: TEXT }, apply: ([v]) => text(renderValue(v as ConcreteValue)) }],
});
