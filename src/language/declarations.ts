// Parses the declarations of the ※ section: type expressions, callable plane
// signatures and 자료 type declarations. These are syntax, not prose: types are written
// the conventional way (Int, Option<Text>, [Int; 3], []Int), so that values stay boring.
//
//   type        = "[" "]" type | "[" type ";" INT "]" | name [ "<" type { "," type } ">" ]
//   name        = IDENT [ IDENT ]                         (* "기하 점": module alias, then type *)
//   signature   = "(" [ param { "," param } ] ")" [ arrow results ]
//   param       = IDENT ":" type
//   results     = type | "(" [ type { "," type } ] ")"
//   arrow       = "→" | "->"
//   declaration = "자료" IDENT [ "<" IDENT { "," IDENT } ">" ] "=" ( record | sum )
//   record      = "{" [ IDENT ":" type { "," IDENT ":" type } ] "}"
//   sum         = variant { "|" variant }
//   variant     = IDENT [ "(" type { "," type } ")" ]

export type TypeAst =
  | { readonly kind: "name"; readonly path: readonly string[]; readonly args: readonly TypeAst[] } // path: [type] or [alias, type]
  | { readonly kind: "array"; readonly element: TypeAst; readonly length: number }
  | { readonly kind: "slice"; readonly element: TypeAst };

export type SignatureAst = {
  readonly params: readonly { readonly name: string; readonly type: TypeAst }[];
  readonly results: readonly TypeAst[]; // empty: Unit
};

export type DeclarationBodyAst =
  | { readonly kind: "record"; readonly fields: readonly { readonly name: string; readonly type: TypeAst }[] }
  | { readonly kind: "sum"; readonly variants: readonly { readonly name: string; readonly fields: readonly TypeAst[] }[] };

export type TypeDeclarationAst = { readonly name: string; readonly params: readonly string[]; readonly body: DeclarationBodyAst };

export class DeclarationError extends Error {}

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*/u;

class Tokens {
  private readonly tokens: string[] = [];
  private index = 0;

  constructor(text: string) {
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const space = rest.match(/^\s+/u);
      if (space) {
        i += space[0].length;
        continue;
      }
      const word = rest.match(IDENT) ?? rest.match(/^\d+/u) ?? rest.match(/^(->|→|[()[\]{}<>,:;|=])/u);
      if (!word) throw new DeclarationError(`unexpected '${rest[0]}'`);
      this.tokens.push(word[0] === "->" ? "→" : word[0]);
      i += word[0].length;
    }
  }

  peek(offset = 0): string | undefined {
    return this.tokens[this.index + offset];
  }

  next(): string {
    const token = this.tokens[this.index];
    if (token === undefined) throw new DeclarationError("unexpected end");
    this.index += 1;
    return token;
  }

  accept(token: string): boolean {
    if (this.peek() !== token) return false;
    this.index += 1;
    return true;
  }

  expect(token: string): void {
    const found = this.peek();
    if (found !== token) throw new DeclarationError(`expected '${token}' but found ${found === undefined ? "the end" : `'${found}'`}`);
    this.index += 1;
  }

  ident(what: string): string {
    const found = this.peek();
    if (found === undefined || !IDENT.test(found) || /^\d/.test(found)) {
      throw new DeclarationError(`expected ${what} but found ${found === undefined ? "the end" : `'${found}'`}`);
    }
    this.index += 1;
    return found;
  }

  isIdent(offset = 0): boolean {
    const found = this.peek(offset);
    return found !== undefined && IDENT.test(found) && !/^\d/.test(found);
  }

  end(): void {
    const found = this.peek();
    if (found !== undefined) throw new DeclarationError(`unexpected '${found}' at the end`);
  }
}

function list<T>(t: Tokens, close: string, item: () => T): T[] {
  const items: T[] = [];
  if (t.accept(close)) return items;
  do items.push(item());
  while (t.accept(","));
  t.expect(close);
  return items;
}

function type(t: Tokens): TypeAst {
  if (t.accept("[")) {
    if (t.accept("]")) return { kind: "slice", element: type(t) };
    const element = type(t);
    t.expect(";");
    const length = t.next();
    if (!/^\d+$/.test(length)) throw new DeclarationError(`an array length is a whole number, not '${length}'`);
    t.expect("]");
    return { kind: "array", element, length: Number(length) };
  }
  const path = [t.ident("a type")];
  if (t.isIdent()) path.push(t.ident("a type"));
  const args = t.accept("<") ? list(t, ">", () => type(t)) : [];
  return { kind: "name", path, args };
}

function whole<T>(text: string, parse: (t: Tokens) => T): T {
  const t = new Tokens(text);
  const result = parse(t);
  t.end();
  return result;
}

export function parseType(text: string): TypeAst {
  return whole(text, type);
}

export function parseSignature(text: string): SignatureAst {
  return whole(text, (t) => {
    t.expect("(");
    const params = list(t, ")", () => {
      const name = t.ident("a parameter name");
      t.expect(":");
      return { name, type: type(t) };
    });
    if (!t.accept("→")) return { params, results: [] };
    // "(A, B)" is several results; a lone "(" never starts a single type.
    const results = t.accept("(") ? list(t, ")", () => type(t)) : [type(t)];
    return { params, results };
  });
}

export function parseTypeDeclaration(text: string): TypeDeclarationAst {
  return whole(text, (t) => {
    t.expect("자료");
    const name = t.ident("the type's name");
    const params = t.accept("<") ? list(t, ">", () => t.ident("a type parameter")) : [];
    t.expect("=");
    if (t.accept("{")) {
      const fields = list(t, "}", () => {
        const field = t.ident("a field name");
        t.expect(":");
        return { name: field, type: type(t) };
      });
      return { name, params, body: { kind: "record", fields } };
    }
    const variants: { name: string; fields: TypeAst[] }[] = [];
    do {
      const variant = t.ident("a variant name");
      variants.push({ name: variant, fields: t.accept("(") ? list(t, ")", () => type(t)) : [] });
    } while (t.accept("|"));
    return { name, params, body: { kind: "sum", variants } };
  });
}

// 외부 declarations (docs/v2-ffi.md): one exported function of a foreign library.
//
//   foreign = "외부" IDENT IDENT "(" [ fparam { "," fparam } ] ")" [ arrow type ] "=" IDENT { attr }
//   fparam  = IDENT ":" [ "출력" ] type                (* 출력: an out-buffer *)
//   attr    = "순수" | "해제"                           (* pure; frees its pointer *)
export type ForeignDeclarationAst = {
  readonly library: string;
  readonly name: string;
  readonly params: readonly { readonly name: string; readonly out: boolean; readonly type: TypeAst }[];
  readonly result: TypeAst | null;
  readonly symbol: string;
  readonly pure: boolean;
  readonly frees: boolean;
};

export const FOREIGN_KEYWORD = "외부";

export function parseForeignDeclaration(text: string): ForeignDeclarationAst {
  return whole(text, (t) => {
    t.expect(FOREIGN_KEYWORD);
    const library = t.ident("the library's alias");
    const name = t.ident("the function's name");
    t.expect("(");
    const params = list(t, ")", () => {
      const pname = t.ident("a parameter name");
      t.expect(":");
      const out = t.accept("출력");
      return { name: pname, out, type: type(t) };
    });
    const result = t.accept("→") ? type(t) : null;
    t.expect("=");
    const symbol = t.ident("the exported symbol");
    let pure = false;
    let frees = false;
    while (t.peek() !== undefined) {
      const attr = t.next();
      if (attr === "순수" && !pure) pure = true;
      else if (attr === "해제" && !frees) frees = true;
      else throw new DeclarationError(`'${attr}' is not 순수 or 해제, or is written twice`);
    }
    return { library, name, params, result, symbol, pure, frees };
  });
}
