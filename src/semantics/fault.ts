// An ordinary run-time error the program itself caused (an overflow, an index out of
// range, a division by zero): the run ends with FAULT. Distinct from plain Errors,
// which mean an internal invariant broke (the type checker let something through).
export class RuntimeFault extends Error {}
