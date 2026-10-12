import type { CellIds, ProgramRevision } from "../ir/identity";
import type { Coordinate, Pose } from "../space/manifest";
import type { Orientation } from "../space/orientation";
import type { ProgramResult, ProgramTraceEntry } from "../runtime/core";
import type { HostEvent } from "../ir/callables";
import { showValue } from "../semantics/values";

// Structured runtime events for an editor (docs/v2-source-mapping.md § events). They are
// a view of a run's trace, effects and host events, each tied to the authored cell that
// produced it: no editor ever parses a trace string. This layer adds no semantics: every
// event is one the runtime already reported.

export type EventPlace = {
  readonly revision: ProgramRevision; // the build the run came from
  readonly step: number;
  readonly frame: string | null;
  readonly at: Coordinate;
  readonly ids: CellIds | null; // null when the program was not built by an editor model
};

export type SpatialEvent = EventPlace & { readonly kind: "spatial" } & (
    | { readonly type: "EnterCell"; readonly orientation: Orientation }
    | { readonly type: "LeaveCell"; readonly next: Pose }
    | { readonly type: "Move" | "Turn" | "Face" | "FloorTransition" | "Jump"; readonly next: Pose }
  );
export type ValueEvent = EventPlace & { readonly kind: "value" } & (
    | { readonly type: "Define"; readonly noun: string; readonly symbol: string } // a temporal unknown
    | { readonly type: "Assign"; readonly noun: string; readonly value: string; readonly symbolic: boolean }
    | { readonly type: "Read"; readonly noun: string; readonly version: number }
    | { readonly type: "Resolve"; readonly symbol: string; readonly value: string }
  );
export type CallEvent = EventPlace & { readonly kind: "call"; readonly type: "Call" | "Return"; readonly callee: string; readonly values: readonly string[] };
export type TemporalEvent = EventPlace & { readonly kind: "temporal" } & (
    | { readonly type: "Constraint"; readonly equation: string; readonly source: string }
    | { readonly type: "Promise"; readonly noun: string; readonly term: string; readonly due: string }
    | { readonly type: "Receive"; readonly noun: string; readonly symbol: string }
    | { readonly type: "Send"; readonly sent: string; readonly openedAt: number }
    | { readonly type: "RetroResolve"; readonly symbol: string; readonly value: string; readonly fills: readonly number[] }
    | { readonly type: "SelfCaused"; readonly symbol: string; readonly value: string; readonly loop: string }
    | { readonly type: "Paradox"; readonly reason: string }
    | { readonly type: "Unresolved"; readonly symbols: readonly string[] }
  );
export type IOEvent = EventPlace & {
  readonly kind: "io";
  readonly type: "Stdout" | "Stdin" | "FileRead" | "FileWrite" | "Clock" | "ForeignCall" | "Effect";
  readonly source: string;
  readonly resource: string | null;
  readonly args: readonly string[];
  readonly value: string; // debug text (file contents redacted)
};
export type DiagnosticEvent = EventPlace & { readonly kind: "diagnostic"; readonly status: string; readonly message: string | null };

export type RuntimeEvent = SpatialEvent | ValueEvent | CallEvent | TemporalEvent | IOEvent | DiagnosticEvent;

const IO_TYPE = (e: HostEvent): IOEvent["type"] => {
  if (e.kind === "output") return "Stdout";
  if (e.kind === "foreign") return "ForeignCall";
  if (e.source.startsWith("std.io.")) return "Stdin";
  if (e.source.startsWith("std.clock.")) return "Clock";
  if (e.source.startsWith("std.fs.")) return e.kind === "effect" ? "FileWrite" : "FileRead";
  return "Effect";
};

type Motion = "Move" | "Turn" | "Face" | "FloorTransition" | "Jump";
const SPATIAL: Record<string, Motion | null> = { nop: null, turn: "Turn", face: "Face", step: "Move", floor: "FloorTransition", jump: "Jump", call: null, return: null, end: null };

// Every event of a run, in order.
export function runEvents(revision: ProgramRevision, result: ProgramResult): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const byStep = new Map<number, ProgramTraceEntry>(result.trace.map((t) => [t.step, t]));
  const place = (t: ProgramTraceEntry): EventPlace => ({ revision, step: t.step, frame: t.frame, at: t.at, ids: t.ids ?? null });
  const reads = new Map<number, { noun: string; version: number }[]>();
  for (const v of result.versions) for (const step of v.uses) reads.set(step, [...(reads.get(step) ?? []), { noun: v.noun, version: v.index }]);
  const host = new Map<number, HostEvent[]>();
  for (const e of result.events) host.set(e.step, [...(host.get(e.step) ?? []), e]);
  for (const t of result.trace) {
    const p = place(t);
    out.push({ ...p, kind: "spatial", type: "EnterCell", orientation: t.orientation });
    for (const r of reads.get(t.step) ?? []) out.push({ ...p, kind: "value", type: "Read", noun: r.noun, version: r.version });
    for (const e of t.effects) {
      switch (e.kind) {
        case "set":
          out.push({ ...p, kind: "value", type: "Assign", noun: e.name, value: showValue(e.value), symbolic: false });
          break;
        case "bind":
          out.push({ ...p, kind: "value", type: "Assign", noun: e.name, value: e.term, symbolic: true });
          break;
        case "declare":
          out.push({ ...p, kind: "value", type: "Define", noun: e.name, symbol: e.symbol });
          break;
        case "call":
          out.push({ ...p, kind: "call", type: "Call", callee: e.frame, values: e.args });
          break;
        case "return":
          out.push({ ...p, kind: "call", type: "Return", callee: e.frame, values: e.values });
          break;
        case "constrain":
          out.push({ ...p, kind: "temporal", type: "Constraint", equation: e.equation, source: e.source });
          break;
        case "promise":
          out.push({ ...p, kind: "temporal", type: "Promise", noun: e.name, term: e.term, due: e.due });
          break;
        case "open":
          out.push({ ...p, kind: "temporal", type: "Receive", noun: e.name, symbol: e.symbol });
          break;
        case "close":
          out.push({ ...p, kind: "temporal", type: "Send", sent: e.sent, openedAt: e.openedAt });
          break;
        case "resolve": {
          const value = showValue(e.value);
          out.push({ ...p, kind: "value", type: "Resolve", symbol: e.symbol, value });
          if (e.selfLoop) out.push({ ...p, kind: "temporal", type: "SelfCaused", symbol: e.symbol, value, loop: e.selfLoop });
          else if (e.fills.some((s) => s < t.step)) out.push({ ...p, kind: "temporal", type: "RetroResolve", symbol: e.symbol, value, fills: e.fills });
          break;
        }
        case "contradiction":
          out.push({ ...p, kind: "temporal", type: "Paradox", reason: e.reason });
          break;
        case "unresolved":
          out.push({ ...p, kind: "temporal", type: "Unresolved", symbols: e.symbols });
          break;
        default:
          break; // tests, anchors, holds and flushes are visible in the trace itself
      }
    }
    for (const h of host.get(t.step) ?? []) out.push({ ...p, kind: "io", type: IO_TYPE(h), source: h.source, resource: h.resource, args: h.args, value: h.value });
    const move = SPATIAL[t.instruction.op];
    if (move) out.push({ ...p, kind: "spatial", type: move, next: t.next });
    out.push({ ...p, kind: "spatial", type: "LeaveCell", next: t.next });
  }
  // Output committed after the last step (held writes written as "?").
  const last = result.trace[result.trace.length - 1];
  for (const [step, hs] of host) {
    if (byStep.has(step)) continue;
    const t = last;
    for (const h of hs) out.push({ revision, step, frame: t?.frame ?? null, at: t?.at ?? { x: 0, y: 0, z: 0 }, ids: t?.ids ?? null, kind: "io", type: IO_TYPE(h), source: h.source, resource: h.resource, args: h.args, value: h.value });
  }
  const o = result.outcome;
  out.push({ revision, step: o.steps, frame: last?.frame ?? null, at: ("at" in o ? (o.at as Coordinate) : null) ?? last?.at ?? { x: 0, y: 0, z: 0 }, ids: last?.ids ?? null, kind: "diagnostic", status: o.status, message: "message" in o ? (o.message as string) : null });
  return out;
}
