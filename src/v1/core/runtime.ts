import { Y3RuntimeError } from "./errors";
import { keyFromPosition } from "./parser";
import type { MachineState, Program, RunOptions, StepTrace, Vec3 } from "./types";

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

function rotateRight(vector: Vec3): Vec3 {
  return { dx: vector.dy, dy: -vector.dx, dz: vector.dz };
}

function rotateLeft(vector: Vec3): Vec3 {
  return { dx: -vector.dy, dy: vector.dx, dz: vector.dz };
}

function rotateUp(vector: Vec3): Vec3 {
  return { dx: vector.dx, dy: -vector.dz, dz: vector.dy };
}

function rotateDown(vector: Vec3): Vec3 {
  return { dx: vector.dx, dy: vector.dz, dz: -vector.dy };
}

function readMemory(state: MachineState): number {
  return state.memory.get(state.memoryPointer) ?? 0;
}

function writeMemory(state: MachineState, value: number): void {
  if (value === 0) {
    state.memory.delete(state.memoryPointer);
    return;
  }
  state.memory.set(state.memoryPointer, value);
}

export function createInitialState(options?: { input?: number[] }): MachineState {
  return {
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 1,
    dz: 0,
    stack: [],
    input: [...(options?.input ?? [])],
    memory: new Map<number, number>(),
    memoryPointer: 0,
    output: "",
    stepCount: 0,
    halted: false,
    lastConditionWasTrue: null,
  };
}

export function step(
  program: Program,
  state: MachineState,
  options?: RunOptions,
): { state: MachineState; trace: StepTrace | null } {
  const maxSteps = options?.maxSteps ?? 10000;

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
    input: [...state.input],
    memory: new Map(state.memory),
  };

  let shouldAutoMove = true;
  let moveDx = nextState.dx;
  let moveDy = nextState.dy;
  let moveDz = nextState.dz;

  const clearConditionFlag = () => {
    nextState.lastConditionWasTrue = null;
  };

  switch (cell.instruction.type) {
    case "PUSH": {
      nextState.stack.push(cell.instruction.value);
      clearConditionFlag();
      break;
    }
    case "INPUT_STACK": {
      const value = nextState.input.shift();
      nextState.stack.push(typeof value === "number" ? value : 0);
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
        moveDx = nextState.dx;
        moveDy = nextState.dy;
        moveDz = nextState.dz;
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
        moveDx = nextState.dx;
        moveDy = nextState.dy;
        moveDz = nextState.dz;
      }
      clearConditionFlag();
      break;
    }
    case "ROTATE_RIGHT": {
      const rotated = rotateRight({ dx: nextState.dx, dy: nextState.dy, dz: nextState.dz });
      nextState.dx = rotated.dx;
      nextState.dy = rotated.dy;
      nextState.dz = rotated.dz;
      clearConditionFlag();
      break;
    }
    case "ROTATE_LEFT": {
      const rotated = rotateLeft({ dx: nextState.dx, dy: nextState.dy, dz: nextState.dz });
      nextState.dx = rotated.dx;
      nextState.dy = rotated.dy;
      nextState.dz = rotated.dz;
      clearConditionFlag();
      break;
    }
    case "ROTATE_UP": {
      const rotated = rotateUp({ dx: nextState.dx, dy: nextState.dy, dz: nextState.dz });
      nextState.dx = rotated.dx;
      nextState.dy = rotated.dy;
      nextState.dz = rotated.dz;
      clearConditionFlag();
      break;
    }
    case "ROTATE_DOWN": {
      const rotated = rotateDown({ dx: nextState.dx, dy: nextState.dy, dz: nextState.dz });
      nextState.dx = rotated.dx;
      nextState.dy = rotated.dy;
      nextState.dz = rotated.dz;
      clearConditionFlag();
      break;
    }
    case "PORTAL": {
      nextState.x = cell.instruction.target.x;
      nextState.y = cell.instruction.target.y;
      nextState.z = cell.instruction.target.z;
      shouldAutoMove = false;
      clearConditionFlag();
      break;
    }
    case "MEMORY_MOVE_RIGHT": {
      nextState.memoryPointer += 1;
      clearConditionFlag();
      break;
    }
    case "MEMORY_MOVE_LEFT": {
      nextState.memoryPointer -= 1;
      clearConditionFlag();
      break;
    }
    case "MEMORY_INC": {
      const current = readMemory(nextState);
      writeMemory(nextState, current + 1);
      clearConditionFlag();
      break;
    }
    case "MEMORY_DEC": {
      const current = readMemory(nextState);
      const nextValue = current > 0 ? current - 1 : 0;
      writeMemory(nextState, nextValue);
      clearConditionFlag();
      break;
    }
    case "MEMORY_GET": {
      nextState.stack.push(readMemory(nextState));
      clearConditionFlag();
      break;
    }
    case "MEMORY_SET": {
      const value = popOrThrow(nextState.stack);
      writeMemory(nextState, value);
      clearConditionFlag();
      break;
    }
    case "MEMORY_COND_ZERO": {
      const current = readMemory(nextState);
      if (current === 0) {
        nextState.dx = cell.instruction.direction.dx;
        nextState.dy = cell.instruction.direction.dy;
        nextState.dz = cell.instruction.direction.dz;
        moveDx = nextState.dx;
        moveDy = nextState.dy;
        moveDz = nextState.dz;
        nextState.lastConditionWasTrue = true;
      } else {
        nextState.lastConditionWasTrue = false;
      }
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
    memoryPointer: nextState.memoryPointer,
    memoryValue: readMemory(nextState),
    output: nextState.output,
  };

  if (shouldAutoMove) {
    nextState.x += moveDx;
    nextState.y += moveDy;
    nextState.z += moveDz;
  }
  nextState.stepCount += 1;

  if (nextState.stepCount >= maxSteps) {
    nextState.halted = true;
  }

  return { state: nextState, trace };
}

export function runProgram(program: Program, initialState = createInitialState(), options?: RunOptions): MachineState {
  let state = initialState;

  while (!state.halted) {
    const result = step(program, state, options);
    state = result.state;
  }

  return state;
}

export function runProgramWithTrace(
  program: Program,
  initialState = createInitialState(),
  options?: RunOptions,
): { finalState: MachineState; trace: StepTrace[] } {
  let state = initialState;
  const trace: StepTrace[] = [];

  while (!state.halted) {
    const result = step(program, state, options);
    state = result.state;
    if (result.trace) {
      trace.push(result.trace);
    }
  }

  return { finalState: state, trace };
}
