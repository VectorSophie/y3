# Y3 v2 — the present-tense core (M2)

M2 makes the rule *present tense executes* real. (M3 has since added `미정이다`, `였다` and `일 것이다`, M4 channels, fixed points and time anchors, and M5 static types, `Bool` and colon calls; see `v2-temporal-core.md`, `v2-temporal-cycles.md` and `v2-typed-core.md`.) This is the complete sentence set it
accepts. Everything else is either recognised and refused (past and future tense,
unknowns, channels) or reported as an unknown sentence. The full design is in
`v2-space-and-time.md`.

## Values

Values are `bigint` integers or text, and every value lives in a named noun. There is
no operand stack. A noun is any word that is not reserved (`처음`, `끝`, `여기`, `미정`,
`전`, `다음`, and the direction words). Reading a noun that no sentence ever assigns
is a compile error. Reading one that this run hasn't assigned *yet* is a runtime
`FAULT`.

## Sentences

| Sentence | Meaning |
|---|---|
| `[값은 3이다.]` `[값은 "셋"이다.]` `[합은 값이다.]` | 값 := 3 / "셋" / the value of 합 |
| `[값에 1을 더한다.]` | 값 := 값 + 1 (integers only) |
| `[값에서 1을 뺀다.]` | 값 := 값 − 1 (integers only) |
| `[값을 말한다.]` `["발사"를 말한다.]` | print one line |
| `[오른쪽을 본다.]` `왼쪽` `뒤` `위` `아래` | turn in the body frame |
| `[동쪽을 본다.]` `서쪽` `남쪽` `북쪽` | face a compass direction, level |
| `[앞으로 간다.]` `뒤로` `오른쪽으로` `왼쪽으로` `위로` `아래로` | step one cell; orientation unchanged |
| `[위층으로 간다.]` `[아래층으로 간다.]` | z ± 1; x, y and facing unchanged |
| `[여기가 처음이다.]` | a loop anchor: opens a loop here, or starts its next iteration |
| `[끝은 처음이다.]` | back-edge: return to the innermost anchor |
| `[끝이다.]` | the end of the run (`HALT`) |
| `[N이 E이면 ⟨sentence⟩.]` | do the sentence if N equals E |
| `[N이 E이 아니면 ⟨sentence⟩.]` | do the sentence if N differs from E |

- **Equality.** A condition compares two values of the same type. Since M5, comparing
  the integer `3` with the text `"3"` is a type error at `y3 check`.
- **Consequences.** A consequence is any sentence above except a condition or an anchor.
- **Leaving a loop.** When a conditional back-edge's condition fails, execution falls
  through to the next cell and leaves the loop. Nested and consecutive loops in one
  plane work through the anchor stack.
- **Word order** is free: particles assign roles, so `[1을 값에 더한다.]` is the same
  sentence as `[값에 1을 더한다.]`.
- **Particle allomorphs** (은/는, 이/가, 을/를, 으로/로) are all accepted. A
  non-canonical one gets a `Y3K001` warning, chosen by the final consonant of the word
  as read aloud (numbers use their Sino-Korean reading).

## Not yet (refused with a reason)

| Form | Code | Arrives |
|---|---|---|
| `일 것이라면`, `이었다면` | `Y3T001` | experimental |
| `곱한다`, `나눈다`, `듣는다` | `Y3T002` | when a program needs them |
| past or future verbs (`더했다`, `더할 것이다`) | `Y3G008` | never; only states take tense |

## Running

```bash
y3 check program.y3   # structure, manifest, and every sentence
y3 run program.y3     # output lines; non-HALT outcomes print a 진단 line and exit non-zero
y3 trace program.y3   # every executed cell and its effects
```

Exit codes: `HALT` 0, `FAULT` 1, `VOID` 2, `STEP_LIMIT` 3.

## Layers

```
.y3 text → document parser → Space → sentence parser → SentenceAst
        → lower → Operation → interpreter (values, output, anchors) → spatial machine
```

The spatial machine never sees Korean or values. The interpreter gives it one spatial
instruction per cell, through the same decoder hook the M1 tests use.
