#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  Y3ParseError,
  Y3RuntimeError,
  createInitialState,
  formatTraceEntry,
  parseProgram,
  runProgram,
  runProgramWithTrace,
} from "./v1/core";
import { registerV2Commands, runV2 } from "./cli/v2-commands";
import { looksLikeV2 } from "./container/document";

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function parseInputValues(rawInput: string | undefined): number[] {
  if (!rawInput) {
    return [];
  }

  return rawInput
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      if (!/^-?\d+$/.test(token)) {
        throw new Error(`Invalid input token '${token}'. Only integers are allowed.`);
      }
      return Number(token);
    });
}

function parseMaxSteps(rawSteps: string | undefined): number | undefined {
  if (!rawSteps) {
    return undefined;
  }

  if (!/^\d+$/.test(rawSteps)) {
    throw new Error(`Invalid --max-steps value '${rawSteps}'. Expected non-negative integer.`);
  }

  return Number(rawSteps);
}

function printError(error: unknown): never {
  if (error instanceof Y3ParseError) {
    console.error(`ParseError(line=${error.line})`);
    console.error(`text: ${error.text}`);
    console.error(`reason: ${error.explanation}`);
    process.exit(1);
  }

  if (error instanceof Y3RuntimeError) {
    console.error(`RuntimeError: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(error.message);
    process.exit(1);
  }

  console.error("Unknown error");
  process.exit(1);
}

function engineOf(name: string): "vm" | "hir" {
  if (name !== "vm" && name !== "hir") throw new Error(`unknown engine '${name}': use vm or hir`);
  return name;
}

const cli = new Command();

cli.name("y3").description("YI3ANG tooling: v2 document commands (check, ir, fmt, unpack, pack) and the v1 interpreter (validate, run, trace)").version("0.1.0");

cli
  .command("validate")
  .description("v1: validate a v1 program")
  .argument("<file>", "Path to .y3 file")
  .action((filePath: string) => {
    try {
      const program = parseProgram(readSource(filePath));
      console.log(`valid (cells=${program.cells.size})`);
    } catch (error) {
      printError(error);
    }
  });

cli
  .command("run")
  .description("run a program (v2 documents with planes, or v1 programs)")
  .argument("<file>", "Path to .y3 file")
  .option("-i, --input <values>", "Space/comma separated integer input values")
  .option("--max-steps <count>", "Execution step limit (default: 10000)")
  .option("--engine <engine>", "v2: vm (bytecode VM, default) or hir (the reference interpreter)", "vm")
  .option("--record <file>", "v2: record the run's effects to a replay file (Y3REPLAY)")
  .option("--replay <file>", "v2: replay a recorded run: effects return their recorded results")
  .option("--force", "v2: replay a recording made for a different program")
  .action((filePath: string, options: { input?: string; maxSteps?: string; engine: string; record?: string; replay?: string; force?: boolean }) => {
    try {
      const source = readSource(filePath);
      if (looksLikeV2(source) || source.startsWith("Y3BC ")) {
        if (options.record && options.replay) throw new Error("--record and --replay cannot be used together");
        runV2(filePath, source, { maxSteps: parseMaxSteps(options.maxSteps), input: options.input, trace: false, engine: engineOf(options.engine), record: options.record, replay: options.replay, force: options.force });
        return;
      }
      const program = parseProgram(source);
      const initialState = createInitialState({ input: parseInputValues(options.input) });
      const finalState = runProgram(program, initialState, { maxSteps: parseMaxSteps(options.maxSteps) });
      process.stdout.write(finalState.output);
      if (!finalState.output.endsWith("\n")) {
        process.stdout.write("\n");
      }
    } catch (error) {
      printError(error);
    }
  });

cli
  .command("trace")
  .description("trace a program step by step (v2 documents with planes, or v1 programs)")
  .argument("<file>", "Path to .y3 file")
  .option("-i, --input <values>", "Space/comma separated integer input values")
  .option("--max-steps <count>", "Execution step limit (default: 10000)")
  .option("--engine <engine>", "v2: vm (bytecode VM, default) or hir (the reference interpreter)", "vm")
  .action((filePath: string, options: { input?: string; maxSteps?: string; engine: string }) => {
    try {
      const source = readSource(filePath);
      if (looksLikeV2(source) || source.startsWith("Y3BC ")) {
        runV2(filePath, source, { maxSteps: parseMaxSteps(options.maxSteps), input: options.input, trace: true, engine: engineOf(options.engine) });
        return;
      }
      const program = parseProgram(source);
      const initialState = createInitialState({ input: parseInputValues(options.input) });
      const result = runProgramWithTrace(program, initialState, { maxSteps: parseMaxSteps(options.maxSteps) });
      for (const entry of result.trace) {
        console.log(formatTraceEntry(entry));
        console.log("");
      }
      console.log(`# halted after ${result.finalState.stepCount} steps`);
    } catch (error) {
      printError(error);
    }
  });

registerV2Commands(cli);

cli.parse();
