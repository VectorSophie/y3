import { describe, expect, it } from "vitest";
import { compileToMir, optimizeMir, type OptimizationStats } from "../../src/v2";
import { compileSource, column, observable, runHir, runVm } from "./compile-helpers";
import { fixtures } from "./helpers";
import { ORIENTATIONS, prng, randomCallee, randomGrid, renderProgram } from "./program-generator";

// Optimized MIR must be the same program: same outcome, output, events, symbols and
// marks (SELF_CAUSED, RETRO), versions, trace (path, orientation, FAULT step) and graph.
describe("optimized MIR = unoptimized = HIR", () => {
  const total: OptimizationStats = { folded: 0, neutral: 0, copies: 0, dead: 0 };
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const c = compileSource(source, path);
      if (!c || c.program.space.layers.length === 0) return;
      const { stats } = optimizeMir(compileToMir(c.program, c.manifest.start).mir);
      for (const k of Object.keys(total) as (keyof OptimizationStats)[]) total[k] += stats[k];
      expect(observable(runVm(c, undefined, undefined, true))).toEqual(observable(runHir(c)));
    });
  }

  it("on 600 seeded random programs (property)", () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const r = prng(seed * 104729);
      const opts = { temporal: seed % 2 === 0, calls: seed % 3 === 0 };
      const source = renderProgram(randomGrid(r, { floors: 2, width: 3, height: 3 }, opts), opts.calls ? randomCallee(r) : null, r.pick(ORIENTATIONS));
      const c = compileSource(source);
      if (!c) continue;
      expect(observable(runVm(c, 80, undefined, true)), `seed ${seed}:\n${source}`).toEqual(observable(runHir(c, 80)));
    }
  });

  it("actually optimizes: folds, neutral steps, copies, dead temporaries", () => {
    const c = compileSource(column(["x는 3이다.", "x에 0을 더한다.", "y는 2이다.", "y에 1을 곱한다.", "o는 Some: x", "z는 o에 따라: Some(n) → n, None → 0", "z를 말한다.", "끝이다."]))!;
    const { stats } = optimizeMir(compileToMir(c.program, c.manifest.start).mir);
    expect(stats.neutral).toBeGreaterThanOrEqual(2);
    expect(stats.folded + stats.copies + stats.dead).toBeGreaterThan(0);
  });

  it("never touches bigint (temporal) arithmetic: x+0 on a symbol keeps its classification", () => {
    const source = column(["수가 다음에서 온다.", "수에 0을 더한다.", "수를 말한다.", "수를 전으로 보낸다.", "끝이다."]);
    const c = compileSource(source)!;
    const { mir, stats } = optimizeMir(compileToMir(c.program, c.manifest.start).mir);
    expect(stats.neutral).toBe(0);
    expect(mir.blocks.flatMap((b) => b.ops).some((o) => o.op === "arith" && o.type === "bigint")).toBe(true);
    expect(observable(runVm(c, undefined, undefined, true))).toEqual(observable(runHir(c)));
  });

  it("does not fold an overflow: the FAULT stays at its step", () => {
    const c = compileSource(column(["x는 1이다.", "y는 255u8이다.", "y에 1을 더한다.", "끝이다."]))!;
    const r = runVm(c, undefined, undefined, true);
    expect(r.outcome).toMatchObject({ status: "FAULT", steps: 2 });
    expect(observable(r)).toEqual(observable(runHir(c)));
  });

  it("never turns -0.0 into +0.0 (no x+0.0)", () => {
    const c = compileSource(column(["x는 -0.0이다.", "x에 0.0을 더한다.", "x를 말한다.", "y는 -0.0이다.", "y에서 0.0을 뺀다.", "y를 말한다.", "끝이다."]))!;
    expect(runVm(c, undefined, undefined, true).output).toEqual(["0.0", "-0.0"]);
  });
});
