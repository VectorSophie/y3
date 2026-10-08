import { describe, expect, it } from "vitest";
import { combine, formatTerm, fromLinear, integerSolvable, LinearSystem, literal, symbol, TemporalStore, type Linear } from "../../src/v2";

// Σ cᵢ·αᵢ + k, written as [[id, c], …] and k.
const row = (coefficients: [number, number][], constant: number): Linear => ({
  constant: BigInt(constant),
  coefficients: new Map(coefficients.map(([id, c]) => [id, BigInt(c)])),
});

describe("symbolic terms", () => {
  const label = (id: number) => `α${id}`;
  const int = (n: number) => literal({ kind: "int", value: BigInt(n) });

  it("normalise: a bare symbol is a symbol, a constant is a literal", () => {
    expect(fromLinear(row([[1, 1]], 0))).toEqual(symbol(1));
    expect(fromLinear(row([[1, 0]], 5))).toEqual(int(5));
    expect(fromLinear(row([[1, 2]], 0)).kind).toBe("linear");
  });

  it("combine and print", () => {
    const t = combine(combine(symbol(1), symbol(1), 1n), int(3), -1n);
    expect(formatTerm(t, label)).toBe("2·α1 - 3");
    expect(formatTerm(combine(symbol(1), symbol(2), -1n), label)).toBe("α1 - α2");
    expect(combine(symbol(1), symbol(1), -1n)).toEqual(int(0));
  });

  it("refuse arithmetic on text", () => {
    expect(() => combine(literal({ kind: "text", value: "a" }), int(1), 1n)).toThrow(/integers/);
  });
});

describe("the linear solver", () => {
  it("x + 1 = 4 → x = 3", () => {
    const system = new LinearSystem();
    expect(system.add(row([[1, 1]], 1 - 4))).toEqual({ kind: "consistent", resolved: new Map([[1, 3n]]) });
  });

  it("resolves only what the equations determine", () => {
    const system = new LinearSystem();
    // α1 + α2 = 5: two unknowns, one equation
    expect(system.add(row([[1, 1], [2, 1]], -5))).toEqual({ kind: "consistent", resolved: new Map() });
    expect(system.constrained()).toEqual(new Set([1, 2]));
    // α1 - α2 = 1: now both are determined
    expect(system.add(row([[1, 1], [2, -1]], -1))).toEqual({ kind: "consistent", resolved: new Map([[1, 3n], [2, 2n]]) });
    expect(system.constrained()).toEqual(new Set());
  });

  it("uses known values in later equations", () => {
    const system = new LinearSystem();
    system.add(row([[1, 1]], -3));
    expect(system.add(row([[1, 2], [2, 1]], -10))).toEqual({ kind: "consistent", resolved: new Map([[2, 4n]]) });
  });

  it("accepts a redundant equation, and rejects a contradictory one without changing", () => {
    const system = new LinearSystem();
    system.add(row([[1, 1], [2, 1]], -5));
    expect(system.add(row([[1, 2], [2, 2]], -10))).toEqual({ kind: "consistent", resolved: new Map() });
    expect(system.add(row([[1, 1], [2, 1]], -6))).toEqual({ kind: "contradiction", reason: "no solution" });
    expect(system.constrained()).toEqual(new Set([1, 2]));
  });

  it("rejects equations with no integer solution", () => {
    expect(new LinearSystem().add(row([[1, 2]], -3))).toEqual({ kind: "contradiction", reason: "no integer solution" }); // 2α = 3
    expect(new LinearSystem().add(row([[1, 2], [2, 4]], -1))).toEqual({ kind: "contradiction", reason: "no integer solution" }); // 2α + 4β = 1
  });

  it("solves the bootstrap shapes as plain equations", () => {
    expect(new LinearSystem().add(row([[1, 0]], 0))).toEqual({ kind: "consistent", resolved: new Map() }); // β = β
    expect(new LinearSystem().add(row([[1, -1]], 0))).toEqual({ kind: "consistent", resolved: new Map([[1, 0n]]) }); // β = 2β
    expect(new LinearSystem().add(row([[1, 0]], -1))).toEqual({ kind: "contradiction", reason: "no solution" }); // β = β + 1
  });

  it("accepts an underdetermined system that has integer solutions, resolving nothing", () => {
    const one = new LinearSystem();
    expect(one.add(row([[1, 2], [2, 3]], -1))).toEqual({ kind: "consistent", resolved: new Map() }); // 2x + 3y = 1 (x = 2, y = -1)
    const two = new LinearSystem();
    expect(two.add(row([[1, 6], [2, 10], [3, 15]], -1))).toEqual({ kind: "consistent", resolved: new Map() }); // 6x + 10y + 15z = 1
    const three = new LinearSystem();
    three.add(row([[1, 1], [2, 2], [3, 3]], -6)); // x + 2y + 3z = 6
    expect(three.add(row([[1, 1], [2, -1]], 0))).toEqual({ kind: "consistent", resolved: new Map() }); // x = y: 3(y + z) = 6
    expect(three.constrained()).toEqual(new Set([1, 2, 3]));
  });

  it("stays exact beyond 2^53", () => {
    const big = 2n ** 80n;
    const system = new LinearSystem();
    expect(system.add({ constant: -big - 1n, coefficients: new Map([[1, 1n]]) })).toEqual({ kind: "consistent", resolved: new Map([[1, big + 1n]]) });
  });
});

describe("the temporal store", () => {
  it("moves a symbol from declared to constrained to resolved", () => {
    const store = new TemporalStore();
    const a = store.declare("a", 1);
    const b = store.declare("b", 2);
    expect(store.state(1)).toBe("declared");
    store.arithmetic(a, b, 1n); // arithmetic fixes the sort, not the value
    expect(store.state(1)).toBe("declared");
    store.equate(combine(a, b, 1n), literal({ kind: "int", value: 5n }), 3);
    expect([store.state(1), store.state(2)]).toEqual(["constrained", "constrained"]);
    const result = store.equate(combine(a, b, -1n), literal({ kind: "int", value: 1n }), 4);
    expect(result.kind === "consistent" && result.resolutions.map((r) => [r.symbol.label, r.value])).toEqual([
      ["α1", { kind: "int", value: 3n }],
      ["α2", { kind: "int", value: 2n }],
    ]);
    expect(store.state(1)).toBe("resolved");
  });

  it("calls a resolution retroactive only when earlier steps already depended on it", () => {
    const store = new TemporalStore();
    const a = store.declare("a", 1);
    store.noteUse(a, 2);
    store.noteUse(a, 4);
    const used = store.equate(a, literal({ kind: "int", value: 7n }), 6);
    expect(used.kind === "consistent" && used.resolutions[0]).toMatchObject({ retroactive: true, fills: [2, 4] });

    const b = store.declare("b", 7);
    const unused = store.equate(b, literal({ kind: "int", value: 1n }), 8);
    expect(unused.kind === "consistent" && unused.resolutions[0]).toMatchObject({ retroactive: false, fills: [] });
  });

  it("binds text symbols by unification, and keeps sorts apart", () => {
    const store = new TemporalStore();
    const name = store.declare("이름", 1);
    const text = literal({ kind: "text", value: "이상" });
    const bound = store.equate(name, text, 2);
    expect(bound.kind === "consistent" && bound.resolutions[0]?.value).toEqual({ kind: "text", value: "이상" });

    const n = store.declare("n", 3);
    store.arithmetic(n, literal({ kind: "int", value: 1n }), 1n);
    expect(store.equate(n, text, 4)).toMatchObject({ kind: "contradiction" });
  });
});

describe("integer solvability is a property of the whole system", () => {
  // Each equation alone passes the per-row gcd test, and every system here has rational
  // solutions, but no integer one.
  const infeasible: [string, Linear[]][] = [
    [
      "-3x - 3y - 2z - 4 = 0, -3x - z - 4 = 0 (z ≡ 1 and z ≡ 2 mod 3)",
      [row([[1, -3], [2, -3], [3, -2]], -4), row([[1, -3], [3, -1]], -4)],
    ],
    ["x + 2y = 1, x + 4z = 2 (x odd and even)", [row([[1, 1], [2, 2]], -1), row([[1, 1], [3, 4]], -2)]],
    ["3x + 2y = 1, 3x + 4z = 0 (12t + 2y = 1)", [row([[1, 3], [2, 2]], -1), row([[1, 3], [3, 4]], 0)]],
    ["x + y = 1, x - y = 0 (x = y = 1/2)", [row([[1, 1], [2, 1]], -1), row([[1, 1], [2, -1]], 0)]],
    // Found by searching for systems the earlier per-row check accepted:
    ["-4x + 2y - z - 1 = 0, -2y + 3z + 5 = 0 (z odd, and z = 2x - 2 even)", [row([[1, -4], [2, 2], [3, -1]], -1), row([[2, -2], [3, 3]], 5)]],
    ["2x - 4y - 3z - 2 = 0, -2x - 4y - 2z - 3 = 0 (even = odd)", [row([[1, 2], [2, -4], [3, -3]], -2), row([[1, -2], [2, -4], [3, -2]], -3)]],
  ];

  for (const [label, equations] of infeasible) {
    it(`rejects ${label}`, () => {
      expect(integerSolvable(equations)).toBe(false);
      for (const order of [equations, [...equations].reverse()]) {
        const system = new LinearSystem();
        const results = order.map((equation) => system.add(equation));
        const first = results.findIndex((r) => r.kind === "contradiction");
        expect(first).toBeGreaterThanOrEqual(0); // some equation is rejected …
        expect(results.slice(0, first).every((r) => r.kind === "consistent")).toBe(true); // … and none before it
      }
    });
  }

  it("names the reason: the equation itself, or the system it joins", () => {
    expect(new LinearSystem().add(row([[1, 2], [2, 4]], -1))).toEqual({ kind: "contradiction", reason: "no integer solution" });
    const system = new LinearSystem();
    system.add(row([[1, -3], [2, -3], [3, -2]], -4));
    expect(system.add(row([[1, -3], [3, -1]], -4))).toEqual({
      kind: "contradiction",
      reason: "no integer solution together with the earlier constraints",
    });
  });

  // A tiny deterministic generator, so these properties are reproducible.
  function lcg(seed: number) {
    let state = seed >>> 0;
    return (low: number, high: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return low + (state % (high - low + 1));
    };
  }

  it("never rejects a system that has a known integer solution", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = lcg(seed);
      const n = next(1, 4);
      const solution = Array.from({ length: n }, () => BigInt(next(-20, 20)));
      const system = new LinearSystem();
      for (let e = next(1, 4); e > 0; e -= 1) {
        const coefficients = Array.from({ length: n }, () => BigInt(next(-6, 6)));
        const value = coefficients.reduce((sum, c, i) => sum + c * (solution[i] as bigint), 0n);
        const equation = { constant: -value, coefficients: new Map(coefficients.map((c, i) => [i + 1, c] as [number, bigint])) };
        const result = system.add(equation);
        expect(result.kind, `seed ${seed}`).toBe("consistent");
        if (result.kind === "consistent") {
          for (const [id, v] of result.resolved) expect(v, `seed ${seed}, α${id}`).toBe(solution[id - 1]);
        }
      }
    }
  });

  it("never claims infeasibility when brute force finds a solution", () => {
    let rejected = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = lcg(seed * 7919);
      const equations = Array.from({ length: next(1, 3) }, () => ({
        constant: BigInt(next(-9, 9)),
        coefficients: new Map([1, 2, 3].map((id) => [id, BigInt(next(-4, 4))] as [number, bigint])),
      }));
      if (integerSolvable(equations)) continue;
      rejected += 1;
      const rows = equations.map((e) => [e.constant, e.coefficients.get(1) ?? 0n, e.coefficients.get(2) ?? 0n, e.coefficients.get(3) ?? 0n]);
      let found: string | null = null;
      for (let x = -8n; x <= 8n && !found; x += 1n)
        for (let y = -8n; y <= 8n && !found; y += 1n)
          for (let z = -8n; z <= 8n && !found; z += 1n)
            if (rows.every(([k, a, b, c]) => (k as bigint) + (a as bigint) * x + (b as bigint) * y + (c as bigint) * z === 0n)) found = `(${x}, ${y}, ${z})`;
      expect(found, `seed ${seed}: a system called infeasible has the solution ${found}`).toBeNull();
    }
    expect(rejected).toBeGreaterThan(50); // the property was actually exercised
  });
});
