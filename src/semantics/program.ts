import type { DefinitionAst, DocumentAst, InlinePlaneAst, Span } from "../language/ast";
import type { Diagnostic } from "../language/diagnostics";
import { DeclarationError, parseSignature, parseTypeDeclaration, type TypeAst } from "../language/declarations";
import { parseSentence, RESERVED_WORDS, SENTENCE_CODES } from "../language/sentence-parser";
import type { NounId, PlaneId, Provenance, Stmt } from "../ir/hir";
import { coordinateKey, type Body, type CompiledProgram, type Procedure } from "../ir/program";
import { interpretManifest } from "../space/manifest";
import { planeFromAst } from "../space/plane";
import { buildSpace, type Space } from "../space/volume";
import { TypeChecker, type BodyContext } from "../types/check";
import { arrayOf, BOOL, FLOAT_TYPES, INTEGER_TYPES, named, param, prim, RUNE, sliceOf, TEXT, TypeTable, UNIT_TYPE, type Type, type TypeDef } from "../types/types";
import { parseDocument } from "../language/document-parser";
import {
  ARRAY_NAMESPACE,
  BUILTIN_CONSTRUCTORS,
  elaborate,
  ElaborationError,
  nounsIn,
  NounTable,
  type Constructor,
  type ModuleScope,
} from "./elaborate";

// A compiled program: every body of code (the main volume and each callable plane of
// every module it imports), parsed, elaborated into HIR and type checked once, before
// anything runs. Sentence and type errors are found here, with source positions,
// rather than in the middle of a run. The runtime sees only the HIR.
//
//   sentence AST → elaborate (names, calls) → HIR → check (types) → typed HIR
//
// Three things are kept apart:
//   module          a .y3 file: a namespace for its types and callable planes
//   named plane     a floor plan placed in the volume (composition: same body, same nouns)
//   callable plane  a named plane with a signature, run by a call in a frame of its own

export const PROGRAM_CODES = {
  RETURN_OUTSIDE: "Y3C001",
  END_IN_CALLABLE: "Y3C002",
  MULTIPLE_RESULTS: "Y3C003",
  BAD_SIGNATURE: "Y3C005",
  BAD_DECLARATION: "Y3C006",
  NAME_CLASH: "Y3C007",
  NO_MODULE: "Y3C008",
  IMPORT_CYCLE: "Y3C009",
  BAD_ALIAS: "Y3C010",
} as const;

// Reads an imported module: the module's source and a canonical path for it (used to
// load each module once and to detect cycles), or null when there is no such module.
export type ModuleResolver = (path: string, from: string | null) => { path: string; source: string } | null;

export type CompileOptions = { readonly resolve?: ModuleResolver; readonly path?: string };

const NOWHERE: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
const NOUN_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const PRIMITIVES: ReadonlyMap<string, Type> = new Map([
  ["Text", TEXT],
  ["Bool", BOOL],
  ["Unit", UNIT_TYPE],
  ["Rune", RUNE],
  ...[...INTEGER_TYPES, ...FLOAT_TYPES].map((name) => [name, prim(name)] as const),
]);
const BUILTIN_TYPES = new Set([...PRIMITIVES.keys(), ...new TypeTable().names()]);
const STD_NAMESPACES = new Set(["표준", "수학", ARRAY_NAMESPACE]);

// Where each cell of a plane was written.
function cellSpan(plane: InlinePlaneAst | null, x: number, y: number): Span {
  return plane?.rows[y]?.cells[x]?.span ?? NOWHERE;
}

type Module = {
  readonly key: string;
  readonly path: string | null;
  readonly ast: DocumentAst;
  readonly scope: ModuleScope & { planes: Map<string, PlaneId>; constructors: Map<string, Constructor>; imports: Map<string, ModuleScope> };
  readonly types: Map<string, string>; // the module's own type names → internal names
};

export function compileProgram(ast: DocumentAst, space: Space, options: CompileOptions = {}): { program: CompiledProgram | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (diagnostic: Diagnostic) => {
    const key = `${diagnostic.span.start.line}:${diagnostic.span.start.column}:${diagnostic.code}:${diagnostic.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    diagnostics.push(diagnostic);
  };
  const error = (module: Module | null, code: string, span: Span, message: string) =>
    report({ code, severity: "error", message: module?.path && module.key !== "main" ? `${module.path}: ${message}` : message, span });

  const table = new TypeTable();
  const ids = { next: 1 };
  const modules = new Map<string, Module>(); // by canonical path ("" for the program itself)
  const loading: string[] = [];
  type Declared = {
    readonly name: string;
    readonly module: Module;
    readonly definition: DefinitionAst;
    readonly params: readonly { name: string; type: Type }[];
    readonly results: readonly Type[];
  };
  const signatures = new Map<PlaneId, Declared>();

  // Loads a module and everything it imports, depth first, and declares its types and
  // the signatures of its callable planes. Bodies are compiled once every signature is known.
  const load = (ast: DocumentAst, path: string | null, key: string): Module => {
    const module: Module = {
      key,
      path,
      ast,
      scope: { key, planes: new Map(), constructors: new Map(), imports: new Map() },
      types: new Map(),
    };
    const frontSpan = ast.frontMatter?.span ?? NOWHERE;
    const { manifest } = interpretManifest(ast.frontMatter?.text ?? null, frontSpan);
    loading.push(path ?? "");
    for (const [alias, importPath] of manifest?.imports ?? []) {
      if (!NOUN_PATTERN.test(alias) || RESERVED_WORDS.has(alias) || STD_NAMESPACES.has(alias) || alias.endsWith("의")) {
        error(module, PROGRAM_CODES.BAD_ALIAS, frontSpan, `'${alias}' cannot name a module: use a noun that is not reserved, not 표준/수학/배열, and does not end in 의`);
        continue;
      }
      const found = options.resolve?.(importPath, path) ?? null;
      if (!found) {
        error(module, PROGRAM_CODES.NO_MODULE, frontSpan, `cannot find module '${importPath}' (imported as '${alias}')`);
        continue;
      }
      if (loading.includes(found.path)) {
        error(module, PROGRAM_CODES.IMPORT_CYCLE, frontSpan, `'${importPath}' imports this module back: ${[...loading.slice(loading.indexOf(found.path)), found.path].join(" → ")}`);
        continue;
      }
      let imported = modules.get(found.path) ?? null;
      if (!imported) {
        const parsed = parseDocument(found.source);
        if (!parsed.ok) {
          for (const d of parsed.diagnostics) report({ ...d, message: `${found.path}: ${d.message}` });
          continue;
        }
        const importedManifest = interpretManifest(parsed.ast.frontMatter?.text ?? null).manifest;
        const importedKey = importedManifest?.name ?? found.path.replace(/^.*[\\/]/, "").replace(/\.y3$/, "");
        if ([...modules.values()].some((m) => m.key === importedKey) || importedKey === "main") {
          error(module, PROGRAM_CODES.NAME_CLASH, frontSpan, `two modules are both called '${importedKey}'; give one a different manifest name`);
          continue;
        }
        imported = load(parsed.ast, found.path, importedKey);
      }
      if (imported) module.scope.imports.set(alias, imported.scope);
    }
    loading.pop();
    declareTypes(module);
    declarePlanes(module);
    modules.set(path ?? "", module);
    return module;
  };

  // A type expression, in a module, with these type parameters in scope.
  const resolveType = (module: Module, t: TypeAst, params: ReadonlySet<string>): Type => {
    if (t.kind === "array") return arrayOf(resolveType(module, t.element, params), t.length);
    if (t.kind === "slice") return sliceOf(resolveType(module, t.element, params));
    const args = t.args.map((a) => resolveType(module, a, params));
    const [first, second] = t.path;
    const fail = (message: string): never => {
      throw new DeclarationError(message);
    };
    let internal: string;
    if (second !== undefined) {
      const imported = [...modules.values()].find((m) => m.scope === module.scope.imports.get(first ?? ""));
      internal = imported?.types.get(second) ?? fail(`'${t.path.join(" ")}' is not a type: module '${first}' is not imported or has no type '${second}'`);
    } else {
      const name = first ?? "";
      if (params.has(name)) {
        if (args.length > 0) fail(`type parameter '${name}' takes no arguments`);
        return param(name);
      }
      const primitive = PRIMITIVES.get(name);
      if (primitive) {
        if (args.length > 0) fail(`'${name}' takes no type arguments`);
        return primitive;
      }
      internal = BUILTIN_TYPES.has(name) ? name : (module.types.get(name) ?? fail(`unknown type '${name}'`));
    }
    const def = table.get(internal);
    if (def && def.params.length !== args.length) fail(`'${internal}' takes ${def.params.length} type argument${def.params.length === 1 ? "" : "s"}, not ${args.length}`);
    return named(internal, ...args);
  };

  const declareTypes = (module: Module) => {
    const parsed = (module.ast.appendix?.declarations ?? []).flatMap((d) => {
      try {
        return [{ d, decl: parseTypeDeclaration(d.text) }];
      } catch (e) {
        if (!(e instanceof DeclarationError)) throw e;
        error(module, PROGRAM_CODES.BAD_DECLARATION, d.span, `[${d.text}] ${e.message}`);
        return [];
      }
    });
    const qualify = (name: string) => (module.key === "main" ? name : `${module.key}.${name}`);
    // Names first, so declarations can refer to each other (and to themselves).
    for (const { d, decl } of parsed) {
      if (BUILTIN_TYPES.has(decl.name) || module.types.has(decl.name)) {
        error(module, PROGRAM_CODES.NAME_CLASH, d.span, `type '${decl.name}' is already defined`);
        continue;
      }
      module.types.set(decl.name, qualify(decl.name));
      table.define({ kind: "product", name: qualify(decl.name), params: decl.params, fields: [] }); // placeholder for arity
    }
    for (const { d, decl } of parsed) {
      const internal = qualify(decl.name);
      const params = new Set(decl.params);
      const claim = (name: string, ctor: Constructor) => {
        if (BUILTIN_CONSTRUCTORS.has(name) || module.scope.constructors.has(name)) {
          error(module, PROGRAM_CODES.NAME_CLASH, d.span, `constructor '${name}' is already defined`);
          return;
        }
        module.scope.constructors.set(name, ctor);
      };
      try {
        let def: TypeDef;
        if (decl.body.kind === "record") {
          const fields = decl.body.fields.map((f) => ({ name: f.name, type: resolveType(module, f.type, params) }));
          const names = fields.map((f) => f.name);
          const dup = names.find((n, i) => names.indexOf(n) !== i);
          if (dup) throw new DeclarationError(`field '${dup}' appears twice`);
          def = { kind: "product", name: internal, params: decl.params, fields };
          claim(decl.name, { typeName: internal, variant: null, arity: fields.length, fields: names });
        } else {
          const variants = decl.body.variants.map((v) => ({ name: v.name, fields: v.fields.map((f) => resolveType(module, f, params)) }));
          def = { kind: "sum", name: internal, params: decl.params, variants };
          for (const v of variants) claim(v.name, { typeName: internal, variant: v.name, arity: v.fields.length });
        }
        table.replace(def);
      } catch (e) {
        if (!(e instanceof DeclarationError)) throw e;
        error(module, PROGRAM_CODES.BAD_DECLARATION, d.span, `[${d.text}] ${e.message}`);
      }
    }
  };

  const declarePlanes = (module: Module) => {
    for (const definition of module.ast.appendix?.definitions ?? []) {
      if (definition.signature === null) continue;
      const span = definition.span;
      if (module.scope.constructors.has(definition.name) || BUILTIN_CONSTRUCTORS.has(definition.name) || definition.name === ARRAY_NAMESPACE) {
        error(module, PROGRAM_CODES.NAME_CLASH, span, `':${definition.name}:' has the name of a constructor; a call to it would be ambiguous`);
        continue;
      }
      try {
        const ast = parseSignature(definition.signature);
        const params = ast.params.map((p) => ({ name: p.name, type: resolveType(module, p.type, new Set()) }));
        const names = params.map((p) => p.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) throw new DeclarationError(`parameter '${dup}' appears twice`);
        const bad = names.find((n) => RESERVED_WORDS.has(n) || module.scope.constructors.has(n) || BUILTIN_CONSTRUCTORS.has(n));
        if (bad) throw new DeclarationError(`'${bad}' cannot name a parameter`);
        const id: PlaneId = `${module.key}.${definition.name}`;
        module.scope.planes.set(definition.name, id);
        signatures.set(id, {
          name: definition.name,
          module,
          definition,
          params,
          results: ast.results.map((r) => resolveType(module, r, new Set())),
        });
      } catch (e) {
        if (!(e instanceof DeclarationError)) throw e;
        error(module, PROGRAM_CODES.BAD_SIGNATURE, span, `:${definition.name}: ${definition.signature}: ${e.message}`);
      }
    }
  };

  const context = (results: readonly Type[] | null): BodyContext => ({
    planes: new Map([...signatures].map(([id, s]) => [id, { name: s.name, params: s.params.map((p) => p.type), results: s.results }])),
    results,
  });

  // Parses, elaborates and checks one body. Null when it has errors.
  const compileBody = (
    module: Module,
    bodySpace: Space,
    spanOf: (z: number, x: number, y: number) => { span: Span; name: string | null },
    params: readonly { name: string; type: Type }[],
    results: readonly Type[] | null,
  ): (Body & { paramNouns: NounId[] }) | null => {
    const before = diagnostics.filter((d) => d.severity === "error").length;
    const nouns = new NounTable(ids);
    const paramNouns = params.map((p) => nouns.id(p.name));
    const cells = new Map<string, Stmt>();
    const uses = new Map<number, { span: Span }>();
    const introduced = new Set<number>(paramNouns);
    let unparsed = 0;
    const fail = (code: string, span: Span, message: string) => error(module, code, span, message);

    for (const layer of bodySpace.layers) {
      layer.plane.rows.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (cell.sentence === null) return;
          const source = spanOf(layer.z, x, y);
          const span = source.span;
          const result = parseSentence(cell.sentence);
          for (const issue of result.issues) {
            report({ ...issue, message: `${module.key !== "main" && module.path ? `${module.path}: ` : ""}[${cell.sentence}] ${issue.message}`, span });
          }
          if (!result.sentence) {
            unparsed += 1;
            return;
          }
          const at: Provenance = { span, plane: { slot: layer.z, name: source.name }, cell: { x, y, z: layer.z }, source: cell.sentence };
          let stmt: Stmt;
          try {
            stmt = elaborate(result.sentence, at, nouns, module.scope, (w) =>
              report({ code: w.code, severity: "warning", message: `${module.key !== "main" && module.path ? `${module.path}: ` : ""}[${cell.sentence}] ${w.message}`, span }),
            );
          } catch (e) {
            if (!(e instanceof ElaborationError)) throw e;
            fail(e.code, span, `[${cell.sentence}] ${e.message}`);
            unparsed += 1;
            return;
          }
          const ends = stmt.node === "End" || (stmt.node === "Branch" && stmt.then.node === "End");
          if (results !== null && ends) {
            fail(PROGRAM_CODES.END_IN_CALLABLE, span, `[${cell.sentence}] '끝이다' ends the program; a callable plane returns with '돌려준다' or '돌아간다'`);
          }
          cells.set(coordinateKey(at.cell), stmt);
          const names = nounsIn(stmt);
          for (const id of names.introduces) introduced.add(id);
          for (const id of names.uses) if (!uses.has(id)) uses.set(id, { span });
        });
      });
    }

    const all = nouns.all();
    // A cell that did not parse might have given the name a value, so only judge names
    // when every cell parsed; otherwise the report would be noise.
    for (const [id, { span }] of unparsed > 0 ? [] : uses) {
      if (introduced.has(id)) continue;
      const name = all.find((n) => n.id === id)?.name ?? "";
      fail(
        SENTENCE_CODES.NEVER_INTRODUCED,
        span,
        `'${name}' is used but never introduced: give it a value ('${name}은 3이다') or declare it ('${name}은 미정이다')`,
      );
    }

    // Types are checked once every cell is in hand, in source order, so the first
    // statement that pins a noun's type is the one reported against a later conflict.
    if (unparsed === 0) {
      const checker = new TypeChecker(new Map(all.map((n) => [n.id, n])), table, context(results));
      params.forEach((p, i) => checker.param(paramNouns[i] as NounId, p.type));
      for (const s of inSourceOrder(cells)) checker.stmt(s);
      checker.finish();
      for (const d of checker.diagnostics) {
        report(module.key !== "main" && module.path ? { ...d, message: `${module.path}: ${d.message}` } : d);
      }
    }
    if (diagnostics.filter((d) => d.severity === "error").length > before) return null;
    return { space: bodySpace, cells, nouns: all, paramNouns };
  };

  const root = load(ast, options.path ?? null, "main");

  const definitionsOf = (module: Module) => new Map((module.ast.appendix?.definitions ?? []).map((d) => [d.name, d]));
  const rootDefinitions = definitionsOf(root);
  const main = compileBody(
    root,
    space,
    (z, x, y) => {
      const slot = ast.volume[z]?.plane;
      if (slot?.kind === "inline") return { span: cellSpan(slot, x, y), name: null };
      const name = slot?.name ?? null;
      return { span: cellSpan(name === null ? null : (rootDefinitions.get(name)?.plane ?? null), x, y), name };
    },
    [],
    null,
  );

  const procedures = new Map<PlaneId, Procedure>();
  for (const [id, s] of signatures) {
    const plane = planeFromAst(s.definition.plane);
    const bodySpace: Space = { manifest: null, layers: [{ z: 0, plane, presentation: { kind: "named", name: s.name } }] };
    const body = compileBody(s.module, bodySpace, (_z, x, y) => ({ span: cellSpan(s.definition.plane, x, y), name: s.name }), s.params, s.results);
    if (!body) continue;
    procedures.set(id, {
      ...body,
      id,
      name: s.name,
      module: s.module.key,
      params: s.params.map((p, i) => ({ noun: body.paramNouns[i] as NounId, name: p.name, type: p.type })),
      results: s.results,
    });
  }

  if (!main || diagnostics.some((d) => d.severity === "error")) {
    return { program: null, diagnostics };
  }
  const builtin = new Set(new TypeTable().names());
  const types = table.names().filter((n) => !builtin.has(n)).map((n) => table.get(n) as TypeDef);
  return { program: { space: main.space, cells: main.cells, nouns: main.nouns, procedures, types }, diagnostics };
}

function inSourceOrder(cells: ReadonlyMap<string, Stmt>): Stmt[] {
  const position = (s: Stmt) => [s.at.span.start.line, s.at.span.start.column, s.at.cell.z] as const;
  return [...cells.values()].sort((a, b) => {
    const [la, ca, za] = position(a);
    const [lb, cb, zb] = position(b);
    return la - lb || ca - cb || za - zb;
  });
}

// Loads and compiles a program from source, resolving imports with `resolve`.
export function compileSource(source: string, options: CompileOptions = {}) {
  const parsed = parseDocument(source);
  if (!parsed.ok) return { program: null, diagnostics: parsed.diagnostics };
  const built = buildSpace(parsed.ast);
  if (!built.space) return { program: null, diagnostics: built.diagnostics };
  const compiled = compileProgram(parsed.ast, built.space, options);
  return { program: compiled.program, diagnostics: [...built.diagnostics, ...compiled.diagnostics] };
}

