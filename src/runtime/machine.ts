import type { Manifest, Pose } from "../space/manifest";
import { lookup, type Space } from "../space/volume";
import { isDecodeError, type Decoder, type Instruction } from "./instructions";
import { nextPose } from "./movement";
import type { Outcome } from "./outcomes";
import type { TraceEntry } from "./trace";

// The spatial machine (M1). Deterministic: the same space, manifest and decoder always
// produce the same steps and the same outcome. State is immutable; step() returns a
// new state.

export type MachineState = {
  readonly space: Space; // the space the pointer is in: the volume, or a callable plane's
  readonly pose: Pose;
  readonly steps: number;
  readonly maxSteps: number;
  readonly outcome: Outcome | null; // null while running
};

export type StepResult = { readonly state: MachineState; readonly entry: TraceEntry | null };

export function createMachine(space: Space, manifest: Manifest, options: { maxSteps?: number } = {}): MachineState {
  const maxSteps = options.maxSteps ?? manifest.maxSteps;
  const pose = manifest.start;
  const { x, y, z } = pose.position;
  const start = lookup(space, x, y, z);
  return {
    space,
    pose,
    steps: 0,
    maxSteps,
    outcome: start.kind === "void" ? { status: "VOID", steps: 0, at: pose.position, from: null } : null,
  };
}

export function step(state: MachineState, decode: Decoder): StepResult {
  if (state.outcome) {
    return { state, entry: null };
  }
  const { space } = state;
  const { position } = state.pose;
  const here = lookup(space, position.x, position.y, position.z);
  if (here.kind === "void") {
    // Unreachable through step(): a move into VOID ends the run in the same step.
    return { state: { ...state, outcome: { status: "VOID", steps: state.steps, at: position, from: null } }, entry: null };
  }

  const sentence = here.cell.sentence;
  let instruction: Instruction = { op: "nop" };
  if (sentence !== null) {
    const decoded = decode(sentence, state.pose);
    if (isDecodeError(decoded)) {
      return {
        state: { ...state, outcome: { status: "FAULT", steps: state.steps, at: position, message: decoded.error } },
        entry: null,
      };
    }
    instruction = decoded;
  }

  const steps = state.steps + 1;
  const isEnd = instruction.op === "end";
  const next = nextPose(state.pose, instruction);
  const entry: TraceEntry = {
    step: steps,
    at: position,
    orientation: state.pose.orientation,
    cell: sentence,
    instruction,
    next,
  };

  // A call or a return moves the pointer into another space.
  const nextSpace = instruction.op === "call" || instruction.op === "return" ? instruction.space : space;
  const nextIsVoid = lookup(nextSpace, next.position.x, next.position.y, next.position.z).kind === "void";
  const outcome = stepOutcome(steps, state.maxSteps, position, next, isEnd, nextIsVoid);
  return { state: { ...state, space: nextSpace, pose: next, steps, outcome }, entry };
}

// How a completed step ends the run, if it does: the one rule for every engine. An
// end cell halts; otherwise moving into VOID is VOID; otherwise the step limit.
export function stepOutcome(steps: number, maxSteps: number, position: Pose["position"], next: Pose, isEnd: boolean, nextIsVoid: boolean): Outcome | null {
  if (isEnd) return { status: "HALT", steps, at: position };
  if (nextIsVoid) return { status: "VOID", steps, at: next.position, from: position };
  if (steps >= maxSteps) return { status: "STEP_LIMIT", steps, pose: next };
  return null;
}

export type RunResult = { readonly outcome: Outcome; readonly state: MachineState; readonly trace: TraceEntry[] };

export function run(
  space: Space,
  manifest: Manifest,
  decode: Decoder,
  options: { maxSteps?: number; trace?: boolean } = {},
): RunResult {
  let state = createMachine(space, manifest, options);
  const trace: TraceEntry[] = [];
  while (!state.outcome) {
    const result = step(state, decode);
    state = result.state;
    if (result.entry && options.trace !== false) {
      trace.push(result.entry);
    }
  }
  return { outcome: state.outcome, state, trace };
}
