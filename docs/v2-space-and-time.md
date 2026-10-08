# Y3 v2 — 공간에서는 움직이고, 시간에서는 진술한다

> In space, Y3 moves. In time, Y3 states.

Status: **accepted design**. It is the basis for the v2 implementation, which starts with
milestone M0 (§13). It supersedes the language model in `v2-samchagak.md`; §12 lists
what carries over.

Every program in this document has been traced by hand against the rules stated
here. Each will become a conformance test as soon as the milestone that can run it
lands. Until then they are kept as parse and round-trip fixtures.

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | **`.y3` is one plain-text document.** It holds the volume, inline planes, and a `※` section of named planes. `y3 unpack` materialises a folder only when explicitly asked. There is no zip container. |
| D2 | **The authored space has hard edges.** A blank cell `[ ]` exists; a position with no cell is **VOID**. Stepping past a plane's edge is `VOID`. Rows never wrap. Wrapped or toroidal topology may come later as an explicit feature. |
| D3 | **No past machine snapshots.** The runtime keeps only the symbolic value versions and dependency information that temporal constraints need (§6.1). |
| D4 | **Orthography is lint, not syntax.** Interchangeable allomorphs (은/는, 이/가, 을/를, 으로/로, 이었다/였다) are all accepted, reported as non-canonical, and rewritten by the formatter. Particles and endings that change meaning stay semantic (§5.5). |
| D5 | **Loops are anchor-based cycles inside spatial execution**, not whole planes. `여기가 처음이다` opens a cycle, `끝은 처음이다` continues it, and a plane can hold several cycles (§4). |
| D6 | **One implementation language: TypeScript.** One parser, one semantic model. Integers are `bigint`. The solver is a small hand-written linear-equality solver: no Z3, no SMT, no Go. Rust is an option later only for an isolated solver (native + WebAssembly). |
| D7 | **Pipeline discipline:** source → AST → semantic model → runtime. The parser never constructs runtime behaviour. |

---

## 0. The idea in one table

| Dimension | Expressed by | Mode | Engine |
|---|---|---|---|
| **Y1** cell | one sentence in `[ ]` | — | — |
| **Y2** plane | a rectangle of cells in `⟦ ⟧` (a floor) | — | — |
| **Y3** space | an ordered stack of planes (a building) | — | — |
| **space** | layout, orientation, movement | **operational** | the machine |
| **time** | tense (`이다` / `였다` / `일 것이다`) | **relational** | the solver |
| **relation** | particles (`에 에서 을 으로 의 보다`) | assigns roles | the grammar |

The core rule:

> **현재형은 실행하고, 과거형과 미래형은 제약한다.**
> Present tense executes. Past and future tense constrain.
>
> **이다 replaces, 였다 reveals, 일 것이다 promises.**

The **tense morpheme is the type tag** of a sentence. From the sentence-final form
alone, the parser decides whether a cell is an action (the machine runs it) or a
relation (the solver records it). No cell is ever both.

### Answers at a glance

| # | Question | Short answer | § |
|---|---|---|---|
| 1 | Container in the architecture | A single text document parsed into an AST, then resolved into a semantic `Space`. Inline and named planes become identical layers. `unpack`/`pack` convert to and from a folder. | 1 |
| 2 | Y2 / Y3 grammar | An EBNF over `⟦ ⟧`, `[ ]`, `:name:`, and `※`. Indentation and gaps are never read. Planes are rectangular. | 2 |
| 3 | Orientation | 24 cube orientations (forward, up). `본다` turns, `간다` steps once, `층` translates in z. Edges are VOID. Default facing is 남, down the page. | 3 |
| 4 | Minimal temporal model | Immutable value versions with affine terms over unknowns. Linear equalities. No machine snapshots. | 6 |
| 5 | Unambiguous tense | A closed set of sentence-final forms. Orthographic variants are linted; meaning-bearing forms are parsed. Only the copula conjugates. | 5 |
| 6 | How much retrocausality is core | Equational retrocausality is core. Choosing among histories is experimental. | 9 |
| 7 | `끝은 처음이다` loops | Anchor-based cycles: `끝은 처음이다` continues, and a failed conditional `끝은 처음이다` closes the cycle. `처음은 끝이었다` is its relational twin. | 4, 7 |
| 8 | Separating execution and solving | Two engines behind five calls. Control flow on an unknown is `UNRESOLVED`. | 8 |
| 9 | Anti-collapse rules | Seven rules. | 10 |
| 10 | Tiers | Core / experimental / future. | 11 |

---

## 1. The `.y3` document

### 1.1 Logical model

A Y3 program is a **space**:

```
Space
  manifest    language version, name, start pose, limits, experimental flags
  layers      [Layer]           index = z
  Layer       { plane: Plane, presentation: inline | named(name) }
  Plane       { width, height, cells[y][x] }
```

- **Inline ≡ referenced.** A layer's `presentation` records whether the source wrote
  the plane inline or as `⟦ :name: ⟧`. Presentation is excluded from the semantic
  model: two documents that differ only in inline-versus-named are the same space.
  Extracting a plane into the `※` section, or inlining it back, never changes the space.
- **Reuse.** A named plane can be referenced from several layers, like one floor plan
  built on two storeys. Each reference is its own layer, with its own z and its own cells.

### 1.2 One text file

```
+++
name = "countdown"
+++

⟦
[값은 3이다.]
[여기가 처음이다.]
[값을 말한다.]
[값이 0이 아니면 끝은 처음이다.]
[끝이다.]
⟧

    ⟦ :basement: ⟧

※

:basement: ⟦
[ ]
[ ]
⟧
```

- The `+++` front matter is the manifest (TOML).
- After `※` comes the **appendix**: named planes that the volume refers to.
  (The mark is from 「오감도 시제6호」: 鸚鵡 ※ 二匹.)

`y3 unpack countdown.y3` writes:

```
countdown/
  META-INF/manifest.toml    # the front matter, if any
  space/main.y3s            # the volume; inline planes stay inline here
  planes/basement.y2        # one file per named plane; exactly one ⟦ … ⟧ each
```

`y3 pack countdown/` reverses it. `pack(unpack(doc))` is the canonical formatting of
`doc`, so the space is unchanged. **To Y3 a `.y2` is a plane, not a file**: it has no
imports and no path semantics, and `:basement:` is a name inside the space, never a path.

### 1.3 Code organisation (TypeScript)

```
src/
  language/   AST, document parser, (M2) sentence grammar, diagnostics
  space/      plane, volume (semantic model), (M1) orientation
  runtime/    (M1+) machine, movement, trace, outcomes
  temporal/   (M3+) symbols, versions, constraints, solver
  format/     formatter, projections, plane refactors
  container/  document I/O, pack / unpack
  v1/         the v1 interpreter, frozen until v2 can replace it
```

```
source ──parse──▶ AST ──resolve──▶ semantic model (Space) ──run──▶ outcome + trace
              (language/)        (space/)                   (runtime/ ⇄ temporal/)
```

The parser produces data, never closures or behaviour. The runtime consumes the
semantic model only.

CLI: `y3 check | fmt [--projection flat|perspective|strong] [--write] | unpack | pack`,
and later `run | trace`. v1's `validate | run | trace` keep working on v1 files until
v2 runs programs (M2).

---

## 2. Grammar of Y2 planes and Y3 space

### 2.1 EBNF

```ebnf
file        = [ frontmatter ] , { trivia } , volume , [ appendix ] , { trivia } ;
frontmatter = "+++" , NL , { toml-line } , "+++" , NL ;
volume      = plane-slot , { { trivia } , plane-slot } ;
plane-slot  = ws , "⟦" , ws , ref , ws , "⟧" , NL       (* referenced *)
            | inline-plane ;
inline-plane= ws , "⟦" , ws , row , ws , "⟧" , NL       (* one-row form *)
            | ws , "⟦" , ws , NL , row-line , { row-line } , ws , "⟧" , ws , NL ;
row-line    = ws , row , ws , NL ;
row         = cell , { ws , cell } ;
cell        = "[" , { cell-char | quoted } , "]" ;      (* blank or spaces = empty cell *)
quoted      = '"' , { char - ( '"' | "\" ) | "\" , char } , '"' ;
cell-char   = char - ( "[" | "]" | '"' | NL ) ;

appendix    = ws , "※" , ws , NL , { { trivia } , definition } ;
definition  = ws , ref , ws , inline-plane ;            (* a definition is never a ref *)
ref         = ":" , name , ":" ;
name        = ( letter | "_" ) , { letter | digit | "_" | "-" } ;   (* letter includes Hangul *)
trivia      = blank-line | comment-line ;
comment-line= ws , "#" , { char } , NL ;                (* never inside a plane *)
ws          = { " " | "\t" } ;
```

### 2.2 Layout rules

1. **Plane order defines z.** The *n*-th plane slot of the volume is `z = n`.
2. **Inside a plane, row index defines y and cell index defines x.** The origin is the
   top-left cell, x increases to the east, and y increases to the south (a floor plan).
3. **Planes are rectangular.** Every row has the same number of cells, so a missing
   cell is never a silent typo. `[ ]` is a real cell that does nothing.
4. **Outside every rectangle is VOID.** There is no implicit padding and no wrap.
5. **Planes may differ in size.** A 1×5 floor can sit over a 1×8 floor.
6. **Whitespace outside `[ ]` is never read.** That covers leading indentation, gaps
   between cells, and blank lines. *Indentation is projection, not syntax.*
7. **Inside a cell, runs of whitespace (outside quotes) mean one space.** The sentence's
   leading and trailing whitespace is dropped.
8. **Comments** are `#` lines outside planes. Each comment block belongs to the item that
   follows it. Comments after the last item belong to the end of the document.

### 2.3 Projection: the formatter's job

The same space has three renderings, and parsing any of them gives the same AST.

`flat` (indent 0):

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

`perspective` (default and canonical; indent 4 per layer):

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

`strong` (indent 5 per layer; gaps and padding shrink with depth):

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

The formatter can only shrink what it adds: gaps and column-alignment padding,
measured in display columns, where Hangul counts as two. It can **never** drop or
abbreviate cells. *Visual perspective is not geometry.*

In the appendix, definitions are ordered by first reference in the volume, and unused
ones come last in name order. Definitions sit at indent 0.

---

## 3. Orientation, movement, and floors

### 3.1 State

The pointer's **pose** is a position `p = (x, y, z)` and an orientation `(f, u)`:
**forward** and **up**, two perpendicular axis vectors. These give the **24** rotations
of a cube. **Right** is `r = u × f`.

Axes: `동 = +x`, `남 = +y`, `위 = +z` (floors), with `서`, `북`, `아래` as the opposites.

**Default pose: `(0,0,0)`, facing `남`, up `위`, so right is `서`.** Sentences are
written one per row, so reading goes down the page. (Facing south on a floor plan,
your right hand points west.)

### 3.2 Three verbs, three concepts

| Sentence | Kind | Effect |
|---|---|---|
| `[오른쪽을 본다.]` `[왼쪽을 본다.]` `[뒤를 본다.]` | turn (body frame) | `f ← r`, `f ← −r`, `f ← −f` |
| `[위를 본다.]` `[아래를 본다.]` | pitch (body frame) | `(f,u) ← (u, −f)`, `(f,u) ← (−u, f)` |
| `[동쪽을 본다.]` (and 서/남/북) | absolute face | `f ← compass`, `u ← 위` |
| `[앞으로 간다.]` and `뒤로`, `오른쪽으로`, `왼쪽으로`, `위로`, `아래로` | step (body frame) | move once by `f`, `−f`, `r`, `−r`, `u`, `−u`; **orientation unchanged** |
| `[위층으로 간다.]` `[아래층으로 간다.]` | translate (world frame) | `z ← z ± 1`; x, y and orientation unchanged |

- **`간다` replaces this step's normal advance.** The pointer lands on the target cell,
  executes it next, then continues along `f`. Continuous travel through floors happens
  only if you *face* along z (`위를 본다`) and keep walking.
- **`층` belongs to the building; `위` belongs to the body.** In the default pose,
  `위로 간다` and `위층으로 간다` coincide; after a pitch or roll they don't.
- Turning is meaningful while facing ±z, because `r = u × f` is always defined.

### 3.3 Edges

Each step executes the current cell, then advances one cell along `f`, unless the cell
moved the pointer itself.

- **Any move to a position with no cell is `VOID`.** That includes walking past a
  plane's edge, translating to a floor whose rectangle doesn't contain `(x, y)`, and
  moving to a z that has no layer.
- Programs end deliberately with `[끝이다.]` (§4). VOID is a distinct outcome, not a
  normal end.

---

## 4. Cycles: `처음` and `끝`

Loops are **anchors inside spatial execution**, and a plane can hold any number of them.

| Sentence | Tense | Effect |
|---|---|---|
| `[여기가 처음이다.]` | present → act | opens a cycle anchored here (this cell, this orientation). Running an anchor that is already open starts its next iteration, after closing any cycles opened inside it. |
| `[끝은 처음이다.]` | present → act | ends the current iteration of the innermost cycle and returns to its anchor, which runs next (**continue**) |
| `[⟨조건⟩ 끝은 처음이다.]` | present → control | if the condition holds, continue; **if not, the innermost cycle closes** and execution moves on (a do-while exit) |
| `[끝이다.]` | present → act | the end of the run: close every cycle (innermost first), then `HALT` |
| `[처음은 끝이었다.]` | past → relation | when the current iteration ends, every noun written during it must equal its value at the iteration's start (**fixed point / invariant**) |

Why a failed `끝은 처음이다` closes the cycle: *값이 0이 아니면 끝은 처음이다* reads
"unless 값 is 0, the end is the beginning". When 값 is 0, the end is just the end.

Cycles nest because they form a stack. Returning to an outer anchor discards any inner
cycles that are still open, so spatial detours (§7, Example 1) are safe.

`일 것이다` promises and `처음은 끝이었다` relations attach to the innermost open
iteration. With no cycle open, they attach to the end of the run.

---

## 5. Korean that carries meaning

### 5.1 Data lives in nouns, not a stack

Every value has a name: any Hangul noun the program introduces (`값`, `수`, `결과`,
`문장`, `원래`, …). Values are `bigint` integers or text. A noun must be introduced
(by `이다`, `미정이다`, `듣는다`, or `온다`) before it is read.

### 5.2 Particles assign roles; word order is free

| Particle | Role | Example |
|---|---|---|
| `은/는`, `이/가` | subject / topic | `[값은 3이다.]` `[값이 0이면 끝이다.]` |
| `을/를` | object / amount | `[값을 말한다.]` |
| `에` | target | `[값에 1을 더한다.]` → 값 := 값 + 1 |
| `에서` | source | `[값에서 1을 뺀다.]` → 값 := 값 − 1 |
| `으로/로` | direction, destination, means | `[위층으로 간다.]` `[값을 2로 나눈다.]` |
| `의` | temporal anchor | `[처음의 값은 0이었다.]` |
| `보다` | comparison | `[값이 3보다 크면 …]` |

Roles come from particles, so `[값에 1을 더한다.]` ≡ `[1을 값에 더한다.]`.

| Verb | Frame | Act |
|---|---|---|
| `더한다` | `N에` + `E을` | N := N + E |
| `뺀다` | `N에서` + `E을` | N := N − E |
| `곱한다` | `N에` + `E을` | N := N × E (one side known, §6.3) |
| `나눈다` | `N을` + `E로` | N := N ÷ E (both known) |
| `말한다` | `E을` | output E as one line |
| `듣는다` | `N을` | N := next input, or a fresh unknown if input is exhausted |
| `본다` | `D을` | turn (§3) |
| `간다` | `D으로` | step / translate (§3) |
| `온다` | `N이` + `다음에서` | open a channel (§6.2) |
| `보낸다` | `N을` + `전으로` | close a channel (§6.2) |

### 5.3 Only the copula conjugates

| Form | Tense | Kind | Meaning |
|---|---|---|---|
| `N은 E이다` | present | **act** | write N := E (a new version) |
| `N은 미정이다` | present | **act** | write N := a fresh unknown |
| `N은 E이었다` / `였다` | past | **relation** | assert: N's current version equals E (never writes) |
| `N은 E일 것이다` | future | **relation** | promise: N equals E when the current iteration (or the run) ends |
| `N이 E이면 ⟨act⟩` | present | **control** | if N = E (both known), do the act |
| `N이 E일 것이라면 ⟨act⟩` | future | **control** | *experimental* (§9) |

Verbs stay in present tense in core (`더한다`, never `더했다`): *actions happen now;
only states have tense.* `정해지지 않았다` would be past tense and so a relation; the
act form is `[값은 미정이다.]`.

### 5.4 Morphology (deterministic)

1. The cell text must end in `.`, which is stripped.
2. Split into eojeols on spaces. A quoted literal is one token.
3. **Predicate.** Match the final eojeol(s) right-to-left against the closed table
   (`…일 것이라면`, `…일 것이다`, `…이었다`, `…였다`, `…이다`, `…이면`, `…이 아니면`,
   `…보다 크면` / `작으면`, then the verbs). The longest match wins.
   A conditional sentence is the condition clause up to the first eojeol ending in
   `면`, followed by one consequence clause.
4. **Noun phrases.** Each other eojeol is exactly one noun or literal plus exactly one
   particle.
5. **Frame match.** Missing or extra roles are errors.

### 5.5 Orthography is lint (D4)

| Pair | Canonical after consonant | Canonical after vowel | Status |
|---|---|---|---|
| 은/는, 이/가, 을/를, 와/과 | 은, 이, 을, 과 | 는, 가, 를, 와 | lint |
| 으로/로 | 으로 (ㄹ-final takes 로) | 로 | lint |
| 이었다/였다 | 이었다 | 였다 | lint |
| 은·는 vs 이·가 in a statement | topic form | | lint |

- **Parser:** accepts either form, because the meaning is identical.
- **Diagnostic:** reports non-canonical Korean as a warning, with the fix.
- **Formatter:** rewrites to the canonical form.

Numbers use their Sino-Korean reading: `3` 삼 → `3이었다`, `4` 사 → `4였다`, `1` 일 → `1로`,
`10` 십 → `10을`. Text literals use their last Hangul syllable, and a non-Hangul ending
has no canonical form.

**What stays semantic:** the role particles (`에`, `에서`, `을/를`, `으로/로`, `의`, `보다`),
tense (`이다` / `였다` / `일 것이다`), and the conditional ending `면`. Getting these wrong
changes the meaning, so they are errors, not lint.

**Ambiguity rule:** if accepting a non-canonical allomorph would give two different
parses (two different known nouns), the canonical parse wins. If it doesn't exist, the
parser reports an error asking for a respelling.

---

## 6. The temporal model

### 6.1 What the runtime keeps (D3)

The runtime does **not** keep past machine states: no past positions, orientations,
cycle stacks, or stores. It keeps only the symbolic material that temporal constraints
refer to:

```
Version   = { id, noun, term, born: step }          immutable; every write makes one
Term      = bigint | text | unknown | Σ cᵢ·αᵢ + c   (affine, known integer coefficients)
Unknown   = { id, origin: 미정 | 다음 | 입력, born: step, provenance? }
Store     = noun → current Version id               (current only)
Snapshot  = per open iteration: noun → Version id   (ids, not values or states)
Equation  = { left: Term, right: Term, why: statement + step }
Promise   = { iteration | run, noun, term, made: step }
Channel   = per-noun stack of open slots { unknown, opened: step }
Output    = [Term]; flushed in order up to the first undetermined term
```

Take the retrocausal example:

```
v0 = α            (값은 미정이다 — α born)
v1 = α + 1        (값에 1을 더한다 — a new version, term over α)
constraint v1 = 4 (값은 4였다)  ⇒  α + 1 = 4  ⇒  α = 3
```

`v0` and `v1` are kept because their terms mention an unknown that is still unresolved.
They are values and dependencies, not snapshots of the machine. A version whose term is
fully determined, and which no snapshot, promise, slot or held output refers to, can be
discarded.

The debugging trace is a separate, optional record that plays no part in semantics.

### 6.2 Solving and channels

- **Unification plus Gaussian elimination** over linear integer equations, run
  incrementally as each equation arrives. Text unknowns only unify. A system with no
  solution, or whose unique solution isn't an integer, is a `PARADOX`. An undetermined
  unknown that output depends on is `AMBIGUOUS` at the end.
- `[N이 다음에서 온다.]` sets N := a fresh unknown β and pushes an open slot for N.
- `[N을 전으로 보낸다.]` pops N's most recent slot and adds `β = current N`. With no
  open slot, it's a `PARADOX`: no past is listening.

### 6.3 Limits that keep it small

Multiplying an unknown by an unknown, dividing an unknown, and comparing or branching
on an unknown all make the run `UNRESOLVED`. *Time solves straight lines.*

### 6.4 Provenance

| Mark | When |
|---|---|
| **소급 RETRO** | determined by an equation made later in time than the unknown's birth |
| **자기원인 SELF_CAUSED** | born on a channel; the term sent back to its slot contains that same unknown; no present-tense act or input contributed its value. Past and future statements may pin it, because testimony is not a cause. |

### 6.5 Outcomes

| Status | 진단 | Exit | Meaning |
|---|---|---|---|
| `HALT` | 정지 | 0 | reached `끝이다`; consistent; all output determined |
| `FAULT` | 고장 | 1 | ordinary error (division by zero, `끝은 처음이다` with no open cycle) |
| `VOID` | 허공 | 2 | moved to a position with no cell |
| `STEP_LIMIT` | 한계 | 3 | step budget exhausted |
| `PARADOX` | 역설 | 4 | constraints are inconsistent (both statements named) |
| `UNRESOLVED` | 미결 | 5 | control needed a value that only the future could decide |
| `AMBIGUOUS` | 중의 | 6 | consistent, but some output has more than one consistent value |

---

## 7. Worked examples

Trace columns: **t** step · **pos** `(x,y,z)` · **cell** · **effect**. The pose is the
default (facing 남, up 위) unless stated.

### Example 1 — conditional, loop, and a detour upstairs

```
⟦
[값은 3이다.]
[여기가 처음이다.]
[값을 말한다.]
[값이 2이면 위층으로 간다.]
[값에서 1을 뺀다.]
[값이 0이 아니면 끝은 처음이다.]
["발사"를 말한다.]
[끝이다.]
⟧

    ⟦
    [ ]
    [ ]
    [ ]
    ["둘"을 말한다.]
    [아래층으로 간다.]
    ⟧
```

| t | pos | cell | effect |
|---|---|---|---|
| 1 | (0,0,0) | `값은 3이다.` | 값 := 3 |
| 2 | (0,1,0) | `여기가 처음이다.` | open cycle A, iteration 1 |
| 3 | (0,2,0) | `값을 말한다.` | out `3` |
| 4 | (0,3,0) | `값이 2이면 위층으로 간다.` | 3 ≠ 2 |
| 5 | (0,4,0) | `값에서 1을 뺀다.` | 값 := 2 |
| 6 | (0,5,0) | `값이 0이 아니면 끝은 처음이다.` | 2 ≠ 0 → back to A |
| 7 | (0,1,0) | `여기가 처음이다.` | A, iteration 2 |
| 8 | (0,2,0) | `값을 말한다.` | out `2` |
| 9 | (0,3,0) | `값이 2이면 위층으로 간다.` | 2 = 2 → translate to (0,3,1) |
| 10 | (0,3,1) | `"둘"을 말한다.` | out `둘` |
| 11 | (0,4,1) | `아래층으로 간다.` | translate to (0,4,0) |
| 12 | (0,4,0) | `값에서 1을 뺀다.` | 값 := 1 |
| 13 | (0,5,0) | `값이 0이 아니면 끝은 처음이다.` | 1 ≠ 0 → back to A |
| 14 | (0,1,0) | `여기가 처음이다.` | A, iteration 3 |
| 15 | (0,2,0) | `값을 말한다.` | out `1` |
| 16 | (0,3,0) | `값이 2이면 위층으로 간다.` | 1 ≠ 2 |
| 17 | (0,4,0) | `값에서 1을 뺀다.` | 값 := 0 |
| 18 | (0,5,0) | `값이 0이 아니면 끝은 처음이다.` | 0 = 0 → **cycle A closes**; move on |
| 19 | (0,6,0) | `"발사"를 말한다.` | out `발사` |
| 20 | (0,7,0) | `끝이다.` | `HALT` |

```
3
2
둘
1
발사
진단: 정지 (HALT) · 20보
```

The branch is a **stairwell**: floor 1's row 3 lies directly above the conditional, and
its row 4 lies directly above the cell where the loop resumes. Floor 1's blank cells
are what keep the alignment, and the projection shows them as a narrower, shorter
floor. Without `[끝이다.]`, step 20 would walk off the plane and the outcome would be
`허공 (VOID)`.

### Example 2 — the future determines the past

```
⟦
[값은 미정이다.]
[원래는 값이다.]
[값에 1을 더한다.]
[원래를 말한다.]
[위층으로 간다.]
⟧

    ⟦
    [ ]
    [ ]
    [ ]
    [ ]
    [값은 4였다.]
    [끝이다.]
    ⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `값은 미정이다.` | 값 := v0 = α | α born (미정, t1) |
| 2 | (0,1,0) | `원래는 값이다.` | 원래 := v1 = α | |
| 3 | (0,2,0) | `값에 1을 더한다.` | 값 := v2 = α + 1 | |
| 4 | (0,3,0) | `원래를 말한다.` | output #1 = α, **held** | |
| 5 | (0,4,0) | `위층으로 간다.` | → (0,4,1) | |
| 6 | (0,4,1) | `값은 4였다.` | (relation: no write) | v2 = 4 ⇒ α + 1 = 4 ⇒ **α = 3** [소급 t6 → t1]; output #1 flushes `3` |
| 7 | (0,5,1) | `끝이다.` | `HALT` | |

```
3
진단: 정지 (HALT) · 7보 · α = 3 [소급 t6 → t1]
```

**The same thing as a prophecy** (one plane, future tense):

```
⟦
[값은 미정이다.]
[값은 4일 것이다.]
[원래는 값이다.]
[값에 1을 더한다.]
[원래를 말한다.]
[끝이다.]
⟧
```

At t2 the promise "값 at the end of the run = 4" is recorded, with no cycle open. At t6
`끝이다` ends the run: α + 1 = 4, so α = 3, and the output is `3`. The promise was spoken
*before* the addition but binds what comes *after* it.

**Variants:**

- Add `[원래는 2였다.]` on floor 1, between `값은 4였다` and `끝이다`:
  ```
  진단: 역설 (PARADOX) · t7 [원래는 2였다.] contradicts t6 [값은 4였다.] (α = 3)
  ```
- Replace `[위층으로 간다.]` with `[끝이다.]` and delete floor 1:
  ```
  ?
  진단: 중의 (AMBIGUOUS) · α unconstrained (born t1 [값은 미정이다.])
  ```
- Insert `[원래가 3이면 끝이다.]` before `원래를 말한다`:
  ```
  진단: 미결 (UNRESOLVED) · t4 needs α; only the future could decide it
  ```

### Example 3 — the bootstrap trio (canonical temporal conformance set)

**3a. β = β → AMBIGUOUS**

```
⟦
[문장이 다음에서 온다.]
[문장을 말한다.]
[위층으로 간다.]
⟧

    ⟦
    [ ]
    [ ]
    [문장을 전으로 보낸다.]
    [끝이다.]
    ⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `문장이 다음에서 온다.` | 문장 := β | slot S₁ opened (t1) |
| 2 | (0,1,0) | `문장을 말한다.` | output #1 = β, held | |
| 3 | (0,2,0) | `위층으로 간다.` | → (0,2,1) | |
| 4 | (0,2,1) | `문장을 전으로 보낸다.` | | close S₁: β = β (tautology) |
| 5 | (0,3,1) | `끝이다.` | end | β undetermined; output #1 depends on it |

```
?
진단: 중의 (AMBIGUOUS) · β is self-consistent but has no unique value
```

**3b. β = 2β → unique self-caused 0**

```
⟦
[수가 다음에서 온다.]
[수에 수를 더한다.]
[수를 말한다.]
[위층으로 간다.]
⟧

    ⟦
    [ ]
    [ ]
    [ ]
    [수를 전으로 보낸다.]
    [끝이다.]
    ⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `수가 다음에서 온다.` | 수 := β | slot S₁ |
| 2 | (0,1,0) | `수에 수를 더한다.` | 수 := 2β | |
| 3 | (0,2,0) | `수를 말한다.` | output #1 = 2β, held | |
| 4 | (0,3,0) | `위층으로 간다.` | → (0,3,1) | |
| 5 | (0,3,1) | `수를 전으로 보낸다.` | | close S₁: β = 2β ⇒ **β = 0** [자기원인]; flush `0` |
| 6 | (0,4,1) | `끝이다.` | `HALT` | |

```
0
진단: 정지 (HALT) · 6보 · β = 0 [자기원인: S₁ t5 → t1]
```

No literal, no input, and no write ever produced the 0. It is the only number that can
survive its own trip through time.

**3c. β = β + 1 → PARADOX**

```
⟦
[수가 다음에서 온다.]
[수에 1을 더한다.]
[위층으로 간다.]
⟧

    ⟦
    [ ]
    [ ]
    [수를 전으로 보낸다.]
    [끝이다.]
    ⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `수가 다음에서 온다.` | 수 := β | slot S₁ |
| 2 | (0,1,0) | `수에 1을 더한다.` | 수 := β + 1 | |
| 3 | (0,2,0) | `위층으로 간다.` | → (0,2,1) | |
| 4 | (0,2,1) | `수를 전으로 보낸다.` | | close S₁: β = β + 1 ⇒ 0 = 1 |

```
진단: 역설 (PARADOX) · t4 sent β+1 to t1, which received β
```

**3d. Testimony, not cause.** In 3a, insert `[문장은 "날자"였다.]` between
`문장을 전으로 보낸다` and `끝이다`. (It must be at or below row 2, where the pointer
arrives; a cell above the landing point never runs.) β = "날자", the output is `날자`,
and β is marked 자기원인: past tense never writes.

### Example 4 — `끝은 처음이다` vs `처음은 끝이었다`

| Sentence | Tense | Mode | Meaning |
|---|---|---|---|
| `[끝은 처음이다.]` | present | act | the end *becomes* the beginning: run again |
| `[처음은 끝이었다.]` | past | relation | the beginning *was* the end: start state = end state (x = f(x)) |

```
⟦
[수는 미정이다.]
[여기가 처음이다.]
[수에 수를 더한다.]
[수에서 3을 뺀다.]
[처음은 끝이었다.]
[수를 말한다.]
[끝이다.]
⟧
```

| t | pos | cell | machine | time |
|---|---|---|---|---|
| 1 | (0,0,0) | `수는 미정이다.` | 수 := v0 = δ | |
| 2 | (0,1,0) | `여기가 처음이다.` | open A; snapshot {수: v0} | |
| 3 | (0,2,0) | `수에 수를 더한다.` | 수 := v1 = 2δ | |
| 4 | (0,3,0) | `수에서 3을 뺀다.` | 수 := v2 = 2δ − 3 | |
| 5 | (0,4,0) | `처음은 끝이었다.` | | at A's iteration end: 수 = v0 |
| 6 | (0,5,0) | `수를 말한다.` | output #1 = 2δ − 3, held | |
| 7 | (0,6,0) | `끝이다.` | close A → `HALT` | 2δ − 3 = δ ⇒ **δ = 3**; flush `3` |

The body runs **once**, symbolically, and solves x = 2x − 3. Had 수 been known on entry
(say 5), the same sentence would check an **invariant** instead: 7 ≠ 5, so `역설`.
Replacing `처음은 끝이었다` with `끝은 처음이다` turns the relation back into a loop. That
loop never exits, and the outcome is `한계 (STEP_LIMIT)`.

---

## 8. Keeping execution and solving apart

```ts
interface Time {
  fresh(origin: "미정" | "다음" | "입력", at: Step): Unknown;
  equate(a: Term, b: Term, why: Statement): void;          // may raise PARADOX
  promise(at: IterationRef | "run", noun: Noun, t: Term, why: Statement): void;
  iterationEnded(at: IterationRef | "run", store: Store): void;  // discharges promises
  resolve(t: Term): { known: Value } | { pending: Unknown[] };
}
```

- **The machine** runs present-tense acts and calls `resolve` only for conditions,
  non-linear arithmetic, and output flushing. A pending result in a control position
  stops the run with `UNRESOLVED`.
- **The time engine** never moves the pointer, never writes the store, never
  backtracks, and never calls the machine.
- **Determinism.** Program plus input gives exactly one trace and one outcome.

---

## 9. Future-dependent branching (experimental)

```
[결과가 0일 것이라면 동쪽을 본다.]
```

With `[experimental] future-branching = true`:

- The machine forks the history at this cell. Branch **A** applies the act and adds
  `결과 = 0` at the iteration's end. Branch **B** skips it and adds `결과 ≠ 0`, the one
  place an inequality enters.
- If exactly one branch is consistent, execution continues on it. If none is, the
  outcome is `PARADOX`; if both are, it's `AMBIGUOUS`.
- Forks are bounded by `limits.future-forks` (default 8).

This is search, which is why it stays outside core.

---

## 10. Rules that prevent collapse

1. **The tense rule.** Present executes; past and future constrain.
2. **No anonymous data.** Values live in named nouns, and particles assign roles.
   *(This prevents a stack VM.)*
3. **No coordinates in sentences.** Movement is relative, or by floors. Loops are
   anchors. *(This prevents goto.)*
4. **Time solves straight lines, never searches** (in core). *(This prevents SMT.)*
5. **Space never waits for time.** Control flow on an unknown is `UNRESOLVED`.
6. **A fixed vocabulary budget.** Seven temporal words (`이다 였다 일 것이다 처음 끝 전
   다음`), ten verbs, and the copula. New capability must be a movement, a cycle
   boundary or a tense.
7. **Projection is never semantics, and inline ≡ reference.**

---

## 11. Tiers

| Tier | Contents |
|---|---|
| **v2 core** | Text `.y3` document, `⟦ ⟧`/`[ ]`/`:ref:`/`※`, rectangular planes, VOID edges, formatter projections, `pack`/`unpack`; 24 orientations, `본다`/`간다`/`층`; anchor cycles (`여기가 처음이다`, `끝은 처음이다`, `끝이다`); nouns, particles, frames, orthography lint; `bigint`; tense (`이다`, `미정이다`, `였다`, `일 것이다`), `처음의`/`끝의`, `처음은 끝이었다`; channels; linear solver; provenance; seven outcomes with 진단 reports. |
| **Experimental** (manifest flags) | Future conditional `일 것이라면`; Novikov selection for ambiguous bootstraps; past-tense verbs as transition assertions; counterfactual `이었다면`; inequalities in past/future statements. |
| **Future ideas** | Explicit wrapped/toroidal topology; IDE projections (orthographic/top/side/exploded) and a time-scrubber; `.y4` recorded runs (space × time); **거울**, the 24 improper orientations as the left-handed mirror self; **13인의아해**, concurrent pointers; a Rust solver behind the same interface, for native and WebAssembly. |

---

## 12. Relation to earlier proposals

- **From `design-review-v2.md`:** the bug list, the shift-versus-flight fix (now `층`),
  and static checking carry over. Label jumps do not, because cycles replace them.
- **From `v2-samchagak.md`:** Yi Sang naming, 진단 reports, and citing the poems carry
  over. The glyph register, value stack, wings, and `光` rewind are dropped. The mirror
  and the children are future ideas.

## 13. Implementation plan

**Branches.** Design lives on `claude/brave-einstein-sv6mxm` and is merged to `main`
first. Each milestone then gets a fresh branch from the updated `main`, starting with
`v2/m0-space`.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 document** | single-file document model; `[ ]` cells; `⟦ ⟧` planes; inline planes; `:name:` refs; `※` section; rectangular validation; canonical formatting; projections; `pack`/`unpack`. **No sentence grammar, no runtime.** | `parse(format(parse(s))) = parse(s)` for every projection; `format` is idempotent; inline ≡ named (structural and semantic); `pack(unpack(s)) = format(s)` |
| **M1 space** | 24-orientation group, movement, translation, VOID, step loop (driven by test stubs, not sentences) | orientation group laws; VOID cases |
| **M2 present tense** | sentence morphology and frames, orthography lint, `bigint` values, present-tense acts, anchor cycles, `HALT`/`FAULT`/`STEP_LIMIT` | Example 1 runs |
| **M3 past/future** | versions, unknowns, solver, `였다` / `일 것이다` / anchors, `UNRESOLVED` | Example 2 and its variants run |
| **M4 temporal loops** | channels, `처음은 끝이었다`, provenance, `PARADOX` / `AMBIGUOUS` reporting | **the bootstrap trio and Example 4 run as conformance tests** |
| **M5 IDE** | projections, debugger, time-scrubber | — |

The bootstrap trio and the other examples are checked in at M0 under
`tests/conformance/` with their expected outcomes. M0 parses and round-trips them, and
their execution tests are marked `todo` until M2–M4 enable them.

## 14. Open questions

1. **Output lines.** Should `말한다` always end a line (current proposal), or should a
   second verb print inline?
2. **Default facing 남.** This follows from D2: with no wrap, a column of sentences
   facing 동 would hit the void after one cell. Does 남 match your intuition, or should
   the manifest's `start.facing` be mandatory?
3. **Lint severity.** Should non-canonical orthography be a warning (proposed) or an
   info-level hint?
