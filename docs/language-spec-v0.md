# Y3 Language Spec v0 (No Delimiter)

## Core rules

- Strict token matching only
- No NLP, synonyms, fuzzy grammar, optional grammar, inference
- If unmatched: parse error with line number, original text, explanation

## Source format

- `@layer <integer>` must appear before instructions
- one non-empty line = one cell
- blank lines ignored
- authored cells use `x=0`
- `y` increments by row in each layer
- `z` is the layer number

## Direction tokens

- `위로` → `(0,0,+1)`
- `아래로` → `(0,0,-1)`
- `오른쪽으로` → `(+1,0,0)`
- `왼쪽으로` → `(-1,0,0)`
- `앞으로` → `(0,-1,0)`
- `뒤로` → `(0,+1,0)`

## Grammar (exact)

- PUSH: `^값은\s+(\d+)이다$`
- ADD: `값을 더한다`
- SUB: `값을 뺀다`
- POP: `값을 버린다`
- COND: `^조건이면\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$`
- ELSE: `^아니다\s+(위로|아래로|왼쪽으로|오른쪽으로|앞으로|뒤로)$`
- OUTPUT_CHAR: `^출력은\s+"(.)"이다$`
- OUTPUT_STACK: `출력은 값이다`

## ELSE pairing

`아니다` must immediately follow `조건이면` in authored source order within the same layer; otherwise parse error.

## Halt conditions

- pointer leaves program bounds
- pointer enters undefined coordinate
- step count reaches 10000

## Intentionally deferred in v0

- horizontal multi-cell source form
- explicit authored noop syntax
- macro/abstraction forms
- semantic layer metadata
