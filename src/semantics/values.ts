// Runtime values. Present-tense execution only ever handles these; symbolic temporal
// terms live in temporal/ and are never folded into this type. Values are plain data:
// no truthiness, no implicit conversion, no null.

export type ConcreteValue =
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "unit" }
  // A value of a sum type (variant set) or a product type (variant null), fields in
  // declaration order.
  | { readonly kind: "data"; readonly type: string; readonly variant: string | null; readonly fields: readonly ConcreteValue[] }
  // [T; N] owns its elements. []T views elements [start, start + length) of some
  // array's storage. Storage is never mutated: writing an element makes a new array,
  // so a slice keeps seeing the array version it was taken from.
  | { readonly kind: "array"; readonly elements: readonly ConcreteValue[] }
  | { readonly kind: "slice"; readonly storage: readonly ConcreteValue[]; readonly start: number; readonly length: number };

export const UNIT: ConcreteValue = { kind: "unit" };

export function int(value: bigint): ConcreteValue {
  return { kind: "int", value };
}

export function text(value: string): ConcreteValue {
  return { kind: "text", value };
}

export function bool(value: boolean): ConcreteValue {
  return { kind: "bool", value };
}

// The elements an array holds or a slice views, or null for any other value.
export function elementsOf(value: ConcreteValue): readonly ConcreteValue[] | null {
  if (value.kind === "array") return value.elements;
  if (value.kind === "slice") return value.storage.slice(value.start, value.start + value.length);
  return null;
}

// How a value prints on an output line.
export function renderValue(value: ConcreteValue): string {
  switch (value.kind) {
    case "int":
      return value.value.toString();
    case "text":
      return value.value;
    case "bool":
      return value.value ? "참" : "거짓";
    case "unit":
      return "()";
    case "data": {
      const head = value.variant ?? value.type;
      return value.fields.length === 0 ? head : `${head}(${value.fields.map(showValue).join(", ")})`;
    }
    case "array":
    case "slice":
      return `[${(elementsOf(value) ?? []).map(showValue).join(", ")}]`;
  }
}

// How a value reads in a trace or a diagnostic: text is quoted.
export function showValue(value: ConcreteValue): string {
  return value.kind === "text" ? JSON.stringify(value.value) : renderValue(value);
}

// Structural equality. Values of different types never meet: the type checker sees to that.
export function sameValue(a: ConcreteValue, b: ConcreteValue): boolean {
  switch (a.kind) {
    case "unit":
      return b.kind === "unit";
    case "data":
      return (
        b.kind === "data" &&
        a.type === b.type &&
        a.variant === b.variant &&
        a.fields.length === b.fields.length &&
        a.fields.every((field, i) => sameValue(field, b.fields[i] as ConcreteValue))
      );
    case "array":
    case "slice": {
      const x = elementsOf(a) ?? [];
      const y = b.kind === a.kind ? elementsOf(b) ?? [] : null;
      return y !== null && x.length === y.length && x.every((element, i) => sameValue(element, y[i] as ConcreteValue));
    }
    default:
      return a.kind === b.kind && a.value === (b as typeof a).value;
  }
}
