// Facts about Korean that the grammar needs: whether a word ends in a final consonant
// (받침), and which particle allomorph is canonical after it.

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const RIEUL_FINAL = 8; // ㄹ as a final consonant

export type Ending = "vowel" | "rieul" | "consonant";

function syllableEnding(ch: string): Ending | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return null;
  const final = (code - HANGUL_FIRST) % 28;
  if (final === 0) return "vowel";
  return final === RIEUL_FINAL ? "rieul" : "consonant";
}

// Sino-Korean reading of the last word of an integer: 3 → 삼, 4 → 사, 10 → 십,
// 20 → 이십 (ends in 십), 1000 → 천, 0 → 영.
const DIGIT_READINGS = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];

function lastReading(digits: string): string {
  const trimmed = digits.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  if (/^0+$/.test(trimmed)) return "영";
  const last = Number(trimmed[trimmed.length - 1]);
  if (last !== 0) return DIGIT_READINGS[last] ?? "";
  const zeros = trimmed.length - trimmed.replace(/0+$/, "").length;
  if (zeros === 1) return "십";
  if (zeros === 2) return "백";
  if (zeros === 3) return "천";
  if (zeros <= 7) return "만";
  if (zeros <= 11) return "억";
  if (zeros <= 15) return "조";
  return "경";
}

// How a written word ends when read aloud, or null when that is unknown (e.g. Latin text).
export function endingOf(word: string): Ending | null {
  if (/^-?\d+$/.test(word)) {
    return syllableEnding(lastReading(word));
  }
  const unquoted = word.startsWith('"') && word.endsWith('"') && word.length >= 2 ? word.slice(1, -1) : word;
  const chars = [...unquoted];
  const last = chars[chars.length - 1];
  return last === undefined ? null : syllableEnding(last);
}

// Particle pairs whose choice depends only on the preceding sound (orthography, D4).
export type ParticlePair = "topic" | "subject" | "object" | "direction";

export const ALLOMORPHS: Readonly<Record<ParticlePair, { consonant: string; vowel: string }>> = {
  topic: { consonant: "은", vowel: "는" },
  subject: { consonant: "이", vowel: "가" },
  object: { consonant: "을", vowel: "를" },
  direction: { consonant: "으로", vowel: "로" },
};

export function canonicalParticle(pair: ParticlePair, ending: Ending): string {
  const forms = ALLOMORPHS[pair];
  if (ending === "vowel") return forms.vowel;
  if (ending === "rieul" && pair === "direction") return forms.vowel; // 길로, 1로
  return forms.consonant;
}
