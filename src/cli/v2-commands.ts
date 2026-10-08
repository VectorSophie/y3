import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Command } from "commander";
import { loadDocument } from "../container/document";
import { packDocument, unpackDocument, type FileMap } from "../container/pack";
import { formatDocument } from "../format/formatter";
import { isProjection, PROJECTIONS } from "../format/projection";
import { formatDiagnostic, hasErrors, Y3DocumentError } from "../language/diagnostics";

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

function report(error: unknown): never {
  if (error instanceof Y3DocumentError) {
    fatal(error.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"));
  }
  fatal(error instanceof Error ? error.message : String(error));
}

function loadOrExit(filePath: string) {
  const loaded = loadDocument(readFileSync(filePath, "utf8"));
  for (const diagnostic of loaded.diagnostics) {
    console.error(formatDiagnostic(diagnostic, filePath));
  }
  if (hasErrors(loaded.diagnostics) || !loaded.ast) {
    process.exit(1);
  }
  return { ast: loaded.ast, space: loaded.space };
}

function readTree(root: string): FileMap {
  const files: FileMap = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.set(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return files;
}

export function registerV2Commands(cli: Command): void {
  cli
    .command("check")
    .description("check a v2 document's structure (planes, references, the ※ section)")
    .argument("<file>", "path to a .y3 document")
    .action((filePath: string) => {
      const { space } = loadOrExit(filePath);
      const layers = space?.layers ?? [];
      const sizes = layers.map((layer) => `${layer.plane.width}×${layer.plane.height}`).join(", ");
      console.log(`ok: ${layers.length} layer(s) [${sizes}]`);
    });

  cli
    .command("fmt")
    .description("print a v2 document in canonical form")
    .argument("<file>", "path to a .y3 document")
    .option("-p, --projection <style>", `depth projection: ${PROJECTIONS.join(" | ")}`, "perspective")
    .option("-w, --write", "rewrite the file in place")
    .option("--check", "exit 1 if the file is not already formatted")
    .action((filePath: string, options: { projection: string; write?: boolean; check?: boolean }) => {
      if (!isProjection(options.projection)) {
        fatal(`unknown projection '${options.projection}'. Expected: ${PROJECTIONS.join(", ")}`);
      }
      const { ast } = loadOrExit(filePath);
      const formatted = formatDocument(ast, { projection: options.projection });
      if (options.check) {
        if (readFileSync(filePath, "utf8") !== formatted) {
          fatal(`${filePath}: not formatted`);
        }
        return;
      }
      if (options.write) {
        writeFileSync(filePath, formatted);
        return;
      }
      process.stdout.write(formatted);
    });

  cli
    .command("unpack")
    .description("write a document's internal representation to a folder")
    .argument("<file>", "path to a .y3 document")
    .option("-o, --out <dir>", "output folder (default: the file name without .y3)")
    .option("-f, --force", "write into an existing, non-empty folder")
    .action((filePath: string, options: { out?: string; force?: boolean }) => {
      const out = options.out ?? join(dirname(filePath), basename(filePath, ".y3"));
      if (existsSync(out) && readdirSync(out).length > 0 && !options.force) {
        fatal(`${out} already exists and is not empty (use --force)`);
      }
      try {
        for (const [path, content] of unpackDocument(readFileSync(filePath, "utf8"))) {
          const target = join(out, ...path.split("/"));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      } catch (error) {
        report(error);
      }
      console.log(`unpacked to ${out}`);
    });

  cli
    .command("pack")
    .description("assemble an unpacked folder back into one .y3 document")
    .argument("<dir>", "folder produced by 'y3 unpack'")
    .option("-o, --out <file>", "output file (default: <dir>.y3)")
    .option("-f, --force", "overwrite an existing file")
    .action((dir: string, options: { out?: string; force?: boolean }) => {
      const out = options.out ?? `${dir.replace(/[\\/]+$/, "")}.y3`;
      if (existsSync(out) && !options.force) {
        fatal(`${out} already exists (use --force)`);
      }
      try {
        writeFileSync(out, packDocument(readTree(dir)));
      } catch (error) {
        report(error);
      }
      console.log(`packed to ${out}`);
    });
}
