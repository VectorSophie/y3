import type { Span } from "../language/ast";
import type { CellId, DocumentId, NodeId, PlaneId } from "../ir/identity";
import type { Expr, NounId, Pattern, Stmt } from "../ir/hir";
import type { Body, CompiledProgram, Procedure } from "../ir/program";
import { CALLABLES, resolveCallable } from "../ir/callables";
import { BUILTIN_CONSTRUCTORS, nounsIn } from "../semantics/elaborate";
import { parseSentence } from "../language/sentence-parser";
import { parseSignature, parseTypeDeclaration, type TypeAst } from "../language/declarations";
import type { CallAst, ExprAst, MatchAst, PatternAst, PlaceAst, SentenceAst } from "../language/sentence-ast";
import { ALLOMORPHS, canonicalParticle, endingOf, type ParticlePair } from "../language/korean";
import { formatType, type TypeDef } from "../types/types";
import { renameTypeIn } from "../format/canonical";
import { documentStandardLibrary } from "../tools/doc";
import { callablePlane, EditError, hirNodes, type Command, type ProgramModel } from "./model";

// Editor services (docs/v2-lsp-services.md): definition, references, rename, hover,
// completion and semantic tokens. Each one reads the model and its current build: names
// are resolved by the compiler's own results (HIR noun ids, callable ids, declared
// types), never by searching text.

export type Location = { readonly document: DocumentId; readonly span: Span | null; readonly cell?: CellId; readonly node?: NodeId; readonly plane?: PlaneId };

export type SymbolRef =
  | { readonly kind: "noun"; readonly document: DocumentId; readonly body: string; readonly noun: NounId; readonly name: string }
  | { readonly kind: "local"; readonly document: DocumentId; readonly cell: CellId; readonly name: string } // a pattern binding, scoped to its arm
  | { readonly kind: "plane"; readonly plane: PlaneId; readonly name: string }
  | { readonly kind: "type"; readonly document: DocumentId; readonly name: string }
  | { readonly kind: "variant" | "field"; readonly document: DocumentId; readonly type: string; readonly name: string }
  | { readonly kind: "module"; readonly document: DocumentId; readonly alias: string }
  | { readonly kind: "builtin"; readonly id: string; readonly name: string };

export class RenameError extends Error {}

// ---- Words in source text.

type Word = { readonly text: string; readonly start: number; readonly end: number }; // offsets into the document

const WORD = /[\p{L}\p{N}_]+/gu;

function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l += 1) offset = text.indexOf("\n", offset) + 1;
  return offset + column - 1;
}
function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

// Words of a source range, outside string and rune literals.
function wordsIn(text: string, from: number, to: number): Word[] {
  const out: Word[] = [];
  const slice = text.slice(from, to);
  let quote: string | null = null;
  let i = 0;
  while (i < slice.length) {
    const ch = slice[i] as string;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    WORD.lastIndex = i;
    const m = WORD.exec(slice);
    if (m && m.index === i) {
      out.push({ text: m[0], start: from + i, end: from + i + m[0].length });
      i += m[0].length;
    } else i += 1;
  }
  return out;
}

// Particles and endings that follow a name in a sentence, longest first.
const SUFFIXES = ["이었다", "였다", "이다", "일", "에서", "으로", "에게", "보다", "에", "로", "의", "과", "와", "을", "를", "은", "는", "이", "가", "번", "다", "이면", "면"].sort((a, b) => b.length - a.length);

// A word's possible name stems: itself, then with one suffix removed.
function stems(word: string): string[] {
  const out = [word];
  for (const s of SUFFIXES) if (word.length > s.length && word.endsWith(s)) out.push(word.slice(0, -s.length));
  return out;
}

const ser = (x: unknown) => JSON.stringify(x, (k, v) => (k === "lint" ? undefined : typeof v === "bigint" ? `${v}n` : v));

// ---- The services.

export class EditorServices {
  constructor(private readonly model: ProgramModel) {}

  private program(document: DocumentId): CompiledProgram | null {
    return this.model.build(document).program;
  }

  // The body a cell's statements run in: the main volume, or a callable plane.
  private bodyOf(document: DocumentId, cell: CellId): { key: string; body: Body } | null {
    const program = this.program(document);
    if (!program) return null;
    const plane = this.model.getCell(cell).plane;
    for (const [id, p] of program.procedures) if (callablePlane(program, id) === plane) return { key: id, body: p };
    return { key: "main", body: program };
  }

  private constructors(document: DocumentId): Map<string, TypeDef> {
    const out = new Map<string, TypeDef>();
    for (const def of this.program(document)?.types ?? []) {
      if (def.kind === "sum") for (const v of def.variants) out.set(v.name, def);
      if (def.kind === "product") out.set(def.name, def);
    }
    return out;
  }

  // What the word at a position names.
  symbolAt(document: DocumentId, line: number, column: number): SymbolRef | null {
    const doc = this.model.getDocument(document);
    const e = this.model.elementAt(document, line, column);
    if (!e) return null;
    const offset = offsetOf(doc.text, line, column);
    const span = e.span;
    const words = wordsIn(doc.text, offsetOf(doc.text, span.start.line, span.start.column), offsetOf(doc.text, span.end.line, span.end.column));
    const word = words.find((w) => offset >= w.start && offset < w.end);
    if (!word) return null;
    if (e.kind === "plane" || e.kind === "reference") {
      const plane = e.kind === "plane" ? e.plane : e.plane;
      if (plane) {
        const v = this.model.getPlane(plane);
        if (v.name === word.text) return { kind: "plane", plane, name: v.name };
      }
      if (e.kind === "plane") return this.typeSymbol(document, word.text);
      return null;
    }
    if (e.kind === "declaration") return this.declarationSymbol(document, e.node, word.text);
    if (e.kind !== "cell") return null;
    return this.resolveWord(document, e.cell, word.text, words.indexOf(word) > 0 ? (words[words.indexOf(word) - 1] as Word).text : null);
  }

  private typeSymbol(document: DocumentId, name: string): SymbolRef | null {
    return (this.program(document)?.types ?? []).some((t) => t.name === name) ? { kind: "type", document, name } : null;
  }

  private declarationSymbol(document: DocumentId, node: NodeId, word: string): SymbolRef | null {
    const t = this.typeSymbol(document, word);
    if (t) return t;
    for (const def of this.program(document)?.types ?? []) {
      if (def.kind === "sum" && def.variants.some((v) => v.name === word)) return { kind: "variant", document, type: def.name, name: word };
      if (def.kind === "product" && def.fields.some((f) => f.name === word)) return { kind: "field", document, type: def.name, name: word };
    }
    void node;
    return null;
  }

  private resolveWord(document: DocumentId, cell: CellId, word: string, previous: string | null): SymbolRef | null {
    const where = this.bodyOf(document, cell);
    const stmt = this.model.statements(document).get(cell);
    const program = this.program(document);
    for (const stem of stems(word)) {
      // A name after a namespace: a callable of that namespace or module.
      if (previous !== null) {
        const builtin = resolveCallable(previous, stem);
        if (builtin.kind === "found") return { kind: "builtin", id: builtin.callable.id, name: stem };
      }
      if (stmt && localsOf(stmt).has(stem)) return { kind: "local", document, cell, name: stem };
      const noun = where?.body.nouns.find((n) => n.name === stem);
      if (noun && stmt && nounIdsOf(stmt).has(noun.id)) return { kind: "noun", document, body: where?.key as string, noun: noun.id, name: stem };
      if (program && stmt) {
        for (const [id, p] of program.procedures) {
          if (p.name !== stem || !callsOf(stmt).has(id)) continue;
          const plane = callablePlane(program, id);
          if (plane) return { kind: "plane", plane, name: stem };
        }
      }
      if (this.model.getModule(this.model.moduleOfDocument(document)).imports.some((i) => i.alias === stem)) return { kind: "module", document, alias: stem };
      const ctor = this.constructors(document).get(stem);
      if (ctor) return ctor.kind === "product" ? { kind: "type", document, name: stem } : { kind: "variant", document, type: ctor.name, name: stem };
      const builtinCtor = BUILTIN_CONSTRUCTORS.get(stem);
      if (builtinCtor) return builtinCtor.variant ? { kind: "variant", document, type: builtinCtor.typeName, name: stem } : { kind: "type", document, name: stem };
      for (const def of program?.types ?? []) if (def.kind === "product" && def.fields.some((f) => f.name === stem)) return { kind: "field", document, type: def.name, name: stem };
    }
    return null;
  }

  // ---- Definition and references.

  definition(symbol: SymbolRef): Location | null {
    switch (symbol.kind) {
      case "noun": {
        // The first statement, in source order, that gives the noun a value or declares it.
        const cells = this.bodyCells(symbol.document, symbol.body);
        const first = cells.filter(({ stmt }) => nounsIn(stmt).introduces.includes(symbol.noun)).sort((a, b) => order(a.stmt, b.stmt))[0];
        return first ? this.stmtLocation(symbol.document, first.cell, first.stmt) : null;
      }
      case "local":
        return this.stmtLocation(symbol.document, symbol.cell, this.model.statements(symbol.document).get(symbol.cell) as Stmt);
      case "plane": {
        const v = this.model.getPlane(symbol.plane);
        return { document: v.document, span: v.span, plane: symbol.plane };
      }
      case "type":
      case "variant":
      case "field": {
        const want = symbol.kind === "type" ? symbol.name : symbol.type;
        const d = this.model.getDocument(symbol.document);
        for (const node of this.declarationNodes(symbol.document)) {
          if (declaredName(node.text) === want) return { document: d.id, span: node.span, node: node.node };
        }
        return null;
      }
      case "module": {
        const m = this.model.getModule(this.model.moduleOfDocument(symbol.document)).imports.find((i) => i.alias === symbol.alias);
        if (!m?.module) return null;
        const doc = this.model.getModule(m.module).document;
        return { document: doc, span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } };
      }
      case "builtin":
        return null; // the standard library has no source in the model
    }
  }

  references(symbol: SymbolRef): Location[] {
    switch (symbol.kind) {
      case "noun":
        return this.bodyCells(symbol.document, symbol.body)
          .filter(({ stmt }) => nounIdsOf(stmt).has(symbol.noun))
          .sort((a, b) => order(a.stmt, b.stmt))
          .map(({ cell, stmt }) => this.stmtLocation(symbol.document, cell, stmt));
      case "local":
        return [this.stmtLocation(symbol.document, symbol.cell, this.model.statements(symbol.document).get(symbol.cell) as Stmt)];
      case "plane": {
        const v = this.model.getPlane(symbol.plane);
        const placements = v.floors.map((z) => ({ document: v.document, span: null, plane: symbol.plane, floor: z }));
        const calls = this.model.referencesToPlane(symbol.plane).map((cell) => {
          const c = this.model.getCell(cell);
          return { document: c.document, span: c.span, cell, ...(c.node ? { node: c.node } : {}) };
        });
        return [...calls, ...placements.map(({ floor: _, ...l }) => l)];
      }
      case "type":
      case "variant":
      case "field": {
        const out: Location[] = [];
        for (const node of this.declarationNodes(symbol.document)) if (mentions(node.text, symbol.name)) out.push({ document: symbol.document, span: node.span, node: node.node });
        for (const [cell, stmt] of this.model.statements(symbol.document)) {
          const hit = hirNodes(stmt, cell, stmt.at.ids?.node as NodeId).some(({ item }) =>
            symbol.kind === "field" ? item.node === "Field" || item.node === "SetField" ? item.field === symbol.name : false : (item.node === "Construct" && (item.variant === symbol.name || (item.variant === null && item.typeName === symbol.name))) || patternMentions(item, symbol.name),
          );
          if (hit) out.push(this.stmtLocation(symbol.document, cell, stmt));
        }
        return out;
      }
      case "module":
        return [...this.model.statements(symbol.document)]
          .filter(([cell]) => (this.model.getCell(cell).sentence ?? "").split(/\s+/).some((w) => w === symbol.alias))
          .map(([cell, stmt]) => this.stmtLocation(symbol.document, cell, stmt));
      case "builtin":
        return this.model
          .documents()
          .flatMap((d) => [...this.model.statements(d)].filter(([cell, stmt]) => hirNodes(stmt, cell, stmt.at.ids?.node as NodeId).some(({ item }) => item.node === "Call" && item.callee === symbol.id)).map(([cell, stmt]) => this.stmtLocation(d, cell, stmt)));
    }
  }

  // By HIR NodeId: what the node refers to.
  symbolOfNode(node: NodeId): SymbolRef | null {
    const n = this.model.hirNode(node);
    if (!n) return null;
    const c = this.model.getCell(n.cell);
    const where = this.bodyOf(c.document, n.cell);
    const item = n.item;
    const nounId = "noun" in item ? item.noun : null;
    if (nounId !== null && where) {
      const noun = where.body.nouns.find((x) => x.id === nounId);
      if (noun) return { kind: "noun", document: c.document, body: where.key, noun: noun.id, name: noun.name };
    }
    if (item.node === "CallPlane") {
      const program = this.program(c.document);
      const plane = program ? callablePlane(program, item.plane) : null;
      if (plane) return { kind: "plane", plane, name: this.model.getPlane(plane).name as string };
    }
    if (item.node === "Call") return { kind: "builtin", id: item.callee, name: item.callee };
    if (item.node === "Construct") return item.variant ? { kind: "variant", document: c.document, type: item.typeName, name: item.variant } : { kind: "type", document: c.document, name: item.typeName };
    if (item.node === "Field" || item.node === "SetField") return { kind: "field", document: c.document, type: formatType(item.record.type), name: item.field };
    if (item.node === "LoadLocal") return { kind: "local", document: c.document, cell: n.cell, name: item.local };
    return null;
  }

  definitionOf(node: NodeId): Location | null {
    const s = this.symbolOfNode(node);
    return s ? this.definition(s) : null;
  }

  referencesOf(node: NodeId): Location[] {
    const s = this.symbolOfNode(node);
    return s ? this.references(s) : [];
  }

  private bodyCells(document: DocumentId, body: string): { cell: CellId; stmt: Stmt }[] {
    const program = this.program(document);
    if (!program) return [];
    const b: Body | Procedure | undefined = body === "main" ? program : program.procedures.get(body);
    const seen = new Set<CellId>();
    const out: { cell: CellId; stmt: Stmt }[] = [];
    for (const stmt of b?.cells.values() ?? []) {
      const cell = stmt.at.ids?.cell;
      if (cell && !seen.has(cell)) {
        seen.add(cell);
        out.push({ cell, stmt });
      }
    }
    return out;
  }

  private stmtLocation(document: DocumentId, cell: CellId, stmt: Stmt): Location {
    return { document, span: this.model.getCell(cell).span, cell, ...(stmt?.at.ids?.node ? { node: stmt.at.ids.node } : {}) };
  }

  private declarationNodes(document: DocumentId): { node: NodeId; text: string; span: Span }[] {
    const d = this.model.getDocument(document);
    const out: { node: NodeId; text: string; span: Span }[] = [];
    const lines = d.text.split("\n");
    lines.forEach((text, i) => {
      const e = this.model.elementAt(document, i + 1, 1 + (text.length - text.trimStart().length));
      if (e?.kind === "declaration" && !out.some((o) => o.node === e.node)) out.push({ node: e.node, text: text.trim(), span: e.span });
    });
    return out;
  }

  // ---- Hover.

  hover(document: DocumentId, line: number, column: number): string | null {
    const s = this.symbolAt(document, line, column);
    if (!s) return null;
    switch (s.kind) {
      case "noun": {
        const program = this.program(document);
        const body = s.body === "main" ? program : program?.procedures.get(s.body);
        const noun = body?.nouns.find((n) => n.id === s.noun);
        const temporal = this.temporalRole(document, s);
        return `${s.name}: ${noun ? formatType(noun.type) : "?"}${temporal ? ` — ${temporal}` : ""}${s.body === "main" ? "" : ` (in ${s.body})`}`;
      }
      case "local":
        return `${s.name}: a name bound by a match pattern in this cell`;
      case "plane": {
        const v = this.model.getPlane(s.plane);
        return v.kind === "callable" ? `:${v.name}: ${v.signature} — callable plane` : `:${v.name}: — named plane, ${v.width}×${v.height}, on floor${v.floors.length === 1 ? "" : "s"} ${v.floors.join(", ") || "none"}`;
      }
      case "type":
      case "variant":
      case "field": {
        const def = this.definition(s);
        const text = def?.node ? this.declarationNodes(document).find((n) => n.node === def.node)?.text : null;
        const what = s.kind === "type" ? "type" : s.kind === "variant" ? `variant of ${s.type}` : `field of ${s.type}`;
        return `${s.name} — ${what}${text ? `\n${text}` : ""}`;
      }
      case "module": {
        const m = this.model.getModule(this.model.moduleOfDocument(document)).imports.find((i) => i.alias === s.alias);
        const name = m?.module ? this.model.getModule(m.module).name : null;
        return `${s.alias} — module ${name ?? m?.spec ?? "?"} (${m?.spec})`;
      }
      case "builtin": {
        const entry = documentStandardLibrary().find((c) => c.id === s.id);
        return entry ? `${entry.namespace} ${entry.name}: ${entry.signature} — ${entry.id}` : s.id;
      }
    }
  }

  // How a noun takes part in time, as the statements say (no run needed).
  private temporalRole(document: DocumentId, s: Extract<SymbolRef, { kind: "noun" }>): string | null {
    const roles = new Set<string>();
    for (const { stmt } of this.bodyCells(document, s.body)) {
      const visit = (x: Stmt) => {
        if (x.node === "Branch") return visit(x.then);
        if (!("noun" in x) || x.noun !== s.noun) return;
        if (x.node === "TemporalDeclare") roles.add("temporal unknown (미정)");
        if (x.node === "TemporalAssert") roles.add("stated in the past");
        if (x.node === "TemporalPromise") roles.add("promised for the future");
        if (x.node === "TemporalReceive") roles.add("receives a value from later");
        if (x.node === "TemporalSend") roles.add("sends a value back");
      };
      visit(stmt);
    }
    return roles.size ? [...roles].join(", ") : null;
  }

  // ---- Completion.

  completion(document: DocumentId, line: number, column: number): { label: string; kind: string; detail: string }[] {
    const doc = this.model.getDocument(document);
    const e = this.model.elementAt(document, line, column) ?? this.model.elementAt(document, line, Math.max(1, column - 1));
    const offset = offsetOf(doc.text, line, column);
    const lineStart = offsetOf(doc.text, line, 1);
    const before = wordsIn(doc.text, lineStart, offset);
    const last = before[before.length - 1];
    const typing = last && last.end === offset ? last.text : "";
    const previous = typing ? before[before.length - 2]?.text : last?.text;
    const items: { label: string; kind: string; detail: string }[] = [];
    const add = (label: string, kind: string, detail: string) => {
      if (label.startsWith(typing) && !items.some((i) => i.label === label && i.kind === kind)) items.push({ label, kind, detail });
    };
    // After a namespace: its callables.
    const inNamespace = previous ? CALLABLES.filter((c) => c.namespace === previous) : [];
    if (inNamespace.length > 0) {
      for (const c of inNamespace) add(c.name, "callable", c.id);
      return items.sort(byLabel);
    }
    const program = this.program(document);
    if (e?.kind === "declaration") {
      for (const t of program?.types ?? []) add(t.name, "type", "declared type");
      for (const p of ["i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "bigint", "f32", "f64", "Bool", "Text", "Rune", "Unit", "Option", "Result", "List", "Map", "Set"]) add(p, "type", "built-in type");
      return items.sort(byLabel);
    }
    if (e?.kind === "cell") {
      const where = this.bodyOf(document, e.cell);
      for (const n of where?.body.nouns ?? []) add(n.name, "noun", formatType(n.type));
    }
    for (const p of program?.procedures.values() ?? []) if (p.module === "main") add(p.name, "callable", `callable plane ${p.id}`);
    for (const i of this.model.getModule(this.model.moduleOfDocument(document)).imports) add(i.alias, "module", i.spec);
    for (const ns of new Set(CALLABLES.map((c) => c.namespace))) add(ns, "module", "standard library");
    for (const [name, ctor] of [...BUILTIN_CONSTRUCTORS].map(([n, c]) => [n, c.typeName] as const)) add(name, "variant", ctor);
    for (const def of program?.types ?? []) {
      if (def.kind === "sum") for (const v of def.variants) add(v.name, "variant", def.name);
      if (def.kind === "product") {
        add(def.name, "type", "record");
        for (const f of def.fields) add(f.name, "field", def.name);
      }
    }
    return items.sort(byLabel);
  }

  // ---- Semantic tokens.

  semanticTokens(document: DocumentId): { line: number; column: number; length: number; type: TokenType }[] {
    const doc = this.model.getDocument(document);
    const out: { line: number; column: number; length: number; type: TokenType }[] = [];
    if (doc.broken) return out;
    const push = (start: number, end: number, type: TokenType) => {
      const p = positionOf(doc.text, start);
      out.push({ line: p.line, column: p.column, length: end - start, type });
    };
    const lines = doc.text.split("\n");
    let lineStart = 0;
    lines.forEach((text, i) => {
      // A comment is what the parser says is one: a '#' inside a cell is part of its sentence.
      const hash = commentStart(text);
      if (hash >= 0 && this.model.elementAt(document, i + 1, hash + 1)?.kind === "comment") push(lineStart + hash, lineStart + text.length, "comment");
      lineStart += text.length + 1;
    });
    for (const plane of doc.planes) {
      for (const row of this.model.getPlane(plane).cells) {
        for (const cell of row) {
          const c = this.model.getCell(cell);
          if (!c.span || c.blank) continue;
          const from = offsetOf(doc.text, c.span.start.line, c.span.start.column);
          const to = offsetOf(doc.text, c.span.end.line, c.span.end.column);
          literals(doc.text, from, to).forEach(([s, e]) => push(s, e, "literal"));
          const words = wordsIn(doc.text, from, to);
          words.forEach((w, k) => {
            const type = /^\d/.test(w.text) ? "literal" : this.tokenType(document, cell, w.text, k > 0 ? (words[k - 1] as Word).text : null);
            if (type) push(w.start, w.end, type);
          });
        }
      }
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  private tokenType(document: DocumentId, cell: CellId, word: string, previous: string | null): TokenType | null {
    if (TEMPORAL.has(word)) return "temporal";
    if (KEYWORDS.has(word)) return "keyword";
    const s = this.resolveWord(document, cell, word, previous);
    if (s) return s.kind === "noun" || s.kind === "local" ? "noun" : s.kind === "plane" ? "plane" : s.kind === "builtin" ? "callable" : s.kind === "variant" ? "variant" : s.kind === "field" ? "field" : s.kind === "module" ? "module" : "type";
    if (CALLABLES.some((c) => c.namespace === word)) return "module";
    if (stems(word).some((x) => TEMPORAL.has(x))) return "temporal";
    if (word.endsWith("였다") || word.endsWith("이었다")) return "temporal";
    return null;
  }

  // ---- Rename.

  // Renames a symbol everywhere it is meant, as one transaction, then checks that the
  // program has no new errors (else the edit is undone). Returns the commands applied.
  rename(symbol: SymbolRef, to: string): Command[] {
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(to)) throw new RenameError(`'${to}' is not a name`);
    const commands = this.renameCommands(symbol, to);
    // Errors by owner, not by count: one error fixed and another made would balance a count.
    // An error is owned by its document, code and element (cell, else plane); messages and
    // spans change with the rename itself, so they are not part of it.
    const errors = () => {
      const keys = new Map<string, number>();
      for (const d of this.model.documents()) {
        for (const x of this.model.diagnostics(d)) {
          if (x.severity !== "error") continue;
          const key = `${x.document}|${x.code}|${x.cell ?? x.plane ?? x.path ?? "-"}`;
          keys.set(key, (keys.get(key) ?? 0) + 1);
        }
      }
      return keys;
    };
    const before = errors();
    if (commands.length === 0) return [];
    try {
      this.model.apply(commands);
    } catch (e) {
      if (e instanceof EditError) throw new RenameError(e.message);
      throw e;
    }
    const after = errors();
    if ([...after].some(([key, n]) => n > (before.get(key) ?? 0))) {
      this.model.undo();
      throw new RenameError(`renaming '${symbol.kind === "builtin" ? symbol.id : symbol.kind === "module" ? symbol.alias : symbol.name}' to '${to}' would break the program: the new name is taken or captured`);
    }
    return commands;
  }

  private renameCommands(symbol: SymbolRef, to: string): Command[] {
    switch (symbol.kind) {
      case "noun": {
        const program = this.program(symbol.document);
        const body = symbol.body === "main" ? program : program?.procedures.get(symbol.body);
        if (body?.nouns.some((n) => n.name === to)) throw new RenameError(`'${to}' is already a noun here`);
        const ctors = this.constructors(symbol.document);
        const out: Command[] = [];
        for (const { cell } of this.bodyCells(symbol.document, symbol.body)) {
          const text = this.model.getCell(cell).sentence;
          if (text === null) continue;
          const next = rewriteSentence(text, (ast) => renameNoun(ast, symbol.name, to, (n) => ctors.has(n) || BUILTIN_CONSTRUCTORS.has(n)), symbol.name, to);
          if (next !== text) out.push({ kind: "EditSentence", cell, sentence: next });
        }
        // A callable plane's parameter is declared in its signature.
        if (symbol.body !== "main" && program) {
          const plane = callablePlane(program, symbol.body);
          const v = plane ? this.model.getPlane(plane) : null;
          if (plane && v?.signature) {
            const sig = parseSignature(v.signature);
            if (sig.params.some((p) => p.name === symbol.name)) out.push({ kind: "EditSignature", plane, signature: v.signature.replace(new RegExp(`(^|[(,]\\s*)${escape(symbol.name)}(\\s*:)`, "u"), `$1${to}$2`) });
          }
        }
        return out;
      }
      case "plane": {
        const v = this.model.getPlane(symbol.plane);
        const out: Command[] = [{ kind: "RenamePlane", plane: symbol.plane, name: to }];
        if (v.kind !== "callable") return out;
        for (const cell of this.model.referencesToPlane(symbol.plane)) {
          const c = this.model.getCell(cell);
          const alias = c.document === v.document ? null : this.model.getModule(c.module).imports.find((i) => i.module === this.model.moduleOfDocument(v.document))?.alias ?? null;
          const next = rewriteSentence(c.sentence as string, (ast) => renameCallee(ast, alias, symbol.name, to), symbol.name, to);
          if (next !== c.sentence) out.push({ kind: "EditSentence", cell, sentence: next });
        }
        return out;
      }
      case "type": {
        if ((this.program(symbol.document)?.types ?? []).some((t) => t.name === to)) throw new RenameError(`a type '${to}' already exists`);
        const out: Command[] = [];
        for (const d of this.declarationNodes(symbol.document)) {
          const next = renameTypeIn(d.text, "declaration", symbol.name, to);
          if (next !== null && next !== d.text) out.push({ kind: "EditDeclaration", node: d.node, text: next });
        }
        for (const plane of this.model.getDocument(symbol.document).planes) {
          const v = this.model.getPlane(plane);
          if (!v.signature) continue;
          const next = renameTypeIn(v.signature, "signature", symbol.name, to);
          if (next !== null && next !== v.signature) out.push({ kind: "EditSignature", plane, signature: next });
        }
        // A record's name is also its constructor.
        const def = this.program(symbol.document)?.types.find((t) => t.name === symbol.name);
        if (def?.kind === "product") {
          for (const [cell] of this.model.statements(symbol.document)) {
            const text = this.model.getCell(cell).sentence as string;
            const next = rewriteSentence(text, (ast) => renameCallee(ast, null, symbol.name, to), symbol.name, to);
            if (next !== text) out.push({ kind: "EditSentence", cell, sentence: next });
          }
        }
        return out;
      }
      default:
        throw new RenameError(`renaming a ${symbol.kind} is not supported yet`);
    }
  }
}

export type TokenType = "keyword" | "type" | "module" | "plane" | "callable" | "noun" | "field" | "variant" | "literal" | "comment" | "temporal";

const KEYWORDS = new Set(["말한다", "간다", "본다", "끝이다", "돌려준다", "돌아간다", "더한다", "뺀다", "곱한다", "나눈다", "따라", "이다", "아니면", "앞으로", "뒤로", "왼쪽으로", "오른쪽으로", "위로", "아래로", "위층으로", "아래층으로", "동쪽을", "서쪽을", "남쪽을", "북쪽을", "왼쪽을", "오른쪽을", "위를", "아래를", "뒤를", "앞을", "참", "거짓"]);
const TEMPORAL = new Set(["처음", "끝", "처음의", "끝의", "처음이다", "처음은", "끝은", "끝이었다", "미정이다", "다음에서", "온다", "전으로", "보낸다", "것이다", "일", "여기가"]);

const byLabel = (a: { label: string; kind: string }, b: { label: string; kind: string }) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const order = (a: Stmt, b: Stmt) => a.at.span.start.line - b.at.span.start.line || a.at.span.start.column - b.at.span.start.column || a.at.cell.z - b.at.cell.z;

function commentStart(line: string): number {
  let quote = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quote = !quote;
    if (!quote && line[i] === "#") return i;
  }
  return -1;
}

function literals(text: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const s = text.slice(from, to);
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push([from + m.index, from + m.index + m[0].length]);
  return out;
}

function declaredName(text: string): string | null {
  try {
    return parseTypeDeclaration(text).name;
  } catch {
    return null;
  }
}

function mentions(declaration: string, name: string): boolean {
  try {
    const d = parseTypeDeclaration(declaration);
    const inType = (t: TypeAst): boolean => (t.kind === "name" ? t.path.includes(name) || t.args.some(inType) : inType(t.element));
    return d.name === name || (d.body.kind === "record" ? d.body.fields.some((f) => f.name === name || inType(f.type)) : d.body.variants.some((v) => v.name === name || v.fields.some(inType)));
  } catch {
    return false;
  }
}

function patternMentions(item: Stmt | Expr, name: string): boolean {
  if (item.node !== "Match") return false;
  const go = (p: Pattern): boolean => (p.kind === "variant" ? p.variant === name || p.fields.some(go) : p.kind === "record" ? p.type === name || p.fields.some(go) : false);
  return item.arms.some((a) => go(a.pattern));
}

// Noun ids a statement reads or writes.
function nounIdsOf(stmt: Stmt): Set<NounId> {
  const n = nounsIn(stmt);
  return new Set([...n.introduces, ...n.uses]);
}

// Names bound by match patterns in a statement.
function localsOf(stmt: Stmt): Set<string> {
  const out = new Set<string>();
  const go = (p: Pattern) => {
    if (p.kind === "bind") out.add(p.local);
    if (p.kind === "variant" || p.kind === "record") p.fields.forEach(go);
  };
  for (const n of hirNodes(stmt, "" as CellId, "" as NodeId)) if (n.item.node === "Match") n.item.arms.forEach((a) => go(a.pattern));
  return out;
}

function callsOf(stmt: Stmt): Set<string> {
  const out = new Set<string>();
  const go = (s: Stmt): void => void (s.node === "CallPlane" ? out.add(s.plane) : s.node === "Branch" ? go(s.then) : undefined);
  go(stmt);
  return out;
}

// ---- Rewriting sentences: candidates checked against the sentence AST.

// Rewrites a sentence so that it parses to `transform(ast)`: occurrences of `from` are
// replaced (with the particle re-chosen for the new name, or as written) in every
// combination until the parse matches exactly. Text is never trusted on its own.
function rewriteSentence(text: string, transform: (ast: SentenceAst) => SentenceAst, from: string, to: string): string {
  const parsed = parseSentence(text).sentence;
  if (!parsed) return text;
  const expected = ser(transform(parsed));
  if (expected === ser(parsed)) return text;
  const occurrences = wordsIn(text, 0, text.length).filter((w) => w.text.startsWith(from));
  if (occurrences.length > 8) throw new RenameError(`[${text}] mentions '${from}' too often to rename safely`);
  const options = occurrences.map((w) => {
    const suffix = w.text.slice(from.length);
    const adjusted = to + reparticle(suffix, to);
    return [...new Set([null, adjusted, to + suffix])];
  });
  const total = options.reduce((n, o) => n * o.length, 1);
  for (let k = 0; k < total; k += 1) {
    let rest = k;
    let out = "";
    let at = 0;
    occurrences.forEach((w, i) => {
      const o = options[i] as (string | null)[];
      const choice = o[rest % o.length] ?? null;
      rest = Math.floor(rest / o.length);
      out += text.slice(at, w.start) + (choice ?? w.text);
      at = w.end;
    });
    out += text.slice(at);
    const p = parseSentence(out).sentence;
    if (p && ser(p) === expected) return out;
  }
  throw new RenameError(`[${text}] cannot be rewritten for the rename safely`);
}

// The particle after a new name, by its final sound.
function reparticle(suffix: string, name: string): string {
  const ending = endingOf(name);
  if (!ending) return suffix;
  for (const [pair, forms] of Object.entries(ALLOMORPHS) as [ParticlePair, { consonant: string; vowel: string }][]) {
    for (const form of [forms.consonant, forms.vowel]) {
      if (suffix.startsWith(form) && (suffix.length === form.length || pair !== "subject")) return canonicalParticle(pair, ending) + suffix.slice(form.length);
    }
  }
  return suffix;
}

// A sentence's AST with a noun renamed wherever it means the noun (not a pattern-bound
// local, a field, a callee or a constructor).
function renameNoun(ast: SentenceAst, from: string, to: string, isConstructor: (name: string) => boolean): SentenceAst {
  const name = (n: string) => (n === from ? to : n);
  const expr = (e: ExprAst, shadowed: Set<string>): ExprAst => {
    switch (e.kind) {
      case "noun":
        return shadowed.has(e.name) || isConstructor(e.name) ? e : { ...e, name: name(e.name) };
      case "anchored":
        return { ...e, name: name(e.name) };
      case "field":
        return { ...e, target: expr(e.target, shadowed) };
      case "index":
        return { ...e, target: expr(e.target, shadowed), index: expr(e.index, shadowed) };
      default:
        return e;
    }
  };
  const binds = (p: PatternAst, out: Set<string>) => {
    if (p.kind === "name" && p.path.length === 1 && p.args === null && !isConstructor(p.path[0] as string)) out.add(p.path[0] as string);
    if (p.kind === "name") for (const a of p.args ?? []) binds(a, out);
  };
  const match = (m: MatchAst): MatchAst => ({
    ...m,
    scrutinee: expr(m.scrutinee, new Set()),
    arms: m.arms.map((a) => {
      const bound = new Set<string>();
      binds(a.pattern, bound);
      if (bound.has(to) && !bound.has(from) && JSON.stringify(a.body).includes(JSON.stringify(from))) throw new RenameError(`'${to}' is bound by a pattern where '${from}' is used: the rename would capture it`);
      return { ...a, body: expr(a.body, bound) };
    }),
  });
  const place = (p: PlaceAst): PlaceAst => ({ noun: name(p.noun), steps: p.steps.map((s) => (s.kind === "index" ? { ...s, index: expr(s.index, new Set()) } : s)) });
  const call = (c: CallAst): CallAst => ({ ...c, readings: c.readings.map((r) => ({ ...r, targets: r.targets.map(name) })), args: c.args.map((a) => expr(a, new Set())) });
  const act = (a: SentenceAst): SentenceAst => {
    const none = new Set<string>();
    switch (a.kind) {
      case "assign":
        return { ...a, place: place(a.place), value: expr(a.value, none) };
      case "call":
        return { ...a, call: call(a.call) };
      case "match":
        return { ...a, target: name(a.target), match: match(a.match) };
      case "return":
        return { ...a, values: a.values.map((v) => expr(v, none)) };
      case "declare":
      case "receive":
      case "send":
        return { ...a, noun: name(a.noun) };
      case "add":
      case "subtract":
      case "multiply":
      case "divide":
        return { ...a, place: place(a.place), amount: expr(a.amount, none) };
      case "say":
        return { ...a, value: expr(a.value, none) };
      case "assert":
      case "promise":
        return { ...a, noun: name(a.noun), value: expr(a.value, none) };
      case "when":
        return { ...a, condition: { ...a.condition, left: expr(a.condition.left, none), right: expr(a.condition.right, none) }, then: act(a.then) as typeof a.then };
      default:
        return a;
    }
  };
  return act(ast);
}

// A sentence's AST with a callee (a callable plane, or a record's constructor) renamed:
// `[from: …]` in its own module, `[alias from: …]` from an importer.
function renameCallee(ast: SentenceAst, alias: string | null, from: string, to: string): SentenceAst {
  const callee = (path: readonly string[]) => (alias === null ? (path.length === 1 && path[0] === from ? [to] : path) : path.length === 2 && path[0] === alias && path[1] === from ? [alias, to] : path);
  // The readings of a call head are alternative parses of the same words: when one of
  // them means this callee, the word is renamed in all of them.
  const means = (path: readonly string[]) => callee(path) !== path;
  const call = (c: CallAst): CallAst =>
    c.readings.some((r) => means(r.callee)) ? { ...c, readings: c.readings.map((r) => ({ ...r, callee: r.callee[r.callee.length - 1] === from ? [...r.callee.slice(0, -1), to] : r.callee })) } : c;
  const pattern = (p: PatternAst): PatternAst => (p.kind === "name" ? { ...p, path: callee(p.path), args: p.args?.map(pattern) ?? null } : p);
  switch (ast.kind) {
    case "call":
      return { ...ast, call: call(ast.call) };
    case "match":
      return { ...ast, match: { ...ast.match, arms: ast.match.arms.map((a) => ({ ...a, pattern: pattern(a.pattern) })) } };
    case "when":
      return { ...ast, then: renameCallee(ast.then, alias, from, to) as typeof ast.then };
    default:
      return ast;
  }
}
