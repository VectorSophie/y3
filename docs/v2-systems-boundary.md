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
