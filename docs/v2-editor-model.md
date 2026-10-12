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
| `EditSentence` | same CellId; a new statement NodeId when the sentence changes |
| `InsertRow`/`DeleteRow`/`InsertColumn`/`DeleteColumn` | new blank cells get new ids; deleted cells end |
| `InsertPlane` | new PlaneId, blank cells with new ids |
| `DeletePlane` | the PlaneId and its CellIds end; a named plane that is still placed or called is rejected |
| `MovePlane`/`MoveLayer` | same ids |
| `RenamePlane` | same PlaneId; every `⟦ :name: ⟧` and call site follows; a conflicting name is rejected |
| `ExtractNamedPlane` | a whole inline floor becomes a named plane: same PlaneId, same CellIds; the floor becomes a reference (a placement, no id) |
| `InlineNamedPlane` | the floor gets a new inline plane: new PlaneId, new CellIds (copies) |

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
