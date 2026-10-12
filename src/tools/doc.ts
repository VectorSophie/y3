import type { DocumentAst } from "../language/ast";
import { CALLABLES } from "../ir/callables";
import { DeclarationError, parseSignature, parseTypeDeclaration, type TypeAst } from "../language/declarations";
import { interpretManifest } from "../space/manifest";
import { formatType } from "../types/types";

// `y3 doc`: a module's documentation, extracted from its source (go doc, rustdoc in
// miniature). Comments written just before a declaration or a named plane are its doc
// comment. Output is plain text or JSON; there is no site generator.

export type DocModel = {
  readonly module: string;
  readonly imports: readonly { readonly alias: string; readonly from: string }[];
  readonly types: readonly {
    readonly name: string;
    readonly params: readonly string[];
    readonly kind: "record" | "sum" | "unparsed";
    readonly fields: readonly { readonly name: string; readonly type: string }[];
    readonly variants: readonly { readonly name: string; readonly fields: readonly string[] }[];
    readonly doc: string;
    readonly source: string;
  }[];
  readonly callables: readonly { readonly name: string; readonly signature: string; readonly params: readonly { readonly name: string; readonly type: string }[]; readonly results: readonly string[]; readonly doc: string }[];
  readonly planes: readonly { readonly name: string; readonly doc: string }[]; // floor plans for the volume
  readonly volume: number; // floors in the volume; 0 for a library
};

const typeText = (t: TypeAst): string =>
  t.kind === "array" ? `[${typeText(t.element)}; ${t.length}]` : t.kind === "slice" ? `[]${typeText(t.element)}` : `${t.path.join(" ")}${t.args.length ? `<${t.args.map(typeText).join(", ")}>` : ""}`;

export function documentModule(ast: DocumentAst, fallbackName: string): DocModel {
  const manifest = interpretManifest(ast.frontMatter?.text ?? null).manifest;
  const doc = (comments: readonly { text: string }[]) => comments.map((c) => c.text.trim()).join("\n");
  const types = (ast.appendix?.declarations ?? []).map((d) => {
    try {
      const decl = parseTypeDeclaration(d.text);
      return {
        name: decl.name,
        params: decl.params,
        kind: decl.body.kind,
        fields: decl.body.kind === "record" ? decl.body.fields.map((f) => ({ name: f.name, type: typeText(f.type) })) : [],
        variants: decl.body.kind === "sum" ? decl.body.variants.map((v) => ({ name: v.name, fields: v.fields.map(typeText) })) : [],
        doc: doc(d.comments),
        source: d.text,
      };
    } catch (e) {
      if (!(e instanceof DeclarationError)) throw e;
      return { name: d.name, params: [], kind: "unparsed" as const, fields: [], variants: [], doc: doc(d.comments), source: d.text };
    }
  });
  const definitions = ast.appendix?.definitions ?? [];
  const callables = definitions.flatMap((d) => {
    if (d.signature === null) return [];
    try {
      const s = parseSignature(d.signature);
      return [{ name: d.name, signature: d.signature, params: s.params.map((p) => ({ name: p.name, type: typeText(p.type) })), results: s.results.map(typeText), doc: doc(d.comments) }];
    } catch {
      return [{ name: d.name, signature: d.signature, params: [], results: [], doc: doc(d.comments) }];
    }
  });
  return {
    module: manifest?.name ?? fallbackName,
    imports: [...(manifest?.imports ?? new Map())].map(([alias, from]) => ({ alias, from })),
    types,
    callables,
    planes: definitions.filter((d) => d.signature === null).map((d) => ({ name: d.name, doc: doc(d.comments) })),
    volume: ast.volume.length,
  };
}

export function formatDoc(model: DocModel): string {
  const lines = [`module ${model.module}${model.volume === 0 ? " (library)" : ` (${model.volume} floor${model.volume === 1 ? "" : "s"})`}`];
  const docLines = (d: string) => (d ? d.split("\n").map((l) => `    ${l}`) : []);
  if (model.imports.length) lines.push("", "imports", ...model.imports.map((i) => `  ${i.alias} = ${i.from}`));
  if (model.types.length) {
    lines.push("", "types");
    for (const t of model.types) lines.push(`  ${t.source}`, ...docLines(t.doc));
  }
  if (model.callables.length) {
    lines.push("", "callable planes");
    for (const c of model.callables) lines.push(`  :${c.name}: ${c.signature}`, ...docLines(c.doc));
  }
  if (model.planes.length) {
    lines.push("", "named planes");
    for (const p of model.planes) lines.push(`  :${p.name}:`, ...docLines(p.doc));
  }
  return `${lines.join("\n")}\n`;
}

// The standard library, from its registry: the same source the type checker uses.
export function documentStandardLibrary(): { namespace: string; name: string; id: string; kind: string; signature: string }[] {
  return CALLABLES.map((c) => {
    const s = c.signature;
    const tp = s.typeParams.length ? `<${s.typeParams.map((t) => (s.bounds?.[t] ? `${t}: ${s.bounds[t]}` : t)).join(", ")}>` : "";
    const params = s.params.map((p) => formatType(p)).concat(s.rest ? [s.rest === "same" ? "T…" : "…"] : []);
    return { namespace: c.namespace, name: c.name, id: c.id, kind: c.kind, signature: `${tp}(${params.join(", ")}) → ${formatType(s.result)}` };
  });
}
