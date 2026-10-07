# Y3 v2 — 공간에서는 움직이고, 시간에서는 진술한다

> In space, Y3 moves. In time, Y3 states.

Status: design proposal, precise enough to implement. It supersedes the language
model in `v2-samchagak.md`. §12 lists what carries over from that doc.

Every program in this document has been traced by hand against the rules stated
here. Each one is meant to become a golden test once the implementation starts.

---

## 0. The idea in one table

| Dimension | Expressed by | Mode | Engine |
|---|---|---|---|
| **Y1** cell | one sentence in `[ ]` | — | — |
| **Y2** plane | a rectangle of cells in `⟦ ⟧` (a floor) | — | — |
| **Y3** space | an ordered stack of planes (a building) | — | — |
| **space** | layout, orientation, movement | **operational** | the machine |
| **time** | tense (`이다` / `였다` / `일 것이다`) | **relational** | the solver |
| **relation** | particles (`은 이 을 에 에서 으로 의 보다`) | assigns roles | the grammar |

The core rule that keeps all of this from collapsing:

> **현재형은 실행하고, 과거형과 미래형은 제약한다.**
> Present tense executes. Past and future tense constrain.

The **tense morpheme is the type tag** of a sentence. The parser decides from the
sentence-final form alone whether a cell is an action (the machine runs it) or a
relation (the solver records it). No cell is ever both.

### Answers at a glance

| # | Question | Short answer | § |
|---|---|---|---|
| 1 | Container in the architecture | One logical container (manifest + named planes + volume order). It is stored as a single text `.y3` by default; `unpack` / `pack` convert it to and from a directory. Parsing becomes `decode → resolve refs → plane layout → Korean → frames`. | 1 |
| 2 | Y2 / Y3 grammar | An EBNF over `⟦ ⟧`, `[ ]`, `:name:`, and a `※` appendix. Indentation and gaps are never read. Planes must be rectangular. | 2 |
| 3 | Orientation | The 24 cube orientations as (forward, up) pairs. `본다` turns, `간다` steps once, `층` translates in z. Rows wrap like lines of text. | 3 |
| 4 | Minimal temporal model | Named values are terms over unknowns. Linear equalities are solved by unification plus Gaussian elimination. Per-plane snapshots, promises, and channel slots. No history log. | 6 |
| 5 | Unambiguous tense | A closed set of sentence-final forms, matched by suffix. Copula allomorphs and particles must agree with 받침. Only the copula conjugates; verbs are present-only. | 5 |
| 6 | How much retrocausality is core | **Equational** retrocausality is core, because it is deterministic and needs no search. **Choosing among histories** is experimental. | 9 |
| 7 | `끝은 처음이다` loops | Yes. A loop is a plane cycle: `끝은 처음이다` continues and `끝이다` breaks. Nested loops are stacked floors. `처음은 끝이었다` is the relational twin: a fixed point or invariant. | 4, 7 |
| 8 | Separating execution and solving | Two engines behind a five-call interface. The machine never asks the solver to *choose*. Control flow on an unknown value is `UNRESOLVED`. | 8 |
| 9 | Anti-collapse rules | Seven rules (§10): no stack, no coordinates in sentences, equalities only, no search in core, verbs don't conjugate, and so on. | 10 |
| 10 | Tiers | Core / experimental / future table. | 11 |

---

## 1. The `.y3` container

### 1.1 Logical model

A Y3 program is a **space**, not a file:

```
Space
  manifest    language version, name, start pose, limits, experimental flags
  planes      name → Plane            (every plane is a named object)
  volume      [PlaneRef]              (order = z: 0, 1, 2, …)
```

An inline plane is a plane with a generated name (`:#1:`, `:#2:`, …). That makes
**inline ≡ referenced** true by construction: the volume only ever holds
references. Inlining and extracting are display decisions that the formatter can
toggle without changing the space.

The same named plane can appear more than once in the volume, like the same floor
plan used on two storeys. Each occurrence is a separate floor with its own z, its
own cells and its own `처음`.

### 1.2 Physical encodings

**Recommendation: a single UTF-8 text `.y3` as the canonical encoding**, plus a
directory form for `unpack`. A zip container can be added later as an optional
distribution format.

Why text over zip by default: `.y3` is still something people author, diff, review
and paste. A zip is opaque to git, to editors, and to anyone without the CLI. The
container idea survives intact either way, because the *logical* model above is
what Y3 sees. The text file is just one way of writing that model down.

Text encoding (one file, normally the only thing a user sees):

```
+++
name = "countdown"
+++

⟦
[값은 3이다.]
⟧

    ⟦ :loop: ⟧

        ⟦
        ["발사"를 말한다.]
        ⟧

※
:loop: ⟦
[값을 말한다.]
[값에서 1을 뺀다.]
[값이 0이면 끝이다.]
[끝은 처음이다.]
⟧
```

- The `+++` front matter is exactly `manifest.toml`.
- After `※` comes the **appendix**: named planes that the volume refers to.
  (The mark is from 「오감도 시제6호」: 鸚鵡 ※ 二匹.)

`y3 unpack countdown.y3` produces the directory form:

```
countdown/
  META-INF/manifest.toml
  space/main.y3s        # the volume: one ⟦ :name: ⟧ per line, projection kept
  planes/
    p0.y2               # inline planes get names; manifest records inline = true
    loop.y2
    p2.y2
```

`y3 pack countdown/` reverses it, and `pack ∘ unpack` is the identity on the
logical model. A `.y2` file contains exactly one `⟦ … ⟧`. **To Y3 it is a plane,
not a file**: it has no imports, no path semantics, and `:loop:` is a name inside
the space, never a path.

`manifest.toml`:

```toml
[y3]
language = "2.0"
name = "countdown"

[start]            # default pose; all optional
plane = 0          # z
cell = [0, 0]      # [x, y]
facing = "동"
up = "위"

[limits]
steps = 10000

[experimental]     # §9; all off by default
future-branching = false

[planes.p0]        # written by unpack only
inline = true
```

### 1.3 Where it fits the existing code

v1's `parser.ts` and `runtime.ts` are replaced. The CLI scaffolding, tests and IDE
shell carry over.

```
src/
  container/  decode(text | dir) → SpaceDoc; encode; pack/unpack; manifest schema
  syntax/     plane lexer (⟦ ⟧ [ ] :ref: ※) → PlaneAST; formatter + projections
  korean/     jamo/받침, Sino-Korean number readings, eojeol → noun+particle | predicate
  grammar/    frame table (single source of truth) → Sentence IR: Act | Relation | Control
  check/      static checks (§5.5)
  space/      Program (planes by z, dims), the 24-orientation group, movement
  machine/    operational executor (deterministic)
  time/       terms, unknowns, solver, promises, channels, provenance
  outcome/    statuses, 진단 report, trace
  cli/  ide/
```

Pipeline:

```
bytes → decode → SpaceDoc → resolve refs → Program(planes, z order)
      → per cell: morphology → frame match → Act | Relation | Control
      → check → run: machine ⇄ time (§8) → Outcome + trace
```

CLI: `y3 run | trace | check | fmt [--projection flat|perspective|strong] | unpack | pack | new`.

---

## 2. Grammar of Y2 planes and Y3 space

### 2.1 EBNF

```ebnf
file        = [ frontmatter ] , volume , [ appendix ] ;
frontmatter = "+++" , NL , toml , "+++" , NL ;
volume      = plane , { { blank } , plane } ;

plane       = ws , "⟦" , ws , ( ref , ws , "⟧"                  (* referenced *)
                               | row , ws , "⟧"                  (* one-row inline *)
                               | NL , row , NL , { row , NL } , ws , "⟧" ) , NL ;
ref         = ":" , name , ":" ;
row         = ws , cell , { gap , cell } , ws ;
cell        = "[" , [ ws , sentence , ws ] , "]" ;     (* "[ ]" = empty cell *)
sentence    = { char - ( "[" | "]" ) | quoted } , "." ; (* §5; must end in "." *)
quoted      = '"' , { char - '"' | '\"' } , '"' ;

appendix    = "※" , NL , { { blank } , ref , ws , plane } ;
name        = ( hangul | letter | "_" ) , { hangul | letter | digit | "_" | "-" } ;
comment     = ws , "#" , { char } , NL ;   (* only outside planes *)
ws = { " " | "\t" } ;   gap = ws ;
```

### 2.2 Layout rules

1. **Plane order defines z.** The *n*-th plane in the volume has `z = n`.
2. **Inside a plane, row index defines y and cell index defines x.** Origin is the
   top-left corner, x increases east and y increases south (like a floor plan).
3. **Planes are rectangular.** Every row has the same number of cells. Use `[ ]`
   for empty cells. The formatter can pad. Ragged rows are a parse error, so a
   missing cell can never be a silent typo.
4. **Planes may differ in size.** A 2×3 floor can sit under a 1×5 floor.
5. **Whitespace outside `[ ]` is never read.** That covers leading indentation,
   gaps between cells, and blank lines between planes.
   *Indentation is projection, not syntax.*

### 2.3 Projection: the formatter's job

Same space, three renderings. The parser produces an identical `Program` from each.

`flat`:

```
⟦
[A] [B] [C] [D]
[E] [F] [G] [H]
⟧

⟦
[I] [J] [K] [L]
[M] [N] [O] [P]
⟧
```

`perspective` (default; indent 4 per plane):

```
⟦
[A] [B] [C] [D]
[E] [F] [G] [H]
⟧

    ⟦
    [I] [J] [K] [L]
    [M] [N] [O] [P]
    ⟧
```

`strong` (indent 5 per plane, and **gap and padding shrink with depth**):

```
⟦
[A]  [B]  [C]  [D]
[E]  [F]  [G]  [H]
⟧

     ⟦
     [I] [J] [K] [L]
     [M] [N] [O] [P]
     ⟧

          ⟦
          [Q][R][S][T]
          [U][V][W][X]
          ⟧
```

How far narrowing can go: a formatter can only shrink what it adds, which is
inter-cell gaps and column-alignment padding. It can **never** drop or abbreviate
cells. Front planes get aligned columns and wide gaps; deep planes get tight, unpadded rows.
That is a lossless perspective, and it's the only kind allowed, because
*visual perspective is not geometry*.

The IDE adds `orthographic`, `top`, `side`, and `exploded` as views of the
same `Program`. These are never written back as different code.

---

## 3. Orientation, movement, and floors

### 3.1 State

The pointer's **pose** is position `p = (x, y, z)` plus orientation `(f, u)`:
**forward** and **up**, two perpendicular unit axis vectors. There are exactly
**24** such pairs, which are the rotations of a cube. **Right** is derived as
`r = u × f`.

Axes: `동 = +x`, `남 = +y`, `위 = +z` (floors), with `서`, `북`, `아래` as the opposites.
The default pose is `(0,0,0)`, facing `동`, up `위`, so right is `남`. Facing east on
a floor plan, your right hand points south.

### 3.2 Three verbs, three concepts

| Sentence | Kind | Effect |
|---|---|---|
| `[오른쪽을 본다.]` `[왼쪽을 본다.]` `[뒤를 본다.]` | turn (body frame) | `f ← r`, `f ← −r`, `f ← −f` |
| `[위를 본다.]` `[아래를 본다.]` | pitch (body frame) | `(f,u) ← (u, −f)`, `(f,u) ← (−u, f)` |
| `[동쪽을 본다.]` (and 서/남/북) | absolute face | `f ← compass`, `u ← 위` (resets roll) |
| `[앞으로 간다.]` and `뒤로`, `오른쪽으로`, `왼쪽으로`, `위로`, `아래로` | step (body frame) | move once by `f`, `−f`, `r`, `−r`, `u`, `−u`; **orientation unchanged** |
| `[위층으로 간다.]` `[아래층으로 간다.]` | translate (world frame) | `z ← z ± 1`; x, y and orientation unchanged |

Rules:

- **`간다` replaces this step's normal advance.** The pointer lands on the target
  cell, executes it next, and then continues along `f`. Nothing ever starts
  "flying" unless you *face* along z with `위를 본다` and keep walking. Continuous
  vertical travel is therefore always deliberate.
- **`층` belongs to the building; `위` belongs to the body.** With the default pose
  `위로 간다` and `위층으로 간다` coincide. After `위를 본다` or a roll they don't:
  `층` is always ±z, while `위로` follows your up vector.
- Turning left or right is meaningful while facing ±z, because `r = u × f` is
  always defined. This fixes the v1 bug where rotation was degenerate on the z axis.

### 3.3 Advancing and edges

Each step executes the current cell, then advances one cell along `f` (or follows
the cell's `간다` / control effect).

- **Line wrap.** If facing `동` and stepping off the east edge, go to `(0, y+1)` on
  the same plane: rows read like lines of text. Off the last row, the plane reaches
  its **끝**.
- **Other in-plane edges.** Stepping off west, north or south also reaches the plane's 끝.
- **Into the void.** Any z move (a translation, `위로` / `아래로`, or walking along ±z)
  onto a plane that doesn't exist, or to an `(x, y)` outside that plane's rectangle,
  halts with `VOID`.

---

## 4. Scenes: `처음`, `끝`, and the flow between planes

Each plane has **one `처음`**: a cell plus an orientation. By default it is where the
pointer first entered the plane, or `(0,0)` facing `동` if the plane has never been
entered. `[여기가 처음이다.]` moves it to the current cell and orientation.

A **scene** is one cycle of a plane: it starts when the pointer begins at the
plane's 처음 and ends at the plane's 끝. Leaving spatially (`층`) suspends nothing and
ends nothing. If you come back, the scene is still open.

| Sentence / event | Tense | Effect |
|---|---|---|
| reaching 끝 by walking off | — | the scene ends; **flow** to the next plane in volume order (z+1), at its 처음. If there is none, `HALT`. |
| `[끝이다.]` | present → act | end the scene now, then flow as above (**break**) |
| `[끝은 처음이다.]` | present → act | end the scene now, start a new scene of *this* plane at its 처음 (**continue**) |
| `[여기가 처음이다.]` | present → act | set this plane's 처음 here; start a new scene (takes a snapshot) |
| `[처음은 끝이었다.]` | past → relation | when this scene ends, each noun touched in it must equal its value at the scene's start (**fixed point / invariant**, §7) |

There are two ways to reach the next plane, and the difference is the point:

- **through space**: `위층으로 간다` keeps your x, y and heading (translation)
- **through time**: an ending (`끝`) takes you to the next plane's beginning (`처음`)

---

## 5. Korean that carries meaning

### 5.1 Data lives in nouns, not a stack

There is no stack. Every value has a name: any Hangul noun the program introduces
(`값`, `수`, `결과`, `문장`, `원래`, …). Values are integers or text. A noun must be
introduced (by `이다`, `미정이다`, `듣는다`, or `온다`) before it is read; otherwise
it's a static error.

### 5.2 Particles assign roles; word order is free

| Particle | Role | Example |
|---|---|---|
| `은/는` | topic: the noun being stated about | `[값은 3이다.]` |
| `이/가` | subject (conditions, arrivals) | `[값이 0이면 끝이다.]` `[수가 다음에서 온다.]` |
| `을/를` | object / amount | `[값을 말한다.]` `[1을 더한다]` |
| `에` | target | `[값에 1을 더한다.]` → 값 := 값 + 1 |
| `에서` | source | `[값에서 1을 뺀다.]` → 값 := 값 − 1 |
| `으로/로` | direction, destination, means | `[위층으로 간다.]` `[값을 2로 나눈다.]` `[문장을 전으로 보낸다.]` |
| `의` | temporal anchor | `[처음의 값은 0이었다.]` |
| `보다` | comparison | `[값이 3보다 크면 …]` |

Roles come from particles, not positions, so `[값에 1을 더한다.]` ≡ `[1을 값에 더한다.]`.
The formatter can normalise the order. The grammar is a **case-frame table**: each
verb lists the roles it requires.

| Verb | Frame | Act |
|---|---|---|
| `더한다` | `N에` + `E을` | N := N + E |
| `뺀다` | `N에서` + `E을` | N := N − E |
| `곱한다` | `N에` + `E을` | N := N × E (one side must be known, §6.4) |
| `나눈다` | `N을` + `E로` | N := N ÷ E (N and E must be known) |
| `말한다` | `E을` | output E as one line |
| `듣는다` | `N을` | N := next input, or a fresh unknown if input is exhausted |
| `본다` | `D을` | turn (§3) |
| `간다` | `D으로` | step / translate (§3) |
| `온다` | `N이` + `다음에서` | open a channel (§6.3) |
| `보낸다` | `N을` + `전으로` | close a channel (§6.3) |

### 5.3 Only the copula conjugates

Actions are always present tense (`더한다`, `간다`). **States** carry tense, through
the copula:

| Form | Tense | Kind | Meaning |
|---|---|---|---|
| `N은 E이다` | present | **act** | write: N := E (a new version; replaces) |
| `N은 미정이다` | present | **act** | write: N := a fresh unknown |
| `N은 E이었다` / `였다` | past | **relation** | assert: N's current value equals E (it reveals; it never writes) |
| `N은 E일 것이다` | future | **relation** | promise: N's value at this scene's 끝 equals E |
| `N이 E이면 ⟨act⟩` | present | **control** | if N = E (both known), do the act |
| `N이 E일 것이라면 ⟨act⟩` | future | **control** | *experimental* (§9) |

A slogan for teaching: **이다 replaces, 였다 reveals, 일 것이다 promises.**

`정해지지 않았다` from your sketch is past tense, so under the tense rule it would be a
relation, not an act. The act form is `[값은 미정이다.]` (未定). The tense rule holds
with no exceptions.

Past and future **verb** forms (`더했다`, `더할 것이다`) are parse errors in core:
"actions happen now; only states have tense." §11 parks past-tense verbs as an
experimental way to describe transitions.

### 5.4 Morphology algorithm (deterministic)

1. The cell text must end in `.`, which is stripped.
2. Split into eojeols on spaces. A quoted literal is one token.
3. **Predicate.** Match the final eojeol(s) right-to-left against the closed table:
   `…일 것이라면`, `…일 것이다`, `…이었다`, `…였다`, `…이다`, `…이면`, `…가 아니면`,
   `…보다 크면` / `작으면`, then the verb list. The longest match wins. What remains of
   that eojeol is the predicate's value expression.
4. **Noun phrases.** Each other eojeol must be *exactly one* noun or literal followed by
   *exactly one* particle. Strip the longest particle whose allomorph agrees with the
   remainder; the remainder must be a literal, a reserved word, or a known noun. A
   noun's first introduction strips the single longest particle.
5. **Frame match.** Look up the predicate in the frame table and check the role set.
   Missing or extra roles are errors.

### 5.5 Agreement is enforced

The 받침 (final consonant) of the preceding word selects the allomorph, and the parser
checks it:

| Pair | After consonant | After vowel | Notes |
|---|---|---|---|
| topic | 은 | 는 | |
| subject | 이 | 가 | |
| object | 을 | 를 | |
| direction | 으로 | 로 | ㄹ-final also takes 로: `1로`, `둘로` |
| past copula | 이었다 | 였다 | `3이었다`, `4였다` |

- Numerals use the **Sino-Korean reading** of the whole number's final syllable:
  - `3` 삼 (ㅁ) → `3이었다`
  - `4` 사 (vowel) → `4였다`
  - `1` 일 (ㄹ) → `1로`
  - `10` 십 (ㅂ) → `10을`
  - `20` 이십 → `20을`
  - `1000` 천 → `1000을`
- Text literals use their last Hangul syllable. A non-Hangul ending accepts either
  form.
- `이다`, `이면` and `일 것이다` are always written in full: Y3 does not contract to `다`
  or `면`.

The examples in your message already agree (`3이었다`, `4였다`). Agreement errors
come with a fix: `y3 fmt` corrects them, and `y3 check` explains them.

**Tense / anchor agreement.** A subject anchored with `처음의` takes past tense; one
anchored with `끝의` takes future tense. `[처음의 값은 3일 것이다.]` is a parse error.

Static checks (`y3 check`):
- agreement
- tense and anchor agreement
- nouns read before they're introduced
- planes that can't be reached
- `보낸다` with no matching `온다` anywhere
- translations that can never land

---

## 6. The temporal model (smallest viable)

### 6.1 State

```
Term      = Int | Text | α (unknown) | Σ cᵢ·αᵢ + c   (affine; coefficients known integers)
Store     = noun → Term                                (current version only)
Unknown   = { id, origin: 미정 | 다음 | 입력, born: step, provenance? }
Equations = solved substitution + pending linear system
Promise   = { plane, scene, noun, term, made: step }
Channel   = per-noun stack of open slots { unknown, opened: step }
Snapshot  = per plane: Store at the current scene's start   (for 처음 / 처음은 끝이었다)
Output    = list of Terms; flushed in order up to the first unresolved one
```

There is **no history log.** `였다` talks about the current value, which the
sentence itself doesn't change. `일 것이다` and `처음은 끝이었다` are promises checked at
a scene's end. `처음의 N` reads the snapshot. That's all the past the machine keeps.

### 6.2 Solving

- **Unification plus Gaussian elimination** over linear integer equations, run
  incrementally as each equation arrives. Text unknowns only unify.
- An equation with no rational solution, or whose unique solution isn't an integer,
  is a `PARADOX`.
- An unknown that ends the run undetermined is harmless *unless output depends on
  it*; if output does, the outcome is `AMBIGUOUS`.
- There is no disjunction, no inequality, and no search in core. Every resolution
  is one explainable trace line:
  `α = 3 because α + 1 = 4 (t5: [값은 4였다.])`.

### 6.3 Temporal channels (`전` / `다음`)

- `[N이 다음에서 온다.]` sets N := a fresh unknown β and pushes an open slot for N.
- `[N을 전으로 보낸다.]` pops N's most recent open slot (β) and adds the equation
  `β = current N`. With no open slot, it's a `PARADOX`: no past is listening.
- A channel is therefore *sugar over unknowns and equations*. The slot structure is
  kept because it lets the trace show the causal loop.

### 6.4 Provenance

Each unknown is marked when it resolves:

| Mark | When |
|---|---|
| **소급 RETRO** | determined by an equation made later in time than the unknown's birth |
| **자기원인 SELF_CAUSED** | determined, born on a channel, and the term sent back to its slot contains that same unknown (it caused itself). No present-tense act and no input contributed its value; past/future statements may pin it, because testimony is not a cause (Example 3d). |

Operations that would make a term non-linear (an unknown times an unknown, division
of an unknown) are `UNRESOLVED` in core: **time only solves straight lines.**

### 6.5 Outcomes

| Status | 진단 | Exit | Meaning |
|---|---|---|---|
| `HALT` | 정지 | 0 | ran to the end; consistent; all output determined |
| `VOID` | 허공 | 2 | translated into space that doesn't exist |
| `STEP_LIMIT` | 한계 | 3 | step budget exhausted |
| `PARADOX` | 역설 | 4 | constraints are inconsistent (the report names both statements) |
| `UNRESOLVED` | 미결 | 5 | control needed a value only the future could decide |
| `AMBIGUOUS` | 중의 | 6 | consistent, but some output has more than one consistent value |
| `FAULT` | 고장 | 1 | ordinary error (e.g. division by zero) |

---

## 7. Worked examples

Trace columns: **t** step · **pos** `(x,y,z)` · **pose** facing/up · **cell** · **effect**.

### Example 1 — conditional, loop, and a detour downstairs

Count down from 3, say "둘" on the way past 2, then launch.

```
⟦
[값은 3이다.]       [끝이다.]
["둘"을 말한다.]    [ ]
[위층으로 간다.]    [ ]
⟧

    ⟦
    [값을 말한다.]
    [값이 2이면 아래층으로 간다.]
    [값에서 1을 뺀다.]
    [값이 0이면 끝이다.]
    [끝은 처음이다.]
    ⟧

        ⟦
        ["발사"를 말한다.]
        ⟧
```

- Floor 0 (2×3) is a prelude, and also a basement for the detour.
- Floor 1 (1×5) is the loop.
- Floor 2 (1×1) is the ending.

| t | pos | pose | cell | effect |
|---|---|---|---|---|
| 1 | (0,0,0) | 동/위 | `값은 3이다.` | 값 := 3 |
| 2 | (1,0,0) | 동/위 | `끝이다.` | floor 0 scene ends → flow to floor 1's 처음 (0,0) |
| 3 | (0,0,1) | 동/위 | `값을 말한다.` | out `3`; east edge → wrap |
| 4 | (0,1,1) | | `값이 2이면 아래층으로 간다.` | 3 ≠ 2 → wrap |
| 5 | (0,2,1) | | `값에서 1을 뺀다.` | 값 := 2 |
| 6 | (0,3,1) | | `값이 0이면 끝이다.` | 2 ≠ 0 |
| 7 | (0,4,1) | | `끝은 처음이다.` | scene 1#1 ends; scene 1#2 starts at (0,0) |
| 8 | (0,0,1) | | `값을 말한다.` | out `2` |
| 9 | (0,1,1) | | `값이 2이면 아래층으로 간다.` | 2 = 2 → translate to (0,1,0) |
| 10 | (0,1,0) | 동/위 | `"둘"을 말한다.` | out `둘` → (1,1,0) |
| 11 | (1,1,0) | | `[ ]` | wrap → (0,2,0) |
| 12 | (0,2,0) | | `위층으로 간다.` | translate to (0,2,1); scene 1#2 is still open |
| 13 | (0,2,1) | | `값에서 1을 뺀다.` | 값 := 1 |
| 14 | (0,3,1) | | `값이 0이면 끝이다.` | 1 ≠ 0 |
| 15 | (0,4,1) | | `끝은 처음이다.` | scene 1#3 |
| 16 | (0,0,1) | | `값을 말한다.` | out `1` |
| 17 | (0,1,1) | | `값이 2이면 …` | 1 ≠ 2 |
| 18 | (0,2,1) | | `값에서 1을 뺀다.` | 값 := 0 |
| 19 | (0,3,1) | | `값이 0이면 끝이다.` | 0 = 0 → scene ends → flow to floor 2's 처음 |
| 20 | (0,0,2) | | `"발사"를 말한다.` | out `발사`; wrap off last row → 끝 → no floor 3 |

```
3
2
둘
1
발사
진단: 정지 (HALT) · 20보
```

The branch is a **stairwell**: floor 1's cell (0,1) sits directly above the basement
cell that handles it, and the basement's exit (0,2) sits directly below the cell
where the loop resumes. The alignment *is* the control flow.

A single-plane loop with its prelude in the same plane uses `여기가 처음이다`:

```
⟦
[값은 5이다.]
[여기가 처음이다.]
[값을 말한다.]
[값에서 1을 뺀다.]
[값이 0이면 끝이다.]
[끝은 처음이다.]
⟧
```

This prints `5 4 3 2 1`. Without `여기가 처음이다`, the loop would restart at
`값은 5이다` forever, and the step limit would report `한계`. That was the bug hiding
in the single-plane sketch from your message.

### Example 2 — the future determines the past

```
⟦
[값은 미정이다.]
[원래는 값이다.]
[값에 1을 더한다.]
[원래를 말한다.]
⟧

    ⟦
    [값은 4였다.]
    ⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `값은 미정이다.` | 값 := α | α born (미정, t1) |
| 2 | (0,1,0) | `원래는 값이다.` | 원래 := α | |
| 3 | (0,2,0) | `값에 1을 더한다.` | 값 := α+1 | |
| 4 | (0,3,0) | `원래를 말한다.` | output #1 = α, **held** (not yet determined) | |
| — | | (walk off → floor 0 ends → floor 1) | | |
| 5 | (0,0,1) | `값은 4였다.` | (relation: no write) | equation α + 1 = 4 ⇒ **α = 3**, marked **소급** (made at t5 about a value born at t1) |
| — | | output #1 flushes | out `3` | |

```
3
진단: 정지 (HALT) · 5보 · α = 3 [소급 t5 → t1]
```

The `원래` printed at t4 was decided at t5. The trace renders the t2–t4 rows with
`α (=3, from t5)` in a distinct style, so the retro-fill is visible.

**The same retrocausality with a prophecy instead of testimony** (one plane, future tense):

```
⟦
[값은 미정이다.]
[값은 4일 것이다.]
[원래는 값이다.]
[값에 1을 더한다.]
[원래를 말한다.]
⟧
```

At t2 the promise "값 at this scene's 끝 = 4" is recorded. At the scene's end, `α+1 = 4`,
so α = 3, and the output is `3`. The promise was spoken *before* the addition but
binds what comes *after* it.

**Variants that show the other statuses:**

- Add `[원래는 2였다.]` to floor 1, after `값은 4였다`. At t6: α = 3 and α = 2.
  ```
  진단: 역설 (PARADOX) · t6 [원래는 2였다.] contradicts t5 [값은 4였다.] (α = 3)
  ```
- Delete floor 1 entirely. α is never determined, and output #1 depends on it.
  ```
  ?
  진단: 중의 (AMBIGUOUS) · α unconstrained (born t1 [값은 미정이다.])
  ```
- Put `[원래가 3이면 끝이다.]` at floor 0, row 3. At that step 원래 = α is still
  unknown, and a branch needs a value now.
  ```
  진단: 미결 (UNRESOLVED) · t4 needs α; only the future could decide it
  ```

### Example 3 — bootstrap loops: ambiguous, self-caused, and paradoxical

**3a. A sentence with no origin**

```
⟦
[문장이 다음에서 온다.]
[문장을 말한다.]
⟧

    ⟦
    [문장을 전으로 보낸다.]
    ⟧
```

| t | cell | machine | time |
|---|---|---|---|
| 1 | `문장이 다음에서 온다.` | 문장 := β | β born (다음, t1); slot S₁ opened for 문장 |
| 2 | `문장을 말한다.` | output #1 = β, held | |
| 3 | `문장을 전으로 보낸다.` | | close S₁: β = β (tautology); the loop closes on itself |

```
?
진단: 중의 (AMBIGUOUS) · β is self-consistent but has no unique value
```

The loop is **consistent**: no paradox, and the program is legal. But nothing in the
universe says *which* sentence travelled. Y3 reports that honestly rather than
inventing one. (§11 parks a "Novikov selection" rule as experimental.)

**3b. A number that caused itself**

```
⟦
[수가 다음에서 온다.]
[수에 수를 더한다.]
[수를 말한다.]
⟧

    ⟦
    [수를 전으로 보낸다.]
    ⟧
```

| t | cell | machine | time |
|---|---|---|---|
| 1 | `수가 다음에서 온다.` | 수 := β | slot S₁ |
| 2 | `수에 수를 더한다.` | 수 := 2β | |
| 3 | `수를 말한다.` | output #1 = 2β, held | |
| 4 | `수를 전으로 보낸다.` | | close S₁: β = 2β ⇒ **β = 0**, marked **자기원인** |
| — | output flushes | out `0` | |

```
0
진단: 정지 (HALT) · 4보 · β = 0 [자기원인: S₁ t4 → t1]
```

This is a valid bootstrap. No literal, no input and no write ever produced the 0.
It is the only number that can survive its own trip through time: a fixed point that
caused itself.

**3c. The paradox**

```
⟦
[수가 다음에서 온다.]
[수에 1을 더한다.]
⟧

    ⟦
    [수를 전으로 보낸다.]
    ⟧
```

| t | cell | machine | time |
|---|---|---|---|
| 1 | `수가 다음에서 온다.` | 수 := β | slot S₁ |
| 2 | `수에 1을 더한다.` | 수 := β+1 | |
| 3 | `수를 전으로 보낸다.` | | close S₁: β = β + 1 ⇒ 0 = 1 |

```
진단: 역설 (PARADOX) · t3 sent β+1 to t1, which received β
```

**3d. Testimony, not cause.** Add `[문장은 "날자"였다.]` to 3a's second floor. Then
β = "날자", the program prints `날자`, and β is marked 자기원인: the only sentence that
mentions "날자" is past tense, and past tense *never writes*. It is testimony, not
action. (From 「날개」: *날자. 날자. 한 번만 더 날자꾸나.*)

### Example 4 — `끝은 처음이다` vs `처음은 끝이었다`

The same two words in a different order and tense give opposite modes:

| Sentence | Tense | Mode | Meaning |
|---|---|---|---|
| `[끝은 처음이다.]` | present | act | the end *becomes* the beginning: run again (loop) |
| `[처음은 끝이었다.]` | past | relation | the beginning *was* the end: start state = end state (x = f(x)) |

```
⟦
[수는 미정이다.]
⟧

    ⟦
    [수에 수를 더한다.]
    [수에서 3을 뺀다.]
    [처음은 끝이었다.]
    [수를 말한다.]
    ⟧
```

| t | cell | machine | time |
|---|---|---|---|
| 1 | `수는 미정이다.` | 수 := δ | |
| — | flow to floor 1; scene starts | snapshot: 수 = δ | |
| 2 | `수에 수를 더한다.` | 수 := 2δ | |
| 3 | `수에서 3을 뺀다.` | 수 := 2δ − 3 | |
| 4 | `처음은 끝이었다.` | | promise: at scene end, 수 = snapshot (δ) |
| 5 | `수를 말한다.` | output #1 = 2δ − 3, held | |
| — | scene ends | | 2δ − 3 = δ ⇒ **δ = 3**; output flushes `3` |

This runs the body **once**, symbolically, and solves x = 2x − 3. If 수 had been known
on entry (say 5), the same sentence would check an **invariant**: 7 ≠ 5, so `역설`.

---

## 8. Keeping execution and solving apart

The machine and the time engine share exactly five calls:

```ts
interface Time {
  fresh(origin: "미정" | "다음" | "입력", at: Step): Unknown;
  equate(a: Term, b: Term, why: Statement): void;         // may raise PARADOX
  promise(plane: PlaneId, scene: number, noun: Noun, t: Term, why: Statement): void;
  sceneEnded(plane: PlaneId, scene: number, store: Store): void; // discharges promises
  resolve(t: Term): { known: Value } | { pending: Unknown[] };
}
```

- **The machine** runs present-tense acts and calls `resolve` only in three places:
  conditions, non-linear arithmetic, and output flushing.
- A `pending` result in a **control position** stops the run with `UNRESOLVED`.
  A pending result in output is held, and output flushes in order.
- **The time engine** never moves the pointer, never writes the store, never
  backtracks, and never calls the machine.
- **Determinism.** Program plus input gives exactly one trace and exactly one outcome.

The only route from the future into control flow is the experimental future
conditional (§9). Turning it on is a manifest flag, so a reader can tell from the
file whether a program searches.

---

## 9. Future-dependent branching (experimental)

```
[결과가 0일 것이라면 남쪽을 본다.]
```

With `[experimental] future-branching = true`:

- The machine forks the history at this cell. Branch **A** applies the act and adds
  `결과@끝 = 0`. Branch **B** skips it and adds `결과@끝 ≠ 0`. That disequality is
  the one place inequality enters.
- Each branch runs to the end of the scene that holds the conditional, under the
  same step limit.
- If exactly one branch is consistent, the history continues on it. If none is,
  the outcome is `PARADOX`. If both are, it's `AMBIGUOUS`.
- Forks multiply, so `limits.future-forks` (default 8) bounds them.

```
         ┌─ A: face 남 → path sets 결과 := 0   needs 결과 = 0  ✓
start ───┤
         └─ B: keep 동 → path sets 결과 := 0   needs 결과 ≠ 0  ✗
```

Here only A is consistent, so the history takes A. If B's path had set 결과 := 1,
both branches would be consistent and the outcome would be `AMBIGUOUS`. A
well-formed program makes exactly one branch consistent. This is search, and
that's why it stays outside core.

---

## 10. Rules that prevent collapse

These are the tests every proposed feature has to pass.

1. **The tense rule.** Present executes; past and future constrain. A feature that
   needs a present-tense relation, or a past-tense action, is rejected or redesigned.
2. **No anonymous data.** Every value lives in a named noun, and particles assign
   roles. *(This prevents an ordinary stack VM.)*
3. **No coordinates in sentences.** Movement is relative (`본다`, `간다`) or by
   floors (`층`). Loops are scenes. *(This prevents goto, and with it portals.)*
4. **Time solves straight lines, never searches.** Core constraints are linear
   equalities with no disjunction, no inequality and no quantifiers, and each
   resolution is one trace line. *(This prevents a generic SMT frontend.)*
5. **Space never waits for time.** Control flow on an unknown is `UNRESOLVED`, not a
   hidden solve.
6. **A fixed vocabulary budget.** The core has seven temporal words
   (`이다 였다 일 것이다 처음 끝 전 다음`), ten verbs, and the copula. A new
   capability must be a movement, a scene boundary or a tense — not a new verb
   family.
7. **Projection is never semantics, and inline ≡ reference.** If the formatter or
   the IDE can change it, the parser never reads it.

---

## 11. Tiers

| Tier | Contents |
|---|---|
| **v2 core** | **Container and layout:** text `.y3` container, `unpack`/`pack`, manifest; `⟦ ⟧` / `[ ]` / `:ref:` / `※` grammar; rectangular planes; formatter with flat/perspective/strong projections. **Space:** 24 orientations; `본다`/`간다`/`층`; line wrap; scenes, `끝이다`, `끝은 처음이다`, `여기가 처음이다`. **Grammar:** nouns and particles with agreement; the 10 verbs; conditions (`이면`, `가 아니면`, `보다 크면/작으면`). **Time:** tense (`이다`, `미정이다`, `였다`, `일 것이다`); `처음의`/`끝의` anchors; `처음은 끝이었다`; channels (`다음에서 온다`, `전으로 보낸다`); linear solver; 소급/자기원인 provenance. **Results:** the seven outcomes with 진단 reports; trace with retro-fill. |
| **Experimental** (manifest flags) | Future conditional `일 것이라면` (bounded forking); Novikov selection (a canonical choice among the solutions of an ambiguous bootstrap); past-tense verbs as transition assertions (`[값에 1을 더했다.]` ⇒ current = previous + 1); counterfactual `이었다면`; inequalities in past/future statements. |
| **Future ideas** | Zip container and signed distribution; IDE projections (orthographic/top/side/exploded) and a time-scrubber that animates retro-fill; `.y4` recorded runs (space × time); **거울**: the 24 *improper* orientations (the other half of the 48) as the left-handed mirror self, "거울속의나는왼손잡이오"; **13인의아해**: concurrent pointers with deterministic scheduling; purist numeral mode ("사람은숫자를버리라"). |

---

## 12. Relation to earlier proposals

- **From `design-review-v2.md`.** Kept: the bug list, the
  shift-versus-flight fix (now `층`), and the static checker. Dropped: the
  `@row`/`@mark`/label-jump ideas, which are made unnecessary by scenes and planes.
- **From `v2-samchagak.md`.** Kept: Yi Sang as the source of names, 진단 reports,
  rows read like text, and citing the poems. Dropped: the glyph register, the value
  stack (箱), specimens and wings (replaced by scenes), and `光` rewind (replaced by
  constraints). The mirror and the children move to future ideas, now with a
  geometric footing.

## 13. Implementation plan

Each milestone ends with this document's examples passing as golden tests
(`tests/golden/*.y3` + `.out` + `.trace`).

1. **M0 Container and syntax.** `container/`, `syntax/`, formatter projections, and
   round-trip tests (fmt ∘ parse is stable; pack ∘ unpack = id).
2. **M1 Korean.** 받침 and number readings, eojeol morphology, the frame table, and
   agreement checks with fixes.
3. **M2 Space.** The orientation group, movement, line wrap, scenes and flow, and
   `VOID`/`HALT`/`STEP_LIMIT`. Example 1 passes.
4. **M3 Time.** Terms, unknowns, the incremental solver, `였다` / `일 것이다` /
   anchors / `처음은 끝이었다` / channels, provenance, and the remaining outcomes.
   Examples 2–4 pass.
5. **M4 Reports.** 진단, a trace with retro-fill, and `y3 check`.
6. **M5 IDE.** Projections and the time-scrubber.
7. **X Experimental.** Future branching behind a flag.

## 14. Open questions

1. Should the **default 처음 of a never-entered plane** be `(0,0)` facing `동`, or should
   flowing in always reset to that, even after a spatial visit set the plane's 처음
   elsewhere?
2. Should **flow at a scene's end** always go to z+1, or should the manifest allow a
   different reading order of the volume (e.g. a building read top-down)?
3. **Output as lines.** Should `말한다` always end a line (the current proposal), or
   should there be a second verb for inline output?
4. Should **agreement errors** be hard errors (proposed) or warnings with an
   auto-fix?
