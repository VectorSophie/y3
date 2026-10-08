import type { Pose, Coordinate } from "../space/manifest";
import { face, turn, vectorOf, worldDirection, type Direction } from "../space/orientation";
import type { Instruction } from "./instructions";

// Where an instruction leaves the pointer. END leaves it exactly where it is; every
// other instruction moves exactly one cell: forward by default, or as it says.

export function offset(position: Coordinate, direction: Direction): Coordinate {
  const v = vectorOf(direction);
  return { x: position.x + v.x, y: position.y + v.y, z: position.z + v.z };
}

export function nextPose(pose: Pose, instruction: Instruction): Pose {
  const { position, orientation } = pose;
  switch (instruction.op) {
    case "end":
      return pose;
    case "nop":
      return { position: offset(position, orientation.forward), orientation };
    case "turn": {
      // The new orientation applies to this step's advance.
      const turned = turn(orientation, instruction.turn);
      return { position: offset(position, turned.forward), orientation: turned };
    }
    case "face": {
      const faced = face(instruction.compass);
      return { position: offset(position, faced.forward), orientation: faced };
    }
    case "step":
      return { position: offset(position, worldDirection(orientation, instruction.relative)), orientation };
    case "floor":
      return {
        position: { x: position.x, y: position.y, z: position.z + instruction.delta },
        orientation,
      };
  }
}
