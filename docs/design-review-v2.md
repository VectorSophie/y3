# Y3 Design Review & v2 Proposal

Status: proposal / brainstorm. Nothing here is implemented yet.

This review covers the current v1 implementation (`src/core`, CLI, web IDE, docs).
Part 1 lists what is broken or inconsistent today. Part 2 names the central design
problem. Part 3 proposes a v2 language model. Part 4 covers the codebase. Part 5
is a list of wilder ideas that could give Y3 a stronger identity. Part 6 is a
phased roadmap.

---

## 1. Findings in v1

### 1.1 Runtime bugs

| # | Where | Problem | Evidence |
|---|-------|---------|----------|
| B1 | `src/core/runtime.ts:93-95`, `:159-188` | **Rotations take effect one step late.** `moveDx/Dy/Dz` are captured before the `switch`. `COND`/`ELSE` update them, but the four `ROTATE_*` cases only update `nextState.d*`. So the pointer moves one more cell in the *old* direction before turning. | `방향을 오른쪽으로 회전한다` followed by `출력은 "R"이다` prints `R`. With correct semantics the pointer would turn to +X and halt immediately, because no cell exists at x=1. |
| B2 | `tests/runtime.test.ts` ("relative rotation and portal jump") | That test only passes **because of B1**. Fixing B1 will break it. | (see B1) |
| B3 | `src/core/runtime.ts:191`, `:269` | **Trace reports the wrong position for `PORTAL`.** The portal mutates `nextState.x/y/z` before the trace is built, so the trace entry shows the destination instead of the cell that ran. | Trace for `이동은 (0,0,0)로` at row 1 shows `pos=(0,0,0)`. |
| B4 | `src/core/runtime.ts:18-32` | **Rotations are degenerate on the Z axis.** `rotateRight/Left` rotate about Z, so with heading `(0,0,±1)` they do nothing. Left/right have no meaning without an "up" vector. | heading `(0,0,1)` → `rotateRight` → `(0,0,1)` |
| B5 | `src/core/runtime.ts:287` | **Hitting the step limit looks like a normal halt.** `halted: true` is set either way, the CLI exits 0, and output is printed as if the program finished. An infinite loop is indistinguishable from success. | `run` on a portal loop exits 0 with 10 000 chars of output. |
| B6 | `src/core/parser.ts:36` | `"(.)"` has no `u` flag, so non-BMP characters can't be printed. | `출력은 "😀"이다` → parse error |
| B7 | `src/core/types.ts` | Values are JS `number`. The Turing-completeness argument assumes unbounded integers, but precision is lost above 2^53. | — |

### 1.2 Language design problems

1. **The X axis is dead.** Every authored cell is at `x = 0` (`parser.ts:285`). `오른쪽으로`/`왼쪽으로` and rotate-left/right always send the pointer out of bounds. The language is really 2D (rows × layers).
2. **A layer jump becomes a flight.** `조건이면 위로` sets heading to +Z, so after landing on layer 1 the pointer keeps going up through layers 2, 3, … It does **not** continue reading down layer 1. That is why every example ends with one output cell and then halts. You can't write a multi-line branch body without a rotate after every jump.
3. **Alignment padding.** A Z jump lands on the *same row* in the target layer, so you must pad the target layer with dummy cells. The examples use `값은 99이다` as padding, which pushes junk onto the stack. `NOOP` exists in `types.ts` but no sentence produces it.
4. **Loops are absolute `goto`.** The only practical loop is `이동은 (x,y,z)로`. Inserting one line above the target silently breaks every portal that points past it.
5. **`아니다` (else) is fragile.** It depends on a hidden machine flag (`lastConditionWasTrue`) plus a source-order rule. Both break when the pointer travels backwards (`앞으로`) or arrives from another layer. It is really one two-way branch split across two cells.
6. **Small instruction set, with gaps:** no DUP/SWAP, no MUL/DIV/MOD, no negative literals, no way to print a computed character, numeric input only, no explicit halt.
7. **Macros are just aliases.** `@macro` maps one name to one sentence, which adds almost nothing over writing the sentence.
8. **The Korean is cosmetic.** The grammar is a fixed list of sentences. None of the language's structure (particles, verb endings, number words) carries meaning. That is a missed opportunity for an esolang whose identity is Korean.

### 1.3 Tooling and packaging

- `react`, `react-dom`, `three`, `monaco-editor` are runtime `dependencies` (`package.json:58-60`). `npm i -g y3` would download a browser IDE to get a CLI. Move them to `devDependencies`, or split the IDE into its own package.
- `bin/y3.mjs` spawns a second Node process (`spawnSync`) instead of importing `dist/cli.js`.
- The parser is a 140-line `if` chain. Every direction regex repeats the alternation `(위로|아래로|…)` four times, plus `*_ANY_PATTERN` duplicates for error messages. The instruction set is defined in three places: regexes, `types.ts`, and the docs.
- `step()` copies the stack, input, and memory `Map` on every step. That is fine for traces but makes `runProgram` O(steps × state size).
- The web IDE says "Y3 v0" (`App.tsx:226`), has no syntax highlighting, no step-back, no breakpoints, and doesn't show memory cells. The "trail points" counter reads a ref, so it's stale.
- There is no static validation. `validate` only checks syntax, not whether portals and branches land on real cells.

---

## 2. The central problem

Y3 claims to be a 3D spatial language, but the source is a 1D list of sentences per layer. The 3D runtime and the 1D authoring model don't fit together:

- Space should make control flow *visible*. Instead, every jump turns into "count the rows and pad".
- Free 3D headings (Befunge-style) work in Befunge because the source *is* a 2D grid you can see. Y3 deliberately rejects grids (one line = one cell, no inferred columns). So a free heading gives you a pointer that flies off into nothing.

**Recommendation:** keep the literary one-sentence-per-line source, and change the *spatial model* so it matches how text is actually read.

---

## 3. Proposed v2 language model: "the book"

Treat the program as a **book**:

| Axis | Meaning | Korean | Declared by |
|------|---------|--------|-------------|
| z | page (layer) | 쪽 | `@layer N [label]` (as today) |
| x | column on a page | 단 | **new** `@column N` (default 0) |
| y | line | 줄 | implicit row index, offset by **new** `@row N` |

The pointer has a **reading direction** (forward/backward along y) that is separate from **shifts** (one-off moves along x or z).

### 3.1 Core semantic change: shift, don't fly

- `위로` / `아래로` / `오른쪽으로` / `왼쪽으로` become **shifts**: move ±1 on z or x for *this step only*. You land on the same line of the neighbouring page or column and **keep reading** in the current direction.
- `뒤로` / `앞으로` become **reading direction**: forward (+y) or backward (−y). Add `거꾸로 읽는다` to reverse.
- This fixes problems 1.2.1 and 1.2.2 in one move. Branch bodies can be many lines long, and the X axis is finally reachable.
- Rotations either go away, or move to an opt-in "free flight" mode with a full orientation frame (forward + up vectors) so that left/right are defined everywhere (fixes B4).

### 3.2 Alignment and no-op

- `@row N` sets the next cell's row in the current layer or column. Branch targets no longer need padding.
- A real no-op sentence. Suggestion: `그리고` ("and then"). It reads naturally as a connective and is honest about doing nothing.
- Comments: lines starting with `#` (or `--`) are **not** cells, unlike the no-op.

### 3.3 Labels instead of coordinates

- `@mark NAME` labels the next cell.
- `NAME로 돌아간다` / `NAME으로 간다` jumps to it and keeps the reading direction.
- Absolute `이동은 (x,y,z)로` stays as a low-level escape hatch.
- Labels make programs robust to editing (fixes 1.2.4) and give the validator something to check.

### 3.4 One-cell branches

Replace the `조건이면` + `아니다` pair and the hidden flag with self-contained sentences:

```
값이 0이 아니면 위로                   # one-way: shift if top ≠ 0 (pops)
값이 0이 아니면 위로 아니면 아래로        # two-way in one cell
칸 값이 0이면 위로
값이 음수이면 오른쪽으로
```

`lastConditionWasTrue` is deleted from `MachineState`. `아니다` can stay as sugar that the parser fuses into the preceding cell, for backwards compatibility.

### 3.5 Instruction set additions

| Sentence | Op |
|---|---|
| `값은 -3이다` | negative literal |
| `값을 복사한다` | DUP |
| `값을 바꾼다` | SWAP |
| `값을 곱한다` / `값을 나눈다` / `나머지를 구한다` | MUL / DIV / MOD |
| `글자로 출력한다` | print top as a Unicode code point |
| `글자를 입력받는다` | read one character as its code point |
| `출력은 "안녕"이다` | multi-character string literal |
| `멈춘다` | explicit halt |

Values become `bigint` (fixes B7, and makes the Turing-completeness claim honest).

### 3.6 Example: v1 vs v2

Countdown that prints `321!`.

**v2 (proposed):**

```
@layer 0 [main]
값은 3이다
칸 값으로 넣는다
@mark 반복
칸 값을 가져온다
출력은 값이다
칸 값을 하나 줄인다
칸 값이 0이면 위로        # row 5: shift to page 1, keep reading down
반복으로 돌아간다

@layer 1 [exit]
@row 5
출력은 "!"이다
```

**v1 (today):** you need a hard-coded `이동은 (0,2,0)로`, five padding cells in layer 1, and a rotate after landing. Otherwise the pointer prints `!` and flies upward out of the program, which in this case happens to be fine but stops working as soon as the exit branch needs a second line.

### 3.7 Halting and exit status

Add a `haltReason` to the final state: `fell-off | empty-cell | halt-instruction | step-limit | error`. The CLI exits non-zero on `step-limit`, and `--max-steps 0` means unlimited.

### 3.8 Macros that matter

Upgrade `@macro` to **multi-line blocks** that expand to consecutive cells, optionally with parameters:

```
@macro 출력하고_비우기
출력은 값이다
값을 버린다
@end
```

Blocks expand vertically, so they keep the one-line-one-cell rule.

---

## 4. Codebase restructure

### 4.1 One instruction registry

Define every sentence once:

```ts
defineSentence({
  op: "MEMORY_COND_ZERO",
  pattern: ["칸", "값이", "0이면", DIRECTION],   // tokens, not regex
  doc: "현재 칸이 0이면 <방향>으로 이동",
  example: "칸 값이 0이면 위로",
  exec: (m, { direction }) => { if (m.readMem() === 0n) m.shift(direction); },
});
```

The **parser**, **runtime dispatch**, **Monaco tokenizer, completion and hover**, **generated spec doc**, and **"did you mean …?" errors** (edit distance over decomposed jamo) are all derived from this one table. Adding an instruction becomes a one-file change.

### 4.2 Pipeline

```
source
  → lex (lines, directives, comments)
  → layout (assign x,y,z; resolve @row/@column/@mark)
  → parse sentences (registry)
  → check (static analysis: warnings)
  → Program
```

The `check` stage turns `y3 validate` into a real linter:
- a shift, branch or portal lands on an empty coordinate
- an unknown label, or a label that is never used
- unreachable cells
- a layer has a label but no cells

### 4.3 Runtime

- Use a mutable `Machine` class for `run`, with `snapshot()` for traces. This removes per-step copying.
- Add `haltReason` (3.7).
- Make `step` a pure dispatch through the registry.
- Make the event stream (`onStep`, `onOutput`) the basis for both CLI trace and the IDE, so the IDE can run lazily or incrementally instead of precomputing up to 10k steps.

### 4.4 Layout

```
src/
  core/            # registry, lexer, layout, parser, checker, machine (no deps)
  cli/             # commander entry; imported directly by bin/y3.mjs
  ide/             # React + three + monaco (devDependencies / separate package)
  lang/            # monaco language def generated from the registry
tests/
  golden/          # *.y3 + *.out + *.trace snapshot pairs
```

Golden tests (an example program plus its expected output and trace) are the cheapest way to lock in semantics before the v2 changes land.

### 4.5 IDE ideas

- Syntax highlighting and completion from the registry.
- A **"오감도" (crow's-eye) view**: a 2D top-down map per page, alongside the 3D view.
- Step back and forward (traces are already snapshots), breakpoints on cells, and a memory tape panel.
- Click a cube to jump to its source line, and the reverse.
- Static-check warnings shown as editor squiggles.

---

## 5. Identity brainstorm (bigger swings)

> Superseded by `docs/v2-samchagak.md`, which develops these ideas into a full concept.

The name YI3ANG reads like **이상 (Yi Sang, 1910–1937)**: the avant-garde poet who trained as an architect and wrote geometric, numeric, unspaced poems. If that is the intent, his work offers a ready-made design vocabulary that fits a strict, spatial, literary language. Each idea below can be adopted on its own.

1. **띄어쓰기 없음 (no spacing) as canonical form.** Normalize sentences by removing whitespace before matching, so `값을더한다` ≡ `값을 더한다`. Matching stays exact, and the language becomes whitespace-insensitive in homage to Yi Sang's unspaced style.
2. **13인의아해 (the 13 children) → concurrency.** `아해가 달린다` forks a new pointer at the current cell. Pointers run in lockstep, and a program can hold at most 13 at once. "13인의아해가도로로질주하오" becomes a real parallel program.
3. **거울 (Mirror) → reflective cells.** `거울이다` reverses the reading direction. Inside an odd number of mirrors the program runs "mirror-world" semantics: push↔pop, inc↔dec, output is silenced ("거울속에는소리가없소"). This points toward a **reversible** sublanguage.
4. **건축무한육면각체 (infinite hexahedron) → toroidal pages.** `@layer 2 [loop] 순환` makes reading wrap from the last line back to the first, so loops are natural without jumps.
5. **Particle agreement as a type check.** Require grammatically correct particles: `반복으로` (with 받침) vs `LOOP로` (without), `값은` vs `수는`. The parser already knows the 받침 from the Unicode syllable. A mismatch is an error, so writing correct Korean is a compile-time requirement.
6. **Native numerals as literals.** `값은 셋이다` / `값은 삼이다` as alternatives to digits, with one strict canonical spelling per number.
7. **Speech level as scope.** Plain style (`더한다`) acts on the stack, and polite style (`더합니다`) acts on memory. This could replace the `칸` prefix and make memory ops read differently from stack ops.
8. **날개 (Wings) → `날자` as an absolute jump.** "날자. 날자. 한 번만 더 날자꾸나." could be a flight instruction that lifts the pointer to the top page.

Of these, 1, 3 and 4 are the cheapest and most on-theme. 2 is the most distinctive but adds the most complexity.

---

## 6. Suggested roadmap

**Phase 0: fix and lock (small, safe)**
- Fix B1, B3, B6. Rewrite the rotation test to match correct semantics.
- Add `haltReason` and a non-zero exit code on step-limit (B5).
- Move IDE dependencies to `devDependencies`, and make `bin/y3.mjs` import the CLI directly.
- Add golden tests for all examples.

**Phase 1: registry refactor (no language change)**
- Build the sentence registry and generate parser dispatch, the Monaco language, and the spec doc from it.
- Add the mutable machine and snapshot traces.

**Phase 2: v2 spatial model**
- Shift-vs-reading-direction semantics, `@row`, `@column`, `@mark` and label jumps, the `그리고` no-op, comments.
- One-cell branches, then deprecate `아니다` (keep it as fused sugar).
- Instruction additions and `bigint` values.
- Static checker.

**Phase 3: identity features**
- Pick from section 5. Recommended first: whitespace-insensitive matching, mirrors, toroidal pages.

**Phase 4: IDE**
- Crow's-eye view, step back, breakpoints, memory tape, diagnostics.

## Open questions

1. Is the Yi Sang reading of the name intended? It decides how much of section 5 is in scope.
2. Should free 3D flight survive at all, or is the book model the language?
3. Is backwards compatibility with v1 programs a goal, or can v2 break freely? There are only four examples today.
