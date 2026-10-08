import type { Compass, Relative, Turn } from "../space/orientation";

// The sentences Y3 understands, as parsed from Korean. Present-tense sentences are
// acts; past and future sentences are relations (M3). Nothing here is executable;
// semantics/ lowers these into operations.

export type Expr =
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "noun"; readonly name: string };

export type ActAst =
  | { readonly kind: "assign"; readonly noun: string; readonly value: Expr } // N은 E이다
  | { readonly kind: "declare"; readonly noun: string } // N은 미정이다
  | { readonly kind: "add"; readonly noun: string; readonly amount: Expr } // N에 E을 더한다
  | { readonly kind: "subtract"; readonly noun: string; readonly amount: Expr } // N에서 E을 뺀다
  | { readonly kind: "say"; readonly value: Expr } // E을 말한다
  | { readonly kind: "turn"; readonly turn: Turn } // 오른쪽을 본다 …
  | { readonly kind: "face"; readonly compass: Compass } // 동쪽을 본다 …
  | { readonly kind: "step"; readonly relative: Relative } // 앞으로 간다 …
  | { readonly kind: "floor"; readonly delta: 1 | -1 } // 위층으로 간다, 아래층으로 간다
  | { readonly kind: "anchor" } // 여기가 처음이다
  | { readonly kind: "back" } // 끝은 처음이다
  | { readonly kind: "end" }; // 끝이다

// Relations constrain instead of executing.
export type RelationAst =
  | { readonly kind: "assert"; readonly noun: string; readonly value: Expr } // N은 E이었다 / 였다
  | { readonly kind: "promise"; readonly noun: string; readonly value: Expr }; // N은 E일 것이다

export type ConditionAst = { readonly left: Expr; readonly right: Expr; readonly negated: boolean };

export type SentenceAst = ActAst | RelationAst | { readonly kind: "when"; readonly condition: ConditionAst; readonly then: ActAst };
