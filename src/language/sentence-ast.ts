import type { Compass, Relative, Turn } from "../space/orientation";

// The sentences Y3 understands, as parsed from Korean. Present-tense sentences are
// acts; past and future sentences are relations (M3). Nothing here is executable;
// semantics/elaborate.ts turns these into typed IR.

export type TimeAnchor = "처음" | "끝";

export type ExprAst =
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean } // 참, 거짓
  | { readonly kind: "noun"; readonly name: string }
  | { readonly kind: "anchored"; readonly anchor: TimeAnchor; readonly name: string }; // 처음의 N, 끝의 N

// [이름공간 이름: 인자, …]: an explicit call. The colon is a syntactic boundary, not prose.
export type CallAst = { readonly kind: "call"; readonly namespace: string; readonly name: string; readonly args: readonly ExprAst[] };

export type ActAst =
  | { readonly kind: "assign"; readonly noun: string; readonly value: ExprAst | CallAst } // N은 E이다, [N은 ns f: …]
  | { readonly kind: "call"; readonly call: CallAst } // [ns f: …]
  | { readonly kind: "declare"; readonly noun: string } // N은 미정이다
  | { readonly kind: "add"; readonly noun: string; readonly amount: ExprAst } // N에 E을 더한다
  | { readonly kind: "subtract"; readonly noun: string; readonly amount: ExprAst } // N에서 E을 뺀다
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

export type ConditionAst = { readonly left: ExprAst; readonly right: ExprAst; readonly negated: boolean };

export type SentenceAst = ActAst | RelationAst | { readonly kind: "when"; readonly condition: ConditionAst; readonly then: ActAst };
