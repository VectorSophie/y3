# Y3 v2: the typed semantic core (M5)

M5 puts a typed semantic layer between Korean and execution. This layer is Y3's
equivalent of a compiler's HIR. Every later subsystem targets it: callable planes,
records, modules, a bytecode. The runtime no longer sees sentences.

```
.y3 source
  → layout AST                       language/document-parser
  → sentence AST                     language/sentence-parser   (Korean ends here)
  → HIR: resolved nouns and calls    semantics/elaborate
  → typed HIR                        types/check
  → spatial machine + temporal store runtime/interpreter, temporal/
```

The design rule is **weird control flow, boring values**: space and time may be strange,
but a value is an Int, a Text, a Bool, a Unit or a piece of plain data, and it never
turns into another kind by itself.

## Types

| Type | Values | Notes |
|---|---|---|
| `Int` | `bigint` integers | arbitrary precision (the numeric tower is M7) |
| `Text` | strings | |
| `Bool` | `참`, `거짓` | real booleans; nothing is truthy |
| `Unit` | `()` | the result of a call made for its effect |
| `Option<T>`, `Result<T, E>` | built-in sum types | no `null` |
| `?T1`, `?T2`, … | type variables | internal; solved by unification |

**No implicit conversions.** Int → Bool, Text → Int and the rest are all refused. A
comparison `Eq<T>(a, b) -> Bool` needs both sides to have the same `T`, so `3` against
`"3"` is a type error at `y3 check`, not a false comparison at run time.

**Inference** follows ML in spirit, but on purpose it is smaller and more predictable:
- **One type per noun.** A noun has a single type for the whole program (Go-style).
  Nothing is annotated: the first statement that pins the type decides it, and every
  other use must agree.
- **Clear errors.** An error names where the type came from:
  `'값' holds Int since [값은 3이다.] (line 2), not Text`.
- **No let-polymorphism.** The only polymorphism is in built-in signatures
  (`표준 줄출력 : T → Unit`) and in type definitions (`Option<T>`). Both are instantiated
  afresh at each use.
- **Open types are allowed.** A type left open by everything (a bootstrap value that
  is only printed) stays a variable. That is not an error.

```
[값은 미정이다.]   [값에 1을 더한다.]      → 값 : Int
[값은 미정이다.]   [값은 "이상"이었다.]    → 값 : Text
[값은 3이다.]      [값은 "셋"이다.]        → Y3Y001, refused by y3 check
```

## Type unknowns and temporal unknowns

The two kinds of unknown are kept apart:

| | Type unknown | Value unknown |
|---|---|---|
| written | `?T1` | `α1`, `β1`, `ε1` |
| owned by | the type checker (`types/`) | the temporal store (`temporal/`) |
| solved | before the run, by unification | during the run, by `A x = b` |
| from `[값은 미정이다.]` | `T(값)` | a fresh α |
| from `[값에 1을 더한다.]` | `T(값) = Int` | `값 := α + 1` |
| from `[값은 4였다.]` | `T(값) = Int` (agrees) | `α + 1 = 4` |

The two systems share no variables. They meet in exactly one rule:

> **A temporal value has type Int or Text.** These are the two sorts the temporal solver
> knows: Int goes into the integer matrix, Text into unification.

A `미정`, a channel or a `끝의` read of a Bool is refused at check (`Y3Y004`). The
temporal solver is unchanged.

## The typed IR

Every node carries its provenance:
- the source span;
- the plane (its floor, and its name if it was referenced from `※`);
- the cell coordinate;
- the sentence as written.

Every expression also carries its type. No node mentions particles or tense
morphology.

| Group | Nodes |
|---|---|
| expressions | `Literal`, `LoadNoun`, `LoadLocal`, `Add`, `Sub`, `Eq`, `Not`, `Call`, `TemporalAnchorRead` |
| algebraic data | `Construct`, `Field`, `Match` (with patterns) |
| statements | `StoreNoun`, `Eval`, `Branch` |
| space | `Move`, `Turn`, `FloorMove`, `Anchor`, `BackEdge`, `End` |
| time | `TemporalDeclare`, `TemporalAssert`, `TemporalPromise`, `TemporalReceive`, `TemporalSend`, `TemporalFixedPoint` |

Surface forms become ordinary nodes:

| Surface | HIR |
|---|---|
| `[값에 1을 더한다.]` | `StoreNoun 값 ← Add(LoadNoun 값, 1)` |
| `[값을 말한다.]` | `Eval Call std.io.println(값)`, the same call as `[표준 줄출력: 값]` |
| `[값이 3이 아니면 …]` | `Branch Not(Eq(값, 3)) → …` |
| past tense | `TemporalAssert` |
| future tense | `TemporalPromise` |

`y3 ir program.y3` prints the typed IR with its provenance:

```
(0,0,0) 5:1  TemporalDeclare 값#1
(0,1,0) 6:1  StoreNoun 값#1 ← Add(값#1 : Int, 1 : Int) : Int
(0,2,0) 7:1  Eval Call std.io.println(값#1 : Int) : Unit
(0,3,0) 8:1  TemporalAssert 값#1 = 4 : Int
(0,4,0) 9:1  End
nouns:
  값#1 : Int
```

The runtime executes HIR only. Tests replace a cell's HIR and the program does what
the IR says, whatever the cell's text reads. A layering test keeps `ir/`, `types/` and
`runtime/` from importing the sentence parser.

## Semantic versions

Surface Y3 looks mutable. Internally, each store, `미정` or receive defines a new
*version* of a noun, in SSA style:

```
[값은 3이다.]       값₀ = 3
[값에 1을 더한다.]   값₁ = 값₀ + 1
```

- A run reports every version with the step that defined it and the steps that read
  it (`ProgramResult.versions`): a def-use chain.
- A `처음` snapshot is a map from nouns to versions. Fixed points compare versions,
  not copies of the machine.
- This is a semantic model, not yet bytecode. φ-like merges arrive with a static
  control-flow graph.

## Algebraic data types

The type representation has sum types (tagged unions of variants) and product types
(records of named fields), with type parameters:

```
Option<T>    = Some(T) | None
Result<T, E> = Ok(T) | Err(E)
```

`Construct` builds a variant or a record, `Field` reads a record field, and `Match`
chooses an arm by pattern. The patterns are:
- wildcard `_`;
- a binding;
- a literal;
- a variant with sub-patterns;
- a record with sub-patterns.

The checker requires every match to be exhaustive. It must have a catch-all arm, or
cover every variant of a sum, or cover both `참` and `거짓`. It also requires all arms
to share one type.

M5 has no source syntax for these. They are built and tested at the IR level, and M6
gives them surface syntax without changing the IR or the checker.

## Colon calls

```
[표준 줄출력: 값]
[크기는 수학 절댓값: 값]
[큰것은 수학 최댓값: 크기, 10]
[값이 3이면 표준 줄출력: "셋"]
```

- **The colon is a call boundary**, not prose. Its full stop is optional.
- **Arguments** are separated by commas. Commas and colons inside quoted text belong to
  the text.
- **A call goes through each stage:**
  - parse (`CallAst`);
  - name resolution (namespace, then callable);
  - signature resolution (instantiating type parameters);
  - type checking;
  - execution.
- **Pure callables need concrete arguments.** A call on an open temporal symbol is
  `UNRESOLVED`, like a branch: the present never waits for the future.

| Namespace | Callable | Signature | Id |
|---|---|---|---|
| `표준` | `줄출력` | `T → Unit` | `std.io.println` |
| `수학` | `절댓값` | `Int → Int` | `std.math.abs` |
| `수학` | `최댓값` | `Int, Int → Int` | `std.math.max` |

## Diagnostics

| Code | Meaning |
|---|---|
| `Y3Y001` | type mismatch |
| `Y3Y002` | unknown namespace or callable |
| `Y3Y003` | wrong number of arguments or fields |
| `Y3Y004` | a temporal value that is not Int or Text |
| `Y3Y005` | a match that is not exhaustive |
| `Y3Y006` | unknown type, variant, field or local |
| `Y3G012` | a malformed call |

## What changed for existing programs

- **Now refused by `y3 check`.** These were errors that M2–M4 found at run time (or
  answered with a false comparison):
  - a comparison of Int with Text;
  - arithmetic on Text;
  - a noun that holds Int in one place and Text in another;
  - a symbol that is both a number and text.
- **Unchanged.** Every other M2–M4 program and every golden trace is byte-identical.
- **New reserved words.** `참` and `거짓` can no longer name a noun.
