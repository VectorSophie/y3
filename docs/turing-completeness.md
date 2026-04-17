# Turing-completeness notes (v1)

This repository does **not** include external esolang submissions. This document is an internal technical rationale for v1 capability.

## Model assumptions

Y3 v1 runtime provides:

1. Unbounded control flow via direction-based loops
2. Unbounded sparse memory map indexed by an unbounded memory pointer (`칸`)
3. Conditional branching from memory zero-test (`칸 값이 0이면 <direction>`)
4. Input queue (`입력은 값이다`) and textual output

Given unbounded memory and zero-test branch, Y3 can encode counter-machine style computation.

## Counter-machine style mapping sketch

- Counter pointer movement:
  - move to next counter: `칸을 오른쪽으로 이동한다`
  - move to previous counter: `칸을 왼쪽으로 이동한다`
- Increment counter:
  - `칸 값을 하나 늘린다`
- Decrement counter (saturating at 0):
  - `칸 값을 하나 줄인다`
- Zero-test jump:
  - `칸 값이 0이면 <direction>` with paired alternate path (`아니다 <direction>` pattern where needed)

The combination above is sufficient to construct Minsky-like control patterns in finite source with unbounded execution paths.

## Practical runtime safety

- CLI default step limit is 10000 to prevent accidental infinite runs
- `--max-steps` can raise this limit for larger programs
