# 삼차각설계도 — Y3 v2 concept

> 사각형의내부의사각형의내부의사각형의내부의사각형의내부의사각형.
> — 이상, 「건축무한육면각체」 (1932)

Status: concept. Its language model is superseded by `v2-space-and-time.md`; see §12 there. This document replaces section 5 of `design-review-v2.md` and goes
further. It doesn't try to stay compatible with v1. Only the **verse register** (§3)
descends from v1's sentences.

Yi Sang (李箱, 1910–1937) trained and worked as an architect, then wrote poems
that look like blueprints: digit grids, dotted diagrams, mirrored text, unspaced
lines, equations. The 箱 in his pen name means *box*. Y3 v2 takes him literally:
**a program is a blueprint that runs.**

The title borrows his 「삼차각설계도」 (1931), "design for a third-degree angle".
Y3 already has three spatial axes. The "third angle" here is the one beyond them:
**time**, which he imagined outrunning light to look back at the past.

---

## 0. Laws

Every feature must obey these five laws.

1. **정밀 (precision).** Execution is deterministic and the vocabulary is closed.
   Every written form maps to exactly one operation. There is no NLP and no inference.
2. **띄어쓰기없음 (no spacing).** Whitespace inside a line carries no meaning.
   `값은3이오` and `값은 3이오` are the same line. This is his typographic signature,
   and it makes the grammar simpler.
3. **출전 (citation).** No feature without a poem. Every construct names the text
   it comes from (the tables below have a *source* column). If a feature has no
   source, it doesn't go in.
4. **종이 (paper).** A pointer *reads along* a page and only *crosses between* pages.
   Headings are in-page (前後左右). Moving through pages (上下) is always a single
   shift that keeps the reading heading. This fixes the "flying off the program"
   problem from the v1 review.
5. **진단 (diagnosis).** Every run ends with a diagnosis, the way 「오감도 시제4호」 ends
   with `진단 0:1`.

---

## 1. Space — 건축무한육면각체

A program is a **hexahedron**: a stack of **pages** (z). Each page is a grid of
cells (x, y). There are two ways to write a page:

| Register | Directive | Looks like | Read |
|---|---|---|---|
| **도 (圖, drawing)** | `@도 N` | a 2D grid of single glyphs, like 시제4호's digit grid | across, starting at `▽`, heading 右 |
| **시 (詩, verse)** | `@시 N` | one 하오체 sentence per line, unspaced | down a single column, heading 後 |

Both registers compile to the same cells. Every operation has a **glyph** and a
**sentence**, so a program can be dense like 오감도 or long like 날개, and you can
mix pages of each kind.

Empty cells in a drawing are written `・`, after the dotted grids of 「선에관한각서」.

### Topology is declared in his words

| Line (exact) | Meaning | Source |
|---|---|---|
| `길은막다른골목이적당하오` | **bounded** (default): a pointer that steps off the hexahedron stops | 시제1호 |
| `길은뚫린골목이라도적당하오` | **open**: edges wrap around, so space is a 3-torus | 시제1호; 「건축무한육면각체」 "사각이난원운동" |

### Boxes — 箱, 사각형의내부의사각형

Any cell can be a **box**: a whole hexahedron nested inside one cell.

```
@箱 倍          # defines the glyph 倍 as a box
@도 0
▽鸚＋           # enter, duplicate, add, step out the east face
```

```
@도 0
▽３倍數。        # prints 6
```

- **Entering** a box cell is a call. The pointer appears at the box's `▽` and
  **keeps the heading it came in with**, so a box can react to which side you
  entered from.
- **Leaving** a box's bounding hexahedron is a return. Boxes are always bounded.
  The pointer comes out of the box cell in the caller, **travelling in the
  direction it left by**.
- So **a box returns a direction**. It has up to six exits: east, west, front,
  back, and through the top or bottom page. A predicate needs no boolean; it just
  leaves by a different face. Control flow and space become the same thing.
- A box may contain its own glyph. That is recursion, and the space becomes
  무한육면각체 (an infinite hexahedron).

### Ancestry — 「오감도 시제2호」

> 나의아버지가나의곁에졸적에나는나의아버지가되고또나는나의아버지의아버지가되고…

The call stack is **ancestry**. Inside one box, 나 *becomes my father*. Two boxes deep,
my father's father. Traces and the IDE name each frame this way:

```
제7보  나의아버지의아버지  倍(0,0,0) 右  箱[3,3]
```

---

## 2. The self — ▽ and 箱

| Glyph | Meaning | Source |
|---|---|---|
| `▽` | 나, the pointer, and where it starts | 「▽의유희」 (1931) |
| `箱` | the box 나 carries, which is the value stack. Pushing puts a square inside a square. | 李箱; 「건축무한육면각체」 |

The program has no separate memory tape. Working values ride in 나's 箱 (box),
and long-term data lives in **the blueprint itself** (§4: `刻` / `讀`).

---

## 3. Vocabulary (core)

Verse sentences are in 하오체, his own voice ("질주하오", "적당하오", "없소").

| Glyph | Verse (canonical, unspaced) | Operation | Source |
|---|---|---|---|
| `前` `後` `左` `右` | `앞을향하오` `뒤를향하오` `왼쪽을향하오` `오른쪽을향하오` | set in-page heading | 시제5호 "전후좌우를제하는" |
| `上` `下` | `위로가오` `아래로가오` | shift one page and keep heading. This is the axis "left after excluding 前後左右". | 시제5호 |
| `／` `＼` | `선이꺾이오` (／), `선이되꺾이오` (＼) | deflect the heading like a mirror line | 「선에관한각서」 |
| `─` `│` | — | wire (no-op), so drawings read as drawings | 「선에관한각서」 |
| `０`–`９` | `값은N이오` | push a number | 시제4호 digit grid |
| `「…」` | `"…"이오` | push each character's code point in reading order | — |
| `＋` `－` `×` `÷` | `더하오` `빼오` `곱하오` `나누오` | arithmetic | 「선에관한각서2」 "1+3 3+1" |
| `否` | `아니하오` | logical not (0 ↔ 1) | 시제3호 "싸움하는사람은즉싸움하지아니하던사람이고" |
| `鸚` | `앵무二匹` | duplicate: one parrot becomes two | 시제6호 "鸚鵡 ※ 二匹" |
| `換` | `바꾸오` | swap the top two values | — |
| `岐` | `영이아니면위로가오` | pop; if ≠ 0, shift 上 to the parallel page; else keep going | Law 4 |
| `刻` / `讀` | `새기오` / `읽소` | carve top value into the cell ahead as a glyph / read the cell ahead's glyph | the architect redrawing his own plan |
| `蝶` / `數` | `나비가말하오` / `숫자로말하오` | output as character / as number | 시제10호 |
| `耳` | `듣소` | read one input value | 「거울」 "거울속에도내게귀가있소" |
| `剝` | `박제가되오` | leave a specimen: remember this cell and heading | 「날개」 |
| `翼` | `날자` | fly back to the specimen | 「날개」 "날자. 날자. 한번만더날자꾸나." |
| `。` | `。` | stop this pointer | his full stops |

With `刻`/`讀`, programs can modify their own blueprint, and space is unbounded.
Together these make the core Turing-complete in the same way Befunge-98 is.

### Butterflies only speak at the wall — 시제10호

> 찢어진벽지에죽어가는나비를본다. 그것은유계에낙역되는비밀한통화구다.

`蝶` and `數` only work on cells at the **boundary of their page** (the torn
wallpaper). In a drawing, a pointer has to *walk to the wall* to say anything.
A verse page is a single column, so every line is on the wall: **a poem is always
speaking.**

### Wings — 「날개」, one specimen per room

> 박제가되어버린천재를아시오?

- `剝` turns the current moment into a specimen: this cell plus the current heading.
  The values in the box are **not** frozen. The genius is stuffed, but his mind goes on.
- `翼` flies back to that specimen. That's the loop: `剝 … 翼`.
- **Each box frame holds exactly one specimen.** The narrator of 날개 never leaves his
  room. Nested loops therefore need nested boxes, which gives structured
  programming through architecture.

---

## 4. Examples (core only)

### 이상

```
@도 0
▽「상이」蝶蝶。
```

The string pushes `상` then `이`, so the top is `이`. Two butterflies print `이상`.
You write his name backwards and the machine says it forwards.

### Countdown, as a drawing

```
@도 0
▽３剝鸚數１－鸚岐。
@도 1
・・・・・・・・翼・
```

Prints `321`. While the counter is non-zero, `岐` steps through to page 1. Page 1
holds only a wing, in the same column, which flies back to the specimen on page 0.
At zero, `岐` lets the pointer pass and `。` ends the run. **The alternative
literally sits on the parallel page.**

### The same program, as verse

```
@시 0
값은3이오
박제가되오
앵무二匹
숫자로말하오
값은1이오
빼오
앵무二匹
영이아니면위로가오
。
@시 1
@줄 7
날자
```

`@줄 7` puts `날자` on line 7 of page 1, directly behind `영이아니면위로가오`.

---

## 5. Time — 「이상한가역반응」 and 「선에관한각서」

> 사람은광선보다빠르게달아나면사람은광선을보는가

His 1931 poem 「이상한가역반응」 ("strange reversible reaction") names the idea: the
**Y3 machine is reversible**.

| Glyph | Verse | Operation |
|---|---|---|
| `光` | `광선보다빠르게달아나오` | outrun light: **run time backwards** |
| `目` | `보오` | pop the top value into **the eye** |
| `憶` | `기억하오` | push what the eye holds |

- Every forward step leaves a **흔적 (trace)** on its cell (시제5호 "유일의흔적"). The trace
  is the undo record for that step. The IDE draws traces as dots, so a running program
  slowly covers itself in his dotted grids.
- `光` flips the arrow of time. The pointer walks back along its path, **undoing**
  every step (un-adding, un-carving, un-popping) and wiping each trace as it goes.
  It stops at **the room's specimen** (`剝`), or at the room's entrance if there is none,
  and runs forward again.
- **Only the eye remembers.** Everything is undone except the value in `目`. That
  is how knowledge travels into the past: "미래로달아나서과거를본다". The eye is
  시제5호's 目大不覩, big eyes that see nothing in the present.
- **What's said can't be unsaid.** Undoing a butterfly is impossible, because the
  message has already passed to the nether world. Reaching one while reversing ends
  the run with `진단 역설` (paradox).
- A rewind that brings no new knowledge back repeats forever. That is honest
  determinism, and the step limit reports it as an unfinished diagnosis.

**So there are two ways back to a specimen.** Wings return through **space** and keep
your values. Light returns through **time** and keeps only what you saw. Backtracking
search is: compute, store "what I learned" in the eye, outrun light, recall, try the
next option. It leaves no garbage behind (Bennett's uncomputation trick, made visible).

```
@도 0
▽３數光
```

This prints `3`, outruns light, and immediately tries to unsay `3`, giving `진단 역설`.
It's the shortest lesson in the language.

---

## 6. The mirror — 「거울」 (1933)

> 거울속에는소리가없소 … 거울속의나는왼손잡이오 … 거울속의나는참나와는반대요마는또꽤닮았소

`@거울 x=4` places a mirror plane. Planes can also be on `y=` or `z=`. Declaring one brings
**거울속의나** (the self in the mirror) into existence:

- It starts at the reflection of `▽` and moves as the reflection of 나:
  **left-handed**.
- It reads the cell at its own position, interpreted as the **dual**:
  - digits push their negation
  - `＋`↔`－` and `×`↔`÷`
  - `／`↔`＼`
  - headings mirrored across the plane
- **It is silent**: `蝶` and `數` do nothing (거울속에는소리가없소).
- **It is deaf**: `耳` gives 0 (내말을못알아듣는딱한귀).
- **They meet only on the glass.** The plane is the set of points that the reflection
  leaves fixed, so it's the only place both selves can stand at once. When they do,
  **they swap boxes**. ("거울아니었던들내가어찌거울속의나를만나보기라도했겠소")

```
길은막다른골목이적당하오
@거울 x=4
@도 0
▽７・・│・數３・
```

- 나 pushes 7 while the reflection, at the mirrored cell, pushes −3.
- They meet on the glass at x=4 and exchange boxes.
- 나 walks on and prints `-3`, a number it was never given. The 7 is never seen.
- The diagnosis is `진단 0:2`: two selves were born and both ended.

Writing for the mirror means writing **palindromic programs**: one page, two
interleaved computations, like 시제4호's mirrored digits.

---

## 7. The children — 「오감도 시제1호」

> 13인의아해가도로로질주하오. … 13인의아해는무서운아해와무서워하는아해와그렇게뿐이모였소.

| Glyph | Verse | Operation |
|---|---|---|
| `兒` | `아해가질주하오` | a child starts running from the cell ahead, turned clockwise. The children are numbered 제1의아해…제13의아해. |
| `告` | `무섭다고그리오` | put the top value on **the road** (a shared queue). This makes the child frightening. |
| `怖` | `무서워하오` | wait until the road holds something, then take it. This makes the child frightened. |

- There are **never more than 13**. A fourteenth child is an error.
- Each tick runs a fixed order: 나, then 거울속의나, then 제1… to 제13의아해. So the
  concurrency stays deterministic.
- If everyone is waiting, that's deadlock, and the diagnosis says how many children were
  left on the road.

```
@도 0
▽兒怖數。
・５・・・
・告・・・
```

- 제1의아해 runs down from `兒`, picks up 5, and announces it on the road at `告`.
- Meanwhile 나 stands frightened at `怖` until something arrives.
- Output: `5`. Diagnosis: `진단 0:2`.

The empty program is the poem's last line:
`13인의아해가도로로질주하지아니하여도좋소` (it's fine if the 13 children don't run).

---

## 8. Diagnosis — 「오감도 시제4호」

Every run ends with a chart, not an exit code:

```
환자의용태에관한문제
…
진단 0:1
책임의사 이상
```

- `진단 a:b` means *a* selves were still running or waiting when the run stopped,
  out of *b* ever born.
- `0:1` is a lone 나 that ended naturally, which is exactly the poem's diagnosis.
- Anything with *a* > 0 means the run was cut short (step limit or deadlock), and the
  CLI exits non-zero.
- `진단 역설` is a time paradox.

This also fixes the v1 bug where hitting the step limit looked like success.

---

## 9. 오감도 — the IDE

烏瞰圖 is a pun on 鳥瞰圖 (bird's-eye view). The crow 烏 is the bird 鳥 missing a
single stroke. The IDE is a crow's-eye view of the hexahedron:

- **Pages as translucent sheets of tracing paper**, stacked like architectural drawings.
  Drawings show their glyph grid, and verse pages show their column of lines.
- **▽** walks the grid. Children are numbered 1–13. The mirror self is a pale left-handed ▽
  behind a pane of glass.
- **Traces** pile up as dots. On `光`, the scene visibly rewinds and the dots are wiped.
- **Specimens** show as frozen grey ▽s. Boxes open in place, as a square inside a square.
- **Two editors.** Changing a cell in the drawing view rewrites the verse view, and
  the reverse.
- **"One stroke away" errors.** An unknown glyph suggests the nearest known glyphs,
  the way 烏 is one stroke from 鳥. Hangul lines get jamo edit distance.
- **Print.** Export any program as a typeset poster. Every Y3 program is also a
  concrete poem.

---

## 10. Building it

The engine is small if it is built around one table:

```ts
op({
  glyph: "鸚", verse: "앵무二匹", source: "시제6호",
  exec:  (self) => { const v = self.box.peek(); self.box.push(v); return { undo: "pop" }; },
  dual:  "鸚",                 // how the mirror self reads it
  speaks: false, wallOnly: false,
});
```

- **World**: boxes (hexahedra of cells), the road, the eye, history (only back to each
  room's specimen), the time arrow, and output.
- **Self**: kind (나 / 거울 / 아해n), position, heading, frames (box, specimen, return
  point), and its 箱.
- **Tick**: for each self in order, either `exec` (forward) or apply the undo record
  (backward). Every op returns its own undo, so reversibility is enforced by the
  type checker.
- Parser, verse/glyph round-tripping, Monaco language, docs tables (including the
  source column), and mirror duals are all generated from the op table.

### Phases

1. **Paper.** 도 and 시 registers, the laws, the core vocabulary, boxes and ancestry,
   wings, butterflies on the wall, diagnosis, and v1 examples ported by hand.
2. **Light.** Traces, `光`, the eye, paradox.
3. **Glass.** The mirror self, duals, swapping on the plane.
4. **Road.** Children, the road, deadlock diagnosis.
5. **오감도.** The IDE described above.

Each phase produces a language that is complete and pleasant on its own. Phase 1
alone already beats v1 in expressiveness and in looking like his work.

---

## 11. Margins (ideas not yet in)

- **Particle agreement as a type check.** `倍로` vs `箱으로`, checked from the 받침.
- **「선에관한각서」 "사람은숫자를버리라"** ("people, abandon numbers"): a purist mode
  where digits are forbidden and values are built from dot counts.
- **"우주는멱에의하는멱에의한다"** ("the universe depends on power by power"): an exponent
  op, or a box-depth-based scale in the IDE.
- **Hanja register for verse** (方向을右로…): a third way to write the same cell.
- **시제15호's gun at the mirror**: an op that ends the mirror self.

## 12. Open questions

1. When a pointer crosses from a drawing page into a verse page, should it keep its
   heading (strict) or turn 後 (a poem is always read downward)?
2. Should the mirror self swap **whole boxes** on the glass, or only the top values?
3. Must `剝` re-run on each loop pass (current design), or is a specimen permanent
   until replaced?
4. Is the butterfly-at-the-wall rule a law, or an opt-in strict mode?
