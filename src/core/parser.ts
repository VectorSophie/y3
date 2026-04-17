import { parseDirectionToken, VALID_DIRECTIONS } from "./directions";
import { Y3ParseError } from "./errors";
import type { Cell, Instruction, Program } from "./types";

const LAYER_PATTERN = /^@layer\s+(-?\d+)\s*$/;
const PUSH_PATTERN = /^값은\s+(\d+)이다$/;
const PUSH_ANY_PATTERN = /^값은\s+(.+)이다$/;
const ADD_PATTERN = /^값을\s+더한다$/;
const SUB_PATTERN = /^값을\s+뺀다$/;
const POP_PATTERN = /^값을\s+버린다$/;
const COND_PATTERN = /^조건이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$/;
const COND_ANY_PATTERN = /^조건이면\s+(.+)$/;
const ELSE_PATTERN = /^아니다\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$/;
const ELSE_ANY_PATTERN = /^아니다\s+(.+)$/;
const OUTPUT_CHAR_PATTERN = /^출력은\s+"(.)"이다$/;
const OUTPUT_STACK_PATTERN = /^출력은\s+값이다$/;

function keyFor(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseInstruction(text: string, lineNumber: number): Instruction {
  const pushMatch = text.match(PUSH_PATTERN);
  if (pushMatch) {
    const valueToken = pushMatch.at(1);
    if (!valueToken) {
      throw new Y3ParseError(lineNumber, text, "malformed number in PUSH");
    }
    return { type: "PUSH", value: Number(valueToken) };
  }

  if (PUSH_ANY_PATTERN.test(text)) {
    throw new Y3ParseError(lineNumber, text, "malformed number in PUSH. Expected: 값은 <non-negative integer>이다");
  }

  if (ADD_PATTERN.test(text)) {
    return { type: "ADD" };
  }

  if (SUB_PATTERN.test(text)) {
    return { type: "SUB" };
  }

  if (POP_PATTERN.test(text)) {
    return { type: "POP" };
  }

  const condMatch = text.match(COND_PATTERN);
  if (condMatch) {
    const directionToken = condMatch.at(1);
    if (!directionToken) {
      throw new Y3ParseError(lineNumber, text, "invalid direction for CONDITIONAL");
    }

    const direction = parseDirectionToken(directionToken);
    if (!direction) {
      throw new Y3ParseError(lineNumber, text, "invalid direction for CONDITIONAL");
    }
    return { type: "COND", direction };
  }

  const condAnyMatch = text.match(COND_ANY_PATTERN);
  if (condAnyMatch) {
    throw new Y3ParseError(
      lineNumber,
      text,
      `invalid direction '${condAnyMatch[1]}'. Expected one of: ${VALID_DIRECTIONS.join(", ")}`,
    );
  }

  const elseMatch = text.match(ELSE_PATTERN);
  if (elseMatch) {
    const directionToken = elseMatch.at(1);
    if (!directionToken) {
      throw new Y3ParseError(lineNumber, text, "invalid direction for ELSE");
    }

    const direction = parseDirectionToken(directionToken);
    if (!direction) {
      throw new Y3ParseError(lineNumber, text, "invalid direction for ELSE");
    }
    return { type: "ELSE", direction };
  }

  const elseAnyMatch = text.match(ELSE_ANY_PATTERN);
  if (elseAnyMatch) {
    throw new Y3ParseError(
      lineNumber,
      text,
      `invalid direction '${elseAnyMatch[1]}'. Expected one of: ${VALID_DIRECTIONS.join(", ")}`,
    );
  }

  const outputCharMatch = text.match(OUTPUT_CHAR_PATTERN);
  if (outputCharMatch) {
    const charValue = outputCharMatch.at(1);
    if (!charValue) {
      throw new Y3ParseError(lineNumber, text, "malformed OUTPUT_CHAR value");
    }
    return { type: "OUTPUT_CHAR", value: charValue };
  }

  if (OUTPUT_STACK_PATTERN.test(text)) {
    return { type: "OUTPUT_STACK" };
  }

  throw new Y3ParseError(lineNumber, text, "unknown sentence for v0 grammar");
}

export function parseProgram(source: string): Program {
  const lines = source.split(/\r?\n/);
  const cells = new Map<string, Cell>();

  let currentLayer: number | null = null;
  const rowIndexByLayer = new Map<number, number>();
  const lastInstructionByLayer = new Map<number, Instruction>();

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = index + 1;
    const rawLine = lines[index] ?? "";
    const text = rawLine.trim();

    if (text.length === 0) {
      continue;
    }

    if (text.startsWith("@layer")) {
      const layerMatch = text.match(LAYER_PATTERN);
      if (!layerMatch) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid layer format. Expected: @layer <integer>");
      }

      currentLayer = Number(layerMatch[1]);
      if (!rowIndexByLayer.has(currentLayer)) {
        rowIndexByLayer.set(currentLayer, 0);
      }
      lastInstructionByLayer.delete(currentLayer);
      continue;
    }

    if (currentLayer === null) {
      throw new Y3ParseError(sourceLine, rawLine, "instruction before first @layer declaration");
    }

    const instruction = parseInstruction(text, sourceLine);
    const y = rowIndexByLayer.get(currentLayer) ?? 0;

    if (instruction.type === "ELSE") {
      const previous = lastInstructionByLayer.get(currentLayer);
      if (!previous || previous.type !== "COND") {
        throw new Y3ParseError(sourceLine, rawLine, "misplaced 아니다. It must immediately follow 조건이면 in same layer");
      }
    }

    const cell: Cell = {
      x: 0,
      y,
      z: currentLayer,
      instruction,
      raw: text,
      sourceLine,
    };

    const key = keyFor(cell.x, cell.y, cell.z);
    if (cells.has(key)) {
      throw new Y3ParseError(sourceLine, rawLine, `duplicate cell coordinate detected at ${key}`);
    }

    cells.set(key, cell);
    rowIndexByLayer.set(currentLayer, y + 1);
    lastInstructionByLayer.set(currentLayer, instruction);
  }

  if (cells.size === 0) {
    return {
      cells,
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
    };
  }

  const positions = [...cells.values()];
  const xs = positions.map((cell) => cell.x);
  const ys = positions.map((cell) => cell.y);
  const zs = positions.map((cell) => cell.z);

  return {
    cells,
    bounds: {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    },
  };
}

export function keyFromPosition(x: number, y: number, z: number): string {
  return keyFor(x, y, z);
}
