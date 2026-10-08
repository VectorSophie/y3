// Terminal display width, so columns of Korean sentences line up. Wide (East Asian
// W/F) characters take two columns; combining marks take none.

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals and punctuation
  [0x3041, 0x33ff], // kana, CJK symbols
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f900, 0x1f9ff], // supplemental pictographs
  [0x20000, 0x3fffd], // CJK extensions B+
];

function inRanges(code: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high);
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x0300 && code <= 0x036f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) {
      continue;
    }
    width += inRanges(code, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}
