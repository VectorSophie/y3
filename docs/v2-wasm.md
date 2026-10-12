# Y3 v2: the WebAssembly backend (M9)

`y3 build --target wasm` compiles a program to a `.wasm` artifact; `y3 run program.wasm`
and `y3 run program.y3 --engine wasm` run it. The design gate
(`docs/v2-systems-boundary.md`) chose this backend's shape: compile what is control flow,
import what is semantics.

## What is compiled

The input is **verified Y3BC** (`docs/v2-bytecode.md`), not source: the backend sits
behind the same loader and type verifier as the VM. `compiler/wasm.ts`, `compileWasm`,
emits one function:

```
step(block: i32) → i32
```

- a `loop` around a `br_table` over **every block of every step**: the dispatch;
- each MIR register is an `externref` local, fresh on every call (one call per step);
- branches inside a step (`test`, `if`, `goto`) are WASM control flow: the next block is
  chosen with `select` and the loop dispatches to it;
- when a block's terminator leaves the node (an edge, a back edge, a call or a return),
  `step` hands over the registers that terminator reads and returns the block's id.

Every operation compiles to: hand over the registers it reads (`arg`), call its import
with the instruction's index, store the result in its destination local. A pattern test
also stores its bindings (`bound`).

## What is imported

Module `y3`:

| Import | Type | Does |
|---|---|---|
| `arg` | `(externref) → ()` | hands one register to the next operation, test or exit |
| `op_<kind>` | `(i32) → externref` | one per MIR operation kind used; runs instruction *i* |
| `bound` | `(i32) → externref` | the *j*th binding of the last pattern test (null when it did not match) |
| `test` | `(i32) → i32` | the terminator test of block *b*, through the runtime core |
| `truth` | `() → i32` | an `if` condition |

The host side (`runtime/wasm-host.ts`, `runWasm`) implements them with the VM's own
functions: `executeOp` and `executeTest` (`runtime/vm.ts`). The run loop is the VM's own
`runSteps`: steps, the trace, faults, step limits, and how edges, back edges, calls and
returns complete a step. The only code that differs between the VM and the WASM backend is
where registers live and who walks the blocks inside one step.

## Why Y3 numbers never become WASM numbers

Registers hold `externref`s: opaque references to runtime values. WASM code never
computes with them. So:

- checked arithmetic is `semantics/numeric`: `i32` overflow, division by zero and
  `MIN / -1` FAULT, exactly as on the VM, and never wrap or trap;
- `f32` rounding, `NaN` and `-0.0` are the runtime's;
- `i128`, `u128` and `bigint` work unchanged;
- temporal operations go to `runtime/core.ts` and the one solver, `temporal/solver.ts`;
  RETRO, SELF_CAUSED and PARADOX are the same outcomes;
- effects go through the core's one effect path: barrier, capabilities, events, replay;
- foreign calls are the `op_foreign` import, the same `ForeignRuntime`.

The only WASM trap the code can hit is `unreachable`, for a block id the dispatch does not
know or an `unreachable` terminator; the VM's `VmError` checks guard the rest.

## The artifact

A `.wasm` artifact is a valid WebAssembly module with a custom section `y3bc` holding the
Y3BC text it was compiled from. Loading (`loadWasmArtifact`):

1. reads the `y3bc` section;
2. verifies that bytecode like any `.y3b` (structure, dataflow, types, foreign tables);
3. compiles it again and requires **byte-for-byte the same module**.

The WASM code is never trusted on its own: hand-edited code, or code from another
compiler, is refused with "its WebAssembly code is not the compilation of its bytecode".
The build is reproducible (a test builds twice and compares bytes). The replay identity of
a `.wasm` program is the hash of its embedded Y3BC, so a run recorded from `program.y3`
replays on `program.wasm`.

## Differential testing

`tests/v2/wasm.test.ts`:

- every fixture: HIR = WASM on everything observable (outcome, output, events, values,
  symbols, versions, trace, temporal graph);
- 700 seeded random programs (space and arithmetic, calls, time, calls and time): HIR =
  WASM;
- targeted cases: checked overflow, division by zero, `MIN / -1`, `i128`, `f32`, `NaN`,
  `-0.0`, movement, a loop under a tilted pose (`up` = east), loops, recursion, data,
  collections, temporal unknowns, RETRO, SELF_CAUSED, PARADOX, the effect barrier, stdin
  and clock, the step limit;
- the FFI suite runs every program on all three engines (`tests/v2/ffi.test.ts`).

## Performance

Node 24, this machine, mean of 3–10 runs:

| Workload | HIR | VM | WASM |
|---|---|---|---|
| 40 fixtures, one pass | — | 6.7 ms | 9.5 ms (incl. instantiation) |
| arithmetic loop, 80 004 steps | 299 ms | 566 ms | 728 ms |
| i32 add loop, 60 003 steps | 206 ms | 395 ms | 525 ms |

The WASM backend costs about 1.3× the VM per step: every operation crosses the JS/WASM
boundary at least twice. That is the price of keeping semantics in one place, and there is
no catastrophic overhead. (The VM being slower than the HIR interpreter predates M9; it is
noted as a design question, not chased here.) Compiling all 40 fixtures to WASM takes
8.4 ms.

## Deferred

A WASM build of the runtime itself (so a `.wasm` program runs without JavaScript), WASI
host imports, and compiling arithmetic on fixed-width integers to native WASM instructions
with explicit overflow checks. Each would need its own differential suite before it could
replace an import.
