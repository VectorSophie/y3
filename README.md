# YI3ANG (Y3) v1

Y3 is a strict 3D spatial execution language. Source is authored as **one non-empty line = one cell**. Execution is a pointer moving in 3D `(x,y,z)` with direction `(dx,dy,dz)`.

## v2 (in progress)

v2 is being built milestone by milestone from `docs/v2-space-and-time.md`. **M0** (the
document model) is done: a `.y3` file is one plain-text space made of Y2 planes.

```
⟦
[값은 3이다.]
[값이 2이면 위층으로 간다.]
[끝이다.]
⟧

    ⟦ :detour: ⟧

※

:detour: ⟦
[ ]
["둘"을 말한다.]
⟧
```

- `⟦ … ⟧` is a plane; plane order is `z`, rows are `y`, cells are `x`.
- `[ … ]` is a cell, and `[ ]` is a blank one. Planes must be rectangular.
- `⟦ :name: ⟧` places a named plane from the `※` section; it means exactly the same as
  writing the plane inline.
- Indentation and gaps are projection only; the parser never reads them.

```bash
y3 check program.y3                      # structure, manifest, and sentences
y3 fmt program.y3 [--projection flat|perspective|strong] [--write | --check]
y3 unpack program.y3                     # → program/{META-INF,space,planes}
y3 pack program/                         # → program.y3
```

**M1** added the spatial machine (`src/runtime/`): 24 cube orientations, turns, relative
steps, floor transitions, and the start pose and step limit from the manifest.

**M2** makes present tense execute. v2 programs run, with `bigint` values held in
named nouns, arithmetic, output, movement, conditionals and anchor-based loops
(`docs/v2-present-tense.md` lists the exact sentence set):

```
⟦
[값은 3이다.]
[여기가 처음이다.]
[값을 말한다.]
[값에서 1을 뺀다.]
[값이 0이 아니면 끝은 처음이다.]
[끝이다.]
⟧
```

```bash
y3 run countdown.y3      # 3, 2, 1
y3 trace countdown.y3    # every executed cell and its effects
```

**M3** adds the temporal core: past and future tense constrain instead of executing
(`docs/v2-temporal-core.md`). A later statement can determine an earlier unknown:

```
⟦
[값은 미정이다.]
[원래는 값이다.]
[값에 1을 더한다.]
[원래를 말한다.]
[값은 4였다.]
[끝이다.]
⟧
```

This prints `3`: α + 1 = 4 at step 5 determines the α printed at step 4. When the
constraints have no solution the run ends in `PARADOX`; when they leave the output open,
`AMBIGUOUS`; and a condition that needs an open value is `UNRESOLVED`. Fixed points and
temporal channels come in M4.
`run` and `trace` choose v1 or v2 from the file: v2 documents contain planes. The
sections below describe v1, whose examples are in `examples/v1/`; v2 examples are in
`examples/v2/`.

## Why this format (v1)

The visible cell delimiter was removed to keep a literary appearance, but parser determinism is preserved by these hard rules:

- one line = one cell
- no line splitting
- no inferred columns
- no indentation semantics
- no NLP/fuzzy grammar

This gives a readable source form while keeping machine behavior strict and deterministic.

## v1 additions (TC-focused + identity)

- Turing-completeness oriented memory model:
  - sparse unbounded memory pointer (`칸` instructions)
  - zero-conditional memory branch (`칸 값이 0이면 ...`)
  - input queue instruction (`입력은 값이다`)
- 3D identity features:
  - relative direction rotations (`방향을 ... 회전한다`)
  - absolute portal jumps (`이동은 (x,y,z)로`)
- semantic/source features:
  - semantic layer labels (`@layer 0 [control]`)
  - strict macro expansion (`@macro NAME=...`, `@use NAME`)

## Quick start

```bash
npm install
npm test
```

Run CLI examples:

```bash
npm run validate -- examples/v1/minimal.y3
npm run run -- examples/v1/minimal.y3
npm run trace -- examples/v1/minimal.y3
```

Or link as a command:

```bash
npm link
y3 run examples/v1/branch-true.y3
```

Publish-ready packaging check:

```bash
npm run build:package
npm pack --dry-run
```

After publishing, global usage is:

```bash
npm install -g y3
y3 validate ./program.y3
```

## Commands

- `y3 validate file.y3`
- `y3 run file.y3 [--input "1 2 3"] [--max-steps 50000]`
- `y3 trace file.y3 [--input "1,2,3"] [--max-steps 50000]`

Trace entries include:

```text
step=3
pos=(0,2,0)
dir=(0,1,0)
cell="값을 더한다"
stack=[8]
mem=(0:0)
output=""
```

## Web IDE

Start development server:

```bash
npm run dev
```

The IDE includes:

- Monaco editor
- 3D grid rendering by layer (Z-separated)
- pointer highlight and movement trail
- animated stepping
- runtime state panel (position, direction, stack, output, step)

## Documentation

- `docs/architecture.md`
- `docs/language-spec-v0.md`
- `docs/language-spec-v1.md`
- `docs/turing-completeness.md`
- `docs/visualization.md`
- `docs/roadmap.md`
- `docs/design-review-v2.md` (review of v1 + first v2 proposal)
- `docs/v2-samchagak.md` (삼차각설계도: Yi Sang–based v2 concept)
- `docs/v2-space-and-time.md` (accepted v2 design: container, planes, orientation, tense-as-constraint)
- `docs/v2-present-tense.md` (the M2 sentence set)
- `docs/v2-temporal-core.md` (M3: 미정, 였다, 일 것이다)
