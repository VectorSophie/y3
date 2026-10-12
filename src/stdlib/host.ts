// The outside world, as the runtime sees it. Every effect goes through a Host: the
// interpreter never touches stdout, stdin, files or clocks itself, so tests use an
// in-memory host and the browser build never imports node:fs.

export type FsErrorKind = "NotFound" | "PermissionDenied" | "AlreadyExists" | "IsDirectory" | "Other";
export type FsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: FsErrorKind; readonly message: string };

// What a host can offer a program. A host may deny any of them: the browser, say, has no
// filesystem. A denied capability is reported at the call that needed it.
export type Capability = "stdin" | "filesystem" | "clock" | "ffi";
export const CAPABILITIES: readonly Capability[] = ["stdin", "filesystem", "clock", "ffi"];

export interface Host {
  // Absent or true: provided. false: denied.
  readonly capabilities?: Partial<Record<Capability, boolean>>;
  // Standard output: what is written here is committed; it is never taken back.
  write(text: string): void;
  // Standard input. A line without its line break, or the next whitespace-separated
  // token; null at the end of input. Lines and tokens read the same stream.
  readLine(): string | null;
  readToken(): string | null;
  // Files, synchronously, as bytes.
  readFile(path: string): FsResult<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): FsResult<null>;
  appendFile(path: string, bytes: Uint8Array): FsResult<null>;
  stat(path: string): FsResult<{ readonly size: bigint; readonly directory: boolean }>;
  // Clocks: wall time in milliseconds since the Unix epoch; a monotonic reading in
  // nanoseconds from an arbitrary origin.
  nowMillis(): bigint;
  monotonicNanos(): bigint;
  // Foreign libraries (docs/v2-ffi.md): a library's bytes by its [foreign] path, or null.
  // A host without it cannot run foreign calls.
  loadLibrary?(path: string): Uint8Array | null;
}

// Reads lines and tokens from text that arrives in chunks (all at once, or as the
// user types). `pull` returns the next chunk, or null at the end.
export class InputReader {
  private buffer = "";
  private ended = false;

  constructor(private readonly pull: () => string | null) {}

  private fill(until: () => boolean): void {
    while (!this.ended && !until()) {
      const chunk = this.pull();
      if (chunk === null) this.ended = true;
      else this.buffer += chunk;
    }
  }

  readLine(): string | null {
    this.fill(() => this.buffer.includes("\n"));
    if (this.buffer.length === 0 && this.ended) return null;
    const end = this.buffer.indexOf("\n");
    const line = end < 0 ? this.buffer : this.buffer.slice(0, end);
    this.buffer = end < 0 ? "" : this.buffer.slice(end + 1);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  readToken(): string | null {
    for (;;) {
      this.fill(() => /\S\s/u.test(this.buffer));
      const match = this.buffer.match(/^\s*(\S+)/u);
      if (match) {
        this.buffer = this.buffer.slice(match[0].length);
        return match[1] ?? null;
      }
      if (this.ended) return null;
    }
  }
}

// A host with no outside world: stdin from a string, files in a map, a fixed clock.
export type MemoryHost = Host & { readonly stdout: string[]; readonly files: Map<string, Uint8Array<ArrayBufferLike>> };

export function memoryHost(options: { stdin?: string; files?: Record<string, string>; now?: bigint; deny?: readonly Capability[]; libraries?: Record<string, Uint8Array> } = {}): MemoryHost {
  let stdin: string | null = options.stdin ?? "";
  const reader = new InputReader(() => {
    const chunk = stdin;
    stdin = null;
    return chunk;
  });
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array<ArrayBufferLike>>(Object.entries(options.files ?? {}).map(([path, text]) => [path, encoder.encode(text)]));
  const stdout: string[] = [];
  let ticks = 0n;
  const missing = (path: string) => ({ ok: false, kind: "NotFound", message: `no such file: ${path}` }) as const;
  return {
    capabilities: Object.fromEntries((options.deny ?? []).map((c) => [c, false])),
    loadLibrary: (path) => options.libraries?.[path] ?? null,
    stdout,
    files,
    write: (text) => stdout.push(text),
    readLine: () => reader.readLine(),
    readToken: () => reader.readToken(),
    readFile: (path) => {
      const bytes = files.get(path);
      return bytes ? { ok: true, value: bytes } : missing(path);
    },
    writeFile: (path, bytes) => {
      files.set(path, bytes);
      return { ok: true, value: null };
    },
    appendFile: (path, bytes) => {
      const before = files.get(path);
      if (!before) return missing(path);
      const joined = new Uint8Array(before.length + bytes.length);
      joined.set(before);
      joined.set(bytes, before.length);
      files.set(path, joined);
      return { ok: true, value: null };
    },
    stat: (path) => {
      const bytes = files.get(path);
      return bytes ? { ok: true, value: { size: BigInt(bytes.length), directory: false } } : missing(path);
    },
    nowMillis: () => options.now ?? 0n,
    monotonicNanos: () => {
      ticks += 1000n;
      return ticks;
    },
  };
}
