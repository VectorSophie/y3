# Y3 v2: foreign functions (M9)

Y3 calls C code through the wasm32 C ABI. A foreign library is a WebAssembly module,
compiled from C (or anything that targets wasm32), and instantiated with **no imports**:
its own linear memory is all it can reach. `docs/v2-systems-boundary.md` explains the
choice. This document is the reference.

```
+++
[foreign]
"씨" = "libs/math.wasm"          # alias = a .wasm path inside the project
+++
⟦
[x는 씨 더하기: 40i32, 2i32]
[x를 말한다.]
[끝이다.]
⟧

※

# int add(int, int)
외부 씨 더하기 (a: i32, b: i32) → i32 = add 순수
```

`examples/v2/ffi/ffi.y3` is a complete program: scalars, Text, an out-buffer and a
pointer with its free. It runs on all three engines (`y3 test examples/v2/ffi`).

## Declarations: the unsafe boundary

```
외부 <library> <name> (<param>: [출력] <type>, …) [→ <type>] = <symbol> [순수] [해제]
```

Writing a declaration is the one unsafe act in Y3. It asserts that the library's
`<symbol>` follows the declared signature, ownership and purity. Calling it is ordinary,
type-checked Y3: `[x는 씨 더하기: 1i32, 2i32]` is checked against the declared types like
any call (`types/check.ts`, `ForeignCall`). There is no `unsafe` block.

- `순수` (pure): the programmer's promise that the function has no effect and depends
  only on its arguments. A pure call is not an effect barrier and leaves no event. Nothing
  infers purity. A pure function cannot take, return or free a `Foreign` pointer, because
  pointers are state.
- `해제` (free): the call frees its `Foreign` argument. After it returns, that handle is
  dead.
- Only the program's own module declares foreign libraries and functions. An imported
  module that does is an error (`Y3C012`).

The pipeline is the ordinary one: 외부 declaration → `ForeignDecl` (`runtime/ffi.ts`) →
HIR `ForeignCall` → MIR `foreign` → Y3BC `foreign` instruction → the runtime core's
`env.foreign` → `ForeignRuntime.call`.

## Types

| Y3 type | crosses as (wasm32 C ABI) | C |
|---|---|---|
| `i8 i16 i32 u8 u16 u32` | `i32` | `int8_t` … `uint32_t` |
| `i64 u64` | `i64` | `int64_t`, `uint64_t` |
| `f32`, `f64` | `f32`, `f64` | `float`, `double` |
| `Bool` | `i32`, 0 or 1 | `bool` |
| `Text` (parameter) | `i32, i32`: pointer, **byte** length of UTF-8 | `const char *, size_t` |
| `[u8; N]`, `[]u8` (parameter) | `i32, i32`: pointer, length | `const uint8_t *, size_t` |
| `출력 [u8; N]` (parameter) | `i32, i32`: pointer to N zeroed bytes, N | `uint8_t *, size_t` |
| `Foreign` | `i32`: the pointer | `T *` |
| no result | — | `void` |

- `i128`, `u128` and `bigint` do not cross: C compilers disagree on how to pass 128-bit
  integers, and bigint has no C type. `Rune`, data, collections and `File` do not cross.
- A function returns a scalar, a `Foreign`, nothing, or (with an out-buffer parameter)
  `[u8; N]`. Text and slices cannot be returned: there is no length to trust.
- An out-buffer is not passed by the caller: `[b는 버 채우기: 7u8]` calls
  `fill(7, buf, 4)` and the 4 bytes `fill` wrote become `b`.

**Results are checked.** A function declared `→ u8` that returns 300, or `→ Bool` that
returns 2, or `→ Foreign` that returns a null pointer, has broken its contract: the call
FAULTs (`ffi.ts`, `fromWasm`). A foreign function can never produce a Y3 value outside its
type. `u32` reads the wasm `i32` bits unsigned; `u64` reads the `i64` bits unsigned. A
trap in foreign code (an out-of-bounds load, `unreachable`) is a FAULT.

## Libraries

`[foreign]` maps an alias to a `.wasm` path. The path is relative and stays inside the
project: no absolute path, no drive letter, no `..` (`space/manifest.ts`,
`isProjectPath`). The CLI also resolves symbolic links and refuses a library whose real
path leaves the program's directory (`cli/node-host.ts`, `libraryLoader`). An alias cannot
be reserved, `표준`/`수학`/`배열`, a standard namespace or an imported module's alias.

At **build time** (`semantics/program.ts`) every library is read and checked:

- it is a WebAssembly module (`runtime/wasm-binary.ts` reads its type, import, function
  and export sections);
- it has **no imports**;
- every declared symbol is an exported function whose wasm type is exactly the
  declaration's (`wasmSignature`); a mismatch names both types;
- a library that takes buffers exports `memory`, `y3_alloc(i32) → i32` and
  `y3_free(i32, i32)`.

Its sha256 is pinned in the program and in the bytecode. At **run time** the library is
loaded through the Host, its hash must equal the pinned one, and it is checked against the
declarations again before it is instantiated (`ForeignRuntime.instance`). An edited library
or an edited artifact therefore fails before any foreign code runs.

## Ownership

- **Borrowed buffers.** For `Text`, `[u8; N]`, `[]u8` and out-buffers, the runtime
  allocates in the library's memory with `y3_alloc`, copies the bytes in, makes the call,
  and frees with `y3_free` afterwards, whatever happened. The foreign side may read them
  only during the call. An out-buffer's bytes are copied out before it is freed.
  `y3_alloc` returning 0 or a region outside memory is a FAULT.
- **Foreign pointers.** A pointer returned as `Foreign` becomes a handle in the run's
  handle table: `{ library, address, freed }`. Y3 sees `<foreign #n>`, an opaque value.
- **Freeing.** A `해제` function frees its handle. Before any call, every handle argument
  is checked: issued by this run, from this library, not freed. A second free or any use
  after free is a FAULT before foreign code runs (`ForeignRuntime.address`).

## Handles

A `Foreign` (like a `File`) is an external resource:

| Rule | Where |
|---|---|
| opaque: no fields, no constructor, no literal | `types/types.ts` `FOREIGN` is opaque; `bytecode.ts` `decodeValue` has no resource constant |
| no integer ↔ pointer conversion, no arithmetic | the type checker; the bytecode type verifier (`verify-types.ts`, `foreign`) |
| never temporal | temporal values are `bigint` or `Text` (`check.ts`, `Y3Y004`) |
| never a map key or set element | opaque types are not keys (`check.ts`, `isKey`) |
| identity, not structure | `sameValue` compares handle ids (`semantics/values.ts`) |
| not serializable | a replay log carries handle ids only as results to hand back, never as something to reconstruct a pointer from |

## Effects

A foreign call that is not `순수` is an effect, through the runtime core's one effect path
(`core.ts`, `external`): it never overtakes held output (the M7 barrier), needs the `ffi`
capability, commits an event (`kind: "foreign"`, `source: "foreign.<library>.<name>"`, the
handle in `resource`) and is replayed from the log. A `순수` call still needs the `ffi`
capability, but is not a barrier and leaves no event; under replay it runs for real, so a
replayed program with pure foreign calls needs its libraries.

## Capabilities

A Host offers `stdin`, `filesystem`, `clock` and `ffi` (`stdlib/host.ts`). A host may deny
any of them (`capabilities: { ffi: false }`; `memoryHost({ deny: [...] })`), and the program
learns at the call that needed it:

- a file operation that returns a `Result` returns `Err(PermissionDenied(…))`;
- anything else (`파일 존재`, stdin, clocks, foreign calls) is a FAULT naming the
  capability: "needs the 'ffi' capability, which the host denies".

A host with no `loadLibrary` (a browser IDE) cannot run foreign calls; a toolchain that
cannot read libraries cannot build a program that declares them.

## What the boundary does not guarantee

Whether the foreign code computes what its name says, whether it is really pure, whether
it keeps its own memory consistent, and whether it terminates (there is no step limit
inside foreign code). What still holds: it gets copies of Y3 values, cannot forge a handle,
cannot return a value outside its declared type, cannot reorder effects, and cannot reach
the host.

## Deferred

Native shared libraries (`.so`/`.dylib`/`.dll`) need a native addon and per-platform
builds; they would implement the same `ForeignRuntime` surface. Callbacks into Y3, structs
by value, varargs, foreign globals, and `Option<Foreign>` for nullable pointers are also
deferred.
