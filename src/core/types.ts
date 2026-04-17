export type Vec3 = { dx: number; dy: number; dz: number };

export type Instruction =
  | { type: "PUSH"; value: number }
  | { type: "ADD" }
  | { type: "SUB" }
  | { type: "POP" }
  | { type: "COND"; direction: Vec3 }
  | { type: "ELSE"; direction: Vec3 }
  | { type: "OUTPUT_CHAR"; value: string }
  | { type: "OUTPUT_STACK" }
  | { type: "NOOP" };

export type Cell = {
  x: number;
  y: number;
  z: number;
  instruction: Instruction;
  raw: string;
  sourceLine: number;
};

export type Program = {
  cells: Map<string, Cell>;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
};

export type MachineState = {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  stack: number[];
  output: string;
  stepCount: number;
  halted: boolean;
  lastConditionWasTrue: boolean | null;
};

export type StepTrace = {
  step: number;
  pos: { x: number; y: number; z: number };
  dir: Vec3;
  cell: string;
  stack: number[];
  output: string;
};
