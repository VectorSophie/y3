# YI3ANG (Y3) v0

Y3 is a strict 3D spatial execution language. In v0, source is authored as **one non-empty line = one cell**. Execution is a pointer moving in 3D `(x,y,z)` with a direction vector `(dx,dy,dz)`.

## Why this v0 format

The visible cell delimiter was removed to keep a literary appearance, but parser determinism is preserved by these hard rules:

- one line = one cell
- no line splitting
- no inferred columns
- no indentation semantics
- no NLP/fuzzy grammar

This gives a readable source form while keeping machine behavior strict and deterministic.

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
- `y3 run file.y3`
- `y3 trace file.y3`

Trace entries include:

```text
step=3
pos=(0,2,0)
dir=(0,1,0)
cell="값을 더한다"
stack=[8]
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
- `docs/visualization.md`
- `docs/roadmap.md`
