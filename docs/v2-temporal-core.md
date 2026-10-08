# Y3 v2 — the temporal core (M3)

M3 adds the second half of the tense rule. Present tense executes (M2); past and
future tense constrain. It covers exactly three forms, with linear equalities only.

| Sentence | Tense | Kind | Meaning |
|---|---|---|---|
| `[값은 미정이다.]` | present | act | 값 := a fresh symbol α, which only the future can determine |
| `[값은 4였다.]` / `[값은 3이었다.]` | past | relation | constraint: 값's current value equals 4 (never writes) |
| `[값은 4일 것이다.]` | future | relation | promise: 값 equals 4 when the current loop iteration ends, or at the end of the run outside loops |

Relations never write a name, never move the pointer, and cannot be the consequence of
a condition.

## Two kinds of value

- **`ConcreteValue`** (`semantics/`) is `bigint` or text, nothing else. Present-tense
  execution works on these whenever the values involved are concrete.
- **`SymbolicTerm`** (`temporal/`) is a literal, a symbol α, or a linear expression
  Σ cᵢ·αᵢ + k. Arithmetic involving a symbol produces a symbolic term. The temporal
  store turns a term back into a concrete value as soon as its symbols are determined,
  and only then.

## The life of a name

```
unbound ──이다 / 더한다…──▶ present-assigned (concrete)
   │
   └──미정이다──▶ declared (symbolic) ──였다 / 일 것이다──▶ constrained ──▶ resolved
```

- **Introducing a name.** A name must be introduced somewhere: assigned in the present,
  or declared `미정`. A name that is only ever constrained is reported as never
  introduced (`Y3G007`). A name with no present-tense writer is fine if it is declared
  `미정`.
- **Arithmetic.** It fixes a symbol's sort (integer) but not its value: an α used only
  in arithmetic is still *declared*, not *constrained*.
- **Resolved.** A symbol is resolved when the equations leave exactly one value. It is
  **retroactive** when earlier steps already depended on it (copied it, computed with it,
  or printed it). The trace names those steps.

## Outcomes

| Status | 진단 | Exit | When |
|---|---|---|---|
| `HALT` | 정지 | 0 | `끝이다`, constraints consistent, every output line determined |
| `PARADOX` | 역설 | 4 | a constraint contradicts what is known. That covers no solution, no integer solution (2α = 3), or text against a number. The run stops at that step. |
| `UNRESOLVED` | 미결 | 5 | a condition needs a symbol that is still open; the run stops there |
| `AMBIGUOUS` | 중의 | 6 | the run ended, but an output line depends on a symbol the constraints leave open. That line prints as `?`. |

An open symbol that never reaches the output is harmless.

## The solver model

Every temporal constraint in Y3 (past statements, promises, and from M4 also channels,
fixed points and time anchors) becomes one linear equation over symbols. Together they
form one system

```
A x = b        A an integer matrix, b an integer vector, x the symbols, over ℤ
```

which the solver treats in exactly three parts.

1. **Exact whole-system integer feasibility.** After each new equation, the whole system
   is brought to column Hermite form with unimodular column operations in `bigint`, and
   solved by forward substitution. An integer solution exists exactly when every step
   divides evenly. Checking each equation alone (the gcd of its coefficients divides its
   constant) is necessary but not sufficient. 3x + 3y + 2z = −4 and 3x + z = −4 each
   pass that check, but together force z ≡ 1 and z ≡ 2 (mod 3).
2. **Rational elimination for determination.** Fraction-free Gaussian elimination keeps
   the equations in reduced form. A symbol is determined when its row mentions nothing
   else.
3. **Unique over ℚ, plus integer-feasible, means unique over ℤ.** If the system has an
   integer solution, any rational direction of freedom scales to an integer one. So a
   symbol that is unique over the rationals is unique over the integers, and no search
   is needed.

That gives exactly three answers:

- **No integer solution:** `PARADOX` ("no integer solution" for the equation alone, or
  "… together with the earlier constraints").
- **Integer solutions, and a symbol pinned down:** resolved.
- **Integer solutions, but a symbol left open:** it stays open, and output that depends
  on it is `AMBIGUOUS`.

`temporal/integer-paradox.y3` and `temporal/integer-ambiguous.y3` show the two sides at
the language level.

### What the solver is not

This boundary is part of the design, not a gap to fill later.

- **No choosing.** It never picks a value the equations leave open. A canonical or
  arbitrary choice ("Novikov selection") is out of scope.
- **No branching.** It never decides control flow: a condition on an open symbol is
  `UNRESOLVED`, even `α = α`.
- **Nothing beyond linear equalities.** There are no inequalities, no nonlinear terms
  (an unknown times an unknown), and no disjunction or search.
- **No second model.** New temporal features (M4's cycles included) must be expressible
  as more equations in the same `A x = b`.

Text symbols are handled outside the matrix by unification. They take part only in
equations with text or with themselves.

## Later milestones

Temporal cycles (M4) are described in `v2-temporal-cycles.md`. They add channels
(`다음에서 온다`, `전으로 보낸다`), the fixed point `처음은 끝이었다`, and the time anchors
`처음의` and `끝의`, all as equations in the same system.

Not planned: future-dependent branches `일 것이라면`, a canonical choice among several
solutions, inequalities, and nonlinear terms.
