import type { Callable, CallableBody, CallTypes } from "../ir/callables";
import { RuntimeFault } from "../semantics/fault";
import { bool, text, type ConcreteValue } from "../semantics/values";
import { named, param, type Kind, type Type } from "../types/types";

// Helpers shared by the standard library modules.

export const T = param("T");
export const K = param("K");
export const V = param("V");
export const E = param("E");
export const option = (t: Type) => named("Option", t);
export const result = (t: Type, e: Type) => named("Result", t, e);
export const listOf = (t: Type) => named("List", t);

export const some = (value: ConcreteValue): ConcreteValue => ({ kind: "data", type: "Option", variant: "Some", fields: [value] });
export const none: ConcreteValue = { kind: "data", type: "Option", variant: "None", fields: [] };
export const ok = (value: ConcreteValue): ConcreteValue => ({ kind: "data", type: "Result", variant: "Ok", fields: [value] });
export const err = (value: ConcreteValue): ConcreteValue => ({ kind: "data", type: "Result", variant: "Err", fields: [value] });
export const variant = (type: string, name: string, ...fields: ConcreteValue[]): ConcreteValue => ({ kind: "data", type, variant: name, fields });
export const list = (elements: readonly ConcreteValue[]): ConcreteValue => ({ kind: "list", elements });

const broken = (what: string): never => {
  throw new Error(`${what} was expected; the type checker should have caught this`);
};
export const asText = (v: ConcreteValue | undefined): string => (v?.kind === "text" ? v.value : broken("a Text"));
export const asInt = (v: ConcreteValue | undefined): bigint => (v?.kind === "int" ? v.value : broken("an integer"));
export const asFloat = (v: ConcreteValue | undefined): number => (v?.kind === "float" ? v.value : broken("a float"));
export const asList = (v: ConcreteValue | undefined): readonly ConcreteValue[] => (v?.kind === "list" ? v.elements : broken("a List"));
export { bool, text };

// A checked position for an element (below `length`) or a bound (up to `length`).
export function position(value: bigint, length: number, what: "element" | "bound"): number {
  const limit = what === "element" ? length - 1 : length;
  if (value < 0n || value > BigInt(limit)) {
    throw new RuntimeFault(`${what === "element" ? "index" : "bound"} ${value} is out of range for ${length} element${length === 1 ? "" : "s"}`);
  }
  return Number(value);
}

export const resultType = (types: CallTypes): Type => types.result;

type Definition = CallableBody & {
  readonly signature: Partial<Callable["signature"]> & Pick<Callable["signature"], "params" | "result">;
};

// Declares the callables of one namespace: `id` is "<prefix>.<key>", `name` the Korean spelling.
export function namespace(prefix: string, korean: string, entries: Readonly<Record<string, readonly [string, Definition]>>): Callable[] {
  return Object.entries(entries).map(([key, [name, def]]) => ({
    ...def,
    id: `${prefix}.${key}`,
    namespace: korean,
    name,
    signature: { typeParams: [], ...def.signature },
  })) as Callable[];
}

export type Bounds = Readonly<Record<string, Kind | "key">>;
