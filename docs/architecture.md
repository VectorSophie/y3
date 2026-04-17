# Architecture (v1)

## Design goals

1. Strict correctness (regex/token deterministic parser)
2. Clean separation: parser/runtime/CLI/web view
3. Extendable core without rewrites

## Modules

- `src/core/types.ts`: canonical Program, Cell, Instruction, MachineState, Vec3
- `src/core/directions.ts`: exact direction token mapping
- `src/core/parser.ts`: line-based parser, strict macro expansion, semantic layer labels, instruction validation
- `src/core/runtime.ts`: step machine, sparse memory model, spatial rotations/portals, configurable step limit
- `src/core/trace.ts`: trace text formatting for CLI
- `src/cli.ts`: `validate/run/trace` commands
- `src/web/App.tsx`: Monaco + 3D visualization + runtime panel

## Parsing model

Input is split by lines. Blank lines are ignored.

- `@layer N [label]` changes current Z layer and optional semantic label
- `@macro NAME=<instruction>` defines strict one-line macro
- `@use NAME` expands to the exact macro instruction

Every non-directive line becomes one cell at:

- `x = 0`
- `y = row index within layer`
- `z = declared layer`

No visual grouping, no inferred columns, no optional grammar.

## Runtime model

Initial state:

- position `(0,0,0)`
- direction `(0,+1,0)`

Default `+Y` is chosen because source is vertically authored and should execute downward in reading order.

Additional machine state in v1:

- input queue (`입력은 값이다`)
- sparse unbounded memory map + memory pointer
- configurable max steps (`run/trace --max-steps`)

Each step:

1. halt if out of bounds
2. halt if current coordinate is undefined
3. execute instruction
4. move pointer by direction
5. increment step count
6. halt at configured step limit (default 10000)

## Branching

Spatial branching is direction control:

- `조건이면 <방향>` updates direction if popped value is non-zero
- `아니다 <방향>` only applies when previous condition was false

This makes branch paths physically visible across Z/Y/X movement.

v1 also adds:

- relative rotation commands (left/right/up/down)
- absolute portal jump command
- memory-zero branch for counter-machine style control
