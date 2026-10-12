import type { ConcreteValue } from "../semantics/values";
import { integerRange, isInteger, substituteParams, TypeTable, type Type } from "../types/types";

// Values as JSON, for the replay log: everything an effect can return, resource handles
// included (a replayed run reissues the same handle numbers in the same order).

export type Payload = null | boolean | number | string | Payload[] | { [key: string]: Payload };

export class PayloadError extends Error {}

export function encodePayload(v: ConcreteValue): Payload {
  switch (v.kind) {
    case "int":
      return { int: v.value.toString() };
    case "float":
      return { float: Number.isNaN(v.value) ? "NaN" : Object.is(v.value, -0) ? "-0" : Number.isFinite(v.value) ? v.value : v.value > 0 ? "+Inf" : "-Inf", width: v.width };
    case "rune":
      return { rune: v.value };
    case "text":
      return { text: v.value };
    case "bool":
      return { bool: v.value };
    case "unit":
      return { unit: true };
    case "data":
      return { data: v.type, variant: v.variant, fields: v.fields.map(encodePayload) };
    case "array":
    case "list":
      return { [v.kind]: v.elements.map(encodePayload) };
    case "slice":
      return { array: v.storage.slice(v.start, v.start + v.length).map(encodePayload) };
    case "map":
      return { map: [...v.entries].map(([k, [key, value]]) => [k, encodePayload(key), encodePayload(value)]) };
    case "set":
      return { set: [...v.entries].map(([k, value]) => [k, encodePayload(value)]) };
    case "resource":
      return { resource: v.resource, id: v.id };
  }
}

export function decodePayload(p: Payload): ConcreteValue {
  const o = p as Record<string, Payload>;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new PayloadError("a malformed value");
  if (typeof o.int === "string" && /^-?\d+$/.test(o.int)) return { kind: "int", value: BigInt(o.int) };
  if ("float" in o) {
    const f = o.float;
    const value = f === "NaN" ? NaN : f === "-0" ? -0 : f === "+Inf" ? Infinity : f === "-Inf" ? -Infinity : f;
    if (typeof value !== "number" || (o.width !== 32 && o.width !== 64)) throw new PayloadError("a malformed float");
    return { kind: "float", value, width: o.width };
  }
  if (typeof o.rune === "number") return { kind: "rune", value: o.rune };
  if (typeof o.text === "string") return { kind: "text", value: o.text };
  if (typeof o.bool === "boolean") return { kind: "bool", value: o.bool };
  if (o.unit === true) return { kind: "unit" };
  if (typeof o.data === "string" && Array.isArray(o.fields)) return { kind: "data", type: o.data, variant: typeof o.variant === "string" ? o.variant : null, fields: o.fields.map(decodePayload) };
  if (Array.isArray(o.array)) return { kind: "array", elements: o.array.map(decodePayload) };
  if (Array.isArray(o.list)) return { kind: "list", elements: o.list.map(decodePayload) };
  if (Array.isArray(o.map)) return { kind: "map", entries: new Map(o.map.map((e) => { const [k, key, value] = e as [string, Payload, Payload]; return [k, [decodePayload(key), decodePayload(value)]]; })) };
  if (Array.isArray(o.set)) return { kind: "set", entries: new Map(o.set.map((e) => { const [k, value] = e as [string, Payload]; return [k, decodePayload(value)]; })) };
  if ((o.resource === "file" || o.resource === "foreign") && typeof o.id === "number") return { kind: "resource", resource: o.resource, id: o.id };
  throw new PayloadError(`a malformed value: ${JSON.stringify(p)}`);
}

// Whether a value has a type: what a replayed result must satisfy before the program sees
// it. A replay log is input, so a value from it is checked like any other input: a clock
// reading must be an i64 in range, never Text, whatever the log claims.
const BUILTINS = new TypeTable();
export function conformsTo(v: ConcreteValue, t: Type): boolean {
  switch (t.kind) {
    case "prim":
      if (isInteger(t.name)) {
        if (v.kind !== "int") return false;
        const range = integerRange(t.name);
        return range === null || (v.value >= range.min && v.value <= range.max);
      }
      if (t.name === "f32" || t.name === "f64") return v.kind === "float" && v.width === (t.name === "f32" ? 32 : 64) && (t.name === "f64" || Number.isNaN(v.value) || Math.fround(v.value) === v.value);
      if (t.name === "Rune") return v.kind === "rune" && Number.isInteger(v.value) && v.value >= 0 && v.value <= 0x10ffff && !(v.value >= 0xd800 && v.value <= 0xdfff);
      if (t.name === "Text") return v.kind === "text";
      if (t.name === "Bool") return v.kind === "bool";
      if (t.name === "Unit") return v.kind === "unit";
      return false;
    case "array":
      return v.kind === "array" && v.elements.length === t.length && v.elements.every((e) => conformsTo(e, t.element));
    case "slice":
      return v.kind === "array" && v.elements.every((e) => conformsTo(e, t.element));
    case "named": {
      const def = BUILTINS.get(t.name);
      if (!def) return false;
      const args = new Map(def.params.map((p, i) => [p, t.args[i] as Type]));
      if (def.kind === "opaque") {
        if (t.name === "File") return v.kind === "resource" && v.resource === "file";
        if (t.name === "Foreign") return v.kind === "resource" && v.resource === "foreign";
        if (t.name === "List") return v.kind === "list" && v.elements.every((e) => conformsTo(e, t.args[0] as Type));
        return false; // no effect returns a map or a set
      }
      if (v.kind !== "data" || v.type !== t.name) return false;
      const fields = def.kind === "product" ? (v.variant === null ? def.fields.map((f) => f.type) : null) : (def.variants.find((x) => x.name === v.variant)?.fields ?? null);
      return fields !== null && fields.length === v.fields.length && fields.every((f, i) => conformsTo(v.fields[i] as ConcreteValue, substituteParams(f, args)));
    }
    default:
      return true; // an open type variable: the checker left it unconstrained
  }
}
