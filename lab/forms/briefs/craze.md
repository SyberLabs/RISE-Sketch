# Craze — the stroke as a drying film

| | |
|---|---|
| file | `lab/forms/craze.form.ts`, `ops.id 'ripple'`, `v 101` |
| ink | oxide (Night: lava crust; Paper: terracotta glaze) |
| locality | local chain, `reach 48`, `halfWin 48`, trunk plain `{w 1, α 1}` |
| depth | `dMax 4`, `baseDefault 2`, `radialCeiling 4` |
| budgets | `unitBudget 96`, `strokeBudget 10000` (causal) |
| mood | bold · natural fracture · pigment (reads correctly on both grounds without geometry changes) |

## Concept

The stroke is a film of paint or mud that dries as it rises. A band a little wider than the nib breaks into a cellular network: transverse cracks run out from the stroke first, then each plate is split lengthwise by a crack that meets the older ones in T-junctions, then the plates split again, and finally the oldest seams widen and curl. Crack spacing scales with film thickness, so pressure makes bigger plates and a fast, thin stroke crazes finely. On Night the seams crossing the trunk are the hottest light (a cooling lava crust); on Paper the same seams multiply darker over the pigment (craquelure in old varnish). Nothing about Craze is a tree, a copy, a filament or a displacement: it is a *network*, the one primitive the four shipped Forms lack.

## Algorithm (operator model)

Unit `j` = transverse crack at `s_j` (gen 1) **plus the plate behind it** `[s_j − Λ_{j−1}, s_j]` (gens 2–4). The plate length is frozen in `rec.tmpl` (a float; `tmpl = 0` for `j = 0`, which has no plate). All geometry is built in band coordinates `(s, ν)` and mapped through the spine: `P(s, ν) = pos(s) + ν·n(s)` with the concave cap `ν·sign(κ̄) ≤ 0.8/|κ̄|`.

```
fast   = smoothstep(1.0, 2.4, v̄n)                            (v̄n, p̄, c̄, κ̄ over ±12 sp)
h(s)   = max(3.5, w_sp/2 + (3 + 0.4S)(0.5 + 0.8p)) · (1 − 0.35c)     band half-width (sp)
h_±    = h · (1 − 0.4·max(0, ±cs)) · (1 ± 0.4·tiltAcross)     free side wider, downhill side wider
Λ(s)   = clamp(2h·(0.8 + 0.7p)·(0.85 + 0.3r_j)·(1 − 0.4fast)·(1 − 0.4·min(1, |κ̄|/0.05))·(corner ? 0.5 : 1), 6, 44)
cursor : phase 0 → s_0 = s0 + Λ(s0)(0.5 + 0.5r);  s_{j+1} = s_j + Λ(s_j);  rec.tmpl = Λ(s_j)  (the next plate's length)
need   = (phase 0 ? s0 : cur.s) + 24;   keep(s) = s ≤ L − 6
```

Generation geometry (every crack is axis-aligned in `(s, ν)` with a wobble that vanishes at its ends, so junction points are computed once from the parent's function and reused: the network welds exactly):

| gen | what | drawn to |
|---|---|---|
| 1 | transverse crack through `s_j`: `s(ν) = s_j + tan(ψ_j)·ν + wob_j(ν)`, `ν ∈ [−h_−, +h_+]`, `ψ_j = clamp(0.6·tiltAlong, −0.5, 0.5)·35° + (2r − 1)·10°`; two polys (one per arm) sharing the centre point on the spine | `h_±·clamp(D, 0, 1)` centre-out |
| 2 | longitudinal split of the plate: `n2 = 2h < 0.9Λ ? 1 : 2` cracks at `ν_c = 0.6h(2r − 1)` (or `±0.35h(0.9 + 0.2r)`), from the T-junction on crack `j−1` (computed with crack `j−1`'s own rng addresses) to the junction on crack `j`; `ν(s) = ν_c + wob(s)·smoothstep(0, 3, s − s_a)·smoothstep(0, 3, s_b − s)` | `(s_b − s_a)·clamp(D − 1, 0, 1)` old-to-new |
| 3 | one transverse crack per sub-cell at `s_t = s_a + (s_b − s_a)(0.35 + 0.3r)`, from its longitudinal boundary to the next (or the band edge) | `clamp(D − 2, 0, 1)` |
| 4 | one longitudinal per tertiary-split cell; gen-1 and gen-2 seams widen `×(1 + 0.8·clamp(D − 3, 0, 1))` | `clamp(D − 3, 0, 1)` |

```
wob    = hats on nodes every 4 sp (amp 0.9(1 + fast)) + every 2 sp (amp 0.45(1 + fast)), addressed (j, k); points every 2.5 sp
widths : w_c = clamp(0.18·w_sp, 0.4, 1.8) sp · 0.78^(g−1), constant along a crack, child start eased over 1.5 sp
alpha  : 0.55·hierarchy(g)·glow(c);   tone = toneOf(p, g);   gens 3–4 never widen
rng    : Ch.Geometry (wobble), Ch.Length (Λ, ν_c), Ch.Angle (ψ), Ch.Growth (s_t); address j·32 + k
```

`count(g, D)` sums `prefixCount` over the branches with `clamp(D − g + 1, 0, 1) > 0`; `emit` writes the prefixes with the gen-4 width factor (a continuous function of `D`, recomputed on every truncation, Drift's precedent). The chain reads the spine on `[s_j − Λ_{j−1} − 4, s_j + h + 4] ⊂ [s_j − 48, s_j + 24]`.

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | thin film: `Λ ×(1 − 0.4fast)`, wobble `×(1 + fast)` → fine jagged crazing; slow = broad calm plates |
| Pressure | film thickness: `h` and `Λ ∝ (0.8 + 0.7p)`; seam width `0.18w` → heavy strokes crack into big slabs |
| Lean / tilt | tilt along the stroke shears the transverse cracks up to 35° (dragged plates); tilt across spreads the band downhill (`h_±`) |
| Curvature & corners | the band map fans cracks on the outside of bends; inside capped at `0.8/|κ̄|`; a `corner` station within ±6 sp halves `Λ` → corners shatter |
| Closing a loop | a cracked annulus (raku rim); the last partial plate before the seam stays whole and reads as the plate that broke first (nothing reads `closed`) |
| Holding | the film dries where you wait: pools split the local plates (gens 2–3), then widen the old seams (gen 4) |
| Nearby ink | band narrows `×(1 − 0.35c)` and spreads to the free side (`h_±`); glow budget on all seams |
| Nib | pen: ~10 sp band at S 2.5, 0.4 sp hairline seams (a line in cracked glaze); brush: band ≈ 2.5× the stroke; chisel: ribbons, `w` from the edge length |
| Zoom | band, spacing, wobble in sp: zoom in → finer crazing |

**Tap** (radial seed): a dried drop. `R = (5 + 1.1S)(0.5 + 0.9p)` sp; gen 1: 5–7 radial cracks from a centre offset `0.2R·r`, drawn to `R·min(D, 1)`; gen 2: a ring crack at `0.55R` growing around by `2π·clamp(D − 1, 0, 1)` from a random start; gen 3: short radials between ring and rim; gen 4: widening. ≈ 60 points.
**Loop**: see above (annulus, no seam artefact). **Hold**: gens 2–4 unfold only inside the pool window, so a hold is a patch of fine craquelure in a field of slabs.

## Night / Paper

Night: a lava crust. Seams crossing the trunk add to it (`1 + 0.55`), so the brightest light is in the cracks over the stroke, which is physically right; seams beyond the trunk are faint glowing hairlines. Paper: multiply makes the same seams darker over the pigment (craquelure), and the off-trunk seams are the varnish cracking past the paint. Both grounds read correctly from one geometry; gens 3–4 never widen so a held spot never blooms white.

## Budgets

~10 + 16 + 12 + 16 ≈ 54 pts, 11 polys per plate at the ceiling, 26 at base 2. 600 sp stroke ≈ 1.6 k pts. `strokeBudget 10000` ≈ 185 plates ≈ 3700 sp at the ceiling: the cheapest of the six.

## Acceptance criteria (judged in screenshots)

1. **Network, not hair.** On the signature and corners gestures every crack ends on another crack or on the band edge (T-junctions, no dangling tips except at the band edge), plates are visibly larger on heavy/slow runs and finer at corners, and no crack folds through another on the inside of a bend.
2. **Depth ladder.** On the depth sheet d = 1 shows transverse cracks only, d = 2 adds one longitudinal split per plate, d = 4 shows sub-plates and clearly wider gen-1 seams; the held tap is a dried drop with a ring crack. Every step reads as *more drying*, nothing moves.
3. **Two grounds, one geometry.** On Night the seams over the trunk are brighter than the trunk and brighter than the off-trunk seams; on Paper the same seams are darker than the trunk. No white blow-out at a held spot.

Risks noted: if a plate ever reads unsettled spine live, raise `need` to `cur.s + 28`; a closure-aware last plate would need the cook.ts "mark all units uncooked on closure change" line (not for the prototype).
