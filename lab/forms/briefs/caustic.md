# Caustic — the stroke as a mirror

| | |
|---|---|
| file | `lab/forms/caustic.form.ts`, `ops.id 'ripple'`, `v 103` |
| ink | spectral (hue rides `born`, so the fan disperses along the stroke for free) |
| locality | local chain, `reach 12`, `halfWin 12`, trunk plain `{w 1, α 1}` |
| depth | `dMax 4`, `baseDefault 2`, `radialCeiling 4` |
| budgets | `unitBudget 40`, `strokeBudget 16000` (causal) |
| mood | delicate · light · structural (Night is its home; Paper is engraver's reflection hatching) |

## Concept

A lamp shines on the page from the side you lean toward (or from the top when there is no tilt). The stroke is a polished mirror: fine reflected rays leave its lit face at the mirror angle, and where the line bends toward the lamp they gather into a burning caustic curve with a cusp at every curvature peak. A straight run throws parallel hatching; a drawn circle fills with the coffee-cup nephroid. Rising lengthens the rays and spreads the source, so a held spot blazes. Nothing grows *from* the stroke here: the stroke is an optical surface, which no shipped Form is.

## Algorithm (operator model)

Unit `j` = 8 sp of arc `[s_j, s_j + Δ]` holding 3 reflected rays and a 5-point segment of the caustic.

```
Δ      = 8·(1 + c);   s_0 = s0 + 1;   need = (phase 0 ? s0 + 1 : cur.s) + 12;   keep(s) = s ≤ L − 1
lamp L : pen, wt = smoothstep(0.1, 0.3, cos alt): L = normalize(wt·(−tiltVec) + (1 − wt)·down), tiltVec = (cos az, sin az) over ±12 sp
         (the source sits on the barrel side; if the gallery shows the fan on the wrong side, flip one sign)
         mouse / finger: L = screen-down rotated by r.rot
per ray at arc s (3 per unit at s_j + (q + 0.5)·Δ/3):
  n        = normal at s (κ over ±4 sp),  cos θ = |L·n|,  lit face outward normal n_lit = −sign(L·n)·n
  r        = L − 2(L·n)n                                 reflected direction (unit)
  real     = −κ·(L·n) > 0                                the light hits the concave face
  ρ_f      = min(cos θ / (2|κ|), 400)                    tangential focal distance (sp)
  c(s)     = pos(s) + ρ_f·r  (real)  |  pos(s) − ρ_f·r (virtual, drawn at α × 0.35 on even units only)
  scatter  = ±(0.02 + 0.25·smoothstep(0.6, 2.4, vn))·(2·rnd(seed, Ch.Jitter, j, q) − 1) rad applied to r
  ℓ_max    = (24 + 2.5S)(0.6 + 0.8p)·(1 − 0.5·max(0, cs·sideOf(r)))
  α_ray    = (0.08 + 0.14p)·min(1, ρ_f/12)·glow(c)      tight foci stay bright, never white
```

| gen | geometry | depth |
|---|---|---|
| 2 (bucket 2) | ray: origin on the lit edge `pos + n_lit·w/2`, through `c` as an intermediate point (so it is tangent to the caustic there), to `ℓ(D)`; width `0.25w_sp` → 0 (pen: hairline 0.35 sp) | `ℓ(D) = ℓ_max·min(D, 1)·(1 + 0.6·max(0, D − 1))`, a prefix |
| 2 | extended source: the pair `r_±` rotated ±2.5° with the same `ρ_f` | α × `clamp(D − 1, 0, 1)` |
| 1 (bucket 0) | the caustic: 5-point polyline `c(s)` over the unit at 2 sp, width `0.35w_sp·(0.5 + 0.5cos θ)`, α 0.9 | α × `smoothstep(0, 4, ℓ(D) − ρ_f)·smoothstep(400, 200, ρ_f)·cos θ` |

All three are prefixes or alpha weights, so depth is continuous; the lit-face flip at `L ⟂ n` is continuous because `cos θ → 0` fades everything there. `count(g, D)`: per ray 2 pts + 1 if `ℓ(D) > ρ_f`, ×3 when side rays are on, + 5 when the caustic alpha is > 0. `cook` stores origin, `r`, `r_±`, `ρ_f`, `cos θ` per ray and the 5 caustic points. rng: `Ch.Jitter` only, address `(j, q)`.

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | mirror roughness: ray scatter ±0.02 → ±0.27 rad; slow = polished, razor caustic; fast = brushed metal, a glittering band |
| Pressure | reflectivity: ray α `0.08 + 0.14p`, caustic width, ray reach `ℓ_max ∝ (0.6 + 0.8p)` |
| Lean / tilt | **the lamp**: rolling the pen swings the whole fan and the caustic with it; the clearest lean response of the six |
| Curvature & corners | the engine: tight concave bends focus close (bright knots), gentle ones throw long rays, straight runs hatch in parallel; at a corner the two faces reflect in two directions, rays cross in an X and the caustic jumps to a cusp |
| Closing a loop | the top of the loop throws a crown outward, the bottom's inner face focuses a nephroid inside (no occlusion, by design; nothing reads `closed`) |
| Holding | rays lengthen `ℓ(D)` and triple (`D > 1`): light pours in where you hold and the caustic blazes there |
| Nearby ink | α × `glow(c)`; rays shortened toward side ink |
| Nib | pen: hairline rays, thread caustic; brush: rays `0.25w` tapering to 0; chisel: the chisel edge normal replaces `n` (behind a flag for the prototype) |
| Zoom | reach and spacing in sp, κ in rad/sp: zoomed-in strokes focus finer |

**Tap**: a glint: 12 rays at `30°·i + 30°·r`, length `ℓ_max·min(D, 1)`, with a 4-point star caustic (the astroid of a point mirror), ≤ 60 points. **Loop**: the cup of light (above). **Hold**: the pool window lengthens and triples its rays only, so a held spot is a blaze on an otherwise quiet fan.

## Night / Paper

Night: α 0.12 hairline rays add up exactly where they fold, so the caustic's brightness is partly *earned* by additive overlap, with the explicit gen-1 caustic poly on top so the Form survives GEN_CULL at zoom-out. Paper: engraver's reflection hatching (rays at the raster's Paper scale, bucket 2) with the envelope drawn as a dense burnished line: structure instead of light. Spectral ink shifts hue along the stroke, so the fan disperses like a prism.

## Budgets

9 rays × 3 + 5 ≈ 32 pts per 8 sp = 4 pts/sp at the ceiling; 1500 sp ≈ 6 k. ~150 lines of code; the cheapest to prototype.

## Acceptance criteria (judged in screenshots)

1. **The nephroid.** On the loop gesture (Night, base 2) a bright cusped curve sits inside the loop on the side away from the lamp, with a crown of near-parallel rays outside the near side; the curve is continuous around its cusp (no gaps between units).
2. **Geometry obeys curvature.** On the corners gesture rays leave straight runs as parallel hatching with no caustic, and cross in an X at every corner; on the signature gesture the caustic appears only at the bends, brightest at the tightest one, never white (no clipped core at a focus).
3. **Speed and ground.** On the speed sheet the slow stroke's caustic is a razor line and the fast stroke's is a glittering band; on Paper the same strokes read as reflection hatching with a burnished envelope and the rays never muddy the trunk.

Risks noted: no occlusion or second bounce (global; never fake it); hairline rays retire under GEN_CULL before the caustic does, which is LOD's job.
