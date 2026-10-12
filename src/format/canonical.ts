import { DeclarationError, FOREIGN_KEYWORD, parseForeignDeclaration, parseSignature, parseTypeDeclaration, type TypeAst } from "../language/declarations";
import { parseSentence } from "../language/sentence-parser";
import { formatFloat } from "../semantics/values";

// Canonical text for what is written inside declarations and cells. Formatting must never
// change meaning, so every rewrite here is checked: a cell's canonical text is used only
// if it parses to exactly the same sentence as the original, and a declaration's or a
// signature's only if it parses at all (otherwise the text is kept as written).

const typeText = (t: TypeAst): string =>
  t.kind === "array" ? `[${typeText(t.element)}; ${t.length}]` : t.kind === "slice" ? `[]${typeText(t.element)}` : `${t.path.join(" ")}${t.args.length ? `<${t.args.map(typeText).join(", ")}>` : ""}`;

// "자료 점 = { 가로: i64, 세로: i64 }", "자료 모양<T> = 원(T) | 빈것".
export function canonicalDeclaration(text: string): string {
  try {
    if (text.startsWith(`${FOREIGN_KEYWORD} `)) {
      // 외부 씨 더하기 (a: i32, b: i32) → i32 = add 순수
      const f = parseForeignDeclaration(text);
      const params = f.params.map((p) => `${p.name}: ${p.out ? "출력 " : ""}${typeText(p.type)}`).join(", ");
      const attrs = [...(f.pure ? ["순수"] : []), ...(f.frees ? ["해제"] : [])];
      return [`${FOREIGN_KEYWORD} ${f.library} ${f.name} (${params})${f.result ? ` → ${typeText(f.result)}` : ""} = ${f.symbol}`, ...attrs].join(" ");
    }
    const d = parseTypeDeclaration(text);
    const head = `자료 ${d.name}${d.params.length ? `<${d.params.join(", ")}>` : ""} = `;
    if (d.body.kind === "record") return `${head}{ ${d.body.fields.map((f) => `${f.name}: ${typeText(f.type)}`).join(", ")} }`.replace("{  }", "{}");
    return head + d.body.variants.map((v) => (v.fields.length ? `${v.name}(${v.fields.map(typeText).join(", ")})` : v.name)).join(" | ");
  } catch (e) {
    if (e instanceof DeclarationError) return text;
    throw e;
  }
}

// "(수: i64, 밑: i64) → i64", "(가: i64) → (i64, i64)"; no arrow for Unit.
export function canonicalSignature(text: string): string {
  try {
    const s = parseSignature(text);
    const params = `(${s.params.map((p) => `${p.name}: ${typeText(p.type)}`).join(", ")})`;
    if (s.results.length === 0) return params;
    return `${params} → ${s.results.length === 1 ? typeText(s.results[0] as TypeAst) : `(${s.results.map(typeText).join(", ")})`}`;
  } catch (e) {
    if (e instanceof DeclarationError) return text.replace(/\s*->\s*/u, " → ");
    throw e;
  }
}

const NUMBER = /^(-?\d+(?:\.\d+(?:[eE][+-]?\d+)?)?)(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|bigint|f32|f64)?(.*)$/u;

// A numeric literal written its one way: no leading zeros, floats as the shortest text
// that reads back at their width. Anything after it (a particle, 번) is kept.
function canonicalNumber(word: string): string {
  const m = word.match(NUMBER);
  if (!m) return word;
  const [, digits, suffix = "", rest] = m as unknown as [string, string, string | undefined, string];
  if (!digits.includes(".") && suffix !== "f32" && suffix !== "f64") return `${BigInt(digits).toString()}${suffix}${rest}`;
  const width = suffix === "f32" ? 32 : 64;
  const value = width === 32 ? Math.fround(Number(digits)) : Number(digits);
  if (!Number.isFinite(value)) return word;
  return `${formatFloat(value, width)}${suffix}${rest}`;
}

// Splits on `separator` outside quotes and parentheses.
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote && ch === "\\") {
      current += ch + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') quote = !quote;
    if (!quote && ch === "(") depth += 1;
    if (!quote && ch === ")") depth -= 1;
    if (!quote && depth === 0 && text.startsWith(separator, i)) {
      parts.push(current);
      current = "";
      i += separator.length - 1;
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

const words = (text: string) => splitTop(text, " ").filter((w) => w.length > 0);
const canonicalWords = (text: string) => words(text).map((w) => (w.startsWith('"') || w.startsWith("'") ? w : canonicalNumber(w))).join(" ");

function canonicalArgument(arg: string): string {
  const a = arg.trim();
  const arm = splitTop(a, "→").length === 2 ? splitTop(a, "→") : splitTop(a, "->");
  if (arm.length === 2) return `${(arm[0] as string).trim()} → ${canonicalWords((arm[1] as string).trim())}`;
  const named = a.match(/^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u);
  if (named && !a.startsWith('"')) return `${named[1]}=${canonicalWords(named[2] as string)}`;
  return canonicalWords(a);
}

const same = (a: string, b: string) => {
  const parsed = (t: string) => JSON.stringify(parseSentence(t).sentence, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  const pa = parsed(a);
  return pa !== "null" && pa === parsed(b);
};

// The canonical text of a cell's sentence: one space after each comma in a call, named
// arguments as "이름=값", match arms as "패턴 → 값", canonical numeric literals. Kept as
// written if the rewrite would parse differently (or the sentence does not parse).
export function canonicalCell(text: string): string {
  let colon = -1;
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && quote) i += 1;
    else if (text[i] === '"') quote = !quote;
    else if (!quote && text[i] === ":") {
      colon = i;
      break;
    }
  }
  let candidate: string;
  if (colon < 0) {
    const stop = text.endsWith(".") ? "." : "";
    candidate = canonicalWords(stop ? text.slice(0, -1) : text) + stop;
  } else {
    const head = canonicalWords(text.slice(0, colon));
    const rawTail = text.slice(colon + 1).trim();
    const stop = rawTail.endsWith(".") && !rawTail.endsWith("..") ? "." : "";
    const tail = stop ? rawTail.slice(0, -1) : rawTail;
    const args = tail.trim().length === 0 ? [] : splitTop(tail, ",").map(canonicalArgument);
    candidate = `${head}:${args.length ? ` ${args.join(", ")}` : ""}${stop}`;
  }
  return candidate !== text && same(text, candidate) ? candidate : text;
}
