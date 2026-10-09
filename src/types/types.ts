// Y3's static types. A small, predictable system in the ML family: primitive types,
// named algebraic data types (sums and products, possibly with type parameters) and
// type variables solved by unification. There is no let-polymorphism; the only
// polymorphism is in the signatures of built-in callables and in type definitions,
// both instantiated afresh at each use.
//
// Type unknowns live here and only here. A temporal unknown (α, β, ε) is a *value*
// the future determines; its type is an ordinary type variable that the checker
// solves before the program runs. The two systems never share a variable.

export type PrimName = "Bool" | "Int" | "Text" | "Unit";

export type Type =
  | { readonly kind: "prim"; readonly name: PrimName }
  | { readonly kind: "var"; readonly id: number }
  | { readonly kind: "named"; readonly name: string; readonly args: readonly Type[] } // a TypeDef applied to arguments
  | { readonly kind: "param"; readonly name: string }; // only inside definitions and signatures

export const BOOL: Type = { kind: "prim", name: "Bool" };
export const INT: Type = { kind: "prim", name: "Int" };
export const TEXT: Type = { kind: "prim", name: "Text" };
export const UNIT_TYPE: Type = { kind: "prim", name: "Unit" };

export function named(name: string, ...args: Type[]): Type {
  return { kind: "named", name, args };
}

export function param(name: string): Type {
  return { kind: "param", name };
}

// Algebraic data types. A sum type is a tagged union of variants; each variant carries
// a product of fields. A product type is a single record of named fields.
export type Variant = { readonly name: string; readonly fields: readonly Type[] };
export type Field = { readonly name: string; readonly type: Type };
export type TypeDef =
  | { readonly kind: "sum"; readonly name: string; readonly params: readonly string[]; readonly variants: readonly Variant[] }
  | { readonly kind: "product"; readonly name: string; readonly params: readonly string[]; readonly fields: readonly Field[] };

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

export class TypeTable {
  private readonly defs = new Map<string, TypeDef>();

  constructor(defs: readonly TypeDef[] = [OPTION, RESULT]) {
    for (const def of defs) this.define(def);
  }

  define(def: TypeDef): void {
    if (this.defs.has(def.name)) throw new Error(`type ${def.name} is already defined`);
    this.defs.set(def.name, def);
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
    case "named":
      return { kind: "named", name: type.name, args: type.args.map((arg) => substituteParams(arg, args)) };
    default:
      return type;
  }
}

export function formatType(type: Type): string {
  switch (type.kind) {
    case "prim":
      return type.name;
    case "var":
      return `?T${type.id}`;
    case "param":
      return type.name;
    case "named":
      return type.args.length === 0 ? type.name : `${type.name}<${type.args.map(formatType).join(", ")}>`;
  }
}

export type UnifyError = { readonly expected: Type; readonly found: Type };

// Type variables and their solutions. Unification is first-order with an occurs check;
// nothing is generalised.
export class Unifier {
  private readonly solutions = new Map<number, Type>();
  private next = 1;

  fresh(): Type {
    const id = this.next;
    this.next += 1;
    return { kind: "var", id };
  }

  // A type with every solved variable replaced, as far as it is known now.
  resolve(type: Type): Type {
    switch (type.kind) {
      case "var": {
        const solved = this.solutions.get(type.id);
        return solved ? this.resolve(solved) : type;
      }
      case "named":
        return { kind: "named", name: type.name, args: type.args.map((arg) => this.resolve(arg)) };
      default:
        return type;
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
    if (a.kind === "named" && b.kind === "named" && a.name === b.name && a.args.length === b.args.length) {
      for (let i = 0; i < a.args.length; i += 1) {
        if (this.unify(a.args[i] as Type, b.args[i] as Type)) return { expected: this.resolve(a), found: this.resolve(b) };
      }
      return null;
    }
    return { expected: a, found: b };
  }

  private bind(id: number, type: Type, expected: Type, found: Type): UnifyError | null {
    if (this.occurs(id, type)) return { expected, found };
    this.solutions.set(id, type);
    return null;
  }

  private occurs(id: number, type: Type): boolean {
    const t = this.resolve(type);
    if (t.kind === "var") return t.id === id;
    if (t.kind === "named") return t.args.some((arg) => this.occurs(id, arg));
    return false;
  }

  // A definition or signature with its parameters replaced by fresh variables.
  instantiate(params: readonly string[]): Map<string, Type> {
    return new Map(params.map((name) => [name, this.fresh()]));
  }
}
