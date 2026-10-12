import { describe, expect, it } from "vitest";
import { buildCfg, ALL_ORIENTATIONS, DIRECTION_NAMES, type Cfg, type Edge, type Target, type ProgramResult } from "../../src/v2";
import { compileSource, column, runHir } from "./compile-helpers";
import { fixtures } from "./helpers";

// The spatial CFG must describe exactly the paths the reference interpreter takes.

// Follows an interpreter run through the CFG: every executed step must be a node with the
// same body and full pose, and leave by an edge with the same instruction and next pose.
function follow(cfg: Cfg, result: ProgramResult, bodyOf: (frame: string | null) => string): void {
  let at: Target = cfg.entries.get("main") as Target;
  const continuations: Target[] = [];
  const last = result.trace.length - 1;
  result.trace.forEach((entry, i) => {
    if (at.kind !== "node") throw new Error(`step ${entry.step} ran, but the CFG says ${at.kind}`);
    const node = cfg.nodes[at.node];
    if (!node) throw new Error(`no node #${at.node}`);
    expect({ body: node.body, pose: node.pose }, `step ${entry.step}`).toEqual({ body: bodyOf(entry.frame), pose: { position: entry.at, orientation: entry.orientation } });
    const temporalStop = i === last && ["UNRESOLVED", "PARADOX", "AMBIGUOUS"].includes(result.outcome.status) && result.outcome.status !== "AMBIGUOUS";
    const edges = [node.always, node.then, node.otherwise].filter((e): e is Edge => e !== null);
    const op = entry.instruction.op;
    const taken =
      op === "call"
        ? edges.find((e) => e.kind === "call")
        : op === "return"
          ? edges.find((e) => e.kind === "return")
          : edges.find((e) => JSON.stringify(e.instruction) === JSON.stringify(entry.instruction) && JSON.stringify(e.next) === JSON.stringify(entry.next));
    if (!taken) {
      if (temporalStop) return; // time stopped the run mid-cell
      throw new Error(`step ${entry.step}: no edge of node #${node.id} matches ${JSON.stringify(entry.instruction)} → ${JSON.stringify(entry.next)}`);
    }
    if (taken.target.kind === "call") {
      continuations.push(taken.target.continuation);
      at = taken.target.entry;
    } else if (taken.target.kind === "return") {
      at = continuations.pop() as Target;
      if (at.kind === "node") expect(cfg.nodes[at.node]?.pose, `return at step ${entry.step}`).toEqual(entry.next);
    } else {
      at = taken.target;
    }
  });
  if (result.outcome.status === "VOID" && result.trace.length > 0) expect(at).toEqual({ kind: "void", at: result.outcome.at });
  if (result.outcome.status === "HALT") expect(at.kind).toBe("halt");
}

function check(source: string, path?: string, maxSteps?: number) {
  const c = compileSource(source, path);
  if (!c) throw new Error("expected a program");
  const cfg = buildCfg(c.program, c.manifest.start);
  const result = runHir(c, maxSteps);
  const names = new Map([...c.program.procedures].map(([id, p]) => [p.name, id]));
  follow(cfg, result, (frame) => (frame === null ? "main" : (names.get(frame.replace(/#\d+$/, "")) as string)));
  return { cfg, result };
}

describe("the spatial CFG follows the interpreter", () => {
  for (const { path, source } of fixtures()) {
    it(path, () => {
      const c = compileSource(source, path);
      if (!c || c.program.space.layers.length === 0) return; // rejected fixtures and libraries
      check(source, path);
    });
  }

  it("turns before moving, pitches and rolls: full 3D orientation", () => {
    // From every orientation, a cube of cells that turns up then right then steps.
    for (const o of ALL_ORIENTATIONS) {
      const plane = (c: string) => `⟦\n[끝이다.] [끝이다.] [끝이다.]\n[끝이다.] [${c}] [끝이다.]\n[끝이다.] [끝이다.] [끝이다.]\n⟧`;
      const source = `+++\n[start]\nplane = 1\ncell = [1, 1]\nfacing = "${DIRECTION_NAMES[o.forward]}"\nup = "${DIRECTION_NAMES[o.up]}"\n+++\n\n${plane("끝이다.")}\n\n${plane("위를 본다.")}\n\n${plane("끝이다.")}\n`;
      const { cfg } = check(source);
      const entry = cfg.nodes[0];
      expect(entry?.pose.orientation).toEqual(o);
    }
  });

  it("floor moves, loops, conditional back-edges, VOID just past the last cell", () => {
    check(column(["값은 3이다.", "여기가 처음이다.", "값에서 1을 뺀다.", "값이 0이 아니면 끝은 처음이다.", "위층으로 간다."]) + "\n    ⟦\n    [ ]\n    [ ]\n    [ ]\n    [ ]\n    [끝이다.]\n    ⟧\n");
    const { result } = check(column(["값은 1이다.", "값을 말한다."]));
    expect(result.outcome.status).toBe("VOID");
    const { result: r2 } = check(column(["x는 3이다.", "x가 3이면 동쪽을 본다.", "끝이다."]));
    expect(r2.outcome).toMatchObject({ status: "VOID", at: { x: 1, y: 1, z: 0 } });
  });

  it("calls and recursive returns, through a turning callee", () => {
    const appendix = ":돈다: (수: i64) → i64 ⟦\n[수가 0이면 0을 돌려준다.] [ ]\n[왼쪽을 본다.] [오른쪽을 본다.]\n[ ] [작은것은 수이다.]\n[ ] [작은것에서 1을 뺀다.]\n[ ] [r은 돈다: 작은것]\n[ ] [r에 1을 더한다.]\n[ ] [r을 돌려준다.]\n⟧\n";
    const { result } = check(column(["결과는 돈다: 3", "결과를 말한다.", "끝이다."], appendix));
    expect(result.output).toEqual(["3"]);
  });

  it("anchors nest; reaching an outer anchor closes inner loops", () => {
    const { cfg } = check(column(["i는 0이다.", "여기가 처음이다.", "j는 0이다.", "여기가 처음이다.", "j에 1을 더한다.", "j가 2보다 작으면 끝은 처음이다.", "i에 1을 더한다.", "i가 3보다 작으면 끝은 처음이다.", "끝이다."]));
    expect(Math.max(...cfg.nodes.map((n) => n.anchors.length))).toBe(2);
  });

  it("stops at the step limit on a path the CFG knows", () => {
    const { result } = check(column(["여기가 처음이다.", "끝은 처음이다."]), undefined, 25);
    expect(result.outcome.status).toBe("STEP_LIMIT");
  });

  it("keeps blank cells and unused values as nodes: cell existence is semantic", () => {
    const { cfg } = check(column(["x는 1이다.", " ", "y는 2이다.", "끝이다."]));
    expect(cfg.nodes.map((n) => n.stmt?.node ?? "blank")).toEqual(["StoreNoun", "blank", "StoreNoun", "End"]);
  });

  it("marks a back-edge with no open loop as a FAULT node", () => {
    const { cfg, result } = check(column(["끝은 처음이다."]));
    expect(cfg.nodes[0]?.always).toBeNull();
    expect(result.outcome.status).toBe("FAULT");
  });
});
