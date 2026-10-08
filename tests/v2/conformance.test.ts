import { describe, expect, it } from "vitest";
import { hasErrors, loadDocument } from "../../src/v2";
import { readRepoFile } from "./helpers";

// The conformance set: programs with known results. M0 can only check that each one is
// a valid document; each run turns into a real test when its milestone lands.

type Expectation = {
  path: string;
  milestone: string;
  status: string;
  output: string[];
  steps: number;
};

const { fixtures } = JSON.parse(readRepoFile("tests/conformance/expected.json")) as { fixtures: Expectation[] };

describe("conformance fixtures", () => {
  it("includes the bootstrap trio", () => {
    const statuses = fixtures.filter((fixture) => fixture.path.includes("/temporal/bootstrap-")).map((fixture) => fixture.status);
    expect(statuses.sort()).toEqual(["AMBIGUOUS", "HALT", "PARADOX"]);
  });

  for (const fixture of fixtures) {
    describe(fixture.path, () => {
      it("is a valid M0 document", () => {
        const loaded = loadDocument(readRepoFile(fixture.path));
        expect(hasErrors(loaded.diagnostics)).toBe(false);
        expect(loaded.space?.layers.length).toBeGreaterThan(0);
      });

      it.todo(`runs to ${fixture.status} with output [${fixture.output.join(", ")}] in ${fixture.steps} steps (${fixture.milestone})`);
    });
  }
});
