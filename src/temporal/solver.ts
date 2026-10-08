import type { Linear, SymbolId } from "./terms";

// A small, exact solver for linear equalities over the integers, built for explaining
// rather than for speed. It answers three questions after each new equation:
//
//   1. Is the system still consistent over the rationals?
//   2. Does the whole system still have an integer solution?   (exact, not per row)
//   3. Which symbols are now uniquely determined?
//
// It never chooses a value the equations leave open, and it never decides control flow.
//
// (1) and (3) use fraction-free Gaussian elimination: each reduced row means
// Σ cᵢ·αᵢ + k = 0, every row has a pivot (its smallest symbol), and no other row
// mentions that pivot. A symbol is determined exactly when its row mentions nothing else.
// Over a system that has integer solutions, a symbol that is unique over the rationals
// is unique over the integers too (any rational direction of freedom scales to an
// integer one), so (3) needs no search.
//
// (2) uses the column Hermite form of the whole system (see integerSolvable): a
// per-row divisibility check is necessary but not sufficient.

type Row = { coefficients: Map<SymbolId, bigint>; constant: bigint };

export type Contradiction = "no solution" | "no integer solution" | "no integer solution together with the earlier constraints";

export type AddResult = { kind: "consistent"; resolved: Map<SymbolId, bigint> } | { kind: "contradiction"; reason: Contradiction };

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
// A row whose constant the gcd does not divide has no integer solution; it is kept
// scaled by the gcd only partially, which is harmless because such a system is
// rejected by the integer check before it is ever committed.
function normalize(row: Row): Row {
  let g = 0n;
  for (const c of row.coefficients.values()) g = gcd(g, c);
  if (g === 0n) return row;
  if (row.constant % g !== 0n) g = gcd(g, row.constant);
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

// Whether Σ cᵢ·αᵢ + k = 0 for every equation has a solution in integers.
//
// Writing the system as A·x = b, column operations that are unimodular (swaps, and
// adding an integer multiple of one column to another) turn A into a lower-triangular
// H = A·U without changing which right-hand sides are reachable by integer x, because
// x = U·y is a bijection on integer vectors. H·y = b is then solved by forward
// substitution: each row either fixes the next y (which must come out an integer) or
// has no new column (and must then already be satisfied). Exact, bigint-only, and
// deterministic.
export function integerSolvable(equations: readonly Linear[]): boolean {
  const ids = [...new Set(equations.flatMap((e) => [...e.coefficients.keys()]))].sort((x, y) => x - y);
  const n = ids.length;
  const a: bigint[][] = equations.map((e) => ids.map((id) => e.coefficients.get(id) ?? 0n));
  const b: bigint[] = equations.map((e) => -e.constant);

  const swapColumns = (i: number, j: number) => {
    for (const row of a) [row[i], row[j]] = [row[j] as bigint, row[i] as bigint];
  };
  const subtractColumn = (target: number, source: number, factor: bigint) => {
    for (const row of a) row[target] = (row[target] as bigint) - factor * (row[source] as bigint);
  };

  // Reduce, row by row, to lower-triangular form.
  const pivotColumn: (number | null)[] = [];
  let next = 0;
  for (const row of a) {
    for (;;) {
      let smallest = -1;
      for (let j = next; j < n; j += 1) {
        const value = row[j] as bigint;
        if (value !== 0n && (smallest < 0 || abs(value) < abs(row[smallest] as bigint))) smallest = j;
      }
      if (smallest < 0) {
        pivotColumn.push(null);
        break;
      }
      swapColumns(next, smallest);
      let reduced = true;
      for (let j = next + 1; j < n; j += 1) {
        if ((row[j] as bigint) === 0n) continue;
        subtractColumn(j, next, (row[j] as bigint) / (row[next] as bigint)); // remainder is smaller than the pivot
        if ((row[j] as bigint) !== 0n) reduced = false;
      }
      if (reduced) {
        pivotColumn.push(next);
        next += 1;
        break;
      }
    }
  }

  // Forward substitution in integers.
  const y: bigint[] = new Array<bigint>(n).fill(0n);
  for (let i = 0; i < a.length; i += 1) {
    const row = a[i] as bigint[];
    const pivot = pivotColumn[i] ?? null;
    let rest = b[i] as bigint;
    for (let j = 0; j < (pivot ?? next); j += 1) rest -= (row[j] as bigint) * (y[j] as bigint);
    if (pivot === null) {
      if (rest !== 0n) return false;
      continue;
    }
    const h = row[pivot] as bigint;
    if (rest % h !== 0n) return false;
    y[pivot] = rest / h;
  }
  return true;
}

function rowSolvable(linear: Linear): boolean {
  let g = 0n;
  for (const c of linear.coefficients.values()) g = gcd(g, c);
  return g === 0n ? linear.constant === 0n : linear.constant % g === 0n;
}

export class LinearSystem {
  private rows: Row[] = [];
  private readonly equations: Linear[] = []; // every equation accepted so far, as given
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
    // (1) Rational consistency, by elimination against the reduced rows.
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
      if (b !== undefined) row = eliminate(row, existing, existing.coefficients.get(pivot) ?? 1n, b);
    }
    if (row.coefficients.size === 0 && row.constant !== 0n) {
      return { kind: "contradiction", reason: "no solution" };
    }

    // (2) Integer solvability of the whole system, exactly.
    if (!rowSolvable(linear)) {
      return { kind: "contradiction", reason: "no integer solution" };
    }
    if (!integerSolvable([...this.equations, linear])) {
      return { kind: "contradiction", reason: "no integer solution together with the earlier constraints" };
    }
    this.equations.push(linear);
    if (row.coefficients.size === 0) {
      return { kind: "consistent", resolved: new Map() }; // redundant
    }

    // Keep the rows reduced: remove the new pivot from every other row.
    const added = normalize(row);
    const pivot = pivotOf(added);
    const a = added.coefficients.get(pivot) ?? 1n;
    const rows = this.rows.map((existing) => {
      const b = existing.coefficients.get(pivot);
      return b === undefined ? existing : normalize(eliminate(existing, added, a, b));
    });
    rows.push(added);

    // (3) A row with one symbol determines it: c·α + k = 0. The system has an integer
    // solution and α is unique, so c divides k.
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
