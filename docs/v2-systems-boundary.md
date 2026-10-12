# Y3 v2: the systems boundary (M9)

M9 gives Y3 a controlled way out: foreign code, a WebAssembly backend, capabilities
and replay. Each one is a boundary, and this document says what holds on each side.
It is the design gate; `docs/v2-ffi.md`, `docs/v2-wasm.md` and `docs/v2-replay.md`
describe the parts.

```
safe Y3                 ↔  foreign code             (외부 declarations: the unsafe boundary)
deterministic runtime   ↔  nondeterministic host    (Host, capabilities, the event log, replay)
typed MIR / Y3BC        ↔  WebAssembly              (a backend; semantics stay in runtime/core)
```

## The ten questions

**1. What is a safe Y3 value?** A value built by safe Y3 code or by the standard library:
- integers in their type's range;
- floats at their width;
- Unicode scalar runes;
- UTF-8 Text;
- data, arrays, slices and collections made of those;
- resource handles the runtime issued.

Safe values obey the M7 value model: value semantics, no aliasing, no null, nothing
outside its type. The type checker and the bytecode type verifier (M8) prove this
statically; checked arithmetic and bounds checks prove it dynamically.

**2. What is an external resource?** Something that lives outside the program and that Y3
reaches only through an opaque handle the runtime issued: an open `File` (M7) or a
`Foreign` pointer returned by foreign code (M9). Sockets and processes come later.
A handle:
- has an **identity**: the runtime's handle number. Two handles are equal only if they
  are the same handle, never because they look alike.
- has **no constructor**. Safe code, the type checker and the bytecode verifier allow no
  way to make one from an integer or a constant.
- is never a key, never part of a constant, and never temporal (`bigint`/`Text` only).
- may be **closed** (a file) or **freed** (a foreign pointer). Using a closed file is an
  ordinary `Err(Closed)`; using a freed foreign pointer is a `FAULT`.

**3. What crosses FFI by value?**
- `i8 i16 i32 u8 u16 u32` (as wasm `i32`), `i64 u64` (as `i64`), `f32`, `f64`;
- `Bool` (as `i32`, 0 or 1);
- `Unit` (no value).

Results are checked on the way back. A foreign function that returns 300 where `u8` was
declared, or 2 for a `Bool`, has broken its contract: that is a `FAULT`, never a bad
Y3 value. `i128`/`u128` do not cross: C compilers disagree on how to pass them.

**4. What crosses FFI by reference?**
- **Borrowed buffers.** A `Text` or a `[u8; N]` / `[]u8` argument is copied into foreign
  memory as (pointer, byte length) for the duration of the call, and freed afterwards.
  The foreign side reads it; anything it writes there is discarded.
- **Out-buffers.** A function declared with an `out [u8; N]` parameter receives a zeroed
  N-byte region. After the call, the bytes it wrote become the call's Y3 result, as a new
  `[u8; N]` value.
- **Foreign pointers.** A pointer that must outlive the call is never a Y3 reference. The
  foreign function returns it, and Y3 gets an opaque `Foreign` handle.

**5. Who owns foreign memory?**
- **Y3-owned buffers** (borrowed and out-buffers) are allocated by the runtime in the
  library's memory through its `y3_alloc`/`y3_free` exports, and live exactly as long as
  one call.
- **Foreign-owned memory** belongs to the library. Y3 holds only a handle, and gives the
  memory back by calling a function the declaration marks `해제` (free). After that the
  handle is dead.
- Safe Y3 cannot double-free or use after free. Both need a `해제` declaration, that is,
  crossing the unsafe boundary, and the runtime still checks them: a second free, or any
  use after free, is a `FAULT` before foreign code runs.

**6. What requires unsafe?** Declaring a foreign function. The `외부` declaration in the ※
section *is* the unsafe boundary: by writing one, the programmer asserts that the
foreign code honours the declared signature, ownership and purity. Calling a declared
function is ordinary, type-checked Y3. There is no `unsafe` block, because the only
unsafe thing Y3 can do is trust a declaration.

**7. What counts as an irreversible effect?**
- stdout;
- reading stdin (it consumes input);
- file writes and file reads (reads observe the world, and replay records them);
- clock readings;
- every foreign call not declared `순수` (pure).

All of them pass through the runtime core's one effect path. They commit in program
order, never cross held output (the M7 barrier), and are never undone.

**8. What runtime state is portable to WASM?** Control state: the compiled blocks of every
step, the registers, the dispatch to the next block. The WASM backend compiles Y3BC's
blocks into WebAssembly functions whose registers are `externref` locals. Semantic
state stays where it is defined:
- noun versions, frames, loops;
- the temporal store, graph and solver;
- numbers (`semantics/numeric`);
- output and effects.

The compiled module reaches that state only through host imports. Y3 numbers never
become WASM numbers, so WASM's wrapping arithmetic and its traps can never become Y3
semantics.

**9. What host functionality must be imported?** For the WASM backend: the runtime-core
operations (one import per MIR operation kind, plus step and terminator services). For
the program: the Host's capabilities (stdout, stdin, filesystem, clock, foreign
libraries). A host that does not provide a capability reports it denied, and the
program sees that at the call that needed it (§ capabilities in `docs/v2-ffi.md`).

**10. What guarantees stop at the FFI boundary?**
- Whether the foreign code computes what its name says.
- Whether it is really pure when declared `순수`.
- Whether it keeps its memory consistent across calls.
- Whether it runs in bounded time: an infinite loop in foreign code hangs the run, with
  no step limit across the boundary.
- What it does with the bytes it borrowed during the call.

**What still holds:**
- Foreign code cannot touch Y3 values: it gets copies.
- It cannot forge a handle.
- It cannot make a Y3 value outside its type: results are checked.
- It cannot reorder effects: the call is an effect.
- It cannot touch the host. M9 foreign libraries are WebAssembly modules instantiated
  with **no imports**, so their only reachable state is their own linear memory.

## Decisions

**Foreign code is WebAssembly (the wasm32 C ABI), not native shared libraries.** C ABI
interoperability in Node otherwise needs a native addon: a build toolchain, per-platform
binaries, and a dependency that cannot run in a browser. A wasm32 module compiled from C
(`clang --target=wasm32 -nostdlib -Wl,--no-entry`) has a precisely specified C ABI, loads
with the standard `WebAssembly` API in Node *and* in browsers, and is sandboxed by
construction. Native libraries are deferred, behind the same `ForeignHost` interface
(`docs/v2-ffi.md`).

**The WASM backend compiles Y3BC to WebAssembly and imports the runtime core.** The
alternatives were:
- **Direct MIR → WASM with its own runtime:** that would re-implement the temporal
  solver, the store, frames, effects and numerics in WASM. It is a second semantics, and
  M8's rule is one.
- **The VM itself compiled to WASM:** that needs the TypeScript runtime ported to a
  WASM-compiled language, the same duplication by another route.

The chosen design compiles what is genuinely backend-level (blocks, registers, dispatch)
and imports what is semantic, in the style of Go's `wasm_exec.js` or Emscripten's JS
runtime. It runs anywhere JavaScript and WebAssembly do, which is exactly the web
IDE's need. A native host, later, would implement the same imports.

**Replay lives in the runtime core.** Recording and replaying happen at the one effect
path, so they are the same for the HIR interpreter, the VM and the WASM backend.

**Y3BC becomes version 2.** Foreign calls add an instruction, and the artifact gains a
foreign-declaration table with pinned library hashes. Version 1 was merged in M8, so its
meaning is not changed in place: a v1 artifact is refused with "rebuild from source".

## Where each part lives

| Part | Code | Reference |
|---|---|---|
| foreign functions | `language/declarations.ts` (`외부`), `semantics/program.ts` (`declareForeign`), `runtime/ffi.ts`, `runtime/wasm-binary.ts` | `docs/v2-ffi.md` |
| capabilities, events, replay | `stdlib/host.ts`, `runtime/core.ts` (`external`), `runtime/payload.ts`, `tools/replay.ts`, `tools/sha256.ts` | `docs/v2-replay.md` |
| WebAssembly backend | `compiler/wasm.ts`, `runtime/wasm-host.ts`, `runtime/vm.ts` (`runSteps`, `executeOp`) | `docs/v2-wasm.md` |
| Y3BC 2 | `compiler/bytecode.ts` (`loadForeign`), `compiler/verify-types.ts` (`foreign`) | `docs/v2-bytecode.md` |

## Security audit

| Threat | Defence | Test |
|---|---|---|
| library path traversal | `[foreign]` paths are relative, no `..`, no absolute or drive paths (`isProjectPath`, manifest and bytecode loader); the CLI resolves symbolic links and refuses a real path outside the program's directory (`libraryLoader`) | `ffi.test.ts`: "a library outside the project", "the CLI loads libraries only from inside the project"; hostile bytecode "outside the project" |
| a library swapped after build | sha256 pinned in the program and artifact, checked before instantiation | "a host that cannot load the library, or loads different bytes"; hostile bytecode "another hash" |
| a library reaching the host | instantiated with no imports; a library that declares any import is refused | "a library with imports" |
| symbol lookup | only exported **functions** whose wasm type equals the declaration's; checked at build and again at load | "the declared wasm type must be the library's real export type", "cannot point a symbol at a different export" |
| malformed ABI declarations | `checkDecl` at build and at load; types that do not cross (`i128`, `bigint`, `Text` results) are refused | "types that do not cross, and contradictory attributes", "cannot bypass the declaration rules" |
| buffer bounds | buffers live in the library's memory, never Y3's; `y3_alloc` results are bounds-checked before copying; out-of-bounds foreign loads trap and FAULT | "an allocator that returns an address outside memory", "a trap in foreign code" |
| pointer forgery | `Foreign` is opaque: no constant, constructor or conversion; the type verifier refuses a non-`Foreign` register for a `Foreign` parameter; handle ids are checked against the run's table and library | "a Foreign value cannot be made from an integer", "cannot forge a pointer" |
| use after close / free, double free | files: `Err(Closed)` (M7); foreign: handles checked before every call | "use after free and double free are FAULTs" |
| foreign results outside their type | range-checked; null pointers refused | "a result outside its declared type is an ABI violation" |
| WASM capability escape | a compiled program imports only module `y3`; the `.wasm` must equal the compilation of its verified bytecode | `wasm.test.ts`: "code that is not the compilation of its bytecode is refused" |
| replay tampering | header, JSON, integrity hash, program hash; every replayed result decoded defensively and checked against the effect's type; divergence stops the run | `replay.test.ts`: "refuses truncated, tampered…", "a forged log … cannot hand the program a value outside its type" |
| untrusted Y3BC + FFI | the three guards in `docs/v2-bytecode.md` (loader, type verifier, runtime) | `ffi.test.ts` "FFI: hostile bytecode" |
| denied capabilities | `external` checks before acting; denied file operations return `Err(PermissionDenied)`, others FAULT | "a denied file system…", "a denied clock or stdin…", "a host that denies ffi" |

Not defended: a foreign function that never returns hangs the run (no step limit inside
foreign code), and a malicious library can compute wrong answers within its declared types.
Both are the unsafe boundary's contract.

## Architecture audit

**1. What exact guarantee does safe Y3 provide around FFI?** Without an `외부`
declaration no foreign code runs. With one, calls are type-checked against the declared
signature (`check.ts`, `ForeignCall`); every value crossing is a copy; results are inside
their declared type or the call FAULTs (`ffi.ts`, `fromWasm`); pointers are opaque handles;
effects keep their order (`core.ts`, `external`); the library cannot reach the host (no
imports, `checkLibrary`). Tests: `tests/v2/ffi.test.ts`.

**2. What does unsafe permit?** Trusting a declaration: that the symbol computes what it
claims, that `순수` is really pure, that `해제` really frees, and that the library keeps its
memory consistent. Nothing else: an unsafe declaration cannot bypass the type checker,
the barrier, capabilities or handle checks.

**3. Who owns foreign memory?** Borrowed buffers: the runtime, for exactly one call
(`y3_alloc` before, `y3_free` after, in `finally`). Pointers returned as `Foreign`: the
library, until a `해제` call; Y3 holds only a handle (`ForeignRuntime.handles`).

**4. Can ordinary Y3 forge a pointer?** No. `Foreign` is opaque with no constructor; no
conversion exists; the checker refuses `i64` for `Foreign` ("a Foreign value cannot be
made from an integer…").

**5. Can bytecode forge one?** No. Constants cannot be resources (`decodeValue`); the type
verifier refuses a non-`Foreign` register for a `Foreign` parameter ("cannot forge a
pointer"); at run time a handle id must be in this run's table, for this library, not freed
(`ForeignRuntime.address`).

**6. Are all foreign calls effect barriers by default?** Yes. Only `순수` opts out
(`core.ts`, `env.foreign`). Tests: "a foreign call is an effect barrier", "a 순수 call is not
a barrier".

**7. Is there one effect-ordering implementation?** Yes: `external` and `commit` in
`runtime/core.ts`. Standard library effects, foreign calls, WASM imports and replay all go
through them (`docs/v2-replay.md`, effect ordering audit).

**8. Does WASM duplicate runtime semantics?** No. Its imports call `executeOp` and
`executeTest`; its run loop is `runSteps`; both are the VM's (`runtime/vm.ts`,
`runtime/wasm-host.ts`). The module holds dispatch and registers only. Planted bugs in the
WASM host (wrapping add, a skipped constraint) are caught by the differential suite.

**9. Does WASM preserve checked arithmetic?** Yes, because it never does arithmetic:
values are `externref`s and arithmetic is `semantics/numeric` through the core. Test:
"checked arithmetic: overflow, division by zero and MIN / -1 FAULT".

**10. Does WASM preserve temporal outcomes?** Yes: one solver, reached through the core.
Tests: "temporal unknowns, RETRO, SELF_CAUSED and PARADOX", every fixture, 700 random
programs with time.

**11. Is replay backend-independent?** Yes: it lives in `external` and `commit`. Test: "a
recording made by one engine replays on the other"; the CLI replays a `.y3` recording on
the `.wasm` artifact.

**12. Can replay accidentally redo irreversible effects?** No. Under replay `external`
returns the recorded result and never calls `perform`; output is compared, not trusted.
Test: "replays stdin, clock and file reads on a different host, without acting" (the file
write does not happen). Exception by design: `순수` foreign calls run for real.

**13. Can Host deny capabilities?** Yes: `Host.capabilities`; `memoryHost({ deny })`.
Tests in `replay.test.ts` ("capabilities") and `ffi.test.ts`.

**14. Can malformed Y3BC reach a foreign call?** Only a call the loader, the type
verifier and the runtime all accept: a declared function (`loadForeign`), with arguments of
the declared types (`verify-types.ts`), into a library with the pinned hash whose real
exports match (`ForeignRuntime.instance`). Tests: "FFI: hostile bytecode".

**15. What part of M9 is intentionally deferred?** Native shared libraries, callbacks,
structs by value, nullable pointers as `Option<Foreign>`, a WASM build of the runtime,
WASI, native WASM arithmetic, networking and processes (the brief made them optional;
FFI, WASM and replay came first), signed replay logs, and foreign declarations in imported
modules.

## Planted bugs

Each was planted in a copy of the code, the M9 suites run, and the file restored.

| # | Bug | Caught by |
|---|---|---|
| 1 | FFI `i32` result read as `u32` | "i32 wraps in C, but its result is still an i32" |
| 2 | foreign `f32` result widened to `f64` | "f32 is computed at f32" |
| 3 | Text length passed in runes, not bytes | "Text crosses as UTF-8 … bytes, not characters" |
| 4 | type verifier skips `Foreign` argument types (pointer forged from `i64`) | "cannot forge a pointer" (after strengthening: a fresh register) |
| 5 | freed foreign pointer still usable | "use after free and double free" |
| 6 | foreign calls with scalar results bypass the barrier | "a foreign call is an effect barrier" |
| 7 | WASM `i32` add wraps | "checked arithmetic…" |
| 8 | WASM loses `up` in loop anchors | "a loop under a tilted pose" (added after the first run missed it) |
| 9 | WASM trusts past statements instead of constraining (a second "solver") | fixtures `retro.y3`, `history-paradox.y3` |
| 10 | replay reads the real clock | "replays stdin, clock and file reads on a different host" |
| 11 | replay accepts a wrong program hash | "a replay for a different program is refused" |
| 12 | replay skips its integrity check | "refuses truncated, tampered…" |
| 13 | a host-denied file system still opens files | "a denied file system is an ordinary Err(PermissionDenied)" |
| 14 | the bytecode loader skips the FFI declaration rules | "cannot bypass the declaration rules" |
| 15 | `.wasm` code trusted without recompiling | "code that is not the compilation of its bytecode" |
| 16 | `Y3BC 1` accepted as version 2 | "refuses another bytecode version" |
| 17 | foreign libraries allowed one import | "a library with imports…" |

## Real bugs found during M9

- **Replayed results were not type-checked.** A forged log with a recomputed integrity hash
  could return Text from `시계 지금`. Every replayed payload is now decoded defensively and
  checked against the effect's declared result type (`conformsTo`, `runtime/payload.ts`).
- **Two tests were weaker than they looked** (planted bugs 4 and 8 survived the first
  run): the pointer-forgery test reused a register and was refused for the wrong reason,
  and no WASM test anchored a loop under a non-default `up`. Both were strengthened.
