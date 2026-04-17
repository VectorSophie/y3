# Y3 Language Spec v1

## Core rules

- Strict token matching only
- No NLP, no synonym expansion, no fuzzy parsing
- One non-empty instruction line = one cell

## Directives

- Layer declaration: `@layer <integer> [label]`
  - `label` is optional and must match `[A-Za-z0-9_-]+`
- Macro declaration: `@macro <NAME>=<instruction>`
  - `NAME` must match `[A-Za-z_][A-Za-z0-9_]*`
  - Right side must be exactly one valid instruction sentence
- Macro use: `@use <NAME>`
  - Expands to the exact declared sentence

## Coordinates

- authored instruction cells: `x=0`
- `y` increments by row within layer
- `z` is layer number

## Direction tokens

- `위로` → `(0,0,+1)`
- `아래로` → `(0,0,-1)`
- `오른쪽으로` → `(+1,0,0)`
- `왼쪽으로` → `(-1,0,0)`
- `앞으로` → `(0,-1,0)`
- `뒤로` → `(0,+1,0)`

## Instruction grammar (exact)

### Stack / arithmetic

- `^값은\s+(\d+)이다$`
- `입력은 값이다`
- `값을 더한다`
- `값을 뺀다`
- `값을 버린다`

### Branching

- `^조건이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$`
- `^아니다\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$`
  - `아니다` must immediately follow `조건이면` in the same layer

### Spatial identity

- `방향을 오른쪽으로 회전한다`
- `방향을 왼쪽으로 회전한다`
- `방향을 위로 회전한다`
- `방향을 아래로 회전한다`
- `^이동은\s+\((-?\d+),(-?\d+),(-?\d+)\)로$`

### Sparse memory model

- `칸을 오른쪽으로 이동한다`
- `칸을 왼쪽으로 이동한다`
- `칸 값을 하나 늘린다`
- `칸 값을 하나 줄인다`
- `칸 값을 가져온다`
- `칸 값으로 넣는다`
- `^칸 값이 0이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$`

### Output

- `^출력은\s+"(.)"이다$`
- `출력은 값이다`

## Runtime defaults

- initial position: `(0,0,0)`
- initial direction: `(0,+1,0)`
- step limit: `10000` (CLI override available)
- input underflow behavior: pushes `0`

## Halt conditions

- pointer leaves bounds
- pointer enters undefined coordinate
- step limit reached
