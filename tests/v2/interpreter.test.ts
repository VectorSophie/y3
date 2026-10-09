import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileProgram,
  describeEffect,
  hasErrors,
  loadDocument,
  runProgram,
  SENTENCE_CODES,
  type ProgramResult,
} from "../../src/v2";

function compile(source: string) {
  const loaded = loadDocument(source);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) {
    throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
  }
  return { compiled: compileProgram(loaded.ast, loaded.space), manifest: loaded.manifest };
}

function run(source: string, options: { maxSteps?: number } = {}): ProgramResult {
  const { compiled, manifest } = compile(source);
  if (!compiled.program) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
  return runProgram(compiled.program, manifest, options);
}

const column = (...cells: string[]) => `⟦\n${cells.map((cell) => `[${cell}]`).join("\n")}\n⟧\n`;

describe("values", () => {
  it("are bigint integers from the start", () => {
    const result = run(column("값은 9007199254740993이다.", "값에 1을 더한다.", "값을 말한다.", "끝이다."));
    expect(result.output).toEqual(["9007199254740994"]); // 2^53 + 2, exact
    expect(result.values.get("값")).toEqual({ kind: "int", value: 9007199254740994n });
  });

  it("never compare an integer with text: Eq<T> needs one T, checked before the run (M5)", () => {
    const { compiled } = compile(column('값은 "3"이다.', "값이 3이면 왼쪽을 본다.", "끝이다."));
    expect(compiled.program).toBeNull();
    expect(compiled.diagnostics.map((d) => d.message)).toEqual(["[값이 3이면 왼쪽을 본다.] cannot compare Text with Int"]);
  });

  it("refuse arithmetic on text before the run, not as a fault in it (M5)", () => {
    const { compiled } = compile(column('값은 "셋"이다.', "값에 1을 더한다.", "끝이다."));
    expect(compiled.program).toBeNull();
    expect(compiled.diagnostics.map((d) => d.code)).toContain("Y3Y001");
    expect(compiled.diagnostics[0]?.message).toBe("[값에 1을 더한다.] a value in arithmetic must be Int, not Text");
  });

  it("fault when a noun is read before this run gave it a value", () => {
    const result = run(column("수를 말한다.", "수는 1이다.", "끝이다."));
    expect(result.outcome).toMatchObject({ status: "FAULT", steps: 0, message: "'수' has no value or symbol yet" });
  });

  it("report a noun that no sentence ever gives a value, before running", () => {
    const { compiled } = compile(column("없는을 말한다.", "끝이다."));
    expect(compiled.program).toBeNull();
    expect(compiled.diagnostics.map((d) => d.code)).toEqual([SENTENCE_CODES.NEVER_INTRODUCED]);
  });
});

describe("loops are anchor regions; a plane can hold several", () => {
  it("runs two loops one after another in the same plane", () => {
    const result = run(
      column(
        "값은 2이다.",
        "여기가 처음이다.",
        "값을 말한다.",
        "값에서 1을 뺀다.",
        "값이 0이 아니면 끝은 처음이다.",
        '"다음"을 말한다.',
        "수는 2이다.",
        "여기가 처음이다.",
        "수를 말한다.",
        "수에서 1을 뺀다.",
        "수가 0이 아니면 끝은 처음이다.",
        "끝이다.",
      ),
    );
    expect(result.output).toEqual(["2", "1", "다음", "2", "1"]);
    expect(result.outcome.status).toBe("HALT");
  });

  it("nests: the inner back-edge returns to the inner anchor, then falls through to the outer one", () => {
    const result = run(
      column(
        "바깥은 2이다.",
        "여기가 처음이다.",
        "안은 2이다.",
        "여기가 처음이다.",
        "안을 말한다.",
        "안에서 1을 뺀다.",
        "안이 0이 아니면 끝은 처음이다.",
        "바깥에서 1을 뺀다.",
        "바깥이 0이 아니면 끝은 처음이다.",
        "끝이다.",
      ),
    );
    expect(result.output).toEqual(["2", "1", "2", "1"]);
    const anchors = result.trace.flatMap((entry) => entry.effects.filter((e) => e.kind === "anchor").map(describeEffect));
    expect(anchors).toEqual(["처음 (0,1,0) #1", "처음 (0,3,0) #1", "처음 (0,3,0) #2", "처음 (0,1,0) #2", "처음 (0,3,0) #1", "처음 (0,3,0) #2"]);
  });

  it("closes inner loops when the pointer comes back to an outer anchor", () => {
    const result = run(`+++
[start]
cell = [0, 1]
+++
${column("끝이다.", "여기가 처음이다.", "여기가 처음이다.", "뒤를 본다.")}`);
    expect(result.trace.map((entry) => entry.effects.map(describeEffect))).toEqual([
      ["처음 (0,1,0) #1"],
      ["처음 (0,2,0) #1"],
      [],
      ["처음 (0,2,0) #2"],
      ["leave 처음 (0,2,0)", "처음 (0,1,0) #2"],
      ["leave 처음 (0,1,0)", "end"],
    ]);
  });

  it("faults on a back-edge with no anchor", () => {
    expect(run(column("끝은 처음이다.")).outcome).toMatchObject({ status: "FAULT", steps: 0 });
  });

  it("stops an endless loop at the step limit", () => {
    const result = run(column("여기가 처음이다.", "끝은 처음이다."), { maxSteps: 7 });
    expect(result.outcome).toMatchObject({ status: "STEP_LIMIT", steps: 7 });
  });

  it("ends in VOID, not HALT, when the program walks off instead of ending", () => {
    const result = run(column("값은 1이다.", "값을 말한다."));
    expect(result.output).toEqual(["1"]);
    expect(result.outcome).toMatchObject({ status: "VOID", steps: 2, at: { x: 0, y: 2, z: 0 } });
  });
});

describe("layering", () => {
  // The machine stays purely spatial: Korean and values never reach it.
  it("keeps the spatial machine free of language and value semantics", () => {
    const dir = join(__dirname, "..", "..", "src", "runtime");
    for (const file of ["machine.ts", "movement.ts", "instructions.ts", "outcomes.ts", "trace.ts", "assembly.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const path of imports) {
        expect(path.startsWith("../space/") || path.startsWith("./"), `${file} imports ${path}`).toBe(true);
        expect(path.includes("interpreter"), `${file} imports ${path}`).toBe(false);
      }
    }
    expect(readdirSync(dir)).toContain("interpreter.ts");
  });

  it("keeps the IR, the type checker and the runtime free of the Korean parser (M5)", () => {
    const root = join(__dirname, "..", "..", "src");
    for (const dir of ["ir", "types", "runtime"]) {
      for (const file of readdirSync(join(root, dir))) {
        const source = readFileSync(join(root, dir, file), "utf8");
        const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "");
        for (const path of imports) {
          // Spans and diagnostics are shared; sentences, particles and tense are not.
          expect(/language\/(sentence|korean|document-parser)/.test(path), `${dir}/${file} imports ${path}`).toBe(false);
        }
      }
    }
  });
});
