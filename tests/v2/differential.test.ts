import { describe, expect, it } from "vitest";
import { compileSource, observable, runHir, runVm } from "./compile-helpers";
import { fixtures } from "./helpers";

// The central M8 check: the bytecode VM and the HIR interpreter are the same language.
describe("HIR interpreter = bytecode VM, on every fixture", () => {
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const c = compileSource(source, path);
      if (!c || c.program.space.layers.length === 0) return;
      expect(observable(runVm(c))).toEqual(observable(runHir(c)));
    });
  }
});

import { ORIENTATIONS, prng, randomCallee, randomGrid, renderProgram } from "./program-generator";

// Shrinks a failing program by blanking cells while the engines still disagree.
function shrink(grid: (string | null)[][][], callee: (string | null)[][] | null, start: { facing: string; up: string }, differs: (src: string) => boolean): string {
  for (const floor of grid) {
    for (const row of floor) {
      for (let x = 0; x < row.length; x += 1) {
        const before = row[x] as string | null;
        if (before === null) continue;
        row[x] = null;
        if (!differs(renderProgram(grid, callee, start))) row[x] = before;
      }
    }
  }
  return renderProgram(grid, callee, start);
}

describe("HIR interpreter = bytecode VM, on seeded random programs (property)", () => {
  const cases: [string, { temporal: boolean; calls: boolean }, number][] = [
    ["space and arithmetic", { temporal: false, calls: false }, 400],
    ["with calls", { temporal: false, calls: true }, 250],
    ["with time", { temporal: true, calls: false }, 400],
    ["with calls and time", { temporal: true, calls: true }, 250],
  ];
  for (const [label, opts, count] of cases) {
    it(`${label}: ${count} programs`, () => {
      let compiled = 0;
      for (let seed = 1; seed <= count; seed += 1) {
        const r = prng(seed * 7919 + count);
        const grid = randomGrid(r, { floors: 2, width: 3, height: 3 }, opts);
        const callee = opts.calls ? randomCallee(r) : null;
        const start = r.pick(ORIENTATIONS);
        const source = renderProgram(grid, callee, start);
        const differs = (src: string) => {
          const c = compileSource(src);
          if (!c) return false;
          try {
            return JSON.stringify(observable(runVm(c, 80))) !== JSON.stringify(observable(runHir(c, 80)));
          } catch {
            return true; // the VM refused something the interpreter ran: that is a difference too
          }
        };
        const c = compileSource(source);
        if (!c) continue;
        compiled += 1;
        if (differs(source)) {
          const small = shrink(grid, callee, start, differs);
          const sc = compileSource(small);
          if (!sc) throw new Error(`seed ${seed}: shrinking lost the program`);
          expect(observable(runVm(sc, 80)), `seed ${seed}, shrunk program:\n${small}`).toEqual(observable(runHir(sc, 80)));
        }
      }
      expect(compiled, "most generated programs should compile").toBeGreaterThan(count * 0.6);
    });
  }
});

import { compileToMir, encodeBytecode, memoryHost, moduleOf, runExecutable, writeArtifact } from "../../src/v2";

describe("bytecode artifact round trip = HIR interpreter, on every fixture", () => {
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const c = compileSource(source, path);
      if (!c || c.program.space.layers.length === 0) return;
      const { mir, nodes } = compileToMir(c.program, c.manifest.start);
      const text = writeArtifact(encodeBytecode(mir, nodes, c.program, { module: "main", maxSteps: c.manifest.maxSteps, start: c.manifest.start }));
      expect(writeArtifact(encodeBytecode(mir, nodes, c.program, { module: "main", maxSteps: c.manifest.maxSteps, start: c.manifest.start }))).toBe(text); // reproducible
      const loaded = moduleOf(text);
      const vm = runExecutable(loaded.executable, loaded.program, c.manifest, { host: memoryHost({ now: 42n }) });
      const ref = runHir(c);
      expect({ ...observable(vm), versions: undefined }).toEqual({ ...observable(ref), versions: undefined });
    });
  }
});
