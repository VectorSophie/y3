import { parseDirectionToken, VALID_DIRECTIONS } from "./directions";
import { Y3ParseError } from "./errors";
import type { Cell, Instruction, Program } from "./types";

const LAYER_PATTERN = /^@layer\s+(-?\d+)(?:\s+\[([A-Za-z0-9_-]+)\])?\s*$/;
const MACRO_PATTERN = /^@macro\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/;
const USE_MACRO_PATTERN = /^@use\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;

const PUSH_PATTERN = /^값은\s+(\d+)이다$/;
const PUSH_ANY_PATTERN = /^값은\s+(.+)이다$/;
const INPUT_PATTERN = /^입력은\s+값이다$/;
const ADD_PATTERN = /^값을\s+더한다$/;
const SUB_PATTERN = /^값을\s+뺀다$/;
const POP_PATTERN = /^값을\s+버린다$/;

const COND_PATTERN = /^조건이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$/;
const COND_ANY_PATTERN = /^조건이면\s+(.+)$/;
const ELSE_PATTERN = /^아니다\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$/;
const ELSE_ANY_PATTERN = /^아니다\s+(.+)$/;

const ROTATE_RIGHT_PATTERN = /^방향을\s+오른쪽으로\s+회전한다$/;
const ROTATE_LEFT_PATTERN = /^방향을\s+왼쪽으로\s+회전한다$/;
const ROTATE_UP_PATTERN = /^방향을\s+위로\s+회전한다$/;
const ROTATE_DOWN_PATTERN = /^방향을\s+아래로\s+회전한다$/;
const PORTAL_PATTERN = /^이동은\s+\((-?\d+),(-?\d+),(-?\d+)\)로$/;

const MEMORY_MOVE_RIGHT_PATTERN = /^칸을\s+오른쪽으로\s+이동한다$/;
const MEMORY_MOVE_LEFT_PATTERN = /^칸을\s+왼쪽으로\s+이동한다$/;
const MEMORY_INC_PATTERN = /^칸\s+값을\s+하나\s+늘린다$/;
const MEMORY_DEC_PATTERN = /^칸\s+값을\s+하나\s+줄인다$/;
const MEMORY_GET_PATTERN = /^칸\s+값을\s+가져온다$/;
const MEMORY_SET_PATTERN = /^칸\s+값으로\s+넣는다$/;
const MEMORY_COND_ZERO_PATTERN = /^칸\s+값이\s+0이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$/;
const MEMORY_COND_ZERO_ANY_PATTERN = /^칸\s+값이\s+0이면\s+(.+)$/;

const OUTPUT_CHAR_PATTERN = /^출력은\s+"(.)"이다$/;
const OUTPUT_STACK_PATTERN = /^출력은\s+값이다$/;

function keyFor(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseDirectionOrThrow(token: string, lineNumber: number, text: string, context: string) {
  const direction = parseDirectionToken(token);
  if (!direction) {
    throw new Y3ParseError(lineNumber, text, `invalid direction for ${context}`);
  }
  return direction;
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

  if (INPUT_PATTERN.test(text)) {
    return { type: "INPUT_STACK" };
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
    return { type: "COND", direction: parseDirectionOrThrow(directionToken, lineNumber, text, "CONDITIONAL") };
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
    return { type: "ELSE", direction: parseDirectionOrThrow(directionToken, lineNumber, text, "ELSE") };
  }

  const elseAnyMatch = text.match(ELSE_ANY_PATTERN);
  if (elseAnyMatch) {
    throw new Y3ParseError(
      lineNumber,
      text,
      `invalid direction '${elseAnyMatch[1]}'. Expected one of: ${VALID_DIRECTIONS.join(", ")}`,
    );
  }

  if (ROTATE_RIGHT_PATTERN.test(text)) {
    return { type: "ROTATE_RIGHT" };
  }
  if (ROTATE_LEFT_PATTERN.test(text)) {
    return { type: "ROTATE_LEFT" };
  }
  if (ROTATE_UP_PATTERN.test(text)) {
    return { type: "ROTATE_UP" };
  }
  if (ROTATE_DOWN_PATTERN.test(text)) {
    return { type: "ROTATE_DOWN" };
  }

  const portalMatch = text.match(PORTAL_PATTERN);
  if (portalMatch) {
    const x = Number(portalMatch.at(1));
    const y = Number(portalMatch.at(2));
    const z = Number(portalMatch.at(3));
    return { type: "PORTAL", target: { x, y, z } };
  }

  if (MEMORY_MOVE_RIGHT_PATTERN.test(text)) {
    return { type: "MEMORY_MOVE_RIGHT" };
  }
  if (MEMORY_MOVE_LEFT_PATTERN.test(text)) {
    return { type: "MEMORY_MOVE_LEFT" };
  }
  if (MEMORY_INC_PATTERN.test(text)) {
    return { type: "MEMORY_INC" };
  }
  if (MEMORY_DEC_PATTERN.test(text)) {
    return { type: "MEMORY_DEC" };
  }
  if (MEMORY_GET_PATTERN.test(text)) {
    return { type: "MEMORY_GET" };
  }
  if (MEMORY_SET_PATTERN.test(text)) {
    return { type: "MEMORY_SET" };
  }

  const memoryCondZeroMatch = text.match(MEMORY_COND_ZERO_PATTERN);
  if (memoryCondZeroMatch) {
    const directionToken = memoryCondZeroMatch.at(1);
    if (!directionToken) {
      throw new Y3ParseError(lineNumber, text, "invalid direction for MEMORY_COND_ZERO");
    }
    return {
      type: "MEMORY_COND_ZERO",
      direction: parseDirectionOrThrow(directionToken, lineNumber, text, "MEMORY_COND_ZERO"),
    };
  }

  const memoryCondZeroAnyMatch = text.match(MEMORY_COND_ZERO_ANY_PATTERN);
  if (memoryCondZeroAnyMatch) {
    throw new Y3ParseError(
      lineNumber,
      text,
      `invalid direction '${memoryCondZeroAnyMatch[1]}'. Expected one of: ${VALID_DIRECTIONS.join(", ")}`,
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

  throw new Y3ParseError(lineNumber, text, "unknown sentence for strict grammar");
}

export function parseProgram(source: string): Program {
  const lines = source.split(/\r?\n/);
  const cells = new Map<string, Cell>();
  const macros = new Map<string, string>();
  const layerMetadata = new Map<number, string | null>();

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

    if (text.startsWith("@macro")) {
      const macroMatch = text.match(MACRO_PATTERN);
      if (!macroMatch) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid macro format. Expected: @macro <name>=<instruction>");
      }

      const name = macroMatch.at(1);
      const body = macroMatch.at(2);
      if (!name || !body) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid macro format");
      }

      parseInstruction(body.trim(), sourceLine);
      macros.set(name, body.trim());
      continue;
    }

    if (text.startsWith("@layer")) {
      const layerMatch = text.match(LAYER_PATTERN);
      if (!layerMatch) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid layer format. Expected: @layer <integer> [label]");
      }

      const layerToken = layerMatch.at(1);
      if (!layerToken) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid layer number");
      }

      currentLayer = Number(layerToken);
      const label = layerMatch.at(2) ?? null;
      layerMetadata.set(currentLayer, label);

      if (!rowIndexByLayer.has(currentLayer)) {
        rowIndexByLayer.set(currentLayer, 0);
      }
      lastInstructionByLayer.delete(currentLayer);
      continue;
    }

    if (currentLayer === null) {
      throw new Y3ParseError(sourceLine, rawLine, "instruction before first @layer declaration");
    }

    let resolvedText = text;
    if (resolvedText.startsWith("@")) {
      const useMatch = resolvedText.match(USE_MACRO_PATTERN);
      if (!useMatch) {
        throw new Y3ParseError(sourceLine, rawLine, "unknown directive. Expected @use <macroName>");
      }
      const macroName = useMatch.at(1);
      if (!macroName) {
        throw new Y3ParseError(sourceLine, rawLine, "invalid macro reference");
      }

      const macroBody = macros.get(macroName);
      if (!macroBody) {
        throw new Y3ParseError(sourceLine, rawLine, `unknown macro '${macroName}'`);
      }
      resolvedText = macroBody;
    }

    const instruction = parseInstruction(resolvedText, sourceLine);
    const y = rowIndexByLayer.get(currentLayer) ?? 0;

    if (instruction.type === "ELSE") {
      const previous = lastInstructionByLayer.get(currentLayer);
      if (!previous || (previous.type !== "COND" && previous.type !== "MEMORY_COND_ZERO")) {
        throw new Y3ParseError(sourceLine, rawLine, "misplaced 아니다. It must immediately follow 조건이면 in same layer");
      }
    }

    const cell: Cell = {
      x: 0,
      y,
      z: currentLayer,
      instruction,
      raw: resolvedText,
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
      layerMetadata,
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
    };
  }

  const positions = [...cells.values()];
  const xs = positions.map((cell) => cell.x);
  const ys = positions.map((cell) => cell.y);
  const zs = positions.map((cell) => cell.z);

  return {
    cells,
    layerMetadata,
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
