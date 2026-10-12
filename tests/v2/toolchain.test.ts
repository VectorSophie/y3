import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageResolver, PackageError, readLock, writeLock } from "../../src/cli/packages";
import { compileProgram, documentModule, interpretManifest, loadDocument, parseDocument, runProgram, memoryHost } from "../../src/v2";
import { readRepoFile } from "./helpers";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

function repo(lib: string) {
  const dir = mkdtempSync(join(tmpdir(), "y3-repo-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "lib.y3"), lib);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "v1");
  return dir;
}
const lib = (body: string) => `+++\nname = "원격"\n+++\n\n※\n\n:둘배: (x: i64) → i64 ⟦\n${body}\n⟧\n`;
const app = (url: string) => `+++\n[imports]\n"원" = { git = "${url}", ref = "main", path = "lib.y3" }\n+++\n\n⟦\n[y는 원 둘배: 21]\n[y를 말한다.]\n[끝이다.]\n⟧\n`;

function run(source: string, resolve: Parameters<typeof compileProgram>[2] extends infer O ? O extends { resolve?: infer R } ? R : never : never) {
  const loaded = loadDocument(source);
  const compiled = compileProgram(loaded.ast!, loaded.space!, { resolve });
  if (!compiled.program) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
  return runProgram(compiled.program, loaded.manifest!, { host: memoryHost() }).output;
}

describe("package resolution", () => {
  it("refuses an unlocked git import, pins it with lock, and keeps the pin when upstream moves", () => {
    const upstream = repo(lib("[x에 x를 더한다.]\n[x를 돌려준다.]"));
    const root = mkdtempSync(join(tmpdir(), "y3-app-"));
    const source = app(`file://${upstream}`);
    expect(() => run(source, packageResolver({ root, mode: "locked" }).resolve)).toThrow(PackageError);
    const update = packageResolver({ root, mode: "update" });
    expect(run(source, update.resolve)).toEqual(["42"]);
    writeLock(root, update.lock());
    const rev = readLock(root).packages[0]?.rev;
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(upstream, "lib.y3"), lib("[x를 돌려준다.]"));
    git(upstream, "commit", "-qam", "v2");
    expect(run(source, packageResolver({ root, mode: "locked" }).resolve)).toEqual(["42"]); // still v1
    const relock = packageResolver({ root: mkdtempSync(join(tmpdir(), "y3-app2-")), mode: "update" });
    expect(run(source, relock.resolve)).toEqual(["21"]); // a new lock sees v2
  });

  it("writes the lock deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "y3-lock-"));
    writeLock(dir, { version: 1, packages: [{ git: "b", ref: "main", rev: "2".repeat(40) }, { git: "a", ref: "main", rev: "1".repeat(40) }] });
    const once = readLock(dir);
    writeLock(dir, { version: 1, packages: [...once.packages].reverse() });
    expect(readLock(dir)).toEqual(once);
    expect(once.packages.map((p) => p.git)).toEqual(["a", "b"]);
  });
});

describe("manifest [test]", () => {
  it("reads expected output, outcome and stdin", () => {
    expect(interpretManifest('[test]\noutput = ["1"]\nstatus = "FAULT"\nstdin = "x"').manifest?.test).toEqual({ output: ["1"], status: "FAULT", stdin: "x" });
    expect(interpretManifest("[test]\noutput = 3").diagnostics[0]?.message).toBe("test.output must be a list of lines");
  });
});

describe("y3 doc", () => {
  it("extracts types, callable planes, named planes and doc comments", () => {
    const ast = parseDocument(`※\n\n# A point.\n자료 점 = { 가로: i64, 세로: i64 }\n자료 모양<T> = 원(T) | 빈것\n\n# Doubles a number.\n# Twice.\n:둘배: (x: i64) → i64 ⟦\n[x를 돌려준다.]\n⟧\n\n:바닥: ⟦ [ ] ⟧\n`);
    if (!ast.ok) throw new Error("parse");
    const doc = documentModule(ast.ast, "도형");
    expect(doc.types).toMatchObject([
      { name: "점", kind: "record", fields: [{ name: "가로", type: "i64" }, { name: "세로", type: "i64" }], doc: "A point." },
      { name: "모양", params: ["T"], kind: "sum", variants: [{ name: "원", fields: ["T"] }, { name: "빈것", fields: [] }] },
    ]);
    expect(doc.callables).toEqual([{ name: "둘배", signature: "(x: i64) → i64", params: [{ name: "x", type: "i64" }], results: ["i64"], doc: "Doubles a number.\nTwice." }]);
    expect(doc.planes).toEqual([{ name: "바닥", doc: "" }]);
    expect(documentModule(parseDocument(readRepoFile("tests/conformance/core/lib/geometry.y3")).ast!, "x").module).toBe("기하");
  });
});
