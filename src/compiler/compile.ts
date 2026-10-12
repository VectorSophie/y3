import type { CompiledProgram } from "../ir/program";
import type { Pose } from "../space/manifest";
import type { Executable, NodeInfo } from "../runtime/vm";
import { buildCfg, type Cfg } from "./cfg";
import { lowerToMir, type Mir } from "./mir";

// HIR → spatial CFG → MIR, and the debug map that ties MIR back to cells.
export function compileToMir(program: CompiledProgram, start: Pose): { cfg: Cfg; mir: Mir; nodes: NodeInfo[] } {
  const cfg = buildCfg(program, start);
  const mir = lowerToMir(program, cfg);
  const nodes = cfg.nodes.map((n): NodeInfo => {
    const at = n.stmt?.at;
    const body = n.body === "main" ? program : program.procedures.get(n.body);
    const cell = body?.space.layers[n.pose.position.z]?.plane.rows[n.pose.position.y]?.[n.pose.position.x];
    return { body: n.body, pose: n.pose, sentence: cell?.sentence ?? null, plane: at?.plane.name ?? (n.body === "main" ? null : (body as { name?: string }).name ?? null), span: at?.span ?? null };
  });
  return { cfg, mir, nodes };
}

export function executableOf(mir: Mir, nodes: readonly NodeInfo[], start: Pose): Executable {
  return { blocks: mir.blocks, nodeBlock: mir.nodeBlock, nodes, entries: mir.cfg.entries, registers: mir.registers, start: start.position };
}
