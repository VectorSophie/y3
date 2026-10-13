# Y3 v2: semantic services (M10)

`EditorServices` (`src/editor/services.ts`) answers the questions an editor or a future LSP
server asks. It reads the `ProgramModel` and its current build. Names are resolved by the
compiler's own results, and text is never searched:
- HIR noun ids per body;
- callable plane ids, mapped to PlaneIds through the procedures' cell identities;
- the declared types;
- the standard library registry.

There is no LSP transport in M10. Each service is a plain function of the model.

## Symbols

`symbolAt(document, line, column)` finds the word under the cursor in the element at that
position. It then tries the word and its stems with one particle or ending removed
(`값은` → `값`). Each candidate is resolved in this order:
1. a callable after a namespace (`표준 줄읽기`);
2. a pattern-bound local of the cell;
3. a noun the cell's statement actually reads or writes (by noun id);
4. a callable plane the statement calls;
5. an import alias;
6. a constructor (user-declared or built-in);
7. a record field.

On declarations and plane heads, it finds types, variants and fields. `symbolOfNode(NodeId)`
does the same from an HIR node.

| Symbol | Identity |
|---|---|
| `noun` | document, body (`main` or the callable's id) and noun id: the same spelling in another body is another noun |
| `local` | a match-pattern binding, scoped to its arm |
| `plane` | the PlaneId |
| `type`, `variant`, `field` | the declared type in its document |
| `module` | an import alias in a document |
| `builtin` | the standard library id (`std.io.readLine`) |

## Definition and references

| Symbol | Definition | References |
|---|---|---|
| noun | the first statement, in source order, that introduces it (`nounsIn`) | every statement of its body whose HIR mentions the noun id |
| plane | the plane's span | cells whose `CallPlane` targets it (in every open document), and its placements |
| type / variant / field | its declaration | declarations mentioning it; statements constructing, matching or selecting it |
| module | the imported document | cells that use the alias |
| builtin | none (no source) | statements calling it |

`definitionOf(NodeId)` and `referencesOf(NodeId)` are the NodeId forms.

## Rename

`rename(symbol, newName)` builds one transaction of structural commands:
- `EditSentence` for each affected cell;
- `RenamePlane`;
- `EditDeclaration` and `EditSignature`.

It applies the transaction, then compares errors by owner: document, code, and the cell
(else the plane, else the file). The count alone is not enough, because one error fixed
while another is made leaves it unchanged. If any owner has more errors than before, the
service undoes the rename and refuses it. Messages and spans are not part of the key,
because the rename itself changes them.

Supported targets:
- **Nouns.** Every cell of the noun's body, and the callable's signature when the noun is a
  parameter. Pattern-bound locals of the same spelling are left alone. A new name that a
  pattern would capture is refused, and so is one that already names a noun there.
- **Callable and named planes.** The definition, its placements (they follow the PlaneId),
  and every call site. That includes call sites in importing documents, which use
  `[별칭 이름: …]`.
- **Types.** Declarations and signatures in the module, and, for a record, the calls that
  construct it.

A sentence is never edited by text substitution alone. The service computes the sentence
AST it should have, with the symbol renamed where it means the symbol. It then tries every
combination of the occurrences of the old spelling: skipped, renamed with the particle
re-chosen for the new name's final sound (`값은` → `수는`), or renamed as written. It keeps
the first combination that parses to exactly that AST. Strings, comments, fields and
other symbols are therefore never touched.

## Hover

The text is deterministic and comes from static information only:
- a noun: its type and its temporal role from its statements, such as `temporal unknown
  (미정)`, `stated in the past` or `receives a value from later`;
- a callable plane: its signature;
- a named plane: its size and floors;
- a type, variant or field: its declaration;
- a module: its manifest name and path;
- a built-in: its signature from the registry.

## Completion

The candidates depend on where the cursor is:
- after a namespace: its callables;
- in a declaration: types;
- in a cell:
  - the nouns of the cell's body;
  - the module's callable planes;
  - import aliases and standard namespaces;
  - constructors, types and fields.

There is no ranking. Results are sorted by kind, then label.

## Semantic tokens

`semanticTokens(document)` returns `{ line, column, length, type }` with these types:

| Group | Types |
|---|---|
| words | `keyword`, `temporal` |
| names | `type`, `module`, `plane`, `callable`, `noun`, `field`, `variant` |
| other | `literal`, `comment` |

Words in cells are classified by the same resolution as `symbolAt`. Literals are numbers,
strings and runes. Comments run from `#` outside a string to the end of the line. No
colours are chosen here.

## Freshness

Every service reads the model's current revision. An asynchronous caller that has to
apply a result later should record `model.revision` when it starts, and use the result
only if `model.isCurrent({ revision })` still holds.
