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
import { registerV2Commands } from "./cli/v2-commands";

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

const cli = new Command();

cli.name("y3").description("YI3ANG tooling: v2 document commands (check, fmt, unpack, pack) and the v1 interpreter (validate, run, trace)").version("0.1.0");

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
  .description("v1: run a v1 program")
  .argument("<file>", "Path to .y3 file")
  .option("-i, --input <values>", "Space/comma separated integer input values")
  .option("--max-steps <count>", "Execution step limit (default: 10000)")
  .action((filePath: string, options: { input?: string; maxSteps?: string }) => {
    try {
      const program = parseProgram(readSource(filePath));
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
  .description("v1: trace a v1 program")
  .argument("<file>", "Path to .y3 file")
  .option("-i, --input <values>", "Space/comma separated integer input values")
  .option("--max-steps <count>", "Execution step limit (default: 10000)")
  .action((filePath: string, options: { input?: string; maxSteps?: string }) => {
    try {
      const program = parseProgram(readSource(filePath));
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
