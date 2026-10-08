import { describe, expect, it } from "vitest";
import { combine, formatTerm, fromLinear, LinearSystem, literal, symbol, TemporalStore, type Linear } from "../../src/v2";

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
