# Y3 v2: the toolchain (M8)

One `y3` command, Go-style.

| Command | Does | Stops after |
|---|---|---|
| `y3 check <file>` | parse, resolve names and modules, type-check | HIR; nothing runs, no CFG |
| `y3 fmt <file> [-w] [--check] [-p flat\|perspective\|strong]` | canonical text | — |
| `y3 build <file> [-o out.y3b]` | compile to a bytecode artifact (`docs/v2-bytecode.md`) | verified bytecode |
| `y3 run <file \| artifact.y3b> [--engine vm\|hir]` | run; the VM by default | — |
| `y3 trace <file> [--engine vm\|hir]` | run, printing every step | — |
| `y3 test [paths…] [--engine vm\|hir]` | run every program with a `[test]` table and check it | — |
| `y3 doc [<file>] [--json] [--std]` | a module's documentation, or the standard library's | — |
| `y3 lock <file>` | resolve git imports and write `y3.lock` | — |
| `y3 ir`, `y3 cfg`, `y3 mir [--optimized]`, `y3 bytecode` | inspect each stage | — |

The inspection commands are for debugging; nothing requires them.

## Engines

`y3 run` compiles source down to bytecode and runs it on the VM, so it runs exactly
what `y3 build` would write. `--engine hir` runs the HIR interpreter, the reference
implementation. M8 keeps it on purpose: the differential tests compare the two engines
on every fixture and on thousands of generated programs.

## Tests

A test is an ordinary program whose manifest says what it should do:

```toml
[test]
output = ["42"]        # the expected stdout lines (optional)
status = "HALT"        # the expected outcome (default HALT)
stdin = "21\n"         # standard input (optional)
```

`y3 test` finds every `.y3` file under the given paths (default `.`), skipping dot
directories and `node_modules`. It runs each one that has a `[test]` table, prints
`ok` or `FAIL` per file, and exits with 1 if any failed.

## fmt

`fmt` is canonical and idempotent (`fmt(fmt(x)) = fmt(x)`, a property test). It never
changes meaning:

- **Layout:** whitespace, ※-section order, and depth indentation by projection. The
  projection is presentation only: every projection parses back to the same document.
- **Declarations:** `자료 점 = { 가로: i64, 세로: i64 }`, `자료 모양<T> = 원(T) | 빈것`.
- **Signatures:** `(수: i64, 밑: i64) → i64`, `→ (i64, i64)`, no arrow for Unit.
- **Cells:**
  - one space after each comma in a call;
  - named arguments as `가로=3`;
  - match arms as `패턴 → 값`;
  - numeric literals without leading zeros, and floats as the shortest text that reads
    back at their width (`1.50f32` → `1.5f32`).

  Text and rune literals are never touched. A rewritten cell is kept only if it parses
  to exactly the same sentence; otherwise the cell is written as it was.
- **Declarations and signatures that do not parse** are kept as written, so that
  `check` can report them.

Orthography (particle allomorphs) is still linted, not rewritten.

## Modules and packages

```toml
[imports]
"기하" = "lib/geometry.y3"                                          # local, relative to this file
"원격" = { git = "https://example.org/lib.git", ref = "main", path = "lib.y3" }
```

- **Locked.** A git import resolves only through `y3.lock`, which pins each
  `(git url, ref)` to a 40-hex commit. A build with an unlocked git import fails with
  "run 'y3 lock' to pin it". A build never follows a moving branch.
- **`y3 lock`** fetches, resolves refs to commits and writes the lock. The lock is
  written deterministically: sorted, one entry per line.
- **Cache.** Repositories are cloned bare into `.y3/cache/` and reused. A relative
  import inside a git module stays in that repository at that commit.
- **Canonical names.** A git module is named `git+<url>@<rev>#<path>`.
- **No registry.** Package resolution lives in `cli/packages.ts`, behind the same
  `ModuleResolver` interface the language already used. The language never sees a URL.
