import type { Coordinate, Manifest, Pose } from "../space/manifest";
import type { CellIds } from "../ir/identity";
import { lookup, type Space } from "../space/volume";
import type { Expr, Stmt } from "../ir/hir";
import { coordinateKey, type CompiledProgram } from "../ir/program";
import { createRuntime, CALL_ENTRY, Stopped, type ProgramResult, type ProgramTraceEntry, type RunOptions } from "./core";
import { evaluate, RuntimeFault } from "./evaluate";
import type { DecodeResult, Instruction } from "./instructions";
import { createMachine, step } from "./machine";
import { nextPose } from "./movement";
import type { ProgramOutcome } from "./program-outcome";

export * from "./core";

// The HIR interpreter: the reference engine. It finds control flow the way the language
// defines it, by moving a pointer through space (runtime/machine), and evaluates HIR
// expression trees (runtime/evaluate). Everything that executing a statement does is a
// runtime-core service (runtime/core), shared with the bytecode VM.

const forward: Instruction = { op: "nop" };

export function runProgram(program: CompiledProgram, manifest: Manifest, options: RunOptions = {}): ProgramResult {
  const rt = createRuntime(program, options);
  const env = rt.env;

  const condition = (e: Expr): boolean => {
    if (e.node === "Eq") return rt.testEquality(evaluate(e.left, env), evaluate(e.right, env), false);
    if (e.node === "Not" && e.operand.node === "Eq") return rt.testEquality(evaluate(e.operand.left, env), evaluate(e.operand.right, env), true);
    if (e.node === "Compare") return rt.testOrder(e.op, evaluate(e.left, env), evaluate(e.right, env));
    return rt.testBool(evaluate(e, env));
  };

  const execute = (stmt: Stmt, pose: Pose): Instruction => {
    switch (stmt.node) {
      case "StoreNoun":
        rt.assign(stmt.noun, evaluate(stmt.value, env));
        return forward;
      case "Eval":
        evaluate(stmt.expr, env);
        return forward;
      case "TemporalDeclare":
        rt.declare(stmt.noun);
        return forward;
      case "TemporalReceive":
        rt.receive(stmt.noun);
        return forward;
      case "TemporalSend":
        rt.send(stmt.noun);
        return forward;
      case "TemporalAssert": {
        const left = rt.pastLeft(stmt.noun, stmt.moment);
        // A noun on the right keeps its symbolic identity, so the constraint says what it is about.
        const right = stmt.value.node === "LoadNoun" ? rt.recorded(stmt.value.noun) : evaluate(stmt.value, env);
        rt.past(left, right, stmt.moment);
        return forward;
      }
      case "TemporalPromise":
        rt.promise(stmt.noun, evaluate(stmt.value, env));
        return forward;
      case "TemporalFixedPoint":
        rt.fixedPoint();
        return forward;
      case "Move":
        return { op: "step", relative: stmt.relative };
      case "Turn":
        return stmt.turn ? { op: "turn", turn: stmt.turn } : { op: "face", compass: stmt.compass as NonNullable<typeof stmt.compass> };
      case "FloorMove":
        return { op: "floor", delta: stmt.delta };
      case "Anchor":
        rt.anchor(pose);
        return forward;
      case "BackEdge":
        return { op: "jump", to: rt.backEdge() };
      case "CallPlane": {
        const procedure = program.procedures.get(stmt.plane);
        if (!procedure) throw new Error(`no callable plane ${stmt.plane}; the compiler should have caught this`);
        // Arguments are evaluated in the caller, and may be symbolic: a call passes a
        // value through, it does not need it now.
        const label = rt.callEnter(procedure, stmt.args.map((arg) => evaluate(arg, env)), pose, stmt.results);
        return { op: "call", space: procedure.space, to: CALL_ENTRY, label };
      }
      case "Return": {
        const { returnTo, caller } = rt.callReturn(stmt.values.map((v) => evaluate(v, env)));
        // Back to the call cell's pose, orientation and all, then on as from any cell.
        return { op: "return", space: caller.body.space, to: nextPose(returnTo, forward), label: caller.label };
      }
      case "End":
        rt.end();
        return { op: "end" };
      case "Branch": {
        if (condition(stmt.condition)) return execute(stmt.then, pose);
        if (stmt.then.node === "BackEdge") rt.leaveInnermost();
        return forward;
      }
    }
  };

  const decode = (_text: string, pose: Pose): DecodeResult => {
    const stmt = rt.frame().body.cells.get(coordinateKey(pose.position));
    if (!stmt) return { error: "this cell was not compiled" };
    try {
      return execute(stmt, pose);
    } catch (error) {
      if (error instanceof RuntimeFault) return { error: error.message };
      if (error instanceof Stopped) return forward;
      throw error;
    }
  };

  let state = createMachine(program.space, manifest, options);
  const trace: ProgramTraceEntry[] = [];
  while (!state.outcome && !rt.stopped()) {
    const position = state.pose.position;
    rt.beginStep(state.steps + 1, position, rt.frame().body.cells.get(coordinateKey(position))?.at.source ?? "");
    const frame = rt.frame().label;
    const space = rt.frame().body.space;
    // The machine's space and the innermost frame's body move together (call, return).
    if (state.space !== rt.frame().body.space) throw new Error("the machine and the frame stack disagree about the current space");
    const result = step(state, decode);
    state = result.state;
    const ids = lookupIds(space, position);
    if (result.entry) trace.push({ ...result.entry, effects: rt.effects(), frame, ...(ids ? { ids } : {}) });
  }
  return rt.finish(state.outcome as ProgramOutcome | null, state.steps, trace);
}

// The ids of the cell at a position, if the program carries identities.
function lookupIds(space: Space, at: Coordinate): CellIds | undefined {
  const found = lookup(space, at.x, at.y, at.z);
  return found.kind === "cell" ? found.cell.ids : undefined;
}
