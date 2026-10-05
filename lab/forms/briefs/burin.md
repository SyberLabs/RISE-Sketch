# Burin — engraving that follows the form

| | |
|---|---|
| file | `lab/forms/burin.form.ts`, `ops.id 'ripple'`, `v 104` |
| ink | graphite (a steel engraving on Paper; scratched film on Night) |
| locality | local chain, `reach 8`, `halfWin 8`, trunk plain `{w 1, α 1}` |
| depth | `dMax 4`, `baseDefault 2`, `radialCeiling 4` |
| budgets | `unitBudget 40`, `strokeBudget 16000` (causal) |
| mood | bold · structural · pigment (the most legible on Paper; Night reads as scratched film) |

## Concept

The stroke becomes an engraver's contour. Short lozenge-shaped ticks (thin, thick, thin: the burin's cut) are laid across it on the side the light does not reach, so a straight run reads as a lit cylinder and a bend reads as a sphere's rim. The pen's lean *is* the light; without tilt the lamp is up-left. Rising crosses the ticks into cross-hatch, then adds the third diagonal, the engraver's flick and stipple in the gaps, until a held hand burnishes the spot to mezzotint black. Ticks are discrete marks *across* the line that carry tone: nothing in Line, Echo, Sprout or Drift is a mark laid across the stroke.

## Algorithm (operator model)

Unit `j` = one hatch station at `s_j`, cooked with both sides at the ceiling (a side with zero weight has no branches).

```
Δ(s)   = clamp(lerp(7, 3.5, p̄)·(1 + 0.8c̄), 3, 10) sp;  s_0 = s0 + Δ/2;  s_{j+1} = s_j + Δ(s_j);  skipped within 3 sp of a corner station
need   = (phase 0 ? s0 : cur.s) + 8;   keep(s) = s ≤ L − 2
light ℓ: unit vector light travels along; pen, wt = smoothstep(0.1, 0.3, cos alt): ℓ = normalize(wt·(−tiltVec) + (1 − wt)·ℓ_page)
         ℓ_page = direction −45° from screen-up rotated by r.rot (a lamp up-left);  mouse / finger: ℓ_page
shade  : nℓ = n·ℓ;  σ_sh = |nℓ| > 0.15 ? sign(nℓ) : alternate(j)         the shadow side (ℓ points into it)
sphere : q = clamp(|κ̄|/0.015, 0, 1), σ_in = sign(κ̄) (concave side);  w_far = smoothstep(−0.2, 0.6, −σ_in·nℓ)
         weight(σ_in)  = q·w_far + (1 − q)·[σ_sh == σ_in]                 inside of a bend: the far rim of a sphere
         weight(−σ_in) = (1 − q)·[σ_sh == −σ_in]                           outside of a bend: cylinder rule only
ℓ_t    = (6 + 1.5S)(0.5 + p)·(1 − 0.4·fast)·(0.9 + 0.2r)·clamp(1 − 0.8ℓ_t·|κ̄|, 0.25, 1)·(1 − 0.6·max(0, σ·cs))·weight(σ)
skew   = 25°·fast toward the trailing tangent, ±4°(2r − 1);  fast = smoothstep(1, 2.5, vn)
```

| gen | geometry (per side σ with weight > 0) | drawn to |
|---|---|---|
| 1 | shadow tick: from `pos + σn(w_sp/2 + 0.5)` outward along `rot(σn, skew)`, 5 points at `a = 0, ¼, ½, ¾, 1·ℓ_t`; the last point displaced `0.15ℓ_t` tangentially (the flick, part of the ceiling polyline) | `ℓ_t·clamp(D, 0, 1)` |
| 2 | lit-side tick on `−σ`: same, length `0.45ℓ_t`, only when `|nℓ| < 0.9` | `clamp(D − 1, 0, 1)` |
| 3 | cross family at `+40°` on even `j`, `−40°` on odd `j` (so the diagonals interleave at the same spacing), length `0.9ℓ_t`; gated `ℓ_t ≥ 6 sp` | `clamp(D − 2, 0, 1)` |
| 4 | the other diagonal on the other parity, plus 2 stipple `Dot`s of diameter `0.35w_sp` placed by `rnd` between the tick roots and `0.6ℓ_t` out | prefix `clamp(D − 3, 0, 1)`; dots ease in by width `×clamp(D − 3, 0, 1)` |

```
width  : lozenge w(a) = w_t·(0.25 + 0.75·4a(ℓ − a)/ℓ²), w_t = w_sp·lerp(0.45, 0.9, p) (pen: 0.6w_sp), floor 0.35 sp
alpha  : 0.55 / 0.45 / 0.35 / 0.35 per family × glow(c);  tone = toneOf(p, g);  rng addresses (j·16 + k) on Ch.Length / Ch.Angle / Ch.Misc
```

`count` sums `prefixCount` over branches plus the dots when `D > 3`; `emit` is Sprout's prefix emit with the lozenge width as an ease (a function of position only, so truncation is exact).

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | ticks lean back up to 25° toward the trailing tangent and shorten ×0.6: a skidding burin |
| Pressure | spacing 7 → 3.5 sp, length `∝ (0.5 + p)`, belly `0.45w → 0.9w`: pressing darkens the tone exactly as on a plate |
| Lean / tilt | the pen's azimuth is the light; ticks migrate from side to side as the line turns away from it |
| Curvature & corners | ticks ride the normal and fan around bends; inside tight bends they shorten so they never cross; the inside of a bend takes the sphere rule (shaded on the far rim); a corner station skips the unit within 3 sp: the engraver's open corner |
| Closing a loop | a sphere: the rim is hatched inside on the side away from the light, bare on the near side (curvature-local, so bowls and curls shade the same way) |
| Holding | families 3–4 and stipple appear only in the pool: a burnished shadow spot in a clean contour |
| Nearby ink | spacing `×(1 + 0.8c)`, ticks shortened on the crowded side: hatching never runs into a neighbouring tone |
| Nib | pen: hairline ticks, belly 0.6w; brush: full lozenge; chisel: ticks are `PolyKind.Chisel` at the tick's own direction (broad across the nib angle, hairline along it, for free) |
| Zoom | `Δ`, `ℓ_t` in sp: zoom in and the hatch becomes a fine steel engraving |

**Tap**: the dot; held: a stippled disc, rings `k = 1..round(2D)` at radius `(3 + 0.4S)·k` sp of `6k` dots (±30 % jitter of the ring gap), each ring easing in by width over its depth interval: a mezzotint rocker spot. **Loop**: the sphere. **Hold**: a burnished patch.

## Night / Paper

Night: ticks at α 0.55 / 0.45 / 0.35; a triple crossing peaks at ≈ 1.35 before bloom, a bright knot of light like scratched film. Ticks start 0.5 sp outside the trunk edge, so they never add a bar onto the trunk (the engraver's white halo, which is authentic). Paper: multiply builds true engraving tone and the lozenge swell is exactly the burin's mark; this is the Form's home.

## Budgets

≤ 7 ticks × 5 pts + 2 dots = 37 pts per unit; `strokeBudget 16000` ≈ 430 units ≈ 2000 sp at Δ ≈ 4.7 (p 0.6). Cheap; no transcendentals beyond the Sampler and two rotations.

## Acceptance criteria (judged in screenshots)

1. **Light reads.** On the signature gesture (Paper, base 2) the ticks sit on one consistent side relative to the up-left lamp and switch sides where the line turns; the stroke reads as a lit cylinder, not as fur (ticks are lozenges with a visible belly, never uniform hairs).
2. **The sphere.** On the loop gesture the inside of the loop is hatched on the lower-right rim and bare on the upper-left, with no tick crossing the trunk or another tick at base depth.
3. **Tone ladder.** On the depth sheet d = 2 is single hatching, d = 3 cross-hatching, d = 4 three families with stipple in the gaps; the held tap is a stippled disc. On Night a triple crossing is a bright knot but never a white patch.

Risks noted: if Night bloom over-reads, drop family 3 to α 0.28; a fast scribble must read as a scratched halo (a shot decides).
