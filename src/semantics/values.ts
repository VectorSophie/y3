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
  | { readonly kind: "data"; readonly type: string; readonly variant: string | null; readonly fields: readonly ConcreteValue[] };

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
    default:
      return a.kind === b.kind && a.value === (b as typeof a).value;
  }
}
