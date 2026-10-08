import { describe, expect, it } from "vitest";
import {
  buildSpace,
  extractPlane,
  formatDocument,
  inlinePlane,
  PROJECTIONS,
  sameDocument,
  semanticKey,
  type DocumentAst,
  type Space,
} from "../../src/v2";
import { fixtures, parseOk, readRepoFile } from "./helpers";

function spaceOf(ast: DocumentAst): Space {
  const { space, diagnostics } = buildSpace(ast);
  if (!space) {
    throw new Error(diagnostics.map((d) => d.message).join("\n"));
  }
  return space;
}

describe("round trip: parse(format(parse(s))) = parse(s)", () => {
  for (const { path, source } of fixtures()) {
    for (const projection of PROJECTIONS) {
      it(`${path} · ${projection}`, () => {
        const ast = parseOk(source);
        const formatted = formatDocument(ast, { projection });
        expect(sameDocument(parseOk(formatted), ast)).toBe(true);
        // and formatting is idempotent
        expect(formatDocument(parseOk(formatted), { projection })).toBe(formatted);
      });
    }
  }

  it("every fixture is already in canonical (perspective) form", () => {
    for (const { path, source } of fixtures()) {
      expect(formatDocument(parseOk(source)), path).toBe(source);
    }
  });
});

describe("projection is not semantics", () => {
  for (const { path, source } of fixtures()) {
    it(`${path}: every projection parses to the same document and space`, () => {
      const ast = parseOk(source);
      const keys = PROJECTIONS.map((projection) => semanticKey(spaceOf(parseOk(formatDocument(ast, { projection })))));
      expect(new Set(keys).size).toBe(1);
      for (const projection of PROJECTIONS) {
        expect(sameDocument(parseOk(formatDocument(ast, { projection })), ast)).toBe(true);
      }
    });
  }

  it("draws deeper planes indented and, in strong projection, narrower", () => {
    const ast = parseOk(readRepoFile("examples/v2/projection.y3"));
    const strong = formatDocument(ast, { projection: "strong" }).split("\n");
    expect(strong).toContain("[A]  [B]  [C]  [D]");
    expect(strong).toContain("     [I] [J] [K] [L]");
    expect(strong).toContain("          [Q][R][S][T]");
    const flat = formatDocument(ast, { projection: "flat" }).split("\n");
    expect(flat).toContain("[Q] [R] [S] [T]");
  });

  it("aligns columns by display width, counting Hangul as two columns", () => {
    const ast = parseOk("⟦\n[값은 3이다.] [A]\n[B] [끝이다.]\n⟧");
    expect(formatDocument(ast)).toBe("⟦\n[값은 3이다.] [A]\n[B]           [끝이다.]\n⟧\n");
  });
});

describe("inline plane ≡ named referenced plane", () => {
  it("the inline and named versions of Example 1 are the same space", () => {
    const inline = spaceOf(parseOk(readRepoFile("examples/v2/stairwell.y3")));
    const named = spaceOf(parseOk(readRepoFile("examples/v2/stairwell-named.y3")));
    expect(semanticKey(named)).toBe(semanticKey(inline));
    expect(named.layers.map((layer) => layer.presentation)).toEqual([{ kind: "inline" }, { kind: "named", name: "detour" }]);
    expect(named.layers[1]?.plane).toEqual(inline.layers[1]?.plane);
  });

  for (const { path, source } of fixtures()) {
    it(`${path}: extracting every inline plane, then inlining every one, never changes the space`, () => {
      const original = parseOk(source);
      const key = semanticKey(spaceOf(original));

      let extracted = original;
      original.volume.forEach((slot, z) => {
        if (slot.plane.kind === "inline") {
          extracted = extractPlane(extracted, z, `층_${z}`);
          expect(semanticKey(spaceOf(extracted))).toBe(key);
        }
      });
      expect(extracted.volume.every((slot) => slot.plane.kind === "ref")).toBe(true);
      // still identical after a trip through text
      expect(semanticKey(spaceOf(parseOk(formatDocument(extracted))))).toBe(key);

      let inlined = extracted;
      extracted.volume.forEach((_, z) => {
        inlined = inlinePlane(inlined, z);
      });
      expect(inlined.volume.every((slot) => slot.plane.kind === "inline")).toBe(true);
      expect(semanticKey(spaceOf(inlined))).toBe(key);
    });
  }

  it("a named plane used on two floors becomes two independent, identical layers", () => {
    const space = spaceOf(parseOk("⟦ :층: ⟧\n⟦ [끝이다.] ⟧\n⟦ :층: ⟧\n※\n:층: ⟦ [ ] [A] ⟧\n"));
    expect(space.layers.map((layer) => layer.z)).toEqual([0, 1, 2]);
    expect(space.layers[0]?.plane).toEqual(space.layers[2]?.plane);
    // inlining one use keeps the definition for the other
    const once = inlinePlane(parseOk("⟦ :층: ⟧\n⟦ :층: ⟧\n※\n:층: ⟦ [A] ⟧\n"), 0);
    expect(once.appendix?.definitions.map((definition) => definition.name)).toEqual(["층"]);
  });
});
