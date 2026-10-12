# Y3 v2: bytecode and the VM (M8)

Bytecode is MIR in a portable, versioned, verified form. One MIR operation is one
instruction. `compiler/bytecode.ts` defines the format; `runtime/vm.ts` runs it.

## The artifact (`.y3b`)

The artifact is text: a header line, then one JSON document.

```
Y3BC 1
{"magic":"Y3BC","version":1,"module":"countdown","maxSteps":10000,"start":{…},"registers":3,
 "bodies":[…],"procedures":[…],"constants":[…],"patterns":[…],"types":[…],"edges":[…],
 "entries":[…],"nodes":[…],"blocks":[…]}
```

| Field | Holds |
|---|---|
| `magic`, `version` | `Y3BC`, `1`. Any other version is refused with "rebuild from source". |
| `module`, `maxSteps`, `start` | the manifest's name, step limit and start pose |
| `registers` | registers per step, at most |
| `bodies` | the noun table (id, name) of the main volume and of each callable plane |
| `procedures` | callable planes: id, name, module, parameters (noun, name, type) and result types |
| `constants` | literal values. Integers are strings, because they are unbounded. Floats keep `NaN`, `+Inf`, `-Inf` and `-0` exactly, with their width. |
| `patterns` | match patterns, with their literals encoded like constants |
| `types` | the resolved argument and result types of built-in calls (checked arithmetic and conversions need them) |
| `edges` | CFG edges: kind, the machine instruction a trace reports, next pose, target |
| `entries` | where each body starts |
| `nodes` | **the debug map**: per CFG node, its body, full pose, sentence, plane and source span |
| `blocks` | per block, its node, whether the node's step starts there, `code` (instructions) and `end` (terminator) |

An instruction is `[opcode, operand…]`. Opcodes and operand kinds come from a single
table, `OPS` in `compiler/bytecode.ts`: 35 opcodes, from `0 const` to `34 end`. Operands
are registers, noun ids, pool indices, strings or small integers. A terminator is one of:

```
["edge", e]   ["back", e|null]   ["call", plane, args, results, e]   ["return", values]
["test", test, then, else]   ["if", reg, then, else]   ["goto", block]   ["unreachable", reason]
```

**Reproducible.** The artifact has no timestamps, paths or random ids. Pools are
filled in first-use order, CFG nodes are numbered in discovery order, and JSON keys are
written in a fixed order. The same source and lock always produce the same bytes, and a
test checks it.

## The verifier

`loadBytecode` checks everything before anything runs; it does not trust that a
compiler wrote the module. It refuses:

- an unknown opcode, or the wrong number of operands;
- a register outside the register count, or a constant, pattern, type or edge index
  outside its pool;
- a noun that is not a noun of the body the instruction runs in;
- a jump to a block that is not in the same step, or to a node, body or callable plane
  that does not exist;
- a node with no starting block, or with two;
- a `return` in the main body (no call frame to return to);
- a call whose argument count does not match the callable plane, or whose results are
  not the caller's nouns;
- a built-in that does not exist, or the wrong number of arguments to it (variadic
  built-ins need at least their fixed ones);
- an `arith` with a bad operation or numeric type, a bad ordering, or a past statement
  about `끝`;
- **a register read before it is written** on some path through the step (a dataflow
  pass over the step's blocks).

The VM also guards at run time: an unwritten or nonexistent register, a missing block, a
return with nothing to return to, or a runtime loop or frame that disagrees with the CFG
each stop the VM with an internal `VmError`. None of them is ever reported as a program
outcome.

## The VM

`runExecutable(executable, program, manifest, options)` holds:

- the runtime core (`runtime/core.ts`), the same one the HIR interpreter uses: nouns,
  frames, loops, the temporal store and graph, output and effects;
- a register file, fresh for each step;
- a stack of call continuations.

Each step:

1. `beginStep` in the core, at the node's position;
2. the node's blocks, operation by operation, until a terminator leaves the node;
3. a trace entry, with the edge's instruction and next pose;
4. `stepOutcome` from `runtime/machine` (HALT, VOID, STEP_LIMIT), the same rule the
   machine uses.

A `RuntimeFault` ends the run with `FAULT` at that step, exactly as in the interpreter. A
temporal stop (`UNRESOLVED`, `PARADOX`) ends the step as if the cell moved forward, also
exactly as in the interpreter.

The VM has no movement logic, no arithmetic of its own, no pattern matcher, no
temporal logic and no built-in dispatch. It calls `semantics/numeric` through the core,
`matchPattern` and `ops` from `runtime/evaluate`, `temporal/store` through the core, and
`callBuiltin`. The only things it does differently from the interpreter are following
CFG edges and holding values in registers.

## Compatibility

The bytecode version changes whenever an opcode, an operand's meaning or the layout
changes. There is no cross-version loading: an artifact is rebuilt from source.
