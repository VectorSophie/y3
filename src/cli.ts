#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { Y3ParseError, Y3RuntimeError, formatTraceEntry, parseProgram, runProgram, runProgramWithTrace } from "./core";

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
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

cli.name("y3").description("YI3ANG v0 tooling").version("0.1.0");

cli
  .command("validate")
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
  .argument("<file>", "Path to .y3 file")
  .action((filePath: string) => {
    try {
      const program = parseProgram(readSource(filePath));
      const finalState = runProgram(program);
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
  .argument("<file>", "Path to .y3 file")
  .action((filePath: string) => {
    try {
      const program = parseProgram(readSource(filePath));
      const result = runProgramWithTrace(program);
      for (const entry of result.trace) {
        console.log(formatTraceEntry(entry));
        console.log("");
      }
      console.log(`# halted after ${result.finalState.stepCount} steps`);
    } catch (error) {
      printError(error);
    }
  });

cli.parse();
