import type { ConcreteValue } from "../semantics/operations";
import { LinearSystem } from "./solver";
import { combine, formatTerm, substitute, symbol, symbolsOf, toLinear, TermError, type SymbolicTerm, type SymbolId } from "./terms";

// The temporal store: symbols, the constraints on them, and what has been determined.
// A symbol moves through   declared → constrained → resolved   (or stays open).
// It is resolved only when the equations admit exactly one value; nothing here ever
// picks one of several possibilities.

export type SymbolState = "declared" | "constrained" | "resolved";

// Where a symbol came from: 미정 (declared), a channel from later (다음), or a value read
// from the end of the iteration (끝의 N).
export type SymbolOrigin = "미정" | "다음" | "끝";
const PREFIX: Readonly<Record<SymbolOrigin, string>> = { 미정: "α", 다음: "β", 끝: "ε" };

export type SymbolInfo = {
  readonly id: SymbolId;
  readonly label: string; // α1 (미정), β2 (channel), ε3 (끝의 N)
  readonly noun: string; // the noun that declared it
  readonly origin: SymbolOrigin;
  // Set when a cycle closed back onto this symbol with no external cause (see
  // carriesCause), naming the edge that closed it. A resolved self-loop is self-caused.
  selfLoop: string | null;
  readonly born: number; // step
  sort: "unknown" | "int" | "text"; // fixed by arithmetic or by an equation; says nothing about the value
  constrained: boolean; // some equation has mentioned it
  value: ConcreteValue | null;
  resolvedAt: number | null;
  retroactive: boolean;
  readonly uses: Set<number>; // steps (after birth) whose effects depended on it
};

export type Resolution = {
  readonly symbol: SymbolInfo;
  readonly value: ConcreteValue;
  readonly retroactive: boolean; // earlier steps already depended on this symbol
  readonly fills: readonly number[]; // those steps
};

export type EquateResult = { kind: "consistent"; resolutions: Resolution[] } | { kind: "contradiction"; reason: string };

export class TemporalStore {
  private readonly symbols: SymbolInfo[] = [];
  private readonly system = new LinearSystem();

  declare(noun: string, step: number, origin: SymbolOrigin = "미정"): SymbolicTerm {
    const id = this.symbols.length + 1;
    this.symbols.push({
      id,
      label: `${PREFIX[origin]}${id}`,
      noun,
      origin,
      selfLoop: null,
      born: step,
      sort: "unknown",
      constrained: false,
      value: null,
      resolvedAt: null,
      retroactive: false,
      uses: new Set(),
    });
    return symbol(id);
  }

  info(id: SymbolId): SymbolInfo {
    const found = this.symbols[id - 1];
    if (!found) throw new Error(`unknown symbol ${id}`);
    return found;
  }

  all(): readonly SymbolInfo[] {
    return this.symbols;
  }

  state(id: SymbolId): SymbolState {
    const info = this.info(id);
    if (info.value) return "resolved";
    return info.constrained ? "constrained" : "declared";
  }

  format(term: SymbolicTerm): string {
    return formatTerm(term, (id) => this.info(id).label);
  }

  // Records that a step's result depended on these symbols (copied, computed, printed).
  noteUse(term: SymbolicTerm, step: number): void {
    for (const id of symbolsOf(term)) {
      const info = this.info(id);
      if (!info.value && step !== info.born) info.uses.add(step);
    }
  }

  // The term with every determined symbol replaced by its value.
  current(term: SymbolicTerm): SymbolicTerm {
    return substitute(term, (id) => this.info(id).value);
  }

  // A concrete value, if the term is fully determined.
  resolve(term: SymbolicTerm): ConcreteValue | null {
    const now = this.current(term);
    return now.kind === "literal" ? now.value : null;
  }

  // Undetermined symbols a term still depends on.
  pending(term: SymbolicTerm): SymbolInfo[] {
    return symbolsOf(this.current(term)).map((id) => this.info(id));
  }

  arithmetic(a: SymbolicTerm, b: SymbolicTerm, sign: 1n | -1n): SymbolicTerm {
    for (const id of [...symbolsOf(a), ...symbolsOf(b)]) {
      const info = this.info(id);
      if (info.sort === "text") throw new TermError(`${info.label} is text and cannot take part in arithmetic`);
      info.sort = "int";
    }
    return combine(this.current(a), this.current(b), sign);
  }

  // Adds the constraint a = b, made at `step`.
  equate(a: SymbolicTerm, b: SymbolicTerm, step: number): EquateResult {
    for (const id of [...symbolsOf(a), ...symbolsOf(b)]) this.info(id).constrained = true;
    const left = this.current(a);
    const right = this.current(b);

    if (left.kind === "literal" && right.kind === "literal") {
      const same = left.value.kind === right.value.kind && left.value.value === right.value.value;
      return same
        ? { kind: "consistent", resolutions: [] }
        : { kind: "contradiction", reason: `${this.format(left)} ≠ ${this.format(right)}` };
    }

    const text = [left, right].find((t) => t.kind === "literal" && t.value.kind === "text");
    if (text) {
      const other = text === left ? right : left;
      if (other.kind !== "symbol") {
        return { kind: "contradiction", reason: `${this.format(other)} is a number and cannot equal ${this.format(text)}` };
      }
      const info = this.info(other.id);
      if (info.sort === "int" || this.system.constrained().has(info.id)) {
        return { kind: "contradiction", reason: `${info.label} is a number and cannot equal ${this.format(text)}` };
      }
      info.sort = "text";
      return { kind: "consistent", resolutions: [this.settle(info, text.kind === "literal" ? text.value : { kind: "text", value: "" }, step)] };
    }

    // An identity (β = β) holds for any value of any sort; it constrains nothing.
    const identical = JSON.stringify(left, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v)) ===
      JSON.stringify(right, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v));
    if (identical) {
      return { kind: "consistent", resolutions: [] };
    }

    const ids = [...symbolsOf(left), ...symbolsOf(right)];
    for (const id of ids) {
      const info = this.info(id);
      if (info.sort === "text") {
        return { kind: "contradiction", reason: `${info.label} is text and cannot satisfy a numeric equation` };
      }
    }
    const difference = toLinear(combine(left, right, -1n));
    if (!difference) throw new Error("numeric terms expected");
    const result = this.system.add(difference);
    if (result.kind === "contradiction") {
      return {
        kind: "contradiction",
        reason: `${this.format(left)} = ${this.format(right)} has ${result.reason}`,
      };
    }
    for (const id of ids) this.info(id).sort = "int";
    const resolutions = [...result.resolved].map(([id, value]) => this.settle(this.info(id), { kind: "int", value }, step));
    return { kind: "consistent", resolutions };
  }

  private settle(info: SymbolInfo, value: ConcreteValue, step: number): Resolution {
    info.value = value;
    info.resolvedAt = step;
    const fills = [...info.uses].filter((use) => use < step).sort((x, y) => x - y);
    info.retroactive = fills.length > 0;
    return { symbol: info, value, retroactive: info.retroactive, fills };
  }
}
