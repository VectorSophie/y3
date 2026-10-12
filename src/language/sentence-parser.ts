import type { Compass, Relative, Turn } from "../space/orientation";
import { canonicalParticle, endingOf, type ParticlePair } from "./korean";
import type { NumericName } from "../types/types";
import type { ActAst, CallAst, CallReading, ConditionAst, ExprAst, MatchAst, PatternAst, PlaceAst, PlaceStep, RelationAst, SentenceAst, TimeAnchor } from "./sentence-ast";

// Parses one cell's sentence. Tense is read from the sentence-final form: present
// tense is an act (it executes), past and future tense are relations (they constrain).
// Forms that belong to later milestones are recognised and refused, never half-run.
// Particles assign roles, so word order is free. A colon marks an explicit call,
// `[이름공간 이름: 인자, …]`, which is syntax rather than prose.

export type SentenceIssue = { code: string; severity: "error" | "warning"; message: string };
export type SentenceResult = { sentence: SentenceAst | null; issues: SentenceIssue[] };

export const SENTENCE_CODES = {
  NO_FULL_STOP: "Y3G001",
  UNKNOWN_SENTENCE: "Y3G002",
  BAD_PHRASE: "Y3G003",
  WRONG_ROLES: "Y3G004",
  UNKNOWN_DIRECTION: "Y3G005",
  RESERVED_NOUN: "Y3G006",
  NEVER_INTRODUCED: "Y3G007",
  VERB_TENSE: "Y3G008",
  BAD_CONDITIONAL: "Y3G009",
  BAD_CALL: "Y3G012",
  BAD_MATCH: "Y3G013",
  BAD_RETURN: "Y3G014",
  ANCHOR_WRITE: "Y3G010",
  ANCHOR_TENSE: "Y3G011",
  TEMPORAL_LATER: "Y3T001",
  FEATURE_LATER: "Y3T002",
  NON_CANONICAL: "Y3K001",
} as const;

class SentenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new SentenceError(code, message);
}

const PARTICLES: readonly { form: string; role: Role; pair: ParticlePair | null }[] = [
  { form: "에서", role: "source", pair: null },
  { form: "으로", role: "direction", pair: "direction" },
  { form: "은", role: "subject", pair: "topic" },
  { form: "는", role: "subject", pair: "topic" },
  { form: "이", role: "subject", pair: "subject" },
  { form: "가", role: "subject", pair: "subject" },
  { form: "을", role: "object", pair: "object" },
  { form: "를", role: "object", pair: "object" },
  { form: "에", role: "target", pair: null },
  { form: "로", role: "direction", pair: "direction" },
  { form: "과", role: "and", pair: "and" },
  { form: "와", role: "and", pair: "and" },
];

type Role = "subject" | "object" | "target" | "source" | "direction" | "and";
type Phrase = { stem: string; particle: string; role: Role; pair: ParticlePair | null };

const TURN_WORDS: Readonly<Record<string, Turn>> = { 오른쪽: "right", 왼쪽: "left", 뒤: "around", 위: "up", 아래: "down" };
const COMPASS_WORDS: Readonly<Record<string, Compass>> = { 동쪽: "east", 서쪽: "west", 남쪽: "south", 북쪽: "north" };
const STEP_WORDS: Readonly<Record<string, Relative>> = {
  앞: "forward",
  뒤: "back",
  오른쪽: "right",
  왼쪽: "left",
  위: "up",
  아래: "down",
};
const FLOOR_WORDS: Readonly<Record<string, 1 | -1>> = { 위층: 1, 아래층: -1 };

export const RESERVED_WORDS = new Set([
  "참",
  "거짓",
  "처음",
  "끝",
  "여기",
  "미정",
  "전",
  "다음",
  ...Object.keys(TURN_WORDS),
  ...Object.keys(COMPASS_WORDS),
  ...Object.keys(STEP_WORDS),
  ...Object.keys(FLOOR_WORDS),
]);

const PRESENT_VERBS = new Set(["더한다", "뺀다", "곱한다", "나눈다", "말한다", "본다", "간다", "온다", "보낸다", "돌려준다", "돌아간다"]);
const LATER_VERBS: Readonly<Record<string, string>> = {
  듣는다: "input (use '표준 줄읽기')",
};
const TIME_WORDS = new Set(["처음", "끝", "여기", "전", "다음"]);
const PAST_VERB_ENDINGS = ["했다", "뺐다", "갔다", "봤다", "보았다", "들었다", "왔다", "냈다"];

const NOUN_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;

// Where the rune literal opening at `i` closes, or -1: one scalar or one escape.
function runeEnd(text: string, i: number): number {
  const width = text[i + 1] === "\\" ? 2 : String.fromCodePoint(text.codePointAt(i + 1) ?? 0).length;
  return text[i + 1] !== undefined && text[i + 1 + width] === "'" ? i + 1 + width : -1;
}

const NUMERIC_SUFFIX = "(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|bigint|f32|f64)?";
const INTEGER_LITERAL = new RegExp(`^(-?\\d+)${NUMERIC_SUFFIX}$`, "u");
const FLOAT_LITERAL = new RegExp(`^(-?\\d+\\.\\d+(?:[eE][+-]?\\d+)?)${NUMERIC_SUFFIX}$`, "u");
const RUNE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", "\\": "\\", "'": "'" };

// A numeric or rune literal, or null.
function literal(stem: string): ExprAst | null {
  const integer = stem.match(INTEGER_LITERAL);
  if (integer) {
    const suffix = integer[2] as NumericName | undefined;
    if (suffix === "f32" || suffix === "f64") return { kind: "float", value: Number(integer[1]), suffix };
    return suffix ? { kind: "int", value: BigInt(integer[1] ?? "0"), suffix } : { kind: "int", value: BigInt(integer[1] ?? "0") };
  }
  const real = stem.match(FLOAT_LITERAL);
  if (real) {
    const suffix = real[2] as NumericName | undefined;
    if (suffix && suffix !== "f32" && suffix !== "f64") fail(SENTENCE_CODES.BAD_PHRASE, `'${stem}' is a float literal; it cannot be ${suffix}`);
    return suffix ? { kind: "float", value: Number(real[1]), suffix } : { kind: "float", value: Number(real[1]) };
  }
  if (stem.startsWith("'") && stem.endsWith("'") && stem.length >= 3) {
    const body = stem.slice(1, -1);
    const char = body.startsWith("\\") ? RUNE_ESCAPES[body.slice(1)] : body;
    const scalar = char === undefined ? undefined : char.codePointAt(0);
    if (char === undefined || scalar === undefined || String.fromCodePoint(scalar) !== char) {
      fail(SENTENCE_CODES.BAD_PHRASE, `'${stem}' is not a rune: write one character, or \\n \\t \\\\ \\'`);
    }
    return { kind: "rune", value: scalar };
  }
  return null;
}

// Splits a sentence (without its full stop) into eojeols; a quoted literal, with any
// spaces inside it, stays inside one eojeol.
function eojeols(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      }
    } else if (ch === " ") {
      if (current.length > 0) words.push(current);
      current = "";
    } else if (ch === "'" && runeEnd(text, i) > 0) {
      // A rune literal is one token even when it is a space: ' '.
      const end = runeEnd(text, i);
      current += text.slice(i, end + 1);
      i = end;
    } else {
      current += ch;
      if (ch === '"') inQuote = true;
    }
  }
  if (inQuote) fail(SENTENCE_CODES.BAD_PHRASE, "a text literal is missing its closing quote");
  if (current.length > 0) words.push(current);
  return words;
}

function splitQuoted(word: string): { stem: string; rest: string } | null {
  if (!word.startsWith('"')) return null;
  for (let i = 1; i < word.length; i += 1) {
    const ch = word[i];
    if (ch === "\\") {
      i += 1;
    } else if (ch === '"') {
      return { stem: word.slice(0, i + 1), rest: word.slice(i + 1) };
    }
  }
  return null;
}

function phrase(word: string, issues: SentenceIssue[]): Phrase {
  const quoted = splitQuoted(word);
  let found: Phrase | null = null;
  for (const particle of PARTICLES) {
    if (quoted) {
      if (quoted.rest === particle.form) {
        found = { stem: quoted.stem, particle: particle.form, role: particle.role, pair: particle.pair };
        break;
      }
    } else if (word.endsWith(particle.form) && word.length > particle.form.length) {
      found = { stem: word.slice(0, -particle.form.length), particle: particle.form, role: particle.role, pair: particle.pair };
      break;
    }
  }
  if (!found) {
    fail(SENTENCE_CODES.BAD_PHRASE, `'${word}' needs a particle (은/는, 이/가, 을/를, 에, 에서, 으로/로, 과/와)`);
  }
  lintParticle(found.stem, found.particle, found.pair, issues);
  return found;
}

function lintParticle(stem: string, particle: string, pair: ParticlePair | null, issues: SentenceIssue[]): void {
  if (!pair) return;
  const ending = endingOf(stem);
  if (!ending) return;
  const canonical = canonicalParticle(pair, ending);
  if (canonical !== particle) {
    issues.push({
      code: SENTENCE_CODES.NON_CANONICAL,
      severity: "warning",
      message: `non-canonical Korean: write '${stem}${canonical}' instead of '${stem}${particle}'`,
    });
  }
}

// Escapes in a text literal: \n, \t, \\ and \" (the same as a rune's, with \" for \').
const TEXT_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", "\\": "\\", '"': '"' };

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/gu, (_, c: string) => {
    const escaped = TEXT_ESCAPES[c];
    if (escaped === undefined) fail(SENTENCE_CODES.BAD_PHRASE, `'\\${c}' is not an escape: use \\n, \\t, \\\\ or \\"`);
    return escaped;
  });
}

const ANCHORED = /^(처음|끝)의 (.+)$/u;
const GENITIVE = "의 "; // X의 Y: Y of X (a field, an element, or a moment)
const INDEX = /^(.+)번$/u; // 수들의 2번: element 2

function noun(stem: string): string {
  if (ANCHORED.test(stem)) {
    fail(SENTENCE_CODES.ANCHOR_WRITE, `'${stem}' names a value at a moment in time; it can be read or constrained, never written`);
  }
  if (stem.includes(GENITIVE)) {
    fail(SENTENCE_CODES.BAD_PHRASE, `'${stem}' is part of a value; this sentence speaks about a whole noun`);
  }
  if (RESERVED_WORDS.has(stem)) {
    fail(SENTENCE_CODES.RESERVED_NOUN, `'${stem}' is a reserved word and cannot name a value`);
  }
  if (!NOUN_PATTERN.test(stem)) {
    fail(SENTENCE_CODES.BAD_PHRASE, `'${stem}' is not a noun, a number or a quoted text`);
  }
  return stem;
}

// One step of a path: '가로' (a field) or '2번', 'i번' (an element).
function step(part: string): PlaceStep {
  const index = part.match(INDEX);
  if (index) return { kind: "index", index: expr(index[1] ?? "") };
  if (!NOUN_PATTERN.test(part) || RESERVED_WORDS.has(part)) fail(SENTENCE_CODES.BAD_PHRASE, `'${part}' is not a field name or an element ('2번')`);
  return { kind: "field", name: part };
}

// 위치의 가로는 …, 수들의 0번은 …: a noun, or a place inside one.
function place(stem: string): PlaceAst {
  const [base, ...rest] = stem.split(GENITIVE);
  if (base === "처음" || base === "끝") noun(stem); // a moment is never written
  return { noun: noun(base ?? ""), steps: rest.map(step) };
}

function expr(stem: string): ExprAst {
  if (stem.includes(GENITIVE) && !stem.startsWith('"')) {
    const parts = stem.split(GENITIVE);
    const [base, ...rest] = parts;
    let target: ExprAst;
    if (base === "처음" || base === "끝") {
      const anchored = rest.shift();
      target = { kind: "anchored", anchor: base, name: noun(anchored ?? "") };
    } else {
      target = expr(base ?? "");
    }
    for (const part of rest) {
      const s = step(part);
      target = s.kind === "field" ? { kind: "field", target, name: s.name } : { kind: "index", target, index: s.index };
    }
    return target;
  }
  const number = literal(stem);
  if (number) return number;
  if (stem === "참" || stem === "거짓") return { kind: "bool", value: stem === "참" };
  if (stem.startsWith('"') && stem.endsWith('"') && stem.length >= 2) return { kind: "text", value: unquote(stem) };
  return { kind: "noun", name: noun(stem) };
}

// Collects noun phrases by role; every role may appear once.
function roles(words: string[], issues: SentenceIssue[]): Map<Role, Phrase> {
  const found = new Map<Role, Phrase>();
  for (const word of words) {
    const p = phrase(word, issues);
    if (found.has(p.role)) {
      fail(SENTENCE_CODES.WRONG_ROLES, `two phrases take the same role ('${found.get(p.role)?.stem}${found.get(p.role)?.particle}' and '${word}')`);
    }
    found.set(p.role, p);
  }
  return found;
}

function expectRoles(verb: string, found: Map<Role, Phrase>, expected: Role[], usage: string): void {
  const ok = found.size === expected.length && expected.every((role) => found.has(role));
  if (!ok) {
    fail(SENTENCE_CODES.WRONG_ROLES, `'${verb}' is written '${usage}'`);
  }
}

// The subject of a relation: a noun, possibly anchored in time. Its tense must agree
// with its anchor: 처음의 N is past, 끝의 N is future.
function relationSubject(word: string, tense: "past" | "future", issues: SentenceIssue[]): { noun: string; anchor: TimeAnchor | null } {
  const subject = phrase(word, issues);
  if (subject.role !== "subject") {
    fail(SENTENCE_CODES.WRONG_ROLES, "a relation is written 'N은 E이었다' or 'N은 E일 것이다'");
  }
  if (TIME_WORDS.has(subject.stem)) {
    fail(SENTENCE_CODES.UNKNOWN_SENTENCE, `'${subject.stem}' is not a value; the only relation between 처음 and 끝 is '처음은 끝이었다'`);
  }
  const anchored = subject.stem.match(ANCHORED);
  if (!anchored) return { noun: noun(subject.stem), anchor: null };
  const anchor = anchored[1] as TimeAnchor;
  if ((anchor === "처음" && tense === "future") || (anchor === "끝" && tense === "past")) {
    fail(
      SENTENCE_CODES.ANCHOR_TENSE,
      anchor === "처음" ? "처음 is in the past: write '처음의 N은 E이었다'" : "끝 is in the future: write '끝의 N은 E일 것이다'",
    );
  }
  return { noun: noun(anchored[2] ?? ""), anchor };
}

// Past and future copulas. Returns null for any other sentence.
function parseRelation(words: string[], issues: SentenceIssue[]): RelationAst | null {
  const last = words[words.length - 1] ?? "";
  const before = words[words.length - 2] ?? "";
  if (last === "것이다") {
    if (!before.endsWith("일") || before.length < 2) {
      fail(SENTENCE_CODES.VERB_TENSE, "verbs are present tense only (더한다, not 더할 것이다); only states take tense");
    }
    if (words.length !== 3) {
      fail(SENTENCE_CODES.WRONG_ROLES, "a promise is written 'N은 E일 것이다'");
    }
    return { kind: "promise", ...relationSubject(words[0] ?? "", "future", issues), value: expr(before.slice(0, -1)) };
  }
  const past = last.endsWith("이었다") ? "이었다" : last.endsWith("였다") ? "였다" : null;
  if (past && last.length > past.length) {
    if (words.length !== 2) {
      fail(SENTENCE_CODES.WRONG_ROLES, "a past statement is written 'N은 E이었다'");
    }
    const value = last.slice(0, -past.length);
    const first = phrase(words[0] ?? "", []);
    if (first.stem === "처음" && first.role === "subject" && value === "끝") {
      return { kind: "fixed" };
    }
    const ending = endingOf(value);
    const canonical = ending === "vowel" ? "였다" : "이었다";
    if (ending && canonical !== past) {
      issues.push({
        code: SENTENCE_CODES.NON_CANONICAL,
        severity: "warning",
        message: `non-canonical Korean: write '${value}${canonical}' instead of '${value}${past}'`,
      });
    }
    return { kind: "assert", ...relationSubject(words[0] ?? "", "past", issues), value: expr(value) };
  }
  return null;
}

// The index of the first ':' outside a quoted text, or -1.
function colonAt(text: string): number {
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote && ch === "\\") i += 1;
    else if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === ":") return i;
  }
  return -1;
}

// Splits on `separator` outside quoted texts and parentheses.
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inQuote && ch === "\\") {
      current += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "(") depth += 1;
    if (!inQuote && ch === ")") depth -= 1;
    if (!inQuote && depth === 0 && text.startsWith(separator, i)) {
      parts.push(current.trim());
      current = "";
      i += separator.length - 1;
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

// Joins "X의" with the word after it: "위치의 가로는" is one phrase.
function mergeGenitives(words: readonly string[]): string[] {
  const merged: string[] = [];
  for (const word of words) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.endsWith("의") && previous.length > 1 && !previous.endsWith('"의')) {
      merged[merged.length - 1] = `${previous} ${word}`;
    } else {
      merged.push(word);
    }
  }
  return merged;
}

// _ | literal | name [name] [ "(" pattern, … ")" ]
function pattern(text: string): PatternAst {
  const usage = "a pattern is '_', a literal, a name, or a constructor with patterns: 'Some(x)'";
  if (text === "_") return { kind: "wildcard" };
  const open = text.indexOf("(");
  const head = (open < 0 ? text : text.slice(0, open)).trim();
  const number = open < 0 ? literal(head) : null;
  if (number?.kind === "float") fail(SENTENCE_CODES.BAD_MATCH, `'${head}': floats are never patterns (NaN is not equal to itself); compare with 보다 instead`);
  if (number?.kind === "int" && number.suffix) fail(SENTENCE_CODES.BAD_MATCH, `'${head}': a pattern literal takes the matched value's type; drop the suffix`);
  if (open < 0 && (number || head.startsWith('"') || head === "참" || head === "거짓")) {
    const value = expr(head);
    if (value.kind !== "int" && value.kind !== "text" && value.kind !== "bool" && value.kind !== "rune") fail(SENTENCE_CODES.BAD_MATCH, usage);
    return { kind: "literal", value };
  }
  const path = head.split(" ").filter((w) => w.length > 0);
  if (path.length === 0 || path.length > 2 || !path.every((w) => NOUN_PATTERN.test(w))) fail(SENTENCE_CODES.BAD_MATCH, usage);
  if (open < 0) return { kind: "name", path, args: null };
  if (!text.endsWith(")")) fail(SENTENCE_CODES.BAD_MATCH, `'${text}' is missing its closing ')'`);
  const inner = text.slice(open + 1, -1).trim();
  return { kind: "name", path, args: inner.length === 0 ? [] : splitTop(inner, ",").map(pattern) };
}

// [N은 E에 따라: 패턴 → 값, …]
function parseMatch(head: string[], tail: string, issues: SentenceIssue[]): ActAst {
  const usage = "a match is written '[N은 E에 따라: 패턴 → 값, …]'";
  const target = phrase(head[0] ?? "", issues);
  const scrutinee = phrase(head[1] ?? "", issues);
  if (target.role !== "subject" || scrutinee.role !== "target") fail(SENTENCE_CODES.BAD_MATCH, usage);
  const arms = tail.length === 0 ? [] : splitTop(tail, ",");
  const match: MatchAst = {
    kind: "match",
    scrutinee: expr(scrutinee.stem),
    arms: arms.map((arm) => {
      // '→', or '->' for keyboards without it; never inside a quoted text.
      const arrow = splitTop(arm, "→").length === 2 ? splitTop(arm, "→") : splitTop(arm, "->");
      if (arrow.length !== 2 || !arrow[0] || !arrow[1]) fail(SENTENCE_CODES.BAD_MATCH, `an arm is written '패턴 → 값', not '${arm}'`);
      return { pattern: pattern(arrow[0]), body: expr(arrow[1]) };
    }),
  };
  if (match.arms.length === 0) fail(SENTENCE_CODES.BAD_MATCH, `a match needs at least one arm: ${usage}`);
  return { kind: "match", target: noun(target.stem), match };
}

// [f: …], [ns f: …], [N은 f: …], [N과 M은 ns f: …]. Leading phrases with 과/와 and then
// 은/는/이/가 name the nouns that receive the results; one or two words name the callee.
function parseCall(words: string[], issues: SentenceIssue[]): ActAst {
  const usage = "a call is written '[이름: 인자, …]', '[이름공간 이름: 인자, …]' or '[N은 이름: 인자, …]'";
  const text = words.join(" ");
  const colon = colonAt(text);
  const head = mergeGenitives(text.slice(0, colon).trim().split(" ").filter((w) => w.length > 0));
  const tail = text.slice(colon + 1).trim();
  // [N은 E에 따라: …] is a match; a callable plane may still be called 따라.
  if (head.length === 3 && head[2] === "따라" && (head[1] ?? "").endsWith("에")) return parseMatch(head, tail, issues);
  const args = tail.length === 0 ? [] : splitTop(tail, ",");
  if (args.some((arg) => arg.length === 0)) fail(SENTENCE_CODES.BAD_CALL, `an argument is missing: ${usage}`);

  // Targets: phrases in 과/와, then one in 은/는/이/가; or none at all.
  // Lint belongs to a reading: '나이' is non-canonical as 나 + 이, but fine as a namespace.
  const targetsOf = (words: readonly string[], lint: SentenceIssue[]): string[] | null => {
    const found: string[] = [];
    for (const [i, word] of words.entries()) {
      const p = PARTICLES.find((x) => word.endsWith(x.form) && word.length > x.form.length);
      const role = i === words.length - 1 ? "subject" : "and";
      if (p?.role !== role) return null;
      const stem = phrase(word, lint).stem;
      if (!NOUN_PATTERN.test(stem) || RESERVED_WORDS.has(stem)) return null;
      found.push(stem);
    }
    return found;
  };
  const readings: CallReading[] = [];
  let twice: string | undefined;
  for (const size of [2, 1]) {
    const callee = head.slice(-size);
    if (callee.length !== size || !callee.every((w) => NOUN_PATTERN.test(w))) continue;
    const lint: SentenceIssue[] = [];
    const targets = targetsOf(head.slice(0, head.length - size), lint);
    if (!targets) continue;
    const repeated = targets.find((t, i) => targets.indexOf(t) !== i);
    if (repeated) {
      twice ??= repeated;
      continue;
    }
    readings.push({ targets, callee, lint });
  }
  if (readings.length === 0 && twice) fail(SENTENCE_CODES.BAD_CALL, `'${twice}' would receive two results; each result needs its own noun`);
  if (readings.length === 0) fail(SENTENCE_CODES.BAD_CALL, usage);
  // Named arguments (가로=3, 세로=4) build a record by field name, in any order.
  const NAMED = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u;
  const named = args.map((arg) => (arg.startsWith('"') ? null : arg.match(NAMED)));
  if (named.some((m) => m) && !named.every((m) => m)) fail(SENTENCE_CODES.BAD_CALL, "write every argument by name ('가로=3') or none");
  const fields = named.every((m) => m) && named.length > 0 ? named.map((m) => m?.[1] ?? "") : null;
  const call: CallAst = { kind: "call", readings, args: fields ? named.map((m) => expr((m?.[2] ?? "").trim())) : args.map(expr), fields };
  return { kind: "call", call };
}

function parseAct(words: string[], issues: SentenceIssue[]): ActAst {
  if (colonAt(words.join(" ")) >= 0) return parseCall(words, issues);
  const last = words[words.length - 1] ?? "";
  const rest = words.slice(0, -1);
  if (PAST_VERB_ENDINGS.some((ending) => last.endsWith(ending))) {
    fail(SENTENCE_CODES.VERB_TENSE, "verbs are present tense only (더한다, not 더했다); only states take tense");
  }

  if (words.length === 1 && last === "끝이다") {
    return { kind: "end" };
  }

  if (last === "이다") {
    fail(SENTENCE_CODES.WRONG_ROLES, "write the value and 이다 as one word: 'N은 3이다'");
  }
  if (last.endsWith("이다") && last.length > 2) {
    const value = last.slice(0, -2);
    if (rest.length !== 1) {
      fail(SENTENCE_CODES.WRONG_ROLES, "a statement is written 'N은 E이다' (one subject, one value)");
    }
    const subject = phrase(rest[0] ?? "", issues);
    if (subject.role !== "subject") {
      fail(SENTENCE_CODES.WRONG_ROLES, "a statement is written 'N은 E이다' (one subject, one value)");
    }
    if (subject.stem === "여기" && value === "처음") return { kind: "anchor" };
    if (subject.stem === "끝" && value === "처음") return { kind: "back" };
    if (value === "미정") return { kind: "declare", noun: noun(subject.stem) };
    return { kind: "assign", place: place(subject.stem), value: expr(value) };
  }

  const later = LATER_VERBS[last];
  if (later !== undefined) {
    fail(SENTENCE_CODES.FEATURE_LATER, `'${last}' (${later}) is not part of the present-tense core yet`);
  }
  if (!PRESENT_VERBS.has(last)) {
    fail(SENTENCE_CODES.UNKNOWN_SENTENCE, `unknown sentence: no known predicate '${last}'`);
  }

  if (last === "돌아간다") {
    if (rest.length > 0) fail(SENTENCE_CODES.BAD_RETURN, "'돌아간다' returns nothing and takes no phrases; to return values write 'E을 돌려준다'");
    return { kind: "return", values: [] };
  }
  if (last === "돌려준다") {
    // E을 돌려준다, E와 F를 돌려준다: every phrase but the last is joined by 과/와.
    const usage = "values are returned as 'E을 돌려준다' or 'E와 F를 돌려준다'";
    if (rest.length === 0) fail(SENTENCE_CODES.BAD_RETURN, `${usage}; '돌아간다' returns nothing`);
    const phrases = rest.map((word) => phrase(word, issues));
    phrases.forEach((p, i) => {
      if (p.role !== (i === phrases.length - 1 ? "object" : "and")) fail(SENTENCE_CODES.BAD_RETURN, usage);
    });
    return { kind: "return", values: phrases.map((p) => expr(p.stem)) };
  }

  const found = roles(rest, issues);
  switch (last) {
    case "더한다": {
      expectRoles(last, found, ["target", "object"], "N에 E을 더한다");
      return { kind: "add", place: place(found.get("target")?.stem ?? ""), amount: expr(found.get("object")?.stem ?? "") };
    }
    case "뺀다": {
      expectRoles(last, found, ["source", "object"], "N에서 E을 뺀다");
      return { kind: "subtract", place: place(found.get("source")?.stem ?? ""), amount: expr(found.get("object")?.stem ?? "") };
    }
    case "곱한다": {
      expectRoles(last, found, ["target", "object"], "N에 E을 곱한다");
      return { kind: "multiply", place: place(found.get("target")?.stem ?? ""), amount: expr(found.get("object")?.stem ?? "") };
    }
    case "나눈다": {
      expectRoles(last, found, ["object", "direction"], "N을 E로 나눈다");
      return { kind: "divide", place: place(found.get("object")?.stem ?? ""), amount: expr(found.get("direction")?.stem ?? "") };
    }
    case "온다": {
      expectRoles(last, found, ["subject", "source"], "N이 다음에서 온다");
      if (found.get("source")?.stem !== "다음") {
        fail(SENTENCE_CODES.WRONG_ROLES, "a value comes from the future: 'N이 다음에서 온다'");
      }
      return { kind: "receive", noun: noun(found.get("subject")?.stem ?? "") };
    }
    case "보낸다": {
      expectRoles(last, found, ["object", "direction"], "N을 전으로 보낸다");
      if (found.get("direction")?.stem !== "전") {
        fail(SENTENCE_CODES.WRONG_ROLES, "a value is sent to the past: 'N을 전으로 보낸다'");
      }
      return { kind: "send", noun: noun(found.get("object")?.stem ?? "") };
    }
    case "말한다": {
      expectRoles(last, found, ["object"], "E을 말한다");
      return { kind: "say", value: expr(found.get("object")?.stem ?? "") };
    }
    case "본다": {
      expectRoles(last, found, ["object"], "방향을 본다");
      const word = found.get("object")?.stem ?? "";
      const turnTo = TURN_WORDS[word];
      if (turnTo) return { kind: "turn", turn: turnTo };
      const compass = COMPASS_WORDS[word];
      if (compass) return { kind: "face", compass };
      fail(
        SENTENCE_CODES.UNKNOWN_DIRECTION,
        `'${word}' is not a direction to look: ${[...Object.keys(TURN_WORDS), ...Object.keys(COMPASS_WORDS)].join(", ")}`,
      );
    }
    default: {
      expectRoles(last, found, ["direction"], "방향으로 간다");
      const word = found.get("direction")?.stem ?? "";
      const relative = STEP_WORDS[word];
      if (relative) return { kind: "step", relative };
      const delta = FLOOR_WORDS[word];
      if (delta) return { kind: "floor", delta };
      fail(
        SENTENCE_CODES.UNKNOWN_DIRECTION,
        `'${word}' is not a direction to go: ${[...Object.keys(STEP_WORDS), ...Object.keys(FLOOR_WORDS)].join(", ")}`,
      );
    }
  }
}

const ORDERS: Readonly<Record<string, "lt" | "le" | "gt" | "ge">> = { 크면: "gt", 작으면: "lt", "크거나 같으면": "ge", "작거나 같으면": "le" };

function parseCondition(words: string[], issues: SentenceIssue[]): ConditionAst {
  const usage = "a condition is written 'N이 E이면', 'N이 E이 아니면' or 'N이 E보다 크면' (작으면, 크거나 같으면, 작거나 같으면)";
  const last = words[words.length - 1] ?? "";
  const ordering = last === "같으면" ? `${words[words.length - 2] ?? ""} 같으면` : last;
  const op = ORDERS[ordering];
  if (op) {
    const head = words.slice(0, ordering === last ? -1 : -2);
    if (head.length !== 2 || !(head[1] ?? "").endsWith("보다") || (head[1] ?? "").length <= 2) fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
    const left = phrase(head[0] ?? "", issues);
    if (left.role !== "subject") fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
    return { left: expr(left.stem), right: expr((head[1] ?? "").slice(0, -"보다".length)), negated: false, order: op };
  }
  if (last === "아니면") {
    if (words.length !== 3) fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
    const left = phrase(words[0] ?? "", issues);
    const right = phrase(words[1] ?? "", issues);
    if (left.role !== "subject" || right.role !== "subject") fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
    return { left: expr(left.stem), right: expr(right.stem), negated: true };
  }
  if (words.length !== 2) fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
  const left = phrase(words[0] ?? "", issues);
  if (left.role !== "subject") fail(SENTENCE_CODES.BAD_CONDITIONAL, usage);
  return { left: expr(left.stem), right: expr(last.slice(0, -"이면".length)), negated: false };
}

function isConditionEnd(word: string): boolean {
  return (
    word === "아니면" ||
    word === "크면" ||
    word === "작으면" ||
    word === "같으면" ||
    (word.endsWith("이면") && word.length > 2) ||
    word.endsWith("것이라면") ||
    word.endsWith("었다면")
  );
}

export function parseSentence(text: string): SentenceResult {
  const issues: SentenceIssue[] = [];
  try {
    const trimmed = text.trim();
    // A call is syntax, not prose: its full stop is optional.
    const isCall = colonAt(trimmed) >= 0;
    if (!trimmed.endsWith(".") && !isCall) {
      fail(SENTENCE_CODES.NO_FULL_STOP, "a sentence ends with '.'");
    }
    const body = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
    // "X의 Y…" is one noun phrase: a field (위치의 가로), an element (수들의 0번) or a
    // moment (처음의 N, 끝의 N).
    const words = mergeGenitives(eojeols(body));
    if (words.length === 0) {
      fail(SENTENCE_CODES.UNKNOWN_SENTENCE, "empty sentence");
    }

    // A condition can only come before a call's colon, never among its arguments.
    const callWord = words.findIndex((word) => colonAt(word) >= 0);
    const conditionEnd = words.findIndex((word, i) => (callWord < 0 || i < callWord) && isConditionEnd(word));
    if (conditionEnd < 0) {
      return { sentence: (isCall ? null : parseRelation(words, issues)) ?? parseAct(words, issues), issues };
    }
    const end = words[conditionEnd] ?? "";
    if (end.endsWith("것이라면")) {
      fail(SENTENCE_CODES.TEMPORAL_LATER, "future conditionals (일 것이라면) are experimental and not part of the core");
    }
    if (end.endsWith("었다면")) {
      fail(SENTENCE_CODES.TEMPORAL_LATER, "past conditionals (이었다면) are experimental and not part of the core");
    }
    const condition = parseCondition(words.slice(0, conditionEnd + 1), issues);
    const consequence = words.slice(conditionEnd + 1);
    if (consequence.length === 0) {
      fail(SENTENCE_CODES.BAD_CONDITIONAL, "a condition needs a consequence: 'N이 E이면 ⟨act⟩'");
    }
    if (consequence.some(isConditionEnd)) {
      fail(SENTENCE_CODES.BAD_CONDITIONAL, "a consequence cannot itself be conditional");
    }
    if (colonAt(consequence.join(" ")) < 0 && parseRelation(consequence, [])) {
      fail(SENTENCE_CODES.BAD_CONDITIONAL, "a consequence must be present tense; a relation cannot depend on a condition");
    }
    const then = parseAct(consequence, issues);
    if (then.kind === "anchor") {
      fail(SENTENCE_CODES.BAD_CONDITIONAL, "'여기가 처음이다' cannot be conditional; an anchor is a place");
    }
    return { sentence: { kind: "when", condition, then }, issues };
  } catch (error) {
    if (error instanceof SentenceError) {
      return { sentence: null, issues: [...issues, { code: error.code, severity: "error", message: error.message }] };
    }
    throw error;
  }
}
