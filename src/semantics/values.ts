// Runtime values. Present-tense execution only ever handles these; symbolic temporal
// terms live in temporal/ and are never folded into this type. Values are plain data:
// no truthiness, no implicit conversion, no null.

export type ConcreteValue =
  | { readonly kind: "int"; readonly value: bigint } // every integer type; the static type says which
  | { readonly kind: "float"; readonly value: number; readonly width: 32 | 64 } // IEEE binary32/binary64
  | { readonly kind: "rune"; readonly value: number } // a Unicode scalar value
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
  | { readonly kind: "slice"; readonly storage: readonly ConcreteValue[]; readonly start: number; readonly length: number }
  // Collections are values too: adding to a list makes a new list. Map and set entries
  // are keyed by keyOf (only key values have one) and keep insertion order.
  | { readonly kind: "list"; readonly elements: readonly ConcreteValue[] }
  | { readonly kind: "map"; readonly entries: ReadonlyMap<string, readonly [ConcreteValue, ConcreteValue]> }
  | { readonly kind: "set"; readonly entries: ReadonlyMap<string, ConcreteValue> }
  // A handle on something outside the program (an open file). Copying the handle does
  // not copy the file: a handle is the one value that refers rather than contains.
  | { readonly kind: "resource"; readonly resource: "file" | "foreign"; readonly id: number };

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

export function float(value: number, width: 32 | 64 = 64): ConcreteValue {
  return { kind: "float", value: width === 32 ? Math.fround(value) : value, width };
}

export function rune(value: number): ConcreteValue {
  return { kind: "rune", value };
}

// A float as Y3 prints it: the shortest decimal that reads back to the same value at
// its width, with ".0" on integral values; NaN, +Inf, -Inf, -0.0.
export function formatFloat(value: number, width: 32 | 64): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  if (Object.is(value, -0)) return "-0.0";
  let digits = String(value);
  if (width === 32) {
    for (let p = 1; p <= 9; p += 1) {
      const candidate = Number(value.toPrecision(p));
      if (Math.fround(candidate) === value) {
        digits = String(candidate);
        break;
      }
    }
  }
  return /[.eE]/.test(digits) ? digits : `${digits}.0`;
}

// The elements an array holds or a slice views, or null for any other value.
export function elementsOf(value: ConcreteValue): readonly ConcreteValue[] | null {
  if (value.kind === "array" || value.kind === "list") return value.elements;
  if (value.kind === "slice") return value.storage.slice(value.start, value.start + value.length);
  return null;
}

// How a value prints on an output line.
export function renderValue(value: ConcreteValue): string {
  switch (value.kind) {
    case "int":
      return value.value.toString();
    case "float":
      return formatFloat(value.value, value.width);
    case "rune":
      return String.fromCodePoint(value.value);
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
    case "list":
      return `[${(elementsOf(value) ?? []).map(showValue).join(", ")}]`;
    case "set":
      return `{${[...value.entries.values()].map(showValue).join(", ")}}`;
    case "map":
      return `{${[...value.entries.values()].map(([k, v]) => `${showValue(k)}: ${showValue(v)}`).join(", ")}}`;
    case "resource":
      return `<${value.resource} #${value.id}>`;
  }
}

// How a value reads in a trace or a diagnostic: text is quoted.
export function showValue(value: ConcreteValue): string {
  if (value.kind === "text") return JSON.stringify(value.value);
  if (value.kind === "rune") return `'${String.fromCodePoint(value.value)}'`;
  return renderValue(value);
}

// The identity of a key value: equal keys (sameValue) have equal keyOf, and different
// keys different ones. Only integers, Bool, Text, Rune, Unit and data built from them
// are keys; the type checker refuses anything else, so this throws for the rest.
export function keyOf(value: ConcreteValue): string {
  switch (value.kind) {
    case "int":
      return `i${value.value}`;
    case "bool":
      return value.value ? "T" : "F";
    case "text":
      return `t${JSON.stringify(value.value)}`;
    case "rune":
      return `r${value.value}`;
    case "unit":
      return "u";
    case "data":
      return `d${JSON.stringify([value.type, value.variant, value.fields.map(keyOf)])}`;
    default:
      throw new Error(`a ${value.kind} is not a key; the type checker should have caught this`);
  }
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
    case "slice":
    case "list": {
      const x = elementsOf(a) ?? [];
      const y = b.kind === a.kind ? elementsOf(b) ?? [] : null;
      return y !== null && x.length === y.length && x.every((element, i) => sameValue(element, y[i] as ConcreteValue));
    }
    case "float":
      return b.kind === "float" && a.value === b.value; // IEEE: NaN ≠ NaN, -0 = 0
    case "set":
      return b.kind === "set" && a.entries.size === b.entries.size && [...a.entries.keys()].every((k) => b.entries.has(k));
    case "map":
      return (
        b.kind === "map" &&
        a.entries.size === b.entries.size &&
        [...a.entries].every(([k, [, v]]) => {
          const other = b.entries.get(k);
          return other !== undefined && sameValue(v, other[1]);
        })
      );
    case "resource":
      return b.kind === "resource" && a.id === b.id;
    default:
      return a.kind === b.kind && a.value === (b as typeof a).value;
  }
}
