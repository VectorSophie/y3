import type { PlaneId, Stmt } from "../ir/hir";
import { coordinateKey, type Body, type CompiledProgram } from "../ir/program";
import type { Coordinate, Pose } from "../space/manifest";
import { lookup } from "../space/volume";
import { CALL_ENTRY } from "../runtime/core";
import type { Instruction } from "../runtime/instructions";
import { nextPose } from "../runtime/movement";

// The spatial CFG: where execution can go, compiled ahead of time
// (docs/v2-compiler-pipeline.md §2).
//
// A node is a cell executed in a state: the body, the full pose (position, forward, up)
// and the stack of open anchors. The same cell can be several nodes. Edges follow from
// the cell's statement and that state, by the same movement rules the machine uses
// (runtime/movement). Cell existence is semantic: a blank cell is a node, and nothing
// here removes a node because its value is unused.

export type BodyId = "main" | PlaneId;

// Where an edge leads.
export type Target =
  | { readonly kind: "node"; readonly node: number }
  | { readonly kind: "void"; readonly at: Coordinate } // no cell there: the run ends VOID
  | { readonly kind: "halt" } // 끝이다
  | { readonly kind: "return" } // to whatever call this activation came from
  | { readonly kind: "call"; readonly plane: PlaneId; readonly entry: Target; readonly continuation: Target };

export type EdgeKind = "forward" | "turn" | "face" | "step" | "floor" | "back" | "call" | "return" | "end";

// One way out of a node. `instruction` and `next` are what the step reports in a trace:
// the machine instruction the cell amounted to, and the pose the pointer ends in (for a
// call, the callee's entry; for a return, decided by the frame at run time).
export type Edge = { readonly kind: EdgeKind; readonly instruction: Instruction | null; readonly next: Pose | null; readonly target: Target };

export type CfgNode = {
  readonly id: number;
  readonly body: BodyId;
  readonly pose: Pose;
  readonly anchors: readonly Pose[]; // open anchors, innermost last
  readonly stmt: Stmt | null; // null: a blank cell
  // A straight-line cell has `always`; a branch has `then` and `otherwise`. A node with
  // neither (a back-edge with no open anchor) can only FAULT.
  readonly always: Edge | null;
  readonly then: Edge | null;
  readonly otherwise: Edge | null;
};

export type Cfg = {
  readonly nodes: readonly CfgNode[];
  readonly entries: ReadonlyMap<BodyId, Target>; // where each body starts
};

export class CfgError extends Error {}

const MAX_NODES = 200_000;
const NOP: Instruction = { op: "nop" };

function poseKey(p: Pose): string {
  return `${p.position.x},${p.position.y},${p.position.z}:${p.orientation.forward}/${p.orientation.up}`;
}

const samePosition = (a: Coordinate, b: Coordinate) => a.x === b.x && a.y === b.y && a.z === b.z;

export function buildCfg(program: CompiledProgram, start: Pose): Cfg {
  const nodes: CfgNode[] = [];
  const index = new Map<string, number>();
  const bodies = new Map<BodyId, Body>([["main", program], ...[...program.procedures].map(([id, p]) => [id, p] as [BodyId, Body])]);
  const pending: { id: number; body: BodyId; pose: Pose; anchors: readonly Pose[] }[] = [];
  let count = 0;

  // The node for a state, created on first sight; or VOID when no cell is there.
  const target = (body: BodyId, pose: Pose, anchors: readonly Pose[]): Target => {
    const space = (bodies.get(body) as Body).space;
    const { x, y, z } = pose.position;
    if (lookup(space, x, y, z).kind === "void") return { kind: "void", at: pose.position };
    const key = `${body}|${poseKey(pose)}|${anchors.map(poseKey).join(";")}`;
    let id = index.get(key);
    if (id === undefined) {
      id = count;
      count += 1;
      if (id >= MAX_NODES) throw new CfgError(`the spatial CFG would exceed ${MAX_NODES} nodes`);
      index.set(key, id);
      pending.push({ id, body, pose, anchors });
    }
    return { kind: "node", node: id };
  };

  // The edge a statement takes when it runs (for a branch: when its condition holds).
  const edge = (body: BodyId, stmt: Stmt | null, pose: Pose, anchors: readonly Pose[]): Edge | null => {
    const move = (kind: EdgeKind, instruction: Instruction, after: readonly Pose[] = anchors): Edge => {
      const next = nextPose(pose, instruction);
      return { kind, instruction, next, target: target(body, next, after) };
    };
    switch (stmt?.node) {
      case "Move":
        return move("step", { op: "step", relative: stmt.relative });
      case "Turn":
        return stmt.turn
          ? move("turn", { op: "turn", turn: stmt.turn })
          : move("face", { op: "face", compass: stmt.compass as NonNullable<typeof stmt.compass> });
      case "FloorMove":
        return move("floor", { op: "floor", delta: stmt.delta });
      case "Anchor": {
        // An anchor already open is reached again (inner loops close); a new one opens.
        const open = anchors.findIndex((a) => samePosition(a.position, pose.position));
        return move("forward", NOP, open >= 0 ? anchors.slice(0, open + 1) : [...anchors, pose]);
      }
      case "BackEdge": {
        const innermost = anchors[anchors.length - 1];
        if (!innermost) return null; // FAULT: no loop to return to
        return { kind: "back", instruction: { op: "jump", to: innermost }, next: innermost, target: target(body, innermost, anchors) };
      }
      case "End":
        return { kind: "end", instruction: { op: "end" }, next: pose, target: { kind: "halt" } };
      case "Return":
        return { kind: "return", instruction: null, next: null, target: { kind: "return" } };
      case "CallPlane": {
        const after = nextPose(pose, NOP);
        return {
          kind: "call",
          instruction: null,
          next: CALL_ENTRY,
          target: { kind: "call", plane: stmt.plane, entry: target(stmt.plane, CALL_ENTRY, []), continuation: target(body, after, anchors) },
        };
      }
      case "Branch":
        return edge(body, stmt.then, pose, anchors);
      default:
        return move("forward", NOP);
    }
  };

  const entries = new Map<BodyId, Target>();
  entries.set("main", program.space.layers.length === 0 ? { kind: "void", at: start.position } : target("main", start, []));
  for (const id of program.procedures.keys()) entries.set(id, target(id, CALL_ENTRY, []));

  while (pending.length > 0) {
    // Nodes are numbered in discovery order; build them in that order too.
    pending.sort((a, b) => a.id - b.id);
    const next = pending.shift() as (typeof pending)[number];
    const body = bodies.get(next.body) as Body;
    const stmt = body.cells.get(coordinateKey(next.pose.position)) ?? null;
    let node: CfgNode;
    if (stmt?.node === "Branch") {
      // Not taken: on along forward; a conditional back-edge that fails leaves the loop.
      const left = stmt.then.node === "BackEdge" ? next.anchors.slice(0, -1) : next.anchors;
      const then = edge(next.body, stmt, next.pose, next.anchors);
      const forwardPose = nextPose(next.pose, NOP);
      const otherwise: Edge = { kind: "forward", instruction: NOP, next: forwardPose, target: target(next.body, forwardPose, left) };
      node = { ...next, stmt, always: null, then, otherwise };
    } else {
      node = { ...next, stmt, always: edge(next.body, stmt, next.pose, next.anchors), then: null, otherwise: null };
    }
    nodes[next.id] = node;
  }
  return { nodes, entries };
}

// A readable listing, for `y3 cfg` and tests.
export function formatCfg(cfg: Cfg): string {
  const pose = (p: Pose) => `(${p.position.x},${p.position.y},${p.position.z}) ${p.orientation.forward}/${p.orientation.up}`;
  const to = (t: Target): string => {
    switch (t.kind) {
      case "node":
        return `#${t.node}`;
      case "void":
        return `VOID (${t.at.x},${t.at.y},${t.at.z})`;
      case "halt":
        return "HALT";
      case "return":
        return "RETURN";
      case "call":
        return `CALL ${t.plane} ${to(t.entry)} then ${to(t.continuation)}`;
    }
  };
  const lines = [...cfg.entries].map(([body, t]) => `entry ${body}: ${to(t)}`);
  for (const n of cfg.nodes) {
    const anchors = n.anchors.length === 0 ? "" : `  anchors [${n.anchors.map((a) => `(${a.position.x},${a.position.y},${a.position.z})`).join(" ")}]`;
    const head = `#${n.id} ${n.body} ${pose(n.pose)}${anchors}  ${n.stmt ? n.stmt.node : "blank"}`;
    const out = n.always
      ? `${n.always.kind} → ${to(n.always.target)}`
      : n.then && n.otherwise
        ? `then ${n.then.kind} → ${to(n.then.target)} | else → ${to(n.otherwise.target)}`
        : "FAULT";
    lines.push(`${head}  ${out}`);
  }
  return `${lines.join("\n")}\n`;
}
