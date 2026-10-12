# Y3 v2: the standard library (M7)

The standard library is built in. It uses the same calls, names and types as user code:
`[결과는 수학 최댓값: a, b]` goes through name resolution, signature instantiation and
type checking, exactly like a call to a callable plane. Every callable has:
- a **source spelling**, a Korean namespace and name: `표준 줄출력`;
- a **stable id** that tools and backends use: `std.io.println`.

The two do not need to match.

Kinds:
- **pure**: a function of its arguments.
- **output**: stdout. The argument may still be a temporal symbol; the write is held.
- **effect**: reaches the outside world through the runtime's host, with concrete
  arguments, and commits when it runs (`docs/v2-runtime-model.md` §6).

In the types below:
- `T: number`, `T: integer`, `T: float` are bounded type parameters;
- `K: key` means a key type (runtime model §3);
- `…` is any number of further arguments.

## std/io: 표준

| Source | Id | Type | Kind |
|---|---|---|---|
| `표준 출력` | `std.io.print` | `<T>(T) → Unit` | output |
| `표준 줄출력` | `std.io.println` | `<T>(T) → Unit` | output |
| `표준 형식` | `std.io.format` | `(Text, …) → Text` | pure |
| `표준 줄읽기` | `std.io.readLine` | `() → Option<Text>` | effect |
| `표준 낱말읽기` | `std.io.readToken` | `() → Option<Text>` | effect |

- `[x를 말한다.]` is `[표준 줄출력: x]`: the same call, the same output path.
- `형식` fills each `{}` with the next value, as `말한다` would print it. `{{` and
  `}}` are literal braces. A template written out in the source is checked before the
  run (`Y3Y003` if the count is wrong); any other template is checked when it runs
  (`FAULT`).
- `줄읽기` returns the next line without its line break; `낱말읽기` returns the next
  whitespace-separated token. Both read the same stream, and both give `None` at the
  end of input. Every read is recorded as an event. Like every effect other than output,
  a read never runs while earlier output is held (runtime model §6).

## std/text: 글

| Source | Id | Type | Kind |
|---|---|---|---|
| `글 길이` | `std.text.length` | `(Text) → i64` | pure |
| `글 바이트길이` | `std.text.byteLength` | `(Text) → i64` | pure |
| `글 글자수` | `std.text.graphemes` | `(Text) → i64` | pure |
| `글 포함` | `std.text.contains` | `(Text, Text) → Bool` | pure |
| `글 시작함` | `std.text.startsWith` | `(Text, Text) → Bool` | pure |
| `글 끝남` | `std.text.endsWith` | `(Text, Text) → Bool` | pure |
| `글 자르기` | `std.text.slice` | `(Text, i64, i64) → Text` | pure |
| `글 나누기` | `std.text.split` | `(Text, Text) → List<Text>` | pure |
| `글 잇기` | `std.text.join` | `(List<Text>, Text) → Text` | pure |
| `글 문자들` | `std.text.runes` | `(Text) → List<Rune>` | pure |
| `글 모으기` | `std.text.fromRunes` | `(List<Rune>) → Text` | pure |
| `글 문자` | `std.text.rune` | `(u32) → Option<Rune>` | pure |
| `글 정수로` | `std.text.parseInt` | `(Text) → Result<i64, ParseError>` | pure |
| `글 실수로` | `std.text.parseFloat` | `(Text) → Result<f64, ParseError>` | pure |
| `글 글로` | `std.text.show` | `<T>(T) → Text` | pure |

- Positions and lengths count runes; `바이트길이` counts UTF-8 bytes; `글자수` counts
  grapheme clusters (runtime model §2).
- `자르기` takes runes `[a, b)`. Out of range is a `FAULT`.
- `나누기` with an empty separator splits between runes.
- `정수로` accepts an optional sign and decimal digits, nothing else (no spaces).
  `실수로` accepts decimal and exponent forms, and the printed forms `NaN`, `+Inf` and
  `-Inf`. Bad input is `Err(Invalid(…))`; an integer outside `i64` is
  `Err(OutOfRange(…))`.

## std/math: 수학

| Source | Id | Type | Kind |
|---|---|---|---|
| `수학 절댓값` | `std.math.abs` | `<T: number>(T) → T` | pure |
| `수학 최솟값` | `std.math.min` | `<T: number>(T, T) → T` | pure |
| `수학 최댓값` | `std.math.max` | `<T: number>(T, T) → T` | pure |
| `수학 범위` | `std.math.clamp` | `<T: number>(T, T, T) → T` | pure |
| `수학 나머지` | `std.math.rem` | `<T: integer>(T, T) → T` | pure |
| `수학 제곱근` | `std.math.sqrt` | `<T: float>(T) → T` | pure |
| `수학 내림` | `std.math.floor` | `<T: float>(T) → T` | pure |
| `수학 올림` | `std.math.ceil` | `<T: float>(T) → T` | pure |
| `수학 반올림` | `std.math.round` | `<T: float>(T) → T` | pure |

- Integers stay checked: `수학 절댓값: -128i8` is a `FAULT` (128 is not an `i8`).
- `최솟값`/`최댓값` of floats propagate NaN.
- `범위: x, lo, hi` faults if `lo > hi`.
- `반올림` rounds half away from zero (Go's `math.Round`, Rust's `round`).
- `나머지` takes the sign of the dividend and faults on zero.

## Conversions: 변환

| Source | Id | Type | Kind |
|---|---|---|---|
| `변환 i8` | `std.convert.i8` | `<T: number>(T) → i8` | pure |
| `변환 i16` | `std.convert.i16` | `<T: number>(T) → i16` | pure |
| `변환 i32` | `std.convert.i32` | `<T: number>(T) → i32` | pure |
| `변환 i64` | `std.convert.i64` | `<T: number>(T) → i64` | pure |
| `변환 i128` | `std.convert.i128` | `<T: number>(T) → i128` | pure |
| `변환 u8` | `std.convert.u8` | `<T: number>(T) → u8` | pure |
| `변환 u16` | `std.convert.u16` | `<T: number>(T) → u16` | pure |
| `변환 u32` | `std.convert.u32` | `<T: number>(T) → u32` | pure |
| `변환 u64` | `std.convert.u64` | `<T: number>(T) → u64` | pure |
| `변환 u128` | `std.convert.u128` | `<T: number>(T) → u128` | pure |
| `변환 bigint` | `std.convert.bigint` | `<T: number>(T) → bigint` | pure |
| `변환 f32` | `std.convert.f32` | `<T: number>(T) → f32` | pure |
| `변환 f64` | `std.convert.f64` | `<T: number>(T) → f64` | pure |

Rules: runtime model §1.3. A conversion is the only way a number changes type.

## std/collections: 목록, 사전, 집합

| Source | Id | Type | Kind |
|---|---|---|---|
| `목록 새` | `std.collections.list.new` | `<T>() → List<T>` | pure |
| `목록 만들기` | `std.collections.list.of` | `<T>(T…) → List<T>` | pure |
| `목록 추가` | `std.collections.list.push` | `<T>(List<T>, T) → List<T>` | pure |
| `목록 길이` | `std.collections.list.length` | `<T>(List<T>) → i64` | pure |
| `목록 가져오기` | `std.collections.list.get` | `<T>(List<T>, i64) → Option<T>` | pure |
| `목록 바꾸기` | `std.collections.list.set` | `<T>(List<T>, i64, T) → List<T>` | pure |
| `사전 새` | `std.collections.map.new` | `<K: key, V>() → Map<K, V>` | pure |
| `사전 넣기` | `std.collections.map.insert` | `<K: key, V>(Map<K, V>, K, V) → Map<K, V>` | pure |
| `사전 찾기` | `std.collections.map.get` | `<K: key, V>(Map<K, V>, K) → Option<V>` | pure |
| `사전 빼기` | `std.collections.map.remove` | `<K: key, V>(Map<K, V>, K) → Map<K, V>` | pure |
| `사전 포함` | `std.collections.map.has` | `<K: key, V>(Map<K, V>, K) → Bool` | pure |
| `사전 길이` | `std.collections.map.length` | `<K: key, V>(Map<K, V>) → i64` | pure |
| `사전 열쇠들` | `std.collections.map.keys` | `<K: key, V>(Map<K, V>) → List<K>` | pure |
| `집합 새` | `std.collections.set.new` | `<T: key>() → Set<T>` | pure |
| `집합 넣기` | `std.collections.set.insert` | `<T: key>(Set<T>, T) → Set<T>` | pure |
| `집합 포함` | `std.collections.set.has` | `<T: key>(Set<T>, T) → Bool` | pure |
| `집합 빼기` | `std.collections.set.remove` | `<T: key>(Set<T>, T) → Set<T>` | pure |
| `집합 길이` | `std.collections.set.length` | `<T: key>(Set<T>) → i64` | pure |
| `집합 원소들` | `std.collections.set.elements` | `<T: key>(Set<T>) → List<T>` | pure |

- Collections are values. `추가`, `넣기`, `빼기` and `바꾸기` return a new collection,
  and the old one is unchanged.
- `목록` elements are also read with `l의 i번`, which faults out of range; use
  `가져오기` for an `Option`.
- `사전 열쇠들` and `집합 원소들` keep insertion order.
- Keys must be key types (`Y3N002` otherwise).

## std/fs: 파일

| Source | Id | Type | Kind |
|---|---|---|---|
| `파일 읽기` | `std.fs.read` | `(Text) → Result<Text, FsError>` | effect |
| `파일 쓰기` | `std.fs.write` | `(Text, Text) → Result<Unit, FsError>` | effect |
| `파일 존재` | `std.fs.exists` | `(Text) → Bool` | effect |
| `파일 정보` | `std.fs.metadata` | `(Text) → Result<FileInfo, FsError>` | effect |
| `파일 열기` | `std.fs.open` | `(Text) → Result<File, FsError>` | effect |
| `파일 만들기` | `std.fs.create` | `(Text) → Result<File, FsError>` | effect |
| `파일 내용` | `std.fs.readHandle` | `(File) → Result<Text, FsError>` | effect |
| `파일 덧쓰기` | `std.fs.append` | `(File, Text) → Result<Unit, FsError>` | effect |
| `파일 닫기` | `std.fs.close` | `(File) → Result<Unit, FsError>` | effect |
| `파일 경로잇기` | `std.fs.join` | `(Text, Text) → Text` | pure |

- Every failure the outside world can cause is an `Err(FsError)`:

  ```
  자료 FsError = NotFound(Text) | PermissionDenied(Text) | AlreadyExists(Text)
               | IsDirectory(Text) | Closed(Text) | Other(Text)
  자료 FileInfo = { 크기: u64, 폴더: Bool }
  ```

- `열기` opens an existing file for reading (`내용`) and appending (`덧쓰기`). `만들기`
  creates or empties a file.
- After `닫기`, the handle's operations give `Err(Closed(…))`.
- `File` is the only value that refers rather than contains: a copy names the same
  open file.
- `경로잇기` joins POSIX-style. It is pure, because it touches no files.

## std/clock: 시계

| Source | Id | Type | Kind |
|---|---|---|---|
| `시계 지금` | `std.clock.now` | `() → i64` | effect |
| `시계 단조` | `std.clock.monotonic` | `() → i64` | effect |

- `지금`: wall time, in milliseconds since the Unix epoch. `단조`: a monotonic reading,
  in nanoseconds from an arbitrary origin.
- Readings are `i64`, recorded as events, and can never become temporal symbols.
  `clock` is named so that it never meets Y3's own time (tense, `처음`, `끝`).
- There is no `sleep`: nothing needs it yet.

## Option and Result: 선택, 결과

| Source | Id | Type | Kind |
|---|---|---|---|
| `선택 꺼내기` | `std.option.unwrap` | `<T>(Option<T>) → T` | pure |
| `선택 아니면` | `std.option.unwrapOr` | `<T>(Option<T>, T) → T` | pure |
| `결과 꺼내기` | `std.result.unwrap` | `<T, E>(Result<T, E>) → T` | pure |
| `결과 아니면` | `std.result.unwrapOr` | `<T, E>(Result<T, E>, T) → T` | pure |
- Handle an `Option` or `Result` with a match: `[v는 r에 따라: Ok(x) → x, Err(e) → …]`.
- `아니면` supplies a default.
- `꺼내기` asserts that the value is there. On `None` or `Err` it is a `FAULT`: the
  program has declared that case a bug.

## Error types

```
자료 ParseError = Invalid(Text) | OutOfRange(Text)
```

`Some`, `None`, `Ok`, `Err`, the `FsError` and `ParseError` variants, and `FileInfo`
are built-in constructors. Patterns use them like a program's own:
`Err(NotFound(p)) → …`.
