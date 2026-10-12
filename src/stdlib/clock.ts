import { int } from "../semantics/values";
import { I64 } from "../types/types";
import { namespace } from "./core";

// std/clock (시계), named so that it never meets Y3's own time (tense, 처음, 끝). A clock
// reading is a grounded event: concrete, recorded for replay, and an i64, so it can never
// become a temporal symbol (those are bigint or Text).
export const CLOCK = namespace("std.clock", "시계", {
  now: [
    "지금",
    {
      kind: "effect",
      capability: "clock",
      signature: { params: [], result: I64 },
      perform: (_args, ctx) => {
        const ms = ctx.host.nowMillis();
        return int(ms);
      },
    },
  ],
  monotonic: [
    "단조",
    {
      kind: "effect",
      capability: "clock",
      signature: { params: [], result: I64 },
      perform: (_args, ctx) => {
        const ns = ctx.host.monotonicNanos();
        return int(ns);
      },
    },
  ],
});
