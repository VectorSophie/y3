# Y3 v2: source mapping (M10)

How an authored cell is found again at every stage: in the text, in typed HIR, in MIR and
bytecode, and in a run. Every link is a table built from structured data, keyed by the
stable ids of `docs/v2-editor-model.md`. Nothing is recovered from coordinates, line
numbers or human-readable strings.

```
text ──parse──▶ layout AST ──attach ids──▶ CellAst.ids
                                              │ planeFromAst
                                              ▼
                                         space Cell.ids ──compileProgram──▶ Provenance.ids (HIR)
                                              │ compileToMir                      │
                                              ▼                                   ▼
                                         NodeInfo.ids (debug map) ──▶ Y3BC 3 nodes[].ids
                                              │ runSteps / interpreter
                                              ▼
                                         ProgramTraceEntry.ids ──▶ structured events
```

## Source ↔ cell

The model never guesses where a cell is written. It parses the text with the existing
parser and walks the layout AST in step with its identity structure (`editor/structure.ts`,
`attach`), which has the same shape. For each document and revision a `SourceMap`
(`editor/model.ts`) holds:

- `CellId → Span`: a cell's `[…]`, blank or not;
- `PlaneId → Span`: an inline plane's brackets, or a named plane's whole definition;
- `position → Element`, the innermost element at a line and column: a `cell`, a
  `declaration` (with its NodeId), a `reference` (`⟦ :name: ⟧`, with its floor and plane),
  a `plane`, a `comment` or the `manifest`. `cellAtSourceOffset` converts a UTF-16 offset
  first.

Multi-line elements (planes, definitions, front matter) are indexed on every line they
cover. After a structural edit the text is the formatter's; after a raw edit it is the
user's own text, and the spans are that text's spans. A document whose text does not parse
has no source map: its queries return no spans rather than spans of an older text.

## Cell ↔ HIR

`compileProgram` copies `CellIds` from the space's cells into each statement's
`Provenance.ids`: document, module, plane, cell and the statement's NodeId. Every
expression of the statement shares that provenance (`at`). Editor NodeIds for the nodes
below a statement are derived: `<statement id>/<i>/<j>…`, the path of child positions
(`hirNodes`). So:

- `hirNodesForCell(cell)`: the statement and every node in it, with ids;
- `hirNode(id)`: the node for an id in the current build;
- `statements(document)`: every statement by cell.

A named plane placed on several floors compiles its cells once per placement in the main
body; every placement carries the same CellIds, because it is the same authored cell.

## HIR ↔ MIR

The spatial CFG's nodes take the ids of the cell they execute, blank cells included
(`compileToMir`, `NodeInfo.ids`). A MIR instruction is named `<block>:<index>`
(`InstructionId`); its block belongs to one CFG node. So:

- `mirInstructionsForCell(cell)`: every instruction compiled from the cell (a cell can be
  several CFG nodes: one per pose and anchor stack);
- `instruction(document, id)`: its op, cell, statement NodeId and full `CellIds`.

Instructions map to statements, not to individual expressions: MIR operations do not
record which sub-expression produced them. That is an open question, because answering it
changes the bytecode.

## Bytecode (Y3BC 3)

Y3BC 3 carries each debug-map node's ids (`nodes[i].ids`) and the revision a build came
from (`revision`, null for a plain `y3 build`). The loader checks their shape and never
interprets them. A plain build has no ids, and stays byte-for-byte reproducible. A
WebAssembly artifact embeds its Y3BC, so it carries the same ids with no format of its own.

## Runtime trace

Each trace entry (`ProgramTraceEntry.ids`) names the cell that ran, on every engine: the
VM and the WASM backend from the debug map, the HIR interpreter from its space. The
differential tests compare traces with ids across all three.

`runEvents` (`editor/events.ts`) turns a run into typed events, each with the revision,
step, frame, position and `CellIds`:

| Kind | Types | From |
|---|---|---|
| `spatial` | EnterCell, LeaveCell, Move, Turn, Face, FloorTransition, Jump | trace entries and their instructions |
| `value` | Define, Assign, Read, Resolve | effects; def-use records (`versions`) |
| `call` | Call, Return | effects |
| `temporal` | Constraint, Promise, Receive, Send, RetroResolve, SelfCaused, Paradox, Unresolved | effects |
| `io` | Stdout, Stdin, FileRead, FileWrite, Clock, ForeignCall | host events (`docs/v2-replay.md`), with `resource` |
| `diagnostic` | the outcome | the run's outcome |

They add no semantics. Human trace text is rendered from the same entries
(`formatProgramTrace`); no editor reads it.

## Stale results

Builds, runs, diagnostics and events carry their `ProgramRevision`. `model.isCurrent(x)`
says whether `x` belongs to the current state; `traceEvents(run)` reports `stale: true`
for a run of another revision. A stale result is shown as stale, never mapped onto cells
that may have moved or changed. Undo back to a revision makes its results current again,
because that is exactly the state they came from.

## Diagnostics

Compiler diagnostics are adapted, not recomputed (`ModelDiagnostic`): code, severity,
message, revision, document and span, plus the cell, plane and statement or declaration
NodeId found at the span's start. A diagnostic about an imported module outside the model
carries that module's `path` instead of an element of this document.
