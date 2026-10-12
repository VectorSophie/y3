# Y3 v2: effects, events and replay (M9)

Every external effect passes through one function, `external` in `runtime/core.ts`,
whichever engine runs the program (HIR interpreter, VM, WASM). Recording and replaying
happen there, so they are the same for every engine: a run recorded on one replays on
any other.

## The effect path

For each effect, in program order:

1. **Barrier.** If earlier output is still held on an open temporal symbol, the effect does
   not run: the run is UNRESOLVED (the M7 rule).
2. **Replay.** When replaying, the next recorded event must be this effect (same source,
   same arguments); its recorded result, decoded and checked against the effect's declared
   result type, is the result. Nothing touches the host.
3. **Capability.** A denied capability gives the callable's ordinary error
   (`Err(PermissionDenied)` for file operations that return a `Result`) or a FAULT.
4. **Perform.** The effect runs through the Host. A host that throws is a FAULT.
5. **Event.** The effect is committed as an event.

Standard output takes the same path when a write commits (`commit`): under replay, every
committed write must equal the recorded one, in the same place.

## Events

`HostEvent` (`ir/callables.ts`):

| Field | Holds |
|---|---|
| `step`, `at`, `frame` | where: the step, the cell, the call activation |
| `source` | the operation: `std.fs.write`, `std.clock.now`, `foreign.씨.더하기`, `std.io.stdout` |
| `kind` | `output` (stdout), `input` (stdin, clocks, file reads and opens, `파일 정보`, `파일 존재`), `effect` (file writes, creates, appends, closes), `foreign` |
| `resource` | the handle acted on or opened: `file#0`, `foreign#2`, or null |
| `args` | the arguments, as debug text |
| `value` | the result, as debug text; **file contents are redacted** (`Ok(<12 bytes>)`) |
| `payload` | the result as data, for replay (`runtime/payload.ts`) |

Debug text is for people; the payload is the only thing replay reads. A file read's bytes
are in the payload because replay needs them; they never appear in `value`, traces or
diagnostics. Pure foreign calls (`순수`) leave no event.

## The replay file

```
Y3REPLAY 1
{"magic":"Y3REPLAY","version":1,"toolchain":"y3 0.1.0 (Y3BC 2)",
 "program":"<sha256 of the Y3BC artifact>",
 "capabilities":{"stdin":true,"filesystem":true,"clock":true,"ffi":true},
 "events":[…],"integrity":"<sha256 of the events>"}
```

- **`program`** is the sha256 of the program's Y3BC artifact text, the exact bytes `y3
  build` writes. It is never a path: the same program in another directory replays; an
  edited program does not. `program.y3`, `program.y3b` and `program.wasm` share it.
- **`integrity`** is the sha256 of the `events` array only. It detects accidental
  corruption and editing of the event payload. It is **not authentication**: anyone who
  edits a log can recompute it, and it does not cover the other metadata fields
  (`toolchain`, `capabilities`; `program` is checked against the program itself). Signed
  logs are deferred. A forged log can still only feed values to effects, in order, each
  checked against its declared type.
- **`capabilities`** records what the recording host offered; **`toolchain`** the toolchain
  that wrote it.

SHA-256 is implemented in `tools/sha256.ts`, synchronous and dependency-free, so the same
identities are computed in Node and in a browser.

## Commands

```
y3 run program.y3 --record run.y3r     # runs for real and writes the log
y3 run program.y3 --replay run.y3r     # replays it
y3 run program.y3 --replay run.y3r --force   # replays a log made for another program
```

`--record` and `--replay` work with every engine and with `.y3b` and `.wasm` artifacts.

**Recording** runs every effect for real and writes the log when the run ends, whatever
its outcome.

**Replaying** reads the log and refuses it, before running, if:

- the header is not `Y3REPLAY 1` (another version is refused by number);
- the body is not JSON (a truncated file);
- the events do not match `integrity`;
- `program` is not this program's hash (unless `--force`).

Then the run replays: stdin, clocks, file reads and foreign calls return their recorded
results; file writes, creates, appends and closes, and foreign calls, are **not
performed**. Output is written again, and must match the recording. The run **diverges**
(`ReplayDivergence`, exit 1) when the program calls an effect the log does not have next,
with other arguments, writes other output, or ends with recorded events left over. Replay
never falls back to the real host.

## Effect ordering audit

| Effect | Path | Ordered by |
|---|---|---|
| stdout | `env.output` → `commit` | the held-write queue; commits in program order |
| stdin, clocks, files | `env.effect` → `external` | the barrier, then program order |
| FFI (not 순수) | `env.foreign` → `external` | the same |
| FFI 순수 | `env.foreign` | not an effect: no order to keep |
| WASM imports | `op_builtin`, `op_foreign` → `executeOp` → the same `env` | the same |
| replay | inside `external` and `commit` | consumes events in the order they were committed |

There is one ordering implementation, and backends cannot reach the host except through
it. Tests: `tests/v2/replay.test.ts` (order across stdout, stdin, clock and files; replay
on another engine), `tests/v2/ffi.test.ts` (barrier), `tests/v2/runtime-stdlib.test.ts`
(the M7 barrier).
