import type { Pose } from "../space/manifest";
import type { Compass, Relative, Turn } from "../space/orientation";

// What the spatial machine can do. Cells hold sentences; a decoder turns a sentence
// into one of these. In M1 the decoder is supplied by the caller (tests use the
// assembly notation); from M2 on it comes from present-tense sentence semantics.
// The machine itself never reads Korean.

export type Instruction =
  | { readonly op: "nop" } // a blank cell, or a sentence with no spatial effect
  | { readonly op: "turn"; readonly turn: Turn } // look: change orientation, then advance
  | { readonly op: "face"; readonly compass: Compass } // face a compass direction, level
  | { readonly op: "step"; readonly relative: Relative } // move once; orientation unchanged
  | { readonly op: "floor"; readonly delta: 1 | -1 } // z ± 1; x, y and orientation unchanged
  | { readonly op: "jump"; readonly to: Pose } // return to a pose the program already stood on (a loop anchor)
  | { readonly op: "end" }; // 끝이다: the run ends deliberately

export type DecodeResult = Instruction | { readonly error: string };

// Called once for each non-blank cell, in execution order, with the pose the cell runs
// in. A decoder may keep state (the present-tense interpreter does); the machine itself
// stays purely spatial.
export type Decoder = (sentence: string, pose: Pose) => DecodeResult;

export function isDecodeError(result: DecodeResult): result is { readonly error: string } {
  return "error" in result;
}
