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

## What the solver does and doesn't do

It adds linear equalities over the integers, incrementally, and reports consistency and
newly determined symbols. A system with one equation in two unknowns resolves neither.
It never picks a value, never searches, and never chooses a branch. A condition on an
open symbol is `UNRESOLVED`, even `α = α`.

Integer solvability is checked per equation: the gcd of the coefficients must divide
the constant. A whole system can still lack an integer solution while each equation
passes this check. That limitation is documented, and the cases are rare.

## Reading a trace

```
4 (0,3,0) 남/위 [원래를 말한다.] → (0,4,0) 남/위
  out α1  [held]                                    ← present execution, symbolic value
6 (0,4,1) 남/위 [값은 4였다.] → (0,5,1) 남/위
  constraint α1 + 1 = 4  [past]                     ← constraint introduced
  retro α1 = 3  [born t1; fills t2, t3, t4]         ← retroactive resolution
  out "3"  [held since t4]                          ← the held line is now determined
```

- **Plain resolution.** A resolution that nothing depended on yet reads
  `resolved α1 = 7`.
- **Promises.** A promise reads `promise 값 = 4  [due end of run]` where it is made,
  and `constraint …  [promised at t2]` where it falls due.
- **Symbol summary.** The end of a trace lists every symbol with its state.

## Not yet (M4)

These are refused with `Y3T001`/`Y3T002`:
- the fixed point `처음은 끝이었다`
- time anchors `처음의` and `끝의`
- channels `다음에서 온다` and `전으로 보낸다`

The bootstrap trio waits for channels.

Also not planned: future-dependent branches `일 것이라면`, a canonical choice among
several solutions, inequalities, and nonlinear terms.
