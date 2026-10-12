import type { CallAst, CallReading, ExprAst, MatchAst, PatternAst, PlaceAst, SentenceAst } from "../language/sentence-ast";
import { PRINTLN, resolveCallable } from "../ir/callables";
import { childExprs, type Expr, type Noun, type NounId, type Pattern, type PlaneId, type Provenance, type Stmt } from "../ir/hir";
import { bool, float, int, rune, text } from "./values";
import { BUILTIN_TYPE_DEFS, type Type } from "../types/types";

// Sentence AST → HIR. Resolves nouns to ids and names to what they name (a callable
// plane, a built-in callable, a constructor, a local bound by a pattern), and spells
// every surface form as a language-neutral node: 더한다 is a store of an Add, 말한다 is
// a call to the same output callable as [표준 줄출력: …], 이 아니면 is Not(Eq), 위치의
// 가로는 3이다 is a store of a SetField. Types are left open here (PENDING) and filled in
// by the type checker.

export const PENDING: Type = { kind: "var", id: 0 };

export class ElaborationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const ELABORATION_CODES = {
  UNKNOWN_CALLABLE: "Y3Y002",
  UNKNOWN_NAME: "Y3Y006",
  MULTIPLE_RESULTS: "Y3C003",
  AMBIGUOUS_CALL: "Y3C011",
} as const;

// A warning found while elaborating: the statement is still well formed.
export type ElaborationWarning = { readonly code: string; readonly message: string };

// The nouns of one body (the main volume or a callable plane). Ids are unique across
// the program, so two bodies' 값 are two different nouns.
export class NounTable {
  private readonly byName = new Map<string, Noun>();

  constructor(private readonly ids: { next: number } = { next: 1 }) {}

  id(name: string): NounId {
    const known = this.byName.get(name);
    if (known) return known.id;
    const noun: Noun = { id: this.ids.next, name, type: PENDING };
    this.ids.next += 1;
    this.byName.set(name, noun);
    return noun.id;
  }

  all(): Noun[] {
    return [...this.byName.values()];
  }
}

// A constructor: a variant of a sum type, or a record type (variant null).
// A record constructor also knows its field names, for construction by name.
export type Constructor = { readonly typeName: string; readonly variant: string | null; readonly arity: number; readonly fields?: readonly string[] };

// What a module's code can name. Built-in names (Option, Some, 표준, 수학, 배열) are
// visible everywhere; a module's own planes, types and constructors are visible
// unqualified in that module; an imported module's are reached through its alias.
export type ModuleScope = {
  readonly key: string; // "main" for the program itself
  readonly planes: ReadonlyMap<string, PlaneId>;
  readonly constructors: ReadonlyMap<string, Constructor>;
  readonly imports: ReadonlyMap<string, ModuleScope>;
  readonly foreign: ReadonlyMap<string, ReadonlyMap<string, string>>; // library alias → name → foreign id
};

// Every constructor of the built-in sum and record types (Some, Ok, NotFound, FileInfo, …).
export const BUILTIN_CONSTRUCTORS: ReadonlyMap<string, Constructor> = new Map(
  BUILTIN_TYPE_DEFS.flatMap((def): [string, Constructor][] =>
    def.kind === "sum"
      ? def.variants.map((v) => [v.name, { typeName: def.name, variant: v.name, arity: v.fields.length }])
      : def.kind === "product"
        ? [[def.name, { typeName: def.name, variant: null, arity: def.fields.length, fields: def.fields.map((f) => f.name) }]]
        : [],
  ),
);

// 배열 (arrays): [xs는 배열: 1, 2, 3], [n은 배열 길이: xs], [ys는 배열 자르기: xs, 1, 3].
export const ARRAY_NAMESPACE = "배열";

export function constructorIn(scope: ModuleScope, name: string): Constructor | null {
  return scope.constructors.get(name) ?? BUILTIN_CONSTRUCTORS.get(name) ?? null;
}

export function elaborate(
  sentence: SentenceAst,
  at: Provenance,
  nouns: NounTable,
  scope: ModuleScope,
  warn: (warning: ElaborationWarning) => void = () => {},
): Stmt {
  const node = <T extends object>(fields: T) => ({ ...fields, at }) as unknown as Stmt;
  const typed = <T extends object>(fields: T): Expr => ({ ...fields, type: PENDING, at }) as unknown as Expr;
  const unknown = (message: string): never => {
    throw new ElaborationError(ELABORATION_CODES.UNKNOWN_NAME, message);
  };

  const construct = (ctor: Constructor, args: Expr[]) => typed({ node: "Construct", typeName: ctor.typeName, variant: ctor.variant, args });

  // Arguments in declaration order. Named arguments ([점: 세로=4, 가로=3]) are matched to
  // the record's fields by name: every field once, no others, in any order.
  const ordered = (ctor: Constructor, c: CallAst): Expr[] => {
    const args = c.args.map(expr);
    if (c.fields === null) return args;
    const label = ctor.variant ?? ctor.typeName;
    if (!ctor.fields) unknown(`'${label}' takes its fields in order; only a record's fields have names`);
    const fields = ctor.fields as readonly string[];
    const twice = c.fields.find((f, i) => c.fields?.indexOf(f) !== i);
    if (twice) unknown(`field '${twice}' is given twice`);
    const stray = c.fields.find((f) => !fields.includes(f));
    if (stray) unknown(`'${label}' has no field '${stray}'; it has ${fields.join(", ")}`);
    const missing = fields.filter((f) => !c.fields?.includes(f));
    if (missing.length > 0) unknown(`'${label}' needs ${missing.map((f) => `'${f}'`).join(", ")} too`);
    return fields.map((f) => args[c.fields?.indexOf(f) ?? -1] as Expr);
  };

  // A constructor's name never names a noun, so reading 'None' means the same thing
  // wherever it is written.
  const noun = (name: string): NounId => {
    if (constructorIn(scope, name)) unknown(`'${name}' is a constructor and cannot name a value`);
    return nouns.id(name);
  };

  // Locals bound by the patterns of the match arms being elaborated, innermost last.
  const locals: Set<string>[] = [];

  const expr = (e: ExprAst): Expr => {
    switch (e.kind) {
      case "int":
        if (e.suffix === "f32" || e.suffix === "f64") throw new Error("the parser makes float literals of float suffixes");
        return typed({ node: "Literal", value: int(e.value), ...(e.suffix ? { declared: e.suffix } : {}) });
      case "float":
        return typed({ node: "Literal", value: float(e.value), ...(e.suffix ? { declared: e.suffix } : {}) });
      case "rune":
        return typed({ node: "Literal", value: rune(e.value) });
      case "text":
        return typed({ node: "Literal", value: text(e.value) });
      case "bool":
        return typed({ node: "Literal", value: bool(e.value) });
      case "noun": {
        if (locals.some((frame) => frame.has(e.name))) return typed({ node: "LoadLocal", local: e.name });
        const ctor = constructorIn(scope, e.name);
        if (ctor) {
          if (ctor.arity > 0) unknown(`'${e.name}' needs its fields: write '[N은 ${e.name}: …]'`);
          return construct(ctor, []);
        }
        return typed({ node: "LoadNoun", noun: noun(e.name) });
      }
      case "anchored":
        return typed({ node: "TemporalAnchorRead", noun: noun(e.name), moment: e.anchor === "처음" ? "start" : "end" });
      case "field":
        return typed({ node: "Field", record: expr(e.target), field: e.name, index: -1 });
      case "index":
        return typed({ node: "Index", base: expr(e.target), index: expr(e.index) });
    }
  };

  // Whether a callee names something here: a callable plane, a constructor or a
  // built-in, under its namespace if it has one.
  const known = (namespace: string) =>
    namespace === ARRAY_NAMESPACE || scope.imports.has(namespace) || scope.foreign.has(namespace) || resolveCallable(namespace, "").kind !== "no-namespace";
  const resolves = ([first, second]: readonly string[]): boolean => {
    const name = first ?? "";
    if (second === undefined) return scope.planes.has(name) || constructorIn(scope, name) !== null || name === ARRAY_NAMESPACE;
    if (name === ARRAY_NAMESPACE) return second === "길이" || second === "자르기";
    const imported = scope.imports.get(name);
    if (imported) return imported.planes.has(second) || imported.constructors.has(second);
    const library = scope.foreign.get(name);
    if (library) return library.has(second);
    return resolveCallable(name, second).kind === "found";
  };
  // Which reading of a call head to take. The namespaced reading wins when it resolves.
  // When both resolve, the sentence's meaning hangs on which names exist, so say so:
  // a later import could otherwise change it silently.
  const reading = (c: CallAst): CallReading => {
    const chosen = choose(c);
    for (const issue of chosen.lint) warn({ code: issue.code, message: issue.message });
    return chosen;
  };
  const choose = (c: CallAst): CallReading => {
    const namespaced = c.readings.find((r) => r.callee.length === 2);
    const plain = c.readings.find((r) => r.callee.length === 1);
    const namespacedOk = namespaced !== undefined && resolves(namespaced.callee);
    const plainOk = plain !== undefined && resolves(plain.callee);
    if (namespaced && plain && namespacedOk && plainOk) {
      const [ns, name] = namespaced.callee;
      const receiver = plain.targets[plain.targets.length - 1] ?? "";
      warn({
        code: ELABORATION_CODES.AMBIGUOUS_CALL,
        message:
          `ambiguous call head '${namespaced.callee.join(" ")}': it can mean module '${ns}', callable '${name}', ` +
          `or noun '${receiver}' receiving callable '${plain.callee[0]}'; read as the module call`,
      });
    }
    if (namespacedOk) return namespaced as CallReading;
    if (plainOk) return plain as CallReading;
    // Neither resolves: report against the reading the writer most likely meant.
    return (namespaced && known(namespaced.callee[0] ?? "") ? namespaced : (plain ?? namespaced)) as CallReading;
  };

  // A call that yields one value: a built-in callable, a constructor, or an array form;
  // or a callable plane, which is a statement of its own.
  const valueCall = (c: CallAst, callee: readonly string[]): Expr | { plane: PlaneId } => {
    const args = () => c.args.map(expr);
    const [first, second] = callee;
    if (second === undefined) {
      const name = first ?? "";
      const plane = scope.planes.get(name);
      if (plane) return { plane };
      const ctor = constructorIn(scope, name);
      if (ctor) return construct(ctor, ordered(ctor, c));
      if (c.fields !== null) unknown("only a record is built from named fields");
      if (name === ARRAY_NAMESPACE) return typed({ node: "ArrayLiteral", elements: args() });
      return unknown(`'${name}' is not a callable plane or a constructor here`);
    }
    const namespace = first ?? "";
    if (c.fields !== null && !scope.imports.get(namespace)?.constructors.has(second)) unknown("only a record is built from named fields");
    if (namespace === ARRAY_NAMESPACE) {
      const a = args();
      if (second === "길이" && a.length === 1) return typed({ node: "Length", base: a[0] });
      if (second === "자르기" && a.length === 3) return typed({ node: "Slice", base: a[0], from: a[1], to: a[2] });
      return unknown(`'${ARRAY_NAMESPACE}' has '길이: 배열' and '자르기: 배열, 처음, 끝'`);
    }
    const imported = scope.imports.get(namespace);
    if (imported) {
      const plane = imported.planes.get(second);
      if (plane) return { plane };
      const ctor = imported.constructors.get(second);
      if (ctor) return construct(ctor, ordered(ctor, c));
      return unknown(`module '${namespace}' has no callable plane or constructor '${second}'`);
    }
    const library = scope.foreign.get(namespace);
    if (library) {
      const id = library.get(second);
      if (!id) return unknown(`foreign library '${namespace}' has no 외부 declaration '${second}'; it has ${[...library.keys()].join(", ")}`);
      return typed({ node: "ForeignCall", foreign: id, args: args() });
    }
    const resolution = resolveCallable(namespace, second);
    if (resolution.kind === "no-namespace") {
      throw new ElaborationError(
        ELABORATION_CODES.UNKNOWN_CALLABLE,
        `unknown namespace '${namespace}'; known namespaces: ${[...resolution.known, ARRAY_NAMESPACE, ...scope.imports.keys()].join(", ")}`,
      );
    }
    if (resolution.kind === "no-name") {
      throw new ElaborationError(ELABORATION_CODES.UNKNOWN_CALLABLE, `'${namespace}' has no callable '${second}'; it has ${resolution.known.join(", ")}`);
    }
    return typed({ node: "Call", callee: resolution.callable.id, args: args() });
  };

  const pattern = (p: PatternAst, bound: Set<string>): Pattern => {
    switch (p.kind) {
      case "wildcard":
        return { kind: "wildcard" };
      case "literal":
        return {
          kind: "literal",
          value:
            p.value.kind === "int" ? int(p.value.value) : p.value.kind === "text" ? text(p.value.value) : p.value.kind === "rune" ? rune(p.value.value) : bool(p.value.value),
        };
      case "name": {
        const [first, second] = p.path;
        const ctor =
          second === undefined
            ? constructorIn(scope, first ?? "")
            : (scope.imports.get(first ?? "")?.constructors.get(second) ??
              unknown(`'${p.path.join(" ")}' is not a constructor: module '${first}' is not imported or has no such constructor`));
        if (!ctor) {
          if (p.args !== null) unknown(`'${first}' is not a constructor`);
          bound.add(first ?? "");
          return { kind: "bind", local: first ?? "" };
        }
        const fields = (p.args ?? []).map((sub) => pattern(sub, bound));
        return ctor.variant === null
          ? { kind: "record", type: ctor.typeName, fields }
          : { kind: "variant", type: ctor.typeName, variant: ctor.variant, fields };
      }
    }
  };

  const match = (m: MatchAst): Expr =>
    typed({
      node: "Match",
      scrutinee: expr(m.scrutinee),
      arms: m.arms.map((arm) => {
        const bound = new Set<string>();
        const p = pattern(arm.pattern, bound);
        locals.push(bound);
        const body = expr(arm.body);
        locals.pop();
        return { pattern: p, body };
      }),
    });

  const load = (name: string) => typed({ node: "LoadNoun", noun: noun(name) });

  // A store into a place: the noun itself, or a field or element inside it, which
  // rebuilds the noun's value around the new part.
  const store = (place: PlaceAst, value: (current: Expr) => Expr): Stmt => {
    const rebuild = (base: Expr, depth: number): Expr => {
      const s = place.steps[depth];
      if (!s) return value(base);
      if (s.kind === "field") {
        const inner = typed({ node: "Field", record: base, field: s.name, index: -1 });
        return typed({ node: "SetField", record: base, field: s.name, index: -1, value: rebuild(inner, depth + 1) });
      }
      const index = expr(s.index);
      const inner = typed({ node: "Index", base, index });
      return typed({ node: "SetIndex", base, index, value: rebuild(inner, depth + 1) });
    };
    const target = noun(place.noun);
    return node({ node: "StoreNoun", noun: target, value: place.steps.length === 0 ? value(load(place.noun)) : rebuild(load(place.noun), 0) });
  };

  const stmt = (s: SentenceAst): Stmt => {
    switch (s.kind) {
      case "assign": {
        const value = expr(s.value);
        return store(s.place, () => value);
      }
      case "call": {
        const { targets, callee } = reading(s.call);
        const call = valueCall(s.call, callee);
        if ("plane" in call) {
          return node({ node: "CallPlane", plane: call.plane, args: s.call.args.map(expr), results: targets.map((t) => noun(t)) });
        }
        if (targets.length > 1) {
          throw new ElaborationError(ELABORATION_CODES.MULTIPLE_RESULTS, `only a callable plane returns several values; '${callee.join(" ")}' returns one`);
        }
        const [target] = targets;
        return target === undefined ? node({ node: "Eval", expr: call }) : node({ node: "StoreNoun", noun: noun(target), value: call });
      }
      case "match":
        return node({ node: "StoreNoun", noun: noun(s.target), value: match(s.match) });
      case "return":
        return node({ node: "Return", values: s.values.map(expr) });
      case "declare":
        return node({ node: "TemporalDeclare", noun: noun(s.noun) });
      case "add":
      case "subtract":
      case "multiply":
      case "divide": {
        const amount = expr(s.amount);
        const op = ({ add: "Add", subtract: "Sub", multiply: "Mul", divide: "Div" } as const)[s.kind];
        return store(s.place, (current) => typed({ node: op, left: current, right: amount }));
      }
      case "say":
        return node({ node: "Eval", expr: typed({ node: "Call", callee: PRINTLN, args: [expr(s.value)] }) });
      case "receive":
        return node({ node: "TemporalReceive", noun: noun(s.noun) });
      case "send":
        return node({ node: "TemporalSend", noun: noun(s.noun) });
      case "turn":
        return node({ node: "Turn", turn: s.turn, compass: null });
      case "face":
        return node({ node: "Turn", turn: null, compass: s.compass });
      case "step":
        return node({ node: "Move", relative: s.relative });
      case "floor":
        return node({ node: "FloorMove", delta: s.delta });
      case "anchor":
        return node({ node: "Anchor" });
      case "back":
        return node({ node: "BackEdge" });
      case "end":
        return node({ node: "End" });
      case "assert":
        return node({
          node: "TemporalAssert",
          noun: noun(s.noun),
          moment: s.anchor === "처음" ? "start" : "now",
          value: expr(s.value),
        });
      case "promise":
        // 끝의 N은 E일 것이다 and N은 E일 것이다 both speak of the end of the iteration.
        return node({ node: "TemporalPromise", noun: noun(s.noun), value: expr(s.value) });
      case "fixed":
        return node({ node: "TemporalFixedPoint" });
      case "when": {
        const { left, right, order } = s.condition;
        if (order) return node({ node: "Branch", condition: typed({ node: "Compare", op: order, left: expr(left), right: expr(right) }), then: stmt(s.then) });
        const eq = typed({ node: "Eq", left: expr(left), right: expr(right) });
        return node({
          node: "Branch",
          condition: s.condition.negated ? typed({ node: "Not", operand: eq }) : eq,
          then: stmt(s.then),
        });
      }
    }
  };

  return stmt(sentence);
}

// How a statement touches nouns, for the never-introduced check. A noun is introduced
// by a present-tense store, a 미정 declaration, a receive, or a call's results; anything
// else that names it (reading, sending, constraining) needs it introduced somewhere.
export function nounsIn(stmt: Stmt): { uses: NounId[]; introduces: NounId[] } {
  const uses: NounId[] = [];
  const introduces: NounId[] = [];
  const visitExpr = (e: Expr): void => {
    if (e.node === "LoadNoun" || e.node === "TemporalAnchorRead") uses.push(e.noun);
    for (const child of childExprs(e)) visitExpr(child);
  };
  const visit = (s: Stmt): void => {
    for (const e of childExprs(s)) visitExpr(e);
    switch (s.node) {
      case "StoreNoun":
        // A store into a field or an element reads the noun it rebuilds.
        introduces.push(s.noun);
        return;
      case "CallPlane":
        introduces.push(...s.results);
        return;
      case "TemporalDeclare":
      case "TemporalReceive":
        introduces.push(s.noun);
        return;
      case "TemporalSend":
      case "TemporalAssert":
      case "TemporalPromise":
        uses.push(s.noun);
        return;
      case "Branch":
        visit(s.then);
        return;
      default:
        return;
    }
  };
  visit(stmt);
  return { uses, introduces };
}
