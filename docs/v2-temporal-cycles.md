# Y3 v2 — temporal cycles (M4)

M3 let a later statement determine an earlier unknown. M4 lets time loop: a value can
travel from later to earlier, an iteration's end can be equated with its beginning, and
a value can take part in its own cause. Every cycle is still just more equations in the
M3 system `A x = b` over the integers (`v2-temporal-core.md`). M4 adds a graph of
temporal identities and a rule for when each edge closes, not a second solver.

## The sentences

| Sentence | Tense | Kind | Meaning |
|---|---|---|---|
| `[수가 다음에서 온다.]` | present | act | open a channel: 수 := a fresh β that something later will send back |
| `[수를 전으로 보낸다.]` | present | act | close 수's most recent open channel: β = 수's current value |
| `[처음은 끝이었다.]` | past | relation | when this iteration ends, every name it wrote must equal its value at 처음 |
| `처음의 수` | — | value | 수 as it was when the current iteration began |
| `끝의 수` | — | value | 수 as it will be when the current iteration (or the run) ends |

- **Anchors in relations.** They work as the subject of a relation, and the tense must
  agree: `[처음의 수는 5였다.]` (past), `[끝의 수는 0일 것이다.]` (future).
- **Anchors are never written.** `[처음의 수는 3이다.]` is an error (`Y3G010`).
- **Mismatched tense is an error.** `[끝의 수는 0이었다.]` gives `Y3G011`.

## Identities across a cycle

- **A symbol keeps its identity for the whole run.** α (`미정`), β (a channel) and ε
  (`끝의 N`) are named by origin and numbered in order of birth.
- **Every iteration of a `여기가 처음이다` loop is a scope.** Outside any loop, the run is
  the scope. A scope remembers:
  - the bindings it began with (its `처음`, a snapshot of identities, not of values);
  - the names it wrote;
  - what must close when it ends.
- **A channel is a slot on a per-name stack.** Each channel stays open across iterations
  until something sends to it. `보낸다` closes the most recent open slot for that name.

## When constraints close

| Edge | Closes |
|---|---|
| channel β ← sent value | at `보낸다`, immediately |
| `일 것이다` promise | when the scope ends |
| `끝의 N` read (ε) | when the scope ends: ε = N's binding then |
| `처음은 끝이었다` | when the scope ends: start = end for every name written in it |

**When a scope ends:**
- a back-edge (`끝은 처음이다`);
- a failed conditional back-edge (falling through leaves the loop);
- the anchor being reached again;
- an outer anchor closing inner loops;
- `끝이다`, which closes every open loop and then the run.

**Ending the run with open channels.** A channel still open at `끝이다` is reported as
`never answered`. Its symbol stays open, so output that depends on it is `AMBIGUOUS`.
A `보낸다` with no open channel is a `PARADOX`: no past is listening.

**What a fixed point covers.** `처음은 끝이었다` covers *every* name written during the
iteration, including loop counters. It is a whole-scope fixed point: the iteration as a
whole changes nothing. Names introduced during the iteration have no `처음` and are left
out. A selective form that constrains one name without freezing loop-management state,
`[처음의 수는 끝의 수였다.]`, is planned for when the general core grows.

**Fixed points and branches.** A value determined only by its iteration's fixed point is
open until that iteration ends. A condition on it inside the iteration is `UNRESOLVED`.
Letting the branch use it would be future-dependent control flow.

## Self-caused values

Self-causation is a property of the temporal dependency graph, not of the sentence that
made the cycle.

> A value is **SELF_CAUSED** when its determining cycle closes back onto its own
> symbolic origin, contains no external operational cause, and the resulting
> constraints uniquely determine it.

**Cycle edges.** Three constructs close a cycle, and each one equates an origin with
what came back to it. All three go through the same rule.

| Edge | Origin | Returned value | Trace says |
|---|---|---|---|
| channel | its β | the value sent back | `via channel S1` |
| `끝의 N` | its ε | N's binding at the end | `via 끝의 수` |
| fixed point | each name's binding at `처음` | that name's binding at the end | `via fixed point at t5` |

**External cause.** Whether a value carries an operational cause is read from its
*normal form* Σ cᵢ·symbolᵢ + k, the same form the solver sees:
- A concrete value is caused.
- A term with a non-zero constant k is caused.
- A term made only of symbols (k = 0) is uncaused.

Causality therefore survives trivial rewrites:
- `x + 0`, `x - 0` and `x + 3 - 3` are all `x`, so they stay uncaused;
- adding a name whose value is 0 is neutral too;
- `x + 1` carries a genuine contribution, so it is caused.

**The cycle closes on itself** when neither the origin nor the returned value is caused
and the returned value contains the origin's symbols. The edge is recorded on those
symbols. What follows is decided by the solver alone:

| Program | Equation | Result |
|---|---|---|
| send β back unchanged (or `+ 0`) | β = β | closed on itself, but open: output depends on it, so `AMBIGUOUS` |
| `수에 수를 더한다`, send back | β = 2β | unique: **self-caused** β = 0 |
| `수에 수를 더한다`, `처음은 끝이었다` | α = 2α | unique: **self-caused** α = 0, the same shape through a fixed point |
| `수는 끝의 수이다`, `수에 수를 더한다` | ε = 2ε | unique: **self-caused** ε = 0 |
| `수에 1을 더한다`, send back | β = β + 1 | no solution: `PARADOX` (the 1 is a cause, so this is not a self-loop) |
| `수에 수를 더한다`, `수에서 3을 뺀다`, fixed point | α = 2α − 3 | unique, but caused by the 3: retroactive α = 3 |
| send β back, then `[문장은 "날자"였다.]` | β = β, β = "날자" | **self-caused** "날자": testimony pins it, and a past statement describes rather than causes |

A fixed point whose starting value already carries a cause (`수` was `α + 1` before the
loop) is caused, even when the loop body adds no literal.

## Reading a trace

```
1 (0,0,0) 남/위 [수가 다음에서 온다.] → (0,1,0) 남/위
  channel S1 opens: 수 := β1  [다음에서 온다]
2 (0,1,0) 남/위 [수에 수를 더한다.] → (0,2,0) 남/위
  수 := 2·β1
5 (0,3,1) 남/위 [수를 전으로 보낸다.] → (0,4,1) 남/위
  channel S1 closes: 2·β1 back to t1  [closes on itself]
  constraint β1 = 2·β1  [channel S1]
  self-caused β1 = 0  [via channel S1; closed on itself, no external cause]
  out "0"  [held since t3]
…
symbols:
  β1 (수, born t1) = 0 at t5 [self-caused via channel S1]
```

The trace shows where the value comes from: the channel that opened, the edge that
closed the cycle on itself, the single equation that pins it, and the statement that
nothing outside the cycle caused it. A fixed point reads the same way:
`self-caused α1 = 0  [via fixed point at t4; closed on itself, no external cause]`
(`cycles/fixed-point-self-caused.y3`). Other lines:

- `처음은 끝이었다  [due end of 처음 (0,1,0) #1]` marks where a fixed point was stated.
  When it falls due, `constraint α1 = 2·α1 - 3  [처음은 끝이었다 at t5]` shows the
  equation it adds.
- `끝의 합 = ε1  [due end of run]` marks a read from the end; its closing equation is
  `constraint ε1 = 5  [끝의 합 from t1]`.
- An open self-loop shows in the symbol summary as `β1 (문장, born t1) closed on itself
  via channel S1, open`.

## Not in M4

These are not part of M4:
- future-dependent branch selection (`일 것이라면`)
- nonlinear solving
- inequalities
- arbitrary or canonical choice among solutions

An open self-loop stays open; Y3 does not invent the sentence that travelled.
