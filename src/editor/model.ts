import type { DocumentAst, Span } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { parseDocument } from "../language/document-parser";
import { loadParsed } from "../container/document";
import { formatDocument } from "../format/formatter";
import type { Projection } from "../format/projection";
import type { CellId, CellIds, DocumentId, ModuleId, NodeId, PlaneId, ProgramRevision } from "../ir/identity";
import { childExprs, type Expr, type Stmt } from "../ir/hir";
import type { CompiledProgram } from "../ir/program";
import { compileProgram, type LibraryLoader, type ModuleResolver } from "../semantics/program";
import { compileToMir } from "../compiler/compile";
import { optimizeMir } from "../compiler/optimize";
import { encodeBytecode, moduleOf, writeArtifact, type Loaded } from "../compiler/bytecode";
import type { MirOp } from "../compiler/mir";
import type { Manifest } from "../space/manifest";
import { runProgram } from "../runtime/interpreter";
import { runExecutable } from "../runtime/vm";
import type { ProgramResult, RunOptions } from "../runtime/core";
import { attach, canonicalOrder, fromAst, reconcile, slotPlane, StructureError, toAst, type CellEntry, type NewId, type Structure } from "./structure";
import { Draft, EditError, type Command } from "./commands";
import { runEvents, type RuntimeEvent } from "./events";

// The editor-facing program model (docs/v2-editor-model.md). It owns documents and their
// identities, applies edits as transactions, keeps an exact undo history of immutable
// snapshots, and answers questions by asking the existing compiler and runtime. It never
// parses Korean, checks types or runs time itself.

export { EditError, type Command };

// ---- State.

type DocState = {
  readonly id: DocumentId;
  readonly module: ModuleId;
  readonly path: string | null;
  readonly projection: Projection;
  readonly text: string; // the current source text
  readonly structure: Structure; // identities, aligned with `ast`
  readonly ast: DocumentAst; // the last text that parsed, with identities attached
  readonly broken: readonly Diagnostic[] | null; // the current text does not parse
};

type Snapshot = { readonly revision: ProgramRevision; readonly docs: ReadonlyMap<DocumentId, DocState> };

export type EditResult = { readonly revision: ProgramRevision; readonly created: readonly string[] };

// A diagnostic, tied to the model: which document, revision and element it is about.
export type ModelDiagnostic = {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly revision: ProgramRevision;
  readonly document: DocumentId;
  readonly span: Span | null; // null when it is about another file (an imported module outside the model)
  readonly path?: string; // that file
  readonly cell?: CellId;
  readonly plane?: PlaneId;
  readonly node?: NodeId;
};

// One build of one document at one revision: the existing pipeline's products.
export type Build = {
  readonly revision: ProgramRevision;
  readonly document: DocumentId;
  readonly diagnostics: readonly ModelDiagnostic[];
  readonly program: CompiledProgram | null;
  readonly manifest: Manifest | null;
  readonly artifact: string | null; // Y3BC 3, stamped with the revision
  readonly loaded: Loaded | null;
};

export type RunRecord = { readonly revision: ProgramRevision; readonly document: DocumentId; readonly result: ProgramResult };

// ---- Read-only views. Plain frozen data: no internal maps escape.

export type DocumentView = {
  readonly id: DocumentId;
  readonly module: ModuleId;
  readonly path: string | null;
  readonly revision: ProgramRevision;
  readonly text: string;
  readonly broken: boolean;
  readonly floors: readonly (PlaneId | null)[]; // z → plane (null: a reference to a missing plane)
  readonly planes: readonly PlaneId[];
};
export type ModuleView = {
  readonly id: ModuleId;
  readonly document: DocumentId;
  readonly name: string | null; // the manifest's name: a display property
  readonly imports: readonly { readonly alias: string; readonly spec: string; readonly module: ModuleId | null }[];
};
export type PlaneView = {
  readonly id: PlaneId;
  readonly document: DocumentId;
  readonly name: string | null;
  readonly kind: "floor" | "named" | "callable";
  readonly signature: string | null;
  readonly width: number;
  readonly height: number;
  readonly floors: readonly number[]; // where it is placed in the volume
  readonly cells: readonly (readonly CellId[])[];
  readonly span: Span | null;
};
export type CellView = {
  readonly id: CellId;
  readonly document: DocumentId;
  readonly module: ModuleId;
  readonly plane: PlaneId;
  readonly x: number;
  readonly y: number;
  readonly floors: readonly number[];
  readonly sentence: string | null;
  readonly blank: boolean;
  readonly node: NodeId | null;
  readonly span: Span | null;
};
export type Element =
  | { readonly kind: "cell"; readonly cell: CellId; readonly span: Span }
  | { readonly kind: "plane"; readonly plane: PlaneId; readonly span: Span } // a plane's brackets or a named plane's head
  | { readonly kind: "reference"; readonly floor: number; readonly plane: PlaneId | null; readonly span: Span } // ⟦ :name: ⟧
  | { readonly kind: "declaration"; readonly node: NodeId; readonly span: Span }
  | { readonly kind: "comment"; readonly span: Span }
  | { readonly kind: "manifest"; readonly span: Span };
export type HirNode = { readonly id: NodeId; readonly cell: CellId; readonly parent: NodeId | null; readonly kind: string; readonly item: Stmt | Expr };
export type InstructionId = `${number}:${number}`;
export type InstructionView = { readonly id: InstructionId; readonly op: MirOp["op"]; readonly cell: CellId; readonly node: NodeId | null; readonly ids: CellIds };

export type ModelOptions = {
  readonly nonce?: string; // makes ids distinct between sessions; fixed in tests
  readonly resolve?: ModuleResolver; // modules that are not open in the model
  readonly libraries?: LibraryLoader;
};

export class ModelError extends Error {}

const freeze = <T>(x: T): T => Object.freeze(x);
const contains = (s: Span, line: number, column: number) =>
  (line > s.start.line || (line === s.start.line && column >= s.start.column)) && (line < s.end.line || (line === s.end.line && column < s.end.column));
const posixDir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const normalize = (p: string) => {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};

export class ProgramModel {
  private snapshot: Snapshot;
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private counter = 0;
  private readonly nonce: string;
  private readonly reserved = new Set<string>();
  private builds = new Map<string, Build>(); // `${revision} ${document}`
  private maps = new Map<string, SourceMap>();

  constructor(private readonly options: ModelOptions = {}) {
    this.nonce = options.nonce ?? Math.random().toString(36).slice(2, 8);
    this.snapshot = { revision: this.revisionId(), docs: new Map() };
  }

  private next(prefix: string): string {
    for (;;) {
      this.counter += 1;
      const id = `${prefix}${this.nonce}.${this.counter}`;
      if (!this.reserved.has(id)) return id;
    }
  }
  private readonly newId: NewId = ((kind: "cell" | "plane" | "node") => this.next(kind === "cell" ? "c:" : kind === "plane" ? "p:" : "n:")) as NewId;
  private revisionId(): ProgramRevision {
    return this.next("r:") as ProgramRevision;
  }

  // ---- Lifecycle.

  get revision(): ProgramRevision {
    return this.snapshot.revision;
  }

  // Opens a document: a new DocumentId and ModuleId, unless a sidecar written by `sidecar`
  // brings them back (its identities are then reconciled with the text, as for a raw edit).
  // Opening or closing starts a new edit history.
  open(input: { text: string; path?: string; sidecar?: string; projection?: Projection }): DocumentId {
    let saved: SidecarData | null = null;
    if (input.sidecar !== undefined) saved = readSidecar(input.sidecar);
    if (saved) for (const id of sidecarIds(saved)) this.reserved.add(id);
    const id = (saved?.document ?? this.next("d:")) as DocumentId;
    if (this.snapshot.docs.has(id)) throw new ModelError(`document ${id} is already open`);
    const module = (saved?.module ?? this.next("m:")) as ModuleId;
    const parsed = parseDocument(input.text);
    let state: DocState;
    const base: Omit<DocState, "structure" | "ast" | "broken"> = { id, module, path: input.path ?? saved?.path ?? null, projection: input.projection ?? "perspective", text: input.text };
    if (parsed.ok) {
      const previous = saved ? saved.structure : null;
      const structure = previous ? reconcile(previous, parsed.ast, this.newId) : fromAst(parsed.ast, this.newId);
      const attached = attach(structure, parsed.ast, { document: id, module });
      state = { ...base, structure: attached.structure, ast: attached.ast, broken: null };
    } else {
      const empty = fromAst({ frontMatter: null, volume: [], appendix: null, trailingComments: [] }, this.newId);
      state = { ...base, structure: empty, ast: toAst(empty), broken: parsed.diagnostics };
    }
    this.commitSnapshot(new Map([...this.snapshot.docs, [id, state]]), false);
    this.past = [];
    this.future = [];
    return id;
  }

  close(document: DocumentId): void {
    this.doc(document);
    const docs = new Map(this.snapshot.docs);
    docs.delete(document);
    this.commitSnapshot(docs, false);
    this.past = [];
    this.future = [];
  }

  // The identity sidecar (docs/v2-editor-model.md): internal JSON, versioned.
  sidecar(document: DocumentId): string {
    const d = this.doc(document);
    const data: SidecarData = { magic: "Y3MODEL", version: 1, document: d.id, module: d.module, path: d.path, structure: d.structure };
    return `Y3MODEL 1\n${JSON.stringify(data, (_, v) => (v instanceof Map ? { map: [...v.values()] } : v))}\n`;
  }

  // ---- Edits. Each is a transaction: it applies completely or not at all.

  apply(commands: Command | readonly Command[]): EditResult {
    const list = Array.isArray(commands) ? commands : [commands as Command];
    const drafts = new Map<DocumentId, Draft>();
    const draftFor = (document: DocumentId) => {
      let d = drafts.get(document);
      if (!d) {
        const state = this.doc(document);
        if (state.broken) throw new EditError(`document ${document} does not parse: fix its text before a structural edit`);
        d = new Draft(document, state.structure, this.newId);
        drafts.set(document, d);
      }
      return d;
    };
    // Which document a command touches.
    const owner = (c: Command): DocumentId => {
      if ("document" in c) return c.document;
      const plane = "plane" in c && typeof c.plane === "string" && c.kind !== "MoveCell" && c.kind !== "CopyCell" ? c.plane : null;
      const id = "cell" in c ? c.cell : "a" in c ? c.a : "node" in c ? c.node : plane;
      for (const [doc, d] of drafts) if (("cell" in c || "a" in c) && d.has(id as CellId)) return doc;
      for (const s of this.snapshot.docs.values()) {
        if ("node" in c && s.structure.declarations.some((x) => x.node === c.node)) return s.id;
        if (("cell" in c || "a" in c) && findCell(s.structure, id as CellId)) return s.id;
        if (plane && s.structure.planes.has(plane)) return s.id;
      }
      throw new EditError(`${c.kind}: ${String(id)} does not exist`);
    };
    const created: string[] = [];
    for (const c of list) {
      const doc = owner(c);
      const d = draftFor(doc);
      if ((c.kind === "MoveCell" || c.kind === "CopyCell" || c.kind === "SwapCells") && !drafts.has(doc)) throw new EditError("internal: draft");
      if ((c.kind === "MoveCell" || c.kind === "CopyCell") && !d.planes.has(c.plane)) throw new EditError(`${c.kind}: plane ${c.plane} is not in the same document`);
      if (c.kind === "SwapCells" && !d.has(c.b)) throw new EditError("SwapCells: both cells must be in the same document");
      if (c.kind === "DeletePlane") this.refuseCalledPlane(doc, c.plane);
      created.push(...d.apply(c));
    }
    const docs = new Map(this.snapshot.docs);
    for (const [id, d] of drafts) docs.set(id, this.serialize(this.doc(id), d.commit()));
    this.commitSnapshot(docs, true);
    return { revision: this.revision, created };
  }

  // A raw text edit: the text is parsed and its identities reconciled with the old ones.
  setText(document: DocumentId, text: string): EditResult {
    const old = this.doc(document);
    const parsed = parseDocument(text);
    let state: DocState;
    if (!parsed.ok) state = { ...old, text, broken: parsed.diagnostics };
    else {
      const structure = reconcile(old.structure, parsed.ast, this.newId);
      const attached = attach(structure, parsed.ast, { document: old.id, module: old.module });
      state = { ...old, text, structure: attached.structure, ast: attached.ast, broken: null };
    }
    this.commitSnapshot(new Map([...this.snapshot.docs, [document, state]]), true);
    return { revision: this.revision, created: [] };
  }

  // Canonical formatting. Identity is the model's: formatting re-renders the same cells.
  format(document: DocumentId, projection?: Projection): EditResult {
    const old = this.doc(document);
    if (old.broken) throw new EditError(`document ${document} does not parse: it cannot be formatted`);
    this.commitSnapshot(new Map([...this.snapshot.docs, [document, this.serialize({ ...old, projection: projection ?? old.projection }, old.structure)]]), true);
    return { revision: this.revision, created: [] };
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.snapshot);
    this.snapshot = previous;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.snapshot);
    this.snapshot = next;
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  private serialize(old: DocState, edited: Structure): DocState {
    const structure = canonicalOrder(edited);
    let text: string;
    try {
      text = formatDocument(toAst(structure), { projection: old.projection });
    } catch (e) {
      if (e instanceof StructureError) throw new EditError(e.message);
      throw e;
    }
    const parsed = parseDocument(text);
    if (!parsed.ok) throw new EditError(`the edit does not produce a valid document: ${parsed.diagnostics[0]?.message}`);
    const attached = attach(structure, parsed.ast, { document: old.id, module: old.module });
    return { ...old, text, structure: attached.structure, ast: attached.ast, broken: null };
  }

  private commitSnapshot(docs: ReadonlyMap<DocumentId, DocState>, history: boolean) {
    if (history) {
      this.past.push(this.snapshot);
      this.future = []; // a new edit after undo discards the redo branch
    }
    this.snapshot = { revision: this.revisionId(), docs };
  }

  // A callable plane that something still calls cannot be deleted.
  private refuseCalledPlane(document: DocumentId, plane: PlaneId) {
    const p = this.doc(document).structure.planes.get(plane);
    if (!p || p.signature === null) return;
    const callers = this.referencesToPlane(plane);
    if (callers.length > 0) throw new EditError(`':${p.name}:' is still called from ${callers.length} cell(s): remove the calls first`);
  }

  // Cells whose statement calls this callable plane, in every open document's build.
  referencesToPlane(plane: PlaneId): CellId[] {
    const out: CellId[] = [];
    for (const d of this.snapshot.docs.values()) {
      const program = this.build(d.id).program;
      if (!program) continue;
      for (const body of [program, ...program.procedures.values()]) {
        for (const stmt of body.cells.values()) {
          const calls = (s: Stmt): boolean => (s.node === "CallPlane" ? callablePlane(program, s.plane) === plane : s.node === "Branch" ? calls(s.then) : false);
          if (calls(stmt) && stmt.at.ids && !out.includes(stmt.at.ids.cell)) out.push(stmt.at.ids.cell);
        }
      }
    }
    return out;
  }

  // ---- Builds and runs.

  private doc(id: DocumentId): DocState {
    const d = this.snapshot.docs.get(id);
    if (!d) throw new ModelError(`document ${id} is not open`);
    return d;
  }

  // Resolves imports against the documents open in the model (with their identities),
  // then the model's resolver.
  private resolver(): ModuleResolver {
    return (spec, from) => {
      const target = normalize(`${posixDir(from ?? "")}/${spec}`);
      for (const d of this.snapshot.docs.values()) {
        if (d.path !== null && normalize(d.path) === target && !d.broken) return { path: d.path, source: d.text, ast: d.ast };
      }
      return this.options.resolve?.(spec, from) ?? null;
    };
  }

  build(document: DocumentId): Build {
    const key = `${this.revision} ${document}`;
    const cached = this.builds.get(key);
    if (cached) return cached;
    const d = this.doc(document);
    const raw: Diagnostic[] = [];
    let program: CompiledProgram | null = null;
    let manifest: Manifest | null = null;
    let artifact: string | null = null;
    let loaded: Loaded | null = null;
    if (d.broken) raw.push(...d.broken);
    else {
      const l = loadParsed(d.ast);
      raw.push(...l.diagnostics);
      manifest = l.manifest;
      if (l.space && l.manifest) {
        const compiled = compileProgram(d.ast, l.space, { path: d.path ?? undefined, resolve: this.resolver(), libraries: this.options.libraries });
        raw.push(...compiled.diagnostics);
        program = compiled.program;
        if (program && program.space.layers.length > 0 && !raw.some((x) => x.severity === "error")) {
          const { mir, nodes } = compileToMir(program, l.manifest.start);
          artifact = writeArtifact(encodeBytecode(optimizeMir(mir).mir, nodes, program, { module: l.manifest.name ?? "main", maxSteps: l.manifest.maxSteps, start: l.manifest.start, revision: this.revision }));
          loaded = moduleOf(artifact);
        }
      }
    }
    const build: Build = freeze({ revision: this.revision, document, diagnostics: raw.map((x) => this.adapt(d, x)), program, manifest, artifact, loaded });
    this.builds = new Map([...[...this.builds].slice(-16), [key, build]]);
    return build;
  }

  run(document: DocumentId, options: RunOptions & { engine?: "vm" | "hir" } = {}): RunRecord {
    const b = this.build(document);
    if (!b.program || !b.manifest) throw new ModelError(`document ${document} does not compile`);
    const result = options.engine === "hir" || !b.loaded ? runProgram(b.program, b.manifest, options) : runExecutable(b.loaded.executable, b.loaded.program, b.manifest, options);
    return freeze({ revision: b.revision, document, result });
  }

  // A run's structured events. `stale`: the run came from another revision, so its cells
  // may no longer be where (or what) the events say; an editor shows it as stale, never as
  // an exact mapping onto the current model.
  traceEvents(run: RunRecord): { readonly stale: boolean; readonly events: readonly RuntimeEvent[] } {
    return freeze({ stale: !this.isCurrent(run), events: freeze(runEvents(run.revision, run.result)) });
  }

  traceEventsForCell(run: RunRecord, cell: CellId): { readonly stale: boolean; readonly events: readonly RuntimeEvent[] } {
    const all = this.traceEvents(run);
    return freeze({ stale: all.stale, events: freeze(all.events.filter((e) => e.ids?.cell === cell)) });
  }

  // Whether a result (build, run, diagnostics, analysis) belongs to the current state.
  isCurrent(result: { readonly revision: ProgramRevision }): boolean {
    return result.revision === this.revision;
  }

  private adapt(d: DocState, x: Diagnostic): ModelDiagnostic {
    const base = { code: x.code, severity: x.severity, message: x.message, revision: this.revision, document: d.id };
    if (x.path !== undefined && x.path !== d.path) return freeze({ ...base, span: x.span, path: x.path });
    if (d.broken) return freeze({ ...base, span: x.span });
    const e = this.sourceMap(d.id).at(x.span.start.line, x.span.start.column);
    const cell = e?.kind === "cell" ? e.cell : undefined;
    const ids = cell ? this.cellIds(cell) : undefined;
    const plane = ids?.plane ?? (e?.kind === "plane" ? e.plane : e?.kind === "reference" ? (e.plane ?? undefined) : undefined);
    const node = ids?.node ?? (e?.kind === "declaration" ? e.node : undefined);
    return freeze({ ...base, span: x.span, ...(cell ? { cell } : {}), ...(plane ? { plane } : {}), ...(node ? { node } : {}) });
  }

  // ---- Source maps.

  private sourceMap(document: DocumentId): SourceMap {
    const key = `${this.revision} ${document}`;
    let map = this.maps.get(key);
    if (!map) {
      map = new SourceMap(this.doc(document));
      this.maps = new Map([...[...this.maps].slice(-16), [key, map]]);
    }
    return map;
  }

  // ---- Queries (read-only; plain frozen views).

  documents(): DocumentId[] {
    return [...this.snapshot.docs.keys()];
  }

  getDocument(id: DocumentId): DocumentView {
    const d = this.doc(id);
    return freeze({
      id: d.id,
      module: d.module,
      path: d.path,
      revision: this.revision,
      text: d.text,
      broken: d.broken !== null,
      floors: freeze(d.structure.volume.map(slotPlane)),
      planes: freeze([...d.structure.planes.keys()]),
    });
  }

  diagnostics(document: DocumentId): readonly ModelDiagnostic[] {
    return this.build(document).diagnostics;
  }

  getModule(id: ModuleId): ModuleView {
    const d = [...this.snapshot.docs.values()].find((x) => x.module === id);
    if (!d) throw new ModelError(`module ${id} is not open`);
    const manifest = d.broken ? null : loadParsed(d.ast).manifest;
    const imports = [...(manifest?.imports ?? new Map<string, string>())].map(([alias, spec]) => {
      const target = normalize(`${posixDir(d.path ?? "")}/${spec}`);
      const found = [...this.snapshot.docs.values()].find((x) => x.path !== null && normalize(x.path) === target);
      return freeze({ alias, spec, module: found?.module ?? null });
    });
    return freeze({ id, document: d.id, name: manifest?.name ?? null, imports: freeze(imports) });
  }

  moduleOfDocument(document: DocumentId): ModuleId {
    return this.doc(document).module;
  }

  private findPlane(id: PlaneId): { d: DocState; p: Structure["planes"] extends ReadonlyMap<PlaneId, infer P> ? P : never } | null {
    for (const d of this.snapshot.docs.values()) {
      const p = d.structure.planes.get(id);
      if (p) return { d, p };
    }
    return null;
  }

  getPlane(id: PlaneId): PlaneView {
    const found = this.findPlane(id);
    if (!found) throw new ModelError(`plane ${id} does not exist`);
    const { d, p } = found;
    const floors = d.structure.volume.flatMap((s, z) => (slotPlane(s) === id ? [z] : []));
    return freeze({
      id,
      document: d.id,
      name: p.name,
      kind: p.name === null ? "floor" : p.signature === null ? "named" : "callable",
      signature: p.signature,
      width: p.grid[0]?.length ?? 0,
      height: p.grid.length,
      floors: freeze(floors),
      cells: freeze(p.grid.map((r) => freeze(r.map((e) => (e as CellEntry).id)))),
      span: d.broken ? null : (this.sourceMap(d.id).planeSpan(id) ?? null),
    });
  }

  getCell(id: CellId): CellView {
    for (const d of this.snapshot.docs.values()) {
      const found = findCell(d.structure, id);
      if (!found) continue;
      return freeze({
        id,
        document: d.id,
        module: d.module,
        plane: found.plane,
        x: found.x,
        y: found.y,
        floors: freeze(d.structure.volume.flatMap((s, z) => (slotPlane(s) === found.plane ? [z] : []))),
        sentence: found.entry.text,
        blank: found.entry.text === null,
        node: found.entry.node,
        span: d.broken ? null : (this.sourceMap(d.id).cellSpan(id) ?? null),
      });
    }
    throw new ModelError(`cell ${id} does not exist`);
  }

  hasCell(id: CellId): boolean {
    return [...this.snapshot.docs.values()].some((d) => findCell(d.structure, id) !== null);
  }

  cellIds(id: CellId): CellIds {
    const c = this.getCell(id);
    return { document: c.document, module: c.module, plane: c.plane, cell: c.id, node: c.node };
  }

  // The cell at a position of a plane; null for VOID.
  cellAt(plane: PlaneId, x: number, y: number): CellId | null {
    const found = this.findPlane(plane);
    if (!found) throw new ModelError(`plane ${plane} does not exist`);
    return found.p.grid[y]?.[x]?.id ?? null;
  }

  // The cell at a position of a document's space (floor z); null for VOID.
  spaceCellAt(document: DocumentId, x: number, y: number, z: number): CellId | null {
    const slot = this.doc(document).structure.volume[z];
    const plane = slot ? slotPlane(slot) : null;
    return plane ? this.cellAt(plane, x, y) : null;
  }

  sourceSpanOf(cell: CellId): Span | null {
    return this.getCell(cell).span;
  }

  // What is written at a source position (1-based line, UTF-16 column).
  elementAt(document: DocumentId, line: number, column: number): Element | null {
    if (this.doc(document).broken) return null;
    return this.sourceMap(document).at(line, column);
  }

  cellAtSourcePosition(document: DocumentId, line: number, column: number): CellId | null {
    const e = this.elementAt(document, line, column);
    return e?.kind === "cell" ? e.cell : null;
  }

  // The same, by UTF-16 offset into the document's text.
  cellAtSourceOffset(document: DocumentId, offset: number): CellId | null {
    const text = this.doc(document).text;
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - (before.lastIndexOf("\n") + 1) + 1;
    return this.cellAtSourcePosition(document, line, column);
  }

  // ---- HIR, MIR and trace links.

  // The typed HIR a cell compiled to: its statement and every node inside, with NodeIds
  // (the statement's own, and derived "<statement>/<path>" ids below it).
  hirNodesForCell(cell: CellId): HirNode[] {
    const c = this.getCell(cell);
    const stmt = this.statements(c.document).get(cell);
    return stmt && c.node ? hirNodes(stmt, cell, c.node) : [];
  }

  // The HIR node with this id, in the current build.
  hirNode(node: NodeId): HirNode | null {
    const root = node.split("/")[0] as NodeId;
    for (const d of this.snapshot.docs.values()) {
      for (const [cell, stmt] of this.statements(d.id)) {
        if (stmt.at.ids?.node !== root) continue;
        return hirNodes(stmt, cell, root).find((n) => n.id === node) ?? null;
      }
    }
    return null;
  }

  // Every statement of a document's current build, by cell.
  statements(document: DocumentId): ReadonlyMap<CellId, Stmt> {
    const program = this.build(document).program;
    const out = new Map<CellId, Stmt>();
    if (!program) return out;
    for (const body of [program, ...program.procedures.values()]) {
      for (const stmt of body.cells.values()) if (stmt.at.ids && stmt.at.ids.document === document) out.set(stmt.at.ids.cell, stmt);
    }
    return out;
  }

  // MIR instructions ("<block>:<index>") compiled from a cell, in the current build.
  mirInstructionsForCell(cell: CellId): InstructionView[] {
    return this.instructions(this.getCell(cell).document).filter((i) => i.cell === cell);
  }

  instructions(document: DocumentId): InstructionView[] {
    const loaded = this.build(document).loaded;
    if (!loaded) return [];
    const exe = loaded.executable;
    return exe.blocks.flatMap((b) => {
      const ids = exe.nodes[b.node]?.ids;
      return ids ? b.ops.map((o, i) => freeze({ id: `${b.id}:${i}` as InstructionId, op: o.op, cell: ids.cell, node: ids.node, ids })) : [];
    });
  }

  instruction(document: DocumentId, id: InstructionId): InstructionView | null {
    return this.instructions(document).find((i) => i.id === id) ?? null;
  }
}

// ---- Helpers.

function findCell(s: Structure, id: CellId): { plane: PlaneId; x: number; y: number; entry: CellEntry } | null {
  for (const p of s.planes.values()) {
    for (let y = 0; y < p.grid.length; y += 1) {
      const row = p.grid[y] as readonly (CellEntry | null)[];
      for (let x = 0; x < row.length; x += 1) if (row[x]?.id === id) return { plane: p.id, x, y, entry: row[x] as CellEntry };
    }
  }
  return null;
}

// The editor PlaneId of a compiled callable plane ("main.제곱", "기하.넓이"): read from its
// cells' identities, never guessed from names.
export function callablePlane(program: CompiledProgram, callee: string): PlaneId | null {
  const body = program.procedures.get(callee);
  return body?.space.layers[0]?.plane.rows[0]?.[0]?.ids?.plane ?? null;
}

// A statement and everything inside it, with ids: the statement's own, then
// "<statement>/<i>/<j>…" by child position.
export function hirNodes(stmt: Stmt, cell: CellId, id: NodeId): HirNode[] {
  const out: HirNode[] = [];
  const go = (item: Stmt | Expr, nid: NodeId, parent: NodeId | null) => {
    out.push(freeze({ id: nid, cell, parent, kind: item.node, item }));
    const children: (Stmt | Expr)[] = [...(item.node === "Branch" ? [item.then] : []), ...childExprs(item)];
    children.forEach((child, i) => go(child, `${nid}/${i}` as NodeId, nid));
  };
  go(stmt, id, null);
  return out;
}

// Positions → elements, and elements → spans, for one document at one revision.
class SourceMap {
  private readonly elements: Element[] = [];
  private readonly cells = new Map<CellId, Span>();
  private readonly planes = new Map<PlaneId, Span>();

  constructor(d: DocState) {
    const ast = d.ast;
    if (ast.frontMatter) this.elements.push({ kind: "manifest", span: ast.frontMatter.span });
    const comments = (cs: readonly { span: Span }[]) => cs.forEach((c) => this.elements.push({ kind: "comment", span: c.span }));
    const plane = (id: PlaneId, p: { span: Span; rows: { cells: { span: Span; ids?: CellIds }[] }[] }) => {
      for (const row of p.rows) {
        for (const c of row.cells) {
          if (!c.ids) continue;
          this.cells.set(c.ids.cell, c.span);
          this.elements.push({ kind: "cell", cell: c.ids.cell, span: c.span });
        }
      }
      this.elements.push({ kind: "plane", plane: id, span: p.span });
    };
    ast.volume.forEach((slot, z) => {
      comments(slot.comments);
      const entry = d.structure.volume[z];
      const id = entry ? slotPlane(entry) : null;
      if (slot.plane.kind === "ref") this.elements.push({ kind: "reference", floor: z, plane: id, span: slot.plane.span });
      else if (id) {
        plane(id, slot.plane);
        this.planes.set(id, slot.plane.span);
      }
    });
    if (ast.appendix) {
      comments(ast.appendix.comments);
      ast.appendix.declarations.forEach((decl, i) => {
        comments(decl.comments);
        const node = d.structure.declarations[i]?.node;
        if (node) this.elements.push({ kind: "declaration", node, span: decl.span });
      });
      ast.appendix.definitions.forEach((def, i) => {
        comments(def.comments);
        const id = d.structure.definitions[i];
        if (!id) return;
        plane(id, def.plane);
        this.planes.set(id, def.span);
        this.elements.push({ kind: "plane", plane: id, span: def.span });
      });
    }
    comments(ast.trailingComments);
  }

  // The innermost element containing a position: a cell before its plane.
  at(line: number, column: number): Element | null {
    const rank = (e: Element) => (e.kind === "cell" || e.kind === "declaration" || e.kind === "comment" || e.kind === "reference" ? 0 : 1);
    let best: Element | null = null;
    for (const e of this.elements) if (contains(e.span, line, column) && (!best || rank(e) < rank(best))) best = e;
    return best;
  }
  cellSpan(id: CellId): Span | undefined {
    return this.cells.get(id);
  }
  planeSpan(id: PlaneId): Span | undefined {
    return this.planes.get(id);
  }
}

// ---- Sidecar.

type SidecarData = { magic: "Y3MODEL"; version: 1; document: DocumentId; module: ModuleId; path: string | null; structure: Structure };

function readSidecar(text: string): SidecarData {
  const [header, body] = [text.slice(0, text.indexOf("\n")), text.slice(text.indexOf("\n") + 1)];
  if (header !== "Y3MODEL 1") throw new ModelError("not a version 1 identity sidecar");
  let raw: { magic?: string; version?: number; document?: unknown; module?: unknown; path?: unknown; structure?: { planes?: { map?: unknown[] } } & Record<string, unknown> };
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ModelError("the identity sidecar is not valid JSON");
  }
  if (raw.magic !== "Y3MODEL" || raw.version !== 1 || typeof raw.document !== "string" || typeof raw.module !== "string" || !Array.isArray(raw.structure?.planes?.map)) throw new ModelError("a malformed identity sidecar");
  const structure = { ...raw.structure, planes: new Map((raw.structure.planes.map as { id: PlaneId }[]).map((p) => [p.id, p])) } as unknown as Structure;
  return { magic: "Y3MODEL", version: 1, document: raw.document as DocumentId, module: raw.module as ModuleId, path: typeof raw.path === "string" ? raw.path : null, structure };
}

function sidecarIds(s: SidecarData): string[] {
  const ids: string[] = [s.document, s.module];
  for (const p of s.structure.planes.values()) {
    ids.push(p.id);
    for (const row of p.grid) for (const c of row) if (c) ids.push(c.id, ...(c.node ? [c.node] : []));
  }
  for (const d of s.structure.declarations) ids.push(d.node);
  return ids;
}
