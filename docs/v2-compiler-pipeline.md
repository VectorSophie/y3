# Y3 v2: the compiler pipeline (M8)

M8 puts a compiler boundary between Y3's language semantics and its execution backends.
This document is the design gate: each layer below has to justify its existence before
it is built.

```
.y3 source
  → layout AST          language/document-parser    planes, cells, ※ section
  → sentence AST        language/sentence-parser    Korean ends here
  → typed HIR           semantics/, types/          what the program means
  → spatial CFG         compiler/cfg                where execution can go
  → MIR                 compiler/mir                what each step does, explicitly
  → bytecode            compiler/bytecode           a portable, verified, versioned encoding
  → VM                  runtime/vm                  runs bytecode through the shared runtime core
```

The temporal constraint graph is not a stage of this chain. It is built by the runtime
while a program runs, next to the CFG, never inside it (§3).

## 1. HIR: what the program means

HIR (M5, `ir/hir.ts`) is the language. It is a statement per cell, and every statement
and expression is typed and carries provenance. HIR contains:

- nouns, as ids with types, and pattern-bound locals;
- expressions as trees: literals, arithmetic, comparisons, built-in calls,
  constructors, fields, elements, matches;
- spatial statements: `Move`, `Turn`, `FloorMove`, `Anchor`, `BackEdge`, `End`;
- temporal statements: `TemporalDeclare`, `Assert`, `Promise`, `Receive`, `Send`,
  `FixedPoint`, and the `TemporalAnchorRead` expression;
- calls to callable planes, and returns.

HIR has **no control flow**. Which cell runs next is not written anywhere in HIR. It
follows from geometry: the cell's position, the pointer's full orientation, whether the
target position holds a cell, and which anchors are open. The HIR interpreter
rediscovers all of this on every step by moving a pointer through space.

## 2. Spatial CFG: where execution can go

The spatial CFG (`compiler/cfg.ts`) makes that control flow explicit, ahead of time.

**A node is a cell executed in a state.** The state is:

- the body (main volume or callable plane);
- the full pose: position, forward and up (24 orientations, never reduced to 2D);
- the stack of open anchors (loops), innermost last.

The same cell can be several nodes: once per orientation it is entered with, and once
per anchor stack it can run under. Control in Y3 depends on exactly these things and
nothing else, so this unfolding is precise.

**Edges.** Each node's successors follow from its statement and its state:

| Edge | From | To |
|---|---|---|
| forward | any statement that does not move the pointer | the next cell along forward |
| turn, face | `Turn` | the next cell along the new forward, with the new orientation |
| step | `Move` | one cell in a body direction; orientation unchanged |
| floor | `FloorMove` | the same x, y on the floor above or below |
| back-edge | `BackEdge` | the innermost open anchor's pose (statically known from the node's anchor stack) |
| branch | `Branch` | two edges: the consequence's edge, or forward (and, for a conditional back-edge, leaving the loop) |
| call | `CallPlane` | the callee's entry node; the call site also records its **return continuation**, the next cell along the caller's own pose |
| return | `Return` | no static target: the frame says where |
| end | `End` | HALT |
| VOID | any edge whose target position holds no cell | VOID, at that position |

Anchors follow the interpreter's rule, statically. Reaching an anchor already open at
depth *k* keeps the stack up to *k*. Reaching a new anchor pushes it. A conditional
back-edge whose condition fails pops the innermost anchor. An anchor appears in the
stack at most once, so the stack is bounded by the number of anchor cells, and the graph
is finite.

**Invariant: cell existence is semantic.** A node exists because execution can stand
on that cell in that state. A blank cell is a real node that does nothing. A cell whose
computed value is never read still changes the step count, the trace, the step limit,
and which cell comes next. The CFG therefore never removes or merges nodes for being
"dead", and no optimization works on cells (§6).

Basic blocks: a node and the MIR it produces form a block; chains are not merged
across cells, because a cell boundary is an observable step.

## 3. Temporal constraint graph: what values must relate across time

Time is relational, so it does not belong in a control-flow graph. A promise does not
send control anywhere, and a channel's back-edge carries a *value*, not the pointer.
Putting either into the CFG would mean either inventing control flow that does not
exist, or losing the relation.

The temporal graph (`temporal/graph.ts`) is built by the runtime as it runs: whichever
engine executes the CFG extends and closes the graph through the same runtime calls.

- **Nodes:** symbols (α, β, ε) with their origin (`미정`, `다음`, `끝`), birth step and
  cell; constraints (equations) with their step, source (past, promise, channel,
  `끝의`, fixed point) and cell.
- **Edges:**
  - `mentions`: constraint → each symbol it involves;
  - `resolves`: constraint → symbol, when the solver determines the symbol there;
  - `fills`: symbol → each earlier step that already depended on it (retroactive
    dependency);
  - `closes`: the edge (channel, `끝의`, fixed point) on which a cycle closed on a
    symbol with no external cause, i.e. SELF_CAUSED.

The graph is a record of relationships. It solves nothing: `temporal/solver.ts` is still
the one solver, behind `temporal/store.ts`. The graph only records what the store was
asked and answered.

## 4. Why Y3 needs MIR

MIR (`compiler/mir.ts`) is the CFG with every step's work written out as explicit
operations on registers:

```
block b3  node #3  (0,2,0) 남/위  [값에 1을 더한다.]
  step
  r1 = load 값#1
  r2 = const 1 : bigint
  r3 = arith add bigint r1, r2
  assign 값#1, r3
  goto b4 (forward)
```

**What MIR makes explicit:**
- control successors: every block ends in a terminator naming its target blocks, or
  VOID, HALT or a return;
- evaluation order: expression trees become an order of operations, exactly the order
  in which the reference interpreter evaluates them;
- *where a value must be concrete*: `now` operations, the points where an open temporal
  symbol stops the run (`UNRESOLVED`);
- pattern matching, as tests and branches inside a step;
- calls: arguments, result targets and the continuation block;
- which runtime service each step uses: loads, stores, arithmetic, built-ins, temporal
  operations.

**What MIR removes from HIR:**
- expression nesting;
- pattern-local names (they become registers);
- the dependence on geometry: positions and orientations survive only as edge labels
  and debug information, and the VM never computes a movement;
- surface types beyond the numeric type each arithmetic needs.

MIR never contains Korean: no particles, no verbs, no sentence text. Sentences and
spans live in the separate debug map (§7).

**Why not HIR → bytecode directly?** Two real compilation steps happen between them,
and both need a structured form:

1. Unfolding space into the CFG: pose and anchor-stack exploration, VOID detection,
   continuation blocks.
2. Linearizing expressions with explicit concreteness points.

Optimizations (§6) and the verifier's well-formedness rules are written against MIR's
blocks and registers, not against a byte array. Bytecode is MIR's serialized form:
numeric opcodes, a constant pool, resolved block indices, a version, and a debug map.
One MIR operation is one instruction. If MIR and bytecode ever stop being worth keeping
apart, bytecode is the one to simplify. MIR is where the compiler reasons.

**SSA.** MIR registers are assigned once (each expression result gets a fresh
register, and pattern bindings are assigned once per arm). Nouns are not registers:
they stay in the runtime as semantic versions (M5), because the temporal store,
`처음` snapshots and def-use records are about nouns. A join after a branch never needs
to merge register values, since no register outlives the step that defines it, so there
are no φ-nodes. Loops are back-edges between steps, and the values they carry are
nouns. This is SSA where it helps, inside a step, without φ-nodes Y3 has no use for.

## 5. The shared runtime core

Neither engine owns semantics. `runtime/core.ts` holds every effect of execution:

- noun versions and def-use;
- frames, loops and their iterations, `처음` snapshots;
- the temporal store calls and the temporal graph;
- channels, promises and fixed points;
- output holding and the effect barrier;
- built-in dispatch;
- trace effects;
- the result.

The two engines differ only in how they find control flow and order work:

| | HIR interpreter (reference) | bytecode VM |
|---|---|---|
| control | moves a pointer through space at run time (`runtime/machine`) | follows CFG edges compiled ahead of time |
| expressions | walks HIR trees (`runtime/evaluate`) | executes MIR operations on registers |
| semantics | `runtime/core`, `semantics/numeric`, `temporal/store`, the stdlib | the same |

Differential testing (`engine=hir` against `engine=vm`) therefore checks exactly what
differs: control-flow compilation and evaluation order.

## 6. Optimization boundary

Optimizations run on MIR registers inside a step, and never on cells or edges:

- **constant folding** of arithmetic on constants, only when it does not fault (a fault
  must happen at its own step);
- **copy propagation** of register moves;
- **neutral arithmetic** on fixed-width integers (`x+0`, `x−0`, `x×1`, `x÷1`) and on
  floats (`x−0.0`, `x×1.0`, `x÷1.0`, but never `x+0.0`, which turns −0 into +0);
- **dead temporaries:** constants and moves whose register is never read.

Never optimized:
- `bigint` arithmetic, the one type that can be symbolic. M4 makes cause depend on the
  normalized term, so `α+0` is in fact `α`. Declining to optimize here keeps temporal
  classification trivially unchanged instead of depending on that argument.
- loads, assignments, temporal operations, built-in calls, branches and their test
  effects;
- cells, edges, orientation.

## 7. Debug map

Every MIR operation and bytecode instruction records the CFG node it belongs to. A node
records its body, pose, cell coordinate, plane, source span and sentence. So:

```
bytecode instruction → MIR op → CFG node → HIR statement (cell) → source span and sentence
```

A `FAULT` raised in the VM reports the same coordinate and frame as the interpreter, and
the debug map names the sentence and plane.

## 8. Audit (M8)

1. **Why MIR exists.** It is where the two real compilation steps land: space unfolded
   into CFG blocks, and expressions linearized with explicit concreteness (`now`) points.
   It is also what the optimizer and the verifier's dataflow pass reason about.
2. **Could HIR → bytecode have been enough?** Not without doing MIR's work inside the
   encoder: the CFG exploration, the linearization and the register dataflow would
   have to happen while writing bytes. MIR and bytecode share one instruction set on
   purpose. If one of them ever stops paying for itself, it is bytecode's separate
   encoding, not MIR.
3. **The Spatial CFG's invariant.** A node is (body, full pose, open-anchor stack).
   Its successors are exactly the poses the machine would reach from it, by
   `runtime/movement`. Cells are never removed. A test follows every interpreter run
   through the CFG, step by step.
4. **Why the temporal graph is not part of the CFG.** Temporal relations carry values,
   not control. A channel's "back-edge" never moves the pointer, and a promise never
   changes which cell runs. Merging the two would either invent control flow or lose
   the relation.
5. **Semantics duplicated in the VM?** None. The VM follows edges and keeps registers.
   Everything else goes through `runtime/core`, `semantics/numeric`, `runtime/evaluate`'s
   `ops`/`matchPattern`/`callBuiltin`, and `temporal/store`.
6. **Is numeric behaviour centralized?** Yes, in `semantics/numeric`. The optimizer folds
   through the same `arith`, and refuses to fold anything that would fault.
7. **Is temporal solving centralized?** Yes. `temporal/solver.ts` is the only solver,
   behind `temporal/store`. The graph only records what the store was asked and
   answered.
8. **Is effect ordering centralized?** Yes. Output holding, the effect barrier and the
   event log all live in `runtime/core`, and every effect, from either engine, passes
   through `env.effect`.
9. **Can an optimizer change causal classification?** It never rewrites `bigint`
   arithmetic, temporal operations, loads or assignments. Differential tests compare
   marks, the temporal graph and the trace with optimization on and off, and a planted
   bug that optimizes `bigint` is caught.
10. **Can malformed bytecode break runtime invariants?** The verifier refuses it before
    it runs (§ verifier in `docs/v2-bytecode.md`). What remains is guarded inside the VM
    as an internal error, never a fake program outcome.
11. **Does source mapping survive every lowering stage?** Yes:
    instruction → block → CFG node → debug map (body, pose, sentence, plane, span). A
    test traces a bytecode `FAULT` back to its sentence, plane and source line.
12. **Are bytecode artifacts reproducible?** Yes. They are byte-identical for the same
    source and lock, as tested and checked by the CLI. A planted timestamp is caught.

Decisions (M8 review):
- **MIR and bytecode stay separate.** MIR is the compiler's in-memory representation;
  Y3BC is a stable, versioned, independently verified serialization boundary. They share
  one instruction vocabulary, not two semantic models.
- **The 200k CFG cap stays.** It is a compiler resource limit, not language semantics.
  Its error names the cause: too many (pose, open-loop) states.
- **The HIR interpreter stays,** at least through M9 and M10, as the differential oracle.
- **Particle allomorphs stay lint-only** in `fmt`.
- **Git and the network are needed only at `y3 lock` time;** locked builds run from the
  cache.

Known limits:
- **CFG size.** The CFG is capped at 200,000 nodes, because poses × anchor stacks could
  blow up in a pathological program. Real programs are small: every fixture and test
  program is under a few hundred nodes.
- **Collections** still copy on update (M7).
