import type { Callable } from "../ir/callables";
import { convert } from "../semantics/numeric";
import type { ConcreteValue } from "../semantics/values";
import { FLOAT_TYPES, INTEGER_TYPES, prim } from "../types/types";
import { namespace, T } from "./core";

// 변환: the only way a number changes type (docs/v2-runtime-model.md §1.3). One
// callable per target type, from any numeric type: [y는 변환 i64: x].
export const CONVERT: Callable[] = namespace(
  "std.convert",
  "변환",
  Object.fromEntries(
    [...INTEGER_TYPES, ...FLOAT_TYPES].map((target) => [
      target,
      [
        target,
        {
          kind: "pure",
          signature: { typeParams: ["T"], bounds: { T: "number" }, params: [T], result: prim(target) },
          apply: ([x]: readonly ConcreteValue[]) => convert(target, x as ConcreteValue),
        },
      ] as const,
    ]),
  ),
);
