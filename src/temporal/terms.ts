import { showValue, type ConcreteValue } from "../semantics/values";

// Symbolic terms: what a value is known to be in terms of symbols that only the
// future can determine. Kept apart from ConcreteValue on purpose: present-tense
// execution handles concrete values, and only the temporal layer handles these.

export type SymbolId = number;

export type SymbolicTerm =
  | { readonly kind: "literal"; readonly value: ConcreteValue }
  | { readonly kind: "symbol"; readonly id: SymbolId }
  // Σ cᵢ·αᵢ + k with integer coefficients: at least one non-zero coefficient, and never
  // just a bare symbol (that is a "symbol" term).
  | { readonly kind: "linear"; readonly constant: bigint; readonly coefficients: ReadonlyMap<SymbolId, bigint> };

export type Linear = { constant: bigint; coefficients: Map<SymbolId, bigint> };

export class TermError extends Error {}

export function literal(value: ConcreteValue): SymbolicTerm {
  return { kind: "literal", value };
}

export function symbol(id: SymbolId): SymbolicTerm {
  return { kind: "symbol", id };
}

// Builds the normal form of Σ cᵢ·αᵢ + k.
export function fromLinear(linear: Linear): SymbolicTerm {
  const coefficients = new Map([...linear.coefficients].filter(([, c]) => c !== 0n).sort(([a], [b]) => a - b));
  if (coefficients.size === 0) {
    return literal({ kind: "int", value: linear.constant });
  }
  const [only] = coefficients;
  if (coefficients.size === 1 && only && only[1] === 1n && linear.constant === 0n) {
    return symbol(only[0]);
  }
  return { kind: "linear", constant: linear.constant, coefficients };
}

// The linear form of a numeric term, or null for text.
export function toLinear(term: SymbolicTerm): Linear | null {
  switch (term.kind) {
    case "literal":
      return term.value.kind === "int" ? { constant: term.value.value, coefficients: new Map() } : null;
    case "symbol":
      return { constant: 0n, coefficients: new Map([[term.id, 1n]]) };
    case "linear":
      return { constant: term.constant, coefficients: new Map(term.coefficients) };
  }
}

// a + sign·b, for numeric terms.
export function combine(a: SymbolicTerm, b: SymbolicTerm, sign: 1n | -1n): SymbolicTerm {
  const left = toLinear(a);
  const right = toLinear(b);
  if (!left || !right) {
    throw new TermError("arithmetic needs integers, not text");
  }
  const coefficients = new Map(left.coefficients);
  for (const [id, c] of right.coefficients) {
    coefficients.set(id, (coefficients.get(id) ?? 0n) + sign * c);
  }
  return fromLinear({ constant: left.constant + sign * right.constant, coefficients });
}

// Whether a term carries an operational cause of its own, judged on its normal form:
// a concrete value does, and so does a non-zero constant. Symbols alone do not, so a
// neutral step (x + 0, x - 0, x + 3 - 3) leaves a value exactly as uncaused as before.
export function carriesCause(term: SymbolicTerm): boolean {
  switch (term.kind) {
    case "literal":
      return true;
    case "symbol":
      return false;
    case "linear":
      return term.constant !== 0n;
  }
}

export function symbolsOf(term: SymbolicTerm): SymbolId[] {
  switch (term.kind) {
    case "literal":
      return [];
    case "symbol":
      return [term.id];
    case "linear":
      return [...term.coefficients.keys()];
  }
}

// Replaces symbols that have values; the result may still be symbolic.
export function substitute(term: SymbolicTerm, valueOf: (id: SymbolId) => ConcreteValue | null): SymbolicTerm {
  if (term.kind === "literal") return term;
  if (term.kind === "symbol") {
    const value = valueOf(term.id);
    return value ? literal(value) : term;
  }
  let constant = term.constant;
  const coefficients = new Map<SymbolId, bigint>();
  for (const [id, c] of term.coefficients) {
    const value = valueOf(id);
    if (!value) {
      coefficients.set(id, c);
    } else if (value.kind === "int") {
      constant += c * value.value;
    } else {
      throw new TermError("a symbol in arithmetic was resolved to text");
    }
  }
  return fromLinear({ constant, coefficients });
}

export function formatTerm(term: SymbolicTerm, label: (id: SymbolId) => string): string {
  if (term.kind === "literal") {
    return showValue(term.value);
  }
  if (term.kind === "symbol") return label(term.id);
  const parts: string[] = [];
  for (const [id, c] of term.coefficients) {
    const magnitude = c < 0n ? -c : c;
    const body = magnitude === 1n ? label(id) : `${magnitude}·${label(id)}`;
    parts.push(parts.length === 0 ? (c < 0n ? `-${body}` : body) : `${c < 0n ? "-" : "+"} ${body}`);
  }
  if (term.constant !== 0n) {
    parts.push(`${term.constant < 0n ? "-" : "+"} ${term.constant < 0n ? -term.constant : term.constant}`);
  }
  return parts.join(" ");
}
