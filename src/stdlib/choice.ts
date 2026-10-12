import { RuntimeFault } from "../semantics/fault";
import { showValue, type ConcreteValue } from "../semantics/values";
import { E, namespace, option, result, T } from "./core";

// Taking the value out of an Option (선택) or a Result (결과). 아니면 supplies a default;
// 꺼내기 asserts there is a value, and an Err or None there is a FAULT: the program has
// declared that case a bug (Rust's unwrap). Ordinary handling is a match.

const field = (v: ConcreteValue | undefined) => (v?.kind === "data" ? v : null);

export const CHOICE = [
  ...namespace("std.option", "선택", {
    unwrap: [
      "꺼내기",
      {
        kind: "pure",
        signature: { typeParams: ["T"], params: [option(T)], result: T },
        apply: ([o]) => {
          const d = field(o);
          if (d?.variant !== "Some") throw new RuntimeFault("'선택 꺼내기' found None");
          return d.fields[0] as ConcreteValue;
        },
      },
    ],
    unwrapOr: ["아니면", { kind: "pure", signature: { typeParams: ["T"], params: [option(T), T], result: T }, apply: ([o, d]) => (field(o)?.variant === "Some" ? (field(o)?.fields[0] as ConcreteValue) : (d as ConcreteValue)) }],
  }),
  ...namespace("std.result", "결과", {
    unwrap: [
      "꺼내기",
      {
        kind: "pure",
        signature: { typeParams: ["T", "E"], params: [result(T, E)], result: T },
        apply: ([r]) => {
          const d = field(r);
          if (d?.variant !== "Ok") throw new RuntimeFault(`'결과 꺼내기' found ${d ? showValue(d) : "?"}`);
          return d.fields[0] as ConcreteValue;
        },
      },
    ],
    unwrapOr: ["아니면", { kind: "pure", signature: { typeParams: ["T", "E"], params: [result(T, E), T], result: T }, apply: ([r, d]) => (field(r)?.variant === "Ok" ? (field(r)?.fields[0] as ConcreteValue) : (d as ConcreteValue)) }],
  }),
];
