// Y3's static types. A small, predictable system in the ML family: primitive types,
// named algebraic data types (sums and products, possibly with type parameters) and
// type variables solved by unification. There is no let-polymorphism; the only
// polymorphism is in the signatures of built-in callables and in type definitions,
// both instantiated afresh at each use.
//
// Type unknowns live here and only here. A temporal unknown (α, β, ε) is a *value*
// the future determines; its type is an ordinary type variable that the checker
// solves before the program runs. The two systems never share a variable.

export const INTEGER_TYPES = ["i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "bigint"] as const;
export const FLOAT_TYPES = ["f32", "f64"] as const;
export type IntegerName = (typeof INTEGER_TYPES)[number];
export type FloatName = (typeof FLOAT_TYPES)[number];
export type NumericName = IntegerName | FloatName;

// Rune: a Unicode scalar value (U+0000–U+10FFFF, no surrogates), like Go's rune or
// Rust's char.
export type PrimName = "Bool" | "Text" | "Unit" | "Rune" | NumericName;

export function isInteger(name: string): name is IntegerName {
  return (INTEGER_TYPES as readonly string[]).includes(name);
}
export function isFloat(name: string): name is FloatName {
  return (FLOAT_TYPES as readonly string[]).includes(name);
}
export function isNumeric(name: string): name is NumericName {
  return isInteger(name) || isFloat(name);
}

// The range of a fixed-width integer type; null for bigint (unbounded).
export function integerRange(name: IntegerName): { min: bigint; max: bigint } | null {
  if (name === "bigint") return null;
  const bits = BigInt(Number(name.slice(1)));
  return name.startsWith("u") ? { min: 0n, max: (1n << bits) - 1n } : { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n };
}

// What a type variable may still become: any number (a variable used in arithmetic),
// an integer (an integer literal) or a float (a float literal). Kinds meet: an integer
// literal added to a number is an integer; an integer meeting a float is an error.
export type Kind = "number" | "integer" | "float";

export type Type =
  | { readonly kind: "prim"; readonly name: PrimName }
  | { readonly kind: "var"; readonly id: number }
  | { readonly kind: "named"; readonly name: string; readonly args: readonly Type[] } // a TypeDef applied to arguments
  | { readonly kind: "param"; readonly name: string } // only inside definitions and signatures
  | { readonly kind: "array"; readonly element: Type; readonly length: number } // [T; N]: owns its elements
  | { readonly kind: "slice"; readonly element: Type }; // []T: a view of some array's elements

export const BOOL: Type = { kind: "prim", name: "Bool" };
export const TEXT: Type = { kind: "prim", name: "Text" };
export const UNIT_TYPE: Type = { kind: "prim", name: "Unit" };
export const RUNE: Type = { kind: "prim", name: "Rune" };
export const prim = (name: PrimName): Type => ({ kind: "prim", name });
export const I64: Type = prim("i64");
export const F64: Type = prim("f64");
export const BIGINT: Type = prim("bigint");

export function named(name: string, ...args: Type[]): Type {
  return { kind: "named", name, args };
}

export function param(name: string): Type {
  return { kind: "param", name };
}

export function arrayOf(element: Type, length: number): Type {
  return { kind: "array", element, length };
}

export function sliceOf(element: Type): Type {
  return { kind: "slice", element };
}

// The element type of an array or a slice, or null.
export function elementOf(type: Type): Type | null {
  return type.kind === "array" || type.kind === "slice" ? type.element : null;
}

// Rebuilds a type with its immediate component types mapped.
function mapParts(type: Type, f: (part: Type) => Type): Type {
  switch (type.kind) {
    case "named":
      return { kind: "named", name: type.name, args: type.args.map(f) };
    case "array":
      return { kind: "array", element: f(type.element), length: type.length };
    case "slice":
      return { kind: "slice", element: f(type.element) };
    default:
      return type;
  }
}

function parts(type: Type): readonly Type[] {
  return type.kind === "named" ? type.args : type.kind === "array" || type.kind === "slice" ? [type.element] : [];
}

// Algebraic data types. A sum type is a tagged union of variants; each variant carries
// a product of fields. A product type is a single record of named fields.
export type Variant = { readonly name: string; readonly fields: readonly Type[] };
export type Field = { readonly name: string; readonly type: Type };
export type TypeDef =
  | { readonly kind: "sum"; readonly name: string; readonly params: readonly string[]; readonly variants: readonly Variant[] }
  | { readonly kind: "product"; readonly name: string; readonly params: readonly string[]; readonly fields: readonly Field[] }
  // A type whose values only built-ins make and look inside: List, Map, Set, File.
  | { readonly kind: "opaque"; readonly name: string; readonly params: readonly string[] };

// Option<T> = Some(T) | None and Result<T, E> = Ok(T) | Err(E). There is no null.
export const OPTION: TypeDef = {
  kind: "sum",
  name: "Option",
  params: ["T"],
  variants: [
    { name: "Some", fields: [param("T")] },
    { name: "None", fields: [] },
  ],
};

export const RESULT: TypeDef = {
  kind: "sum",
  name: "Result",
  params: ["T", "E"],
  variants: [
    { name: "Ok", fields: [param("T")] },
    { name: "Err", fields: [param("E")] },
  ],
};

// Collections and files: values only the standard library makes and looks inside.
export const LIST: TypeDef = { kind: "opaque", name: "List", params: ["T"] };
export const MAP: TypeDef = { kind: "opaque", name: "Map", params: ["K", "V"] };
export const SET: TypeDef = { kind: "opaque", name: "Set", params: ["T"] };
export const FILE: TypeDef = { kind: "opaque", name: "File", params: [] };

// Ordinary errors are values: the standard library reports them with these.
export const FS_ERROR: TypeDef = {
  kind: "sum",
  name: "FsError",
  params: [],
  variants: ["NotFound", "PermissionDenied", "AlreadyExists", "IsDirectory", "Closed", "Other"].map((name) => ({ name, fields: [TEXT] })),
};
export const PARSE_ERROR: TypeDef = {
  kind: "sum",
  name: "ParseError",
  params: [],
  variants: [
    { name: "Invalid", fields: [TEXT] },
    { name: "OutOfRange", fields: [TEXT] },
  ],
};
export const FILE_INFO: TypeDef = {
  kind: "product",
  name: "FileInfo",
  params: [],
  fields: [
    { name: "크기", type: prim("u64") },
    { name: "폴더", type: BOOL },
  ],
};

export const BUILTIN_TYPE_DEFS: readonly TypeDef[] = [OPTION, RESULT, LIST, MAP, SET, FILE, FS_ERROR, PARSE_ERROR, FILE_INFO];

export class TypeTable {
  private readonly defs = new Map<string, TypeDef>();

  constructor(defs: readonly TypeDef[] = BUILTIN_TYPE_DEFS) {
    for (const def of defs) this.define(def);
  }

  define(def: TypeDef): void {
    if (this.defs.has(def.name)) throw new Error(`type ${def.name} is already defined`);
    this.defs.set(def.name, def);
  }

  // Completes a definition declared earlier by name (declarations may refer to each other).
  replace(def: TypeDef): void {
    if (!this.defs.has(def.name)) throw new Error(`type ${def.name} was never declared`);
    this.defs.set(def.name, def);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  get(name: string): TypeDef | null {
    return this.defs.get(name) ?? null;
  }
}

// Replaces parameters by name.
export function substituteParams(type: Type, args: ReadonlyMap<string, Type>): Type {
  switch (type.kind) {
    case "param":
      return args.get(type.name) ?? type;
    default:
      return mapParts(type, (part) => substituteParams(part, args));
  }
}

export function formatType(type: Type, variable: (id: number) => string = (id) => `?T${id}`): string {
  const f = (t: Type) => formatType(t, variable);
  switch (type.kind) {
    case "prim":
      return type.name;
    case "var":
      return variable(type.id);
    case "param":
      return type.name;
    case "named":
      return type.args.length === 0 ? type.name : `${type.name}<${type.args.map(f).join(", ")}>`;
    case "array":
      return `[${f(type.element)}; ${type.length}]`;
    case "slice":
      return `[]${f(type.element)}`;
  }
}

export type UnifyError = { readonly expected: Type; readonly found: Type };

function satisfies(type: Type, kind: Kind): boolean {
  if (type.kind !== "prim") return false;
  return kind === "integer" ? isInteger(type.name) : kind === "float" ? isFloat(type.name) : isNumeric(type.name);
}

// The meet of two kinds: null when there was none to meet, undefined when they clash.
function meet(a: Kind | null, b: Kind): Kind | null | undefined {
  if (a === null || a === b) return b;
  if (a === "number") return b;
  if (b === "number") return a;
  return undefined; // integer and float
}

// Type variables and their solutions. Unification is first-order with an occurs check;
// nothing is generalised.
export class Unifier {
  private readonly solutions = new Map<number, Type>();
  private readonly kinds = new Map<number, Kind>();
  private next = 1;

  fresh(kind?: Kind): Type {
    const id = this.next;
    this.next += 1;
    if (kind) this.kinds.set(id, kind);
    return { kind: "var", id };
  }

  // The kind of an unsolved variable, if it has one.
  kindOf(type: Type): Kind | null {
    const t = this.resolve(type);
    return t.kind === "var" ? (this.kinds.get(t.id) ?? null) : null;
  }

  // Requires the type to be of this kind: narrows a variable, or checks a known type.
  constrain(type: Type, kind: Kind): boolean {
    const t = this.resolve(type);
    if (t.kind !== "var") return satisfies(t, kind);
    const met = meet(this.kinds.get(t.id) ?? null, kind);
    if (met === undefined) return false;
    if (met) this.kinds.set(t.id, met);
    return true;
  }

  // Every unsolved variable with a kind, for defaulting.
  kindedVariables(): { id: number; kind: Kind }[] {
    return [...this.kinds].filter(([id]) => !this.solutions.has(id)).map(([id, kind]) => ({ id, kind }));
  }

  // As formatType, but an unsolved kinded variable reads as {integer}, {float} or {number}.
  describe(type: Type): string {
    return formatType(this.resolve(type), (id) => {
      const k = this.kinds.get(id);
      return k ? `{${k}}` : `?T${id}`;
    });
  }

  // A type with every solved variable replaced, as far as it is known now.
  resolve(type: Type): Type {
    switch (type.kind) {
      case "var": {
        const solved = this.solutions.get(type.id);
        return solved ? this.resolve(solved) : type;
      }
      default:
        return mapParts(type, (part) => this.resolve(part));
    }
  }

  // Makes the two types equal, or reports them as they stand.
  unify(expected: Type, found: Type): UnifyError | null {
    const a = this.resolve(expected);
    const b = this.resolve(found);
    if (a.kind === "var" && b.kind === "var" && a.id === b.id) return null;
    if (a.kind === "var") return this.bind(a.id, b, a, b);
    if (b.kind === "var") return this.bind(b.id, a, a, b);
    if (a.kind === "prim" && b.kind === "prim") return a.name === b.name ? null : { expected: a, found: b };
    const sameShape =
      (a.kind === "named" && b.kind === "named" && a.name === b.name && a.args.length === b.args.length) ||
      (a.kind === "array" && b.kind === "array" && a.length === b.length) ||
      (a.kind === "slice" && b.kind === "slice");
    if (sameShape) {
      const pa = parts(a);
      const pb = parts(b);
      for (let i = 0; i < pa.length; i += 1) {
        if (this.unify(pa[i] as Type, pb[i] as Type)) return { expected: this.resolve(a), found: this.resolve(b) };
      }
      return null;
    }
    return { expected: a, found: b };
  }

  private bind(id: number, type: Type, expected: Type, found: Type): UnifyError | null {
    if (this.occurs(id, type)) return { expected, found };
    const kind = this.kinds.get(id);
    if (kind && !this.constrain(type, kind)) return { expected, found };
    this.solutions.set(id, type);
    return null;
  }

  private occurs(id: number, type: Type): boolean {
    const t = this.resolve(type);
    if (t.kind === "var") return t.id === id;
    return parts(t).some((part) => this.occurs(id, part));
  }

  // A definition or signature with its parameters replaced by fresh variables.
  instantiate(params: readonly string[]): Map<string, Type> {
    return new Map(params.map((name) => [name, this.fresh()]));
  }
}
