import { describe, expect, it } from "vitest";
import { compileWasm, loadWasmArtifact, moduleOf, readCustomSection, WasmArtifactError, WASM_SECTION } from "../../src/v2";
import { column, compileSource, observable, runHir, runVm, runWasmEngine, wasmArtifact } from "./compile-helpers";
import { fixtures } from "./helpers";
import { ORIENTATIONS, prng, randomCallee, randomGrid, renderProgram } from "./program-generator";

// M9: the WebAssembly backend (docs/v2-wasm.md) is the same language as the HIR
// interpreter and the VM: everything observable is equal, temporal causality included.

const same = (source: string, maxSteps?: number, stdin?: string) => {
  const c = compileSource(source);
  if (!c) throw new Error("does not compile");
  const hir = observable(runHir(c, maxSteps, stdin));
  expect(observable(runVm(c, maxSteps, stdin, true))).toEqual(hir);
  const wasm = runWasmEngine(c, maxSteps, stdin);
  expect(observable(wasm)).toEqual(hir);
  return wasm;
};

describe("HIR = VM = WASM, on every fixture", () => {
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const c = compileSource(source, path);
      if (!c || c.program.space.layers.length === 0) return;
      expect(observable(runWasmEngine(c))).toEqual(observable(runHir(c)));
    });
  }
});

describe("HIR = WASM, on seeded random programs (property)", () => {
  const cases: [string, { temporal: boolean; calls: boolean }, number][] = [
    ["space and arithmetic", { temporal: false, calls: false }, 200],
    ["with calls", { temporal: false, calls: true }, 150],
    ["with time", { temporal: true, calls: false }, 200],
    ["with calls and time", { temporal: true, calls: true }, 150],
  ];
  for (const [label, opts, count] of cases) {
    it(`${label}: ${count} programs`, () => {
      let compiled = 0;
      for (let seed = 1; seed <= count; seed += 1) {
        const r = prng(seed * 104729 + count);
        const grid = randomGrid(r, { floors: 2, width: 3, height: 3 }, opts);
        const callee = opts.calls ? randomCallee(r) : null;
        const source = renderProgram(grid, callee, r.pick(ORIENTATIONS));
        const c = compileSource(source);
        if (!c) continue;
        compiled += 1;
        expect(observable(runWasmEngine(c, 80)), `seed ${seed}:\n${source}`).toEqual(observable(runHir(c, 80)));
      }
      expect(compiled).toBeGreaterThan(count * 0.6);
    });
  }
});

describe("WASM: semantics stay in the runtime core", () => {
  it("checked arithmetic: overflow, division by zero and MIN / -1 FAULT, never wrap or trap", () => {
    expect(same(column(["x는 2147483647i32이다.", "x에 1i32를 더한다.", "끝이다."])).outcome.status).toBe("FAULT");
    expect(same(column(["x는 1이다.", "x를 0으로 나눈다.", "끝이다."])).outcome.status).toBe("FAULT");
    expect(same(column(["x는 -128i8이다.", "x를 -1i8로 나눈다.", "끝이다."])).outcome.status).toBe("FAULT");
    expect(same(column(["x는 170141183460469231731687303715884105727i128이다.", "x를 말한다.", "x에 1i128을 더한다.", "끝이다."])).output).toEqual(["170141183460469231731687303715884105727"]);
  });

  it("f32 rounding, NaN, -0.0", () => {
    expect(same(column(["x는 0.1f32이다.", "x에 0.2f32를 더한다.", "x를 말한다.", "z는 -0.0이다.", "z를 말한다.", "n은 0.0이다.", "n을 0.0으로 나눈다.", "n을 말한다.", "끝이다."])).output).toEqual(["0.3", "-0.0", "NaN"]);
  });

  it("movement keeps the full pose (up included)", () => {
    const r = same(column(["x는 1이다.", "위를 본다.", "왼쪽을 본다.", "앞으로 간다.", "끝이다."]));
    expect(r.trace.length).toBeGreaterThan(0);
  });

  it("a loop under a tilted pose: the anchor keeps up as well as forward", () => {
    const source = `+++\n[start]\nfacing = "남"\nup = "동"\n+++\n${column(["i는 0이다.", "여기가 처음이다.", "i에 1을 더한다.", "i가 3보다 작으면 끝은 처음이다.", "i를 말한다.", "끝이다."])}`;
    const r = same(source);
    expect(r.output).toEqual(["3"]);
    expect(r.trace[0]?.orientation).toEqual({ forward: "south", up: "east" });
  });

  it("loops, calls, recursion, data and collections", () => {
    const appendix = ":합: (n: i64) → i64 ⟦\n[n이 0이면 0을 돌려준다.]\n[m은 n이다.]\n[m에서 1을 뺀다.]\n[r은 합: m]\n[r에 n을 더한다.]\n[r을 돌려준다.]\n⟧\n";
    expect(same(column(["s는 합: 100", "s를 말한다.", "끝이다."], appendix), 100_000).output).toEqual(["5050"]);
    expect(same(column(["o는 Some: 3", "v는 o에 따라: Some(x) → x, None → 0", "v를 말한다.", "l은 목록 새:", "l은 목록 추가: l, 4", "l을 말한다.", "끝이다."])).output).toEqual(["3", "[4]"]);
  });

  it("temporal unknowns, RETRO, SELF_CAUSED and PARADOX", () => {
    expect(same(column(["x는 미정이다.", "x를 말한다.", "x는 4였다.", "끝이다."])).output).toEqual(["4"]);
    for (const { path, source } of fixtures().filter((f) => /retro|paradox|self|prophecy|fixed/.test(f.path))) {
      const c = compileSource(source, path);
      if (c && c.program.space.layers.length > 0) expect(observable(runWasmEngine(c)), path).toEqual(observable(runHir(c)));
    }
    expect(same(column(["x는 미정이다.", "x는 x였다.", "끝이다."])).outcome.status).toBe(runHir(compileSource(column(["x는 미정이다.", "x는 x였다.", "끝이다."]))!).outcome.status);
    expect(same(column(["x는 미정이다.", "x는 1였다.", "x는 2였다.", "끝이다."])).outcome.status).toBe("PARADOX");
  });

  it("the effect barrier, stdin and clock imports", () => {
    expect(same(column(["x는 미정이다.", "x를 말한다.", "t는 시계 지금:", "x는 1였다.", "끝이다."])).outcome.status).toBe("UNRESOLVED");
    const r = same(column(["l은 표준 줄읽기:", "t는 시계 지금:", "l을 말한다.", "t를 말한다.", "끝이다."]), undefined, "안녕\n");
    expect(r.output).toEqual(['Some("안녕")', "42"]);
  });

  it("the step limit", () => {
    expect(same(column(["x는 1이다.", "뒤로 간다."]), 50).outcome.status).toBe("STEP_LIMIT");
  });
});

describe("WASM artifacts are not trusted on their own", () => {
  const c = compileSource(column(["x는 1이다.", "x에 2를 더한다.", "x를 말한다.", "끝이다."]))!;
  const bytes = wasmArtifact(c);

  it("carry their bytecode, and build reproducibly", () => {
    expect(new TextDecoder().decode(readCustomSection(bytes, WASM_SECTION)!)).toMatch(/^Y3BC 3\n/);
    expect(wasmArtifact(c)).toEqual(bytes);
    expect(() => new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>)).not.toThrow();
  });

  it("code that is not the compilation of its bytecode is refused", () => {
    const edited = bytes.slice();
    const at = edited.findIndex((b, i) => b === 0x41 && edited[i + 1] === 0x00 && edited[i + 2] === 0x10); // an `i32.const 0; call` in the code
    edited[at + 1] = 0x01;
    expect(() => loadWasmArtifact(edited)).toThrow(/not the compilation of its bytecode/);
  });

  it("bytecode that fails verification is refused", () => {
    const text = new TextDecoder().decode(readCustomSection(bytes, WASM_SECTION)!);
    const bad = text.replace('"registers":', '"registers":-1,"x":');
    const loaded = moduleOf(text);
    const forged = compileWasm(loaded, bad);
    expect(() => loadWasmArtifact(forged)).toThrow(WasmArtifactError);
    expect(() => loadWasmArtifact(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toThrow(/no 'y3bc' section/);
  });
});
