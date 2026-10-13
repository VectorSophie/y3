# Y3 v2: the editor model (M10)

M10 adds the substrate a future editor (the 3D IDE, an LSP server, structural tools)
stands on: a `ProgramModel` with stable identities, structural edits, undo/redo, and
queries that tie source, cells, typed HIR, MIR and runtime traces together. It is not a
UI. Nothing in it parses Korean, checks types, solves time or builds a CFG: it asks the
existing layers and keeps the answers linked.

```
source text ⇄ ProgramModel (identities, history, revisions)
                 │  annotated layout AST (each cell carries its ids)
                 ▼
     buildSpace → compileProgram → typed HIR → CFG → MIR → Y3BC → VM / WASM
                 │  provenance, debug map and trace entries carry the same ids
                 ▼
     structured editor events, diagnostics, semantic services
```

## The twelve questions

**1. What is the canonical identity of a document?** A `DocumentId`, created when the
model opens a document (`model.open`). It is not the path (a property, which may change on
save-as) and not a content hash (which changes on every edit). It survives every edit,
formatting, plane renames and moves. Save-as keeps the id by default (the same logical
document now lives elsewhere); a caller who wants a fork opens the text again, which
creates a new id. Closing the model forgets it unless an identity sidecar was written.

**2. What is the identity of a module?** A `ModuleId`, created with the document that
defines the module and kept for its life. It is distinct from the document id (one
module per document today, but the namespace and the file are different things), from
the manifest `name` (a display property that may be edited), from import aliases (each
importer's local name for it) and from paths or git URLs (how a resolver finds it).
Changing an alias changes nothing about the imported module.

**3. What is the identity of a plane?** A `PlaneId` per authored plane: an inline floor
of the volume, or a named plane in the ※ section (placed or callable). Renaming, moving
(changing z) and extracting into the ※ section keep it. A `⟦ :name: ⟧` reference is not
a plane: it is a placement of the named plane, which keeps its one id however many
floors place it.

**4. What is the identity of a cell?** A `CellId` per authored cell: one `[…]` in one
plane, blank or not. Coordinates are properties: a cell moved from (1,2,0) to (4,1,3) is
the same cell. A named plane placed on two floors has its cells at two z positions of
the space, but each cell is authored once and has one id. VOID has no id: VOID is the
absence of authored geometry.

**5. What is the identity of a syntax/semantic node?** A `NodeId` for:
- the statement of each non-blank cell (its root HIR statement);
- each declaration line of the ※ section (`자료`, `외부`).

Expressions and sub-statements inside a cell get *derived* ids, `<statement id>/<path>`
(the path of child indices in the HIR): unique, deterministic, and replaced whenever the
statement's id is. Tokens are not identified.

**6. Which identities survive edits?** Documents and modules always. Planes across
rename, move, extract and resize. Cells across move (within or between planes), swap,
sentence edits, formatting, plane moves and projection changes. A statement's NodeId
survives anything that leaves the cell's sentence unchanged (it is replaced when the
sentence changes). A declaration's NodeId survives while its text is unchanged.

**7. Which identities are regenerated?** New cells, planes and declarations get new ids.
Copies get new ids: duplicating a cell, inlining a named plane (a definition may be
placed many times, so its cells cannot all be "the" inlined cells). An edited sentence
gets a new statement NodeId (its derived expression ids change with it). A raw text edit
gives new ids to whatever reconciliation cannot match with high confidence.

**8. How does source text map to cells?** The model formats (or keeps the user's raw
text), parses it with the existing parser, and walks the parsed layout AST in step with
its own identity layer, which has exactly the same shape: volume slots, rows, cells,
declarations, definitions. Each `CellAst` gets its ids; each span comes from the parser.
`CellId → span` and `position → element` are tables built from that walk, never derived
from coordinates or from re-reading text. Comments, front matter, `※` and definition
heads map to non-cell elements.

**9. How do cells map to HIR?** The annotated AST is what the compiler compiles. Its
cells carry `CellIds` (document, module, plane, cell, statement node) into the space
(`space/plane.ts`), and `compileProgram` copies them into each statement's provenance
(`Provenance.ids`). One cell → one root statement and its sub-nodes; every HIR node knows
its cell through its provenance. The compiler only carries the ids: it never creates,
reads or depends on them.

**10. How do HIR nodes map to MIR and the runtime trace?** CFG nodes take the ids of the
cell they execute (blank cells included) into the debug map (`NodeInfo.ids`), and from
there into Y3BC (version 3) and every trace entry, on every engine. A MIR instruction is
`<block>:<index>`; its block belongs to a CFG node, whose ids name the cell and the
statement. So `statement NodeId → instructions` and `instruction → NodeId → CellId` are
table lookups. Instructions are not mapped to individual expressions (see open
questions). Each build is stamped with the `ProgramRevision` it was built from.

**11. What does undo/redo restore?** Exactly the prior model state: the snapshot is
immutable, so undo restores the very same ids, text, layout, blank/VOID structure,
spans and revision. Redo restores the exact post-edit snapshot. History is linear: a new
edit after undo discards the redo branch. Id counters are never rolled back, so an id is
never handed out twice.

**12. What does an incremental edit invalidate?** Logically, the edited cells' statement
NodeIds and anything derived from the revision: spans of the document, diagnostics, HIR,
MIR, bytecode and traces of the old revision. Physically, M10 re-formats, re-parses and
re-compiles the whole document on demand, per revision; it does not pretend otherwise.
Identities of everything not edited are preserved, which is what an editor needs; an
incremental compiler can later use the same invalidation boundaries.

## Decisions

### Identity lives in the model, not the source
Source stays clean Y3: no ids in `.y3` files. Ids live in the `ProgramModel`. For
cross-session identity the model can write an optional sidecar (`Y3MODEL 1`, internal
JSON): the identity layer and the text it belongs to. Reopening with a sidecar
reconciles that old text with the current text, exactly as for a raw edit, so a file
edited outside the editor keeps only the ids that can be matched confidently.

### Snapshots, not inverse commands
Each committed edit produces a new immutable snapshot; undo and redo move between
snapshots. Inverse operations are easy to get subtly wrong (ids regenerated on undo, a
lost comment); restoring a snapshot cannot be.

### Transactions
`model.apply(commands)` applies a list of structural commands to a draft, then validates
(rectangular planes, unique names, every invariant), serializes with the existing
formatter, re-parses and re-attaches ids. Any failure throws and leaves the model
unchanged. Planes are rectangles, so most geometry changes are transactions of several
commands (or the row/column helpers).

### Structural commands
| Command | Identity rule |
|---|---|
| `InsertCell` | new CellId, at a VOID position |
| `DeleteCell` | the CellId ends (undo restores it) |
| `MakeBlank` | same CellId, no statement |
| `MakeVoid` | a *blank* cell's geometry is removed; its CellId ends |
| `MoveCell` | same CellId; the destination must be VOID: an occupied destination (blank or not) is rejected, never overwritten |
| `SwapCells` | both keep their CellIds and exchange positions (the explicit form of "move onto a blank") |
| `EditSentence` | same CellId; a new statement NodeId when the sentence changes; see below for what is accepted |
| `InsertRow`/`DeleteRow`/`InsertColumn`/`DeleteColumn` | new blank cells get new ids; deleted cells end |
| `InsertPlane` | new PlaneId, blank cells with new ids |
| `DeletePlane` | the PlaneId and its CellIds end; a named plane that is still placed or called is rejected |
| `MovePlane`/`MoveLayer` | same ids |
| `RenamePlane` | same PlaneId; every `⟦ :name: ⟧` and call site follows; a conflicting name is rejected |
| `ExtractNamedPlane` | a whole inline floor becomes a named plane: same PlaneId, same CellIds; the floor becomes a reference (a placement, no id) |
| `InlineNamedPlane` | the floor gets a new inline plane: new PlaneId, new CellIds (copies) |

`EditSentence` lets the parsers decide what the text means. It strips outer whitespace
only, then the document parser must read `[text]` as exactly one cell. Inside a text
literal, brackets, `⟦ ⟧`, repeated spaces and escapes are data; outside one, a bracket or
a line break is structure. The resulting cell text is the parser's own: whitespace is
collapsed outside literals and only there. The sentence parser must then accept it. No
pattern of the model's own rewrites characters. When serialization respells a sentence
(the formatter's canonical form), `attach` checks that it still parses to the same
sentence, and refuses the edit otherwise. Half-typed text is not a sentence: an editor
sends it as a raw text edit (`setText`), which keeps the cell's identity.

Extraction works on whole floors, because a named plane composes as a whole floor in Y3;
extracting part of a floor has no meaning-preserving form, so it is not offered.

### Raw text reconciliation
When the text is edited directly, the model parses it and matches old to new, in this
order, deterministically, and only with high confidence:
1. **Planes**: named planes by name; then unmatched inline planes with identical contents;
   then inline planes in volume order that have the same size and at least half their
   cells unchanged.
2. **Cells** inside matched planes: same position and same sentence; then a sentence
   that is unique among the unmatched cells of both versions (a move); then, if the plane
   kept its size, same position (an edited sentence).
3. **Cells across planes**: a non-blank sentence unique among all unmatched cells.
4. **Declarations**: identical text.
Everything else gets a new id. Blank cells are matched only by position in a plane of
unchanged size: a blank has no content to recognise it by. Wrongly kept identity is worse
than a fresh one.

When the new text does not parse at the document level (an unclosed plane), the model
keeps the text and its diagnostics, keeps the last good structure for queries, marks the
document broken, and refuses structural edits until the text parses again. Formatting a
broken document is refused.

### Revisions
`ProgramRevision` names one state of the model. It is fresh for every committed change
(never reused, even after undo creates a new branch), and restored by undo/redo along with
the snapshot. Builds, bytecode (`revision` in Y3BC 3), traces, diagnostics and analysis
results carry it. A result whose revision is not the current one is stale: the model
reports it as stale instead of mapping it onto changed cells.

### Lifecycle
`open` (text, path, optional sidecar) → parse → identity layer → snapshot; `apply` /
`setText` / `undo` / `redo` → new snapshot and revision; queries and services read the
current snapshot and its lazily built compilation; `sidecar` serializes identity; `close`
forgets the document. The model owns its documents; the compiler and runtime never hold
a reference to it.

## Not in M10
No UI, renderer, LSP transport, async workers, collaboration or incremental parser.

## The API

Everything lives in `src/editor` (exported from the package as `editor`). An IDE imports
nothing else.

| Module | Holds |
|---|---|
| `ir/identity.ts` | the branded id types (`DocumentId`, `ModuleId`, `PlaneId`, `CellId`, `NodeId`, `ProgramRevision`) and `CellIds`; neutral: no imports, so the compiler can carry ids without knowing the editor |
| `editor/structure.ts` | a document's structure with ids, aligned one to one with the layout AST; `fromAst`, `toAst`, `attach` (ids onto a fresh parse), `reconcile` (raw text) |
| `editor/commands.ts` | the structural commands and the transaction draft that validates them |
| `editor/model.ts` | `ProgramModel`: lifecycle, transactions, history, builds, runs, source maps, queries |
| `editor/events.ts` | structured runtime events (`docs/v2-source-mapping.md`) |
| `editor/services.ts` | definition, references, rename, hover, completion, semantic tokens (`docs/v2-lsp-services.md`) |
| `editor/invariants.ts` | `modelViolations`: every invariant below, through the public queries |

Queries: `documents`, `getDocument`, `getModule`, `getPlane`, `getCell`, `cellAt(plane, x, y)`,
`spaceCellAt(document, x, y, z)`, `sourceSpanOf`, `elementAt`, `cellAtSourcePosition`,
`cellAtSourceOffset`, `hirNodesForCell`, `hirNode`, `statements`, `mirInstructionsForCell`,
`instruction`, `instructions`, `traceEvents`, `traceEventsForCell`, `diagnostics`, `build`,
`run`, `isCurrent`, `sidecar`. They return frozen plain data; no internal map escapes.
Definitions and references are services (`EditorServices.definitionOf(NodeId)`,
`referencesOf(NodeId)`, and by position or symbol).

### Invariants (checked after every edit, undo and redo in the tests)
- no two documents, modules, planes, cells or statements share an id;
- every cell is in exactly one plane, at the position the plane says, and `cellAt` agrees;
- every authored cell has a CellId; VOID (outside a plane's rectangle) has none; a cell is
  blank exactly when it has no statement NodeId;
- an inline plane is on exactly one floor; a callable plane on none; planes are non-empty
  rectangles;
- the source map sends each cell's span back to that cell;
- every HIR statement's provenance names an existing cell and that cell's current
  statement NodeId; so does every MIR instruction.

## Results

**Performance** (Node 24, synthetic programs of N floors of N×N cells, one third of them
sentences; global recompilation on demand):

| | 1 000 cells | 8 000 cells |
|---|---|---|
| open | 4 ms | 13 ms |
| first build (HIR, MIR, Y3BC 3) | 27 ms | 98 ms |
| edit one sentence (transaction, format, re-parse, attach) | 12 ms | 33 ms |
| rebuild after it | 13 ms | 56 ms |
| swap two cells | 10 ms | 23 ms |
| undo / redo | < 0.1 ms | < 0.1 ms |
| `getCell` for every cell | 12 ms | 17 ms |
| rename a noun read by a third of the cells (one transaction, checked) | 36 ms | 207 ms |
| `modelViolations` | 7 ms | 36 ms |

The first measurement found three quadratic paths (a linear `getCell`, a linear draft
lookup per command, a linear source-map search); each is now indexed per revision or per
draft, and an edit is linear in the document, as a whole-document recompile must be.

**Planted bugs.** Each was planted in a copy of the code, the editor suites run, and the
file restored. All 17 were caught (two only after their tests were sharpened):

| # | Bug | Caught by |
|---|---|---|
| 1 | MoveCell creates a new CellId | "MoveCell keeps the CellId…" |
| 2 | RenamePlane creates a new PlaneId | "ExtractNamedPlane keeps the PlaneId…", plane rename service |
| 3 | delete + undo regenerates CellIds | properties: "delete + undo restores ids exactly" |
| 4 | redo regenerates identities | "undo restores the exact prior model; redo the exact later one", fuzzing |
| 5 | blank cells treated as VOID | properties, fuzzing (invariants) |
| 6 | a source span mapped to the neighbouring cell | invariants (source map round trip) |
| 7 | HIR loses its CellId provenance | definition/references services |
| 8 | MIR maps to the wrong NodeId | invariants (MIR provenance) |
| 9 | a stale trace is mapped as current | "a trace from an older revision is stale" |
| 10 | rename ignores pattern shadowing | "renames a noun in its body only…" |
| 11 | inlined copies reuse the named plane's CellIds | "inlining a named plane makes copies" |
| 12 | the formatter becomes the identity source | rename and edit tests (statement ids) |
| 13 | a raw edit keeps a position's id in a resized plane | "a named plane resized by a raw edit…" (added after the first run missed it) |
| 14 | a failed transaction commits its earlier commands | "a transaction applies completely or not at all" |
| 15 | a new edit after undo keeps the redo branch | "a new edit after undo discards the redo branch", fuzzing |
| 16 | sidecar ids are not reserved (collisions) | "an identity sidecar brings ids back…" |
| 17 | Y3BC 3 accepts malformed identities | "Y3BC 3 refuses malformed identities" (added after the first run missed it) |

**Real bugs found.**
- A malformed identity sidecar crashed `open` with a `TypeError` deep in reconciliation;
  a sidecar is input, so it is now checked for shape and refused cleanly.
- The quadratic queries above.
- During development the services' call-head rename failed on `[합은 두배: 값]`: the
  parser keeps two readings of a call head, and renaming one of them in the expected
  sentence AST left the other stale. Both readings now follow the renamed word.

## Architecture audit

**1. What exactly is stable identity in Y3?** The model's ids for authored things:
documents, modules, planes, cells, statements and declarations (`ir/identity.ts`), kept
by `ProgramModel` across edits, undo/redo and (with a sidecar) sessions.

**2. Why are coordinates not identity?** Cells move (`MoveCell`, `SwapCells`, rows and
columns inserted before them); a named plane's cell is at several z positions at once;
coordinates are what an edit changes. Tests: "after a move, the source map follows the
cell, not the coordinates", "move and swap preserve CellIds".

**3. Where are IDs created?** Only in `ProgramModel` (`newId`): `fromAst` on open, `reconcile`
for unmatched elements, and the commands that create cells, planes and statements
(`Draft.fresh`, `InsertPlane`, `InlineNamedPlane`, `EditSentence` with new text).

**4. Where are IDs preserved?** In the structure through every command (`commands.ts`),
through serialization (`attach` copies ids onto the fresh parse; it never invents them),
through raw edits where `reconcile` is certain, through undo/redo (snapshots), and through
the compiler (provenance, debug map, Y3BC 3, trace entries).

**5. When are IDs intentionally regenerated?** New elements; copies (`CopyCell`,
`InlineNamedPlane`); a changed sentence's statement NodeId; anything reconciliation cannot
match with confidence.

**6. How does raw text editing reconcile IDs?** `reconcile` (structure.ts): planes by name,
identical content, then size-and-majority; cells by position-and-text, unique text, then
position in an unresized plane; declarations by text. Tests in "raw text…" and
"adversarial cases".

**7. What is the difference between DocumentId and ProgramRevision?** A DocumentId names a
logical document for its whole life; a ProgramRevision names one state of the whole model,
fresh on every change.

**8. How does a trace know which revision it belongs to?** `model.run` returns a `RunRecord`
with the build's revision; an artifact carries it in Y3BC 3 (`Loaded.revision`); every
structured event carries it. `traceEvents` reports `stale` when it is not current.

**9. Can old diagnostics attach to a new model?** Each `ModelDiagnostic` carries its
revision; `isCurrent(result)` is the contract an asynchronous analysis checks before
applying anything. Builds are cached per revision, so the current diagnostics are always
those of the current revision.

**10. Does undo restore exact identities?** Yes: it restores the snapshot object itself.
Tests: "undo restores the exact prior model", "delete, then undo, restores the very same
CellId", fuzzing compares full identity snapshots after every undo.

**11. Does redo restore exact identities?** Yes, the same way; the same tests.

**12. Can one CellId exist in two locations?** No. Placements of a named plane are one
authored cell; copies get new ids; the invariant "no two cells share an id" is checked
after every fuzzed operation.

**13. Can VOID have a CellId?** No. `cellAt` returns null outside a plane; a draft's VOID
holes are refused at commit; `MakeVoid` and `DeleteCell` end the id.

**14. Does the compiler depend on editor classes?** No. It carries `CellIds` from the
neutral `ir/identity.ts`; a test forbids any import of `src/editor` from the compiler,
runtime, language, semantics, types, space, temporal, stdlib, format, ir, tools and
container layers.

**15. Does the UI need to parse trace strings?** No: `runEvents` turns structured trace
entries, effects and host events into typed events with ids; human traces are rendered
from the same data.

**16. Can semantic rename accidentally rename shadowed or unrelated symbols?** References
come from HIR noun ids per body; pattern-bound locals are excluded; every rewritten
sentence must parse to exactly the expected sentence AST; the program must have no new
errors afterwards or the rename is undone. Tests: strings, pattern bindings, another
body's same-named noun, conflicts, capture.

**17. What does the future 3D IDE still need?** Expression-level MIR mapping (instructions
are mapped to statements, not to sub-expressions); token-level offsets inside sentences
from the parser (services find words by scanning the cell's text); an incremental
compiler; a sentence printer, so structural edits inside a sentence (not just renames)
can be made on the AST; an LSP transport; cross-document undo grouping per editor tab;
and a persistent sidecar policy for git workflows (merges).

## Decisions after review
1. **Token spans inside sentences** should come from the parser, not from editor word
   scanning. Word scanning is acceptable for M10; parser token spans are the next step
   before a serious LSP or IDE.
2. **Expression-level MIR provenance** is deferred: statement-level provenance is enough
   for the first 3D IDE, and Y3BC is not bumped for it unless debugger UX needs it.
3. **Undo history stays per model**, so a cross-document rename stays one atomic
   transaction.
4. **The identity sidecar stays optional and untracked by default**: editor metadata, like a
   cache. Git collaboration never depends on merging opaque ids. A merge strategy is
   designed only if persistent shared identity becomes a requirement.
5. **Brackets in `EditSentence`** are allowed inside literals: parser context decides, not
   raw characters (above).

The review also found that `EditSentence` collapsed whitespace with a regex over the
whole sentence, which changed text literals (`"a  b"` became `"a b"`), and that a raw
bracket ban rejected valid literals. Both were replaced by the parser-aware rule above.
The rename check compared error counts, which misses one error fixed while another is
made; it now compares errors by owner (below and in `docs/v2-lsp-services.md`).
