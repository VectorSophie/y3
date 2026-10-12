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
