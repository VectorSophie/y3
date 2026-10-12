import type { Coordinate, Manifest, Pose } from "../space/manifest";
import type { Span } from "../language/ast";
import type { CompiledProgram } from "../ir/program";
import type { Space } from "../space/volume";
import type { BodyId, Edge, Target } from "../compiler/cfg";
import type { MirBlock, MirOp, MirTest } from "../compiler/mir";
import { CALL_ENTRY, createRuntime, Stopped, type ProgramResult, type ProgramTraceEntry, type RunOptions } from "./core";
import { callBuiltin, concrete, matchPattern, ops, RuntimeFault, type Value } from "./evaluate";
import type { Instruction } from "./instructions";
import { stepOutcome } from "./machine";
import { nextPose } from "./movement";
import type { Outcome } from "./outcomes";
import type { ProgramOutcome } from "./program-outcome";

// The bytecode VM. It runs a verified executable (decoded bytecode: blocks of MIR-shaped
// instructions) and never sees Korean or space. Control flow comes from the compiled
// spatial CFG: the VM follows edges, it does not move a pointer. Every semantic action
// is a call into the runtime core or a shared evaluation operation, the same ones the
// HIR interpreter uses, so the VM has no semantics of its own
// (docs/v2-compiler-pipeline.md §5).

// What the debug map says about a CFG node: enough to run it and to report it.
export type NodeInfo = {
  readonly body: BodyId;
  readonly pose: Pose;
  readonly sentence: string | null; // null for a blank cell
  readonly plane: string | null;
  readonly span: Span | null;
};

export type Executable = {
  readonly blocks: readonly MirBlock[];
  readonly nodeBlock: ReadonlyMap<number, number>;
  readonly nodes: readonly NodeInfo[];
  readonly entries: ReadonlyMap<BodyId, Target>;
  readonly registers: number;
  readonly start: Coordinate; // where the run starts, for a start in VOID
};

// The trace's call and return instructions name a space for the machine; the VM has none.
const NO_SPACE: Space = { manifest: null, layers: [] };
const NOP: Instruction = { op: "nop" };

export class VmError extends Error {} // an executable that breaks the VM's invariants


export function runExecutable(exe: Executable, program: CompiledProgram, manifest: Manifest, options: RunOptions = {}): ProgramResult {
  const rt = createRuntime(program, options);
  const env = rt.env;
  const maxSteps = options.maxSteps ?? manifest.maxSteps;
  const trace: ProgramTraceEntry[] = [];
  const continuations: Target[] = [];
  let steps = 0;
  let machine: Outcome | null = null;
  let regs: (Value | undefined)[] = [];

  const read = (r: number): Value => {
    const v = regs[r];
    if (v === undefined) throw new VmError(`register r${r} is read before it is written`);
    return v;
  };
  const concreteOf = (r: number) => {
    const v = read(r);
    if (v.kind !== "concrete") throw new VmError(`register r${r} must hold a concrete value here`);
    return v.value;
  };
  const write = (r: number, v: Value) => {
    if (r < 0 || r >= regs.length) throw new VmError(`register r${r} does not exist`);
    regs[r] = v;
  };

  const op = (o: MirOp): void => {
    switch (o.op) {
      case "const":
        return write(o.dst, concrete(o.value));
      case "load":
        return write(o.dst, env.load(o.noun));
      case "recorded":
        return write(o.dst, rt.recorded(o.noun));
      case "anchorRead":
        return write(o.dst, env.anchor(o.noun, o.moment));
      case "move":
        return write(o.dst, read(o.src));
      case "arith":
        return write(o.dst, env.arithmetic(o.arith, o.type, read(o.a), read(o.b)));
      case "now":
        return write(o.dst, concrete(env.now(read(o.src), o.purpose)));
      case "not":
        return write(o.dst, concrete(ops.not(concreteOf(o.a))));
      case "eq":
        return write(o.dst, concrete(ops.eq(concreteOf(o.a), concreteOf(o.b))));
      case "order":
        return write(o.dst, concrete(ops.order(o.order, concreteOf(o.a), concreteOf(o.b))));
      case "builtin":
        return write(o.dst, callBuiltin(env, o.callee, o.args.map(read), o.types));
      case "construct":
        return write(o.dst, concrete(ops.construct(o.type, o.variant, o.fields.map(concreteOf))));
      case "field":
        return write(o.dst, concrete(ops.field(concreteOf(o.record), o.index, o.name)));
      case "checkField":
        return ops.checkField(concreteOf(o.record), o.index, o.name);
      case "setField":
        return write(o.dst, concrete(ops.setField(concreteOf(o.record), o.index, concreteOf(o.value))));
      case "array":
        return write(o.dst, concrete(ops.array(o.elements.map(concreteOf))));
      case "index":
        return write(o.dst, concrete(ops.index(concreteOf(o.base), concreteOf(o.index))));
      case "checkWritable":
        return ops.checkWritable(concreteOf(o.base));
      case "writePosition":
        return write(o.dst, concrete(ops.writePosition(concreteOf(o.base), concreteOf(o.index))));
      case "setIndex":
        return write(o.dst, concrete(ops.setIndex(concreteOf(o.base), concreteOf(o.at), concreteOf(o.value))));
      case "sliceBound":
        return write(o.dst, concrete(ops.sliceBound(concreteOf(o.base), concreteOf(o.bound))));
      case "slice":
        return write(o.dst, concrete(ops.slice(concreteOf(o.base), concreteOf(o.from), concreteOf(o.to))));
      case "length":
        return write(o.dst, concrete(ops.length(concreteOf(o.base))));
      case "test": {
        const bound = matchPattern(o.pattern, concreteOf(o.scrutinee));
        if (bound) for (const b of o.binds) write(b.reg, concrete(bound.get(b.local) as never));
        return write(o.dst, concrete({ kind: "bool", value: bound !== null }));
      }
      case "assign":
        return rt.assign(o.noun, read(o.src));
      case "declare":
        return rt.declare(o.noun);
      case "receive":
        return rt.receive(o.noun);
      case "send":
        return rt.send(o.noun);
      case "pastLeft":
        return write(o.dst, rt.pastLeft(o.noun, o.moment));
      case "past":
        return rt.past(read(o.left), read(o.right), o.moment);
      case "promise":
        return rt.promise(o.noun, read(o.src));
      case "fixedPoint":
        return rt.fixedPoint();
      case "anchor":
        return rt.anchor(o.pose);
      case "leave":
        return rt.leaveInnermost();
      case "end":
        return rt.end();
    }
  };

  const test = (t: MirTest): boolean =>
    t.kind === "eq" ? rt.testEquality(read(t.a), read(t.b), t.negated) : t.kind === "order" ? rt.testOrder(t.order, read(t.a), read(t.b)) : rt.testBool(read(t.a));

  const block = (id: number): MirBlock => {
    const b = exe.blocks[id];
    if (!b) throw new VmError(`block b${id} does not exist`);
    return b;
  };

  // Runs one step: the node's blocks, until a terminator leaves the node.
  const runStep = (node: NodeInfo, first: number): { instruction: Instruction; next: Pose; target: Target } => {
    const edge = (e: Edge) => ({ instruction: e.instruction as Instruction, next: e.next as Pose, target: e.target });
    let b = block(first);
    for (;;) {
      for (const o of b.ops) op(o);
      const t = b.terminator;
      switch (t.kind) {
        case "edge":
          return edge(t.edge);
        case "back": {
          const anchor = rt.backEdge(); // FAULT here when no loop is open
          if (!t.edge || JSON.stringify(anchor) !== JSON.stringify(t.edge.next)) throw new VmError("the runtime's open loop disagrees with the CFG");
          return edge(t.edge);
        }
        case "call": {
          if (t.edge.target.kind !== "call") throw new VmError("a call edge must lead to a call");
          const procedure = program.procedures.get(t.plane);
          if (!procedure) throw new VmError(`no callable plane ${t.plane}`);
          const label = rt.callEnter(procedure, t.args.map(read), node.pose, t.results);
          continuations.push(t.edge.target.continuation);
          return { instruction: { op: "call", space: NO_SPACE, to: CALL_ENTRY, label }, next: CALL_ENTRY, target: t.edge.target.entry };
        }
        case "return": {
          const { returnTo, caller } = rt.callReturn(t.values.map(read));
          const next = nextPose(returnTo, NOP);
          const target = continuations.pop();
          if (!target) throw new VmError("a return with no call to return to");
          if (target.kind === "node" && JSON.stringify(exe.nodes[target.node]?.pose) !== JSON.stringify(next)) throw new VmError("the frame's return pose disagrees with the CFG");
          return { instruction: { op: "return", space: NO_SPACE, to: next, label: caller.label }, next, target };
        }
        case "test":
          b = block(test(t.test) ? t.then : t.otherwise);
          break;
        case "if": {
          const v = concreteOf(t.cond);
          b = block(v.kind === "bool" && v.value ? t.then : t.otherwise);
          break;
        }
        case "goto":
          b = block(t.block);
          break;
        case "unreachable":
          throw new VmError(t.reason);
      }
    }
  };

  let target = exe.entries.get("main") as Target;
  if (target.kind === "void") machine = { status: "VOID", steps: 0, at: target.at, from: null };
  while (!machine && !rt.stopped()) {
    if (target.kind !== "node") throw new VmError(`execution reached a ${target.kind} target with the run still going`);
    const node = exe.nodes[target.node];
    const first = exe.nodeBlock.get(target.node);
    if (!node || first === undefined) throw new VmError(`node #${target.node} does not exist`);
    const position = node.pose.position;
    rt.beginStep(steps + 1, position, node.sentence ?? "");
    const frame = rt.frame().label;
    regs = new Array<Value | undefined>(exe.registers);
    let taken: { instruction: Instruction; next: Pose; target: Target };
    try {
      taken = runStep(node, first);
    } catch (error) {
      if (error instanceof RuntimeFault) {
        machine = { status: "FAULT", steps, at: position, message: error.message };
        break;
      }
      if (!(error instanceof Stopped)) throw error;
      // Time stopped the run mid-cell: the step ends as if the cell moved forward.
      const next = nextPose(node.pose, NOP);
      taken = { instruction: NOP, next, target: { kind: "void", at: next.position } };
    }
    steps += 1;
    trace.push({ step: steps, at: position, orientation: node.pose.orientation, cell: node.sentence, instruction: taken.instruction, next: taken.next, effects: rt.effects(), frame });
    machine = stepOutcome(steps, maxSteps, position, taken.next, taken.target.kind === "halt", taken.target.kind === "void");
    target = taken.target;
  }
  return rt.finish(machine as ProgramOutcome | null, steps, trace);
}
