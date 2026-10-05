# Plume — the stroke as a rachis

| | |
|---|---|
| file | `lab/forms/plume.form.ts`, `ops.id 'ripple'`, `v 102` |
| ink | ochre (a quill study on Paper; a vane of warm light on Night) |
| locality | local chain, `reach 12`, `halfWin 6`, trunk plain `{w 0.9, α 1}` |
| depth | `dMax 3`, `baseDefault 2`, `radialCeiling 3` |
| budgets | `unitBudget 80`, `strokeBudget 24000` (causal) |
| mood | delicate · organic · light (Night) and pen-and-ink (Paper) |

## Concept

The stroke is the shaft of a feather. From both edges grows a vane of dense, parallel, gently curved barbs with a soft undulating outer edge; the entry taper is the bare quill. Draw fast and the vane sweeps back and ruffles into split groups; draw slowly and it is pristine. Barbules fringe each barb at base depth so the vane reads as a translucent sheet; a held hand turns the vane plumulaceous (loose down). The inner vane of a curve is short, exactly as on a real flight feather, so a closed loop becomes an **ocellus**: a fringed eye with a clear pupil. Sprout is sparse, tapered and branching; Plume is a dense array of parallel hairs with no branching at all.

## Algorithm (operator model)

Unit `j` = one barb pair at `s_j` (`side` unused: both sides are cooked). Everything is a prefix or a width, so depth is continuous by construction.

```
Δ(s)   = clamp(2.4 + 0.06S, 2.4, 5.5)·(1 + 0.6c)                        barb pitch ≈ 3 sp at S 9
cursor : s_0 = s0 + Δ/2;  s_{j+1} = s_j + Δ(s_j);  need = (phase 0 ? s0 : cur.s) + 6;  keep(s) = s ≤ L − 2
fast ρ = smoothstep(1.0, 2.4, vn)
β0     = 90° − (18° + 32°·smoothstep(0.3, 2, v̄n))                       barb angle from the shaft toward the tip
asym   = pen && cos(alt) > 0.3 ? clamp(0.6·(tiltVec·n), −0.5, 0.5) : −0.25·clamp(κ̄/0.01, −1, 1)
vane(s)= 0.88 + 0.24·smoothlerp(rnd(seed, Ch.Growth, floor(s/24)), rnd(…, floor(s/24) + 1), fract(s/24))
tip    = cx.final && L − s < 40 ? smoothstep(0, 40, L − s)^0.7 : 1    (tail re-cook zone: exact, animates in with the lift zone)
ℓ_σ    = (8 + 1.6S)(0.45 + 1.1p)·E·vane(s)·(1 − 0.5c)·(1 + σ·asym)·(1 − 0.5·max(0, σ·cs))·tip
cap    : σ·κ̄ > 0 (concave side) → ℓ_σ = min(ℓ_σ, 0.7/|κ̄|)              the pupil
ruffle : ℓ ×(1 + 0.45ρ(2r − 1));  β0 += 14°ρ(2r − 1) + 10°ρ·(2·rnd(seed, Ch.Misc, floor(s_j/8)) − 1)   (groups of 8 sp sway together)
heading(a) = σn·cos β(a) + T·sin β(a),  β(a) = β0 + 20°(1 + 0.5ρ)·(a/ℓ)   (curving toward the tip; no rotation maths)
```

| gen | geometry | drawn to |
|---|---|---|
| 1 | barb: start on the trunk edge `pos + σn·w/2`, 3 sp substeps along `heading(a)`, ≤ 9 points; width `w_b = clamp(0.30·w_sp·E, 0.35, 3)` sp at the base → `0.3w_b` at the tip, collar `0.6w_b` | `ℓ·clamp(D, 0, 1)` |
| 2 | barbules: ONE zigzag poly per barb with nodes `a_k` every 3 sp from `0.25ℓ`, barbule tip at 55° from the barb toward the feather tip, length `0.42Δ(0.8 + 0.4r)` (neighbours never cross); points `a_k, tip_k, a_{k+1}, tip_{k+1}, …`, width 0.35 sp | plain prefix `len·clamp(D − 1, 0, 1)`; count `2·floor(λ/3) + 2` (closed form) |
| 3 | down (`j % 3 == 0` only): one plumulaceous barb per side, `ℓ_d = 1.3ℓ`, heading `+= (2r − 1)·0.45` rad per 3 sp substep, width 0.35 sp | `ℓ_d·clamp(D − 2, 0, 1)` |

```
alpha  : barbs 0.5, barbules 0.5·0.72, down 0.5·0.72², all × glow(c);  barbule α → 0 (linearly) when Δ/z < 1.5 doc px (moiré guard)
tone   : toneOf(p, g);   rng addresses (j·4 + side·2 + k) on Ch.Length / Ch.Angle / Ch.Jitter
```

## Gesture grammar

| Gesture | What visibly changes |
|---|---|
| Speed | sweep (`β0` lays the barbs back) and ruffle (length and angle jitter, groups of 8 sp swaying together): a split, wind-blown vane; slow = pristine |
| Pressure | vane width `ℓ ∝ (0.45 + 1.1p)`; barb width `0.3w` |
| Lean / tilt | flight-feather asymmetry: the vane on the tilt side is wider, the other narrower |
| Curvature & corners | without tilt the outer vane is longer; the concave vane is capped at `0.7/|κ̄|` so it never folds through itself; corners fan outside, crowd inside |
| Closing a loop | an **ocellus**: outer barbs fringe, inner barbs shorten to the cap and leave a clear pupil (curvature-driven, so tight open curls get it too) |
| Holding | barbules, then down: the vane thickens into texture, then goes fluffy around the hold |
| Nearby ink | barbs `×(1 − 0.5c)`; the vane facing ink narrows; glow budget dims barbules and down |
| Nib | pen: hair barbs 0.35–0.5 sp (a quill drawing); brush: barbs carry pressure width; chisel: barbs are `PolyKind.Chisel` at the nib angle (calligraphic plumage, broad across the edge, hairline along it) |
| Zoom | pitch and length in sp: zoom in → finer plumage |

**Tap**: a tuft of down: 8 plumulaceous barbs at `45°·i + jitter`, `ℓ_d` as above, barbules at `D > 1`; a bloom grows into a powder-down rosette. **Loop**: the ocellus. **Hold**: gens 2–3 appear only inside the pool window, so a held spot is the downy patch on a crisp vane.

## Night / Paper

Night: a vane of light. Barbs at α 0.5 with ~13 % coverage never add up except at the rachis, where they start on the trunk *edge* with a 0.6w collar; barbule zigzags give a soft glowing texture rather than lines; loop eyes glow around a dark pupil. Paper: a pen-and-ink feather study (Dürer's wing) at 0.78 per generation, down as faint grey wisps.

## Budgets

16 (barbs) + 32 (barbules) + ~9 (down, every third unit) ≈ 56 pts, 4–6 polys per unit at the ceiling; 16 at base 1, 48 at base 2. 600 sp stroke at base 2 ≈ 9.6 k pts, ~800 polys. `strokeBudget 24000` ≈ 430 units ≈ 1300 sp of full vane before the causal budget stops new units. Each `cook` is tiny; `count`/`emit` must stay closed-form because they run on every re-truncation.

## Acceptance criteria (judged in screenshots)

1. **Ocellus.** On the loop gesture the inside of the loop shows a clear pupil at least 0.3R across, ringed by short inner barbs, with a full fringe outside; no barb crosses the trunk or another barb's root.
2. **Speed reads as wind.** On the speed sheet the slow stroke's vane is smooth-edged with parallel barbs; the fast stroke's barbs are laid back toward the tip and visibly split into swaying groups, but the vane is still a vane (not Sprout-like fuzz).
3. **Density without blow-out.** On Night the rachis is the brightest line and the vane is a soft sheet (no bright bar along the trunk edge, no moiré at the `nibs` sheet's pen size); on Paper the same stroke reads as a quill drawing.

Risks noted: if the tail taper reads as a pop at lift, drop `tip` and let the shaft's exit taper carry it (one line).
