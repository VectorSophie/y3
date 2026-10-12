import { encodeModule, I, type FuncType } from "../../src/v2";

// Foreign libraries for the FFI tests, assembled by hand: exactly what a C compiler
// targeting wasm32 would export for the C functions in the comments.

const t = (params: FuncType["params"], results: FuncType["results"]): FuncType => ({ params, results });
const i32 = "i32" as const;
const ADD = 0x6a;
const GE_U = 0x4f;
const BLOCK = [0x02, 0x40];
const LOOP = [0x03, 0x40];
const END = 0x0b;

// int add(int, int); long long add64(long long, long long); double sqrt(double);
// float fadd(float, float); and functions that break their declared contract.
export const MATH = encodeModule({
  functions: [
    { export: "add", type: t([i32, i32], [i32]), body: [...I.localGet(0), ...I.localGet(1), ADD] },
    { export: "add64", type: t(["i64", "i64"], ["i64"]), body: [...I.localGet(0), ...I.localGet(1), 0x7c] },
    { export: "sqrt", type: t(["f64"], ["f64"]), body: [...I.localGet(0), 0x9f] },
    { export: "fadd", type: t(["f32", "f32"], ["f32"]), body: [...I.localGet(0), ...I.localGet(1), 0x92] },
    { export: "three_hundred", type: t([], [i32]), body: I.i32(300) },
    { export: "two", type: t([], [i32]), body: I.i32(2) },
    { export: "minus_one", type: t([], [i32]), body: I.i32(-1) },
    { export: "is_odd", type: t([i32], [i32]), body: [...I.localGet(0), ...I.i32(1), 0x71] },
    { export: "trap", type: t([], []), body: [0x00] },
    { export: "null", type: t([], [i32]), body: I.i32(0) },
  ],
});

// Buffers and pointers: a bump allocator, size_t count(const char*, size_t) (bytes, not
// characters), int sum(const uint8_t*, size_t), void fill(uint8_t, uint8_t*, size_t), and
// a counter object: counter* new_counter(), int next(counter*), void free_counter(counter*).
export const BUFFERS = encodeModule({
  memory: { pages: 1, export: "memory" },
  globals: [{ type: i32, mutable: true, init: I.i32(1024) }],
  functions: [
    /* 0 */ { export: "y3_alloc", type: t([i32], [i32]), body: [...I.globalGet(0), ...I.globalGet(0), ...I.localGet(0), ADD, ...I.globalSet(0)] },
    /* 1 */ { export: "y3_free", type: t([i32, i32], []), body: [] },
    { export: "count", type: t([i32, i32], [i32]), body: I.localGet(1) },
    {
      export: "sum",
      type: t([i32, i32], [i32]),
      locals: [i32, i32],
      body: [
        ...BLOCK, ...LOOP,
        ...I.localGet(2), ...I.localGet(1), GE_U, ...I.brIf(1),
        ...I.localGet(3), ...I.localGet(0), ...I.localGet(2), ADD, ...I.i32Load8u, ADD, ...I.localSet(3),
        ...I.localGet(2), ...I.i32(1), ADD, ...I.localSet(2),
        ...I.br(0), END, END,
        ...I.localGet(3),
      ],
    },
    {
      export: "fill",
      type: t([i32, i32, i32], []),
      locals: [i32],
      body: [
        ...BLOCK, ...LOOP,
        ...I.localGet(3), ...I.localGet(2), GE_U, ...I.brIf(1),
        ...I.localGet(1), ...I.localGet(3), ADD, ...I.localGet(0), ...I.localGet(3), ADD, ...I.i32Store8,
        ...I.localGet(3), ...I.i32(1), ADD, ...I.localSet(3),
        ...I.br(0), END, END,
      ],
    },
    { export: "new_counter", type: t([], [i32]), locals: [i32], body: [...I.i32(4), ...I.call(0), ...I.localTee(0), ...I.i32(0), ...I.i32Store, ...I.localGet(0)] },
    { export: "next", type: t([i32], [i32]), body: [...I.localGet(0), ...I.localGet(0), ...I.i32Load, ...I.i32(1), ADD, ...I.i32Store, ...I.localGet(0), ...I.i32Load] },
    { export: "free_counter", type: t([i32], []), body: [] },
    // Reads far outside its memory: a trap, never a read of Y3's memory.
    { export: "wild", type: t([i32], [i32]), body: [...I.i32(0x7ffffff0), ...I.i32Load] },
  ],
});

// A library that wants something from its host: refused.
export const IMPORTS = encodeModule({
  imports: [{ module: "env", name: "system", type: t([i32], [i32]) }],
  functions: [{ export: "run", type: t([i32], [i32]), body: [...I.localGet(0), ...I.call(0)] }],
});

// An allocator that lies: it hands out an address past the end of memory.
export const BAD_ALLOC = encodeModule({
  memory: { pages: 1, export: "memory" },
  functions: [
    { export: "y3_alloc", type: t([i32], [i32]), body: I.i32(65530) },
    { export: "y3_free", type: t([i32, i32], []), body: [] },
    { export: "count", type: t([i32, i32], [i32]), body: I.localGet(1) },
  ],
});
