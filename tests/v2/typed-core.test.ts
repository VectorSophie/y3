import { describe, expect, it } from "vitest";
import {
  bool,
  checkProgram,
  compileProgram,
  concrete,
  describeEffect,
  evaluate,
  formatType,
  hasErrors,
  int,
  INT,
  loadDocument,
  matchPattern,
  named,
  param,
  parseSentence,
  runProgram,
  SENTENCE_CODES,
  text,
  TEXT,
  TypeChecker,
  TypeTable,
  Unifier,
  walk,
  type ConcreteValue,
  type EvalEnv,
  type Expr,
  type Noun,
  type Pattern,
  type ProgramResult,
  type Provenance,
  type Stmt,
} from "../../src/v2";
import { fixtures } from "./helpers";

function compile(...cells: string[]) {
  const loaded = loadDocument(`⟦\n${cells.map((cell) => `[${cell}]`).join("\n")}\n⟧\n`);
  if (hasErrors(loaded.diagnostics) || !loaded.ast || !loaded.space || !loaded.manifest) {
    throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
  }
  return { ...compileProgram(loaded.ast, loaded.space), manifest: loaded.manifest };
}

function run(...cells: string[]): ProgramResult {
  const { program, diagnostics, manifest } = compile(...cells);
  if (!program) throw new Error(diagnostics.map((d) => d.message).join("\n"));
  return runProgram(program, manifest);
}

const typeOf = (cells: string[], name: string) => {
  const { program, diagnostics } = compile(...cells);
  if (!program) throw new Error(diagnostics.map((d) => d.message).join("\n"));
  const noun = program.nouns.find((n) => n.name === name);
  return noun ? formatType(noun.type) : null;
};

const errors = (...cells: string[]) =>
  compile(...cells)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => `${d.code} ${d.message}`);

describe("type inference", () => {
  it("infers Int from arithmetic", () => {
    expect(typeOf(["값은 미정이다.", "값에 1을 더한다.", "끝이다."], "값")).toBe("Int");
  });

  it("infers Text from testimony", () => {
    expect(typeOf(["값은 미정이다.", '값은 "이상"이었다.', "끝이다."], "값")).toBe("Text");
  });

  it("infers through copies, in either direction", () => {
    expect(typeOf(["값은 미정이다.", "다른은 값이다.", "다른에 1을 더한다.", "끝이다."], "값")).toBe("Int");
    expect(typeOf(["값은 다른이다.", "다른은 참이다.", "끝이다."], "값")).toBe("Bool"); // a later statement pins an earlier copy
  });

  it("leaves a type open when nothing pins it, and still runs", () => {
    const { program } = compile("문장이 다음에서 온다.", "문장을 말한다.", "문장을 전으로 보낸다.", "끝이다.");
    expect(program?.nouns.map((n) => n.type.kind)).toEqual(["var"]);
  });

  it("keeps type unknowns and value unknowns apart: the type is settled before the run, the value is not", () => {
    const { program, manifest } = compile("값은 미정이다.", "값에 1을 더한다.", "끝이다.");
    if (!program) throw new Error("expected a program");
    expect(formatType(program.nouns[0]?.type ?? INT)).toBe("Int"); // Tα = Int, in the checker
    const result = runProgram(program, manifest);
    expect(result.symbols).toMatchObject([{ label: "α1", state: "declared", value: null }]); // α still open
  });
});

describe("static type errors", () => {
  it("refuses Int against Text, naming where the type came from", () => {
    expect(errors("값은 3이다.", '값은 "셋"이다.', "끝이다.")).toEqual([
      `Y3Y001 [값은 "셋"이다.] '값' holds Int since [값은 3이다.] (line 2), not Text`,
    ]);
  });

  it("allows no implicit conversion", () => {
    expect(errors("값은 3이다.", "값이 참이면 끝이다.", "끝이다.")).toEqual(["Y3Y001 [값이 참이면 끝이다.] cannot compare Int with Bool"]);
    expect(errors('값은 "3"이다.', "값이 3이면 끝이다.", "끝이다.")).toEqual(["Y3Y001 [값이 3이면 끝이다.] cannot compare Text with Int"]);
    expect(errors("값은 참이다.", "값에 1을 더한다.", "끝이다.")[0]).toBe("Y3Y001 [값에 1을 더한다.] a value in arithmetic must be Int, not Bool");
    expect(errors("값은 1이다.", '값에 "셋"을 더한다.', "끝이다.")).toEqual([`Y3Y001 [값에 "셋"을 더한다.] the amount must be Int, not Text`]);
  });

  it("keeps temporal values to Int and Text", () => {
    expect(errors("값은 미정이다.", "값은 참이었다.", "끝이다.")).toEqual([
      "Y3Y004 [값은 미정이다.] '값' is Bool; a temporal value (미정) must be Int or Text, the sorts the temporal solver knows",
    ]);
    expect(errors("값은 끝의 같음이다.", "같음은 참이다.", "끝이다.")[0]).toMatch(/^Y3Y004 .*끝의/);
    expect(errors("값이 다음에서 온다.", "값은 참이다.", "값을 전으로 보낸다.", "끝이다.")[0]).toMatch(/^Y3Y004 .*다음에서 온다/);
  });

  it("are reported by check, before anything runs", () => {
    expect(compile("값은 3이다.", "값을 말한다.", '값은 "셋"이다.', "끝이다.").program).toBeNull();
  });
});

describe("Bool", () => {
  it("is 참 or 거짓, and prints as such", () => {
    expect(run("값은 거짓이다.", "값을 말한다.", "끝이다.").output).toEqual(["거짓"]);
  });

  it("drives branches through Eq; 이 아니면 is Not(Eq)", () => {
    const result = run("값은 참이다.", "값이 거짓이 아니면 \"맞다\"를 말한다.", "끝이다.");
    expect(result.output).toEqual(["맞다"]);
    const { program } = compile("값은 참이다.", "값이 거짓이 아니면 \"맞다\"를 말한다.", "끝이다.");
    const branch = [...(program?.cells.values() ?? [])].find((s) => s.node === "Branch");
    expect(branch?.node === "Branch" && branch.condition.node).toBe("Not");
  });

  it("reserves 참 and 거짓", () => {
    expect(parseSentence("참은 3이다.").issues.map((i) => i.code)).toEqual([SENTENCE_CODES.RESERVED_NOUN]);
  });
});

describe("colon calls", () => {
  it("parse as calls, with or without a full stop, as statements or assignments", () => {
    expect(parseSentence("표준 줄출력: 값").sentence).toMatchObject({ kind: "call", call: { namespace: "표준", name: "줄출력" } });
    expect(parseSentence("표준 줄출력: 값.").sentence).toMatchObject({ kind: "call" });
    expect(parseSentence("크기는 수학 절댓값: 값").sentence).toMatchObject({ kind: "assign", noun: "크기", value: { kind: "call" } });
    expect(parseSentence("수학 최댓값: 1, 2").sentence).toMatchObject({ call: { args: [{ value: 1n }, { value: 2n }] } });
  });

  it("keep commas and colons inside quoted text", () => {
    expect(parseSentence('표준 줄출력: "a, b: c"').sentence).toMatchObject({ call: { args: [{ kind: "text", value: "a, b: c" }] } });
  });

  it("can be the consequence of a condition", () => {
    expect(run("값은 3이다.", '값이 3이면 표준 줄출력: "셋"', "끝이다.").output).toEqual(["셋"]);
  });

  it("run through name resolution, signature resolution, type checking and execution", () => {
    expect(run("값은 -7이다.", "크기는 수학 절댓값: 값", "표준 줄출력: 크기", "끝이다.").output).toEqual(["7"]);
  });

  it("reject unknown callables, wrong arity and wrong argument types at check", () => {
    expect(errors("수학 제곱근: 4", "끝이다.")).toEqual(["Y3Y002 [수학 제곱근: 4] '수학' has no callable '제곱근'; it has 절댓값, 최댓값"]);
    expect(errors("수학 최댓값: 4", "끝이다.")).toEqual(["Y3Y003 [수학 최댓값: 4] '수학 최댓값' takes 2 arguments, not 1"]);
    expect(errors('수학 절댓값: "셋"', "끝이다.")).toEqual([`Y3Y001 [수학 절댓값: "셋"] argument 1 of '수학 절댓값' must be Int, not Text`]);
    expect(errors("크기는 수학 절댓값: 3", "크기는 참이다.", "끝이다.")[0]).toMatch(/^Y3Y001 .*'크기' holds Int/);
  });

  it("need concrete arguments: a pure call on an open symbol is UNRESOLVED, like a branch", () => {
    const result = run("값은 미정이다.", "크기는 수학 절댓값: 값", "값은 3이었다.", "끝이다.");
    expect(result.outcome).toMatchObject({ status: "UNRESOLVED", steps: 2 });
    expect(result.trace.flatMap((e) => e.effects.map(describeEffect))).toContain("unresolved: needs α1");
  });

  it("말한다 is the same call as 표준 줄출력", () => {
    const said = compile("값은 3이다.", "값을 말한다.", "끝이다.").program;
    const called = compile("값은 3이다.", "표준 줄출력: 값", "끝이다.").program;
    const strip = (s: Stmt | undefined) => JSON.stringify(s, (key, v) => (key === "at" ? undefined : typeof v === "bigint" ? `${v}` : v));
    expect(strip(said?.cells.get("0,1,0"))).toBe(strip(called?.cells.get("0,1,0")));
  });
});

describe("semantic versions", () => {
  it("give every store a new version, with its definition and uses", () => {
    const result = run("값은 3이다.", "값에 1을 더한다.", "값을 말한다.", "끝이다.");
    expect(result.versions).toEqual([
      { noun: "값", index: 0, definedAt: 1, value: "3", uses: [2] },
      { noun: "값", index: 1, definedAt: 2, value: "4", uses: [3] },
    ]);
  });

  it("keep a symbolic version's identity, settled at the end", () => {
    const result = run("값은 미정이다.", "값에 1을 더한다.", "값은 4였다.", "끝이다.");
    expect(result.versions.map((v) => [v.index, v.value])).toEqual([
      [0, "3"],
      [1, "4"],
    ]);
  });
});

describe("provenance", () => {
  it("is on every IR node of every fixture: span, plane and cell", () => {
    for (const fixture of fixtures()) {
      const loaded = loadDocument(fixture.source);
      if (!loaded.ast || !loaded.space) continue;
      const { program } = compileProgram(loaded.ast, loaded.space);
      if (!program) continue;
      for (const [key, stmt] of program.cells) {
        walk(stmt, (item) => {
          expect(`${item.at.cell.x},${item.at.cell.y},${item.at.cell.z}`, `${fixture.path} ${item.node}`).toBe(key);
          expect(item.at.span.start.line).toBeGreaterThan(0);
          expect(item.at.plane.slot).toBe(item.at.cell.z);
          expect(item.at.source.length).toBeGreaterThan(0);
        });
      }
    }
  });

  it("names the plane a cell came from when it was referenced", () => {
    const loaded = loadDocument("⟦ :아래: ⟧\n\n※\n\n:아래: ⟦\n[값은 1이다.]\n[끝이다.]\n⟧\n");
    if (!loaded.ast || !loaded.space) throw new Error("expected a document");
    const stmt = compileProgram(loaded.ast, loaded.space).program?.cells.get("0,0,0");
    expect(stmt?.at).toMatchObject({ plane: { slot: 0, name: "아래" }, cell: { x: 0, y: 0, z: 0 }, span: { start: { line: 6 } } });
  });
});

describe("the runtime consumes typed IR, not Korean", () => {
  it("runs what the IR says, whatever the cell's text", () => {
    const { program, manifest } = compile("값은 3이다.", "값을 말한다.", "끝이다.");
    if (!program) throw new Error("expected a program");
    const say = program.cells.get("0,1,0") as Extract<Stmt, { node: "Eval" }>;
    const hello: Expr = { node: "Literal", value: text("IR"), type: TEXT, at: say.at };
    const call = say.expr as Extract<Expr, { node: "Call" }>;
    const cells = new Map(program.cells).set("0,1,0", { ...say, expr: { ...call, args: [hello] } });
    const result = runProgram({ ...program, cells }, manifest);
    expect(result.output).toEqual(["IR"]);
    expect(result.trace[1]?.cell).toBe("값을 말한다."); // the trace still shows the source cell
  });

  it("branches on any Bool expression, not only comparisons", () => {
    const { program, manifest } = compile("값은 3이다.", "값이 3이면 \"셋\"을 말한다.", "끝이다.");
    if (!program) throw new Error("expected a program");
    const branch = program.cells.get("0,1,0") as Extract<Stmt, { node: "Branch" }>;
    const no: Expr = { node: "Not", operand: { node: "Literal", value: bool(false), type: { kind: "prim", name: "Bool" }, at: branch.at }, type: { kind: "prim", name: "Bool" }, at: branch.at };
    const cells = new Map(program.cells).set("0,1,0", { ...branch, condition: no });
    const result = runProgram({ ...program, cells }, manifest);
    expect(result.output).toEqual(["셋"]);
    expect(result.trace[1]?.effects.map(describeEffect)).toContain("condition: yes");
  });
});

// Algebraic data types, at the IR level: M6 gives them source syntax.
describe("algebraic data types", () => {
  const at: Provenance = { span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, plane: { slot: 0, name: null }, cell: { x: 0, y: 0, z: 0 }, source: "test" };
  const PENDING = { kind: "var", id: 0 } as const;
  const lit = (value: ConcreteValue): Expr => ({ node: "Literal", value, type: PENDING, at });
  const make = (typeName: string, variant: string | null, ...args: Expr[]): Expr => ({ node: "Construct", typeName, variant, args, type: PENDING, at });
  const local = (name: string): Expr => ({ node: "LoadLocal", local: name, type: PENDING, at });
  const match = (scrutinee: Expr, ...arms: [Pattern, Expr][]): Expr => ({
    node: "Match",
    scrutinee,
    arms: arms.map(([pattern, body]) => ({ pattern, body })),
    type: PENDING,
    at,
  });
  const some = (p: Pattern): Pattern => ({ kind: "variant", type: "Option", variant: "Some", fields: [p] });
  const none: Pattern = { kind: "variant", type: "Option", variant: "None", fields: [] };
  const bind = (name: string): Pattern => ({ kind: "bind", local: name });

  const typecheck = (e: Expr, table?: TypeTable) => {
    const checker = new TypeChecker(new Map<number, Noun>(), table);
    checker.expr(e);
    checker.finish();
    return { type: formatType(e.type), errors: checker.diagnostics.map((d) => `${d.code} ${d.message.replace("[test] ", "")}`) };
  };
  const env: EvalEnv = {
    load: () => {
      throw new Error("no nouns");
    },
    anchor: () => {
      throw new Error("no time");
    },
    arithmetic: (a, b, sign) => concrete(int(((a.kind === "concrete" && a.value.kind === "int" && a.value.value) || 0n) + sign * ((b.kind === "concrete" && b.value.kind === "int" && b.value.value) || 0n))),
    effect: () => concrete({ kind: "unit" }),
    now: (v) => {
      if (v.kind !== "concrete") throw new Error("symbolic");
      return v.value;
    },
  };
  const value = (e: Expr) => {
    const v = evaluate(e, env);
    return v.kind === "concrete" ? v.value : null;
  };

  it("builds Option and Result: there is no null", () => {
    expect(typecheck(make("Option", "Some", lit(int(3n))))).toEqual({ type: "Option<Int>", errors: [] });
    expect(typecheck(make("Option", "None")).type).toMatch(/^Option<\?T\d+>$/); // T stays open
    expect(typecheck(make("Result", "Err", lit(text("없음"))))).toMatchObject({ type: expect.stringMatching(/^Result<\?T\d+, Text>$/) });
    expect(value(make("Option", "Some", lit(int(3n))))).toEqual({ kind: "data", type: "Option", variant: "Some", fields: [int(3n)] });
  });

  it("type-checks fields against the variant", () => {
    const pair = { node: "Eq", left: make("Option", "Some", lit(int(1n))), right: make("Option", "Some", lit(text("a"))), type: PENDING, at } as Expr;
    expect(typecheck(pair).errors).toEqual(["Y3Y001 cannot compare Option<Int> with Option<Text>"]);
    expect(typecheck(make("Option", "Maybe")).errors).toEqual(["Y3Y006 'Option' has no variant 'Maybe'; it has Some, None"]);
    expect(typecheck(make("Option", "Some")).errors).toEqual(["Y3Y003 'Some' has 1 field, not 0"]);
  });

  it("matches by pattern, binding locals for the arm", () => {
    const unwrap = (scrutinee: Expr) => match(scrutinee, [some(bind("x")), local("x")], [none, lit(int(0n))]);
    expect(typecheck(unwrap(make("Option", "Some", lit(int(3n)))))).toEqual({ type: "Int", errors: [] });
    expect(value(unwrap(make("Option", "Some", lit(int(3n)))))).toEqual(int(3n));
    expect(value(unwrap(make("Option", "None")))).toEqual(int(0n));
  });

  it("requires a match to be exhaustive", () => {
    expect(typecheck(match(make("Option", "None"), [some(bind("x")), local("x")])).errors).toEqual(["Y3Y005 this match does not cover None"]);
    expect(typecheck(match(lit(bool(true)), [{ kind: "literal", value: bool(true) }, lit(int(1n))])).errors).toEqual([
      "Y3Y005 this match does not cover 거짓",
    ]);
    expect(typecheck(match(lit(int(1n)), [{ kind: "literal", value: int(1n) }, lit(int(1n))])).errors).toEqual(["Y3Y005 this match does not cover _"]);
    expect(typecheck(match(lit(int(1n)), [{ kind: "wildcard" }, lit(int(1n))])).errors).toEqual([]);
  });

  it("requires every arm to have the same type", () => {
    expect(typecheck(match(make("Option", "None"), [some(bind("x")), lit(int(1n))], [none, lit(text("영"))])).errors).toEqual([
      "Y3Y001 every arm of a match must be Int, not Text",
    ]);
  });

  it("supports product types: records with named fields", () => {
    const table = new TypeTable();
    table.define({ kind: "product", name: "점", params: [], fields: [{ name: "x", type: INT }, { name: "y", type: INT }] });
    const point = make("점", null, lit(int(1n)), lit(int(2n)));
    const y: Expr = { node: "Field", record: point, field: "y", index: -1, type: PENDING, at };
    expect(typecheck(y, table)).toEqual({ type: "Int", errors: [] });
    expect(value(y)).toEqual(int(2n));
    const z: Expr = { node: "Field", record: make("점", null, lit(int(1n)), lit(int(2n))), field: "z", index: -1, type: PENDING, at };
    expect(typecheck(z, table).errors).toEqual(["Y3Y006 '점' has no field 'z'; it has x, y"]);
    const destructure = match(point, [{ kind: "record", type: "점", fields: [bind("a"), { kind: "wildcard" }] }, local("a")]);
    expect(typecheck(destructure, table)).toEqual({ type: "Int", errors: [] });
  });

  describe("bind each name once per pattern", () => {
    const pairs = () => {
      const table = new TypeTable();
      table.define({ kind: "sum", name: "Pair", params: ["A", "B"], variants: [{ name: "Pair", fields: [param("A"), param("B")] }] });
      return table;
    };
    const pair = (...fields: Pattern[]): Pattern => ({ kind: "variant", type: "Pair", variant: "Pair", fields });

    it("accepts distinct names: Some(x), Pair(x, y)", () => {
      expect(typecheck(match(make("Option", "Some", lit(int(1n))), [some(bind("x")), local("x")], [none, lit(int(0n))])).errors).toEqual([]);
      const both = match(make("Pair", "Pair", lit(int(1n)), lit(int(2n))), [pair(bind("x"), bind("y")), local("y")]);
      expect(typecheck(both, pairs())).toEqual({ type: "Int", errors: [] });
    });

    it("refuses the same name twice in one variant pattern: Pair(x, x)", () => {
      const twice = match(make("Pair", "Pair", lit(int(1n)), lit(int(2n))), [pair(bind("x"), bind("x")), local("x")]);
      expect(typecheck(twice, pairs()).errors).toEqual(["Y3Y007 'x' is bound twice in one pattern; each name may be bound once"]);
    });

    it("keeps the first binding's type rather than letting the second replace it", () => {
      const body = local("x");
      const mixed = match(make("Pair", "Pair", lit(int(1n)), lit(text("둘"))), [pair(bind("x"), bind("x")), body]);
      expect(typecheck(mixed, pairs()).errors).toEqual(["Y3Y007 'x' is bound twice in one pattern; each name may be bound once"]);
      expect(formatType(body.type)).toBe("Int"); // x is the Int field, never the Text one
    });

    it("refuses the same name twice in a nested pattern: Pair(Some(x), x)", () => {
      const nested = match(make("Pair", "Pair", make("Option", "Some", lit(int(1n))), lit(int(2n))), [pair(some(bind("x")), bind("x")), local("x")], [{ kind: "wildcard" }, lit(int(0n))]);
      expect(typecheck(nested, pairs()).errors).toEqual(["Y3Y007 'x' is bound twice in one pattern; each name may be bound once"]);
      const record = new TypeTable();
      record.define({ kind: "product", name: "점", params: [], fields: [{ name: "x", type: INT }, { name: "y", type: INT }] });
      const inRecord = match(make("점", null, lit(int(1n)), lit(int(2n))), [{ kind: "record", type: "점", fields: [bind("a"), bind("a")] }, local("a")]);
      expect(typecheck(inRecord, record).errors).toEqual(["Y3Y007 'a' is bound twice in one pattern; each name may be bound once"]);
    });

    it("allows the same name in separate arms, and an inner match to shadow an outer one", () => {
      const arms = match(make("Pair", "Pair", lit(int(1n)), lit(int(2n))), [pair(bind("x"), { kind: "literal", value: int(0n) }), local("x")], [pair({ kind: "wildcard" }, bind("x")), local("x")]);
      expect(typecheck(arms, pairs())).toEqual({ type: "Int", errors: [] });
      expect(value(arms)).toEqual(int(2n)); // the second arm matched, with its own x
      const inner = match(make("Option", "Some", lit(int(7n))), [some(bind("x")), match(make("Option", "Some", local("x")), [some(bind("x")), local("x")], [none, lit(int(0n))])], [none, lit(int(0n))]);
      expect(typecheck(inner)).toEqual({ type: "Int", errors: [] });
      expect(value(inner)).toEqual(int(7n));
    });

    it("is an invariant of the runtime matcher too, for HIR that skipped the checker", () => {
      const v: ConcreteValue = { kind: "data", type: "Pair", variant: "Pair", fields: [int(1n), int(2n)] };
      expect(() => matchPattern(pair(bind("x"), bind("x")), v)).toThrow(/bound twice/);
      expect(matchPattern(pair(bind("x"), bind("y")), v, new Map([["x", int(9n)]]))).toEqual(new Map([["x", int(1n)], ["y", int(2n)]]));
    });
  });

  it("nest: Result<Option<Int>, Text>", () => {
    const nested = make("Result", "Ok", make("Option", "Some", lit(int(5n))));
    const result = typecheck(nested);
    expect(result.type).toMatch(/^Result<Option<Int>, \?T\d+>$/);
    const pick = match(nested, [{ kind: "variant", type: "Result", variant: "Ok", fields: [some(bind("n"))] }, local("n")], [{ kind: "wildcard" }, lit(int(0n))]);
    expect(value(pick)).toEqual(int(5n));
  });
});

describe("the unifier", () => {
  it("refuses infinite types (occurs check)", () => {
    const u = new Unifier();
    const t = u.fresh();
    expect(u.unify(t, named("Option", t))).not.toBeNull();
  });

  it("solves through type arguments", () => {
    const u = new Unifier();
    const t = u.fresh();
    expect(u.unify(named("Option", t), named("Option", INT))).toBeNull();
    expect(u.resolve(t)).toEqual(INT);
  });

  it("checks whole programs through checkProgram, independently of the runtime", () => {
    const { program } = compile("값은 3이다.", "끝이다.");
    expect(checkProgram([...(program?.cells.values() ?? [])], program?.nouns ?? [])).toEqual([]);
  });
});
