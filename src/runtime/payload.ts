import type { ConcreteValue } from "../semantics/values";

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
