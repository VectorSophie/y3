import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { ModuleResolver } from "../semantics/program";

// Module resolution for the toolchain (docs/v2-toolchain.md). The language only sees a
// ModuleResolver; where modules come from is decided here:
//
//   "lib/geometry.y3"                         a local path, relative to the importing file
//   { git = "url", ref = "main", path = … }   a file in a git repository, at the revision
//                                             y3.lock pins for that url and ref
//
// A build never follows a moving branch: a git import without a lock entry is an error,
// and only `y3 lock` resolves refs to revisions and writes the lock. There is no registry.

export const LOCKFILE = "y3.lock";

export type LockEntry = { readonly git: string; readonly ref: string; readonly rev: string };
export type Lock = { readonly version: 1; readonly packages: LockEntry[] };

export class PackageError extends Error {}

const GIT_IMPORT = /^git\+(.+)\?ref=([^#]*)#(.+)$/;
// Inside a fetched repository: "git+<url>@<rev>#<path>", the module's canonical name.
const GIT_MODULE = /^git\+(.+)@([0-9a-f]{40})#(.+)$/;

export function readLock(dir: string): Lock {
  const file = join(dir, LOCKFILE);
  if (!existsSync(file)) return { version: 1, packages: [] };
  const lock = JSON.parse(readFileSync(file, "utf8")) as Lock;
  if (lock.version !== 1 || !Array.isArray(lock.packages)) throw new PackageError(`${file} is not a version 1 lock file`);
  return lock;
}

// Deterministic: entries sorted, one per line, so the lock diffs cleanly.
export function writeLock(dir: string, lock: Lock): void {
  const packages = [...lock.packages].sort((a, b) => (a.git + a.ref < b.git + b.ref ? -1 : 1));
  writeFileSync(join(dir, LOCKFILE), `{\n  "version": 1,\n  "packages": [${packages.map((p) => `\n    ${JSON.stringify(p)}`).join(",")}${packages.length ? "\n  " : ""}]\n}\n`);
}

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A bare clone of a repository, shared by every build that uses it.
function cache(url: string, cacheDir: string): string {
  const dir = join(cacheDir, createHash("sha256").update(url).digest("hex").slice(0, 16));
  if (!existsSync(dir)) {
    mkdirSync(cacheDir, { recursive: true });
    git(["clone", "--quiet", "--bare", url, dir]);
  }
  return dir;
}

function hasRev(repo: string, rev: string): boolean {
  try {
    git(["cat-file", "-e", `${rev}^{commit}`], repo);
    return true;
  } catch {
    return false;
  }
}

// Resolves imports. In "locked" mode a git import must already be in the lock; in
// "update" mode (`y3 lock`) its ref is resolved now and recorded.
export function packageResolver(options: { root: string; mode: "locked" | "update"; cacheDir?: string }): { resolve: ModuleResolver; lock: () => Lock } {
  const lock = readLock(options.root);
  const entries = new Map(lock.packages.map((p) => [`${p.git}\n${p.ref}`, p]));
  const cacheDir = options.cacheDir ?? join(options.root, ".y3", "cache");

  const fromGit = (url: string, rev: string, path: string) => {
    const repo = cache(url, cacheDir);
    if (!hasRev(repo, rev)) git(["fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], repo);
    if (!hasRev(repo, rev)) throw new PackageError(`${url} has no revision ${rev}`);
    try {
      return { path: `git+${url}@${rev}#${path}`, source: git(["show", `${rev}:${path}`], repo) };
    } catch {
      return null;
    }
  };

  const resolveImport: ModuleResolver = (spec, from) => {
    const imported = spec.match(GIT_IMPORT);
    if (imported) {
      const [, url, ref, path] = imported as unknown as [string, string, string, string];
      const key = `${url}\n${decodeURIComponent(ref)}`;
      let entry = entries.get(key);
      if (!entry) {
        if (options.mode === "locked") throw new PackageError(`${url} (${decodeURIComponent(ref)}) is not in ${LOCKFILE}: run 'y3 lock' to pin it`);
        const repo = cache(url, cacheDir);
        git(["fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], repo);
        const rev = git(["rev-parse", `${decodeURIComponent(ref)}^{commit}`], repo).trim();
        entry = { git: url, ref: decodeURIComponent(ref), rev };
        entries.set(key, entry);
      }
      return fromGit(url, entry.rev, posix.normalize(path));
    }
    // A relative import inside a git module stays in that repository, at that revision.
    const inside = from?.match(GIT_MODULE);
    if (inside) {
      const [, url, rev, file] = inside as unknown as [string, string, string, string];
      return fromGit(url, rev, posix.normalize(posix.join(posix.dirname(file), spec)));
    }
    const full = resolve(from === null ? options.root : dirname(from), spec);
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return { path: relative(".", full), source: readFileSync(full, "utf8") };
  };

  return { resolve: resolveImport, lock: () => ({ version: 1, packages: [...entries.values()] }) };
}
