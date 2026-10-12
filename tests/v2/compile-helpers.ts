import { dirname, join, normalize } from "node:path";
import { compileProgram, hasErrors, loadDocument, memoryHost, runProgram, type CompiledProgram, type Manifest, type ModuleResolver, type ProgramResult } from "../../src/v2";
import { readRepoFile } from "./helpers";

// Shared helpers for M8 tests: compile a source (imports resolve inside the repository
// or from an in-memory map), and run it with the reference interpreter.

export const repoModules =
  (files: Record<string, string> = {}): ModuleResolver =>
  (path, from) => {
    if (files[path] !== undefined) return { path, source: files[path] as string };
    const full = normalize(join(from === null ? "." : dirname(from), path));
    try {
      return { path: full, source: readRepoFile(full) };
    } catch {
      return null;
    }
  };

export function compileSource(source: string, path?: string, files: Record<string, string> = {}): { program: CompiledProgram; manifest: Manifest } | null {
  const loaded = loadDocument(source);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) return null;
  const compiled = compileProgram(loaded.ast, loaded.space, { path, resolve: repoModules(files) });
  return compiled.program ? { program: compiled.program, manifest: loaded.manifest } : null;
}

export function runHir(c: { program: CompiledProgram; manifest: Manifest }, maxSteps?: number, stdin?: string): ProgramResult {
  return runProgram(c.program, c.manifest, { maxSteps, host: memoryHost({ stdin, now: 42n }) });
}

export const column = (cells: string[], appendix = "") => `⟦\n${cells.map((c) => `[${c}]`).join("\n")}\n⟧\n${appendix ? `\n※\n\n${appendix}` : ""}`;
