import type { Compass, Relative, Turn } from "../space/orientation";
import { canonicalParticle, endingOf, type ParticlePair } from "./korean";
import type { ActAst, ConditionAst, Expr, RelationAst, SentenceAst, TimeAnchor } from "./sentence-ast";

// Parses one cell's sentence. Tense is read from the sentence-final form: present
// tense is an act (it executes), past and future tense are relations (they constrain).
// Forms that belong to later milestones are recognised and refused, never half-run.
// Particles assign roles, so word order is free.

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
];

type Role = "subject" | "object" | "target" | "source" | "direction";
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

const PRESENT_VERBS = new Set(["더한다", "뺀다", "말한다", "본다", "간다", "온다", "보낸다"]);
const LATER_VERBS: Readonly<Record<string, string>> = {
  곱한다: "multiplication",
  나눈다: "division",
  듣는다: "input",
};
const TIME_WORDS = new Set(["처음", "끝", "여기", "전", "다음"]);
const PAST_VERB_ENDINGS = ["했다", "뺐다", "갔다", "봤다", "보았다", "들었다", "왔다", "냈다"];

const NOUN_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;

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
    fail(SENTENCE_CODES.BAD_PHRASE, `'${word}' needs a particle (은/는, 이/가, 을/를, 에, 에서, 으로/로)`);
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

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

const ANCHORED = /^(처음|끝)의 (.+)$/u;

function noun(stem: string): string {
  if (ANCHORED.test(stem)) {
    fail(SENTENCE_CODES.ANCHOR_WRITE, `'${stem}' names a value at a moment in time; it can be read or constrained, never written`);
  }
  if (RESERVED_WORDS.has(stem)) {
    fail(SENTENCE_CODES.RESERVED_NOUN, `'${stem}' is a reserved word and cannot name a value`);
  }
  if (!NOUN_PATTERN.test(stem)) {
    fail(SENTENCE_CODES.BAD_PHRASE, `'${stem}' is not a noun, a number or a quoted text`);
  }
  return stem;
}

function expr(stem: string): Expr {
  const anchored = stem.match(ANCHORED);
  if (anchored) return { kind: "anchored", anchor: anchored[1] as TimeAnchor, name: noun(anchored[2] ?? "") };
  if (/^-?\d+$/.test(stem)) return { kind: "int", value: BigInt(stem) };
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

function parseAct(words: string[], issues: SentenceIssue[]): ActAst {
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
    return { kind: "assign", noun: noun(subject.stem), value: expr(value) };
  }

  const later = LATER_VERBS[last];
  if (later !== undefined) {
    fail(SENTENCE_CODES.FEATURE_LATER, `'${last}' (${later}) is not part of the present-tense core yet`);
  }
  if (!PRESENT_VERBS.has(last)) {
    fail(SENTENCE_CODES.UNKNOWN_SENTENCE, `unknown sentence: no known predicate '${last}'`);
  }

  const found = roles(rest, issues);
  switch (last) {
    case "더한다": {
      expectRoles(last, found, ["target", "object"], "N에 E을 더한다");
      return { kind: "add", noun: noun(found.get("target")?.stem ?? ""), amount: expr(found.get("object")?.stem ?? "") };
    }
    case "뺀다": {
      expectRoles(last, found, ["source", "object"], "N에서 E을 뺀다");
      return { kind: "subtract", noun: noun(found.get("source")?.stem ?? ""), amount: expr(found.get("object")?.stem ?? "") };
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

function parseCondition(words: string[], issues: SentenceIssue[]): ConditionAst {
  const usage = "a condition is written 'N이 E이면' or 'N이 E이 아니면'";
  const last = words[words.length - 1] ?? "";
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
  return word === "아니면" || (word.endsWith("이면") && word.length > 2) || word.endsWith("것이라면") || word.endsWith("었다면");
}

export function parseSentence(text: string): SentenceResult {
  const issues: SentenceIssue[] = [];
  try {
    const trimmed = text.trim();
    if (!trimmed.endsWith(".")) {
      fail(SENTENCE_CODES.NO_FULL_STOP, "a sentence ends with '.'");
    }
    // "처음의 N…" and "끝의 N…" are one noun phrase anchored in time.
    const words: string[] = [];
    for (const word of eojeols(trimmed.slice(0, -1))) {
      const previous = words[words.length - 1];
      if (previous === "처음의" || previous === "끝의") {
        words[words.length - 1] = `${previous} ${word}`;
      } else {
        words.push(word);
      }
    }
    if (words.length === 0) {
      fail(SENTENCE_CODES.UNKNOWN_SENTENCE, "empty sentence");
    }

    const conditionEnd = words.findIndex(isConditionEnd);
    if (conditionEnd < 0) {
      return { sentence: parseRelation(words, issues) ?? parseAct(words, issues), issues };
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
    if (parseRelation(consequence, [])) {
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
