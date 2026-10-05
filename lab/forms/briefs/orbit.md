# Orbit — epicycles around the nib

| | |
|---|---|
| file | `lab/forms/orbit.form.ts`, `ops.id 'ripple'`, `v 106` |
| ink | rose (copperplate flourish; the thirds deepen around every loop) |
| locality | local chain, `reach 40`, `halfWin 40`, trunk plain `{w 0.9, α 1}` |
| depth | `dMax 4`, `baseDefault 2`, `radialCeiling 4` |
| budgets | `unitBudget 220`, `strokeBudget 24000` (causal) |
| mood | bold · dynamics · pigment (a flourish on Paper, a rope of light-loops on Night) |

## Concept

A satellite circles the nib as it travels, and its trail, a trochoid, curls along the stroke in an unbroken rope of loops. Rising adds epicycles so every loop grows a lace edge, like a Fourier drawing of your own line or the edge of a copperplate flourish; a slow hand makes tight round loops, a fast hand stretches them into cusps and waves. A tap draws a spirograph rose. Nothing in the shipped Forms is *kinematic*: Orbit's shape is the motion of the hand integrated, not geometry grown from it.

## Algorithm (operator model)

Unit `j` = one orbit `[s_j, s_j + P_j]`; every orbit starts at phase 0 on `+t`, so consecutive orbits (and the seam of a loop) join exactly.

```
P(s)   = clamp((8 + 1.4S)·(0.6 + 0.9·smoothstep(0.4, 2.4, v̄n)), 8, 36) sp        (v̄n over ±12 sp)
R(s)   = (3 + 0.9S)(0.5 + p)·(1 − 0.5·smoothstep(1, 2.6, vn))·(1 − 0.4c) sp
cursor : s_0 = s0;  s_{j+1} = s_j + P_j;  need = (phase 0 ? s0 : cur.s) + 40;  keep(s) = s ≤ L − 0.45·P(s)
seam   : when cx.final, a unit with s_j + P_j > L stretches to P_j' = L − s_j; its predecessor (also in the tail re-cook zone, halfWin 40)
         takes the stretch itself when the straddling unit would be shorter than 0.45P (then keep() drops it). Loops close exactly.
epicycles (m_k, R_k/R): (1, 1), (−5, 0.30), (+7, 0.12);  φ_1 = 2πu, u = (s − s_j)/P_j;  φ_k = m_k·φ_1
lean   : pen with cos(alt) > 0.3: components along tiltVec scaled by 1 − 0.6·cos(alt) (the circle seen in perspective)
cs     : the n-component on the ink side scaled by 1 − 0.6·max(0, ±cs) (loops lean away from neighbours)
trail  : T(s) = pos(s) + Σ_k f_k(D)·R(D)·ρ_k·(cos φ_k·t(s) + sin φ_k·n(s)),  f_k = clamp(D − k + 1, 0, 1),  R(D) = R·(1 + 0.5·clamp(D − 3, 0, 1))
```

`cook` at the ceiling stores per sample `x, y, tx, ty, nx, ny` and the three `(cos φ_k, sin φ_k)` pairs (after the lean / `cs` scales), sampled so the ceiling trail advances ≤ 1.25 sp per sample (≈ 200 samples per orbit at the brush), plus the stored width profile below. `emit` at depth `D` sums the stored terms with weights `f_k(D)` and `R(D)` (the trail grows out of the trunk as a wobble at D ≈ 0.3, a wave at 0.6, loops at 1; every epicycle grows from radius 0), writes each orbit as three polys split by thirds of `u` with buckets 1 / 2 / 3 (Drift's tone thirds, shared joints), and on an open stroke's final unit tapers width by `smoothstep(0, 6, L − s)`. `count` = samples + 4. Depth is continuous by construction and rising never re-cooks.

```
width  : brush: 0.55·w_sp·(1.3 − 0.8·v̂_k), v̂_k = normalised finite-difference speed of the CEILING trail (stored at cook, so truncation stays exact):
         thick where the satellite slows at the inner cusp, thin on the outer sweep (a flourish); pen: 0.5·w_sp constant; floor 0.35 sp
alpha  : 0.8·glow(c);  tone = toneOf(p, third + 1);  gen 1 for all three thirds;  no rng (the orbit is deterministic)
```

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | period 0.6× → 1.5× and radius ×0.5 at speed: slow hands make tight round loops, fast ones stretch them into cusps and waves (`2πR/P → 1`) |
| Pressure | orbit radius `∝ (0.5 + p)`; brush width breathes with the satellite's speed |
| Lean / tilt | eccentricity: leaning squashes the loops into ellipses whose minor axis points along the lean |
| Curvature & corners | the orbit lives in the moving frame `(t, n)`, so loops spread outside bends and bunch inside; a corner flips the frame and the satellite swings wide around it (a crack-the-whip loop) |
| Closing a loop | the straddling orbit stretches to end at `L`; every orbit starts at phase 0, so the rope of loops joins itself exactly at the seam |
| Holding | epicycles 2–3 and the swell (`D > 3`) follow `d(s)`: the curls near the hold turn to lace and swell, then plain again over 32 sp |
| Nearby ink | `R ×(1 − 0.4c)`; loops lean away from side ink; glow |
| Nib | pen: hairline trail; brush: the flourish (width from speed); chisel: Chisel polys with the nib angle per point (true copperplate; prototype second) |
| Zoom | `P`, `R` in sp |

**Tap**: a rose: hypotrochoid `(m, R) = (1, R), (−4, 0.35R)` (five petals), traced as a prefix to fraction `min(1, D/2)` of its parameter (the pen draws the rosette for you), the moon epicycle `(+7, 0.12R)` fading in with `clamp(D − 2, 0, 1)`; 360 samples. **Loop**: an unbroken wreath of loops. **Hold**: lace and swell around the hold.

## Night / Paper

Night: the trail (gen 1, α 0.8) split per orbit into thirds with buckets 1 / 2 / 3, so each loop deepens in colour around itself (Spectral or Rose ink turns hue per third); loops overlap only at their crossings, so no blow-out. Paper: flourish ink, the thirds reading as the nib loading and unloading around every loop; the speed-width makes it a real pen flourish.

## Budgets

Brush S 9, p 0.5: `R` 11 sp, `P` 21 sp (12 slow, 31 fast); trail length per orbit ≈ P + 2πR·(1 + 1.5 + 0.84) ≈ 250 sp at the ceiling → ≤ 200 samples per 21 sp ≈ 9.5 pts/sp; 1500 sp ≈ 14 k, under `strokeBudget 24000`. Sampling the ceiling trail wastes points at D = 1 (the trail is shorter there); accepted rather than a visible density step.

## Acceptance criteria (judged in screenshots)

1. **One rope.** On the signature gesture the loops form a continuous trail with no gap or kink between orbits; loops are round on the slow stretches and stretched into cusps/waves on the fast ones; the trunk stays visible underneath.
2. **Seam.** On the loop gesture the wreath joins itself with no doubled, missing or half-size loop at the seam, and the loops spread on the outside of the circle.
3. **Depth ladder and tap.** On the depth sheet d = 1 is plain loops, d = 2 frilled with five lobes per loop, d = 4 lace swollen 1.5×; the held tap is a five-petal rose drawn as a growing prefix; on Night the thirds are visibly three tones around every loop and no crossing goes white.

Risks noted: on tight curvature the loops self-overlap (the per-third tones and `R ×(1 − 0.4c)` help; the frame is already smoothed over 6 sp); the chisel variant needs an angle per point (available in `Sink.pt`): prototype second.
