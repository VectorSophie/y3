import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, type DocumentAst } from "../../src/v2";

export function parseOk(source: string): DocumentAst {
  const result = parseDocument(source);
  if (!result.ok) {
    throw new Error(`expected a valid document:\n${result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")}`);
  }
  return result.ast;
}

export function parseError(source: string): { code: string; line: number; message: string } {
  const result = parseDocument(source);
  if (result.ok) {
    throw new Error("expected a syntax error");
  }
  const diagnostic = result.diagnostics[0];
  if (!diagnostic) {
    throw new Error("expected a diagnostic");
  }
  return { code: diagnostic.code, line: diagnostic.span.start.line, message: diagnostic.message };
}

const ROOT = join(__dirname, "..", "..");

// Every v2 example and conformance fixture in the repository.
export function fixtures(): { path: string; source: string }[] {
  const dirs = ["examples/v2", "tests/conformance/present", "tests/conformance/temporal", "tests/conformance/cycles"];
  return dirs.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((file) => file.endsWith(".y3"))
      .sort()
      .map((file) => ({ path: `${dir}/${file}`, source: readFileSync(join(ROOT, dir, file), "utf8") })),
  );
}

export function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}
