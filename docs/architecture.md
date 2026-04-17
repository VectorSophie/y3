# Architecture (v0)

## Design goals

1. Strict correctness (regex/token deterministic parser)
2. Clean separation: parser/runtime/CLI/web view
3. Extendable core without rewrites

## Modules

- `src/core/types.ts`: canonical Program, Cell, Instruction, MachineState, Vec3
- `src/core/directions.ts`: exact direction token mapping
- `src/core/parser.ts`: line-based parser, layer handling, adjacency validation (`아니다` pairing), bounds calculation
- `src/core/runtime.ts`: step machine, halt behavior, stack effects, trace capture
- `src/core/trace.ts`: trace text formatting for CLI
- `src/cli.ts`: `validate/run/trace` commands
- `src/web/App.tsx`: Monaco + 3D visualization + runtime panel

## Parsing model

Input is split by lines. Blank lines are ignored. `@layer N` changes current Z layer. Every subsequent non-empty line becomes one cell at:

- `x = 0`
- `y = row index within layer`
- `z = declared layer`

No visual grouping, no inferred columns, no optional grammar.

## Runtime model

Initial state:

- position `(0,0,0)`
- direction `(0,+1,0)`

Default `+Y` is chosen because source is vertically authored in v0 and should execute downward in reading order.

Each step:

1. halt if out of bounds
2. halt if current coordinate is undefined
3. execute instruction
4. move pointer by direction
5. increment step count
6. halt at 10000 steps

## Branching

Spatial branching is direction control:

- `조건이면 <방향>` updates direction if popped value is non-zero
- `아니다 <방향>` only applies when previous condition was false

This makes branch paths physically visible across Z/Y/X movement.
