import { COMPASS, RELATIVES, TURNS, type Compass, type Relative, type Turn } from "../space/orientation";
import type { DecodeResult, Decoder } from "./instructions";

// Machine assembly: a plain notation for the spatial machine's instructions, used to
// test and debug the machine without the Korean language layer. It is NOT Y3 source;
// real programs reach the machine through sentence semantics (M2).
//
//   nop · end · turn right|left|around|up|down · face east|west|south|north
//   step forward|back|right|left|up|down · floor up|down

export const decodeAssembly: Decoder = (sentence: string): DecodeResult => {
  const words = sentence.trim().split(/\s+/);
  const [op, arg, ...extra] = words;
  const bad = (): DecodeResult => ({ error: `not a machine instruction: '${sentence}'` });
  if (extra.length > 0) return bad();
  switch (op) {
    case "nop":
      return arg === undefined ? { op: "nop" } : bad();
    case "end":
      return arg === undefined ? { op: "end" } : bad();
    case "turn":
      return (TURNS as readonly string[]).includes(arg ?? "") ? { op: "turn", turn: arg as Turn } : bad();
    case "face":
      return (COMPASS as readonly string[]).includes(arg ?? "") ? { op: "face", compass: arg as Compass } : bad();
    case "step":
      return (RELATIVES as readonly string[]).includes(arg ?? "") ? { op: "step", relative: arg as Relative } : bad();
    case "floor":
      return arg === "up" ? { op: "floor", delta: 1 } : arg === "down" ? { op: "floor", delta: -1 } : bad();
    default:
      return bad();
  }
};
