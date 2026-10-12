import type { Manifest } from "../space/manifest";
import type { MirOp } from "../compiler/mir";
import { readsOf, termReads } from "../compiler/optimize";
import { instructionTable } from "../compiler/wasm";
import type { Loaded } from "../compiler/bytecode";
import type { ProgramResult, RunOptions } from "./core";
import type { Value } from "./evaluate";
import { executeOp, executeTest, runSteps, truth, VmError, type StepRunner } from "./vm";

// Runs a compiled WebAssembly module (docs/v2-wasm.md). Its imports are the runtime
// core: each operation runs through executeOp, the VM's own, and the run loop is
// runSteps, the VM's own. The module holds only control flow and registers.

export function runWasm(module: WebAssembly.Module, loaded: Loaded, manifest: Manifest, options: RunOptions = {}): ProgramResult {
  const { executable: exe, program } = loaded;
  const table = instructionTable(exe.blocks);
  return runSteps(exe, program, manifest, options, (rt): StepRunner => {
    let handed: Value[] = []; // registers handed over by `arg` for the next operation
    let bindings: (Value | null)[] = [];
    // The values handed over, by register: exactly the registers the operation reads.
    const take = (regs: readonly number[], what: string) => {
      const values = handed;
      handed = [];
      if (values.length !== regs.length) throw new VmError(`${what} was handed ${values.length} registers, not ${regs.length}`);
      const byReg = new Map(regs.map((r, i) => [r, values[i] as Value]));
      return (r: number) => {
        const v = byReg.get(r);
        if (!v) throw new VmError(`${what} reads r${r}, which was not handed over`);
        return v;
      };
    };
    const op = (kind: MirOp["op"]) => (ins: number) => {
      const o = table[ins];
      if (!o || o.op !== kind) throw new VmError(`instruction ${ins} is not a '${kind}'`);
      const read = take(readsOf(o), `'${kind}'`);
      const written = new Map<number, Value>();
      executeOp(o, rt, { read, write: (r, v) => void written.set(r, v) });
      if (o.op === "test") bindings = o.binds.map((b) => written.get(b.reg) ?? null);
      const dst = (o as { dst?: number }).dst;
      return typeof dst === "number" ? (written.get(dst) ?? null) : null;
    };
    const imports: Record<string, unknown> = {
      arg: (v: Value | null) => {
        if (v === null) throw new VmError("a register is read before it is written");
        handed.push(v);
      },
      bound: (j: number) => bindings[j] ?? null,
      test: (block: number) => {
        const t = exe.blocks[block]?.terminator;
        if (t?.kind !== "test") throw new VmError(`block b${block} does not end in a test`);
        return executeTest(t.test, rt, take(termReads(t), "a test")) ? 1 : 0;
      },
      truth: () => {
        const [v] = handed;
        if (handed.length !== 1 || !v) throw new VmError("a branch condition was not handed over");
        handed = [];
        return truth(v) ? 1 : 0;
      },
    };
    for (const o of table) imports[`op_${o.op}`] ??= op(o.op);
    const instance = new WebAssembly.Instance(module, { y3: imports as WebAssembly.ModuleImports });
    const step = instance.exports.step as (block: number) => number;
    return (_node, first) => {
      handed = [];
      const exit = step(first);
      const block = exe.blocks[exit];
      if (!block) throw new VmError(`the step left through block b${exit}, which does not exist`);
      return { block, read: take(termReads(block.terminator), "a terminator") };
    };
  });
}
