import type { Linear, SymbolId } from "./terms";

// A small solver for linear equalities over the integers, built for explaining rather
// than for speed. Each row means Σ cᵢ·αᵢ + k = 0. Rows are kept reduced: every row has
// a pivot (its smallest symbol), and no other row mentions that pivot. Elimination is
// fraction-free, so everything stays in bigint.
//
// It decides only three things: whether the equations are still consistent, whether
// they still admit an integer solution (one row at a time: gcd of the coefficients
// must divide the constant), and which symbols are now uniquely determined. It never
// chooses a value that the equations leave open, and it never decides control flow.

type Row = { coefficients: Map<SymbolId, bigint>; constant: bigint };

export type AddResult =
  | { kind: "consistent"; resolved: Map<SymbolId, bigint> }
  | { kind: "contradiction"; reason: "no solution" | "no integer solution" };

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function pivotOf(row: Row): SymbolId {
  return Math.min(...row.coefficients.keys());
}

// Divides by the gcd of the coefficients and makes the pivot coefficient positive.
// Returns null when no integer solution can exist.
function normalize(row: Row): Row | null {
  let g = 0n;
  for (const c of row.coefficients.values()) g = gcd(g, c);
  if (g === 0n) return row;
  if (row.constant % g !== 0n) return null;
  const sign = (row.coefficients.get(pivotOf(row)) ?? 1n) < 0n ? -1n : 1n;
  const coefficients = new Map<SymbolId, bigint>();
  for (const [id, c] of row.coefficients) coefficients.set(id, (sign * c) / g);
  return { coefficients, constant: (sign * row.constant) / g };
}

// a·row − b·other, dropping zero coefficients.
function eliminate(row: Row, other: Row, a: bigint, b: bigint): Row {
  const coefficients = new Map<SymbolId, bigint>();
  const ids = new Set([...row.coefficients.keys(), ...other.coefficients.keys()]);
  for (const id of ids) {
    const c = a * (row.coefficients.get(id) ?? 0n) - b * (other.coefficients.get(id) ?? 0n);
    if (c !== 0n) coefficients.set(id, c);
  }
  return { coefficients, constant: a * row.constant - b * other.constant };
}

export class LinearSystem {
  private rows: Row[] = [];
  private readonly values = new Map<SymbolId, bigint>();

  valueOf(id: SymbolId): bigint | undefined {
    return this.values.get(id);
  }

  // Symbols that appear in an equation but are not yet determined.
  constrained(): Set<SymbolId> {
    return new Set(this.rows.flatMap((row) => [...row.coefficients.keys()]));
  }

  // Adds `linear = 0`. On contradiction the system is left unchanged.
  add(linear: Linear): AddResult {
    let row: Row = { coefficients: new Map(), constant: linear.constant };
    for (const [id, c] of linear.coefficients) {
      const known = this.values.get(id);
      if (known !== undefined) {
        row.constant += c * known;
      } else if (c !== 0n) {
        row.coefficients.set(id, (row.coefficients.get(id) ?? 0n) + c);
      }
    }
    for (const [id, c] of [...row.coefficients]) if (c === 0n) row.coefficients.delete(id);

    for (const existing of this.rows) {
      const pivot = pivotOf(existing);
      const b = row.coefficients.get(pivot);
      if (b !== undefined) {
        row = eliminate(row, existing, existing.coefficients.get(pivot) ?? 1n, b);
      }
    }
    if (row.coefficients.size === 0) {
      return row.constant === 0n ? { kind: "consistent", resolved: new Map() } : { kind: "contradiction", reason: "no solution" };
    }
    const normalized = normalize(row);
    if (!normalized) return { kind: "contradiction", reason: "no integer solution" };

    // Keep the system reduced: remove the new pivot from every other row.
    const pivot = pivotOf(normalized);
    const a = normalized.coefficients.get(pivot) ?? 1n;
    const rows: Row[] = [];
    for (const existing of this.rows) {
      const b = existing.coefficients.get(pivot);
      if (b === undefined) {
        rows.push(existing);
        continue;
      }
      const reduced = normalize(eliminate(existing, normalized, a, b));
      if (!reduced) return { kind: "contradiction", reason: "no integer solution" };
      rows.push(reduced);
    }
    rows.push(normalized);

    // A row with one symbol determines it: c·α + k = 0, and normalize() already
    // guaranteed that c divides k.
    const resolved = new Map<SymbolId, bigint>();
    this.rows = rows.filter((r) => {
      if (r.coefficients.size !== 1) return true;
      const [[id, c]] = [...r.coefficients] as [[SymbolId, bigint]];
      resolved.set(id, -r.constant / c);
      return false;
    });
    for (const [id, value] of resolved) this.values.set(id, value);
    return { kind: "consistent", resolved };
  }
}
