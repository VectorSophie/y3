import type { Compass, Relative, Turn } from "../space/orientation";
import type { NumericName } from "../types/types";

// The sentences Y3 understands, as parsed from Korean. Present-tense sentences are
// acts; past and future sentences are relations (M3). Nothing here is executable;
// semantics/elaborate.ts turns these into typed IR.

export type TimeAnchor = "처음" | "끝";

export type ExprAst =
  // A numeric literal may end with its type: 255u8, -1i128, 10bigint, 1.5f32.
  | { readonly kind: "int"; readonly value: bigint; readonly suffix?: NumericName }
  | { readonly kind: "float"; readonly value: number; readonly suffix?: NumericName }
  | { readonly kind: "rune"; readonly value: number } // '가', '\n'; a Unicode scalar value
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean } // 참, 거짓
  | { readonly kind: "noun"; readonly name: string } // a noun, or a constructor with no fields (None)
  | { readonly kind: "anchored"; readonly anchor: TimeAnchor; readonly name: string } // 처음의 N, 끝의 N
  | { readonly kind: "field"; readonly target: ExprAst; readonly name: string } // 위치의 가로
  | { readonly kind: "index"; readonly target: ExprAst; readonly index: ExprAst }; // 수들의 0번, 수들의 i번

// Where a value can be written: a noun, or a field or element inside one.
export type PlaceStep = { readonly kind: "field"; readonly name: string } | { readonly kind: "index"; readonly index: ExprAst };
export type PlaceAst = { readonly noun: string; readonly steps: readonly PlaceStep[] };

// [이름: 인자, …], [이름공간 이름: 인자, …]: an explicit call (or construction). The
// colon is a syntactic boundary, not prose.
//
// The words before the colon can sometimes be read two ways: [나이 계산: 3] is either
// namespace 나이 and callable 계산, or target 나(이) and callable 계산. Morphology alone
// cannot tell, so the parser keeps every well-formed reading (two-word callee first) and
// name resolution takes the namespaced one only when that namespace exists.
export type CallReading = {
  readonly targets: readonly string[]; // nouns that receive the results: 몫과 나머지는 …
  readonly callee: readonly string[]; // [name] or [namespace, name]
  // Orthography lint for this reading's particles, reported only if it is chosen.
  readonly lint: readonly { readonly code: string; readonly severity: "error" | "warning"; readonly message: string }[];
};
// `fields`: the names of named arguments ([점: 가로=3, 세로=4]), in the order written;
// null for positional arguments. A call uses one style or the other, never both.
export type CallAst = {
  readonly kind: "call";
  readonly readings: readonly CallReading[];
  readonly args: readonly ExprAst[];
  readonly fields: readonly string[] | null;
};

// A pattern in a match arm: _, a literal, or a name with optional sub-patterns. Whether
// a bare name binds a local or names a constructor (None) is decided by name resolution.
export type PatternAst =
  | { readonly kind: "wildcard" }
  | { readonly kind: "literal"; readonly value: ExprAst & { readonly kind: "int" | "text" | "bool" | "rune" } }
  | { readonly kind: "name"; readonly path: readonly string[]; readonly args: readonly PatternAst[] | null };

// [N은 E에 따라: 패턴 → 값, …]
export type MatchAst = {
  readonly kind: "match";
  readonly scrutinee: ExprAst;
  readonly arms: readonly { readonly pattern: PatternAst; readonly body: ExprAst }[];
};

export type ActAst =
  | { readonly kind: "assign"; readonly place: PlaceAst; readonly value: ExprAst } // N은 E이다, N의 F는 E이다
  | { readonly kind: "call"; readonly call: CallAst } // [f: …], [N은 f: …], [N과 M은 ns f: …]
  | { readonly kind: "match"; readonly target: string; readonly match: MatchAst } // [N은 E에 따라: …]
  | { readonly kind: "return"; readonly values: readonly ExprAst[] } // E을 돌려준다, E와 F를 돌려준다, 돌아간다
  | { readonly kind: "declare"; readonly noun: string } // N은 미정이다
  | { readonly kind: "add"; readonly place: PlaceAst; readonly amount: ExprAst } // N에 E을 더한다
  | { readonly kind: "subtract"; readonly place: PlaceAst; readonly amount: ExprAst } // N에서 E을 뺀다
  | { readonly kind: "multiply"; readonly place: PlaceAst; readonly amount: ExprAst } // N에 E을 곱한다
  | { readonly kind: "divide"; readonly place: PlaceAst; readonly amount: ExprAst } // N을 E로 나눈다
  | { readonly kind: "say"; readonly value: ExprAst } // E을 말한다
  | { readonly kind: "receive"; readonly noun: string } // N이 다음에서 온다
  | { readonly kind: "send"; readonly noun: string } // N을 전으로 보낸다
  | { readonly kind: "turn"; readonly turn: Turn } // 오른쪽을 본다 …
  | { readonly kind: "face"; readonly compass: Compass } // 동쪽을 본다 …
  | { readonly kind: "step"; readonly relative: Relative } // 앞으로 간다 …
  | { readonly kind: "floor"; readonly delta: 1 | -1 } // 위층으로 간다, 아래층으로 간다
  | { readonly kind: "anchor" } // 여기가 처음이다
  | { readonly kind: "back" } // 끝은 처음이다
  | { readonly kind: "end" }; // 끝이다

// Relations constrain instead of executing.
export type RelationAst =
  | { readonly kind: "assert"; readonly noun: string; readonly anchor: TimeAnchor | null; readonly value: ExprAst } // (처음의) N은 E이었다
  | { readonly kind: "promise"; readonly noun: string; readonly anchor: TimeAnchor | null; readonly value: ExprAst } // (끝의) N은 E일 것이다
  | { readonly kind: "fixed" }; // 처음은 끝이었다

// N이 E이면, N이 E이 아니면; or an ordering: N이 E보다 크면 (gt), 작으면 (lt),
// 크거나 같으면 (ge), 작거나 같으면 (le).
export type ConditionAst = {
  readonly left: ExprAst;
  readonly right: ExprAst;
  readonly negated: boolean;
  readonly order?: "lt" | "le" | "gt" | "ge";
};

export type SentenceAst = ActAst | RelationAst | { readonly kind: "when"; readonly condition: ConditionAst; readonly then: ActAst };
