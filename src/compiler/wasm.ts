import type { MirBlock, MirOp } from "./mir";
import { readsOf, termReads } from "./optimize";
import { BytecodeError, moduleOf, type Loaded } from "./bytecode";
import { encodeModule, I, leb, readCustomSection, WasmFormatError, type FuncType, type ValType } from "../runtime/wasm-binary";

// The WebAssembly backend (docs/v2-wasm.md). Verified Y3BC becomes one WebAssembly
// function, `step(block) → block`: the blocks of every step, dispatched by a br_table,
// with the registers as externref locals and branches inside a step as WASM control flow.
// Everything semantic is an import from the runtime core (one per MIR operation kind, and
// the terminator tests): Y3 values are opaque references, never WASM numbers, so WASM
// arithmetic and traps cannot become Y3 semantics. The run loop, effects, time and frames
// stay in runtime/core, shared with the VM and the HIR interpreter.
//
// A .wasm artifact carries its Y3BC in the custom section "y3bc". Loading verifies that
// bytecode, compiles it again and requires the same bytes: the code is never trusted on
// its own.

export const WASM_SECTION = "y3bc";

const EXTERNREF: ValType = "externref";
const fn = (params: ValType[], results: ValType[]): FuncType => ({ params, results });

export type WasmImports = { readonly ops: readonly MirOp["op"][] }; // the op kinds, in import order

// Function indices of the imports: arg, bound, test, truth, then one per op kind used.
function importsOf(blocks: readonly MirBlock[]) {
  const kinds = [...new Set(blocks.flatMap((b) => b.ops.map((o) => o.op)))].sort();
  const imports = [
    { module: "y3", name: "arg", type: fn([EXTERNREF], []) }, // 0: hand a register to the next operation
    { module: "y3", name: "bound", type: fn(["i32"], [EXTERNREF]) }, // 1: a pattern binding of the last test
    { module: "y3", name: "test", type: fn(["i32"], ["i32"]) }, // 2: a block's terminator test
    { module: "y3", name: "truth", type: fn([], ["i32"]) }, // 3: an `if` condition
    ...kinds.map((k) => ({ module: "y3", name: `op_${k}`, type: fn(["i32"], [EXTERNREF]) })),
  ];
  return { imports, opIndex: new Map(kinds.map((k, i) => [k, 4 + i])) };
}

// Every operation's index in program order: what an op_* import is called with.
export function instructionTable(blocks: readonly MirBlock[]): MirOp[] {
  return blocks.flatMap((b) => b.ops);
}

export function compileWasm(loaded: Loaded, artifact: string): Uint8Array {
  const { blocks, registers } = loaded.executable;
  const { imports, opIndex } = importsOf(blocks);
  const reg = (r: number) => r + 1; // local 0 is the block to start at
  const n = blocks.length;
  const body: number[] = [0x03, 0x40]; // loop $dispatch
  for (let k = 0; k <= n; k += 1) body.push(0x02, 0x40); // block $b(n-1) … $b0, $bad
  body.push(...I.localGet(0), 0x0e, ...leb(n), ...blocks.map((_, k) => leb(k + 1)).flat(), ...leb(0)); // br_table
  body.push(0x0b, 0x00); // end $bad: no such block
  let ins = 0;
  blocks.forEach((b, k) => {
    body.push(0x0b); // end $bk: block k's code follows
    const push = (rs: readonly number[]) => rs.forEach((r) => body.push(...I.localGet(reg(r)), ...I.call(0)));
    for (const o of b.ops) {
      push(readsOf(o));
      body.push(...I.i32(ins), ...I.call(opIndex.get(o.op) as number));
      const dst = (o as { dst?: number }).dst;
      body.push(...(typeof dst === "number" ? I.localSet(reg(dst)) : [0x1a])); // local.set or drop
      if (o.op === "test") o.binds.forEach((x, j) => body.push(...I.i32(j), ...I.call(1), ...I.localSet(reg(x.reg))));
      ins += 1;
    }
    const toLoop = n - 1 - k;
    const t = b.terminator;
    switch (t.kind) {
      case "test":
        push(termReads(t));
        body.push(...I.i32(t.then), ...I.i32(t.otherwise), ...I.i32(b.id), ...I.call(2), 0x1b, ...I.localSet(0), ...I.br(toLoop));
        break;
      case "if":
        push([t.cond]);
        body.push(...I.i32(t.then), ...I.i32(t.otherwise), ...I.call(3), 0x1b, ...I.localSet(0), ...I.br(toLoop));
        break;
      case "goto":
        body.push(...I.i32(t.block), ...I.localSet(0), ...I.br(toLoop));
        break;
      case "unreachable":
        body.push(0x00);
        break;
      default:
        // The step leaves its node: hand over what the terminator reads, return the block.
        push(termReads(t));
        body.push(...I.i32(b.id), 0x0f);
    }
  });
  body.push(0x0b, 0x00); // end loop; never reached
  return encodeModule({
    imports,
    functions: [{ export: "step", type: fn(["i32"], ["i32"]), locals: new Array<ValType>(registers).fill(EXTERNREF), body }],
    custom: [{ name: WASM_SECTION, bytes: new TextEncoder().encode(artifact) }],
  });
}

export class WasmArtifactError extends Error {}

// Reads a .wasm artifact: its bytecode is verified like any .y3b, and its code must be
// exactly the compilation of that bytecode.
export function loadWasmArtifact(bytes: Uint8Array): { loaded: Loaded; artifact: string; module: WebAssembly.Module } {
  let section: Uint8Array | null;
  try {
    section = readCustomSection(bytes, WASM_SECTION);
  } catch (e) {
    if (e instanceof WasmFormatError) throw new WasmArtifactError(e.message);
    throw e;
  }
  if (!section) throw new WasmArtifactError(`not a Y3 WebAssembly artifact: no '${WASM_SECTION}' section`);
  const artifact = new TextDecoder("utf-8", { fatal: true }).decode(section);
  let loaded: Loaded;
  try {
    loaded = moduleOf(artifact);
  } catch (e) {
    if (e instanceof BytecodeError) throw new WasmArtifactError(`its bytecode is invalid: ${e.message}`);
    throw e;
  }
  const expected = compileWasm(loaded, artifact);
  if (expected.length !== bytes.length || expected.some((b, i) => b !== bytes[i])) {
    throw new WasmArtifactError("its WebAssembly code is not the compilation of its bytecode: rebuild it with 'y3 build --target wasm'");
  }
  return { loaded, artifact, module: new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>) };
}
