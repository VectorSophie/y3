import { int, text, type ConcreteValue } from "../semantics/values";
import { BOOL, named, TEXT, UNIT_TYPE } from "../types/types";
import type { EffectContext } from "../ir/callables";
import type { FsResult } from "./host";
import { asText, bool, err, namespace, ok, result, variant } from "./core";

// std/fs (파일): synchronous files. Every failure the outside world can cause is an
// ordinary FsError value in a Result, never a FAULT. Text is UTF-8; a file that is not
// valid UTF-8 is an Err(Other(…)) when read as Text.

const FS_ERROR = named("FsError");
const FILE = named("File");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNIT: ConcreteValue = { kind: "unit" };

const failure = (kind: string, message: string) => err(variant("FsError", kind, text(message)));
const wrap = <T>(r: FsResult<T>, value: (v: T) => ConcreteValue) => (r.ok ? ok(value(r.value)) : failure(r.kind, r.message));
const decode = (bytes: Uint8Array): ConcreteValue => {
  try {
    return ok(text(decoder.decode(bytes)));
  } catch {
    return failure("Other", "the file is not valid UTF-8");
  }
};

// An open file is a handle on a path; the runtime keeps the table.
function handle(ctx: EffectContext, value: ConcreteValue | undefined): { path: string; open: boolean } | ConcreteValue {
  const entry = value?.kind === "resource" ? ctx.files.get(value.id) : undefined;
  if (!entry) throw new Error("a File was expected; the type checker should have caught this");
  return entry.open ? entry : failure("Closed", `${entry.path} is closed`);
}
const isHandle = (h: ReturnType<typeof handle>): h is { path: string; open: boolean } => "path" in h;

function open(ctx: EffectContext, path: string): ConcreteValue {
  const id = ctx.files.size + 1;
  ctx.files.set(id, { path, open: true });
  return ok({ kind: "resource", resource: "file", id });
}

export const FS = namespace("std.fs", "파일", {
  read: [
    "읽기",
    {
      kind: "effect",
      signature: { params: [TEXT], result: result(TEXT, FS_ERROR) },
      perform: ([path], ctx) => {
        const r = ctx.host.readFile(asText(path));
        ctx.record("fs.read", r.ok ? `${r.value.length} bytes` : r.kind);
        return r.ok ? decode(r.value) : failure(r.kind, r.message);
      },
    },
  ],
  write: [
    "쓰기",
    { kind: "effect", signature: { params: [TEXT, TEXT], result: result(UNIT_TYPE, FS_ERROR) }, perform: ([path, body], ctx) => wrap(ctx.host.writeFile(asText(path), encoder.encode(asText(body))), () => UNIT) },
  ],
  exists: [
    "존재",
    {
      kind: "effect",
      signature: { params: [TEXT], result: BOOL },
      perform: ([path], ctx) => {
        const found = ctx.host.stat(asText(path)).ok;
        ctx.record("fs.exists", String(found));
        return bool(found);
      },
    },
  ],
  metadata: [
    "정보",
    {
      kind: "effect",
      signature: { params: [TEXT], result: result(named("FileInfo"), FS_ERROR) },
      perform: ([path], ctx) => {
        const r = ctx.host.stat(asText(path));
        ctx.record("fs.metadata", r.ok ? `${r.value.size} bytes` : r.kind);
        return wrap(r, (info) => ({ kind: "data", type: "FileInfo", variant: null, fields: [int(info.size), bool(info.directory)] }));
      },
    },
  ],
  open: [
    "열기",
    {
      kind: "effect",
      signature: { params: [TEXT], result: result(FILE, FS_ERROR) },
      // An existing file, for reading and appending.
      perform: ([path], ctx) => {
        const r = ctx.host.stat(asText(path));
        if (!r.ok) return failure(r.kind, r.message);
        if (r.value.directory) return failure("IsDirectory", `${asText(path)} is a directory`);
        return open(ctx, asText(path));
      },
    },
  ],
  create: [
    "만들기",
    {
      kind: "effect",
      signature: { params: [TEXT], result: result(FILE, FS_ERROR) },
      // A new, empty file (an existing one is emptied).
      perform: ([path], ctx) => {
        const r = ctx.host.writeFile(asText(path), new Uint8Array());
        return r.ok ? open(ctx, asText(path)) : failure(r.kind, r.message);
      },
    },
  ],
  readHandle: [
    "내용",
    {
      kind: "effect",
      signature: { params: [FILE], result: result(TEXT, FS_ERROR) },
      perform: ([file], ctx) => {
        const h = handle(ctx, file);
        if (!isHandle(h)) return h;
        const r = ctx.host.readFile(h.path);
        ctx.record("fs.read", r.ok ? `${r.value.length} bytes` : r.kind);
        return r.ok ? decode(r.value) : failure(r.kind, r.message);
      },
    },
  ],
  append: [
    "덧쓰기",
    {
      kind: "effect",
      signature: { params: [FILE, TEXT], result: result(UNIT_TYPE, FS_ERROR) },
      perform: ([file, body], ctx) => {
        const h = handle(ctx, file);
        return isHandle(h) ? wrap(ctx.host.appendFile(h.path, encoder.encode(asText(body))), () => UNIT) : h;
      },
    },
  ],
  close: [
    "닫기",
    {
      kind: "effect",
      signature: { params: [FILE], result: result(UNIT_TYPE, FS_ERROR) },
      perform: ([file], ctx) => {
        const h = handle(ctx, file);
        if (!isHandle(h)) return h;
        h.open = false;
        return ok(UNIT);
      },
    },
  ],
  join: [
    "경로잇기",
    {
      kind: "pure",
      signature: { params: [TEXT, TEXT], result: TEXT },
      // POSIX-style: a second absolute path replaces the first; one '/' between parts.
      apply: ([a, b]) => {
        const x = asText(a);
        const y = asText(b);
        return text(y.startsWith("/") || x === "" ? y : `${x.replace(/\/+$/u, "")}/${y}`);
      },
    },
  ],
});
