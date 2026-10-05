# Plait — a woven cord along the line

| | |
|---|---|
| file | `lab/forms/plait.form.ts`, `ops.id 'ripple'`, `v 105` |
| ink | indigo (a carved stone knot on Paper; a cord of light on Night) |
| locality | trunk replacement (`trunkReach 0`, `trunkDepthReach 0`) + local chain, `reach 12`, `halfWin 12` |
| depth | `dMax 4`, `baseDefault 2`, `radialCeiling 4` |
| budgets | `unitBudget 220` (ceiling lowered to the 1/16 level that fits, Sprout's `treeCeiling`), `strokeBudget 20000` (causal) |
| mood | bold · structural · pigment |

## Concept

The stroke becomes a cord. As it rises the trunk thins to a core strand and two strands twine around it in the 120° rhythm of a three-strand plait, **passing over and under** with the carved gaps of a knotwork panel; the third strand arrives at depth 3 and at depth 4 each strand carries the carver's inner groove. A heavy hand makes a fat, long-period rope; a fast hand braids loose; a tilted pen lays the cord over to one side; a held tap ties a trefoil. Over/under occlusion is a primitive no shipped Form has.

## Algorithm (operator model)

**Trunk** (stations only, like Line's path through `stationTrunk` but with a per-station multiplier): `w·lerp(1, 0.45, clamp(d(s_i), 0, 1))·lerp(1, 0.5, clamp(d(s_i) − 2, 0, 1))`: the core thins as strand 0 arrives and thins again as the third strand takes over. Depth 0 is bit-exactly the plain trunk.

**Chain**: unit `j` = one braid period `[s_j, s_j + P_j]`.

```
w_s    = max(0.35, 0.45·w_sp) sp                                         strand width
P(s)   = clamp(6·w_sp + 14, 20, 72)·(1 + 0.6·fast)·(1 + 0.5c)            fast = smoothstep(1, 2.5, v̄n)
A(s)   = A0·clamp(1 − A0·|κ̄|/0.8, 0.3, 1),  A0 = 0.9·w_sp + 2 sp          inner strands never fold on bends
A_±    = A·(1 ± 0.4·tiltAcross)·(1 − 0.5·max(0, ±cs))                     lean and crowding flatten one side
cursor : s_0 = s0;  s_{j+1} = s_j + P(s_j);  need = (phase 0 ? s0 : cur.s) + 12;  keep(s) = s + P(s) ≤ L
         a corner station inside the period ends the unit 2 sp before it and the next starts 2 sp after (cut cord, rounded caps)
strand m ∈ {0,1,2}: o_m(s) = A_σ·dsin(φ + 2πm/3),  φ = 2π(s − s_j)/P_j,  point = pos(s) + o_m·n(s),  sampled every 2 sp (P/2 + 1 pts)
crossings: strands meet where their sines are equal: φ = π/6 + kπ/3, k = 0..5, one per cell k = floor(6(s − s_j)/P)
           pair (0,1) at k ∈ {0,3}, (1,2) at {1,4}, (0,2) at {2,5}
rule   : the strand with do/ds > 0 at the crossing passes OVER at even k, UNDER at odd k
         (analytically this gives each strand over, under, over, under per period; the unit test checks it numerically)
gap    : the under strand is split around the crossing by g = clamp(0.6·w_s + 0.8, 0.8, P/14) sp each side (gap end widths eased over 0.5 sp)
```

| gen | geometry | drawn to |
|---|---|---|
| m + 1 | strand `m` as 1–3 branches (split at its under crossings), width `w_s`, α 0.8, bucket `m + 1` | branch `k` of strand `m` drawn to `clamp(λ − a0_k, 0, len_k)` with `λ = P_j·clamp(D − m, 0, 1)`: strand 0 arrives over d ∈ (0, 1], strand 1 over (1, 2], strand 2 over (2, 3] |
| 4 | the carver's groove: a centre hairline on every strand branch, width `max(0.35, 0.12·w_sp)`, bucket 4, α 0.6 | eases in by width `×clamp(D − 3, 0, 1)`; same prefix as its strand |

`cook` stores the sampled offset points per branch (`pa` = arc along the strand); `count` and `emit` are prefix sums. No rng at all (the braid is deterministic); the only transcendentals are `dsin` per sample. Both sides of `A_±` are cooked, so `side` is unused.

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | a fast hand braids loose: `P ×(1 + 0.6fast)`; slow is tight |
| Pressure | through `w`: strand width, period and amplitude all grow: a heavy hand makes a fat, long-period rope |
| Lean / tilt | across-stroke tilt flattens the braid on the lean side and lifts the other: a cord lying over |
| Curvature & corners | the braid rides the normal; `A` shrinks on tight bends so inner strands never fold; at a corner the cord is cut with rounded caps and a 4 sp gap: the standard knotwork break |
| Closing a loop | strands end at the seam as a cut cord (last unit kept only if `s_j + P ≤ L`); exact tiling `P' = L/round(L/P)` is a global retime: noted for a cook.ts hook, not hacked |
| Holding | strand 2 (d > 2) and the groove (d > 3) appear in the pool and the core thins there: a thick knot at the hold |
| Nearby ink | `cs` flattens the braid on the crowded side; `c` lengthens `P`; glow dims strands |
| Nib | pen: tight thin cord; brush: strands follow `p`; chisel: strands as `PolyKind.Chisel` at `θ_nib`: a flat tablet-woven band |
| Zoom | `P`, `A` in sp: zoom in for a fine braid |

**Tap**: the dot; held: a trefoil `x = dsin t + 2·dsin 2t, y = dcos t − 2·dcos 2t` scaled to `R = (8 + 1.2S)(0.5 + p)/3` sp, 72 points, its three self-crossings at baked `t` constants (found once numerically, stored in the file) with alternating over/under gaps; prefix by `t` over d ∈ [0, 2], groove over [2, 4]. **Loop**: a cut cord at the seam (honest). **Hold**: a knot.

## Night / Paper

Night: an *over* crossing adds a bright lozenge where two strands overlap; bounded by the trunk thinning to 0.45w above d = 1 (so core crossings are small), strand α 0.8, and the under strand's gap removing half of all overlaps. Paper: the darker multiply at an over-crossing is exactly the shadow a carver cuts; the groove at d = 4 completes the stone-knot look. This Form will look best on Paper.

## Budgets

3 strands × (`P/2 + 1 + 4` gap points) + 3 grooves of the same ≈ 6 × 40 = 240 at `P = 72` (`unitBudget 220`, ceiling lowered when it does not fit); ≤ 4 pts/sp. `strokeBudget 20000` ≈ 100 units at `P = 72`, 500 at `P = 20`.

## Acceptance criteria (judged in screenshots)

1. **A true plait.** On the signature gesture at base 3 (depth sheet, d ≥ 3) every strand visibly alternates over and under at consecutive crossings (no strand passes over twice in a row), gaps are clean (the over strand is never nicked), and the three strands never fold on the signature's bends.
2. **The hand changes the rope.** On the speed sheet the fast stroke's braid is visibly longer-period and looser; on the nibs sheet the brush cord is fat and long-period, the pen cord tight and fine, and both remain legible plaits.
3. **Two grounds.** On Night over-crossings read as bright lozenges but no run of the cord goes white; on Paper the same crossings read as carved shadow and the held tap is a trefoil with alternating gaps.

Risks noted: over/under correctness is the one claim that needs its unit test before any shot; tight loops degenerate to a thin twist (accepted).
