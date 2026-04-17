import type { StepTrace } from "./types";

export function formatTraceEntry(entry: StepTrace): string {
  return [
    `step=${entry.step}`,
    `pos=(${entry.pos.x},${entry.pos.y},${entry.pos.z})`,
    `dir=(${entry.dir.dx},${entry.dir.dy},${entry.dir.dz})`,
    `cell="${entry.cell}"`,
    `stack=[${entry.stack.join(",")}]`,
    `output="${entry.output}"`,
  ].join("\n");
}
