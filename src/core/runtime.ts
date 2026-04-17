import { Y3RuntimeError } from "./errors";
import { keyFromPosition } from "./parser";
import type { MachineState, Program, StepTrace } from "./types";

function popOrThrow(stack: number[]): number {
  const value = stack.pop();
  if (typeof value !== "number") {
    throw new Y3RuntimeError("stack underflow");
  }
  return value;
}

function isOutsideBounds(program: Program, x: number, y: number, z: number): boolean {
  const { minX, maxX, minY, maxY, minZ, maxZ } = program.bounds;
  return x < minX || x > maxX || y < minY || y > maxY || z < minZ || z > maxZ;
}

export function createInitialState(): MachineState {
  return {
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 1,
    dz: 0,
    stack: [],
    output: "",
    stepCount: 0,
    halted: false,
    lastConditionWasTrue: null,
  };
}

export function step(program: Program, state: MachineState): { state: MachineState; trace: StepTrace | null } {
  if (state.halted) {
    return { state, trace: null };
  }

  if (isOutsideBounds(program, state.x, state.y, state.z)) {
    return { state: { ...state, halted: true }, trace: null };
  }

  const cell = program.cells.get(keyFromPosition(state.x, state.y, state.z));
  if (!cell) {
    return { state: { ...state, halted: true }, trace: null };
  }

  const nextState: MachineState = {
    ...state,
    stack: [...state.stack],
  };

  const clearConditionFlag = () => {
    nextState.lastConditionWasTrue = null;
  };

  switch (cell.instruction.type) {
    case "PUSH": {
      nextState.stack.push(cell.instruction.value);
      clearConditionFlag();
      break;
    }
    case "ADD": {
      const a = popOrThrow(nextState.stack);
      const b = popOrThrow(nextState.stack);
      nextState.stack.push(b + a);
      clearConditionFlag();
      break;
    }
    case "SUB": {
      const a = popOrThrow(nextState.stack);
      const b = popOrThrow(nextState.stack);
      nextState.stack.push(b - a);
      clearConditionFlag();
      break;
    }
    case "POP": {
      popOrThrow(nextState.stack);
      clearConditionFlag();
      break;
    }
    case "COND": {
      const value = popOrThrow(nextState.stack);
      if (value !== 0) {
        nextState.dx = cell.instruction.direction.dx;
        nextState.dy = cell.instruction.direction.dy;
        nextState.dz = cell.instruction.direction.dz;
        nextState.lastConditionWasTrue = true;
      } else {
        nextState.lastConditionWasTrue = false;
      }
      break;
    }
    case "ELSE": {
      if (nextState.lastConditionWasTrue === false) {
        nextState.dx = cell.instruction.direction.dx;
        nextState.dy = cell.instruction.direction.dy;
        nextState.dz = cell.instruction.direction.dz;
      }
      clearConditionFlag();
      break;
    }
    case "OUTPUT_CHAR": {
      nextState.output += cell.instruction.value;
      clearConditionFlag();
      break;
    }
    case "OUTPUT_STACK": {
      const value = popOrThrow(nextState.stack);
      nextState.output += String(value);
      clearConditionFlag();
      break;
    }
    case "NOOP": {
      clearConditionFlag();
      break;
    }
    default: {
      const neverType: never = cell.instruction;
      throw new Y3RuntimeError(`unsupported instruction: ${JSON.stringify(neverType)}`);
    }
  }

  const trace: StepTrace = {
    step: nextState.stepCount + 1,
    pos: { x: nextState.x, y: nextState.y, z: nextState.z },
    dir: { dx: nextState.dx, dy: nextState.dy, dz: nextState.dz },
    cell: cell.raw,
    stack: [...nextState.stack],
    output: nextState.output,
  };

  nextState.x += nextState.dx;
  nextState.y += nextState.dy;
  nextState.z += nextState.dz;
  nextState.stepCount += 1;

  if (nextState.stepCount >= 10000) {
    nextState.halted = true;
  }

  return { state: nextState, trace };
}

export function runProgram(program: Program, initialState = createInitialState()): MachineState {
  let state = initialState;

  while (!state.halted) {
    const result = step(program, state);
    state = result.state;
  }

  return state;
}

export function runProgramWithTrace(
  program: Program,
  initialState = createInitialState(),
): { finalState: MachineState; trace: StepTrace[] } {
  let state = initialState;
  const trace: StepTrace[] = [];

  while (!state.halted) {
    const result = step(program, state);
    state = result.state;
    if (result.trace) {
      trace.push(result.trace);
    }
  }

  return { finalState: state, trace };
}
