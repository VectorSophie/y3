import { describe, expect, it } from "vitest";
import { compileSource, column, runHir, runVm } from "./compile-helpers";
import { readRepoFile } from "./helpers";

// The temporal constraint graph records, and never changes, temporal semantics.

const graphOf = (source: string) => {
  const c = compileSource(source);
  if (!c) throw new Error("expected a program");
  const hir = runHir(c);
  const vm = runVm(c);
  expect(vm.temporal).toEqual(hir.temporal); // both engines build the same graph
  return hir;
};

describe("temporal constraint graph", () => {
  it("β = β: closed on itself, never resolved: AMBIGUOUS", () => {
    const r = graphOf(readRepoFile("tests/conformance/temporal/bootstrap-ambiguous.y3"));
    expect(r.outcome.status).toBe("AMBIGUOUS");
    expect(r.temporal.symbols).toEqual([{ label: "β1", origin: "다음", noun: "문장", born: 1, frame: null }]);
    expect(r.temporal.edges.filter((e) => e.kind === "resolves")).toEqual([]);
    expect(r.temporal.edges).toContainEqual({ kind: "closes", symbol: "β1", via: "channel S1" });
  });

  it("β = 2β: closed and resolved to 0: SELF_CAUSED", () => {
    const r = graphOf(readRepoFile("tests/conformance/temporal/bootstrap-self-caused.y3"));
    expect(r.symbols).toMatchObject([{ label: "β1", value: "0", mark: "SELF_CAUSED" }]);
    expect(r.temporal.edges).toContainEqual({ kind: "closes", symbol: "β1", via: "channel S1" });
    expect(r.temporal.edges).toContainEqual({ kind: "resolves", constraint: 0, symbol: "β1", value: "0" });
    expect(r.temporal.edges).toContainEqual({ kind: "fills", symbol: "β1", step: 2 });
  });

  it("β = β + 1: a constraint that cannot hold: PARADOX", () => {
    const r = graphOf(readRepoFile("tests/conformance/temporal/bootstrap-paradox.y3"));
    expect(r.outcome.status).toBe("PARADOX");
    expect(r.temporal.constraints).toMatchObject([{ source: "channel S1", holds: false }]);
  });

  it("keeps a symbol's identity through calls, returns, loops and fixed points", () => {
    const call = graphOf(column(["값은 미정이다.", "결과는 하나더: 값", "결과를 말한다.", "값은 3이었다.", "끝이다."], ":하나더: (수: bigint) → bigint ⟦\n[수에 1을 더한다.]\n[수를 돌려준다.]\n⟧\n"));
    expect(call.temporal.symbols.map((s) => s.label)).toEqual(["α1"]);
    expect(call.temporal.edges).toContainEqual({ kind: "resolves", constraint: 0, symbol: "α1", value: "3" });
    const born = graphOf(column(["x는 모름:", "x를 말한다.", 'x는 "날자"였다.', "끝이다."], ":모름: () → Text ⟦\n[y는 미정이다.]\n[y를 돌려준다.]\n⟧\n"));
    expect(born.temporal.symbols).toEqual([{ label: "α1", origin: "미정", noun: "y", born: 2, frame: "모름#1" }]);
    const fixed = graphOf(readRepoFile("tests/conformance/cycles/fixed-point-self-caused.y3"));
    expect(fixed.temporal.edges.some((e) => e.kind === "closes" && e.via.startsWith("fixed point"))).toBe(true);
    const loop = graphOf(readRepoFile("tests/conformance/cycles/anchor-end.y3"));
    expect(loop.temporal.symbols.map((s) => s.origin)).toContain("끝");
  });
});
