import { RuntimeFault } from "../semantics/fault";
import { renderValue, type ConcreteValue } from "../semantics/values";
import { TEXT, UNIT_TYPE } from "../types/types";
import { asText, namespace, none, option, some, T, text } from "./core";

// std/io (표준). Output goes to stdout through the runtime's one output path; 말한다
// lowers to 줄출력. Input is grounded: a read value is concrete and recorded, and no
// later constraint can change what was read.

// The pieces of a 형식 template: text between "{}" holes; "{{" and "}}" are braces.
export function templateParts(template: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < template.length; i += 1) {
    const two = template.slice(i, i + 2);
    if (two === "{{" || two === "}}") {
      current += two[0];
      i += 1;
    } else if (two === "{}") {
      parts.push(current);
      current = "";
      i += 1;
    } else if (template[i] === "{" || template[i] === "}") {
      return null;
    } else {
      current += template[i];
    }
  }
  parts.push(current);
  return parts;
}

function format(args: readonly ConcreteValue[]): ConcreteValue {
  const [template, ...values] = args;
  const parts = templateParts(asText(template));
  if (!parts) throw new RuntimeFault(`'${asText(template)}' is not a template: a lone '{' or '}' must be doubled`);
  if (parts.length - 1 !== values.length) throw new RuntimeFault(`the template has ${parts.length - 1} '{}' for ${values.length} value${values.length === 1 ? "" : "s"}`);
  return text(parts.map((part, i) => part + (i < values.length ? renderValue(values[i] as ConcreteValue) : "")).join(""));
}

export const IO = namespace("std.io", "표준", {
  print: ["출력", { kind: "output", newline: false, signature: { typeParams: ["T"], params: [T], result: UNIT_TYPE } }],
  println: ["줄출력", { kind: "output", newline: true, signature: { typeParams: ["T"], params: [T], result: UNIT_TYPE } }],
  format: ["형식", { kind: "pure", signature: { params: [TEXT], rest: "any", result: TEXT }, apply: format }],
  readLine: [
    "줄읽기",
    {
      kind: "effect",
      signature: { params: [], result: option(TEXT) },
      perform: (_args, ctx) => {
        const line = ctx.host.readLine();
        ctx.record("stdin.line", line === null ? "<end>" : JSON.stringify(line));
        return line === null ? none : some(text(line));
      },
    },
  ],
  readToken: [
    "낱말읽기",
    {
      kind: "effect",
      signature: { params: [], result: option(TEXT) },
      perform: (_args, ctx) => {
        const token = ctx.host.readToken();
        ctx.record("stdin.token", token === null ? "<end>" : JSON.stringify(token));
        return token === null ? none : some(text(token));
      },
    },
  ],
});
