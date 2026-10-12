import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { loadDocument } from "../container/document";
import { compileProgram, type ModuleResolver } from "../semantics/program";
import { runProgram, type ProgramResult } from "../runtime/interpreter";
import { runExecutable } from "../runtime/vm";
import { compileWasm, loadWasmArtifact } from "../compiler/wasm";
import { runWasm } from "../runtime/wasm-host";
import { ReplayDivergence, type RunOptions } from "../runtime/core";
import { readReplay, ReplayError, writeReplay, type Replay } from "../tools/replay";
import { compileToMir } from "../compiler/compile";
import { formatCfg } from "../compiler/cfg";
import { formatMir } from "../compiler/mir";
import { optimizeMir } from "../compiler/optimize";
import { BYTECODE_MAGIC, encodeBytecode, loadBytecode, moduleOf, writeArtifact, type Loaded } from "../compiler/bytecode";
import { DEFAULT_MANIFEST, type Manifest } from "../space/manifest";
import type { CompiledProgram } from "../ir/program";
import { packageResolver, PackageError, writeLock } from "./packages";
import { documentModule, documentStandardLibrary, formatDoc } from "../tools/doc";
import { formatProgramTrace } from "../runtime/program-trace";
import { libraryLoader, nodeHost } from "./node-host";
import { formatCompiledIr } from "../ir/print";
import { describeProgramOutcome, PROGRAM_EXIT_CODES } from "../runtime/program-outcome";
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

function loadOrExit(filePath: string, source = readFileSync(filePath, "utf8")) {
  const loaded = loadDocument(source);
  for (const diagnostic of loaded.diagnostics) {
    console.error(formatDiagnostic(diagnostic, filePath));
  }
  if (hasErrors(loaded.diagnostics) || !loaded.ast) {
    process.exit(1);
  }
  return { ast: loaded.ast, space: loaded.space, manifest: loaded.manifest };
}

// Imports resolve through the package resolver: local paths relative to the importing
// file, git imports at the revision y3.lock pins (docs/v2-toolchain.md).
function modulesFor(filePath: string, mode: "locked" | "update" = "locked") {
  return packageResolver({ root: dirname(resolve(filePath)), mode });
}

// Loads and compiles a v2 program; prints every diagnostic and exits on errors.
function compileOrExit(filePath: string, source?: string, resolver: ModuleResolver = modulesFor(filePath).resolve) {
  const { ast, space, manifest } = loadOrExit(filePath, source);
  if (!space || !manifest) process.exit(1);
  let compiled: ReturnType<typeof compileProgram>;
  try {
    compiled = compileProgram(ast, space, { path: relative(".", resolve(filePath)), resolve: resolver, libraries: libraryLoader(dirname(resolve(filePath))) });
  } catch (error) {
    if (error instanceof PackageError) fatal(`${filePath}: ${error.message}`);
    throw error;
  }
  for (const diagnostic of compiled.diagnostics) {
    console.error(formatDiagnostic(diagnostic, filePath));
  }
  if (!compiled.program) process.exit(1);
  return { program: compiled.program, manifest };
}

export type Engine = "vm" | "hir" | "wasm";

// Compiles a program to an executable: spatial CFG, MIR (optimized), and back through the
// bytecode encoding, so `y3 run` executes exactly what `y3 build` would write.
function executableFor(program: CompiledProgram, manifest: Manifest, module: string): Loaded {
  const { mir, nodes } = compileToMir(program, manifest.start);
  return loadBytecode(encodeBytecode(optimizeMir(mir).mir, nodes, program, { module, maxSteps: manifest.maxSteps, start: manifest.start }));
}

export type RunV2Options = { maxSteps?: number; input?: string; trace: boolean; engine?: Engine; record?: string; replay?: string; force?: boolean; wasm?: Uint8Array };

export function runV2(filePath: string, source: string, options: RunV2Options): void {
  // Output is written as the program commits it; a trace prints the run instead.
  const host = nodeHost({ stdin: options.input, write: options.trace ? () => {} : undefined, root: dirname(resolve(filePath)) });
  // Every run has its artifact: the bytecode `y3 build` would write. Its hash is the
  // program's identity for replay (docs/v2-replay.md).
  let artifact: string;
  let execute: (run: RunOptions) => ProgramResult;
  // The WASM backend runs what the bytecode verifier accepted, compiled.
  const onWasm = (loaded: Loaded, text: string, manifest: Manifest) => {
    const { module } = loadWasmArtifact(compileWasm(loaded, text));
    return (run: RunOptions) => runWasm(module, loaded, manifest, run);
  };
  if (options.wasm) {
    if (options.engine === "hir") fatal(`${filePath} is a WebAssembly artifact: only the wasm engine runs it`);
    let found: ReturnType<typeof loadWasmArtifact>;
    try {
      found = loadWasmArtifact(options.wasm);
    } catch (error) {
      fatal(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    artifact = found.artifact;
    const manifest = { ...DEFAULT_MANIFEST, maxSteps: found.loaded.maxSteps };
    execute = (run) => runWasm(found.module, found.loaded, manifest, run);
  } else if (source.startsWith(`${BYTECODE_MAGIC} `)) {
    if (options.engine === "hir") fatal(`${filePath} is bytecode: only the VM runs it`);
    let loaded: Loaded;
    try {
      loaded = moduleOf(source);
    } catch (error) {
      fatal(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = { ...DEFAULT_MANIFEST, maxSteps: loaded.maxSteps };
    artifact = source;
    execute = options.engine === "wasm" ? onWasm(loaded, source, manifest) : (run) => runExecutable(loaded.executable, loaded.program, manifest, run);
  } else {
    const { program, manifest } = compileOrExit(filePath, source);
    if (program.space.layers.length === 0) {
      fatal(`${filePath} is a library module: it has callable planes and types but no volume to run`);
    }
    const { mir, nodes } = compileToMir(program, manifest.start);
    artifact = writeArtifact(encodeBytecode(optimizeMir(mir).mir, nodes, program, { module: manifest.name ?? basename(filePath, ".y3"), maxSteps: manifest.maxSteps, start: manifest.start }));
    if (options.engine === "hir") {
      execute = (run) => runProgram(program, manifest, run);
    } else {
      const loaded = moduleOf(artifact);
      execute = options.engine === "wasm" ? onWasm(loaded, artifact, manifest) : (run) => runExecutable(loaded.executable, loaded.program, manifest, run);
    }
  }
  let replay: Replay | undefined;
  if (options.replay) {
    try {
      replay = readReplay(readFileSync(options.replay, "utf8"), artifact, { force: options.force });
    } catch (error) {
      if (error instanceof ReplayError) fatal(`${options.replay}: ${error.message}`);
      throw error;
    }
  }
  let result: ProgramResult;
  try {
    result = execute({ maxSteps: options.maxSteps, host, replay: replay?.events });
  } catch (error) {
    if (error instanceof ReplayDivergence) fatal(`${options.replay}: ${error.message}`);
    throw error;
  }
  if (options.record) writeFileSync(options.record, writeReplay(artifact, result.events, host.capabilities));
  if (options.trace) {
    process.stdout.write(formatProgramTrace(result));
  } else if (result.outcome.status !== "HALT") {
    console.error(describeProgramOutcome(result.outcome));
  }
  process.exitCode = PROGRAM_EXIT_CODES[result.outcome.status];
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

// Every .y3 file under a directory, skipping caches and dependencies.
function findSources(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((e) => !e.startsWith(".") && e !== "node_modules")
    .sort()
    .flatMap((e) => {
      const full = join(path, e);
      return statSync(full).isDirectory() ? findSources(full) : e.endsWith(".y3") ? [full] : [];
    });
}

export function registerV2Commands(cli: Command): void {
  cli
    .command("build")
    .description("compile a program to a portable bytecode artifact (.y3b), or to WebAssembly (.wasm)")
    .argument("<file>", "path to a .y3 document")
    .option("-o, --out <file>", "output file (default: the file name with .y3b or .wasm)")
    .option("--target <target>", "y3bc (default) or wasm", "y3bc")
    .action((filePath: string, options: { out?: string; target: string }) => {
      if (options.target !== "y3bc" && options.target !== "wasm") fatal(`unknown target '${options.target}': use y3bc or wasm`);
      const { program, manifest } = compileOrExit(filePath);
      if (program.space.layers.length === 0) fatal(`${filePath} is a library module: it has no volume to build into a program`);
      const { mir, nodes } = compileToMir(program, manifest.start);
      const module = encodeBytecode(optimizeMir(mir).mir, nodes, program, { module: manifest.name ?? basename(filePath, ".y3"), maxSteps: manifest.maxSteps, start: manifest.start });
      const loaded = loadBytecode(module); // never write what the VM would refuse
      const out = options.out ?? join(dirname(filePath), `${basename(filePath, ".y3")}.${options.target === "wasm" ? "wasm" : "y3b"}`);
      writeFileSync(out, options.target === "wasm" ? compileWasm(loaded, writeArtifact(module)) : writeArtifact(module));
      console.log(`built ${out}`);
    });

  for (const [name, description] of [
    ["cfg", "print a program's spatial control-flow graph"],
    ["mir", "print a program's MIR (add --optimized for what the VM runs)"],
    ["bytecode", "print a program's bytecode artifact"],
  ] as const) {
    cli
      .command(name)
      .description(description)
      .argument("<file>", "path to a .y3 document")
      .option("--optimized", "after optimization")
      .action((filePath: string, options: { optimized?: boolean }) => {
        const { program, manifest } = compileOrExit(filePath);
        const { cfg, mir, nodes } = compileToMir(program, manifest.start);
        const shown = options.optimized || name === "bytecode" ? optimizeMir(mir).mir : mir;
        if (name === "cfg") process.stdout.write(formatCfg(cfg));
        else if (name === "mir") process.stdout.write(formatMir(shown, (n) => (nodes[n.id]?.sentence ? `[${nodes[n.id]?.sentence}]` : "[ ]")));
        else process.stdout.write(writeArtifact(encodeBytecode(shown, nodes, program, { module: manifest.name ?? basename(filePath, ".y3"), maxSteps: manifest.maxSteps, start: manifest.start })));
      });
  }

  cli
    .command("test")
    .description("run every program with a [test] table in its manifest and check its output and outcome")
    .argument("[paths...]", "files or directories (default: .)")
    .option("--engine <engine>", "vm (default) or hir", "vm")
    .action((paths: string[], options: { engine: string }) => {
      const files = (paths.length ? paths : ["."]).flatMap(findSources);
      let passed = 0;
      let failed = 0;
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        const loaded = loadDocument(source);
        const test = loaded.manifest?.test;
        if (!test) continue;
        const { program, manifest } = compileOrExit(file, source);
        const host = nodeHost({ stdin: test.stdin, write: () => {}, root: dirname(resolve(file)) });
        const result =
          options.engine === "hir" ? runProgram(program, manifest, { host }) : (() => {
            const l = executableFor(program, manifest, manifest.name ?? basename(file, ".y3"));
            return runExecutable(l.executable, l.program, manifest, { host });
          })();
        const problems: string[] = [];
        if (result.outcome.status !== test.status) problems.push(`outcome ${result.outcome.status}, expected ${test.status}`);
        if (test.output && JSON.stringify(result.output) !== JSON.stringify(test.output)) problems.push(`output ${JSON.stringify(result.output)}, expected ${JSON.stringify(test.output)}`);
        if (problems.length === 0) {
          passed += 1;
          console.log(`ok   ${file}`);
        } else {
          failed += 1;
          console.log(`FAIL ${file}: ${problems.join("; ")}`);
        }
      }
      console.log(`${passed} passed, ${failed} failed`);
      if (failed > 0) process.exitCode = 1;
    });

  cli
    .command("doc")
    .description("print a module's documentation: types, callable planes, named planes, doc comments")
    .argument("[file]", "path to a .y3 document")
    .option("--json", "machine-readable output")
    .option("--std", "the standard library instead")
    .action((filePath: string | undefined, options: { json?: boolean; std?: boolean }) => {
      if (options.std || !filePath) {
        const entries = documentStandardLibrary();
        process.stdout.write(options.json ? `${JSON.stringify(entries, null, 2)}\n` : `${entries.map((e) => `${e.namespace} ${e.name}  ${e.signature}  (${e.id}, ${e.kind})`).join("\n")}\n`);
        return;
      }
      const { ast } = loadOrExit(filePath);
      const model = documentModule(ast, basename(filePath, ".y3"));
      process.stdout.write(options.json ? `${JSON.stringify(model, null, 2)}\n` : formatDoc(model));
    });

  cli
    .command("lock")
    .description("resolve git imports to revisions and write y3.lock")
    .argument("<file>", "path to a .y3 document")
    .action((filePath: string) => {
      const packages = modulesFor(filePath, "update");
      compileOrExit(filePath, undefined, packages.resolve);
      writeLock(dirname(resolve(filePath)), packages.lock());
      console.log(`locked ${packages.lock().packages.length} package(s)`);
    });

  cli
    .command("check")
    .description("check a v2 document: structure, manifest, every sentence, and types")
    .argument("<file>", "path to a .y3 document")
    .action((filePath: string) => {
      const { program } = compileOrExit(filePath);
      const layers = program.space.layers;
      const sizes = layers.map((layer) => `${layer.plane.width}×${layer.plane.height}`).join(", ");
      const callables = program.procedures.size === 0 ? "" : `, ${program.procedures.size} callable plane(s)`;
      console.log(layers.length === 0 ? `ok: library module${callables}` : `ok: ${layers.length} layer(s) [${sizes}]${callables}`);
    });

  cli
    .command("ir")
    .description("print a v2 program's typed IR: one statement per cell, with its types and source position")
    .argument("<file>", "path to a .y3 document")
    .action((filePath: string) => {
      const { program } = compileOrExit(filePath);
      process.stdout.write(formatCompiledIr(program));
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
