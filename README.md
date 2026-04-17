# YI3ANG (Y3) v1

Y3 is a strict 3D spatial execution language. Source is authored as **one non-empty line = one cell**. Execution is a pointer moving in 3D `(x,y,z)` with direction `(dx,dy,dz)`.

## Why this format

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
npm run validate -- examples/minimal.y3
npm run run -- examples/minimal.y3
npm run trace -- examples/minimal.y3
```

Or link as a command:

```bash
npm link
y3 run examples/branch-true.y3
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
