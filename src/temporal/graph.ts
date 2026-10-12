// The temporal constraint graph: what values must relate across time
// (docs/v2-compiler-pipeline.md §3). It is a record kept beside the spatial CFG, never
// inside it: the runtime extends it as either engine runs, through the same calls to the
// one temporal store. It solves nothing.

export type TemporalSymbolNode = {
  readonly label: string; // α1, β2, ε3
  readonly origin: "미정" | "다음" | "끝";
  readonly noun: string;
  readonly born: number; // step
  readonly frame: string | null; // the activation it was born in
};

export type TemporalConstraintNode = {
  readonly id: number;
  readonly step: number;
  readonly source: string; // past, promised at t3, channel S1, 끝의 N, 처음은 끝이었다
  readonly equation: string;
  readonly holds: boolean; // false: the constraint contradicted the others (PARADOX)
};

export type TemporalEdge =
  | { readonly kind: "mentions"; readonly constraint: number; readonly symbol: string }
  | { readonly kind: "resolves"; readonly constraint: number; readonly symbol: string; readonly value: string }
  | { readonly kind: "fills"; readonly symbol: string; readonly step: number } // a retroactive dependency
  | { readonly kind: "closes"; readonly symbol: string; readonly via: string }; // a cycle closed on it: SELF_CAUSED once determined

export type TemporalGraph = {
  readonly symbols: TemporalSymbolNode[];
  readonly constraints: TemporalConstraintNode[];
  readonly edges: TemporalEdge[];
};

export const emptyTemporalGraph = (): TemporalGraph => ({ symbols: [], constraints: [], edges: [] });
