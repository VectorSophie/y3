# Y3 v2: the runtime and value model (M7)

M7 makes Y3's values conventional and explicit, and leaves space and time alone:
**weird control flow, boring values.** This document defines the language semantics.
The TypeScript implementation is described only where it is part of the contract.

## 1. Numbers

### 1.1 Types

| Type | Values |
|---|---|
| `i8` `i16` `i32` `i64` `i128` | two's-complement ranges: −2ⁿ⁻¹ … 2ⁿ⁻¹ − 1 |
| `u8` `u16` `u32` `u64` `u128` | 0 … 2ⁿ − 1 |
| `bigint` | every integer: arbitrary precision |
| `f32` `f64` | IEEE 754 binary32 and binary64 |

M6's `Int` is gone. Its literals are now `i64` (§1.2), and its temporal uses are now
`bigint` (§1.8).

### 1.2 Literals

- An **integer literal** (`3`, `-7`) has no type of its own. It takes the integer
  type its context requires, any width or `bigint`. With no such context it is
  **`i64`**. It never becomes a float: write `3.0`.
- A **float literal** (`1.5`, `-0.0`) takes `f32` or `f64` from context, and is
  **`f64`** otherwise.
- A **suffix** fixes the type: `255u8`, `-1i128`, `10bigint`, `1.5f32`.
- **A literal must fit its type**, and this is checked before the program runs:
  `300u8`, and `-1` where a `u8` is needed, are refused (`Y3N001`). An `f32` literal is
  rounded to the nearest `f32`.

"Context" is ordinary inference: every use of a value must agree on its type. If a
noun is passed to a parameter of type `u8`, a literal written into that noun is a
`u8`.

### 1.3 No implicit conversion

Arithmetic and comparison need both operands to be the same numeric type. `i32 + i64`,
`i64 + f64` and `u64 = i64` are type errors. A conversion is always a call:

```
[y는 변환 i64: x]        x of any numeric type → i64
[f는 변환 f64: n]
[k는 변환 bigint: n]
```

| From → to | Rule |
|---|---|
| integer → integer (any width, or bigint) | exact; **FAULT** if the value does not fit |
| integer → float | rounds to nearest, ties to even (IEEE); always succeeds, may lose precision |
| float → integer | truncates toward zero; **FAULT** for NaN, ±∞, or out of range |
| f64 → f32 | rounds to nearest, ties to even; overflow gives ±∞ |
| f32 → f64 | exact |

Converting a value that does not fit is treated like overflow (§1.4): a broken
program, not an input error. Text that should hold a number is parsed into a `Result`
instead (`글 정수로`, see the standard library).

### 1.4 Checked arithmetic

| Operation | Sentence | Integers (fixed width) | bigint | Floats |
|---|---|---|---|---|
| add | `N에 E을 더한다` | exact or **FAULT** | exact | IEEE, rounded to the type |
| subtract | `N에서 E을 뺀다` | exact or **FAULT** | exact | IEEE |
| multiply | `N에 E을 곱한다` | exact or **FAULT** | exact | IEEE |
| divide | `N을 E로 나눈다` | truncates toward zero; **FAULT** on ÷0 and on MIN ÷ −1 | truncates; **FAULT** on ÷0 | IEEE (÷0 gives ±∞ or NaN) |
| remainder | `[r은 수학 나머지: a, b]` | sign of the dividend; **FAULT** on ÷0 | same | not defined (type error) |

Fixed-width integers **never wrap**. A result outside the type's range ends the run
with `FAULT` (`i8 overflow: 127 + 1`). `FAULT` is the machine outcome for a broken
program; it is not a `Result`, and nothing can catch it (§5). The policy is a property
of the operation and its operand type, `(add, i8)`, not of how it is executed, so a
later bytecode or WebAssembly backend must produce the same outcome at the same step.

### 1.5 Floats

| Question | Answer (IEEE 754, stated) |
|---|---|
| NaN | produced by `0.0 / 0.0`, `∞ − ∞`, `수학 제곱근` of a negative number |
| infinity | produced by overflow and by dividing a non-zero value by ±0 |
| equality | IEEE: `NaN = NaN` is false; `-0.0 = 0.0` is true |
| ordering | IEEE: every comparison with NaN is false |
| f32 | every operation computes in binary64, then rounds to binary32 once. For +, −, ×, ÷ and √ this equals binary32 arithmetic (double rounding is innocuous at these widths) |
| printing | shortest decimal that reads back to the same value; integral values end in `.0`; `NaN`, `+Inf`, `-Inf`, `-0.0` |

Because NaN is not equal to itself, floats are excluded from pattern literals and from
map keys and set elements (§4). A record holding a NaN is not equal to itself either.
Equality is structural, and IEEE all the way down.

### 1.6 Ordering

```
[수가 3보다 크면 …]          >
[수가 3보다 작으면 …]        <
[수가 3보다 크거나 같으면 …]  >=
[수가 3보다 작거나 같으면 …]  <=
```

Ordering is defined for numbers of the same type and for runes (by scalar value). It
needs concrete values: ordering an open temporal symbol is `UNRESOLVED`, like any
other branch on the future. An ordering is only a condition. It feeds the existing
spatial branch (`… 끝은 처음이다`, `… 동쪽을 본다`), and there is no general `if`.

### 1.7 Representation (implementation, not semantics)

All integer types are held as JS `bigint` and range-checked after every operation, so
the arithmetic itself can never overflow. Floats are JS numbers, with `Math.fround`
after each `f32` operation. The semantics above are stated without reference to
these choices.

### 1.8 The temporal numeric boundary

The temporal solver is `A x = b` over the unbounded integers. Fixed-width arithmetic
is not unbounded-integer arithmetic. `α + 1` on an `i8` faults when α = 127, and the
solver cannot know that. Treating them as the same would let the solver "prove" a
value that the program's own arithmetic would have rejected.

So, the smallest correct rule:

> **A temporal value is `bigint` or `Text`.** A noun declared `미정`, received from a
> channel, or read as `끝의 N` must have one of these types (`Y3Y004`). An integer
> literal used with such a noun is a `bigint`.

Consequences:
- Symbolic arithmetic exists only on `bigint`, where it agrees exactly with the
  solver. No range constraints are invented.
- `i64`, the floats, runes, booleans, data, collections, files and clock readings
  never become symbols. A temporal noun is passed to an `i64` parameter only through
  an explicit `변환 i64` call. That call needs a concrete value, so on an open
  symbol it is `UNRESOLVED`.
- A past or future statement about a non-temporal noun (`[n은 3이었다.]` on an
  `i64`) is a check between two concrete values. It never reaches the solver.
- Programs from M3–M6 keep their traces: their temporal nouns were already used only
  with literals and with each other, and those now infer `bigint`.

## 2. Text and runes

- **`Text`** is a sequence of Unicode scalar values (U+0000–U+10FFFF, no surrogates),
  stored as UTF-8. Source files, stdin and files are decoded as UTF-8. A file that is
  not valid UTF-8 is an `Err(Other(…))` when read as `Text`, never a silently repaired
  string. (Interactive stdin replaces invalid bytes with U+FFFD; this is noted as a
  limit, not a semantic.)
- **`Rune`** is one scalar value (Go's `rune`, Rust's `char`). It is written `'가'`,
  `' '`, `'\n'`, `'\t'`, `'\\'` or `'\''`. Runes are ordered by scalar value, and
  `글 문자: n` makes one from a `u32`. Surrogates and values above U+10FFFF give
  `None`.
- **Three different lengths**, never confused:

  | | Counts | `"é😀가"` |
  |---|---|---|
  | `글 길이` | runes (scalar values) | 4 |
  | `글 바이트길이` | UTF-8 bytes | 10 |
  | `글 글자수` | grapheme clusters (UAX #29, as the host's ICU segments them) | 3 |

- **No direct indexing.** `s의 0번` is refused for `Text`. `글 자르기: s, a, b` takes
  runes `[a, b)`, and `글 문자들` gives the runes as a `List<Rune>`. A position never
  counts UTF-16 units or bytes; that would make JavaScript's representation the
  language's semantics.
- **Escapes** in a text literal are `\n`, `\t`, `\\` and `\"`; in a rune literal,
  `\n`, `\t`, `\\` and `\'`. Any other backslash is refused (`Y3G003`). (Before M7 a
  backslash kept the next character as written, so `"\n"` was `n`; nothing relied on
  that.)
- Text equality is scalar-by-scalar. There is no normalisation: `"é"` and
  `"é"` are different texts. Ordering is not defined on `Text` (compare runes,
  or keep a `Map`).

## 3. Values

**Value semantics everywhere.** Assigning, passing or storing a value copies it, as
far as the program can tell. No operation on one name changes what another name holds.

| Category | Values | Model |
|---|---|---|
| scalars | integers, floats, `Bool`, `Rune`, `Unit` | immediate |
| records, variants | `자료` types, `Option`, `Result`, errors | value: a field write builds a new record |
| arrays `[T; N]` | own their elements | value: an element write builds a new array |
| slices `[]T` | a **persistent view** of one array version | read-only; see below |
| `Text`, `List`, `Map`, `Set` | heap-backed | value: every update returns a new collection |
| `File` | a handle on an outside resource | the one reference: copies name the same open file |

**Slices.** M6 said a slice "views storage". Under value semantics that phrase could
suggest mutable aliasing, so here it is exactly: storage is never mutated, so a slice is
a persistent view of the array version it was taken from. Writing the array afterwards
makes a new version; the slice keeps the old one. Writing through a slice is refused.
There is no mutable aliasing anywhere in the language, and so no aliasing questions for
a borrow checker to answer.

**Equality** is structural for all values and IEEE for floats: a record holding a
NaN is not equal to itself. `File` handles are equal when they are the same handle.

**Keys.** `Map` keys and `Set` elements must be *key types*: integers, `Bool`, `Text`,
`Rune`, `Unit`, and records and variants made only of those. Their equality is
reflexive and structural, so a key always finds itself. Floats, arrays, slices,
collections and files are refused at check (`Y3N002`). Iteration order is insertion
order.

## 4. Memory

- The runtime is garbage collected. Values are allocated as needed and reclaimed when
  unreachable. There is no ownership, no borrowing, no `free`, and no observable
  object identity (except `File` handles).
- The implementation copies a collection on every update, which is O(n) per update and
  quadratic for a growing collection. This is a performance ceiling, not a semantic:
  persistent data structures would keep the same semantics.
- **Heap lifetime is not temporal lifetime.** A temporal symbol (α, β, ε) is not a
  pointer and owns no storage. It lives in the temporal store from its birth to the end
  of the run, whatever frames come and go, and it may be determined after every value
  that mentioned it is gone. A determined symbol is a number or a text, with no
  identity: two symbols determined to 3 are just 3.

## 5. Errors

| Kind | Mechanism | Examples |
|---|---|---|
| **ordinary, recoverable** | a value: `Result<T, E>` or `Option<T>`, matched with `에 따라` | a missing file, text that is not a number, an absent map key |
| **a broken program** | `FAULT`: the run ends at that cell | overflow, division by zero, an index out of range, a failed conversion, `결과 꺼내기` on `Err` |
| **space** | `VOID`, `STEP_LIMIT` | walking off a plane |
| **time** | `PARADOX`, `UNRESOLVED`, `AMBIGUOUS` | an inconsistent past |

Nothing converts between the rows. A `Result` never becomes a `FAULT` unless the
program asks for it with `꺼내기`. A `FAULT` cannot be caught. The standard library's
error types are ordinary data: `FsError` and `ParseError` (§6 of the library document).

## 6. Effects

**Pure values** are everything except effects. **Effects** reach outside the program:
stdout, stdin, files and clocks. Every effect goes through the runtime's `Host`; the
interpreter never touches the outside world itself.

| Effect | Commits | Arguments |
|---|---|---|
| stdout (`출력`, `줄출력`, `말한다`) | in program order, as soon as every earlier write is known | may be symbolic: the write is **held** until its value is determined, and holds every write after it |
| stdin, files, clocks (and any later effect: network, process, FFI) | when the cell runs, and only if no earlier output is held | must be concrete now; a symbolic argument is `UNRESOLVED` at the boundary |

- **Output is held, not rewritten.** A held write has no text yet. It is written once,
  when its value becomes known, or as `?` if the run ends first. Output is never taken
  back, and the stdout stream is never reordered: a later write waits behind a held one.
- **Held output is an effect barrier.** External effects reach the world in program
  order, across all of them, not only within stdout. While an earlier write is held on
  an open symbol, the run may continue through pure computation and through temporal
  statements (which may resolve the symbol and flush the write). It may not commit
  another external effect. If it reaches one first (a file write, a read from stdin or
  a file, a clock reading), it stops there with `UNRESOLVED`, before the effect is
  committed: the file is not written, the input is not consumed, the clock is not read.
  The held write is never forced out as `?` early, because the value may still become
  known and `?` would then be a false observation; `?` appears only when the run is
  over. All effects pass through one runtime entry point, which holds the barrier, so a
  new effect kind is covered by construction.
- **The event log is the order the world saw.** `ProgramResult.events` records every
  committed external effect at the moment it commits: each stdout write
  (`std.io.stdout`, with its text) and each other effect (its callable id and what it
  returned), with the step. Because of the barrier, this is both program order and
  observation order, and it is what a replay will feed back.
- **Input is grounded.** What stdin, a file or a clock returns is a concrete value. It
  is in the event log for replay, and it can never become a temporal symbol. Clock readings are `i64`; input is
  `Text`. A past statement about an input value can only check it: a mismatch is a
  `PARADOX`, never a rewrite of what was read.
- **The outside world is not retroactive.** No constraint, however late, changes a
  committed effect.

## 7. Audit (M7)

1. **The numeric model** is §1: ten fixed-width integer types, `bigint`, `f32` and
   `f64`. Literals default to `i64`/`f64` or take their type from context. There is no
   implicit conversion. Arithmetic is checked (`FAULT`, never wrapping), and floats are
   IEEE 754.
2. **Temporal symbolic values** are `bigint` and `Text` only (§1.8), enforced at check
   time (`Y3Y004`) and asserted at run time.
3. **Overflow is defined by operation and type** in one module (`semantics/numeric`).
   The interpreter, the standard library and conversions all call it, and a bytecode
   backend must call it or match it. Any backend has to fault at the same step.
4. **JavaScript leaking into semantics:**
   - Integers are JS `bigint`, so the runtime never meets JS number arithmetic.
   - Floats are JS numbers, which are IEEE binary64 by specification, with `f32`
     rounding explicit.
   - Text positions count scalars. JS UTF-16 indexing appears nowhere in the API.
   - Float printing is specified (§1.5) rather than inherited.
   - Grapheme segmentation is delegated to the host's ICU, and documented as such.
5. **Text Unicode behaviour** is language-defined (§2). Only grapheme segmentation
   depends on a Unicode table version.
6. **Slices do not imply mutable aliasing.** They are persistent views (§3).
7. **Recoverable errors are `Result`/`Option`** throughout the standard library. File
   failures, parse failures, absent keys and absent input are values. A test plants
   "file error becomes FAULT" and catches it.
8. **External effects are separated from temporal constraints** (§6). Effects need
   concrete arguments except held stdout, and held stdout is a barrier no other effect
   crosses, so the world observes effects in program order. Input is recorded and
   grounded. Clock values are `i64`.
9. **The standard library uses the user's call and type system.**
   - Same `Call` HIR node, name resolution, signature instantiation and checking.
   - One difference: built-ins may have *bounded* type parameters (`T: number`,
     `K: key`), which a user's callable plane cannot declare yet. Go's `len` and `min`
     are generic in the same way, before user generics existed.
10. **No second runtime path.**
    - `말한다` lowers to `std.io.println`. There is one output path (`writes` →
      `Host.write`), and the CLI streams through it instead of printing results at the
      end.
    - Arithmetic has one implementation (`semantics/numeric`).
    - A test plants a separate path for `말한다` and catches it (62 tests).
