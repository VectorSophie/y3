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
| `bodies` | the noun table of the main volume and of each callable plane: id, name and **resolved type** |
| `typedefs` | the program's own type declarations (records and sums); the built-in ones are implied |
| `procedures` | callable planes: id, name, module, parameters (noun, name, type) and result types |
| `constants` | literal values. Integers are strings, because they are unbounded. Floats keep `NaN`, `+Inf`, `-Inf` and `-0` exactly, with their width. |
| `patterns` | match patterns, with their literals encoded like constants |
| `types` | value types: the type of each literal (`const`), construction (`construct`) and array (`array`), the three places the operands alone do not determine it |
| `callTypes` | the instantiated argument and result types of built-in calls (checked arithmetic and conversions need them) |
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

## The type verifier

`.y3b` is directly executable (`y3 run artifact.y3b`), so it is an external format, and
a hand-written artifact must not be able to express a program the type checker could
never produce. After the structural checks, `compiler/verify-types.ts` proves the
**typed-MIR invariant** from the artifact alone. It reads the serialized resolved types;
it does not run the source type checker again.

**The type model.** Types are the resolved `Type` values of the compiler: primitives,
named types with arguments, arrays, slices, and open type variables. An open variable is
a type the checker left open, such as a temporal noun only ever printed. The verifier
treats it as **rigid**: it equals only itself, so it cannot stand in for anything else.

Every type in the artifact must be well-formed: known primitives, declared or built-in
names with the right number of arguments, and no type parameters outside a
definition. Declarations may not redefine built-in types or be opaque.

**Registers.** Inside each step the verifier tracks the type of every register on every
path. A register has one type: if two paths reach a block with different types for the
same register (a match's result, say), the artifact is refused.

| Instruction | Rule |
|---|---|
| `const` | the constant is a value of its declared type: an integer in range, a float of matching width, a rune, Text, Bool, Unit, or data that fits its declaration |
| `load`, `recorded`, `pastLeft` | the register takes the noun's type |
| `assign`, `promise` | the value's type is the noun's type |
| `past` | both sides have one type |
| `anchorRead` | the noun's type; for `끝`, a temporal type |
| `declare`, `receive` | the noun is `bigint`, `Text` or an open variable: only those reach the temporal store |
| `move`, `now` | the source's type |
| `arith` | both operands and the result are the instruction's numeric type |
| `not` | Bool to Bool |
| `eq` | operands of one type, giving Bool |
| `order` | operands of one numeric type or Rune, giving Bool |
| `builtin` | the registers' types are the call types' arguments. The call types are an instantiation of the callable's signature, with every type parameter bound consistently, the rest arguments respected, and the bounds (`number`, `integer`, `float`, `key`) satisfied |
| `construct` | the result is the named type, and each field register has its field's instantiated type |
| `field`, `checkField`, `setField` | the record's field, by declaration |
| `array` | `[T; N]` with N elements, each of type T |
| `index` | an array, slice or List element, with an `i64` index |
| `setIndex`, `checkWritable`, `writePosition` | an array or List (never a slice), an `i64` position, a value of the element type |
| `sliceBound`, `slice`, `length` | an array or slice, with `i64` bounds |
| `test` | the pattern matches the scrutinee's type, and its bindings get the field types, available only on the matching branch |
| `test` terminator | `bool`: a Bool register; `eq`/`order`: as the instructions |
| `if` | a Bool register |
| `call` | arguments have the parameter types; result nouns have the result types (a single result noun of a Unit plane is Unit) |
| `return` | the values have the plane's result types |

**Constants.**
- A `rune` constant is a Unicode scalar value: U+0000–U+10FFFF, excluding the
  surrogates U+D800–U+DFFF.
- A width-32 `float` constant must already be a binary32 value: `Math.fround(v) === v`,
  or NaN. It is refused otherwise, never silently rounded, so an artifact cannot carry
  an `f32` that compiled source could not produce.

The compiler remains responsible for writing correct bytecode. The loader proves,
independently, the invariants the VM and the runtime rely on.

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

Version 1 gained its type tables (`typedefs`, typed `bodies`, `types`, `callTypes`) and
the typed `const`/`construct`/`array` operands before M8 was merged. No version-1
artifact was ever released before that, so the number did not change.
