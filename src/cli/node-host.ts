import { appendFileSync, existsSync, readFileSync, readSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isProjectPath } from "../space/manifest";
import { InputReader, type FsErrorKind, type FsResult, type Host } from "../stdlib/host";

// The real outside world for `y3 run`: stdout as the program writes it, stdin read as
// the user types (a line at a time), the file system, and the host's clocks.

function fsError(error: unknown): { ok: false; kind: FsErrorKind; message: string } {
  const code = (error as { code?: string }).code;
  const kind: FsErrorKind = code === "ENOENT" ? "NotFound" : code === "EACCES" || code === "EPERM" ? "PermissionDenied" : code === "EEXIST" ? "AlreadyExists" : code === "EISDIR" ? "IsDirectory" : "Other";
  return { ok: false, kind, message: error instanceof Error ? error.message : String(error) };
}

function attempt<T>(f: () => T): FsResult<T> {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return fsError(error);
  }
}

// Foreign libraries, read only from inside the project directory: a [foreign] path is
// relative, has no '..', and must not leave the directory through a symbolic link either.
export function libraryLoader(root: string): (path: string) => Uint8Array | null {
  return (path) => {
    if (!isProjectPath(path)) return null;
    try {
      const base = realpathSync(root);
      const real = realpathSync(resolve(base, path));
      if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
      return new Uint8Array(readFileSync(real));
    } catch {
      return null;
    }
  };
}

export function nodeHost(options: { stdin?: string; write?: (text: string) => void; root?: string } = {}): Host {
  const chunk = Buffer.alloc(4096);
  const decoder = new TextDecoder("utf-8");
  let given = options.stdin;
  const reader = new InputReader(() => {
    if (given !== undefined) {
      const text = given;
      given = undefined;
      return text === "" ? null : text;
    }
    if (options.stdin !== undefined) return null;
    try {
      const n = readSync(0, chunk, 0, chunk.length, null);
      return n === 0 ? null : decoder.decode(chunk.subarray(0, n), { stream: true });
    } catch (error) {
      if ((error as { code?: string }).code === "EAGAIN") return "";
      if ((error as { code?: string }).code === "EOF") return null;
      throw error;
    }
  });
  return {
    write: options.write ?? ((text) => writeSync(1, text)),
    readLine: () => reader.readLine(),
    readToken: () => reader.readToken(),
    readFile: (path) => attempt(() => new Uint8Array(readFileSync(path))),
    writeFile: (path, bytes) => attempt(() => (writeFileSync(path, bytes), null)),
    appendFile: (path, bytes) =>
      attempt(() => {
        if (!existsSync(path)) throw Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
        appendFileSync(path, bytes);
        return null;
      }),
    stat: (path) =>
      attempt(() => {
        const info = statSync(path, { bigint: true });
        return { size: info.size, directory: info.isDirectory() };
      }),
    nowMillis: () => BigInt(Date.now()),
    monotonicNanos: () => process.hrtime.bigint(),
    loadLibrary: libraryLoader(options.root ?? "."),
  };
}
