import { int, keyOf, type ConcreteValue } from "../semantics/values";
import { BOOL, I64, named } from "../types/types";
import { asInt, asList, bool, K, list, listOf, namespace, none, option, position, some, T, V } from "./core";

// std/collections: 목록 (List<T>), 사전 (Map<K, V>), 집합 (Set<T>). Collections are
// values: adding to a list makes a new list, and the old one is unchanged.
// ponytail: every update copies (O(n)); persistent structures if programs grow large.
//
// Map keys and set elements must be key types (an integer, Bool, Text, Rune, Unit, or
// data made only of them): their equality is reflexive, so a key always finds itself.
// Floats (NaN ≠ NaN), arrays, slices, collections and files are not keys; the type
// checker refuses them (Y3N002). Iteration order is insertion order.

const MAP_T = named("Map", K, V);
const SET_T = named("Set", T);
const LIST_T = listOf(T);

const asMap = (v: ConcreteValue | undefined) => {
  if (v?.kind !== "map") throw new Error("a Map was expected; the type checker should have caught this");
  return v.entries;
};
const asSet = (v: ConcreteValue | undefined) => {
  if (v?.kind !== "set") throw new Error("a Set was expected; the type checker should have caught this");
  return v.entries;
};

export const LISTS = namespace("std.collections.list", "목록", {
  new: ["새", { kind: "pure", signature: { typeParams: ["T"], params: [], result: LIST_T }, apply: () => list([]) }],
  of: ["만들기", { kind: "pure", signature: { typeParams: ["T"], params: [], rest: "same", result: LIST_T }, apply: (xs) => list(xs) }],
  push: ["추가", { kind: "pure", signature: { typeParams: ["T"], params: [LIST_T, T], result: LIST_T }, apply: ([xs, x]) => list([...asList(xs), x as ConcreteValue]) }],
  length: ["길이", { kind: "pure", signature: { typeParams: ["T"], params: [LIST_T], result: I64 }, apply: ([xs]) => int(BigInt(asList(xs).length)) }],
  get: [
    "가져오기",
    {
      kind: "pure",
      signature: { typeParams: ["T"], params: [LIST_T, I64], result: option(T) },
      apply: ([xs, i]) => {
        const elements = asList(xs);
        const n = asInt(i);
        return n >= 0n && n < BigInt(elements.length) ? some(elements[Number(n)] as ConcreteValue) : none;
      },
    },
  ],
  set: [
    "바꾸기",
    {
      kind: "pure",
      signature: { typeParams: ["T"], params: [LIST_T, I64, T], result: LIST_T },
      apply: ([xs, i, x]) => {
        const elements = [...asList(xs)];
        elements[position(asInt(i), elements.length, "element")] = x as ConcreteValue;
        return list(elements);
      },
    },
  ],
});

export const MAPS = namespace("std.collections.map", "사전", {
  new: ["새", { kind: "pure", signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [], result: MAP_T }, apply: () => ({ kind: "map", entries: new Map() }) }],
  insert: [
    "넣기",
    {
      kind: "pure",
      signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T, K, V], result: MAP_T },
      apply: ([m, k, v]) => ({ kind: "map", entries: new Map(asMap(m)).set(keyOf(k as ConcreteValue), [k as ConcreteValue, v as ConcreteValue]) }),
    },
  ],
  get: [
    "찾기",
    {
      kind: "pure",
      signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T, K], result: option(V) },
      apply: ([m, k]) => {
        const entry = asMap(m).get(keyOf(k as ConcreteValue));
        return entry ? some(entry[1]) : none;
      },
    },
  ],
  remove: [
    "빼기",
    {
      kind: "pure",
      signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T, K], result: MAP_T },
      apply: ([m, k]) => {
        const entries = new Map(asMap(m));
        entries.delete(keyOf(k as ConcreteValue));
        return { kind: "map", entries };
      },
    },
  ],
  has: ["포함", { kind: "pure", signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T, K], result: BOOL }, apply: ([m, k]) => bool(asMap(m).has(keyOf(k as ConcreteValue))) }],
  length: ["길이", { kind: "pure", signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T], result: I64 }, apply: ([m]) => int(BigInt(asMap(m).size)) }],
  keys: ["열쇠들", { kind: "pure", signature: { typeParams: ["K", "V"], bounds: { K: "key" }, params: [MAP_T], result: listOf(K) }, apply: ([m]) => list([...asMap(m).values()].map(([k]) => k)) }],
});

export const SETS = namespace("std.collections.set", "집합", {
  new: ["새", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "key" }, params: [], result: SET_T }, apply: () => ({ kind: "set", entries: new Map() }) }],
  insert: [
    "넣기",
    {
      kind: "pure",
      signature: { typeParams: ["T"], bounds: { T: "key" }, params: [SET_T, T], result: SET_T },
      apply: ([s, x]) => ({ kind: "set", entries: new Map(asSet(s)).set(keyOf(x as ConcreteValue), x as ConcreteValue) }),
    },
  ],
  has: ["포함", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "key" }, params: [SET_T, T], result: BOOL }, apply: ([s, x]) => bool(asSet(s).has(keyOf(x as ConcreteValue))) }],
  remove: [
    "빼기",
    {
      kind: "pure",
      signature: { typeParams: ["T"], bounds: { T: "key" }, params: [SET_T, T], result: SET_T },
      apply: ([s, x]) => {
        const entries = new Map(asSet(s));
        entries.delete(keyOf(x as ConcreteValue));
        return { kind: "set", entries };
      },
    },
  ],
  length: ["길이", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "key" }, params: [SET_T], result: I64 }, apply: ([s]) => int(BigInt(asSet(s).size)) }],
  elements: ["원소들", { kind: "pure", signature: { typeParams: ["T"], bounds: { T: "key" }, params: [SET_T], result: listOf(T) }, apply: ([s]) => list([...asSet(s).values()]) }],
});

