import { int, type ConcreteValue } from "../semantics/values";
import { INT, param, UNIT_TYPE, type Type } from "../types/types";
import type { CallableId } from "./hir";

// Callables reachable through the colon-call syntax `[이름공간 이름: 인자, …]`. M5 has a
// tiny built-in set, enough to take a call through parsing, name resolution, signature
// resolution, type checking and execution.
//
// A pure callable is a function of concrete values. An effect callable (output) is
// carried out by the runtime, which owns every effect.

export type Signature = { readonly typeParams: readonly string[]; readonly params: readonly Type[]; readonly result: Type };

export type Callable = {
  readonly id: CallableId;
  readonly namespace: string; // as written in source
  readonly name: string;
  readonly signature: Signature;
} & ({ readonly kind: "pure"; readonly apply: (args: readonly ConcreteValue[]) => ConcreteValue } | { readonly kind: "effect" });

const asInt = (value: ConcreteValue | undefined): bigint => {
  if (value?.kind !== "int") throw new Error("an Int argument was expected; the type checker should have caught this");
  return value.value;
};

export const CALLABLES: readonly Callable[] = [
  {
    id: "std.io.println",
    namespace: "표준",
    name: "줄출력",
    signature: { typeParams: ["T"], params: [param("T")], result: UNIT_TYPE },
    kind: "effect",
  },
  {
    id: "std.math.abs",
    namespace: "수학",
    name: "절댓값",
    signature: { typeParams: [], params: [INT], result: INT },
    kind: "pure",
    apply: ([x]) => {
      const n = asInt(x);
      return int(n < 0n ? -n : n);
    },
  },
  {
    id: "std.math.max",
    namespace: "수학",
    name: "최댓값",
    signature: { typeParams: [], params: [INT, INT], result: INT },
    kind: "pure",
    apply: ([a, b]) => {
      const x = asInt(a);
      const y = asInt(b);
      return int(x >= y ? x : y);
    },
  },
];

export const PRINTLN: CallableId = "std.io.println";

const byId = new Map(CALLABLES.map((callable) => [callable.id, callable]));

export function callable(id: CallableId): Callable {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown callable ${id}`);
  return found;
}

export type CallableResolution = { kind: "found"; callable: Callable } | { kind: "no-namespace"; known: string[] } | { kind: "no-name"; known: string[] };

// Resolves `namespace name` as written.
export function resolveCallable(namespace: string, name: string): CallableResolution {
  const inNamespace = CALLABLES.filter((c) => c.namespace === namespace);
  if (inNamespace.length === 0) return { kind: "no-namespace", known: [...new Set(CALLABLES.map((c) => c.namespace))] };
  const found = inNamespace.find((c) => c.name === name);
  return found ? { kind: "found", callable: found } : { kind: "no-name", known: inNamespace.map((c) => c.name) };
}

