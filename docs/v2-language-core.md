# Y3 v2: the general language core (M6)

M6 adds ordinary programming-language abstractions around the spatial and temporal
core: callable planes, records, sums and matches, arrays and slices, and modules. The
rule from M5 still holds: **weird control flow, boring values**. Nothing in M6 changes
how space moves or how time constrains. Every M2–M5 golden trace is byte-identical.

```
.y3 source
  → layout AST            document-parser: planes, ※ section, signatures, 자료 lines
  → sentence AST          sentence-parser: Korean ends here
  → HIR                   semantics/elaborate: names resolved per module and body
  → typed HIR             types/check: one checker per body
  → runtime               runtime/interpreter (frames) + machine (spaces) + temporal store
```

## Four things kept apart

| Thing | What it is | Created by | Scope of names |
|---|---|---|---|
| **module** | a `.y3` file; a namespace for types and callable planes | `[imports]` in the manifest | its own declarations, plus imports by alias |
| **named plane** | a floor plan placed in the volume (`⟦ :이름: ⟧`) | composition | the main body's nouns: placing a plane adds floors, not a scope |
| **callable plane** | a named plane with a signature | `[f: …]` | its own nouns, in a frame of its own |
| **jump** | a back-edge to an anchor in the same space | `끝은 처음이다` | nothing: no frame, no new nouns |

A callable plane cannot be placed in the volume (`Y3V004`), and a plane without a
signature cannot be called. Composition and calls never meet.

## Callable planes

A signature sits between a plane's name and its `⟦`:

```
※

:제곱: (수: Int) → Int ⟦
[곱은 0이다.]
[번은 0이다.]
[여기가 처음이다.]
[곱에 수를 더한다.]
[번에 1을 더한다.]
[번이 수가 아니면 끝은 처음이다.]
[곱을 돌려준다.]
⟧

:합차: (가: Int, 나: Int) → (Int, Int) ⟦ … ⟧     several results
:인사: () ⟦ … ⟧                                   no arrow: returns Unit
```

- **Types are explicit in signatures** (Go-style). Bodies are checked against them, so
  calls, recursion and mutual recursion need no inference across bodies. Signatures are
  monomorphic; only built-in types and `자료` declarations take type parameters.
- `->` is accepted for `→`; `fmt` writes `→`.

### Calling and returning

| Sentence | Meaning |
|---|---|
| `[제곱: 7]` | call; discard any results |
| `[결과는 제곱: 7]` | call; the result goes to 결과 |
| `[몫과 나머지는 나눗셈: 7, 2]` | several results, in order (과/와 joins nouns) |
| `[a는 기하 넓이: p]` | call into the module imported as 기하 |
| `[x를 돌려준다.]`, `[x와 y를 돌려준다.]` | return values |
| `[돌아간다.]` | return nothing (Unit) |

- One receiving noun for a plane that returns nothing gets `()`.
- A noun cannot receive two results of one call (`[a와 a는 f: 1]` is refused).
- Only a callable plane returns (`Y3C001`), and only the main volume ends with `끝이다`
  (`Y3C002`). A callable plane that walks off its edge is `VOID`, like the volume.

### Frames

A call is a step: the call cell runs, then the pointer stands on the callee's first
cell. Return is also a step: the return cell runs, then the pointer stands on the cell
after the call. A **frame** holds:

- the **return pose**: the call cell's position and *full* orientation (forward and up);
- the **arguments**, bound as the callee's parameter nouns;
- the callee's **locals**: its own nouns and versions;
- its **cycles** (anchors) and **channels**;
- its root temporal scope, the call (see below);
- where the **results** go: the caller's nouns.

On return, the pointer goes to `nextPose(return pose, nop)`: one cell along the
caller's own forward, facing exactly as the caller did, whatever the callee did to its
own orientation. A test checks this for all 24 orientations. Falling off the caller's
plane at that point is `VOID` in the caller's space.

Callees start at their plane's `(0,0)`, facing 남, up 위. A callee is one floor (its
plane is z = 0); `층` moves inside a call are `VOID`.

The spatial machine knows only that `call` and `return` move the pointer into another
space. Frames, values and results belong to the interpreter. Recursion needs no host
stack: frames are explicit, and the step limit bounds them (each call takes a step).
Trace lines name the activation: `누적#3(0,4,0)`.

**A call is not a jump.**
- A back-edge in a callee returns only to the callee's own anchors. With none open,
  it is a `FAULT`, not a way out to the caller's loop.
- Anchors, `처음` snapshots and channels are per frame.

### Lexical scope, call frames, temporal scope, spatial region

| | Lifetime | Boundary |
|---|---|---|
| lexical scope | the program text | a body: the main volume (all its floors, including placed named planes) or one callable plane |
| call frame | one activation | call to return |
| temporal scope | an iteration, a call, or the run | `여기가 처음이다` … iteration end; call … return; start … `끝이다` |
| spatial region | — | a plane; coordinates never decide which nouns are visible |

- A noun is visible everywhere in its body, whichever cell it is written in.
- A callee cannot see the caller's nouns. The same name in two bodies is two nouns,
  with two types.
- A match arm's bindings are visible only in that arm.
- **Temporal lifetime is not lexical lifetime.** Symbols (α, β, ε) live in the
  temporal store, not in frames:
  - a symbol can be passed into a call, computed on, returned, and determined after
    the frame is gone;
  - a symbol born in a callee can be resolved by the caller's testimony;
  - a channel can close through a call (β = 2β, self-caused 0).
- What a frame *does* own is its obligations. A promise, `끝의 N` or `처음은 끝이었다`
  made in a callee with no open cycle falls due when the call returns, its "end".
  Returning from inside a loop first closes the loop.
- Channels belong to a frame's nouns. A callee cannot close its caller's channel (that
  is a `PARADOX`: no past in this frame is listening). A channel left open in a callee
  is reported unanswered at return.

## Records and sums

Type declarations are one-line `자료` items in the ※ section:

```
자료 점 = { 가로: Int, 세로: Int }
자료 모양 = 원(Int) | 사각(Int, Int) | 빈모양
자료 쌍<A, B> = { 첫: A, 둘: B }
자료 목록 = 마디(Int, 목록) | 끝마디            recursive types are fine
```

| Sentence | HIR |
|---|---|
| `[위치는 점: 1, 2]` | `Construct 점(1, 2)`: positional, in declaration order |
| `[도형은 원: 5]`, `[o는 Some: 3]` | `Construct` of a variant |
| `[빈것은 빈모양이다.]`, `[x는 None이다.]` | a variant with no fields is a plain word |
| `위치의 가로` | `Field` |
| `[위치의 가로는 3이다.]` | `StoreNoun 위치 ← SetField(위치, 가로, 3)` |
| `[위치의 가로에 1을 더한다.]` | the same, around an `Add` |

**Values are values.** Writing a field makes a new record, which is a new version of
the noun. Any other noun that held the old record still holds it. There are no classes
and no inheritance.

**Constructors** are visible in their module unqualified, and through an alias outside
it (`[p는 기하 점: 1, 2]`). A constructor's name never names a noun (`None은 3이다` is
refused), so a word means the same thing wherever it is written.

## Matches

```
[넓이는 도형에 따라: 원(r) → r, 사각(w, _) → w, 빈모양 → 0]
[값은 찾음에 따라: Some(n) → n, None → 0]
[k는 m에 따라: 기하 원(r) → r, 기하 없는모양 → 0]
```

- **Patterns:** a wildcard `_`, a binding, a literal (Int, Text, 참/거짓), a variant
  with sub-patterns, or a record with positional sub-patterns.
- **Exhaustive where it can be known** (`Y3Y005`). The check looks through nesting, so
  `Some(참) | Some(거짓) | None` covers `Option<Bool>`. A missing case is named
  (`사각(_, _), 빈모양`).
- **Unreachable arms** are warnings (`Y3Y008`).
- **Bindings:** each name once per pattern (`Y3Y007`). They are visible in their arm
  only.
- Arm bodies are plain expressions: literals, nouns, locals, fields, elements.

## Option and Result: ordinary errors are values

There is no null and no exception for ordinary failure. A plane that can fail returns
`Result<T, E>` or `Option<T>`, and the caller matches it:

```
:나눔: (수: Int, 나눌수: Int) → Result<Int, Text> ⟦
[r은 Ok: 수]
[나눌수가 0이면 r은 Err: "0으로 나눌 수 없다"]
[r을 돌려준다.]
⟧
```

Machine outcomes stay separate, and they are not values:
- `HALT`, `VOID`, `STEP_LIMIT` and `FAULT` belong to the machine;
- `PARADOX`, `UNRESOLVED` and `AMBIGUOUS` belong to time.

A `FAULT` is a broken program (an index out of range), not a recoverable error.

## Arrays and slices

| Sentence | Type | Meaning |
|---|---|---|
| `[수들은 배열: 1, 2, 3]` | `[Int; 3]` | an array owns its elements |
| `수들의 0번`, `수들의 i번` | `Int` | an element (zero-based) |
| `[수들의 1번은 99이다.]` | | a new array with one element replaced |
| `[가운데는 배열 자르기: 수들, 1, 3]` | `[]Int` | a slice: a view of elements [1, 3) |
| `[n은 배열 길이: 가운데]` | `Int` | length of an array or a slice |

- **An array owns its storage. A slice is a view of storage.** Storage is never
  mutated: writing an element makes a new array, so a slice keeps seeing the array
  version it was taken from. A slice of a slice views the same array.
- **Slices are read-only.** Writing through one is refused at check (`Y3Y001`). Writing
  through a shared view would make aliasing visible, and the value model has none. That
  is a question for M7's memory model.
- Indexes and slice bounds are checked when the program runs. Out of range is a
  `FAULT`, never a wrapped value.
- The element type and `N` are part of the type: `[Int; 3]` and `[Int; 4]` differ.
- Arrays pass to callable planes by value.

## Modules

```
+++
[imports]
"기하" = "lib/geometry.y3"
+++
```

- **A module is a file**: a namespace for its `자료` types and callable planes.
  - Paths live in the manifest only, never in sentences.
  - A path is relative to the importing file.
  - TOML needs quotes around a Korean key.
- **A library module** has a ※ section and no volume. `y3 check` accepts it, and
  `y3 run` explains that it has nothing to run.
- **An imported module's volume is never run.**
- **A module is known by its manifest `name`**, or else its file name. Its types are
  qualified in messages and in the IR: `기하.점`, `기하.넓이`.
- **Refused:**
  - an import cycle (`Y3C009`);
  - a missing module (`Y3C008`);
  - an alias that is reserved, a built-in namespace (`표준`, `수학`, `배열`), or ends
    in `의` (`Y3C010`).
- Errors in an imported module are reported under its path.

**Reading a call head.** `[길이 계산: 3]` can be read two ways: module `길이` plus
callable `계산`, or noun `길` receiving the result of `계산`. Morphology alone cannot
choose, so the parser keeps both readings and name resolution decides:

1. A reading **resolves** when its callee names something that exists: a callable
   plane, a constructor or a built-in, in the named module if it has one.
2. The namespaced reading is taken if it resolves; otherwise the plain one.
3. If **both** resolve, the program still compiles, with a warning (`Y3C011`) that
   names both readings and the one taken. Without the warning, adding an import could
   silently change what an existing sentence means.
4. An import that does not have the callable cannot capture a sentence: it does not
   resolve, so the plain reading stands.
5. Orthography lint belongs to a reading. `나이` is non-canonical as `나` + `이` (write
   `나가`), but as a namespace it is just a name, so the lint is reported only when the
   plain reading is taken.

There is no extra qualification syntax. The choice depends only on which names exist,
so formatting and the order of imports never change it.

## Data values are concrete, for now

Records, variants and arrays are built from concrete values. Building one from an open
temporal symbol needs that symbol's value now, so the run stops `UNRESOLVED`, exactly
like a branch. Temporal values remain Int or Text (`Y3Y004`). Symbolic data is not
planned: the solver stays `A x = b` over integers, and text unification.

## Diagnostics added in M6

| Code | Meaning |
|---|---|
| `Y3C001` | a return outside a callable plane |
| `Y3C002` | `끝이다` in a callable plane |
| `Y3C003` | several results from something that is not a callable plane |
| `Y3C005` | a malformed signature, or a duplicate or reserved parameter |
| `Y3C006` | a malformed `자료` declaration |
| `Y3C007` | a type, constructor or plane name defined twice, or clashing |
| `Y3C008` | a module that cannot be found |
| `Y3C009` | an import cycle |
| `Y3C010` | an alias that cannot name a module |
| `Y3C011` | a call head that two readings resolve (warning) |
| `Y3G013`, `Y3G014` | a malformed match, a malformed return |
| `Y3S023`, `Y3S024` | a misplaced signature, a declaration with no name |
| `Y3V004` | a callable plane placed in the volume |

## Intentional changes to earlier behaviour

- **A document may have no volume** if it has a ※ section: a library module. M0
  refused `※` before any plane (`Y3S011`).
- **New words.** `과/와` is a particle (lint: 과 after a consonant), and `돌려준다`,
  `돌아간다` and `에 따라` are sentence forms. `X의 Y` now reads a field (or `X의 n번`,
  an element) whenever X is not `처음` or `끝`.
- **New IR.** The sentence AST's call has readings instead of a single namespace.
  `ProgramTraceEntry` and `VersionSummary` carry the frame. `CompiledProgram` carries
  `procedures`.

## Design audit (M6)

**Does call semantics collapse into jump semantics?** No.
- A call is its own instruction, `call`, and pushes a frame.
- A jump never leaves its space and never touches frames.
- A back-edge in a callee cannot reach the caller's anchor.
- A planted bug that shared the caller's cycle stack with the callee was caught.

**Can temporal identities survive calls?** Yes.
- Arguments pass their terms through unchanged: `call 하나더#1(수 := α1)` returns
  `α1 + 1`, which the caller's past tense later settles.
- A planted bug that forced arguments to be concrete was caught (5 tests).

**Can locals leak?**
- Bodies have separate noun tables, so a callee that reads a caller's noun is refused
  at check.
- Frames have separate version maps.
- Results are written only to the nouns the call names.
- A planted bug that shared the caller's version map was caught.

**Can recursion corrupt spatial orientation?**
- Every frame keeps its own return pose.
- The 24-orientation property test, a recursive test that turns in every activation,
  and a pitched/rolled caller all hold.
- Two planted bugs were caught: one returned with the callee's orientation (3 tests);
  the other restored forward but lost up (21 tests).

**Are modules confused with planes?** No.
- A module is a file and a namespace. A plane is spatial code inside one.
- An imported module's volume never runs.
- A placed plane is composition; a callable plane is a call. The compiler refuses
  any mix of the two.

**Are ADT values concrete-only, explicitly?** Yes.
- This doc says so, and a test checks that `[o는 Some: 값]` on an open α is
  `UNRESOLVED`.

## Open questions

1. **Callees are one floor.** A callable volume (several floors) would need a way to
   name its floors. Placing named planes inside a callable is the obvious candidate.
2. **Comparisons beyond `=`** (`보다 크면`) are not in the core yet. Loops that count
   are written with `=`/`≠`. M7's numeric tower is the natural place for ordering.
3. **Field-by-name construction** (`점: 가로 1, 세로 2`) would read better than
   positional construction for wide records.
4. **Pattern-conditional sentences** (`[결과가 Err(e)이면 동쪽을 본다.]`) would make
   variant dispatch spatial. Today a match yields a value, and a branch tests it.
5. **Canonical declarations.** `fmt` collapses whitespace in `자료` lines and
   canonicalises a signature's arrow, but does not re-render either from its parse.
