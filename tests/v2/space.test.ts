import { describe, expect, it } from "vitest";
import { buildSpace, DIAGNOSTIC_CODES as CODES, lookup, loadDocument } from "../../src/v2";
import { parseOk, readRepoFile } from "./helpers";

describe("space: the semantic model", () => {
  it("gives every layer its own size", () => {
    const { space } = loadDocument(readRepoFile("examples/v2/stairwell.y3"));
    expect(space?.layers.map((layer) => [layer.plane.width, layer.plane.height])).toEqual([
      [1, 8],
      [1, 5],
    ]);
    expect(space?.manifest).toBe('name = "stairwell"');
  });

  it("distinguishes a blank cell from VOID", () => {
    const { space } = loadDocument(readRepoFile("examples/v2/stairwell.y3"));
    if (!space) throw new Error("expected a space");
    expect(lookup(space, 0, 0, 1)).toEqual({ kind: "cell", cell: { sentence: null } }); // [ ]
    expect(lookup(space, 0, 3, 1)).toEqual({ kind: "cell", cell: { sentence: '"둘"을 말한다.' } });
    expect(lookup(space, 0, 7, 0)).toEqual({ kind: "cell", cell: { sentence: "끝이다." } });
    expect(lookup(space, 0, 8, 0)).toEqual({ kind: "void" }); // past the bottom edge
    expect(lookup(space, 1, 0, 0)).toEqual({ kind: "void" }); // past the east edge
    expect(lookup(space, -1, 0, 0)).toEqual({ kind: "void" });
    expect(lookup(space, 0, 6, 1)).toEqual({ kind: "void" }); // floor 1 is shorter
    expect(lookup(space, 0, 0, 2)).toEqual({ kind: "void" }); // no floor 2
    expect(lookup(space, 0, 0, -1)).toEqual({ kind: "void" });
  });

  it("reports unknown and duplicate planes as errors", () => {
    const unknown = buildSpace(parseOk("⟦ :없음: ⟧"));
    expect(unknown.space).toBeNull();
    expect(unknown.diagnostics.map((d) => d.code)).toEqual([CODES.UNKNOWN_PLANE]);

    const duplicate = buildSpace(parseOk("⟦ :a: ⟧\n※\n:a: ⟦ [A] ⟧\n:a: ⟦ [B] ⟧"));
    expect(duplicate.space).toBeNull();
    expect(duplicate.diagnostics.map((d) => d.code)).toEqual([CODES.DUPLICATE_PLANE]);
  });

  it("warns about named planes that are never used, but still builds", () => {
    const result = buildSpace(parseOk("⟦ [A] ⟧\n※\n:spare: ⟦ [B] ⟧"));
    expect(result.space?.layers).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ code: CODES.UNUSED_PLANE, severity: "warning" }]);
  });
});
