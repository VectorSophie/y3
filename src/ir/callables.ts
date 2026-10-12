import type { ConcreteValue } from "../semantics/values";
import type { Kind, Type } from "../types/types";
import type { Capability, Host } from "../stdlib/host";
import type { Payload } from "../runtime/payload";
import { STANDARD_LIBRARY } from "../stdlib/index";
import type { CallableId } from "./hir";

// Built-in callables, reached through the colon-call syntax `[이름공간 이름: 인자, …]`.
// They go through the same stages as a user's callable plane: name resolution,
// signature instantiation, type checking, execution. Each has a stable internal id
// (std.io.println) and a Korean source spelling (표준 줄출력).
//
// Three kinds:
// - pure: a function of concrete values (and their types, which checked arithmetic needs);
// - output: stdout (print, println), the one effect whose argument may still be
//   symbolic; the runtime holds the write until the value is known;
// - effect: everything else outside the program (stdin, files, clocks). It needs
//   concrete arguments, runs through the Host, and commits when it runs.

// A built-in's type parameters may be bounded: to a kind of number, or to key types.
// `rest`: further arguments after `params`, all of type T ("same") or of any types ("any").
export type Signature = {
  readonly typeParams: readonly string[];
  readonly bounds?: Readonly<Record<string, Kind | "key">>;
  readonly params: readonly Type[];
  readonly rest?: "same" | "any";
  readonly result: Type;
};

// The resolved types of one call: what checked arithmetic and conversions need.
export type CallTypes = { readonly args: readonly Type[]; readonly result: Type };

// One committed external effect: what crossed the boundary, in the order it crossed.
//   step, at, frame   where it happened: the step, the cell, the activation
//   source            the callable's id (std.fs.write, std.io.readLine, a foreign id), or
//                     std.io.stdout for a committed write
//   kind              output, input (stdin, clock, file reads), effect (file writes and
//                     the rest), foreign
//   args              the arguments, as debug text
//   value             the result, as debug text (file contents are redacted)
//   payload           the result itself, for replay (debug text is never replayed)
export type HostEvent = {
  readonly step: number;
  readonly at: { readonly x: number; readonly y: number; readonly z: number };
  readonly frame: string | null;
  readonly source: string;
  readonly kind: "output" | "input" | "effect" | "foreign";
  readonly args: readonly string[];
  readonly value: string;
  readonly payload: Payload;
};

export type EffectContext = {
  readonly host: Host;
  readonly files: Map<number, { readonly path: string; open: boolean }>;
};

export type CallableBody =
  | { readonly kind: "pure"; readonly apply: (args: readonly ConcreteValue[], types: CallTypes) => ConcreteValue }
  | { readonly kind: "output"; readonly newline: boolean }
  | {
      readonly kind: "effect";
      readonly perform: (args: readonly ConcreteValue[], ctx: EffectContext, types: CallTypes) => ConcreteValue;
      readonly capability: Capability; // what the host must provide
      readonly denied?: () => ConcreteValue; // the ordinary error when it does not (else FAULT)
      readonly redact?: boolean; // keep the result out of the event's debug text (file contents)
    };

export type Callable = {
  readonly id: CallableId;
  readonly namespace: string; // as written in source
  readonly name: string;
  readonly signature: Signature;
} & CallableBody;

export const CALLABLES: readonly Callable[] = STANDARD_LIBRARY;

export const PRINTLN: CallableId = "std.io.println";

const byId = new Map(CALLABLES.map((callable) => [callable.id, callable]));

export function callable(id: CallableId): Callable {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown callable ${id}`);
  return found;
}

export type CallableResolution = { kind: "found"; callable: Callable } | { kind: "no-namespace"; known: string[] } | { kind: "no-name"; known: string[] };

// Resolves `namespace name` as written.
export function resolveCallable(namespace: string, name: string): CallableResolution {
  const inNamespace = CALLABLES.filter((c) => c.namespace === namespace);
  if (inNamespace.length === 0) return { kind: "no-namespace", known: [...new Set(CALLABLES.map((c) => c.namespace))] };
  const found = inNamespace.find((c) => c.name === name);
  return found ? { kind: "found", callable: found } : { kind: "no-name", known: inNamespace.map((c) => c.name) };
}
