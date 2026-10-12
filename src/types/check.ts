import type { Diagnostic } from "../language/diagnostics";
import { callable } from "../ir/callables";
import type { Expr, Noun, NounId, Pattern, PlaneId, Provenance, Stmt } from "../ir/hir";
import type { ConcreteValue } from "../semantics/values";
import { arrayOf, BOOL, formatType, INT, named, sliceOf, substituteParams, TEXT, TypeTable, Unifier, UNIT_TYPE, type Type } from "./types";

// The type checker. It walks the HIR once, in source order, unifying as it goes, then
// writes the solved type onto every expression and noun. Inference is local and
// first-order: a noun has one type for the whole program, fixed by whatever first pins
// it down, and every later use must agree. Nothing converts implicitly.
//
// Temporal unknowns are not its business. `값은 미정이다` gives 값 a type variable here
// and a value symbol α in the temporal store at run time; arithmetic solves the first
// (T = Int) before the program starts, testimony solves the second (α = 4) while it
// runs. The only meeting point is a rule: a temporal value must be Int or Text,
// the two sorts the temporal solver understands.

export const TYPE_CODES = {
  MISMATCH: "Y3Y001",
  ARITY: "Y3Y003",
  NOT_TEMPORAL: "Y3Y004",
  NOT_EXHAUSTIVE: "Y3Y005",
  UNKNOWN: "Y3Y006",
  DUPLICATE_BINDING: "Y3Y007",
  UNREACHABLE_ARM: "Y3Y008",
  RETURN_OUTSIDE: "Y3C001",
} as const;

// What a body's checker needs to know beyond its own nouns: the signatures of the
// callable planes it can call, and what it returns itself (null for the main volume,
// which does not return).
export type PlaneSignature = { readonly params: readonly Type[]; readonly results: readonly Type[] };
export type BodyContext = {
  readonly planes: ReadonlyMap<PlaneId, PlaneSignature & { readonly name: string }>;
  readonly results: readonly Type[] | null;
};

const MAIN_CONTEXT: BodyContext = { planes: new Map(), results: null };

// Pattern-matrix analysis (Maranget, "Warnings for pattern matching"). A constructor
// is a variant, a record, 참/거짓 or (); Int and Text have infinitely many literals, so
// only a catch-all covers them. Binds count as wildcards.
type Ctor = { readonly key: string; readonly label: string; readonly fields: readonly Type[] };

const WILD: Pattern = { kind: "wildcard" };
const OPEN: Type = { kind: "var", id: -1 }; // a column whose type has no finite constructor set

function headKey(p: Pattern | undefined): string | null {
  if (!p) return null;
  switch (p.kind) {
    case "wildcard":
    case "bind":
      return null;
    case "variant":
      return p.variant;
    case "record":
      return p.type;
    case "literal":
      return p.value.kind === "bool" ? (p.value.value ? "참" : "거짓") : p.value.kind === "unit" ? "()" : `literal ${JSON.stringify(p.value, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  }
}

const headFields = (p: Pattern): readonly Pattern[] => (p.kind === "variant" || p.kind === "record" ? p.fields : []);

// Rows that can still match once the first column is the constructor `key`.
function specialize(rows: readonly Pattern[][], key: string, arity: number): Pattern[][] {
  return rows.flatMap((row) => {
    const [head, ...rest] = row;
    if (headKey(head) === null) return [[...Array<Pattern>(arity).fill(WILD), ...rest]];
    return headKey(head) === key && head ? [[...headFields(head), ...rest]] : [];
  });
}

// Rows that match whatever the first column holds, without it.
const defaultRows = (rows: readonly Pattern[][]): Pattern[][] => rows.filter((row) => headKey(row[0]) === null).map((row) => row.slice(1));

const heads = (rows: readonly Pattern[][]): Set<string | null> => new Set(rows.map((row) => headKey(row[0])));

const render = (ctor: Ctor, args: readonly string[]) => (ctor.fields.length === 0 ? ctor.label : `${ctor.label}(${args.join(", ")})`);

type TemporalUse = { readonly noun: NounId; readonly at: Provenance; readonly what: string };

export class TypeChecker {
  readonly diagnostics: Diagnostic[] = [];
  private readonly u = new Unifier();
  private readonly nounTypes = new Map<NounId, Type>();
  private readonly origins = new Map<NounId, Provenance>(); // where a noun's type was first pinned
  private readonly exprs: Expr[] = [];
  private readonly temporal: TemporalUse[] = [];
  private readonly locals: Map<string, Type>[] = [];
  private readonly reported = new Set<string>();

  constructor(
    private readonly nouns: ReadonlyMap<NounId, Noun>,
    readonly table: TypeTable = new TypeTable(),
    private readonly context: BodyContext = MAIN_CONTEXT,
  ) {}

  private report(code: string, at: Provenance, message: string, severity: "error" | "warning" = "error"): void {
    const key = `${at.span.start.line}:${at.span.start.column}:${code}:${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push({ code, severity, message: `[${at.source}] ${message}`, span: at.span });
  }

  private name(id: NounId): string {
    return this.nouns.get(id)?.name ?? `#${id}`;
  }

  private nounType(id: NounId): Type {
    let type = this.nounTypes.get(id);
    if (!type) {
      type = this.u.fresh();
      this.nounTypes.set(id, type);
    }
    return type;
  }

  private show(type: Type): string {
    return formatType(this.u.resolve(type));
  }

  // The noun must have this type.
  private noun(id: NounId, found: Type, at: Provenance): void {
    const expected = this.nounType(id);
    const before = this.show(expected);
    if (this.u.unify(expected, found)) {
      const origin = this.origins.get(id);
      const since = origin ? ` since [${origin.source}] (line ${origin.span.start.line})` : "";
      this.report(TYPE_CODES.MISMATCH, at, `'${this.name(id)}' holds ${before}${since}, not ${this.show(found)}`);
      return;
    }
    if (!this.origins.has(id) && this.u.resolve(expected).kind !== "var") this.origins.set(id, at);
  }

  private expect(expected: Type, found: Type, at: Provenance, what: string): void {
    if (this.u.unify(expected, found)) {
      this.report(TYPE_CODES.MISMATCH, at, `${what} must be ${this.show(expected)}, not ${this.show(found)}`);
    }
  }

  // A callable plane's parameter: its type comes from the signature.
  param(id: NounId, type: Type): void {
    this.nounTypes.set(id, type);
  }

  stmt(s: Stmt): void {
    switch (s.node) {
      case "StoreNoun":
        this.noun(s.noun, this.expr(s.value), s.at);
        return;
      case "Eval":
        this.expr(s.expr);
        return;
      case "Branch":
        this.expect(BOOL, this.expr(s.condition), s.at, "a condition");
        this.stmt(s.then);
        return;
      case "TemporalDeclare":
        this.nounType(s.noun);
        this.temporal.push({ noun: s.noun, at: s.at, what: "미정" });
        return;
      case "TemporalReceive":
        this.nounType(s.noun);
        this.temporal.push({ noun: s.noun, at: s.at, what: "다음에서 온다" });
        return;
      case "TemporalSend":
        this.nounType(s.noun);
        return;
      case "TemporalAssert":
      case "TemporalPromise":
        this.noun(s.noun, this.expr(s.value), s.at);
        return;
      case "CallPlane":
        this.callPlane(s);
        return;
      case "Return":
        this.return(s);
        return;
      default:
        return; // movement, anchors, end, fixed point: nothing to type
    }
  }

  expr(e: Expr): Type {
    const type = this.infer(e);
    e.type = type;
    this.exprs.push(e);
    return type;
  }

  private infer(e: Expr): Type {
    switch (e.node) {
      case "Literal":
        return this.literalType(e.value, e.at);
      case "LoadNoun":
        return this.nounType(e.noun);
      case "TemporalAnchorRead":
        if (e.moment === "end") this.temporal.push({ noun: e.noun, at: e.at, what: "끝의" });
        return this.nounType(e.noun);
      case "LoadLocal": {
        for (let i = this.locals.length - 1; i >= 0; i -= 1) {
          const found = this.locals[i]?.get(e.local);
          if (found) return found;
        }
        this.report(TYPE_CODES.UNKNOWN, e.at, `'${e.local}' is not bound here`);
        return this.u.fresh();
      }
      case "Add":
      case "Sub":
        this.expect(INT, this.expr(e.left), e.at, "a value in arithmetic");
        this.expect(INT, this.expr(e.right), e.at, "the amount");
        return INT;
      case "Eq": {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        if (this.u.unify(left, right)) {
          this.report(TYPE_CODES.MISMATCH, e.at, `cannot compare ${this.show(left)} with ${this.show(right)}`);
        }
        return BOOL;
      }
      case "Not":
        this.expect(BOOL, this.expr(e.operand), e.at, "a negation");
        return BOOL;
      case "Call":
        return this.call(e);
      case "Construct":
        return this.construct(e);
      case "Field":
        return this.field(e);
      case "Match":
        return this.match(e);
      case "SetField": {
        const field = this.field(e);
        this.expect(field, this.expr(e.value), e.at, `the new '${e.field}'`);
        return this.u.resolve(e.record.type);
      }
      case "ArrayLiteral": {
        const element = this.u.fresh();
        for (const x of e.elements) this.expect(element, this.expr(x), e.at, "every element of an array");
        return arrayOf(element, e.elements.length);
      }
      case "Index": {
        const base = this.sequence(e.base, e.at, "an element");
        this.expect(INT, this.expr(e.index), e.at, "an index");
        return base?.element ?? this.u.fresh();
      }
      case "SetIndex": {
        const base = this.sequence(e.base, e.at, "an element");
        this.expect(INT, this.expr(e.index), e.at, "an index");
        const value = this.expr(e.value);
        if (base?.kind === "slice") {
          this.report(TYPE_CODES.MISMATCH, e.at, `a slice (${formatType(base)}) is a view of an array; write the element through the array`);
        }
        if (base) this.expect(base.element, value, e.at, "the new element");
        return base ?? this.u.fresh();
      }
      case "Slice": {
        const base = this.sequence(e.base, e.at, "a slice");
        this.expect(INT, this.expr(e.from), e.at, "where a slice starts");
        this.expect(INT, this.expr(e.to), e.at, "where a slice ends");
        return sliceOf(base?.element ?? this.u.fresh());
      }
      case "Length":
        this.sequence(e.base, e.at, "a length");
        return INT;
    }
  }

  // An array or slice operand, whose type must be known here (local inference).
  private sequence(e: Expr, at: Provenance, what: string): Extract<Type, { kind: "array" | "slice" }> | null {
    const type = this.u.resolve(this.expr(e));
    if (type.kind === "array" || type.kind === "slice") return type;
    this.report(TYPE_CODES.MISMATCH, at, `${what} needs an array or a slice whose type is known here, not ${formatType(type)}`);
    return null;
  }

  private callPlane(s: Extract<Stmt, { node: "CallPlane" }>): void {
    const target = this.context.planes.get(s.plane);
    const args = s.args.map((arg) => this.expr(arg));
    if (!target) {
      this.report(TYPE_CODES.UNKNOWN, s.at, `no callable plane '${s.plane}'`);
      return;
    }
    const label = `':${target.name}:'`;
    const n = target.params.length;
    if (args.length !== n) {
      this.report(TYPE_CODES.ARITY, s.at, `${label} takes ${n} argument${n === 1 ? "" : "s"}, not ${args.length}`);
    } else {
      args.forEach((arg, i) => this.expect(target.params[i] as Type, arg, s.at, `argument ${i + 1} of ${label}`));
    }
    // Results may be discarded; one name for a plane that returns nothing receives ().
    const results = target.results.length === 0 && s.results.length === 1 ? [UNIT_TYPE] : target.results;
    if (s.results.length === 0) return;
    if (s.results.length !== results.length) {
      const m = target.results.length;
      this.report(TYPE_CODES.ARITY, s.at, `${label} returns ${m === 0 ? "nothing" : `${m} value${m === 1 ? "" : "s"}`}, not ${s.results.length}`);
      return;
    }
    s.results.forEach((noun, i) => this.noun(noun, results[i] as Type, s.at));
  }

  private return(s: Extract<Stmt, { node: "Return" }>): void {
    const values = s.values.map((v) => this.expr(v));
    const expected = this.context.results;
    if (expected === null) {
      this.report(TYPE_CODES.RETURN_OUTSIDE, s.at, "only a callable plane returns; the main volume ends with '끝이다'");
      return;
    }
    if (values.length !== expected.length) {
      const m = expected.length;
      this.report(TYPE_CODES.ARITY, s.at, `this plane returns ${m === 0 ? "nothing ('돌아간다')" : `${m} value${m === 1 ? "" : "s"}`}, not ${values.length}`);
      return;
    }
    values.forEach((v, i) => this.expect(expected[i] as Type, v, s.at, `returned value ${i + 1}`));
  }

  private literalType(value: ConcreteValue, at: Provenance): Type {
    switch (value.kind) {
      case "int":
        return INT;
      case "text":
        return TEXT;
      case "bool":
        return BOOL;
      case "unit":
        return UNIT_TYPE;
      case "data":
      case "array":
      case "slice":
        this.report(TYPE_CODES.UNKNOWN, at, "data values are built with Construct or ArrayLiteral, not written as literals");
        return this.u.fresh();
    }
  }

  private call(e: Extract<Expr, { node: "Call" }>): Type {
    const target = callable(e.callee);
    const label = `'${target.namespace} ${target.name}'`;
    const params = this.u.instantiate(target.signature.typeParams);
    const expected = target.signature.params.map((p) => substituteParams(p, params));
    const args = e.args.map((arg) => this.expr(arg));
    if (args.length !== expected.length) {
      const n = expected.length;
      this.report(TYPE_CODES.ARITY, e.at, `${label} takes ${n} argument${n === 1 ? "" : "s"}, not ${args.length}`);
    } else {
      args.forEach((arg, i) => this.expect(expected[i] as Type, arg, e.at, `argument ${i + 1} of ${label}`));
    }
    return substituteParams(target.signature.result, params);
  }

  private construct(e: Extract<Expr, { node: "Construct" }>): Type {
    const args = e.args.map((arg) => this.expr(arg));
    const def = this.table.get(e.typeName);
    if (!def) {
      this.report(TYPE_CODES.UNKNOWN, e.at, `unknown type '${e.typeName}'`);
      return this.u.fresh();
    }
    const params = this.u.instantiate(def.params);
    const result = named(def.name, ...def.params.map((p) => params.get(p) as Type));
    let fields: readonly Type[];
    if (def.kind === "sum") {
      const variant = def.variants.find((v) => v.name === e.variant);
      if (!variant) {
        this.report(TYPE_CODES.UNKNOWN, e.at, `'${def.name}' has no variant '${e.variant}'; it has ${def.variants.map((v) => v.name).join(", ")}`);
        return result;
      }
      fields = variant.fields;
    } else {
      if (e.variant !== null) this.report(TYPE_CODES.UNKNOWN, e.at, `'${def.name}' is a record, not a sum; it has no variants`);
      fields = def.fields.map((f) => f.type);
    }
    const label = e.variant ?? def.name;
    if (args.length !== fields.length) {
      this.report(TYPE_CODES.ARITY, e.at, `'${label}' has ${fields.length} field${fields.length === 1 ? "" : "s"}, not ${args.length}`);
    } else {
      args.forEach((arg, i) => this.expect(substituteParams(fields[i] as Type, params), arg, e.at, `field ${i + 1} of '${label}'`));
    }
    return result;
  }

  private field(e: Extract<Expr, { node: "Field" | "SetField" }>): Type {
    const record = this.u.resolve(this.expr(e.record));
    // Local inference: the record's type must already be known here.
    const def = record.kind === "named" ? this.table.get(record.name) : null;
    if (!def || def.kind !== "product" || record.kind !== "named") {
      this.report(TYPE_CODES.UNKNOWN, e.at, `a field needs a record whose type is known here, not ${formatType(record)}`);
      return this.u.fresh();
    }
    const field = def.fields.find((f) => f.name === e.field);
    if (!field) {
      this.report(TYPE_CODES.UNKNOWN, e.at, `'${def.name}' has no field '${e.field}'; it has ${def.fields.map((f) => f.name).join(", ")}`);
      return this.u.fresh();
    }
    e.index = def.fields.indexOf(field);
    return substituteParams(field.type, new Map(def.params.map((p, i) => [p, record.args[i] as Type])));
  }

  private match(e: Extract<Expr, { node: "Match" }>): Type {
    const scrutinee = this.expr(e.scrutinee);
    const result = this.u.fresh();
    let wellTyped = true;
    for (const arm of e.arms) {
      this.locals.push(new Map());
      const before = this.diagnostics.length;
      this.pattern(arm.pattern, scrutinee, e.at);
      wellTyped &&= this.diagnostics.length === before;
      this.expect(result, this.expr(arm.body), arm.body.at, "every arm of a match");
      this.locals.pop();
    }
    // Coverage is only meaningful for well-typed patterns.
    if (wellTyped) this.coverage(e, scrutinee);
    return result;
  }

  private pattern(p: Pattern, type: Type, at: Provenance): void {
    switch (p.kind) {
      case "wildcard":
        return;
      case "bind": {
        // Each arm has its own scope, so a name already in it was bound by this same
        // pattern. Repeating a name is refused, not read as an equality test.
        const scope = this.locals[this.locals.length - 1];
        if (scope?.has(p.local)) {
          this.report(TYPE_CODES.DUPLICATE_BINDING, at, `'${p.local}' is bound twice in one pattern; each name may be bound once`);
          return;
        }
        scope?.set(p.local, type);
        return;
      }
      case "literal":
        this.expect(type, this.literalType(p.value, at), at, "a pattern");
        return;
      case "variant":
      case "record": {
        const def = this.table.get(p.type);
        if (!def) {
          this.report(TYPE_CODES.UNKNOWN, at, `unknown type '${p.type}'`);
          return;
        }
        const params = this.u.instantiate(def.params);
        this.expect(type, named(def.name, ...def.params.map((x) => params.get(x) as Type)), at, "a pattern");
        let fields: readonly Type[] = [];
        if (p.kind === "variant") {
          const variant = def.kind === "sum" ? def.variants.find((v) => v.name === p.variant) : undefined;
          if (!variant) {
            this.report(TYPE_CODES.UNKNOWN, at, `'${def.name}' has no variant '${p.variant}'`);
            return;
          }
          fields = variant.fields;
        } else if (def.kind === "product") {
          fields = def.fields.map((f) => f.type);
        } else {
          this.report(TYPE_CODES.UNKNOWN, at, `'${def.name}' is a sum; match its variants`);
          return;
        }
        if (fields.length !== p.fields.length) {
          this.report(TYPE_CODES.ARITY, at, `a pattern for '${p.kind === "variant" ? p.variant : def.name}' needs ${fields.length} fields, not ${p.fields.length}`);
          return;
        }
        p.fields.forEach((sub, i) => this.pattern(sub, substituteParams(fields[i] as Type, params), at));
        return;
      }
    }
  }

  // The constructors of a type, or null when it has too many to list (Int, Text) or
  // is not known here.
  private ctorsOf(type: Type): Ctor[] | null {
    const t = this.u.resolve(type);
    if (t.kind === "prim") {
      if (t.name === "Bool") return [{ key: "참", label: "참", fields: [] }, { key: "거짓", label: "거짓", fields: [] }];
      return t.name === "Unit" ? [{ key: "()", label: "()", fields: [] }] : null;
    }
    const def = t.kind === "named" ? this.table.get(t.name) : null;
    if (!def || t.kind !== "named") return null;
    const args = new Map(def.params.map((p, i) => [p, t.args[i] ?? OPEN]));
    if (def.kind === "product") return [{ key: def.name, label: def.name, fields: def.fields.map((f) => substituteParams(f.type, args)) }];
    return def.variants.map((v) => ({ key: v.name, label: v.name, fields: v.fields.map((f) => substituteParams(f, args)) }));
  }

  // Whether the pattern vector q matches some value that no row matches.
  private useful(rows: readonly Pattern[][], q: readonly Pattern[], types: readonly Type[]): boolean {
    const [p, ...qs] = q;
    const [t, ...rest] = types;
    if (!p || !t) return rows.length === 0;
    const ctors = this.ctorsOf(t);
    const key = headKey(p);
    if (key !== null) {
      const fields = headFields(p);
      const fieldTypes = ctors?.find((c) => c.key === key)?.fields ?? fields.map(() => OPEN);
      return this.useful(specialize(rows, key, fields.length), [...fields, ...qs], [...fieldTypes, ...rest]);
    }
    // Split on constructors only when the rows name all of them; otherwise the rows
    // that match anything here decide (this keeps wide records of Bools linear).
    if (ctors && ctors.every((c) => heads(rows).has(c.key))) {
      return ctors.some((c) => this.useful(specialize(rows, c.key, c.fields.length), [...c.fields.map(() => WILD), ...qs], [...c.fields, ...rest]));
    }
    return this.useful(defaultRows(rows), qs, rest);
  }

  // Values (as pattern vectors) that no row matches; empty when the rows are exhaustive.
  private uncovered(rows: readonly Pattern[][], types: readonly Type[], limit = 3): string[][] {
    const [t, ...rest] = types;
    if (!t) return rows.length === 0 ? [[]] : [];
    const ctors = this.ctorsOf(t);
    const named = heads(rows);
    if (!ctors || !ctors.every((c) => named.has(c.key))) {
      // Some constructor (or, for Int and Text, some literal) is never named, so only
      // the rows that match anything here can cover it.
      // A column that names no constructor at all is missing simply "_".
      const listed = ctors && [...named].some((key) => key !== null);
      const missing = listed ? ctors.filter((c) => !named.has(c.key)).map((c) => render(c, c.fields.map(() => "_"))) : ["_"];
      const tails = this.uncovered(defaultRows(rows), rest, limit);
      return missing.flatMap((m) => tails.map((w) => [m, ...w])).slice(0, limit);
    }
    const found: string[][] = [];
    for (const c of ctors) {
      for (const w of this.uncovered(specialize(rows, c.key, c.fields.length), [...c.fields, ...rest], limit - found.length)) {
        found.push([render(c, w.slice(0, c.fields.length)), ...w.slice(c.fields.length)]);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  // A match must cover every value of its scrutinee's type, and every arm must be
  // reachable. Nested patterns count: Some(참), Some(거짓) and None cover Option<Bool>.
  private coverage(e: Extract<Expr, { node: "Match" }>, scrutinee: Type): void {
    const rows: Pattern[][] = [];
    for (const arm of e.arms) {
      if (!this.useful(rows, [arm.pattern], [scrutinee])) {
        this.report(TYPE_CODES.UNREACHABLE_ARM, arm.body.at, "this arm can never match: the arms before it cover every value it matches", "warning");
      }
      rows.push([arm.pattern]);
    }
    const missing = this.uncovered(rows, [scrutinee]).map((w) => w[0] ?? "_");
    if (missing.length > 0) {
      this.report(TYPE_CODES.NOT_EXHAUSTIVE, e.at, `this match does not cover ${missing.join(", ")}`);
    }
  }

  // Writes solved types onto the IR and checks what needed every constraint first.
  finish(): void {
    for (const e of this.exprs) e.type = this.u.resolve(e.type);
    for (const [id, noun] of this.nouns) noun.type = this.u.resolve(this.nounType(id));
    for (const use of this.temporal) {
      const type = this.u.resolve(this.nounType(use.noun));
      const ok = type.kind === "var" || (type.kind === "prim" && (type.name === "Int" || type.name === "Text"));
      if (!ok) {
        this.report(
          TYPE_CODES.NOT_TEMPORAL,
          use.at,
          `'${this.name(use.noun)}' is ${formatType(type)}; a temporal value (${use.what}) must be Int or Text, the sorts the temporal solver knows`,
        );
      }
    }
  }
}

// Checks a whole program, in the order given.
export function checkProgram(stmts: readonly Stmt[], nouns: readonly Noun[], table?: TypeTable, context?: BodyContext): Diagnostic[] {
  const checker = new TypeChecker(new Map(nouns.map((n) => [n.id, n])), table, context);
  for (const s of stmts) checker.stmt(s);
  checker.finish();
  return checker.diagnostics;
}
