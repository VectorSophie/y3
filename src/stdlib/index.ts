import type { Callable } from "../ir/callables";
import { CLOCK } from "./clock";
import { LISTS, MAPS, SETS } from "./collections";
import { CONVERT } from "./convert";
import { FS } from "./fs";
import { IO } from "./io";
import { MATH } from "./math";
import { TEXT_LIBRARY } from "./text";
import { CHOICE } from "./choice";

// Every built-in callable. Spelling in source: '<namespace> <name>' in Korean; identity:
// a stable id such as std.io.println.
export const STANDARD_LIBRARY: readonly Callable[] = [...IO, ...TEXT_LIBRARY, ...MATH, ...CONVERT, ...LISTS, ...MAPS, ...SETS, ...FS, ...CLOCK, ...CHOICE];
