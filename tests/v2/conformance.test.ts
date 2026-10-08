import { describe, expect, it } from "vitest";
import { compileProgram, formatProgramIr, formatProgramTrace, formatType, hasErrors, loadDocument, runProgram } from "../../src/v2";
import { readRepoFile } from "./helpers";

// The conformance set: programs with known results. A fixture runs once its milestone
// is implemented: its outcome, output, step count and (when given) its golden trace
// must match exactly. Fixtures for later milestones must still load, and must be
// refused by the compiler only because they use what a later milestone adds.

const IMPLEMENTED = new Set(["M2", "M3", "M4", "M5"]);

type Expectation = {
  path: string;
  milestone: string;
  status: string;
  output: string[];
  steps: number;
  trace?: string;
  ir?: string;
  types?: Record<string, string>;
  codes?: string[];
  unknowns?: { bornAtStep: number; value: string | null; mark: string | null }[];
};

const { fixtures } = JSON.parse(readRepoFile("tests/conformance/expected.json")) as { fixtures: Expectation[] };

describe("conformance fixtures", () => {
  it("includes the canonical bootstrap trio: β = β, β = 2β, β = β + 1", () => {
    const trio = fixtures.filter((fixture) => fixture.path.includes("/temporal/bootstrap-"));
    expect(trio.map((fixture) => [fixture.path.split("/").pop(), fixture.status, fixture.output])).toEqual([
      ["bootstrap-ambiguous.y3", "AMBIGUOUS", ["?"]],
      ["bootstrap-self-caused.y3", "HALT", ["0"]],
      ["bootstrap-paradox.y3", "PARADOX", []],
    ]);
    expect(trio.every((fixture) => IMPLEMENTED.has(fixture.milestone))).toBe(true);
  });

  for (const fixture of fixtures) {
    describe(fixture.path, () => {
      const loaded = loadDocument(readRepoFile(fixture.path));

      it("is a valid document", () => {
        expect(hasErrors(loaded.diagnostics)).toBe(false);
        expect(loaded.space?.layers.length).toBeGreaterThan(0);
      });

      if (!IMPLEMENTED.has(fixture.milestone)) {
        it(`is refused until ${fixture.milestone}, only for temporal features`, () => {
          if (!loaded.ast || !loaded.space) throw new Error("expected a document");
          const compiled = compileProgram(loaded.ast, loaded.space);
          expect(compiled.program).toBeNull();
          const codes = compiled.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
          expect(codes.length).toBeGreaterThan(0);
          expect(codes.every((code) => code.startsWith("Y3T")), codes.join(", ")).toBe(true);
        });
        it.todo(`runs to ${fixture.status} with output [${fixture.output.join(", ")}] in ${fixture.steps} steps (${fixture.milestone})`);
        return;
      }

      if (fixture.status === "REJECTED") {
        it(`is refused by check with ${(fixture.codes ?? []).join(", ")}`, () => {
          if (!loaded.ast || !loaded.space) throw new Error("expected a document");
          const compiled = compileProgram(loaded.ast, loaded.space);
          expect(compiled.program).toBeNull();
          expect(compiled.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(fixture.codes);
        });
        return;
      }

      it(`runs to ${fixture.status} with output [${fixture.output.join(", ")}] in ${fixture.steps} steps`, () => {
        if (!loaded.ast || !loaded.space || !loaded.manifest) throw new Error("expected a document");
        const compiled = compileProgram(loaded.ast, loaded.space);
        expect(compiled.diagnostics).toEqual([]);
        if (!compiled.program) throw new Error("expected a program");
        if (fixture.ir) {
          expect(formatProgramIr(compiled.program.cells.values(), compiled.program.nouns)).toBe(readRepoFile(fixture.ir));
        }
        for (const [name, type] of Object.entries(fixture.types ?? {})) {
          const noun = compiled.program.nouns.find((n) => n.name === name);
          expect(noun && formatType(noun.type), `type of ${name}`).toBe(type);
        }
        const result = runProgram(compiled.program, loaded.manifest);
        expect(result.outcome.status).toBe(fixture.status);
        expect(result.output).toEqual(fixture.output);
        expect(result.outcome.steps).toBe(fixture.steps);
        if (fixture.trace) {
          expect(formatProgramTrace(result)).toBe(readRepoFile(fixture.trace));
        }
        for (const unknown of fixture.unknowns ?? []) {
          const symbol = result.symbols.find((s) => s.born === unknown.bornAtStep);
          expect(symbol, `symbol born at step ${unknown.bornAtStep}`).toBeDefined();
          expect(symbol?.value).toBe(unknown.value);
          expect(symbol?.mark).toBe(unknown.mark);
        }
      });
    });
  }
});
